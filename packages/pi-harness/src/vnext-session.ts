import { join, resolve } from "node:path";

import type { Api, Model, Transport } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ModelRuntime,
  type SessionStats,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { PiThinkingLevel } from "./types.js";
import {
  abortPiSession,
  type RootCollaborationPort,
} from "./root-collaboration.js";
import { configureVNextPiHostHttpTransport } from "./vnext-host-http.js";

export const VNEXT_ENVIRONMENT_APPENDIX = `ChronoRift environment:
- Your file and command tools execute inside the task workspace shown as your current working directory.
- Network and Host credentials are unavailable inside sandboxed commands.
- Game tools operate on task-owned resource IDs; resource IDs are not filesystem paths.
- Requested controls are requests. Runtime receipts report realized values and known side effects.
- Runtime records carry observation coverage, checkpoint fidelity, clock uncertainty, and capture loss.
- Unsupported capabilities, unavailable history, restore gaps, conflicts, exhausted budgets, and runtime failures are structured recoverable tool results when recovery is available.
- Report only checks you actually ran and their observed results. Finishing the Agent Loop does not prove a bug is fixed.`;

export const VNEXT_CODING_ENVIRONMENT_APPENDIX = `Task environment:
- Your file and command tools execute inside the task workspace shown as your current working directory.
- Network and Host credentials are unavailable inside sandboxed commands.
- Unsupported operations and exhausted budgets are returned as structured tool results when recovery is available.
- Report only checks you actually ran and their observed results. Finishing the Agent Loop does not prove a bug is fixed.`;

export interface RunVNextPiTurnOptions {
  readonly resourceWorkspaceDirectory: string;
  readonly sessionDirectory: string;
  /** Host-selected ID for a new durable Session; forbidden when resuming. */
  readonly newSessionId?: string | undefined;
  readonly resumeSessionFile?: string | undefined;
  readonly agentDir?: string | undefined;
  readonly modelRuntime: ModelRuntime;
  readonly model: Model<Api>;
  readonly thinkingLevel: PiThinkingLevel;
  readonly prompt: string;
  readonly tools: readonly ToolDefinition[];
  readonly timeoutMs?: number | undefined;
  /** Idle timeout for one provider request, independent of the whole Agent turn. */
  readonly providerRequestTimeoutMs?: number | undefined;
  /** Pi-level retries after a failed assistant request. Provider SDK retries stay disabled. */
  readonly agentRetryMaxRetries?: number | undefined;
  readonly transport?: Transport | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Defaults to the game-capable appendix retained by existing vNext paths. */
  readonly environmentProfile?: "game" | "coding" | undefined;
  readonly additionalEnvironmentInstructions?: string | undefined;
  readonly onEvent?: ((event: AgentSessionEvent) => void) | undefined;
  readonly collaboration?: RootCollaborationPort | undefined;
}

export type RunVNextPiSdkTurnOptions = Omit<
  RunVNextPiTurnOptions,
  "modelRuntime" | "model"
> & {
  readonly provider: string;
  readonly model: string;
};

export interface VNextPiTurnResult {
  readonly schemaVersion: 1;
  readonly status: "completed" | "provider_failed" | "aborted" | "timed_out";
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly provider: string;
  readonly model: string;
  readonly requestedThinkingLevel: PiThinkingLevel;
  readonly realizedThinkingLevel: PiThinkingLevel;
  readonly activeTools: readonly string[];
  readonly assistantText: string;
  readonly errorMessage: string | null;
  readonly eventsObserved: number;
  readonly stats: SessionStats;
}

interface VNextPiSessionDependencies {
  readonly createSession: (
    options: CreateAgentSessionOptions,
  ) => Promise<CreateAgentSessionResult>;
}

const DEFAULT_DEPENDENCIES: VNextPiSessionDependencies = {
  createSession: (options) => createAgentSession(options),
};

const boundedTimeout = (value: number | undefined): number => {
  const timeoutMs = value ?? 600_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error("timeoutMs must be an integer from 1 to 3600000");
  }
  return timeoutMs;
};

const boundedProviderRequestTimeout = (
  value: number | undefined,
): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 600_000) {
    throw new Error(
      "providerRequestTimeoutMs must be an integer from 1 to 600000",
    );
  }
  return value;
};

const boundedAgentRetryMaxRetries = (value: number | undefined): number => {
  const retries = value ?? 2;
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
    throw new Error("agentRetryMaxRetries must be an integer from 0 to 10");
  }
  return retries;
};

const normalizedToolNames = (tools: readonly ToolDefinition[]): string[] => {
  if (tools.length === 0) throw new Error("at least one Pi tool is required");
  const names = tools.map((tool) => tool.name);
  if (
    names.some((name) => name.length === 0) ||
    new Set(names).size !== names.length
  ) {
    throw new Error("Pi tools must have unique non-empty names");
  }
  return names;
};

const isTextPart = (
  value: unknown,
): value is { readonly type: "text"; readonly text: string } =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  value.type === "text" &&
  "text" in value &&
  typeof value.text === "string";

const assistantText = (messages: readonly unknown[]): string => {
  const latest = [...messages].reverse().find((message) => {
    return (
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "assistant"
    );
  });
  if (
    typeof latest !== "object" ||
    latest === null ||
    !("content" in latest) ||
    !Array.isArray(latest.content)
  ) {
    return "";
  }
  return (latest.content as unknown[])
    .filter(isTextPart)
    .map((part) => part.text)
    .join("");
};

export const finalAssistantFailure = (
  messages: readonly unknown[],
):
  | { readonly status: "provider_failed" | "aborted"; readonly message: string }
  | undefined => {
  const latest = [...messages].reverse().find((message) => {
    return (
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "assistant"
    );
  });
  if (
    typeof latest !== "object" ||
    latest === null ||
    !("stopReason" in latest)
  ) {
    return undefined;
  }
  if (latest.stopReason !== "error" && latest.stopReason !== "aborted") {
    return undefined;
  }
  const message =
    "errorMessage" in latest && typeof latest.errorMessage === "string"
      ? latest.errorMessage
      : `Pi ended with ${latest.stopReason}`;
  return {
    status: latest.stopReason === "error" ? "provider_failed" : "aborted",
    message,
  };
};

export type CreateManagedPiSessionOptions = Omit<
  RunVNextPiTurnOptions,
  "prompt" | "timeoutMs" | "signal" | "collaboration"
>;

export type CreateManagedPiSdkSessionOptions = Omit<
  RunVNextPiSdkTurnOptions,
  "prompt" | "timeoutMs" | "signal" | "collaboration"
>;

export interface PiSessionMessageOptions {
  readonly triggerTurn?: boolean;
  readonly deliverAs?: "steer" | "followUp" | "nextTurn";
  readonly source?: Readonly<Record<string, unknown>>;
}

export interface ManagedPiSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isIdle: boolean;
  readonly activeTools: readonly string[];
  prompt(text: string): Promise<void>;
  sendMessage(text: string, options?: PiSessionMessageOptions): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  snapshot(
    status?: VNextPiTurnResult["status"],
    errorMessage?: string | null,
  ): VNextPiTurnResult;
  dispose(): void;
}

export const resolvePiHostAgentDirectory = (agentDir?: string): string =>
  resolve(agentDir ?? getAgentDir());

/** Snapshot an existing Pi Session without creating a model request. */
export function snapshotPiSession(
  session: AgentSession,
  options: {
    readonly provider: string;
    readonly model: string;
    readonly thinkingLevel: PiThinkingLevel;
    readonly eventsObserved: number;
  },
  status?: VNextPiTurnResult["status"],
  errorMessage?: string | null,
): VNextPiTurnResult {
  const sessionFile = session.sessionFile;
  if (sessionFile === undefined)
    throw new Error("Pi did not persist the vNext session");
  const failure = finalAssistantFailure(session.messages);
  return {
    schemaVersion: 1,
    status: status ?? failure?.status ?? "completed",
    sessionId: session.sessionId,
    sessionFile,
    provider: options.provider,
    model: options.model,
    requestedThinkingLevel: options.thinkingLevel,
    realizedThinkingLevel: session.thinkingLevel,
    activeTools: Object.freeze([...session.getActiveToolNames()]),
    assistantText: assistantText(session.messages),
    errorMessage:
      errorMessage === undefined ? (failure?.message ?? null) : errorMessage,
    eventsObserved: options.eventsObserved,
    stats: session.getSessionStats(),
  };
}

export async function createManagedPiSession(
  options: CreateManagedPiSessionOptions,
  overrides: Partial<VNextPiSessionDependencies> = {},
): Promise<ManagedPiSession> {
  const toolNames = normalizedToolNames(options.tools);
  const providerRequestTimeoutMs = boundedProviderRequestTimeout(
    options.providerRequestTimeoutMs,
  );
  const agentRetryMaxRetries = boundedAgentRetryMaxRetries(
    options.agentRetryMaxRetries,
  );
  const resourceWorkspaceDirectory = resolve(
    options.resourceWorkspaceDirectory,
  );
  const sessionDirectory = resolve(options.sessionDirectory);
  const agentDir = resolvePiHostAgentDirectory(options.agentDir);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    ...(options.transport === undefined
      ? {}
      : { transport: options.transport }),
    ...(providerRequestTimeoutMs === undefined
      ? {}
      : { httpIdleTimeoutMs: providerRequestTimeoutMs }),
    retry: {
      enabled: true,
      maxRetries: agentRetryMaxRetries,
      ...(providerRequestTimeoutMs === undefined
        ? {}
        : {
            provider: {
              timeoutMs: providerRequestTimeoutMs,
              maxRetries: 0,
              maxRetryDelayMs: 1_000,
            },
          }),
    },
  });
  const appendSystemPrompt = [
    options.environmentProfile === "coding"
      ? VNEXT_CODING_ENVIRONMENT_APPENDIX
      : VNEXT_ENVIRONMENT_APPENDIX,
    ...(options.additionalEnvironmentInstructions === undefined
      ? []
      : [options.additionalEnvironmentInstructions]),
  ];
  const resourceLoader = new DefaultResourceLoader({
    cwd: resourceWorkspaceDirectory,
    agentDir,
    settingsManager,
    noExtensions: true,
    noThemes: true,
    appendSystemPrompt,
  });
  await resourceLoader.reload();
  const sessionManager =
    options.resumeSessionFile === undefined
      ? SessionManager.create(resourceWorkspaceDirectory, sessionDirectory, {
          ...(options.newSessionId === undefined
            ? {}
            : { id: options.newSessionId }),
        })
      : SessionManager.open(
          resolve(options.resumeSessionFile),
          sessionDirectory,
          resourceWorkspaceDirectory,
        );
  if (
    options.resumeSessionFile !== undefined &&
    options.newSessionId !== undefined
  ) {
    throw new Error("newSessionId cannot be supplied when resuming a Session");
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const created = await dependencies.createSession({
    cwd: resourceWorkspaceDirectory,
    agentDir,
    modelRuntime: options.modelRuntime,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    noTools: "all",
    tools: toolNames,
    customTools: [...options.tools],
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  const { session, extensionsResult } = created;
  if (extensionsResult.extensions.length !== 0) {
    session.dispose();
    throw new Error("vNext Pi session loaded executable extensions");
  }
  if (extensionsResult.errors.length !== 0) {
    session.dispose();
    throw new Error(
      `vNext Pi extension loading failed: ${extensionsResult.errors
        .map((entry) => `${entry.path}: ${entry.error}`)
        .join("; ")}`,
    );
  }
  const activeTools = session.getActiveToolNames();
  if (
    activeTools.length !== toolNames.length ||
    toolNames.some((name) => !activeTools.includes(name))
  ) {
    session.dispose();
    throw new Error(
      `Pi activated an unexpected tool set: ${activeTools.join(", ")}`,
    );
  }

  let eventsObserved = 0;
  let disposed = false;
  const unsubscribe = session.subscribe((event) => {
    eventsObserved += 1;
    options.onEvent?.(event);
  });
  const assertOpen = (): void => {
    if (disposed) throw new Error("Pi session is disposed");
  };
  return {
    get sessionId() {
      return session.sessionId;
    },
    get sessionFile() {
      return session.sessionFile;
    },
    get isIdle() {
      return session.isIdle;
    },
    activeTools: Object.freeze([...activeTools]),
    prompt: async (text) => {
      assertOpen();
      if (text.trim().length === 0) throw new Error("prompt must not be empty");
      await session.prompt(text, { expandPromptTemplates: true });
    },
    sendMessage: async (text, messageOptions = {}) => {
      assertOpen();
      if (text.trim().length === 0)
        throw new Error("message must not be empty");
      await session.sendCustomMessage(
        {
          customType: "chronorift.collaboration",
          content: text,
          display: true,
          details: {
            source: messageOptions.source ?? { kind: "agent-message" },
          },
        },
        {
          triggerTurn: messageOptions.triggerTurn ?? false,
          deliverAs: messageOptions.deliverAs ?? "followUp",
        },
      );
    },
    abort: () => abortPiSession(session),
    waitForIdle: () => session.waitForIdle(),
    subscribe: (listener) => {
      assertOpen();
      return session.subscribe(listener);
    },
    snapshot: (status, errorMessage) => {
      assertOpen();
      return snapshotPiSession(
        session,
        {
          provider: options.model.provider,
          model: options.model.id,
          thinkingLevel: options.thinkingLevel,
          eventsObserved,
        },
        status,
        errorMessage,
      );
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      session.dispose();
    },
  };
}

export async function createManagedPiSessionWithSdk(
  options: CreateManagedPiSdkSessionOptions,
): Promise<ManagedPiSession> {
  if (
    options.provider.trim().length === 0 ||
    options.model.trim().length === 0
  ) {
    throw new Error("provider and model must not be empty");
  }
  configureVNextPiHostHttpTransport();
  const agentDir = resolvePiHostAgentDirectory(options.agentDir);
  const modelRuntime = await (
    await import("@earendil-works/pi-coding-agent")
  ).ModelRuntime.create({
    allowModelNetwork: false,
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const model = modelRuntime.getModel(options.provider, options.model);
  if (model === undefined) {
    throw new Error(
      `Pi model ${options.provider}/${options.model} is not registered`,
    );
  }
  const available = await modelRuntime.getAvailable(options.provider);
  if (!available.some((candidate) => candidate.id === options.model)) {
    throw new Error(
      `Pi model ${options.provider}/${options.model} has no usable Host authentication`,
    );
  }
  return createManagedPiSession({ ...options, agentDir, modelRuntime, model });
}

async function runManagedPiTurn(
  options: Pick<
    RunVNextPiTurnOptions,
    "prompt" | "timeoutMs" | "signal" | "collaboration"
  >,
  create: () => Promise<ManagedPiSession>,
): Promise<VNextPiTurnResult> {
  if (options.prompt.trim().length === 0)
    throw new Error("prompt must not be empty");
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const session = await create();
  const collaboration = options.collaboration;
  const operation = new AbortController();
  let timedOut = false;
  let signalAborted = options.signal?.aborted ?? false;
  let failedResult: VNextPiTurnResult | undefined;
  let abortPromise: Promise<void> | undefined;
  const cleanupErrors: string[] = [];
  const requestAbort = (): void => {
    operation.abort();
    collaboration?.interrupt();
    // A settled event is synchronous. Disable continuation now, but start cleanup
    // after Pi has returned from its event subscribers.
    abortPromise ??= Promise.resolve()
      .then(() =>
        Promise.allSettled([
          session.abort(),
          collaboration?.stopAgents() ?? Promise.resolve(),
        ]),
      )
      .then((results) => {
        for (const result of results) {
          if (result.status === "rejected") {
            cleanupErrors.push(String(result.reason).slice(0, 2048));
          }
        }
      });
  };
  const checkSettledFailure = (): void => {
    if (collaboration === undefined || operation.signal.aborted) return;
    const result = session.snapshot();
    if (result.status === "completed") return;
    // Preserve the failed turn before cancellation can change Pi's last
    // message, and prevent another worker result from starting a new turn.
    failedResult = result;
    requestAbort();
  };
  const onAbort = (): void => {
    signalAborted = true;
    requestAbort();
  };
  let unbind: void | (() => void) = undefined;
  let unsubscribeSettled: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (collaboration !== undefined) {
      unsubscribeSettled = session.subscribe((event) => {
        // Individual error messages can still be retried by Pi. Only the
        // settled event marks the end of its complete retry/compaction loop.
        if (event.type === "agent_settled") checkSettledFailure();
      });
    }
    unbind = collaboration?.bindRoot({
      isIdle: () => session.isIdle,
      deliver: async (message) => {
        operation.signal.throwIfAborted();
        await session.sendMessage(message, {
          triggerTurn: true,
          deliverAs: "followUp",
          source: { kind: "agent-supervisor" },
        });
        // A message queued during streaming returns before its turn ends;
        // the settled subscriber handles that path instead.
        if (session.isIdle) checkSettledFailure();
      },
      abort: () => session.abort(),
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signalAborted) requestAbort();
      else {
        await Promise.race([
          (async () => {
            await session.prompt(options.prompt);
            checkSettledFailure();
            operation.signal.throwIfAborted();
            await collaboration?.drain(operation.signal);
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              requestAbort();
              reject(new Error(`Pi turn timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            operation.signal.addEventListener(
              "abort",
              () => reject(new Error("Pi turn aborted")),
              { once: true },
            );
          }),
        ]);
      }
    } catch (error) {
      if (!timedOut && !signalAborted && failedResult === undefined) {
        collaboration?.interrupt();
        await collaboration?.stopAgents();
        throw error;
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (abortPromise !== undefined) await abortPromise;
    }
    const terminationMessage = timedOut
      ? `Pi turn timed out after ${timeoutMs}ms`
      : signalAborted
        ? "Pi turn was aborted by the caller"
        : undefined;
    const result =
      failedResult ??
      session.snapshot(
        timedOut ? "timed_out" : signalAborted ? "aborted" : undefined,
        terminationMessage,
      );
    return cleanupErrors.length === 0
      ? result
      : {
          ...result,
          errorMessage: `${result.errorMessage ?? "Pi turn ended"}; cleanup failed: ${cleanupErrors.join("; ")}`,
        };
  } finally {
    unsubscribeSettled?.();
    unbind?.();
    session.dispose();
  }
}

export async function runVNextPiTurn(
  options: RunVNextPiTurnOptions,
  overrides: Partial<VNextPiSessionDependencies> = {},
): Promise<VNextPiTurnResult> {
  return runManagedPiTurn(options, () =>
    createManagedPiSession(options, overrides),
  );
}

export async function runVNextPiTurnWithSdk(
  options: RunVNextPiSdkTurnOptions,
): Promise<VNextPiTurnResult> {
  return runManagedPiTurn(options, () =>
    createManagedPiSessionWithSdk(options),
  );
}
