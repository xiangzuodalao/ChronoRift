import { createHash } from "node:crypto";

import {
  BenchmarkCellAttemptV2Schema,
  BenchmarkCellResultV2Schema,
  BenchmarkCellScoreV2Schema,
  BenchmarkReportV2Schema,
  BenchmarkSuiteSpecV2Schema,
  asBenchmarkAttemptId,
  asBenchmarkCellId,
  asBenchmarkDefinitionId,
  asBenchmarkSuiteId,
  type BenchmarkAggregateV2,
  type BenchmarkArmAggregateV2,
  type BenchmarkArmV1,
  type BenchmarkCellAttemptV2,
  type BenchmarkAttemptId,
  type BenchmarkCellId,
  type BenchmarkCellResultV2,
  type BenchmarkCellScoreV2,
  type BenchmarkFixtureSpecV2,
  type BenchmarkGateEvaluationV2,
  type BenchmarkReportV2,
  type BenchmarkExecutionId,
  type BenchmarkSuiteSpecV2,
  type EvidenceAccessReceiptId,
  type ExecutionId,
  type FixtureId,
  type JsonValue,
  type MechanismCodeV2,
  type ProposalId,
} from "@chronorift/domain";

import { canonicalStringify } from "./canonical.js";

const digest = (value: JsonValue): string =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex");

const textDigest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

type CreateBenchmarkSuiteSpecV2Base = Omit<
  BenchmarkSuiteSpecV2,
  "suiteId" | "definitionId" | "suiteHash" | "fixtures"
>;

export interface CreateBenchmarkSuiteSpecV2Input extends CreateBenchmarkSuiteSpecV2Base {
  readonly fixtures: readonly BenchmarkFixtureSpecV2[];
}

const suiteHashBasis = (input: CreateBenchmarkSuiteSpecV2Input): JsonValue => {
  const { subjectHash, runnerHash, ...basis } = input;
  void subjectHash;
  void runnerHash;
  return { ...basis, fixtures: [...input.fixtures] } as unknown as JsonValue;
};

export function createBenchmarkSuiteSpecV2(
  input: CreateBenchmarkSuiteSpecV2Input,
): BenchmarkSuiteSpecV2 {
  const suiteHash = digest(suiteHashBasis(input));
  const suiteId = asBenchmarkSuiteId(`benchmark-suite:${suiteHash}`);
  const definitionId = asBenchmarkDefinitionId(
    `benchmark-definition:${digest({
      suiteHash,
      subjectHash: input.subjectHash,
      runnerHash: input.runnerHash,
    })}`,
  );
  return BenchmarkSuiteSpecV2Schema.parse({
    ...input,
    suiteId,
    definitionId,
    suiteHash,
  });
}

export function assertBenchmarkSuiteSpecV2Integrity(
  input: BenchmarkSuiteSpecV2,
): BenchmarkSuiteSpecV2 {
  const spec = BenchmarkSuiteSpecV2Schema.parse(input);
  const { suiteId, definitionId, suiteHash, ...basis } = spec;
  void suiteId;
  void definitionId;
  void suiteHash;
  const expected = createBenchmarkSuiteSpecV2(basis);
  if (
    expected.suiteId !== spec.suiteId ||
    expected.suiteHash !== spec.suiteHash ||
    expected.definitionId !== spec.definitionId
  ) {
    throw new Error("Benchmark suite hash or definition ID is invalid");
  }
  return spec;
}

export function benchmarkCellIdV2(
  specInput: BenchmarkSuiteSpecV2,
  fixtureId: FixtureId,
  arm: BenchmarkArmV1,
  repetition: number,
): BenchmarkCellId {
  const spec = BenchmarkSuiteSpecV2Schema.parse(specInput);
  if (!spec.fixtures.some((fixture) => fixture.fixtureId === fixtureId)) {
    throw new Error("Benchmark cell Fixture is not in the suite");
  }
  if (!spec.arms.includes(arm)) {
    throw new Error("Benchmark cell arm is not in the suite");
  }
  if (!Number.isInteger(repetition) || repetition < 1 || repetition > 3) {
    throw new Error("Benchmark cell repetition is outside the suite");
  }
  return asBenchmarkCellId(
    `benchmark-cell:${digest({
      definitionId: spec.definitionId,
      fixtureId,
      arm,
      repetition,
    })}`,
  );
}

export interface BenchmarkOrderedCellV2 {
  readonly cellId: BenchmarkCellId;
  readonly fixtureId: FixtureId;
  readonly arm: BenchmarkArmV1;
  readonly repetition: number;
}

/**
 * Recomputes the frozen block-randomized execution schedule. Fixture/repetition
 * blocks remain contiguous, and arm order is randomized within each block.
 */
export function benchmarkCellOrderV2(
  specInput: BenchmarkSuiteSpecV2,
): readonly BenchmarkOrderedCellV2[] {
  const spec = assertBenchmarkSuiteSpecV2Integrity(specInput);
  const blocks = spec.fixtures.flatMap((fixture) =>
    Array.from({ length: spec.repetitions }, (_, index) => ({
      fixtureId: fixture.fixtureId,
      repetition: index + 1,
    })),
  );
  blocks.sort((left, right) =>
    textDigest(
      `${spec.orderSeed}\0block\0${left.fixtureId}\0${left.repetition}`,
    ).localeCompare(
      textDigest(
        `${spec.orderSeed}\0block\0${right.fixtureId}\0${right.repetition}`,
      ),
    ),
  );
  return blocks.flatMap((block) =>
    [...spec.arms]
      .sort((left, right) =>
        textDigest(
          `${spec.orderSeed}\0arm\0${block.fixtureId}\0${block.repetition}\0${left}`,
        ).localeCompare(
          textDigest(
            `${spec.orderSeed}\0arm\0${block.fixtureId}\0${block.repetition}\0${right}`,
          ),
        ),
      )
      .map((arm) => ({
        cellId: benchmarkCellIdV2(spec, block.fixtureId, arm, block.repetition),
        fixtureId: block.fixtureId,
        arm,
        repetition: block.repetition,
      })),
  );
}

export function benchmarkAttemptHashV2(
  input: Omit<BenchmarkCellAttemptV2, "attemptHash">,
): string {
  return digest(input);
}

export function benchmarkAttemptIdV2(
  executionId: BenchmarkExecutionId,
  cellId: BenchmarkCellId,
  ordinal: number,
): BenchmarkAttemptId {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 6) {
    throw new Error("Benchmark attempt ordinal is outside the absolute budget");
  }
  return asBenchmarkAttemptId(
    `benchmark-attempt:${digest({ executionId, cellId, ordinal })}`,
  );
}

export function benchmarkExecutionSelectionHashV2(
  definitionId: BenchmarkSuiteSpecV2["definitionId"],
  executionId: BenchmarkExecutionId,
): string {
  return digest({
    policy: "first-formal-execution-wins-v1",
    definitionId,
    executionId,
  });
}

export interface ScoreBenchmarkDiagnosisV2Input {
  readonly proposalId: ProposalId | null;
  readonly candidateExecutionIds: readonly ExecutionId[];
  readonly accessReceiptIds: readonly EvidenceAccessReceiptId[];
  readonly expectedMechanism: Exclude<MechanismCodeV2, "unknown">;
  readonly proposedMechanism: MechanismCodeV2;
  readonly verdict: "confirmed" | "inconclusive";
  readonly sourceLocationCorrect: boolean | null;
  readonly sourceGrounded: boolean;
  readonly confidence: number | null;
}

/** Recomputes all score fields controlled by the Harness, never by confidence. */
export function scoreBenchmarkDiagnosisV2(
  input: ScoreBenchmarkDiagnosisV2Input,
): BenchmarkCellScoreV2 {
  const mechanismCorrect = input.expectedMechanism === input.proposedMechanism;
  return BenchmarkCellScoreV2Schema.parse({
    proposalId: input.proposalId,
    candidateExecutionIds: [...input.candidateExecutionIds],
    accessReceiptIds: [...input.accessReceiptIds],
    proposedMechanism: input.proposedMechanism,
    mechanismCorrect,
    verdict: input.verdict,
    groundedSuccess: mechanismCorrect && input.verdict === "confirmed",
    incorrectConfirmation: !mechanismCorrect && input.verdict === "confirmed",
    sourceLocationCorrect: input.sourceLocationCorrect,
    sourceGrounded: input.sourceGrounded,
    confidence: input.confidence,
  });
}

export interface BuildBenchmarkReportV2Options {
  readonly suite: BenchmarkSuiteSpecV2;
  readonly executionId: BenchmarkReportV2["executionId"];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly provenance: BenchmarkReportV2["provenance"];
  readonly attempts: readonly BenchmarkCellAttemptV2[];
  readonly cells: readonly BenchmarkCellResultV2[];
  readonly auditIssues?: readonly "prompt_fairness_failed"[] | undefined;
}

export type BenchmarkReportHashBasisV2 = Omit<BenchmarkReportV2, "reportHash">;

export function benchmarkReportHashV2(
  input: BenchmarkReportHashBasisV2,
): string {
  return digest(input as unknown as JsonValue);
}

interface ExpectedCell {
  readonly fixtureId: FixtureId;
  readonly arm: BenchmarkArmV1;
  readonly repetition: number;
  readonly expectedMechanism: Exclude<MechanismCodeV2, "unknown">;
}

const expectedCells = (
  suite: BenchmarkSuiteSpecV2,
): ReadonlyMap<BenchmarkCellId, ExpectedCell> => {
  const cells = new Map<BenchmarkCellId, ExpectedCell>();
  for (const fixture of suite.fixtures) {
    for (let repetition = 1; repetition <= suite.repetitions; repetition += 1) {
      for (const arm of suite.arms) {
        const cellId = benchmarkCellIdV2(
          suite,
          fixture.fixtureId,
          arm,
          repetition,
        );
        cells.set(cellId, {
          fixtureId: fixture.fixtureId,
          arm,
          repetition,
          expectedMechanism: fixture.expectedMechanism,
        });
      }
    }
  }
  return cells;
};

const assertEntryProvenance = (
  suite: BenchmarkSuiteSpecV2,
  executionId: BenchmarkReportV2["executionId"],
  entry: BenchmarkCellAttemptV2 | BenchmarkCellResultV2,
): void => {
  if (
    entry.suiteId !== suite.suiteId ||
    entry.definitionId !== suite.definitionId ||
    entry.executionId !== executionId
  ) {
    throw new Error("Benchmark entry provenance does not match the execution");
  }
};

const assertAttempts = (
  suite: BenchmarkSuiteSpecV2,
  executionId: BenchmarkReportV2["executionId"],
  attemptsInput: readonly BenchmarkCellAttemptV2[],
  expected: ReadonlyMap<BenchmarkCellId, ExpectedCell>,
): ReadonlyMap<BenchmarkCellId, readonly BenchmarkCellAttemptV2[]> => {
  const attemptsByCell = new Map<BenchmarkCellId, BenchmarkCellAttemptV2[]>();
  const attemptIds = new Set<string>();
  let previousFinishedAt: number | null = null;
  for (const input of attemptsInput) {
    const attempt = BenchmarkCellAttemptV2Schema.parse(input);
    const startedAt = Date.parse(attempt.startedAt);
    if (previousFinishedAt !== null && startedAt < previousFinishedAt) {
      throw new Error(
        "Benchmark attempts must be globally serial and non-overlapping",
      );
    }
    previousFinishedAt = Date.parse(attempt.finishedAt);
    assertEntryProvenance(suite, executionId, attempt);
    if (attemptIds.has(attempt.attemptId)) {
      throw new Error("Benchmark attempt IDs must be unique");
    }
    attemptIds.add(attempt.attemptId);
    const cell = expected.get(attempt.cellId);
    if (
      cell === undefined ||
      cell.fixtureId !== attempt.fixtureId ||
      cell.arm !== attempt.arm ||
      cell.repetition !== attempt.repetition
    ) {
      throw new Error("Benchmark attempt does not match its canonical cell");
    }
    if (
      attempt.ordinal > suite.retryPolicy.maxAttemptsPerCell ||
      attempt.attemptId !==
        benchmarkAttemptIdV2(executionId, attempt.cellId, attempt.ordinal)
    ) {
      throw new Error("Benchmark attempt ID or ordinal is not canonical");
    }
    const expectedKind =
      attempt.ordinal === 1
        ? "initial"
        : attempt.ordinal === 4
          ? "recovery"
          : "infra_retry";
    if (attempt.kind !== expectedKind) {
      throw new Error("Benchmark attempt kind is not canonical");
    }
    const { attemptHash, ...hashBasis } = attempt;
    void attemptHash;
    if (benchmarkAttemptHashV2(hashBasis) !== attempt.attemptHash) {
      throw new Error("Benchmark attempt hash is invalid");
    }
    const chain = attemptsByCell.get(attempt.cellId) ?? [];
    chain.push(attempt);
    attemptsByCell.set(attempt.cellId, chain);
  }

  for (const chain of attemptsByCell.values()) {
    chain.sort((left, right) => left.ordinal - right.ordinal);
    if (chain.length > suite.retryPolicy.maxAttemptsPerCell) {
      throw new Error("Benchmark cell exceeded its absolute attempt budget");
    }
    for (const [index, attempt] of chain.entries()) {
      if (attempt.ordinal !== index + 1) {
        throw new Error("Benchmark attempt ordinals must be contiguous");
      }
      const previous = chain[index - 1];
      if ((previous?.attemptHash ?? null) !== attempt.previousAttemptHash) {
        throw new Error("Benchmark attempt hash chain is broken");
      }
      if (
        previous !== undefined &&
        previous.outcome.status !== "infra_failure" &&
        previous.outcome.status !== "interrupted"
      ) {
        throw new Error("Benchmark attempt follows a terminal outcome");
      }
    }
  }

  const canonicalOrder = benchmarkCellOrderV2(suite);
  const canonicalIndex = new Map(
    canonicalOrder.map((cell, index) => [cell.cellId, index] as const),
  );
  const scheduleSorted = [...attemptsInput].sort((left, right) => {
    const leftPhase = left.ordinal <= 3 ? 0 : 1;
    const rightPhase = right.ordinal <= 3 ? 0 : 1;
    if (leftPhase !== rightPhase) return leftPhase - rightPhase;
    const cellDifference =
      (canonicalIndex.get(left.cellId) ?? Number.MAX_SAFE_INTEGER) -
      (canonicalIndex.get(right.cellId) ?? Number.MAX_SAFE_INTEGER);
    return cellDifference === 0 ? left.ordinal - right.ordinal : cellDifference;
  });
  if (
    scheduleSorted.some(
      (attempt, index) => attempt.attemptId !== attemptsInput[index]?.attemptId,
    )
  ) {
    throw new Error(
      "Benchmark attempts do not follow the frozen global schedule",
    );
  }
  const initialCellIds = attemptsInput
    .filter((attempt) => attempt.ordinal <= 3)
    .map((attempt) => attempt.cellId)
    .filter((cellId, index, values) => values.indexOf(cellId) === index);
  if (
    initialCellIds.some(
      (cellId, index) => cellId !== canonicalOrder[index]?.cellId,
    )
  ) {
    throw new Error(
      "Initial benchmark cells must be a canonical schedule prefix",
    );
  }
  if (
    attemptsInput.some((attempt) => attempt.ordinal >= 4) &&
    initialCellIds.length !== canonicalOrder.length
  ) {
    throw new Error("Recovery attempts require a complete initial schedule");
  }
  return attemptsByCell;
};

const assertCells = (
  suite: BenchmarkSuiteSpecV2,
  executionId: BenchmarkReportV2["executionId"],
  cellsInput: readonly BenchmarkCellResultV2[],
  expected: ReadonlyMap<BenchmarkCellId, ExpectedCell>,
  attemptsByCell: ReadonlyMap<
    BenchmarkCellId,
    readonly BenchmarkCellAttemptV2[]
  >,
): readonly BenchmarkCellResultV2[] => {
  const cells = cellsInput.map((input) =>
    BenchmarkCellResultV2Schema.parse(input),
  );
  const actualCellIds = cells.map((cell) => cell.cellId);
  const actualCellIdSet = new Set(actualCellIds);
  const expectedCellIds = benchmarkCellOrderV2(suite)
    .map((cell) => cell.cellId)
    .filter((cellId) => actualCellIdSet.has(cellId));
  if (
    expectedCellIds.some((cellId, index) => cellId !== actualCellIds[index])
  ) {
    throw new Error(
      "Benchmark results do not follow the frozen global schedule",
    );
  }
  const ids = new Set<string>();
  for (const cell of cells) {
    assertEntryProvenance(suite, executionId, cell);
    if (ids.has(cell.cellId)) {
      throw new Error("Benchmark cell IDs must be unique");
    }
    ids.add(cell.cellId);
    const canonical = expected.get(cell.cellId);
    if (
      canonical === undefined ||
      canonical.fixtureId !== cell.fixtureId ||
      canonical.arm !== cell.arm ||
      canonical.repetition !== cell.repetition ||
      canonical.expectedMechanism !== cell.expectedMechanism
    ) {
      throw new Error("Benchmark result does not match its canonical cell");
    }
    const chain = attemptsByCell.get(cell.cellId) ?? [];
    if (
      chain.length !== cell.attemptIds.length ||
      chain.some(
        (attempt, index) => attempt.attemptId !== cell.attemptIds[index],
      ) ||
      chain.at(-1)?.attemptId !== cell.selectedAttemptId
    ) {
      throw new Error(
        "Benchmark result does not reference its exact attempt chain",
      );
    }
    const selected = chain.at(-1);
    const selectedMatchesCellStatus =
      (cell.status === "scored" && selected?.outcome.status === "completed") ||
      (cell.status === "diagnostic_failure" &&
        selected?.outcome.status === "diagnostic_failure") ||
      (cell.status === "infra_exhausted" &&
        (selected?.outcome.status === "infra_failure" ||
          selected?.outcome.status === "interrupted")) ||
      (cell.status === "invalid" && selected?.outcome.status === "invalid");
    if (!selectedMatchesCellStatus) {
      throw new Error(
        "Benchmark cell status does not match its terminal attempt",
      );
    }
    if (
      selected?.outcome.status === "completed" ||
      selected?.outcome.status === "diagnostic_failure"
    ) {
      if (selected.outcome.rawManifestHash !== cell.rawManifestHash) {
        throw new Error(
          "Benchmark result manifest is not its selected attempt",
        );
      }
      if (
        canonicalStringify(cell.metrics) !==
        canonicalStringify(selected.metrics)
      ) {
        throw new Error(
          "Benchmark result metrics are not its selected attempt metrics",
        );
      }
    }
  }
  return cells;
};

const sum = <T>(values: readonly T[], select: (value: T) => number): number =>
  values.reduce((total, value) => total + select(value), 0);

const aggregateArm = (
  cells: readonly BenchmarkCellResultV2[],
  attempts: readonly BenchmarkCellAttemptV2[],
): BenchmarkArmAggregateV2 => {
  const scores = cells.flatMap((cell) =>
    cell.score === null ? [] : [cell.score],
  );
  const groundedSuccesses = scores.filter(
    (score) => score.groundedSuccess,
  ).length;
  const mechanismCorrect = scores.filter(
    (score) => score.mechanismCorrect,
  ).length;
  const sourceScores = scores.filter(
    (score) => score.sourceLocationCorrect !== null,
  );
  return {
    expectedCells: cells.length,
    groundedSuccesses,
    groundedSuccessRate:
      cells.length === 0 ? 0 : groundedSuccesses / cells.length,
    mechanismCorrect,
    mechanismAccuracy: cells.length === 0 ? 0 : mechanismCorrect / cells.length,
    incorrectConfirmations: scores.filter(
      (score) => score.incorrectConfirmation,
    ).length,
    sourceCorrect: sourceScores.filter(
      (score) => score.sourceLocationCorrect === true,
    ).length,
    sourceAssessed: sourceScores.length,
    totalGameExecutions: sum(
      attempts,
      (attempt) => attempt.metrics.gameExecutions,
    ),
    totalToolCalls: sum(attempts, (attempt) => attempt.metrics.toolCalls),
    totalWallTimeMs: sum(attempts, (attempt) => attempt.metrics.wallTimeMs),
    totalTokens: sum(attempts, (attempt) => attempt.metrics.tokens.total),
  };
};

const aggregate = (
  suite: BenchmarkSuiteSpecV2,
  cells: readonly BenchmarkCellResultV2[],
  attempts: readonly BenchmarkCellAttemptV2[],
): BenchmarkAggregateV2 => {
  const generic = aggregateArm(
    cells.filter((cell) => cell.arm === "generic"),
    attempts.filter((attempt) => attempt.arm === "generic"),
  );
  const evidenceOnly = aggregateArm(
    cells.filter((cell) => cell.arm === "evidence-only"),
    attempts.filter((attempt) => attempt.arm === "evidence-only"),
  );
  const chronoriftFull = aggregateArm(
    cells.filter((cell) => cell.arm === "chronorift-full"),
    attempts.filter((attempt) => attempt.arm === "chronorift-full"),
  );
  const delta =
    chronoriftFull.groundedSuccessRate - generic.groundedSuccessRate;
  return {
    expectedCells: 36,
    scoredCells: cells.filter((cell) => cell.score !== null).length,
    byArm: { generic, evidenceOnly, chronoriftFull },
    advantage: {
      fullGroundedSuccesses: chronoriftFull.groundedSuccesses,
      fullGroundedSuccessRate: chronoriftFull.groundedSuccessRate,
      genericGroundedSuccessRate: generic.groundedSuccessRate,
      fullMinusGeneric: delta,
      fullIncorrectConfirmations: chronoriftFull.incorrectConfirmations,
      thresholdMet:
        chronoriftFull.groundedSuccesses >=
          suite.gate.fullRequiredGroundedSuccesses &&
        delta >= suite.gate.minimumFullMinusGeneric &&
        chronoriftFull.incorrectConfirmations <=
          suite.gate.fullMaximumIncorrectConfirmations,
    },
  };
};

export function buildBenchmarkReportV2(
  options: BuildBenchmarkReportV2Options,
): BenchmarkReportV2 {
  const suite = assertBenchmarkSuiteSpecV2Integrity(options.suite);
  const reportStartedAt = Date.parse(options.startedAt);
  const reportFinishedAt = Date.parse(options.finishedAt);
  if (
    !Number.isFinite(reportStartedAt) ||
    !Number.isFinite(reportFinishedAt) ||
    reportFinishedAt < reportStartedAt
  ) {
    throw new Error("Benchmark report time envelope is invalid");
  }
  const firstAttempt = options.attempts[0];
  const lastAttempt = options.attempts.at(-1);
  if (
    (firstAttempt !== undefined &&
      Date.parse(firstAttempt.startedAt) < reportStartedAt) ||
    (lastAttempt !== undefined &&
      Date.parse(lastAttempt.finishedAt) > reportFinishedAt)
  ) {
    throw new Error("Benchmark attempts fall outside the report time envelope");
  }
  const expected = expectedCells(suite);
  const attemptsByCell = assertAttempts(
    suite,
    options.executionId,
    options.attempts,
    expected,
  );
  const cells = assertCells(
    suite,
    options.executionId,
    options.cells,
    expected,
    attemptsByCell,
  );
  const hasInvalid =
    (options.auditIssues?.length ?? 0) > 0 ||
    cells.some((cell) => cell.status === "invalid") ||
    options.attempts.some((attempt) => attempt.outcome.status === "invalid");
  const hasIncomplete =
    cells.length !== expected.size ||
    cells.some((cell) => cell.status === "infra_exhausted");
  const status = hasInvalid
    ? "invalid"
    : hasIncomplete
      ? "incomplete"
      : "complete";
  const reportBasis: BenchmarkReportHashBasisV2 = {
    schemaVersion: 2,
    suite,
    executionId: options.executionId,
    selectionHash: benchmarkExecutionSelectionHashV2(
      suite.definitionId,
      options.executionId,
    ),
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    provenance: options.provenance,
    attempts: [...options.attempts],
    cells: [...cells],
    auditIssues: [...(options.auditIssues ?? [])],
    status,
    aggregate:
      status === "complete" ? aggregate(suite, cells, options.attempts) : null,
  };
  return BenchmarkReportV2Schema.parse({
    ...reportBasis,
    reportHash: benchmarkReportHashV2(reportBasis),
  });
}

export function evaluateBenchmarkGateV2(
  reportInput: BenchmarkReportV2,
): BenchmarkGateEvaluationV2 {
  const report = BenchmarkReportV2Schema.parse(reportInput);
  if (report.status !== "complete" || report.aggregate === null) {
    return {
      status: "not_evaluated",
      reasons: ["Benchmark execution is incomplete or invalid"],
    };
  }
  const reasons: string[] = [];
  const { advantage } = report.aggregate;
  if (
    advantage.fullGroundedSuccesses <
    report.suite.gate.fullRequiredGroundedSuccesses
  ) {
    reasons.push(
      `ChronoRift full grounded successes ${advantage.fullGroundedSuccesses}/12 are below 9/12`,
    );
  }
  if (advantage.fullMinusGeneric < report.suite.gate.minimumFullMinusGeneric) {
    reasons.push(
      `ChronoRift full minus generic is below ${report.suite.gate.minimumFullMinusGeneric}`,
    );
  }
  if (
    advantage.fullIncorrectConfirmations >
    report.suite.gate.fullMaximumIncorrectConfirmations
  ) {
    reasons.push("ChronoRift full emitted an incorrect confirmation");
  }
  return {
    status: reasons.length === 0 ? "pass" : "fail",
    reasons,
  };
}

export type BenchmarkReportVerificationV2 =
  | {
      readonly valid: true;
      readonly report: BenchmarkReportV2;
      readonly gate: BenchmarkGateEvaluationV2;
      readonly issues: readonly [];
    }
  | {
      readonly valid: false;
      readonly gate: BenchmarkGateEvaluationV2;
      readonly issues: readonly string[];
    };

/** Integrity verification; a valid negative report is still valid. */
export function verifyBenchmarkReportV2(
  input: unknown,
): BenchmarkReportVerificationV2 {
  try {
    const report = BenchmarkReportV2Schema.parse(input);
    const rebuilt = buildBenchmarkReportV2({
      suite: report.suite,
      executionId: report.executionId,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      provenance: report.provenance,
      attempts: report.attempts,
      cells: report.cells,
      auditIssues: report.auditIssues,
    });
    if (
      canonicalStringify(rebuilt as unknown as JsonValue) !==
      canonicalStringify(report as unknown as JsonValue)
    ) {
      throw new Error("Benchmark report fields do not match recomputation");
    }
    return {
      valid: true,
      report,
      gate: evaluateBenchmarkGateV2(report),
      issues: [],
    };
  } catch (error) {
    return {
      valid: false,
      gate: {
        status: "not_evaluated",
        reasons: ["Benchmark report integrity verification failed"],
      },
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}
