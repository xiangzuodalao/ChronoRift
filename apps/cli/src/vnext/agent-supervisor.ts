import { z } from "zod";
import { Type } from "typebox";

import {
  createPiProxyToolDefinitions,
  type PiProxyToolDescriptor,
  type PiProxyToolResult,
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
  readonly task: string;
  readonly startedAt: string | null;
  readonly finishedAt: string;
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
  readResult(
    this: void,
    turnId: number,
    section: "summary" | "diff" | "evidence",
    offset?: number,
    limit?: number,
  ): Promise<unknown>;
  apply(this: void, turnId: number): Promise<unknown>;
  cancel(this: void): Promise<void>;
  close(this: void): Promise<void>;
}

export type AgentResourceFactory = (agentId: string) => Promise<AgentResource>;

export interface AgentSupervisorOptions {
  readonly createResource: AgentResourceFactory;
  readonly cancelRoot?: () => Promise<void>;
  readonly maxAgents?: number;
  readonly turnTimeoutMs?: number;
  readonly interruptGraceMs?: number;
  readonly workerFactory?: AgentWorkerFactory;
  readonly onResult?: (record: AgentTurnRecord) => void | Promise<void>;
}

export interface AgentTurnTarget {
  readonly agentId: string;
  readonly turnId: number;
}

interface PendingTurn {
  readonly turnId: number;
  readonly task: string;
  readonly prompt: string;
  readonly done: Promise<AgentTurnRecord>;
  readonly resolve: (result: AgentTurnRecord) => void;
  startedAt: string | null;
  timer?: ReturnType<typeof setTimeout>;
  interruptTimer?: ReturnType<typeof setTimeout>;
  finishing?: Promise<void>;
  forcedStatus?: "cancelled" | "timed_out";
  toolCalls: number;
  result?: AgentTurnRecord;
}

interface AgentEntry {
  readonly agentId: string;
  readonly turns: Map<number, PendingTurn>;
  readonly queue: PendingTurn[];
  readonly requests: Map<
    string,
    {
      readonly turnId: number;
      readonly controller: AbortController;
      readonly done: Promise<void>;
    }
  >;
  resource?: AgentResource;
  client?: AgentWorkerClient;
  state: "starting" | "idle" | "running" | "closing" | "closed" | "failed";
  current?: PendingTurn | undefined;
  nextTurnId: number;
  closing?: Promise<void>;
  failing?: Promise<void>;
  startupDone?: Promise<void>;
  resourcesClosed?: boolean;
  failure?: string;
}

const MAX_QUEUE = 8;
const MAX_NOTIFICATIONS = 512;
const TURN_TOOL_BUDGET = 64;
const CONTROL_NAMES = new Set([
  "spawn_agent",
  "list_agents",
  "followup_task",
  "wait_agent",
  "read_agent_result",
  "interrupt_agent",
  "close_agent",
  "apply_agent_patch",
]);
const textInput = z.string().trim().min(1).max(AGENT_MESSAGE_MAX_LENGTH);
const agentIdInput = z.string().regex(/^agent-[1-9][0-9]*$/u);
const turnIdInput = z.number().int().positive();
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
  if (!Number.isInteger(selected) || selected < 1 || selected > maximum)
    throw new TypeError(`${name} must be an integer from 1 to ${maximum}`);
  return selected;
};
const workerMessageDescriptor: PiProxyToolDescriptor = {
  name: "send_message",
  description:
    "Send an observation or question to the Root agent. This does not grant permissions or complete your task.",
  parameters: Type.Object(
    {
      message: Type.String({
        minLength: 1,
        maxLength: AGENT_MESSAGE_MAX_LENGTH,
      }),
    },
    { additionalProperties: false },
  ) as unknown as Record<string, unknown>,
};

export class AgentSupervisor implements RootCollaborationPort {
  private readonly agents = new Map<string, AgentEntry>();
  private readonly notifications: string[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly maxAgents: number;
  private readonly timeoutMs: number;
  private readonly interruptGraceMs: number;
  private readonly workerFactory: AgentWorkerFactory;
  private nextAgentId = 1;
  private root: RootPiSessionControl | undefined;
  private generation = 0;
  private autoContinue = true;
  private disposed = false;
  private drainPromise: Promise<void> | undefined;
  private backgroundDelivery: Promise<void> | undefined;
  private notificationOverflow = 0;

  public constructor(private readonly options: AgentSupervisorOptions) {
    this.maxAgents = boundedInteger(options.maxAgents, 3, 4, "maxAgents");
    this.timeoutMs = boundedInteger(
      options.turnTimeoutMs,
      600_000,
      3_600_000,
      "turnTimeoutMs",
    );
    this.interruptGraceMs = boundedInteger(
      options.interruptGraceMs,
      2_000,
      30_000,
      "interruptGraceMs",
    );
    this.workerFactory = options.workerFactory ?? createNodeAgentWorker;
  }

  public async spawnAgent(
    task: string,
    context?: string,
  ): Promise<AgentTurnTarget> {
    textInput.parse(task);
    if (context !== undefined) textInput.parse(context);
    const prompt =
      context === undefined
        ? task
        : `${task}\n\nBackground supplied by Root:\n${context}`;
    textInput.parse(prompt);
    if (this.disposed) throw new Error("Agent supervisor is closed");
    const live = [...this.agents.values()].filter(
      (agent) =>
        agent.state !== "closed" &&
        !(agent.state === "failed" && agent.resourcesClosed === true),
    ).length;
    if (live >= this.maxAgents)
      throw new Error(
        `All ${this.maxAgents} worker slots are occupied; close an idle worker first`,
      );
    const agentId = `agent-${this.nextAgentId++}`;
    const entry: AgentEntry = {
      agentId,
      state: "starting",
      turns: new Map(),
      queue: [],
      requests: new Map(),
      nextTurnId: 1,
    };
    this.agents.set(agentId, entry);
    const turn = this.makeTurn(entry, task, prompt);
    entry.queue.push(turn);
    let resolveStartup: () => void = () => undefined;
    entry.startupDone = new Promise<void>((resolve) => {
      resolveStartup = resolve;
    });
    this.changed();
    try {
      entry.resource = await this.options.createResource(agentId);
      if (this.disposed || entry.state !== "starting")
        throw new Error("Agent startup was cancelled");
      const configuration = entry.resource.workerConfiguration;
      if (
        configuration.tools.some(
          (tool) =>
            CONTROL_NAMES.has(tool.name) || tool.name === "send_message",
        )
      )
        throw new Error(
          "Worker resource cannot expose Root collaboration tools",
        );
      const client = await this.workerFactory({
        configuration: {
          ...configuration,
          tools: [...configuration.tools, workerMessageDescriptor],
          additionalEnvironmentInstructions: [
            configuration.additionalEnvironmentInstructions,
            `You are ${agentId}, delegated by Root. Work only on your assigned task. Your workspace and game executions are independent. Send useful findings to Root with send_message. A completed turn is not acceptance of a fix.`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
        onMessage: (message) => {
          this.handleMessage(entry, message);
        },
        onExit: (error) => {
          void this.workerFailed(entry, error).catch((failure: unknown) => {
            entry.failure = errorText(failure);
            this.changed();
          });
        },
      });
      entry.client = client;
      if (this.disposed || entry.state !== "starting") {
        await client.close();
        throw new Error("Agent startup was cancelled");
      }
      entry.state = "idle";
      this.startNext(entry);
      return { agentId, turnId: turn.turnId };
    } catch (error) {
      await this.workerFailed(entry, error);
      throw error;
    } finally {
      resolveStartup();
    }
  }

  public listAgents(): readonly {
    agentId: string;
    state: AgentEntry["state"];
    currentTurnId: number | null;
    queuedTurns: number;
    completedTurns: number;
    failure: string | null;
  }[] {
    return [...this.agents.values()].map((entry) => ({
      agentId: entry.agentId,
      state: entry.state,
      currentTurnId: entry.current?.turnId ?? null,
      queuedTurns: entry.queue.length,
      completedTurns: [...entry.turns.values()].filter(
        (turn) => turn.result !== undefined,
      ).length,
      failure: entry.failure ?? null,
    }));
  }

  public async sendMessage(agentId: string, message: string): Promise<void> {
    textInput.parse(message);
    const entry = this.requireLive(agentId);
    if (entry.client === undefined)
      throw new Error("Agent worker is still starting");
    await entry.client.send({ version: 1, type: "message", text: message });
  }

  public followupTask(agentId: string, task: string): AgentTurnTarget {
    textInput.parse(task);
    const entry = this.requireLive(agentId);
    if (entry.queue.length >= MAX_QUEUE)
      throw new Error(`Agent already has ${MAX_QUEUE} queued tasks`);
    const turn = this.makeTurn(entry, task, task);
    entry.queue.push(turn);
    this.startNext(entry);
    this.changed();
    return { agentId, turnId: turn.turnId };
  }

  public async waitAgent(
    targets: readonly AgentTurnTarget[],
    mode: "any" | "all" = "all",
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<{ timedOut: boolean; results: readonly AgentTurnRecord[] }> {
    if (targets.length === 0 || targets.length > 32)
      throw new Error("wait_agent requires 1 to 32 targets");
    z.enum(["any", "all"]).parse(mode);
    const duration = boundedInteger(
      timeoutMs,
      30_000,
      3_600_000,
      "wait timeoutMs",
    );
    const turns = targets.map((target) =>
      this.requireTurn(target.agentId, target.turnId),
    );
    const end = Date.now() + duration;
    while (
      !(mode === "any"
        ? turns.some((turn) => turn.result !== undefined)
        : turns.every((turn) => turn.result !== undefined))
    ) {
      signal?.throwIfAborted();
      const remaining = end - Date.now();
      if (remaining <= 0)
        return {
          timedOut: true,
          results: turns.flatMap((turn) =>
            turn.result === undefined ? [] : [turn.result],
          ),
        };
      await this.waitForChange(remaining, signal);
    }
    const results = turns.flatMap((turn) =>
      turn.result === undefined ? [] : [turn.result],
    );
    for (const result of results) this.consumeCompletion(result);
    return { timedOut: false, results };
  }

  public async readAgentResult(
    agentId: string,
    turnId: number,
    section: "summary" | "diff" | "evidence" = "summary",
    offset = 0,
    limit = 16_384,
  ): Promise<unknown> {
    const entry = this.requireAgent(agentId);
    const turn = this.requireTurn(agentId, turnId);
    if (turn.result === undefined)
      throw new Error("Agent turn has not finished");
    z.enum(["summary", "diff", "evidence"]).parse(section);
    z.number().int().min(0).parse(offset);
    boundedInteger(limit, 16_384, 65_536, "result limit");
    if (section !== "summary")
      return (
        (await entry.resource?.readResult(turnId, section, offset, limit)) ?? {
          available: false,
        }
      );
    this.consumeCompletion(turn.result);
    const { assistantText, status, errorMessage, task, startedAt, finishedAt } =
      turn.result;
    const summary = {
      agentId,
      turnId,
      status,
      errorMessage,
      task,
      startedAt,
      finishedAt,
    };
    const data = Buffer.from(assistantText);
    const text = data.subarray(offset, offset + limit).toString("utf8");
    return {
      ...summary,
      text,
      nextOffset: Math.min(data.length, offset + limit),
      totalBytes: data.length,
      truncated: offset + limit < data.length,
    };
  }

  public async applyAgentPatch(
    agentId: string,
    turnId: number,
  ): Promise<unknown> {
    const entry = this.requireAgent(agentId);
    const turn = this.requireTurn(agentId, turnId);
    if (turn.result === undefined || turn.result.evidence === undefined)
      throw new Error("Agent turn has no frozen candidate");
    if (entry.resource === undefined)
      throw new Error("Agent resource is unavailable");
    return await entry.resource.apply(turnId);
  }

  public async interruptAgent(agentId: string): Promise<void> {
    const entry = this.requireAgent(agentId);
    this.cancelQueued(entry, "cancelled", "Queued task was cancelled");
    const turn = entry.current;
    if (turn === undefined) {
      await entry.resource?.cancel();
      return;
    }
    await this.cancelTurn(entry, turn, "cancelled");
  }

  public closeAgent(agentId: string): Promise<void> {
    const entry = this.requireAgent(agentId);
    entry.closing ??= (async () => {
      entry.state = "closing";
      const errors: unknown[] = [];
      this.cancelQueued(
        entry,
        "cancelled",
        "Agent was closed before the task started",
      );
      if (entry.current !== undefined) {
        try {
          await this.cancelTurn(entry, entry.current, "cancelled");
        } catch (error) {
          errors.push(error);
        }
      }
      await entry.startupDone;
      const cleanup = await Promise.allSettled([
        entry.client?.close(),
        entry.resource?.close(),
      ]);
      errors.push(
        ...cleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        ),
      );
      if (entry.current !== undefined) {
        await this.finish(entry, entry.current, {
          agentId,
          turnId: entry.current.turnId,
          status: "cancelled",
          assistantText: "",
          errorMessage: "Agent closed during resource cleanup",
        });
      }
      if (errors.length !== 0) {
        entry.state = "failed";
        throw new AggregateError(errors, `Agent ${agentId} cleanup failed`);
      }
      entry.resourcesClosed = true;
      entry.state = "closed";
      this.changed();
    })();
    return entry.closing;
  }

  public bindRoot(control: RootPiSessionControl): () => void {
    this.root = control;
    this.generation += 1;
    this.changed();
    return () => {
      if (this.root === control) {
        this.root = undefined;
        this.generation += 1;
        this.changed();
      }
    };
  }

  public drain(signal?: AbortSignal): Promise<void> {
    this.drainPromise ??= this.drainResults(signal).finally(() => {
      this.drainPromise = undefined;
    });
    return this.drainPromise;
  }

  public interrupt(): void {
    this.autoContinue = false;
    this.generation += 1;
    this.changed();
  }
  public onUserInput(): void {
    this.autoContinue = true;
    this.changed();
  }
  public describeAgents(): string {
    return JSON.stringify(this.listAgents(), null, 2);
  }

  public async stopAgents(): Promise<void> {
    this.interrupt();
    const results = await Promise.allSettled([
      this.root?.abort(),
      this.options.cancelRoot?.(),
      ...[...this.agents.values()]
        .filter((entry) => entry.state !== "closed" && entry.state !== "failed")
        .map((entry) => this.interruptAgent(entry.agentId)),
    ]);
    this.notifications.length = 0;
    this.notificationOverflow = 0;
    const errors = results.flatMap((result) =>
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
    const results = await Promise.allSettled(
      [...this.agents.keys()].map((agentId) => this.closeAgent(agentId)),
    );
    const errors = results.flatMap((result) =>
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

  private makeTurn(
    entry: AgentEntry,
    task: string,
    prompt: string,
  ): PendingTurn {
    let resolve: (result: AgentTurnRecord) => void = () => undefined;
    const done = new Promise<AgentTurnRecord>((resolveResult) => {
      resolve = resolveResult;
    });
    const turn: PendingTurn = {
      turnId: entry.nextTurnId++,
      task,
      prompt,
      done,
      resolve,
      startedAt: null,
      toolCalls: 0,
    };
    entry.turns.set(turn.turnId, turn);
    return turn;
  }

  private startNext(entry: AgentEntry): void {
    if (entry.state !== "idle" || entry.current !== undefined || this.disposed)
      return;
    const turn = entry.queue.shift();
    if (turn === undefined) return;
    entry.current = turn;
    entry.state = "running";
    turn.startedAt = new Date().toISOString();
    turn.timer = setTimeout(() => {
      void this.cancelTurn(entry, turn, "timed_out").catch((error: unknown) => {
        void this.workerFailed(entry, error);
      });
    }, this.timeoutMs);
    this.changed();
    void entry.client
      ?.send({
        version: 1,
        type: "prompt",
        turnId: turn.turnId,
        text: turn.prompt,
      })
      .catch((error: unknown) => this.workerFailed(entry, error));
  }

  private handleMessage(entry: AgentEntry, message: AgentWorkerMessage): void {
    const turn = entry.current;
    if (message.type === "ready") return;
    if (message.type === "fatal") {
      void this.workerFailed(entry, new Error(message.error));
      return;
    }
    if (
      turn === undefined ||
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
    void this.finish(entry, turn, result);
  }

  private handleTool(
    entry: AgentEntry,
    turn: PendingTurn,
    message: Extract<AgentWorkerMessage, { type: "tool_request" }>,
  ): void {
    const respond = async (result: PiProxyToolResult): Promise<void> => {
      if (entry.current === turn && turn.result === undefined)
        await entry.client?.send({
          version: 1,
          type: "tool_result",
          turnId: turn.turnId,
          requestId: message.requestId,
          result,
        });
    };
    const reject = (reason: string): void => {
      void respond(agentToolError(reason)).catch((error: unknown) =>
        this.workerFailed(entry, error),
      );
    };
    if (turn.forcedStatus !== undefined || turn.finishing !== undefined) {
      reject("Agent turn is stopping");
      return;
    }
    if (entry.requests.has(message.requestId)) {
      void this.workerFailed(
        entry,
        new Error("Worker reused a tool request ID"),
      );
      return;
    }
    if (entry.requests.size >= AGENT_IPC_MAX_PENDING) {
      reject("Too many outstanding worker tool requests");
      return;
    }
    if (message.name === "send_message") {
      try {
        const args = z
          .object({ message: textInput })
          .strict()
          .parse(message.arguments);
        if (this.notifications.length >= MAX_NOTIFICATIONS) {
          reject(
            "Root message queue is full; wait before sending more messages",
          );
          return;
        }
        this.notify(
          `Message from ${entry.agentId}, turn ${turn.turnId} (collaboration information):\n${args.message}`,
        );
        void respond({
          content: [{ type: "text", text: "Message queued for Root" }],
        }).catch((error: unknown) => this.workerFailed(entry, error));
      } catch (error) {
        reject(errorText(error));
      }
      return;
    }
    if (
      !entry.resource?.workerConfiguration.tools.some(
        (tool) => tool.name === message.name,
      )
    ) {
      reject("Tool is not available to this worker");
      return;
    }
    if (message.name !== "game_stop" && turn.toolCalls >= TURN_TOOL_BUDGET) {
      reject(`Worker turn tool budget exhausted (${TURN_TOOL_BUDGET})`);
      return;
    }
    if (message.name !== "game_stop") turn.toolCalls += 1;
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(async () => {
        try {
          const result = await entry.resource!.invokeTool(
            message,
            controller.signal,
            (update) => {
              if (entry.current !== turn || turn.forcedStatus !== undefined)
                return;
              void entry.client
                ?.send({
                  version: 1,
                  type: "tool_update",
                  turnId: turn.turnId,
                  requestId: message.requestId,
                  result: update,
                })
                .catch((error: unknown) => this.workerFailed(entry, error));
            },
          );
          await respond(result);
        } catch (error) {
          await respond(agentToolError(errorText(error)));
        }
      })
      .catch((error: unknown) => {
        void this.workerFailed(entry, error);
      })
      .finally(() => {
        entry.requests.delete(message.requestId);
        this.changed();
      });
    entry.requests.set(message.requestId, {
      turnId: turn.turnId,
      controller,
      done,
    });
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
        if (!resourcesSettled) {
          if (entry.state !== "closing") entry.state = "failed";
          entry.failure = `Worker resources failed to stop: ${errorText(error)}`;
          this.cancelQueued(entry, "failed", entry.failure);
          const stopped = await Promise.allSettled([
            entry.client?.close(),
            entry.resource?.close(),
          ]);
          entry.resourcesClosed = stopped.every(
            (result) => result.status === "fulfilled",
          );
        }
        completion = {
          ...completion,
          status:
            completion.status === "completed" ? "failed" : completion.status,
          errorMessage: [
            completion.errorMessage,
            `Result capture failed: ${errorText(error)}`,
          ]
            .filter(Boolean)
            .join("; "),
        };
      }
      const record = Object.freeze({
        ...completion,
        task: turn.task,
        startedAt: turn.startedAt,
        finishedAt: new Date().toISOString(),
        ...(evidence === undefined ? {} : { evidence }),
      });
      turn.result = record;
      try {
        await this.options.onResult?.(record);
      } catch (error) {
        entry.failure = `Result persistence failed: ${errorText(error)}`;
      }
      turn.resolve(record);
      if (entry.current === turn) entry.current = undefined;
      if (entry.state === "running") entry.state = "idle";
      this.notify(
        `Agent ${entry.agentId}, turn ${turn.turnId} ${record.status}. Completed means the loop finished, not acceptance.\n${record.assistantText.slice(0, 16_384)}${record.assistantText.length > 16_384 ? "\n[Summary truncated; use read_agent_result]" : ""}${record.errorMessage === null ? "" : `\nError: ${record.errorMessage}`}`,
      );
      this.changed();
      this.startNext(entry);
    })();
    return await turn.finishing;
  }

  private cancelQueued(
    entry: AgentEntry,
    status: "cancelled" | "failed",
    reason: string,
  ): void {
    for (const turn of entry.queue.splice(0)) {
      const record: AgentTurnRecord = Object.freeze({
        agentId: entry.agentId,
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
      this.notify(
        `Agent ${entry.agentId}, queued turn ${turn.turnId} ${status}: ${reason}`,
      );
      void Promise.resolve(this.options.onResult?.(record)).catch(
        (error: unknown) => {
          entry.failure = `Result persistence failed: ${errorText(error)}`;
        },
      );
    }
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
        entry.state = entry.state === "closing" ? "closing" : "failed";
        entry.failure =
          "Worker did not settle after cancellation and was terminated";
        void (async () => {
          await entry.client?.close().catch((error: unknown) => {
            entry.failure += `; process cleanup: ${errorText(error)}`;
          });
          await this.finish(entry, turn, {
            agentId: entry.agentId,
            turnId: turn.turnId,
            status,
            assistantText: "",
            errorMessage: entry.failure ?? "Worker was terminated",
          });
          this.cancelQueued(entry, "cancelled", "Worker was terminated");
          await entry.resource?.close();
          entry.resourcesClosed = true;
        })().catch((error: unknown) => {
          entry.failure = errorText(error);
          this.changed();
        });
      }, this.interruptGraceMs);
      await entry.client
        ?.send({ version: 1, type: "interrupt", turnId: turn.turnId })
        .catch(() => undefined);
    }
    await entry.resource?.cancel();
    await turn.done;
  }

  private async workerFailed(entry: AgentEntry, error: unknown): Promise<void> {
    if (entry.state === "closed") return;
    entry.failing ??= (async () => {
      entry.failure = errorText(error);
      if (entry.state !== "closing") entry.state = "failed";
      this.cancelQueued(entry, "failed", entry.failure);
      if (entry.current !== undefined) {
        const turn = entry.current;
        await this.finish(entry, turn, {
          agentId: entry.agentId,
          turnId: turn.turnId,
          status: turn.forcedStatus ?? "failed",
          assistantText: "",
          errorMessage: entry.failure,
        });
      }
      const cleanup = await Promise.allSettled([
        entry.resource?.cancel(),
        entry.client?.close(),
      ]);
      await entry.resource?.close();
      const errors = cleanup.flatMap((result) =>
        result.status === "rejected" ? [errorText(result.reason)] : [],
      );
      if (errors.length !== 0)
        entry.failure += `; cleanup: ${errors.join("; ")}`;
      else entry.resourcesClosed = true;
      this.changed();
    })();
    return await entry.failing;
  }

  private requireAgent(agentId: string): AgentEntry {
    agentIdInput.parse(agentId);
    const entry = this.agents.get(agentId);
    if (entry === undefined) throw new Error(`Unknown agent ${agentId}`);
    return entry;
  }
  private requireLive(agentId: string): AgentEntry {
    const entry = this.requireAgent(agentId);
    if (
      entry.state === "closed" ||
      entry.state === "closing" ||
      entry.state === "failed"
    )
      throw new Error(`Agent ${agentId} is ${entry.state}`);
    return entry;
  }
  private requireTurn(agentId: string, turnId: number): PendingTurn {
    turnIdInput.parse(turnId);
    const turn = this.requireAgent(agentId).turns.get(turnId);
    if (turn === undefined)
      throw new Error(`Unknown turn ${turnId} for ${agentId}`);
    return turn;
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  private notify(message: string): void {
    if (this.notifications.length >= MAX_NOTIFICATIONS) {
      this.notifications.shift();
      this.notificationOverflow += 1;
    }
    this.notifications.push(message);
    this.changed();
    this.deliverWhileRootRuns();
  }
  private consumeCompletion(result: AgentTurnCompletion): void {
    const prefix = `Agent ${result.agentId}, turn ${result.turnId} `;
    for (let index = this.notifications.length - 1; index >= 0; index -= 1) {
      if (this.notifications[index]?.startsWith(prefix))
        this.notifications.splice(index, 1);
    }
  }
  private deliverWhileRootRuns(): void {
    if (
      this.backgroundDelivery !== undefined ||
      !this.autoContinue ||
      this.root === undefined ||
      this.root.isIdle() ||
      this.disposed
    )
      return;
    const control = this.root;
    const generation = this.generation;
    let delivered = false;
    this.backgroundDelivery = Promise.resolve()
      .then(async () => {
        if (
          this.root !== control ||
          generation !== this.generation ||
          !this.autoContinue ||
          control.isIdle()
        )
          return;
        const messages = this.notifications.splice(0, 16);
        if (messages.length === 0) return;
        try {
          await control.deliver(
            `Worker collaboration information; assess against actual source and execution evidence.\n${messages.join("\n\n")}`,
          );
          delivered = true;
        } catch {
          if (this.root === control && generation === this.generation)
            this.notifications.unshift(...messages);
        }
      })
      .finally(() => {
        this.backgroundDelivery = undefined;
        this.changed();
        if (delivered && this.notifications.length !== 0)
          this.deliverWhileRootRuns();
      });
  }
  private async waitForChange(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.listeners.delete(finish);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = (): void => {
        clearTimeout(timer);
        this.listeners.delete(finish);
        signal?.removeEventListener("abort", abort);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Agent wait cancelled"),
        );
      };
      const timer = setTimeout(finish, timeoutMs);
      this.listeners.add(finish);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  private async drainResults(signal?: AbortSignal): Promise<void> {
    const generation = this.generation;
    const control = this.root;
    if (control === undefined) return;
    while (
      this.autoContinue &&
      generation === this.generation &&
      this.root === control &&
      !this.disposed
    ) {
      signal?.throwIfAborted();
      if (this.backgroundDelivery !== undefined) {
        await this.backgroundDelivery;
        continue;
      }
      if (!control.isIdle()) {
        await this.waitForChange(25, signal);
        continue;
      }
      if (this.notifications.length !== 0) {
        const messages = this.notifications.splice(0, 16);
        const dropped = this.notificationOverflow;
        this.notificationOverflow = 0;
        await control.deliver(
          `Worker collaboration information; assess findings using actual source and execution evidence.\n${dropped === 0 ? "" : `[${dropped} older notifications omitted; durable turn results remain available.]\n`}${messages.join("\n\n")}`,
        );
        continue;
      }
      if (
        ![...this.agents.values()].some(
          (entry) =>
            entry.current !== undefined ||
            entry.queue.length !== 0 ||
            entry.state === "starting",
        )
      )
        return;
      await this.waitForChange(60_000, signal);
    }
  }
}

const targetSchema = Type.Object(
  { agentId: Type.String(), turnId: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
const named = { agentId: Type.String() };
const numbered = { ...named, turnId: Type.Integer({ minimum: 1 }) };
const messageSchema = Type.String({
  minLength: 1,
  maxLength: AGENT_MESSAGE_MAX_LENGTH,
});
const descriptor = (
  name: string,
  description: string,
  properties: Parameters<typeof Type.Object>[0],
): PiProxyToolDescriptor => ({
  name,
  description,
  parameters: Type.Object(properties, {
    additionalProperties: false,
  }) as unknown as Record<string, unknown>,
});

export function createAgentSupervisorTools(
  supervisor: AgentSupervisor,
): ReturnType<typeof createPiProxyToolDefinitions> {
  const descriptors: PiProxyToolDescriptor[] = [
    descriptor(
      "spawn_agent",
      "Delegate an independent bounded task to a new Pi worker with its own candidate workspace. Returns immediately after startup. Only Root can spawn.",
      { task: messageSchema, context: Type.Optional(messageSchema) },
    ),
    descriptor(
      "list_agents",
      "Inspect worker state and queue occupancy. Idle workers still occupy slots.",
      {},
    ),
    descriptor(
      "send_message",
      "Send a correction or finding to an existing worker without starting a new task.",
      { ...named, message: messageSchema },
    ),
    descriptor(
      "followup_task",
      "Queue another task in an existing worker Session and workspace.",
      { ...named, task: messageSchema },
    ),
    descriptor(
      "wait_agent",
      "Wait for specified immutable turn results. A timeout does not cancel workers.",
      {
        targets: Type.Array(targetSchema, { minItems: 1, maxItems: 32 }),
        mode: Type.Optional(
          Type.Union([Type.Literal("any"), Type.Literal("all")]),
        ),
        timeoutMs: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 3_600_000 }),
        ),
      },
    ),
    descriptor(
      "read_agent_result",
      "Read a finished worker summary, candidate diff, or execution evidence with pagination.",
      {
        ...numbered,
        section: Type.Optional(
          Type.Union([
            Type.Literal("summary"),
            Type.Literal("diff"),
            Type.Literal("evidence"),
          ]),
        ),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_536 })),
      },
    ),
    descriptor(
      "interrupt_agent",
      "Cancel the current worker turn and queued tasks; retain a cooperative worker Session.",
      named,
    ),
    descriptor(
      "close_agent",
      "Close a worker and free its slot; retain recorded candidates and evidence.",
      named,
    ),
    descriptor(
      "apply_agent_patch",
      "Explicitly merge a frozen worker candidate into Root. Conflicts leave Root unchanged; verify the merged candidate afterwards.",
      numbered,
    ),
  ];
  return createPiProxyToolDefinitions(descriptors, async (request, signal) => {
    const args = z.record(z.string(), z.unknown()).parse(request.arguments);
    const agentId = (): string => agentIdInput.parse(args.agentId);
    const turnId = (): number => turnIdInput.parse(args.turnId);
    let result: unknown;
    switch (request.name) {
      case "spawn_agent":
        result = await supervisor.spawnAgent(
          textInput.parse(args.task),
          args.context === undefined
            ? undefined
            : textInput.parse(args.context),
        );
        break;
      case "list_agents":
        result = supervisor.listAgents();
        break;
      case "send_message":
        await supervisor.sendMessage(agentId(), textInput.parse(args.message));
        result = { queued: true };
        break;
      case "followup_task":
        result = supervisor.followupTask(agentId(), textInput.parse(args.task));
        break;
      case "wait_agent": {
        const targets = z
          .array(
            z.object({ agentId: agentIdInput, turnId: turnIdInput }).strict(),
          )
          .min(1)
          .max(32)
          .parse(args.targets);
        const waited = await supervisor.waitAgent(
          targets,
          args.mode === undefined
            ? "all"
            : z.enum(["any", "all"]).parse(args.mode),
          args.timeoutMs === undefined
            ? 30_000
            : z.number().parse(args.timeoutMs),
          signal,
        );
        result = {
          timedOut: waited.timedOut,
          results: waited.results.map(
            ({
              agentId: id,
              turnId: number,
              status,
              assistantText,
              errorMessage,
            }) => ({
              agentId: id,
              turnId: number,
              status,
              assistantText: assistantText.slice(0, 4096),
              truncated: assistantText.length > 4096,
              errorMessage,
            }),
          ),
        };
        break;
      }
      case "read_agent_result":
        result = await supervisor.readAgentResult(
          agentId(),
          turnId(),
          args.section === undefined
            ? "summary"
            : z.enum(["summary", "diff", "evidence"]).parse(args.section),
          args.offset === undefined ? 0 : z.number().parse(args.offset),
          args.limit === undefined ? 16_384 : z.number().parse(args.limit),
        );
        break;
      case "interrupt_agent":
        await supervisor.interruptAgent(agentId());
        result = { interrupted: true };
        break;
      case "close_agent":
        await supervisor.closeAgent(agentId());
        result = { closed: true };
        break;
      case "apply_agent_patch":
        result = await supervisor.applyAgentPatch(agentId(), turnId());
        break;
      default:
        throw new Error("Unknown collaboration tool");
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: result,
    };
  });
}
