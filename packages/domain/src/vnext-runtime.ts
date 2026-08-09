import { z } from "zod";

import { Sha256DigestV1Schema } from "./hash.js";
import {
  AdapterIdSchema,
  BranchIdSchema as LegacyBranchIdSchema,
  BuildIdSchema,
  CaptureWindowIdSchema,
  CheckpointIdSchema as LegacyCheckpointIdSchema,
  ComparisonIdSchema as LegacyComparisonIdSchema,
  EventIdSchema as LegacyEventIdSchema,
  ExecutionIdSchema as LegacyExecutionIdSchema,
  ProbeIdSchema,
  RestoreReceiptIdSchema,
  RuntimeIdSchema,
  RuntimeStateIndexIdSchema,
  SourceIdSchema,
  TaskIdSchema as LegacyTaskIdSchema,
  TraceIdSchema,
  WorkspaceIdSchema,
} from "./ids.js";
import { JsonObjectSchema, JsonValueSchema, type JsonValue } from "./json.js";
import { MicrosecondsSchema } from "./time.js";

const timestampSchema = z.string().datetime();
const nonEmptyStringArraySchema = z.array(z.string().min(1));
const nullableDigestSchema = Sha256DigestV1Schema.nullable();

const safeVNextOpaqueId = <Output extends string>(
  schema: z.ZodType<Output>,
): z.ZodType<Output> =>
  schema.refine(
    (value) =>
      value.length <= 256 &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) &&
      !value.includes(".."),
    "vNext resource ID must be a bounded opaque non-path value",
  );

const TaskIdSchema = safeVNextOpaqueId(LegacyTaskIdSchema);
const ExecutionIdSchema = safeVNextOpaqueId(LegacyExecutionIdSchema);
const CheckpointIdSchema = safeVNextOpaqueId(LegacyCheckpointIdSchema);
const BranchIdSchema = safeVNextOpaqueId(LegacyBranchIdSchema);
const ComparisonIdSchema = safeVNextOpaqueId(LegacyComparisonIdSchema);
const EventIdSchema = safeVNextOpaqueId(LegacyEventIdSchema);

const jsonValuesEqual = (left: JsonValue, right: JsonValue): boolean => {
  if (left === null || right === null || typeof left !== typeof right) {
    return left === right;
  }
  if (typeof left !== "object" || typeof right !== "object") {
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) =>
        jsonValuesEqual(entry, right[index] as JsonValue),
      )
    );
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        jsonValuesEqual(left[key] as JsonValue, right[key] as JsonValue),
    )
  );
};

const addDuplicateIssue = (
  values: readonly string[],
  path: PropertyKey,
  context: z.core.$RefinementCtx,
): void => {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      path: [path],
      message: `${String(path)} must not contain duplicates`,
      input: values,
    });
  }
};

export const VNextClockDomainV1Schema = z.enum([
  "process_frame",
  "physics_tick",
  "simulation_time",
  "render_completion",
  "host_monotonic",
]);
export type VNextClockDomainV1 = z.infer<typeof VNextClockDomainV1Schema>;

export const VNextRuntimePhaseV1Schema = z.enum([
  "runtime_start",
  "process_frame_start",
  "input_flush",
  "physics_tick_start",
  "physics_tick_end",
  "process_frame_end",
  "render_complete",
  "runtime_stop",
]);
export type VNextRuntimePhaseV1 = z.infer<typeof VNextRuntimePhaseV1Schema>;

export const VNextClockPositionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    processFrame: z.number().int().nonnegative(),
    physicsTick: z.number().int().nonnegative(),
    simulationTimeUs: MicrosecondsSchema,
    hostMonotonicUs: MicrosecondsSchema,
    renderFrame: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type VNextClockPositionV1 = z.infer<typeof VNextClockPositionV1Schema>;

export const VNextClockRangeV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    from: VNextClockPositionV1Schema,
    through: VNextClockPositionV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const reversed =
      value.through.processFrame < value.from.processFrame ||
      value.through.physicsTick < value.from.physicsTick ||
      value.through.simulationTimeUs < value.from.simulationTimeUs ||
      value.through.hostMonotonicUs < value.from.hostMonotonicUs ||
      (value.from.renderFrame !== null &&
        value.through.renderFrame !== null &&
        value.through.renderFrame < value.from.renderFrame);
    if (reversed) {
      context.addIssue({
        code: "custom",
        path: ["through"],
        message: "clock range must not run backwards in any known domain",
        input: value.through,
      });
    }
  });
export type VNextClockRangeV1 = z.infer<typeof VNextClockRangeV1Schema>;

export const VNextCaptureChannelV1Schema = z.enum([
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
]);
export type VNextCaptureChannelV1 = z.infer<typeof VNextCaptureChannelV1Schema>;

const protectedCaptureChannels = new Set<VNextCaptureChannelV1>([
  "input",
  "clock",
  "entity_lifecycle",
  "error",
  "checkpoint",
  "restore",
]);

export const VNextCaptureChannelRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    channel: VNextCaptureChannelV1Schema,
    priority: z.enum(["protected", "high", "normal", "low"]),
    sampleEvery: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      protectedCaptureChannels.has(value.channel) &&
      value.priority !== "protected"
    ) {
      context.addIssue({
        code: "custom",
        path: ["priority"],
        message: `${value.channel} is a protected capture channel`,
        input: value.priority,
      });
    }
  });
export type VNextCaptureChannelRequestV1 = z.infer<
  typeof VNextCaptureChannelRequestV1Schema
>;

export const VNextCapturePolicyV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    requestedRetentionUs: z.number().int().positive(),
    requestedRetentionTicks: z.number().int().positive(),
    memoryBudgetBytes: z.number().int().positive(),
    diskBudgetBytes: z.number().int().positive(),
    maxAverageOverheadRatio: z.number().finite().min(0).max(1),
    maxMainThreadBlockUs: z.number().int().nonnegative(),
    channels: z.array(VNextCaptureChannelRequestV1Schema),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(
      value.channels.map((channel) => channel.channel),
      "channels",
      context,
    );
  });
export type VNextCapturePolicyV1 = z.infer<typeof VNextCapturePolicyV1Schema>;

export const VNextCaptureProfileV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    requested: VNextCapturePolicyV1Schema,
    realizedRetentionUs: z.number().int().nonnegative(),
    realizedRetentionTicks: z.number().int().nonnegative(),
    peakMemoryBytes: z.number().int().nonnegative(),
    writtenBytes: z.number().int().nonnegative(),
    averageOverheadRatio: z.number().finite().nonnegative(),
    maxMainThreadBlockUs: MicrosecondsSchema,
    budgetStatus: z.enum(["within_budget", "degraded", "exceeded"]),
    degradationReasons: nonEmptyStringArraySchema,
    gameplayPausedForCapture: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    const exceeded =
      value.peakMemoryBytes > value.requested.memoryBudgetBytes ||
      value.writtenBytes > value.requested.diskBudgetBytes ||
      value.averageOverheadRatio > value.requested.maxAverageOverheadRatio ||
      value.maxMainThreadBlockUs > value.requested.maxMainThreadBlockUs;
    const degraded =
      value.realizedRetentionUs < value.requested.requestedRetentionUs ||
      value.realizedRetentionTicks < value.requested.requestedRetentionTicks;
    if (exceeded && value.budgetStatus !== "exceeded") {
      context.addIssue({
        code: "custom",
        path: ["budgetStatus"],
        message:
          "realized capture cost above a requested budget must be marked exceeded",
        input: value.budgetStatus,
      });
    }
    if (!exceeded && degraded && value.budgetStatus === "within_budget") {
      context.addIssue({
        code: "custom",
        path: ["budgetStatus"],
        message: "reduced capture retention must be marked degraded",
        input: value.budgetStatus,
      });
    }
    if (
      value.budgetStatus !== "within_budget" &&
      value.degradationReasons.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["degradationReasons"],
        message:
          "capture degradation or budget excess requires an explicit reason",
        input: value.degradationReasons,
      });
    }
    if (
      value.budgetStatus === "within_budget" &&
      value.degradationReasons.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["degradationReasons"],
        message: "within-budget capture cannot report degradation reasons",
        input: value.degradationReasons,
      });
    }
  });
export type VNextCaptureProfileV1 = z.infer<typeof VNextCaptureProfileV1Schema>;

export const VNextCaptureCoverageV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    channel: VNextCaptureChannelV1Schema,
    status: z.enum(["full", "sampled", "partial", "unavailable"]),
    availableRange: VNextClockRangeV1Schema.nullable(),
    requestedSampleEvery: z.number().int().positive(),
    realizedSampleEvery: z.number().int().positive().nullable(),
    emittedRecords: z.number().int().nonnegative(),
    droppedRecords: z.number().int().nonnegative(),
    overwrittenRecords: z.number().int().nonnegative(),
    observerEffectUs: MicrosecondsSchema,
    limitations: nonEmptyStringArraySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === "unavailable" &&
      (value.availableRange !== null || value.realizedSampleEvery !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["availableRange"],
        message:
          "unavailable coverage cannot claim a realized range or sample rate",
        input: value.availableRange,
      });
    }
    if (
      value.status !== "unavailable" &&
      (value.availableRange === null || value.realizedSampleEvery === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["availableRange"],
        message:
          "available coverage requires its realized range and sample rate",
        input: value.availableRange,
      });
    }
    if (
      value.status === "full" &&
      (value.droppedRecords !== 0 ||
        value.overwrittenRecords !== 0 ||
        value.realizedSampleEvery !== value.requestedSampleEvery)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "full coverage cannot contain sampling degradation or loss",
        input: value.status,
      });
    }
  });
export type VNextCaptureCoverageV1 = z.infer<
  typeof VNextCaptureCoverageV1Schema
>;

export const VNextCaptureLossV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().nonnegative(),
    channel: VNextCaptureChannelV1Schema,
    kind: z.enum([
      "degraded",
      "sampled",
      "dropped",
      "overwritten",
      "unavailable",
      "observer_effect",
    ]),
    count: z.number().int().nonnegative(),
    firstClock: VNextClockPositionV1Schema.nullable(),
    lastClock: VNextClockPositionV1Schema.nullable(),
    reason: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.firstClock === null) !== (value.lastClock === null)) {
      context.addIssue({
        code: "custom",
        path: ["lastClock"],
        message:
          "loss clock boundaries must either both be known or both be null",
        input: value.lastClock,
      });
    }
    if (
      value.firstClock !== null &&
      value.lastClock !== null &&
      value.lastClock.hostMonotonicUs < value.firstClock.hostMonotonicUs
    ) {
      context.addIssue({
        code: "custom",
        path: ["lastClock"],
        message: "loss interval must not run backwards",
        input: value.lastClock,
      });
    }
  });
export type VNextCaptureLossV1 = z.infer<typeof VNextCaptureLossV1Schema>;

const validateCoverageAndLoss = (
  coverage: readonly VNextCaptureCoverageV1[],
  loss: readonly VNextCaptureLossV1[],
  context: z.core.$RefinementCtx,
): void => {
  addDuplicateIssue(
    coverage.map((entry) => entry.channel),
    "coverage",
    context,
  );
  for (const [index, entry] of loss.entries()) {
    if (entry.sequence !== index) {
      context.addIssue({
        code: "custom",
        path: ["loss", index, "sequence"],
        message: "capture loss sequence must be contiguous from zero",
        input: entry.sequence,
      });
    }
  }
  for (const [index, entry] of coverage.entries()) {
    const degraded =
      entry.status !== "full" ||
      entry.droppedRecords > 0 ||
      entry.overwrittenRecords > 0 ||
      entry.realizedSampleEvery !== entry.requestedSampleEvery;
    if (degraded && !loss.some((item) => item.channel === entry.channel)) {
      context.addIssue({
        code: "custom",
        path: ["coverage", index],
        message: `coverage degradation for ${entry.channel} requires an explicit loss record`,
        input: entry,
      });
    }
  }
};

export const VNextBuildV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    workspaceId: WorkspaceIdSchema,
    sourceId: SourceIdSchema,
    buildId: BuildIdSchema,
    sourceHash: Sha256DigestV1Schema,
    workspaceDiffHash: Sha256DigestV1Schema,
    buildConfigurationHash: Sha256DigestV1Schema,
    outputHash: Sha256DigestV1Schema,
    createdAt: timestampSchema,
  })
  .strict();
export type VNextBuildV1 = z.infer<typeof VNextBuildV1Schema>;

export const VNextAdapterRefV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    adapterId: AdapterIdSchema,
    contentHash: Sha256DigestV1Schema,
    protocolVersion: z.string().min(1),
  })
  .strict();
export type VNextAdapterRefV1 = z.infer<typeof VNextAdapterRefV1Schema>;

export const VNextProbeRefV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    probeId: ProbeIdSchema,
    contentHash: Sha256DigestV1Schema,
    channels: z.array(VNextCaptureChannelV1Schema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.channels, "channels", context);
  });
export type VNextProbeRefV1 = z.infer<typeof VNextProbeRefV1Schema>;

const vNextRuntimeBase = {
  schemaVersion: z.literal(1),
  taskId: TaskIdSchema,
  runtimeId: RuntimeIdSchema,
  buildId: BuildIdSchema,
  sourceId: SourceIdSchema,
  adapter: VNextAdapterRefV1Schema,
  probes: z.array(VNextProbeRefV1Schema),
  capabilities: z.array(z.string().min(1)),
  startedAt: timestampSchema,
};

export const VNextRuntimeV1Schema = z
  .discriminatedUnion("status", [
    z
      .object({
        ...vNextRuntimeBase,
        status: z.enum(["starting", "running"]),
      })
      .strict(),
    z
      .object({
        ...vNextRuntimeBase,
        status: z.enum(["stopped", "crashed", "failed"]),
        endedAt: timestampSchema,
        termination: z
          .object({
            schemaVersion: z.literal(1),
            code: z.string().min(1),
            message: z.string().min(1).nullable(),
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    addDuplicateIssue(
      value.probes.map((probe) => probe.probeId),
      "probes",
      context,
    );
    addDuplicateIssue(value.capabilities, "capabilities", context);
    if ("endedAt" in value) {
      if (Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
        context.addIssue({
          code: "custom",
          path: ["endedAt"],
          message: "runtime cannot end before it starts",
          input: value.endedAt,
        });
      }
    }
  });
export type VNextRuntimeV1 = z.infer<typeof VNextRuntimeV1Schema>;

export const VNextRuntimeControlValuesV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    fixedFps: z.number().int().positive().nullable(),
    physicsTicksPerSecond: z.number().int().positive(),
    timeScale: z.number().finite().positive(),
    paused: z.boolean(),
    headless: z.boolean(),
  })
  .strict();
export type VNextRuntimeControlValuesV1 = z.infer<
  typeof VNextRuntimeControlValuesV1Schema
>;

export const VNextRuntimeControlMismatchV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    control: z.enum([
      "fixed_fps",
      "physics_ticks_per_second",
      "time_scale",
      "paused",
      "headless",
    ]),
    requested: JsonValueSchema,
    realized: JsonValueSchema,
    reason: z.string().min(1),
  })
  .strict();
export type VNextRuntimeControlMismatchV1 = z.infer<
  typeof VNextRuntimeControlMismatchV1Schema
>;

const controlProperty = {
  fixed_fps: "fixedFps",
  physics_ticks_per_second: "physicsTicksPerSecond",
  time_scale: "timeScale",
  paused: "paused",
  headless: "headless",
} as const;

export const VNextRuntimeControlReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    requested: VNextRuntimeControlValuesV1Schema,
    realized: VNextRuntimeControlValuesV1Schema,
    mismatches: z.array(VNextRuntimeControlMismatchV1Schema),
    knownSideEffects: nonEmptyStringArraySchema,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(
      value.mismatches.map((mismatch) => mismatch.control),
      "mismatches",
      context,
    );
    for (const control of Object.keys(controlProperty) as Array<
      keyof typeof controlProperty
    >) {
      const property = controlProperty[control];
      const requested = value.requested[property];
      const realized = value.realized[property];
      const mismatch = value.mismatches.find(
        (candidate) => candidate.control === control,
      );
      if (requested !== realized && mismatch === undefined) {
        context.addIssue({
          code: "custom",
          path: ["mismatches"],
          message: `${control} differs but has no mismatch receipt`,
          input: value.mismatches,
        });
      }
      if (requested === realized && mismatch !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["mismatches"],
          message: `${control} is realized exactly and cannot be listed as a mismatch`,
          input: mismatch,
        });
      }
      if (
        mismatch !== undefined &&
        (mismatch.requested !== requested || mismatch.realized !== realized)
      ) {
        context.addIssue({
          code: "custom",
          path: ["mismatches"],
          message: `${control} mismatch values do not match requested and realized controls`,
          input: mismatch,
        });
      }
    }
  });
export type VNextRuntimeControlReceiptV1 = z.infer<
  typeof VNextRuntimeControlReceiptV1Schema
>;

export const VNextObservedRelationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.enum(["scheduled_by", "spawned_by", "delivery"]),
    targetEventId: EventIdSchema,
  })
  .strict();
export type VNextObservedRelationV1 = z.infer<
  typeof VNextObservedRelationV1Schema
>;

export const VNextRawRuntimeEventV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: EventIdSchema,
    taskId: TaskIdSchema,
    executionId: ExecutionIdSchema,
    runtimeId: RuntimeIdSchema,
    buildId: BuildIdSchema,
    sequence: z.number().int().nonnegative(),
    channel: VNextCaptureChannelV1Schema,
    kind: z.enum([
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
    ]),
    clock: VNextClockPositionV1Schema,
    payload: JsonObjectSchema,
    observedRelations: z.array(VNextObservedRelationV1Schema),
  })
  .strict();
export type VNextRawRuntimeEventV1 = z.infer<
  typeof VNextRawRuntimeEventV1Schema
>;

export const VNextExecutionManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    executionId: ExecutionIdSchema,
    runtimeId: RuntimeIdSchema,
    workspaceId: WorkspaceIdSchema,
    sourceId: SourceIdSchema,
    buildId: BuildIdSchema,
    adapterId: AdapterIdSchema,
    stateSchemaVersion: z.string().min(1),
    probeIds: z.array(ProbeIdSchema),
    traceId: TraceIdSchema.nullable(),
    startCheckpointId: CheckpointIdSchema.nullable(),
    branchId: BranchIdSchema.nullable(),
    launchTarget: z.string().min(1),
    launchParameters: JsonObjectSchema,
    controls: VNextRuntimeControlReceiptV1Schema,
    clockDomains: z.array(VNextClockDomainV1Schema).min(1),
    capturePolicy: VNextCapturePolicyV1Schema,
    startedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.probeIds, "probeIds", context);
    addDuplicateIssue(value.clockDomains, "clockDomains", context);
  });
export type VNextExecutionManifestV1 = z.infer<
  typeof VNextExecutionManifestV1Schema
>;

const vNextExecutionRecordBase = {
  schemaVersion: z.literal(1),
  taskId: TaskIdSchema,
  executionId: ExecutionIdSchema,
  runtimeId: RuntimeIdSchema,
  buildId: BuildIdSchema,
  manifest: VNextExecutionManifestV1Schema,
  captureProfile: VNextCaptureProfileV1Schema,
  events: z.array(VNextRawRuntimeEventV1Schema),
  coverage: z.array(VNextCaptureCoverageV1Schema),
  loss: z.array(VNextCaptureLossV1Schema),
};

export const VNextExecutionRecordV1Schema = z
  .discriminatedUnion("sealed", [
    z
      .object({
        ...vNextExecutionRecordBase,
        status: z.literal("running"),
        sealed: z.literal(false),
      })
      .strict(),
    z
      .object({
        ...vNextExecutionRecordBase,
        status: z.enum(["completed", "stopped", "crashed", "failed"]),
        sealed: z.literal(true),
        endedAt: timestampSchema,
        termination: z
          .object({
            schemaVersion: z.literal(1),
            code: z.string().min(1),
            message: z.string().min(1).nullable(),
          })
          .strict(),
        recordHash: Sha256DigestV1Schema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.manifest.taskId !== value.taskId ||
      value.manifest.executionId !== value.executionId ||
      value.manifest.runtimeId !== value.runtimeId ||
      value.manifest.buildId !== value.buildId
    ) {
      context.addIssue({
        code: "custom",
        path: ["manifest"],
        message:
          "execution manifest task and resource identities must match its record",
        input: value.manifest,
      });
    }
    if (
      value.captureProfile.requested !== value.manifest.capturePolicy &&
      !jsonValuesEqual(
        value.captureProfile.requested,
        value.manifest.capturePolicy,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["captureProfile", "requested"],
        message:
          "realized capture profile must reference the execution's requested capture policy",
        input: value.captureProfile.requested,
      });
    }

    const eventIds = new Set<string>();
    for (const [index, event] of value.events.entries()) {
      if (
        event.taskId !== value.taskId ||
        event.executionId !== value.executionId ||
        event.runtimeId !== value.runtimeId ||
        event.buildId !== value.buildId
      ) {
        context.addIssue({
          code: "custom",
          path: ["events", index],
          message: "raw event provenance must match its execution record",
          input: event,
        });
      }
      if (event.sequence !== index) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "sequence"],
          message: "raw event sequence must be contiguous from zero",
          input: event.sequence,
        });
      }
      if (eventIds.has(event.eventId)) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "eventId"],
          message: "raw event IDs must be unique within an execution",
          input: event.eventId,
        });
      }
      eventIds.add(event.eventId);
    }
    for (const [eventIndex, event] of value.events.entries()) {
      for (const [
        relationIndex,
        relation,
      ] of event.observedRelations.entries()) {
        if (relation.targetEventId === event.eventId) {
          context.addIssue({
            code: "custom",
            path: [
              "events",
              eventIndex,
              "observedRelations",
              relationIndex,
              "targetEventId",
            ],
            message: "raw event relation cannot target its own event",
            input: relation.targetEventId,
          });
        } else if (!eventIds.has(relation.targetEventId)) {
          context.addIssue({
            code: "custom",
            path: [
              "events",
              eventIndex,
              "observedRelations",
              relationIndex,
              "targetEventId",
            ],
            message:
              "raw event relation target must exist in the same execution record",
            input: relation.targetEventId,
          });
        }
      }
    }

    validateCoverageAndLoss(value.coverage, value.loss, context);
    const requestedCoverageChannels = new Set(
      value.manifest.capturePolicy.channels.map((entry) => entry.channel),
    );
    const realizedCoverageChannels = new Set(
      value.coverage.map((entry) => entry.channel),
    );
    if (
      requestedCoverageChannels.size !== realizedCoverageChannels.size ||
      [...requestedCoverageChannels].some(
        (channel) => !realizedCoverageChannels.has(channel),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["coverage"],
        message:
          "execution coverage must account for every requested capture channel exactly once",
        input: value.coverage,
      });
    }
    for (const [index, entry] of value.loss.entries()) {
      if (!requestedCoverageChannels.has(entry.channel)) {
        context.addIssue({
          code: "custom",
          path: ["loss", index, "channel"],
          message:
            "execution loss cannot reference a channel outside its capture policy",
          input: entry.channel,
        });
      }
    }

    if (
      value.sealed &&
      Date.parse(value.endedAt) < Date.parse(value.manifest.startedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "execution cannot end before it starts",
        input: value.endedAt,
      });
    }
  });
export type VNextExecutionRecordV1 = z.infer<
  typeof VNextExecutionRecordV1Schema
>;

export const VNextCaptureWindowV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    captureWindowId: CaptureWindowIdSchema,
    executionId: ExecutionIdSchema,
    runtimeId: RuntimeIdSchema,
    sourceId: SourceIdSchema,
    buildId: BuildIdSchema,
    adapterId: AdapterIdSchema,
    probeIds: z.array(ProbeIdSchema),
    status: z.enum(["available", "partial", "unavailable"]),
    requestedRange: VNextClockRangeV1Schema,
    realizedRange: VNextClockRangeV1Schema.nullable(),
    captureProfile: VNextCaptureProfileV1Schema,
    coverage: z.array(VNextCaptureCoverageV1Schema),
    loss: z.array(VNextCaptureLossV1Schema),
    frozenBy: z.enum([
      "manual_pin",
      "capture_trigger",
      "crash",
      "engine_error",
      "timeout",
      "process_exit",
    ]),
    pinnedAt: timestampSchema,
    firstVisibleAnomalyEventId: EventIdSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.probeIds, "probeIds", context);
    validateCoverageAndLoss(value.coverage, value.loss, context);
    if (value.status === "unavailable" && value.realizedRange !== null) {
      context.addIssue({
        code: "custom",
        path: ["realizedRange"],
        message: "an unavailable history window cannot claim a realizedRange",
        input: value.realizedRange,
      });
    }
    if (value.status !== "unavailable" && value.realizedRange === null) {
      context.addIssue({
        code: "custom",
        path: ["realizedRange"],
        message:
          "an available or partial history window requires a realizedRange",
        input: value.realizedRange,
      });
    }
    if (value.status === "available" && value.loss.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "a window with capture loss must be marked partial",
        input: value.status,
      });
    }
    if (value.status === "partial" && value.loss.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["loss"],
        message: "a partial window requires explicit loss metadata",
        input: value.loss,
      });
    }
  });
export type VNextCaptureWindowV1 = z.infer<typeof VNextCaptureWindowV1Schema>;

const stateDomainBase = {
  schemaVersion: z.literal(1),
  domain: z.string().min(1),
};

export const VNextCapturedStateDomainV1Schema = z
  .object({
    ...stateDomainBase,
    classification: z.literal("captured"),
    serializationRule: z.string().min(1),
    canonicalizationRule: z.string().min(1),
    stateHash: Sha256DigestV1Schema,
    tolerance: JsonValueSchema.nullable(),
    restoreOrder: z.number().int().nonnegative(),
  })
  .strict();
export type VNextCapturedStateDomainV1 = z.infer<
  typeof VNextCapturedStateDomainV1Schema
>;

export const VNextResetStateDomainV1Schema = z
  .object({
    ...stateDomainBase,
    classification: z.literal("reset"),
    resetRule: z.string().min(1),
    restoreOrder: z.number().int().nonnegative(),
  })
  .strict();
export type VNextResetStateDomainV1 = z.infer<
  typeof VNextResetStateDomainV1Schema
>;

export const VNextExternallyControlledStateDomainV1Schema = z
  .object({
    ...stateDomainBase,
    classification: z.literal("externally_controlled"),
    controller: z.string().min(1),
    limitation: z.string().min(1),
  })
  .strict();
export type VNextExternallyControlledStateDomainV1 = z.infer<
  typeof VNextExternallyControlledStateDomainV1Schema
>;

export const VNextUnsupportedStateDomainV1Schema = z
  .object({
    ...stateDomainBase,
    classification: z.literal("unsupported"),
    reason: z.string().min(1),
  })
  .strict();
export type VNextUnsupportedStateDomainV1 = z.infer<
  typeof VNextUnsupportedStateDomainV1Schema
>;

export const VNextUncontrolledStateDomainV1Schema = z
  .object({
    ...stateDomainBase,
    classification: z.literal("uncontrolled"),
    reason: z.string().min(1),
  })
  .strict();
export type VNextUncontrolledStateDomainV1 = z.infer<
  typeof VNextUncontrolledStateDomainV1Schema
>;

export const VNextCheckpointStateDomainV1Schema = z.discriminatedUnion(
  "classification",
  [
    VNextCapturedStateDomainV1Schema,
    VNextResetStateDomainV1Schema,
    VNextExternallyControlledStateDomainV1Schema,
    VNextUnsupportedStateDomainV1Schema,
    VNextUncontrolledStateDomainV1Schema,
  ],
);
export type VNextCheckpointStateDomainV1 = z.infer<
  typeof VNextCheckpointStateDomainV1Schema
>;

export const VNextCheckpointManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    checkpointId: CheckpointIdSchema,
    executionId: ExecutionIdSchema,
    runtimeId: RuntimeIdSchema,
    workspaceId: WorkspaceIdSchema,
    sourceId: SourceIdSchema,
    buildId: BuildIdSchema,
    adapterId: AdapterIdSchema,
    stateSchemaVersion: z.string().min(1),
    probeIds: z.array(ProbeIdSchema),
    captureWindowId: CaptureWindowIdSchema.nullable(),
    capturedAt: VNextClockPositionV1Schema,
    consistencyModel: z.string().min(1),
    semanticBarrier: z.string().min(1),
    domains: z.array(VNextCheckpointStateDomainV1Schema).min(1),
    restoreDependencyOrder: z.array(z.string().min(1)),
    inFlightState: nonEmptyStringArraySchema,
    limitations: nonEmptyStringArraySchema,
    portability: z.literal("same_build_only"),
    fidelity: z.enum(["equivalent_candidate", "descriptive_only"]),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.probeIds, "probeIds", context);
    addDuplicateIssue(
      value.domains.map((domain) => domain.domain),
      "domains",
      context,
    );
    addDuplicateIssue(
      value.restoreDependencyOrder,
      "restoreDependencyOrder",
      context,
    );

    const restorableDomains = value.domains.filter(
      (domain) =>
        domain.classification === "captured" ||
        domain.classification === "reset",
    );
    addDuplicateIssue(
      restorableDomains.map((domain) => String(domain.restoreOrder)),
      "restoreOrder",
      context,
    );
    const restorable = restorableDomains
      .sort((left, right) => left.restoreOrder - right.restoreOrder)
      .map((domain) => domain.domain);
    if (
      restorable.length !== value.restoreDependencyOrder.length ||
      restorable.some(
        (domain, index) => domain !== value.restoreDependencyOrder[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["restoreDependencyOrder"],
        message:
          "restoreDependencyOrder must list every captured/reset domain in restore order",
        input: value.restoreDependencyOrder,
      });
    }

    const hasUnrestorableDomain = value.domains.some(
      (domain) =>
        domain.classification === "unsupported" ||
        domain.classification === "uncontrolled",
    );
    if (hasUnrestorableDomain && value.fidelity !== "descriptive_only") {
      context.addIssue({
        code: "custom",
        path: ["fidelity"],
        message:
          "unsupported or uncontrolled state makes checkpoint fidelity descriptive_only",
        input: value.fidelity,
      });
    }
  });
export type VNextCheckpointManifestV1 = z.infer<
  typeof VNextCheckpointManifestV1Schema
>;

export const VNextRestoreDomainReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    domain: z.string().min(1),
    requested: z.boolean(),
    status: z.enum([
      "restored",
      "reset",
      "externally_controlled",
      "rejected",
      "skipped",
      "unsupported",
      "uncontrolled",
    ]),
    beforeHash: nullableDigestSchema,
    afterHash: nullableDigestSchema,
    message: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.requested && value.status === "restored") {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "an unrequested domain cannot be reported as restored",
        input: value.status,
      });
    }
    if (
      (value.status === "restored" || value.status === "reset") &&
      value.afterHash === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["afterHash"],
        message: "a restored/reset domain requires an afterHash",
        input: value.afterHash,
      });
    }
  });
export type VNextRestoreDomainReceiptV1 = z.infer<
  typeof VNextRestoreDomainReceiptV1Schema
>;

export const VNextRestoreValidationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1),
    status: z.enum(["pass", "fail", "unavailable"]),
    expectedHash: nullableDigestSchema,
    actualHash: nullableDigestSchema,
    message: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === "pass" &&
      (value.expectedHash === null ||
        value.actualHash === null ||
        value.expectedHash !== value.actualHash)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "a passing restore validation requires equal expected and actual hashes",
        input: value.status,
      });
    }
    if (value.status === "unavailable" && value.message === null) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "an unavailable validation requires an explanation",
        input: value.message,
      });
    }
  });
export type VNextRestoreValidationV1 = z.infer<
  typeof VNextRestoreValidationV1Schema
>;

export const VNextObservedFirstDivergenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("observed"),
    clock: VNextClockPositionV1Schema,
    phase: VNextRuntimePhaseV1Schema,
    differenceKind: z.enum(["field", "entity", "event", "clock"]),
    subject: z.string().min(1),
    left: JsonValueSchema,
    right: JsonValueSchema,
    fidelityBoundary: z.string().min(1),
  })
  .strict();

export const VNextNoObservedDivergenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("none_observed"),
    fidelityBoundary: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export const VNextUnavailableDivergenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("unavailable"),
    fidelityBoundary: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export const VNextFirstDivergenceV1Schema = z.discriminatedUnion("status", [
  VNextObservedFirstDivergenceV1Schema,
  VNextNoObservedDivergenceV1Schema,
  VNextUnavailableDivergenceV1Schema,
]);
export type VNextFirstDivergenceV1 = z.infer<
  typeof VNextFirstDivergenceV1Schema
>;

export const VNextRestoreReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    restoreReceiptId: RestoreReceiptIdSchema,
    checkpointId: CheckpointIdSchema,
    checkpointBuildId: BuildIdSchema,
    currentBuildId: BuildIdSchema,
    checkpointAdapterId: AdapterIdSchema,
    currentAdapterId: AdapterIdSchema,
    checkpointStateSchemaVersion: z.string().min(1),
    currentStateSchemaVersion: z.string().min(1),
    targetRuntimeId: RuntimeIdSchema,
    targetExecutionId: ExecutionIdSchema,
    compatibility: z.enum([
      "same_build",
      "build_mismatch",
      "adapter_mismatch",
      "schema_mismatch",
    ]),
    status: z.enum(["restored", "partially_restored", "rejected"]),
    equivalentForkEligible: z.boolean(),
    equivalence: z.enum([
      "registered_state_restored_but_equivalence_unestablished",
      "unavailable",
    ]),
    domains: z.array(VNextRestoreDomainReceiptV1Schema),
    uncoveredDomains: z.array(z.string().min(1)),
    fidelity: z.enum(["equivalent_candidate", "descriptive_only"]),
    deterministicBoundary: z.string().min(1),
    validations: z.array(VNextRestoreValidationV1Schema),
    firstDivergence: VNextFirstDivergenceV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(
      value.domains.map((domain) => domain.domain),
      "domains",
      context,
    );
    addDuplicateIssue(value.uncoveredDomains, "uncoveredDomains", context);
    addDuplicateIssue(
      value.validations.map((validation) => validation.name),
      "validations",
      context,
    );

    const sameBuild = value.checkpointBuildId === value.currentBuildId;
    const sameAdapter = value.checkpointAdapterId === value.currentAdapterId;
    const sameStateSchema =
      value.checkpointStateSchemaVersion === value.currentStateSchemaVersion;
    const expectedCompatibility = !sameBuild
      ? "build_mismatch"
      : !sameAdapter
        ? "adapter_mismatch"
        : !sameStateSchema
          ? "schema_mismatch"
          : "same_build";
    if (value.compatibility !== expectedCompatibility) {
      context.addIssue({
        code: "custom",
        path: ["compatibility"],
        message: `compatibility must report ${expectedCompatibility} for the supplied build, adapter, and state schema identities`,
        input: value.compatibility,
      });
    }

    if (expectedCompatibility !== "same_build") {
      if (
        value.status !== "rejected" ||
        value.equivalentForkEligible ||
        value.fidelity !== "descriptive_only" ||
        value.equivalence !== "unavailable"
      ) {
        context.addIssue({
          code: "custom",
          path: ["compatibility"],
          message:
            "incompatible build, adapter, or state schema restore must be rejected and cannot claim equivalent restore",
          input: value.compatibility,
        });
      }
      if (
        value.domains.some(
          (domain) => domain.status === "restored" || domain.status === "reset",
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["domains"],
          message:
            "incompatible restore rejection cannot report restored state domains",
          input: value.domains,
        });
      }
    }

    if (value.status === "rejected" && value.equivalence !== "unavailable") {
      context.addIssue({
        code: "custom",
        path: ["equivalence"],
        message: "a rejected restore has no replay equivalence observation",
        input: value.equivalence,
      });
    }
    if (value.status !== "restored" && value.equivalence !== "unavailable") {
      context.addIssue({
        code: "custom",
        path: ["equivalence"],
        message:
          "only a restored checkpoint can report registered-state restore equivalence as unestablished",
        input: value.equivalence,
      });
    }

    if (
      value.firstDivergence?.status === "observed" &&
      value.equivalentForkEligible
    ) {
      context.addIssue({
        code: "custom",
        path: ["equivalentForkEligible"],
        message:
          "an observed replay divergence makes the restore ineligible for an equivalent fork",
        input: value.equivalentForkEligible,
      });
    }

    if (value.equivalentForkEligible) {
      const ineligibleDomain = value.domains.some(
        (domain) =>
          domain.status === "rejected" ||
          domain.status === "skipped" ||
          domain.status === "unsupported" ||
          domain.status === "uncontrolled",
      );
      if (
        !sameBuild ||
        !sameAdapter ||
        !sameStateSchema ||
        value.compatibility !== "same_build" ||
        value.status !== "restored" ||
        value.fidelity !== "equivalent_candidate" ||
        value.uncoveredDomains.length > 0 ||
        ineligibleDomain
      ) {
        context.addIssue({
          code: "custom",
          path: ["equivalentForkEligible"],
          message:
            "equivalent-fork eligibility requires a complete same-build registered-state restore",
          input: value.equivalentForkEligible,
        });
      }
    }

    if (value.fidelity === "descriptive_only" && value.equivalentForkEligible) {
      context.addIssue({
        code: "custom",
        path: ["fidelity"],
        message: "descriptive-only restore is not equivalent-fork eligible",
        input: value.fidelity,
      });
    }
  });
export type VNextRestoreReceiptV1 = z.infer<typeof VNextRestoreReceiptV1Schema>;

export const VNextTraceTargetV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    clockDomain: VNextClockDomainV1Schema,
    position: z.number().int().nonnegative(),
    phase: VNextRuntimePhaseV1Schema,
  })
  .strict();
export type VNextTraceTargetV1 = z.infer<typeof VNextTraceTargetV1Schema>;

export const VNextTraceRealizationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    clock: VNextClockPositionV1Schema,
    phase: VNextRuntimePhaseV1Schema,
    quantized: z.boolean(),
    mismatchReason: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.quantized !== (value.mismatchReason !== null)) {
      context.addIssue({
        code: "custom",
        path: ["mismatchReason"],
        message:
          "quantized trace realization must explain its mismatch, and exact realization must not invent one",
        input: value.mismatchReason,
      });
    }
  });
export type VNextTraceRealizationV1 = z.infer<
  typeof VNextTraceRealizationV1Schema
>;

export const VNextTraceEventV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().nonnegative(),
    kind: z.enum(["input_press", "input_release", "step", "runtime_control"]),
    name: z.string().min(1),
    value: JsonValueSchema,
    inputPairId: z.string().min(1).nullable(),
    requested: VNextTraceTargetV1Schema,
    realized: VNextTraceRealizationV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const isInput =
      value.kind === "input_press" || value.kind === "input_release";
    if (isInput !== (value.inputPairId !== null)) {
      context.addIssue({
        code: "custom",
        path: ["inputPairId"],
        message:
          "input press/release events require a pair ID; non-input controls cannot claim one",
        input: value.inputPairId,
      });
    }
  });
export type VNextTraceEventV1 = z.infer<typeof VNextTraceEventV1Schema>;

export const VNextRuntimeTraceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    traceId: TraceIdSchema,
    sourceExecutionId: ExecutionIdSchema.nullable(),
    sourceRuntimeId: RuntimeIdSchema.nullable(),
    sourceId: SourceIdSchema,
    sourceBuildId: BuildIdSchema,
    sourceAdapterId: AdapterIdSchema.nullable(),
    sourceProbeIds: z.array(ProbeIdSchema),
    sourceCaptureWindowId: CaptureWindowIdSchema.nullable(),
    createdAt: timestampSchema,
    events: z.array(VNextTraceEventV1Schema),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.sourceProbeIds, "sourceProbeIds", context);
    if (
      value.sourceExecutionId === null &&
      (value.sourceRuntimeId !== null || value.sourceCaptureWindowId !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceExecutionId"],
        message:
          "a trace without a source execution cannot claim source runtime or capture resources",
        input: value.sourceExecutionId,
      });
    }
    const inputPairs = new Map<
      string,
      { press?: VNextTraceEventV1; release?: VNextTraceEventV1 }
    >();
    for (const [index, event] of value.events.entries()) {
      if (event.sequence !== index) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "sequence"],
          message: "trace event sequence must be contiguous from zero",
          input: event.sequence,
        });
      }
      if (event.inputPairId !== null) {
        const pair = inputPairs.get(event.inputPairId) ?? {};
        if (event.kind === "input_press") {
          if (pair.press !== undefined) {
            context.addIssue({
              code: "custom",
              path: ["events", index, "inputPairId"],
              message: "an input pair cannot contain more than one press",
              input: event.inputPairId,
            });
          }
          pair.press = event;
        } else if (event.kind === "input_release") {
          if (pair.release !== undefined) {
            context.addIssue({
              code: "custom",
              path: ["events", index, "inputPairId"],
              message: "an input pair cannot contain more than one release",
              input: event.inputPairId,
            });
          }
          pair.release = event;
        }
        inputPairs.set(event.inputPairId, pair);
      }
    }
    for (const [pairId, pair] of inputPairs) {
      if (
        pair.press === undefined ||
        pair.release === undefined ||
        pair.release.sequence <= pair.press.sequence ||
        pair.press.name !== pair.release.name
      ) {
        context.addIssue({
          code: "custom",
          path: ["events"],
          message: `input pair ${pairId} must contain an ordered press/release for the same action`,
          input: pair,
        });
      }
    }
  });
export type VNextRuntimeTraceV1 = z.infer<typeof VNextRuntimeTraceV1Schema>;

export const VNextTraceReplayApplicationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    traceSequence: z.number().int().nonnegative(),
    requested: VNextTraceTargetV1Schema,
    realized: VNextTraceRealizationV1Schema,
    knownSideEffects: nonEmptyStringArraySchema,
  })
  .strict();
export type VNextTraceReplayApplicationV1 = z.infer<
  typeof VNextTraceReplayApplicationV1Schema
>;

export const VNextTraceReplayReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    traceId: TraceIdSchema,
    sourceExecutionId: ExecutionIdSchema.nullable(),
    targetExecutionId: ExecutionIdSchema,
    sourceBuildId: BuildIdSchema,
    targetBuildId: BuildIdSchema,
    mode: z.enum(["same_build_replay", "descriptive_only"]),
    status: z.enum(["completed", "stopped", "failed"]),
    applications: z.array(VNextTraceReplayApplicationV1Schema),
    firstDivergence: VNextFirstDivergenceV1Schema,
    limitations: nonEmptyStringArraySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.sourceBuildId !== value.targetBuildId &&
      value.mode !== "descriptive_only"
    ) {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "cross-build trace replay can only be descriptive",
        input: value.mode,
      });
    }
    const sequences = value.applications.map(
      (application) => application.traceSequence,
    );
    if (sequences.some((sequence, index) => sequence !== index)) {
      context.addIssue({
        code: "custom",
        path: ["applications"],
        message:
          "replay application receipts must be contiguous from trace sequence zero",
        input: sequences,
      });
    }
  });
export type VNextTraceReplayReceiptV1 = z.infer<
  typeof VNextTraceReplayReceiptV1Schema
>;

export const VNextBranchParentV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("workspace"),
      workspaceId: WorkspaceIdSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("build"),
      buildId: BuildIdSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("execution"),
      executionId: ExecutionIdSchema,
      buildId: BuildIdSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("checkpoint"),
      checkpointId: CheckpointIdSchema,
      buildId: BuildIdSchema,
    })
    .strict(),
]);
export type VNextBranchParentV1 = z.infer<typeof VNextBranchParentV1Schema>;

export const VNextBranchChangeDimensionV1Schema = z.enum([
  "code",
  "adapter",
  "probe",
  "input",
  "seed",
  "runtime_control",
  "capture_profile",
  "project_configuration",
]);
export type VNextBranchChangeDimensionV1 = z.infer<
  typeof VNextBranchChangeDimensionV1Schema
>;

export const VNextRequestedBranchChangeV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    dimension: VNextBranchChangeDimensionV1Schema,
    requested: JsonValueSchema,
  })
  .strict();
export type VNextRequestedBranchChangeV1 = z.infer<
  typeof VNextRequestedBranchChangeV1Schema
>;

export const VNextRealizedBranchChangeV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    dimension: VNextBranchChangeDimensionV1Schema,
    requested: JsonValueSchema,
    realized: JsonValueSchema,
    status: z.enum(["applied", "partially_applied", "rejected"]),
    knownSideEffects: nonEmptyStringArraySchema,
  })
  .strict();
export type VNextRealizedBranchChangeV1 = z.infer<
  typeof VNextRealizedBranchChangeV1Schema
>;

export const VNextBranchLineageV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    branchId: BranchIdSchema,
    parent: VNextBranchParentV1Schema,
    childWorkspaceId: WorkspaceIdSchema,
    childSourceId: SourceIdSchema,
    childBuildId: BuildIdSchema,
    childAdapterId: AdapterIdSchema,
    childProbeIds: z.array(ProbeIdSchema),
    childCaptureWindowId: CaptureWindowIdSchema.nullable(),
    childTraceId: TraceIdSchema.nullable(),
    childExecutionId: ExecutionIdSchema.nullable(),
    requestedChanges: z.array(VNextRequestedBranchChangeV1Schema),
    realizedChanges: z.array(VNextRealizedBranchChangeV1Schema),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.childProbeIds, "childProbeIds", context);
    if (
      value.childExecutionId === null &&
      value.childCaptureWindowId !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["childCaptureWindowId"],
        message:
          "a branch cannot claim a child capture window before a child execution exists",
        input: value.childCaptureWindowId,
      });
    }
    for (const [index, requested] of value.requestedChanges.entries()) {
      const realized = value.realizedChanges[index];
      if (
        realized === undefined ||
        requested.dimension !== realized.dimension ||
        !jsonValuesEqual(requested.requested, realized.requested)
      ) {
        context.addIssue({
          code: "custom",
          path: ["realizedChanges", index],
          message:
            "every requested branch change requires an ordered realized receipt for the same request",
          input: realized,
        });
      }
    }
    if (value.realizedChanges.length !== value.requestedChanges.length) {
      context.addIssue({
        code: "custom",
        path: ["realizedChanges"],
        message:
          "realized branch changes must correspond one-to-one with requested changes",
        input: value.realizedChanges,
      });
    }
  });
export type VNextBranchLineageV1 = z.infer<typeof VNextBranchLineageV1Schema>;

export const VNextRuntimeStateQueryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    executionId: ExecutionIdSchema,
    entityIds: z.array(z.string().min(1)),
    eventKinds: z.array(
      z.enum([
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
      ]),
    ),
    statePaths: z.array(z.string().min(1)),
    clockRange: VNextClockRangeV1Schema.nullable(),
    limit: z.number().int().positive().max(10_000),
    cursor: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.entityIds, "entityIds", context);
    addDuplicateIssue(value.eventKinds, "eventKinds", context);
    addDuplicateIssue(value.statePaths, "statePaths", context);
  });
export type VNextRuntimeStateQueryV1 = z.infer<
  typeof VNextRuntimeStateQueryV1Schema
>;

export const VNextIndexedEntityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    stableId: z.string().min(1),
    incarnation: z.number().int().positive(),
    sceneId: z.string().min(1),
    parentStableId: z.string().min(1).nullable(),
    ownerStableId: z.string().min(1).nullable(),
  })
  .strict();
export type VNextIndexedEntityV1 = z.infer<typeof VNextIndexedEntityV1Schema>;

export const VNextRuntimeStateRowV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    rawEventId: EventIdSchema,
    rawSequence: z.number().int().nonnegative(),
    clock: VNextClockPositionV1Schema,
    kind: z.enum([
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
    ]),
    entity: VNextIndexedEntityV1Schema.nullable(),
    statePath: z.string().min(1).nullable(),
    value: JsonValueSchema,
    observedRelations: z.array(VNextObservedRelationV1Schema),
    checkpointId: CheckpointIdSchema.nullable(),
  })
  .strict();
export type VNextRuntimeStateRowV1 = z.infer<
  typeof VNextRuntimeStateRowV1Schema
>;

export const VNextRuntimeStateQueryResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    indexId: RuntimeStateIndexIdSchema,
    executionId: ExecutionIdSchema,
    runtimeId: RuntimeIdSchema,
    sourceId: SourceIdSchema,
    buildId: BuildIdSchema,
    adapterId: AdapterIdSchema,
    probeIds: z.array(ProbeIdSchema),
    captureWindowIds: z.array(CaptureWindowIdSchema),
    rawRecordHash: Sha256DigestV1Schema,
    query: VNextRuntimeStateQueryV1Schema,
    rows: z.array(VNextRuntimeStateRowV1Schema),
    coverage: z.array(VNextCaptureCoverageV1Schema),
    loss: z.array(VNextCaptureLossV1Schema),
    incomplete: z.boolean(),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.probeIds, "probeIds", context);
    addDuplicateIssue(value.captureWindowIds, "captureWindowIds", context);
    if (
      value.query.taskId !== value.taskId ||
      value.query.executionId !== value.executionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["query"],
        message:
          "Runtime State Index query task ownership must match its result",
        input: value.query,
      });
    }
    validateCoverageAndLoss(value.coverage, value.loss, context);
    const hasIncompleteCoverage =
      value.loss.length > 0 ||
      value.coverage.some((entry) => entry.status !== "full");
    if (hasIncompleteCoverage && !value.incomplete) {
      context.addIssue({
        code: "custom",
        path: ["incomplete"],
        message:
          "query results with capture loss or incomplete coverage must be marked incomplete",
        input: value.incomplete,
      });
    }
  });
export type VNextRuntimeStateQueryResultV1 = z.infer<
  typeof VNextRuntimeStateQueryResultV1Schema
>;

export const VNextComparisonExecutionRefV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    executionId: ExecutionIdSchema,
    runtimeId: RuntimeIdSchema,
    sourceId: SourceIdSchema,
    buildId: BuildIdSchema,
    adapterId: AdapterIdSchema,
    probeIds: z.array(ProbeIdSchema),
    traceId: TraceIdSchema.nullable(),
    checkpointId: CheckpointIdSchema.nullable(),
    captureWindowIds: z.array(CaptureWindowIdSchema),
    executionRecordHash: Sha256DigestV1Schema,
    rawRecordHash: Sha256DigestV1Schema,
    captureCoverageHash: Sha256DigestV1Schema,
    checkpointFidelity: z.enum([
      "equivalent_candidate",
      "descriptive_only",
      "not_applicable",
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.probeIds, "probeIds", context);
    addDuplicateIssue(value.captureWindowIds, "captureWindowIds", context);
    if (
      (value.checkpointId === null) !==
      (value.checkpointFidelity === "not_applicable")
    ) {
      context.addIssue({
        code: "custom",
        path: ["checkpointFidelity"],
        message:
          "checkpoint fidelity must be not_applicable exactly when no checkpoint is referenced",
        input: value.checkpointFidelity,
      });
    }
  });
export type VNextComparisonExecutionRefV1 = z.infer<
  typeof VNextComparisonExecutionRefV1Schema
>;

export const VNextComparisonAlignmentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["aligned", "partial", "unavailable"]),
    clockUncertaintyUs: MicrosecondsSchema.nullable(),
    matchedEntities: z.array(z.string().min(1)),
    unmatchedLeftEntities: z.array(z.string().min(1)),
    unmatchedRightEntities: z.array(z.string().min(1)),
    ambiguousEntities: z.array(z.string().min(1)),
    limitations: nonEmptyStringArraySchema,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.matchedEntities, "matchedEntities", context);
    addDuplicateIssue(
      value.unmatchedLeftEntities,
      "unmatchedLeftEntities",
      context,
    );
    addDuplicateIssue(
      value.unmatchedRightEntities,
      "unmatchedRightEntities",
      context,
    );
    addDuplicateIssue(value.ambiguousEntities, "ambiguousEntities", context);
    if (
      value.status === "aligned" &&
      (value.unmatchedLeftEntities.length > 0 ||
        value.unmatchedRightEntities.length > 0 ||
        value.ambiguousEntities.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "aligned comparison cannot contain unmatched or ambiguous entities",
        input: value.status,
      });
    }
    if (value.status === "unavailable" && value.clockUncertaintyUs !== null) {
      context.addIssue({
        code: "custom",
        path: ["clockUncertaintyUs"],
        message: "unavailable alignment cannot claim known clock uncertainty",
        input: value.clockUncertaintyUs,
      });
    }
    if (value.status === "aligned" && value.clockUncertaintyUs === null) {
      context.addIssue({
        code: "custom",
        path: ["clockUncertaintyUs"],
        message: "aligned comparison requires measured clock uncertainty",
        input: value.clockUncertaintyUs,
      });
    }
  });
export type VNextComparisonAlignmentV1 = z.infer<
  typeof VNextComparisonAlignmentV1Schema
>;

export const VNextComparisonConfounderV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    category: z.enum([
      "build",
      "adapter",
      "probe",
      "coverage",
      "checkpoint_fidelity",
      "clock",
      "trace",
      "runtime",
      "nondeterminism",
    ]),
    description: z.string().min(1),
    left: JsonValueSchema,
    right: JsonValueSchema,
  })
  .strict();
export type VNextComparisonConfounderV1 = z.infer<
  typeof VNextComparisonConfounderV1Schema
>;

export const VNextObservableDifferenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    category: z.enum([
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
    ]),
    subject: z.string().min(1),
    left: JsonValueSchema,
    right: JsonValueSchema,
    observability: z.enum(["full", "partial", "unavailable"]),
    clock: VNextClockPositionV1Schema.nullable(),
    details: nonEmptyStringArraySchema,
  })
  .strict();
export type VNextObservableDifferenceV1 = z.infer<
  typeof VNextObservableDifferenceV1Schema
>;

const sameStringSet = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  [...left].sort().every((entry, index) => entry === [...right].sort()[index]);

export const VNextComparisonV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    comparisonId: ComparisonIdSchema,
    mode: z.enum(["descriptive_only", "confounded"]),
    left: VNextComparisonExecutionRefV1Schema,
    right: VNextComparisonExecutionRefV1Schema,
    alignment: VNextComparisonAlignmentV1Schema,
    confounders: z.array(VNextComparisonConfounderV1Schema),
    differences: z.array(VNextObservableDifferenceV1Schema),
    firstDivergence: VNextFirstDivergenceV1Schema.nullable(),
    limitations: nonEmptyStringArraySchema,
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.left.executionId === value.right.executionId) {
      context.addIssue({
        code: "custom",
        path: ["right", "executionId"],
        message: "comparison requires two distinct executions",
        input: value.right.executionId,
      });
    }

    const categories = new Set(
      value.confounders.map((confounder) => confounder.category),
    );
    const requireConfounder = (
      condition: boolean,
      category: VNextComparisonConfounderV1["category"],
      path: PropertyKey,
    ): void => {
      if (condition && !categories.has(category)) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `${category} identity/coverage mismatch requires an explicit confounder`,
          input: value.right,
        });
      }
    };

    requireConfounder(
      value.left.buildId !== value.right.buildId ||
        value.left.sourceId !== value.right.sourceId,
      "build",
      "right",
    );
    requireConfounder(
      value.left.adapterId !== value.right.adapterId,
      "adapter",
      "right",
    );
    requireConfounder(
      !sameStringSet(value.left.probeIds, value.right.probeIds),
      "probe",
      "right",
    );
    requireConfounder(
      value.left.captureCoverageHash !== value.right.captureCoverageHash,
      "coverage",
      "right",
    );
    requireConfounder(
      value.left.checkpointId !== value.right.checkpointId ||
        value.left.checkpointFidelity !== value.right.checkpointFidelity,
      "checkpoint_fidelity",
      "right",
    );

    if (value.mode === "confounded" && value.confounders.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["confounders"],
        message:
          "confounded comparison requires at least one explicit confounder",
        input: value.confounders,
      });
    }
  });
export type VNextComparisonV1 = z.infer<typeof VNextComparisonV1Schema>;
