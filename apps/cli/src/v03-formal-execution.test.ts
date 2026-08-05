import {
  asBenchmarkExecutionId,
  asEvidenceAccessReceiptId,
  asExecutionId,
  asFixtureId,
  asProposalId,
  type BenchmarkAttemptFinishedV2,
  type BenchmarkAttemptId,
  type BenchmarkAttemptStartedV2,
  type BenchmarkAttemptProgressV2,
  type BenchmarkCellId,
  type BenchmarkCellResultV2,
  type BenchmarkDefinitionId,
  type BenchmarkExecutionId,
  type BenchmarkExecutionStartedV2,
  type BenchmarkExecutionSelectionV2,
  type BenchmarkFixtureSpecV2,
  type BenchmarkReportV2,
  type BenchmarkSuiteSpecV2,
} from "@chronorift/domain";
import {
  createBenchmarkSuiteSpecV2,
  benchmarkExecutionSelectionHashV2,
  scoreBenchmarkDiagnosisV2,
  type V03BenchmarkArtifactRepositoryPort,
} from "@chronorift/gamebranch";
import { describe, expect, it } from "vitest";

import {
  executeFormalBenchmarkV2,
  type FormalBenchmarkAttemptResultV2,
  type FormalBenchmarkCellV2,
} from "./v03-formal-execution.js";

const hash = "b".repeat(64);
const fixture = (
  id: string,
  mechanism: BenchmarkFixtureSpecV2["expectedMechanism"],
): BenchmarkFixtureSpecV2 => ({
  fixtureId: asFixtureId(id),
  expectedMechanism: mechanism,
  expectedSource: { virtualPath: "case/main.gd", symbol: "_process" },
  contractHash: hash,
  inputTraceHash: hash,
  interventionCatalogHash: hash,
  oracleHash: hash,
  aliasMapHash: hash,
});

const fixtures = [
  fixture("opaque-1", "signal_before_receiver_connection"),
  fixture("opaque-2", "frame_count_used_for_time_window"),
  fixture("opaque-3", "discrete_physics_tunneling"),
  fixture("opaque-4", "stale_effect_crossed_entity_incarnation"),
];

const suite: BenchmarkSuiteSpecV2 = createBenchmarkSuiteSpecV2({
  schemaVersion: 2,
  subjectHash: hash,
  runnerHash: hash,
  metricSet: "grounded-diagnosis-v2",
  fixtures,
  arms: ["generic", "evidence-only", "chronorift-full"],
  repetitions: 3,
  orderSeed: "chronorift-v0.3-formal-1",
  orderStrategy: "block_randomized_by_fixture_repetition",
  provider: "volcengine-coding-plan",
  model: "glm-5.2",
  thinkingLevel: "max",
  modelRequirements: {
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMapMax: "max",
  },
  budgets: {
    baselineExecutions: 1,
    maxReplays: 1,
    maxInterventions: 2,
    maxSourceCalls: 4,
    maxGameExecutions: 4,
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
  },
  calibrationStatus: "calibrated_on_same_fixtures",
  samplingSeedAvailable: false,
  preselectedCase: {
    fixtureId: fixtures[2]!.fixtureId,
    arm: "chronorift-full",
    repetition: 1,
  },
});

class MemoryRepository implements V03BenchmarkArtifactRepositoryPort {
  public definition: BenchmarkSuiteSpecV2 | undefined;
  public start: BenchmarkExecutionStartedV2 | undefined;
  public selection: BenchmarkExecutionSelectionV2 | undefined;
  public completed: BenchmarkReportV2 | undefined;
  public readonly starts = new Map<string, BenchmarkAttemptStartedV2>();
  public readonly finishes = new Map<string, BenchmarkAttemptFinishedV2>();
  public readonly progress = new Map<string, BenchmarkAttemptProgressV2>();
  public readonly cells = new Map<string, BenchmarkCellResultV2>();
  public failNextFinish = false;

  private attemptKey(
    cellId: BenchmarkCellId,
    ordinal: number,
    attemptId: BenchmarkAttemptId,
  ): string {
    return `${cellId}\0${ordinal}\0${attemptId}`;
  }

  public putDefinition(spec: BenchmarkSuiteSpecV2): Promise<void> {
    this.definition = structuredClone(spec);
    return Promise.resolve();
  }
  public getDefinition(
    _id: BenchmarkDefinitionId,
  ): Promise<BenchmarkSuiteSpecV2> {
    void _id;
    if (this.definition === undefined)
      return Promise.reject(new Error("missing"));
    return Promise.resolve(structuredClone(this.definition));
  }
  public putExecutionSelection(
    record: BenchmarkExecutionSelectionV2,
  ): Promise<void> {
    if (
      this.selection !== undefined &&
      JSON.stringify(this.selection) !== JSON.stringify(record)
    ) {
      return Promise.reject(new Error("selection conflict"));
    }
    this.selection = structuredClone(record);
    return Promise.resolve();
  }
  public getExecutionSelection(
    _definitionId: BenchmarkDefinitionId,
  ): Promise<BenchmarkExecutionSelectionV2 | null> {
    void _definitionId;
    return Promise.resolve(
      this.selection === undefined ? null : structuredClone(this.selection),
    );
  }
  public putExecutionStarted(
    record: BenchmarkExecutionStartedV2,
  ): Promise<void> {
    this.start = structuredClone(record);
    return Promise.resolve();
  }
  public getExecutionStarted(
    _definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
  ): Promise<BenchmarkExecutionStartedV2 | null> {
    return Promise.resolve(
      this.start === undefined || this.start.executionId !== executionId
        ? null
        : structuredClone(this.start),
    );
  }
  public putAttemptStarted(record: BenchmarkAttemptStartedV2): Promise<void> {
    this.starts.set(
      this.attemptKey(record.cellId, record.ordinal, record.attemptId),
      structuredClone(record),
    );
    return Promise.resolve();
  }
  public getAttemptStarted(
    _definitionId: BenchmarkDefinitionId,
    _executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
    ordinal: number,
    attemptId: BenchmarkAttemptId,
  ): Promise<BenchmarkAttemptStartedV2 | null> {
    return Promise.resolve(
      this.starts.get(this.attemptKey(cellId, ordinal, attemptId)) ?? null,
    );
  }
  public putAttemptFinished(record: BenchmarkAttemptFinishedV2): Promise<void> {
    if (this.failNextFinish) {
      this.failNextFinish = false;
      return Promise.reject(new Error("simulated process crash"));
    }
    this.finishes.set(
      this.attemptKey(
        record.attempt.cellId,
        record.attempt.ordinal,
        record.attempt.attemptId,
      ),
      structuredClone(record),
    );
    return Promise.resolve();
  }
  public putAttemptProgress(record: BenchmarkAttemptProgressV2): Promise<void> {
    this.progress.set(
      this.attemptKey(record.cellId, record.ordinal, record.attemptId),
      structuredClone(record),
    );
    return Promise.resolve();
  }
  public getLatestAttemptProgress(
    _definitionId: BenchmarkDefinitionId,
    _executionId: BenchmarkExecutionId,
    _cellId: BenchmarkCellId,
    _ordinal: number,
    _attemptId: BenchmarkAttemptId,
  ): Promise<BenchmarkAttemptProgressV2 | null> {
    return Promise.resolve(
      this.progress.get(this.attemptKey(_cellId, _ordinal, _attemptId)) ?? null,
    );
  }
  public getAttemptFinished(
    _definitionId: BenchmarkDefinitionId,
    _executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
    ordinal: number,
    attemptId: BenchmarkAttemptId,
  ): Promise<BenchmarkAttemptFinishedV2 | null> {
    return Promise.resolve(
      this.finishes.get(this.attemptKey(cellId, ordinal, attemptId)) ?? null,
    );
  }
  public putCell(record: BenchmarkCellResultV2): Promise<void> {
    this.cells.set(record.cellId, structuredClone(record));
    return Promise.resolve();
  }
  public getCell(
    _definitionId: BenchmarkDefinitionId,
    _executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
  ): Promise<BenchmarkCellResultV2 | null> {
    return Promise.resolve(this.cells.get(cellId) ?? null);
  }
  public putCompleted(report: BenchmarkReportV2): Promise<void> {
    this.completed = structuredClone(report);
    return Promise.resolve();
  }
  public getCompleted(
    _definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
  ): Promise<BenchmarkReportV2 | null> {
    return Promise.resolve(
      this.completed === undefined || this.completed.executionId !== executionId
        ? null
        : structuredClone(this.completed),
    );
  }
}

const provenance = {
  gitCommit: "abcdef0",
  freezeTag: "v0.3.0-benchmark-freeze",
  dirty: false,
  lockfileHash: hash,
  piPackageVersion: "0.83.0",
  nodeVersion: "v22.23.1",
  pnpmVersion: "11.20.0",
  godotVersion: "4.7.1",
  godotExecutableHash: hash,
  resolvedModelName: "GLM-5.2 [1M]",
  resolvedContextWindow: 1_000_000,
  resolvedMaxTokens: 128_000,
  mappedThinkingLevel: "max",
  requestedThinkingLevel: "max",
  os: "linux",
  arch: "x64",
  platform: "linux-x64",
} as const;

const success = (
  cell: FormalBenchmarkCellV2,
): FormalBenchmarkAttemptResultV2 => ({
  status: "completed",
  progressObserved: true,
  rawManifest: { schemaVersion: 1, fixtureId: cell.fixtureId },
  score: scoreBenchmarkDiagnosisV2({
    proposalId: asProposalId(`proposal:${cell.cellId}`),
    candidateExecutionIds: [asExecutionId(`candidate:${cell.cellId}`)],
    accessReceiptIds: [asEvidenceAccessReceiptId(`receipt:${cell.cellId}`)],
    expectedMechanism: cell.expectedMechanism,
    proposedMechanism: cell.expectedMechanism,
    verdict: "confirmed",
    sourceLocationCorrect: null,
    sourceGrounded: false,
    confidence: null,
  }),
  metrics: {
    gameExecutions: 1,
    toolCalls: 1,
    wallTimeMs: 1,
    tokens: { input: 1, output: 1, total: 2 },
  },
});

describe("executeFormalBenchmarkV2", () => {
  it("rejects a recovery-cycle request for a new execution ID", async () => {
    const repository = new MemoryRepository();
    let identified: BenchmarkExecutionId | undefined;
    const requestedExecutionId = asBenchmarkExecutionId(
      "benchmark-execution:not-started",
    );
    await expect(
      executeFormalBenchmarkV2({
        suite,
        executionId: requestedExecutionId,
        provenance,
        repository,
        allowRecoveryCycle: true,
        runAttempt: async (cell) => success(cell),
        recover: async () => undefined,
        nowIso: () => "2026-08-05T00:00:00.000Z",
        sleep: async () => undefined,
        onExecutionSelected: (executionId) => {
          expect(repository.definition).toEqual(suite);
          expect(repository.selection?.executionId).toBe(executionId);
          identified = executionId;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("Recovery requires an existing");
    expect(repository.starts.size).toBe(0);
    expect(repository.selection).toBeUndefined();
    expect(identified).toBeUndefined();
  });

  it("resumes a selected-but-unstarted execution without opening recovery attempts", async () => {
    const repository = new MemoryRepository();
    const executionId = asBenchmarkExecutionId(
      "benchmark-execution:selected-only",
    );
    repository.selection = {
      schemaVersion: 2,
      suiteId: suite.suiteId,
      definitionId: suite.definitionId,
      executionId,
      selectionHash: benchmarkExecutionSelectionHashV2(
        suite.definitionId,
        executionId,
      ),
    };
    let recoveries = 0;
    let identified: BenchmarkExecutionId | undefined;
    const result = await executeFormalBenchmarkV2({
      suite,
      executionId,
      provenance,
      repository,
      allowRecoveryCycle: true,
      runAttempt: async (cell) => success(cell),
      recover: () => {
        recoveries += 1;
        return Promise.resolve();
      },
      nowIso: () => "2026-08-05T00:00:00.000Z",
      sleep: () => Promise.resolve(),
      onExecutionSelected: (selectedExecutionId) => {
        expect(repository.definition).toEqual(suite);
        expect(repository.selection?.executionId).toBe(selectedExecutionId);
        identified = selectedExecutionId;
        return Promise.resolve();
      },
    });
    expect(result.report.status).toBe("complete");
    expect(
      result.report.attempts.every((attempt) => attempt.ordinal === 1),
    ).toBe(true);
    expect(recoveries).toBe(0);
    expect(identified).toBe(executionId);
  });

  it("seals an execution-level prompt fairness failure as publishable invalid", async () => {
    const repository = new MemoryRepository();
    const executionId = asBenchmarkExecutionId("benchmark-execution:audit");
    let clock = 0;
    const result = await executeFormalBenchmarkV2({
      suite,
      executionId,
      provenance,
      repository,
      allowRecoveryCycle: false,
      runAttempt: async (cell) => success(cell),
      recover: async () => undefined,
      nowIso: () =>
        new Date(Date.UTC(2026, 7, 5) + clock++ * 1_000).toISOString(),
      sleep: async () => undefined,
      validateBeforePersist: async () => {
        throw new Error("prompt mismatch with untrusted details");
      },
    });
    expect(result.report.status).toBe("invalid");
    expect(result.report.auditIssues).toEqual(["prompt_fairness_failed"]);
    expect(repository.completed).toEqual(result.report);
    expect(JSON.stringify(result.report)).not.toContain("untrusted details");
    let cherryPickAnnounced = false;
    await expect(
      executeFormalBenchmarkV2({
        suite,
        executionId: asBenchmarkExecutionId("benchmark-execution:cherry-pick"),
        provenance,
        repository,
        allowRecoveryCycle: false,
        runAttempt: async (cell) => success(cell),
        recover: async () => undefined,
        nowIso: () => "2026-08-05T01:00:00.000Z",
        sleep: async () => undefined,
        onExecutionSelected: () => {
          cherryPickAnnounced = true;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("selection conflict");
    expect(cherryPickAnnounced).toBe(false);
  });

  it("seals malformed provider usage metrics instead of leaving a running execution", async () => {
    const repository = new MemoryRepository();
    const executionId = asBenchmarkExecutionId(
      "benchmark-execution:invalid-usage",
    );
    const result = await executeFormalBenchmarkV2({
      suite,
      executionId,
      provenance,
      repository,
      allowRecoveryCycle: false,
      runAttempt: async (cell, _ordinal, recordProgress) => {
        await recordProgress({
          observedAt: "2026-08-05T00:00:01.000Z",
          validationStage: "agent_progress",
          metrics: {
            gameExecutions: 1,
            toolCalls: 3,
            wallTimeMs: 100,
            tokens: { input: 7, output: 5, total: 12 },
          },
          rawManifest: { schemaVersion: 2, progress: true },
        });
        return {
          ...success(cell),
          metrics: {
            gameExecutions: 1,
            toolCalls: 3,
            wallTimeMs: 200,
            tokens: { input: 7, output: 5, total: 100 },
          },
        } as unknown as FormalBenchmarkAttemptResultV2;
      },
      recover: async () => undefined,
      nowIso: () => "2026-08-05T00:00:02.000Z",
      sleep: async () => undefined,
    });
    expect(result.report.status).toBe("invalid");
    expect(result.report.cells).toHaveLength(1);
    expect(result.report.cells[0]).toMatchObject({
      terminalCode: "harness_failure",
    });
    expect(result.report.attempts[0]?.metrics).toMatchObject({
      toolCalls: 3,
      tokens: { total: 12 },
    });
    expect(repository.completed).toEqual(result.report);
  });

  it("seals a started-only crash after progress as terminal diagnostic without retry", async () => {
    const repository = new MemoryRepository();
    repository.failNextFinish = true;
    const executionId = asBenchmarkExecutionId("benchmark-execution:progress");
    let clock = 0;
    const nowIso = (): string =>
      new Date(Date.UTC(2026, 7, 5) + clock++ * 1_000).toISOString();
    await expect(
      executeFormalBenchmarkV2({
        suite,
        executionId,
        provenance,
        repository,
        allowRecoveryCycle: false,
        runAttempt: async (cell, _ordinal, recordProgress) => {
          await recordProgress({
            observedAt: nowIso(),
            validationStage: "agent_progress",
            metrics: {
              gameExecutions: 2,
              toolCalls: 3,
              wallTimeMs: 50,
              tokens: { input: 7, output: 5, total: 12 },
            },
            rawManifest: { schemaVersion: 2, promptAudit: "persisted" },
          });
          return success(cell);
        },
        recover: async () => undefined,
        nowIso,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("simulated process crash");

    let reruns = 0;
    const resumed = await executeFormalBenchmarkV2({
      suite,
      executionId,
      provenance,
      repository,
      allowRecoveryCycle: false,
      runAttempt: async (cell) => {
        reruns += 1;
        return success(cell);
      },
      recover: async () => undefined,
      nowIso,
      sleep: async () => undefined,
    });
    const recovered = resumed.report.cells.find(
      (cell) => cell.status === "diagnostic_failure",
    );
    expect(recovered?.terminalCode).toBe("process_interrupted_after_progress");
    expect(recovered?.metrics).toMatchObject({
      gameExecutions: 2,
      toolCalls: 3,
      tokens: { total: 12 },
    });
    expect(reruns).toBe(35);
  });

  it("seals a crash before Fixture validation as invalid while preserving cost", async () => {
    const repository = new MemoryRepository();
    repository.failNextFinish = true;
    const executionId = asBenchmarkExecutionId(
      "benchmark-execution:unvalidated-progress",
    );
    let clock = 0;
    const nowIso = (): string =>
      new Date(Date.UTC(2026, 7, 5) + clock++ * 1_000).toISOString();
    await expect(
      executeFormalBenchmarkV2({
        suite,
        executionId,
        provenance,
        repository,
        allowRecoveryCycle: false,
        runAttempt: async (cell, _ordinal, recordProgress) => {
          await recordProgress({
            observedAt: nowIso(),
            validationStage: "baseline_completed_unvalidated",
            metrics: {
              gameExecutions: 1,
              toolCalls: 0,
              wallTimeMs: 25,
              tokens: { input: 0, output: 0, total: 0 },
            },
            rawManifest: { schemaVersion: 2, stage: "baseline_completed" },
          });
          return success(cell);
        },
        recover: () => Promise.resolve(),
        nowIso,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow("simulated process crash");

    let reruns = 0;
    const resumed = await executeFormalBenchmarkV2({
      suite,
      executionId,
      provenance,
      repository,
      allowRecoveryCycle: false,
      runAttempt: async (cell) => {
        reruns += 1;
        return success(cell);
      },
      recover: () => Promise.resolve(),
      nowIso,
      sleep: () => Promise.resolve(),
    });
    expect(resumed.report.status).toBe("invalid");
    expect(resumed.report.attempts[0]?.metrics.gameExecutions).toBe(1);
    expect(resumed.report.cells[0]?.terminalCode).toBe("harness_failure");
    expect(reruns).toBe(0);
  });

  it("retries a validated baseline crash before Agent progress and retains its cost", async () => {
    const repository = new MemoryRepository();
    repository.failNextFinish = true;
    const executionId = asBenchmarkExecutionId(
      "benchmark-execution:validated-progress",
    );
    let clock = 0;
    const nowIso = (): string =>
      new Date(Date.UTC(2026, 7, 5) + clock++ * 1_000).toISOString();
    await expect(
      executeFormalBenchmarkV2({
        suite,
        executionId,
        provenance,
        repository,
        allowRecoveryCycle: false,
        runAttempt: async (cell, _ordinal, recordProgress) => {
          await recordProgress({
            observedAt: nowIso(),
            validationStage: "fixture_material_validated",
            metrics: {
              gameExecutions: 1,
              toolCalls: 0,
              wallTimeMs: 25,
              tokens: { input: 0, output: 0, total: 0 },
            },
            rawManifest: { schemaVersion: 2, stage: "fixture_validated" },
          });
          return success(cell);
        },
        recover: () => Promise.resolve(),
        nowIso,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow("simulated process crash");

    let reruns = 0;
    const resumed = await executeFormalBenchmarkV2({
      suite,
      executionId,
      provenance,
      repository,
      allowRecoveryCycle: false,
      runAttempt: async (cell) => {
        reruns += 1;
        return success(cell);
      },
      recover: () => Promise.resolve(),
      nowIso,
      sleep: () => Promise.resolve(),
    });
    expect(resumed.report.status).toBe("complete");
    expect(resumed.report.attempts).toHaveLength(37);
    expect(resumed.report.attempts[0]).toMatchObject({
      progressObserved: false,
      metrics: { gameExecutions: 1 },
      outcome: { status: "interrupted", retryable: true },
    });
    expect(reruns).toBe(36);
    const aggregate = resumed.report.aggregate;
    if (aggregate === null) throw new Error("Missing complete aggregate");
    expect(
      aggregate.byArm.generic.totalGameExecutions +
        aggregate.byArm.evidenceOnly.totalGameExecutions +
        aggregate.byArm.chronoriftFull.totalGameExecutions,
    ).toBe(37);
  });

  it("leaves three-failure cells recoverable and opens ordinals 4-6 only on resume", async () => {
    const repository = new MemoryRepository();
    const executionId = asBenchmarkExecutionId("benchmark-execution:test");
    let clock = 0;
    const nowIso = (): string =>
      new Date(Date.UTC(2026, 7, 5) + clock++ * 1_000).toISOString();
    let blockedCell: BenchmarkCellId | undefined;
    const initial = await executeFormalBenchmarkV2({
      suite,
      executionId,
      provenance,
      repository,
      allowRecoveryCycle: false,
      runAttempt: async (cell) => {
        blockedCell ??= cell.cellId;
        return cell.cellId === blockedCell
          ? {
              status: "infra_failure",
              progressObserved: false,
              code: "connection_error",
              message: "reset",
              metrics: {
                gameExecutions: 0,
                toolCalls: 0,
                wallTimeMs: 10,
                tokens: { input: 0, output: 0, total: 0 },
              },
            }
          : success(cell);
      },
      recover: async () => undefined,
      nowIso,
      sleep: async () => undefined,
    });
    expect(initial.report.status).toBe("incomplete");
    expect(initial.recoverable).toBe(true);
    expect(initial.report.cells).toHaveLength(35);
    expect(repository.completed).toBeUndefined();

    let recoveries = 0;
    let resumedCalls = 0;
    const resumed = await executeFormalBenchmarkV2({
      suite,
      executionId,
      provenance,
      repository,
      allowRecoveryCycle: true,
      runAttempt: async (cell) => {
        resumedCalls += 1;
        return success(cell);
      },
      recover: async () => {
        recoveries += 1;
      },
      nowIso,
      sleep: async () => undefined,
    });
    expect(resumed.report.status).toBe("complete");
    expect(resumed.report.cells).toHaveLength(36);
    expect(resumed.report.attempts).toHaveLength(39);
    expect(resumedCalls).toBe(1);
    expect(recoveries).toBe(1);
    expect(repository.completed?.reportHash).toBe(resumed.report.reportHash);
  });
});
