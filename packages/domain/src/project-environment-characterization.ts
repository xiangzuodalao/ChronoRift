import { z } from "zod";

import { Sha256DigestV1Schema } from "./hash.js";
import { BuildIdSchema, RuntimeIdSchema } from "./ids.js";
import {
  ProjectAdapterRevisionIdSchema,
  ProjectEnvironmentTaskIdSchema,
  ProjectStateDomainDispositionV1Schema,
} from "./project-environment.js";

const boundedText = z.string().min(1).max(4_096);
const opaqueId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u)
  .refine((value) => !value.includes(".."), {
    message: "characterization identities are opaque and cannot traverse paths",
  });

export const ProjectSnapshotCharacterizationDomainV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    domainId: opaqueId,
    disposition: ProjectStateDomainDispositionV1Schema,
    expectedHash: Sha256DigestV1Schema.nullable(),
    mutatedHash: Sha256DigestV1Schema.nullable(),
    actualHash: Sha256DigestV1Schema.nullable(),
    mutationObserved: z.boolean(),
    restoreStatus: z.enum([
      "written",
      "failed",
      "missing",
      "unsupported",
      "uncontrolled",
    ]),
    missing: z.boolean(),
    mismatch: z.boolean(),
    limitations: z.array(boundedText).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.disposition !== "captured") {
      if (
        value.expectedHash !== null ||
        value.mutatedHash !== null ||
        value.actualHash !== null ||
        value.mutationObserved ||
        value.missing ||
        value.mismatch
      ) {
        context.addIssue({
          code: "custom",
          message:
            "only captured domains participate in snapshot hash comparison",
        });
      }
      return;
    }

    if (value.expectedHash === null) {
      context.addIssue({
        code: "custom",
        path: ["expectedHash"],
        message: "captured domains require an expected snapshot digest",
      });
      return;
    }
    const mutationObserved =
      value.mutatedHash !== null && value.mutatedHash !== value.expectedHash;
    if (value.mutationObserved !== mutationObserved) {
      context.addIssue({
        code: "custom",
        path: ["mutationObserved"],
        message: "mutationObserved must match the captured digest evidence",
      });
    }
    const missing = value.actualHash === null;
    if (value.missing !== missing) {
      context.addIssue({
        code: "custom",
        path: ["missing"],
        message: "missing must report an absent read-back digest",
      });
    }
    const mismatch =
      value.actualHash !== null && value.actualHash !== value.expectedHash;
    if (value.mismatch !== mismatch) {
      context.addIssue({
        code: "custom",
        path: ["mismatch"],
        message: "mismatch must match expected versus read-back digests",
      });
    }
    if (
      (value.restoreStatus !== "written" || missing || mismatch) &&
      value.limitations.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["limitations"],
        message: "restore or read-back gaps require an explicit limitation",
      });
    }
  });
export type ProjectSnapshotCharacterizationDomainV1 = z.infer<
  typeof ProjectSnapshotCharacterizationDomainV1Schema
>;

export const ProjectSnapshotFirstDivergenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    domainId: opaqueId,
    kind: z.enum(["missing", "mismatch"]),
    expectedHash: Sha256DigestV1Schema,
    actualHash: Sha256DigestV1Schema.nullable(),
    observation: z.literal("post_restore_read_back"),
    description: boundedText,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.kind === "missing") !== (value.actualHash === null)) {
      context.addIssue({
        code: "custom",
        path: ["actualHash"],
        message: "a missing divergence has no actual read-back digest",
      });
    }
    if (value.kind === "mismatch" && value.actualHash === value.expectedHash) {
      context.addIssue({
        code: "custom",
        path: ["actualHash"],
        message: "a mismatch requires distinct expected and actual digests",
      });
    }
  });
export type ProjectSnapshotFirstDivergenceV1 = z.infer<
  typeof ProjectSnapshotFirstDivergenceV1Schema
>;

export const ProjectSnapshotCharacterizationReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: opaqueId,
    taskId: ProjectEnvironmentTaskIdSchema,
    adapterRevisionId: ProjectAdapterRevisionIdSchema,
    buildId: BuildIdSchema,
    runtimeId: RuntimeIdSchema,
    executionId: opaqueId,
    initialSnapshotId: opaqueId,
    mutationSnapshotId: opaqueId,
    readBackSnapshotId: opaqueId,
    mutationId: opaqueId,
    requestedBarrierId: opaqueId,
    initialRealizedBarrierId: opaqueId,
    mutationRealizedBarrierId: opaqueId,
    restoreRealizedBarrierId: opaqueId,
    readBackRealizedBarrierId: opaqueId,
    controlledMutationObserved: z.boolean(),
    domains: z
      .array(ProjectSnapshotCharacterizationDomainV1Schema)
      .min(1)
      .max(128),
    firstDivergence: ProjectSnapshotFirstDivergenceV1Schema.nullable(),
    conclusion: z.literal("descriptive_only"),
    limitations: z.array(boundedText).min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const domainIds = value.domains.map((domain) => domain.domainId);
    if (new Set(domainIds).size !== domainIds.length) {
      context.addIssue({
        code: "custom",
        path: ["domains"],
        message: "characterization domains must be unique",
      });
    }
    if (
      new Set([
        value.initialSnapshotId,
        value.mutationSnapshotId,
        value.readBackSnapshotId,
      ]).size !== 3
    ) {
      context.addIssue({
        code: "custom",
        path: ["mutationSnapshotId"],
        message:
          "initial, mutation, and read-back snapshots require distinct identities",
      });
    }
    const mutationObserved = value.domains.some(
      (domain) => domain.mutationObserved,
    );
    if (value.controlledMutationObserved !== mutationObserved) {
      context.addIssue({
        code: "custom",
        path: ["controlledMutationObserved"],
        message:
          "controlledMutationObserved must match per-domain digest evidence",
      });
    }
    const first = value.domains.find(
      (domain) => domain.missing || domain.mismatch,
    );
    if (first === undefined && value.firstDivergence !== null) {
      context.addIssue({
        code: "custom",
        path: ["firstDivergence"],
        message: "a matching read-back cannot declare a first divergence",
      });
    } else if (
      first !== undefined &&
      (value.firstDivergence === null ||
        value.firstDivergence.domainId !== first.domainId ||
        value.firstDivergence.kind !==
          (first.missing ? "missing" : "mismatch") ||
        value.firstDivergence.expectedHash !== first.expectedHash ||
        value.firstDivergence.actualHash !== first.actualHash)
    ) {
      context.addIssue({
        code: "custom",
        path: ["firstDivergence"],
        message:
          "firstDivergence must identify the first missing or mismatched domain",
      });
    }
  });
export type ProjectSnapshotCharacterizationReceiptV1 = z.infer<
  typeof ProjectSnapshotCharacterizationReceiptV1Schema
>;
