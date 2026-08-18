import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { Api, Model, Transport } from "@earendil-works/pi-ai";
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
import {
  PROJECT_ADAPTER_SKILL_V1_DIRECTORY,
  PROJECT_ADAPTER_SKILL_V1_NAME,
  projectAdapterSkillResourceOptionsV1,
} from "./project-adapter-skill.js";
import {
  createVNextPiHostHttpTransportObservationScopeV1,
  parseVNextPiHostHttpTransportObservationV1,
  type VNextPiHostHttpTransportObservationV1,
} from "./internal/vnext-host-http-observation.js";
import { configureVNextPiHostHttpTransport } from "./vnext-host-http.js";

export const VNEXT_PI_WORKSPACE_CWD = "/workspace";

export const VNEXT_PI_LIFECYCLE_STAGES = [
  "sdk_call_started",
  "model_runtime_created",
  "auth_availability_checked",
  "model_selected",
  "resources_loaded",
  "session_created",
  "tools_activated",
  "prompt_submitted",
] as const;
export type VNextPiLifecycleStage = (typeof VNEXT_PI_LIFECYCLE_STAGES)[number];

export interface VNextPiLifecycleEventV1 {
  readonly schemaVersion: 1;
  /** Stable position in the complete SDK lifecycle, even for lower-level use. */
  readonly ordinal: number;
  readonly stage: VNextPiLifecycleStage;
}

export const VNEXT_PI_FAILURE_STAGES = [
  "input_validation",
  "sdk_start",
  "model_runtime_create",
  "authentication_check",
  "model_selection",
  "resource_load",
  "session_create",
  "tool_activation",
  "prompt_submit",
  "agent_turn",
  "session_cleanup",
] as const;
export type VNextPiFailureStage = (typeof VNEXT_PI_FAILURE_STAGES)[number];

export const VNEXT_PI_FAILURE_CATEGORIES = [
  "authentication",
  "configuration",
  "network",
  "filesystem",
  "permission",
  "timeout",
  "aborted",
  "validation",
  "provider",
  "cleanup",
  "unknown",
] as const;
export type VNextPiFailureCategory =
  (typeof VNEXT_PI_FAILURE_CATEGORIES)[number];

export interface VNextPiFailureProjectionV1 {
  readonly schemaVersion: 1;
  readonly stage: VNextPiFailureStage;
  readonly category: VNextPiFailureCategory;
  readonly errorName: string;
  readonly platformCode: string | null;
  readonly syscall: string | null;
  readonly messageSha256: string;
  readonly causeSha256s: readonly string[];
}

export interface VNextPiTurnFailureReceiptV1 {
  readonly schemaVersion: 1;
  readonly recordKind: "vnext-pi-turn-failure";
  /** Stage of the primary failure, or cleanup when cleanup alone failed. */
  readonly stage: VNextPiFailureStage;
  readonly lifecycle: readonly VNextPiLifecycleEventV1[];
  readonly primaryFailure: VNextPiFailureProjectionV1 | null;
  readonly cleanupFailures: readonly VNextPiFailureProjectionV1[];
  /** Present for failures raised through the Host SDK boundary. */
  readonly hostHttpTransportObservation?:
    VNextPiHostHttpTransportObservationV1 | undefined;
}

/**
 * In-memory carrier for a bounded receipt. Its cause is not a persisted DTO and
 * must never be serialized in place of `receipt`.
 */
export class VNextPiTurnFailure extends Error {
  public override readonly name = "VNextPiTurnFailure";
  public readonly receipt: VNextPiTurnFailureReceiptV1;

  public constructor(
    receipt: VNextPiTurnFailureReceiptV1,
    options?: ErrorOptions,
  ) {
    super(`vNext Pi turn failed during ${receipt.stage}`, options);
    this.receipt = freezeFailureReceipt(receipt);
  }
}

export const VNEXT_ENVIRONMENT_APPENDIX = `ChronoRift environment:
- Your file and command tools execute inside the task sandbox at /workspace. Their outputs and receipts are the execution record.
- Network, Host files, credentials, ports, and devices are unavailable unless the task policy explicitly grants them.
- Game tools operate on task-owned resource IDs; resource IDs are not filesystem paths.
- Requested controls are requests. Runtime receipts report realized values and known side effects.
- Runtime records carry observation coverage, checkpoint fidelity, clock uncertainty, and capture loss.
- Unsupported capabilities, unavailable history, restore gaps, conflicts, exhausted budgets, and runtime failures are structured recoverable tool results when recovery is available.
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
  /** Optional Host-selected provider transport; omitted preserves Pi's default. */
  readonly transport?: Transport | undefined;
  readonly prompt: string;
  readonly tools: readonly ToolDefinition[];
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly additionalEnvironmentInstructions?: string | undefined;
  readonly loadProjectAdapterSkillV1?: boolean | undefined;
  readonly onEvent?: ((event: AgentSessionEvent) => void) | undefined;
  /** Append-only milestones emitted only after the named boundary completed. */
  readonly onLifecycleEvent?:
    ((event: VNextPiLifecycleEventV1) => void) | undefined;
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
  /** Actual prompt submissions observed by this one-turn host: always 0 or 1. */
  readonly observedTurnCount: 0 | 1;
  readonly stats: SessionStats;
}

export interface VNextPiSdkTurnResult extends VNextPiTurnResult {
  /** Always present on the real SDK path; optional for compatible test doubles. */
  readonly hostHttpTransportObservation?:
    VNextPiHostHttpTransportObservationV1 | undefined;
}

interface VNextPiSessionDependencies {
  readonly createSession: (
    options: CreateAgentSessionOptions,
  ) => Promise<CreateAgentSessionResult>;
}

const DEFAULT_DEPENDENCIES: VNextPiSessionDependencies = {
  createSession: (options) => createAgentSession(options),
};

export interface VNextPiSdkDependencies {
  readonly configureTransport: () => void;
  readonly createModelRuntime: () => Promise<ModelRuntime>;
  readonly runTurn: typeof runVNextPiTurn;
}

const DEFAULT_SDK_DEPENDENCIES: VNextPiSdkDependencies = {
  configureTransport: configureVNextPiHostHttpTransport,
  createModelRuntime: async () =>
    (await import("@earendil-works/pi-coding-agent")).ModelRuntime.create({
      allowModelNetwork: false,
    }),
  runTurn: runVNextPiTurn,
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const errorRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const rawErrorMessage = (value: unknown): string => {
  if (typeof value === "string") return value;
  const record = errorRecord(value);
  return typeof record?.message === "string" ? record.message : "";
};

const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "DOMException",
  "Error",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "SystemError",
  "TypeError",
  "VNextPiTurnFailure",
]);
const SAFE_PLATFORM_CODES = new Set([
  "ABORT_ERR",
  "EACCES",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EIO",
  "EISDIR",
  "ENETUNREACH",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
  "ETIMEDOUT",
]);
const SAFE_SYSCALLS = new Set([
  "connect",
  "fetch",
  "getaddrinfo",
  "lstat",
  "mkdir",
  "open",
  "read",
  "realpath",
  "rename",
  "stat",
  "unlink",
  "write",
]);

const safeListedString = (
  value: unknown,
  allowed: ReadonlySet<string>,
): string | null =>
  typeof value === "string" && allowed.has(value) ? value : null;

const safeErrorName = (value: unknown): string => {
  const name = errorRecord(value)?.name;
  return safeListedString(name, SAFE_ERROR_NAMES) ?? "Error";
};

const classifyFailure = (error: unknown): VNextPiFailureCategory => {
  const record = errorRecord(error);
  const code = safeListedString(record?.code, SAFE_PLATFORM_CODES);
  const name = safeErrorName(error);
  const message = rawErrorMessage(error).slice(0, 8_192).toLowerCase();
  if (name === "AbortError" || code === "ABORT_ERR") return "aborted";
  if (code === "ETIMEDOUT" || message.includes("timed out")) return "timeout";
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EROFS" ||
    message.includes("permission denied") ||
    message.includes("read-only file system")
  ) {
    return "permission";
  }
  if (
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH"
  ) {
    return "network";
  }
  if (
    code === "EIO" ||
    code === "EISDIR" ||
    code === "ENOENT" ||
    code === "ENOSPC" ||
    code === "ENOTDIR"
  ) {
    return "filesystem";
  }
  if (
    message.includes("authentication") ||
    message.includes("credential") ||
    message.includes("api key")
  ) {
    return "authentication";
  }
  if (message.includes("provider") || message.includes("model request")) {
    return "provider";
  }
  if (message.includes("not registered") || message.includes("configuration")) {
    return "configuration";
  }
  if (name === "TypeError" || name === "RangeError") return "validation";
  return "unknown";
};

const errorIdentitySha256 = (error: unknown): string => {
  const record = errorRecord(error);
  return sha256(
    JSON.stringify([
      safeErrorName(error),
      safeListedString(record?.code, SAFE_PLATFORM_CODES),
      safeListedString(record?.syscall, SAFE_SYSCALLS),
      rawErrorMessage(error),
    ]),
  );
};

export const projectVNextPiFailureV1 = (
  error: unknown,
  stage: VNextPiFailureStage,
): VNextPiFailureProjectionV1 => {
  const record = errorRecord(error);
  const causes: string[] = [];
  let cause = record?.cause;
  const visited = new Set<unknown>();
  while (cause !== undefined && causes.length < 3 && !visited.has(cause)) {
    visited.add(cause);
    causes.push(errorIdentitySha256(cause));
    cause = errorRecord(cause)?.cause;
  }
  return Object.freeze({
    schemaVersion: 1,
    stage,
    category: classifyFailure(error),
    errorName: safeErrorName(error),
    platformCode: safeListedString(record?.code, SAFE_PLATFORM_CODES),
    syscall: safeListedString(record?.syscall, SAFE_SYSCALLS),
    messageSha256: sha256(rawErrorMessage(error)),
    causeSha256s: Object.freeze(causes),
  });
};

const freezeFailureReceipt = (
  receipt: VNextPiTurnFailureReceiptV1,
): VNextPiTurnFailureReceiptV1 => {
  const digestPattern = /^[a-f0-9]{64}$/u;
  const hasExactKeys = (
    value: object,
    expected: readonly string[],
  ): boolean => {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return (
      actual.length === sortedExpected.length &&
      actual.every((key, index) => key === sortedExpected[index])
    );
  };
  const hasTransportObservation = Object.prototype.hasOwnProperty.call(
    receipt,
    "hostHttpTransportObservation",
  );
  if (
    !hasExactKeys(receipt, [
      "schemaVersion",
      "recordKind",
      "stage",
      "lifecycle",
      "primaryFailure",
      "cleanupFailures",
      ...(hasTransportObservation ? ["hostHttpTransportObservation"] : []),
    ]) ||
    receipt.lifecycle.length > VNEXT_PI_LIFECYCLE_STAGES.length ||
    receipt.cleanupFailures.length > 4
  ) {
    throw new TypeError("vNext Pi failure receipt is invalid");
  }
  const freezeProjection = (
    projection: VNextPiFailureProjectionV1,
  ): VNextPiFailureProjectionV1 => {
    if (
      !hasExactKeys(projection, [
        "schemaVersion",
        "stage",
        "category",
        "errorName",
        "platformCode",
        "syscall",
        "messageSha256",
        "causeSha256s",
      ]) ||
      projection.schemaVersion !== 1 ||
      !VNEXT_PI_FAILURE_STAGES.includes(projection.stage) ||
      !VNEXT_PI_FAILURE_CATEGORIES.includes(projection.category) ||
      !SAFE_ERROR_NAMES.has(projection.errorName) ||
      (projection.platformCode !== null &&
        !SAFE_PLATFORM_CODES.has(projection.platformCode)) ||
      (projection.syscall !== null && !SAFE_SYSCALLS.has(projection.syscall)) ||
      !digestPattern.test(projection.messageSha256) ||
      projection.causeSha256s.length > 3 ||
      projection.causeSha256s.some((digest) => !digestPattern.test(digest))
    ) {
      throw new TypeError("vNext Pi failure projection is invalid");
    }
    return Object.freeze({
      schemaVersion: 1,
      stage: projection.stage,
      category: projection.category,
      errorName: projection.errorName,
      platformCode: projection.platformCode,
      syscall: projection.syscall,
      messageSha256: projection.messageSha256,
      causeSha256s: Object.freeze([...projection.causeSha256s]),
    });
  };
  const lifecycle = receipt.lifecycle.map((event, index) => {
    const ordinal = lifecycleOrdinal(event.stage);
    if (
      !hasExactKeys(event, ["schemaVersion", "ordinal", "stage"]) ||
      event.schemaVersion !== 1 ||
      !VNEXT_PI_LIFECYCLE_STAGES.includes(event.stage) ||
      event.ordinal !== ordinal ||
      (index > 0 &&
        event.ordinal <= (receipt.lifecycle[index - 1]?.ordinal ?? 0))
    ) {
      throw new TypeError("vNext Pi lifecycle receipt is invalid");
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      ordinal,
      stage: event.stage,
    });
  });
  const primaryFailure =
    receipt.primaryFailure === null
      ? null
      : freezeProjection(receipt.primaryFailure);
  const cleanupFailures = receipt.cleanupFailures.map(freezeProjection);
  const hostHttpTransportObservation = hasTransportObservation
    ? parseVNextPiHostHttpTransportObservationV1(
        receipt.hostHttpTransportObservation,
      )
    : undefined;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.recordKind !== "vnext-pi-turn-failure" ||
    (primaryFailure === null && cleanupFailures.length === 0) ||
    receipt.stage !== (primaryFailure?.stage ?? "session_cleanup") ||
    cleanupFailures.some((failure) => failure.stage !== "session_cleanup")
  ) {
    throw new TypeError("vNext Pi failure receipt is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    recordKind: "vnext-pi-turn-failure",
    stage: receipt.stage,
    lifecycle: Object.freeze(lifecycle),
    primaryFailure,
    cleanupFailures: Object.freeze(cleanupFailures),
    ...(hostHttpTransportObservation === undefined
      ? {}
      : { hostHttpTransportObservation }),
  });
};

const lifecycleOrdinal = (stage: VNextPiLifecycleStage): number =>
  VNEXT_PI_LIFECYCLE_STAGES.indexOf(stage) + 1;

const emitLifecycle = (
  lifecycle: VNextPiLifecycleEventV1[],
  onLifecycleEvent: RunVNextPiTurnOptions["onLifecycleEvent"],
  stage: VNextPiLifecycleStage,
): void => {
  const event = Object.freeze({
    schemaVersion: 1 as const,
    ordinal: lifecycleOrdinal(stage),
    stage,
  });
  lifecycle.push(event);
  onLifecycleEvent?.(event);
};

const asTurnFailure = (input: {
  readonly error: unknown;
  readonly stage: VNextPiFailureStage;
  readonly lifecycle: readonly VNextPiLifecycleEventV1[];
  readonly cleanupErrors?: readonly unknown[] | undefined;
  readonly hostHttpTransportObservation?:
    VNextPiHostHttpTransportObservationV1 | undefined;
}): VNextPiTurnFailure => {
  const inherited =
    input.error instanceof VNextPiTurnFailure ? input.error.receipt : null;
  const primaryFailure =
    inherited === null
      ? projectVNextPiFailureV1(input.error, input.stage)
      : inherited.primaryFailure;
  const cleanupFailures = [
    ...(inherited?.cleanupFailures ?? []),
    ...(input.cleanupErrors ?? [])
      .slice(0, 4)
      .map((error) => projectVNextPiFailureV1(error, "session_cleanup")),
  ].slice(0, 4);
  return new VNextPiTurnFailure(
    {
      schemaVersion: 1,
      recordKind: "vnext-pi-turn-failure",
      stage: primaryFailure?.stage ?? inherited?.stage ?? "session_cleanup",
      lifecycle: [...input.lifecycle],
      primaryFailure,
      cleanupFailures,
      ...(input.hostHttpTransportObservation === undefined
        ? inherited?.hostHttpTransportObservation === undefined
          ? {}
          : {
              hostHttpTransportObservation:
                inherited.hostHttpTransportObservation,
            }
        : {
            hostHttpTransportObservation: input.hostHttpTransportObservation,
          }),
    },
    { cause: input.error },
  );
};

const cleanupOnlyTurnFailure = (input: {
  readonly lifecycle: readonly VNextPiLifecycleEventV1[];
  readonly cleanupErrors: readonly unknown[];
}): VNextPiTurnFailure =>
  new VNextPiTurnFailure(
    {
      schemaVersion: 1,
      recordKind: "vnext-pi-turn-failure",
      stage: "session_cleanup",
      lifecycle: [...input.lifecycle],
      primaryFailure: null,
      cleanupFailures: input.cleanupErrors
        .slice(0, 4)
        .map((error) => projectVNextPiFailureV1(error, "session_cleanup")),
    },
    { cause: input.cleanupErrors[0] },
  );

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
  const lifecycle: VNextPiLifecycleEventV1[] = [];
  const cleanupErrors: unknown[] = [];
  let failureStage: VNextPiFailureStage = "input_validation";
  let primaryError: unknown;
  let result: VNextPiTurnResult | undefined;
  let session: CreateAgentSessionResult["session"] | undefined;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortPromise: Promise<void> | undefined;
  let removeAbortListener: (() => void) | undefined;

  try {
    if (options.prompt.trim().length === 0) {
      throw new Error("prompt must not be empty");
    }
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
      ...(options.transport === undefined
        ? {}
        : { transport: options.transport }),
    });
    const appendSystemPrompt = [
      VNEXT_ENVIRONMENT_APPENDIX,
      ...(options.additionalEnvironmentInstructions === undefined
        ? []
        : [options.additionalEnvironmentInstructions]),
    ];
    const projectAdapterSkill = options.loadProjectAdapterSkillV1
      ? projectAdapterSkillResourceOptionsV1()
      : undefined;

    failureStage = "resource_load";
    const resourceLoader = new DefaultResourceLoader({
      cwd: resourceWorkspaceDirectory,
      agentDir,
      settingsManager,
      noExtensions: true,
      noThemes: true,
      appendSystemPrompt,
      ...(projectAdapterSkill === undefined
        ? {}
        : {
            additionalSkillPaths: [...projectAdapterSkill.additionalSkillPaths],
          }),
    });
    await resourceLoader.reload();
    if (projectAdapterSkill !== undefined) {
      const loaded = resourceLoader
        .getSkills()
        .skills.filter((skill) => skill.name === PROJECT_ADAPTER_SKILL_V1_NAME);
      const expectedFile = resolve(
        PROJECT_ADAPTER_SKILL_V1_DIRECTORY,
        "SKILL.md",
      );
      if (
        loaded.length !== 1 ||
        resolve(loaded[0]?.filePath ?? "") !== expectedFile
      ) {
        throw new Error(
          "Pi did not load the pinned Project Adapter V1 skill from the managed package",
        );
      }
    }
    emitLifecycle(lifecycle, options.onLifecycleEvent, "resources_loaded");

    failureStage = "session_create";
    if (
      options.resumeSessionFile !== undefined &&
      options.newSessionId !== undefined
    ) {
      throw new Error(
        "newSessionId cannot be supplied when resuming a Session",
      );
    }
    const sessionManager =
      options.resumeSessionFile === undefined
        ? SessionManager.create(VNEXT_PI_WORKSPACE_CWD, sessionDirectory, {
            ...(options.newSessionId === undefined
              ? {}
              : { id: options.newSessionId }),
          })
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
    session = created.session;
    emitLifecycle(lifecycle, options.onLifecycleEvent, "session_created");

    failureStage = "tool_activation";
    if (created.extensionsResult.extensions.length !== 0) {
      throw new Error("vNext Pi session loaded executable extensions");
    }
    if (created.extensionsResult.errors.length !== 0) {
      throw new Error("vNext Pi extension loading failed");
    }
    const activeTools = session.getActiveToolNames();
    if (
      activeTools.length !== toolNames.length ||
      toolNames.some((name) => !activeTools.includes(name))
    ) {
      throw new Error("Pi activated an unexpected tool set");
    }
    emitLifecycle(lifecycle, options.onLifecycleEvent, "tools_activated");

    let eventsObserved = 0;
    let timedOut = false;
    let promptSubmitted = false;
    let signalAborted = options.signal?.aborted ?? false;
    const requestAbort = (): void => {
      abortPromise ??= Promise.resolve()
        .then(() => session!.abort())
        .catch((error: unknown) => {
          cleanupErrors.push(error);
        });
    };
    const onAbort = (): void => {
      signalAborted = true;
      requestAbort();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () =>
      options.signal?.removeEventListener("abort", onAbort);
    unsubscribe = session.subscribe((event) => {
      eventsObserved += 1;
      options.onEvent?.(event);
    });

    try {
      if (!signalAborted) {
        failureStage = "prompt_submit";
        const promptPromise = session.prompt(options.prompt, {
          expandPromptTemplates: true,
        });
        promptSubmitted = true;
        emitLifecycle(lifecycle, options.onLifecycleEvent, "prompt_submitted");
        failureStage = "agent_turn";
        await Promise.race([
          promptPromise,
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
    }

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
    result = {
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
      observedTurnCount: promptSubmitted ? 1 : 0,
      stats: session.getSessionStats(),
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      removeAbortListener?.();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (abortPromise !== undefined) await abortPromise;
    try {
      unsubscribe?.();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      session?.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError !== undefined) {
    throw asTurnFailure({
      error: primaryError,
      stage: failureStage,
      lifecycle,
      cleanupErrors,
    });
  }
  if (cleanupErrors.length > 0) {
    throw cleanupOnlyTurnFailure({ lifecycle, cleanupErrors });
  }
  if (result === undefined) {
    throw new Error("vNext Pi turn produced no result");
  }
  return result;
}

export async function runVNextPiTurnWithSdk(
  options: RunVNextPiSdkTurnOptions,
  overrides: Partial<VNextPiSdkDependencies> = {},
): Promise<VNextPiSdkTurnResult> {
  const transportObservation =
    createVNextPiHostHttpTransportObservationScopeV1();
  return transportObservation.run(async () => {
    const lifecycle: VNextPiLifecycleEventV1[] = [];
    let failureStage: VNextPiFailureStage = "input_validation";
    try {
      if (
        options.provider.trim().length === 0 ||
        options.model.trim().length === 0
      ) {
        throw new Error("provider and model must not be empty");
      }
      const dependencies = { ...DEFAULT_SDK_DEPENDENCIES, ...overrides };
      failureStage = "sdk_start";
      emitLifecycle(lifecycle, options.onLifecycleEvent, "sdk_call_started");
      dependencies.configureTransport();

      failureStage = "model_runtime_create";
      const modelRuntime = await dependencies.createModelRuntime();
      emitLifecycle(
        lifecycle,
        options.onLifecycleEvent,
        "model_runtime_created",
      );

      failureStage = "authentication_check";
      const available = await modelRuntime.getAvailable(options.provider);
      emitLifecycle(
        lifecycle,
        options.onLifecycleEvent,
        "auth_availability_checked",
      );
      if (!available.some((candidate) => candidate.id === options.model)) {
        throw new Error("Pi model has no usable Host authentication");
      }

      failureStage = "model_selection";
      const model = modelRuntime.getModel(options.provider, options.model);
      if (model === undefined) {
        throw new Error("Pi model is not registered");
      }
      emitLifecycle(lifecycle, options.onLifecycleEvent, "model_selected");

      const result = await dependencies.runTurn({
        resourceWorkspaceDirectory: options.resourceWorkspaceDirectory,
        sessionDirectory: options.sessionDirectory,
        ...(options.newSessionId === undefined
          ? {}
          : { newSessionId: options.newSessionId }),
        ...(options.resumeSessionFile === undefined
          ? {}
          : { resumeSessionFile: options.resumeSessionFile }),
        ...(options.agentDir === undefined
          ? {}
          : { agentDir: options.agentDir }),
        modelRuntime,
        model,
        thinkingLevel: options.thinkingLevel,
        ...(options.transport === undefined
          ? {}
          : { transport: options.transport }),
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
        ...(options.loadProjectAdapterSkillV1 === undefined
          ? {}
          : { loadProjectAdapterSkillV1: options.loadProjectAdapterSkillV1 }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
        onLifecycleEvent: (event) => {
          lifecycle.push(event);
          options.onLifecycleEvent?.(event);
        },
      });
      return {
        ...result,
        hostHttpTransportObservation: transportObservation.snapshot(),
      };
    } catch (error) {
      throw asTurnFailure({
        error,
        stage: failureStage,
        lifecycle,
        hostHttpTransportObservation: transportObservation.snapshot(),
      });
    }
  });
}
