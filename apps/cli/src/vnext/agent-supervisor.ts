import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Type } from "typebox";

import {
  createPiProxyToolDefinitions,
  type PiCollaborationMessage,
  type PiSessionForkContext,
  type PiProxyToolDescriptor,
  type PiProxyToolResult,
  type PiThinkingLevel,
  type RootCollaborationPort,
  type RootPiSessionControl,
  type VNextPiTurnResult,
} from "@chronorift/pi-harness";

import {
  AGENT_MESSAGE_MAX_LENGTH,
  AGENT_IPC_MAX_PENDING,
  agentToolError,
  type AgentWorkerConfiguration,
  type AgentWorkerMessage,
} from "./agent-ipc.js";
import {
  createNodeAgentWorker,
  type AgentWorkerClient,
  type AgentWorkerFactory,
} from "./agent-worker-client.js";

export type { AgentWorkerConfiguration } from "./agent-ipc.js";

export interface AgentTurnCompletion {
  readonly agentId: string;
  readonly turnId: number;
  readonly status: "completed" | "failed" | "cancelled" | "timed_out";
  readonly assistantText: string;
  readonly errorMessage: string | null;
  readonly piResult?: VNextPiTurnResult;
}

export interface AgentTurnRecord extends AgentTurnCompletion {
  readonly taskName: string;
  readonly parentAgentId: string;
  readonly task: string;
  readonly startedAt: string | null;
  readonly finishedAt: string;
  /** Host receipt of Pi settlement, before resource cleanup; null if unavailable. */
  readonly settledAt?: string | null;
  readonly evidence?: unknown;
}

export interface AgentResource {
  readonly workerConfiguration: AgentWorkerConfiguration;
  invokeTool(
    this: void,
    request: {
      readonly turnId: number;
      readonly requestId: string;
      readonly name: string;
      readonly arguments: unknown;
    },
    signal: AbortSignal,
    onUpdate: (result: PiProxyToolResult) => void,
  ): Promise<PiProxyToolResult>;
  finishTurn(
    this: void,
    turnId: number,
    result: AgentTurnCompletion,
  ): Promise<unknown>;
  cancel(this: void): Promise<void>;
  close(this: void): Promise<void>;
}

export type AgentResourceFactory = (agentId: string) => Promise<AgentResource>;

/** Optional Host constraints for controlled runs; ordinary collaboration has no spawn policy. */
export interface AgentSpawnPolicy {
  /** Lifetime non-root identities, including failed, closed, and unloaded agents. */
  readonly maxCreatedAgents?: number;
  /** Root has depth zero. A value of one permits only Root's direct children. */
  readonly maxDepth?: number;
  readonly lockedRuntime?: {
    readonly provider: string;
    readonly model: string;
    readonly thinkingLevel: PiThinkingLevel;
  };
}

export interface AgentSupervisorOptions {
  readonly createResource: AgentResourceFactory;
  readonly cancelRoot?: () => Promise<void>;
  /** Non-root active turns and loaded workers. Root has its own reserved slot. */
  readonly maxAgents?: number;
  readonly turnTimeoutMs?: number;
  /** Host-only non-collaboration calls per turn; cleanup remains available. */
  readonly turnToolCallLimit?: number;
  readonly interruptGraceMs?: number;
  readonly workerFactory?: AgentWorkerFactory;
  readonly spawnPolicy?: AgentSpawnPolicy;
  readonly onResult?: (record: AgentTurnRecord) => void | Promise<void>;
}

export interface AgentTurnTarget {
  readonly agentId: string;
  readonly turnId: number;
  readonly taskName: string;
}

export interface SpawnAgentOptions {
  readonly taskName: string;
  readonly forkTurns?: string;
  readonly model?: string;
  readonly reasoningEffort?: PiThinkingLevel;
}

export interface AgentMessageRecord {
  readonly envelope: PiCollaborationMessage;
  readonly queuedAt: string;
  consumedAt: string | null;
  deferredAt: string | null;
  submittedAt: string | null;
  error: string | null;
}

interface PendingTurn {
  readonly turnId: number;
  readonly task: string;
  readonly tasks: PiCollaborationMessage[];
  readonly done: Promise<AgentTurnRecord>;
  readonly resolve: (result: AgentTurnRecord) => void;
  startedAt: string | null;
  settledAt?: string;
  timer?: ReturnType<typeof setTimeout>;
  interruptTimer?: ReturnType<typeof setTimeout>;
  finishing?: Promise<void>;
  forcedStatus?: "cancelled" | "timed_out";
  toolCalls: number;
  result?: AgentTurnRecord;
}

interface Request<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface AgentEntry {
  readonly agentId: string;
  readonly taskName: string;
  readonly parentAgentId: string;
  readonly turns: Map<number, PendingTurn>;
  readonly mailbox: Map<string, PiCollaborationMessage>;
  readonly deliveries: Map<string, Request<boolean>>;
  readonly exports: Map<string, Request<PiSessionForkContext>>;
  readonly requests: Map<
    string,
    { readonly controller: AbortController; readonly done: Promise<void> }
  >;
  resource?: AgentResource;
  configuration?: AgentWorkerConfiguration;
  client?: AgentWorkerClient | undefined;
  state: "starting" | "idle" | "running" | "closing" | "closed" | "failed";
  current?: PendingTurn | undefined;
  next?: PendingTurn | undefined;
  nextTurnId: number;
  resident: boolean;
  lastUsed: number;
  processGeneration: number;
  sessionFile?: string;
  sessionId?: string;
  loading?: Promise<void> | undefined;
  closing?: Promise<void> | undefined;
  failing?: Promise<void> | undefined;
  resourcesClosed?: boolean;
  cleanupBlocked: boolean;
  failure?: string;
}

const ROOT = "/root";
const MAX_MAILBOX = 512;
const TURN_TOOL_BUDGET = 64;
const IPC_RESPONSE_TIMEOUT_MS = 30_000;
const CONTROL_NAMES = new Set([
  "spawn_agent",
  "list_agents",
  "followup_task",
  "send_message",
  "wait_agent",
  "interrupt_agent",
]);
const textInput = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_MESSAGE_MAX_LENGTH)
  .refine(
    (text) => Buffer.byteLength(text, "utf8") <= AGENT_MESSAGE_MAX_LENGTH,
    "Message exceeds 64 KiB",
  );
const taskNameInput = z
  .string()
  .max(128)
  .regex(/^[a-z0-9_]+$/u)
  .refine((name) => name !== "root", "task_name root is reserved");
const reasoningInput = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const spawnArgumentsSchema = z
  .object({
    message: textInput,
    task_name: taskNameInput,
    fork_turns: z.string().optional(),
    model: textInput.optional(),
    reasoning_effort: reasoningInput.optional(),
  })
  .strict();
const lockedSpawnArgumentsSchema = spawnArgumentsSchema.omit({
  model: true,
  reasoning_effort: true,
});

function validatedSpawnPolicy(
  value: AgentSpawnPolicy | undefined,
): AgentSpawnPolicy | null {
  if (value === undefined) return null;
  const limit = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const identifier = z.string().trim().min(1).max(128);
  const parsed = z
    .object({
      maxCreatedAgents: limit.optional(),
      maxDepth: limit.optional(),
      lockedRuntime: z
        .object({
          provider: identifier,
          model: identifier,
          thinkingLevel: reasoningInput,
        })
        .strict()
        .optional(),
    })
    .strict()
    .parse(value);
  return Object.freeze({
    ...(parsed.maxCreatedAgents === undefined
      ? {}
      : { maxCreatedAgents: parsed.maxCreatedAgents }),
    ...(parsed.maxDepth === undefined ? {} : { maxDepth: parsed.maxDepth }),
    ...(parsed.lockedRuntime === undefined
      ? {}
      : { lockedRuntime: Object.freeze({ ...parsed.lockedRuntime }) }),
  });
}
const errorText = (error: unknown): string =>
  String(error instanceof Error ? error.message : error).slice(
    0,
    AGENT_MESSAGE_MAX_LENGTH,
  );
const boundedInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number => {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum)
    throw new TypeError(`${name} must be an integer from 1 to ${maximum}`);
  return selected;
};

function forkMode(value = "all"): string {
  const selected = value.trim().toLowerCase() || "all";
  if (selected === "all" || selected === "none") return selected;
  if (
    !/^[0-9]+$/u.test(selected) ||
    !Number.isSafeInteger(Number(selected)) ||
    Number(selected) < 1
  )
    throw new Error(
      "fork_turns must be none, all, or a positive integer string",
    );
  return String(Number(selected));
}

function canonicalPath(value: string): string {
  if (value.length > 4096)
    throw new Error("Agent path exceeds 4096 characters");
  if (value === ROOT) return ROOT;
  if (!value.startsWith(`${ROOT}/`) || value.endsWith("/"))
    throw new Error(
      "Agent paths must start with /root and have no trailing slash",
    );
  for (const part of value.slice(ROOT.length + 1).split("/"))
    taskNameInput.parse(part);
  return value;
}

function pathMatches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

const targetFor = (entry: AgentEntry, turn: PendingTurn): AgentTurnTarget => ({
  agentId: entry.agentId,
  taskName: entry.taskName,
  turnId: turn.turnId,
});

/** One Host owns the complete task tree, admission, mail identities and tool authority. */
export class AgentSupervisor implements RootCollaborationPort {
  private readonly agents = new Map<string, AgentEntry>();
  private readonly paths = new Map<string, string>();
  private readonly rootMailbox = new Map<string, PiCollaborationMessage>();
  private readonly messageRecords: AgentMessageRecord[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly maxAgents: number;
  private readonly timeoutMs: number;
  private readonly turnToolCallLimit: number;
  private readonly interruptGraceMs: number;
  private readonly workerFactory: AgentWorkerFactory;
  private readonly spawnPolicy: AgentSpawnPolicy | null;
  private root: RootPiSessionControl | undefined;
  private rootUnsubscribe: (() => void) | undefined;
  private rootDelivery: Promise<void> = Promise.resolve();
  private residencyOperation: Promise<void> = Promise.resolve();
  private userRevision = 0;
  private clock = 0;
  private disposed = false;
  private accepting = true;

  public constructor(private readonly options: AgentSupervisorOptions) {
    this.maxAgents = boundedInteger(options.maxAgents, 3, 4, "maxAgents");
    this.timeoutMs = boundedInteger(
      options.turnTimeoutMs,
      600_000,
      3_600_000,
      "turnTimeoutMs",
    );
    this.turnToolCallLimit = boundedInteger(
      options.turnToolCallLimit,
      TURN_TOOL_BUDGET,
      512,
      "turnToolCallLimit",
    );
    this.interruptGraceMs = boundedInteger(
      options.interruptGraceMs,
      2_000,
      30_000,
      "interruptGraceMs",
    );
    this.workerFactory = options.workerFactory ?? createNodeAgentWorker;
    this.spawnPolicy = validatedSpawnPolicy(options.spawnPolicy);
  }

  public get effectiveSpawnPolicy(): AgentSpawnPolicy | null {
    return this.spawnPolicy;
  }

  public async spawnAgent(
    message: string,
    options: SpawnAgentOptions,
    caller = ROOT,
  ): Promise<AgentTurnTarget> {
    textInput.parse(message);
    taskNameInput.parse(options.taskName);
    const forkTurns = forkMode(options.forkTurns);
    if (options.model !== undefined) textInput.parse(options.model);
    if (options.reasoningEffort !== undefined)
      reasoningInput.parse(options.reasoningEffort);
    const parentId = this.resolveTarget(caller, ROOT);
    const parentPath = this.pathOf(parentId);
    const taskName = canonicalPath(`${parentPath}/${options.taskName}`);
    this.assertSpawnPolicy(options, parentPath);
    this.renderTasks([{ from: parentPath, to: taskName, text: message }]);
    this.assertAccepting();
    if (this.paths.has(taskName))
      throw new Error(`Agent path ${taskName} already exists`);
    this.assertCapacity();
    const entry: AgentEntry = {
      agentId: randomUUID(),
      taskName,
      parentAgentId: parentId,
      turns: new Map(),
      mailbox: new Map(),
      deliveries: new Map(),
      exports: new Map(),
      requests: new Map(),
      state: "starting",
      nextTurnId: 1,
      resident: false,
      lastUsed: ++this.clock,
      processGeneration: 0,
      cleanupBlocked: false,
    };
    this.agents.set(entry.agentId, entry);
    this.paths.set(taskName, entry.agentId);
    const initial = this.envelope(parentId, entry.agentId, "task", message);
    const turn = this.makeTurn(entry, initial);
    entry.next = turn;
    // The entry reserves active capacity synchronously, before any asynchronous preparation.
    const startup = (async () => {
      entry.resource = await this.options.createResource(entry.agentId);
      this.assertEntryStarting(entry);
      const base = entry.resource.workerConfiguration;
      if (base.tools.some((tool) => CONTROL_NAMES.has(tool.name)))
        throw new Error("Agent resources must not inject collaboration tools");
      const inherited =
        parentId === ROOT
          ? base
          : (this.requireAgent(parentId).configuration ?? base);
      const forkContext =
        forkTurns === "none"
          ? undefined
          : await this.exportContext(parentId, forkTurns);
      this.assertEntryStarting(entry);
      entry.configuration = {
        ...base,
        agentId: entry.agentId,
        taskName,
        parentAgentId: parentId,
        provider: this.spawnPolicy?.lockedRuntime?.provider ?? base.provider,
        model:
          this.spawnPolicy?.lockedRuntime?.model ??
          options.model ??
          inherited.model,
        thinkingLevel:
          this.spawnPolicy?.lockedRuntime?.thinkingLevel ??
          options.reasoningEffort ??
          inherited.thinkingLevel,
        ...(forkContext === undefined ? {} : { forkContext }),
        tools: [...base.tools, ...collaborationDescriptors(this.spawnPolicy)],
        additionalEnvironmentInstructions: [
          base.additionalEnvironmentInstructions,
          `You are ${taskName}, a member of the team rooted at /root. Your parent is ${parentPath}. All agents share the same private candidate directory; edits are immediately visible. Coordinate overlapping edits and preserve other agents' changes. Stay within your assigned task and use supported findings already supplied by other agents. There are ${this.maxAgents + 1} concurrency slots including Root; waiting keeps your slot. When your task is finished, give a concise final answer with your conclusion, concrete evidence references, and uncovered items, then end the current turn. Your final answer is automatically sent to your parent; do not also send the same result as a separate message or loop on wait_agent to remain available. The parent can resume you with followup_task when further work is needed. A completed turn is not acceptance of a fix.`,
          spawnPolicyDescription(this.spawnPolicy),
        ]
          .filter(Boolean)
          .join("\n"),
      };
      await this.loadWorker(entry);
      this.assertEntryStarting(entry);
      entry.state = "idle";
      this.startNext(entry);
    })();
    entry.loading = startup;
    try {
      await startup;
      return targetFor(entry, turn);
    } catch (error) {
      await this.workerFailed(entry, error);
      throw error;
    } finally {
      entry.loading = undefined;
      this.changed();
    }
  }

  /** Host records include unloaded agents; the model-facing tool filters residents. */
  public listAllAgents() {
    return [...this.agents.values()].map((entry) => ({
      agentId: entry.agentId,
      taskName: entry.taskName,
      path: entry.taskName,
      parentAgentId: entry.parentAgentId,
      state: entry.state,
      resident: entry.resident,
      cleanupBlocked: entry.cleanupBlocked,
      sessionId: entry.sessionId ?? null,
      sessionFile: entry.sessionFile ?? null,
      currentTurnId: entry.current?.turnId ?? null,
      queuedTurns: entry.next === undefined ? 0 : 1,
      completedTurns: [...entry.turns.values()].filter(
        (turn) => turn.result !== undefined,
      ).length,
      failure: entry.failure ?? null,
    }));
  }

  public listAgents() {
    return this.listAllAgents();
  }

  public async sendMessage(
    target: string,
    message: string,
    caller = ROOT,
  ): Promise<void> {
    textInput.parse(message);
    const senderId = this.resolveTarget(caller, ROOT);
    const receiverId = this.resolveTarget(target, senderId);
    await this.queueMessage(
      this.envelope(senderId, receiverId, "message", message),
    );
  }

  public async followupTask(
    target: string,
    message: string,
    caller = ROOT,
  ): Promise<AgentTurnTarget> {
    textInput.parse(message);
    this.assertAccepting();
    const senderId = this.resolveTarget(caller, ROOT);
    const receiverId = this.resolveTarget(target, senderId);
    if (receiverId === ROOT)
      throw new Error("Follow-up tasks cannot target Root");
    const entry = this.requireAgent(receiverId);
    if (entry.failing !== undefined) await entry.failing;
    this.requireLive(receiverId);
    const envelope = this.envelope(senderId, receiverId, "task", message);
    this.renderTasks([envelope]);
    if (entry.mailbox.size >= MAX_MAILBOX)
      throw new Error("Agent mailbox is full");
    if (
      entry.current !== undefined &&
      entry.current.forcedStatus === undefined &&
      entry.current.finishing === undefined
    ) {
      const current = entry.current;
      this.recordMessage(entry.mailbox, envelope);
      try {
        const accepted = await this.deliverToWorker(entry, envelope);
        if (accepted) return targetFor(entry, current);
      } catch (error) {
        this.failMessage(entry.mailbox, envelope.id, error);
        throw error;
      }
      // A task arriving after Pi closed its response is admitted by this Host as a new turn.
      entry.mailbox.delete(envelope.id);
      const record = this.messageRecords.find(
        (item) => item.envelope.id === envelope.id,
      );
      if (record !== undefined) record.deferredAt = new Date().toISOString();
    }
    if (entry.next !== undefined) {
      if (entry.next.tasks.length >= MAX_MAILBOX)
        throw new Error("Agent task queue is full");
      this.renderTasks([...entry.next.tasks, envelope]);
      entry.next.tasks.push(envelope);
      this.recordTask(envelope);
      return targetFor(entry, entry.next);
    }
    if (entry.current === undefined) this.assertCapacity();
    const next = this.makeTurn(entry, envelope);
    entry.next = next;
    if (entry.current === undefined) {
      entry.state = "starting";
      const loading = this.ensureLoaded(entry).then(() => {
        if (entry.state !== "starting" || this.disposed)
          throw new Error("Agent startup was cancelled");
        entry.state = "idle";
        this.startNext(entry);
      });
      entry.loading = loading;
      try {
        await loading;
      } catch (error) {
        await this.workerFailed(entry, error);
        throw error;
      } finally {
        entry.loading = undefined;
      }
    }
    return targetFor(entry, next);
  }

  public async waitAgent(
    timeoutMs = 30_000,
    signal?: AbortSignal,
    caller = ROOT,
  ): Promise<{ message: string; timed_out: boolean }> {
    const id = this.resolveTarget(caller, ROOT);
    const requested = boundedInteger(
      timeoutMs,
      30_000,
      3_600_000,
      "timeout_ms",
    );
    const duration = Math.max(10_000, requested);
    const revision = this.userRevision;
    const deadline = Date.now() + duration;
    const pending = () =>
      id === ROOT
        ? this.rootMailbox.size !== 0 ||
          this.root?.hasPendingMessages() === true
        : this.requireAgent(id).mailbox.size !== 0;
    while (true) {
      signal?.throwIfAborted();
      if (pending())
        return { message: "Mailbox activity is available.", timed_out: false };
      if (id === ROOT && revision !== this.userRevision)
        return {
          message: "Wait interrupted by new user input.",
          timed_out: false,
        };
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        return { message: "Wait timed out.", timed_out: true };
      await this.waitForChange(
        remaining,
        signal,
        () => pending() || (id === ROOT && revision !== this.userRevision),
      );
    }
  }

  /** Internal evidence/fixture helper, intentionally absent from the six model tools. */
  public async waitForTurns(
    targets: readonly Pick<AgentTurnTarget, "agentId" | "turnId">[],
    mode: "any" | "all" = "all",
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<{ timedOut: boolean; results: readonly AgentTurnRecord[] }> {
    if (targets.length < 1 || targets.length > 32)
      throw new Error("Expected 1 to 32 turn targets");
    z.enum(["any", "all"]).parse(mode);
    const turns = targets.map((target) =>
      this.requireTurn(target.agentId, target.turnId),
    );
    const deadline =
      Date.now() + boundedInteger(timeoutMs, 30_000, 3_600_000, "timeoutMs");
    const ready = () =>
      mode === "all"
        ? turns.every((turn) => turn.result !== undefined)
        : turns.some((turn) => turn.result !== undefined);
    while (!ready() && Date.now() < deadline)
      await this.waitForChange(deadline - Date.now(), signal, ready);
    return {
      timedOut: !ready(),
      results: turns.flatMap((turn) =>
        turn.result === undefined ? [] : [turn.result],
      ),
    };
  }

  public async interruptAgent(
    target: string,
    caller = ROOT,
  ): Promise<{ previous_status: unknown }> {
    const sender = this.resolveTarget(caller, ROOT);
    const id = this.resolveTarget(target, sender);
    if (id === ROOT) throw new Error("Root is not a spawned agent");
    if (id === sender) throw new Error("An agent cannot interrupt itself");
    const entry = this.requireAgent(id);
    const previous_status = this.modelStatus(entry);
    this.cancelPending(entry, "cancelled", "Pending task was interrupted");
    if (entry.current !== undefined)
      await this.cancelTurn(entry, entry.current, "cancelled");
    else await entry.resource?.cancel();
    return { previous_status };
  }

  public closeAgent(agentId: string): Promise<void> {
    const entry = this.requireAgent(agentId);
    if (entry.closing !== undefined) return entry.closing;
    const closing = (async () => {
      entry.state = "closing";
      entry.cleanupBlocked = true;
      this.cancelPending(
        entry,
        "cancelled",
        "Agent was closed before its task started",
      );
      const errors: unknown[] = [];
      try {
        if (entry.current !== undefined)
          await this.cancelTurn(entry, entry.current, "cancelled");
      } catch (error) {
        errors.push(error);
      }
      await entry.loading?.catch(() => undefined);
      await entry.failing?.catch(() => undefined);
      this.rejectIpc(entry, new Error("Agent is closing"));
      entry.processGeneration += 1;
      const cleanup = await Promise.allSettled([
        entry.client?.close(),
        entry.resource?.close(),
      ]);
      errors.push(
        ...cleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        ),
      );
      if (cleanup[0]?.status === "fulfilled") {
        entry.client = undefined;
        entry.resident = false;
      }
      entry.resourcesClosed = cleanup.every(
        (result) => result.status === "fulfilled",
      );
      entry.cleanupBlocked = !entry.resourcesClosed;
      if (errors.length !== 0) {
        entry.state = "failed";
        entry.failure = `Agent cleanup failed: ${errors.map(errorText).join("; ")}`;
        this.changed();
        throw new AggregateError(errors, entry.failure);
      }
      entry.state = "closed";
      this.changed();
    })();
    entry.closing = closing;
    void closing.catch(() => {
      if (entry.closing === closing) entry.closing = undefined;
    });
    return closing;
  }

  public bindRoot(control: RootPiSessionControl): () => void {
    this.rootUnsubscribe?.();
    this.root = control;
    const activity = control.subscribeActivity(() => this.changed());
    const consumption = control.subscribeConsumption((ids) =>
      this.consume(this.rootMailbox, ids),
    );
    const unbind = () => {
      activity();
      consumption();
      if (this.root === control) this.root = undefined;
    };
    this.rootUnsubscribe = unbind;
    for (const message of this.rootMailbox.values()) this.deliverRoot(message);
    return unbind;
  }

  /** Headless Root settled: queued ordinary mail never starts another Root prompt. */
  public async drain(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.accepting = false;
    await this.stopWorkers();
  }

  public interrupt(): void {
    this.accepting = false;
    this.userRevision += 1;
    this.changed();
  }
  public onUserInput(): void {
    if (!this.disposed) this.accepting = true;
    this.userRevision += 1;
    this.root?.onUserInput();
    this.changed();
  }
  public describeAgents(): string {
    return JSON.stringify(this.listAllAgents(), null, 2);
  }

  public async stopAgents(): Promise<void> {
    this.interrupt();
    const stopped = await Promise.allSettled([
      this.root?.abort(),
      this.options.cancelRoot?.(),
      this.stopWorkers(),
    ]);
    const errors = stopped.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length !== 0)
      throw new AggregateError(
        errors,
        "Some agent resources could not be stopped",
      );
  }

  public async close(): Promise<void> {
    this.disposed = true;
    this.interrupt();
    const closed = await Promise.allSettled(
      [...this.agents.keys()].map((id) => this.closeAgent(id)),
    );
    await this.rootDelivery;
    this.rootUnsubscribe?.();
    const errors = closed.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length !== 0)
      throw new AggregateError(
        errors,
        "Some agent resources could not be closed",
      );
  }

  public get results(): readonly AgentTurnRecord[] {
    return [...this.agents.values()].flatMap((entry) =>
      [...entry.turns.values()].flatMap((turn) =>
        turn.result === undefined ? [] : [turn.result],
      ),
    );
  }
  public get messages(): readonly AgentMessageRecord[] {
    return this.messageRecords;
  }

  public async invokeCollaboration(
    name: string,
    input: unknown,
    signal?: AbortSignal,
    caller = ROOT,
  ): Promise<PiProxyToolResult> {
    const callerId = this.resolveTarget(caller, ROOT);
    let result: unknown;
    switch (name) {
      case "spawn_agent": {
        // Omitted tool fields are also rejected at the Host boundary, including
        // callers that bypass the model-facing JSON schema.
        const args = spawnArgumentsSchema.parse(
          this.spawnPolicy?.lockedRuntime === undefined
            ? input
            : lockedSpawnArgumentsSchema.parse(input),
        );
        const spawned = await this.spawnAgent(
          args.message,
          {
            taskName: args.task_name,
            ...(args.fork_turns === undefined
              ? {}
              : { forkTurns: args.fork_turns }),
            ...(args.model === undefined ? {} : { model: args.model }),
            ...(args.reasoning_effort === undefined
              ? {}
              : { reasoningEffort: args.reasoning_effort }),
          },
          callerId,
        );
        result = { agent_id: spawned.agentId, task_name: spawned.taskName };
        break;
      }
      case "list_agents": {
        const args = z
          .object({ path_prefix: z.string().optional() })
          .strict()
          .parse(input);
        const prefix =
          args.path_prefix === undefined
            ? ROOT
            : this.resolvePath(args.path_prefix, callerId);
        result = {
          agents: [
            ...(pathMatches(ROOT, prefix)
              ? [
                  {
                    agent_name: ROOT,
                    agent_status:
                      this.root?.isIdle() === false
                        ? "running"
                        : { completed: null },
                  },
                ]
              : []),
            ...[...this.agents.values()]
              .filter(
                (entry) =>
                  entry.resident && pathMatches(entry.taskName, prefix),
              )
              .sort((a, b) => a.taskName.localeCompare(b.taskName))
              .map((entry) => ({
                agent_name: entry.taskName,
                agent_status: this.modelStatus(entry),
              })),
          ],
        };
        break;
      }
      case "send_message": {
        const args = z
          .object({ target: textInput, message: textInput })
          .strict()
          .parse(input);
        await this.sendMessage(args.target, args.message, callerId);
        result = { queued: true };
        break;
      }
      case "followup_task": {
        const args = z
          .object({ target: textInput, message: textInput })
          .strict()
          .parse(input);
        await this.followupTask(args.target, args.message, callerId);
        result = { queued: true };
        break;
      }
      case "wait_agent": {
        const args = z
          .object({ timeout_ms: z.number().int().optional() })
          .strict()
          .parse(input);
        result = await this.waitAgent(args.timeout_ms, signal, callerId);
        break;
      }
      case "interrupt_agent": {
        const args = z.object({ target: textInput }).strict().parse(input);
        result = await this.interruptAgent(args.target, callerId);
        break;
      }
      default:
        throw new Error("Unknown collaboration tool");
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: result,
    };
  }

  private assertAccepting(): void {
    if (this.disposed || !this.accepting)
      throw new Error("Agent task admission is closed");
  }
  private assertSpawnPolicy(
    options: SpawnAgentOptions,
    parentPath: string,
  ): void {
    const policy = this.spawnPolicy;
    if (policy === null) return;
    if (
      policy.lockedRuntime !== undefined &&
      ("model" in options || "reasoningEffort" in options)
    )
      throw new Error(
        "Host spawn policy locks the worker runtime; model and reasoning overrides are forbidden",
      );
    const childDepth = parentPath.split("/").length - 1;
    if (policy.maxDepth !== undefined && childDepth > policy.maxDepth)
      throw new Error(
        `Host spawn policy permits a maximum agent depth of ${policy.maxDepth}`,
      );
    if (
      policy.maxCreatedAgents !== undefined &&
      this.agents.size >= policy.maxCreatedAgents
    )
      throw new Error(
        `Host spawn policy permits at most ${policy.maxCreatedAgents} created agent identities`,
      );
  }
  private assertEntryStarting(entry: AgentEntry): void {
    if (this.disposed || !this.accepting || entry.state !== "starting")
      throw new Error("Agent startup was cancelled");
  }
  private assertCapacity(): void {
    const active = [...this.agents.values()].filter(
      (entry) =>
        entry.current !== undefined ||
        entry.next !== undefined ||
        entry.state === "starting" ||
        entry.state === "closing" ||
        entry.cleanupBlocked,
    ).length;
    if (active >= this.maxAgents)
      throw new Error(
        `All ${this.maxAgents} non-root execution slots are occupied`,
      );
  }
  private resolvePath(reference: string, caller: string): string {
    return canonicalPath(
      reference.startsWith("/")
        ? reference
        : `${this.pathOf(caller)}/${reference}`,
    );
  }
  private resolveTarget(reference: string, caller: string): string {
    if (reference === ROOT) return ROOT;
    if (this.agents.has(reference)) return reference;
    const path = this.resolvePath(reference, caller);
    const id = this.paths.get(path);
    if (id === undefined) throw new Error(`Unknown agent ${path}`);
    return id;
  }
  private pathOf(id: string): string {
    return id === ROOT ? ROOT : this.requireAgent(id).taskName;
  }
  private requireAgent(id: string): AgentEntry {
    const entry =
      this.agents.get(id) ?? this.agents.get(this.paths.get(id) ?? "");
    if (entry === undefined) throw new Error(`Unknown agent ${id}`);
    return entry;
  }
  private requireLive(id: string): AgentEntry {
    const entry = this.requireAgent(id);
    if (entry.cleanupBlocked)
      throw new Error(`Agent ${entry.taskName} cleanup is incomplete`);
    if (
      entry.state === "closed" ||
      entry.state === "closing" ||
      entry.resourcesClosed === true
    )
      throw new Error(`Agent ${entry.taskName} is closed`);
    return entry;
  }
  private requireTurn(id: string, turnId: number): PendingTurn {
    z.number().int().positive().parse(turnId);
    const turn = this.requireAgent(id).turns.get(turnId);
    if (turn === undefined) throw new Error(`Unknown turn ${turnId} for ${id}`);
    return turn;
  }
  private modelStatus(entry: AgentEntry): unknown {
    if (entry.state === "starting") return "pending_init";
    if (entry.current !== undefined) return "running";
    if (entry.state === "closed" || entry.state === "closing")
      return "shutdown";
    if (entry.state === "failed")
      return { errored: entry.failure ?? "Worker failed" };
    const last = [...entry.turns.values()].at(-1)?.result;
    if (last?.status === "cancelled" || last?.status === "timed_out")
      return "interrupted";
    if (last?.status === "failed")
      return { errored: last.errorMessage ?? "Worker failed" };
    return { completed: last?.assistantText ?? null };
  }

  private envelope(
    from: string,
    to: string,
    kind: PiCollaborationMessage["kind"],
    text: string,
  ): PiCollaborationMessage {
    return {
      id: randomUUID(),
      kind,
      from: this.pathOf(from),
      to: this.pathOf(to),
      text,
      createdAt: new Date().toISOString(),
    };
  }
  private recordMessage(
    mailbox: Map<string, PiCollaborationMessage>,
    envelope: PiCollaborationMessage,
  ): void {
    if (mailbox.size >= MAX_MAILBOX) throw new Error("Agent mailbox is full");
    if (mailbox.has(envelope.id)) return;
    mailbox.set(envelope.id, envelope);
    this.recordTask(envelope);
    this.changed();
  }
  private recordTask(envelope: PiCollaborationMessage): void {
    if (
      this.messageRecords.some((record) => record.envelope.id === envelope.id)
    )
      return;
    this.messageRecords.push({
      envelope,
      queuedAt: new Date().toISOString(),
      consumedAt: null,
      deferredAt: null,
      submittedAt: null,
      error: null,
    });
  }
  private renderTasks(
    tasks: readonly Pick<PiCollaborationMessage, "from" | "to" | "text">[],
  ): string {
    const text = tasks
      .map((task) => `Task for ${task.to} from ${task.from}:\n${task.text}`)
      .join("\n\n");
    textInput.parse(text);
    return text;
  }
  private background(entry: AgentEntry, operation: Promise<unknown>): void {
    void operation.catch((error: unknown) => {
      entry.failure = errorText(error);
      if (entry.state !== "closed" && entry.state !== "closing")
        entry.state = "failed";
      this.changed();
    });
  }
  private consume(
    mailbox: Map<string, PiCollaborationMessage>,
    ids: readonly string[],
  ): void {
    for (const id of ids) {
      if (!mailbox.delete(id)) continue;
      const record = this.messageRecords.find(
        (item) => item.envelope.id === id,
      );
      if (record !== undefined) record.consumedAt = new Date().toISOString();
    }
    this.changed();
  }
  private failMessage(
    mailbox: Map<string, PiCollaborationMessage>,
    id: string,
    error: unknown,
  ): void {
    mailbox.delete(id);
    const record = this.messageRecords.find((item) => item.envelope.id === id);
    if (record !== undefined) record.error = errorText(error);
    this.changed();
  }
  private async queueMessage(envelope: PiCollaborationMessage): Promise<void> {
    const id = this.resolveTarget(envelope.to, ROOT);
    if (id === ROOT) {
      this.recordMessage(this.rootMailbox, envelope);
      this.deliverRoot(envelope);
      return;
    }
    const entry = this.requireLive(id);
    if (entry.mailbox.size >= MAX_MAILBOX)
      throw new Error("Agent mailbox is full");
    await this.ensureLoaded(entry);
    this.recordMessage(entry.mailbox, envelope);
    try {
      await this.deliverToWorker(entry, envelope);
    } catch (error) {
      this.failMessage(entry.mailbox, envelope.id, error);
      throw error;
    }
  }
  private deliverRoot(envelope: PiCollaborationMessage): void {
    this.rootDelivery = this.rootDelivery.then(async () => {
      const root = this.root;
      if (root === undefined || !this.rootMailbox.has(envelope.id)) return;
      try {
        await root.deliver(envelope);
      } catch (error) {
        const record = this.messageRecords.find(
          (item) => item.envelope.id === envelope.id,
        );
        if (record !== undefined) record.error = errorText(error);
      }
    });
  }
  private async deliverToWorker(
    entry: AgentEntry,
    envelope: PiCollaborationMessage,
  ): Promise<boolean> {
    if (entry.client === undefined) throw new Error("Worker is not loaded");
    const requestId = randomUUID();
    const response = this.ipcResponse(entry.deliveries, requestId);
    try {
      await entry.client.send({
        version: 2,
        type: "collaboration",
        requestId,
        envelope,
      });
    } catch (error) {
      this.rejectRequest(entry.deliveries, requestId, error);
    }
    return await response;
  }
  private async exportContext(
    id: string,
    forkTurns: string,
  ): Promise<PiSessionForkContext> {
    if (id === ROOT) {
      if (this.root === undefined)
        throw new Error("Root Session is unavailable for context fork");
      return this.root.exportForkContext(forkTurns);
    }
    const entry = this.requireLive(id);
    await this.ensureLoaded(entry);
    const requestId = randomUUID();
    const response = this.ipcResponse(entry.exports, requestId);
    try {
      await entry.client!.send({
        version: 2,
        type: "export_context",
        requestId,
        forkTurns,
      });
    } catch (error) {
      this.rejectRequest(entry.exports, requestId, error);
    }
    return await response;
  }
  private ipcResponse<T>(
    requests: Map<string, Request<T>>,
    id: string,
  ): Promise<T> {
    if (requests.size >= AGENT_IPC_MAX_PENDING)
      throw new Error("Too many pending worker control requests");
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error("Worker control response timed out"));
      }, IPC_RESPONSE_TIMEOUT_MS);
      requests.set(id, { resolve, reject, timer });
    });
    void response.catch(() => undefined);
    return response;
  }
  private rejectRequest<T>(
    requests: Map<string, Request<T>>,
    id: string,
    error: unknown,
  ): void {
    const pending = requests.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    requests.delete(id);
    pending.reject(new Error(errorText(error)));
  }
  private rejectIpc(entry: AgentEntry, error: Error): void {
    for (const id of entry.deliveries.keys())
      this.rejectRequest(entry.deliveries, id, error);
    for (const id of entry.exports.keys())
      this.rejectRequest(entry.exports, id, error);
  }

  private async reserveResident(entry: AgentEntry): Promise<void> {
    const operation = this.residencyOperation.then(async () => {
      if (entry.resident) return;
      const residents = [...this.agents.values()].filter(
        (agent) => agent.resident,
      );
      if (residents.length >= this.maxAgents) {
        const candidate = residents
          .filter(
            (agent) =>
              agent !== entry &&
              agent.current === undefined &&
              agent.next === undefined &&
              agent.state === "idle" &&
              agent.mailbox.size === 0 &&
              agent.requests.size === 0 &&
              agent.deliveries.size === 0 &&
              agent.exports.size === 0 &&
              agent.sessionFile !== undefined,
          )
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (candidate === undefined)
          throw new Error(
            `All ${this.maxAgents} worker residency slots are occupied`,
          );
        candidate.processGeneration += 1;
        candidate.cleanupBlocked = true;
        const cleanup = await Promise.allSettled([
          candidate.resource?.cancel(),
          candidate.client?.close(),
        ]);
        if (cleanup[1]?.status === "fulfilled") {
          candidate.client = undefined;
          candidate.resident = false;
        }
        const errors = cleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        );
        if (errors.length !== 0) {
          candidate.state = "failed";
          candidate.failure = `Worker eviction cleanup failed: ${errors.map(errorText).join("; ")}`;
          throw new AggregateError(errors, candidate.failure);
        }
        candidate.cleanupBlocked = false;
      }
      entry.resident = true;
      entry.lastUsed = ++this.clock;
      this.changed();
    });
    this.residencyOperation = operation.catch(() => undefined);
    await operation;
  }
  private async loadWorker(entry: AgentEntry): Promise<void> {
    if (entry.configuration === undefined)
      throw new Error("Worker configuration is unavailable");
    await this.reserveResident(entry);
    const generation = ++entry.processGeneration;
    entry.failing = undefined;
    const { forkContext, ...resumeConfiguration } = entry.configuration;
    try {
      const client = await this.workerFactory({
        configuration: {
          ...(entry.sessionFile === undefined
            ? {
                ...resumeConfiguration,
                ...(forkContext === undefined ? {} : { forkContext }),
              }
            : resumeConfiguration),
          ...(entry.sessionFile === undefined
            ? {}
            : { resumeSessionFile: entry.sessionFile }),
        },
        onMessage: (message) => {
          if (entry.processGeneration === generation)
            this.handleMessage(entry, message);
        },
        onExit: (error) => {
          if (entry.processGeneration === generation)
            this.background(entry, this.workerFailed(entry, error));
        },
      });
      // Retain ownership before attempting cancellation cleanup. A failed close
      // must remain reachable for the Host's final cleanup retry.
      entry.client = client;
      if (
        entry.processGeneration !== generation ||
        this.disposed ||
        entry.state === "closing" ||
        entry.state === "closed"
      ) {
        await client.close();
        entry.client = undefined;
        throw new Error("Agent startup was cancelled");
      }
      for (const message of entry.mailbox.values())
        await this.deliverToWorker(entry, message);
    } catch (error) {
      entry.resident = entry.client !== undefined;
      if (entry.client !== undefined) {
        entry.cleanupBlocked = true;
        if (entry.state !== "closing" && entry.state !== "closed")
          entry.state = "failed";
      }
      throw error;
    }
  }
  private async ensureLoaded(entry: AgentEntry): Promise<void> {
    if (entry.loading !== undefined) return await entry.loading;
    if (entry.client !== undefined && entry.failing === undefined) {
      entry.lastUsed = ++this.clock;
      return;
    }
    const loading = (async () => {
      if (entry.failing !== undefined) await entry.failing;
      if (entry.cleanupBlocked)
        throw new Error(`Agent ${entry.taskName} cleanup is incomplete`);
      if (entry.client === undefined) await this.loadWorker(entry);
    })();
    entry.loading = loading;
    try {
      await loading;
    } finally {
      if (entry.loading === loading) entry.loading = undefined;
    }
  }

  private makeTurn(
    entry: AgentEntry,
    task: PiCollaborationMessage,
  ): PendingTurn {
    this.recordTask(task);
    let resolve: (result: AgentTurnRecord) => void = () => undefined;
    const done = new Promise<AgentTurnRecord>((accept) => {
      resolve = accept;
    });
    const turn: PendingTurn = {
      turnId: entry.nextTurnId++,
      task: task.text,
      tasks: [task],
      done,
      resolve,
      startedAt: null,
      toolCalls: 0,
    };
    entry.turns.set(turn.turnId, turn);
    return turn;
  }
  private startNext(entry: AgentEntry): void {
    if (
      entry.state !== "idle" ||
      entry.current !== undefined ||
      entry.next === undefined ||
      this.disposed ||
      !this.accepting
    )
      return;
    const turn = entry.next;
    entry.next = undefined;
    entry.current = turn;
    entry.state = "running";
    entry.lastUsed = ++this.clock;
    turn.startedAt = new Date().toISOString();
    turn.timer = setTimeout(() => {
      this.background(
        entry,
        this.cancelTurn(entry, turn, "timed_out").catch((error: unknown) =>
          this.workerFailed(entry, error),
        ),
      );
    }, this.timeoutMs);
    const text = this.renderTasks(turn.tasks);
    this.changed();
    this.background(
      entry,
      entry.client
        ?.send({ version: 2, type: "prompt", turnId: turn.turnId, text })
        .then(() => {
          for (const task of turn.tasks) {
            const record = this.messageRecords.find(
              (item) => item.envelope.id === task.id,
            );
            if (record !== undefined)
              record.submittedAt = new Date().toISOString();
          }
        })
        .catch((error: unknown) => this.workerFailed(entry, error)) ??
        Promise.resolve(),
    );
  }

  private handleMessage(entry: AgentEntry, message: AgentWorkerMessage): void {
    if (message.type === "ready") return;
    if (message.type === "fatal") {
      this.background(
        entry,
        this.workerFailed(entry, new Error(message.error)),
      );
      return;
    }
    if (message.type === "phase") {
      if (message.phase === "current") {
        for (const task of entry.current?.tasks ?? []) {
          const record = this.messageRecords.find(
            (item) => item.envelope.id === task.id,
          );
          if (record !== undefined)
            record.consumedAt ??= new Date().toISOString();
        }
      }
      return;
    }
    if (message.type === "collaboration_consumed") {
      this.consume(entry.mailbox, message.ids);
      return;
    }
    if (message.type === "collaboration_accepted") {
      const request = entry.deliveries.get(message.requestId);
      if (request !== undefined) {
        clearTimeout(request.timer);
        entry.deliveries.delete(message.requestId);
        request.resolve(message.acceptedInCurrentTurn);
      }
      return;
    }
    if (message.type === "context_exported") {
      const request = entry.exports.get(message.requestId);
      if (request !== undefined) {
        clearTimeout(request.timer);
        entry.exports.delete(message.requestId);
        request.resolve(message.context);
      }
      return;
    }
    const turn = entry.current;
    if (
      turn === undefined ||
      !("turnId" in message) ||
      message.turnId !== turn.turnId ||
      turn.result !== undefined
    )
      return;
    if (message.type === "tool_request") {
      this.handleTool(entry, turn, message);
      return;
    }
    if (message.type === "tool_cancel") {
      entry.requests.get(message.requestId)?.controller.abort();
      return;
    }
    if (message.type !== "completed" && message.type !== "failed") return;
    turn.settledAt = new Date().toISOString();
    const result: AgentTurnCompletion =
      message.type === "failed"
        ? {
            agentId: entry.agentId,
            turnId: turn.turnId,
            status: turn.forcedStatus ?? "failed",
            assistantText: "",
            errorMessage: message.error,
          }
        : {
            agentId: entry.agentId,
            turnId: turn.turnId,
            status:
              turn.forcedStatus ??
              (message.result.status === "completed"
                ? "completed"
                : message.result.status === "timed_out"
                  ? "timed_out"
                  : message.result.status === "aborted"
                    ? "cancelled"
                    : "failed"),
            assistantText: message.result.assistantText,
            errorMessage: message.result.errorMessage,
            piResult: message.result,
          };
    this.background(entry, this.finish(entry, turn, result));
  }

  private handleTool(
    entry: AgentEntry,
    turn: PendingTurn,
    message: Extract<AgentWorkerMessage, { type: "tool_request" }>,
  ): void {
    const respond = async (result: PiProxyToolResult) => {
      if (entry.current === turn && turn.result === undefined)
        await entry.client?.send({
          version: 2,
          type: "tool_result",
          turnId: turn.turnId,
          requestId: message.requestId,
          result,
        });
    };
    const reject = (reason: string) => {
      this.background(
        entry,
        respond(agentToolError(reason)).catch((error: unknown) =>
          this.workerFailed(entry, error),
        ),
      );
    };
    if (turn.forcedStatus !== undefined || turn.finishing !== undefined) {
      reject("Agent turn is stopping");
      return;
    }
    if (entry.requests.has(message.requestId)) {
      this.background(
        entry,
        this.workerFailed(entry, new Error("Worker reused a tool request ID")),
      );
      return;
    }
    if (entry.requests.size >= AGENT_IPC_MAX_PENDING) {
      reject("Too many outstanding worker tool requests");
      return;
    }
    const collaboration = CONTROL_NAMES.has(message.name);
    if (
      !collaboration &&
      !entry.resource?.workerConfiguration.tools.some(
        (tool) => tool.name === message.name,
      )
    ) {
      reject("Tool is not available to this worker");
      return;
    }
    if (
      !collaboration &&
      message.name !== "game_stop" &&
      turn.toolCalls >= this.turnToolCallLimit
    ) {
      reject(`Worker turn tool budget exhausted (${this.turnToolCallLimit})`);
      return;
    }
    if (!collaboration && message.name !== "game_stop") turn.toolCalls += 1;
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(async () => {
        try {
          const result = collaboration
            ? await this.invokeCollaboration(
                message.name,
                message.arguments,
                controller.signal,
                entry.agentId,
              )
            : await entry.resource!.invokeTool(
                message,
                controller.signal,
                (result) => {
                  if (entry.current === turn && turn.forcedStatus === undefined)
                    this.background(
                      entry,
                      entry.client
                        ?.send({
                          version: 2,
                          type: "tool_update",
                          turnId: turn.turnId,
                          requestId: message.requestId,
                          result,
                        })
                        .catch((error: unknown) =>
                          this.workerFailed(entry, error),
                        ) ?? Promise.resolve(),
                    );
                },
              );
          await respond(result);
        } catch (error) {
          await respond(agentToolError(errorText(error)));
        }
      })
      .catch((error: unknown) => {
        this.background(entry, this.workerFailed(entry, error));
      })
      .finally(() => {
        entry.requests.delete(message.requestId);
        this.changed();
      });
    entry.requests.set(message.requestId, { controller, done });
  }

  private async finish(
    entry: AgentEntry,
    turn: PendingTurn,
    result: AgentTurnCompletion,
  ): Promise<void> {
    if (turn.finishing !== undefined) return await turn.finishing;
    if (turn.result !== undefined) return;
    turn.finishing = (async () => {
      if (turn.timer !== undefined) clearTimeout(turn.timer);
      if (turn.interruptTimer !== undefined) clearTimeout(turn.interruptTimer);
      let completion = result;
      let evidence: unknown;
      let resourcesSettled = false;
      try {
        for (const request of entry.requests.values())
          request.controller.abort();
        await entry.resource?.cancel();
        await Promise.all(
          [...entry.requests.values()].map((request) => request.done),
        );
        resourcesSettled = true;
        evidence = await entry.resource?.finishTurn(turn.turnId, completion);
      } catch (error) {
        entry.failure = `Result capture failed: ${errorText(error)}`;
        entry.state = entry.state === "closing" ? "closing" : "failed";
        this.cancelPending(entry, "failed", entry.failure);
        if (!resourcesSettled) {
          entry.processGeneration += 1;
          this.rejectIpc(entry, new Error(entry.failure));
          const cleanup = await Promise.allSettled([
            entry.client?.close(),
            entry.resource?.close(),
          ]);
          entry.resourcesClosed = cleanup.every(
            (result) => result.status === "fulfilled",
          );
          entry.cleanupBlocked = !entry.resourcesClosed;
          if (cleanup[0]?.status === "fulfilled") {
            entry.client = undefined;
            entry.resident = false;
          }
          if (!entry.resourcesClosed)
            entry.failure += `; cleanup: ${cleanup.flatMap((result) => (result.status === "rejected" ? [errorText(result.reason)] : [])).join("; ")}`;
        }
        completion = {
          ...completion,
          status:
            completion.status === "completed" ? "failed" : completion.status,
          errorMessage: [completion.errorMessage, entry.failure]
            .filter(Boolean)
            .join("; "),
        };
      }
      if (completion.piResult !== undefined) {
        entry.sessionFile = completion.piResult.sessionFile;
        entry.sessionId = completion.piResult.sessionId;
      }
      const record: AgentTurnRecord = Object.freeze({
        ...completion,
        taskName: entry.taskName,
        parentAgentId: entry.parentAgentId,
        task: turn.task,
        startedAt: turn.startedAt,
        settledAt: turn.settledAt ?? null,
        finishedAt: new Date().toISOString(),
        ...(evidence === undefined ? {} : { evidence }),
      });
      turn.result = record;
      try {
        await this.options.onResult?.(record);
      } catch (error) {
        entry.failure = `Result persistence failed: ${errorText(error)}`;
      }
      if (entry.current === turn) entry.current = undefined;
      if (entry.state === "running") entry.state = "idle";
      entry.lastUsed = ++this.clock;
      turn.resolve(record);
      const fullSummary = `${record.status}. Completed means the loop finished, not acceptance.\n${record.assistantText}${record.errorMessage === null ? "" : `\nError: ${record.errorMessage}`}`;
      const summary =
        Buffer.byteLength(fullSummary) > 60 * 1024
          ? `${Buffer.from(fullSummary)
              .subarray(0, 60 * 1024)
              .toString(
                "utf8",
              )}\n[Completion truncated; full record retained by Host]`
          : fullSummary;
      try {
        await this.queueMessage(
          this.envelope(
            entry.agentId,
            entry.parentAgentId,
            "completion",
            summary,
          ),
        );
      } catch (error) {
        entry.failure = `Completion delivery failed: ${errorText(error)}`;
      }
      this.changed();
      this.startNext(entry);
    })();
    return await turn.finishing;
  }
  private cancelPending(
    entry: AgentEntry,
    status: "cancelled" | "failed",
    reason: string,
  ): void {
    const turn = entry.next;
    if (turn === undefined) return;
    entry.next = undefined;
    const record: AgentTurnRecord = Object.freeze({
      agentId: entry.agentId,
      taskName: entry.taskName,
      parentAgentId: entry.parentAgentId,
      turnId: turn.turnId,
      task: turn.task,
      startedAt: null,
      finishedAt: new Date().toISOString(),
      status,
      assistantText: "",
      errorMessage: reason,
    });
    turn.result = record;
    turn.resolve(record);
    void Promise.resolve()
      .then(() => this.options.onResult?.(record))
      .catch((error: unknown) => {
        entry.failure = errorText(error);
      });
    this.changed();
  }
  private async cancelTurn(
    entry: AgentEntry,
    turn: PendingTurn,
    status: "cancelled" | "timed_out",
  ): Promise<void> {
    if (turn.result !== undefined) return;
    turn.forcedStatus ??= status;
    for (const request of entry.requests.values()) request.controller.abort();
    if (turn.finishing === undefined && turn.interruptTimer === undefined) {
      turn.interruptTimer = setTimeout(() => {
        void (async () => {
          entry.processGeneration += 1;
          this.rejectIpc(
            entry,
            new Error("Worker was terminated after cancellation"),
          );
          let closeFailure: unknown;
          try {
            await entry.client?.close();
            entry.client = undefined;
            entry.resident = false;
          } catch (error) {
            closeFailure = error;
            entry.cleanupBlocked = true;
            if (entry.state !== "closing") entry.state = "failed";
          }
          await this.finish(entry, turn, {
            agentId: entry.agentId,
            turnId: turn.turnId,
            status,
            assistantText: "",
            errorMessage:
              closeFailure === undefined
                ? "Worker did not settle after cancellation and was terminated"
                : `Worker did not settle; termination failed: ${errorText(closeFailure)}`,
          });
        })().catch((error: unknown) => {
          entry.failure = errorText(error);
          this.changed();
        });
      }, this.interruptGraceMs);
      await entry.client
        ?.send({ version: 2, type: "interrupt", turnId: turn.turnId })
        .catch(() => undefined);
    }
    await entry.resource?.cancel();
    await turn.done;
  }
  private async workerFailed(entry: AgentEntry, error: unknown): Promise<void> {
    if (entry.state === "closed") return;
    entry.failing ??= (async () => {
      entry.failure = errorText(error);
      entry.cleanupBlocked = true;
      if (entry.state !== "closing") entry.state = "failed";
      this.rejectIpc(entry, new Error(entry.failure));
      this.cancelPending(entry, "failed", entry.failure);
      if (entry.current !== undefined)
        await this.finish(entry, entry.current, {
          agentId: entry.agentId,
          turnId: entry.current.turnId,
          status: entry.current.forcedStatus ?? "failed",
          assistantText: "",
          errorMessage: entry.failure,
        });
      entry.processGeneration += 1;
      const cleanup = await Promise.allSettled([
        entry.resource?.cancel(),
        entry.client?.close(),
      ]);
      if (cleanup[1]?.status === "fulfilled") {
        entry.client = undefined;
        entry.resident = false;
      }
      entry.cleanupBlocked = cleanup.some(
        (result) => result.status === "rejected",
      );
      const errors = cleanup.flatMap((result) =>
        result.status === "rejected" ? [errorText(result.reason)] : [],
      );
      if (errors.length !== 0)
        entry.failure += `; cleanup: ${errors.join("; ")}`;
      this.changed();
    })();
    await entry.failing;
  }
  private async stopWorkers(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.agents.values()].map(async (entry) => {
        this.cancelPending(
          entry,
          "cancelled",
          "Task stopped before activation",
        );
        if (entry.current !== undefined)
          await this.cancelTurn(entry, entry.current, "cancelled");
        await entry.loading?.catch(() => undefined);
        if (entry.cleanupBlocked) await this.closeAgent(entry.agentId);
      }),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length !== 0)
      throw new AggregateError(errors, "Workers failed to stop");
  }
  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
  private async waitForChange(
    timeoutMs: number,
    signal?: AbortSignal,
    ready: () => boolean = () => false,
  ): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        this.listeners.delete(finish);
        signal?.removeEventListener("abort", abort);
      };
      const finish = () => {
        clean();
        resolve();
      };
      const abort = () => {
        clean();
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Agent wait cancelled"),
        );
      };
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
      this.listeners.add(finish);
      signal?.addEventListener("abort", abort, { once: true });
      // Subscribe before the final check so an arriving message cannot be lost.
      if (ready()) finish();
      else if (signal?.aborted === true) abort();
    });
  }
}

const messageSchema = Type.String({
  minLength: 1,
  maxLength: AGENT_MESSAGE_MAX_LENGTH,
});
function descriptor(
  name: string,
  description: string,
  properties: Parameters<typeof Type.Object>[0],
  promptGuidelines?: readonly string[],
): PiProxyToolDescriptor {
  return {
    name,
    description,
    parameters: Type.Object(properties, {
      additionalProperties: false,
    }) as unknown as Record<string, unknown>,
    ...(promptGuidelines === undefined ? {} : { promptGuidelines }),
  };
}
function spawnPolicyDescription(policy: AgentSpawnPolicy | null): string {
  if (policy === null) return "";
  const constraints = [
    ...(policy.maxCreatedAgents === undefined
      ? []
      : [
          `At most ${policy.maxCreatedAgents} non-root agent identities may be created over this run, including failed, closed and unloaded agents.`,
        ]),
    ...(policy.maxDepth === undefined
      ? []
      : [`Maximum agent depth is ${policy.maxDepth}; Root has depth zero.`]),
    ...(policy.lockedRuntime === undefined
      ? []
      : [
          `Worker runtime is fixed to ${policy.lockedRuntime.provider}/${policy.lockedRuntime.model} with thinking level ${policy.lockedRuntime.thinkingLevel}; omit model and reasoning_effort.`,
        ]),
  ];
  return constraints.length === 0
    ? ""
    : `Host spawn policy: ${constraints.join(" ")}`;
}

function collaborationDescriptors(
  policy: AgentSpawnPolicy | null = null,
): PiProxyToolDescriptor[] {
  return [
    descriptor(
      "spawn_agent",
      [
        "Optionally spawn an agent for a bounded independent task that replaces work you would otherwise do. Zero workers is valid. Do not duplicate an investigation assigned to another agent. All agents share the candidate. task_name is relative to you; use canonical paths to address siblings. fork_turns defaults to all and inherits filtered conversation context; none starts from the task alone.",
        spawnPolicyDescription(policy),
      ]
        .filter(Boolean)
        .join("\n"),
      {
        message: messageSchema,
        task_name: Type.String({ pattern: "^[a-z0-9_]+$", maxLength: 128 }),
        fork_turns: Type.Optional(Type.String()),
        ...(policy?.lockedRuntime === undefined
          ? {
              model: Type.Optional(Type.String()),
              reasoning_effort: Type.Optional(
                Type.Union(
                  [
                    "off",
                    "minimal",
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "max",
                  ].map((value) => Type.Literal(value)),
                ),
              ),
            }
          : {}),
      },
      [
        "Use Adaptive Multi: worker capacity is a ceiling, not a target. For a small or tightly coupled task, use zero workers. Delegate only a concrete, independently completable subtask that replaces Root's later work and can proceed alongside useful work by Root; otherwise continue locally.",
        "Before delegating, identify the distinct result needed, its scope, and the evidence to return. Do not assign the same investigation to multiple workers or continue that investigation yourself while a worker owns it.",
        "Root should integrate supported worker findings, make the necessary changes, and validate the final candidate. Do not fully repeat a completed investigation with concrete evidence; recheck only an identified gap, conflict, or evidence made stale by changes. Worker observations do not replace final validation of the edited candidate. Once a minimal fix passes the relevant final-candidate checks, finish and report remaining limits. Revisit an equivalent fix or repeat the same validation only for an observed failure, a concrete uncovered acceptance requirement, conflicting evidence, or changed source. A worker suggesting an alternative alone is not a reason to reopen a validated fix. Successful runtime checks are not complete acceptance.",
      ],
    ),
    descriptor(
      "list_agents",
      "List currently loaded agents in the current root tree, optionally under a relative or canonical path prefix.",
      { path_prefix: Type.Optional(Type.String()) },
    ),
    descriptor(
      "send_message",
      "Queue information for an agent. This does not start an idle agent turn.",
      { target: Type.String(), message: messageSchema },
    ),
    descriptor(
      "followup_task",
      "Give a non-root agent a task, including resuming an agent that already finished its previous task. Busy agents consume it at the next safe boundary; idle agents start one turn. Workers do not need to remain in wait_agent for future tasks.",
      { target: Type.String(), message: messageSchema },
    ),
    descriptor(
      "wait_agent",
      "Wait for a result needed to continue the current task when no independent work remains. Returns a summary of mailbox activity or new user input; messages are delivered through the normal inbox. Timeout does not cancel workers; waiting keeps your execution slot. Once your assigned task is complete, give your final answer and end the turn instead of waiting to remain online; use followup_task for later work.",
      {
        timeout_ms: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 3_600_000 }),
        ),
      },
    ),
    descriptor(
      "interrupt_agent",
      "Interrupt another non-root agent's current turn, retaining its Session and changes. Descendants are not interrupted.",
      { target: Type.String() },
    ),
  ];
}

export function createAgentSupervisorTools(
  supervisor: AgentSupervisor,
): ReturnType<typeof createPiProxyToolDefinitions> {
  return createPiProxyToolDefinitions(
    collaborationDescriptors(supervisor.effectiveSpawnPolicy),
    async (request, signal) =>
      await supervisor.invokeCollaboration(
        request.name,
        request.arguments,
        signal,
      ),
  );
}
