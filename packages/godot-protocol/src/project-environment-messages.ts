import {
  ProjectStateDomainDispositionV1Schema,
  type JsonValue,
} from "@chronorift/domain";
import { z } from "zod";

import { payloadHash } from "./messages.js";
import {
  PROJECT_ADAPTER_CAPABILITY_MODULES_V1,
  ProjectAdapterCapabilityModulesV1Schema,
} from "./project-environment-manifest.js";
import {
  ProjectAdapterResourceReferenceV1Schema,
  ProjectAdapterStableIdV1Schema,
  ProjectAdapterValueV1Schema,
} from "./project-environment-values.js";

export const GODOT_PROJECT_ENVIRONMENT_PROTOCOL_PROFILE_V1 =
  "chronorift-godot-project-environment-v1" as const;
export const GODOT_PROJECT_ENVIRONMENT_PROTOCOL_VERSION_V1 = 1 as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const opaqueId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !value.includes(".."), {
    message: "wire resource IDs cannot contain traversal",
  });
const singleLine = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "wire text must be a bounded single line",
  );

export const GodotProjectEnvironmentRuntimeIdentityV1Schema = z
  .object({
    taskId: opaqueId,
    sourceClosureId: opaqueId,
    environmentRevisionId: opaqueId,
    adapterRevisionId: opaqueId,
    buildId: opaqueId,
    runtimeId: opaqueId,
    executionId: opaqueId,
    instrumentationMode: z.enum(["bridge_only", "instrumented"]),
    candidateSourceHash: sha256,
    adapterManifestSha256: sha256,
    sdkSha256: sha256,
    bridgeSha256: sha256,
    toolchainSha256: sha256,
  })
  .strict();
export type GodotProjectEnvironmentRuntimeIdentityV1 = z.infer<
  typeof GodotProjectEnvironmentRuntimeIdentityV1Schema
>;

export const GodotProjectEnvironmentClockV1Schema = z
  .object({
    processFrame: counter,
    physicsTick: counter,
    simulationTimeUs: counter,
    renderFrame: counter.nullable(),
  })
  .strict();
export type GodotProjectEnvironmentClockV1 = z.infer<
  typeof GodotProjectEnvironmentClockV1Schema
>;

export const GodotProjectEnvironmentCaptureCoverageV1Schema = z
  .object({
    status: z.enum(["complete", "partial", "unavailable"]),
    firstAvailableRecordSequence: counter.nullable(),
    lastAvailableRecordSequence: counter.nullable(),
    droppedRecordCount: counter,
    overwriteCount: counter,
    semanticCoverage: z.enum(["declared", "partial", "unknown"]),
  })
  .strict()
  .superRefine((coverage, context) => {
    if (
      (coverage.firstAvailableRecordSequence === null) !==
      (coverage.lastAvailableRecordSequence === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "capture coverage range must have both endpoints or neither",
      });
    }
    if (
      coverage.firstAvailableRecordSequence !== null &&
      coverage.lastAvailableRecordSequence !== null &&
      coverage.firstAvailableRecordSequence >
        coverage.lastAvailableRecordSequence
    ) {
      context.addIssue({
        code: "custom",
        message: "capture coverage range is reversed",
      });
    }
  });

export const GodotProjectEnvironmentStatusV1Schema = z
  .object({
    running: z.boolean(),
    configuredMainScene: ProjectAdapterResourceReferenceV1Schema,
    currentScene: ProjectAdapterResourceReferenceV1Schema.nullable(),
    clock: GodotProjectEnvironmentClockV1Schema,
    nextObservationRecordSequence: counter,
    coverage: GodotProjectEnvironmentCaptureCoverageV1Schema,
  })
  .strict();
export type GodotProjectEnvironmentStatusV1 = z.infer<
  typeof GodotProjectEnvironmentStatusV1Schema
>;

export const GodotProjectEnvironmentFingerprintV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    protocolProfile: z.literal(GODOT_PROJECT_ENVIRONMENT_PROTOCOL_PROFILE_V1),
    protocolVersion: z.literal(GODOT_PROJECT_ENVIRONMENT_PROTOCOL_VERSION_V1),
    engine: z.literal("godot"),
    engineVersion: singleLine.max(128),
    engineBuildHash: z
      .string()
      .max(128)
      .regex(/^[A-Za-z0-9._-]*$/u),
    platform: singleLine.max(128),
    renderer: z.literal("headless"),
    displayServer: z.literal("headless"),
    audioDriver: singleLine.max(128),
    physicsTicksPerSecond: z.number().int().min(1).max(1_000),
    configuredMainScene: ProjectAdapterResourceReferenceV1Schema,
    modules: ProjectAdapterCapabilityModulesV1Schema,
    identity: GodotProjectEnvironmentRuntimeIdentityV1Schema,
  })
  .strict();
export type GodotProjectEnvironmentFingerprintV1 = z.infer<
  typeof GodotProjectEnvironmentFingerprintV1Schema
>;

const observationEnvelope = {
  schemaVersion: z.literal(1),
  recordSequence: counter,
  clock: GodotProjectEnvironmentClockV1Schema,
} as const;

const observationRecords = [
  z
    .object({
      ...observationEnvelope,
      kind: z.literal("clock"),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...observationEnvelope,
      kind: z.literal("runtime_error"),
      payload: z
        .object({
          channel: z.enum(["engine", "script", "bridge", "process"]),
          severity: z.enum(["warning", "error", "fatal"]),
          code: ProjectAdapterStableIdV1Schema.nullable(),
          message: singleLine,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...observationEnvelope,
      kind: z.literal("entity_lifecycle"),
      payload: z
        .object({
          phase: z.enum(["appeared", "updated", "disappeared"]),
          entityId: opaqueId,
          entityTypeId: ProjectAdapterStableIdV1Schema,
          incarnation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
          identityScope: z.enum([
            "project_persistent",
            "authored",
            "spawn_lineage",
            "execution_local",
          ]),
          projection: ProjectAdapterValueV1Schema.nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...observationEnvelope,
      kind: z.literal("state_sample"),
      payload: z
        .object({
          stateDomainId: ProjectAdapterStableIdV1Schema,
          value: ProjectAdapterValueV1Schema,
          semanticCoverage: z.enum(["declared", "partial", "unknown"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...observationEnvelope,
      kind: z.literal("adapter_event"),
      payload: z
        .object({
          eventTypeId: ProjectAdapterStableIdV1Schema,
          sourceEntityId: opaqueId.nullable(),
          value: ProjectAdapterValueV1Schema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...observationEnvelope,
      kind: z.literal("capture_loss"),
      payload: z
        .object({
          channel: ProjectAdapterStableIdV1Schema,
          firstDroppedRecordSequence: counter,
          lastDroppedRecordSequence: counter,
          droppedRecordCount: z
            .number()
            .int()
            .min(1)
            .max(Number.MAX_SAFE_INTEGER),
          reason: z.enum([
            "buffer_overwrite",
            "backpressure",
            "sampling_degraded",
            "adapter_reported",
          ]),
        })
        .strict()
        .superRefine((loss, context) => {
          if (
            loss.lastDroppedRecordSequence < loss.firstDroppedRecordSequence
          ) {
            context.addIssue({
              code: "custom",
              message: "capture loss range is reversed",
            });
          }
          if (
            loss.lastDroppedRecordSequence -
              loss.firstDroppedRecordSequence +
              1 !==
            loss.droppedRecordCount
          ) {
            context.addIssue({
              code: "custom",
              message: "capture loss count does not match its range",
            });
          }
        }),
    })
    .strict(),
] as const;

export const GodotProjectEnvironmentObservationRecordV1Schema =
  z.discriminatedUnion("kind", [
    observationRecords[0],
    observationRecords[1],
    observationRecords[2],
    observationRecords[3],
    observationRecords[4],
    observationRecords[5],
  ]);
export type GodotProjectEnvironmentObservationRecordV1 = z.infer<
  typeof GodotProjectEnvironmentObservationRecordV1Schema
>;

const observationBatch = z
  .object({
    batchId: opaqueId,
    firstRecordSequence: counter,
    lastRecordSequence: counter,
    records: z
      .array(GodotProjectEnvironmentObservationRecordV1Schema)
      .min(1)
      .max(512),
    coverage: GodotProjectEnvironmentCaptureCoverageV1Schema,
  })
  .strict()
  .superRefine((batch, context) => {
    if (
      batch.lastRecordSequence - batch.firstRecordSequence + 1 !==
      batch.records.length
    ) {
      context.addIssue({
        code: "custom",
        message: "observation batch range is not contiguous",
      });
      return;
    }
    batch.records.forEach((record, index) => {
      if (record.recordSequence !== batch.firstRecordSequence + index) {
        context.addIssue({
          code: "custom",
          path: ["records", index, "recordSequence"],
          message: "observation record sequence is not contiguous",
        });
      }
    });
  });

const envelope = {
  schemaVersion: z.literal(1),
  protocolProfile: z.literal(GODOT_PROJECT_ENVIRONMENT_PROTOCOL_PROFILE_V1),
  protocolVersion: z.literal(GODOT_PROJECT_ENVIRONMENT_PROTOCOL_VERSION_V1),
  sequence: counter,
  requestId: opaqueId.optional(),
  payloadHash: sha256,
} as const;

const barrier = z.enum([
  "process_frame_end",
  "physics_tick_end",
  "render_complete",
]);
const controlPhase = z.enum(["process", "physics"]);
const duration = z
  .object({
    clock: z.enum(["process_frame", "physics_tick"]),
    count: z.number().int().min(1).max(600),
  })
  .strict();
const controlInput = z
  .object({
    controlId: ProjectAdapterStableIdV1Schema,
    parameters: ProjectAdapterValueV1Schema,
    phase: controlPhase,
    duration,
  })
  .strict();
const snapshotDomain = z
  .object({
    schemaVersion: z.literal(1),
    stateDomainId: ProjectAdapterStableIdV1Schema,
    disposition: ProjectStateDomainDispositionV1Schema,
    schemaId: ProjectAdapterStableIdV1Schema.nullable(),
    value: ProjectAdapterValueV1Schema.nullable(),
    limitations: z.array(singleLine).max(64),
  })
  .strict()
  .superRefine((domain, context) => {
    if (
      domain.disposition === "captured" &&
      (domain.schemaId === null || domain.value === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "captured snapshot domains require a schema and value",
      });
    }
    if (domain.disposition !== "captured" && domain.limitations.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["limitations"],
        message: "non-captured snapshot domains require a limitation",
      });
    }
  });
const restoreDomain = z
  .object({
    schemaVersion: z.literal(1),
    stateDomainId: ProjectAdapterStableIdV1Schema,
    status: z.enum([
      "written",
      "failed",
      "missing",
      "unsupported",
      "uncontrolled",
    ]),
    reportedValue: ProjectAdapterValueV1Schema.nullable(),
    knownSideEffects: z.array(singleLine).max(64),
    limitations: z.array(singleLine).max(64),
  })
  .strict()
  .superRefine((domain, context) => {
    if (domain.status !== "written" && domain.limitations.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["limitations"],
        message: "non-written restore domains require a limitation",
      });
    }
  });

const wireMessages = [
  z
    .object({
      ...envelope,
      kind: z.literal("hello"),
      requestId: z.undefined().optional(),
      payload: z
        .object({
          token: sha256,
          fingerprint: GodotProjectEnvironmentFingerprintV1Schema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("hello_accept"),
      requestId: opaqueId,
      payload: z
        .object({
          adapterManifestSha256: sha256,
          requiredModules: z
            .array(z.enum(PROJECT_ADAPTER_CAPABILITY_MODULES_V1))
            .min(1)
            .max(PROJECT_ADAPTER_CAPABILITY_MODULES_V1.length),
          observationWindowBatches: z.number().int().min(1).max(32),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("ready"),
      requestId: opaqueId,
      payload: GodotProjectEnvironmentStatusV1Schema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("status"),
      requestId: opaqueId,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("status_result"),
      requestId: opaqueId,
      payload: GodotProjectEnvironmentStatusV1Schema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("observation_batch"),
      requestId: z.undefined().optional(),
      payload: observationBatch,
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("observation_ack"),
      requestId: z.undefined().optional(),
      payload: z
        .object({
          batchId: opaqueId,
          acceptedThroughRecordSequence: counter,
          nextWindowBatches: z.number().int().min(1).max(32),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("query"),
      requestId: opaqueId,
      payload: z
        .object({
          queryKind: z.enum(["entities", "state", "events", "errors"]),
          ids: z.array(opaqueId).max(256),
          limit: z.number().int().min(1).max(512),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("query_result"),
      requestId: opaqueId,
      payload: z
        .object({
          rows: z.array(ProjectAdapterValueV1Schema).max(512),
          truncated: z.boolean(),
          coverage: GodotProjectEnvironmentCaptureCoverageV1Schema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("capture_configure"),
      requestId: opaqueId,
      payload: z
        .object({
          channels: z.array(ProjectAdapterStableIdV1Schema).min(1).max(64),
          rollingRecordLimit: z.number().int().min(1).max(65_536),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("capture_configured"),
      requestId: opaqueId,
      payload: z
        .object({
          channels: z.array(ProjectAdapterStableIdV1Schema).min(1).max(64),
          realizedRollingRecordLimit: z.number().int().min(1).max(65_536),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("barrier"),
      requestId: opaqueId,
      payload: z
        .object({
          barrier: z.enum([
            "process_frame_end",
            "physics_tick_end",
            "render_complete",
          ]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("barrier_reached"),
      requestId: opaqueId,
      payload: z
        .object({
          requestedBarrier: z.enum([
            "process_frame_end",
            "physics_tick_end",
            "render_complete",
          ]),
          realizedBarrier: z.enum([
            "process_frame_end",
            "physics_tick_end",
            "render_complete",
          ]),
          clock: GodotProjectEnvironmentClockV1Schema,
          quantizationDelayUs: counter,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("shutdown"),
      requestId: opaqueId,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("shutdown_ack"),
      requestId: opaqueId,
      payload: z
        .object({ status: GodotProjectEnvironmentStatusV1Schema })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("error"),
      requestId: opaqueId.optional(),
      payload: z
        .object({
          code: z.enum([
            "AUTH_FAILED",
            "IDENTITY_MISMATCH",
            "PROTOCOL_MISMATCH",
            "CAPABILITY_UNSUPPORTED",
            "INVALID_COMMAND",
            "ADAPTER_FAILURE",
            "RUNTIME_FAILURE",
            "BACKPRESSURE_VIOLATION",
          ]),
          message: singleLine,
          details: ProjectAdapterValueV1Schema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("input"),
      requestId: opaqueId,
      payload: controlInput,
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("input_applied"),
      requestId: opaqueId,
      payload: z
        .object({
          controlId: ProjectAdapterStableIdV1Schema,
          requestedPhase: controlPhase,
          realizedPhase: controlPhase,
          requestedDuration: duration,
          realizedDuration: duration,
          startClock: GodotProjectEnvironmentClockV1Schema,
          endClock: GodotProjectEnvironmentClockV1Schema,
          knownSideEffects: z.array(singleLine).max(64),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("controls_set"),
      requestId: opaqueId,
      payload: z
        .object({
          controls: z
            .array(
              z
                .object({
                  controlId: ProjectAdapterStableIdV1Schema,
                  parameters: ProjectAdapterValueV1Schema,
                  active: z.boolean(),
                })
                .strict(),
            )
            .min(1)
            .max(64)
            .refine(
              (controls) =>
                new Set(controls.map((control) => control.controlId)).size ===
                controls.length,
              "control IDs must be unique",
            ),
          requestedBarrier: barrier,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("controls_set_result"),
      requestId: opaqueId,
      payload: z
        .object({
          realizedControls: z
            .array(
              z
                .object({
                  controlId: ProjectAdapterStableIdV1Schema,
                  active: z.boolean(),
                  realizedParameters: ProjectAdapterValueV1Schema,
                })
                .strict(),
            )
            .min(1)
            .max(64),
          requestedBarrier: barrier,
          realizedBarrier: barrier,
          clock: GodotProjectEnvironmentClockV1Schema,
          quantizationDelayUs: counter,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("step"),
      requestId: opaqueId,
      payload: z
        .object({
          clock: z.enum(["process_frame", "physics_tick"]),
          count: z.number().int().min(1).max(600),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("stepped"),
      requestId: opaqueId,
      payload: z
        .object({
          requestedClock: z.enum(["process_frame", "physics_tick"]),
          requestedCount: z.number().int().min(1).max(600),
          realizedCount: z.number().int().min(1).max(600),
          startClock: GodotProjectEnvironmentClockV1Schema,
          endClock: GodotProjectEnvironmentClockV1Schema,
          quantizationDelayUs: counter,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("snapshot_create"),
      requestId: opaqueId,
      payload: z.object({ requestedBarrier: barrier }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("snapshot_result"),
      requestId: opaqueId,
      payload: z
        .object({
          snapshotId: opaqueId,
          requestedBarrier: barrier,
          realizedBarrier: barrier,
          clock: GodotProjectEnvironmentClockV1Schema,
          quantizationDelayUs: counter,
          domains: z
            .array(snapshotDomain)
            .min(1)
            .max(128)
            .refine(
              (domains) =>
                new Set(domains.map((domain) => domain.stateDomainId)).size ===
                domains.length,
              "snapshot state domain IDs must be unique",
            ),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("snapshot_restore"),
      requestId: opaqueId,
      payload: z
        .object({
          snapshotId: opaqueId,
          requestedBarrier: barrier,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("snapshot_restored"),
      requestId: opaqueId,
      payload: z
        .object({
          snapshotId: opaqueId,
          requestedBarrier: barrier,
          realizedBarrier: barrier,
          clock: GodotProjectEnvironmentClockV1Schema,
          quantizationDelayUs: counter,
          domains: z
            .array(restoreDomain)
            .min(1)
            .max(128)
            .refine(
              (domains) =>
                new Set(domains.map((domain) => domain.stateDomainId)).size ===
                domains.length,
              "restore state domain IDs must be unique",
            ),
        })
        .strict(),
    })
    .strict(),
] as const;

export const GodotProjectEnvironmentWireMessageV1Schema = z.discriminatedUnion(
  "kind",
  [
    wireMessages[0],
    wireMessages[1],
    wireMessages[2],
    wireMessages[3],
    wireMessages[4],
    wireMessages[5],
    wireMessages[6],
    wireMessages[7],
    wireMessages[8],
    wireMessages[9],
    wireMessages[10],
    wireMessages[11],
    wireMessages[12],
    wireMessages[13],
    wireMessages[14],
    wireMessages[15],
    wireMessages[16],
    wireMessages[17],
    wireMessages[18],
    wireMessages[19],
    wireMessages[20],
    wireMessages[21],
    wireMessages[22],
    wireMessages[23],
    wireMessages[24],
    wireMessages[25],
  ],
);
export type GodotProjectEnvironmentWireMessageV1 = z.infer<
  typeof GodotProjectEnvironmentWireMessageV1Schema
>;
export type GodotProjectEnvironmentWireMessageKindV1 =
  GodotProjectEnvironmentWireMessageV1["kind"];

export class GodotProjectEnvironmentWireProtocolError extends Error {
  public override readonly name = "GodotProjectEnvironmentWireProtocolError";
}

export const parseGodotProjectEnvironmentWireMessageV1 = (
  json: string,
): GodotProjectEnvironmentWireMessageV1 => {
  let input: unknown;
  try {
    input = JSON.parse(json) as unknown;
  } catch (error) {
    throw new GodotProjectEnvironmentWireProtocolError(
      "Project Environment wire message is not valid JSON",
      { cause: error },
    );
  }
  const message = GodotProjectEnvironmentWireMessageV1Schema.parse(input);
  if (payloadHash(message.payload as JsonValue) !== message.payloadHash) {
    throw new GodotProjectEnvironmentWireProtocolError(
      "Project Environment wire message payload hash mismatch",
    );
  }
  return message;
};

export const makeGodotProjectEnvironmentWireMessageV1 = (message: {
  readonly sequence: number;
  readonly kind: GodotProjectEnvironmentWireMessageKindV1;
  readonly requestId?: string | undefined;
  readonly payload: unknown;
}): GodotProjectEnvironmentWireMessageV1 =>
  GodotProjectEnvironmentWireMessageV1Schema.parse({
    schemaVersion: 1,
    protocolProfile: GODOT_PROJECT_ENVIRONMENT_PROTOCOL_PROFILE_V1,
    protocolVersion: GODOT_PROJECT_ENVIRONMENT_PROTOCOL_VERSION_V1,
    ...message,
    payloadHash: payloadHash(message.payload as JsonValue),
  });
