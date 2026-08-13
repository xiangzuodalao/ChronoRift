import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const ResourceIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !value.includes(".."));
const bounds = {
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
const common = {
  schemaVersion: z.literal(1),
  runtimeProfile: z.literal("chronorift-managed-godot-project-environment-v1"),
  taskId: ResourceIdSchema,
  buildId: ResourceIdSchema,
  runtimeId: ResourceIdSchema,
  executionId: ResourceIdSchema,
  managedRuntimeId: z
    .string()
    .regex(/^managed-godot-project-environment:v1:[a-f0-9]{64}$/u),
  candidateSourceHash: Sha256Schema,
  ...bounds,
};

export const GodotProjectEnvironmentVanillaSmokeLaunchV1Schema = z
  .object({
    ...common,
    operation: z.literal("vanilla_smoke"),
    importTimeoutMs: z.number().int().min(1_000).max(120_000),
    vanillaTimeoutMs: z.number().int().min(2_001).max(60_000),
    stabilityWindowMs: z.literal(2_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.diagnosticTotalMaxBytes < value.diagnosticFrameMaxBytes + 4) {
      context.addIssue({
        code: "custom",
        path: ["diagnosticTotalMaxBytes"],
        message: "diagnostic total must hold a complete frame",
      });
    }
  });
export type GodotProjectEnvironmentVanillaSmokeLaunchV1 = z.infer<
  typeof GodotProjectEnvironmentVanillaSmokeLaunchV1Schema
>;

export const GodotProjectEnvironmentSidecarLaunchV1Schema = z
  .object({
    ...common,
    operation: z.literal("managed_lifecycle"),
    protocolProfile: z.literal("chronorift-godot-project-environment-v1"),
    protocolVersion: z.literal(1),
    token: Sha256Schema,
    overlayHash: Sha256Schema,
    addonHash: Sha256Schema,
    expectedMainScene: z
      .string()
      .min(1)
      .max(1_024)
      .refine(
        (value) => value.startsWith("res://") || value.startsWith("uid://"),
      ),
    instrumentationMode: z.enum(["bridge_only", "instrumented"]),
    sourceClosureId: ResourceIdSchema,
    environmentRevisionId: ResourceIdSchema,
    adapterRevisionId: ResourceIdSchema,
    adapterManifestSha256: Sha256Schema,
    sdkSha256: Sha256Schema,
    bridgeSha256: Sha256Schema,
    toolchainSha256: Sha256Schema,
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
        message: "diagnostic total must hold a complete frame",
      });
    }
  });
export type GodotProjectEnvironmentSidecarLaunchV1 = z.infer<
  typeof GodotProjectEnvironmentSidecarLaunchV1Schema
>;
