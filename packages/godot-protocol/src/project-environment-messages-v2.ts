import { type JsonValue } from "@chronorift/domain";
import { z } from "zod";

import { payloadHash } from "./messages.js";
import { ProjectAdapterManifestV2Schema } from "./project-environment-manifest-v2.js";
import {
  ProjectAdapterEntityRefV2Schema,
  ProjectAdapterValueV2Schema,
} from "./project-environment-values-v2.js";
import { ProjectAdapterStableIdV1Schema } from "./project-environment-values.js";
import {
  GodotProjectEnvironmentCaptureCoverageV1Schema,
  GodotProjectEnvironmentClockV1Schema,
  GodotProjectEnvironmentRuntimeIdentityV1Schema,
} from "./project-environment-messages.js";

export const GODOT_PROJECT_ENVIRONMENT_PROTOCOL_PROFILE_V2 =
  "chronorift-godot-project-environment-v2" as const;
export const GODOT_PROJECT_ENVIRONMENT_PROTOCOL_VERSION_V2 = 2 as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const opaqueId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !value.includes(".."));
const singleLine = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => !/[\0\r\n]/u.test(value));

export const GodotProjectEnvironmentRuntimeIdentityV2Schema =
  GodotProjectEnvironmentRuntimeIdentityV1Schema.extend({
    observationProtocolVersion: z.literal(2),
    adapterSdkVersion: z.literal(2),
  }).strict();
export type GodotProjectEnvironmentRuntimeIdentityV2 = z.infer<
  typeof GodotProjectEnvironmentRuntimeIdentityV2Schema
>;

export const GodotProjectEnvironmentFingerprintV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    protocolProfile: z.literal(GODOT_PROJECT_ENVIRONMENT_PROTOCOL_PROFILE_V2),
    protocolVersion: z.literal(GODOT_PROJECT_ENVIRONMENT_PROTOCOL_VERSION_V2),
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
    configuredMainScene: z.string().min(7).max(1_024).startsWith("res://"),
    modules: ProjectAdapterManifestV2Schema.shape.modules,
    identity: GodotProjectEnvironmentRuntimeIdentityV2Schema,
  })
  .strict();
export type GodotProjectEnvironmentFingerprintV2 = z.infer<
  typeof GodotProjectEnvironmentFingerprintV2Schema
>;

const observationEnvelope = {
  schemaVersion: z.literal(2),
  executionId: opaqueId,
  recordSequence: counter,
  clock: GodotProjectEnvironmentClockV1Schema,
} as const;

export const GodotProjectEnvironmentObservationRecordV2Schema =
  z.discriminatedUnion("kind", [
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
            entity: ProjectAdapterEntityRefV2Schema,
            entityTypeId: ProjectAdapterStableIdV1Schema,
            identityScope: z.enum([
              "project_persistent",
              "authored",
              "spawn_lineage",
              "execution_local",
            ]),
            projection: ProjectAdapterValueV2Schema.nullable(),
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
            subjectEntity: ProjectAdapterEntityRefV2Schema.nullable(),
            value: ProjectAdapterValueV2Schema,
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
            sourceEntity: ProjectAdapterEntityRefV2Schema.nullable(),
            value: ProjectAdapterValueV2Schema,
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
          .strict(),
      })
      .strict(),
  ]);
export type GodotProjectEnvironmentObservationRecordV2 = z.infer<
  typeof GodotProjectEnvironmentObservationRecordV2Schema
>;

export const GodotProjectEnvironmentObservationBatchV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    executionId: opaqueId,
    batchId: opaqueId,
    firstRecordSequence: counter,
    lastRecordSequence: counter,
    records: z
      .array(GodotProjectEnvironmentObservationRecordV2Schema)
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
        message: "observation batch is not contiguous",
      });
    }
    batch.records.forEach((record, index) => {
      if (
        record.executionId !== batch.executionId ||
        record.recordSequence !== batch.firstRecordSequence + index
      ) {
        context.addIssue({
          code: "custom",
          path: ["records", index],
          message: "observation record has wrong execution or sequence",
        });
      }
    });
  });
export type GodotProjectEnvironmentObservationBatchV2 = z.infer<
  typeof GodotProjectEnvironmentObservationBatchV2Schema
>;

export const GodotProjectEnvironmentStatusV2Schema = z
  .object({
    running: z.boolean(),
    configuredMainScene: z.string().min(7).max(1_024).startsWith("res://"),
    currentScene: z.string().min(7).max(1_024).startsWith("res://").nullable(),
    clock: GodotProjectEnvironmentClockV1Schema,
    nextObservationRecordSequence: counter,
    coverage: GodotProjectEnvironmentCaptureCoverageV1Schema,
  })
  .strict();

const envelope = {
  schemaVersion: z.literal(2),
  protocolProfile: z.literal(GODOT_PROJECT_ENVIRONMENT_PROTOCOL_PROFILE_V2),
  protocolVersion: z.literal(GODOT_PROJECT_ENVIRONMENT_PROTOCOL_VERSION_V2),
  sequence: counter,
  requestId: opaqueId.optional(),
  payloadHash: sha256,
} as const;

const wireMessages = [
  z
    .object({
      ...envelope,
      kind: z.literal("hello"),
      requestId: z.undefined().optional(),
      payload: z
        .object({
          token: sha256,
          fingerprint: GodotProjectEnvironmentFingerprintV2Schema,
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
      payload: GodotProjectEnvironmentStatusV2Schema,
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
      payload: GodotProjectEnvironmentStatusV2Schema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("observation_batch"),
      requestId: z.undefined().optional(),
      payload: GodotProjectEnvironmentObservationBatchV2Schema,
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
        .object({ status: GodotProjectEnvironmentStatusV2Schema })
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
          details: ProjectAdapterValueV2Schema.optional(),
        })
        .strict(),
    })
    .strict(),
] as const;

export const GodotProjectEnvironmentWireMessageV2Schema = z.discriminatedUnion(
  "kind",
  wireMessages,
);
export type GodotProjectEnvironmentWireMessageV2 = z.infer<
  typeof GodotProjectEnvironmentWireMessageV2Schema
>;
export type GodotProjectEnvironmentWireMessageKindV2 =
  GodotProjectEnvironmentWireMessageV2["kind"];

export class GodotProjectEnvironmentWireProtocolV2Error extends Error {
  public override readonly name = "GodotProjectEnvironmentWireProtocolV2Error";
}

export const parseGodotProjectEnvironmentWireMessageV2 = (
  json: string,
): GodotProjectEnvironmentWireMessageV2 => {
  let input: unknown;
  try {
    input = JSON.parse(json) as unknown;
  } catch (error) {
    throw new GodotProjectEnvironmentWireProtocolV2Error(
      "V2 wire message is not JSON",
      { cause: error },
    );
  }
  const message = GodotProjectEnvironmentWireMessageV2Schema.parse(input);
  if (payloadHash(message.payload as JsonValue) !== message.payloadHash) {
    throw new GodotProjectEnvironmentWireProtocolV2Error(
      "V2 wire payload hash mismatch",
    );
  }
  return message;
};

export const makeGodotProjectEnvironmentWireMessageV2 = (message: {
  readonly sequence: number;
  readonly kind: GodotProjectEnvironmentWireMessageKindV2;
  readonly requestId?: string | undefined;
  readonly payload: unknown;
}): GodotProjectEnvironmentWireMessageV2 =>
  GodotProjectEnvironmentWireMessageV2Schema.parse({
    schemaVersion: 2,
    protocolProfile: GODOT_PROJECT_ENVIRONMENT_PROTOCOL_PROFILE_V2,
    protocolVersion: GODOT_PROJECT_ENVIRONMENT_PROTOCOL_VERSION_V2,
    ...message,
    payloadHash: payloadHash(message.payload as JsonValue),
  });
