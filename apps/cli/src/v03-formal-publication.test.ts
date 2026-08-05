import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  asBenchmarkExecutionId,
  asBenchmarkCellId,
  asExecutionId,
  asFixtureId,
  type BenchmarkFixtureSpecV2,
  type JsonValue,
} from "@chronorift/domain";
import {
  buildBenchmarkReportV2,
  createBenchmarkSuiteSpecV2,
} from "@chronorift/gamebranch";
import {
  V03BenchmarkJsonArtifactRepository,
  canonicalJson,
} from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import {
  FORMAL_CASE_FILENAME,
  FORMAL_REPORT_FILENAME,
  FORMAL_RESULTS_FILENAME,
  assertPublicationOutputScope,
  publishFormalBenchmark,
  sanitizeFormalCaseEvidence,
  sanitizeFormalProposal,
  verifyFormalBenchmarkReport,
} from "./v03-formal-publication.js";

const hash = "a".repeat(64);
const mechanisms = [
  "signal_before_receiver_connection",
  "frame_count_used_for_time_window",
  "discrete_physics_tunneling",
  "stale_effect_crossed_entity_incarnation",
] as const;
const fixtures: readonly BenchmarkFixtureSpecV2[] = mechanisms.map(
  (expectedMechanism, index) => ({
    fixtureId: asFixtureId(`fixture-${index}`),
    expectedMechanism,
    expectedSource: { virtualPath: "case/main.gd", symbol: `symbol${index}` },
    contractHash: hash,
    inputTraceHash: hash,
    interventionCatalogHash: hash,
    oracleHash: hash,
    aliasMapHash: hash,
  }),
);
const suite = createBenchmarkSuiteSpecV2({
  schemaVersion: 2,
  subjectHash: hash,
  runnerHash: "b".repeat(64),
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
const {
  suiteId: _legacySuiteId,
  definitionId: _legacyDefinitionId,
  suiteHash: _legacySuiteHash,
  orderSeed: _legacyOrderSeed,
  ...legacySuiteBasis
} = suite;
void _legacySuiteId;
void _legacyDefinitionId;
void _legacySuiteHash;
void _legacyOrderSeed;
const v031Suite = createBenchmarkSuiteSpecV2({
  ...legacySuiteBasis,
  campaign: {
    campaignId: "v0.3.1",
    freezeTag: "v0.3.1-benchmark-freeze",
  },
  orderSeed: "chronorift-v0.3.1-formal-1",
});
const executionId = asBenchmarkExecutionId("benchmark-execution:negative");
const report = buildBenchmarkReportV2({
  suite,
  executionId,
  startedAt: "2026-08-05T00:00:00.000Z",
  finishedAt: "2026-08-05T00:01:00.000Z",
  provenance: {
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
    os: "Linux",
    arch: "x64",
    platform: "linux",
  },
  attempts: [],
  cells: [],
});

describe("formal benchmark publication", () => {
  it("limits dirty publication state to three files in the dedicated directory", () => {
    const cwd = "/workspace/chronorift";
    const output = join(cwd, "docs", "benchmarks", "v0.3");
    expect(() => assertPublicationOutputScope(cwd, cwd, "", suite)).toThrow(
      "must be docs/benchmarks/v0.3",
    );
    expect(() =>
      assertPublicationOutputScope(
        cwd,
        output,
        `?? docs/benchmarks/v0.3/${FORMAL_REPORT_FILENAME}\n M docs/benchmarks/v0.3/${FORMAL_RESULTS_FILENAME}\n`,
        suite,
      ),
    ).not.toThrow();
    expect(() =>
      assertPublicationOutputScope(
        cwd,
        output,
        " M docs/benchmarks/v0.3/protocol.md\n",
        suite,
      ),
    ).toThrow("three generated artifacts");
  });

  it("isolates v0.3.1 publication from the legacy evidence directory", () => {
    const cwd = "/workspace/chronorift";
    const output = join(cwd, "docs", "benchmarks", "v0.3.1");
    expect(() => assertPublicationOutputScope(cwd, output, "", suite)).toThrow(
      "docs/benchmarks/v0.3",
    );
    expect(() =>
      assertPublicationOutputScope(
        cwd,
        output,
        `?? docs/benchmarks/v0.3.1/${FORMAL_REPORT_FILENAME}\n`,
        v031Suite,
      ),
    ).not.toThrow();
  });

  it("hashes model-authored prose instead of publishing source-text canaries", () => {
    const canary = "DO_NOT_PUBLISH_SOURCE_CANARY";
    const sanitized = sanitizeFormalProposal({
      schemaVersion: 3,
      proposalId: "proposal:test",
      runId: "run:test",
      fixtureId: "fixture-0",
      capsuleId: "capsule:test",
      baselineExecutionId: "execution:test",
      candidateExecutionIds: [],
      comparisonIds: [],
      accessReceiptIds: [],
      mechanismCode: "unknown",
      summary: canary,
      evidenceEventIds: [],
      blockers: [`${canary}:blocker`],
      nextExperiment: `${canary}:next`,
      confidence: 0.5,
    });
    expect(JSON.stringify(sanitized)).not.toContain(canary);
  });

  it("publishes a strictly typed partial marker after a baseline-only crash", () => {
    const partial = {
      schemaVersion: 2 as const,
      stage: "baseline_completed" as const,
      cellId: asBenchmarkCellId("benchmark-cell:partial"),
      fixtureId: fixtures[2]!.fixtureId,
      arm: "chronorift-full" as const,
      repetition: 1,
      baselineExecutionId: asExecutionId("execution:partial-baseline"),
      baselineTimelineDigest: hash,
      gameExecutions: 1 as const,
      progressObserved: true as const,
      error: { code: "process_interrupted_after_progress" as const },
    };
    expect(sanitizeFormalCaseEvidence(partial)).toMatchObject({
      stage: "baseline_completed",
      evidenceCompleteness: "partial",
      unavailableReason: "attempt_interrupted_after_baseline",
      gameExecutions: 1,
    });
    expect(() =>
      sanitizeFormalCaseEvidence({
        ...partial,
        sourceText: "SOURCE_TEXT_CANARY",
      }),
    ).toThrow();
  });

  it("verifies and publishes an honest incomplete execution with an unavailable case", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-formal-publish-"));
    const specPath = join(root, "benchmark-spec.v2.json");
    const reportPath = join(root, "input-report.json");
    const output = join(root, "published");
    await writeFile(
      specPath,
      `${canonicalJson(suite as unknown as JsonValue)}\n`,
    );
    await writeFile(
      reportPath,
      `${canonicalJson(report as unknown as JsonValue)}\n`,
    );
    await new V03BenchmarkJsonArtifactRepository(root).putCompleted(report);

    const verified = await verifyFormalBenchmarkReport({
      reportPath,
      specPath,
    });
    expect(verified.valid).toBe(true);
    expect(verified.gate.status).toBe("not_evaluated");

    const files = await publishFormalBenchmark({
      cwd: process.cwd(),
      artifactRoot: root,
      specPath,
      executionId,
      outputDirectory: output,
      verifyCheckout: async () => undefined,
    });
    expect(files.map((path) => path.split("/").at(-1))).toEqual([
      FORMAL_REPORT_FILENAME,
      FORMAL_RESULTS_FILENAME,
      FORMAL_CASE_FILENAME,
    ]);
    expect(
      JSON.parse(await readFile(join(output, FORMAL_CASE_FILENAME), "utf8")),
    ).toMatchObject({ caseStatus: "absent", cell: null, attempt: null });
    await expect(
      readFile(join(output, FORMAL_RESULTS_FILENAME), "utf8"),
    ).resolves.toContain("corepack pnpm benchmark:verify");
    await expect(
      verifyFormalBenchmarkReport({
        reportPath: join(output, FORMAL_REPORT_FILENAME),
        specPath,
      }),
    ).resolves.toMatchObject({ valid: true });
    const casePath = join(output, FORMAL_CASE_FILENAME);
    const publishedCase = JSON.parse(
      await readFile(casePath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      casePath,
      `${JSON.stringify({ ...publishedCase, caseHash: "0".repeat(64) })}\n`,
    );
    await expect(
      verifyFormalBenchmarkReport({
        reportPath: join(output, FORMAL_REPORT_FILENAME),
        specPath,
      }),
    ).resolves.toMatchObject({ valid: false });
    await writeFile(casePath, `${canonicalJson(publishedCase as JsonValue)}\n`);
    await expect(
      publishFormalBenchmark({
        cwd: process.cwd(),
        artifactRoot: root,
        specPath,
        executionId,
        outputDirectory: output,
        verifyCheckout: async () => undefined,
      }),
    ).resolves.toHaveLength(3);
    await unlink(casePath);
    await expect(
      verifyFormalBenchmarkReport({
        reportPath: join(output, FORMAL_REPORT_FILENAME),
        specPath,
      }),
    ).resolves.toMatchObject({ valid: false });
  });

  it("rejects report tampering and a report from another committed suite", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-formal-verify-"));
    const specPath = join(root, "benchmark-spec.v2.json");
    const reportPath = join(root, "report.json");
    await writeFile(
      specPath,
      `${canonicalJson(suite as unknown as JsonValue)}\n`,
    );
    await writeFile(
      reportPath,
      `${JSON.stringify({ ...report, reportHash: "0".repeat(64) })}\n`,
    );
    await expect(
      verifyFormalBenchmarkReport({ reportPath, specPath }),
    ).resolves.toMatchObject({ valid: false });

    const otherSuite = createBenchmarkSuiteSpecV2({
      schemaVersion: 2,
      subjectHash: "c".repeat(64),
      runnerHash: suite.runnerHash,
      metricSet: suite.metricSet,
      fixtures: suite.fixtures,
      arms: suite.arms,
      repetitions: suite.repetitions,
      orderSeed: suite.orderSeed,
      orderStrategy: suite.orderStrategy,
      provider: suite.provider,
      model: suite.model,
      thinkingLevel: suite.thinkingLevel,
      modelRequirements: suite.modelRequirements,
      budgets: suite.budgets,
      retryPolicy: suite.retryPolicy,
      gate: suite.gate,
      calibrationStatus: suite.calibrationStatus,
      samplingSeedAvailable: suite.samplingSeedAvailable,
      preselectedCase: suite.preselectedCase,
    });
    await writeFile(
      specPath,
      `${canonicalJson(otherSuite as unknown as JsonValue)}\n`,
    );
    await writeFile(
      reportPath,
      `${canonicalJson(report as unknown as JsonValue)}\n`,
    );
    await expect(
      verifyFormalBenchmarkReport({ reportPath, specPath }),
    ).resolves.toMatchObject({ valid: false });
  });

  it("runs checkout provenance verification before writing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-formal-checkout-"));
    const specPath = join(root, "benchmark-spec.v2.json");
    const output = join(root, "published");
    await writeFile(
      specPath,
      `${canonicalJson(suite as unknown as JsonValue)}\n`,
    );
    await new V03BenchmarkJsonArtifactRepository(root).putCompleted(report);
    await expect(
      publishFormalBenchmark({
        cwd: process.cwd(),
        artifactRoot: root,
        specPath,
        executionId,
        outputDirectory: output,
        verifyCheckout: () =>
          Promise.reject(new Error("checkout provenance mismatch")),
      }),
    ).rejects.toThrow("checkout provenance mismatch");
    await expect(
      readFile(join(output, FORMAL_REPORT_FILENAME), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
