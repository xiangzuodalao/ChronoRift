import { z } from "zod";

import {
  BenchmarkAttemptIdSchema,
  BenchmarkCellIdSchema,
  BenchmarkDefinitionIdSchema,
  BenchmarkExecutionIdSchema,
  BenchmarkSuiteIdSchema,
  EvidenceAccessReceiptIdSchema,
  ExecutionIdSchema,
  FixtureIdSchema,
  ProposalIdSchema,
} from "./ids.js";
import { BenchmarkArmV1Schema, MechanismCodeV2Schema } from "./v03.js";

export const Sha256V1Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export type Sha256V1 = z.infer<typeof Sha256V1Schema>;

export const BenchmarkFreezeTagV1Schema = z.enum([
  "v0.3.0-benchmark-freeze",
  "v0.3.1-benchmark-freeze",
  "v0.3.1-r2-benchmark-freeze",
]);
export type BenchmarkFreezeTagV1 = z.infer<typeof BenchmarkFreezeTagV1Schema>;

export const BenchmarkCampaignV1Schema = z.discriminatedUnion("campaignId", [
  z
    .object({
      campaignId: z.literal("v0.3.1"),
      freezeTag: z.literal("v0.3.1-benchmark-freeze"),
    })
    .strict(),
  z
    .object({
      campaignId: z.literal("v0.3.1-r2"),
      freezeTag: z.literal("v0.3.1-r2-benchmark-freeze"),
    })
    .strict(),
]);
export type BenchmarkCampaignV1 = z.infer<typeof BenchmarkCampaignV1Schema>;

export const BenchmarkFixtureSpecV2Schema = z
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
export type BenchmarkFixtureSpecV2 = z.infer<
  typeof BenchmarkFixtureSpecV2Schema
>;

export const BenchmarkSuiteSpecV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    suiteId: BenchmarkSuiteIdSchema,
    definitionId: BenchmarkDefinitionIdSchema,
    suiteHash: Sha256V1Schema,
    campaign: BenchmarkCampaignV1Schema.optional(),
    subjectHash: Sha256V1Schema,
    runnerHash: Sha256V1Schema,
    metricSet: z.literal("grounded-diagnosis-v2"),
    fixtures: z.array(BenchmarkFixtureSpecV2Schema).length(4),
    arms: z.tuple([
      z.literal("generic"),
      z.literal("evidence-only"),
      z.literal("chronorift-full"),
    ]),
    repetitions: z.literal(3),
    orderSeed: z.enum([
      "chronorift-v0.3-formal-1",
      "chronorift-v0.3.1-formal-1",
      "chronorift-v0.3.1-r2-formal-1",
    ]),
    orderStrategy: z.literal("block_randomized_by_fixture_repetition"),
    provider: z.literal("volcengine-coding-plan"),
    model: z.literal("glm-5.2"),
    thinkingLevel: z.literal("max"),
    modelRequirements: z
      .object({
        contextWindow: z.literal(1_000_000),
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
    const expectedOrderSeed =
      spec.campaign === undefined
        ? "chronorift-v0.3-formal-1"
        : spec.campaign.campaignId === "v0.3.1"
          ? "chronorift-v0.3.1-formal-1"
          : "chronorift-v0.3.1-r2-formal-1";
    if (spec.orderSeed !== expectedOrderSeed) {
      context.addIssue({
        code: "custom",
        message: "Benchmark campaign and order seed do not match",
        path: ["orderSeed"],
      });
    }
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
    if (!fixtureIds.includes(spec.preselectedCase.fixtureId)) {
      context.addIssue({
        code: "custom",
        message: "The preselected case must belong to this suite",
        path: ["preselectedCase", "fixtureId"],
      });
    }
    if (
      spec.fixtures.find(
        (fixture) => fixture.fixtureId === spec.preselectedCase.fixtureId,
      )?.expectedMechanism !== "discrete_physics_tunneling"
    ) {
      context.addIssue({
        code: "custom",
        message: "The preselected case must be the physics Fixture",
        path: ["preselectedCase", "fixtureId"],
      });
    }
  });
export type BenchmarkSuiteSpecV2 = z.infer<typeof BenchmarkSuiteSpecV2Schema>;

export const BenchmarkAttemptKindV2Schema = z.enum([
  "initial",
  "infra_retry",
  "recovery",
]);
export type BenchmarkAttemptKindV2 = z.infer<
  typeof BenchmarkAttemptKindV2Schema
>;

export const BenchmarkInfraFailureCodeV2Schema = z.enum([
  "no_progress_timeout",
  "connection_error",
  "http_408",
  "http_429",
  "http_5xx",
]);
export type BenchmarkInfraFailureCodeV2 = z.infer<
  typeof BenchmarkInfraFailureCodeV2Schema
>;

export const BenchmarkDiagnosticFailureCodeV2Schema = z.enum([
  "progress_timeout",
  "process_interrupted_after_progress",
  "proposal_missing",
  "invalid_proposal",
  "invalid_tool_flow",
  "budget_exhausted",
]);
export type BenchmarkDiagnosticFailureCodeV2 = z.infer<
  typeof BenchmarkDiagnosticFailureCodeV2Schema
>;

export const BenchmarkInvalidCodeV2Schema = z.enum([
  "auth_failure",
  "model_incompatible",
  "non_retryable_http_4xx",
  "harness_failure",
  "godot_failure",
  "schema_failure",
]);
export type BenchmarkInvalidCodeV2 = z.infer<
  typeof BenchmarkInvalidCodeV2Schema
>;

export const BenchmarkCellAttemptOutcomeV2Schema = z.discriminatedUnion(
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
        code: BenchmarkDiagnosticFailureCodeV2Schema,
        message: z.string().min(1),
        rawManifestHash: Sha256V1Schema,
      })
      .strict(),
    z
      .object({
        status: z.literal("infra_failure"),
        code: BenchmarkInfraFailureCodeV2Schema,
        message: z.string().min(1),
        retryable: z.literal(true),
      })
      .strict(),
    z
      .object({
        status: z.literal("invalid"),
        code: BenchmarkInvalidCodeV2Schema,
        message: z.string().min(1),
        retryable: z.literal(false),
      })
      .strict(),
    z
      .object({
        status: z.literal("interrupted"),
        code: z.literal("process_interrupted"),
        message: z.string().min(1),
        retryable: z.literal(true),
      })
      .strict(),
  ],
);
export type BenchmarkCellAttemptOutcomeV2 = z.infer<
  typeof BenchmarkCellAttemptOutcomeV2Schema
>;

const LegacyBenchmarkTokenMetricsV2Schema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();

const CachedBenchmarkTokenMetricsV2Schema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();

export const BenchmarkTokenMetricsV2Schema = z
  .union([
    LegacyBenchmarkTokenMetricsV2Schema,
    CachedBenchmarkTokenMetricsV2Schema,
  ])
  .superRefine((tokens, context) => {
    const expectedTotal =
      tokens.input +
      tokens.output +
      ("cacheRead" in tokens ? tokens.cacheRead + tokens.cacheWrite : 0);
    if (tokens.total !== expectedTotal) {
      context.addIssue({
        code: "custom",
        message:
          "Token total must equal input, output, cache-read, and cache-write tokens",
        path: ["total"],
      });
    }
  });
export type BenchmarkTokenMetricsV2 = z.infer<
  typeof BenchmarkTokenMetricsV2Schema
>;

export const BenchmarkCellAttemptV2Schema = z
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
    ordinal: z.number().int().positive(),
    kind: BenchmarkAttemptKindV2Schema,
    previousAttemptHash: Sha256V1Schema.nullable(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    progressObserved: z.boolean(),
    metrics: z
      .object({
        gameExecutions: z.number().int().nonnegative(),
        toolCalls: z.number().int().nonnegative(),
        wallTimeMs: z.number().int().nonnegative(),
        tokens: BenchmarkTokenMetricsV2Schema,
      })
      .strict(),
    outcome: BenchmarkCellAttemptOutcomeV2Schema,
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
    if (attempt.kind === "initial" && attempt.ordinal !== 1) {
      context.addIssue({
        code: "custom",
        message: "Only ordinal 1 may be an initial attempt",
        path: ["kind"],
      });
    }
    if (
      attempt.outcome.status === "infra_failure" &&
      attempt.progressObserved
    ) {
      context.addIssue({
        code: "custom",
        message: "Retryable infrastructure failures must have no progress",
        path: ["progressObserved"],
      });
    }
    if (Date.parse(attempt.finishedAt) < Date.parse(attempt.startedAt)) {
      context.addIssue({
        code: "custom",
        message: "Attempt completion precedes its start",
        path: ["finishedAt"],
      });
    }
    const expectedFailureMessage =
      attempt.outcome.status === "infra_failure"
        ? "Retryable infrastructure failure"
        : attempt.outcome.status === "diagnostic_failure"
          ? "Terminal diagnostic failure"
          : attempt.outcome.status === "invalid"
            ? "Invalid formal attempt"
            : attempt.outcome.status === "interrupted"
              ? "Retryable process interruption"
              : null;
    if (
      expectedFailureMessage !== null &&
      attempt.outcome.status !== "completed" &&
      attempt.outcome.message !== expectedFailureMessage
    ) {
      context.addIssue({
        code: "custom",
        message: "Formal attempt messages are fixed redacted labels",
        path: ["outcome", "message"],
      });
    }
  });
export type BenchmarkCellAttemptV2 = z.infer<
  typeof BenchmarkCellAttemptV2Schema
>;

export const BenchmarkCellScoreV2Schema = z
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
export type BenchmarkCellScoreV2 = z.infer<typeof BenchmarkCellScoreV2Schema>;

export const BenchmarkCellMetricsV2Schema = z
  .object({
    gameExecutions: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    wallTimeMs: z.number().int().nonnegative(),
    tokens: BenchmarkTokenMetricsV2Schema,
  })
  .strict();
export type BenchmarkCellMetricsV2 = z.infer<
  typeof BenchmarkCellMetricsV2Schema
>;

export const BenchmarkCellTerminalCodeV2Schema = z.union([
  BenchmarkDiagnosticFailureCodeV2Schema,
  BenchmarkInfraFailureCodeV2Schema,
  BenchmarkInvalidCodeV2Schema,
  z.literal("process_interrupted"),
]);
export type BenchmarkCellTerminalCodeV2 = z.infer<
  typeof BenchmarkCellTerminalCodeV2Schema
>;

export const BenchmarkCellResultV2Schema = z
  .object({
    schemaVersion: z.literal(2),
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
      "infra_exhausted",
      "invalid",
    ]),
    terminalCode: BenchmarkCellTerminalCodeV2Schema.nullable(),
    attemptIds: z.array(BenchmarkAttemptIdSchema).nonempty(),
    selectedAttemptId: BenchmarkAttemptIdSchema,
    score: BenchmarkCellScoreV2Schema.nullable(),
    metrics: BenchmarkCellMetricsV2Schema,
    rawManifestHash: Sha256V1Schema,
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
        message: "Only scoreable terminal cells carry a score",
        path: ["score"],
      });
    }
    if ((cell.status === "scored") !== (cell.terminalCode === null)) {
      context.addIssue({
        code: "custom",
        message: "Only scored cells omit a terminal failure code",
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
    if (
      cell.status === "diagnostic_failure" &&
      (cell.score?.proposalId !== null ||
        cell.score.proposedMechanism !== "unknown" ||
        cell.score.verdict !== "inconclusive" ||
        cell.score.confidence !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Diagnostic failures receive a fixed unsuccessful score",
        path: ["score"],
      });
    }
    const terminalCodeMatches =
      (cell.status === "scored" && cell.terminalCode === null) ||
      (cell.status === "diagnostic_failure" &&
        BenchmarkDiagnosticFailureCodeV2Schema.safeParse(cell.terminalCode)
          .success) ||
      (cell.status === "infra_exhausted" &&
        (BenchmarkInfraFailureCodeV2Schema.safeParse(cell.terminalCode)
          .success ||
          cell.terminalCode === "process_interrupted")) ||
      (cell.status === "invalid" &&
        BenchmarkInvalidCodeV2Schema.safeParse(cell.terminalCode).success);
    if (!terminalCodeMatches) {
      context.addIssue({
        code: "custom",
        message: "Cell status and terminal failure code do not match",
        path: ["terminalCode"],
      });
    }
  });
export type BenchmarkCellResultV2 = z.infer<typeof BenchmarkCellResultV2Schema>;

export const BenchmarkArmAggregateV2Schema = z
  .object({
    expectedCells: z.number().int().nonnegative(),
    groundedSuccesses: z.number().int().nonnegative(),
    groundedSuccessRate: z.number().finite().min(0).max(1),
    mechanismCorrect: z.number().int().nonnegative(),
    mechanismAccuracy: z.number().finite().min(0).max(1),
    incorrectConfirmations: z.number().int().nonnegative(),
    sourceCorrect: z.number().int().nonnegative(),
    sourceAssessed: z.number().int().nonnegative(),
    totalGameExecutions: z.number().int().nonnegative(),
    totalToolCalls: z.number().int().nonnegative(),
    totalWallTimeMs: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict();
export type BenchmarkArmAggregateV2 = z.infer<
  typeof BenchmarkArmAggregateV2Schema
>;

export const BenchmarkAggregateV2Schema = z
  .object({
    expectedCells: z.literal(36),
    scoredCells: z.number().int().min(0).max(36),
    byArm: z
      .object({
        generic: BenchmarkArmAggregateV2Schema,
        evidenceOnly: BenchmarkArmAggregateV2Schema,
        chronoriftFull: BenchmarkArmAggregateV2Schema,
      })
      .strict(),
    advantage: z
      .object({
        fullGroundedSuccesses: z.number().int().min(0).max(12),
        fullGroundedSuccessRate: z.number().finite().min(0).max(1),
        genericGroundedSuccessRate: z.number().finite().min(0).max(1),
        fullMinusGeneric: z.number().finite().min(-1).max(1),
        fullIncorrectConfirmations: z.number().int().nonnegative(),
        thresholdMet: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type BenchmarkAggregateV2 = z.infer<typeof BenchmarkAggregateV2Schema>;

export const BenchmarkReportV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    suite: BenchmarkSuiteSpecV2Schema,
    executionId: BenchmarkExecutionIdSchema,
    selectionHash: Sha256V1Schema,
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    provenance: z
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
      .strict(),
    attempts: z.array(BenchmarkCellAttemptV2Schema),
    cells: z.array(BenchmarkCellResultV2Schema),
    auditIssues: z.array(z.enum(["prompt_fairness_failed"])).max(1),
    status: z.enum(["complete", "incomplete", "invalid"]),
    aggregate: BenchmarkAggregateV2Schema.nullable(),
    reportHash: Sha256V1Schema,
  })
  .strict()
  .superRefine((report, context) => {
    const expectedFreezeTag =
      report.suite.campaign?.freezeTag ?? "v0.3.0-benchmark-freeze";
    if (report.provenance.freezeTag !== expectedFreezeTag) {
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
  });
export type BenchmarkReportV2 = z.infer<typeof BenchmarkReportV2Schema>;

export interface BenchmarkGateEvaluationV2 {
  readonly status: "pass" | "fail" | "not_evaluated";
  readonly reasons: readonly string[];
}

export const BenchmarkGateEvaluationV2Schema: z.ZodType<BenchmarkGateEvaluationV2> =
  z
    .object({
      status: z.enum(["pass", "fail", "not_evaluated"]),
      reasons: z.array(z.string().min(1)),
    })
    .strict();
