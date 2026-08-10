import { z } from "zod";

import { Sha256DigestV1Schema } from "./hash.js";
import {
  AdapterIdSchema,
  BranchIdSchema,
  BuildIdSchema,
  CheckpointIdSchema,
  ComparisonIdSchema,
  ExecutionIdSchema,
  RuntimeIdSchema,
  SourceIdSchema,
  TaskIdSchema,
  TraceIdSchema,
  WorkspaceIdSchema,
} from "./ids.js";
import { JsonValueSchema } from "./json.js";

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const finite = z.number().finite();
const resourcePath = z
  .string()
  .min(7)
  .max(512)
  .startsWith("res://")
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.split("/").includes(".."),
    "semantic resource paths cannot traverse",
  );
const uniqueStrings = z
  .array(z.string().min(1))
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        message: "semantic lists must not contain duplicates",
        input: values,
      });
    }
  });

export const VNextSemanticClockPositionV1Schema = z
  .object({
    processFrame: counter,
    physicsTick: counter,
    simulationTimeUs: counter,
    hostMonotonicUs: counter.nullable(),
    renderFrame: z.null(),
  })
  .strict();

export const GodotSemanticAdapterProfileV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileKind: z.literal("chronorift-godot-semantic-adapter"),
    adapterKind: z.literal("timer_spawn_v1"),
    projectCapabilitySha256: Sha256DigestV1Schema,
    targetScene: resourcePath,
    spawnIntervalSeconds: z.number().finite().min(1).max(600),
    checkpointBarrier: z.literal("adapter_process_tail"),
    limits: z
      .object({
        activeRuntimesMaximum: z.literal(2),
        launchesPerTurnMaximum: z.literal(8),
        entityMaximum: z.literal(256),
        eventMaximum: z.literal(4096),
        rawSemanticBytesMaximum: z.literal(2_097_152),
        checkpointBytesMaximum: z.literal(1_048_576),
        traceSamplesMaximum: z.literal(32),
        traceTicksMaximum: z.literal(600),
        queryRowsMaximum: z.literal(200),
      })
      .strict(),
  })
  .strict();
export type GodotSemanticAdapterProfileV1 = z.infer<
  typeof GodotSemanticAdapterProfileV1Schema
>;

export const VNextSemanticVector2V1Schema = z
  .object({ x: finite, y: finite })
  .strict();
export const VNextSemanticTransform2DV1Schema = z
  .object({
    position: VNextSemanticVector2V1Schema,
    rotation: finite,
    scale: VNextSemanticVector2V1Schema,
  })
  .strict();

export const VNextSemanticTimerStateV1Schema = z
  .object({
    stableId: z.literal("semantic:timer"),
    incarnation: z.number().int().positive(),
    waitTimeSeconds: z.number().finite().nonnegative(),
    timeLeftSeconds: z.number().finite().nonnegative(),
    paused: z.boolean(),
    stopped: z.boolean(),
    oneShot: z.boolean(),
    autostart: z.boolean(),
    processCallback: z.enum(["physics", "idle"]),
    ignoreTimeScale: z.boolean(),
    timeoutOrdinal: counter,
  })
  .strict();

export const VNextSemanticSpawnedEntityStateV1Schema = z
  .object({
    stableId: z.string().regex(/^semantic:spawn:[0-9]+$/u),
    incarnation: z.number().int().positive(),
    spawnOrdinal: counter,
    scene: resourcePath,
    parentStableId: z.literal("semantic:harness"),
    transform: VNextSemanticTransform2DV1Schema,
    visible: z.boolean(),
    processMode: z.number().int().min(0).max(4),
    velocity: VNextSemanticVector2V1Schema.nullable(),
  })
  .strict();

export const VNextTimerSpawnProjectionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    stateSchemaVersion: z.literal("chronorift.timer-spawn:v1"),
    subject: z
      .object({
        stableId: z.literal("semantic:subject"),
        incarnation: z.number().int().positive(),
        targetScene: resourcePath,
        spawnIntervalSeconds: z.number().finite().min(1).max(600),
        spawnScene: resourcePath,
      })
      .strict(),
    timer: VNextSemanticTimerStateV1Schema,
    entities: z.array(VNextSemanticSpawnedEntityStateV1Schema).max(256),
    nextSpawnOrdinal: counter,
    capturedAt: VNextSemanticClockPositionV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const ordinals = value.entities.map((entity) => entity.spawnOrdinal);
    if (new Set(ordinals).size !== ordinals.length) {
      context.addIssue({
        code: "custom",
        path: ["entities"],
        message: "spawn ordinals must be unique",
        input: ordinals,
      });
    }
    if (ordinals.some((ordinal) => ordinal >= value.nextSpawnOrdinal)) {
      context.addIssue({
        code: "custom",
        path: ["nextSpawnOrdinal"],
        message: "nextSpawnOrdinal must exceed every captured entity ordinal",
        input: value.nextSpawnOrdinal,
      });
    }
  });
export type VNextTimerSpawnProjectionV1 = z.infer<
  typeof VNextTimerSpawnProjectionV1Schema
>;

export const VNextSemanticCheckpointPayloadV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    checkpointId: CheckpointIdSchema,
    executionId: ExecutionIdSchema,
    runtimeId: RuntimeIdSchema,
    buildId: BuildIdSchema,
    adapterId: AdapterIdSchema,
    adapterProfileSha256: Sha256DigestV1Schema,
    semanticBarrier: z.literal("adapter_process_tail"),
    projection: VNextTimerSpawnProjectionV1Schema,
    projectionSha256: Sha256DigestV1Schema,
    capturedDomains: uniqueStrings.min(4).max(16),
    uncontrolledDomains: uniqueStrings.min(1).max(32),
    restoreDependencyOrder: z.tuple([
      z.literal("subject.configuration"),
      z.literal("spawned_entities"),
      z.literal("timer.configuration"),
      z.literal("timer.runtime"),
    ]),
    fidelity: z.literal("descriptive_only"),
    equivalentForkEligible: z.literal(false),
  })
  .strict();
export type VNextSemanticCheckpointPayloadV1 = z.infer<
  typeof VNextSemanticCheckpointPayloadV1Schema
>;

export const VNextSemanticTraceSampleV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: counter,
    requestedOffset: z.number().int().min(1).max(600),
    realizedOffset: counter,
    quantized: z.boolean(),
    clock: VNextSemanticClockPositionV1Schema,
    projectionSha256: Sha256DigestV1Schema,
    projection: VNextTimerSpawnProjectionV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.quantized !== (value.realizedOffset !== value.requestedOffset)) {
      context.addIssue({
        code: "custom",
        path: ["quantized"],
        message: "trace quantization must match the realized offset",
        input: value.quantized,
      });
    }
  });

export const VNextSemanticTraceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    traceKind: z.literal("semantic_observation_trace"),
    taskId: TaskIdSchema,
    traceId: TraceIdSchema,
    sourceExecutionId: ExecutionIdSchema,
    sourceRuntimeId: RuntimeIdSchema,
    sourceBuildId: BuildIdSchema,
    adapterId: AdapterIdSchema,
    adapterProfileSha256: Sha256DigestV1Schema,
    clockDomain: z.enum(["process_frame", "physics_tick"]),
    origin: VNextSemanticClockPositionV1Schema,
    samples: z.array(VNextSemanticTraceSampleV1Schema).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [index, sample] of value.samples.entries()) {
      if (sample.sequence !== index) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "sequence"],
          message: "semantic trace sample sequence must be contiguous",
          input: sample.sequence,
        });
      }
      if (
        index > 0 &&
        sample.requestedOffset <= value.samples[index - 1]!.requestedOffset
      ) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "requestedOffset"],
          message: "semantic trace offsets must be strictly increasing",
          input: sample.requestedOffset,
        });
      }
    }
  });
export type VNextSemanticTraceV1 = z.infer<typeof VNextSemanticTraceV1Schema>;

export const VNextSemanticTraceReplayReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    traceId: TraceIdSchema,
    sourceExecutionId: ExecutionIdSchema,
    targetExecutionId: ExecutionIdSchema,
    sourceBuildId: BuildIdSchema,
    targetBuildId: BuildIdSchema,
    mode: z.enum(["same_build_projection_replay", "descriptive_only"]),
    status: z.enum(["completed", "stopped", "failed"]),
    realizedSamples: z.array(VNextSemanticTraceSampleV1Schema).max(32),
    firstDivergence: z
      .object({
        sequence: counter,
        subject: z.string().min(1),
        expected: JsonValueSchema,
        observed: JsonValueSchema,
      })
      .strict()
      .nullable(),
    limitations: uniqueStrings.min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const crossBuild = value.sourceBuildId !== value.targetBuildId;
    if (crossBuild && value.mode !== "descriptive_only") {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "cross-build semantic replay must be descriptive_only",
        input: value.mode,
      });
    }
  });
export type VNextSemanticTraceReplayReceiptV1 = z.infer<
  typeof VNextSemanticTraceReplayReceiptV1Schema
>;

export const VNextSemanticCoverageV1Schema = z
  .object({
    channel: z.enum(["clock", "state", "entity_lifecycle", "log", "error"]),
    status: z.enum(["full", "partial", "unavailable"]),
    emittedRecords: counter,
    droppedRecords: counter,
    limitations: uniqueStrings.max(32),
  })
  .strict();

export const VNextSemanticLossV1Schema = z
  .object({
    channel: z.string().min(1).max(128),
    kind: z.enum(["dropped", "truncated", "unavailable", "observer_effect"]),
    count: counter,
    reason: z.string().min(1).max(4_096),
  })
  .strict();

export const VNextSemanticExecutionSealV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    executionId: ExecutionIdSchema,
    count: counter,
    headHash: Sha256DigestV1Schema.nullable(),
    byteLength: counter,
    contentHash: Sha256DigestV1Schema,
  })
  .strict();

export const VNextSemanticObservationEventV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    eventKind: z.literal("semantic_observation"),
    taskId: TaskIdSchema,
    executionId: ExecutionIdSchema,
    runtimeId: RuntimeIdSchema,
    buildId: BuildIdSchema,
    sequence: counter,
    source: z.enum([
      "ready",
      "status",
      "checkpoint",
      "restore",
      "trace",
      "shutdown",
    ]),
    hostMonotonicStartUs: counter,
    hostMonotonicEndUs: counter,
    projectionSha256: Sha256DigestV1Schema,
    projection: VNextTimerSpawnProjectionV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.hostMonotonicEndUs < value.hostMonotonicStartUs) {
      context.addIssue({
        code: "custom",
        path: ["hostMonotonicEndUs"],
        message: "semantic observation Host bounds are reversed",
      });
    }
  });
export type VNextSemanticObservationEventV1 = z.infer<
  typeof VNextSemanticObservationEventV1Schema
>;

export const VNextSemanticRuntimeRecordV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeKind: z.literal("godot_external_semantic"),
    taskId: TaskIdSchema,
    runtimeId: RuntimeIdSchema,
    executionId: ExecutionIdSchema,
    buildId: BuildIdSchema,
    adapterId: AdapterIdSchema,
    adapterProfileSha256: Sha256DigestV1Schema,
    status: z.enum(["stopped", "crashed", "failed"]),
    finalProjectionSha256: Sha256DigestV1Schema,
    finalProjection: VNextTimerSpawnProjectionV1Schema,
    coverage: z.array(VNextSemanticCoverageV1Schema).max(5),
    loss: z.array(VNextSemanticLossV1Schema).max(64),
    cleanupProven: z.boolean(),
  })
  .strict();

export const VNextSemanticExecutionRecordV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    executionKind: z.literal("godot_external_semantic"),
    taskId: TaskIdSchema,
    executionId: ExecutionIdSchema,
    runtimeId: RuntimeIdSchema,
    workspaceId: WorkspaceIdSchema,
    sourceId: SourceIdSchema,
    buildId: BuildIdSchema,
    adapterId: AdapterIdSchema,
    adapterProfileSha256: Sha256DigestV1Schema,
    targetScene: resourcePath,
    stateSchemaVersion: z.literal("chronorift.timer-spawn:v1"),
    fidelity: z.literal("descriptive_only"),
    equivalentForkEligible: z.literal(false),
    eventCount: counter,
    coverage: z.array(VNextSemanticCoverageV1Schema).max(5),
    loss: z.array(VNextSemanticLossV1Schema).max(64),
    executionSeal: VNextSemanticExecutionSealV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.executionSeal.taskId !== value.taskId ||
      value.executionSeal.executionId !== value.executionId ||
      value.executionSeal.count !== value.eventCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["executionSeal"],
        message: "semantic execution seal is detached from its record",
      });
    }
  });

export const VNextSemanticCheckpointResourceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    resourceKind: z.literal("semantic_checkpoint"),
    checkpointId: CheckpointIdSchema,
    payload: VNextSemanticCheckpointPayloadV1Schema,
  })
  .strict();

export const VNextSemanticBranchResourceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    resourceKind: z.literal("semantic_branch"),
    taskId: TaskIdSchema,
    branchId: BranchIdSchema,
    sourceExecutionId: ExecutionIdSchema.nullable(),
    childExecutionId: ExecutionIdSchema,
    childRuntimeId: RuntimeIdSchema,
    targetBuildId: BuildIdSchema,
    checkpointId: CheckpointIdSchema.nullable(),
    traceId: TraceIdSchema.nullable(),
    mode: z.enum([
      "fresh",
      "checkpoint_projection_restore",
      "fresh_trace_replay",
    ]),
    fidelity: z.literal("descriptive_only"),
    limitations: uniqueStrings.min(1).max(64),
  })
  .strict();

export const VNextSemanticComparisonResourceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    resourceKind: z.literal("semantic_comparison"),
    taskId: TaskIdSchema,
    comparisonId: ComparisonIdSchema,
    baselineExecutionId: ExecutionIdSchema,
    candidateExecutionId: ExecutionIdSchema,
    mode: z.enum(["descriptive_only", "confounded"]),
    alignment: z.enum(["aligned", "partial", "unavailable"]),
    differences: z.array(JsonValueSchema).max(200),
    firstDivergenceSequence: counter.nullable(),
    confounders: uniqueStrings.max(64),
    limitations: uniqueStrings.min(1).max(64),
  })
  .strict();
