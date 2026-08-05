import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BenchmarkAttemptFinishedV3Schema,
  BenchmarkAttemptProgressV3Schema,
  BenchmarkAttemptStartedV3Schema,
  BenchmarkCellAttemptV3Schema,
  BenchmarkCellResultV3Schema,
  BenchmarkExecutionSelectionV3Schema,
  BenchmarkExecutionStartedV3Schema,
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
  asRunId,
  type BenchmarkAttemptProgressStateV3,
  type BenchmarkFixtureSpecV3,
  type JsonValue,
} from "@chronorift/domain";
import {
  benchmarkAttemptHashV3,
  benchmarkAttemptIdV3,
  benchmarkCellScoringProofFromRawManifestV3,
  benchmarkCellOrderV3,
  benchmarkExecutionSelectionHashV3,
  benchmarkReportHashV3,
  buildBenchmarkReportV3,
  createBenchmarkSuiteSpecV3,
  diagnosticFailureScoreV3,
} from "@chronorift/gamebranch";
import { describe, expect, it } from "vitest";

import { contentHash } from "./canonical-json.js";
import {
  ArtifactIntegrityError,
  ImmutableArtifactConflictError,
} from "./v01-json-artifact-repository.js";
import { V03BenchmarkJsonArtifactRepositoryV3 } from "./v03-benchmark-json-artifact-repository-v3.js";

const hash = "c".repeat(64);

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
  fixture("artifact-v3-01", "signal_before_receiver_connection", "_ready"),
  fixture("artifact-v3-02", "frame_count_used_for_time_window", "_process"),
  fixture("artifact-v3-03", "discrete_physics_tunneling", "_physics_process"),
  fixture(
    "artifact-v3-04",
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

const executionId = asBenchmarkExecutionId("benchmark-execution:artifact-v3");
const orderedCell = benchmarkCellOrderV3(suite)[0]!;
const expectedFixture = suite.fixtures.find(
  (entry) => entry.fixtureId === orderedCell.fixtureId,
)!;
const attemptId = benchmarkAttemptIdV3(executionId, orderedCell.cellId, 1);
const startedAt = "2026-08-05T00:00:00.000Z";

const selection = BenchmarkExecutionSelectionV3Schema.parse({
  schemaVersion: 3,
  suiteId: suite.suiteId,
  definitionId: suite.definitionId,
  executionId,
  selectionHash: benchmarkExecutionSelectionHashV3(
    suite.definitionId,
    executionId,
  ),
});

const execution = BenchmarkExecutionStartedV3Schema.parse({
  ...selection,
  startedAt,
  provenance: {
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
  },
});

const attemptStarted = BenchmarkAttemptStartedV3Schema.parse({
  schemaVersion: 3,
  suiteId: suite.suiteId,
  definitionId: suite.definitionId,
  executionId,
  cellId: orderedCell.cellId,
  attemptId,
  fixtureId: orderedCell.fixtureId,
  arm: orderedCell.arm,
  repetition: orderedCell.repetition,
  ordinal: 1,
  kind: "initial",
  previousAttemptHash: null,
  startedAt,
});

const progressState = (
  semanticRevision: number,
): BenchmarkAttemptProgressStateV3 => ({
  fixtureStage: "fixture_validated",
  model: {
    requestStarted: true,
    outputObserved: false,
    turnCompleted: false,
  },
  tools: {
    started: Math.max(1, semanticRevision),
    completed: Math.max(1, semanticRevision),
    failed: 0,
    semanticRevision,
  },
  game: { baselineExecutions: 1, diagnosticExecutions: 0 },
  proposalSubmitted: false,
});

const metrics = {
  gameExecutions: 1,
  toolCalls: 1,
  wallTimeMs: 11,
  tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
} as const;

const progress = (
  sequence: number,
  semanticRevision = sequence,
): ReturnType<typeof BenchmarkAttemptProgressV3Schema.parse> =>
  BenchmarkAttemptProgressV3Schema.parse({
    schemaVersion: 3,
    suiteId: suite.suiteId,
    definitionId: suite.definitionId,
    executionId,
    cellId: orderedCell.cellId,
    attemptId,
    ordinal: 1,
    sequence,
    observedAt: `2026-08-05T00:00:0${sequence}.000Z`,
    progress: progressState(semanticRevision),
    metrics: { ...metrics, wallTimeMs: 10 + sequence },
    rawManifest: { schemaVersion: 3, sequence },
  });

const setupAttempt = async (
  repository: V03BenchmarkJsonArtifactRepositoryV3,
): Promise<void> => {
  await repository.putDefinitionV3(suite);
  await repository.putExecutionSelectionV3(selection);
  await repository.putExecutionStartedV3(execution);
  await repository.putAttemptStartedV3(attemptStarted);
};

const retryableAttempt = () => {
  const retryableProgress: BenchmarkAttemptProgressStateV3 = {
    fixtureStage: "fixture_validated",
    model: {
      requestStarted: true,
      outputObserved: false,
      turnCompleted: false,
    },
    tools: { started: 0, completed: 0, failed: 0, semanticRevision: 0 },
    game: { baselineExecutions: 1, diagnosticExecutions: 0 },
    proposalSubmitted: false,
  };
  const retryableMetrics = {
    gameExecutions: 1,
    toolCalls: 0,
    wallTimeMs: 11,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  } as const;
  const attemptBasis = {
    ...attemptStarted,
    finishedAt: "2026-08-05T00:00:03.000Z",
    progress: retryableProgress,
    metrics: retryableMetrics,
    outcome: {
      status: "infra_failure",
      failure: {
        kind: "harness_timeout",
        code: "no_progress_timeout",
        retryClass: "transient",
      },
      message: "Infrastructure failure",
      retryable: true,
    },
  } as const;
  const attempt = BenchmarkCellAttemptV3Schema.parse({
    ...attemptBasis,
    attemptHash: benchmarkAttemptHashV3(attemptBasis),
  });
  return BenchmarkAttemptFinishedV3Schema.parse({
    schemaVersion: 3,
    attempt,
    terminalCell: null,
    rawManifest: null,
  });
};

const terminalProgressFor = (finished: ReturnType<typeof retryableAttempt>) =>
  BenchmarkAttemptProgressV3Schema.parse({
    schemaVersion: 3,
    suiteId: finished.attempt.suiteId,
    definitionId: finished.attempt.definitionId,
    executionId: finished.attempt.executionId,
    cellId: finished.attempt.cellId,
    attemptId: finished.attempt.attemptId,
    ordinal: finished.attempt.ordinal,
    sequence: 1,
    observedAt: "2026-08-05T00:00:02.000Z",
    progress: finished.attempt.progress,
    metrics: finished.attempt.metrics,
    rawManifest: { schemaVersion: 3, stage: "attempt_result" },
  });

const invalidAttempt = () => {
  const attemptBasis = {
    ...attemptStarted,
    finishedAt: "2026-08-05T00:00:03.000Z",
    progress: progressState(1),
    metrics,
    outcome: {
      status: "invalid",
      code: "harness_failure",
      infrastructureFailure: null,
      message: "Invalid formal attempt",
      retryable: false,
    },
  } as const;
  const attempt = BenchmarkCellAttemptV3Schema.parse({
    ...attemptBasis,
    attemptHash: benchmarkAttemptHashV3(attemptBasis),
  });
  const terminalCell = BenchmarkCellResultV3Schema.parse({
    schemaVersion: 3,
    suiteId: suite.suiteId,
    definitionId: suite.definitionId,
    executionId,
    cellId: orderedCell.cellId,
    fixtureId: orderedCell.fixtureId,
    arm: orderedCell.arm,
    repetition: orderedCell.repetition,
    expectedMechanism: expectedFixture.expectedMechanism,
    status: "invalid",
    terminalCode: "harness_failure",
    infrastructureFailure: null,
    attemptIds: [attemptId],
    selectedAttemptId: attemptId,
    score: null,
    metrics,
    rawManifestHash: null,
  });
  return BenchmarkAttemptFinishedV3Schema.parse({
    schemaVersion: 3,
    attempt,
    terminalCell,
    rawManifest: null,
  });
};

const diagnosticAttempt = () => {
  const runId = asRunId("run:artifact-v3-diagnostic");
  const capsuleId = asCapsuleId("capsule:artifact-v3-diagnostic");
  const baselineExecutionId = asExecutionId("execution:artifact-v3-baseline");
  const contractId = asContractId("contract:artifact-v3");
  const checkpointId = asCheckpointId("checkpoint:artifact-v3");
  const inputTraceId = asInputTraceId("trace:artifact-v3");
  const triggerEventId = asEventId("event:artifact-v3-trigger");
  const terminalProgress = progressState(1);
  const failureReceiptBasis = {
    runId,
    fixtureId: orderedCell.fixtureId,
    accessKind: "failure_brief" as const,
    resourceId: capsuleId,
    requestHash: hash,
    contentHash: hash,
    sourceCoverage: [],
  };
  const failureBriefReceipt = {
    schemaVersion: 1 as const,
    receiptId: asEvidenceAccessReceiptId(
      `receipt:v1:${contentHash(failureReceiptBasis)}`,
    ),
    ...failureReceiptBasis,
    issuedAt: "2026-08-05T00:00:00.000Z",
  };
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
        path: "door.open",
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
      finalState: { values: { "door.open": false } },
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
    accessReceipts: [failureBriefReceipt],
  };
  const rawManifest = BenchmarkRawAttemptManifestV3Schema.parse({
    schemaVersion: 3,
    manifestKind: "benchmark_attempt_terminal",
    terminalStatus: "diagnostic_failure",
    suiteId: suite.suiteId,
    definitionId: suite.definitionId,
    executionId,
    cellId: orderedCell.cellId,
    attemptId,
    fixtureId: orderedCell.fixtureId,
    arm: orderedCell.arm,
    repetition: orderedCell.repetition,
    ordinal: 1,
    runId,
    promptAudit: {
      failureBriefHash: failureBriefReceipt.contentHash,
      failureBriefReceiptId: failureBriefReceipt.receiptId,
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
      sourceViewHash: expectedFixture.aliasMapHash,
      experimentCatalogHash: expectedFixture.interventionCatalogHash,
      oracleHash: expectedFixture.oracleHash,
    },
    caseEvidence,
    progress: terminalProgress,
    metrics,
    oracle: {
      oracleHash: expectedFixture.oracleHash,
      expectedMechanism: expectedFixture.expectedMechanism,
      expectedSource: expectedFixture.expectedSource,
    },
    diagnosticCode: "invalid_tool_flow",
    error: { kind: "harness", code: "INVALID_TOOL_FLOW", messageHash: hash },
  });
  const rawManifestHash = contentHash(rawManifest as unknown as JsonValue);
  const attemptBasis = {
    ...attemptStarted,
    finishedAt: "2026-08-05T00:00:03.000Z",
    progress: terminalProgress,
    metrics,
    outcome: {
      status: "diagnostic_failure",
      code: "invalid_tool_flow",
      message: "Terminal diagnostic failure",
      rawManifestHash,
    },
  } as const;
  const attempt = BenchmarkCellAttemptV3Schema.parse({
    ...attemptBasis,
    attemptHash: benchmarkAttemptHashV3(attemptBasis),
  });
  const terminalCell = BenchmarkCellResultV3Schema.parse({
    schemaVersion: 3,
    suiteId: suite.suiteId,
    definitionId: suite.definitionId,
    executionId,
    cellId: orderedCell.cellId,
    fixtureId: orderedCell.fixtureId,
    arm: orderedCell.arm,
    repetition: orderedCell.repetition,
    expectedMechanism: expectedFixture.expectedMechanism,
    status: "diagnostic_failure",
    terminalCode: "invalid_tool_flow",
    infrastructureFailure: null,
    attemptIds: [attemptId],
    selectedAttemptId: attemptId,
    score: diagnosticFailureScoreV3(expectedFixture.expectedMechanism),
    metrics,
    rawManifestHash,
  });
  const finished = BenchmarkAttemptFinishedV3Schema.parse({
    schemaVersion: 3,
    attempt,
    terminalCell,
    rawManifest,
  });
  return {
    finished,
    proof: benchmarkCellScoringProofFromRawManifestV3(rawManifest),
  };
};

const invalidReport = (finished: ReturnType<typeof invalidAttempt>) =>
  buildBenchmarkReportV3({
    suite,
    executionId,
    startedAt,
    finishedAt: "2026-08-05T00:00:04.000Z",
    provenance: execution.provenance,
    attempts: [finished.attempt],
    cells: [finished.terminalCell!],
    scoringProofs: [],
  });

const repository = async (): Promise<V03BenchmarkJsonArtifactRepositoryV3> =>
  new V03BenchmarkJsonArtifactRepositoryV3(
    await mkdtemp(join(tmpdir(), "chronorift-artifact-v3-")),
  );

describe("V03BenchmarkJsonArtifactRepositoryV3", () => {
  it("rejects schema-valid forged definition and selection hashes", async () => {
    const artifactRepository = await repository();
    expect(() =>
      artifactRepository.putDefinitionV3({
        ...suite,
        subjectHash: "e".repeat(64),
      }),
    ).toThrow(ArtifactIntegrityError);
    await artifactRepository.putDefinitionV3(suite);
    expect(() =>
      artifactRepository.putExecutionSelectionV3({
        ...selection,
        selectionHash: "e".repeat(64),
      }),
    ).toThrow(ArtifactIntegrityError);
  });

  it("enforces contiguous, monotonic, idempotent append-only progress", async () => {
    const artifactRepository = await repository();
    await setupAttempt(artifactRepository);
    const first = progress(1, 1);
    await artifactRepository.putAttemptProgressV3(first);
    await expect(
      artifactRepository.putAttemptProgressV3(first),
    ).resolves.toBeUndefined();
    await expect(
      artifactRepository.putAttemptProgressV3(progress(3, 3)),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await expect(
      artifactRepository.putAttemptProgressV3(progress(2, 0)),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await expect(
      artifactRepository.getAttemptProgressV3(
        suite.definitionId,
        executionId,
        orderedCell.cellId,
        1,
        attemptId,
      ),
    ).resolves.toEqual([first]);
  });

  it("rejects progress and finish records that do not reference an exact start", async () => {
    const artifactRepository = await repository();
    await expect(
      artifactRepository.putAttemptProgressV3(progress(1)),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await expect(
      artifactRepository.putAttemptFinishedV3(retryableAttempt()),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("rejects a schema-valid attempt whose content hash is forged", async () => {
    const artifactRepository = await repository();
    await setupAttempt(artifactRepository);
    const finished = retryableAttempt();
    await expect(
      artifactRepository.putAttemptFinishedV3({
        ...finished,
        attempt: { ...finished.attempt, attemptHash: "d".repeat(64) },
      }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("rejects a correctly hashed finish that cites a different immutable start", async () => {
    const artifactRepository = await repository();
    await setupAttempt(artifactRepository);
    const finished = retryableAttempt();
    const { attemptHash: _attemptHash, ...basis } = finished.attempt;
    void _attemptHash;
    const changedBasis = {
      ...basis,
      startedAt: "2026-08-05T00:00:00.500Z",
    };
    const changedAttempt = BenchmarkCellAttemptV3Schema.parse({
      ...changedBasis,
      attemptHash: benchmarkAttemptHashV3(changedBasis),
    });
    await expect(
      artifactRepository.putAttemptFinishedV3({
        ...finished,
        attempt: changedAttempt,
      }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("rejects every progress record after an attempt is sealed", async () => {
    const artifactRepository = await repository();
    await setupAttempt(artifactRepository);
    const finished = retryableAttempt();
    await artifactRepository.putAttemptProgressV3(
      terminalProgressFor(finished),
    );
    await artifactRepository.putAttemptFinishedV3(finished);

    await expect(
      artifactRepository.putAttemptProgressV3({
        ...terminalProgressFor(finished),
        sequence: 2,
        observedAt: "2026-08-05T00:00:03.000Z",
      }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("requires finished attempts to match an exact terminal progress record", async () => {
    const missingProgressRepository = await repository();
    await setupAttempt(missingProgressRepository);
    const finished = retryableAttempt();
    await expect(
      missingProgressRepository.putAttemptFinishedV3(finished),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    const mismatchedProgressRepository = await repository();
    await setupAttempt(mismatchedProgressRepository);
    await mismatchedProgressRepository.putAttemptProgressV3(progress(1));
    await expect(
      mismatchedProgressRepository.putAttemptFinishedV3(finished),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("requires a persisted cell to exactly match its finished attempt", async () => {
    const artifactRepository = await repository();
    await setupAttempt(artifactRepository);
    const finished = invalidAttempt();
    await artifactRepository.putAttemptProgressV3(progress(1));
    await artifactRepository.putAttemptFinishedV3(finished);

    await expect(
      artifactRepository.putCellV3({
        ...finished.terminalCell!,
        terminalCode: "schema_failure",
      }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await expect(
      artifactRepository.putCellV3(finished.terminalCell!),
    ).resolves.toBeUndefined();
  });

  it("seals a report only after resolving its exact ledger lineage", async () => {
    const artifactRepository = await repository();
    await setupAttempt(artifactRepository);
    const finished = invalidAttempt();
    await artifactRepository.putAttemptProgressV3(progress(1));
    await artifactRepository.putAttemptFinishedV3(finished);
    await artifactRepository.putCellV3(finished.terminalCell!);
    const report = invalidReport(finished);

    await expect(
      artifactRepository.putCompletedV3(report),
    ).resolves.toBeUndefined();
    await expect(
      artifactRepository.getCompletedV3(suite.definitionId, executionId),
    ).resolves.toEqual(report);
  });

  it("binds a report scoring proof to the stored terminal raw manifest", async () => {
    const artifactRepository = await repository();
    await setupAttempt(artifactRepository);
    const { finished, proof } = diagnosticAttempt();
    await artifactRepository.putAttemptProgressV3(progress(1));
    await artifactRepository.putAttemptFinishedV3(finished);
    await artifactRepository.putCellV3(finished.terminalCell!);
    const report = buildBenchmarkReportV3({
      suite,
      executionId,
      startedAt,
      finishedAt: "2026-08-05T00:00:04.000Z",
      provenance: execution.provenance,
      attempts: [finished.attempt],
      cells: [finished.terminalCell!],
      scoringProofs: [proof],
    });
    const { reportHash: _reportHash, ...reportBasis } = report;
    void _reportHash;
    const forgedBasis = {
      ...reportBasis,
      scoringProofs: [
        { ...proof, diagnosticCode: "proposal_missing" as const },
      ],
    };
    await expect(
      artifactRepository.putCompletedV3({
        ...forgedBasis,
        reportHash: benchmarkReportHashV3(forgedBasis),
      }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    await expect(
      artifactRepository.putCompletedV3(report),
    ).resolves.toBeUndefined();
    await expect(
      artifactRepository.getCompletedV3(suite.definitionId, executionId),
    ).resolves.toEqual(report);
  });

  it("rejects completed reports with missing or extra ledger records", async () => {
    const missingCellRepository = await repository();
    await setupAttempt(missingCellRepository);
    const finished = invalidAttempt();
    await missingCellRepository.putAttemptProgressV3(progress(1));
    await missingCellRepository.putAttemptFinishedV3(finished);
    await expect(
      missingCellRepository.putCompletedV3(invalidReport(finished)),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    const extraAttemptRepository = await repository();
    await setupAttempt(extraAttemptRepository);
    await extraAttemptRepository.putAttemptProgressV3(progress(1));
    await extraAttemptRepository.putAttemptFinishedV3(finished);
    await extraAttemptRepository.putCellV3(finished.terminalCell!);
    const emptyReport = buildBenchmarkReportV3({
      suite,
      executionId,
      startedAt,
      finishedAt: "2026-08-05T00:00:04.000Z",
      provenance: execution.provenance,
      attempts: [],
      cells: [],
      scoringProofs: [],
    });
    await expect(
      extraAttemptRepository.putCompletedV3(emptyReport),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("detects a forged terminal cell written below the typed adapter", async () => {
    const artifactRepository = await repository();
    await setupAttempt(artifactRepository);
    const finished = invalidAttempt();
    await artifactRepository.putAttemptProgressV3(progress(1));
    await artifactRepository.putAttemptFinishedV3(finished);
    await artifactRepository.ledger.writeCell(
      suite.definitionId,
      executionId,
      orderedCell.cellId,
      {
        ...finished.terminalCell!,
        terminalCode: "schema_failure",
      },
    );

    await expect(
      artifactRepository.getCellV3(
        suite.definitionId,
        executionId,
        orderedCell.cellId,
      ),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await expect(
      artifactRepository.putCompletedV3(invalidReport(finished)),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("detects a sequence-valid progress regression injected below the typed adapter", async () => {
    const artifactRepository = await repository();
    await setupAttempt(artifactRepository);
    await artifactRepository.putAttemptProgressV3(progress(1, 1));
    const regressed = progress(2, 0);
    await artifactRepository.ledger.writeAttemptProgress(
      suite.definitionId,
      executionId,
      orderedCell.cellId,
      1,
      attemptId,
      2,
      regressed,
    );
    await expect(
      artifactRepository.getAttemptProgressV3(
        suite.definitionId,
        executionId,
        orderedCell.cellId,
        1,
        attemptId,
      ),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("keeps execution records write-once", async () => {
    const artifactRepository = await repository();
    await setupAttempt(artifactRepository);
    await expect(
      artifactRepository.putExecutionStartedV3({
        ...execution,
        startedAt: "2026-08-05T00:00:01.000Z",
      }),
    ).rejects.toBeInstanceOf(ImmutableArtifactConflictError);
  });
});
