import {
  BenchmarkAttemptFinishedV2Schema,
  BenchmarkAttemptProgressV2Schema,
  BenchmarkAttemptStartedV2Schema,
  BenchmarkCellAttemptV2Schema,
  BenchmarkCellMetricsV2Schema,
  BenchmarkCellResultV2Schema,
  BenchmarkExecutionStartedV2Schema,
  BenchmarkExecutionSelectionV2Schema,
  type BenchmarkAttemptId,
  type BenchmarkCellAttemptV2,
  type BenchmarkCellId,
  type BenchmarkCellMetricsV2,
  type BenchmarkCellResultV2,
  type BenchmarkCellScoreV2,
  type BenchmarkDiagnosticFailureCodeV2,
  type BenchmarkExecutionId,
  type BenchmarkExecutionStartedV2,
  type BenchmarkInfraFailureCodeV2,
  type BenchmarkInvalidCodeV2,
  type BenchmarkProvenanceV2,
  type BenchmarkReportV2,
  type BenchmarkSuiteSpecV2,
  type FixtureId,
  type JsonValue,
} from "@chronorift/domain";
import {
  benchmarkAttemptIdV2,
  benchmarkAttemptHashV2,
  benchmarkCellOrderV2,
  benchmarkExecutionSelectionHashV2,
  buildBenchmarkReportV2,
  scoreBenchmarkDiagnosisV2,
  verifyBenchmarkReportV2,
  type V03BenchmarkArtifactRepositoryPort,
} from "@chronorift/gamebranch";
import { contentHash } from "@chronorift/json-artifacts";

const INITIAL_ATTEMPT_LIMIT = 3;
const ABSOLUTE_ATTEMPT_LIMIT = 6;
const BACKOFF_MS = [1_000, 3_000] as const;

export interface FormalBenchmarkCellV2 {
  readonly cellId: BenchmarkCellId;
  readonly fixtureId: FixtureId;
  readonly arm: BenchmarkSuiteSpecV2["arms"][number];
  readonly repetition: number;
  readonly expectedMechanism: BenchmarkSuiteSpecV2["fixtures"][number]["expectedMechanism"];
}

export type FormalBenchmarkAttemptResultV2 =
  | {
      readonly status: "completed";
      readonly progressObserved: true;
      readonly rawManifest: JsonValue;
      readonly score: BenchmarkCellScoreV2;
      readonly metrics: BenchmarkCellMetricsV2;
    }
  | {
      readonly status: "diagnostic_failure";
      readonly progressObserved: true;
      readonly code: BenchmarkDiagnosticFailureCodeV2;
      readonly message: string;
      readonly rawManifest: JsonValue;
      readonly metrics: BenchmarkCellMetricsV2;
    }
  | {
      readonly status: "infra_failure";
      readonly progressObserved: false;
      readonly code: BenchmarkInfraFailureCodeV2;
      readonly message: string;
      readonly metrics: BenchmarkCellMetricsV2;
    }
  | {
      readonly status: "invalid";
      readonly progressObserved: boolean;
      readonly code: BenchmarkInvalidCodeV2;
      readonly message: string;
      readonly metrics: BenchmarkCellMetricsV2;
    };

export interface ExecuteFormalBenchmarkV2Options {
  readonly suite: BenchmarkSuiteSpecV2;
  readonly executionId: BenchmarkExecutionId;
  readonly provenance: BenchmarkProvenanceV2;
  readonly repository: V03BenchmarkArtifactRepositoryPort;
  readonly allowRecoveryCycle: boolean;
  readonly runAttempt: (
    cell: FormalBenchmarkCellV2,
    ordinal: number,
    recordProgress: (
      snapshot: FormalAttemptProgressSnapshotV2,
    ) => Promise<void>,
  ) => Promise<FormalBenchmarkAttemptResultV2>;
  readonly recover: (cell: FormalBenchmarkCellV2) => Promise<void>;
  readonly nowIso: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly onExecutionSelected?:
    ((executionId: BenchmarkExecutionId) => Promise<void>) | undefined;
  readonly validateBeforePersist?:
    ((report: BenchmarkReportV2) => Promise<void>) | undefined;
}

export interface FormalAttemptProgressSnapshotV2 {
  readonly observedAt: string;
  readonly validationStage:
    | "baseline_completed_unvalidated"
    | "fixture_material_validated"
    | "agent_progress";
  readonly metrics: BenchmarkCellMetricsV2;
  readonly rawManifest: JsonValue;
}

export interface ExecuteFormalBenchmarkV2Result {
  readonly report: BenchmarkReportV2;
  readonly recoverable: boolean;
  readonly resumed: boolean;
}

const zeroMetrics = (): BenchmarkCellMetricsV2 => ({
  gameExecutions: 0,
  toolCalls: 0,
  wallTimeMs: 0,
  tokens: { input: 0, output: 0, total: 0 },
});

const attemptKind = (ordinal: number): BenchmarkCellAttemptV2["kind"] =>
  ordinal === 1 ? "initial" : ordinal === 4 ? "recovery" : "infra_retry";

const cellsForSuite = (
  suite: BenchmarkSuiteSpecV2,
): readonly FormalBenchmarkCellV2[] => {
  const fixtures = new Map(
    suite.fixtures.map((fixture) => [fixture.fixtureId, fixture] as const),
  );
  return benchmarkCellOrderV2(suite).map((ordered) => {
    const fixture = fixtures.get(ordered.fixtureId);
    if (fixture === undefined) throw new Error("Unknown ordered Fixture");
    return {
      cellId: ordered.cellId,
      fixtureId: fixture.fixtureId,
      arm: ordered.arm,
      repetition: ordered.repetition,
      expectedMechanism: fixture.expectedMechanism,
    };
  });
};

const assertAttemptMatchesStart = (
  started: ReturnType<typeof BenchmarkAttemptStartedV2Schema.parse>,
  finished: BenchmarkCellAttemptV2,
): void => {
  const {
    attemptHash,
    finishedAt: _finishedAt,
    progressObserved: _progress,
    metrics: _metrics,
    outcome: _outcome,
    ...prefix
  } = finished;
  void _finishedAt;
  void _progress;
  void _metrics;
  void _outcome;
  if (
    contentHash(prefix) !== contentHash(started as unknown as JsonValue) ||
    benchmarkAttemptHashV2(
      Object.fromEntries(
        Object.entries(finished).filter(([key]) => key !== "attemptHash"),
      ) as Omit<BenchmarkCellAttemptV2, "attemptHash">,
    ) !== attemptHash
  ) {
    throw new Error(`Attempt ${finished.attemptId} failed lineage validation`);
  }
};

const diagnosticScore = (
  expectedMechanism: FormalBenchmarkCellV2["expectedMechanism"],
): BenchmarkCellScoreV2 =>
  scoreBenchmarkDiagnosisV2({
    proposalId: null,
    candidateExecutionIds: [],
    accessReceiptIds: [],
    expectedMechanism,
    proposedMechanism: "unknown",
    verdict: "inconclusive",
    sourceLocationCorrect: null,
    sourceGrounded: false,
    confidence: null,
  });

const terminalCellFor = (
  suite: BenchmarkSuiteSpecV2,
  executionId: BenchmarkExecutionId,
  cell: FormalBenchmarkCellV2,
  attempts: readonly BenchmarkCellAttemptV2[],
  result: FormalBenchmarkAttemptResultV2 | { readonly status: "interrupted" },
): BenchmarkCellResultV2 | null => {
  const selected = attempts.at(-1);
  if (selected === undefined) throw new Error("Terminal cell has no attempt");
  const attemptIds = attempts.map((attempt) => attempt.attemptId) as [
    BenchmarkAttemptId,
    ...BenchmarkAttemptId[],
  ];
  const common = {
    schemaVersion: 2,
    suiteId: suite.suiteId,
    definitionId: suite.definitionId,
    executionId,
    cellId: cell.cellId,
    fixtureId: cell.fixtureId,
    arm: cell.arm,
    repetition: cell.repetition,
    expectedMechanism: cell.expectedMechanism,
    attemptIds,
    selectedAttemptId: selected.attemptId,
  } as const;
  if (result.status === "completed") {
    return BenchmarkCellResultV2Schema.parse({
      ...common,
      status: "scored",
      terminalCode: null,
      score: result.score,
      metrics: result.metrics,
      rawManifestHash: contentHash(result.rawManifest),
    });
  }
  if (result.status === "diagnostic_failure") {
    return BenchmarkCellResultV2Schema.parse({
      ...common,
      status: "diagnostic_failure",
      terminalCode: result.code,
      score: diagnosticScore(cell.expectedMechanism),
      metrics: result.metrics,
      rawManifestHash: contentHash(result.rawManifest),
    });
  }
  if (result.status === "invalid") {
    return BenchmarkCellResultV2Schema.parse({
      ...common,
      status: "invalid",
      terminalCode: result.code,
      score: null,
      metrics: zeroMetrics(),
      rawManifestHash: contentHash({ attemptHash: selected.attemptHash }),
    });
  }
  if (attempts.length < ABSOLUTE_ATTEMPT_LIMIT) return null;
  return BenchmarkCellResultV2Schema.parse({
    ...common,
    status: "infra_exhausted",
    terminalCode:
      result.status === "interrupted" ? "process_interrupted" : result.code,
    score: null,
    metrics: zeroMetrics(),
    rawManifestHash: contentHash({
      attemptHashes: attempts.map((attempt) => attempt.attemptHash),
    }),
  });
};

const interruptedAttempt = (
  started: ReturnType<typeof BenchmarkAttemptStartedV2Schema.parse>,
  finishedAt: string,
): BenchmarkCellAttemptV2 => {
  const basis = {
    ...started,
    finishedAt,
    progressObserved: false,
    metrics: zeroMetrics(),
    outcome: {
      status: "interrupted",
      code: "process_interrupted",
      message: "Retryable process interruption",
      retryable: true,
    },
  } as const;
  return BenchmarkCellAttemptV2Schema.parse({
    ...basis,
    attemptHash: benchmarkAttemptHashV2(basis),
  });
};

interface ProcessCellResult {
  readonly cell: BenchmarkCellResultV2 | null;
  readonly attempts: readonly BenchmarkCellAttemptV2[];
}

async function processCell(
  options: ExecuteFormalBenchmarkV2Options,
  cell: FormalBenchmarkCellV2,
): Promise<ProcessCellResult> {
  const existingCell = await options.repository.getCell(
    options.suite.definitionId,
    options.executionId,
    cell.cellId,
  );
  const attempts: BenchmarkCellAttemptV2[] = [];
  let previousAttemptHash: string | null = null;
  let firstUnusedOrdinal = 1;

  for (let ordinal = 1; ordinal <= ABSOLUTE_ATTEMPT_LIMIT; ordinal += 1) {
    const attemptId = benchmarkAttemptIdV2(
      options.executionId,
      cell.cellId,
      ordinal,
    );
    const started = await options.repository.getAttemptStarted(
      options.suite.definitionId,
      options.executionId,
      cell.cellId,
      ordinal,
      attemptId,
    );
    const finished = await options.repository.getAttemptFinished(
      options.suite.definitionId,
      options.executionId,
      cell.cellId,
      ordinal,
      attemptId,
    );
    if (started === null) {
      if (finished !== null) throw new Error("Attempt finished without start");
      firstUnusedOrdinal = ordinal;
      break;
    }
    if (
      started.previousAttemptHash !== previousAttemptHash ||
      started.fixtureId !== cell.fixtureId ||
      started.arm !== cell.arm ||
      started.repetition !== cell.repetition ||
      started.kind !== attemptKind(ordinal)
    ) {
      throw new Error(`Attempt ${attemptId} start lineage is invalid`);
    }
    const completion =
      finished ??
      BenchmarkAttemptFinishedV2Schema.parse({
        schemaVersion: 2,
        attempt: interruptedAttempt(started, options.nowIso()),
        terminalCell: null,
        rawManifest: null,
      });
    if (finished === null) {
      const progress = await options.repository.getLatestAttemptProgress(
        options.suite.definitionId,
        options.executionId,
        cell.cellId,
        ordinal,
        attemptId,
      );
      if (progress !== null) {
        if (progress.validationStage === "baseline_completed_unvalidated") {
          const basis = {
            ...started,
            finishedAt: progress.observedAt,
            progressObserved: true,
            metrics: progress.metrics,
            outcome: {
              status: "invalid" as const,
              code: "harness_failure" as const,
              message: "Invalid formal attempt",
              retryable: false as const,
            },
          };
          const attempt = BenchmarkCellAttemptV2Schema.parse({
            ...basis,
            attemptHash: benchmarkAttemptHashV2(basis),
          });
          const chain = [...attempts, attempt];
          const terminalCell = terminalCellFor(
            options.suite,
            options.executionId,
            cell,
            chain,
            {
              status: "invalid",
              progressObserved: true,
              code: "harness_failure",
              message: "Invalid formal attempt",
              metrics: progress.metrics,
            },
          );
          if (terminalCell === null) {
            throw new Error(
              "Unvalidated recovery did not create a terminal cell",
            );
          }
          await options.repository.putAttemptFinished({
            schemaVersion: 2,
            attempt,
            terminalCell,
            rawManifest: null,
          });
          await options.repository.putCell(terminalCell);
          attempts.push(attempt);
          return { cell: terminalCell, attempts };
        }
        if (progress.validationStage === "fixture_material_validated") {
          const basis = {
            ...started,
            finishedAt: progress.observedAt,
            progressObserved: false,
            metrics: progress.metrics,
            outcome: {
              status: "interrupted" as const,
              code: "process_interrupted" as const,
              message: "Retryable process interruption",
              retryable: true as const,
            },
          };
          const attempt = BenchmarkCellAttemptV2Schema.parse({
            ...basis,
            attemptHash: benchmarkAttemptHashV2(basis),
          });
          const chain = [...attempts, attempt];
          const terminalCell = terminalCellFor(
            options.suite,
            options.executionId,
            cell,
            chain,
            { status: "interrupted" },
          );
          await options.repository.putAttemptFinished({
            schemaVersion: 2,
            attempt,
            terminalCell,
            rawManifest: null,
          });
          if (terminalCell !== null) {
            await options.repository.putCell(terminalCell);
          }
          attempts.push(attempt);
          if (terminalCell !== null) return { cell: terminalCell, attempts };
          previousAttemptHash = attempt.attemptHash;
          firstUnusedOrdinal = ordinal + 1;
          continue;
        }
        const recoveredResult = {
          status: "diagnostic_failure" as const,
          progressObserved: true as const,
          code: "process_interrupted_after_progress" as const,
          message: "Terminal diagnostic failure",
          rawManifest: progress.rawManifest,
          metrics: progress.metrics,
        };
        const basis = {
          ...started,
          finishedAt: progress.observedAt,
          progressObserved: true,
          metrics: progress.metrics,
          outcome: {
            status: "diagnostic_failure" as const,
            code: "process_interrupted_after_progress" as const,
            message: "Terminal diagnostic failure",
            rawManifestHash: contentHash(progress.rawManifest),
          },
        };
        const attempt = BenchmarkCellAttemptV2Schema.parse({
          ...basis,
          attemptHash: benchmarkAttemptHashV2(basis),
        });
        const chain = [...attempts, attempt];
        const terminalCell = terminalCellFor(
          options.suite,
          options.executionId,
          cell,
          chain,
          recoveredResult,
        );
        if (terminalCell === null) {
          throw new Error("Progress recovery did not create a terminal cell");
        }
        await options.repository.putAttemptFinished({
          schemaVersion: 2,
          attempt,
          terminalCell,
          rawManifest: progress.rawManifest,
        });
        await options.repository.putCell(terminalCell);
        attempts.push(attempt);
        return { cell: terminalCell, attempts };
      }
      const chain = [...attempts, completion.attempt];
      const terminalCell = terminalCellFor(
        options.suite,
        options.executionId,
        cell,
        chain,
        { status: "interrupted" },
      );
      const recoverable = BenchmarkAttemptFinishedV2Schema.parse({
        ...completion,
        terminalCell,
      });
      await options.repository.putAttemptFinished(recoverable);
      if (terminalCell !== null) await options.repository.putCell(terminalCell);
      attempts.push(recoverable.attempt);
      if (terminalCell !== null) return { cell: terminalCell, attempts };
    } else {
      assertAttemptMatchesStart(started, completion.attempt);
      attempts.push(completion.attempt);
      if (completion.terminalCell !== null) {
        if (existingCell === null) {
          await options.repository.putCell(completion.terminalCell);
        } else if (
          contentHash(existingCell) !== contentHash(completion.terminalCell)
        ) {
          throw new Error("Persisted terminal cell contradicts its attempt");
        }
        return { cell: completion.terminalCell, attempts };
      }
    }
    previousAttemptHash = completion.attempt.attemptHash;
    firstUnusedOrdinal = ordinal + 1;
  }

  if (existingCell !== null) {
    throw new Error("Terminal cell has no matching finished attempt");
  }
  const maximumOrdinal = options.allowRecoveryCycle
    ? ABSOLUTE_ATTEMPT_LIMIT
    : INITIAL_ATTEMPT_LIMIT;
  for (
    let ordinal = firstUnusedOrdinal;
    ordinal <= maximumOrdinal;
    ordinal += 1
  ) {
    if (ordinal === 4) await options.recover(cell);
    else if (ordinal > 1) {
      const backoff = BACKOFF_MS[((ordinal - 1) % 3) - 1];
      if (backoff !== undefined) await options.sleep(backoff);
    }
    const attemptId = benchmarkAttemptIdV2(
      options.executionId,
      cell.cellId,
      ordinal,
    );
    const started = BenchmarkAttemptStartedV2Schema.parse({
      schemaVersion: 2,
      suiteId: options.suite.suiteId,
      definitionId: options.suite.definitionId,
      executionId: options.executionId,
      cellId: cell.cellId,
      attemptId,
      fixtureId: cell.fixtureId,
      arm: cell.arm,
      repetition: cell.repetition,
      ordinal,
      kind: attemptKind(ordinal),
      previousAttemptHash,
      startedAt: options.nowIso(),
    });
    await options.repository.putAttemptStarted(started);
    let result: FormalBenchmarkAttemptResultV2;
    let latestProgress: FormalAttemptProgressSnapshotV2 | undefined;
    try {
      let progressSequence = 0;
      result = await options.runAttempt(cell, ordinal, async (snapshot) => {
        latestProgress = snapshot;
        progressSequence += 1;
        const progress = BenchmarkAttemptProgressV2Schema.parse({
          schemaVersion: 2,
          suiteId: options.suite.suiteId,
          definitionId: options.suite.definitionId,
          executionId: options.executionId,
          cellId: cell.cellId,
          attemptId,
          ordinal,
          sequence: progressSequence,
          observedAt: snapshot.observedAt,
          progressObserved: true,
          validationStage: snapshot.validationStage,
          metrics: snapshot.metrics,
          rawManifest: snapshot.rawManifest,
        });
        await options.repository.putAttemptProgress(progress);
      });
    } catch {
      result = {
        status: "invalid",
        progressObserved: latestProgress !== undefined,
        code: "harness_failure",
        message: "Invalid formal attempt",
        metrics: latestProgress?.metrics ?? zeroMetrics(),
      };
    }
    if (!BenchmarkCellMetricsV2Schema.safeParse(result.metrics).success) {
      result = {
        status: "invalid",
        progressObserved: latestProgress !== undefined,
        code: "harness_failure",
        message: "Invalid formal attempt metrics",
        metrics: latestProgress?.metrics ?? zeroMetrics(),
      };
    }
    const outcome =
      result.status === "completed"
        ? {
            status: "completed" as const,
            rawManifestHash: contentHash(result.rawManifest),
          }
        : result.status === "diagnostic_failure"
          ? {
              status: "diagnostic_failure" as const,
              code: result.code,
              message: "Terminal diagnostic failure",
              rawManifestHash: contentHash(result.rawManifest),
            }
          : result.status === "infra_failure"
            ? {
                status: "infra_failure" as const,
                code: result.code,
                message: "Retryable infrastructure failure",
                retryable: true as const,
              }
            : {
                status: "invalid" as const,
                code: result.code,
                message: "Invalid formal attempt",
                retryable: false as const,
              };
    const attemptBasis = {
      ...started,
      finishedAt: options.nowIso(),
      progressObserved: result.progressObserved,
      metrics: result.metrics,
      outcome,
    } as const;
    const attempt = BenchmarkCellAttemptV2Schema.parse({
      ...attemptBasis,
      attemptHash: benchmarkAttemptHashV2(attemptBasis),
    });
    attempts.push(attempt);
    const terminalCell = terminalCellFor(
      options.suite,
      options.executionId,
      cell,
      attempts,
      result,
    );
    const completion = BenchmarkAttemptFinishedV2Schema.parse({
      schemaVersion: 2,
      attempt,
      terminalCell,
      rawManifest:
        result.status === "completed" || result.status === "diagnostic_failure"
          ? result.rawManifest
          : null,
    });
    await options.repository.putAttemptFinished(completion);
    if (terminalCell !== null) {
      await options.repository.putCell(terminalCell);
      return { cell: terminalCell, attempts };
    }
    previousAttemptHash = attempt.attemptHash;
  }
  return { cell: null, attempts };
}

export async function executeFormalBenchmarkV2(
  options: ExecuteFormalBenchmarkV2Options,
): Promise<ExecuteFormalBenchmarkV2Result> {
  const expectedSelectionHash = benchmarkExecutionSelectionHashV2(
    options.suite.definitionId,
    options.executionId,
  );
  const completed = await options.repository.getCompleted(
    options.suite.definitionId,
    options.executionId,
  );
  if (completed !== null) {
    const selection = await options.repository.getExecutionSelection(
      options.suite.definitionId,
    );
    if (
      selection === null ||
      selection.suiteId !== options.suite.suiteId ||
      selection.executionId !== options.executionId ||
      selection.selectionHash !== expectedSelectionHash
    ) {
      throw new Error("Completed report lacks its first-execution selection");
    }
    const verification = verifyBenchmarkReportV2(completed);
    if (!verification.valid) {
      throw new Error(
        "Persisted completed benchmark failed integrity verification",
      );
    }
    if (completed.auditIssues.length === 0) {
      await options.validateBeforePersist?.(completed);
    }
    return { report: completed, recoverable: false, resumed: true };
  }
  await options.repository.putDefinition(options.suite);
  const selectionHash = expectedSelectionHash;
  const selectionRecord = BenchmarkExecutionSelectionV2Schema.parse({
    schemaVersion: 2,
    suiteId: options.suite.suiteId,
    definitionId: options.suite.definitionId,
    executionId: options.executionId,
    selectionHash,
  });
  const priorSelection = await options.repository.getExecutionSelection(
    options.suite.definitionId,
  );
  if (options.allowRecoveryCycle) {
    if (priorSelection === null) {
      throw new Error(
        "Recovery requires an existing formal execution selection",
      );
    }
  } else {
    await options.repository.putExecutionSelection(selectionRecord);
  }
  const persistedSelection =
    priorSelection ??
    (await options.repository.getExecutionSelection(
      options.suite.definitionId,
    ));
  if (
    persistedSelection === null ||
    persistedSelection.suiteId !== options.suite.suiteId ||
    persistedSelection.executionId !== options.executionId ||
    persistedSelection.selectionHash !== selectionHash
  ) {
    throw new Error("Formal execution selection does not match this execution");
  }
  await options.onExecutionSelected?.(options.executionId);
  const priorStart = await options.repository.getExecutionStarted(
    options.suite.definitionId,
    options.executionId,
  );
  const opensRecoveryAttempts =
    options.allowRecoveryCycle && priorStart !== null;
  const start: BenchmarkExecutionStartedV2 =
    priorStart ??
    BenchmarkExecutionStartedV2Schema.parse({
      schemaVersion: 2,
      suiteId: options.suite.suiteId,
      definitionId: options.suite.definitionId,
      executionId: options.executionId,
      selectionHash,
      startedAt: options.nowIso(),
      provenance: options.provenance,
    });
  if (priorStart === null) await options.repository.putExecutionStarted(start);
  else if (
    priorStart.suiteId !== options.suite.suiteId ||
    priorStart.selectionHash !== selectionHash ||
    JSON.stringify(priorStart.provenance) !== JSON.stringify(options.provenance)
  ) {
    throw new Error("Resume provenance does not match the frozen execution");
  }

  const orderedCells = cellsForSuite(options.suite);
  const processedByCell = new Map<BenchmarkCellId, ProcessCellResult>();
  let invalid = false;
  for (const cell of orderedCells) {
    const processed = await processCell(
      { ...options, allowRecoveryCycle: false },
      cell,
    );
    processedByCell.set(cell.cellId, processed);
    if (processed.cell?.status === "invalid") {
      invalid = true;
      break;
    }
  }
  if (opensRecoveryAttempts && !invalid) {
    for (const cell of orderedCells) {
      if (processedByCell.get(cell.cellId)?.cell !== null) continue;
      const processed = await processCell(
        { ...options, allowRecoveryCycle: true },
        cell,
      );
      processedByCell.set(cell.cellId, processed);
      if (processed.cell?.status === "invalid") {
        invalid = true;
        break;
      }
    }
  }
  const attempts = [
    ...orderedCells.flatMap(
      (cell) =>
        processedByCell
          .get(cell.cellId)
          ?.attempts.filter((attempt) => attempt.ordinal <= 3) ?? [],
    ),
    ...orderedCells.flatMap(
      (cell) =>
        processedByCell
          .get(cell.cellId)
          ?.attempts.filter((attempt) => attempt.ordinal >= 4) ?? [],
    ),
  ];
  const cells = orderedCells.flatMap((cell) => {
    const result = processedByCell.get(cell.cellId)?.cell;
    return result === undefined || result === null ? [] : [result];
  });
  const recoverable =
    !invalid &&
    !opensRecoveryAttempts &&
    cells.length <
      options.suite.fixtures.length * options.suite.arms.length * 3;
  let report = buildBenchmarkReportV2({
    suite: options.suite,
    executionId: options.executionId,
    startedAt: start.startedAt,
    finishedAt: options.nowIso(),
    provenance: start.provenance,
    attempts,
    cells,
  });
  if (!recoverable) {
    try {
      await options.validateBeforePersist?.(report);
    } catch {
      report = buildBenchmarkReportV2({
        suite: options.suite,
        executionId: options.executionId,
        startedAt: start.startedAt,
        finishedAt: report.finishedAt,
        provenance: start.provenance,
        attempts,
        cells,
        auditIssues: ["prompt_fairness_failed"],
      });
    }
    await options.repository.putCompleted(report);
  }
  return { report, recoverable, resumed: priorStart !== null };
}
