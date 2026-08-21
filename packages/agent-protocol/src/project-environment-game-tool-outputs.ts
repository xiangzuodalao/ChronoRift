import { CanonicalAdapterValueV1Schema } from "@chronorift/domain";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

import {
  ProjectEnvironmentCanonicalAdapterValueV1Schema,
  ProjectEnvironmentClockDomainV1Schema,
  ProjectEnvironmentControlSettingV1Schema,
  ProjectEnvironmentGameBuildIdV1Schema,
  ProjectEnvironmentGameCaptureWindowIdV1Schema,
  ProjectEnvironmentGameCheckpointIdV1Schema,
  ProjectEnvironmentGameEntityIdV1Schema,
  ProjectEnvironmentGameEventIdV1Schema,
  ProjectEnvironmentGameExecutionIdV1Schema,
  ProjectEnvironmentGameRuntimeIdV1Schema,
  ProjectEnvironmentGameTaskIdV1Schema,
  ProjectEnvironmentGameTraceIdV1Schema,
  ProjectEnvironmentParameterMapV1Schema,
  ProjectEnvironmentRequestedPointV1Schema,
  ProjectEnvironmentRuntimePhaseV1Schema,
  ProjectEnvironmentStepRequestV1Schema,
} from "./project-environment-game-tool-inputs.js";
import {
  PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1,
  type ProjectEnvironmentGameToolNameV1,
} from "./project-environment-game-tools.js";

const strictObject = { additionalProperties: false } as const;
const boundedText = Type.String({ minLength: 1, maxLength: 4_096 });
const limitations = Type.Array(boundedText, { maxItems: 256 });
const opaqueId = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$",
});
const stableId = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z][A-Za-z0-9_.:-]{0,127}$",
});
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const timestamp = Type.String({ minLength: 20, maxLength: 64 });

export const ProjectEnvironmentCapabilityModuleNameOutputV1Schema = Type.Union(
  [
    "lifecycle",
    "clock",
    "runtime_error",
    "entity_projection",
    "state_projection",
    "event_projection",
    "capture",
    "input_control",
    "snapshot",
    "restore",
    "render_capture",
    "alignment",
  ].map((value) => Type.Literal(value)),
);
export type ProjectEnvironmentCapabilityModuleNameOutputV1 = Static<
  typeof ProjectEnvironmentCapabilityModuleNameOutputV1Schema
>;

export const ProjectEnvironmentCapabilityStatusOutputV1Schema = Type.Union(
  [
    "implemented",
    "unsupported",
    "unavailable_by_policy",
    "unavailable_by_environment",
    "degraded",
  ].map((value) => Type.Literal(value)),
);

export const ProjectEnvironmentCapabilityStateOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    module: ProjectEnvironmentCapabilityModuleNameOutputV1Schema,
    status: ProjectEnvironmentCapabilityStatusOutputV1Schema,
    protocolVersion: Type.Union([Type.Null(), opaqueId]),
    limitations,
  },
  strictObject,
);
export type ProjectEnvironmentCapabilityStateOutputV1 = Static<
  typeof ProjectEnvironmentCapabilityStateOutputV1Schema
>;

export const ProjectEnvironmentClockPositionOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    processFrame: Type.Integer({ minimum: 0 }),
    physicsTick: Type.Integer({ minimum: 0 }),
    simulationTimeUs: Type.Integer({ minimum: 0 }),
    renderFrame: Type.Union([Type.Null(), Type.Integer({ minimum: 0 })]),
    hostMonotonicUs: Type.Integer({ minimum: 0 }),
  },
  strictObject,
);
export type ProjectEnvironmentClockPositionOutputV1 = Static<
  typeof ProjectEnvironmentClockPositionOutputV1Schema
>;

export const ProjectEnvironmentCoverageOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    channelId: stableId,
    status: Type.Union(
      ["complete", "sampled", "incomplete", "unavailable"].map((value) =>
        Type.Literal(value),
      ),
    ),
    observedRecords: Type.Integer({ minimum: 0 }),
    droppedRecords: Type.Integer({ minimum: 0 }),
    overwrittenRecords: Type.Integer({ minimum: 0 }),
    limitations,
  },
  strictObject,
);

export const ProjectEnvironmentLossOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    channelId: stableId,
    kind: Type.Union(
      [
        "sampled",
        "dropped",
        "overwritten",
        "unavailable",
        "observer_effect",
      ].map((value) => Type.Literal(value)),
    ),
    count: Type.Integer({ minimum: 0 }),
    reason: boundedText,
  },
  strictObject,
);

export const ProjectEnvironmentStateDomainOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    domainId: stableId,
    disposition: Type.Union(
      [
        "captured",
        "reset",
        "externally_controlled",
        "unsupported",
        "uncontrolled",
      ].map((value) => Type.Literal(value)),
    ),
    schemaDigest: Type.Union([Type.Null(), sha256]),
    limitations,
  },
  strictObject,
);

export const ProjectEnvironmentCleanupOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    processTreeTerminated: Type.Boolean(),
    runtimeExited: Type.Boolean(),
    bridgeExited: Type.Boolean(),
    isolationGroupEmpty: Type.Boolean(),
    scopeRemoved: Type.Boolean(),
    scratchRemoved: Type.Boolean(),
    storageReconciled: Type.Boolean(),
  },
  strictObject,
);

const capabilities = Type.Array(
  ProjectEnvironmentCapabilityStateOutputV1Schema,
  {
    minItems: 12,
    maxItems: 12,
  },
);
const coverage = Type.Array(ProjectEnvironmentCoverageOutputV1Schema, {
  maxItems: 256,
});
const loss = Type.Array(ProjectEnvironmentLossOutputV1Schema, {
  maxItems: 2_000,
});

export const ProjectEnvironmentToolAvailabilityOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    toolName: Type.Union(
      Object.values(PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1).map((value) =>
        Type.Literal(value),
      ),
    ),
    module: Type.Union([
      Type.Null(),
      ProjectEnvironmentCapabilityModuleNameOutputV1Schema,
    ]),
    status: Type.Union(
      [
        "available",
        "unsupported_capability",
        "unavailable_by_policy",
        "unavailable_by_environment",
      ].map((value) => Type.Literal(value)),
    ),
    limitations,
  },
  strictObject,
);

export const ProjectEnvironmentLaunchTargetOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    targetId: stableId,
    scene: Type.String({ minLength: 7, maxLength: 1_024 }),
    default: Type.Boolean(),
    validationStatus: Type.Union([
      Type.Literal("validated"),
      Type.Literal("declared_unvalidated"),
    ]),
  },
  strictObject,
);

export const ProjectEnvironmentGameCapabilitiesOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    environmentRevisionId: opaqueId,
    adapterRevisionId: opaqueId,
    buildId: Type.Union([Type.Null(), ProjectEnvironmentGameBuildIdV1Schema]),
    runtimeId: Type.Union([
      Type.Null(),
      ProjectEnvironmentGameRuntimeIdV1Schema,
    ]),
    modules: capabilities,
    launchTargets: Type.Optional(
      Type.Array(ProjectEnvironmentLaunchTargetOutputV1Schema, {
        minItems: 1,
        maxItems: 32,
      }),
    ),
    tools: Type.Array(ProjectEnvironmentToolAvailabilityOutputV1Schema, {
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
    }),
    limitations,
  },
  strictObject,
);
export type ProjectEnvironmentGameCapabilitiesOutputV1 = Static<
  typeof ProjectEnvironmentGameCapabilitiesOutputV1Schema
>;

export const ProjectEnvironmentGameLaunchOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    executionId: ProjectEnvironmentGameExecutionIdV1Schema,
    buildId: ProjectEnvironmentGameBuildIdV1Schema,
    environmentRevisionId: opaqueId,
    adapterRevisionId: opaqueId,
    launchReceiptId: opaqueId,
    requested: Type.Object(
      {
        launchTargetId: stableId,
        parameters: ProjectEnvironmentParameterMapV1Schema,
      },
      strictObject,
    ),
    realized: Type.Object(
      {
        launchTargetId: stableId,
        parameters: ProjectEnvironmentParameterMapV1Schema,
        renderer: stableId,
        clock: ProjectEnvironmentClockPositionOutputV1Schema,
      },
      strictObject,
    ),
    status: Type.Union([Type.Literal("running"), Type.Literal("degraded")]),
    modules: capabilities,
    limitations,
  },
  strictObject,
);
export type ProjectEnvironmentGameLaunchOutputV1 = Static<
  typeof ProjectEnvironmentGameLaunchOutputV1Schema
>;

export const ProjectEnvironmentGameStatusOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    executionId: ProjectEnvironmentGameExecutionIdV1Schema,
    buildId: ProjectEnvironmentGameBuildIdV1Schema,
    status: Type.Union(
      [
        "starting",
        "running",
        "stopping",
        "stopped",
        "crashed",
        "timed_out",
      ].map((value) => Type.Literal(value)),
    ),
    clock: ProjectEnvironmentClockPositionOutputV1Schema,
    modules: capabilities,
    coverage,
    loss,
    limitations,
  },
  strictObject,
);
export type ProjectEnvironmentGameStatusOutputV1 = Static<
  typeof ProjectEnvironmentGameStatusOutputV1Schema
>;

export const ProjectEnvironmentGameStopOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    executionId: ProjectEnvironmentGameExecutionIdV1Schema,
    status: Type.Literal("stopped"),
    cleanup: ProjectEnvironmentCleanupOutputV1Schema,
    coverage,
    loss,
    limitations,
  },
  strictObject,
);
export type ProjectEnvironmentGameStopOutputV1 = Static<
  typeof ProjectEnvironmentGameStopOutputV1Schema
>;

export const ProjectEnvironmentGameCaptureConfigureOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    captureProfileId: opaqueId,
    status: Type.Union([Type.Literal("configured"), Type.Literal("degraded")]),
    realized: ProjectEnvironmentCanonicalAdapterValueV1Schema,
    coverage,
    loss,
    limitations,
  },
  strictObject,
);
export type ProjectEnvironmentGameCaptureConfigureOutputV1 = Static<
  typeof ProjectEnvironmentGameCaptureConfigureOutputV1Schema
>;

export const ProjectEnvironmentGameCapturePinOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    captureWindowId: ProjectEnvironmentGameCaptureWindowIdV1Schema,
    anchor: Type.Object(
      {
        requested: ProjectEnvironmentCanonicalAdapterValueV1Schema,
        realized: ProjectEnvironmentClockPositionOutputV1Schema,
        quantized: Type.Boolean(),
      },
      strictObject,
    ),
    coverage,
    loss,
    limitations,
  },
  strictObject,
);
export type ProjectEnvironmentGameCapturePinOutputV1 = Static<
  typeof ProjectEnvironmentGameCapturePinOutputV1Schema
>;

export const ProjectEnvironmentQueryRowOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    rowId: opaqueId,
    kind: Type.Union(
      ["event", "entity", "state", "clock", "coverage", "runtime_error"].map(
        (value) => Type.Literal(value),
      ),
    ),
    clock: Type.Union([
      Type.Null(),
      ProjectEnvironmentClockPositionOutputV1Schema,
    ]),
    value: ProjectEnvironmentCanonicalAdapterValueV1Schema,
  },
  strictObject,
);

export const ProjectEnvironmentGameQueryOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    executionId: ProjectEnvironmentGameExecutionIdV1Schema,
    rows: Type.Array(ProjectEnvironmentQueryRowOutputV1Schema, {
      maxItems: 200,
    }),
    nextCursor: Type.Union([Type.Null(), opaqueId]),
    coverage,
    loss,
    limitations,
  },
  strictObject,
);
export type ProjectEnvironmentGameQueryOutputV1 = Static<
  typeof ProjectEnvironmentGameQueryOutputV1Schema
>;

export const ProjectEnvironmentGameInputOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    controlReceiptId: opaqueId,
    controlId: stableId,
    requested: Type.Object(
      {
        point: ProjectEnvironmentRequestedPointV1Schema,
        parameters: ProjectEnvironmentParameterMapV1Schema,
      },
      strictObject,
    ),
    realized: Type.Object(
      {
        accepted: Type.Boolean(),
        clock: ProjectEnvironmentClockPositionOutputV1Schema,
        phase: ProjectEnvironmentRuntimePhaseV1Schema,
        quantized: Type.Boolean(),
        sideEffects: limitations,
      },
      strictObject,
    ),
    limitations,
  },
  strictObject,
);
export type ProjectEnvironmentGameInputOutputV1 = Static<
  typeof ProjectEnvironmentGameInputOutputV1Schema
>;

export const ProjectEnvironmentGameStepOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    requested: ProjectEnvironmentStepRequestV1Schema,
    before: ProjectEnvironmentClockPositionOutputV1Schema,
    after: ProjectEnvironmentClockPositionOutputV1Schema,
    realizedCount: Type.Integer({ minimum: 0 }),
    realizedDurationUs: Type.Integer({ minimum: 0 }),
    quantized: Type.Boolean(),
    coverage,
    loss,
    limitations,
  },
  strictObject,
);
export type ProjectEnvironmentGameStepOutputV1 = Static<
  typeof ProjectEnvironmentGameStepOutputV1Schema
>;

export const ProjectEnvironmentRealizedControlOutputV1Schema = Type.Object(
  {
    controlId: stableId,
    requested: ProjectEnvironmentCanonicalAdapterValueV1Schema,
    realized: ProjectEnvironmentCanonicalAdapterValueV1Schema,
    status: Type.Union(
      ["applied", "quantized", "rejected", "unavailable"].map((value) =>
        Type.Literal(value),
      ),
    ),
    reason: Type.Union([Type.Null(), boundedText]),
    sideEffects: limitations,
  },
  strictObject,
);

export const ProjectEnvironmentGameSetControlsOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    requested: Type.Array(ProjectEnvironmentControlSettingV1Schema, {
      minItems: 1,
      maxItems: 64,
    }),
    realized: Type.Array(ProjectEnvironmentRealizedControlOutputV1Schema, {
      minItems: 1,
      maxItems: 64,
    }),
    clock: ProjectEnvironmentClockPositionOutputV1Schema,
    limitations,
  },
  strictObject,
);
export type ProjectEnvironmentGameSetControlsOutputV1 = Static<
  typeof ProjectEnvironmentGameSetControlsOutputV1Schema
>;

export const ProjectEnvironmentGameCheckpointCreateOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    checkpointId: ProjectEnvironmentGameCheckpointIdV1Schema,
    requestedBarrierId: stableId,
    realizedBarrierId: Type.Union([Type.Null(), stableId]),
    clock: ProjectEnvironmentClockPositionOutputV1Schema,
    domains: Type.Array(ProjectEnvironmentStateDomainOutputV1Schema, {
      maxItems: 256,
    }),
    contentDigest: sha256,
    coverage,
    limitations,
  },
  strictObject,
);
export type ProjectEnvironmentGameCheckpointCreateOutputV1 = Static<
  typeof ProjectEnvironmentGameCheckpointCreateOutputV1Schema
>;

export const ProjectEnvironmentRestoreDomainOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    domainId: stableId,
    requested: Type.Boolean(),
    reportedWritten: Type.Boolean(),
    readBackMatched: Type.Union([Type.Null(), Type.Boolean()]),
    status: Type.Union(
      ["written", "failed", "missing", "unsupported", "uncontrolled"].map(
        (value) => Type.Literal(value),
      ),
    ),
    sideEffects: limitations,
    limitations,
  },
  strictObject,
);

export const ProjectEnvironmentGameCheckpointRestoreOutputV1Schema =
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      taskId: ProjectEnvironmentGameTaskIdV1Schema,
      runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
      checkpointId: ProjectEnvironmentGameCheckpointIdV1Schema,
      restoreReceiptId: opaqueId,
      status: Type.Union(
        ["restored", "partial", "failed"].map((value) => Type.Literal(value)),
      ),
      domains: Type.Array(ProjectEnvironmentRestoreDomainOutputV1Schema, {
        maxItems: 256,
      }),
      clock: ProjectEnvironmentClockPositionOutputV1Schema,
      firstDivergence: Type.Union([
        Type.Null(),
        Type.Object(
          {
            domainId: stableId,
            description: boundedText,
            clock: Type.Union([
              Type.Null(),
              ProjectEnvironmentClockPositionOutputV1Schema,
            ]),
          },
          strictObject,
        ),
      ]),
      limitations,
    },
    strictObject,
  );
export type ProjectEnvironmentGameCheckpointRestoreOutputV1 = Static<
  typeof ProjectEnvironmentGameCheckpointRestoreOutputV1Schema
>;

export const ProjectEnvironmentGameForkOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    branchId: opaqueId,
    workspaceId: opaqueId,
    buildId: ProjectEnvironmentGameBuildIdV1Schema,
    runtimeId: Type.Union([
      Type.Null(),
      ProjectEnvironmentGameRuntimeIdV1Schema,
    ]),
    executionId: Type.Union([
      Type.Null(),
      ProjectEnvironmentGameExecutionIdV1Schema,
    ]),
    requestedChanges: ProjectEnvironmentCanonicalAdapterValueV1Schema,
    realizedChanges: ProjectEnvironmentCanonicalAdapterValueV1Schema,
    confounders: limitations,
    limitations,
  },
  strictObject,
);
export type ProjectEnvironmentGameForkOutputV1 = Static<
  typeof ProjectEnvironmentGameForkOutputV1Schema
>;

export const ProjectEnvironmentGameTraceCreateOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    traceId: ProjectEnvironmentGameTraceIdV1Schema,
    controlCount: Type.Integer({ minimum: 1, maximum: 128 }),
    contentDigest: sha256,
    normalizedControls: Type.Array(
      Type.Object(
        {
          controlId: stableId,
          requested: ProjectEnvironmentRequestedPointV1Schema,
          parameters: ProjectEnvironmentParameterMapV1Schema,
        },
        strictObject,
      ),
      { minItems: 1, maxItems: 128 },
    ),
    limitations,
  },
  strictObject,
);
export type ProjectEnvironmentGameTraceCreateOutputV1 = Static<
  typeof ProjectEnvironmentGameTraceCreateOutputV1Schema
>;

export const ProjectEnvironmentGameTraceReplayOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    traceId: ProjectEnvironmentGameTraceIdV1Schema,
    runtimeId: ProjectEnvironmentGameRuntimeIdV1Schema,
    executionId: ProjectEnvironmentGameExecutionIdV1Schema,
    status: Type.Union(
      ["completed", "diverged", "incompatible", "timed_out"].map((value) =>
        Type.Literal(value),
      ),
    ),
    firstDivergence: Type.Union([
      Type.Null(),
      Type.Object(
        {
          sequence: Type.Integer({ minimum: 0 }),
          requested: ProjectEnvironmentRequestedPointV1Schema,
          realized: ProjectEnvironmentClockPositionOutputV1Schema,
          description: boundedText,
        },
        strictObject,
      ),
    ]),
    coverage,
    loss,
    limitations,
  },
  strictObject,
);
export type ProjectEnvironmentGameTraceReplayOutputV1 = Static<
  typeof ProjectEnvironmentGameTraceReplayOutputV1Schema
>;

export const ProjectEnvironmentDifferenceOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    category: stableId,
    subjectId: opaqueId,
    baseline: ProjectEnvironmentCanonicalAdapterValueV1Schema,
    candidate: ProjectEnvironmentCanonicalAdapterValueV1Schema,
    observability: Type.Union(
      ["complete", "partial", "unavailable"].map((value) =>
        Type.Literal(value),
      ),
    ),
    clock: Type.Union([
      Type.Null(),
      ProjectEnvironmentClockPositionOutputV1Schema,
    ]),
    limitations,
  },
  strictObject,
);

export const ProjectEnvironmentGameCompareOutputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: ProjectEnvironmentGameTaskIdV1Schema,
    comparisonId: opaqueId,
    baselineExecutionId: ProjectEnvironmentGameExecutionIdV1Schema,
    candidateExecutionId: ProjectEnvironmentGameExecutionIdV1Schema,
    status: Type.Union(
      [
        "aligned",
        "partial",
        "incompatible",
        "descriptive_only",
        "confounded",
      ].map((value) => Type.Literal(value)),
    ),
    differences: Type.Array(ProjectEnvironmentDifferenceOutputV1Schema, {
      maxItems: 200,
    }),
    coverage,
    confounders: limitations,
    limitations,
    createdAt: timestamp,
  },
  strictObject,
);
export type ProjectEnvironmentGameCompareOutputV1 = Static<
  typeof ProjectEnvironmentGameCompareOutputV1Schema
>;

export const PROJECT_ENVIRONMENT_GAME_TOOL_OUTPUT_SCHEMAS_V1 = Object.freeze({
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.capabilities]:
    ProjectEnvironmentGameCapabilitiesOutputV1Schema,
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.launch]:
    ProjectEnvironmentGameLaunchOutputV1Schema,
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.status]:
    ProjectEnvironmentGameStatusOutputV1Schema,
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.stop]:
    ProjectEnvironmentGameStopOutputV1Schema,
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.captureConfigure]:
    ProjectEnvironmentGameCaptureConfigureOutputV1Schema,
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.capturePin]:
    ProjectEnvironmentGameCapturePinOutputV1Schema,
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.query]:
    ProjectEnvironmentGameQueryOutputV1Schema,
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.input]:
    ProjectEnvironmentGameInputOutputV1Schema,
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.step]:
    ProjectEnvironmentGameStepOutputV1Schema,
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.setControls]:
    ProjectEnvironmentGameSetControlsOutputV1Schema,
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.checkpointCreate]:
    ProjectEnvironmentGameCheckpointCreateOutputV1Schema,
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.checkpointRestore]:
    ProjectEnvironmentGameCheckpointRestoreOutputV1Schema,
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.fork]:
    ProjectEnvironmentGameForkOutputV1Schema,
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.traceCreate]:
    ProjectEnvironmentGameTraceCreateOutputV1Schema,
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.traceReplay]:
    ProjectEnvironmentGameTraceReplayOutputV1Schema,
  [PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.compare]:
    ProjectEnvironmentGameCompareOutputV1Schema,
} satisfies Record<ProjectEnvironmentGameToolNameV1, TSchema>);

const canonical = (value: unknown): boolean =>
  CanonicalAdapterValueV1Schema.safeParse(value).success;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const canonicalField = (value: unknown, key: string): boolean => {
  const record = asRecord(value);
  return record !== null && canonical(record[key]);
};

const canonicalOutputFieldsAreValid = (
  toolName: ProjectEnvironmentGameToolNameV1,
  output: unknown,
): boolean => {
  const record = asRecord(output);
  if (record === null) return false;
  switch (toolName) {
    case "game_capabilities": {
      if (!Array.isArray(record.tools)) return false;
      const names = new Set<unknown>();
      for (const value of record.tools) {
        const tool = asRecord(value);
        if (tool === null || names.has(tool.toolName)) return false;
        names.add(tool.toolName);
      }
      return true;
    }
    case "game_launch":
      return (
        canonicalField(record.requested, "parameters") &&
        canonicalField(record.realized, "parameters")
      );
    case "game_capture_configure":
      return canonical(record.realized);
    case "game_capture_pin":
      return canonicalField(record.anchor, "requested");
    case "game_query":
      return (
        Array.isArray(record.rows) &&
        record.rows.every((row) => canonicalField(row, "value"))
      );
    case "game_input":
      return canonicalField(record.requested, "parameters");
    case "game_set_controls":
      return (
        Array.isArray(record.requested) &&
        record.requested.every((entry) => canonicalField(entry, "value")) &&
        Array.isArray(record.realized) &&
        record.realized.every(
          (entry) =>
            canonicalField(entry, "requested") &&
            canonicalField(entry, "realized"),
        )
      );
    case "game_fork":
      return (
        canonical(record.requestedChanges) && canonical(record.realizedChanges)
      );
    case "game_trace_create":
      return (
        Array.isArray(record.normalizedControls) &&
        record.normalizedControls.every((entry) =>
          canonicalField(entry, "parameters"),
        )
      );
    case "game_compare":
      return (
        Array.isArray(record.differences) &&
        record.differences.every(
          (entry) =>
            canonicalField(entry, "baseline") &&
            canonicalField(entry, "candidate"),
        )
      );
    case "game_status":
    case "game_stop":
    case "game_step":
    case "game_checkpoint_create":
    case "game_checkpoint_restore":
    case "game_trace_replay":
      return true;
  }
};

/** Strict success-output validation plus domain canonical-value validation. */
export const validateProjectEnvironmentGameToolOutputV1 = (
  toolName: ProjectEnvironmentGameToolNameV1,
  output: unknown,
): boolean =>
  canonicalOutputFieldsAreValid(toolName, output) &&
  Check(PROJECT_ENVIRONMENT_GAME_TOOL_OUTPUT_SCHEMAS_V1[toolName], output);

// Keep referenced standalone resource schemas visible to API documentation.
export const PROJECT_ENVIRONMENT_GAME_OUTPUT_RESOURCE_SCHEMAS_V1 =
  Object.freeze([
    ProjectEnvironmentGameEntityIdV1Schema,
    ProjectEnvironmentGameEventIdV1Schema,
    ProjectEnvironmentClockDomainV1Schema,
  ]);
