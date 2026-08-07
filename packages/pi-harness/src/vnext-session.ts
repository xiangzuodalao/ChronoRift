import { resolve } from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ModelRuntime,
  type SessionStats,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { PiThinkingLevel } from "./types.js";

export const VNEXT_PI_WORKSPACE_CWD = "/workspace";

export const VNEXT_ENVIRONMENT_APPENDIX = `ChronoRift environment:
- Your file and command tools execute inside the task sandbox at /workspace. Their outputs and receipts are the execution record.
- Network, Host files, credentials, ports, and devices are unavailable unless the task policy explicitly grants them.
- Investigate, edit, and validate autonomously. Choose the tools and order that fit the task.
- Report only checks you actually ran and their observed results. Finishing the Agent Loop does not prove a bug is fixed.`;

export interface RunVNextPiTurnOptions {
  readonly resourceWorkspaceDirectory: string;
  readonly sessionDirectory: string;
  readonly resumeSessionFile?: string | undefined;
  readonly agentDir?: string | undefined;
  readonly modelRuntime: ModelRuntime;
  readonly model: Model<Api>;
  readonly thinkingLevel: PiThinkingLevel;
  readonly prompt: string;
  readonly tools: readonly ToolDefinition[];
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly additionalEnvironmentInstructions?: string | undefined;
  readonly onEvent?: ((event: AgentSessionEvent) => void) | undefined;
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

const finalAssistantFailure = (
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

export async function runVNextPiTurn(
  options: RunVNextPiTurnOptions,
  overrides: Partial<VNextPiSessionDependencies> = {},
): Promise<VNextPiTurnResult> {
  if (options.prompt.trim().length === 0)
    throw new Error("prompt must not be empty");
  const toolNames = normalizedToolNames(options.tools);
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const resourceWorkspaceDirectory = resolve(
    options.resourceWorkspaceDirectory,
  );
  const sessionDirectory = resolve(options.sessionDirectory);
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });
  const appendSystemPrompt = [
    VNEXT_ENVIRONMENT_APPENDIX,
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
      ? SessionManager.create(VNEXT_PI_WORKSPACE_CWD, sessionDirectory)
      : SessionManager.open(
          resolve(options.resumeSessionFile),
          sessionDirectory,
          VNEXT_PI_WORKSPACE_CWD,
        );
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const created = await dependencies.createSession({
    cwd: VNEXT_PI_WORKSPACE_CWD,
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
  let timedOut = false;
  let signalAborted = options.signal?.aborted ?? false;
  let abortPromise: Promise<void> | undefined;
  const requestAbort = (): void => {
    abortPromise ??= session.abort();
  };
  const onAbort = (): void => {
    signalAborted = true;
    requestAbort();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const unsubscribe = session.subscribe((event) => {
    eventsObserved += 1;
    options.onEvent?.(event);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!signalAborted) {
      await Promise.race([
        session.prompt(options.prompt, { expandPromptTemplates: true }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            requestAbort();
            reject(new Error(`Pi turn timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    }
  } catch (error) {
    if (!timedOut && !signalAborted) throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (abortPromise !== undefined) await abortPromise.catch(() => undefined);
    unsubscribe();
  }

  try {
    const sessionFile = session.sessionFile;
    if (sessionFile === undefined) {
      throw new Error("Pi did not persist the vNext session");
    }
    const failure = finalAssistantFailure(session.messages);
    const status = timedOut
      ? "timed_out"
      : signalAborted
        ? "aborted"
        : (failure?.status ?? "completed");
    return {
      schemaVersion: 1,
      status,
      sessionId: session.sessionId,
      sessionFile,
      provider: options.model.provider,
      model: options.model.id,
      requestedThinkingLevel: options.thinkingLevel,
      realizedThinkingLevel: session.thinkingLevel,
      activeTools: Object.freeze([...activeTools]),
      assistantText: assistantText(session.messages),
      errorMessage: timedOut
        ? `Pi turn timed out after ${timeoutMs}ms`
        : signalAborted
          ? "Pi turn was aborted by the caller"
          : (failure?.message ?? null),
      eventsObserved,
      stats: session.getSessionStats(),
    };
  } finally {
    session.dispose();
  }
}

export async function runVNextPiTurnWithSdk(
  options: RunVNextPiSdkTurnOptions,
): Promise<VNextPiTurnResult> {
  if (
    options.provider.trim().length === 0 ||
    options.model.trim().length === 0
  ) {
    throw new Error("provider and model must not be empty");
  }
  const modelRuntime = await (
    await import("@earendil-works/pi-coding-agent")
  ).ModelRuntime.create({ allowModelNetwork: false });
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
  return runVNextPiTurn({
    resourceWorkspaceDirectory: options.resourceWorkspaceDirectory,
    sessionDirectory: options.sessionDirectory,
    ...(options.resumeSessionFile === undefined
      ? {}
      : { resumeSessionFile: options.resumeSessionFile }),
    ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
    modelRuntime,
    model,
    thinkingLevel: options.thinkingLevel,
    prompt: options.prompt,
    tools: options.tools,
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.additionalEnvironmentInstructions === undefined
      ? {}
      : {
          additionalEnvironmentInstructions:
            options.additionalEnvironmentInstructions,
        }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
}
