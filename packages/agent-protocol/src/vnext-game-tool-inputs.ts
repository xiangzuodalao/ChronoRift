import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const strictObject = { additionalProperties: false } as const;
const nonEmptyStrictObject = {
  additionalProperties: false,
  minProperties: 1,
} as const;

const resourceId = (kind: string) =>
  Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$",
    description: `Stable task-owned ${kind} resource ID`,
  });

/** Stable task resources. These strings are neither paths nor Session handles. */
export const GameTaskIdV1Schema = resourceId("task");
export const GameWorkspaceIdV1Schema = resourceId("workspace");
export const GameSourceIdV1Schema = resourceId("source");
export const GameBuildIdV1Schema = resourceId("build");
export const GameRuntimeIdV1Schema = resourceId("runtime");
export const GameExecutionIdV1Schema = resourceId("execution");
export const GameCaptureWindowIdV1Schema = resourceId("capture-window");
export const GameCheckpointIdV1Schema = resourceId("checkpoint");
export const GameTraceIdV1Schema = resourceId("trace");
export const GameBranchIdV1Schema = resourceId("branch");
export const GameComparisonIdV1Schema = resourceId("comparison");
export const GameRuntimeStateIndexIdV1Schema = resourceId(
  "runtime-state-index",
);
export const GameRestoreReceiptIdV1Schema = resourceId("restore-receipt");
export const GameEventIdV1Schema = resourceId("event");
export const GameAdapterIdV1Schema = resourceId("adapter");
export const GameProbeIdV1Schema = resourceId("probe");

export type GameTaskIdV1 = Static<typeof GameTaskIdV1Schema>;
export type GameWorkspaceIdV1 = Static<typeof GameWorkspaceIdV1Schema>;
export type GameSourceIdV1 = Static<typeof GameSourceIdV1Schema>;
export type GameBuildIdV1 = Static<typeof GameBuildIdV1Schema>;
export type GameRuntimeIdV1 = Static<typeof GameRuntimeIdV1Schema>;
export type GameExecutionIdV1 = Static<typeof GameExecutionIdV1Schema>;
export type GameCaptureWindowIdV1 = Static<typeof GameCaptureWindowIdV1Schema>;
export type GameCheckpointIdV1 = Static<typeof GameCheckpointIdV1Schema>;
export type GameTraceIdV1 = Static<typeof GameTraceIdV1Schema>;
export type GameBranchIdV1 = Static<typeof GameBranchIdV1Schema>;
export type GameComparisonIdV1 = Static<typeof GameComparisonIdV1Schema>;
export type GameRuntimeStateIndexIdV1 = Static<
  typeof GameRuntimeStateIndexIdV1Schema
>;
export type GameRestoreReceiptIdV1 = Static<
  typeof GameRestoreReceiptIdV1Schema
>;
export type GameEventIdV1 = Static<typeof GameEventIdV1Schema>;
export type GameAdapterIdV1 = Static<typeof GameAdapterIdV1Schema>;
export type GameProbeIdV1 = Static<typeof GameProbeIdV1Schema>;

export const validateGameTaskIdV1 = (value: unknown): value is GameTaskIdV1 =>
  Check(GameTaskIdV1Schema, value);

export const GameFrameRateV1Schema = Type.Union([
  Type.Literal(60),
  Type.Literal(120),
]);
export type GameFrameRateV1 = Static<typeof GameFrameRateV1Schema>;

export const GameClockV1Schema = Type.Union([
  Type.Literal("process_frame"),
  Type.Literal("physics_tick"),
]);
export type GameClockV1 = Static<typeof GameClockV1Schema>;

export const GameRequestedPointV1Schema = Type.Union([
  Type.Object(
    {
      clock: Type.Literal("process_frame"),
      requestedTick: Type.Integer({ minimum: 0, maximum: 600 }),
      requestedPhase: Type.Union([
        Type.Literal("process_frame_start"),
        Type.Literal("process_frame_end"),
      ]),
    },
    strictObject,
  ),
  Type.Object(
    {
      clock: Type.Literal("physics_tick"),
      requestedTick: Type.Integer({ minimum: 0, maximum: 600 }),
      requestedPhase: Type.Union([
        Type.Literal("physics_tick_start"),
        Type.Literal("physics_tick_end"),
      ]),
    },
    strictObject,
  ),
]);
export type GameRequestedPointV1 = Static<typeof GameRequestedPointV1Schema>;

export const GameRuntimeControlsV1Schema = Type.Object(
  {
    fixedFps: Type.Optional(GameFrameRateV1Schema),
    physicsTicksPerSecond: Type.Optional(GameFrameRateV1Schema),
    maxTicks: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
  },
  nonEmptyStrictObject,
);
export type GameRuntimeControlsV1 = Static<typeof GameRuntimeControlsV1Schema>;

export const GameCaptureChannelV1Schema = Type.Union([
  Type.Literal("input"),
  Type.Literal("clocks"),
  Type.Literal("entity_lifecycle"),
  Type.Literal("runtime_error"),
  Type.Literal("checkpoint"),
  Type.Literal("state"),
  Type.Literal("probe"),
  Type.Literal("log"),
]);
export type GameCaptureChannelV1 = Static<typeof GameCaptureChannelV1Schema>;

const statePath = Type.String({
  minLength: 3,
  maxLength: 128,
  pattern: "^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*){1,7}$",
});
const eventType = Type.String({
  minLength: 1,
  maxLength: 96,
  pattern: "^[A-Za-z][A-Za-z0-9_-]*(?:\\.[A-Za-z][A-Za-z0-9_-]*){0,7}$",
});
const entityId = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z][A-Za-z0-9_.:-]*$",
});
const jsonPrimitive = Type.Union([
  Type.String({ maxLength: 1024 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

export const GameCaptureTriggerV1Schema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("runtime_event"),
      event: Type.Union([
        Type.Literal("runtime_exit"),
        Type.Literal("engine_error"),
        Type.Literal("assertion_failure"),
        Type.Literal("hang_timeout"),
      ]),
    },
    strictObject,
  ),
  Type.Object(
    {
      kind: Type.Literal("state_equals"),
      statePath,
      value: jsonPrimitive,
    },
    strictObject,
  ),
  Type.Object(
    {
      kind: Type.Literal("event"),
      eventType,
    },
    strictObject,
  ),
]);
export type GameCaptureTriggerV1 = Static<typeof GameCaptureTriggerV1Schema>;

const captureProfileProperties = {
  historySeconds: Type.Integer({ minimum: 1, maximum: 10 }),
  maxTicks: Type.Integer({ minimum: 1, maximum: 600 }),
  channels: Type.Array(GameCaptureChannelV1Schema, {
    minItems: 1,
    maxItems: 8,
    uniqueItems: true,
  }),
  stateSampleEveryTicks: Type.Integer({ minimum: 1, maximum: 600 }),
  triggers: Type.Array(GameCaptureTriggerV1Schema, {
    maxItems: 16,
  }),
} as const;

export const GameCaptureProfileV1Schema = Type.Object(
  captureProfileProperties,
  strictObject,
);
export type GameCaptureProfileV1 = Static<typeof GameCaptureProfileV1Schema>;

export const GameCapabilitiesInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    runtimeId: Type.Optional(GameRuntimeIdV1Schema),
  },
  strictObject,
);
export type GameCapabilitiesInputV1 = Static<
  typeof GameCapabilitiesInputV1Schema
>;

export const GameLaunchInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    buildId: GameBuildIdV1Schema,
    controls: Type.Optional(GameRuntimeControlsV1Schema),
  },
  strictObject,
);
export type GameLaunchInputV1 = Static<typeof GameLaunchInputV1Schema>;

export const GameStatusInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
  },
  strictObject,
);
export type GameStatusInputV1 = Static<typeof GameStatusInputV1Schema>;

export const GameStopInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
  },
  strictObject,
);
export type GameStopInputV1 = Static<typeof GameStopInputV1Schema>;

export const GameCaptureConfigureInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
    ...captureProfileProperties,
  },
  strictObject,
);
export type GameCaptureConfigureInputV1 = Static<
  typeof GameCaptureConfigureInputV1Schema
>;

export const GameCapturePinInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
    anchor: Type.Optional(GameRequestedPointV1Schema),
    beforeTicks: Type.Integer({ minimum: 0, maximum: 600 }),
    afterTicks: Type.Integer({ minimum: 0, maximum: 600 }),
  },
  strictObject,
);
export type GameCapturePinInputV1 = Static<typeof GameCapturePinInputV1Schema>;

export const GameQueryTickRangeV1Schema = Type.Object(
  {
    clock: GameClockV1Schema,
    fromTick: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    toTick: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  },
  strictObject,
);
export type GameQueryTickRangeV1 = Static<typeof GameQueryTickRangeV1Schema>;

export const GameQueryFiltersV1Schema = Type.Object(
  {
    entityIds: Type.Optional(
      Type.Array(entityId, { maxItems: 20, uniqueItems: true }),
    ),
    eventTypes: Type.Optional(
      Type.Array(eventType, { maxItems: 20, uniqueItems: true }),
    ),
    statePaths: Type.Optional(
      Type.Array(statePath, { maxItems: 20, uniqueItems: true }),
    ),
    tickRange: Type.Optional(GameQueryTickRangeV1Schema),
  },
  nonEmptyStrictObject,
);
export type GameQueryFiltersV1 = Static<typeof GameQueryFiltersV1Schema>;

export const GameQueryInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    executionId: GameExecutionIdV1Schema,
    indexId: Type.Optional(GameRuntimeStateIndexIdV1Schema),
    select: Type.Union([
      Type.Literal("events"),
      Type.Literal("entities"),
      Type.Literal("state"),
      Type.Literal("clocks"),
      Type.Literal("coverage"),
    ]),
    filters: Type.Optional(GameQueryFiltersV1Schema),
    limit: Type.Integer({ minimum: 1, maximum: 200 }),
    cursor: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 6,
        pattern: "^(0|[1-9][0-9]{0,5})$",
        description: "Bounded Runtime State Index row offset",
      }),
    ),
  },
  strictObject,
);
export type GameQueryInputV1 = Static<typeof GameQueryInputV1Schema>;

export const GameInputInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
    action: Type.Literal("attempt_jump"),
    targetEntityId: Type.Optional(entityId),
    requested: GameRequestedPointV1Schema,
  },
  strictObject,
);
export type GameInputInputV1 = Static<typeof GameInputInputV1Schema>;

export const GameStepInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
    clock: GameClockV1Schema,
    count: Type.Integer({ minimum: 1, maximum: 600 }),
  },
  strictObject,
);
export type GameStepInputV1 = Static<typeof GameStepInputV1Schema>;

export const GameSetControlsInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
    controls: GameRuntimeControlsV1Schema,
  },
  strictObject,
);
export type GameSetControlsInputV1 = Static<
  typeof GameSetControlsInputV1Schema
>;

export const GameCheckpointCreateInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
    barrier: Type.Union([
      Type.Literal("process_frame_end"),
      Type.Literal("physics_tick_end"),
    ]),
    adapterIds: Type.Optional(
      Type.Array(GameAdapterIdV1Schema, {
        minItems: 1,
        maxItems: 8,
        uniqueItems: true,
      }),
    ),
  },
  strictObject,
);
export type GameCheckpointCreateInputV1 = Static<
  typeof GameCheckpointCreateInputV1Schema
>;

export const GameCheckpointRestoreInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
    checkpointId: GameCheckpointIdV1Schema,
  },
  strictObject,
);
export type GameCheckpointRestoreInputV1 = Static<
  typeof GameCheckpointRestoreInputV1Schema
>;

export const GameForkSourceV1Schema = Type.Union([
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
  Type.Object(
    { kind: Type.Literal("build"), buildId: GameBuildIdV1Schema },
    strictObject,
  ),
  Type.Object(
    {
      kind: Type.Literal("workspace"),
      workspaceId: GameWorkspaceIdV1Schema,
    },
    strictObject,
  ),
]);
export type GameForkSourceV1 = Static<typeof GameForkSourceV1Schema>;

export const GameForkChangesV1Schema = Type.Object(
  {
    buildId: Type.Optional(GameBuildIdV1Schema),
    traceId: Type.Optional(GameTraceIdV1Schema),
    seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 4_294_967_295 })),
    controls: Type.Optional(GameRuntimeControlsV1Schema),
    capture: Type.Optional(GameCaptureProfileV1Schema),
    adapterIds: Type.Optional(
      Type.Array(GameAdapterIdV1Schema, {
        maxItems: 8,
        uniqueItems: true,
      }),
    ),
    probeIds: Type.Optional(
      Type.Array(GameProbeIdV1Schema, {
        maxItems: 16,
        uniqueItems: true,
      }),
    ),
  },
  nonEmptyStrictObject,
);
export type GameForkChangesV1 = Static<typeof GameForkChangesV1Schema>;

export const GameForkInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    source: GameForkSourceV1Schema,
    changes: GameForkChangesV1Schema,
  },
  strictObject,
);
export type GameForkInputV1 = Static<typeof GameForkInputV1Schema>;

export const GameTraceEventV1Schema = Type.Object(
  {
    action: Type.Literal("attempt_jump"),
    targetEntityId: Type.Optional(entityId),
    requested: GameRequestedPointV1Schema,
  },
  strictObject,
);
export type GameTraceEventV1 = Static<typeof GameTraceEventV1Schema>;

export const GameTraceCreateInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    source: Type.Optional(
      Type.Union([
        Type.Object(
          {
            kind: Type.Literal("runtime"),
            runtimeId: GameRuntimeIdV1Schema,
          },
          strictObject,
        ),
        Type.Object(
          {
            kind: Type.Literal("execution"),
            executionId: GameExecutionIdV1Schema,
          },
          strictObject,
        ),
      ]),
    ),
    events: Type.Array(GameTraceEventV1Schema, { maxItems: 128 }),
  },
  strictObject,
);
export type GameTraceCreateInputV1 = Static<
  typeof GameTraceCreateInputV1Schema
>;

export const GameTraceReplayInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    runtimeId: GameRuntimeIdV1Schema,
    traceId: GameTraceIdV1Schema,
    maxTicks: Type.Integer({ minimum: 1, maximum: 600 }),
  },
  strictObject,
);
export type GameTraceReplayInputV1 = Static<
  typeof GameTraceReplayInputV1Schema
>;

export const GameCompareInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: GameTaskIdV1Schema,
    baselineExecutionId: GameExecutionIdV1Schema,
    candidateExecutionId: GameExecutionIdV1Schema,
    maxDifferences: Type.Integer({ minimum: 1, maximum: 200 }),
  },
  strictObject,
);
export type GameCompareInputV1 = Static<typeof GameCompareInputV1Schema>;
