import {
  GodotSemanticAdapterProfileV1Schema,
  VNextTimerSpawnProjectionV1Schema,
  type JsonValue,
} from "@chronorift/domain";
import { z } from "zod";

import { payloadHash } from "./messages.js";

export const GODOT_SEMANTIC_PROTOCOL_PROFILE_V1 =
  "chronorift-godot-semantic-v1" as const;
export const GODOT_SEMANTIC_PROTOCOL_VERSION_V1 = 1 as const;
export const GODOT_SEMANTIC_RUNTIME_PROFILE_V1 =
  "chronorift-managed-godot-semantic-v1" as const;

export const GODOT_SEMANTIC_CAPABILITIES_V1 = Object.freeze([
  "lifecycle.status",
  "lifecycle.shutdown",
  "clock.process_frame",
  "clock.physics_tick",
  "semantic.timer_spawn.query",
  "semantic.timer_spawn.checkpoint",
  "semantic.timer_spawn.restore",
] as const);

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const resourceId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !value.includes(".."), {
    message: "semantic resource IDs cannot contain traversal",
  });
const printable = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "semantic text must be a bounded single line",
  );

export const GodotSemanticCapabilitiesV1Schema = z.tuple([
  z.literal(GODOT_SEMANTIC_CAPABILITIES_V1[0]),
  z.literal(GODOT_SEMANTIC_CAPABILITIES_V1[1]),
  z.literal(GODOT_SEMANTIC_CAPABILITIES_V1[2]),
  z.literal(GODOT_SEMANTIC_CAPABILITIES_V1[3]),
  z.literal(GODOT_SEMANTIC_CAPABILITIES_V1[4]),
  z.literal(GODOT_SEMANTIC_CAPABILITIES_V1[5]),
  z.literal(GODOT_SEMANTIC_CAPABILITIES_V1[6]),
]);

export const GodotSemanticRuntimeIdentityV1Schema = z
  .object({
    taskId: resourceId,
    buildId: resourceId,
    runtimeId: resourceId,
    executionId: resourceId,
    managedRuntimeId: z
      .string()
      .regex(/^managed-godot-semantic-runtime:v1:[a-f0-9]{64}$/u),
    candidateSourceHash: sha256,
    adapterProfileSha256: sha256,
    overlayHash: sha256,
    addonHash: sha256,
  })
  .strict();
export type GodotSemanticRuntimeIdentityV1 = z.infer<
  typeof GodotSemanticRuntimeIdentityV1Schema
>;

export const GodotSemanticFingerprintV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    protocolProfile: z.literal(GODOT_SEMANTIC_PROTOCOL_PROFILE_V1),
    protocolVersion: z.literal(1),
    engine: z.literal("godot"),
    engineVersion: printable.max(128),
    engineBuildHash: z
      .string()
      .max(128)
      .regex(/^[A-Za-z0-9._-]*$/u),
    adapterVersion: z.literal("0.5.0"),
    platform: printable.max(128),
    renderer: printable.max(128),
    displayServer: printable.max(128),
    audioDriver: printable.max(128),
    physicsTicksPerSecond: z.number().int().min(1).max(1_000),
    configuredMainScene: printable,
    capabilities: GodotSemanticCapabilitiesV1Schema,
    identity: GodotSemanticRuntimeIdentityV1Schema,
  })
  .strict();
export type GodotSemanticFingerprintV1 = z.infer<
  typeof GodotSemanticFingerprintV1Schema
>;

export const GodotSemanticStatusSampleV1Schema = z
  .object({
    processFrames: counter,
    physicsFrames: counter,
    processTimeUs: counter,
    physicsTimeUs: counter,
    configuredMainScene: printable,
    currentScene: printable.nullable(),
    projection: VNextTimerSpawnProjectionV1Schema,
  })
  .strict();
export type GodotSemanticStatusSampleV1 = z.infer<
  typeof GodotSemanticStatusSampleV1Schema
>;

const envelope = {
  schemaVersion: z.literal(1),
  protocolProfile: z.literal(GODOT_SEMANTIC_PROTOCOL_PROFILE_V1),
  protocolVersion: z.literal(1),
  sequence: counter,
  requestId: resourceId.optional(),
  payloadHash: sha256,
} as const;

const schemas = [
  z
    .object({
      ...envelope,
      kind: z.literal("hello"),
      requestId: z.undefined().optional(),
      payload: z
        .object({
          token: sha256,
          fingerprint: GodotSemanticFingerprintV1Schema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("hello_accept"),
      requestId: resourceId,
      payload: z
        .object({
          requiredCapabilities: GodotSemanticCapabilitiesV1Schema,
          adapterProfile: GodotSemanticAdapterProfileV1Schema,
          adapterProfileSha256: sha256,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("ready"),
      requestId: resourceId,
      payload: GodotSemanticStatusSampleV1Schema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("status"),
      requestId: resourceId,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("status_result"),
      requestId: resourceId,
      payload: GodotSemanticStatusSampleV1Schema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("checkpoint_create"),
      requestId: resourceId,
      payload: z
        .object({ barrier: z.literal("adapter_process_tail") })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("checkpoint_result"),
      requestId: resourceId,
      payload: z
        .object({
          barrier: z.literal("adapter_process_tail"),
          projection: VNextTimerSpawnProjectionV1Schema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("checkpoint_restore"),
      requestId: resourceId,
      payload: z
        .object({ projection: VNextTimerSpawnProjectionV1Schema })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("checkpoint_restored"),
      requestId: resourceId,
      payload: z
        .object({
          restored: z.literal(true),
          projection: VNextTimerSpawnProjectionV1Schema,
          limitations: z.array(printable).min(1).max(32),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("shutdown"),
      requestId: resourceId,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("shutdown_ack"),
      requestId: resourceId,
      payload: z.object({ status: GodotSemanticStatusSampleV1Schema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("error"),
      requestId: resourceId.optional(),
      payload: z
        .object({
          code: z.enum([
            "AUTH_FAILED",
            "PROFILE_MISMATCH",
            "INVALID_COMMAND",
            "ADAPTER_FAILURE",
            "RESTORE_FAILED",
            "RUNTIME_FAILURE",
          ]),
          message: printable,
        })
        .strict(),
    })
    .strict(),
] as const;

export const GodotSemanticWireMessageSchema = z.discriminatedUnion("kind", [
  schemas[0],
  schemas[1],
  schemas[2],
  schemas[3],
  schemas[4],
  schemas[5],
  schemas[6],
  schemas[7],
  schemas[8],
  schemas[9],
  schemas[10],
  schemas[11],
]);
export type GodotSemanticWireMessage = z.infer<
  typeof GodotSemanticWireMessageSchema
>;
export type GodotSemanticWireMessageKind = GodotSemanticWireMessage["kind"];

export class GodotSemanticWireProtocolError extends Error {
  public override readonly name = "GodotSemanticWireProtocolError";
}

export const parseGodotSemanticWireMessage = (
  json: string,
): GodotSemanticWireMessage => {
  let input: unknown;
  try {
    input = JSON.parse(json) as unknown;
  } catch (error) {
    throw new GodotSemanticWireProtocolError(
      "Semantic wire message is not valid JSON",
      { cause: error },
    );
  }
  const message = GodotSemanticWireMessageSchema.parse(input);
  if (payloadHash(message.payload) !== message.payloadHash) {
    throw new GodotSemanticWireProtocolError(
      "Semantic wire message payload hash mismatch",
    );
  }
  return message;
};

export const makeGodotSemanticWireMessage = (message: {
  readonly sequence: number;
  readonly kind: GodotSemanticWireMessageKind;
  readonly requestId?: string | undefined;
  readonly payload: JsonValue;
}): GodotSemanticWireMessage =>
  GodotSemanticWireMessageSchema.parse({
    schemaVersion: 1,
    protocolProfile: GODOT_SEMANTIC_PROTOCOL_PROFILE_V1,
    protocolVersion: 1,
    ...message,
    payloadHash: payloadHash(message.payload),
  });
