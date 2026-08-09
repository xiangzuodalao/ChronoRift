import { JsonPrimitiveSchema, type JsonPrimitive } from "@chronorift/domain";
import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const ResourceIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !value.includes(".."), {
    message: "sidecar resource IDs are opaque and cannot contain traversal",
  });

export interface RuntimeSidecarLaunchV1 {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly buildId: string;
  readonly runtimeId: string;
  readonly executionId: string;
  readonly candidateSourceHash: string;
  readonly fixtureHash: string;
  readonly projectHash: string;
  readonly addonHash: string;
  readonly protocolVersion: 2;
  readonly token: string;
  readonly fixedFps: 60 | 120;
  readonly physicsTicksPerSecond: 60 | 120;
  readonly fixtureControls: Readonly<Record<string, JsonPrimitive>>;
  readonly startupTimeoutMs: number;
  readonly executionTimeoutMs: number;
  readonly diagnosticFrameMaxBytes: number;
  readonly diagnosticTotalMaxBytes: number;
  readonly diagnosticMaxCount: number;
}

export const RuntimeSidecarLaunchV1Schema: z.ZodType<RuntimeSidecarLaunchV1> = z
  .object({
    schemaVersion: z.literal(1),
    taskId: ResourceIdSchema,
    buildId: ResourceIdSchema,
    runtimeId: ResourceIdSchema,
    executionId: ResourceIdSchema,
    candidateSourceHash: Sha256Schema,
    fixtureHash: Sha256Schema,
    projectHash: Sha256Schema,
    addonHash: Sha256Schema,
    protocolVersion: z.literal(2),
    token: z.string().regex(/^[a-f0-9]{64}$/u),
    fixedFps: z.union([z.literal(60), z.literal(120)]),
    physicsTicksPerSecond: z.union([z.literal(60), z.literal(120)]),
    fixtureControls: z.record(z.string().min(1).max(128), JsonPrimitiveSchema),
    startupTimeoutMs: z.number().int().min(1_000).max(60_000),
    executionTimeoutMs: z.number().int().min(1_000).max(600_000),
    diagnosticFrameMaxBytes: z
      .number()
      .int()
      .min(1_024)
      .max(1024 * 1024),
    diagnosticTotalMaxBytes: z
      .number()
      .int()
      .min(4_096)
      .max(16 * 1024 * 1024),
    diagnosticMaxCount: z.number().int().min(1).max(4_096),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.diagnosticTotalMaxBytes < value.diagnosticFrameMaxBytes + 4) {
      context.addIssue({
        code: "custom",
        path: ["diagnosticTotalMaxBytes"],
        message: "diagnostic total bound must hold at least one full frame",
      });
    }
    if (
      Buffer.byteLength(JSON.stringify(value.fixtureControls), "utf8") >
      64 * 1024
    ) {
      context.addIssue({
        code: "custom",
        path: ["fixtureControls"],
        message: "fixture controls exceed the sidecar launch bound",
      });
    }
  });

export const RuntimeSidecarDiagnosticV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("stage_ready"),
      fixtureHash: Sha256Schema,
      projectHash: Sha256Schema,
      addonHash: Sha256Schema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("godot_started"),
      pid: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.enum(["godot_stdout", "godot_stderr"]),
      bytesBase64: z.string().max(2 * 1024 * 1024),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("godot_exit"),
      exitCode: z.number().int().nullable(),
      signal: z.string().min(1).max(64).nullable(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("candidate_process_failure"),
      candidateSourceHash: Sha256Schema,
      phase: z.enum(["before_runtime_connection", "runtime_connected"]),
      reason: z.literal("nonzero_exit"),
      exitCode: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("sidecar_error"),
      code: z.enum([
        "INVALID_LAUNCH",
        "MANAGED_RUNTIME_COLLISION",
        "BUILD_IDENTITY_MISMATCH",
        "GODOT_START_FAILED",
        "GODOT_CONNECTION_TIMEOUT",
        "GODOT_PROTOCOL_IO_FAILED",
        "DIAGNOSTIC_LIMIT_EXCEEDED",
      ]),
      message: z.string().min(1).max(4_096),
    })
    .strict(),
]);

export type RuntimeSidecarDiagnosticV1 = z.infer<
  typeof RuntimeSidecarDiagnosticV1Schema
>;
