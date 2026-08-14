import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

import {
  GameAdapterIdV1Schema,
  GameBranchIdV1Schema,
  GameBuildIdV1Schema,
  GameCheckpointIdV1Schema,
  GameComparisonIdV1Schema,
  GameExecutionIdV1Schema,
  GameRuntimeIdV1Schema,
  GameSourceIdV1Schema,
  GameTaskIdV1Schema,
  GameTraceIdV1Schema,
  GameWorkspaceIdV1Schema,
} from "./vnext-game-tool-inputs.js";
import { GameBoundedJsonValueV1Schema } from "./vnext-game-tool-outputs.js";

const strictObject = { additionalProperties: false } as const;
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const shortString = Type.String({ minLength: 1, maxLength: 4_096 });
const nonnegativeInteger = Type.Integer({ minimum: 0 });
const clockDomain = Type.Union([
  Type.Literal("process_frame"),
  Type.Literal("physics_tick"),
]);

export const SEMANTIC_GAME_TOOL_NAMES_V1 = Object.freeze([
  "game_capabilities",
  "game_launch",
  "game_status",
  "game_stop",
  "game_query",
  "game_checkpoint_create",
  "game_checkpoint_restore",
  "game_fork",
  "game_trace_create",
  "game_trace_replay",
  "game_compare",
] as const);
export type SemanticGameToolNameV1 =
  (typeof SEMANTIC_GAME_TOOL_NAMES_V1)[number];

export const SEMANTIC_UNSUPPORTED_GAME_CAPABILITIES_V1 = Object.freeze([
  "game.capture.configure",
  "game.capture.pin",
  "game.control.input",
  "game.control.step",
  "game.control.configure",
] as const);

const taskInput = {
  schemaVersion: Type.Literal(1),
  taskId: GameTaskIdV1Schema,
} as const;

export const SemanticGameCapabilitiesInputV1Schema = Type.Object(
  {
    ...taskInput,
    runtimeId: Type.Optional(GameRuntimeIdV1Schema),
  },
  strictObject,
);
export const SemanticGameLaunchInputV1Schema = Type.Object(
  { ...taskInput, buildId: GameBuildIdV1Schema },
  strictObject,
);
export const SemanticGameStatusInputV1Schema = Type.Object(
  { ...taskInput, runtimeId: GameRuntimeIdV1Schema },
  strictObject,
);
export const SemanticGameStopInputV1Schema = SemanticGameStatusInputV1Schema;

const semanticQuerySource = Type.Union([
  Type.Object(
    { kind: Type.Literal("runtime"), runtimeId: GameRuntimeIdV1Schema },
    strictObject,
  ),
  Type.Object(
    { kind: Type.Literal("execution"), executionId: GameExecutionIdV1Schema },
    strictObject,
  ),
]);

export const SemanticGameQueryInputV1Schema = Type.Object(
  {
    ...taskInput,
    source: semanticQuerySource,
    view: Type.Union([
      Type.Literal("entities"),
      Type.Literal("state"),
      Type.Literal("events"),
      Type.Literal("clocks"),
      Type.Literal("coverage"),
    ]),
    entityIds: Type.Optional(
      Type.Array(shortString, { maxItems: 20, uniqueItems: true }),
    ),
    statePaths: Type.Optional(
      Type.Array(shortString, { maxItems: 20, uniqueItems: true }),
    ),
    limit: Type.Integer({ minimum: 1, maximum: 200 }),
    cursor: Type.Optional(Type.String({ pattern: "^(0|[1-9][0-9]{0,5})$" })),
  },
  strictObject,
);

export const SemanticGameCheckpointCreateInputV1Schema = Type.Object(
  {
    ...taskInput,
    runtimeId: GameRuntimeIdV1Schema,
    barrier: Type.Literal("adapter_process_tail"),
  },
  strictObject,
);
export const SemanticGameCheckpointRestoreInputV1Schema = Type.Object(
  {
    ...taskInput,
    runtimeId: GameRuntimeIdV1Schema,
    checkpointId: GameCheckpointIdV1Schema,
  },
  strictObject,
);

const semanticForkSource = Type.Union([
  Type.Object(
    { kind: Type.Literal("workspace"), workspaceId: GameWorkspaceIdV1Schema },
    strictObject,
  ),
  Type.Object(
    { kind: Type.Literal("build"), buildId: GameBuildIdV1Schema },
    strictObject,
  ),
  Type.Object(
    { kind: Type.Literal("execution"), executionId: GameExecutionIdV1Schema },
    strictObject,
  ),
  Type.Object(
    {
      kind: Type.Literal("checkpoint"),
      checkpointId: GameCheckpointIdV1Schema,
    },
    strictObject,
  ),
]);
export const SemanticGameForkInputV1Schema = Type.Object(
  {
    ...taskInput,
    source: semanticForkSource,
    targetBuildId: Type.Optional(GameBuildIdV1Schema),
    checkpointId: Type.Optional(GameCheckpointIdV1Schema),
    traceId: Type.Optional(GameTraceIdV1Schema),
  },
  strictObject,
);

export const SemanticGameTraceCreateInputV1Schema = Type.Object(
  {
    ...taskInput,
    runtimeId: GameRuntimeIdV1Schema,
    clockDomain,
    sampleOffsets: Type.Array(Type.Integer({ minimum: 1, maximum: 600 }), {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
  },
  strictObject,
);
export const SemanticGameTraceReplayInputV1Schema = Type.Object(
  {
    ...taskInput,
    runtimeId: GameRuntimeIdV1Schema,
    traceId: GameTraceIdV1Schema,
    maxTicks: Type.Integer({ minimum: 1, maximum: 600 }),
  },
  strictObject,
);
export const SemanticGameCompareInputV1Schema = Type.Object(
  {
    ...taskInput,
    baselineExecutionId: GameExecutionIdV1Schema,
    candidateExecutionId: GameExecutionIdV1Schema,
    maxDifferences: Type.Integer({ minimum: 1, maximum: 200 }),
  },
  strictObject,
);

export type SemanticGameCapabilitiesInputV1 = Static<
  typeof SemanticGameCapabilitiesInputV1Schema
>;
export type SemanticGameLaunchInputV1 = Static<
  typeof SemanticGameLaunchInputV1Schema
>;
export type SemanticGameStatusInputV1 = Static<
  typeof SemanticGameStatusInputV1Schema
>;
export type SemanticGameQueryInputV1 = Static<
  typeof SemanticGameQueryInputV1Schema
>;
export type SemanticGameCheckpointCreateInputV1 = Static<
  typeof SemanticGameCheckpointCreateInputV1Schema
>;
export type SemanticGameCheckpointRestoreInputV1 = Static<
  typeof SemanticGameCheckpointRestoreInputV1Schema
>;
export type SemanticGameForkInputV1 = Static<
  typeof SemanticGameForkInputV1Schema
>;
export type SemanticGameTraceCreateInputV1 = Static<
  typeof SemanticGameTraceCreateInputV1Schema
>;
export type SemanticGameTraceReplayInputV1 = Static<
  typeof SemanticGameTraceReplayInputV1Schema
>;
export type SemanticGameCompareInputV1 = Static<
  typeof SemanticGameCompareInputV1Schema
>;

const semanticClock = Type.Object(
  {
    processFrame: nonnegativeInteger,
    physicsTick: nonnegativeInteger,
    simulationTimeUs: nonnegativeInteger,
    hostMonotonicUs: nonnegativeInteger,
    renderFrame: Type.Null(),
  },
  strictObject,
);
const semanticCoverage = Type.Array(
  Type.Object(
    {
      channel: Type.Union([
        Type.Literal("clock"),
        Type.Literal("state"),
        Type.Literal("entity_lifecycle"),
        Type.Literal("log"),
        Type.Literal("error"),
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
  ),
  { maxItems: 5 },
);
const semanticLoss = Type.Array(
  Type.Object(
    {
      channel: shortString,
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
  ),
  { maxItems: 64 },
);
const semanticRuntime = Type.Object(
  {
    schemaVersion: Type.Literal(1),
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
    targetScene: shortString,
    adapterId: GameAdapterIdV1Schema,
    adapterProfileSha256: hash,
    clocks: semanticClock,
    coverage: semanticCoverage,
    loss: semanticLoss,
  },
  strictObject,
);
const semanticBuild = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    workspaceId: GameWorkspaceIdV1Schema,
    sourceId: GameSourceIdV1Schema,
    buildId: GameBuildIdV1Schema,
    sourceHash: hash,
    workspaceDiffHash: hash,
  },
  strictObject,
);
const semanticToolList = Type.Tuple(
  SEMANTIC_GAME_TOOL_NAMES_V1.map((name) =>
    Type.Object(
      { name: Type.Literal(name), capability: shortString },
      strictObject,
    ),
  ),
);

export const SemanticGameCapabilitiesOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    workspaceId: GameWorkspaceIdV1Schema,
    profile: Type.Literal("godot-external-semantic-v1"),
    semanticAdapterProfileSha256: hash,
    build: semanticBuild,
    tools: semanticToolList,
    unsupported: Type.Tuple(
      SEMANTIC_UNSUPPORTED_GAME_CAPABILITIES_V1.map((capability) =>
        Type.Object(
          {
            capability: Type.Literal(capability),
            reason: Type.Literal("semantic_profile_scope"),
          },
          strictObject,
        ),
      ),
    ),
    limits: Type.Object(
      {
        activeRuntimesMaximum: Type.Literal(2),
        launchesPerTurnMaximum: Type.Literal(8),
        entityMaximum: Type.Literal(256),
        eventMaximum: Type.Literal(4096),
        checkpointBytesMaximum: Type.Literal(1_048_576),
        traceSamplesMaximum: Type.Literal(32),
        traceTicksMaximum: Type.Literal(600),
        queryRowsMaximum: Type.Literal(200),
      },
      strictObject,
    ),
    runtime: Type.Union([Type.Null(), semanticRuntime]),
  },
  strictObject,
);
export const SemanticGameLaunchOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    build: semanticBuild,
    runtime: semanticRuntime,
    qualificationReceiptSha256: hash,
  },
  strictObject,
);
export const SemanticGameStatusOutputV1Schema = Type.Object(
  { schemaVersion: Type.Literal(1), runtime: semanticRuntime },
  strictObject,
);
export const SemanticGameStopOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runtime: semanticRuntime,
    sealed: Type.Literal(true),
    cleanupProven: Type.Literal(true),
  },
  strictObject,
);

const semanticEntity = Type.Object(
  {
    stableId: shortString,
    incarnation: Type.Integer({ minimum: 1 }),
    role: Type.Union([
      Type.Literal("subject"),
      Type.Literal("timer"),
      Type.Literal("spawned_entity"),
    ]),
    scene: Type.Union([Type.Null(), shortString]),
    spawnOrdinal: Type.Union([Type.Null(), nonnegativeInteger]),
  },
  strictObject,
);
const semanticRow = Type.Object(
  {
    sequence: nonnegativeInteger,
    clock: semanticClock,
    kind: Type.Union([
      Type.Literal("state"),
      Type.Literal("entity_lifecycle"),
      Type.Literal("clock"),
      Type.Literal("event"),
      Type.Literal("error"),
    ]),
    entity: Type.Union([Type.Null(), semanticEntity]),
    statePath: Type.Union([Type.Null(), shortString]),
    value: GameBoundedJsonValueV1Schema,
  },
  strictObject,
);

export const SemanticGameQueryOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    indexId: shortString,
    executionId: GameExecutionIdV1Schema,
    rows: Type.Array(semanticRow, { maxItems: 200 }),
    coverage: semanticCoverage,
    loss: semanticLoss,
    incomplete: Type.Boolean(),
    nextCursor: Type.Union([Type.Null(), shortString]),
  },
  strictObject,
);

const semanticCheckpoint = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    checkpointId: GameCheckpointIdV1Schema,
    taskId: GameTaskIdV1Schema,
    executionId: GameExecutionIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
    buildId: GameBuildIdV1Schema,
    adapterId: GameAdapterIdV1Schema,
    stateSchemaVersion: Type.Literal("chronorift.timer-spawn:v1"),
    semanticBarrier: Type.Literal("adapter_process_tail"),
    capturedAt: semanticClock,
    payloadSha256: hash,
    payloadBytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
    capturedDomains: Type.Array(shortString, { minItems: 1, maxItems: 16 }),
    uncontrolledDomains: Type.Array(shortString, { minItems: 1, maxItems: 32 }),
    fidelity: Type.Literal("descriptive_only"),
    equivalentForkEligible: Type.Literal(false),
  },
  strictObject,
);
export const SemanticGameCheckpointCreateOutputV1Schema = Type.Object(
  { schemaVersion: Type.Literal(1), checkpoint: semanticCheckpoint },
  strictObject,
);
export const SemanticGameCheckpointRestoreOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    checkpointId: GameCheckpointIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
    status: Type.Union([
      Type.Literal("restored"),
      Type.Literal("partially_restored"),
      Type.Literal("rejected"),
    ]),
    projectionHashBefore: hash,
    projectionHashAfter: hash,
    equivalence: Type.Literal(
      "registered_state_restored_but_equivalence_unestablished",
    ),
    fidelity: Type.Literal("descriptive_only"),
    equivalentForkEligible: Type.Literal(false),
    limitations: Type.Array(shortString, { minItems: 1, maxItems: 64 }),
  },
  strictObject,
);

const semanticTraceSample = Type.Object(
  {
    sequence: nonnegativeInteger,
    requestedOffset: Type.Integer({ minimum: 1, maximum: 600 }),
    realizedOffset: nonnegativeInteger,
    quantized: Type.Boolean(),
    clock: semanticClock,
    projectionSha256: hash,
    projection: GameBoundedJsonValueV1Schema,
  },
  strictObject,
);
const semanticTrace = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    traceId: GameTraceIdV1Schema,
    taskId: GameTaskIdV1Schema,
    sourceExecutionId: GameExecutionIdV1Schema,
    sourceRuntimeId: GameRuntimeIdV1Schema,
    sourceBuildId: GameBuildIdV1Schema,
    adapterId: GameAdapterIdV1Schema,
    clockDomain,
    origin: semanticClock,
    samples: Type.Array(semanticTraceSample, { minItems: 1, maxItems: 32 }),
  },
  strictObject,
);
export const SemanticGameTraceCreateOutputV1Schema = Type.Object(
  { schemaVersion: Type.Literal(1), trace: semanticTrace },
  strictObject,
);
export const SemanticGameTraceReplayOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    trace: semanticTrace,
    targetExecutionId: GameExecutionIdV1Schema,
    mode: Type.Union([
      Type.Literal("same_build_projection_replay"),
      Type.Literal("descriptive_only"),
    ]),
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("stopped"),
      Type.Literal("failed"),
    ]),
    firstDivergence: Type.Union([
      Type.Null(),
      Type.Object(
        {
          sequence: nonnegativeInteger,
          subject: shortString,
          expected: GameBoundedJsonValueV1Schema,
          observed: GameBoundedJsonValueV1Schema,
        },
        strictObject,
      ),
    ]),
    limitations: Type.Array(shortString, { minItems: 1, maxItems: 64 }),
  },
  strictObject,
);

export const SemanticGameForkOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    branchId: GameBranchIdV1Schema,
    childRuntimeId: GameRuntimeIdV1Schema,
    childExecutionId: GameExecutionIdV1Schema,
    mode: Type.Union([
      Type.Literal("fresh"),
      Type.Literal("checkpoint_projection_restore"),
      Type.Literal("fresh_trace_replay"),
    ]),
    fidelity: Type.Literal("descriptive_only"),
    checkpointId: Type.Union([Type.Null(), GameCheckpointIdV1Schema]),
    traceId: Type.Union([Type.Null(), GameTraceIdV1Schema]),
    limitations: Type.Array(shortString, { minItems: 1, maxItems: 64 }),
  },
  strictObject,
);

export const SemanticGameCompareOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    comparisonId: GameComparisonIdV1Schema,
    baselineExecutionId: GameExecutionIdV1Schema,
    candidateExecutionId: GameExecutionIdV1Schema,
    mode: Type.Union([
      Type.Literal("descriptive_only"),
      Type.Literal("confounded"),
    ]),
    alignment: Type.Union([
      Type.Literal("aligned"),
      Type.Literal("partial"),
      Type.Literal("unavailable"),
    ]),
    differences: Type.Array(
      Type.Object(
        {
          category: Type.Union([
            Type.Literal("state"),
            Type.Literal("entity"),
            Type.Literal("event"),
            Type.Literal("clock"),
          ]),
          subject: shortString,
          baseline: GameBoundedJsonValueV1Schema,
          candidate: GameBoundedJsonValueV1Schema,
          clock: Type.Union([Type.Null(), semanticClock]),
        },
        strictObject,
      ),
      { maxItems: 200 },
    ),
    firstDivergenceSequence: Type.Union([Type.Null(), nonnegativeInteger]),
    confounders: Type.Array(shortString, { maxItems: 64 }),
    limitations: Type.Array(shortString, { minItems: 1, maxItems: 64 }),
  },
  strictObject,
);

export const SEMANTIC_GAME_TOOL_OUTPUT_SCHEMAS_V1 = Object.freeze({
  game_capabilities: SemanticGameCapabilitiesOutputV1Schema,
  game_launch: SemanticGameLaunchOutputV1Schema,
  game_status: SemanticGameStatusOutputV1Schema,
  game_stop: SemanticGameStopOutputV1Schema,
  game_query: SemanticGameQueryOutputV1Schema,
  game_checkpoint_create: SemanticGameCheckpointCreateOutputV1Schema,
  game_checkpoint_restore: SemanticGameCheckpointRestoreOutputV1Schema,
  game_fork: SemanticGameForkOutputV1Schema,
  game_trace_create: SemanticGameTraceCreateOutputV1Schema,
  game_trace_replay: SemanticGameTraceReplayOutputV1Schema,
  game_compare: SemanticGameCompareOutputV1Schema,
} satisfies Record<SemanticGameToolNameV1, TSchema>);

const inputSchemas = Object.freeze({
  game_capabilities: SemanticGameCapabilitiesInputV1Schema,
  game_launch: SemanticGameLaunchInputV1Schema,
  game_status: SemanticGameStatusInputV1Schema,
  game_stop: SemanticGameStopInputV1Schema,
  game_query: SemanticGameQueryInputV1Schema,
  game_checkpoint_create: SemanticGameCheckpointCreateInputV1Schema,
  game_checkpoint_restore: SemanticGameCheckpointRestoreInputV1Schema,
  game_fork: SemanticGameForkInputV1Schema,
  game_trace_create: SemanticGameTraceCreateInputV1Schema,
  game_trace_replay: SemanticGameTraceReplayInputV1Schema,
  game_compare: SemanticGameCompareInputV1Schema,
} satisfies Record<SemanticGameToolNameV1, TSchema>);

const capabilities = Object.freeze({
  game_capabilities: "game.capabilities.read",
  game_launch: "game.runtime.launch",
  game_status: "game.runtime.status",
  game_stop: "game.runtime.stop",
  game_query: "game.state.query",
  game_checkpoint_create: "game.checkpoint.create",
  game_checkpoint_restore: "game.checkpoint.restore",
  game_fork: "game.branch.fork",
  game_trace_create: "game.trace.create",
  game_trace_replay: "game.trace.replay",
  game_compare: "game.execution.compare",
} satisfies Record<SemanticGameToolNameV1, string>);

export interface SemanticGameToolMetadataV1 {
  readonly name: SemanticGameToolNameV1;
  readonly label: string;
  readonly description: string;
  readonly capability: string;
  readonly parameters: TSchema;
}

export const SEMANTIC_GAME_TOOL_DEFINITIONS_V1: readonly SemanticGameToolMetadataV1[] =
  Object.freeze(
    SEMANTIC_GAME_TOOL_NAMES_V1.map((name) => ({
      name,
      label: `External semantic ${name.slice("game_".length).replaceAll("_", " ")}`,
      description:
        name === "game_capabilities"
          ? "Reports the bounded external-project Timer/spawn semantic profile and exact supported tools."
          : `Runs ${name} within the declared Timer/spawn projection and reports coverage, loss, lineage, and fidelity limits.`,
      capability: capabilities[name],
      parameters: inputSchemas[name],
    })),
  );

export const validateSemanticGameToolInputV1 = (
  toolName: SemanticGameToolNameV1,
  input: unknown,
): boolean => Check(inputSchemas[toolName], input);

export const validateSemanticGameToolOutputV1 = (
  toolName: SemanticGameToolNameV1,
  output: unknown,
): boolean => Check(SEMANTIC_GAME_TOOL_OUTPUT_SCHEMAS_V1[toolName], output);
