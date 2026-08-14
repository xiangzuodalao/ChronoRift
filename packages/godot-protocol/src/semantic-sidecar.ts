import { z } from "zod";

import {
  GODOT_SEMANTIC_PROTOCOL_PROFILE_V1,
  GODOT_SEMANTIC_RUNTIME_PROFILE_V1,
} from "./semantic-messages.js";

export {
  GodotLifecycleSidecarDiagnosticV1Schema as GodotSemanticSidecarDiagnosticV1Schema,
  GodotLifecycleVanillaSmokeDiagnosticV1Schema as GodotSemanticVanillaSmokeDiagnosticV1Schema,
  type GodotLifecycleSidecarDiagnosticV1 as GodotSemanticSidecarDiagnosticV1,
  type GodotLifecycleVanillaSmokeDiagnosticV1 as GodotSemanticVanillaSmokeDiagnosticV1,
} from "./lifecycle-sidecar.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const resourceId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !value.includes(".."));
const diagnosticBounds = {
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
} as const;
const common = {
  schemaVersion: z.literal(1),
  runtimeProfile: z.literal(GODOT_SEMANTIC_RUNTIME_PROFILE_V1),
  taskId: resourceId,
  buildId: resourceId,
  runtimeId: resourceId,
  executionId: resourceId,
  managedRuntimeId: z
    .string()
    .regex(/^managed-godot-semantic-runtime:v1:[a-f0-9]{64}$/u),
  candidateSourceHash: sha256,
  ...diagnosticBounds,
} as const;

const checkDiagnosticTotal = (
  value: { diagnosticTotalMaxBytes: number; diagnosticFrameMaxBytes: number },
  context: z.RefinementCtx,
): void => {
  if (value.diagnosticTotalMaxBytes < value.diagnosticFrameMaxBytes + 4) {
    context.addIssue({
      code: "custom",
      path: ["diagnosticTotalMaxBytes"],
      message: "diagnostic total must hold one complete frame",
    });
  }
};

export const GodotSemanticVanillaSmokeLaunchV1Schema = z
  .object({
    ...common,
    operation: z.literal("vanilla_smoke"),
    importTimeoutMs: z.number().int().min(1_000).max(120_000),
    vanillaTimeoutMs: z.number().int().min(2_000).max(60_000),
    stabilityWindowMs: z.literal(2_000),
  })
  .strict()
  .superRefine((value, context) => {
    checkDiagnosticTotal(value, context);
    if (value.vanillaTimeoutMs <= value.stabilityWindowMs) {
      context.addIssue({
        code: "custom",
        path: ["vanillaTimeoutMs"],
        message: "vanilla timeout must exceed the stability window",
      });
    }
  });
export type GodotSemanticVanillaSmokeLaunchV1 = z.infer<
  typeof GodotSemanticVanillaSmokeLaunchV1Schema
>;

export const GodotSemanticSidecarLaunchV1Schema = z
  .object({
    ...common,
    operation: z.literal("managed_lifecycle"),
    protocolProfile: z.literal(GODOT_SEMANTIC_PROTOCOL_PROFILE_V1),
    protocolVersion: z.literal(1),
    token: sha256,
    overlayHash: sha256,
    addonHash: sha256,
    adapterProfileSha256: sha256,
    expectedMainScene: z
      .string()
      .min(1)
      .max(1_024)
      .refine(
        (value) => value.startsWith("res://") || value.startsWith("uid://"),
      ),
    importTimeoutMs: z.number().int().min(1_000).max(120_000),
    startupTimeoutMs: z.number().int().min(1_000).max(60_000),
    executionTimeoutMs: z.number().int().min(1_000).max(600_000),
  })
  .strict()
  .superRefine(checkDiagnosticTotal);
export type GodotSemanticSidecarLaunchV1 = z.infer<
  typeof GodotSemanticSidecarLaunchV1Schema
>;
