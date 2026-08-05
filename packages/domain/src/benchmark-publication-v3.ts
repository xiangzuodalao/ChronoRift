import { z } from "zod";

import { BenchmarkPublishedCaseEvidenceV2Schema } from "./benchmark-ledger.js";
import { Sha256V1Schema } from "./benchmark-v2.js";
import {
  BenchmarkCellAttemptV3Schema,
  BenchmarkCellResultV3Schema,
  BenchmarkProvenanceV3Schema,
} from "./benchmark-v3.js";
import {
  BenchmarkDefinitionIdSchema,
  BenchmarkExecutionIdSchema,
  BenchmarkSuiteIdSchema,
} from "./ids.js";

/**
 * Public, source-text-free projection for the preselected V3 benchmark case.
 *
 * The evidence projection intentionally reuses the already strict V2 public
 * evidence schema: its nested `schemaVersion: 2` describes that projection,
 * while this envelope and all benchmark identities are V3.
 */
export const BenchmarkPublishedCaseBundleV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    reportHash: Sha256V1Schema,
    selectionHash: Sha256V1Schema,
    suiteId: BenchmarkSuiteIdSchema,
    definitionId: BenchmarkDefinitionIdSchema,
    executionId: BenchmarkExecutionIdSchema,
    provenance: BenchmarkProvenanceV3Schema,
    caseStatus: z.enum(["absent", "present"]),
    cell: BenchmarkCellResultV3Schema.nullable(),
    attempt: BenchmarkCellAttemptV3Schema.nullable(),
    evidence: BenchmarkPublishedCaseEvidenceV2Schema,
    caseHash: Sha256V1Schema,
  })
  .strict()
  .superRefine((bundle, context) => {
    const present = bundle.cell !== null && bundle.attempt !== null;
    if ((bundle.caseStatus === "present") !== present) {
      context.addIssue({
        code: "custom",
        message: "Published V3 case status contradicts its cell and attempt",
        path: ["caseStatus"],
      });
    }
    if (
      bundle.cell !== null &&
      bundle.attempt !== null &&
      (bundle.cell.selectedAttemptId !== bundle.attempt.attemptId ||
        bundle.cell.cellId !== bundle.attempt.cellId ||
        bundle.cell.executionId !== bundle.executionId ||
        bundle.attempt.executionId !== bundle.executionId ||
        bundle.cell.definitionId !== bundle.definitionId ||
        bundle.attempt.definitionId !== bundle.definitionId ||
        bundle.cell.suiteId !== bundle.suiteId ||
        bundle.attempt.suiteId !== bundle.suiteId ||
        bundle.cell.fixtureId !== bundle.attempt.fixtureId ||
        bundle.cell.arm !== bundle.attempt.arm ||
        bundle.cell.repetition !== bundle.attempt.repetition)
    ) {
      context.addIssue({
        code: "custom",
        message: "Published V3 case attempt linkage is invalid",
        path: ["attempt"],
      });
    }
  });

export type BenchmarkPublishedCaseBundleV3 = z.infer<
  typeof BenchmarkPublishedCaseBundleV3Schema
>;
