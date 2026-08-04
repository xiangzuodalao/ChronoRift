import {
  asBenchmarkAttemptId,
  asBenchmarkExecutionId,
  asBenchmarkSuiteId,
  asEvidenceAccessReceiptId,
  asExecutionId,
  asFixtureId,
  asProposalId,
  type BenchmarkArmV1,
  type BenchmarkCellAttemptV2,
  type BenchmarkCellResultV2,
  type BenchmarkSuiteSpecV2,
  type MechanismCodeV2,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import {
  benchmarkAttemptIdV2,
  benchmarkAttemptHashV2,
  benchmarkCellIdV2,
  benchmarkCellOrderV2,
  buildBenchmarkReportV2,
  createBenchmarkSuiteSpecV2,
  evaluateBenchmarkGateV2,
  scoreBenchmarkDiagnosisV2,
  verifyBenchmarkReportV2,
} from "../src/index.js";

const mechanisms = [
  "signal_before_receiver_connection",
  "frame_count_used_for_time_window",
  "discrete_physics_tunneling",
  "stale_effect_crossed_entity_incarnation",
] as const satisfies readonly Exclude<MechanismCodeV2, "unknown">[];

const hash = (character: string): string => character.repeat(64);
const executionId = asBenchmarkExecutionId("benchmark-execution:test");

const suite = (
  subjectHash: string = hash("a"),
  runnerHash: string = hash("b"),
): BenchmarkSuiteSpecV2 =>
  createBenchmarkSuiteSpecV2({
    schemaVersion: 2,
    subjectHash,
    runnerHash,
    metricSet: "grounded-diagnosis-v2",
    fixtures: mechanisms.map((expectedMechanism, index) => ({
      fixtureId: asFixtureId(`opaque-fixture-${index + 1}`),
      expectedMechanism,
      expectedSource: {
        virtualPath: "case/main.gd" as const,
        symbol: `symbol_${index + 1}`,
      },
      contractHash: hash("c"),
      inputTraceHash: hash("d"),
      interventionCatalogHash: hash("e"),
      oracleHash: hash("f"),
      aliasMapHash: hash("1"),
    })),
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
      fixtureId: asFixtureId("opaque-fixture-3"),
      arm: "chronorift-full",
      repetition: 1,
    },
  });

interface OutcomePolicy {
  readonly fullSuccesses: number;
  readonly genericSuccesses: number;
  readonly incorrectConfirmation?:
    { readonly arm: BenchmarkArmV1; readonly armIndex: number } | undefined;
  readonly confidence?: number | undefined;
}

const entries = (
  spec: BenchmarkSuiteSpecV2,
  policy: OutcomePolicy,
): {
  readonly attempts: readonly BenchmarkCellAttemptV2[];
  readonly cells: readonly BenchmarkCellResultV2[];
} => {
  const attempts: BenchmarkCellAttemptV2[] = [];
  const cells: BenchmarkCellResultV2[] = [];
  const armIndexes = new Map<BenchmarkArmV1, number>();
  for (const fixture of spec.fixtures) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      for (const arm of spec.arms) {
        const armIndex = armIndexes.get(arm) ?? 0;
        armIndexes.set(arm, armIndex + 1);
        const shouldSucceed =
          arm === "chronorift-full"
            ? armIndex < policy.fullSuccesses
            : arm === "generic"
              ? armIndex < policy.genericSuccesses
              : false;
        const incorrectlyConfirm =
          policy.incorrectConfirmation?.arm === arm &&
          policy.incorrectConfirmation.armIndex === armIndex;
        const proposedMechanism = shouldSucceed
          ? fixture.expectedMechanism
          : "unknown";
        const verdict =
          shouldSucceed || incorrectlyConfirm ? "confirmed" : "inconclusive";
        const cellId = benchmarkCellIdV2(
          spec,
          fixture.fixtureId,
          arm,
          repetition,
        );
        const attemptId = benchmarkAttemptIdV2(executionId, cellId, 1);
        const rawManifestHash = hash("9");
        const attemptBasis: Omit<BenchmarkCellAttemptV2, "attemptHash"> = {
          schemaVersion: 2,
          suiteId: spec.suiteId,
          definitionId: spec.definitionId,
          executionId,
          cellId,
          attemptId,
          fixtureId: fixture.fixtureId,
          arm,
          repetition,
          ordinal: 1,
          kind: "initial",
          previousAttemptHash: null,
          startedAt: "2026-08-05T00:00:00.000Z",
          finishedAt: "2026-08-05T00:00:01.000Z",
          progressObserved: true,
          metrics: {
            gameExecutions: 2,
            toolCalls: 3,
            wallTimeMs: 1_000,
            tokens: { input: 2, output: 1, total: 3 },
          },
          outcome: { status: "completed", rawManifestHash },
        };
        attempts.push({
          ...attemptBasis,
          attemptHash: benchmarkAttemptHashV2(attemptBasis),
        });
        cells.push({
          schemaVersion: 2,
          suiteId: spec.suiteId,
          definitionId: spec.definitionId,
          executionId,
          cellId,
          fixtureId: fixture.fixtureId,
          arm,
          repetition,
          expectedMechanism: fixture.expectedMechanism,
          status: "scored",
          terminalCode: null,
          attemptIds: [attemptId],
          selectedAttemptId: attemptId,
          score: scoreBenchmarkDiagnosisV2({
            proposalId: asProposalId(
              `proposal:${fixture.fixtureId}:${arm}:${repetition}`,
            ),
            candidateExecutionIds: [
              asExecutionId(
                `candidate:${fixture.fixtureId}:${arm}:${repetition}`,
              ),
            ],
            accessReceiptIds: [
              asEvidenceAccessReceiptId(
                `receipt:${fixture.fixtureId}:${arm}:${repetition}`,
              ),
            ],
            expectedMechanism: fixture.expectedMechanism,
            proposedMechanism,
            verdict,
            sourceLocationCorrect: null,
            sourceGrounded: false,
            confidence: policy.confidence ?? 0.5,
          }),
          metrics: {
            gameExecutions: 2,
            toolCalls: 3,
            wallTimeMs: 1_000,
            tokens: { input: 2, output: 1, total: 3 },
          },
          rawManifestHash,
        });
      }
    }
  }
  const orderIndex = new Map(
    benchmarkCellOrderV2(spec).map(
      (cell, index) => [cell.cellId, index] as const,
    ),
  );
  attempts.sort(
    (left, right) =>
      (orderIndex.get(left.cellId) ?? Number.MAX_SAFE_INTEGER) -
      (orderIndex.get(right.cellId) ?? Number.MAX_SAFE_INTEGER),
  );
  cells.sort(
    (left, right) =>
      (orderIndex.get(left.cellId) ?? Number.MAX_SAFE_INTEGER) -
      (orderIndex.get(right.cellId) ?? Number.MAX_SAFE_INTEGER),
  );
  for (const [index, attempt] of attempts.entries()) {
    const { attemptHash, ...basis } = attempt;
    void attemptHash;
    const chronologicalBasis: Omit<BenchmarkCellAttemptV2, "attemptHash"> = {
      ...basis,
      startedAt: new Date(Date.UTC(2026, 7, 5, 0, 0, index * 2)).toISOString(),
      finishedAt: new Date(
        Date.UTC(2026, 7, 5, 0, 0, index * 2 + 1),
      ).toISOString(),
    };
    attempts[index] = {
      ...chronologicalBasis,
      attemptHash: benchmarkAttemptHashV2(chronologicalBasis),
    };
  }
  return { attempts, cells };
};

const report = (
  policy: OutcomePolicy,
  transform?: (input: ReturnType<typeof entries>) => ReturnType<typeof entries>,
) => {
  const spec = suite();
  const generated = entries(spec, policy);
  const selected = transform?.(generated) ?? generated;
  return buildBenchmarkReportV2({
    suite: spec,
    executionId,
    startedAt: "2026-08-05T00:00:00.000Z",
    finishedAt: "2026-08-05T01:00:00.000Z",
    provenance: {
      gitCommit: "a".repeat(40),
      freezeTag: "v0.3.0-benchmark-freeze",
      dirty: false,
      lockfileHash: hash("8"),
      piPackageVersion: "0.83.0",
      nodeVersion: "v22.23.1",
      pnpmVersion: "11.20.0",
      godotVersion: "4.7.1.stable.official",
      godotExecutableHash: hash("7"),
      resolvedModelName: "GLM-5.2 [1M]",
      resolvedContextWindow: 1_000_000,
      resolvedMaxTokens: 128_000,
      mappedThinkingLevel: "max",
      requestedThinkingLevel: "max",
      os: "linux",
      arch: "x64",
      platform: "linux-x64",
    },
    attempts: selected.attempts,
    cells: selected.cells,
  });
};

describe("v0.3 Benchmark V2 report and Gate", () => {
  it("uses grounded success and ignores model confidence", () => {
    const zeroConfidence = scoreBenchmarkDiagnosisV2({
      proposalId: asProposalId("proposal:zero-confidence"),
      candidateExecutionIds: [asExecutionId("execution:zero-confidence")],
      accessReceiptIds: [asEvidenceAccessReceiptId("receipt:zero-confidence")],
      expectedMechanism: mechanisms[0],
      proposedMechanism: mechanisms[0],
      verdict: "confirmed",
      sourceLocationCorrect: null,
      sourceGrounded: false,
      confidence: 0,
    });
    const highConfidenceWrong = scoreBenchmarkDiagnosisV2({
      proposalId: asProposalId("proposal:high-confidence"),
      candidateExecutionIds: [],
      accessReceiptIds: [],
      expectedMechanism: mechanisms[0],
      proposedMechanism: "unknown",
      verdict: "inconclusive",
      sourceLocationCorrect: null,
      sourceGrounded: false,
      confidence: 1,
    });
    expect(zeroConfidence.groundedSuccess).toBe(true);
    expect(highConfidenceWrong.groundedSuccess).toBe(false);

    const result = report({
      fullSuccesses: 9,
      genericSuccesses: 6,
      confidence: 0,
    });
    expect(result.aggregate?.advantage).toMatchObject({
      fullGroundedSuccesses: 9,
      fullGroundedSuccessRate: 0.75,
      genericGroundedSuccessRate: 0.5,
      fullMinusGeneric: 0.25,
      thresholdMet: true,
    });
    expect(evaluateBenchmarkGateV2(result).status).toBe("pass");
  });

  it("only lets full-arm incorrect confirmations veto the Gate", () => {
    const genericFalseConfirmation = report({
      fullSuccesses: 9,
      genericSuccesses: 6,
      incorrectConfirmation: { arm: "generic", armIndex: 10 },
    });
    expect(
      genericFalseConfirmation.aggregate?.byArm.generic.incorrectConfirmations,
    ).toBe(1);
    expect(evaluateBenchmarkGateV2(genericFalseConfirmation).status).toBe(
      "pass",
    );

    const fullFalseConfirmation = report({
      fullSuccesses: 9,
      genericSuccesses: 6,
      incorrectConfirmation: {
        arm: "chronorift-full",
        armIndex: 10,
      },
    });
    expect(evaluateBenchmarkGateV2(fullFalseConfirmation).status).toBe("fail");
  });

  it("keeps incomplete executions valid but unaggregated", () => {
    const incomplete = report(
      { fullSuccesses: 9, genericSuccesses: 6 },
      (input) => ({
        attempts: input.attempts,
        cells: input.cells.slice(0, -1),
      }),
    );
    expect(incomplete.status).toBe("incomplete");
    expect(incomplete.aggregate).toBeNull();
    expect(evaluateBenchmarkGateV2(incomplete).status).toBe("not_evaluated");
    expect(verifyBenchmarkReportV2(incomplete).valid).toBe(true);
  });

  it("scores a missing proposal as a terminal failure without a retry", () => {
    const terminal = report(
      { fullSuccesses: 9, genericSuccesses: 6 },
      (input) => {
        const attempts = [...input.attempts];
        const cells = [...input.cells];
        const originalAttempt = attempts[0];
        const originalCell = cells[0];
        if (originalAttempt === undefined || originalCell === undefined) {
          throw new Error("Missing generated cell");
        }
        const { attemptHash, ...basis } = originalAttempt;
        void attemptHash;
        const terminalBasis: Omit<BenchmarkCellAttemptV2, "attemptHash"> = {
          ...basis,
          outcome: {
            status: "diagnostic_failure",
            code: "proposal_missing",
            message: "Terminal diagnostic failure",
            rawManifestHash: originalCell.rawManifestHash,
          },
        };
        attempts[0] = {
          ...terminalBasis,
          attemptHash: benchmarkAttemptHashV2(terminalBasis),
        };
        cells[0] = {
          ...originalCell,
          status: "diagnostic_failure",
          terminalCode: "proposal_missing",
          score: scoreBenchmarkDiagnosisV2({
            proposalId: null,
            candidateExecutionIds: [],
            accessReceiptIds: [],
            expectedMechanism: originalCell.expectedMechanism,
            proposedMechanism: "unknown",
            verdict: "inconclusive",
            sourceLocationCorrect: null,
            sourceGrounded: false,
            confidence: null,
          }),
        };
        return { attempts, cells };
      },
    );
    expect(terminal.status).toBe("complete");
    expect(terminal.cells[0]?.attemptIds).toHaveLength(1);
    expect(terminal.cells[0]?.score?.groundedSuccess).toBe(false);
  });

  it("detects aggregate and attempt-chain tampering", () => {
    const valid = report({ fullSuccesses: 9, genericSuccesses: 6 });
    const aggregateTamper = structuredClone(valid);
    if (aggregateTamper.aggregate === null)
      throw new Error("Missing aggregate");
    aggregateTamper.aggregate.advantage.fullGroundedSuccesses = 12;
    expect(verifyBenchmarkReportV2(aggregateTamper).valid).toBe(false);

    const reportHashTamper = structuredClone(valid);
    reportHashTamper.reportHash = hash("0");
    expect(verifyBenchmarkReportV2(reportHashTamper).valid).toBe(false);

    const attemptTamper = structuredClone(valid);
    attemptTamper.attempts[0]!.attemptHash = hash("0");
    expect(verifyBenchmarkReportV2(attemptTamper).valid).toBe(false);

    const canonicalIdTamper = structuredClone(valid);
    const original = canonicalIdTamper.attempts[0]!;
    const basis = {
      ...original,
      attemptId: asBenchmarkAttemptId("benchmark-attempt:noncanonical"),
    };
    canonicalIdTamper.attempts[0] = {
      ...basis,
      attemptHash: benchmarkAttemptHashV2(
        Object.fromEntries(
          Object.entries(basis).filter(([key]) => key !== "attemptHash"),
        ) as Omit<BenchmarkCellAttemptV2, "attemptHash">,
      ),
    };
    expect(verifyBenchmarkReportV2(canonicalIdTamper).valid).toBe(false);
  });

  it("rejects a suite whose content hash was changed consistently only in fields", () => {
    const valid = report({ fullSuccesses: 9, genericSuccesses: 6 });
    const tampered = structuredClone(valid);
    tampered.suite.runnerHash = hash("0");
    expect(verifyBenchmarkReportV2(tampered).valid).toBe(false);

    const identityTamper = structuredClone(valid);
    identityTamper.suite.suiteId = asBenchmarkSuiteId("benchmark-suite:fake");
    expect(verifyBenchmarkReportV2(identityTamper).valid).toBe(false);
  });

  it("keeps suite identity stable while definition identity binds the subject", () => {
    const original = suite(hash("a"), hash("b"));
    const subjectOnlyChange = suite(hash("0"), hash("b"));
    expect(subjectOnlyChange.suiteHash).toBe(original.suiteHash);
    expect(subjectOnlyChange.suiteId).toBe(original.suiteId);
    expect(subjectOnlyChange.definitionId).not.toBe(original.definitionId);
  });

  it("recomputes a deterministic block-randomized global schedule", () => {
    const spec = suite();
    const first = benchmarkCellOrderV2(spec);
    const second = benchmarkCellOrderV2(structuredClone(spec));
    expect(second).toEqual(first);
    expect(first).toHaveLength(36);
    for (let index = 0; index < first.length; index += 3) {
      const block = first.slice(index, index + 3);
      expect(new Set(block.map((cell) => cell.fixtureId))).toHaveLength(1);
      expect(new Set(block.map((cell) => cell.repetition))).toHaveLength(1);
      expect(new Set(block.map((cell) => cell.arm))).toEqual(
        new Set(spec.arms),
      );
    }
  });

  it("rejects reordered or overlapping attempts even after rehashing", () => {
    expect(() =>
      report({ fullSuccesses: 9, genericSuccesses: 6 }, (input) => {
        const attempts = [...input.attempts];
        const first = attempts[0];
        const second = attempts[1];
        if (first === undefined || second === undefined) {
          throw new Error("Missing attempts");
        }
        const { attemptHash: firstHash, ...firstBasis } = first;
        const { attemptHash: secondHash, ...secondBasis } = second;
        void firstHash;
        void secondHash;
        const secondAtFirstTime: Omit<BenchmarkCellAttemptV2, "attemptHash"> = {
          ...secondBasis,
          startedAt: first.startedAt,
          finishedAt: first.finishedAt,
        };
        const firstAtSecondTime: Omit<BenchmarkCellAttemptV2, "attemptHash"> = {
          ...firstBasis,
          startedAt: second.startedAt,
          finishedAt: second.finishedAt,
        };
        attempts[0] = {
          ...secondAtFirstTime,
          attemptHash: benchmarkAttemptHashV2(secondAtFirstTime),
        };
        attempts[1] = {
          ...firstAtSecondTime,
          attemptHash: benchmarkAttemptHashV2(firstAtSecondTime),
        };
        return { ...input, attempts };
      }),
    ).toThrow("frozen global schedule");

    expect(() =>
      report({ fullSuccesses: 9, genericSuccesses: 6 }, (input) => {
        const attempts = [...input.attempts];
        const second = attempts[1];
        if (second === undefined) throw new Error("Missing second attempt");
        const { attemptHash, ...basis } = second;
        void attemptHash;
        const overlappingBasis: Omit<BenchmarkCellAttemptV2, "attemptHash"> = {
          ...basis,
          startedAt: input.attempts[0]!.startedAt,
        };
        attempts[1] = {
          ...overlappingBasis,
          attemptHash: benchmarkAttemptHashV2(overlappingBasis),
        };
        return { ...input, attempts };
      }),
    ).toThrow("globally serial");
  });

  it("requires every attempt to remain inside the report time envelope", () => {
    const valid = report({ fullSuccesses: 9, genericSuccesses: 6 });
    expect(() =>
      buildBenchmarkReportV2({
        suite: valid.suite,
        executionId: valid.executionId,
        startedAt: valid.startedAt,
        finishedAt: valid.startedAt,
        provenance: valid.provenance,
        attempts: valid.attempts,
        cells: valid.cells,
      }),
    ).toThrow("outside the report time envelope");
  });
});
