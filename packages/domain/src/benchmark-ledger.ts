import { z } from "zod";

import {
  BenchmarkAttemptIdSchema,
  CapsuleIdSchema,
  CheckpointIdSchema,
  ComparisonIdSchema,
  ContractIdSchema,
  BenchmarkCellIdSchema,
  BenchmarkDefinitionIdSchema,
  BenchmarkExecutionIdSchema,
  BenchmarkSuiteIdSchema,
  FixtureIdSchema,
  InputTraceIdSchema,
  InterventionIdSchema,
  ExecutionIdSchema,
  EventIdSchema,
  EvidenceAccessReceiptIdSchema,
  ProposalIdSchema,
  RunIdSchema,
  VerdictIdSchema,
} from "./ids.js";
import { EvidenceAccessReceiptV1Schema } from "./diagnostic-v3.js";
import { RestoreReceiptSchema, StepReceiptSchema } from "./execution.js";
import {
  PropertyEqualsPredicateSchema,
  StateValueObservationSchema,
} from "./invariant.js";
import { ObservationHealthV1Schema } from "./runtime.js";
import {
  BenchmarkAttemptKindV2Schema,
  BenchmarkCellAttemptV2Schema,
  BenchmarkCellMetricsV2Schema,
  BenchmarkCellResultV2Schema,
  BenchmarkFreezeTagV1Schema,
  Sha256V1Schema,
  type BenchmarkAttemptKindV2,
  type BenchmarkCellAttemptV2,
  type BenchmarkCellResultV2,
} from "./benchmark-v2.js";
import {
  BenchmarkArmV1Schema,
  ContractEvaluationV2Schema,
  EntityRefV1Schema,
  MechanismCodeV2Schema,
  RealizedControlReceiptV1Schema,
  type BenchmarkArmV1,
} from "./v03.js";
import type {
  BenchmarkAttemptId,
  BenchmarkCellId,
  BenchmarkDefinitionId,
  BenchmarkExecutionId,
  BenchmarkSuiteId,
  FixtureId,
} from "./ids.js";
import { JsonValueSchema, type JsonValue } from "./json.js";

export const BenchmarkProvenanceV2Schema = z
  .object({
    gitCommit: z.string().regex(/^[a-f0-9]{7,64}$/u),
    freezeTag: BenchmarkFreezeTagV1Schema,
    dirty: z.literal(false),
    lockfileHash: Sha256V1Schema,
    piPackageVersion: z.string().min(1),
    nodeVersion: z.string().min(1),
    pnpmVersion: z.string().min(1),
    godotVersion: z.string().min(1),
    godotExecutableHash: Sha256V1Schema,
    resolvedModelName: z.string().min(1),
    resolvedContextWindow: z.literal(1_000_000),
    resolvedMaxTokens: z.literal(128_000),
    mappedThinkingLevel: z.literal("max"),
    requestedThinkingLevel: z.literal("max"),
    os: z.string().min(1),
    arch: z.string().min(1),
    platform: z.string().min(1),
  })
  .strict();
export type BenchmarkProvenanceV2 = z.infer<typeof BenchmarkProvenanceV2Schema>;

export interface BenchmarkExecutionSelectionV2 {
  readonly schemaVersion: 2;
  readonly suiteId: BenchmarkSuiteId;
  readonly definitionId: BenchmarkDefinitionId;
  readonly executionId: BenchmarkExecutionId;
  readonly selectionHash: string;
}

export const BenchmarkExecutionSelectionV2Schema: z.ZodType<BenchmarkExecutionSelectionV2> =
  z
    .object({
      schemaVersion: z.literal(2),
      suiteId: BenchmarkSuiteIdSchema,
      definitionId: BenchmarkDefinitionIdSchema,
      executionId: BenchmarkExecutionIdSchema,
      selectionHash: Sha256V1Schema,
    })
    .strict();

const BenchmarkCaseExecutionEvidenceBaseV2Schema = z
  .object({
    executionId: ExecutionIdSchema,
    contractId: ContractIdSchema,
    checkpointId: CheckpointIdSchema,
    inputTraceId: InputTraceIdSchema,
    evaluationStatus: z.enum(["pass", "fail", "incomplete"]),
    evaluation: ContractEvaluationV2Schema,
    timelineDigest: Sha256V1Schema,
    contentHash: Sha256V1Schema,
    restoreReceiptHash: Sha256V1Schema,
    controlReceiptHash: Sha256V1Schema,
    stepReceiptsHash: Sha256V1Schema,
    observationHealthHash: Sha256V1Schema,
    finalStateHash: Sha256V1Schema,
    finalState: z
      .object({
        values: z.record(
          z.string().min(1),
          z.union([z.boolean(), z.number().finite(), z.null()]),
        ),
      })
      .strict(),
    runtimeFingerprintHash: Sha256V1Schema.nullable(),
    timelineMatchesBaseline: z.boolean(),
    restoreReceipt: RestoreReceiptSchema,
    controlReceipt: RealizedControlReceiptV1Schema,
    stepReceipts: z.array(StepReceiptSchema).nonempty(),
    observationHealth: ObservationHealthV1Schema,
  })
  .strict();

export const BenchmarkEvidenceRoleV2Schema = z.enum([
  "trigger",
  "delivery",
  "state_transition",
  "lifecycle",
  "spatial_sample",
  "pending_effect",
]);

const BenchmarkSafeScalarV2Schema = z.union([
  z.boolean(),
  z.number().finite(),
  z.null(),
]);

const publicCausalEventBase = {
  eventId: EventIdSchema,
  role: z.union([
    BenchmarkEvidenceRoleV2Schema,
    z.literal("causal_ancestor"),
    z.literal("agent_citation"),
  ]),
  seq: z.number().int().nonnegative(),
  tick: z.number().int().nonnegative(),
  simTimeUs: z.number().int().nonnegative(),
  causedByEventId: EventIdSchema.nullable(),
  contentHash: Sha256V1Schema,
};

/** Strict, log-free projection of only the fields needed to audit causality. */
export const BenchmarkPublicCausalEventV2Schema = z.discriminatedUnion("kind", [
  z
    .object({
      ...publicCausalEventBase,
      kind: z.literal("input"),
      action: z.string().min(1),
      target: z.string().min(1).nullable(),
      requestedTick: z.number().int().nonnegative(),
      realizedTick: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...publicCausalEventBase,
      kind: z.literal("signal"),
      source: z.string().min(1),
      name: z.string().min(1),
      sourceEntity: EntityRefV1Schema.nullable(),
    })
    .strict(),
  z
    .object({
      ...publicCausalEventBase,
      kind: z.literal("signal_delivery"),
      source: z.string().min(1),
      name: z.string().min(1),
      receiver: z.string().min(1),
      delivered: z.boolean(),
      failureReason: z
        .enum(["receiver_not_connected", "receiver_rejected", "unknown"])
        .nullable(),
      sourceEntity: EntityRefV1Schema.nullable(),
      receiverEntity: EntityRefV1Schema.nullable(),
    })
    .strict(),
  z
    .object({
      ...publicCausalEventBase,
      kind: z.literal("property_changed"),
      path: z.string().min(1),
      before: BenchmarkSafeScalarV2Schema,
      after: BenchmarkSafeScalarV2Schema,
      entity: EntityRefV1Schema.nullable(),
    })
    .strict(),
  z
    .object({
      ...publicCausalEventBase,
      kind: z.literal("entity_lifecycle"),
      action: z.enum(["spawned", "despawned"]),
      entity: EntityRefV1Schema,
    })
    .strict(),
  z
    .object({
      ...publicCausalEventBase,
      kind: z.literal("spatial_sample"),
      entity: EntityRefV1Schema,
      position: z.tuple([z.number().finite(), z.number().finite()]),
    })
    .strict(),
  z
    .object({
      ...publicCausalEventBase,
      kind: z.literal("pending_effect"),
      action: z.enum(["scheduled", "restored", "applied", "discarded"]),
      effectId: z.string().min(1),
      target: EntityRefV1Schema,
      resolvedTarget: EntityRefV1Schema.nullable(),
      dueTick: z.number().int().nonnegative(),
      reason: z
        .enum(["owner_destroyed", "target_missing", "stale_incarnation"])
        .nullable(),
    })
    .strict(),
]);
export type BenchmarkPublicCausalEventV2 = z.infer<
  typeof BenchmarkPublicCausalEventV2Schema
>;

const BenchmarkCaseExecutionEvidenceV2Schema =
  BenchmarkCaseExecutionEvidenceBaseV2Schema.extend({
    causalEvents: z.array(BenchmarkPublicCausalEventV2Schema),
  }).superRefine((execution, context) => {
    const earlier = new Set<string>();
    for (const [index, event] of execution.causalEvents.entries()) {
      if (
        event.causedByEventId !== null &&
        !earlier.has(event.causedByEventId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Execution causal references must resolve to earlier events",
          path: ["causalEvents", index, "causedByEventId"],
        });
      }
      if (earlier.has(event.eventId)) {
        context.addIssue({
          code: "custom",
          message: "Execution causal event IDs must be unique",
          path: ["causalEvents", index, "eventId"],
        });
      }
      earlier.add(event.eventId);
    }
  });

export const BenchmarkPublicCapsuleEvidenceV2Schema = z
  .object({
    capsuleId: CapsuleIdSchema,
    contentHash: Sha256V1Schema,
    timelineDigest: Sha256V1Schema,
    eventChainHash: Sha256V1Schema,
    evidenceLinks: z.array(
      z
        .object({
          role: BenchmarkEvidenceRoleV2Schema,
          eventId: EventIdSchema,
        })
        .strict(),
    ),
    causalEvents: z.array(BenchmarkPublicCausalEventV2Schema),
    omittedRuntimeLogCount: z.number().int().nonnegative(),
    expected: PropertyEqualsPredicateSchema,
    actual: StateValueObservationSchema,
    eventLossDetected: z.boolean(),
    limitationsHash: Sha256V1Schema,
  })
  .strict()
  .superRefine((capsule, context) => {
    const eventsById = new Map(
      capsule.causalEvents.map((event) => [event.eventId, event] as const),
    );
    if (eventsById.size !== capsule.causalEvents.length) {
      context.addIssue({
        code: "custom",
        message: "Public causal event IDs must be unique",
        path: ["causalEvents"],
      });
    }
    const earlier = new Set<string>();
    for (const [index, event] of capsule.causalEvents.entries()) {
      if (
        event.causedByEventId !== null &&
        !earlier.has(event.causedByEventId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Public causal references must resolve to earlier events",
          path: ["causalEvents", index, "causedByEventId"],
        });
      }
      earlier.add(event.eventId);
    }
    const linked = new Set<string>();
    for (const [index, link] of capsule.evidenceLinks.entries()) {
      const event = eventsById.get(link.eventId);
      if (event === undefined || event.role !== link.role) {
        context.addIssue({
          code: "custom",
          message: "Public evidence links must resolve with the same role",
          path: ["evidenceLinks", index],
        });
      }
      if (linked.has(link.eventId)) {
        context.addIssue({
          code: "custom",
          message: "Public evidence links must be unique",
          path: ["evidenceLinks", index, "eventId"],
        });
      }
      linked.add(link.eventId);
    }
  });

export const BenchmarkCaseEvidenceV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    contract: z
      .object({ contractId: ContractIdSchema, contentHash: Sha256V1Schema })
      .strict(),
    checkpoint: z
      .object({
        checkpointId: CheckpointIdSchema,
        contentHash: Sha256V1Schema,
        certificateHash: Sha256V1Schema.nullable(),
        certificate: z
          .object({
            level: z.enum(["l0_restart", "fixture_semantic_l2"]),
            captureConsistencyModel: z.enum([
              "fresh_scene",
              "frame_end_barrier",
            ]),
            coveredStateDomains: z.array(z.string().min(1)),
            missingStateDomains: z.array(z.string().min(1)),
            externalDependencies: z.array(z.string().min(1)),
            rngDomains: z.array(z.string().min(1)),
            pendingAsyncOperations: z.array(z.string().min(1)),
            portability: z.literal("same_build_only"),
            limitations: z.array(z.string().min(1)),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    inputTrace: z
      .object({ inputTraceId: InputTraceIdSchema, contentHash: Sha256V1Schema })
      .strict(),
    capsule: BenchmarkPublicCapsuleEvidenceV2Schema,
    baseline: BenchmarkCaseExecutionEvidenceV2Schema,
    replay: BenchmarkCaseExecutionEvidenceV2Schema.nullable(),
    candidates: z.array(BenchmarkCaseExecutionEvidenceV2Schema),
    comparisons: z.array(
      z
        .object({
          comparisonId: ComparisonIdSchema,
          baselineExecutionId: ExecutionIdSchema,
          candidateExecutionId: ExecutionIdSchema,
          interventionId: InterventionIdSchema,
          baselineOutcome: z.enum(["pass", "fail", "incomplete"]),
          candidateOutcome: z.enum(["pass", "fail", "incomplete"]),
          comparable: z.boolean(),
          blockersHash: Sha256V1Schema,
          firstDivergenceTick: z.number().int().nonnegative().nullable(),
          contentHash: Sha256V1Schema,
        })
        .strict(),
    ),
    accessReceipts: z.array(EvidenceAccessReceiptV1Schema),
  })
  .strict();
export type BenchmarkCaseEvidenceV2 = z.infer<
  typeof BenchmarkCaseEvidenceV2Schema
>;

export const BenchmarkBaselineProgressManifestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    stage: z.literal("baseline_completed"),
    cellId: BenchmarkCellIdSchema,
    fixtureId: FixtureIdSchema,
    arm: BenchmarkArmV1Schema,
    repetition: z.number().int().positive(),
    baselineExecutionId: ExecutionIdSchema,
    baselineTimelineDigest: Sha256V1Schema,
    gameExecutions: z.literal(1),
    progressObserved: z.literal(true),
    error: z
      .object({ code: z.literal("process_interrupted_after_progress") })
      .strict(),
  })
  .strict();
export type BenchmarkBaselineProgressManifestV2 = z.infer<
  typeof BenchmarkBaselineProgressManifestV2Schema
>;

export const BenchmarkSanitizedProposalV2Schema = z
  .object({
    proposalId: ProposalIdSchema,
    runId: RunIdSchema,
    fixtureId: FixtureIdSchema,
    capsuleId: CapsuleIdSchema,
    baselineExecutionId: ExecutionIdSchema,
    replayExecutionId: ExecutionIdSchema.nullable(),
    candidateExecutionIds: z.array(ExecutionIdSchema),
    comparisonIds: z.array(ComparisonIdSchema),
    accessReceiptIds: z.array(EvidenceAccessReceiptIdSchema),
    mechanismCode: MechanismCodeV2Schema,
    evidenceEventIds: z.array(EventIdSchema),
    suspectedSource: z
      .object({
        path: z.string().min(1),
        symbol: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
    confidence: z.number().finite().min(0).max(1),
    summaryHash: Sha256V1Schema,
    blockersHash: Sha256V1Schema,
    nextExperimentHash: Sha256V1Schema.nullable(),
  })
  .strict();

const BenchmarkPromptAuditProjectionV2Schema = z
  .object({
    failureBriefHash: Sha256V1Schema,
    failureBriefReceiptId: z.string().min(1),
    systemHash: Sha256V1Schema,
    userHash: Sha256V1Schema,
    baselineTimelineDigest: Sha256V1Schema,
    checkpointId: CheckpointIdSchema,
    checkpointHash: Sha256V1Schema,
    contractId: ContractIdSchema,
    contractHash: Sha256V1Schema,
    inputTraceId: InputTraceIdSchema,
    inputTraceHash: Sha256V1Schema,
    runtimeFingerprintHash: Sha256V1Schema,
    sourceViewHash: Sha256V1Schema,
    experimentCatalogHash: Sha256V1Schema,
    oracleHash: Sha256V1Schema,
  })
  .strict();

const BenchmarkSanitizedVerdictV2Schema = z
  .object({
    verdictId: VerdictIdSchema,
    proposalId: ProposalIdSchema,
    runId: RunIdSchema,
    fixtureId: FixtureIdSchema,
    status: z.enum(["confirmed", "inconclusive"]),
    mechanismCode: MechanismCodeV2Schema,
    summaryHash: Sha256V1Schema,
    blockersHash: Sha256V1Schema,
  })
  .strict();

const BenchmarkCompleteOrDiagnosticCaseEvidenceV2Schema = z
  .object({
    promptAudit: BenchmarkPromptAuditProjectionV2Schema,
    proposal: BenchmarkSanitizedProposalV2Schema.nullable(),
    accessReceipts: z.array(EvidenceAccessReceiptV1Schema),
    verdict: BenchmarkSanitizedVerdictV2Schema.nullable(),
    gameExecutions: z.number().int().nonnegative().nullable(),
    caseEvidence: BenchmarkCaseEvidenceV2Schema,
    evidenceCompleteness: z.enum(["complete", "partial"]),
    unavailableReason: z
      .literal("diagnostic_attempt_has_partial_flow_evidence")
      .nullable(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (
      (evidence.evidenceCompleteness === "complete") !==
      (evidence.proposal !== null && evidence.verdict !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Public case completeness contradicts proposal and verdict",
        path: ["evidenceCompleteness"],
      });
    }
    if (evidence.proposal === null) return;
    const executions = [
      evidence.caseEvidence.baseline,
      ...(evidence.caseEvidence.replay === null
        ? []
        : [evidence.caseEvidence.replay]),
      ...evidence.caseEvidence.candidates,
    ];
    const eventIds = new Set(
      executions.flatMap((execution) =>
        execution.causalEvents.map((event) => event.eventId),
      ),
    );
    if (evidence.proposal.evidenceEventIds.some((id) => !eventIds.has(id))) {
      context.addIssue({
        code: "custom",
        message: "Proposal event reference is absent from public evidence",
        path: ["proposal", "evidenceEventIds"],
      });
    }
    const candidateIds = new Set(
      evidence.caseEvidence.candidates.map(
        (execution) => execution.executionId,
      ),
    );
    if (
      evidence.proposal.candidateExecutionIds.some(
        (id) => !candidateIds.has(id),
      ) ||
      (evidence.proposal.replayExecutionId !== null &&
        evidence.caseEvidence.replay?.executionId !==
          evidence.proposal.replayExecutionId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Proposal execution reference is absent from public evidence",
        path: ["proposal"],
      });
    }
  });

export const BenchmarkPublishedCaseEvidenceV2Schema = z.union([
  z
    .object({
      promptAudit: z.null(),
      proposal: z.null(),
      accessReceipts: z.tuple([]),
      verdict: z.null(),
      gameExecutions: z.null(),
      caseEvidence: z.null(),
      evidenceCompleteness: z.literal("unavailable"),
      unavailableReason: z.literal("raw_manifest_unavailable"),
    })
    .strict(),
  z
    .object({
      stage: z.literal("baseline_completed"),
      promptAudit: z.null(),
      proposal: z.null(),
      accessReceipts: z.tuple([]),
      verdict: z.null(),
      gameExecutions: z.literal(1),
      caseEvidence: z.null(),
      baselineExecutionId: ExecutionIdSchema,
      baselineTimelineDigest: Sha256V1Schema,
      evidenceCompleteness: z.literal("partial"),
      unavailableReason: z.literal("attempt_interrupted_after_baseline"),
    })
    .strict(),
  BenchmarkCompleteOrDiagnosticCaseEvidenceV2Schema,
]);

export const BenchmarkPublishedCaseBundleV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    reportHash: Sha256V1Schema,
    selectionHash: Sha256V1Schema,
    suiteId: BenchmarkSuiteIdSchema,
    definitionId: BenchmarkDefinitionIdSchema,
    executionId: BenchmarkExecutionIdSchema,
    provenance: BenchmarkProvenanceV2Schema,
    caseStatus: z.enum(["absent", "present"]),
    cell: BenchmarkCellResultV2Schema.nullable(),
    attempt: BenchmarkCellAttemptV2Schema.nullable(),
    evidence: BenchmarkPublishedCaseEvidenceV2Schema,
    caseHash: Sha256V1Schema,
  })
  .strict()
  .superRefine((bundle, context) => {
    const present = bundle.cell !== null && bundle.attempt !== null;
    if ((bundle.caseStatus === "present") !== present) {
      context.addIssue({
        code: "custom",
        message: "Published case status contradicts its cell and attempt",
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
        bundle.attempt.suiteId !== bundle.suiteId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Published case attempt linkage is invalid",
        path: ["attempt"],
      });
    }
  });
export type BenchmarkPublishedCaseBundleV2 = z.infer<
  typeof BenchmarkPublishedCaseBundleV2Schema
>;

export interface BenchmarkExecutionStartedV2 {
  readonly schemaVersion: 2;
  readonly suiteId: BenchmarkSuiteId;
  readonly definitionId: BenchmarkDefinitionId;
  readonly executionId: BenchmarkExecutionId;
  readonly selectionHash: string;
  readonly startedAt: string;
  readonly provenance: BenchmarkProvenanceV2;
}

export const BenchmarkExecutionStartedV2Schema: z.ZodType<BenchmarkExecutionStartedV2> =
  z
    .object({
      schemaVersion: z.literal(2),
      suiteId: BenchmarkSuiteIdSchema,
      definitionId: BenchmarkDefinitionIdSchema,
      executionId: BenchmarkExecutionIdSchema,
      selectionHash: Sha256V1Schema,
      startedAt: z.string().datetime(),
      provenance: BenchmarkProvenanceV2Schema,
    })
    .strict();

export interface BenchmarkAttemptStartedV2 {
  readonly schemaVersion: 2;
  readonly suiteId: BenchmarkSuiteId;
  readonly definitionId: BenchmarkDefinitionId;
  readonly executionId: BenchmarkExecutionId;
  readonly cellId: BenchmarkCellId;
  readonly attemptId: BenchmarkAttemptId;
  readonly fixtureId: FixtureId;
  readonly arm: BenchmarkArmV1;
  readonly repetition: number;
  readonly ordinal: number;
  readonly kind: BenchmarkAttemptKindV2;
  readonly previousAttemptHash: string | null;
  readonly startedAt: string;
}

export const BenchmarkAttemptStartedV2Schema: z.ZodType<BenchmarkAttemptStartedV2> =
  z
    .object({
      schemaVersion: z.literal(2),
      suiteId: BenchmarkSuiteIdSchema,
      definitionId: BenchmarkDefinitionIdSchema,
      executionId: BenchmarkExecutionIdSchema,
      cellId: BenchmarkCellIdSchema,
      attemptId: BenchmarkAttemptIdSchema,
      fixtureId: FixtureIdSchema,
      arm: BenchmarkArmV1Schema,
      repetition: z.number().int().positive(),
      ordinal: z.number().int().min(1).max(6),
      kind: BenchmarkAttemptKindV2Schema,
      previousAttemptHash: Sha256V1Schema.nullable(),
      startedAt: z.string().datetime(),
    })
    .strict()
    .superRefine((attempt, context) => {
      const expectedKind =
        attempt.ordinal === 1
          ? "initial"
          : attempt.ordinal === 4
            ? "recovery"
            : "infra_retry";
      if (attempt.kind !== expectedKind) {
        context.addIssue({
          code: "custom",
          message: `Attempt ordinal ${attempt.ordinal} must be ${expectedKind}`,
          path: ["kind"],
        });
      }
      if ((attempt.ordinal === 1) !== (attempt.previousAttemptHash === null)) {
        context.addIssue({
          code: "custom",
          message: "Only the initial attempt may omit its predecessor hash",
          path: ["previousAttemptHash"],
        });
      }
    });

export interface BenchmarkAttemptProgressV2 {
  readonly schemaVersion: 2;
  readonly suiteId: BenchmarkSuiteId;
  readonly definitionId: BenchmarkDefinitionId;
  readonly executionId: BenchmarkExecutionId;
  readonly cellId: BenchmarkCellId;
  readonly attemptId: BenchmarkAttemptId;
  readonly ordinal: number;
  readonly sequence: number;
  readonly observedAt: string;
  readonly progressObserved: true;
  readonly validationStage:
    | "baseline_completed_unvalidated"
    | "fixture_material_validated"
    | "agent_progress";
  readonly metrics: z.infer<typeof BenchmarkCellMetricsV2Schema>;
  readonly rawManifest: JsonValue;
}

export const BenchmarkAttemptProgressV2Schema: z.ZodType<BenchmarkAttemptProgressV2> =
  z
    .object({
      schemaVersion: z.literal(2),
      suiteId: BenchmarkSuiteIdSchema,
      definitionId: BenchmarkDefinitionIdSchema,
      executionId: BenchmarkExecutionIdSchema,
      cellId: BenchmarkCellIdSchema,
      attemptId: BenchmarkAttemptIdSchema,
      ordinal: z.number().int().min(1).max(6),
      sequence: z.number().int().positive(),
      observedAt: z.string().datetime(),
      progressObserved: z.literal(true),
      validationStage: z.enum([
        "baseline_completed_unvalidated",
        "fixture_material_validated",
        "agent_progress",
      ]),
      metrics: BenchmarkCellMetricsV2Schema,
      rawManifest: JsonValueSchema,
    })
    .strict();

/**
 * Atomic recovery envelope for an attempt completion. The terminal cell is
 * carried beside the canonical attempt so a crash between the two immutable
 * publications can be repaired without repeating a model call.
 */
export interface BenchmarkAttemptFinishedV2 {
  readonly schemaVersion: 2;
  readonly attempt: BenchmarkCellAttemptV2;
  readonly terminalCell: BenchmarkCellResultV2 | null;
  readonly rawManifest: JsonValue | null;
}

export const BenchmarkAttemptFinishedV2Schema: z.ZodType<BenchmarkAttemptFinishedV2> =
  z
    .object({
      schemaVersion: z.literal(2),
      attempt: BenchmarkCellAttemptV2Schema,
      terminalCell: BenchmarkCellResultV2Schema.nullable(),
      rawManifest: JsonValueSchema.nullable(),
    })
    .strict()
    .superRefine((record, context) => {
      const cell = record.terminalCell;
      if (
        cell !== null &&
        (cell.suiteId !== record.attempt.suiteId ||
          cell.definitionId !== record.attempt.definitionId ||
          cell.executionId !== record.attempt.executionId ||
          cell.cellId !== record.attempt.cellId ||
          cell.fixtureId !== record.attempt.fixtureId ||
          cell.arm !== record.attempt.arm ||
          cell.repetition !== record.attempt.repetition ||
          cell.selectedAttemptId !== record.attempt.attemptId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Terminal cell provenance does not match its attempt",
          path: ["terminalCell"],
        });
      }
      const requiresTerminal =
        record.attempt.outcome.status === "completed" ||
        record.attempt.outcome.status === "diagnostic_failure" ||
        record.attempt.outcome.status === "invalid";
      if (requiresTerminal && cell === null) {
        context.addIssue({
          code: "custom",
          message: "Terminal model outcomes must carry their recoverable cell",
          path: ["terminalCell"],
        });
      }
      const expectedCellStatus =
        record.attempt.outcome.status === "completed"
          ? "scored"
          : record.attempt.outcome.status === "diagnostic_failure"
            ? "diagnostic_failure"
            : record.attempt.outcome.status === "invalid"
              ? "invalid"
              : "infra_exhausted";
      if (cell !== null && cell.status !== expectedCellStatus) {
        context.addIssue({
          code: "custom",
          message: "Terminal cell status contradicts its attempt outcome",
          path: ["terminalCell", "status"],
        });
      }
      const requiresRawManifest =
        record.attempt.outcome.status === "completed" ||
        record.attempt.outcome.status === "diagnostic_failure";
      if (requiresRawManifest !== (record.rawManifest !== null)) {
        context.addIssue({
          code: "custom",
          message:
            "Only completed and diagnostic-failure attempts carry a raw manifest",
          path: ["rawManifest"],
        });
      }
    });
