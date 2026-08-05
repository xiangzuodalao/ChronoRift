import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BenchmarkRawAttemptManifestV3Schema,
  asBenchmarkExecutionId,
  asCapsuleId,
  asCheckpointId,
  asContractId,
  asEvidenceAccessReceiptId,
  asEventId,
  asExecutionId,
  asFixtureId,
  asInputTraceId,
  asProposalId,
  asRunId,
  asVerdictId,
  type BenchmarkAttemptFinishedV3,
  type BenchmarkAttemptProgressV3,
  type BenchmarkAttemptProgressStateV3,
  type BenchmarkCellMetricsV3,
  type BenchmarkExecutionId,
  type BenchmarkFixtureSpecV3,
  type BenchmarkInfrastructureFailureV3,
  type BenchmarkProvenanceV3,
  type JsonValue,
} from "@chronorift/domain";
import {
  benchmarkAttemptIdV3,
  benchmarkCellOrderV3,
  createBenchmarkSuiteSpecV3,
  scoreBenchmarkDiagnosisV3,
} from "@chronorift/gamebranch";
import {
  V03BenchmarkJsonArtifactRepositoryV3,
  contentHash,
} from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import {
  emptyFormalProgressV3,
  executeFormalBenchmarkV3,
  zeroFormalMetricsV3,
  type FormalBenchmarkAttemptResultV3,
  type FormalBenchmarkCellV3,
} from "./v03-formal-execution-v3.js";

const hash = "a".repeat(64);

const fixture = (
  id: string,
  expectedMechanism: BenchmarkFixtureSpecV3["expectedMechanism"],
  symbol: string,
): BenchmarkFixtureSpecV3 => ({
  fixtureId: asFixtureId(id),
  expectedMechanism,
  expectedSource: { virtualPath: "case/main.gd", symbol },
  contractHash: hash,
  inputTraceHash: hash,
  interventionCatalogHash: hash,
  oracleHash: hash,
  aliasMapHash: hash,
});

const fixtures = [
  fixture("opaque-v3-01", "signal_before_receiver_connection", "_ready"),
  fixture("opaque-v3-02", "frame_count_used_for_time_window", "_process"),
  fixture("opaque-v3-03", "discrete_physics_tunneling", "_physics_process"),
  fixture(
    "opaque-v3-04",
    "stale_effect_crossed_entity_incarnation",
    "_resolve_pending_effects",
  ),
] as const;

const suite = createBenchmarkSuiteSpecV3({
  schemaVersion: 3,
  campaign: {
    campaignId: "v0.3.2-luna",
    freezeTag: "v0.3.2-luna-benchmark-freeze",
  },
  subjectHash: hash,
  runnerHash: hash,
  metricSet: "grounded-diagnosis-v3",
  fixtures: [...fixtures],
  arms: ["generic", "evidence-only", "chronorift-full"],
  repetitions: 3,
  orderSeed: "chronorift-v0.3.2-luna-formal-1",
  orderStrategy: "block_randomized_by_fixture_repetition",
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  thinkingLevel: "max",
  modelRequirements: {
    contextWindow: 272_000,
    maxTokens: 128_000,
    thinkingLevelMapMax: "max",
  },
  budgets: {
    baselineExecutions: 1,
    maxReplays: 1,
    maxInterventions: 2,
    maxSourceCalls: 4,
    maxGameExecutions: 4,
    maxToolCalls: 12,
    maxToolErrors: 0,
    maxConsecutiveNonProgressToolResults: 0,
    timeoutMs: 600_000,
    concurrency: 1,
  },
  retryPolicy: {
    initialInfraRetries: 2,
    initialBackoffMs: [1_000, 3_000],
    maxRecoveryCycles: 1,
    maxAttemptsPerCell: 6,
    providerInternalRetries: 0,
  },
  gate: {
    fullRequiredGroundedSuccesses: 9,
    fullExpectedCells: 12,
    minimumFullMinusGeneric: 0.2,
    fullMaximumIncorrectConfirmations: 0,
    requiredScoreEligibleCellsByArm: {
      generic: 12,
      evidenceOnly: 12,
      chronoriftFull: 12,
    },
  },
  calibrationStatus: "calibrated_on_same_fixtures",
  samplingSeedAvailable: false,
  preselectedCase: {
    fixtureId: fixtures[2].fixtureId,
    arm: "chronorift-full",
    repetition: 1,
  },
});

const provenance: BenchmarkProvenanceV3 = {
  gitCommit: "abcdef0",
  freezeTag: "v0.3.2-luna-benchmark-freeze",
  dirty: false,
  lockfileHash: hash,
  piPackageVersion: "0.83.0",
  nodeVersion: "v22.23.1",
  pnpmVersion: "11.20.0",
  godotVersion: "4.7.1",
  godotExecutableHash: hash,
  resolvedProvider: "openai-codex",
  resolvedModelId: "gpt-5.6-luna",
  resolvedModelName: "GPT-5.6 Luna",
  resolvedContextWindow: 272_000,
  resolvedMaxTokens: 128_000,
  mappedThinkingLevel: "max",
  requestedThinkingLevel: "max",
  os: "linux",
  arch: "x64",
  platform: "linux-x64",
};

const completedProgress = (): BenchmarkAttemptProgressStateV3 => ({
  fixtureStage: "fixture_validated",
  model: {
    requestStarted: true,
    outputObserved: true,
    turnCompleted: true,
  },
  tools: { started: 1, completed: 1, failed: 0, semanticRevision: 1 },
  game: { baselineExecutions: 1, diagnosticExecutions: 0 },
  proposalSubmitted: true,
});

const diagnosticProgress = (): BenchmarkAttemptProgressStateV3 => ({
  fixtureStage: "fixture_validated",
  model: {
    requestStarted: true,
    outputObserved: true,
    turnCompleted: false,
  },
  tools: { started: 0, completed: 0, failed: 0, semanticRevision: 0 },
  game: { baselineExecutions: 1, diagnosticExecutions: 0 },
  proposalSubmitted: false,
});

const metrics = (
  overrides: Partial<BenchmarkCellMetricsV3> = {},
): BenchmarkCellMetricsV3 => ({
  gameExecutions: 1,
  toolCalls: 1,
  wallTimeMs: 10,
  tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 },
  ...overrides,
});

const success = (
  executionId: BenchmarkExecutionId,
  cell: FormalBenchmarkCellV3,
  ordinal: number,
): FormalBenchmarkAttemptResultV3 => {
  const fixtureSpec = suite.fixtures.find(
    (candidate) => candidate.fixtureId === cell.fixtureId,
  );
  if (fixtureSpec === undefined) throw new Error("Unknown test Fixture");
  const suffix = contentHash({
    executionId,
    cellId: cell.cellId,
    ordinal,
  }).slice(0, 16);
  const attemptId = benchmarkAttemptIdV3(executionId, cell.cellId, ordinal);
  const runId = asRunId(`run:formal-test:${suffix}`);
  const capsuleId = asCapsuleId(`capsule:formal-test:${suffix}`);
  const baselineExecutionId = asExecutionId(`execution:formal-test:${suffix}`);
  const contractId = asContractId(`contract:formal-test:${suffix}`);
  const checkpointId = asCheckpointId(`checkpoint:formal-test:${suffix}`);
  const inputTraceId = asInputTraceId(`trace:formal-test:${suffix}`);
  const triggerEventId = asEventId(`event:formal-test:${suffix}`);
  const proposalId = asProposalId(`proposal:formal-test:${suffix}`);
  const receiptBasis = {
    schemaVersion: 1 as const,
    runId,
    fixtureId: cell.fixtureId,
    accessKind: "failure_brief" as const,
    resourceId: capsuleId,
    requestHash: hash,
    contentHash: hash,
    sourceCoverage: [],
    issuedAt: "2026-08-05T00:00:00.000Z",
  };
  const receiptId = asEvidenceAccessReceiptId(
    `receipt:v1:${contentHash({
      runId: receiptBasis.runId,
      fixtureId: receiptBasis.fixtureId,
      accessKind: receiptBasis.accessKind,
      resourceId: receiptBasis.resourceId,
      requestHash: receiptBasis.requestHash,
      contentHash: receiptBasis.contentHash,
      sourceCoverage: receiptBasis.sourceCoverage,
    } as JsonValue)}`,
  );
  const receipt = { ...receiptBasis, receiptId };
  const progress = completedProgress();
  const attemptMetrics = metrics();
  const observationHealth = {
    schemaVersion: 1 as const,
    emittedEvents: 0,
    droppedEvents: 0,
    truncatedEvents: 0,
    bufferedBytes: 0,
    backpressure: false,
    probeOverheadUs: 0,
  };
  const caseEvidence = {
    schemaVersion: 2 as const,
    contract: { contractId, contentHash: hash },
    checkpoint: {
      checkpointId,
      contentHash: hash,
      certificateHash: null,
      certificate: null,
    },
    inputTrace: { inputTraceId, contentHash: hash },
    capsule: {
      capsuleId,
      contentHash: hash,
      timelineDigest: hash,
      eventChainHash: hash,
      evidenceLinks: [],
      causalEvents: [],
      omittedRuntimeLogCount: 0,
      expected: {
        kind: "property_equals" as const,
        path: "fixture.outcome",
        value: true,
      },
      actual: { present: true as const, value: false },
      eventLossDetected: false,
      limitationsHash: hash,
    },
    baseline: {
      executionId: baselineExecutionId,
      contractId,
      checkpointId,
      inputTraceId,
      evaluationStatus: "fail" as const,
      evaluation: {
        status: "fail" as const,
        triggerEventId,
        triggerTick: 0,
        deadlineTick: 1,
        observed: { present: true as const, value: false },
      },
      timelineDigest: hash,
      contentHash: hash,
      restoreReceiptHash: hash,
      controlReceiptHash: hash,
      stepReceiptsHash: hash,
      observationHealthHash: hash,
      finalStateHash: hash,
      finalState: { values: { "fixture.outcome": false } },
      runtimeFingerprintHash: hash,
      timelineMatchesBaseline: true,
      restoreReceipt: {
        requestedCheckpointId: checkpointId,
        restoredCheckpointId: checkpointId,
        restored: true as const,
        nextTick: 0,
        simTimeUs: 0,
        stateDigest: hash,
      },
      controlReceipt: {
        schemaVersion: 1 as const,
        requested: {},
        realized: {},
        accepted: true,
        mismatches: [],
      },
      stepReceipts: [
        {
          requestedTick: 0,
          realizedTick: 0,
          requestedDeltaUs: 1,
          realizedDeltaUs: 1,
          appliedInputOrders: [],
        },
      ],
      observationHealth,
      causalEvents: [],
    },
    replay: null,
    candidates: [],
    comparisons: [],
    accessReceipts: [receipt],
  };
  const rawManifest = BenchmarkRawAttemptManifestV3Schema.parse({
    schemaVersion: 3,
    manifestKind: "benchmark_attempt_terminal",
    terminalStatus: "completed",
    suiteId: suite.suiteId,
    definitionId: suite.definitionId,
    executionId,
    cellId: cell.cellId,
    attemptId,
    fixtureId: cell.fixtureId,
    arm: cell.arm,
    repetition: cell.repetition,
    ordinal,
    runId,
    promptAudit: {
      failureBriefHash: hash,
      failureBriefReceiptId: receiptId,
      systemHash: hash,
      userHash: hash,
      baselineTimelineDigest: caseEvidence.baseline.timelineDigest,
      checkpointId,
      checkpointHash: caseEvidence.checkpoint.contentHash,
      contractId,
      contractHash: caseEvidence.contract.contentHash,
      inputTraceId,
      inputTraceHash: caseEvidence.inputTrace.contentHash,
      runtimeFingerprintHash: caseEvidence.baseline.runtimeFingerprintHash,
      sourceViewHash: fixtureSpec.aliasMapHash,
      experimentCatalogHash: fixtureSpec.interventionCatalogHash,
      oracleHash: fixtureSpec.oracleHash,
    },
    caseEvidence,
    progress,
    metrics: attemptMetrics,
    oracle: {
      oracleHash: fixtureSpec.oracleHash,
      expectedMechanism: fixtureSpec.expectedMechanism,
      expectedSource: fixtureSpec.expectedSource,
    },
    proposal: {
      schemaVersion: 3,
      proposalId,
      runId,
      fixtureId: cell.fixtureId,
      capsuleId,
      baselineExecutionId,
      candidateExecutionIds: [],
      comparisonIds: [],
      accessReceiptIds: [receiptId],
      mechanismCode: cell.expectedMechanism,
      summary: "Evidence remains incomplete",
      evidenceEventIds: [],
      blockers: ["A replay and intervention are required"],
      nextExperiment: "Run one intervention",
      confidence: 0.8,
    },
    accessReceipts: [receipt],
    verdict: {
      schemaVersion: 2,
      verdictId: asVerdictId(`verdict:formal-test:${suffix}`),
      proposalId,
      runId,
      fixtureId: cell.fixtureId,
      status: "inconclusive",
      mechanismCode: cell.expectedMechanism,
      summary: "Evidence is insufficient for a canonical diagnosis",
      blockers: ["A replay and intervention are required"],
    },
  });
  return {
    status: "completed",
    progress,
    metrics: attemptMetrics,
    rawManifest: rawManifest as unknown as JsonValue,
    score: scoreBenchmarkDiagnosisV3({
      proposalId,
      candidateExecutionIds: [],
      accessReceiptIds: [receiptId],
      expectedMechanism: cell.expectedMechanism,
      proposedMechanism: cell.expectedMechanism,
      verdict: "inconclusive",
      sourceLocationCorrect: null,
      sourceGrounded: false,
      confidence: 0.8,
    }),
  };
};

const transientProviderFailure: BenchmarkInfrastructureFailureV3 = {
  kind: "provider",
  provider: {
    phase: "request",
    code: "connection",
    httpStatus: null,
    retryClass: "transient",
  },
  retryClass: "transient",
};

class FlakyRepository extends V03BenchmarkJsonArtifactRepositoryV3 {
  public failNextFinish = false;
  public failNextProgress = false;

  public override putAttemptProgressV3(
    record: BenchmarkAttemptProgressV3,
  ): Promise<void> {
    if (this.failNextProgress) {
      this.failNextProgress = false;
      return Promise.reject(new Error("simulated progress crash"));
    }
    return super.putAttemptProgressV3(record);
  }

  public override putAttemptFinishedV3(
    record: BenchmarkAttemptFinishedV3,
  ): Promise<void> {
    if (this.failNextFinish) {
      this.failNextFinish = false;
      return Promise.reject(new Error("simulated process crash"));
    }
    return super.putAttemptFinishedV3(record);
  }
}

const repository = async (): Promise<FlakyRepository> =>
  new FlakyRepository(
    await mkdtemp(join(tmpdir(), "chronorift-formal-v3-execution-")),
  );

const clock = (): (() => string) => {
  let ticks = 0;
  return () => new Date(Date.UTC(2026, 7, 5) + ticks++ * 1_000).toISOString();
};

const executionOptions = (
  artifactRepository: FlakyRepository,
  executionId: ReturnType<typeof asBenchmarkExecutionId>,
  nowIso: () => string,
  runAttempt: Parameters<typeof executeFormalBenchmarkV3>[0]["runAttempt"],
  options: {
    readonly allowRecoveryCycle?: boolean;
    readonly recover?: (cell: FormalBenchmarkCellV3) => Promise<void>;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Parameters<typeof executeFormalBenchmarkV3>[0] => ({
  suite,
  executionId,
  provenance,
  repository: artifactRepository,
  allowRecoveryCycle: options.allowRecoveryCycle ?? false,
  runAttempt,
  recover: options.recover ?? (async () => undefined),
  nowIso,
  sleep: options.sleep ?? (async () => undefined),
});

describe("executeFormalBenchmarkV3", () => {
  it("runs three initial transient attempts, then one recovery cycle, and stops at six", async () => {
    const artifactRepository = await repository();
    const executionId = asBenchmarkExecutionId("benchmark-execution:v3-retry");
    const nowIso = clock();
    const target = benchmarkCellOrderV3(suite)[0]!.cellId;
    const sleeps: number[] = [];
    let recoveries = 0;
    const runAttempt: Parameters<
      typeof executeFormalBenchmarkV3
    >[0]["runAttempt"] = async (cell, ordinal) =>
      cell.cellId === target
        ? {
            status: "infra_failure",
            failure: transientProviderFailure,
            retryable: true,
            message: "Connection error.",
            progress: emptyFormalProgressV3(),
            metrics: zeroFormalMetricsV3(),
          }
        : success(executionId, cell, ordinal);

    const initial = await executeFormalBenchmarkV3(
      executionOptions(artifactRepository, executionId, nowIso, runAttempt, {
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          return Promise.resolve();
        },
      }),
    );
    expect(initial.recoverable).toBe(true);
    expect(initial.report.status).toBe("incomplete");
    expect(
      initial.report.attempts
        .filter((attempt) => attempt.cellId === target)
        .map((attempt) => attempt.ordinal),
    ).toEqual([1, 2, 3]);
    await expect(
      artifactRepository.getCompletedV3(suite.definitionId, executionId),
    ).resolves.toBeNull();

    const recovered = await executeFormalBenchmarkV3(
      executionOptions(artifactRepository, executionId, nowIso, runAttempt, {
        allowRecoveryCycle: true,
        recover: (cell) => {
          expect(cell.cellId).toBe(target);
          recoveries += 1;
          return Promise.resolve();
        },
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          return Promise.resolve();
        },
      }),
    );
    const targetAttempts = recovered.report.attempts.filter(
      (attempt) => attempt.cellId === target,
    );
    expect(recovered.report.status).toBe("complete");
    expect(recovered.recoverable).toBe(false);
    expect(targetAttempts.map((attempt) => attempt.ordinal)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(targetAttempts.map((attempt) => attempt.kind)).toEqual([
      "initial",
      "infra_retry",
      "infra_retry",
      "recovery",
      "infra_retry",
      "infra_retry",
    ]);
    expect(
      recovered.report.cells.find((cell) => cell.cellId === target),
    ).toMatchObject({
      status: "infra_unavailable",
      terminalCode: "connection",
      score: null,
    });
    expect(recoveries).toBe(1);
    expect(sleeps).toEqual([1_000, 3_000, 1_000, 3_000]);
  }, 15_000);

  it("does not retry a provider failure after diagnostic activity and leaves it unscored", async () => {
    const artifactRepository = await repository();
    const executionId = asBenchmarkExecutionId(
      "benchmark-execution:v3-provider-progress",
    );
    const nowIso = clock();
    const target = benchmarkCellOrderV3(suite)[0]!.cellId;
    let targetCalls = 0;
    const result = await executeFormalBenchmarkV3(
      executionOptions(
        artifactRepository,
        executionId,
        nowIso,
        async (cell, ordinal, recordProgress) => {
          if (cell.cellId !== target) {
            return success(executionId, cell, ordinal);
          }
          targetCalls += 1;
          const progress = diagnosticProgress();
          const attemptMetrics = metrics({ toolCalls: 0 });
          await recordProgress({
            observedAt: nowIso(),
            progress,
            metrics: attemptMetrics,
            rawManifest: { schemaVersion: 3, stage: "provider_stream" },
          });
          return {
            status: "infra_failure",
            failure: transientProviderFailure,
            retryable: false,
            message: "Connection error.",
            progress,
            metrics: attemptMetrics,
          };
        },
      ),
    );

    expect(targetCalls).toBe(1);
    expect(
      result.report.attempts.filter((attempt) => attempt.cellId === target),
    ).toHaveLength(1);
    expect(
      result.report.cells.find((cell) => cell.cellId === target),
    ).toMatchObject({
      status: "infra_unavailable",
      terminalCode: "connection",
      score: null,
    });
  }, 15_000);

  it("does not retry an unknown provider failure even before diagnostic activity", async () => {
    const artifactRepository = await repository();
    const executionId = asBenchmarkExecutionId(
      "benchmark-execution:v3-provider-unknown",
    );
    const target = benchmarkCellOrderV3(suite)[0]!.cellId;
    let targetCalls = 0;
    const result = await executeFormalBenchmarkV3(
      executionOptions(
        artifactRepository,
        executionId,
        clock(),
        async (cell, ordinal) => {
          if (cell.cellId !== target) {
            return success(executionId, cell, ordinal);
          }
          targetCalls += 1;
          return {
            status: "infra_failure",
            failure: {
              kind: "provider",
              provider: {
                phase: "request",
                code: "provider_error_unknown",
                httpStatus: null,
                retryClass: "unknown",
              },
              retryClass: "unknown",
            },
            retryable: false,
            message: "Unknown provider failure",
            progress: emptyFormalProgressV3(),
            metrics: zeroFormalMetricsV3(),
          };
        },
      ),
    );

    expect(targetCalls).toBe(1);
    expect(
      result.report.attempts.filter((attempt) => attempt.cellId === target),
    ).toHaveLength(1);
    expect(
      result.report.cells.find((cell) => cell.cellId === target),
    ).toMatchObject({
      status: "infra_unavailable",
      terminalCode: "provider_error_unknown",
      score: null,
    });
  });

  it("fails closed when a returned result hides diagnostic activity recorded in the journal", async () => {
    const artifactRepository = await repository();
    const executionId = asBenchmarkExecutionId(
      "benchmark-execution:v3-hidden-progress",
    );
    const nowIso = clock();
    const target = benchmarkCellOrderV3(suite)[0]!.cellId;
    let calls = 0;
    const result = await executeFormalBenchmarkV3(
      executionOptions(
        artifactRepository,
        executionId,
        nowIso,
        async (cell, ordinal, recordProgress) => {
          calls += 1;
          if (cell.cellId !== target) {
            return success(executionId, cell, ordinal);
          }
          await recordProgress({
            observedAt: nowIso(),
            progress: diagnosticProgress(),
            metrics: metrics({ toolCalls: 0 }),
            rawManifest: { schemaVersion: 3, stage: "provider_stream" },
          });
          return {
            status: "infra_failure",
            failure: transientProviderFailure,
            retryable: true,
            message: "Connection error.",
            progress: emptyFormalProgressV3(),
            metrics: zeroFormalMetricsV3(),
          };
        },
      ),
    );

    expect(calls).toBe(1);
    expect(result.report.status).toBe("invalid");
    expect(result.report.cells).toHaveLength(1);
    expect(result.report.cells[0]).toMatchObject({
      status: "invalid",
      terminalCode: "harness_failure",
    });
  });

  it("resumes an unfinished no-activity attempt as a retry without rerunning its ordinal", async () => {
    const artifactRepository = await repository();
    artifactRepository.failNextProgress = true;
    const executionId = asBenchmarkExecutionId(
      "benchmark-execution:v3-resume-no-activity",
    );
    const nowIso = clock();
    const target = benchmarkCellOrderV3(suite)[0]!.cellId;
    let firstOrdinalCalls = 0;
    await expect(
      executeFormalBenchmarkV3(
        executionOptions(
          artifactRepository,
          executionId,
          nowIso,
          async (cell, ordinal) => {
            if (cell.cellId === target && ordinal === 1) {
              firstOrdinalCalls += 1;
            }
            return success(executionId, cell, ordinal);
          },
        ),
      ),
    ).rejects.toThrow("simulated progress crash");

    const resumed = await executeFormalBenchmarkV3(
      executionOptions(
        artifactRepository,
        executionId,
        nowIso,
        async (cell, ordinal) => success(executionId, cell, ordinal),
      ),
    );
    const attempts = resumed.report.attempts.filter(
      (attempt) => attempt.cellId === target,
    );
    expect(firstOrdinalCalls).toBe(1);
    expect(attempts.map((attempt) => attempt.ordinal)).toEqual([1, 2]);
    expect(attempts[0]?.outcome).toMatchObject({
      status: "infra_failure",
      retryable: true,
      failure: { kind: "process_interrupted" },
    });
    expect(attempts[1]?.outcome.status).toBe("completed");
  });

  it("seals an unfinished attempt after diagnostic activity as unscored without retry", async () => {
    const artifactRepository = await repository();
    const executionId = asBenchmarkExecutionId(
      "benchmark-execution:v3-resume-after-activity",
    );
    const nowIso = clock();
    const target = benchmarkCellOrderV3(suite)[0]!.cellId;
    await expect(
      executeFormalBenchmarkV3(
        executionOptions(
          artifactRepository,
          executionId,
          nowIso,
          async (cell, ordinal, recordProgress) => {
            if (cell.cellId === target) {
              await recordProgress({
                observedAt: nowIso(),
                progress: diagnosticProgress(),
                metrics: metrics({ toolCalls: 0 }),
                rawManifest: { schemaVersion: 3, stage: "provider_stream" },
              });
              artifactRepository.failNextProgress = true;
            }
            return success(executionId, cell, ordinal);
          },
        ),
      ),
    ).rejects.toThrow("simulated progress crash");

    let targetReruns = 0;
    const resumed = await executeFormalBenchmarkV3(
      executionOptions(
        artifactRepository,
        executionId,
        nowIso,
        async (cell, ordinal) => {
          if (cell.cellId === target) targetReruns += 1;
          return success(executionId, cell, ordinal);
        },
      ),
    );
    expect(targetReruns).toBe(0);
    expect(
      resumed.report.cells.find((cell) => cell.cellId === target),
    ).toMatchObject({
      status: "infra_unavailable",
      terminalCode: "process_interrupted",
      score: null,
    });
  });

  it("reconstructs a verified terminal manifest after the finish write is interrupted", async () => {
    const artifactRepository = await repository();
    artifactRepository.failNextFinish = true;
    const executionId = asBenchmarkExecutionId(
      "benchmark-execution:v3-reconstruct-terminal",
    );
    const nowIso = clock();
    const target = benchmarkCellOrderV3(suite)[0]!.cellId;
    await expect(
      executeFormalBenchmarkV3(
        executionOptions(
          artifactRepository,
          executionId,
          nowIso,
          async (cell, ordinal) => success(executionId, cell, ordinal),
        ),
      ),
    ).rejects.toThrow("simulated process crash");

    let targetReruns = 0;
    const resumed = await executeFormalBenchmarkV3(
      executionOptions(
        artifactRepository,
        executionId,
        nowIso,
        async (cell, ordinal) => {
          if (cell.cellId === target) targetReruns += 1;
          return success(executionId, cell, ordinal);
        },
      ),
    );
    const attempts = resumed.report.attempts.filter(
      (attempt) => attempt.cellId === target,
    );
    expect(targetReruns).toBe(0);
    expect(attempts.map((attempt) => attempt.ordinal)).toEqual([1]);
    expect(attempts[0]?.outcome.status).toBe("completed");
    expect(
      resumed.report.cells.find((cell) => cell.cellId === target),
    ).toMatchObject({ status: "scored", terminalCode: null });
  });

  it("rejects regressing progress online and seals only the invalid prefix", async () => {
    const artifactRepository = await repository();
    const executionId = asBenchmarkExecutionId(
      "benchmark-execution:v3-progress-regression",
    );
    const nowIso = clock();
    let calls = 0;
    const result = await executeFormalBenchmarkV3(
      executionOptions(
        artifactRepository,
        executionId,
        nowIso,
        async (cell, ordinal, recordProgress) => {
          calls += 1;
          const first = completedProgress();
          await recordProgress({
            observedAt: nowIso(),
            progress: first,
            metrics: metrics(),
            rawManifest: { schemaVersion: 3, sequence: 1 },
          });
          await recordProgress({
            observedAt: nowIso(),
            progress: {
              ...first,
              tools: { ...first.tools, semanticRevision: 0 },
            },
            metrics: metrics(),
            rawManifest: { schemaVersion: 3, sequence: 2 },
          });
          return success(executionId, cell, ordinal);
        },
      ),
    );
    expect(calls).toBe(1);
    expect(result.report.status).toBe("invalid");
    expect(result.report.cells).toHaveLength(1);
    expect(result.report.cells[0]?.terminalCode).toBe("harness_failure");
  });

  it("fails closed on invalid final metrics and does not run later cells", async () => {
    const artifactRepository = await repository();
    const executionId = asBenchmarkExecutionId(
      "benchmark-execution:v3-invalid-metrics",
    );
    let calls = 0;
    const result = await executeFormalBenchmarkV3(
      executionOptions(
        artifactRepository,
        executionId,
        clock(),
        async (cell, ordinal) => {
          calls += 1;
          return {
            ...success(executionId, cell, ordinal),
            metrics: {
              ...metrics(),
              toolCalls: 13,
            },
          };
        },
      ),
    );
    expect(calls).toBe(1);
    expect(result.report.status).toBe("invalid");
    expect(result.report.cells).toHaveLength(1);
    expect(result.report.cells[0]?.terminalCode).toBe("harness_failure");
    await expect(
      artifactRepository.getCompletedV3(suite.definitionId, executionId),
    ).resolves.toEqual(result.report);
  });
});
