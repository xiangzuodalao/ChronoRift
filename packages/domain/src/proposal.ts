import { z } from "zod";

import {
  BranchIdSchema,
  CapsuleIdSchema,
  CheckpointIdSchema,
  ComparisonIdSchema,
  ContractIdSchema,
  EventIdSchema,
  ExecutionIdSchema,
  ProposalIdSchema,
  RunIdSchema,
  VerdictIdSchema,
  type BranchId,
  type CapsuleId,
  type CheckpointId,
  type ComparisonId,
  type ContractId,
  type EventId,
  type ExecutionId,
  type ProposalId,
  type RunId,
  type VerdictId,
} from "./ids.js";
import {
  DelayInputInterventionSchema,
  type DelayInputIntervention,
} from "./execution.js";
import {
  PropertyEqualsPredicateSchema,
  SignalPredicateSchema,
  type PropertyEqualsPredicate,
  type SignalPredicate,
} from "./invariant.js";

export type ArtifactReference =
  | { readonly artifactKind: "contract"; readonly contractId: ContractId }
  | { readonly artifactKind: "branch"; readonly branchId: BranchId }
  | {
      readonly artifactKind: "checkpoint";
      readonly checkpointId: CheckpointId;
    }
  | {
      readonly artifactKind: "execution";
      readonly executionId: ExecutionId;
    }
  | { readonly artifactKind: "capsule"; readonly capsuleId: CapsuleId }
  | {
      readonly artifactKind: "comparison";
      readonly comparisonId: ComparisonId;
    }
  | { readonly artifactKind: "event"; readonly eventId: EventId };

export const ArtifactReferenceSchema: z.ZodType<ArtifactReference> =
  z.discriminatedUnion("artifactKind", [
    z
      .object({
        artifactKind: z.literal("contract"),
        contractId: ContractIdSchema,
      })
      .strict(),
    z
      .object({
        artifactKind: z.literal("branch"),
        branchId: BranchIdSchema,
      })
      .strict(),
    z
      .object({
        artifactKind: z.literal("checkpoint"),
        checkpointId: CheckpointIdSchema,
      })
      .strict(),
    z
      .object({
        artifactKind: z.literal("execution"),
        executionId: ExecutionIdSchema,
      })
      .strict(),
    z
      .object({
        artifactKind: z.literal("capsule"),
        capsuleId: CapsuleIdSchema,
      })
      .strict(),
    z
      .object({
        artifactKind: z.literal("comparison"),
        comparisonId: ComparisonIdSchema,
      })
      .strict(),
    z
      .object({
        artifactKind: z.literal("event"),
        eventId: EventIdSchema,
      })
      .strict(),
  ]);

export interface ObservedFact {
  readonly statement: string;
  readonly references: readonly ArtifactReference[];
}

export const ObservedFactSchema: z.ZodType<ObservedFact> = z
  .object({
    statement: z.string().min(1),
    references: z.array(ArtifactReferenceSchema).nonempty(),
  })
  .strict();

export type DiagnosisClaim =
  | {
      readonly kind: "mechanism";
      readonly summary: string;
      readonly mechanism: string;
      readonly category: "signal_ordering" | "state" | "input" | "unknown";
      readonly mechanismCode:
        | "signal_before_receiver_connection"
        | "signal_rejected_by_connected_receiver"
        | "input_not_applied";
      readonly assertion: {
        readonly signal: SignalPredicate;
        readonly receiver: string;
        readonly failedDeliveryReason:
          "receiver_not_connected" | "receiver_rejected" | "unknown";
        readonly expectedEffect: PropertyEqualsPredicate;
        readonly intervention: DelayInputIntervention;
      };
    }
  | {
      readonly kind: "unknown";
      readonly summary: string;
    };

export const DiagnosisClaimSchema: z.ZodType<DiagnosisClaim> =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("mechanism"),
        summary: z.string().min(1),
        mechanism: z.string().min(1),
        category: z.enum(["signal_ordering", "state", "input", "unknown"]),
        mechanismCode: z.enum([
          "signal_before_receiver_connection",
          "signal_rejected_by_connected_receiver",
          "input_not_applied",
        ]),
        assertion: z
          .object({
            signal: SignalPredicateSchema,
            receiver: z.string().min(1),
            failedDeliveryReason: z.enum([
              "receiver_not_connected",
              "receiver_rejected",
              "unknown",
            ]),
            expectedEffect: PropertyEqualsPredicateSchema,
            intervention: DelayInputInterventionSchema,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("unknown"),
        summary: z.string().min(1),
      })
      .strict(),
  ]);

/** Agent-authored hypothesis. It deliberately has no verdict/status field. */
export interface DiagnosisProposal {
  readonly schemaVersion: 1;
  readonly proposalId: ProposalId;
  readonly runId: RunId;
  readonly capsuleId: CapsuleId;
  readonly baselineExecutionId: ExecutionId;
  readonly replayExecutionId?: ExecutionId | undefined;
  readonly candidateExecutionId?: ExecutionId | undefined;
  readonly comparisonId?: ComparisonId | undefined;
  readonly claim: DiagnosisClaim;
  readonly observedFacts: readonly ObservedFact[];
  readonly hypotheses: readonly string[];
  readonly unknowns: readonly string[];
  readonly attemptedActions: readonly string[];
  readonly blockers: readonly string[];
  readonly nextExperiment: string | null;
  /** Agent metadata only; the Conclusion Gate must not use it. */
  readonly confidence: number;
}

export const DiagnosisProposalSchema: z.ZodType<DiagnosisProposal> = z
  .object({
    schemaVersion: z.literal(1),
    proposalId: ProposalIdSchema,
    runId: RunIdSchema,
    capsuleId: CapsuleIdSchema,
    baselineExecutionId: ExecutionIdSchema,
    replayExecutionId: ExecutionIdSchema.optional(),
    candidateExecutionId: ExecutionIdSchema.optional(),
    comparisonId: ComparisonIdSchema.optional(),
    claim: DiagnosisClaimSchema,
    observedFacts: z.array(ObservedFactSchema),
    hypotheses: z.array(z.string().min(1)),
    unknowns: z.array(z.string().min(1)),
    attemptedActions: z.array(z.string().min(1)),
    blockers: z.array(z.string().min(1)),
    nextExperiment: z.string().min(1).nullable(),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.claim.kind === "mechanism") {
      const required = [
        ["replayExecutionId", value.replayExecutionId],
        ["candidateExecutionId", value.candidateExecutionId],
        ["comparisonId", value.comparisonId],
      ] as const;
      for (const [field, reference] of required) {
        if (reference === undefined) {
          context.addIssue({
            code: "custom",
            message: `A mechanism claim requires ${field}`,
            path: [field],
          });
        }
      }
    }
    if (
      value.claim.kind === "unknown" &&
      value.blockers.length === 0 &&
      value.unknowns.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "An unknown claim requires a blocker or unknown",
        path: ["blockers"],
      });
    }
    if (value.claim.kind === "unknown" && value.nextExperiment === null) {
      context.addIssue({
        code: "custom",
        message: "An unknown claim requires a next experiment",
        path: ["nextExperiment"],
      });
    }
  });

export type ConclusionBlockerCode =
  | "CONTRACT_NOT_FROZEN"
  | "CONTRACT_MISMATCH"
  | "CHECKPOINT_MISMATCH"
  | "EXECUTION_NOT_ADMISSIBLE"
  | "BASELINE_NOT_FAILED"
  | "REPLAY_DIVERGED"
  | "INTERVENTION_NOT_ISOLATED"
  | "INTERVENTION_NOT_REALIZED"
  | "CANDIDATE_NOT_PASSED"
  | "COMPARISON_NOT_ADMISSIBLE"
  | "EVENT_LOSS_DETECTED"
  | "SIGNAL_EVIDENCE_MISSING"
  | "DELIVERY_EVIDENCE_MISSING"
  | "STATE_EVIDENCE_MISSING"
  | "CLAIM_NOT_SUPPORTED";

export interface ConclusionBlocker {
  readonly code: ConclusionBlockerCode;
  readonly message: string;
  readonly references: readonly ArtifactReference[];
}

export const ConclusionBlockerSchema: z.ZodType<ConclusionBlocker> = z
  .object({
    code: z.enum([
      "CONTRACT_NOT_FROZEN",
      "CONTRACT_MISMATCH",
      "CHECKPOINT_MISMATCH",
      "EXECUTION_NOT_ADMISSIBLE",
      "BASELINE_NOT_FAILED",
      "REPLAY_DIVERGED",
      "INTERVENTION_NOT_ISOLATED",
      "INTERVENTION_NOT_REALIZED",
      "CANDIDATE_NOT_PASSED",
      "COMPARISON_NOT_ADMISSIBLE",
      "EVENT_LOSS_DETECTED",
      "SIGNAL_EVIDENCE_MISSING",
      "DELIVERY_EVIDENCE_MISSING",
      "STATE_EVIDENCE_MISSING",
      "CLAIM_NOT_SUPPORTED",
    ]),
    message: z.string().min(1),
    references: z.array(ArtifactReferenceSchema),
  })
  .strict();

interface DiagnosisVerdictBase {
  readonly schemaVersion: 1;
  readonly verdictId: VerdictId;
  readonly proposalId: ProposalId;
  readonly runId: RunId;
  readonly summary: string;
  readonly validatedReferences: readonly ArtifactReference[];
}

export interface ConfirmedDiagnosisVerdict extends DiagnosisVerdictBase {
  readonly status: "confirmed";
  readonly claimLevel: "mechanism_supported";
  readonly mechanismCode: "signal_before_receiver_connection";
  readonly blockers: readonly [];
  readonly nextExperiment: null;
}

export interface InconclusiveDiagnosisVerdict extends DiagnosisVerdictBase {
  readonly status: "inconclusive";
  readonly claimLevel: "none";
  /** Runtime schema requires at least one blocker. */
  readonly blockers: readonly ConclusionBlocker[];
  readonly nextExperiment: string;
}

export type DiagnosisVerdict =
  ConfirmedDiagnosisVerdict | InconclusiveDiagnosisVerdict;

const diagnosisVerdictBase = {
  schemaVersion: z.literal(1),
  verdictId: VerdictIdSchema,
  proposalId: ProposalIdSchema,
  runId: RunIdSchema,
  summary: z.string().min(1),
  validatedReferences: z.array(ArtifactReferenceSchema),
};

export const DiagnosisVerdictSchema: z.ZodType<DiagnosisVerdict> = z
  .discriminatedUnion("status", [
    z
      .object({
        ...diagnosisVerdictBase,
        status: z.literal("confirmed"),
        claimLevel: z.literal("mechanism_supported"),
        mechanismCode: z.literal("signal_before_receiver_connection"),
        blockers: z.tuple([]),
        nextExperiment: z.null(),
      })
      .strict(),
    z
      .object({
        ...diagnosisVerdictBase,
        status: z.literal("inconclusive"),
        claimLevel: z.literal("none"),
        blockers: z.array(ConclusionBlockerSchema).nonempty(),
        nextExperiment: z.string().min(1),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.status !== "confirmed") return;

    const referenceKeys = new Set<string>();
    const kinds = new Map<ArtifactReference["artifactKind"], Set<string>>();
    for (const [index, reference] of value.validatedReferences.entries()) {
      const entry = (() => {
        switch (reference.artifactKind) {
          case "contract":
            return [reference.artifactKind, reference.contractId] as const;
          case "branch":
            return [reference.artifactKind, reference.branchId] as const;
          case "checkpoint":
            return [reference.artifactKind, reference.checkpointId] as const;
          case "execution":
            return [reference.artifactKind, reference.executionId] as const;
          case "capsule":
            return [reference.artifactKind, reference.capsuleId] as const;
          case "comparison":
            return [reference.artifactKind, reference.comparisonId] as const;
          case "event":
            return [reference.artifactKind, reference.eventId] as const;
        }
      })();
      const key = `${entry[0]}\u0000${entry[1]}`;
      if (referenceKeys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Validated verdict references must be unique",
          path: ["validatedReferences", index],
        });
      }
      referenceKeys.add(key);
      const ids = kinds.get(entry[0]) ?? new Set<string>();
      ids.add(entry[1]);
      kinds.set(entry[0], ids);
    }

    const requiredSingletons = [
      "contract",
      "checkpoint",
      "capsule",
      "comparison",
    ] as const;
    for (const kind of requiredSingletons) {
      if ((kinds.get(kind)?.size ?? 0) < 1) {
        context.addIssue({
          code: "custom",
          message: `A confirmed v0.1 verdict requires a validated ${kind}`,
          path: ["validatedReferences"],
        });
      }
    }
    if ((kinds.get("execution")?.size ?? 0) < 3) {
      context.addIssue({
        code: "custom",
        message:
          "A confirmed v0.1 verdict requires original, replay, and intervention executions",
        path: ["validatedReferences"],
      });
    }
    if ((kinds.get("event")?.size ?? 0) < 3) {
      context.addIssue({
        code: "custom",
        message:
          "A confirmed v0.1 verdict requires trigger, delivery, and state evidence events",
        path: ["validatedReferences"],
      });
    }
  });
