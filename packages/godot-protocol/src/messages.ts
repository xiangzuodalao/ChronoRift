import { createHash } from "node:crypto";

import {
  CheckpointCertificateV1Schema,
  EnvironmentSnapshotSchema,
  JsonValueSchema,
  MicrosecondsSchema,
  RestoreValidationV1Schema,
  RuntimeCapabilitySchema,
  RuntimeFingerprintV1Schema,
  RuntimeStepReceiptV1Schema,
  StateSnapshotSchema,
  TickSchema,
  V01EnvironmentEventDraftSchema,
  type CheckpointCertificateV1,
  type EnvironmentSnapshot,
  type JsonValue,
  type RestoreValidationV1,
  type RuntimeCapability,
  type RuntimeFingerprintV1,
  type RuntimeStepReceiptV1,
  type StateSnapshot,
  type V01EnvironmentEventDraft,
} from "@chronorift/domain";
import { z } from "zod";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = {
  runId: z.string().min(1),
  branchId: z.string().min(1),
  executionId: z.string().min(1),
};
const envelope = {
  schemaVersion: z.literal(1),
  protocolVersion: z.literal(1),
  sequence: z.number().int().nonnegative(),
  requestId: z.string().min(1).optional(),
  payloadHash: HashSchema,
};

const RuntimeInputWireSchema = z
  .object({
    localId: z.string().min(1),
    order: z.number().int().nonnegative(),
    action: z.string().min(1),
    target: z.string().min(1).optional(),
    payload: z.record(z.string(), JsonValueSchema),
  })
  .strict();

const ProbePlanWireSchema = z
  .object({
    schemaVersion: z.literal(1),
    signals: z.array(
      z.object({ source: z.string().min(1), name: z.string().min(1) }).strict(),
    ),
    properties: z.array(z.string().min(1)),
  })
  .strict();

const messageSchemas = [
  z
    .object({
      ...envelope,
      kind: z.literal("hello"),
      payload: z
        .object({
          token: z.string().regex(/^[a-f0-9]{64}$/u),
          fingerprint: RuntimeFingerprintV1Schema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("hello_accept"),
      requestId: z.string().min(1),
      payload: z
        .object({
          requiredCapabilities: z.array(RuntimeCapabilitySchema),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("configure"),
      requestId: z.string().min(1),
      payload: z.object({ probePlan: ProbePlanWireSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("configured"),
      requestId: z.string().min(1),
      payload: z.object({ accepted: z.literal(true) }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("restore"),
      requestId: z.string().min(1),
      payload: z
        .object({
          snapshot: EnvironmentSnapshotSchema,
          certificate: CheckpointCertificateV1Schema.optional(),
          nextTick: TickSchema,
          simTimeUs: MicrosecondsSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("restored"),
      requestId: z.string().min(1),
      payload: z
        .object({
          restored: z.literal(true),
          nextTick: TickSchema,
          simTimeUs: MicrosecondsSchema,
          state: StateSnapshotSchema,
          runtimeValidation: RestoreValidationV1Schema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("step"),
      requestId: z.string().min(1),
      payload: z
        .object({
          tick: TickSchema,
          simTimeUs: MicrosecondsSchema,
          deltaUs: MicrosecondsSchema,
          inputs: z.array(RuntimeInputWireSchema),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("stepped"),
      requestId: z.string().min(1),
      payload: z
        .object({
          events: z.array(V01EnvironmentEventDraftSchema),
          state: StateSnapshotSchema,
          receipt: z
            .object({
              requestedTick: TickSchema,
              realizedTick: TickSchema,
              requestedDeltaUs: MicrosecondsSchema,
              realizedDeltaUs: MicrosecondsSchema,
              appliedInputOrders: z.array(z.number().int().nonnegative()),
              runtime: RuntimeStepReceiptV1Schema,
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("snapshot"),
      requestId: z.string().min(1),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("snapshot_result"),
      requestId: z.string().min(1),
      payload: z
        .object({
          snapshot: EnvironmentSnapshotSchema,
          certificate: CheckpointCertificateV1Schema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("shutdown"),
      requestId: z.string().min(1),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("shutdown_ack"),
      requestId: z.string().min(1),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("error"),
      requestId: z.string().min(1).optional(),
      payload: z
        .object({
          code: z.enum([
            "AUTH_FAILED",
            "CAPABILITY_UNSUPPORTED",
            "PROTOCOL_MISMATCH",
            "INVALID_COMMAND",
            "RESTORE_FAILED",
            "RUNTIME_FAILURE",
          ]),
          message: z.string().min(1),
          details: JsonValueSchema.optional(),
        })
        .strict(),
    })
    .strict(),
] as const;

export const GodotWireMessageSchema = z.discriminatedUnion("kind", [
  messageSchemas[0],
  messageSchemas[1],
  messageSchemas[2],
  messageSchemas[3],
  messageSchemas[4],
  messageSchemas[5],
  messageSchemas[6],
  messageSchemas[7],
  messageSchemas[8],
  messageSchemas[9],
  messageSchemas[10],
  messageSchemas[11],
  messageSchemas[12],
]);

export type GodotWireMessage = z.infer<typeof GodotWireMessageSchema>;
export type GodotWireMessageKind = GodotWireMessage["kind"];

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
};

export const payloadHash = (payload: JsonValue): string =>
  createHash("sha256").update(canonicalJson(payload)).digest("hex");

export class GodotWireProtocolError extends Error {
  public override readonly name = "GodotWireProtocolError";
}

export const parseGodotWireMessage = (json: string): GodotWireMessage => {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch (error) {
    throw new GodotWireProtocolError("Wire message is not valid JSON", {
      cause: error,
    });
  }
  const message = GodotWireMessageSchema.parse(raw);
  if (payloadHash(message.payload as JsonValue) !== message.payloadHash) {
    throw new GodotWireProtocolError("Wire message payload hash mismatch");
  }
  return message;
};

export const makeGodotWireMessage = (message: {
  readonly sequence: number;
  readonly kind: GodotWireMessageKind;
  readonly requestId?: string | undefined;
  readonly payload: JsonValue;
}): GodotWireMessage =>
  GodotWireMessageSchema.parse({
    schemaVersion: 1,
    protocolVersion: 1,
    ...message,
    payloadHash: payloadHash(message.payload),
  });

export interface GodotHelloIdentity {
  readonly token: string;
  readonly fingerprint: RuntimeFingerprintV1;
}

export interface GodotRestorePayload {
  readonly snapshot: EnvironmentSnapshot;
  readonly certificate?: CheckpointCertificateV1 | undefined;
  readonly nextTick: number;
  readonly simTimeUs: number;
}

export interface GodotStepResult {
  readonly events: readonly V01EnvironmentEventDraft[];
  readonly state: StateSnapshot;
  readonly receipt: {
    readonly requestedTick: number;
    readonly realizedTick: number;
    readonly requestedDeltaUs: number;
    readonly realizedDeltaUs: number;
    readonly appliedInputOrders: readonly number[];
    readonly runtime: RuntimeStepReceiptV1;
  };
}

export interface GodotRestoreResult {
  readonly restored: true;
  readonly nextTick: number;
  readonly simTimeUs: number;
  readonly state: StateSnapshot;
  readonly runtimeValidation?: RestoreValidationV1 | undefined;
}

export interface GodotLaunchIdentity {
  readonly runId: string;
  readonly branchId: string;
  readonly executionId: string;
}

export const GodotLaunchIdentitySchema = z.object(identity).strict();

export const hasCapabilities = (
  fingerprint: RuntimeFingerprintV1,
  required: readonly RuntimeCapability[],
): boolean => {
  const actual = new Set(fingerprint.capabilities);
  return required.every((capability) => actual.has(capability));
};
