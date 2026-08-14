import { z } from "zod";

import {
  AdapterCompatibilityReceiptV1Schema,
  AdapterConformanceReceiptIdSchema,
  AdapterConformanceReceiptV1Schema,
  ProjectEnvironmentPinnedCaptureV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
} from "./project-environment.js";
import { Sha256DigestV1Schema } from "./hash.js";
import { CaptureWindowIdSchema } from "./ids.js";

const opaqueId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !value.includes(".."));
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const launchTargetValidation = z
  .object({
    schemaVersion: z.literal(1),
    targetId: opaqueId,
    status: z.enum(["validated", "declared_unvalidated"]),
    conformanceReceiptId: AdapterConformanceReceiptIdSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.status === "validated") !==
      (value.conformanceReceiptId !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["conformanceReceiptId"],
        message:
          "validated launch targets must bind conformance and unvalidated targets cannot claim it",
      });
    }
  });

export const ProjectAdapterLaunchTargetValidationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal(
      "chronorift-project-adapter-launch-target-validation",
    ),
    defaultTargetId: opaqueId,
    selectedTargetId: opaqueId,
    targets: z.array(launchTargetValidation).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    const byId = new Map(
      value.targets.map((target) => [target.targetId, target]),
    );
    if (byId.size !== value.targets.length) {
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "launch-target validation identities must be unique",
      });
    }
    for (const [field, targetId] of [
      ["defaultTargetId", value.defaultTargetId],
      ["selectedTargetId", value.selectedTargetId],
    ] as const) {
      if (byId.get(targetId)?.status !== "validated") {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must reference a validated launch target`,
        });
      }
    }
  });
export type ProjectAdapterLaunchTargetValidationV1 = z.infer<
  typeof ProjectAdapterLaunchTargetValidationV1Schema
>;

const selectedTargetObservationRecordsPath =
  "records/dynamic-projection-conformance.v2.json" as const;
const selectedTargetObservationChainPath =
  "records/dynamic-projection-chain.v2.json" as const;
const defaultTargetObservationRecordsPath =
  "records/dynamic-projection-conformance.default.v2.json" as const;
const defaultTargetObservationChainPath =
  "records/dynamic-projection-chain.default.v2.json" as const;

const launchTargetConformanceEvidence = z
  .object({
    schemaVersion: z.literal(1),
    targetId: opaqueId,
    vanillaDigest: Sha256DigestV1Schema,
    bridgeOnlyDigest: Sha256DigestV1Schema,
    instrumentedDigest: Sha256DigestV1Schema,
    rawObservationRecordsPath: z.enum([
      selectedTargetObservationRecordsPath,
      defaultTargetObservationRecordsPath,
    ]),
    rawObservationRecordsSha256: Sha256DigestV1Schema,
    rawObservationChainPath: z.enum([
      selectedTargetObservationChainPath,
      defaultTargetObservationChainPath,
    ]),
    rawObservationChainSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedChainPath =
      value.rawObservationRecordsPath === selectedTargetObservationRecordsPath
        ? selectedTargetObservationChainPath
        : defaultTargetObservationChainPath;
    if (value.rawObservationChainPath !== expectedChainPath) {
      context.addIssue({
        code: "custom",
        path: ["rawObservationChainPath"],
        message:
          "launch-target conformance record and chain paths must use the same path pair",
      });
    }
  });

export const ProjectAdapterLaunchTargetConformanceEvidenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal(
      "chronorift-project-adapter-launch-target-conformance",
    ),
    conformanceReceiptId: AdapterConformanceReceiptIdSchema,
    defaultTargetId: opaqueId,
    selectedTargetId: opaqueId,
    targets: z.array(launchTargetConformanceEvidence).min(1).max(2),
  })
  .strict()
  .superRefine((value, context) => {
    const targetIds = new Set(value.targets.map((target) => target.targetId));
    if (targetIds.size !== value.targets.length) {
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "launch-target conformance identities must be unique",
      });
    }
    const paths = value.targets.flatMap((target) => [
      target.rawObservationRecordsPath,
      target.rawObservationChainPath,
    ]);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "launch-target conformance artifact paths must be unique",
      });
    }
    for (const [field, targetId] of [
      ["defaultTargetId", value.defaultTargetId],
      ["selectedTargetId", value.selectedTargetId],
    ] as const) {
      if (!targetIds.has(targetId)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must reference retained launch-target conformance evidence`,
        });
      }
    }
  });
export type ProjectAdapterLaunchTargetConformanceEvidenceV1 = z.infer<
  typeof ProjectAdapterLaunchTargetConformanceEvidenceV1Schema
>;
const dynamicTrace = z
  .object({
    schemaVersion: z.literal(2),
    traceId: opaqueId,
    entityId: opaqueId,
    firstIncarnation: z.number().int().min(1),
    lastIncarnation: z.number().int().min(2),
    recordSequences: z.array(counter).length(9),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.lastIncarnation !== value.firstIncarnation + 1 ||
      value.recordSequences.some(
        (entry, index) =>
          index > 0 && entry <= (value.recordSequences[index - 1] ?? -1),
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "dynamic trace must contain exactly two consecutive incarnations and increasing records",
      });
    }
  });

export const ProjectEnvironmentDynamicObservationChainV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    recordKind: z.literal(
      "chronorift-project-environment-dynamic-observation-chain",
    ),
    taskId: opaqueId,
    executionId: opaqueId,
    adapterRevisionId: opaqueId,
    manifestSha256: Sha256DigestV1Schema,
    recordCount: z.number().int().positive(),
    firstRecordSequence: counter,
    lastRecordSequence: counter,
    recordsSha256: Sha256DigestV1Schema,
    traces: z.array(dynamicTrace).min(1).max(32),
    lossless: z.literal(true),
  })
  .strict()
  .refine(
    (value) =>
      value.lastRecordSequence - value.firstRecordSequence + 1 ===
      value.recordCount,
    "dynamic chain sequence range must match its record count",
  );
export type ProjectEnvironmentDynamicObservationChainV2 = z.infer<
  typeof ProjectEnvironmentDynamicObservationChainV2Schema
>;

const withoutKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> => {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
};

export const AdapterConformanceReceiptV2Schema = z
  .object({
    ...AdapterConformanceReceiptV1Schema.shape,
    schemaVersion: z.literal(2),
    observationProtocolVersion: z.literal(2),
    adapterSdkVersion: z.literal(2),
    rawObservationChainPath: z.literal(
      "records/dynamic-projection-conformance.v2.json",
    ),
    rawObservationChainSha256: Sha256DigestV1Schema,
    dynamicTraces: z.array(dynamicTrace).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    const base = withoutKeys(value, [
      "observationProtocolVersion",
      "adapterSdkVersion",
      "rawObservationChainPath",
      "rawObservationChainSha256",
      "dynamicTraces",
    ]);
    if (
      !AdapterConformanceReceiptV1Schema.safeParse({
        ...base,
        schemaVersion: 1,
      }).success
    ) {
      context.addIssue({
        code: "custom",
        message: "V2 conformance must satisfy every PE-A conformance invariant",
      });
    }
  });
export type AdapterConformanceReceiptV2 = z.infer<
  typeof AdapterConformanceReceiptV2Schema
>;

export const AdapterCompatibilityReceiptV2Schema = z
  .object({
    ...AdapterCompatibilityReceiptV1Schema.shape,
    schemaVersion: z.literal(2),
    launchTargetId: opaqueId,
    observationProtocolVersion: z.literal(2),
    adapterSdkVersion: z.literal(2),
    eventQueryObserved: z.boolean(),
    eventRows: counter,
    dynamicCaptureWindowId: CaptureWindowIdSchema,
    dynamicTraces: z.array(dynamicTrace).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    const base = withoutKeys(value, [
      "launchTargetId",
      "observationProtocolVersion",
      "adapterSdkVersion",
      "eventQueryObserved",
      "eventRows",
      "dynamicCaptureWindowId",
      "dynamicTraces",
    ]);
    if (
      !AdapterCompatibilityReceiptV1Schema.safeParse({
        ...base,
        schemaVersion: 1,
      }).success
    ) {
      context.addIssue({
        code: "custom",
        message:
          "V2 compatibility must satisfy every PE-A compatibility invariant",
      });
    }
    if (!value.eventQueryObserved || value.eventRows === 0) {
      context.addIssue({
        code: "custom",
        path: ["eventRows"],
        message: "V2 compatibility requires a nonempty validated event query",
      });
    }
    if (value.outcome === "compatible" && value.dynamicTraces.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["dynamicTraces"],
        message: "V2 compatibility requires a recognized dynamic trace",
      });
    }
  });
export type AdapterCompatibilityReceiptV2 = z.infer<
  typeof AdapterCompatibilityReceiptV2Schema
>;

export const ProjectEnvironmentPinnedCaptureV2Schema = z
  .object({
    ...ProjectEnvironmentPinnedCaptureV1Schema.shape,
    schemaVersion: z.literal(2),
    observationProtocolVersion: z.literal(2),
    recordsSchemaVersion: z.literal(2),
    dynamicTraces: z.array(dynamicTrace).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    const base = withoutKeys(value, [
      "observationProtocolVersion",
      "recordsSchemaVersion",
      "dynamicTraces",
    ]);
    if (
      !ProjectEnvironmentPinnedCaptureV1Schema.safeParse({
        ...base,
        schemaVersion: 1,
      }).success
    ) {
      context.addIssue({
        code: "custom",
        message: "V2 capture must satisfy every PE-A pinned-capture invariant",
      });
    }
  });
export type ProjectEnvironmentPinnedCaptureV2 = z.infer<
  typeof ProjectEnvironmentPinnedCaptureV2Schema
>;

export const ProjectEnvironmentRuntimeObservationReceiptV2Schema = z
  .object({
    ...ProjectEnvironmentRuntimeObservationReceiptV1Schema.shape,
    schemaVersion: z.literal(2),
    observationProtocolVersion: z.literal(2),
    adapterSdkVersion: z.literal(2),
    validatedRecordCount: z.number().int().positive(),
    eventQueryCount: counter,
    eventRows: counter,
    stickyPoisoned: z.boolean(),
    dynamicTraces: z.array(dynamicTrace).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    const base = withoutKeys(value, [
      "observationProtocolVersion",
      "adapterSdkVersion",
      "validatedRecordCount",
      "eventQueryCount",
      "eventRows",
      "stickyPoisoned",
      "dynamicTraces",
    ]);
    if (
      !ProjectEnvironmentRuntimeObservationReceiptV1Schema.safeParse({
        ...base,
        schemaVersion: 1,
      }).success
    ) {
      context.addIssue({
        code: "custom",
        message:
          "V2 runtime observation must satisfy every PE-A runtime-observation invariant",
      });
    }
    const dynamicSucceeded =
      value.outcome === "succeeded" &&
      !value.stickyPoisoned &&
      value.dynamicTraces.length > 0 &&
      value.eventQueryCount > 0 &&
      value.eventRows > 0;
    if ((value.outcome === "succeeded") !== dynamicSucceeded)
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message:
          "V2 runtime success requires a validated dynamic trace and no sticky poison",
      });
  });
export type ProjectEnvironmentRuntimeObservationReceiptV2 = z.infer<
  typeof ProjectEnvironmentRuntimeObservationReceiptV2Schema
>;
