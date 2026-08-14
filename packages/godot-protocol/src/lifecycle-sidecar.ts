import { z } from "zod";

import {
  GODOT_LIFECYCLE_PROTOCOL_PROFILE_V1,
  GODOT_LIFECYCLE_PROTOCOL_VERSION_V1,
} from "./lifecycle-messages.js";

export const GODOT_LIFECYCLE_RUNTIME_PROFILE_V1 =
  "chronorift-managed-godot-lifecycle-v1" as const;
export const GODOT_LIFECYCLE_VANILLA_STABILITY_WINDOW_MS_V1 = 2_000 as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const ResourceIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !value.includes(".."), {
    message: "lifecycle sidecar resource IDs cannot contain traversal",
  });
const BoundedSingleLineSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\n") && !value.includes("\r"),
    "sidecar diagnostic text must be a single line",
  );
const diagnosticBoundsShape = {
  diagnosticFrameMaxBytes: z
    .number()
    .int()
    .min(1_024)
    .max(1024 * 1024),
  diagnosticTotalMaxBytes: z
    .number()
    .int()
    .min(16 * 1024)
    .max(16 * 1024 * 1024),
  diagnosticMaxCount: z.number().int().min(16).max(4_096),
  outputCaptureMaxBytes: z
    .number()
    .int()
    .min(1_024)
    .max(1024 * 1024),
};

const commonLaunchShape = {
  schemaVersion: z.literal(1),
  runtimeProfile: z.literal(GODOT_LIFECYCLE_RUNTIME_PROFILE_V1),
  taskId: ResourceIdSchema,
  buildId: ResourceIdSchema,
  runtimeId: ResourceIdSchema,
  executionId: ResourceIdSchema,
  managedRuntimeId: z
    .string()
    .regex(/^managed-godot-runtime:v1:[a-f0-9]{64}$/u),
  candidateSourceHash: Sha256Schema,
  ...diagnosticBoundsShape,
};

export const GodotLifecycleVanillaSmokeLaunchV1Schema = z
  .object({
    ...commonLaunchShape,
    operation: z.literal("vanilla_smoke"),
    importTimeoutMs: z.number().int().min(1_000).max(120_000),
    vanillaTimeoutMs: z.number().int().min(2_000).max(60_000),
    stabilityWindowMs: z.literal(
      GODOT_LIFECYCLE_VANILLA_STABILITY_WINDOW_MS_V1,
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.vanillaTimeoutMs <= value.stabilityWindowMs) {
      context.addIssue({
        code: "custom",
        path: ["vanillaTimeoutMs"],
        message: "vanilla timeout must exceed the stability window",
      });
    }
    if (value.diagnosticTotalMaxBytes < value.diagnosticFrameMaxBytes + 4) {
      context.addIssue({
        code: "custom",
        path: ["diagnosticTotalMaxBytes"],
        message: "diagnostic total must hold at least one complete frame",
      });
    }
  });

export type GodotLifecycleVanillaSmokeLaunchV1 = z.infer<
  typeof GodotLifecycleVanillaSmokeLaunchV1Schema
>;

export const GodotLifecycleSidecarLaunchV1Schema = z
  .object({
    ...commonLaunchShape,
    operation: z.literal("managed_lifecycle"),
    protocolProfile: z.literal(GODOT_LIFECYCLE_PROTOCOL_PROFILE_V1),
    protocolVersion: z.literal(GODOT_LIFECYCLE_PROTOCOL_VERSION_V1),
    token: Sha256Schema,
    overlayHash: Sha256Schema,
    addonHash: Sha256Schema,
    expectedMainScene: z
      .string()
      .min(1)
      .max(1_024)
      .refine(
        (value) => value.startsWith("res://") || value.startsWith("uid://"),
        "expected main scene must use the res:// or uid:// scheme",
      ),
    importTimeoutMs: z.number().int().min(1_000).max(120_000),
    startupTimeoutMs: z.number().int().min(1_000).max(60_000),
    executionTimeoutMs: z.number().int().min(1_000).max(600_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.diagnosticTotalMaxBytes < value.diagnosticFrameMaxBytes + 4) {
      context.addIssue({
        code: "custom",
        path: ["diagnosticTotalMaxBytes"],
        message: "diagnostic total must hold at least one complete frame",
      });
    }
  });

export type GodotLifecycleSidecarLaunchV1 = z.infer<
  typeof GodotLifecycleSidecarLaunchV1Schema
>;

export const GodotLifecycleStreamReceiptV1Schema = z
  .object({
    totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: Sha256Schema,
    retainedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(1024 * 1024),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.retainedBytes > value.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["retainedBytes"],
        message: "retained bytes cannot exceed total bytes",
      });
    }
    if (value.truncated !== value.retainedBytes < value.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "stream truncation must match retained coverage",
      });
    }
  });

export type GodotLifecycleStreamReceiptV1 = z.infer<
  typeof GodotLifecycleStreamReceiptV1Schema
>;

export const GodotLifecycleProcessReceiptV1Schema = z
  .object({
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).max(64).nullable(),
    timedOut: z.boolean(),
    durationMs: z.number().int().nonnegative().max(600_000),
    stdout: GodotLifecycleStreamReceiptV1Schema,
    stderr: GodotLifecycleStreamReceiptV1Schema,
  })
  .strict();

export type GodotLifecycleProcessReceiptV1 = z.infer<
  typeof GodotLifecycleProcessReceiptV1Schema
>;

const ProcessOutputDiagnosticSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("process_output"),
    phase: z.enum(["import", "vanilla", "managed_import", "managed"]),
    stream: z.enum(["stdout", "stderr"]),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    bytesBase64: z.string().max(2 * 1024 * 1024),
  })
  .strict();

const SourceVerifiedDiagnosticSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("source_verified"),
    phase: z.enum(["import", "vanilla", "managed_import", "managed"]),
    candidateSourceHash: Sha256Schema,
    fileCount: z.number().int().nonnegative().max(4_096),
    byteLength: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1024 * 1024),
  })
  .strict();

const SidecarErrorDiagnosticSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("sidecar_error"),
    phase: z.enum([
      "launch",
      "stage",
      "import",
      "vanilla",
      "managed_import",
      "managed",
      "protocol",
      "cleanup",
    ]),
    code: z.enum([
      "INVALID_LAUNCH",
      "MANAGED_RUNTIME_COLLISION",
      "UNSUPPORTED_SOURCE_FEATURE",
      "BUILD_IDENTITY_MISMATCH",
      "PHASE_PROCESS_REMAINED",
      "GODOT_START_FAILED",
      "GODOT_IMPORT_FAILED",
      "VANILLA_EXITED_EARLY",
      "GODOT_CONNECTION_TIMEOUT",
      "GODOT_PROTOCOL_IO_FAILED",
      "GODOT_RUNTIME_FAILED",
      "EXECUTION_TIMEOUT",
      "INTERNAL_FAILURE",
    ]),
    message: BoundedSingleLineSchema,
  })
  .strict();

export const GodotLifecycleVanillaSmokeDiagnosticV1Schema =
  z.discriminatedUnion("kind", [
    z
      .object({
        schemaVersion: z.literal(1),
        kind: z.literal("stage_ready"),
        candidateSourceHash: Sha256Schema,
        fileCount: z.number().int().nonnegative().max(4_096),
        byteLength: z
          .number()
          .int()
          .nonnegative()
          .max(256 * 1024 * 1024),
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        kind: z.literal("phase_started"),
        phase: z.enum(["import", "vanilla"]),
        pid: z.number().int().positive(),
      })
      .strict(),
    ProcessOutputDiagnosticSchema,
    SourceVerifiedDiagnosticSchema,
    z
      .object({
        schemaVersion: z.literal(1),
        kind: z.literal("smoke_failed"),
        candidateSourceHash: Sha256Schema,
        fileCount: z.number().int().nonnegative().max(4_096),
        byteLength: z
          .number()
          .int()
          .nonnegative()
          .max(256 * 1024 * 1024),
        failedPhase: z.enum(["import", "vanilla"]),
        import: GodotLifecycleProcessReceiptV1Schema,
        vanilla: GodotLifecycleProcessReceiptV1Schema.nullable(),
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        kind: z.literal("smoke_complete"),
        candidateSourceHash: Sha256Schema,
        fileCount: z.number().int().nonnegative().max(4_096),
        byteLength: z
          .number()
          .int()
          .nonnegative()
          .max(256 * 1024 * 1024),
        stabilityObservedMs: z.number().int().min(2_000).max(60_000),
        import: GodotLifecycleProcessReceiptV1Schema,
        vanilla: GodotLifecycleProcessReceiptV1Schema,
      })
      .strict(),
    SidecarErrorDiagnosticSchema,
  ]);

export type GodotLifecycleVanillaSmokeDiagnosticV1 = z.infer<
  typeof GodotLifecycleVanillaSmokeDiagnosticV1Schema
>;

export const GodotLifecycleSidecarDiagnosticV1Schema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        schemaVersion: z.literal(1),
        kind: z.literal("stage_ready"),
        candidateSourceHash: Sha256Schema,
        overlayHash: Sha256Schema,
        addonHash: Sha256Schema,
        fileCount: z.number().int().nonnegative().max(4_096),
        byteLength: z
          .number()
          .int()
          .nonnegative()
          .max(256 * 1024 * 1024),
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
        kind: z.literal("phase_started"),
        phase: z.literal("managed_import"),
        pid: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        kind: z.literal("managed_import_result"),
        outcome: z.enum(["succeeded", "failed"]),
        receipt: GodotLifecycleProcessReceiptV1Schema,
      })
      .strict(),
    ProcessOutputDiagnosticSchema,
    SourceVerifiedDiagnosticSchema,
    z
      .object({
        schemaVersion: z.literal(1),
        kind: z.literal("stream_summary"),
        stream: z.enum(["stdout", "stderr"]),
        receipt: GodotLifecycleStreamReceiptV1Schema,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        kind: z.literal("godot_exit"),
        exitCode: z.number().int().nullable(),
        signal: z.string().min(1).max(64).nullable(),
        timedOut: z.boolean(),
      })
      .strict(),
    SidecarErrorDiagnosticSchema,
  ],
);

export type GodotLifecycleSidecarDiagnosticV1 = z.infer<
  typeof GodotLifecycleSidecarDiagnosticV1Schema
>;
