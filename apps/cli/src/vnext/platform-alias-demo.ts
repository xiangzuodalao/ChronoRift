import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  validateProjectEnvironmentGameToolOutputV1,
  type ProjectEnvironmentGameToolNameV1,
} from "@chronorift/agent-protocol";
import {
  JsonValueSchema,
  Sha256DigestV1Schema,
  asProjectEnvironmentTaskId,
  asSha256DigestV1,
  type JsonValue,
} from "@chronorift/domain";
import { loadProjectAdapterPackageWithBytesV1 } from "@chronorift/godot-adapter";
import { contentHash } from "@chronorift/json-artifacts";
import {
  createProjectEnvironmentGameToolDefinitions,
  createVNextCodingToolDefinitions,
  runVNextPiTurnWithSdk,
  type PiThinkingLevel,
  type ProjectEnvironmentGameToolPort,
  type ProjectEnvironmentGameToolPortRequestV1,
  type VNextPiTurnResult,
} from "@chronorift/pi-harness";

import { prepareProjectEnvironmentDebugBuildV1 } from "./candidate-godot-build.js";
import { preflightManagedGodotProjectEnvironmentRuntimeV1 } from "./managed-godot-project-environment-runtime-preflight.js";
import { NodeHostGitPort } from "./host-git.js";
import { extractTaskPatch } from "./patch-handoff.js";
import { SandboxPiCodingToolPort } from "./pi-coding-tool-port.js";
import { ProjectEnvironmentGameRuntimeV1 } from "./project-environment-game-runtime.js";
import { GodotProjectEnvironmentSidecarPortV1 } from "./project-environment-sidecar-port.js";
import {
  preflightCleanProjectEnvironmentV1,
  type VerifiedProjectEnvironmentSourceV1,
} from "./source-preflight.js";
import { createProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";
import { materializePrivateTaskWorkspace } from "./workspace-materializer.js";
import { SrtGodotRunner } from "./srt-godot-runner.js";
import { resolveSrtRuntimeConfig } from "./srt-runtime-config.js";
import { SrtSandboxController } from "./srt-sandbox-controller.js";
import {
  createPlatformAliasGodotRunToolV1,
  PlatformAliasGodotRunCallV1Schema,
  type PlatformAliasGodotRunCallV1,
} from "./platform-alias-godot-run-tool.js";

export const PLATFORM_ALIAS_SOURCE_COMMIT =
  "e78b339500dec8e480b33723c4156bf9b74cd25c" as const;
export const PLATFORM_ALIAS_SOURCE_TREE =
  "9941cb045b3cd73c4554ca1de337a341b383590b" as const;
export const PLATFORM_ALIAS_PROMPT =
  "A falling platform can activate while the player is still outside its visible width. Investigate the project, make the smallest appropriate fix, and validate the candidate. You choose the investigation, edit, and validation strategy." as const;

export const PLATFORM_ALIAS_ABLATION_PROVIDER = "openai-codex" as const;
export const PLATFORM_ALIAS_ABLATION_MODEL = "gpt-5.6-luna" as const;
export const PLATFORM_ALIAS_ABLATION_THINKING_LEVEL = "max" as const;
export const PLATFORM_ALIAS_ABLATION_TIMEOUT_MS = 600_000 as const;
export const PLATFORM_ALIAS_ABLATION_ENVIRONMENT_PROFILE = "coding" as const;
export const PLATFORM_ALIAS_ABLATION_ENVIRONMENT_INSTRUCTION_PROFILE =
  "task-id-v1" as const;

export const PlatformAliasAblationArmV1Schema = z.enum([
  "coding-only",
  "chronorift",
]);
export type PlatformAliasAblationArmV1 = z.infer<
  typeof PlatformAliasAblationArmV1Schema
>;

const createPlatformAliasAblationEnvironmentInstructionsV1 = (input: {
  readonly taskId: string;
}): string => ["Task context:", `- taskId: ${input.taskId}`].join("\n");

export const createPlatformAliasAblationEnvironmentV1 = (input: {
  readonly taskId: string;
}): {
  readonly environmentProfile: "coding";
  readonly additionalEnvironmentInstructions: string;
} => ({
  environmentProfile: PLATFORM_ALIAS_ABLATION_ENVIRONMENT_PROFILE,
  additionalEnvironmentInstructions:
    createPlatformAliasAblationEnvironmentInstructionsV1(input),
});

const PLATFORM_ALIAS_ADAPTER_DIRECTORY = fileURLToPath(
  new URL(
    "../../../../testdata/vnext/external-project/moddable-platformer-platform-alias-adapter/",
    import.meta.url,
  ),
);

const EXPOSED_GAME_TOOLS = Object.freeze([
  "game_capabilities",
  "game_launch",
  "game_stop",
  "game_query",
] as const satisfies readonly ProjectEnvironmentGameToolNameV1[]);

export const PLATFORM_ALIAS_ABLATION_SHARED_TOOL_NAMES = Object.freeze([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "godot_run",
] as const);

export const selectPlatformAliasAblationToolSurfaceV1 = <
  Tool extends { readonly name: string },
>(input: {
  readonly arm: PlatformAliasAblationArmV1;
  readonly codingTools: readonly Tool[];
  readonly godotRunTool: Tool;
  readonly chronoriftTools: readonly Tool[];
}) => {
  const sharedTools = Object.freeze([...input.codingTools, input.godotRunTool]);
  const selectedChronoRiftTools =
    input.arm === "chronorift"
      ? Object.freeze([...input.chronoriftTools])
      : Object.freeze([] as Tool[]);
  return Object.freeze({
    sharedTools,
    chronoriftTools: selectedChronoRiftTools,
    tools: Object.freeze([...sharedTools, ...selectedChronoRiftTools]),
  });
};

const GN1_PROVIDER_REQUEST_TIMEOUT_MS = 60_000;
const GN1_AGENT_RETRY_MAX_RETRIES = 1;

const BoundedMessageSchema = z.string().max(4_096);
const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => resolve(value) === value, "path must be absolute");

export const PlatformAliasRuntimeObservationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    buildId: z.string().min(1).max(256),
    runtimeId: z.string().min(1).max(256),
    executionId: z.string().min(1).max(256),
    capabilities: JsonValueSchema,
    launch: JsonValueSchema,
    entities: JsonValueSchema,
    state: JsonValueSchema,
    stop: JsonValueSchema,
  })
  .strict();
export type PlatformAliasRuntimeObservationV1 = z.infer<
  typeof PlatformAliasRuntimeObservationV1Schema
>;

const PlatformAliasGameToolCallV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    toolCallId: z.string().min(1).max(256),
    toolName: z.enum(EXPOSED_GAME_TOOLS),
    input: JsonValueSchema,
    response: JsonValueSchema,
  })
  .strict();

const PlatformAliasAgentResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum([
      "completed",
      "provider_failed",
      "aborted",
      "timed_out",
      "start_failed",
    ]),
    sessionId: z.string().nullable(),
    sessionFile: AbsolutePathSchema.nullable(),
    provider: z.string().min(1),
    model: z.string().min(1),
    requestedThinkingLevel: z.string().min(1),
    realizedThinkingLevel: z.string().min(1).nullable(),
    activeTools: z.array(z.string().min(1)),
    assistantText: z.string(),
    errorMessage: BoundedMessageSchema.nullable(),
    eventsObserved: z.number().int().nonnegative(),
    stats: z
      .object({
        userMessages: z.number().int().nonnegative(),
        assistantMessages: z.number().int().nonnegative(),
        toolCalls: z.number().int().nonnegative(),
        toolResults: z.number().int().nonnegative(),
        totalMessages: z.number().int().nonnegative(),
        tokens: z
          .object({
            input: z.number().int().nonnegative(),
            output: z.number().int().nonnegative(),
            cacheRead: z.number().int().nonnegative(),
            cacheWrite: z.number().int().nonnegative(),
            total: z.number().int().nonnegative(),
          })
          .strict(),
        cost: z.number().nonnegative().finite(),
      })
      .strict()
      .nullable(),
    gameToolCalls: z.array(PlatformAliasGameToolCallV1Schema),
  })
  .strict();

const PlatformAliasPatchV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sha256: Sha256DigestV1Schema,
    byteLength: z
      .number()
      .int()
      .nonnegative()
      .max(32 * 1_024 * 1_024),
    unifiedDiff: z.string().max(32 * 1_024 * 1_024),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = Buffer.from(value.unifiedDiff, "utf8");
    if (bytes.byteLength !== value.byteLength) {
      context.addIssue({
        code: "custom",
        path: ["byteLength"],
        message: "byteLength must match the UTF-8 diff bytes",
      });
    }
    if (createHash("sha256").update(bytes).digest("hex") !== value.sha256) {
      context.addIssue({
        code: "custom",
        path: ["sha256"],
        message: "sha256 must match the diff bytes",
      });
    }
  });

const PlatformAliasSourceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    repositoryRoot: AbsolutePathSchema,
    commit: z.literal(PLATFORM_ALIAS_SOURCE_COMMIT),
    tree: z.literal(PLATFORM_ALIAS_SOURCE_TREE),
    selectedTreeSha256: Sha256DigestV1Schema,
    checkoutCleanBefore: z.literal(true),
    checkoutCleanAfter: z.boolean(),
  })
  .strict();

export const PlatformAliasDemoResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    commandStatus: z.enum(["completed", "cleanup_or_source_drift"]),
    taskId: z.string().min(1).max(256),
    source: PlatformAliasSourceV1Schema,
    baselineObservation: PlatformAliasRuntimeObservationV1Schema,
    agent: PlatformAliasAgentResultV1Schema,
    candidatePatch: PlatformAliasPatchV1Schema,
    candidateObservation: PlatformAliasRuntimeObservationV1Schema.nullable(),
    candidateObservationError: BoundedMessageSchema.nullable(),
    workspaceDirectory: AbsolutePathSchema,
    taskDirectory: AbsolutePathSchema,
    sandboxRuntime: z.literal("anthropic-srt"),
    limitations: z.array(z.string().min(1).max(4_096)).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.candidateObservation === null) ===
      (value.candidateObservationError === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidateObservation"],
        message:
          "candidate observation and error must have exactly one populated branch",
      });
    }
    if (
      value.commandStatus === "completed" &&
      !value.source.checkoutCleanAfter
    ) {
      context.addIssue({
        code: "custom",
        path: ["commandStatus"],
        message: "completed requires the original checkout to remain exact",
      });
    }
  });
export type PlatformAliasDemoResultV1 = z.infer<
  typeof PlatformAliasDemoResultV1Schema
>;

export const PlatformAliasAblationConfigurationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal(PLATFORM_ALIAS_ABLATION_PROVIDER),
    model: z.literal(PLATFORM_ALIAS_ABLATION_MODEL),
    thinkingLevel: z.literal(PLATFORM_ALIAS_ABLATION_THINKING_LEVEL),
    timeoutMs: z.literal(PLATFORM_ALIAS_ABLATION_TIMEOUT_MS),
    environmentProfile: z.literal(PLATFORM_ALIAS_ABLATION_ENVIRONMENT_PROFILE),
    environmentInstructionProfile: z.literal(
      PLATFORM_ALIAS_ABLATION_ENVIRONMENT_INSTRUCTION_PROFILE,
    ),
    prompt: z.literal(PLATFORM_ALIAS_PROMPT),
    sourceCommit: z.literal(PLATFORM_ALIAS_SOURCE_COMMIT),
    sourceTree: z.literal(PLATFORM_ALIAS_SOURCE_TREE),
    sharedToolNames: z.tuple([
      z.literal("read"),
      z.literal("bash"),
      z.literal("edit"),
      z.literal("write"),
      z.literal("grep"),
      z.literal("find"),
      z.literal("ls"),
      z.literal("godot_run"),
    ]),
    chronoriftToolNames: z.union([
      z.tuple([]),
      z.tuple([
        z.literal("game_capabilities"),
        z.literal("game_launch"),
        z.literal("game_stop"),
        z.literal("game_query"),
      ]),
    ]),
  })
  .strict();
export type PlatformAliasAblationConfigurationV1 = z.infer<
  typeof PlatformAliasAblationConfigurationV1Schema
>;

export const PlatformAliasAblationRunV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    arm: PlatformAliasAblationArmV1Schema,
    configuration: PlatformAliasAblationConfigurationV1Schema,
    result: PlatformAliasDemoResultV1Schema,
    rawGodotToolCalls: z.array(PlatformAliasGodotRunCallV1Schema),
    candidateRuntimeErrors: JsonValueSchema.nullable(),
    candidateRuntimeErrorsError: BoundedMessageSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const shouldExposeChronoRiftTools = value.arm === "chronorift";
    const exposesChronoRiftTools =
      value.configuration.chronoriftToolNames.length > 0;
    if (exposesChronoRiftTools !== shouldExposeChronoRiftTools) {
      context.addIssue({
        code: "custom",
        path: ["configuration", "chronoriftToolNames"],
        message: "chronorift tools must be present only in the chronorift arm",
      });
    }
    if (
      value.arm === "coding-only" &&
      value.result.agent.gameToolCalls.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["result", "agent", "gameToolCalls"],
        message: "coding-only arm cannot contain ChronoRift game-tool calls",
      });
    }
    if (value.result.agent.status !== "start_failed") {
      const expectedActiveTools = [
        ...value.configuration.sharedToolNames,
        ...value.configuration.chronoriftToolNames,
      ];
      if (
        JSON.stringify(value.result.agent.activeTools) !==
        JSON.stringify(expectedActiveTools)
      ) {
        context.addIssue({
          code: "custom",
          path: ["result", "agent", "activeTools"],
          message:
            "actual active tools must match the frozen arm configuration",
        });
      }
    }
    if (
      (value.candidateRuntimeErrors === null) ===
      (value.candidateRuntimeErrorsError === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidateRuntimeErrors"],
        message:
          "candidate runtime errors and error must have exactly one populated branch",
      });
    }
  });
export type PlatformAliasAblationRunV1 = z.infer<
  typeof PlatformAliasAblationRunV1Schema
>;

export const PlatformAliasDemoFailureV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    commandStatus: z.literal("failed"),
    errorMessage: BoundedMessageSchema.min(1),
  })
  .strict();

export interface PlatformAliasDemoRequestV1 {
  readonly projectPath: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly stateRoot?: string | undefined;
  readonly godotBin?: string | undefined;
  readonly agentDir?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface PlatformAliasAblationRequestV1 extends PlatformAliasDemoRequestV1 {
  readonly arm: PlatformAliasAblationArmV1;
}

const boundedError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\0]/gu, " ")
    .trim()
    .slice(0, 4_096) || "Unknown operation failure";

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

interface FixedSourceInspectionV1 {
  readonly source: VerifiedProjectEnvironmentSourceV1;
  readonly repositoryRoot: string;
  readonly tree: typeof PLATFORM_ALIAS_SOURCE_TREE;
}

const inspectFixedSource = async (
  projectPath: string,
  taskStorageRoot: string,
): Promise<FixedSourceInspectionV1> => {
  const source = await preflightCleanProjectEnvironmentV1({
    projectPath,
    sourceRepositoryExclusionRoots: [taskStorageRoot],
  });
  if (
    source.sourceKind !== "project-environment-v1-clean-git" ||
    source.sourceClosure === undefined ||
    source.projectPrefix !== "" ||
    source.projectRoot !== source.repositoryRoot
  ) {
    throw new Error(
      "GN-1 requires a clean checkout whose repository root is the Godot project root",
    );
  }
  if (source.headCommit !== PLATFORM_ALIAS_SOURCE_COMMIT) {
    throw new Error(
      `GN-1 requires exact commit ${PLATFORM_ALIAS_SOURCE_COMMIT}; observed ${source.headCommit}`,
    );
  }
  const tree = (
    await new NodeHostGitPort().resolveHeadTree(source.repositoryRoot)
  ).toLocaleLowerCase("en-US");
  if (tree !== PLATFORM_ALIAS_SOURCE_TREE) {
    throw new Error(
      `GN-1 requires exact tree ${PLATFORM_ALIAS_SOURCE_TREE}; observed ${tree}`,
    );
  }
  if (await pathExists(resolve(source.repositoryRoot, ".chronorift"))) {
    throw new Error("GN-1 source checkout must not contain .chronorift/");
  }
  return {
    source,
    repositoryRoot: source.repositoryRoot,
    tree: PLATFORM_ALIAS_SOURCE_TREE,
  };
};

export const platformAliasSourceStillExactV1 = async (
  repositoryRoot: string,
): Promise<boolean> => {
  const git = new NodeHostGitPort();
  const [status, head, tree, hasChronoRift] = await Promise.all([
    git.statusPorcelain(repositoryRoot),
    git.resolveHeadCommit(repositoryRoot),
    git.resolveHeadTree(repositoryRoot),
    pathExists(resolve(repositoryRoot, ".chronorift")),
  ]);
  return (
    status.byteLength === 0 &&
    head === PLATFORM_ALIAS_SOURCE_COMMIT &&
    tree === PLATFORM_ALIAS_SOURCE_TREE &&
    !hasChronoRift
  );
};

const extractSuccess = (
  toolName: ProjectEnvironmentGameToolNameV1,
  response: unknown,
): JsonValue => {
  if (typeof response !== "object" || response === null) {
    throw new Error(`${toolName} returned a non-object response`);
  }
  const envelope = response as {
    readonly outcome?: unknown;
    readonly output?: unknown;
    readonly error?: unknown;
  };
  if (envelope.outcome !== "success") {
    throw new Error(`${toolName} failed: ${JSON.stringify(envelope.error)}`);
  }
  if (!validateProjectEnvironmentGameToolOutputV1(toolName, envelope.output)) {
    throw new Error(`${toolName} returned an invalid success output`);
  }
  return JsonValueSchema.parse(envelope.output);
};

const requiredString = (value: JsonValue, key: string): string => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value[key] !== "string"
  ) {
    throw new Error(`runtime output is missing ${key}`);
  }
  return value[key];
};

interface PlatformAliasRuntimePostflightV1 {
  readonly observation: PlatformAliasRuntimeObservationV1;
  readonly runtimeErrors: JsonValue | null;
}

const observePlatformAliasRuntimePostflightV1 = async (
  runtime: ProjectEnvironmentGameToolPort,
  taskId: string,
  launchTargetId: string,
  includeRuntimeErrors: boolean,
): Promise<PlatformAliasRuntimePostflightV1> => {
  const invoke = async (
    toolName: (typeof EXPOSED_GAME_TOOLS)[number],
    input: JsonValue,
  ): Promise<JsonValue> =>
    extractSuccess(
      toolName,
      await runtime.invoke({
        schemaVersion: 1,
        toolCallId: `gn1-host-${toolName}-${randomUUID()}`,
        toolName,
        input,
      }),
    );
  const capabilities = await invoke("game_capabilities", {
    schemaVersion: 1,
    taskId,
  });
  const buildId = requiredString(capabilities, "buildId");
  const launch = await invoke("game_launch", {
    schemaVersion: 1,
    taskId,
    buildId,
    launchTargetId,
    parameters: {},
  });
  const runtimeId = requiredString(launch, "runtimeId");
  const executionId = requiredString(launch, "executionId");
  let entities: JsonValue | undefined;
  let state: JsonValue | undefined;
  let runtimeErrors: JsonValue | null = null;
  let primaryError: unknown;
  try {
    entities = await invoke("game_query", {
      schemaVersion: 1,
      taskId,
      executionId,
      select: "entities",
      limit: 200,
    });
    state = await invoke("game_query", {
      schemaVersion: 1,
      taskId,
      executionId,
      select: "state",
      limit: 200,
    });
    if (includeRuntimeErrors) {
      runtimeErrors = await invoke("game_query", {
        schemaVersion: 1,
        taskId,
        executionId,
        select: "runtime_errors",
        limit: 200,
      });
    }
  } catch (error) {
    primaryError = error;
  }
  let stop: JsonValue;
  try {
    stop = await invoke("game_stop", {
      schemaVersion: 1,
      taskId,
      runtimeId,
    });
  } catch (stopError) {
    if (primaryError !== undefined) {
      throw new Error(
        `runtime query failed (${boundedError(primaryError)}) and stop failed (${boundedError(stopError)})`,
      );
    }
    throw stopError;
  }
  if (primaryError !== undefined) {
    throw new Error(boundedError(primaryError), { cause: primaryError });
  }
  if (entities === undefined || state === undefined) {
    throw new Error("runtime query did not return both entity and state rows");
  }
  return {
    observation: PlatformAliasRuntimeObservationV1Schema.parse({
      schemaVersion: 1,
      buildId,
      runtimeId,
      executionId,
      capabilities,
      launch,
      entities,
      state,
      stop,
    }),
    runtimeErrors,
  };
};

/** Runs one neutral lifecycle/query snapshot and always attempts to stop it. */
export const observePlatformAliasRuntimeV1 = async (
  runtime: ProjectEnvironmentGameToolPort,
  taskId: string,
  launchTargetId: string,
): Promise<PlatformAliasRuntimeObservationV1> =>
  (
    await observePlatformAliasRuntimePostflightV1(
      runtime,
      taskId,
      launchTargetId,
      false,
    )
  ).observation;

export const observePlatformAliasAblationPostflightV1 = async (
  runtime: ProjectEnvironmentGameToolPort,
  taskId: string,
  launchTargetId: string,
): Promise<PlatformAliasRuntimePostflightV1> =>
  observePlatformAliasRuntimePostflightV1(
    runtime,
    taskId,
    launchTargetId,
    true,
  );

export const extractPlatformAliasCandidatePatchV1 = async (input: {
  readonly taskId: string;
  readonly workspaceDirectory: string;
  readonly hostBaselineGitDirectory: string;
  readonly hostBaselineCommit: string;
  readonly baselineSourceHash: z.infer<typeof Sha256DigestV1Schema>;
  readonly hostOperationTemporaryDirectory: string;
}) => {
  const extracted = await extractTaskPatch({
    ...input,
    taskId: asProjectEnvironmentTaskId(input.taskId),
    sourceKind: "project-environment-v1",
    ignoredCachePaths: [".chronorift", ".godot"],
  });
  const bytes = Buffer.from(extracted.patchBytes);
  return PlatformAliasPatchV1Schema.parse({
    schemaVersion: 1,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    unifiedDiff: bytes.toString("utf8"),
  });
};

const recordingPort = (
  runtime: ProjectEnvironmentGameToolPort,
  calls: z.infer<typeof PlatformAliasGameToolCallV1Schema>[],
): ProjectEnvironmentGameToolPort => ({
  invoke: async (
    request: ProjectEnvironmentGameToolPortRequestV1,
    signal?: AbortSignal,
  ) => {
    const response = await runtime.invoke(request, signal);
    if (EXPOSED_GAME_TOOLS.includes(request.toolName as never)) {
      calls.push(
        PlatformAliasGameToolCallV1Schema.parse({
          schemaVersion: 1,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          input: JsonValueSchema.parse(request.input),
          response: JsonValueSchema.parse(response),
        }),
      );
    }
    return response;
  },
});

const agentResult = (
  request: PlatformAliasDemoRequestV1,
  result: VNextPiTurnResult | null,
  error: unknown,
  gameToolCalls: readonly z.infer<typeof PlatformAliasGameToolCallV1Schema>[],
) =>
  PlatformAliasAgentResultV1Schema.parse(
    result === null
      ? {
          schemaVersion: 1,
          status: "start_failed",
          sessionId: null,
          sessionFile: null,
          provider: request.provider,
          model: request.model,
          requestedThinkingLevel: request.thinkingLevel,
          realizedThinkingLevel: null,
          activeTools: [],
          assistantText: "",
          errorMessage: boundedError(error),
          eventsObserved: 0,
          stats: null,
          gameToolCalls,
        }
      : {
          schemaVersion: 1,
          status: result.status,
          sessionId: result.sessionId,
          sessionFile: result.sessionFile,
          provider: result.provider,
          model: result.model,
          requestedThinkingLevel: result.requestedThinkingLevel,
          realizedThinkingLevel: result.realizedThinkingLevel,
          activeTools: result.activeTools,
          assistantText: result.assistantText,
          errorMessage: result.errorMessage,
          eventsObserved: result.eventsObserved,
          stats: {
            userMessages: result.stats.userMessages,
            assistantMessages: result.stats.assistantMessages,
            toolCalls: result.stats.toolCalls,
            toolResults: result.stats.toolResults,
            totalMessages: result.stats.totalMessages,
            tokens: result.stats.tokens,
            cost: result.stats.cost,
          },
          gameToolCalls,
        },
  );

interface PlatformAliasCaseRunV1 {
  readonly result: PlatformAliasDemoResultV1;
  readonly rawGodotToolCalls: readonly PlatformAliasGodotRunCallV1[];
  readonly candidateRuntimeErrors: JsonValue | null;
  readonly candidateRuntimeErrorsError: string | null;
  readonly sharedToolNames: readonly string[];
  readonly chronoriftToolNames: readonly string[];
}

async function runPlatformAliasCaseV1(
  request: PlatformAliasDemoRequestV1,
  ablationArm: PlatformAliasAblationArmV1,
): Promise<PlatformAliasCaseRunV1> {
  if (
    request.provider.trim().length === 0 ||
    request.model.trim().length === 0
  ) {
    throw new Error("GN-1 provider and model must not be empty");
  }
  const runtimeConfig = await resolveSrtRuntimeConfig({
    ...(request.stateRoot === undefined
      ? {}
      : { stateRoot: request.stateRoot }),
    ...(request.godotBin === undefined ? {} : { godotBin: request.godotBin }),
  });
  const runtimeRoot = runtimeConfig.stateRoot;
  const inspectedSource = await inspectFixedSource(
    request.projectPath,
    runtimeRoot,
  );
  const source = inspectedSource.source;
  if (source.requestedGodotVersion !== "4.7.1") {
    throw new Error("GN-1 requires Godot 4.7.1");
  }
  const godot = runtimeConfig.godot;
  const adapter = await loadProjectAdapterPackageWithBytesV1(
    PLATFORM_ALIAS_ADAPTER_DIRECTORY,
    {
      requireSingleLaunchTarget: true,
      expectedMainScene: source.mainScene,
      requireEmptyLaunchParameters: true,
    },
  );
  const managed = preflightManagedGodotProjectEnvironmentRuntimeV1({
    godotReceipt: godot.receipt,
    adapterFiles: adapter.fileBytes.map((file) => ({
      relativePath: file.path,
      bytes: Uint8Array.from(file.bytes),
    })),
  });
  const taskId = asProjectEnvironmentTaskId(randomUUID());
  const layout = await createProjectEnvironmentTaskDirectoryLayout({
    runtimeRoot,
    sourceRepositoryRoot: source.repositoryRoot,
    taskId,
  });
  const materialized = await materializePrivateTaskWorkspace({
    taskId,
    source,
    layout,
  });
  const payloadSchemaDigest = asSha256DigestV1(
    contentHash({
      schemaVersion: 1,
      schemas: adapter.manifest.schemas.map((schema) => ({
        schemaId: schema.schemaId,
        sha256: schema.sha256,
      })),
    }),
  );
  const policyProfileDigest = asSha256DigestV1(
    contentHash({
      schemaVersion: 1,
      runtime: "@anthropic-ai/sandbox-runtime@0.0.74",
      network: "denied",
      codingWorkspace: "read-write",
      godotProject: "read-only-host-stage",
    }),
  );
  const prepareBuild = () =>
    prepareProjectEnvironmentDebugBuildV1({
      workspaceDirectory: materialized.workspaceDirectory,
      expectedMainScene: materialized.mainScene,
      adapterManifestDigest: asSha256DigestV1(adapter.manifestSha256),
      adapterPackageDigest: asSha256DigestV1(adapter.candidateSha256),
      payloadSchemaDigest,
      sdkDigest: managed.sdkDigest,
      bridgeDigest: managed.bridgeDigest,
      toolchainArtifactDigest: godot.receipt.executableSha256,
      policyProfileDigest,
    });
  const initial = await prepareBuild();
  const defaultTarget = adapter.manifest.launchTargets.find(
    (target) => target.default,
  );
  if (defaultTarget === undefined) {
    throw new Error("GN-1 adapter lost its validated default launch target");
  }
  const codingHome = join(layout.sandboxTemporaryDirectory, "coding-home");
  const codingTemp = join(layout.sandboxTemporaryDirectory, "coding-tmp");
  await Promise.all([
    mkdir(codingHome, { mode: 0o700 }),
    mkdir(codingTemp, { mode: 0o700 }),
  ]);
  const controller = new SrtSandboxController();
  const runner = new SrtGodotRunner({
    controller,
    candidateWorkspace: materialized.workspaceDirectory,
    validationRoot: join(
      layout.hostOperationTemporaryDirectory,
      "godot-validation",
    ),
  });

  let baselineObservation: PlatformAliasRuntimeObservationV1;
  let piResult: VNextPiTurnResult | null = null;
  let piError: unknown;
  const gameToolCalls: z.infer<typeof PlatformAliasGameToolCallV1Schema>[] = [];
  const rawGodotToolCalls: PlatformAliasGodotRunCallV1[] = [];
  let candidatePatch: z.infer<typeof PlatformAliasPatchV1Schema>;
  let candidateObservation: PlatformAliasRuntimeObservationV1 | null = null;
  let candidateObservationError: string | null = null;
  let candidateRuntimeErrors: JsonValue | null = null;
  let candidateRuntimeErrorsError: string | null = null;
  let runtime: ProjectEnvironmentGameRuntimeV1 | null = null;
  let sharedToolNames: readonly string[] = [];
  let chronoriftToolNames: readonly string[] = [];
  try {
    const sidecar = new GodotProjectEnvironmentSidecarPortV1({
      runner,
      nodePath: runtimeConfig.nodePath,
      godotPath: godot.binding.executablePath,
      managedRuntime: managed,
    });
    runtime = new ProjectEnvironmentGameRuntimeV1({
      sidecar,
      managedRuntime: managed.capability,
      adapterPackage: adapter,
      capabilitySet: adapter.manifest.modules,
      taskId,
      sourceClosureId: initial.build.sourceClosureId,
      environmentRevisionId: `environment.gn1.${source.selectedTreeSha256.slice(0, 32)}`,
      adapterRevisionId: `adapter.gn1.${adapter.manifestSha256.slice(0, 32)}`,
      buildId: initial.build.buildId,
      candidateSourceHash: initial.build.candidateSourceHash,
      expectedMainScene: initial.build.expectedMainScene,
      adapterManifestSha256: adapter.manifestSha256,
      sdkSha256: managed.sdkDigest,
      bridgeSha256: managed.bridgeDigest,
      toolchainSha256: godot.receipt.executableSha256,
      engineVersion: managed.capability.engineVersion,
      exposedToolNames: EXPOSED_GAME_TOOLS,
      resolveCompatibleBuild: async () => (await prepareBuild()).build,
    });
    baselineObservation = await observePlatformAliasRuntimeV1(
      runtime,
      taskId,
      defaultTarget.targetId,
    );
    const gameTools = createProjectEnvironmentGameToolDefinitions(
      recordingPort(runtime, gameToolCalls),
      adapter.manifest.modules,
      {
        includedToolNames: EXPOSED_GAME_TOOLS,
        queryInputProfile: "pe-a-v1-narrow",
      },
    );
    const codingTools = createVNextCodingToolDefinitions(
      new SandboxPiCodingToolPort(controller, {
        workspacePath: materialized.workspaceDirectory,
        homePath: codingHome,
        tempPath: codingTemp,
        artifactsPath: layout.sandboxArtifactScratchDirectory,
      }),
    );
    const godotRunTool = createPlatformAliasGodotRunToolV1({
      sidecar,
      managedRuntime: managed.capability,
      taskId,
      prepareBuild,
      onCall: (call) => {
        rawGodotToolCalls.push(call);
      },
    });
    const ablationToolSurface = selectPlatformAliasAblationToolSurfaceV1({
      arm: ablationArm,
      codingTools,
      godotRunTool,
      chronoriftTools: gameTools,
    });
    const sharedTools = ablationToolSurface.sharedTools;
    const selectedGameTools = ablationToolSurface.chronoriftTools;
    sharedToolNames = Object.freeze(sharedTools.map((tool) => tool.name));
    chronoriftToolNames = Object.freeze(
      selectedGameTools.map((tool) => tool.name),
    );
    if (
      JSON.stringify(sharedToolNames) !==
        JSON.stringify(PLATFORM_ALIAS_ABLATION_SHARED_TOOL_NAMES) ||
      JSON.stringify(chronoriftToolNames) !==
        JSON.stringify(ablationArm === "chronorift" ? EXPOSED_GAME_TOOLS : [])
    ) {
      throw new Error(
        "GN-1 ablation tool catalog drifted before the Agent turn",
      );
    }
    try {
      const ablationEnvironment = createPlatformAliasAblationEnvironmentV1({
        taskId,
      });
      piResult = await runVNextPiTurnWithSdk({
        resourceWorkspaceDirectory: materialized.workspaceDirectory,
        sessionDirectory: layout.piSessionDirectory,
        newSessionId: randomUUID(),
        ...(request.agentDir === undefined
          ? {}
          : { agentDir: request.agentDir }),
        provider: request.provider,
        model: request.model,
        thinkingLevel: request.thinkingLevel,
        prompt: PLATFORM_ALIAS_PROMPT,
        tools: ablationToolSurface.tools,
        ...(request.timeoutMs === undefined
          ? {}
          : { timeoutMs: request.timeoutMs }),
        providerRequestTimeoutMs: GN1_PROVIDER_REQUEST_TIMEOUT_MS,
        agentRetryMaxRetries: GN1_AGENT_RETRY_MAX_RETRIES,
        transport: "sse",
        ...ablationEnvironment,
      });
    } catch (error) {
      piError = error;
    }
    await runtime.close();
    candidatePatch = await extractPlatformAliasCandidatePatchV1({
      taskId,
      workspaceDirectory: materialized.workspaceDirectory,
      hostBaselineGitDirectory: materialized.hostBaselineGitDirectory,
      hostBaselineCommit: materialized.hostBaselineCommit,
      baselineSourceHash: source.selectedTreeSha256,
      hostOperationTemporaryDirectory: layout.hostOperationTemporaryDirectory,
    });
    try {
      const postflight = await observePlatformAliasAblationPostflightV1(
        runtime,
        taskId,
        defaultTarget.targetId,
      );
      candidateObservation = postflight.observation;
      candidateRuntimeErrors = postflight.runtimeErrors;
    } catch (error) {
      candidateObservationError = boundedError(error);
      candidateRuntimeErrorsError = candidateObservationError;
    }
  } finally {
    await runtime?.close().catch(() => undefined);
    await controller.close();
  }
  const checkoutCleanAfter = await platformAliasSourceStillExactV1(
    source.repositoryRoot,
  );
  const commandStatus = checkoutCleanAfter
    ? "completed"
    : "cleanup_or_source_drift";
  const result = PlatformAliasDemoResultV1Schema.parse({
    schemaVersion: 1,
    commandStatus,
    taskId,
    source: {
      schemaVersion: 1,
      repositoryRoot: source.repositoryRoot,
      commit: PLATFORM_ALIAS_SOURCE_COMMIT,
      tree: inspectedSource.tree,
      selectedTreeSha256: source.selectedTreeSha256,
      checkoutCleanBefore: true,
      checkoutCleanAfter,
    },
    baselineObservation,
    agent: agentResult(request, piResult, piError, gameToolCalls),
    candidatePatch,
    candidateObservation,
    candidateObservationError,
    workspaceDirectory: materialized.workspaceDirectory,
    taskDirectory: layout.taskRootDirectory,
    sandboxRuntime: "anthropic-srt",
    limitations: [
      "This is one arm of one project-specific ablation pair at one exact third-party commit and tree.",
      "The Host postflight is not visible to the Agent and does not establish a canonical fix verdict.",
      "Interpretation requires the separately executed matched arm; one pair supports no general superiority claim.",
    ],
  });
  return {
    result,
    rawGodotToolCalls: Object.freeze([...rawGodotToolCalls]),
    candidateRuntimeErrors,
    candidateRuntimeErrorsError,
    sharedToolNames,
    chronoriftToolNames,
  };
}

export async function runPlatformAliasAblationV1(
  request: PlatformAliasAblationRequestV1,
): Promise<PlatformAliasAblationRunV1> {
  const arm = PlatformAliasAblationArmV1Schema.parse(request.arm);
  const timeoutMs = request.timeoutMs ?? PLATFORM_ALIAS_ABLATION_TIMEOUT_MS;
  const configuration = PlatformAliasAblationConfigurationV1Schema.parse({
    schemaVersion: 1,
    provider: request.provider,
    model: request.model,
    thinkingLevel: request.thinkingLevel,
    timeoutMs,
    environmentProfile: PLATFORM_ALIAS_ABLATION_ENVIRONMENT_PROFILE,
    environmentInstructionProfile:
      PLATFORM_ALIAS_ABLATION_ENVIRONMENT_INSTRUCTION_PROFILE,
    prompt: PLATFORM_ALIAS_PROMPT,
    sourceCommit: PLATFORM_ALIAS_SOURCE_COMMIT,
    sourceTree: PLATFORM_ALIAS_SOURCE_TREE,
    sharedToolNames: PLATFORM_ALIAS_ABLATION_SHARED_TOOL_NAMES,
    chronoriftToolNames:
      arm === "chronorift" ? EXPOSED_GAME_TOOLS : Object.freeze([]),
  });
  const executed = await runPlatformAliasCaseV1({ ...request, timeoutMs }, arm);
  if (
    JSON.stringify(executed.sharedToolNames) !==
      JSON.stringify(configuration.sharedToolNames) ||
    JSON.stringify(executed.chronoriftToolNames) !==
      JSON.stringify(configuration.chronoriftToolNames)
  ) {
    throw new Error("GN-1 ablation realized tool surface drifted from config");
  }
  return PlatformAliasAblationRunV1Schema.parse({
    schemaVersion: 1,
    arm,
    configuration,
    result: executed.result,
    rawGodotToolCalls: executed.rawGodotToolCalls,
    candidateRuntimeErrors: executed.candidateRuntimeErrors,
    candidateRuntimeErrorsError: executed.candidateRuntimeErrorsError,
  });
}
