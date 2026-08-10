import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

import {
  GameAdapterIdV1Schema,
  GameBranchIdV1Schema,
  GameBuildIdV1Schema,
  GameCaptureWindowIdV1Schema,
  GameCheckpointIdV1Schema,
  GameClockV1Schema,
  GameComparisonIdV1Schema,
  GameEventIdV1Schema,
  GameExecutionIdV1Schema,
  GameProbeIdV1Schema,
  GameRequestedPointV1Schema,
  GameRestoreReceiptIdV1Schema,
  GameRuntimeControlsV1Schema,
  GameRuntimeIdV1Schema,
  GameRuntimeStateIndexIdV1Schema,
  GameSourceIdV1Schema,
  GameTaskIdV1Schema,
  GameTraceIdV1Schema,
  GameWorkspaceIdV1Schema,
  GameCaptureProfileV1Schema,
} from "./vnext-game-tool-inputs.js";
import { GAME_TOOL_NAMES_V1, type GameToolNameV1 } from "./vnext-game-tools.js";

const strictObject = { additionalProperties: false } as const;

const boundedJsonPrimitive = () =>
  Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String({ maxLength: 65_536 }),
  ]);

const boundedJsonCache = new Map<number, TSchema>();
const boundedJson = (depth: number): TSchema => {
  const cached = boundedJsonCache.get(depth);
  if (cached !== undefined) return cached;
  const schema =
    depth === 0
      ? boundedJsonPrimitive()
      : Type.Union([
          boundedJsonPrimitive(),
          Type.Array(boundedJson(depth - 1), { maxItems: 2_000 }),
          Type.Record(
            Type.String({ minLength: 1, maxLength: 256 }),
            boundedJson(depth - 1),
            { maxProperties: 512 },
          ),
        ]);
  boundedJsonCache.set(depth, schema);
  return schema;
};

/** JSON value schema with finite depth, collection, key, and string bounds. */
export const GameBoundedJsonValueV1Schema = boundedJson(8);

const jsonValue = GameBoundedJsonValueV1Schema;
const nonEmptyString = Type.String({ minLength: 1, maxLength: 4_096 });
const shortString = Type.String({ minLength: 1, maxLength: 256 });
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const timestamp = Type.String({ minLength: 20, maxLength: 64 });
const nullableSha256 = Type.Union([Type.Null(), sha256]);
const stringArray = (maximum = 256) =>
  Type.Array(nonEmptyString, { maxItems: maximum });
const jsonObject = Type.Record(
  Type.String({ minLength: 1, maxLength: 256 }),
  jsonValue,
  { maxProperties: 512 },
);

const runtimeInputApplication = Type.Object(
  {
    order: Type.Integer({ minimum: 0 }),
    eventsInjected: Type.Literal(2),
    pressed: Type.Literal(true),
    released: Type.Literal(true),
  },
  strictObject,
);
const observationHealth = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    emittedEvents: Type.Integer({ minimum: 0 }),
    droppedEvents: Type.Integer({ minimum: 0 }),
    truncatedEvents: Type.Integer({ minimum: 0 }),
    bufferedBytes: Type.Integer({ minimum: 0 }),
    backpressure: Type.Boolean(),
    probeOverheadUs: Type.Integer({ minimum: 0 }),
  },
  strictObject,
);
const runtimeStepReceipt = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    phase: Type.Literal("process_frame_start"),
    idleFramesExecuted: Type.Integer({ minimum: 1 }),
    physicsTicksExecuted: Type.Integer({ minimum: 0 }),
    actualIdleDeltasUs: Type.Array(Type.Integer({ minimum: 0 }), {
      maxItems: 600,
    }),
    actualPhysicsDeltasUs: Type.Array(Type.Integer({ minimum: 0 }), {
      maxItems: 1_200,
    }),
    engineProcessFrame: Type.Integer({ minimum: 0 }),
    enginePhysicsFrame: Type.Integer({ minimum: 0 }),
    hostMonotonicStartUs: Type.Integer({ minimum: 0 }),
    hostMonotonicEndUs: Type.Integer({ minimum: 0 }),
    inputApplications: Type.Array(runtimeInputApplication, { maxItems: 600 }),
    observationHealth,
  },
  strictObject,
);
const stepReceipt = Type.Object(
  {
    requestedTick: Type.Integer({ minimum: 0 }),
    realizedTick: Type.Integer({ minimum: 0 }),
    requestedDeltaUs: Type.Integer({ minimum: 0 }),
    realizedDeltaUs: Type.Integer({ minimum: 0 }),
    appliedInputOrders: Type.Array(Type.Integer({ minimum: 0 }), {
      maxItems: 600,
    }),
    runtime: runtimeStepReceipt,
  },
  strictObject,
);

const clockProperties = {
  schemaVersion: Type.Literal(1),
  processFrame: Type.Integer({ minimum: 0 }),
  physicsTick: Type.Integer({ minimum: 0 }),
  simulationTimeUs: Type.Integer({ minimum: 0 }),
  hostMonotonicUs: Type.Integer({ minimum: 0 }),
  renderFrame: Type.Union([Type.Null(), Type.Integer({ minimum: 0 })]),
} as const;
export const GameClockPositionOutputV1Schema = Type.Object(
  clockProperties,
  strictObject,
);
const clockRange = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    from: GameClockPositionOutputV1Schema,
    through: GameClockPositionOutputV1Schema,
  },
  strictObject,
);

const stateSnapshot = Type.Object(
  {
    values: Type.Record(
      Type.String({ minLength: 1, maxLength: 256 }),
      jsonValue,
      { maxProperties: 512 },
    ),
  },
  strictObject,
);

const captureChannel = Type.Union(
  [
    "input",
    "clock",
    "entity_lifecycle",
    "error",
    "checkpoint",
    "restore",
    "state_summary",
    "probe",
    "log",
    "rng",
    "relation",
  ].map((value) => Type.Literal(value)),
);
const rawEventKind = Type.Union(
  [
    "input",
    "clock",
    "entity_lifecycle",
    "state",
    "signal",
    "log",
    "error",
    "crash",
    "rng",
    "probe",
    "checkpoint",
    "restore",
    "capture_loss",
    "control",
    "relation",
  ].map((value) => Type.Literal(value)),
);
const queryEventKind = Type.Union(
  [
    "input",
    "event",
    "state",
    "lifecycle",
    "relation",
    "log",
    "error",
    "rng",
    "clock",
    "checkpoint",
  ].map((value) => Type.Literal(value)),
);
const runtimePhase = Type.Union(
  [
    "runtime_start",
    "process_frame_start",
    "input_flush",
    "physics_tick_start",
    "physics_tick_end",
    "process_frame_end",
    "render_complete",
    "runtime_stop",
  ].map((value) => Type.Literal(value)),
);
const runtimeControlMismatch = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    control: Type.Union(
      [
        "fixed_fps",
        "physics_ticks_per_second",
        "time_scale",
        "paused",
        "headless",
      ].map((value) => Type.Literal(value)),
    ),
    requested: jsonValue,
    realized: jsonValue,
    reason: nonEmptyString,
  },
  strictObject,
);
const observedRelation = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    kind: Type.Union(
      ["scheduled_by", "spawned_by", "delivery"].map((value) =>
        Type.Literal(value),
      ),
    ),
    targetEventId: GameEventIdV1Schema,
  },
  strictObject,
);
const branchChangeDimension = Type.Union(
  [
    "code",
    "adapter",
    "probe",
    "input",
    "seed",
    "runtime_control",
    "capture_profile",
    "project_configuration",
  ].map((value) => Type.Literal(value)),
);
const captureLoss = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    sequence: Type.Integer({ minimum: 0 }),
    channel: captureChannel,
    kind: Type.Union(
      [
        "degraded",
        "sampled",
        "dropped",
        "overwritten",
        "unavailable",
        "observer_effect",
      ].map((value) => Type.Literal(value)),
    ),
    count: Type.Integer({ minimum: 0 }),
    firstClock: Type.Union([Type.Null(), GameClockPositionOutputV1Schema]),
    lastClock: Type.Union([Type.Null(), GameClockPositionOutputV1Schema]),
    reason: nonEmptyString,
  },
  strictObject,
);
const captureCoverage = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    channel: captureChannel,
    status: Type.Union(
      ["full", "sampled", "partial", "unavailable"].map((value) =>
        Type.Literal(value),
      ),
    ),
    availableRange: Type.Union([Type.Null(), clockRange]),
    requestedSampleEvery: Type.Integer({ minimum: 1 }),
    realizedSampleEvery: Type.Union([
      Type.Null(),
      Type.Integer({ minimum: 1 }),
    ]),
    emittedRecords: Type.Integer({ minimum: 0 }),
    droppedRecords: Type.Integer({ minimum: 0 }),
    overwrittenRecords: Type.Integer({ minimum: 0 }),
    observerEffectUs: Type.Integer({ minimum: 0 }),
    limitations: stringArray(128),
  },
  strictObject,
);
const coverageArray = Type.Array(captureCoverage, { maxItems: 32 });
const lossArray = Type.Array(captureLoss, { maxItems: 2_000 });

const capturePolicy = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    requestedRetentionUs: Type.Integer({ minimum: 1 }),
    requestedRetentionTicks: Type.Integer({ minimum: 1 }),
    memoryBudgetBytes: Type.Integer({ minimum: 1 }),
    diskBudgetBytes: Type.Integer({ minimum: 1 }),
    maxAverageOverheadRatio: Type.Number({ minimum: 0, maximum: 1 }),
    maxMainThreadBlockUs: Type.Integer({ minimum: 0 }),
    channels: Type.Array(
      Type.Object(
        {
          schemaVersion: Type.Literal(1),
          channel: captureChannel,
          priority: Type.Union(
            ["protected", "high", "normal", "low"].map((value) =>
              Type.Literal(value),
            ),
          ),
          sampleEvery: Type.Integer({ minimum: 1 }),
        },
        strictObject,
      ),
      { maxItems: 32 },
    ),
  },
  strictObject,
);
const captureProfile = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    requested: capturePolicy,
    realizedRetentionUs: Type.Integer({ minimum: 0 }),
    realizedRetentionTicks: Type.Integer({ minimum: 0 }),
    peakMemoryBytes: Type.Integer({ minimum: 0 }),
    writtenBytes: Type.Integer({ minimum: 0 }),
    averageOverheadRatio: Type.Number({ minimum: 0 }),
    maxMainThreadBlockUs: Type.Integer({ minimum: 0 }),
    budgetStatus: Type.Union(
      ["within_budget", "degraded", "exceeded"].map((value) =>
        Type.Literal(value),
      ),
    ),
    degradationReasons: stringArray(128),
    gameplayPausedForCapture: Type.Literal(false),
  },
  strictObject,
);

const adapterRef = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    adapterId: GameAdapterIdV1Schema,
    contentHash: sha256,
    protocolVersion: shortString,
  },
  strictObject,
);
const probeRef = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    probeId: GameProbeIdV1Schema,
    contentHash: sha256,
    channels: Type.Array(captureChannel, { minItems: 1, maxItems: 32 }),
  },
  strictObject,
);
const runtimeBase = {
  schemaVersion: Type.Literal(1),
  taskId: GameTaskIdV1Schema,
  runtimeId: GameRuntimeIdV1Schema,
  buildId: GameBuildIdV1Schema,
  sourceId: GameSourceIdV1Schema,
  adapter: adapterRef,
  probes: Type.Array(probeRef, { maxItems: 32 }),
  capabilities: stringArray(64),
  startedAt: timestamp,
} as const;
const runtimeResource = Type.Union([
  Type.Object(
    {
      ...runtimeBase,
      status: Type.Union([Type.Literal("starting"), Type.Literal("running")]),
    },
    strictObject,
  ),
  Type.Object(
    {
      ...runtimeBase,
      status: Type.Union([
        Type.Literal("stopped"),
        Type.Literal("crashed"),
        Type.Literal("failed"),
      ]),
      endedAt: timestamp,
      termination: Type.Object(
        {
          schemaVersion: Type.Literal(1),
          code: shortString,
          message: Type.Union([Type.Null(), nonEmptyString]),
        },
        strictObject,
      ),
    },
    strictObject,
  ),
]);

const buildResource = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    workspaceId: GameWorkspaceIdV1Schema,
    sourceId: GameSourceIdV1Schema,
    buildId: GameBuildIdV1Schema,
    sourceHash: sha256,
    workspaceDiffHash: sha256,
    buildConfigurationHash: sha256,
    outputHash: sha256,
    createdAt: timestamp,
  },
  strictObject,
);

const runtimeControls = Type.Object(
  {
    fixedFps: Type.Union([Type.Literal(60), Type.Literal(120)]),
    physicsTicksPerSecond: Type.Union([Type.Literal(60), Type.Literal(120)]),
    maxTicks: Type.Integer({ minimum: 1, maximum: 600 }),
    stepsUsed: Type.Integer({ minimum: 0 }),
  },
  strictObject,
);
const runtimeFacts = {
  runtime: runtimeResource,
  runtimeId: GameRuntimeIdV1Schema,
  executionId: GameExecutionIdV1Schema,
  state: stateSnapshot,
  clocks: GameClockPositionOutputV1Schema,
  controls: runtimeControls,
  coverage: coverageArray,
  loss: lossArray,
} as const;

export const GameCapabilitiesOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    workspaceId: GameWorkspaceIdV1Schema,
    build: buildResource,
    fixture: Type.Object(
      {
        fixtureId: Type.Literal("frame-input-window"),
        inputActions: Type.Tuple([Type.Literal("attempt_jump")]),
        frameRates: Type.Tuple([Type.Literal(60), Type.Literal(120)]),
        physicsRates: Type.Tuple([Type.Literal(60), Type.Literal(120)]),
        maxTicks: Type.Literal(600),
      },
      strictObject,
    ),
    tools: Type.Array(
      Type.Object({ name: shortString, capability: shortString }, strictObject),
      { minItems: 16, maxItems: 16 },
    ),
    costs: Type.Object(
      {
        rollingHistorySecondsMaximum: Type.Integer({ minimum: 1 }),
        queryRowMaximum: Type.Integer({ minimum: 1 }),
        traceEventMaximum: Type.Integer({ minimum: 1 }),
      },
      strictObject,
    ),
    unsupported: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
      maxItems: 64,
    }),
    runtime: Type.Union([Type.Null(), Type.Object(runtimeFacts, strictObject)]),
  },
  strictObject,
);

export const GameLaunchOutputV1Schema = Type.Object(
  {
    ...runtimeFacts,
    build: Type.Object(
      {
        buildId: GameBuildIdV1Schema,
        sourceId: GameSourceIdV1Schema,
        sourceHash: sha256,
      },
      strictObject,
    ),
  },
  strictObject,
);

export const GameStatusOutputV1Schema = Type.Object(runtimeFacts, strictObject);

export const GameStopOutputV1Schema = Type.Object(
  { ...runtimeFacts, sealed: Type.Literal(true) },
  strictObject,
);

export const GameCaptureConfigureOutputV1Schema = Type.Object(
  {
    runtimeId: GameRuntimeIdV1Schema,
    requested: GameCaptureProfileV1Schema,
    realized: capturePolicy,
    coverage: coverageArray,
    loss: lossArray,
  },
  strictObject,
);

export const GameCapturePinOutputV1Schema = Type.Object(
  {
    window: Type.Object(
      {
        schemaVersion: Type.Literal(1),
        taskId: GameTaskIdV1Schema,
        captureWindowId: GameCaptureWindowIdV1Schema,
        executionId: GameExecutionIdV1Schema,
        runtimeId: GameRuntimeIdV1Schema,
        sourceId: GameSourceIdV1Schema,
        buildId: GameBuildIdV1Schema,
        adapterId: GameAdapterIdV1Schema,
        probeIds: Type.Array(GameProbeIdV1Schema, { maxItems: 32 }),
        status: Type.Union(
          ["available", "partial", "unavailable"].map((value) =>
            Type.Literal(value),
          ),
        ),
        requestedRange: clockRange,
        realizedRange: Type.Union([Type.Null(), clockRange]),
        captureProfile,
        coverage: coverageArray,
        loss: lossArray,
        frozenBy: Type.Union(
          [
            "manual_pin",
            "capture_trigger",
            "crash",
            "engine_error",
            "timeout",
            "process_exit",
          ].map((value) => Type.Literal(value)),
        ),
        pinnedAt: timestamp,
        firstVisibleAnomalyEventId: Type.Union([
          Type.Null(),
          GameEventIdV1Schema,
        ]),
      },
      strictObject,
    ),
    events: Type.Array(
      Type.Object(
        {
          schemaVersion: Type.Literal(1),
          eventId: GameEventIdV1Schema,
          taskId: GameTaskIdV1Schema,
          executionId: GameExecutionIdV1Schema,
          runtimeId: GameRuntimeIdV1Schema,
          buildId: GameBuildIdV1Schema,
          sequence: Type.Integer({ minimum: 0 }),
          channel: captureChannel,
          kind: rawEventKind,
          clock: GameClockPositionOutputV1Schema,
          payload: jsonObject,
          observedRelations: Type.Array(observedRelation, { maxItems: 64 }),
        },
        strictObject,
      ),
      { maxItems: 2_000 },
    ),
  },
  strictObject,
);

export const GameQueryOutputV1Schema = Type.Object(
  {
    result: Type.Object(
      {
        schemaVersion: Type.Literal(1),
        taskId: GameTaskIdV1Schema,
        indexId: GameRuntimeStateIndexIdV1Schema,
        executionId: GameExecutionIdV1Schema,
        runtimeId: GameRuntimeIdV1Schema,
        sourceId: GameSourceIdV1Schema,
        buildId: GameBuildIdV1Schema,
        adapterId: GameAdapterIdV1Schema,
        probeIds: Type.Array(GameProbeIdV1Schema, { maxItems: 32 }),
        captureWindowIds: Type.Array(GameCaptureWindowIdV1Schema, {
          maxItems: 256,
        }),
        rawRecordHash: sha256,
        query: Type.Object(
          {
            schemaVersion: Type.Literal(1),
            taskId: GameTaskIdV1Schema,
            executionId: GameExecutionIdV1Schema,
            entityIds: Type.Array(shortString, { maxItems: 20 }),
            eventKinds: Type.Array(queryEventKind, { maxItems: 16 }),
            statePaths: Type.Array(shortString, { maxItems: 20 }),
            clockRange: Type.Union([Type.Null(), clockRange]),
            limit: Type.Integer({ minimum: 1, maximum: 10_000 }),
            cursor: Type.Union([Type.Null(), shortString]),
          },
          strictObject,
        ),
        rows: Type.Array(
          Type.Object(
            {
              schemaVersion: Type.Literal(1),
              rawEventId: GameEventIdV1Schema,
              rawSequence: Type.Integer({ minimum: 0 }),
              clock: GameClockPositionOutputV1Schema,
              kind: queryEventKind,
              entity: Type.Union([
                Type.Null(),
                Type.Object(
                  {
                    schemaVersion: Type.Literal(1),
                    stableId: shortString,
                    incarnation: Type.Integer({ minimum: 1 }),
                    sceneId: shortString,
                    parentStableId: Type.Union([Type.Null(), shortString]),
                    ownerStableId: Type.Union([Type.Null(), shortString]),
                  },
                  strictObject,
                ),
              ]),
              statePath: Type.Union([Type.Null(), shortString]),
              value: jsonValue,
              observedRelations: Type.Array(observedRelation, { maxItems: 64 }),
              checkpointId: Type.Union([Type.Null(), GameCheckpointIdV1Schema]),
            },
            strictObject,
          ),
          { maxItems: 200 },
        ),
        coverage: coverageArray,
        loss: lossArray,
        incomplete: Type.Boolean(),
        nextCursor: Type.Union([Type.Null(), shortString]),
      },
      strictObject,
    ),
  },
  strictObject,
);

export const GameInputOutputV1Schema = Type.Object(
  {
    runtimeId: GameRuntimeIdV1Schema,
    requestId: Type.String({ minLength: 1, maxLength: 256 }),
    action: Type.Literal("attempt_jump"),
    requested: GameRequestedPointV1Schema,
    queued: Type.Boolean(),
    realized: Type.Union([
      Type.Null(),
      Type.Object(
        {
          ...clockProperties,
          phase: runtimePhase,
          quantized: Type.Boolean(),
          mismatchReason: Type.Union([Type.Null(), nonEmptyString]),
        },
        strictObject,
      ),
    ]),
  },
  strictObject,
);

export const GameStepOutputV1Schema = Type.Object(
  {
    runtimeId: GameRuntimeIdV1Schema,
    executionId: GameExecutionIdV1Schema,
    requested: Type.Object(
      {
        clock: GameClockV1Schema,
        count: Type.Integer({ minimum: 1, maximum: 600 }),
      },
      strictObject,
    ),
    realized: Type.Object(
      {
        processFrames: Type.Integer({ minimum: 0 }),
        physicsTicks: Type.Integer({ minimum: 0 }),
        requestedClockProgress: Type.Integer({ minimum: 0 }),
        overshoot: Type.Integer({ minimum: 0 }),
      },
      strictObject,
    ),
    state: stateSnapshot,
    clocks: GameClockPositionOutputV1Schema,
    receipts: Type.Array(
      Type.Object(
        {
          schemaVersion: Type.Literal(1),
          requestId: Type.String({ minLength: 1, maxLength: 256 }),
          requested: GameRequestedPointV1Schema,
          realized: Type.Object(
            {
              ...clockProperties,
              phase: runtimePhase,
              quantized: Type.Boolean(),
              mismatchReason: Type.Union([Type.Null(), nonEmptyString]),
            },
            strictObject,
          ),
          knownSideEffects: stringArray(32),
        },
        strictObject,
      ),
      { maxItems: 600 },
    ),
    stepReceipts: Type.Array(stepReceipt, { maxItems: 600 }),
    pendingInputs: Type.Array(
      Type.Object(
        {
          requestId: Type.String({ minLength: 1, maxLength: 256 }),
          requested: GameRequestedPointV1Schema,
        },
        strictObject,
      ),
      { maxItems: 600 },
    ),
    coverage: coverageArray,
    loss: lossArray,
  },
  strictObject,
);

export const GameSetControlsOutputV1Schema = Type.Object(
  {
    runtimeId: GameRuntimeIdV1Schema,
    requested: GameRuntimeControlsV1Schema,
    realized: Type.Object(
      {
        fixedFps: Type.Union([Type.Literal(60), Type.Literal(120)]),
        physicsTicksPerSecond: Type.Union([
          Type.Literal(60),
          Type.Literal(120),
        ]),
        maxTicks: Type.Integer({ minimum: 1, maximum: 600 }),
      },
      strictObject,
    ),
    mismatches: Type.Array(runtimeControlMismatch, { maxItems: 16 }),
    knownSideEffects: Type.Array(
      Type.String({ minLength: 1, maxLength: 4_096 }),
      { maxItems: 32 },
    ),
  },
  strictObject,
);

const checkpointDomain = Type.Union([
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      domain: shortString,
      classification: Type.Literal("captured"),
      serializationRule: nonEmptyString,
      canonicalizationRule: nonEmptyString,
      stateHash: sha256,
      tolerance: Type.Union([Type.Null(), jsonValue]),
      restoreOrder: Type.Integer({ minimum: 0 }),
    },
    strictObject,
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      domain: shortString,
      classification: Type.Literal("reset"),
      resetRule: nonEmptyString,
      restoreOrder: Type.Integer({ minimum: 0 }),
    },
    strictObject,
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      domain: shortString,
      classification: Type.Literal("externally_controlled"),
      controller: nonEmptyString,
      limitation: nonEmptyString,
    },
    strictObject,
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      domain: shortString,
      classification: Type.Union([
        Type.Literal("unsupported"),
        Type.Literal("uncontrolled"),
      ]),
      reason: nonEmptyString,
    },
    strictObject,
  ),
]);
const checkpointManifest = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    checkpointId: GameCheckpointIdV1Schema,
    executionId: GameExecutionIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
    workspaceId: GameWorkspaceIdV1Schema,
    sourceId: GameSourceIdV1Schema,
    buildId: GameBuildIdV1Schema,
    adapterId: GameAdapterIdV1Schema,
    stateSchemaVersion: shortString,
    probeIds: Type.Array(GameProbeIdV1Schema, { maxItems: 32 }),
    captureWindowId: Type.Union([Type.Null(), GameCaptureWindowIdV1Schema]),
    capturedAt: GameClockPositionOutputV1Schema,
    consistencyModel: nonEmptyString,
    semanticBarrier: nonEmptyString,
    domains: Type.Array(checkpointDomain, { minItems: 1, maxItems: 256 }),
    restoreDependencyOrder: Type.Array(shortString, { maxItems: 256 }),
    inFlightState: stringArray(256),
    limitations: stringArray(256),
    portability: Type.Literal("same_build_only"),
    fidelity: Type.Union([
      Type.Literal("equivalent_candidate"),
      Type.Literal("descriptive_only"),
    ]),
  },
  strictObject,
);

const firstDivergence = Type.Union([
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      status: Type.Literal("observed"),
      clock: GameClockPositionOutputV1Schema,
      phase: runtimePhase,
      differenceKind: Type.Union(
        ["field", "entity", "event", "clock"].map((value) =>
          Type.Literal(value),
        ),
      ),
      subject: nonEmptyString,
      left: jsonValue,
      right: jsonValue,
      fidelityBoundary: nonEmptyString,
    },
    strictObject,
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      status: Type.Union([
        Type.Literal("none_observed"),
        Type.Literal("unavailable"),
      ]),
      fidelityBoundary: nonEmptyString,
      reason: nonEmptyString,
    },
    strictObject,
  ),
]);

const restoreReceipt = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    restoreReceiptId: GameRestoreReceiptIdV1Schema,
    checkpointId: GameCheckpointIdV1Schema,
    checkpointBuildId: GameBuildIdV1Schema,
    currentBuildId: GameBuildIdV1Schema,
    checkpointAdapterId: GameAdapterIdV1Schema,
    currentAdapterId: GameAdapterIdV1Schema,
    checkpointStateSchemaVersion: shortString,
    currentStateSchemaVersion: shortString,
    targetRuntimeId: GameRuntimeIdV1Schema,
    targetExecutionId: GameExecutionIdV1Schema,
    compatibility: Type.Union(
      [
        "same_build",
        "build_mismatch",
        "adapter_mismatch",
        "schema_mismatch",
      ].map((value) => Type.Literal(value)),
    ),
    status: Type.Union(
      ["restored", "partially_restored", "rejected"].map((value) =>
        Type.Literal(value),
      ),
    ),
    equivalentForkEligible: Type.Boolean(),
    equivalence: Type.Union([
      Type.Literal("registered_state_restored_but_equivalence_unestablished"),
      Type.Literal("unavailable"),
    ]),
    domains: Type.Array(
      Type.Object(
        {
          schemaVersion: Type.Literal(1),
          domain: shortString,
          requested: Type.Boolean(),
          status: Type.Union(
            [
              "restored",
              "reset",
              "externally_controlled",
              "rejected",
              "skipped",
              "unsupported",
              "uncontrolled",
            ].map((value) => Type.Literal(value)),
          ),
          beforeHash: nullableSha256,
          afterHash: nullableSha256,
          message: Type.Union([Type.Null(), nonEmptyString]),
        },
        strictObject,
      ),
      { maxItems: 256 },
    ),
    uncoveredDomains: Type.Array(shortString, { maxItems: 256 }),
    fidelity: Type.Union([
      Type.Literal("equivalent_candidate"),
      Type.Literal("descriptive_only"),
    ]),
    deterministicBoundary: nonEmptyString,
    validations: Type.Array(
      Type.Object(
        {
          schemaVersion: Type.Literal(1),
          name: shortString,
          status: Type.Union([
            Type.Literal("pass"),
            Type.Literal("fail"),
            Type.Literal("unavailable"),
          ]),
          expectedHash: nullableSha256,
          actualHash: nullableSha256,
          message: Type.Union([Type.Null(), nonEmptyString]),
        },
        strictObject,
      ),
      { maxItems: 256 },
    ),
    firstDivergence: Type.Union([Type.Null(), firstDivergence]),
  },
  strictObject,
);

const traceTarget = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    clockDomain: Type.Union(
      [
        "process_frame",
        "physics_tick",
        "simulation_time",
        "render_completion",
        "host_monotonic",
      ].map((value) => Type.Literal(value)),
    ),
    position: Type.Integer({ minimum: 0 }),
    phase: runtimePhase,
  },
  strictObject,
);
const traceRealization = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    clock: GameClockPositionOutputV1Schema,
    phase: runtimePhase,
    quantized: Type.Boolean(),
    mismatchReason: Type.Union([Type.Null(), nonEmptyString]),
  },
  strictObject,
);
const traceEvent = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    sequence: Type.Integer({ minimum: 0 }),
    kind: Type.Union(
      ["input_press", "input_release", "step", "runtime_control"].map((value) =>
        Type.Literal(value),
      ),
    ),
    name: shortString,
    value: jsonValue,
    inputPairId: Type.Union([Type.Null(), shortString]),
    requested: traceTarget,
    realized: Type.Union([Type.Null(), traceRealization]),
  },
  strictObject,
);
const runtimeTrace = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    traceId: GameTraceIdV1Schema,
    sourceExecutionId: Type.Union([Type.Null(), GameExecutionIdV1Schema]),
    sourceRuntimeId: Type.Union([Type.Null(), GameRuntimeIdV1Schema]),
    sourceId: GameSourceIdV1Schema,
    sourceBuildId: GameBuildIdV1Schema,
    sourceAdapterId: Type.Union([Type.Null(), GameAdapterIdV1Schema]),
    sourceProbeIds: Type.Array(GameProbeIdV1Schema, { maxItems: 32 }),
    sourceCaptureWindowId: Type.Union([
      Type.Null(),
      GameCaptureWindowIdV1Schema,
    ]),
    createdAt: timestamp,
    events: Type.Array(traceEvent, { maxItems: 256 }),
  },
  strictObject,
);
const traceReplayReceipt = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    traceId: GameTraceIdV1Schema,
    sourceExecutionId: Type.Union([Type.Null(), GameExecutionIdV1Schema]),
    targetExecutionId: GameExecutionIdV1Schema,
    sourceBuildId: GameBuildIdV1Schema,
    targetBuildId: GameBuildIdV1Schema,
    mode: Type.Union([
      Type.Literal("same_build_replay"),
      Type.Literal("descriptive_only"),
    ]),
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("stopped"),
      Type.Literal("failed"),
    ]),
    applications: Type.Array(
      Type.Object(
        {
          schemaVersion: Type.Literal(1),
          traceSequence: Type.Integer({ minimum: 0 }),
          requested: traceTarget,
          realized: traceRealization,
          knownSideEffects: stringArray(32),
        },
        strictObject,
      ),
      { maxItems: 256 },
    ),
    firstDivergence,
    limitations: stringArray(256),
  },
  strictObject,
);

export const GameCheckpointCreateOutputV1Schema = Type.Object(
  {
    manifest: checkpointManifest,
    state: stateSnapshot,
    participantStates: Type.Record(shortString, jsonValue, {
      maxProperties: 256,
    }),
    certificate: Type.Object(
      {
        level: shortString,
        coveredStateDomains: Type.Array(shortString, { maxItems: 256 }),
        missingStateDomains: Type.Array(shortString, { maxItems: 256 }),
      },
      strictObject,
    ),
  },
  strictObject,
);

export const GameCheckpointRestoreOutputV1Schema = Type.Object(
  {
    receipt: restoreReceipt,
    state: stateSnapshot,
    clocks: GameClockPositionOutputV1Schema,
  },
  strictObject,
);

const branchLineage = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    branchId: GameBranchIdV1Schema,
    parent: Type.Union([
      Type.Object(
        {
          schemaVersion: Type.Literal(1),
          kind: Type.Literal("workspace"),
          workspaceId: GameWorkspaceIdV1Schema,
        },
        strictObject,
      ),
      Type.Object(
        {
          schemaVersion: Type.Literal(1),
          kind: Type.Literal("build"),
          buildId: GameBuildIdV1Schema,
        },
        strictObject,
      ),
      Type.Object(
        {
          schemaVersion: Type.Literal(1),
          kind: Type.Literal("execution"),
          executionId: GameExecutionIdV1Schema,
          buildId: GameBuildIdV1Schema,
        },
        strictObject,
      ),
      Type.Object(
        {
          schemaVersion: Type.Literal(1),
          kind: Type.Literal("checkpoint"),
          checkpointId: GameCheckpointIdV1Schema,
          buildId: GameBuildIdV1Schema,
        },
        strictObject,
      ),
    ]),
    childWorkspaceId: GameWorkspaceIdV1Schema,
    childSourceId: GameSourceIdV1Schema,
    childBuildId: GameBuildIdV1Schema,
    childAdapterId: GameAdapterIdV1Schema,
    childProbeIds: Type.Array(GameProbeIdV1Schema, { maxItems: 32 }),
    childCaptureWindowId: Type.Union([
      Type.Null(),
      GameCaptureWindowIdV1Schema,
    ]),
    childTraceId: Type.Union([Type.Null(), GameTraceIdV1Schema]),
    childExecutionId: Type.Union([Type.Null(), GameExecutionIdV1Schema]),
    requestedChanges: Type.Array(
      Type.Object(
        {
          schemaVersion: Type.Literal(1),
          dimension: branchChangeDimension,
          requested: jsonValue,
        },
        strictObject,
      ),
      { maxItems: 16 },
    ),
    realizedChanges: Type.Array(
      Type.Object(
        {
          schemaVersion: Type.Literal(1),
          dimension: branchChangeDimension,
          requested: jsonValue,
          realized: jsonValue,
          status: Type.Union([
            Type.Literal("applied"),
            Type.Literal("partially_applied"),
            Type.Literal("rejected"),
          ]),
          knownSideEffects: stringArray(32),
        },
        strictObject,
      ),
      { maxItems: 16 },
    ),
    createdAt: timestamp,
  },
  strictObject,
);

export const GameTraceCreateOutputV1Schema = Type.Object(
  { trace: runtimeTrace },
  strictObject,
);

export const GameTraceReplayOutputV1Schema = Type.Object(
  { trace: runtimeTrace, receipt: traceReplayReceipt },
  strictObject,
);

export const GameForkOutputV1Schema = Type.Object(
  {
    branch: branchLineage,
    runtimeId: GameRuntimeIdV1Schema,
    executionId: GameExecutionIdV1Schema,
    restore: Type.Union([Type.Null(), GameCheckpointRestoreOutputV1Schema]),
    replay: Type.Union([Type.Null(), GameTraceReplayOutputV1Schema]),
    state: stateSnapshot,
    clocks: GameClockPositionOutputV1Schema,
  },
  strictObject,
);

const comparisonExecutionRef = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    executionId: GameExecutionIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
    sourceId: GameSourceIdV1Schema,
    buildId: GameBuildIdV1Schema,
    adapterId: GameAdapterIdV1Schema,
    probeIds: Type.Array(GameProbeIdV1Schema, { maxItems: 32 }),
    traceId: Type.Union([Type.Null(), GameTraceIdV1Schema]),
    checkpointId: Type.Union([Type.Null(), GameCheckpointIdV1Schema]),
    captureWindowIds: Type.Array(GameCaptureWindowIdV1Schema, {
      maxItems: 256,
    }),
    executionRecordHash: sha256,
    rawRecordHash: sha256,
    captureCoverageHash: sha256,
    checkpointFidelity: Type.Union([
      Type.Literal("equivalent_candidate"),
      Type.Literal("descriptive_only"),
      Type.Literal("not_applicable"),
    ]),
  },
  strictObject,
);

export const GameCompareOutputV1Schema = Type.Object(
  {
    comparison: Type.Object(
      {
        schemaVersion: Type.Literal(1),
        taskId: GameTaskIdV1Schema,
        comparisonId: GameComparisonIdV1Schema,
        mode: Type.Union([
          Type.Literal("descriptive_only"),
          Type.Literal("confounded"),
        ]),
        left: comparisonExecutionRef,
        right: comparisonExecutionRef,
        alignment: Type.Object(
          {
            schemaVersion: Type.Literal(1),
            status: Type.Union([
              Type.Literal("aligned"),
              Type.Literal("partial"),
              Type.Literal("unavailable"),
            ]),
            clockUncertaintyUs: Type.Union([
              Type.Null(),
              Type.Integer({ minimum: 0 }),
            ]),
            matchedEntities: stringArray(2_000),
            unmatchedLeftEntities: stringArray(2_000),
            unmatchedRightEntities: stringArray(2_000),
            ambiguousEntities: stringArray(2_000),
            limitations: stringArray(256),
          },
          strictObject,
        ),
        confounders: Type.Array(
          Type.Object(
            {
              schemaVersion: Type.Literal(1),
              category: Type.Union(
                [
                  "build",
                  "adapter",
                  "probe",
                  "coverage",
                  "checkpoint_fidelity",
                  "clock",
                  "trace",
                  "runtime",
                  "nondeterminism",
                ].map((value) => Type.Literal(value)),
              ),
              description: nonEmptyString,
              left: jsonValue,
              right: jsonValue,
            },
            strictObject,
          ),
          { maxItems: 256 },
        ),
        differences: Type.Array(
          Type.Object(
            {
              schemaVersion: Type.Literal(1),
              category: Type.Union(
                [
                  "source",
                  "workspace_diff",
                  "build",
                  "runtime",
                  "instrumentation",
                  "checkpoint",
                  "trace",
                  "input",
                  "seed",
                  "control",
                  "coverage",
                  "loss",
                  "clock",
                  "entity",
                  "state",
                  "event",
                  "timeline",
                  "outcome",
                ].map((value) => Type.Literal(value)),
              ),
              subject: nonEmptyString,
              left: jsonValue,
              right: jsonValue,
              observability: Type.Union([
                Type.Literal("full"),
                Type.Literal("partial"),
                Type.Literal("unavailable"),
              ]),
              clock: Type.Union([Type.Null(), GameClockPositionOutputV1Schema]),
              details: stringArray(256),
            },
            strictObject,
          ),
          { maxItems: 200 },
        ),
        firstDivergence: Type.Union([Type.Null(), firstDivergence]),
        limitations: stringArray(256),
        createdAt: timestamp,
      },
      strictObject,
    ),
  },
  strictObject,
);

export const GAME_TOOL_OUTPUT_SCHEMAS_V1 = Object.freeze({
  [GAME_TOOL_NAMES_V1.capabilities]: GameCapabilitiesOutputV1Schema,
  [GAME_TOOL_NAMES_V1.launch]: GameLaunchOutputV1Schema,
  [GAME_TOOL_NAMES_V1.status]: GameStatusOutputV1Schema,
  [GAME_TOOL_NAMES_V1.stop]: GameStopOutputV1Schema,
  [GAME_TOOL_NAMES_V1.captureConfigure]: GameCaptureConfigureOutputV1Schema,
  [GAME_TOOL_NAMES_V1.capturePin]: GameCapturePinOutputV1Schema,
  [GAME_TOOL_NAMES_V1.query]: GameQueryOutputV1Schema,
  [GAME_TOOL_NAMES_V1.input]: GameInputOutputV1Schema,
  [GAME_TOOL_NAMES_V1.step]: GameStepOutputV1Schema,
  [GAME_TOOL_NAMES_V1.setControls]: GameSetControlsOutputV1Schema,
  [GAME_TOOL_NAMES_V1.checkpointCreate]: GameCheckpointCreateOutputV1Schema,
  [GAME_TOOL_NAMES_V1.checkpointRestore]: GameCheckpointRestoreOutputV1Schema,
  [GAME_TOOL_NAMES_V1.fork]: GameForkOutputV1Schema,
  [GAME_TOOL_NAMES_V1.traceCreate]: GameTraceCreateOutputV1Schema,
  [GAME_TOOL_NAMES_V1.traceReplay]: GameTraceReplayOutputV1Schema,
  [GAME_TOOL_NAMES_V1.compare]: GameCompareOutputV1Schema,
} satisfies Record<GameToolNameV1, TSchema>);

export const validateGameToolOutputV1 = (
  toolName: GameToolNameV1,
  output: unknown,
): boolean => Check(GAME_TOOL_OUTPUT_SCHEMAS_V1[toolName], output);

export type GameCapabilitiesOutputV1 = Static<
  typeof GameCapabilitiesOutputV1Schema
>;
export type GameLaunchOutputV1 = Static<typeof GameLaunchOutputV1Schema>;
export type GameStatusOutputV1 = Static<typeof GameStatusOutputV1Schema>;
export type GameStopOutputV1 = Static<typeof GameStopOutputV1Schema>;
export type GameCaptureConfigureOutputV1 = Static<
  typeof GameCaptureConfigureOutputV1Schema
>;
export type GameCapturePinOutputV1 = Static<
  typeof GameCapturePinOutputV1Schema
>;
export type GameQueryOutputV1 = Static<typeof GameQueryOutputV1Schema>;
export type GameInputOutputV1 = Static<typeof GameInputOutputV1Schema>;
export type GameStepOutputV1 = Static<typeof GameStepOutputV1Schema>;
export type GameSetControlsOutputV1 = Static<
  typeof GameSetControlsOutputV1Schema
>;
export type GameCheckpointCreateOutputV1 = Static<
  typeof GameCheckpointCreateOutputV1Schema
>;
export type GameCheckpointRestoreOutputV1 = Static<
  typeof GameCheckpointRestoreOutputV1Schema
>;
export type GameForkOutputV1 = Static<typeof GameForkOutputV1Schema>;
export type GameTraceCreateOutputV1 = Static<
  typeof GameTraceCreateOutputV1Schema
>;
export type GameTraceReplayOutputV1 = Static<
  typeof GameTraceReplayOutputV1Schema
>;
export type GameCompareOutputV1 = Static<typeof GameCompareOutputV1Schema>;

// Keep the imported standalone resource schemas reachable in generated API
// documentation without weakening nested resource validation to Unknown.
export const GAME_OUTPUT_RESOURCE_ID_SCHEMAS_V1 = Object.freeze([
  GameBuildIdV1Schema,
  GameCaptureWindowIdV1Schema,
  GameCheckpointIdV1Schema,
  GameComparisonIdV1Schema,
  GameRuntimeStateIndexIdV1Schema,
  GameTraceIdV1Schema,
]);
