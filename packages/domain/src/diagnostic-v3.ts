import { z } from "zod";

import {
  CapsuleIdSchema,
  ComparisonIdSchema,
  ContractIdSchema,
  EventIdSchema,
  EvidenceAccessReceiptIdSchema,
  ExecutionIdSchema,
  FixtureIdSchema,
  ProposalIdSchema,
  RunIdSchema,
  type CapsuleId,
  type ComparisonId,
  type ContractId,
  type EventId,
  type EvidenceAccessReceiptId,
  type ExecutionId,
  type FixtureId,
  type ProposalId,
  type RunId,
} from "./ids.js";
import {
  PropertyEqualsPredicateSchema,
  SignalPredicateSchema,
  StateValueObservationSchema,
  type PropertyEqualsPredicate,
  type SignalPredicate,
  type StateValueObservation,
} from "./invariant.js";
import { TickSchema } from "./time.js";
import { MechanismCodeV2Schema, type MechanismCodeV2 } from "./v03.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

/** The byte-identical failure description supplied to every benchmark arm. */
export interface FailureBriefV1 {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly fixtureId: FixtureId;
  readonly contractId: ContractId;
  readonly capsuleId: CapsuleId;
  readonly baselineExecutionId: ExecutionId;
  readonly trigger: SignalPredicate;
  readonly triggerEventId: EventId;
  readonly triggerTick: number;
  readonly expectation: PropertyEqualsPredicate;
  readonly deadlineTick: number;
  readonly actual: StateValueObservation;
  readonly violationSummary: string;
}

export const FailureBriefV1Schema: z.ZodType<FailureBriefV1> = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    fixtureId: FixtureIdSchema,
    contractId: ContractIdSchema,
    capsuleId: CapsuleIdSchema,
    baselineExecutionId: ExecutionIdSchema,
    trigger: SignalPredicateSchema,
    triggerEventId: EventIdSchema,
    triggerTick: TickSchema,
    expectation: PropertyEqualsPredicateSchema,
    deadlineTick: TickSchema,
    actual: StateValueObservationSchema,
    violationSummary: z.string().min(1),
  })
  .strict()
  .superRefine((brief, context) => {
    if (brief.deadlineTick < brief.triggerTick) {
      context.addIssue({
        code: "custom",
        message: "Failure Brief deadline precedes its trigger",
        path: ["deadlineTick"],
      });
    }
  });

export const EvidenceAccessKindV1Schema = z.enum([
  "failure_brief",
  "raw_execution",
  "capsule",
  "replay",
  "experiment",
  "comparison",
  "source_read",
  "source_search",
]);
export type EvidenceAccessKindV1 = z.infer<typeof EvidenceAccessKindV1Schema>;

export interface SourceCoverageV1 {
  readonly virtualPath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly coveredSymbols: readonly string[];
}

export const SourceCoverageV1Schema: z.ZodType<SourceCoverageV1> = z
  .object({
    virtualPath: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    coveredSymbols: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((coverage, context) => {
    if (coverage.endLine < coverage.startLine) {
      context.addIssue({
        code: "custom",
        message: "Source coverage line range is reversed",
        path: ["endLine"],
      });
    }
    if (
      new Set(coverage.coveredSymbols).size !== coverage.coveredSymbols.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Covered source symbols must be unique",
        path: ["coveredSymbols"],
      });
    }
  });

/** Content-addressed proof of exactly what evidence a diagnostic Agent read. */
export interface EvidenceAccessReceiptV1 {
  readonly schemaVersion: 1;
  readonly receiptId: EvidenceAccessReceiptId;
  readonly runId: RunId;
  readonly fixtureId: FixtureId;
  readonly accessKind: EvidenceAccessKindV1;
  readonly resourceId: string;
  readonly requestHash: string;
  readonly contentHash: string;
  readonly sourceCoverage: readonly SourceCoverageV1[];
  readonly issuedAt: string;
}

export const EvidenceAccessReceiptV1Schema: z.ZodType<EvidenceAccessReceiptV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      receiptId: EvidenceAccessReceiptIdSchema,
      runId: RunIdSchema,
      fixtureId: FixtureIdSchema,
      accessKind: EvidenceAccessKindV1Schema,
      resourceId: z.string().min(1),
      requestHash: Sha256Schema,
      contentHash: Sha256Schema,
      sourceCoverage: z.array(SourceCoverageV1Schema),
      issuedAt: z.string().datetime(),
    })
    .strict()
    .superRefine((receipt, context) => {
      const isSource =
        receipt.accessKind === "source_read" ||
        receipt.accessKind === "source_search";
      if (!isSource && receipt.sourceCoverage.length > 0) {
        context.addIssue({
          code: "custom",
          message: "Only source accesses may carry source coverage receipts",
          path: ["sourceCoverage"],
        });
      }
    });

/** Agent-authored proposal. All references are revalidated by the Harness. */
export interface DiagnosisProposalV3 {
  readonly schemaVersion: 3;
  readonly proposalId: ProposalId;
  readonly runId: RunId;
  readonly fixtureId: FixtureId;
  readonly capsuleId: CapsuleId;
  readonly baselineExecutionId: ExecutionId;
  readonly replayExecutionId?: ExecutionId | undefined;
  readonly candidateExecutionIds: readonly ExecutionId[];
  readonly comparisonIds: readonly ComparisonId[];
  readonly accessReceiptIds: readonly EvidenceAccessReceiptId[];
  readonly mechanismCode: MechanismCodeV2;
  readonly summary: string;
  readonly evidenceEventIds: readonly EventId[];
  readonly suspectedSource?:
    { readonly path: string; readonly symbol?: string | undefined } | undefined;
  readonly blockers: readonly string[];
  readonly nextExperiment: string | null;
  readonly confidence: number;
}

export const DiagnosisProposalV3Schema: z.ZodType<DiagnosisProposalV3> = z
  .object({
    schemaVersion: z.literal(3),
    proposalId: ProposalIdSchema,
    runId: RunIdSchema,
    fixtureId: FixtureIdSchema,
    capsuleId: CapsuleIdSchema,
    baselineExecutionId: ExecutionIdSchema,
    replayExecutionId: ExecutionIdSchema.optional(),
    candidateExecutionIds: z.array(ExecutionIdSchema),
    comparisonIds: z.array(ComparisonIdSchema),
    accessReceiptIds: z.array(EvidenceAccessReceiptIdSchema),
    mechanismCode: MechanismCodeV2Schema,
    summary: z.string().min(1),
    evidenceEventIds: z.array(EventIdSchema),
    suspectedSource: z
      .object({
        path: z.string().min(1),
        symbol: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    blockers: z.array(z.string().min(1)),
    nextExperiment: z.string().min(1).nullable(),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict()
  .superRefine((proposal, context) => {
    const uniqueFields: readonly [string, readonly string[]][] = [
      ["candidateExecutionIds", proposal.candidateExecutionIds],
      ["comparisonIds", proposal.comparisonIds],
      ["accessReceiptIds", proposal.accessReceiptIds],
      ["evidenceEventIds", proposal.evidenceEventIds],
    ];
    for (const [field, values] of uniqueFields) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: `${field} must contain unique references`,
          path: [field],
        });
      }
    }
  });
