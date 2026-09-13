import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

export interface PiCollaborationMessage {
  readonly id: string;
  readonly kind: "message" | "task" | "completion";
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly createdAt: string;
}

export interface PiSessionForkContext {
  readonly schemaVersion: 1;
  readonly parentSessionId: string;
  readonly forkTurns: string;
  readonly messages: readonly {
    readonly role: "user" | "assistant" | "context";
    readonly text: string;
    readonly turnStart: boolean;
  }[];
}

const BATCH_TYPE = "chronorift.collaboration";
const FORK_TYPE = "chronorift.fork-context";
const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;
const textContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as unknown[])
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
};

export function normalizePiForkTurns(value: string): string {
  const normalized = value.trim().toLowerCase() || "all";
  if (normalized === "all" || normalized === "none") return normalized;
  if (
    !/^[1-9][0-9]*$/.test(normalized) ||
    !Number.isSafeInteger(Number(normalized))
  )
    throw new Error("fork_turns must be all, none, or a positive integer");
  return normalized;
}

/** Validate IPC/import data before it can enter another Session's context. */
export function parsePiSessionForkContext(
  value: unknown,
): PiSessionForkContext {
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid Pi fork context");
  const data = value as Record<string, unknown>;
  if (
    data.schemaVersion !== 1 ||
    typeof data.parentSessionId !== "string" ||
    data.parentSessionId.length === 0 ||
    typeof data.forkTurns !== "string" ||
    !Array.isArray(data.messages) ||
    data.messages.length > 4096
  )
    throw new Error("Invalid Pi fork context");
  const forkTurns = normalizePiForkTurns(data.forkTurns);
  const messages: PiSessionForkContext["messages"][number][] = [];
  let size = 0;
  for (const raw of data.messages) {
    if (typeof raw !== "object" || raw === null)
      throw new Error("Invalid Pi fork context message");
    const message = raw as Record<string, unknown>;
    if (
      !["user", "assistant", "context"].includes(String(message.role)) ||
      typeof message.text !== "string" ||
      typeof message.turnStart !== "boolean" ||
      (message.role !== "user" && message.turnStart)
    )
      throw new Error("Invalid Pi fork context message");
    size += Buffer.byteLength(message.text, "utf8");
    if (size > MAX_CONTEXT_BYTES)
      throw new Error("Pi fork context exceeds 4 MiB");
    messages.push({
      role: message.role as "user" | "assistant" | "context",
      text: message.text,
      turnStart: message.turnStart,
    });
  }
  if (forkTurns === "none" && messages.length !== 0)
    throw new Error("fork_turns none must have no inherited messages");
  return {
    schemaVersion: 1,
    parentSessionId: data.parentSessionId,
    forkTurns,
    messages,
  };
}

export function exportPiSessionForkContext(
  session: Pick<AgentSession, "sessionId" | "messages">,
  value: string,
): PiSessionForkContext {
  const forkTurns = normalizePiForkTurns(value);
  const messages: PiSessionForkContext["messages"][number][] = [];
  if (forkTurns !== "none") {
    for (const entry of session.messages) {
      const message = entry as unknown as Record<string, unknown>;
      if (message.role === "user") {
        if (
          Array.isArray(message.content) &&
          message.content.some(
            (part: { type?: unknown }) => part.type !== "text",
          )
        )
          throw new Error(
            "Forking non-text user content is unsupported; use fork_turns none for a fresh text task",
          );
        messages.push({
          role: "user",
          text: textContent(message.content),
          turnStart: true,
        });
      } else if (
        message.role === "assistant" &&
        message.stopReason === "stop" &&
        Array.isArray(message.content) &&
        !message.content.some(
          (part: { type?: unknown }) => part.type === "toolCall",
        )
      ) {
        const text = textContent(message.content);
        if (text) messages.push({ role: "assistant", text, turnStart: false });
      } else if (
        message.role === "compactionSummary" ||
        message.role === "branchSummary"
      ) {
        if (typeof message.summary === "string")
          messages.push({
            role: "context",
            text: message.summary,
            turnStart: false,
          });
      } else if (
        message.role === "custom" &&
        message.customType === FORK_TYPE
      ) {
        const details = message.details as
          { forkContext?: unknown } | undefined;
        messages.push(
          ...parsePiSessionForkContext(details?.forkContext).messages,
        );
      } else if (
        message.role === "custom" &&
        message.customType === BATCH_TYPE
      ) {
        const details = message.details as
          { messages?: PiCollaborationMessage[] } | undefined;
        for (const item of details?.messages ?? []) {
          if (item.kind === "task")
            messages.push({ role: "user", text: item.text, turnStart: true });
        }
      }
    }
  }
  let selected = messages;
  if (forkTurns !== "all" && forkTurns !== "none") {
    const starts = messages.flatMap((message, index) =>
      message.turnStart ? [index] : [],
    );
    const start = starts[Math.max(0, starts.length - Number(forkTurns))];
    selected = start === undefined ? [] : messages.slice(start);
  }
  return parsePiSessionForkContext({
    schemaVersion: 1,
    parentSessionId: session.sessionId,
    forkTurns,
    messages: selected,
  });
}

/** Inherited background carries no parent requests or usage-bearing assistant entries. */
export async function importPiSessionForkContext(
  session: AgentSession,
  raw: PiSessionForkContext,
): Promise<void> {
  const forkContext = parsePiSessionForkContext(raw);
  session.sessionManager.appendCustomEntry("chronorift.fork-provenance", {
    parentSessionId: forkContext.parentSessionId,
    forkTurns: forkContext.forkTurns,
    inheritedContextMessages: forkContext.messages.length,
  });
  if (forkContext.messages.length === 0) return;
  await session.sendCustomMessage(
    {
      customType: FORK_TYPE,
      content: `Inherited conversation background. The new task below determines your assignment.\n${forkContext.messages.map((message) => `[${message.role}]\n${message.text}`).join("\n\n")}`,
      display: false,
      details: { forkContext, usageOwnership: "parent-context-only" },
    },
    { triggerTurn: false },
  );
}

export type PiCollaborationPhase = "current" | "next" | "idle";
export type PiCollaborationDisposition = "current-turn" | "next-turn";

export interface PiCollaborationInbox {
  readonly phase: PiCollaborationPhase;
  deliver(message: PiCollaborationMessage): Promise<PiCollaborationDisposition>;
  subscribePhase(listener: (phase: PiCollaborationPhase) => void): () => void;
  hasPendingMessages(): boolean;
  subscribeActivity(listener: () => void): () => void;
  subscribeConsumption(listener: (ids: readonly string[]) => void): () => void;
  onUserInput(): void;
  dispose(): void;
}

/**
 * Pi retains its loop, retries and compaction. Mail joins its existing turn boundary,
 * after tools finish; unlike Codex this does not preempt a streaming model response.
 */
export function createPiCollaborationInbox(
  session: AgentSession,
): PiCollaborationInbox {
  let phase: "current" | "next" | "idle" | "closed" = session.isIdle
    ? "idle"
    : "current";
  const pending: PiCollaborationMessage[] = [];
  const known = new Set<string>();
  const inFlight = new Map<string, PiCollaborationMessage>();
  const activity = new Set<() => void>();
  const consumption = new Set<(ids: readonly string[]) => void>();
  const phases = new Set<(phase: PiCollaborationPhase) => void>();
  const setPhase = (value: PiCollaborationPhase): void => {
    if (phase === value || phase === "closed") return;
    phase = value;
    for (const listener of phases) listener(value);
  };
  const notify = (): void => {
    for (const listener of activity) listener();
  };
  const batch = (messages: readonly PiCollaborationMessage[]) => ({
    customType: BATCH_TYPE,
    content: messages
      .map(
        (message) =>
          `Message Type: ${message.kind === "task" ? "NEW_TASK" : message.kind === "completion" ? "FINAL_ANSWER" : "MESSAGE"}\nTask name: ${message.to}\nSender: ${message.from}\nPayload:\n${message.text}`,
      )
      .join("\n\n"),
    display: true,
    details: { messages },
  });
  const take = (): PiCollaborationMessage[] => pending.splice(0);
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const messages = take();
    for (const message of messages) inFlight.set(message.id, message);
    await session.sendCustomMessage(batch(messages), {
      triggerTurn: false,
      deliverAs: "steer",
    });
  };
  const onEvent = (event: AgentSessionEvent): void => {
    if (phase === "closed") return;
    if (event.type === "agent_start") {
      setPhase("current");
    } else if (event.type === "message_end") {
      const message = event.message;
      if (message.role === "custom" && message.customType === BATCH_TYPE) {
        const details = message.details as
          { messages?: PiCollaborationMessage[] } | undefined;
        const ids = (details?.messages ?? []).map((item) => item.id);
        for (const id of ids) inFlight.delete(id);
        if (ids.length !== 0) for (const listener of consumption) listener(ids);
      }
    } else if (event.type === "agent_settled") {
      // An abort can clear Pi's steering queue before its custom message enters history.
      // The Host still owns these unacknowledged mails; retain them for a future task.
      pending.unshift(...inFlight.values());
      inFlight.clear();
      setPhase("idle");
    }
  };
  const unsubscribe = session.subscribe(onEvent);
  // Agent-core awaits these listeners, so a delivery failure belongs to the real
  // Pi run instead of becoming an unhandled promise from a Session subscriber.
  const unsubscribeStart = session.agent.subscribe(async (event) => {
    if (event.type === "agent_start" && phase !== "closed") await flush();
  });
  const previous = session.agent.prepareNextTurnWithContext;
  const previousLegacy = session.agent.prepareNextTurn;
  const prepare: NonNullable<typeof previous> = async (turn, signal) => {
    const snapshot = previous
      ? await previous(turn, signal)
      : await previousLegacy?.(signal);
    if (phase === "closed") return snapshot;
    const hasTools = turn.message.content.some(
      (part) => part.type === "toolCall",
    );
    const explicitTask = pending.some((message) => message.kind === "task");
    if (hasTools || explicitTask) {
      setPhase("current");
      await flush();
    } else {
      setPhase("next");
    }
    return snapshot;
  };
  session.agent.prepareNextTurnWithContext = prepare;
  return {
    get phase() {
      return phase === "closed" ? "idle" : phase;
    },
    subscribePhase(listener) {
      phases.add(listener);
      return () => {
        phases.delete(listener);
      };
    },
    deliver(message) {
      if (phase === "closed")
        throw new Error("Pi collaboration inbox is closed");
      if (
        !message.id ||
        !["message", "task", "completion"].includes(message.kind) ||
        !message.from ||
        !message.to ||
        !message.text.trim() ||
        !Number.isFinite(Date.parse(message.createdAt))
      )
        throw new Error("Invalid collaboration message");
      const disposition = phase === "current" ? "current-turn" : "next-turn";
      // The Host owns turn IDs, execution slots and budgets. It starts an idle task.
      if (message.kind === "task" && disposition === "next-turn")
        return Promise.resolve(disposition);
      if (known.has(message.id)) return Promise.resolve(disposition);
      if (Buffer.byteLength(message.text, "utf8") > 65536)
        throw new Error("Collaboration message exceeds 64 KiB");
      const pendingBytes = [...pending, ...inFlight.values()].reduce(
        (total, item) => total + Buffer.byteLength(item.text, "utf8"),
        0,
      );
      if (
        pendingBytes + Buffer.byteLength(message.text, "utf8") >
        MAX_CONTEXT_BYTES
      )
        throw new Error("Pi collaboration inbox exceeds 4 MiB");
      if (pending.length + inFlight.size >= 4096)
        throw new Error("Pi collaboration inbox is full");
      known.add(message.id);
      pending.push({ ...message });
      notify();
      return Promise.resolve(disposition);
    },
    hasPendingMessages: () => pending.length !== 0 || inFlight.size !== 0,
    subscribeActivity(listener) {
      activity.add(listener);
      return () => {
        activity.delete(listener);
      };
    },
    subscribeConsumption(listener) {
      consumption.add(listener);
      return () => {
        consumption.delete(listener);
      };
    },
    onUserInput() {
      notify();
    },
    dispose() {
      phase = "closed";
      unsubscribe();
      unsubscribeStart();
      if (session.agent.prepareNextTurnWithContext === prepare) {
        if (previous === undefined)
          delete session.agent.prepareNextTurnWithContext;
        else session.agent.prepareNextTurnWithContext = previous;
      }
      activity.clear();
      consumption.clear();
      phases.clear();
    },
  };
}
