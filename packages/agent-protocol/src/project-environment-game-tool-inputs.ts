import {
  CanonicalAdapterValueV1Schema,
  type CanonicalAdapterValueV1,
} from "@chronorift/domain";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

const strictObject = { additionalProperties: false } as const;
const nonEmptyStrictObject = {
  additionalProperties: false,
  minProperties: 1,
} as const;

const opaqueResourceId = (description: string) =>
  Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$",
    description,
  });

const stableName = (description: string) =>
  Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z][A-Za-z0-9_.:-]{0,127}$",
    description,
  });

export const ProjectEnvironmentGameTaskIdV1Schema = opaqueResourceId(
  "Task-owned Project Environment task ID; never a path",
);
export const ProjectEnvironmentGameBuildIdV1Schema = opaqueResourceId(
  "Task-owned candidate Build ID; never a path",
);
export const ProjectEnvironmentGameRuntimeIdV1Schema = opaqueResourceId(
  "Task-owned runtime ID; never a path",
);
export const ProjectEnvironmentGameExecutionIdV1Schema = opaqueResourceId(
  "Task-owned execution ID; never a path",
);
export const ProjectEnvironmentGameWorkspaceIdV1Schema = opaqueResourceId(
  "Task-owned workspace ID; never a path",
);
export const ProjectEnvironmentGameCheckpointIdV1Schema = opaqueResourceId(
  "Task-owned checkpoint ID; never a path",
);
export const ProjectEnvironmentGameCaptureWindowIdV1Schema = opaqueResourceId(
  "Task-owned capture-window ID; never a path",
);
export const ProjectEnvironmentGameTraceIdV1Schema = opaqueResourceId(
  "Task-owned trace ID; never a path",
);
export const ProjectEnvironmentGameEventIdV1Schema = opaqueResourceId(
  "Task-owned event ID; never a path",
);
export const ProjectEnvironmentGameEntityIdV1Schema = opaqueResourceId(
  "Adapter-declared or execution-local entity ID; never a path",
);
export const ProjectEnvironmentGameAlignmentIdV1Schema = opaqueResourceId(
  "Adapter-declared alignment mapping ID; never a path",
);

export type ProjectEnvironmentGameTaskIdV1 = Static<
  typeof ProjectEnvironmentGameTaskIdV1Schema
>;
export type ProjectEnvironmentGameBuildIdV1 = Static<
  typeof ProjectEnvironmentGameBuildIdV1Schema
>;
export type ProjectEnvironmentGameRuntimeIdV1 = Static<
  typeof ProjectEnvironmentGameRuntimeIdV1Schema
>;
export type ProjectEnvironmentGameExecutionIdV1 = Static<
  typeof ProjectEnvironmentGameExecutionIdV1Schema
>;

const canonicalNumber = Type.Number({
  minimum: -Number.MAX_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER,
});
const canonicalInteger = Type.Integer({
  minimum: -Number.MAX_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER,
});
const numericTag = (tag: string, length: number) =>
  Type.Object(
    {
      $type: Type.Literal(tag),
      values: Type.Array(canonicalNumber, {
        minItems: length,
        maxItems: length,
      }),
    },
    strictObject,
  );
const referenceTag = (tag: "entity_ref" | "resource_ref", key: string) =>
  Type.Object(
    {
      $type: Type.Literal(tag),
      [key]: opaqueResourceId(`${tag} opaque identity`),
    },
    strictObject,
  );
const canonicalPrimitive = Type.Union([
  Type.Null(),
  Type.Boolean(),
  canonicalInteger,
  canonicalNumber,
  Type.String({ maxLength: 16_384 }),
]);
const canonicalTaggedValue = Type.Union([
  numericTag("vector2", 2),
  numericTag("vector3", 3),
  numericTag("vector4", 4),
  numericTag("quaternion", 4),
  numericTag("basis", 9),
  numericTag("transform2d", 6),
  numericTag("transform3d", 12),
  numericTag("color", 4),
  numericTag("rect2", 4),
  referenceTag("entity_ref", "entityId"),
  referenceTag("resource_ref", "resourceId"),
]);
/**
 * SDK-neutral projection of the domain canonical value contract for Pi tool
 * metadata. Host validation additionally applies the domain schema.
 */
export const ProjectEnvironmentCanonicalAdapterValueV1Schema = Type.Cyclic(
  {
    CanonicalAdapterValue: Type.Union([
      canonicalPrimitive,
      canonicalTaggedValue,
      Type.Array(Type.Ref("CanonicalAdapterValue"), { maxItems: 256 }),
      Type.Record(
        Type.String({ minLength: 1, maxLength: 256 }),
        Type.Ref("CanonicalAdapterValue"),
        { maxProperties: 256 },
      ),
    ]),
  },
  "CanonicalAdapterValue",
);
export type ProjectEnvironmentCanonicalAdapterValueV1 = CanonicalAdapterValueV1;

export const ProjectEnvironmentParameterMapV1Schema = Type.Record(
  Type.String({ minLength: 1, maxLength: 128 }),
  ProjectEnvironmentCanonicalAdapterValueV1Schema,
  { maxProperties: 128 },
);

export const ProjectEnvironmentClockDomainV1Schema = Type.Union(
  [
    "process_frame",
    "physics_tick",
    "simulation_time",
    "render_completion",
    "host_monotonic",
  ].map((value) => Type.Literal(value)),
);
export type ProjectEnvironmentClockDomainV1 = Static<
  typeof ProjectEnvironmentClockDomainV1Schema
>;

export const ProjectEnvironmentRuntimePhaseV1Schema = Type.Union(
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

export const ProjectEnvironmentRequestedPointV1Schema = Type.Object(
  {
    clockDomain: ProjectEnvironmentClockDomainV1Schema,
    position: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    phase: ProjectEnvironmentRuntimePhaseV1Schema,
  },
  strictObject,
);
export type ProjectEnvironmentRequestedPointV1 = Static<
  typeof ProjectEnvironmentRequestedPointV1Schema
>;

export const ProjectEnvironmentCaptureProfileV1Schema = Type.Object(
  {
    channels: Type.Array(stableName("Adapter or Harness capture channel ID"), {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
      description:
        'PE-A accepts a nonempty subset of "entity", "state", "event", and "runtime_error"; use those four channels for complete project observation.',
    }),
    retention: Type.Object(
      {
        clockDomain: ProjectEnvironmentClockDomainV1Schema,
        before: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
        after: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
      },
      {
        ...strictObject,
        description:
          'PE-A requires exactly {"clockDomain":"process_frame","before":0,"after":0}.',
      },
    ),
    sampling: Type.Array(
      Type.Object(
        {
          channelId: stableName("Capture channel ID"),
          every: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
        },
        strictObject,
      ),
      {
        maxItems: 32,
        description: "PE-A requires an empty sampling array.",
      },
    ),
    triggers: Type.Array(
      Type.Object(
        {
          triggerId: stableName("Capture trigger ID"),
          kind: Type.Union(
            [
              "runtime_error",
              "declared_event",
              "state_predicate",
              "resource_threshold",
            ].map((value) => Type.Literal(value)),
          ),
          referenceId: stableName(
            "Declared event, state predicate, or resource ID",
          ),
        },
        strictObject,
      ),
      {
        maxItems: 32,
        description: "PE-A requires an empty triggers array.",
      },
    ),
  },
  {
    ...strictObject,
    description:
      'PE-A supported profile: channels ["entity","state","event","runtime_error"], process_frame retention with before=0 and after=0, sampling=[], triggers=[]. Use game_capture_pin to retain the current batch.',
  },
);
export type ProjectEnvironmentCaptureProfileV1 = Static<
  typeof ProjectEnvironmentCaptureProfileV1Schema
>;

export const ProjectEnvironmentGameCapabilitiesInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: Type.Optional(ProjectEnvironmentGameRuntimeIdV1Schema),
  },
  strictObject,
);
export type ProjectEnvironmentGameCapabilitiesInputV1 = Static<
  typeof ProjectEnvironmentGameCapabilitiesInputV1Schema
>;

export const ProjectEnvironmentGameLaunchInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    buildId: ProjectEnvironmentGameBuildIdV1Schema,
    launchTargetId: stableName("Adapter-declared launch target ID"),
    parameters: Type.Optional(ProjectEnvironmentParameterMapV1Schema),
  },
  strictObject,
);
export type ProjectEnvironmentGameLaunchInputV1 = Static<
  typeof ProjectEnvironmentGameLaunchInputV1Schema
>;

export const ProjectEnvironmentGameStatusInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
  },
  strictObject,
);
export type ProjectEnvironmentGameStatusInputV1 = Static<
  typeof ProjectEnvironmentGameStatusInputV1Schema
>;

export const ProjectEnvironmentGameStopInputV1Schema =
  ProjectEnvironmentGameStatusInputV1Schema;
export type ProjectEnvironmentGameStopInputV1 =
  ProjectEnvironmentGameStatusInputV1;

export const ProjectEnvironmentGameCaptureConfigureInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    profile: ProjectEnvironmentCaptureProfileV1Schema,
  },
  strictObject,
);
export type ProjectEnvironmentGameCaptureConfigureInputV1 = Static<
  typeof ProjectEnvironmentGameCaptureConfigureInputV1Schema
>;

export const ProjectEnvironmentCaptureAnchorV1Schema = Type.Union([
  Type.Object({ kind: Type.Literal("now") }, strictObject),
  Type.Object(
    {
      kind: Type.Literal("event"),
      eventId: ProjectEnvironmentGameEventIdV1Schema,
    },
    strictObject,
  ),
  Type.Object(
    {
      kind: Type.Literal("clock"),
      point: ProjectEnvironmentRequestedPointV1Schema,
    },
    strictObject,
  ),
]);

export const ProjectEnvironmentGameCapturePinInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    anchor: ProjectEnvironmentCaptureAnchorV1Schema,
    before: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    after: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  },
  strictObject,
);
export type ProjectEnvironmentGameCapturePinInputV1 = Static<
  typeof ProjectEnvironmentGameCapturePinInputV1Schema
>;

export const ProjectEnvironmentGameQueryInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    executionId: ProjectEnvironmentGameExecutionIdV1Schema,
    select: Type.Union(
      [
        "events",
        "entities",
        "state",
        "clocks",
        "coverage",
        "runtime_errors",
      ].map((value) => Type.Literal(value)),
    ),
    filters: Type.Optional(
      Type.Object(
        {
          entityIds: Type.Optional(
            Type.Array(ProjectEnvironmentGameEntityIdV1Schema, {
              maxItems: 64,
              uniqueItems: true,
            }),
          ),
          typeIds: Type.Optional(
            Type.Array(stableName("Declared entity, event, or state type ID"), {
              maxItems: 64,
              uniqueItems: true,
            }),
          ),
          domainIds: Type.Optional(
            Type.Array(stableName("Declared state domain ID"), {
              maxItems: 64,
              uniqueItems: true,
            }),
          ),
          range: Type.Optional(
            Type.Object(
              {
                clockDomain: ProjectEnvironmentClockDomainV1Schema,
                from: Type.Integer({
                  minimum: 0,
                  maximum: Number.MAX_SAFE_INTEGER,
                }),
                through: Type.Integer({
                  minimum: 0,
                  maximum: Number.MAX_SAFE_INTEGER,
                }),
              },
              strictObject,
            ),
          ),
        },
        nonEmptyStrictObject,
      ),
    ),
    limit: Type.Integer({ minimum: 1, maximum: 200 }),
    cursor: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 256,
        pattern: "^[A-Za-z0-9._:-]+$",
      }),
    ),
  },
  strictObject,
);
export type ProjectEnvironmentGameQueryInputV1 = Static<
  typeof ProjectEnvironmentGameQueryInputV1Schema
>;

export const ProjectEnvironmentGameInputInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    controlId: stableName("Adapter-declared control ID"),
    parameters: Type.Optional(ProjectEnvironmentParameterMapV1Schema),
    targetEntityId: Type.Optional(ProjectEnvironmentGameEntityIdV1Schema),
    requested: ProjectEnvironmentRequestedPointV1Schema,
  },
  strictObject,
);
export type ProjectEnvironmentGameInputInputV1 = Static<
  typeof ProjectEnvironmentGameInputInputV1Schema
>;

export const ProjectEnvironmentStepRequestV1Schema = Type.Union([
  Type.Object(
    {
      clockDomain: Type.Literal("process_frame"),
      count: Type.Integer({ minimum: 1, maximum: 600 }),
    },
    strictObject,
  ),
  Type.Object(
    {
      clockDomain: Type.Literal("physics_tick"),
      count: Type.Integer({ minimum: 1, maximum: 600 }),
    },
    strictObject,
  ),
  Type.Object(
    {
      clockDomain: Type.Literal("simulation_time"),
      durationUs: Type.Integer({ minimum: 1, maximum: 60_000_000 }),
    },
    strictObject,
  ),
]);

export const ProjectEnvironmentGameStepInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    requested: ProjectEnvironmentStepRequestV1Schema,
    barrierId: Type.Optional(
      stableName("Standard or adapter-declared barrier ID"),
    ),
  },
  strictObject,
);
export type ProjectEnvironmentGameStepInputV1 = Static<
  typeof ProjectEnvironmentGameStepInputV1Schema
>;

export const ProjectEnvironmentControlSettingV1Schema = Type.Object(
  {
    controlId: stableName("Adapter-declared runtime control ID"),
    value: ProjectEnvironmentCanonicalAdapterValueV1Schema,
  },
  strictObject,
);

export const ProjectEnvironmentGameSetControlsInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    controls: Type.Array(ProjectEnvironmentControlSettingV1Schema, {
      minItems: 1,
      maxItems: 64,
    }),
  },
  strictObject,
);
export type ProjectEnvironmentGameSetControlsInputV1 = Static<
  typeof ProjectEnvironmentGameSetControlsInputV1Schema
>;

export const ProjectEnvironmentGameCheckpointCreateInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    barrierId: stableName("Standard or adapter-declared barrier ID"),
    domainIds: Type.Optional(
      Type.Array(stableName("Adapter-declared state domain ID"), {
        minItems: 1,
        maxItems: 256,
        uniqueItems: true,
      }),
    ),
  },
  strictObject,
);
export type ProjectEnvironmentGameCheckpointCreateInputV1 = Static<
  typeof ProjectEnvironmentGameCheckpointCreateInputV1Schema
>;

export const ProjectEnvironmentGameCheckpointRestoreInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    checkpointId: ProjectEnvironmentGameCheckpointIdV1Schema,
  },
  strictObject,
);
export type ProjectEnvironmentGameCheckpointRestoreInputV1 = Static<
  typeof ProjectEnvironmentGameCheckpointRestoreInputV1Schema
>;

export const ProjectEnvironmentForkSourceV1Schema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("build"),
      buildId: ProjectEnvironmentGameBuildIdV1Schema,
    },
    strictObject,
  ),
  Type.Object(
    {
      kind: Type.Literal("workspace"),
      workspaceId: ProjectEnvironmentGameWorkspaceIdV1Schema,
    },
    strictObject,
  ),
  Type.Object(
    {
      kind: Type.Literal("execution"),
      executionId: ProjectEnvironmentGameExecutionIdV1Schema,
    },
    strictObject,
  ),
  Type.Object(
    {
      kind: Type.Literal("checkpoint"),
      checkpointId: ProjectEnvironmentGameCheckpointIdV1Schema,
    },
    strictObject,
  ),
]);

export const ProjectEnvironmentForkChangesV1Schema = Type.Object(
  {
    buildId: Type.Optional(ProjectEnvironmentGameBuildIdV1Schema),
    traceId: Type.Optional(ProjectEnvironmentGameTraceIdV1Schema),
    seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 4_294_967_295 })),
    controls: Type.Optional(
      Type.Array(ProjectEnvironmentControlSettingV1Schema, {
        minItems: 1,
        maxItems: 64,
      }),
    ),
    capture: Type.Optional(ProjectEnvironmentCaptureProfileV1Schema),
  },
  nonEmptyStrictObject,
);

export const ProjectEnvironmentGameForkInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    source: ProjectEnvironmentForkSourceV1Schema,
    changes: ProjectEnvironmentForkChangesV1Schema,
  },
  strictObject,
);
export type ProjectEnvironmentGameForkInputV1 = Static<
  typeof ProjectEnvironmentGameForkInputV1Schema
>;

export const ProjectEnvironmentTraceControlV1Schema = Type.Object(
  {
    controlId: stableName("Adapter-declared control ID"),
    parameters: Type.Optional(ProjectEnvironmentParameterMapV1Schema),
    targetEntityId: Type.Optional(ProjectEnvironmentGameEntityIdV1Schema),
    requested: ProjectEnvironmentRequestedPointV1Schema,
  },
  strictObject,
);

export const ProjectEnvironmentGameTraceCreateInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    source: Type.Optional(
      Type.Union([
        Type.Object(
          {
            kind: Type.Literal("runtime"),
            runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
          },
          strictObject,
        ),
        Type.Object(
          {
            kind: Type.Literal("execution"),
            executionId: ProjectEnvironmentGameExecutionIdV1Schema,
          },
          strictObject,
        ),
      ]),
    ),
    controls: Type.Array(ProjectEnvironmentTraceControlV1Schema, {
      minItems: 1,
      maxItems: 128,
    }),
  },
  strictObject,
);
export type ProjectEnvironmentGameTraceCreateInputV1 = Static<
  typeof ProjectEnvironmentGameTraceCreateInputV1Schema
>;

export const ProjectEnvironmentGameTraceReplayInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    traceId: ProjectEnvironmentGameTraceIdV1Schema,
    maximumProgress: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    clockDomain: ProjectEnvironmentClockDomainV1Schema,
  },
  strictObject,
);
export type ProjectEnvironmentGameTraceReplayInputV1 = Static<
  typeof ProjectEnvironmentGameTraceReplayInputV1Schema
>;

export const ProjectEnvironmentGameCompareInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    baselineExecutionId: ProjectEnvironmentGameExecutionIdV1Schema,
    candidateExecutionId: ProjectEnvironmentGameExecutionIdV1Schema,
    alignmentId: Type.Optional(ProjectEnvironmentGameAlignmentIdV1Schema),
    maxDifferences: Type.Integer({ minimum: 1, maximum: 200 }),
  },
  strictObject,
);
export type ProjectEnvironmentGameCompareInputV1 = Static<
  typeof ProjectEnvironmentGameCompareInputV1Schema
>;

export const PROJECT_ENVIRONMENT_GAME_INPUT_SCHEMAS_V1 = Object.freeze({
  game_capabilities: ProjectEnvironmentGameCapabilitiesInputV1Schema,
  game_launch: ProjectEnvironmentGameLaunchInputV1Schema,
  game_status: ProjectEnvironmentGameStatusInputV1Schema,
  game_stop: ProjectEnvironmentGameStopInputV1Schema,
  game_capture_configure: ProjectEnvironmentGameCaptureConfigureInputV1Schema,
  game_capture_pin: ProjectEnvironmentGameCapturePinInputV1Schema,
  game_query: ProjectEnvironmentGameQueryInputV1Schema,
  game_input: ProjectEnvironmentGameInputInputV1Schema,
  game_step: ProjectEnvironmentGameStepInputV1Schema,
  game_set_controls: ProjectEnvironmentGameSetControlsInputV1Schema,
  game_checkpoint_create: ProjectEnvironmentGameCheckpointCreateInputV1Schema,
  game_checkpoint_restore: ProjectEnvironmentGameCheckpointRestoreInputV1Schema,
  game_fork: ProjectEnvironmentGameForkInputV1Schema,
  game_trace_create: ProjectEnvironmentGameTraceCreateInputV1Schema,
  game_trace_replay: ProjectEnvironmentGameTraceReplayInputV1Schema,
  game_compare: ProjectEnvironmentGameCompareInputV1Schema,
} satisfies Record<string, TSchema>);

const canonical = (value: unknown): boolean =>
  CanonicalAdapterValueV1Schema.safeParse(value).success;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const canonicalField = (
  value: unknown,
  key: string,
  optional = false,
): boolean => {
  const record = asRecord(value);
  if (record === null) return false;
  return optional && record[key] === undefined ? true : canonical(record[key]);
};

const canonicalArrayField = (
  value: unknown,
  arrayKey: string,
  valueKey: string,
  optional = false,
): boolean => {
  const record = asRecord(value);
  if (record === null) return false;
  const entries = record[arrayKey];
  if (optional && entries === undefined) return true;
  return (
    Array.isArray(entries) &&
    entries.every((entry) => canonicalField(entry, valueKey))
  );
};

const canonicalInputFieldsAreValid = (
  toolName: keyof typeof PROJECT_ENVIRONMENT_GAME_INPUT_SCHEMAS_V1,
  input: unknown,
): boolean => {
  switch (toolName) {
    case "game_launch":
    case "game_input":
      return canonicalField(input, "parameters", true);
    case "game_set_controls":
      return canonicalArrayField(input, "controls", "value");
    case "game_fork": {
      const record = asRecord(input);
      return (
        record !== null &&
        canonicalArrayField(record.changes, "controls", "value", true)
      );
    }
    case "game_trace_create": {
      const record = asRecord(input);
      if (record === null || !Array.isArray(record.controls)) return false;
      return record.controls.every((control) =>
        canonicalField(control, "parameters", true),
      );
    }
    case "game_capabilities":
    case "game_status":
    case "game_stop":
    case "game_capture_configure":
    case "game_capture_pin":
    case "game_query":
    case "game_step":
    case "game_checkpoint_create":
    case "game_checkpoint_restore":
    case "game_trace_replay":
    case "game_compare":
      return true;
  }
};

/** Strict metadata validation with a second domain pass over canonical values. */
export const validateProjectEnvironmentGameInputShapeV1 = (
  toolName: keyof typeof PROJECT_ENVIRONMENT_GAME_INPUT_SCHEMAS_V1,
  input: unknown,
): boolean =>
  canonicalInputFieldsAreValid(toolName, input) &&
  Check(PROJECT_ENVIRONMENT_GAME_INPUT_SCHEMAS_V1[toolName], input);
