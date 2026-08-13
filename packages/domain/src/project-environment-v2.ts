import { z } from "zod";

import {
  AdapterCompatibilityReceiptV1Schema,
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
