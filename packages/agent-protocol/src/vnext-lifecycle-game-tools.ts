import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

import {
  GameBuildIdV1Schema,
  GameExecutionIdV1Schema,
  GameRuntimeIdV1Schema,
  GameSourceIdV1Schema,
  GameTaskIdV1Schema,
  GameWorkspaceIdV1Schema,
} from "./vnext-game-tool-inputs.js";

const strictObject = { additionalProperties: false } as const;
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const timestamp = Type.String({ format: "date-time" });
const nonnegativeInteger = Type.Integer({ minimum: 0 });
const shortString = Type.String({ minLength: 1, maxLength: 4_096 });

export const LIFECYCLE_GAME_TOOL_NAMES_V1 = Object.freeze([
  "game_capabilities",
  "game_launch",
  "game_status",
  "game_stop",
] as const);
export type LifecycleGameToolNameV1 =
  (typeof LIFECYCLE_GAME_TOOL_NAMES_V1)[number];

export const LIFECYCLE_UNSUPPORTED_GAME_CAPABILITIES_V1 = Object.freeze([
  "game.capture.configure",
  "game.capture.pin",
  "game.state.query",
  "game.control.input",
  "game.control.step",
  "game.control.configure",
  "game.checkpoint.create",
  "game.checkpoint.restore",
  "game.branch.fork",
  "game.trace.create",
  "game.trace.replay",
  "game.execution.compare",
] as const);
export type LifecycleUnsupportedGameCapabilityV1 =
  (typeof LIFECYCLE_UNSUPPORTED_GAME_CAPABILITIES_V1)[number];

export const LifecycleGameCapabilitiesInputV2Schema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    taskId: GameTaskIdV1Schema,
    runtimeId: Type.Optional(GameRuntimeIdV1Schema),
  },
  strictObject,
);
export type LifecycleGameCapabilitiesInputV2 = Static<
  typeof LifecycleGameCapabilitiesInputV2Schema
>;

export const LifecycleGameLaunchInputV2Schema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    taskId: GameTaskIdV1Schema,
    buildId: GameBuildIdV1Schema,
  },
  strictObject,
);
export type LifecycleGameLaunchInputV2 = Static<
  typeof LifecycleGameLaunchInputV2Schema
>;

export const LifecycleGameStatusInputV2Schema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    taskId: GameTaskIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
  },
  strictObject,
);
export type LifecycleGameStatusInputV2 = Static<
  typeof LifecycleGameStatusInputV2Schema
>;

export const LifecycleGameStopInputV2Schema = LifecycleGameStatusInputV2Schema;
export type LifecycleGameStopInputV2 = Static<
  typeof LifecycleGameStopInputV2Schema
>;

const lifecycleBuild = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    workspaceId: GameWorkspaceIdV1Schema,
    sourceId: GameSourceIdV1Schema,
    buildId: GameBuildIdV1Schema,
    sourceHash: hash,
    workspaceDiffHash: hash,
    buildConfigurationHash: hash,
    outputHash: hash,
  },
  strictObject,
);

const lifecycleProject = Type.Object(
  {
    profile: Type.Literal("godot-external-lifecycle-v1"),
    declaredSourceUrl: Type.String({ minLength: 1, maxLength: 2_048 }),
    sourceRevision: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
    selectedTreeSha256: hash,
    descriptorSha256: hash,
    projectCapabilitySha256: hash,
  },
  strictObject,
);

const lifecycleEngine = Type.Object(
  {
    version: shortString,
    build: shortString,
    platform: shortString,
    renderer: shortString,
    audioDriver: shortString,
    headless: Type.Boolean(),
  },
  strictObject,
);

const lifecycleClocks = Type.Object(
  {
    processFrame: nonnegativeInteger,
    physicsTick: nonnegativeInteger,
    simulationTimeUs: nonnegativeInteger,
    hostMonotonicUs: nonnegativeInteger,
    renderFrame: Type.Null(),
    processFrameDelta: nonnegativeInteger,
    physicsTickDelta: nonnegativeInteger,
  },
  strictObject,
);

const lifecycleCoverage = Type.Object(
  {
    channel: Type.Union([
      Type.Literal("clock"),
      Type.Literal("log"),
      Type.Literal("error"),
      Type.Literal("probe"),
    ]),
    status: Type.Union([
      Type.Literal("full"),
      Type.Literal("partial"),
      Type.Literal("unavailable"),
    ]),
    emittedRecords: nonnegativeInteger,
    droppedRecords: nonnegativeInteger,
    limitations: Type.Array(shortString, { maxItems: 32 }),
  },
  strictObject,
);

const lifecycleLoss = Type.Object(
  {
    channel: Type.Union([
      Type.Literal("clock"),
      Type.Literal("log"),
      Type.Literal("error"),
      Type.Literal("probe"),
    ]),
    kind: Type.Union([
      Type.Literal("dropped"),
      Type.Literal("truncated"),
      Type.Literal("unavailable"),
      Type.Literal("observer_effect"),
    ]),
    count: nonnegativeInteger,
    reason: shortString,
  },
  strictObject,
);

const lifecycleDiagnostics = Type.Object(
  {
    stdoutTotalBytes: nonnegativeInteger,
    stdoutRetainedBytes: Type.Integer({ minimum: 0, maximum: 1_048_576 }),
    stdoutTruncated: Type.Boolean(),
    stderrTotalBytes: nonnegativeInteger,
    stderrRetainedBytes: Type.Integer({ minimum: 0, maximum: 1_048_576 }),
    stderrTruncated: Type.Boolean(),
  },
  strictObject,
);

const lifecycleRuntimeFacts = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    taskId: GameTaskIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
    executionId: GameExecutionIdV1Schema,
    buildId: GameBuildIdV1Schema,
    status: Type.Union([
      Type.Literal("starting"),
      Type.Literal("running"),
      Type.Literal("cleanup_pending"),
      Type.Literal("stopped"),
      Type.Literal("crashed"),
      Type.Literal("failed"),
    ]),
    engine: lifecycleEngine,
    configuredScene: shortString,
    currentScene: shortString,
    clocks: lifecycleClocks,
    coverage: Type.Array(lifecycleCoverage, { maxItems: 4 }),
    loss: Type.Array(lifecycleLoss, { maxItems: 64 }),
    diagnostics: lifecycleDiagnostics,
    startedAt: timestamp,
    endedAt: Type.Union([Type.Null(), timestamp]),
  },
  strictObject,
);
export type LifecycleRuntimeFactsV2 = Static<typeof lifecycleRuntimeFacts>;

const lifecyclePhase = Type.Object(
  {
    sequence: nonnegativeInteger,
    phase: Type.Union([
      Type.Literal("vanilla_import"),
      Type.Literal("vanilla_smoke"),
      Type.Literal("managed_import"),
      Type.Literal("managed_handshake"),
      Type.Literal("managed_status"),
      Type.Literal("managed_stop"),
    ]),
    operationState: Type.Union([
      Type.Literal("not_started"),
      Type.Literal("started"),
      Type.Literal("unknown"),
    ]),
    timingFidelity: Type.Union([
      Type.Literal("operation_bounds"),
      Type.Literal("host_observed_bounds"),
    ]),
    processDurationMs: Type.Union([nonnegativeInteger, Type.Null()]),
    stabilityObservedMs: Type.Union([
      Type.Integer({ minimum: 2_000, maximum: 60_000 }),
      Type.Null(),
    ]),
    outcome: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("timed_out"),
      Type.Literal("controlled_stop"),
    ]),
    hostMonotonicStartUs: nonnegativeInteger,
    hostMonotonicEndUs: nonnegativeInteger,
    stdoutTruncated: Type.Boolean(),
    stderrTruncated: Type.Boolean(),
    cleanupProven: Type.Boolean(),
  },
  strictObject,
);

const lifecycleIdentities = Type.Object(
  {
    descriptorSha256: hash,
    sourceSha256: hash,
    buildSha256: hash,
    overlaySha256: hash,
    addonSha256: hash,
    vanillaSidecarSha256: hash,
    lifecycleSidecarSha256: hash,
    managedRuntimeId: Type.String({
      pattern: "^managed-godot-runtime:v1:[a-f0-9]{64}$",
    }),
  },
  strictObject,
);

const lifecycleSupportedTools = Type.Tuple(
  LIFECYCLE_GAME_TOOL_NAMES_V1.map((name) =>
    Type.Object(
      {
        name: Type.Literal(name),
        capability: Type.Literal(
          name === "game_capabilities"
            ? "game.capabilities.read"
            : name === "game_launch"
              ? "game.runtime.launch"
              : name === "game_status"
                ? "game.runtime.status"
                : "game.runtime.stop",
        ),
      },
      strictObject,
    ),
  ),
);

const lifecycleUnsupported = Type.Array(
  Type.Object(
    {
      capability: Type.Union(
        LIFECYCLE_UNSUPPORTED_GAME_CAPABILITIES_V1.map((value) =>
          Type.Literal(value),
        ),
      ),
      reason: Type.Literal("lifecycle_only_profile"),
    },
    strictObject,
  ),
  {
    minItems: LIFECYCLE_UNSUPPORTED_GAME_CAPABILITIES_V1.length,
    maxItems: LIFECYCLE_UNSUPPORTED_GAME_CAPABILITIES_V1.length,
  },
);

export const LifecycleGameCapabilitiesOutputV2Schema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    taskId: GameTaskIdV1Schema,
    workspaceId: GameWorkspaceIdV1Schema,
    project: lifecycleProject,
    build: lifecycleBuild,
    tools: lifecycleSupportedTools,
    unsupported: lifecycleUnsupported,
    limits: Type.Object(
      {
        activeRuntimesMaximum: Type.Literal(1),
        launchesPerTurnMaximum: Type.Literal(4),
        readinessProcessFrameDeltaMinimum: Type.Literal(120),
        readinessPhysicsTickDeltaMinimum: Type.Literal(120),
      },
      strictObject,
    ),
    runtime: Type.Union([Type.Null(), lifecycleRuntimeFacts]),
  },
  strictObject,
);
export type LifecycleGameCapabilitiesOutputV2 = Static<
  typeof LifecycleGameCapabilitiesOutputV2Schema
>;

export const LifecycleGameLaunchOutputV2Schema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    project: lifecycleProject,
    build: lifecycleBuild,
    runtime: lifecycleRuntimeFacts,
    identities: lifecycleIdentities,
    phases: Type.Array(lifecyclePhase, { minItems: 4, maxItems: 6 }),
  },
  strictObject,
);
export type LifecycleGameLaunchOutputV2 = Static<
  typeof LifecycleGameLaunchOutputV2Schema
>;

export const LifecycleGameStatusOutputV2Schema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    runtime: lifecycleRuntimeFacts,
  },
  strictObject,
);
export type LifecycleGameStatusOutputV2 = Static<
  typeof LifecycleGameStatusOutputV2Schema
>;

const provenCleanup = Type.Object(
  {
    processGroupTerminated: Type.Literal(true),
    godotExited: Type.Literal(true),
    sidecarExited: Type.Literal(true),
    cgroupEmpty: Type.Literal(true),
    scopeRemoved: Type.Literal(true),
    scratchRemoved: Type.Literal(true),
    storageReconciled: Type.Literal(true),
  },
  strictObject,
);

export const LifecycleGameStopOutputV2Schema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    runtime: lifecycleRuntimeFacts,
    sealed: Type.Literal(true),
    cleanup: provenCleanup,
  },
  strictObject,
);
export type LifecycleGameStopOutputV2 = Static<
  typeof LifecycleGameStopOutputV2Schema
>;

export interface LifecycleGameToolMetadataV1 {
  readonly name: LifecycleGameToolNameV1;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
}

export const LIFECYCLE_GAME_TOOL_DEFINITIONS_V1: readonly LifecycleGameToolMetadataV1[] =
  Object.freeze([
    {
      name: "game_capabilities",
      label: "Game lifecycle capabilities",
      description:
        "Reports the external-project lifecycle profile, current build, supported lifecycle tools, and explicitly unsupported game capabilities.",
      parameters: LifecycleGameCapabilitiesInputV2Schema,
    },
    {
      name: "game_launch",
      label: "Launch external game lifecycle",
      description:
        "Runs vanilla import and main-scene smoke before launching the managed lifecycle overlay for a task-owned build.",
      parameters: LifecycleGameLaunchInputV2Schema,
    },
    {
      name: "game_status",
      label: "Read external game lifecycle status",
      description:
        "Reads realized engine, scene, clocks, diagnostics, coverage, and loss for a task-owned lifecycle runtime.",
      parameters: LifecycleGameStatusInputV2Schema,
    },
    {
      name: "game_stop",
      label: "Stop external game lifecycle",
      description:
        "Stops a lifecycle runtime and seals its execution only after sandbox cleanup is proven.",
      parameters: LifecycleGameStopInputV2Schema,
    },
  ]);

export const LIFECYCLE_GAME_TOOL_OUTPUT_SCHEMAS_V2 = Object.freeze({
  game_capabilities: LifecycleGameCapabilitiesOutputV2Schema,
  game_launch: LifecycleGameLaunchOutputV2Schema,
  game_status: LifecycleGameStatusOutputV2Schema,
  game_stop: LifecycleGameStopOutputV2Schema,
} satisfies Record<LifecycleGameToolNameV1, TSchema>);

export const validateLifecycleGameToolInputV2 = (
  toolName: LifecycleGameToolNameV1,
  input: unknown,
): boolean => {
  const definition = LIFECYCLE_GAME_TOOL_DEFINITIONS_V1.find(
    (candidate) => candidate.name === toolName,
  );
  return definition !== undefined && Check(definition.parameters, input);
};

export const validateLifecycleGameToolOutputV2 = (
  toolName: LifecycleGameToolNameV1,
  output: unknown,
): boolean => Check(LIFECYCLE_GAME_TOOL_OUTPUT_SCHEMAS_V2[toolName], output);
