import { z } from "zod";

import { Sha256DigestV1Schema } from "./hash.js";
import {
  AdapterIdSchema,
  BuildIdSchema,
  ExecutionIdSchema,
  ProbeIdSchema,
  RuntimeIdSchema,
  SourceIdSchema,
  TaskIdSchema,
  WorkspaceIdSchema,
} from "./ids.js";
import {
  VNextCaptureCoverageV1Schema,
  VNextCaptureLossV1Schema,
  VNextClockDomainV1Schema,
  VNextClockPositionV1Schema,
  VNextRawRuntimeEventV1Schema,
  validateVNextCaptureCoverageAndLoss,
} from "./vnext-runtime.js";

const timestampSchema = z.string().datetime({ offset: true });
const nonEmptyStringArraySchema = z
  .array(z.string().min(1))
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        message: "values must not contain duplicates",
        input: values,
      });
    }
  });

export const VNextLifecycleRequestedEnvironmentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    headless: z.literal(true),
    audioDriver: z.literal("Dummy"),
    renderingMethod: z.literal("gl_compatibility"),
    network: z.literal("isolated"),
    display: z.literal("denied"),
    gpu: z.literal("denied"),
  })
  .strict();
export type VNextLifecycleRequestedEnvironmentV1 = z.infer<
  typeof VNextLifecycleRequestedEnvironmentV1Schema
>;

export const VNextLifecycleIdentitySetV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    descriptorSha256: Sha256DigestV1Schema,
    sourceSha256: Sha256DigestV1Schema,
    buildSha256: Sha256DigestV1Schema,
    overlaySha256: Sha256DigestV1Schema,
    addonSha256: Sha256DigestV1Schema,
    vanillaSidecarSha256: Sha256DigestV1Schema,
    lifecycleSidecarSha256: Sha256DigestV1Schema,
    managedRuntimeId: z
      .string()
      .regex(/^managed-godot-runtime:v1:[a-f0-9]{64}$/u),
  })
  .strict();
export type VNextLifecycleIdentitySetV1 = z.infer<
  typeof VNextLifecycleIdentitySetV1Schema
>;

export const VNextLifecycleExecutionSealV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    executionId: ExecutionIdSchema,
    count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    headHash: Sha256DigestV1Schema.nullable(),
    byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    contentHash: Sha256DigestV1Schema,
  })
  .strict();
export type VNextLifecycleExecutionSealV1 = z.infer<
  typeof VNextLifecycleExecutionSealV1Schema
>;

export const VNextLifecycleExecutionManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    manifestKind: z.literal("lifecycle_execution"),
    taskId: TaskIdSchema,
    executionId: ExecutionIdSchema,
    runtimeId: RuntimeIdSchema,
    workspaceId: WorkspaceIdSchema,
    sourceId: SourceIdSchema,
    buildId: BuildIdSchema,
    adapterId: AdapterIdSchema,
    probeIds: z.array(ProbeIdSchema).min(1),
    stateSchemaVersion: z.literal("chronorift.lifecycle-shell:v1"),
    runtimeProfile: z.literal("godot-external-lifecycle-v1"),
    protocolProfile: z.literal("chronorift-godot-lifecycle-v1"),
    launchTarget: z.literal("project_main_scene"),
    requestedEnvironment: VNextLifecycleRequestedEnvironmentV1Schema,
    clockDomains: z.array(VNextClockDomainV1Schema).min(1),
    identities: VNextLifecycleIdentitySetV1Schema,
    executionSeal: VNextLifecycleExecutionSealV1Schema.nullable(),
    startedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.probeIds).size !== value.probeIds.length) {
      context.addIssue({
        code: "custom",
        path: ["probeIds"],
        message: "probe IDs must not contain duplicates",
        input: value.probeIds,
      });
    }
    if (new Set(value.clockDomains).size !== value.clockDomains.length) {
      context.addIssue({
        code: "custom",
        path: ["clockDomains"],
        message: "clock domains must not contain duplicates",
        input: value.clockDomains,
      });
    }
  });
export type VNextLifecycleExecutionManifestV1 = z.infer<
  typeof VNextLifecycleExecutionManifestV1Schema
>;

export const VNextBoundedStreamReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    totalBytes: z.number().int().nonnegative(),
    totalSha256: Sha256DigestV1Schema,
    retainedBytes: z.number().int().nonnegative().max(1_048_576),
    retainedSha256: Sha256DigestV1Schema,
    truncated: z.boolean(),
    droppedBytes: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.retainedBytes > value.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["retainedBytes"],
        message: "retained bytes cannot exceed total bytes",
        input: value.retainedBytes,
      });
    }
    if (value.droppedBytes !== value.totalBytes - value.retainedBytes) {
      context.addIssue({
        code: "custom",
        path: ["droppedBytes"],
        message: "dropped bytes must account for all unretained bytes",
        input: value.droppedBytes,
      });
    }
    if (value.truncated !== value.droppedBytes > 0) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "truncation must match whether bytes were dropped",
        input: value.truncated,
      });
    }
    if (
      value.droppedBytes === 0 &&
      value.retainedSha256 !== value.totalSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["retainedSha256"],
        message:
          "a fully retained stream must have the same total and retained digest",
        input: value.retainedSha256,
      });
    }
  });
export type VNextBoundedStreamReceiptV1 = z.infer<
  typeof VNextBoundedStreamReceiptV1Schema
>;

export const VNextLifecycleCleanupReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    processGroupTerminated: z.boolean(),
    godotExited: z.boolean(),
    sidecarExited: z.boolean(),
    cgroupEmpty: z.boolean(),
    scopeRemoved: z.boolean(),
    scratchRemoved: z.boolean(),
    storageReconciled: z.boolean(),
  })
  .strict();
export type VNextLifecycleCleanupReceiptV1 = z.infer<
  typeof VNextLifecycleCleanupReceiptV1Schema
>;

export const lifecycleCleanupProven = (
  value: VNextLifecycleCleanupReceiptV1,
): boolean =>
  value.processGroupTerminated &&
  value.godotExited &&
  value.sidecarExited &&
  value.cgroupEmpty &&
  value.scopeRemoved &&
  value.scratchRemoved &&
  value.storageReconciled;

export const VNextLifecycleObservationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    engineVersion: z.string().min(1),
    engineBuild: z.string().min(1),
    platform: z.string().min(1),
    renderer: z.string().min(1),
    audioDriver: z.string().min(1),
    headless: z.boolean(),
    configuredScene: z.string().min(1),
    currentScene: z.string().min(1),
    clock: VNextClockPositionV1Schema,
    processFrameDelta: z.number().int().nonnegative(),
    physicsTickDelta: z.number().int().nonnegative(),
    observedAt: timestampSchema,
  })
  .strict();
export type VNextLifecycleObservationV1 = z.infer<
  typeof VNextLifecycleObservationV1Schema
>;

export const VNextLifecyclePhaseReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().nonnegative(),
    phase: z.enum([
      "vanilla_import",
      "vanilla_smoke",
      "managed_import",
      "managed_handshake",
      "managed_status",
      "managed_stop",
    ]),
    operationId: z.string().min(1).max(256),
    operationState: z.enum(["not_started", "started", "unknown"]),
    timingFidelity: z.enum(["operation_bounds", "host_observed_bounds"]),
    processDurationMs: z.number().int().nonnegative().max(600_000).nullable(),
    stabilityObservedMs: z.number().int().min(2_000).max(60_000).nullable(),
    outcome: z.enum(["succeeded", "failed", "timed_out", "controlled_stop"]),
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    hostMonotonicStartUs: z.number().int().nonnegative(),
    hostMonotonicEndUs: z.number().int().nonnegative(),
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).nullable(),
    stdout: VNextBoundedStreamReceiptV1Schema,
    stderr: VNextBoundedStreamReceiptV1Schema,
    observation: VNextLifecycleObservationV1Schema.nullable(),
    cleanup: VNextLifecycleCleanupReceiptV1Schema.nullable(),
    knownSideEffects: nonEmptyStringArraySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "phase cannot end before it starts",
        input: value.endedAt,
      });
    }
    if (value.hostMonotonicEndUs < value.hostMonotonicStartUs) {
      context.addIssue({
        code: "custom",
        path: ["hostMonotonicEndUs"],
        message: "phase monotonic bounds cannot run backwards",
        input: value.hostMonotonicEndUs,
      });
    }
    if (value.stabilityObservedMs !== null && value.phase !== "vanilla_smoke") {
      context.addIssue({
        code: "custom",
        path: ["stabilityObservedMs"],
        message: "stability observation duration belongs only to vanilla smoke",
        input: value.stabilityObservedMs,
      });
    }
  });
export type VNextLifecyclePhaseReceiptV1 = z.infer<
  typeof VNextLifecyclePhaseReceiptV1Schema
>;

const lifecycleOperationPhases = (
  phases: readonly VNextLifecyclePhaseReceiptV1[],
  operation: "vanilla" | "managed",
): readonly VNextLifecyclePhaseReceiptV1[] =>
  phases.filter((phase) => phase.phase.startsWith(`${operation}_`));

export const lifecycleRequiredCleanupProven = (
  phases: readonly VNextLifecyclePhaseReceiptV1[],
): boolean =>
  (["vanilla", "managed"] as const).every((operation) => {
    const operationPhases = lifecycleOperationPhases(phases, operation);
    if (
      operationPhases.length === 0 ||
      operationPhases.every((phase) => phase.operationState === "not_started")
    ) {
      return true;
    }
    const latestCleanup = [...operationPhases]
      .reverse()
      .find((phase) => phase.cleanup !== null)?.cleanup;
    return latestCleanup != null && lifecycleCleanupProven(latestCleanup);
  });

const lifecycleRecordBase = {
  schemaVersion: z.literal(1),
  recordKind: z.literal("lifecycle_execution"),
  taskId: TaskIdSchema,
  executionId: ExecutionIdSchema,
  runtimeId: RuntimeIdSchema,
  buildId: BuildIdSchema,
  manifest: VNextLifecycleExecutionManifestV1Schema,
  phases: z.array(VNextLifecyclePhaseReceiptV1Schema),
  events: z.array(VNextRawRuntimeEventV1Schema),
  coverage: z.array(VNextCaptureCoverageV1Schema),
  loss: z.array(VNextCaptureLossV1Schema),
};

export const VNextLifecycleExecutionRecordV1Schema = z
  .discriminatedUnion("sealed", [
    z
      .object({
        ...lifecycleRecordBase,
        status: z.enum(["starting", "running", "cleanup_pending"]),
        sealed: z.literal(false),
      })
      .strict(),
    z
      .object({
        ...lifecycleRecordBase,
        status: z.enum(["stopped", "crashed", "failed"]),
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
        message: "manifest identities must match the lifecycle record",
        input: value.manifest,
      });
    }
    for (const [index, phase] of value.phases.entries()) {
      if (phase.sequence !== index) {
        context.addIssue({
          code: "custom",
          path: ["phases", index, "sequence"],
          message: "phase sequence must be contiguous from zero",
          input: phase.sequence,
        });
      }
    }
    if (value.sealed) {
      const executionSeal = value.manifest.executionSeal;
      if (
        executionSeal === null ||
        executionSeal.taskId !== value.taskId ||
        executionSeal.executionId !== value.executionId ||
        executionSeal.count !== value.events.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["manifest", "executionSeal"],
          message:
            "a sealed lifecycle record requires the matching raw event ledger seal",
          input: executionSeal,
        });
      }
      if (!lifecycleRequiredCleanupProven(value.phases)) {
        context.addIssue({
          code: "custom",
          path: ["phases"],
          message:
            "every started or start-unknown lifecycle operation requires a proven latest cleanup attempt before sealing",
          input: value.phases,
        });
      }
    }
    const eventIds = new Set<string>();
    for (const [index, event] of value.events.entries()) {
      if (
        event.sequence !== index ||
        event.taskId !== value.taskId ||
        event.executionId !== value.executionId ||
        event.runtimeId !== value.runtimeId ||
        event.buildId !== value.buildId
      ) {
        context.addIssue({
          code: "custom",
          path: ["events", index],
          message: "raw event sequence and provenance must match its execution",
          input: event,
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
        if (
          relation.targetEventId === event.eventId ||
          !eventIds.has(relation.targetEventId)
        ) {
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
              relation.targetEventId === event.eventId
                ? "raw event relation cannot target its own event"
                : "raw event relation target must exist in the same execution record",
            input: relation.targetEventId,
          });
        }
      }
    }
    validateVNextCaptureCoverageAndLoss(value.coverage, value.loss, context);
  });
export type VNextLifecycleExecutionRecordV1 = z.infer<
  typeof VNextLifecycleExecutionRecordV1Schema
>;
