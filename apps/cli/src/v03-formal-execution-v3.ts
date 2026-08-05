import {
  BenchmarkAttemptFinishedV3Schema,
  BenchmarkAttemptProgressV3Schema,
  BenchmarkAttemptProgressStateV3Schema,
  BenchmarkAttemptStartedV3Schema,
  BenchmarkRawAttemptManifestV3Schema,
  BenchmarkCellAttemptV3Schema,
  BenchmarkCellMetricsV3Schema,
  BenchmarkCellResultV3Schema,
  BenchmarkExecutionSelectionV3Schema,
  BenchmarkExecutionStartedV3Schema,
  benchmarkProgressHasDiagnosticActivityV3,
  type BenchmarkAttemptId,
  type BenchmarkAttemptProgressStateV3,
  type BenchmarkCellAttemptV3,
  type BenchmarkCellId,
  type BenchmarkCellMetricsV3,
  type BenchmarkCellResultV3,
  type BenchmarkCellScoringProofV3,
  type BenchmarkCellScoreV3,
  type BenchmarkDiagnosticFailureCodeV3,
  type BenchmarkExecutionId,
  type BenchmarkInfrastructureFailureV3,
  type BenchmarkInvalidCodeV3,
  type BenchmarkProvenanceV3,
  type BenchmarkReportV3,
  type BenchmarkSuiteSpecV3,
  type FixtureId,
  type JsonValue,
} from "@chronorift/domain";
import {
  assertBenchmarkAttemptBudgetsV3,
  assertBenchmarkAttemptProgressSequenceV3,
  assertBenchmarkRawAttemptManifestV3Integrity,
  benchmarkAttemptHashV3,
  benchmarkAttemptIdV3,
  benchmarkCellScoringProofFromRawManifestV3,
  benchmarkCellOrderV3,
  benchmarkExecutionSelectionHashV3,
  buildBenchmarkReportV3,
  diagnosticFailureScoreV3,
  verifyBenchmarkReportV3,
  type V03BenchmarkArtifactRepositoryV3Port,
} from "@chronorift/gamebranch";
import { contentHash } from "@chronorift/json-artifacts";

const INITIAL_ATTEMPT_LIMIT = 3;
const ABSOLUTE_ATTEMPT_LIMIT = 6;
const BACKOFF_MS = [1_000, 3_000] as const;

export interface FormalBenchmarkCellV3 {
  readonly cellId: BenchmarkCellId;
  readonly fixtureId: FixtureId;
  readonly arm: BenchmarkSuiteSpecV3["arms"][number];
  readonly repetition: number;
  readonly expectedMechanism: BenchmarkSuiteSpecV3["fixtures"][number]["expectedMechanism"];
}

interface AttemptResultBaseV3 {
  readonly progress: BenchmarkAttemptProgressStateV3;
  readonly metrics: BenchmarkCellMetricsV3;
}

export type FormalBenchmarkAttemptResultV3 =
  | (AttemptResultBaseV3 & {
      readonly status: "completed";
      readonly rawManifest: JsonValue;
      readonly score: BenchmarkCellScoreV3;
    })
  | (AttemptResultBaseV3 & {
      readonly status: "diagnostic_failure";
      readonly code: BenchmarkDiagnosticFailureCodeV3;
      readonly message: string;
      readonly rawManifest: JsonValue;
    })
  | (AttemptResultBaseV3 & {
      readonly status: "infra_failure";
      readonly failure: BenchmarkInfrastructureFailureV3;
      readonly retryable: boolean;
      readonly message: string;
    })
  | (AttemptResultBaseV3 & {
      readonly status: "invalid";
      readonly code: BenchmarkInvalidCodeV3;
      readonly infrastructureFailure: BenchmarkInfrastructureFailureV3 | null;
      readonly message: string;
    });

export interface FormalAttemptProgressSnapshotV3 {
  readonly observedAt: string;
  readonly progress: BenchmarkAttemptProgressStateV3;
  readonly metrics: BenchmarkCellMetricsV3;
  readonly rawManifest: JsonValue;
}

export interface ExecuteFormalBenchmarkV3Options {
  readonly suite: BenchmarkSuiteSpecV3;
  readonly executionId: BenchmarkExecutionId;
  readonly provenance: BenchmarkProvenanceV3;
  readonly repository: V03BenchmarkArtifactRepositoryV3Port;
  readonly allowRecoveryCycle: boolean;
  readonly runAttempt: (
    cell: FormalBenchmarkCellV3,
    ordinal: number,
    recordProgress: (
      snapshot: FormalAttemptProgressSnapshotV3,
    ) => Promise<void>,
  ) => Promise<FormalBenchmarkAttemptResultV3>;
  readonly recover: (cell: FormalBenchmarkCellV3) => Promise<void>;
  readonly nowIso: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly onExecutionSelected?:
    ((executionId: BenchmarkExecutionId) => Promise<void>) | undefined;
  readonly validateBeforePersist?:
    ((report: BenchmarkReportV3) => Promise<void>) | undefined;
}

export interface ExecuteFormalBenchmarkV3Result {
  readonly report: BenchmarkReportV3;
  readonly recoverable: boolean;
  readonly resumed: boolean;
}

export const emptyFormalProgressV3 = (): BenchmarkAttemptProgressStateV3 => ({
  fixtureStage: "none",
  model: {
    requestStarted: false,
    outputObserved: false,
    turnCompleted: false,
  },
  tools: { started: 0, completed: 0, failed: 0, semanticRevision: 0 },
  game: { baselineExecutions: 0, diagnosticExecutions: 0 },
  proposalSubmitted: false,
});

export const zeroFormalMetricsV3 = (): BenchmarkCellMetricsV3 => ({
  gameExecutions: 0,
  toolCalls: 0,
  wallTimeMs: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assertExactProgressMetricsV3 = (
  progressInput: BenchmarkAttemptProgressStateV3,
  metricsInput: BenchmarkCellMetricsV3,
): void => {
  const progress = BenchmarkAttemptProgressStateV3Schema.parse(progressInput);
  const metrics = BenchmarkCellMetricsV3Schema.parse(metricsInput);
  if (
    progress.tools.failed + progress.tools.semanticRevision >
      progress.tools.completed ||
    metrics.toolCalls !== progress.tools.started ||
    metrics.gameExecutions !==
      progress.game.baselineExecutions + progress.game.diagnosticExecutions
  ) {
    throw new Error("Formal V3 metrics do not exactly match observed progress");
  }
};

const attemptKind = (ordinal: number): BenchmarkCellAttemptV3["kind"] =>
  ordinal === 1 ? "initial" : ordinal === 4 ? "recovery" : "infra_retry";

const cellsForSuite = (
  suite: BenchmarkSuiteSpecV3,
): readonly FormalBenchmarkCellV3[] => {
  const fixtures = new Map(
    suite.fixtures.map((fixture) => [fixture.fixtureId, fixture] as const),
  );
  return benchmarkCellOrderV3(suite).map((ordered) => {
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
  started: ReturnType<typeof BenchmarkAttemptStartedV3Schema.parse>,
  finished: BenchmarkCellAttemptV3,
): void => {
  const {
    attemptHash,
    finishedAt: _finishedAt,
    progress: _progress,
    metrics: _metrics,
    outcome: _outcome,
    ...prefix
  } = finished;
  void _finishedAt;
  void _progress;
  void _metrics;
  void _outcome;
  if (
    contentHash(prefix) !== contentHash(started) ||
    benchmarkAttemptHashV3(
      Object.fromEntries(
        Object.entries(finished).filter(([key]) => key !== "attemptHash"),
      ) as Omit<BenchmarkCellAttemptV3, "attemptHash">,
    ) !== attemptHash
  ) {
    throw new Error(`Attempt ${finished.attemptId} failed lineage validation`);
  }
};

const terminalCellFor = (
  suite: BenchmarkSuiteSpecV3,
  executionId: BenchmarkExecutionId,
  cell: FormalBenchmarkCellV3,
  attempts: readonly BenchmarkCellAttemptV3[],
  result: FormalBenchmarkAttemptResultV3,
): BenchmarkCellResultV3 | null => {
  const selected = attempts.at(-1);
  if (selected === undefined) throw new Error("Terminal cell has no attempt");
  const attemptIds = attempts.map((attempt) => attempt.attemptId) as [
    BenchmarkAttemptId,
    ...BenchmarkAttemptId[],
  ];
  const common = {
    schemaVersion: 3,
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
    return BenchmarkCellResultV3Schema.parse({
      ...common,
      status: "scored",
      terminalCode: null,
      infrastructureFailure: null,
      score: result.score,
      metrics: result.metrics,
      rawManifestHash: contentHash(result.rawManifest),
    });
  }
  if (result.status === "diagnostic_failure") {
    return BenchmarkCellResultV3Schema.parse({
      ...common,
      status: "diagnostic_failure",
      terminalCode: result.code,
      infrastructureFailure: null,
      score: diagnosticFailureScoreV3(cell.expectedMechanism),
      metrics: result.metrics,
      rawManifestHash: contentHash(result.rawManifest),
    });
  }
  if (result.status === "invalid") {
    return BenchmarkCellResultV3Schema.parse({
      ...common,
      status: "invalid",
      terminalCode: result.code,
      infrastructureFailure: null,
      score: null,
      metrics: result.metrics,
      rawManifestHash: null,
    });
  }
  if (result.retryable && attempts.length < ABSOLUTE_ATTEMPT_LIMIT) {
    return null;
  }
  const terminalCode =
    result.failure.kind === "provider"
      ? result.failure.provider.code
      : result.failure.code;
  return BenchmarkCellResultV3Schema.parse({
    ...common,
    status: "infra_unavailable",
    terminalCode,
    infrastructureFailure: result.failure,
    score: null,
    metrics: result.metrics,
    rawManifestHash: null,
  });
};

const processInterruption = (
  progress: BenchmarkAttemptProgressStateV3,
  metrics: BenchmarkCellMetricsV3,
): FormalBenchmarkAttemptResultV3 => ({
  status: "infra_failure",
  failure: {
    kind: "process_interrupted",
    code: "process_interrupted",
    retryClass: "transient",
  },
  retryable: !benchmarkProgressHasDiagnosticActivityV3(progress),
  message: "Process interrupted",
  progress,
  metrics,
});

const terminalProgressManifestV3 = (
  result: FormalBenchmarkAttemptResultV3,
): JsonValue => {
  if (result.status === "completed" || result.status === "diagnostic_failure") {
    return result.rawManifest;
  }
  if (result.status === "infra_failure") {
    return {
      schemaVersion: 3,
      stage: "attempt_terminal_without_evidence",
      status: result.status,
      failure: result.failure as unknown as JsonValue,
    };
  }
  return {
    schemaVersion: 3,
    stage: "attempt_terminal_without_evidence",
    status: result.status,
    code: result.code,
    infrastructureFailure: result.infrastructureFailure as unknown as JsonValue,
  };
};

interface ProcessCellResult {
  readonly cell: BenchmarkCellResultV3 | null;
  readonly attempts: readonly BenchmarkCellAttemptV3[];
}

const scoringProofsFor = async (
  options: ExecuteFormalBenchmarkV3Options,
  cells: readonly BenchmarkCellResultV3[],
  attempts: readonly BenchmarkCellAttemptV3[],
): Promise<readonly BenchmarkCellScoringProofV3[]> => {
  const attemptsById = new Map(
    attempts.map((attempt) => [attempt.attemptId, attempt] as const),
  );
  const proofs: BenchmarkCellScoringProofV3[] = [];
  for (const cell of cells) {
    if (cell.status !== "scored" && cell.status !== "diagnostic_failure") {
      continue;
    }
    const attempt = attemptsById.get(cell.selectedAttemptId);
    if (attempt === undefined) {
      throw new Error(`Scored cell ${cell.cellId} lacks its selected attempt`);
    }
    const finished = await options.repository.getAttemptFinishedV3(
      options.suite.definitionId,
      options.executionId,
      cell.cellId,
      attempt.ordinal,
      attempt.attemptId,
    );
    if (finished === null || finished.rawManifest === null) {
      throw new Error(`Scored cell ${cell.cellId} lacks its raw manifest`);
    }
    proofs.push(
      benchmarkCellScoringProofFromRawManifestV3(
        BenchmarkRawAttemptManifestV3Schema.parse(finished.rawManifest),
      ),
    );
  }
  return proofs;
};

const outcomeFor = (
  result: FormalBenchmarkAttemptResultV3,
): BenchmarkCellAttemptV3["outcome"] => {
  switch (result.status) {
    case "completed":
      return {
        status: "completed",
        rawManifestHash: contentHash(result.rawManifest),
      };
    case "diagnostic_failure":
      return {
        status: "diagnostic_failure",
        code: result.code,
        message: "Terminal diagnostic failure",
        rawManifestHash: contentHash(result.rawManifest),
      };
    case "infra_failure":
      return {
        status: "infra_failure",
        failure: result.failure,
        message: "Infrastructure failure",
        retryable: result.retryable,
      };
    case "invalid":
      return {
        status: "invalid",
        code: result.code,
        infrastructureFailure: result.infrastructureFailure,
        message: "Invalid formal attempt",
        retryable: false,
      };
  }
};

const completionFor = (
  started: ReturnType<typeof BenchmarkAttemptStartedV3Schema.parse>,
  result: FormalBenchmarkAttemptResultV3,
  attempts: readonly BenchmarkCellAttemptV3[],
  suite: BenchmarkSuiteSpecV3,
  executionId: BenchmarkExecutionId,
  cell: FormalBenchmarkCellV3,
  finishedAt: string,
): ReturnType<typeof BenchmarkAttemptFinishedV3Schema.parse> => {
  const basis = {
    ...started,
    finishedAt,
    progress: result.progress,
    metrics: result.metrics,
    outcome: outcomeFor(result),
  } as const;
  const attempt = BenchmarkCellAttemptV3Schema.parse({
    ...basis,
    attemptHash: benchmarkAttemptHashV3(basis),
  });
  const chain = [...attempts, attempt];
  const terminalCell = terminalCellFor(suite, executionId, cell, chain, result);
  return BenchmarkAttemptFinishedV3Schema.parse({
    schemaVersion: 3,
    attempt,
    terminalCell,
    rawManifest:
      result.status === "completed" || result.status === "diagnostic_failure"
        ? result.rawManifest
        : null,
  });
};

async function recoverUnfinishedAttempt(
  options: ExecuteFormalBenchmarkV3Options,
  cell: FormalBenchmarkCellV3,
  started: ReturnType<typeof BenchmarkAttemptStartedV3Schema.parse>,
  attempts: readonly BenchmarkCellAttemptV3[],
): Promise<ReturnType<typeof BenchmarkAttemptFinishedV3Schema.parse>> {
  const journal = assertBenchmarkAttemptProgressSequenceV3(
    await options.repository.getAttemptProgressV3(
      options.suite.definitionId,
      options.executionId,
      cell.cellId,
      started.ordinal,
      started.attemptId,
    ),
  );
  const latest = journal.at(-1);
  const recoveredAt = options.nowIso();
  if (latest !== undefined) {
    const record =
      typeof latest.rawManifest === "object" &&
      latest.rawManifest !== null &&
      !Array.isArray(latest.rawManifest)
        ? latest.rawManifest
        : null;
    const claimsTerminal =
      record?.["manifestKind"] === "benchmark_attempt_terminal";
    const parsed = BenchmarkRawAttemptManifestV3Schema.safeParse(
      latest.rawManifest,
    );
    if (parsed.success) {
      try {
        const manifest = parsed.data;
        const provisional: FormalBenchmarkAttemptResultV3 =
          manifest.terminalStatus === "completed"
            ? {
                status: "completed",
                rawManifest: manifest as unknown as JsonValue,
                score: diagnosticFailureScoreV3(cell.expectedMechanism),
                progress: latest.progress,
                metrics: latest.metrics,
              }
            : {
                status: "diagnostic_failure",
                code: manifest.diagnosticCode,
                message: "Recovered terminal diagnostic failure",
                rawManifest: manifest as unknown as JsonValue,
                progress: latest.progress,
                metrics: latest.metrics,
              };
        const provisionalCompletion = completionFor(
          started,
          provisional,
          attempts,
          options.suite,
          options.executionId,
          cell,
          recoveredAt,
        );
        const verified = assertBenchmarkRawAttemptManifestV3Integrity({
          suite: options.suite,
          attempt: provisionalCompletion.attempt,
          manifest,
        });
        const reconstructed: FormalBenchmarkAttemptResultV3 =
          provisional.status === "completed"
            ? { ...provisional, score: verified.score }
            : provisional;
        const completion = completionFor(
          started,
          reconstructed,
          attempts,
          options.suite,
          options.executionId,
          cell,
          recoveredAt,
        );
        assertBenchmarkAttemptBudgetsV3(options.suite, completion.attempt);
        return completion;
      } catch {
        // A terminal marker is authoritative only after full lineage and score
        // verification. The invalid branch below preserves the observations.
      }
    }
    if (claimsTerminal) {
      const result: FormalBenchmarkAttemptResultV3 = {
        status: "invalid",
        code: "harness_failure",
        infrastructureFailure: null,
        message: "Persisted terminal manifest failed integrity validation",
        progress: latest.progress,
        metrics: latest.metrics,
      };
      const terminalProgress = BenchmarkAttemptProgressV3Schema.parse({
        schemaVersion: 3,
        suiteId: options.suite.suiteId,
        definitionId: options.suite.definitionId,
        executionId: options.executionId,
        cellId: cell.cellId,
        attemptId: started.attemptId,
        ordinal: started.ordinal,
        sequence: latest.sequence + 1,
        observedAt: recoveredAt,
        progress: result.progress,
        metrics: result.metrics,
        rawManifest: terminalProgressManifestV3(result),
      });
      assertBenchmarkAttemptProgressSequenceV3([...journal, terminalProgress]);
      await options.repository.putAttemptProgressV3(terminalProgress);
      return completionFor(
        started,
        result,
        attempts,
        options.suite,
        options.executionId,
        cell,
        recoveredAt,
      );
    }
  }
  const result: FormalBenchmarkAttemptResultV3 =
    latest?.progress.fixtureStage === "baseline_captured" &&
    latest.progress.model.requestStarted === false
      ? {
          status: "invalid",
          code: "harness_failure",
          infrastructureFailure: null,
          message: "Fixture material was not validated before interruption",
          progress: latest.progress,
          metrics: latest.metrics,
        }
      : processInterruption(
          latest?.progress ?? emptyFormalProgressV3(),
          latest?.metrics ?? zeroFormalMetricsV3(),
        );
  const observedAt = recoveredAt;
  const terminalProgress = BenchmarkAttemptProgressV3Schema.parse({
    schemaVersion: 3,
    suiteId: options.suite.suiteId,
    definitionId: options.suite.definitionId,
    executionId: options.executionId,
    cellId: cell.cellId,
    attemptId: started.attemptId,
    ordinal: started.ordinal,
    sequence: (latest?.sequence ?? 0) + 1,
    observedAt,
    progress: result.progress,
    metrics: result.metrics,
    rawManifest: terminalProgressManifestV3(result),
  });
  assertBenchmarkAttemptProgressSequenceV3([...journal, terminalProgress]);
  await options.repository.putAttemptProgressV3(terminalProgress);
  return completionFor(
    started,
    result,
    attempts,
    options.suite,
    options.executionId,
    cell,
    observedAt,
  );
}

async function processCell(
  options: ExecuteFormalBenchmarkV3Options,
  cell: FormalBenchmarkCellV3,
): Promise<ProcessCellResult> {
  const existingCell = await options.repository.getCellV3(
    options.suite.definitionId,
    options.executionId,
    cell.cellId,
  );
  const attempts: BenchmarkCellAttemptV3[] = [];
  let previousAttemptHash: string | null = null;
  let firstUnusedOrdinal = 1;

  for (let ordinal = 1; ordinal <= ABSOLUTE_ATTEMPT_LIMIT; ordinal += 1) {
    const attemptId = benchmarkAttemptIdV3(
      options.executionId,
      cell.cellId,
      ordinal,
    );
    const started = await options.repository.getAttemptStartedV3(
      options.suite.definitionId,
      options.executionId,
      cell.cellId,
      ordinal,
      attemptId,
    );
    const finished = await options.repository.getAttemptFinishedV3(
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
      (await recoverUnfinishedAttempt(options, cell, started, attempts));
    if (finished === null) {
      await options.repository.putAttemptFinishedV3(completion);
      if (completion.terminalCell !== null) {
        await options.repository.putCellV3(completion.terminalCell);
      }
    } else {
      assertAttemptMatchesStart(started, completion.attempt);
    }
    attempts.push(completion.attempt);
    if (completion.terminalCell !== null) {
      if (existingCell === null) {
        await options.repository.putCellV3(completion.terminalCell);
      } else if (
        contentHash(existingCell) !== contentHash(completion.terminalCell)
      ) {
        throw new Error("Persisted terminal cell contradicts its attempt");
      }
      return { cell: completion.terminalCell, attempts };
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
    const attemptId = benchmarkAttemptIdV3(
      options.executionId,
      cell.cellId,
      ordinal,
    );
    const started = BenchmarkAttemptStartedV3Schema.parse({
      schemaVersion: 3,
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
    await options.repository.putAttemptStartedV3(started);
    let latestProgress: FormalAttemptProgressSnapshotV3 | undefined;
    let result: FormalBenchmarkAttemptResultV3;
    const journal: ReturnType<typeof BenchmarkAttemptProgressV3Schema.parse>[] =
      [];
    try {
      result = await options.runAttempt(cell, ordinal, async (snapshot) => {
        assertExactProgressMetricsV3(snapshot.progress, snapshot.metrics);
        const progress = BenchmarkAttemptProgressV3Schema.parse({
          schemaVersion: 3,
          suiteId: options.suite.suiteId,
          definitionId: options.suite.definitionId,
          executionId: options.executionId,
          cellId: cell.cellId,
          attemptId,
          ordinal,
          sequence: journal.length + 1,
          observedAt: snapshot.observedAt,
          progress: snapshot.progress,
          metrics: snapshot.metrics,
          rawManifest: snapshot.rawManifest,
        });
        assertBenchmarkAttemptProgressSequenceV3([...journal, progress]);
        journal.push(progress);
        await options.repository.putAttemptProgressV3(progress);
        latestProgress = {
          observedAt: progress.observedAt,
          progress: progress.progress,
          metrics: progress.metrics,
          rawManifest: progress.rawManifest,
        };
      });
    } catch {
      result = {
        status: "invalid",
        code: "harness_failure",
        infrastructureFailure: null,
        message: "Invalid formal attempt",
        progress: latestProgress?.progress ?? emptyFormalProgressV3(),
        metrics: latestProgress?.metrics ?? zeroFormalMetricsV3(),
      };
    }
    try {
      assertExactProgressMetricsV3(result.progress, result.metrics);
      const proposedFinal = BenchmarkAttemptProgressV3Schema.parse({
        schemaVersion: 3,
        suiteId: options.suite.suiteId,
        definitionId: options.suite.definitionId,
        executionId: options.executionId,
        cellId: cell.cellId,
        attemptId,
        ordinal,
        sequence: journal.length + 1,
        observedAt: options.nowIso(),
        progress: result.progress,
        metrics: result.metrics,
        rawManifest: terminalProgressManifestV3(result),
      });
      assertBenchmarkAttemptProgressSequenceV3([...journal, proposedFinal]);
    } catch {
      result = {
        status: "invalid",
        code: "harness_failure",
        infrastructureFailure: null,
        message: "Invalid formal attempt observations",
        progress: latestProgress?.progress ?? emptyFormalProgressV3(),
        metrics: latestProgress?.metrics ?? zeroFormalMetricsV3(),
      };
    }
    const finishedAt = options.nowIso();
    let completion: ReturnType<typeof BenchmarkAttemptFinishedV3Schema.parse>;
    try {
      completion = completionFor(
        started,
        result,
        attempts,
        options.suite,
        options.executionId,
        cell,
        finishedAt,
      );
      assertBenchmarkAttemptBudgetsV3(options.suite, completion.attempt);
      if (
        result.status === "completed" ||
        result.status === "diagnostic_failure"
      ) {
        const verified = assertBenchmarkRawAttemptManifestV3Integrity({
          suite: options.suite,
          attempt: completion.attempt,
          manifest: result.rawManifest,
        });
        if (
          completion.terminalCell?.score === null ||
          completion.terminalCell?.score === undefined ||
          contentHash(completion.terminalCell.score) !==
            contentHash(verified.score) ||
          (result.status === "completed" &&
            contentHash(result.score) !== contentHash(verified.score))
        ) {
          throw new Error(
            "Terminal cell score does not match its verified raw manifest",
          );
        }
      }
    } catch {
      result = {
        status: "invalid",
        code: "harness_failure",
        infrastructureFailure: null,
        message: "Invalid formal attempt",
        progress: result.progress,
        metrics: result.metrics,
      };
      completion = completionFor(
        started,
        result,
        attempts,
        options.suite,
        options.executionId,
        cell,
        finishedAt,
      );
      assertBenchmarkAttemptBudgetsV3(options.suite, completion.attempt);
    }
    const finalSnapshot = BenchmarkAttemptProgressV3Schema.parse({
      schemaVersion: 3,
      suiteId: options.suite.suiteId,
      definitionId: options.suite.definitionId,
      executionId: options.executionId,
      cellId: cell.cellId,
      attemptId,
      ordinal,
      sequence: journal.length + 1,
      observedAt: finishedAt,
      progress: result.progress,
      metrics: result.metrics,
      rawManifest: terminalProgressManifestV3(result),
    });
    assertBenchmarkAttemptProgressSequenceV3([...journal, finalSnapshot]);
    await options.repository.putAttemptProgressV3(finalSnapshot);
    await options.repository.putAttemptFinishedV3(completion);
    attempts.push(completion.attempt);
    if (completion.terminalCell !== null) {
      await options.repository.putCellV3(completion.terminalCell);
      return { cell: completion.terminalCell, attempts };
    }
    previousAttemptHash = completion.attempt.attemptHash;
  }
  return { cell: null, attempts };
}

export async function executeFormalBenchmarkV3(
  options: ExecuteFormalBenchmarkV3Options,
): Promise<ExecuteFormalBenchmarkV3Result> {
  const selectionHash = benchmarkExecutionSelectionHashV3(
    options.suite.definitionId,
    options.executionId,
  );
  const completed = await options.repository.getCompletedV3(
    options.suite.definitionId,
    options.executionId,
  );
  if (completed !== null) {
    const selection = await options.repository.getExecutionSelectionV3(
      options.suite.definitionId,
    );
    if (
      selection === null ||
      selection.suiteId !== options.suite.suiteId ||
      selection.executionId !== options.executionId ||
      selection.selectionHash !== selectionHash
    ) {
      throw new Error("Completed report lacks its first-execution selection");
    }
    const verification = verifyBenchmarkReportV3(completed);
    if (!verification.valid) {
      throw new Error("Persisted V3 benchmark failed integrity verification");
    }
    if (completed.auditIssues.length === 0) {
      await options.validateBeforePersist?.(completed);
    }
    return { report: completed, recoverable: false, resumed: true };
  }

  await options.repository.putDefinitionV3(options.suite);
  const selectionRecord = BenchmarkExecutionSelectionV3Schema.parse({
    schemaVersion: 3,
    suiteId: options.suite.suiteId,
    definitionId: options.suite.definitionId,
    executionId: options.executionId,
    selectionHash,
  });
  const priorSelection = await options.repository.getExecutionSelectionV3(
    options.suite.definitionId,
  );
  if (options.allowRecoveryCycle) {
    if (priorSelection === null) {
      throw new Error("Recovery requires an existing formal selection");
    }
  } else {
    await options.repository.putExecutionSelectionV3(selectionRecord);
  }
  const persistedSelection =
    priorSelection ??
    (await options.repository.getExecutionSelectionV3(
      options.suite.definitionId,
    ));
  if (
    persistedSelection === null ||
    persistedSelection.suiteId !== options.suite.suiteId ||
    persistedSelection.executionId !== options.executionId ||
    persistedSelection.selectionHash !== selectionHash
  ) {
    throw new Error("Formal V3 selection does not match this execution");
  }
  await options.onExecutionSelected?.(options.executionId);

  const priorStart = await options.repository.getExecutionStartedV3(
    options.suite.definitionId,
    options.executionId,
  );
  const opensRecoveryAttempts =
    options.allowRecoveryCycle && priorStart !== null;
  const start =
    priorStart ??
    BenchmarkExecutionStartedV3Schema.parse({
      schemaVersion: 3,
      suiteId: options.suite.suiteId,
      definitionId: options.suite.definitionId,
      executionId: options.executionId,
      selectionHash,
      startedAt: options.nowIso(),
      provenance: options.provenance,
    });
  if (priorStart === null) {
    await options.repository.putExecutionStartedV3(start);
  } else if (
    priorStart.suiteId !== options.suite.suiteId ||
    priorStart.selectionHash !== selectionHash ||
    JSON.stringify(priorStart.provenance) !== JSON.stringify(options.provenance)
  ) {
    throw new Error("Resume provenance does not match frozen V3 execution");
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
      options.suite.fixtures.length *
        options.suite.arms.length *
        options.suite.repetitions;
  const scoringProofs = await scoringProofsFor(options, cells, attempts);
  let report = buildBenchmarkReportV3({
    suite: options.suite,
    executionId: options.executionId,
    startedAt: start.startedAt,
    finishedAt: options.nowIso(),
    provenance: start.provenance,
    attempts,
    cells,
    scoringProofs,
  });
  if (!recoverable) {
    try {
      await options.validateBeforePersist?.(report);
    } catch {
      report = buildBenchmarkReportV3({
        suite: options.suite,
        executionId: options.executionId,
        startedAt: start.startedAt,
        finishedAt: report.finishedAt,
        provenance: start.provenance,
        attempts,
        cells,
        scoringProofs,
        auditIssues: ["prompt_fairness_failed"],
      });
    }
    await options.repository.putCompletedV3(report);
  }
  return { report, recoverable, resumed: priorStart !== null };
}
