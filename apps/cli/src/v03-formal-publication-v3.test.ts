import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BenchmarkExecutionSelectionV3Schema,
  BenchmarkExecutionStartedV3Schema,
  asBenchmarkExecutionId,
  asFixtureId,
  type BenchmarkFixtureSpecV3,
  type JsonValue,
} from "@chronorift/domain";
import {
  benchmarkExecutionSelectionHashV3,
  buildBenchmarkReportV3,
  createBenchmarkSuiteSpecV3,
} from "@chronorift/gamebranch";
import {
  V03BenchmarkJsonArtifactRepositoryV3,
  canonicalJson,
} from "@chronorift/json-artifacts";
import { describe, expect, it, vi } from "vitest";

import { main } from "./main.js";
import {
  FORMAL_CASE_FILENAME_V3,
  FORMAL_REPORT_FILENAME_V3,
  FORMAL_RESULTS_FILENAME_V3,
  assertFormalPublicationProjectionV3,
  assertPublicationOutputScopeV3,
  publishFormalBenchmarkV3,
  verifyFormalBenchmarkReportV3,
} from "./v03-formal-publication-v3.js";

const hash = "a".repeat(64);
const mechanisms = [
  "signal_before_receiver_connection",
  "frame_count_used_for_time_window",
  "discrete_physics_tunneling",
  "stale_effect_crossed_entity_incarnation",
] as const;
const fixtures: readonly BenchmarkFixtureSpecV3[] = mechanisms.map(
  (expectedMechanism, index) => ({
    fixtureId: asFixtureId(`fixture-v3-${index}`),
    expectedMechanism,
    expectedSource: { virtualPath: "case/main.gd", symbol: `symbol${index}` },
    contractHash: hash,
    inputTraceHash: hash,
    interventionCatalogHash: hash,
    oracleHash: hash,
    aliasMapHash: hash,
  }),
);
const suiteForCampaign = (campaignId: "v0.3.2-luna" | "v0.3.2-luna-r1") => {
  const isR1 = campaignId === "v0.3.2-luna-r1";
  return createBenchmarkSuiteSpecV3({
    schemaVersion: 3,
    campaign: isR1
      ? {
          campaignId: "v0.3.2-luna-r1",
          freezeTag: "v0.3.2-luna-r1-benchmark-freeze",
        }
      : {
          campaignId: "v0.3.2-luna",
          freezeTag: "v0.3.2-luna-benchmark-freeze",
        },
    subjectHash: hash,
    runnerHash: "b".repeat(64),
    metricSet: "grounded-diagnosis-v3",
    fixtures,
    arms: ["generic", "evidence-only", "chronorift-full"],
    repetitions: 3,
    orderSeed: isR1
      ? "chronorift-v0.3.2-luna-r1-formal-1"
      : "chronorift-v0.3.2-luna-formal-1",
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
      fixtureId: fixtures[2]!.fixtureId,
      arm: "chronorift-full",
      repetition: 1,
    },
  });
};
const suite = suiteForCampaign("v0.3.2-luna");
const r1Suite = suiteForCampaign("v0.3.2-luna-r1");
const executionId = asBenchmarkExecutionId("benchmark-execution:v3-publish");
const report = buildBenchmarkReportV3({
  suite,
  executionId,
  startedAt: "2026-08-05T00:00:00.000Z",
  finishedAt: "2026-08-05T00:01:00.000Z",
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
    os: "Linux",
    arch: "x64",
    platform: "linux",
  },
  attempts: [],
  cells: [],
  scoringProofs: [],
});

describe("formal benchmark V3 publication", () => {
  it("limits output to the Luna campaign's three generated files", () => {
    const cwd = "/workspace/chronorift";
    const output = join(cwd, "docs", "benchmarks", "v0.3.2-luna");
    expect(() =>
      assertPublicationOutputScopeV3(
        cwd,
        output,
        `?? docs/benchmarks/v0.3.2-luna/${FORMAL_REPORT_FILENAME_V3}\n M docs/benchmarks/v0.3.2-luna/${FORMAL_RESULTS_FILENAME_V3}\n`,
        suite,
      ),
    ).not.toThrow();
    expect(() =>
      assertPublicationOutputScopeV3(
        cwd,
        output,
        " M docs/architecture.md\n",
        suite,
      ),
    ).toThrow("three generated V3 artifacts");
  });

  it("isolates Luna r1 publication from the original evidence directory", () => {
    const cwd = "/workspace/chronorift";
    const originalOutput = join(cwd, "docs", "benchmarks", "v0.3.2-luna");
    const r1Output = join(cwd, "docs", "benchmarks", "v0.3.2-luna-r1");
    const r1Status = `?? docs/benchmarks/v0.3.2-luna-r1/${FORMAL_REPORT_FILENAME_V3}\n`;

    expect(() =>
      assertPublicationOutputScopeV3(cwd, r1Output, r1Status, r1Suite),
    ).not.toThrow();
    expect(() =>
      assertPublicationOutputScopeV3(cwd, originalOutput, "", r1Suite),
    ).toThrow(
      "Formal V3 publication output must be docs/benchmarks/v0.3.2-luna-r1",
    );
    expect(() =>
      assertPublicationOutputScopeV3(cwd, r1Output, "", suite),
    ).toThrow(
      "Formal V3 publication output must be docs/benchmarks/v0.3.2-luna",
    );
  });

  it("rejects raw session, credential, source text, and host path fields", () => {
    expect(() =>
      assertFormalPublicationProjectionV3({ piSession: {} }),
    ).toThrow("forbidden field");
    expect(() =>
      assertFormalPublicationProjectionV3({ apiKey: "secret" }),
    ).toThrow("forbidden field");
    expect(() =>
      assertFormalPublicationProjectionV3({ accessToken: "secret" }),
    ).toThrow("forbidden field");
    expect(() =>
      assertFormalPublicationProjectionV3({ sourceText: "secret source" }),
    ).toThrow("forbidden field");
    expect(() =>
      assertFormalPublicationProjectionV3({ path: "/home/vm/private" }),
    ).toThrow("unsafe host path");
    expect(() =>
      assertFormalPublicationProjectionV3({ resourceId: "C:\\Users\\private" }),
    ).toThrow("unsafe host path");
  });

  it("publishes and verifies an append-only sanitized V3 bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v3-publish-"));
    const specPath = join(root, "benchmark-spec.v3.json");
    const inputReport = join(root, "input-report.json");
    const output = join(root, "published");
    await writeFile(
      specPath,
      `${canonicalJson(suite as unknown as JsonValue)}\n`,
    );
    await writeFile(
      inputReport,
      `${canonicalJson(report as unknown as JsonValue)}\n`,
    );
    const repository = new V03BenchmarkJsonArtifactRepositoryV3(root);
    const selectionHash = benchmarkExecutionSelectionHashV3(
      suite.definitionId,
      executionId,
    );
    const selection = BenchmarkExecutionSelectionV3Schema.parse({
      schemaVersion: 3,
      suiteId: suite.suiteId,
      definitionId: suite.definitionId,
      executionId,
      selectionHash,
    });
    await repository.putDefinitionV3(suite);
    await repository.putExecutionSelectionV3(selection);
    await repository.putExecutionStartedV3(
      BenchmarkExecutionStartedV3Schema.parse({
        ...selection,
        startedAt: report.startedAt,
        provenance: report.provenance,
      }),
    );
    await repository.putCompletedV3(report);

    await expect(
      verifyFormalBenchmarkReportV3({ reportPath: inputReport, specPath }),
    ).resolves.toMatchObject({ valid: true });
    const files = await publishFormalBenchmarkV3({
      cwd: process.cwd(),
      artifactRoot: root,
      specPath,
      executionId,
      outputDirectory: output,
      verifyCheckout: async () => undefined,
    });
    expect(files.map((path) => path.split("/").at(-1))).toEqual([
      FORMAL_REPORT_FILENAME_V3,
      FORMAL_RESULTS_FILENAME_V3,
      FORMAL_CASE_FILENAME_V3,
    ]);
    const casePath = join(output, FORMAL_CASE_FILENAME_V3);
    const text = await readFile(casePath, "utf8");
    expect(text).not.toMatch(
      /piSession|apiKey|credential|sourceText|runDirectory/u,
    );
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: 3,
      caseStatus: "absent",
      cell: null,
      attempt: null,
      evidence: { evidenceCompleteness: "unavailable" },
    });
    await expect(
      verifyFormalBenchmarkReportV3({
        reportPath: join(output, FORMAL_REPORT_FILENAME_V3),
        specPath,
      }),
    ).resolves.toMatchObject({ valid: true });

    const bundle = JSON.parse(text) as Record<string, unknown>;
    await writeFile(
      casePath,
      `${JSON.stringify({ ...bundle, caseHash: "0".repeat(64) })}\n`,
    );
    await expect(
      verifyFormalBenchmarkReportV3({
        reportPath: join(output, FORMAL_REPORT_FILENAME_V3),
        specPath,
      }),
    ).resolves.toMatchObject({ valid: false });
    await writeFile(casePath, text);
    await unlink(casePath);
    await expect(
      verifyFormalBenchmarkReportV3({
        reportPath: join(output, FORMAL_REPORT_FILENAME_V3),
        specPath,
      }),
    ).resolves.toMatchObject({ valid: false });
  });

  it("dispatches benchmark verification from an explicit V3 spec", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v3-cli-"));
    const specPath = join(root, "benchmark-spec.v3.json");
    const reportPath = join(root, "report.v3.json");
    await writeFile(
      specPath,
      `${canonicalJson(suite as unknown as JsonValue)}\n`,
    );
    await writeFile(
      reportPath,
      `${canonicalJson(report as unknown as JsonValue)}\n`,
    );
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await main([
        "benchmark-verify",
        "--spec",
        specPath,
        "--report",
        reportPath,
      ]);
      const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(JSON.parse(output)).toMatchObject({
        verified: true,
        gate: { status: "not_evaluated" },
      });
    } finally {
      write.mockRestore();
    }
  });
});
