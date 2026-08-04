import { z } from "zod";

import {
  BranchIdSchema,
  EvaluationIdSchema,
  EvidenceIdSchema,
  ReportIdSchema,
  RunIdSchema,
  type BranchId,
  type EvaluationId,
  type EvidenceId,
  type ReportId,
  type RunId,
} from "./ids.js";
import { JsonValueSchema, type JsonValue } from "./json.js";

export interface SuspectedLocation {
  readonly path: string;
  readonly symbol?: string | undefined;
  readonly line?: number | undefined;
}

export interface DiagnosisBranchComparison {
  readonly baselineBranchId: BranchId;
  readonly experimentalBranchId: BranchId;
  readonly changedControls: readonly {
    readonly name: string;
    readonly before: JsonValue;
    readonly after: JsonValue;
  }[];
  readonly baselineEvaluationId: EvaluationId;
  readonly experimentalEvaluationId: EvaluationId;
  readonly observation: string;
  readonly interpretation: string;
}

export interface DiagnosisReport {
  readonly schemaVersion: 1;
  readonly reportId: ReportId;
  readonly runId: RunId;
  readonly status: "confirmed" | "probable" | "inconclusive";
  readonly conclusion: {
    readonly summary: string;
    readonly mechanism: string;
    readonly category:
      "timing" | "signal_ordering" | "state" | "input" | "unknown";
    readonly suspectedLocations: readonly SuspectedLocation[];
  };
  readonly confidence: number;
  /** Runtime schema requires at least one entry. */
  readonly evidenceIds: readonly EvidenceId[];
  readonly branchComparisons: readonly DiagnosisBranchComparison[];
  readonly suggestedFix: {
    readonly summary: string;
    readonly targets: readonly SuspectedLocation[];
    readonly strategy: string;
    readonly validationSteps: readonly string[];
  };
  readonly limitations: readonly string[];
}

const suspectedLocationSchema: z.ZodType<SuspectedLocation> = z
  .object({
    path: z.string().min(1),
    symbol: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
  })
  .strict();

const diagnosisComparisonSchema: z.ZodType<DiagnosisBranchComparison> = z
  .object({
    baselineBranchId: BranchIdSchema,
    experimentalBranchId: BranchIdSchema,
    changedControls: z.array(
      z
        .object({
          name: z.string().min(1),
          before: JsonValueSchema,
          after: JsonValueSchema,
        })
        .strict(),
    ),
    baselineEvaluationId: EvaluationIdSchema,
    experimentalEvaluationId: EvaluationIdSchema,
    observation: z.string().min(1),
    interpretation: z.string().min(1),
  })
  .strict();

export const DiagnosisReportSchema: z.ZodType<DiagnosisReport> = z
  .object({
    schemaVersion: z.literal(1),
    reportId: ReportIdSchema,
    runId: RunIdSchema,
    status: z.enum(["confirmed", "probable", "inconclusive"]),
    conclusion: z
      .object({
        summary: z.string().min(1),
        mechanism: z.string().min(1),
        category: z.enum([
          "timing",
          "signal_ordering",
          "state",
          "input",
          "unknown",
        ]),
        suspectedLocations: z.array(suspectedLocationSchema),
      })
      .strict(),
    confidence: z.number().finite().min(0).max(1),
    evidenceIds: z.array(EvidenceIdSchema).nonempty(),
    branchComparisons: z.array(diagnosisComparisonSchema),
    suggestedFix: z
      .object({
        summary: z.string().min(1),
        targets: z.array(suspectedLocationSchema),
        strategy: z.string().min(1),
        validationSteps: z.array(z.string().min(1)),
      })
      .strict(),
    limitations: z.array(z.string()),
  })
  .strict();
