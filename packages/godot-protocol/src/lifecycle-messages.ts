import type { JsonValue } from "@chronorift/domain";
import { z } from "zod";

import { payloadHash } from "./messages.js";

export const GODOT_LIFECYCLE_PROTOCOL_PROFILE_V1 =
  "chronorift-godot-lifecycle-v1" as const;
export const GODOT_LIFECYCLE_PROTOCOL_VERSION_V1 = 1 as const;

export const GODOT_LIFECYCLE_READY_PROCESS_FRAME_DELTA_V1 = 120 as const;
export const GODOT_LIFECYCLE_READY_PHYSICS_TICK_DELTA_V1 = 120 as const;

export const GODOT_LIFECYCLE_CAPABILITIES_V1 = Object.freeze([
  "lifecycle.status",
  "lifecycle.shutdown",
  "clock.process_frame",
  "clock.physics_tick",
  "scene.identity",
] as const);

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const ResourceIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !value.includes(".."), {
    message: "lifecycle resource IDs are opaque and cannot contain traversal",
  });
const PrintableTextSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "lifecycle text must be a bounded single line",
  );
const SceneReferenceSchema = PrintableTextSchema.refine(
  (value) => value.startsWith("res://") || value.startsWith("uid://"),
  "scene reference must use the res:// or uid:// scheme",
);
const CounterSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const GodotLifecycleCapabilitiesV1Schema = z.tuple([
  z.literal(GODOT_LIFECYCLE_CAPABILITIES_V1[0]),
  z.literal(GODOT_LIFECYCLE_CAPABILITIES_V1[1]),
  z.literal(GODOT_LIFECYCLE_CAPABILITIES_V1[2]),
  z.literal(GODOT_LIFECYCLE_CAPABILITIES_V1[3]),
  z.literal(GODOT_LIFECYCLE_CAPABILITIES_V1[4]),
]);

export type GodotLifecycleCapabilitiesV1 = z.infer<
  typeof GodotLifecycleCapabilitiesV1Schema
>;

export const GodotLifecycleRuntimeIdentityV1Schema = z
  .object({
    taskId: ResourceIdSchema,
    buildId: ResourceIdSchema,
    runtimeId: ResourceIdSchema,
    executionId: ResourceIdSchema,
    managedRuntimeId: z
      .string()
      .regex(/^managed-godot-runtime:v1:[a-f0-9]{64}$/u),
    candidateSourceHash: Sha256Schema,
    overlayHash: Sha256Schema,
    addonHash: Sha256Schema,
  })
  .strict();

export type GodotLifecycleRuntimeIdentityV1 = z.infer<
  typeof GodotLifecycleRuntimeIdentityV1Schema
>;

export const GodotLifecycleFingerprintV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    protocolProfile: z.literal(GODOT_LIFECYCLE_PROTOCOL_PROFILE_V1),
    protocolVersion: z.literal(GODOT_LIFECYCLE_PROTOCOL_VERSION_V1),
    engine: z.literal("godot"),
    engineVersion: PrintableTextSchema.max(128),
    engineBuildHash: z
      .string()
      .max(128)
      .regex(/^[A-Za-z0-9._-]*$/u),
    adapterVersion: z.literal("0.4.0"),
    platform: PrintableTextSchema.max(128),
    renderer: PrintableTextSchema.max(128),
    displayServer: PrintableTextSchema.max(128),
    audioDriver: PrintableTextSchema.max(128),
    physicsTicksPerSecond: z.number().int().min(1).max(1_000),
    configuredMainScene: SceneReferenceSchema,
    capabilities: GodotLifecycleCapabilitiesV1Schema,
    identity: GodotLifecycleRuntimeIdentityV1Schema,
  })
  .strict();

export type GodotLifecycleFingerprintV1 = z.infer<
  typeof GodotLifecycleFingerprintV1Schema
>;

export const GodotLifecycleStatusSampleV1Schema = z
  .object({
    processFrames: CounterSchema,
    physicsFrames: CounterSchema,
    processTimeUs: CounterSchema,
    physicsTimeUs: CounterSchema,
    configuredMainScene: SceneReferenceSchema,
    currentScene: SceneReferenceSchema.nullable(),
  })
  .strict();

export type GodotLifecycleStatusSampleV1 = z.infer<
  typeof GodotLifecycleStatusSampleV1Schema
>;

const envelope = {
  schemaVersion: z.literal(1),
  protocolProfile: z.literal(GODOT_LIFECYCLE_PROTOCOL_PROFILE_V1),
  protocolVersion: z.literal(GODOT_LIFECYCLE_PROTOCOL_VERSION_V1),
  sequence: CounterSchema,
  requestId: ResourceIdSchema.optional(),
  payloadHash: Sha256Schema,
};

const ReadyPayloadSchema = z
  .object({
    baseline: GodotLifecycleStatusSampleV1Schema,
    observed: GodotLifecycleStatusSampleV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.observed.processFrames - value.baseline.processFrames <
      GODOT_LIFECYCLE_READY_PROCESS_FRAME_DELTA_V1
    ) {
      context.addIssue({
        code: "custom",
        path: ["observed", "processFrames"],
        message: "ready requires at least 120 observed process frames",
      });
    }
    if (
      value.observed.physicsFrames - value.baseline.physicsFrames <
      GODOT_LIFECYCLE_READY_PHYSICS_TICK_DELTA_V1
    ) {
      context.addIssue({
        code: "custom",
        path: ["observed", "physicsFrames"],
        message: "ready requires at least 120 observed physics ticks",
      });
    }
    if (value.observed.currentScene === null) {
      context.addIssue({
        code: "custom",
        path: ["observed", "currentScene"],
        message: "ready requires an instantiated current scene",
      });
    }
    if (
      value.baseline.configuredMainScene !== value.observed.configuredMainScene
    ) {
      context.addIssue({
        code: "custom",
        path: ["observed", "configuredMainScene"],
        message: "configured main scene changed during readiness sampling",
      });
    }
  });

const messageSchemas = [
  z
    .object({
      ...envelope,
      kind: z.literal("hello"),
      requestId: z.undefined().optional(),
      payload: z
        .object({
          token: Sha256Schema,
          fingerprint: GodotLifecycleFingerprintV1Schema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("hello_accept"),
      requestId: ResourceIdSchema,
      payload: z
        .object({
          requiredCapabilities: GodotLifecycleCapabilitiesV1Schema,
          minimumProcessFrameDelta: z.literal(
            GODOT_LIFECYCLE_READY_PROCESS_FRAME_DELTA_V1,
          ),
          minimumPhysicsTickDelta: z.literal(
            GODOT_LIFECYCLE_READY_PHYSICS_TICK_DELTA_V1,
          ),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("ready"),
      requestId: ResourceIdSchema,
      payload: ReadyPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("status"),
      requestId: ResourceIdSchema,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("status_result"),
      requestId: ResourceIdSchema,
      payload: GodotLifecycleStatusSampleV1Schema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("shutdown"),
      requestId: ResourceIdSchema,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("shutdown_ack"),
      requestId: ResourceIdSchema,
      payload: z
        .object({ status: GodotLifecycleStatusSampleV1Schema })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("error"),
      requestId: ResourceIdSchema.optional(),
      payload: z
        .object({
          code: z.enum([
            "AUTH_FAILED",
            "PROFILE_MISMATCH",
            "INVALID_COMMAND",
            "RUNTIME_FAILURE",
          ]),
          message: PrintableTextSchema.max(1_024),
        })
        .strict(),
    })
    .strict(),
] as const;

export const GodotLifecycleWireMessageSchema = z.discriminatedUnion("kind", [
  messageSchemas[0],
  messageSchemas[1],
  messageSchemas[2],
  messageSchemas[3],
  messageSchemas[4],
  messageSchemas[5],
  messageSchemas[6],
  messageSchemas[7],
]);

export type GodotLifecycleWireMessage = z.infer<
  typeof GodotLifecycleWireMessageSchema
>;
export type GodotLifecycleWireMessageKind = GodotLifecycleWireMessage["kind"];

export class GodotLifecycleWireProtocolError extends Error {
  public override readonly name = "GodotLifecycleWireProtocolError";
}

export const parseGodotLifecycleWireMessage = (
  json: string,
): GodotLifecycleWireMessage => {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch (error) {
    throw new GodotLifecycleWireProtocolError(
      "Lifecycle wire message is not valid JSON",
      { cause: error },
    );
  }
  const message = GodotLifecycleWireMessageSchema.parse(raw);
  if (payloadHash(message.payload) !== message.payloadHash) {
    throw new GodotLifecycleWireProtocolError(
      "Lifecycle wire message payload hash mismatch",
    );
  }
  return message;
};

export const makeGodotLifecycleWireMessage = (message: {
  readonly sequence: number;
  readonly kind: GodotLifecycleWireMessageKind;
  readonly requestId?: string | undefined;
  readonly payload: JsonValue;
}): GodotLifecycleWireMessage =>
  GodotLifecycleWireMessageSchema.parse({
    schemaVersion: 1,
    protocolProfile: GODOT_LIFECYCLE_PROTOCOL_PROFILE_V1,
    protocolVersion: GODOT_LIFECYCLE_PROTOCOL_VERSION_V1,
    ...message,
    payloadHash: payloadHash(message.payload),
  });
