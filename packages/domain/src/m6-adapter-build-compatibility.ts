import { z } from "zod";

import { Sha256DigestV1Schema } from "./hash.js";
import { AdapterIdSchema, SourceIdSchema, type Id } from "./ids.js";
import {
  AdapterConformanceReceiptIdSchema,
  ProjectAdapterRevisionIdSchema,
  ProjectObservationCoverageV1Schema,
  ProjectObservationLossV1Schema,
  ProjectRuntimeCleanupReceiptV1Schema,
  ProjectToolchainReceiptIdSchema,
  projectRuntimeCleanupCompleteV1,
} from "./project-environment.js";
import { VNextBuildV1Schema } from "./vnext-runtime.js";

const timestampSchema = z.string().datetime({ offset: true });
const counterSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const boundedTextSchema = z.string().min(1).max(4_096);
const opaqueIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u)
  .refine((value) => !value.includes(".."), {
    message: "M6 identities are opaque and cannot contain path traversal",
  });

export type M6AdapterBuildCompatibilityReceiptId =
  Id<"M6AdapterBuildCompatibilityReceiptId">;
export type M6AdapterBuildBindingId = Id<"M6AdapterBuildBindingId">;

export const M6AdapterBuildCompatibilityReceiptIdSchema =
  opaqueIdSchema as unknown as z.ZodType<M6AdapterBuildCompatibilityReceiptId>;
export const M6AdapterBuildBindingIdSchema =
  opaqueIdSchema as unknown as z.ZodType<M6AdapterBuildBindingId>;

export const asM6AdapterBuildCompatibilityReceiptId = (
  value: string,
): M6AdapterBuildCompatibilityReceiptId =>
  M6AdapterBuildCompatibilityReceiptIdSchema.parse(value);
export const asM6AdapterBuildBindingId = (
  value: string,
): M6AdapterBuildBindingId => M6AdapterBuildBindingIdSchema.parse(value);

/**
 * Immutable adapter provenance used by M6. Its sourceId is the source against
 * which the adapter was authored and conformed, not the Task Build source.
 */
export const M6AdapterRevisionLineageV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    adapterRevisionId: ProjectAdapterRevisionIdSchema,
    adapterId: AdapterIdSchema,
    sourceId: SourceIdSchema,
    packageDigest: Sha256DigestV1Schema,
    manifestDigest: Sha256DigestV1Schema,
    implementationDigest: Sha256DigestV1Schema,
    payloadSchemaDigest: Sha256DigestV1Schema,
    sdkDigest: Sha256DigestV1Schema,
    bridgeDigest: Sha256DigestV1Schema,
    conformanceReceiptId: AdapterConformanceReceiptIdSchema,
  })
  .strict();
export type M6AdapterRevisionLineageV1 = z.infer<
  typeof M6AdapterRevisionLineageV1Schema
>;

export const M6AdapterBuildCompatibilityLineageV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    buildRole: z.enum(["assignment_baseline", "candidate"]),
    baselineSourceHash: Sha256DigestV1Schema,
    adapterRevision: M6AdapterRevisionLineageV1Schema,
    build: VNextBuildV1Schema,
    toolchain: z
      .object({
        schemaVersion: z.literal(1),
        toolchainReceiptId: ProjectToolchainReceiptIdSchema,
        artifactDigest: Sha256DigestV1Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.build.sourceId !== `source:${value.build.sourceHash}`) {
      context.addIssue({
        code: "custom",
        path: ["build", "sourceId"],
        message: "M6 Build sourceId must identify its exact selected-tree hash",
        input: value.build.sourceId,
      });
    }
    const unchanged = value.build.sourceHash === value.baselineSourceHash;
    if (
      (value.buildRole === "assignment_baseline" && !unchanged) ||
      (value.buildRole === "candidate" && unchanged)
    ) {
      context.addIssue({
        code: "custom",
        path: ["buildRole"],
        message:
          "M6 assignment baseline must equal the frozen baseline and a candidate must contain changed source bytes",
        input: value.buildRole,
      });
    }
  });
export type M6AdapterBuildCompatibilityLineageV1 = z.infer<
  typeof M6AdapterBuildCompatibilityLineageV1Schema
>;

const queryObservationsSchema = z
  .object({
    schemaVersion: z.literal(1),
    entityQueryObserved: z.boolean(),
    stateQueryObserved: z.boolean(),
    entityRows: counterSchema,
    stateRows: counterSchema,
  })
  .strict();

export const M6AdapterBuildCompatibilityReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: M6AdapterBuildCompatibilityReceiptIdSchema,
    lineage: M6AdapterBuildCompatibilityLineageV1Schema,
    bridgeHandshakeObserved: z.boolean(),
    instrumentedLaunchObserved: z.boolean(),
    queryObservations: queryObservationsSchema,
    coverage: z.array(ProjectObservationCoverageV1Schema).min(1).max(256),
    loss: z.array(ProjectObservationLossV1Schema).max(2_000),
    cleanup: ProjectRuntimeCleanupReceiptV1Schema,
    outcome: z.enum(["compatible", "incompatible"]),
    failures: z.array(boundedTextSchema).max(256),
    observedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const compatible =
      value.bridgeHandshakeObserved &&
      value.instrumentedLaunchObserved &&
      value.queryObservations.entityQueryObserved &&
      value.queryObservations.stateQueryObserved &&
      value.queryObservations.entityRows > 0 &&
      value.queryObservations.stateRows > 0 &&
      value.coverage.every(
        (entry) =>
          entry.status === "complete" &&
          entry.observedRecords > 0 &&
          entry.droppedRecords === 0 &&
          entry.overwrittenRecords === 0,
      ) &&
      value.loss.length === 0 &&
      projectRuntimeCleanupCompleteV1(value.cleanup) &&
      value.failures.length === 0;
    if ((value.outcome === "compatible") !== compatible) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message:
          "M6 compatibility outcome must match observed smoke, coverage, and cleanup facts",
        input: value.outcome,
      });
    }
    if (value.outcome === "incompatible" && value.failures.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["failures"],
        message: "M6 incompatible outcome requires an explicit failure",
        input: value.failures,
      });
    }
  });
export type M6AdapterBuildCompatibilityReceiptV1 = z.infer<
  typeof M6AdapterBuildCompatibilityReceiptV1Schema
>;

const bindingCommon = {
  schemaVersion: z.literal(1),
  bindingId: M6AdapterBuildBindingIdSchema,
  lineage: M6AdapterBuildCompatibilityLineageV1Schema,
  createdAt: timestampSchema,
} as const;

export const M6AdapterBuildCompatibilityBindingV1Schema = z
  .discriminatedUnion("compatibilityStatus", [
    z
      .object({
        ...bindingCommon,
        compatibilityStatus: z.literal("pending"),
        compatibilityReceiptId: z.null(),
        completedAt: z.null(),
      })
      .strict(),
    z
      .object({
        ...bindingCommon,
        compatibilityStatus: z.enum(["compatible", "incompatible"]),
        compatibilityReceiptId: M6AdapterBuildCompatibilityReceiptIdSchema,
        completedAt: timestampSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.completedAt !== null &&
      Date.parse(value.completedAt) < Date.parse(value.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "M6 compatibility binding cannot complete before creation",
        input: value.completedAt,
      });
    }
  });
export type M6AdapterBuildCompatibilityBindingV1 = z.infer<
  typeof M6AdapterBuildCompatibilityBindingV1Schema
>;
