import { z } from "zod";

import { BenchmarkCaseEvidenceV2Schema } from "./benchmark-ledger.js";
import {
  DiagnosisProposalV3Schema,
  EvidenceAccessReceiptV1Schema,
} from "./diagnostic-v3.js";
import {
  BenchmarkArmV1Schema,
  DiagnosisVerdictV2Schema,
  MechanismCodeV2Schema,
} from "./v03.js";
import {
  BenchmarkAttemptIdSchema,
  BenchmarkCellIdSchema,
  BenchmarkDefinitionIdSchema,
  BenchmarkExecutionIdSchema,
  BenchmarkSuiteIdSchema,
  CapsuleIdSchema,
  CheckpointIdSchema,
  ContractIdSchema,
  ComparisonIdSchema,
  EvidenceAccessReceiptIdSchema,
  EventIdSchema,
  ExecutionIdSchema,
  FixtureIdSchema,
  InputTraceIdSchema,
  ProposalIdSchema,
  RunIdSchema,
  VerdictIdSchema,
} from "./ids.js";
import { JsonValueSchema } from "./json.js";
import { Sha256V1Schema } from "./benchmark-v2.js";

export const BenchmarkCampaignV3Schema = z.discriminatedUnion("campaignId", [
  z
    .object({
      campaignId: z.literal("v0.3.2-luna"),
      freezeTag: z.literal("v0.3.2-luna-benchmark-freeze"),
    })
    .strict(),
  z
    .object({
      campaignId: z.literal("v0.3.2-luna-r1"),
      freezeTag: z.literal("v0.3.2-luna-r1-benchmark-freeze"),
    })
    .strict(),
  z
    .object({
      campaignId: z.literal("v0.3.2-luna-r2"),
      freezeTag: z.literal("v0.3.2-luna-r2-benchmark-freeze"),
    })
    .strict(),
  z
    .object({
      campaignId: z.literal("v0.3.2-luna-r3"),
      freezeTag: z.literal("v0.3.2-luna-r3-benchmark-freeze"),
    })
    .strict(),
]);
export type BenchmarkCampaignV3 = z.infer<typeof BenchmarkCampaignV3Schema>;

export const BenchmarkFixtureSpecV3Schema = z
  .object({
    fixtureId: FixtureIdSchema,
    expectedMechanism: MechanismCodeV2Schema.exclude(["unknown"]),
    expectedSource: z
      .object({
        virtualPath: z.literal("case/main.gd"),
        symbol: z.string().min(1),
      })
      .strict(),
    contractHash: Sha256V1Schema,
    inputTraceHash: Sha256V1Schema,
    interventionCatalogHash: Sha256V1Schema,
    oracleHash: Sha256V1Schema,
    aliasMapHash: Sha256V1Schema,
  })
  .strict();
export type BenchmarkFixtureSpecV3 = z.infer<
  typeof BenchmarkFixtureSpecV3Schema
>;

const RequiredScoreEligibleCellsByArmV3Schema = z
  .object({
    generic: z.literal(12),
    evidenceOnly: z.literal(12),
    chronoriftFull: z.literal(12),
  })
  .strict();

export const BenchmarkSuiteSpecV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    suiteId: BenchmarkSuiteIdSchema,
    definitionId: BenchmarkDefinitionIdSchema,
    suiteHash: Sha256V1Schema,
    campaign: BenchmarkCampaignV3Schema,
    subjectHash: Sha256V1Schema,
    runnerHash: Sha256V1Schema,
    metricSet: z.literal("grounded-diagnosis-v3"),
    fixtures: z.array(BenchmarkFixtureSpecV3Schema).length(4),
    arms: z.tuple([
      z.literal("generic"),
      z.literal("evidence-only"),
      z.literal("chronorift-full"),
    ]),
    repetitions: z.literal(3),
    orderSeed: z.enum([
      "chronorift-v0.3.2-luna-formal-1",
      "chronorift-v0.3.2-luna-r1-formal-1",
      "chronorift-v0.3.2-luna-r2-formal-1",
      "chronorift-v0.3.2-luna-r3-formal-1",
    ]),
    orderStrategy: z.literal("block_randomized_by_fixture_repetition"),
    provider: z.literal("openai-codex"),
    model: z.literal("gpt-5.6-luna"),
    thinkingLevel: z.literal("max"),
    modelRequirements: z
      .object({
        contextWindow: z.literal(272_000),
        maxTokens: z.literal(128_000),
        thinkingLevelMapMax: z.literal("max"),
      })
      .strict(),
    budgets: z
      .object({
        baselineExecutions: z.literal(1),
        maxReplays: z.literal(1),
        maxInterventions: z.literal(2),
        maxSourceCalls: z.literal(4),
        maxGameExecutions: z.literal(4),
        maxToolCalls: z.literal(12),
        maxToolErrors: z.literal(0),
        maxConsecutiveNonProgressToolResults: z.literal(0),
        timeoutMs: z.literal(600_000),
        concurrency: z.literal(1),
      })
      .strict(),
    retryPolicy: z
      .object({
        initialInfraRetries: z.literal(2),
        initialBackoffMs: z.tuple([z.literal(1_000), z.literal(3_000)]),
        maxRecoveryCycles: z.literal(1),
        maxAttemptsPerCell: z.literal(6),
        providerInternalRetries: z.literal(0),
      })
      .strict(),
    gate: z
      .object({
        fullRequiredGroundedSuccesses: z.literal(9),
        fullExpectedCells: z.literal(12),
        minimumFullMinusGeneric: z.literal(0.2),
        fullMaximumIncorrectConfirmations: z.literal(0),
        requiredScoreEligibleCellsByArm:
          RequiredScoreEligibleCellsByArmV3Schema,
      })
      .strict(),
    calibrationStatus: z.literal("calibrated_on_same_fixtures"),
    samplingSeedAvailable: z.literal(false),
    preselectedCase: z
      .object({
        fixtureId: FixtureIdSchema,
        arm: z.literal("chronorift-full"),
        repetition: z.literal(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((spec, context) => {
    const fixtureIds = spec.fixtures.map((fixture) => fixture.fixtureId);
    if (new Set(fixtureIds).size !== fixtureIds.length) {
      context.addIssue({
        code: "custom",
        message: "Benchmark Fixture IDs must be unique",
        path: ["fixtures"],
      });
    }
    const mechanisms = spec.fixtures.map(
      (fixture) => fixture.expectedMechanism,
    );
    if (new Set(mechanisms).size !== mechanisms.length) {
      context.addIssue({
        code: "custom",
        message: "The calibrated suite requires one Fixture per mechanism",
        path: ["fixtures"],
      });
    }
    const preselected = spec.fixtures.find(
      (fixture) => fixture.fixtureId === spec.preselectedCase.fixtureId,
    );
    if (preselected?.expectedMechanism !== "discrete_physics_tunneling") {
      context.addIssue({
        code: "custom",
        message: "The preselected case must be the physics Fixture",
        path: ["preselectedCase", "fixtureId"],
      });
    }
    const expectedOrderSeed = {
      "v0.3.2-luna": "chronorift-v0.3.2-luna-formal-1",
      "v0.3.2-luna-r1": "chronorift-v0.3.2-luna-r1-formal-1",
      "v0.3.2-luna-r2": "chronorift-v0.3.2-luna-r2-formal-1",
      "v0.3.2-luna-r3": "chronorift-v0.3.2-luna-r3-formal-1",
    } as const satisfies Record<BenchmarkCampaignV3["campaignId"], string>;
    if (spec.orderSeed !== expectedOrderSeed[spec.campaign.campaignId]) {
      context.addIssue({
        code: "custom",
        message: "Benchmark order seed does not match its campaign",
        path: ["orderSeed"],
      });
    }
  });
export type BenchmarkSuiteSpecV3 = z.infer<typeof BenchmarkSuiteSpecV3Schema>;

export const BenchmarkProvenanceV3Schema = z
  .object({
    gitCommit: z.string().regex(/^[a-f0-9]{7,64}$/u),
    freezeTag: z.enum([
      "v0.3.2-luna-benchmark-freeze",
      "v0.3.2-luna-r1-benchmark-freeze",
      "v0.3.2-luna-r2-benchmark-freeze",
      "v0.3.2-luna-r3-benchmark-freeze",
    ]),
    dirty: z.literal(false),
    lockfileHash: Sha256V1Schema,
    piPackageVersion: z.string().min(1),
    nodeVersion: z.string().min(1),
    pnpmVersion: z.string().min(1),
    godotVersion: z.string().min(1),
    godotExecutableHash: Sha256V1Schema,
    resolvedProvider: z.literal("openai-codex"),
    resolvedModelId: z.literal("gpt-5.6-luna"),
    resolvedModelName: z.literal("GPT-5.6 Luna"),
    resolvedContextWindow: z.literal(272_000),
    resolvedMaxTokens: z.literal(128_000),
    mappedThinkingLevel: z.literal("max"),
    requestedThinkingLevel: z.literal("max"),
    os: z.string().min(1),
    arch: z.string().min(1),
    platform: z.string().min(1),
  })
  .strict();
export type BenchmarkProvenanceV3 = z.infer<typeof BenchmarkProvenanceV3Schema>;

export const BenchmarkProviderFailureCodeV3Schema = z.enum([
  "connection",
  "timeout",
  "http_408",
  "http_429",
  "http_5xx",
  "auth",
  "model_not_found",
  "non_retryable_4xx",
  "provider_error_unknown",
  "aborted",
]);
export type BenchmarkProviderFailureCodeV3 = z.infer<
  typeof BenchmarkProviderFailureCodeV3Schema
>;

export const BenchmarkProviderFailureV3Schema = z
  .object({
    phase: z.enum(["request", "response_stream"]),
    code: BenchmarkProviderFailureCodeV3Schema,
    httpStatus: z.number().int().min(100).max(599).nullable(),
    retryClass: z.enum(["transient", "permanent", "unknown"]),
  })
  .strict()
  .superRefine((failure, context) => {
    const expectedStatus =
      failure.code === "http_408"
        ? 408
        : failure.code === "http_429"
          ? 429
          : null;
    if (expectedStatus !== null && failure.httpStatus !== expectedStatus) {
      context.addIssue({
        code: "custom",
        message: `${failure.code} requires HTTP ${expectedStatus}`,
        path: ["httpStatus"],
      });
    }
    if (
      failure.code === "http_5xx" &&
      (failure.httpStatus === null || failure.httpStatus < 500)
    ) {
      context.addIssue({
        code: "custom",
        message: "http_5xx requires a 5xx status",
        path: ["httpStatus"],
      });
    }
    const permanent = new Set<BenchmarkProviderFailureCodeV3>([
      "auth",
      "model_not_found",
      "non_retryable_4xx",
    ]);
    const transient = new Set<BenchmarkProviderFailureCodeV3>([
      "connection",
      "timeout",
      "http_408",
      "http_429",
      "http_5xx",
    ]);
    if (permanent.has(failure.code) && failure.retryClass !== "permanent") {
      context.addIssue({
        code: "custom",
        message: "Permanent provider failures must not be marked retryable",
        path: ["retryClass"],
      });
    }
    if (transient.has(failure.code) && failure.retryClass !== "transient") {
      context.addIssue({
        code: "custom",
        message: "Transient provider failures require transient retry class",
        path: ["retryClass"],
      });
    }
    if (
      failure.code === "provider_error_unknown" &&
      failure.retryClass !== "unknown"
    ) {
      context.addIssue({
        code: "custom",
        message: "Unknown provider failures require unknown retry class",
        path: ["retryClass"],
      });
    }
  });
export type BenchmarkProviderFailureV3 = z.infer<
  typeof BenchmarkProviderFailureV3Schema
>;

export const BenchmarkInfrastructureFailureV3Schema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("provider"),
        provider: BenchmarkProviderFailureV3Schema,
        retryClass: z.enum(["transient", "permanent", "unknown"]),
      })
      .strict()
      .superRefine((failure, context) => {
        if (failure.retryClass !== failure.provider.retryClass) {
          context.addIssue({
            code: "custom",
            message: "Provider and infrastructure retry classes must match",
            path: ["retryClass"],
          });
        }
      }),
    z
      .object({
        kind: z.literal("harness_timeout"),
        code: z.literal("no_progress_timeout"),
        retryClass: z.literal("transient"),
      })
      .strict(),
    z
      .object({
        kind: z.literal("process_interrupted"),
        code: z.literal("process_interrupted"),
        retryClass: z.literal("transient"),
      })
      .strict(),
  ],
);
export type BenchmarkInfrastructureFailureV3 = z.infer<
  typeof BenchmarkInfrastructureFailureV3Schema
>;

export const benchmarkInfrastructureFailureCodeV3 = (
  failure: BenchmarkInfrastructureFailureV3,
):
  | BenchmarkProviderFailureCodeV3
  | "no_progress_timeout"
  | "process_interrupted" =>
  failure.kind === "provider" ? failure.provider.code : failure.code;

export const BenchmarkAttemptProgressStateV3Schema = z
  .object({
    fixtureStage: z.enum(["none", "baseline_captured", "fixture_validated"]),
    model: z
      .object({
        requestStarted: z.boolean(),
        outputObserved: z.boolean(),
        turnCompleted: z.boolean(),
      })
      .strict(),
    tools: z
      .object({
        started: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        semanticRevision: z.number().int().nonnegative(),
      })
      .strict(),
    game: z
      .object({
        baselineExecutions: z.number().int().nonnegative(),
        diagnosticExecutions: z.number().int().nonnegative(),
      })
      .strict(),
    proposalSubmitted: z.boolean(),
  })
  .strict()
  .superRefine((progress, context) => {
    if (
      (progress.model.outputObserved || progress.model.turnCompleted) &&
      !progress.model.requestStarted
    ) {
      context.addIssue({
        code: "custom",
        message: "Model output and completion require a started request",
        path: ["model"],
      });
    }
    if (
      progress.tools.completed > progress.tools.started ||
      progress.tools.failed > progress.tools.completed ||
      progress.tools.semanticRevision > progress.tools.completed
    ) {
      context.addIssue({
        code: "custom",
        message: "Tool progress counters are not monotonic",
        path: ["tools"],
      });
    }
    if (
      progress.fixtureStage === "none" &&
      progress.game.baselineExecutions !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "A missing Fixture stage cannot have a baseline execution",
        path: ["game", "baselineExecutions"],
      });
    }
    if (
      progress.fixtureStage !== "none" &&
      progress.game.baselineExecutions < 1
    ) {
      context.addIssue({
        code: "custom",
        message: "Captured Fixture progress requires a baseline execution",
        path: ["game", "baselineExecutions"],
      });
    }
    if (progress.proposalSubmitted && progress.tools.completed === 0) {
      context.addIssue({
        code: "custom",
        message: "A submitted proposal requires a completed tool call",
        path: ["proposalSubmitted"],
      });
    }
  });
export type BenchmarkAttemptProgressStateV3 = z.infer<
  typeof BenchmarkAttemptProgressStateV3Schema
>;

export const BenchmarkTokenMetricsV3Schema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((tokens, context) => {
    if (
      tokens.total !==
      tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Token total must equal input, output, cache-read, and cache-write tokens",
        path: ["total"],
      });
    }
  });
export type BenchmarkTokenMetricsV3 = z.infer<
  typeof BenchmarkTokenMetricsV3Schema
>;

export const BenchmarkCellMetricsV3Schema = z
  .object({
    gameExecutions: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    wallTimeMs: z.number().int().nonnegative(),
    tokens: BenchmarkTokenMetricsV3Schema,
  })
  .strict();
export type BenchmarkCellMetricsV3 = z.infer<
  typeof BenchmarkCellMetricsV3Schema
>;

export const BenchmarkAttemptKindV3Schema = z.enum([
  "initial",
  "infra_retry",
  "recovery",
]);
export type BenchmarkAttemptKindV3 = z.infer<
  typeof BenchmarkAttemptKindV3Schema
>;

export const BenchmarkDiagnosticFailureCodeV3Schema = z.enum([
  "progress_timeout",
  "process_interrupted_after_progress",
  "proposal_missing",
  "invalid_proposal",
  "invalid_tool_flow",
  "budget_exhausted",
]);
export type BenchmarkDiagnosticFailureCodeV3 = z.infer<
  typeof BenchmarkDiagnosticFailureCodeV3Schema
>;

export const BenchmarkInvalidCodeV3Schema = z.enum([
  "auth_failure",
  "model_incompatible",
  "non_retryable_http_4xx",
  "harness_failure",
  "godot_failure",
  "schema_failure",
]);
export type BenchmarkInvalidCodeV3 = z.infer<
  typeof BenchmarkInvalidCodeV3Schema
>;

/** Hash-only prompt and frozen material binding; no provider session paths leak into core. */
export const BenchmarkPromptAuditV3Schema = z
  .object({
    failureBriefHash: Sha256V1Schema,
    failureBriefReceiptId: EvidenceAccessReceiptIdSchema,
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
export type BenchmarkPromptAuditV3 = z.infer<
  typeof BenchmarkPromptAuditV3Schema
>;

export const BenchmarkFixtureOracleV3Schema = z
  .object({
    oracleHash: Sha256V1Schema,
    expectedMechanism: MechanismCodeV2Schema.exclude(["unknown"]),
    expectedSource: z
      .object({
        virtualPath: z.literal("case/main.gd"),
        symbol: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type BenchmarkFixtureOracleV3 = z.infer<
  typeof BenchmarkFixtureOracleV3Schema
>;

const BenchmarkRawAttemptManifestIdentityV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    manifestKind: z.literal("benchmark_attempt_terminal"),
    suiteId: BenchmarkSuiteIdSchema,
    definitionId: BenchmarkDefinitionIdSchema,
    executionId: BenchmarkExecutionIdSchema,
    cellId: BenchmarkCellIdSchema,
    attemptId: BenchmarkAttemptIdSchema,
    fixtureId: FixtureIdSchema,
    arm: BenchmarkArmV1Schema,
    repetition: z.number().int().positive(),
    ordinal: z.number().int().min(1).max(6),
    runId: RunIdSchema,
    promptAudit: BenchmarkPromptAuditV3Schema,
    caseEvidence: BenchmarkCaseEvidenceV2Schema,
    progress: BenchmarkAttemptProgressStateV3Schema,
    metrics: BenchmarkCellMetricsV3Schema,
    oracle: BenchmarkFixtureOracleV3Schema,
  })
  .strict();

export const BenchmarkCompletedRawAttemptManifestV3Schema =
  BenchmarkRawAttemptManifestIdentityV3Schema.extend({
    terminalStatus: z.literal("completed"),
    proposal: DiagnosisProposalV3Schema,
    accessReceipts: z.array(EvidenceAccessReceiptV1Schema),
    verdict: DiagnosisVerdictV2Schema,
  }).strict();
export type BenchmarkCompletedRawAttemptManifestV3 = z.infer<
  typeof BenchmarkCompletedRawAttemptManifestV3Schema
>;

export const BenchmarkDiagnosticFailureManifestErrorV3Schema =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("provider"),
        phase: z.enum(["request", "response_stream"]),
        code: BenchmarkProviderFailureCodeV3Schema,
        httpStatus: z.number().int().min(100).max(599).nullable(),
        retryClass: z.enum(["transient", "permanent", "unknown"]),
        messageHash: Sha256V1Schema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("harness"),
        code: z.string().min(1),
        messageHash: Sha256V1Schema,
      })
      .strict(),
  ]);
export type BenchmarkDiagnosticFailureManifestErrorV3 = z.infer<
  typeof BenchmarkDiagnosticFailureManifestErrorV3Schema
>;

export const BenchmarkDiagnosticFailureRawAttemptManifestV3Schema =
  BenchmarkRawAttemptManifestIdentityV3Schema.extend({
    terminalStatus: z.literal("diagnostic_failure"),
    diagnosticCode: BenchmarkDiagnosticFailureCodeV3Schema,
    error: BenchmarkDiagnosticFailureManifestErrorV3Schema,
  }).strict();
export type BenchmarkDiagnosticFailureRawAttemptManifestV3 = z.infer<
  typeof BenchmarkDiagnosticFailureRawAttemptManifestV3Schema
>;

/** Strict terminal evidence accepted by the V3 ledger. Progress manifests use their own stage schemas. */
export const BenchmarkRawAttemptManifestV3Schema = z.discriminatedUnion(
  "terminalStatus",
  [
    BenchmarkCompletedRawAttemptManifestV3Schema,
    BenchmarkDiagnosticFailureRawAttemptManifestV3Schema,
  ],
);
export type BenchmarkRawAttemptManifestV3 = z.infer<
  typeof BenchmarkRawAttemptManifestV3Schema
>;

/** Prose-free projection embedded in the public report for standalone rescoring. */
export const BenchmarkScoringProposalV3Schema = z
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
    hasBlockers: z.boolean(),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();
export type BenchmarkScoringProposalV3 = z.infer<
  typeof BenchmarkScoringProposalV3Schema
>;

export const BenchmarkScoringVerdictV3Schema = z
  .object({
    verdictId: VerdictIdSchema,
    proposalId: ProposalIdSchema,
    runId: RunIdSchema,
    fixtureId: FixtureIdSchema,
    status: z.enum(["confirmed", "inconclusive"]),
    mechanismCode: MechanismCodeV2Schema,
    blockerCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((verdict, context) => {
    if ((verdict.blockerCount === 0) !== (verdict.status === "confirmed")) {
      context.addIssue({
        code: "custom",
        message:
          "Scoring verdict status must be determined by Harness blockers",
        path: ["status"],
      });
    }
  });
export type BenchmarkScoringVerdictV3 = z.infer<
  typeof BenchmarkScoringVerdictV3Schema
>;

export const BenchmarkScoredCellProofV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    proofKind: z.literal("scored"),
    cellId: BenchmarkCellIdSchema,
    selectedAttemptId: BenchmarkAttemptIdSchema,
    rawManifestHash: Sha256V1Schema,
    caseEvidence: BenchmarkCaseEvidenceV2Schema,
    proposal: BenchmarkScoringProposalV3Schema,
    accessReceipts: z.array(EvidenceAccessReceiptV1Schema),
    verdict: BenchmarkScoringVerdictV3Schema,
    oracle: BenchmarkFixtureOracleV3Schema,
  })
  .strict();
export type BenchmarkScoredCellProofV3 = z.infer<
  typeof BenchmarkScoredCellProofV3Schema
>;

export const BenchmarkDiagnosticCellProofV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    proofKind: z.literal("diagnostic_failure"),
    cellId: BenchmarkCellIdSchema,
    selectedAttemptId: BenchmarkAttemptIdSchema,
    rawManifestHash: Sha256V1Schema,
    diagnosticCode: BenchmarkDiagnosticFailureCodeV3Schema,
    oracle: BenchmarkFixtureOracleV3Schema,
  })
  .strict();
export type BenchmarkDiagnosticCellProofV3 = z.infer<
  typeof BenchmarkDiagnosticCellProofV3Schema
>;

export const BenchmarkCellScoringProofV3Schema = z.discriminatedUnion(
  "proofKind",
  [BenchmarkScoredCellProofV3Schema, BenchmarkDiagnosticCellProofV3Schema],
);
export type BenchmarkCellScoringProofV3 = z.infer<
  typeof BenchmarkCellScoringProofV3Schema
>;

export const BenchmarkCellAttemptOutcomeV3Schema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("completed"),
        rawManifestHash: Sha256V1Schema,
      })
      .strict(),
    z
      .object({
        status: z.literal("diagnostic_failure"),
        code: BenchmarkDiagnosticFailureCodeV3Schema,
        message: z.literal("Terminal diagnostic failure"),
        rawManifestHash: Sha256V1Schema,
      })
      .strict(),
    z
      .object({
        status: z.literal("infra_failure"),
        failure: BenchmarkInfrastructureFailureV3Schema,
        message: z.literal("Infrastructure failure"),
        retryable: z.boolean(),
      })
      .strict(),
    z
      .object({
        status: z.literal("invalid"),
        code: BenchmarkInvalidCodeV3Schema,
        infrastructureFailure:
          BenchmarkInfrastructureFailureV3Schema.nullable(),
        message: z.literal("Invalid formal attempt"),
        retryable: z.literal(false),
      })
      .strict(),
    z
      .object({
        status: z.literal("interrupted"),
        code: z.literal("process_interrupted"),
        message: z.literal("Retryable process interruption"),
        retryable: z.literal(true),
      })
      .strict(),
  ],
);
export type BenchmarkCellAttemptOutcomeV3 = z.infer<
  typeof BenchmarkCellAttemptOutcomeV3Schema
>;

export const benchmarkProgressHasDiagnosticActivityV3 = (
  progress: BenchmarkAttemptProgressStateV3,
): boolean =>
  progress.model.outputObserved ||
  progress.tools.started > 0 ||
  progress.game.diagnosticExecutions > 0 ||
  progress.proposalSubmitted;

export const BenchmarkCellAttemptV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    suiteId: BenchmarkSuiteIdSchema,
    definitionId: BenchmarkDefinitionIdSchema,
    executionId: BenchmarkExecutionIdSchema,
    cellId: BenchmarkCellIdSchema,
    attemptId: BenchmarkAttemptIdSchema,
    fixtureId: FixtureIdSchema,
    arm: BenchmarkArmV1Schema,
    repetition: z.number().int().positive(),
    ordinal: z.number().int().min(1).max(6),
    kind: BenchmarkAttemptKindV3Schema,
    previousAttemptHash: Sha256V1Schema.nullable(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    progress: BenchmarkAttemptProgressStateV3Schema,
    metrics: BenchmarkCellMetricsV3Schema,
    outcome: BenchmarkCellAttemptOutcomeV3Schema,
    attemptHash: Sha256V1Schema,
  })
  .strict()
  .superRefine((attempt, context) => {
    if ((attempt.ordinal === 1) !== (attempt.previousAttemptHash === null)) {
      context.addIssue({
        code: "custom",
        message: "Only the first attempt may omit its previous attempt hash",
        path: ["previousAttemptHash"],
      });
    }
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
    if (Date.parse(attempt.finishedAt) < Date.parse(attempt.startedAt)) {
      context.addIssue({
        code: "custom",
        message: "Attempt completion precedes its start",
        path: ["finishedAt"],
      });
    }
    if (
      attempt.progress.tools.completed > attempt.metrics.toolCalls ||
      attempt.progress.game.baselineExecutions +
        attempt.progress.game.diagnosticExecutions >
        attempt.metrics.gameExecutions
    ) {
      context.addIssue({
        code: "custom",
        message: "Attempt metrics undercount recorded progress",
        path: ["metrics"],
      });
    }
    if (attempt.outcome.status === "infra_failure") {
      const hasDiagnosticActivity = benchmarkProgressHasDiagnosticActivityV3(
        attempt.progress,
      );
      const retryClassAllowsRetry =
        attempt.outcome.failure.retryClass === "transient";
      if (
        attempt.outcome.retryable !==
        (!hasDiagnosticActivity && retryClassAllowsRetry)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Retries require a transient infrastructure failure before diagnostic progress",
          path: ["outcome", "retryable"],
        });
      }
    }
  });
export type BenchmarkCellAttemptV3 = z.infer<
  typeof BenchmarkCellAttemptV3Schema
>;

export const BenchmarkAttemptProgressV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    suiteId: BenchmarkSuiteIdSchema,
    definitionId: BenchmarkDefinitionIdSchema,
    executionId: BenchmarkExecutionIdSchema,
    cellId: BenchmarkCellIdSchema,
    attemptId: BenchmarkAttemptIdSchema,
    ordinal: z.number().int().min(1).max(6),
    sequence: z.number().int().positive(),
    observedAt: z.string().datetime(),
    progress: BenchmarkAttemptProgressStateV3Schema,
    metrics: BenchmarkCellMetricsV3Schema,
    rawManifest: JsonValueSchema,
  })
  .strict();
export type BenchmarkAttemptProgressV3 = z.infer<
  typeof BenchmarkAttemptProgressV3Schema
>;

export const BenchmarkCellScoreV3Schema = z
  .object({
    proposalId: ProposalIdSchema.nullable(),
    candidateExecutionIds: z.array(ExecutionIdSchema),
    accessReceiptIds: z.array(EvidenceAccessReceiptIdSchema),
    proposedMechanism: MechanismCodeV2Schema,
    mechanismCorrect: z.boolean(),
    verdict: z.enum(["confirmed", "inconclusive"]),
    groundedSuccess: z.boolean(),
    incorrectConfirmation: z.boolean(),
    sourceLocationCorrect: z.boolean().nullable(),
    sourceGrounded: z.boolean(),
    confidence: z.number().finite().min(0).max(1).nullable(),
  })
  .strict()
  .superRefine((score, context) => {
    if (
      score.groundedSuccess !==
      (score.mechanismCorrect && score.verdict === "confirmed")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "groundedSuccess is determined only by mechanism correctness and the Harness verdict",
        path: ["groundedSuccess"],
      });
    }
    if (
      score.incorrectConfirmation !==
      (score.verdict === "confirmed" && !score.mechanismCorrect)
    ) {
      context.addIssue({
        code: "custom",
        message: "incorrectConfirmation contradicts mechanism and verdict",
        path: ["incorrectConfirmation"],
      });
    }
    if ((score.sourceLocationCorrect !== null) !== score.sourceGrounded) {
      context.addIssue({
        code: "custom",
        message: "Source scoring requires an exact access receipt",
        path: ["sourceGrounded"],
      });
    }
    if (
      score.verdict === "confirmed" &&
      (score.proposalId === null ||
        score.candidateExecutionIds.length === 0 ||
        score.accessReceiptIds.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Confirmed benchmark scores require a proposal, candidate execution, and access receipt",
        path: ["verdict"],
      });
    }
    for (const [field, values] of [
      ["candidateExecutionIds", score.candidateExecutionIds],
      ["accessReceiptIds", score.accessReceiptIds],
    ] as const) {
      if (new Set<string>(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: `${field} must contain unique references`,
          path: [field],
        });
      }
    }
  });
export type BenchmarkCellScoreV3 = z.infer<typeof BenchmarkCellScoreV3Schema>;

export const BenchmarkCellResultV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    suiteId: BenchmarkSuiteIdSchema,
    definitionId: BenchmarkDefinitionIdSchema,
    executionId: BenchmarkExecutionIdSchema,
    cellId: BenchmarkCellIdSchema,
    fixtureId: FixtureIdSchema,
    arm: BenchmarkArmV1Schema,
    repetition: z.number().int().positive(),
    expectedMechanism: MechanismCodeV2Schema.exclude(["unknown"]),
    status: z.enum([
      "scored",
      "diagnostic_failure",
      "infra_unavailable",
      "invalid",
    ]),
    terminalCode: z
      .union([
        BenchmarkDiagnosticFailureCodeV3Schema,
        BenchmarkProviderFailureCodeV3Schema,
        BenchmarkInvalidCodeV3Schema,
        z.literal("no_progress_timeout"),
        z.literal("process_interrupted"),
      ])
      .nullable(),
    infrastructureFailure: BenchmarkInfrastructureFailureV3Schema.nullable(),
    attemptIds: z.array(BenchmarkAttemptIdSchema).nonempty(),
    selectedAttemptId: BenchmarkAttemptIdSchema,
    score: BenchmarkCellScoreV3Schema.nullable(),
    metrics: BenchmarkCellMetricsV3Schema,
    rawManifestHash: Sha256V1Schema.nullable(),
  })
  .strict()
  .superRefine((cell, context) => {
    if (!cell.attemptIds.includes(cell.selectedAttemptId)) {
      context.addIssue({
        code: "custom",
        message: "Selected attempt must be in the cell attempt chain",
        path: ["selectedAttemptId"],
      });
    }
    if (new Set(cell.attemptIds).size !== cell.attemptIds.length) {
      context.addIssue({
        code: "custom",
        message: "Cell attempt IDs must be unique",
        path: ["attemptIds"],
      });
    }
    const scoreRequired =
      cell.status === "scored" || cell.status === "diagnostic_failure";
    if (scoreRequired !== (cell.score !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only score-eligible terminal cells carry a score",
        path: ["score"],
      });
    }
    if ((cell.status === "scored") !== (cell.terminalCode === null)) {
      context.addIssue({
        code: "custom",
        message: "Only scored cells omit a terminal code",
        path: ["terminalCode"],
      });
    }
    if (
      (cell.status === "infra_unavailable") !==
      (cell.infrastructureFailure !== null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Only infrastructure-unavailable cells carry infrastructure facts",
        path: ["infrastructureFailure"],
      });
    }
    const hasRawManifest =
      cell.status === "scored" || cell.status === "diagnostic_failure";
    if (hasRawManifest !== (cell.rawManifestHash !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only scored and diagnostic-failure cells bind a raw manifest",
        path: ["rawManifestHash"],
      });
    }
    if (
      cell.infrastructureFailure !== null &&
      cell.terminalCode !==
        benchmarkInfrastructureFailureCodeV3(cell.infrastructureFailure)
    ) {
      context.addIssue({
        code: "custom",
        message: "Provider failure and terminal code do not match",
        path: ["terminalCode"],
      });
    }
    if (
      cell.score !== null &&
      cell.score.mechanismCorrect !==
        (cell.score.proposedMechanism === cell.expectedMechanism)
    ) {
      context.addIssue({
        code: "custom",
        message: "mechanismCorrect contradicts the Fixture oracle",
        path: ["score", "mechanismCorrect"],
      });
    }
    if (cell.status === "diagnostic_failure") {
      const score = cell.score;
      if (
        score === null ||
        score.proposalId !== null ||
        score.candidateExecutionIds.length !== 0 ||
        score.accessReceiptIds.length !== 0 ||
        score.proposedMechanism !== "unknown" ||
        score.mechanismCorrect ||
        score.verdict !== "inconclusive" ||
        score.groundedSuccess ||
        score.incorrectConfirmation ||
        score.sourceLocationCorrect !== null ||
        score.sourceGrounded ||
        score.confidence !== null
      ) {
        context.addIssue({
          code: "custom",
          message: "Diagnostic failures receive a fixed unsuccessful score",
          path: ["score"],
        });
      }
    }
    const terminalCodeMatches =
      (cell.status === "scored" && cell.terminalCode === null) ||
      (cell.status === "diagnostic_failure" &&
        BenchmarkDiagnosticFailureCodeV3Schema.safeParse(cell.terminalCode)
          .success) ||
      (cell.status === "infra_unavailable" &&
        (BenchmarkProviderFailureCodeV3Schema.safeParse(cell.terminalCode)
          .success ||
          cell.terminalCode === "no_progress_timeout" ||
          cell.terminalCode === "process_interrupted")) ||
      (cell.status === "invalid" &&
        BenchmarkInvalidCodeV3Schema.safeParse(cell.terminalCode).success);
    if (!terminalCodeMatches) {
      context.addIssue({
        code: "custom",
        message: "Cell status and terminal code do not match",
        path: ["terminalCode"],
      });
    }
  });
export type BenchmarkCellResultV3 = z.infer<typeof BenchmarkCellResultV3Schema>;

export const BenchmarkArmAggregateV3Schema = z
  .object({
    expectedCells: z.literal(12),
    scoreEligibleCells: z.number().int().min(0).max(12),
    infraUnavailableCells: z.number().int().min(0).max(12),
    diagnosticFailureCells: z.number().int().min(0).max(12),
    groundedSuccesses: z.number().int().nonnegative(),
    groundedSuccessRate: z.number().finite().min(0).max(1).nullable(),
    mechanismCorrect: z.number().int().nonnegative(),
    mechanismAccuracy: z.number().finite().min(0).max(1).nullable(),
    incorrectConfirmations: z.number().int().nonnegative(),
    sourceCorrect: z.number().int().nonnegative(),
    sourceAssessed: z.number().int().nonnegative(),
    totalGameExecutions: z.number().int().nonnegative(),
    totalToolCalls: z.number().int().nonnegative(),
    totalWallTimeMs: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict();
export type BenchmarkArmAggregateV3 = z.infer<
  typeof BenchmarkArmAggregateV3Schema
>;

export const BenchmarkAdvantageV3Schema = z
  .object({
    fullGroundedSuccesses: z.number().int().min(0).max(12),
    fullGroundedSuccessRate: z.number().finite().min(0).max(1),
    genericGroundedSuccessRate: z.number().finite().min(0).max(1),
    fullMinusGeneric: z.number().finite().min(-1).max(1),
    fullIncorrectConfirmations: z.number().int().nonnegative(),
    thresholdMet: z.boolean(),
  })
  .strict();
export type BenchmarkAdvantageV3 = z.infer<typeof BenchmarkAdvantageV3Schema>;

export const BenchmarkAggregateV3Schema = z
  .object({
    expectedCells: z.literal(36),
    terminalCells: z.number().int().min(0).max(36),
    scoreEligibleCells: z.number().int().min(0).max(36),
    byArm: z
      .object({
        generic: BenchmarkArmAggregateV3Schema,
        evidenceOnly: BenchmarkArmAggregateV3Schema,
        chronoriftFull: BenchmarkArmAggregateV3Schema,
      })
      .strict(),
    advantage: BenchmarkAdvantageV3Schema.nullable(),
  })
  .strict();
export type BenchmarkAggregateV3 = z.infer<typeof BenchmarkAggregateV3Schema>;

export const BenchmarkReportV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    suite: BenchmarkSuiteSpecV3Schema,
    executionId: BenchmarkExecutionIdSchema,
    selectionHash: Sha256V1Schema,
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    provenance: BenchmarkProvenanceV3Schema,
    attempts: z.array(BenchmarkCellAttemptV3Schema),
    cells: z.array(BenchmarkCellResultV3Schema),
    scoringProofs: z.array(BenchmarkCellScoringProofV3Schema),
    auditIssues: z.array(z.enum(["prompt_fairness_failed"])).max(1),
    status: z.enum(["complete", "incomplete", "invalid"]),
    aggregate: BenchmarkAggregateV3Schema.nullable(),
    reportHash: Sha256V1Schema,
  })
  .strict()
  .superRefine((report, context) => {
    if (report.provenance.freezeTag !== report.suite.campaign.freezeTag) {
      context.addIssue({
        code: "custom",
        message: "Benchmark provenance does not match the suite campaign",
        path: ["provenance", "freezeTag"],
      });
    }
    if ((report.status === "complete") !== (report.aggregate !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only complete reports carry an aggregate",
        path: ["aggregate"],
      });
    }
    if (Date.parse(report.finishedAt) < Date.parse(report.startedAt)) {
      context.addIssue({
        code: "custom",
        message: "Benchmark completion precedes its start",
        path: ["finishedAt"],
      });
    }
    for (const [collection, entries] of [
      ["attempts", report.attempts],
      ["cells", report.cells],
    ] as const) {
      for (const [index, entry] of entries.entries()) {
        if (
          entry.suiteId !== report.suite.suiteId ||
          entry.definitionId !== report.suite.definitionId ||
          entry.executionId !== report.executionId
        ) {
          context.addIssue({
            code: "custom",
            message: "Report entry provenance does not match its execution",
            path: [collection, index],
          });
        }
      }
    }
    const proofCellIds = report.scoringProofs.map((proof) => proof.cellId);
    if (new Set(proofCellIds).size !== proofCellIds.length) {
      context.addIssue({
        code: "custom",
        message: "Benchmark scoring proofs must have unique cell IDs",
        path: ["scoringProofs"],
      });
    }
  });
export type BenchmarkReportV3 = z.infer<typeof BenchmarkReportV3Schema>;

export const BenchmarkExecutionSelectionV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    suiteId: BenchmarkSuiteIdSchema,
    definitionId: BenchmarkDefinitionIdSchema,
    executionId: BenchmarkExecutionIdSchema,
    selectionHash: Sha256V1Schema,
  })
  .strict();
export type BenchmarkExecutionSelectionV3 = z.infer<
  typeof BenchmarkExecutionSelectionV3Schema
>;

export const BenchmarkExecutionStartedV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    suiteId: BenchmarkSuiteIdSchema,
    definitionId: BenchmarkDefinitionIdSchema,
    executionId: BenchmarkExecutionIdSchema,
    selectionHash: Sha256V1Schema,
    startedAt: z.string().datetime(),
    provenance: BenchmarkProvenanceV3Schema,
  })
  .strict();
export type BenchmarkExecutionStartedV3 = z.infer<
  typeof BenchmarkExecutionStartedV3Schema
>;

export const BenchmarkAttemptStartedV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    suiteId: BenchmarkSuiteIdSchema,
    definitionId: BenchmarkDefinitionIdSchema,
    executionId: BenchmarkExecutionIdSchema,
    cellId: BenchmarkCellIdSchema,
    attemptId: BenchmarkAttemptIdSchema,
    fixtureId: FixtureIdSchema,
    arm: BenchmarkArmV1Schema,
    repetition: z.number().int().positive(),
    ordinal: z.number().int().min(1).max(6),
    kind: BenchmarkAttemptKindV3Schema,
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
export type BenchmarkAttemptStartedV3 = z.infer<
  typeof BenchmarkAttemptStartedV3Schema
>;

export const BenchmarkAttemptFinishedV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    attempt: BenchmarkCellAttemptV3Schema,
    terminalCell: BenchmarkCellResultV3Schema.nullable(),
    rawManifest: BenchmarkRawAttemptManifestV3Schema.nullable(),
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
      record.attempt.outcome.status === "invalid" ||
      (record.attempt.outcome.status === "infra_failure" &&
        !record.attempt.outcome.retryable);
    if (requiresTerminal && cell === null) {
      context.addIssue({
        code: "custom",
        message: "Terminal attempt outcomes require a recoverable cell",
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
            : "infra_unavailable";
    if (cell !== null && cell.status !== expectedCellStatus) {
      context.addIssue({
        code: "custom",
        message: "Terminal cell status contradicts its attempt outcome",
        path: ["terminalCell", "status"],
      });
    }
    const manifestRequired =
      record.attempt.outcome.status === "completed" ||
      record.attempt.outcome.status === "diagnostic_failure";
    if (manifestRequired !== (record.rawManifest !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only completed and diagnostic attempts carry raw manifests",
        path: ["rawManifest"],
      });
    }
    const manifest = record.rawManifest;
    if (
      manifest !== null &&
      (manifest.suiteId !== record.attempt.suiteId ||
        manifest.definitionId !== record.attempt.definitionId ||
        manifest.executionId !== record.attempt.executionId ||
        manifest.cellId !== record.attempt.cellId ||
        manifest.attemptId !== record.attempt.attemptId ||
        manifest.fixtureId !== record.attempt.fixtureId ||
        manifest.arm !== record.attempt.arm ||
        manifest.repetition !== record.attempt.repetition ||
        manifest.ordinal !== record.attempt.ordinal)
    ) {
      context.addIssue({
        code: "custom",
        message: "Raw manifest lineage does not match its attempt",
        path: ["rawManifest"],
      });
    }
    if (
      manifest !== null &&
      manifest.terminalStatus !== record.attempt.outcome.status
    ) {
      context.addIssue({
        code: "custom",
        message: "Raw manifest terminal status contradicts its attempt",
        path: ["rawManifest", "terminalStatus"],
      });
    }
    if (
      manifest?.terminalStatus === "diagnostic_failure" &&
      record.attempt.outcome.status === "diagnostic_failure" &&
      manifest.diagnosticCode !== record.attempt.outcome.code
    ) {
      context.addIssue({
        code: "custom",
        message: "Raw manifest diagnostic code contradicts its attempt",
        path: ["rawManifest", "diagnosticCode"],
      });
    }
  });
export type BenchmarkAttemptFinishedV3 = z.infer<
  typeof BenchmarkAttemptFinishedV3Schema
>;

export interface BenchmarkGateEvaluationV3 {
  readonly status: "pass" | "fail" | "not_evaluated";
  readonly reasons: readonly string[];
}

export const BenchmarkGateEvaluationV3Schema: z.ZodType<BenchmarkGateEvaluationV3> =
  z
    .object({
      status: z.enum(["pass", "fail", "not_evaluated"]),
      reasons: z.array(z.string().min(1)),
    })
    .strict();
