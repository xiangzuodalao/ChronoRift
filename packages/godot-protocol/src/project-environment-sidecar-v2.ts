import { z } from "zod";

import { ProjectAdapterResourceReferenceV1Schema } from "./project-environment-values.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const resourceId = z
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
  schemaVersion: z.literal(2),
  runtimeProfile: z.literal("chronorift-managed-godot-project-environment-v2"),
  taskId: resourceId,
  buildId: resourceId,
  runtimeId: resourceId,
  executionId: resourceId,
  managedRuntimeId: z
    .string()
    .regex(/^managed-godot-project-environment:v2:[a-f0-9]{64}$/u),
  candidateSourceHash: sha256,
  ...bounds,
};

export const GodotProjectEnvironmentVanillaSmokeLaunchV2Schema = z
  .object({
    ...common,
    operation: z.literal("vanilla_smoke"),
    launchScene: ProjectAdapterResourceReferenceV1Schema.optional(),
    importTimeoutMs: z.number().int().min(1_000).max(120_000),
    vanillaTimeoutMs: z.number().int().min(2_001).max(60_000),
    stabilityWindowMs: z.literal(2_000),
  })
  .strict();
export type GodotProjectEnvironmentVanillaSmokeLaunchV2 = z.infer<
  typeof GodotProjectEnvironmentVanillaSmokeLaunchV2Schema
>;

export const GodotProjectEnvironmentSidecarLaunchV2Schema = z
  .object({
    ...common,
    operation: z.literal("managed_lifecycle"),
    protocolProfile: z.literal("chronorift-godot-project-environment-v2"),
    protocolVersion: z.literal(2),
    token: sha256,
    overlayHash: sha256,
    addonHash: sha256,
    expectedMainScene: z.string().min(7).max(1_024).startsWith("res://"),
    launchScene: ProjectAdapterResourceReferenceV1Schema.optional(),
    instrumentationMode: z.enum(["bridge_only", "instrumented"]),
    sourceClosureId: resourceId,
    environmentRevisionId: resourceId,
    adapterRevisionId: resourceId,
    adapterManifestSha256: sha256,
    sdkSha256: sha256,
    bridgeSha256: sha256,
    toolchainSha256: sha256,
    importTimeoutMs: z.number().int().min(1_000).max(120_000),
    startupTimeoutMs: z.number().int().min(1_000).max(60_000),
    executionTimeoutMs: z.number().int().min(1_000).max(600_000),
  })
  .strict();
export type GodotProjectEnvironmentSidecarLaunchV2 = z.infer<
  typeof GodotProjectEnvironmentSidecarLaunchV2Schema
>;
