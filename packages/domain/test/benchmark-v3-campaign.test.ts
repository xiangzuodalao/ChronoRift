import {
  BenchmarkCampaignV3Schema,
  BenchmarkProvenanceV3Schema,
  BenchmarkReportV3Schema,
  BenchmarkSuiteSpecV3Schema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const hash = "a".repeat(64);
const mechanisms = [
  "signal_before_receiver_connection",
  "frame_count_used_for_time_window",
  "discrete_physics_tunneling",
  "stale_effect_crossed_entity_incarnation",
] as const;

const r2Suite = {
  schemaVersion: 3,
  suiteId: "benchmark-suite:r2",
  definitionId: "benchmark-definition:r2",
  suiteHash: hash,
  campaign: {
    campaignId: "v0.3.2-luna-r2",
    freezeTag: "v0.3.2-luna-r2-benchmark-freeze",
  },
  subjectHash: hash,
  runnerHash: hash,
  metricSet: "grounded-diagnosis-v3",
  fixtures: mechanisms.map((expectedMechanism, index) => ({
    fixtureId: `fixture-${index}`,
    expectedMechanism,
    expectedSource: {
      virtualPath: "case/main.gd",
      symbol: `symbol_${index}`,
    },
    contractHash: hash,
    inputTraceHash: hash,
    interventionCatalogHash: hash,
    oracleHash: hash,
    aliasMapHash: hash,
  })),
  arms: ["generic", "evidence-only", "chronorift-full"],
  repetitions: 3,
  orderSeed: "chronorift-v0.3.2-luna-r2-formal-1",
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
    fixtureId: "fixture-2",
    arm: "chronorift-full",
    repetition: 1,
  },
} as const;

const r2Provenance = {
  gitCommit: "abcdef0",
  freezeTag: "v0.3.2-luna-r2-benchmark-freeze",
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
} as const;

const r3Suite = {
  ...r2Suite,
  suiteId: "benchmark-suite:r3",
  definitionId: "benchmark-definition:r3",
  campaign: {
    campaignId: "v0.3.2-luna-r3",
    freezeTag: "v0.3.2-luna-r3-benchmark-freeze",
  },
  orderSeed: "chronorift-v0.3.2-luna-r3-formal-1",
} as const;

const r3Provenance = {
  ...r2Provenance,
  freezeTag: "v0.3.2-luna-r3-benchmark-freeze",
} as const;

const r4Suite = {
  ...r2Suite,
  suiteId: "benchmark-suite:r4",
  definitionId: "benchmark-definition:r4",
  campaign: {
    campaignId: "v0.3.2-luna-r4",
    freezeTag: "v0.3.2-luna-r4-benchmark-freeze",
  },
  orderSeed: "chronorift-v0.3.2-luna-r4-formal-1",
} as const;

const r4Provenance = {
  ...r2Provenance,
  freezeTag: "v0.3.2-luna-r4-benchmark-freeze",
} as const;

describe("Benchmark V3 campaign identity", () => {
  it("accepts the isolated Luna r2 campaign, freeze tag, and order seed", () => {
    expect(BenchmarkSuiteSpecV3Schema.parse(r2Suite)).toMatchObject({
      campaign: r2Suite.campaign,
      orderSeed: r2Suite.orderSeed,
    });
    expect(BenchmarkProvenanceV3Schema.parse(r2Provenance).freezeTag).toBe(
      "v0.3.2-luna-r2-benchmark-freeze",
    );
  });

  it("accepts the isolated Luna r3 campaign, freeze tag, and order seed", () => {
    expect(BenchmarkSuiteSpecV3Schema.parse(r3Suite)).toMatchObject({
      campaign: r3Suite.campaign,
      orderSeed: r3Suite.orderSeed,
    });
    expect(BenchmarkProvenanceV3Schema.parse(r3Provenance).freezeTag).toBe(
      "v0.3.2-luna-r3-benchmark-freeze",
    );
  });

  it("rejects crossed r3 campaign, tag, seed, and provenance pairings", () => {
    expect(
      BenchmarkCampaignV3Schema.safeParse({
        campaignId: "v0.3.2-luna-r3",
        freezeTag: "v0.3.2-luna-r2-benchmark-freeze",
      }).success,
    ).toBe(false);
    expect(
      BenchmarkSuiteSpecV3Schema.safeParse({
        ...r3Suite,
        orderSeed: "chronorift-v0.3.2-luna-r2-formal-1",
      }).success,
    ).toBe(false);
    expect(
      BenchmarkReportV3Schema.safeParse({
        schemaVersion: 3,
        suite: r3Suite,
        executionId: "benchmark-execution:r3",
        selectionHash: hash,
        startedAt: "2026-08-06T00:00:00.000Z",
        finishedAt: "2026-08-06T00:01:00.000Z",
        provenance: {
          ...r3Provenance,
          freezeTag: "v0.3.2-luna-r2-benchmark-freeze",
        },
        attempts: [],
        cells: [],
        scoringProofs: [],
        auditIssues: [],
        status: "invalid",
        aggregate: null,
        reportHash: hash,
      }).success,
    ).toBe(false);
  });

  it("accepts the isolated Luna r4 campaign, freeze tag, and order seed", () => {
    expect(BenchmarkSuiteSpecV3Schema.parse(r4Suite)).toMatchObject({
      campaign: r4Suite.campaign,
      orderSeed: r4Suite.orderSeed,
    });
    expect(BenchmarkProvenanceV3Schema.parse(r4Provenance).freezeTag).toBe(
      "v0.3.2-luna-r4-benchmark-freeze",
    );
  });

  it("rejects crossed r4 campaign, tag, seed, and provenance pairings", () => {
    expect(
      BenchmarkCampaignV3Schema.safeParse({
        campaignId: "v0.3.2-luna-r4",
        freezeTag: "v0.3.2-luna-r3-benchmark-freeze",
      }).success,
    ).toBe(false);
    expect(
      BenchmarkSuiteSpecV3Schema.safeParse({
        ...r4Suite,
        orderSeed: "chronorift-v0.3.2-luna-r3-formal-1",
      }).success,
    ).toBe(false);
    expect(
      BenchmarkReportV3Schema.safeParse({
        schemaVersion: 3,
        suite: r4Suite,
        executionId: "benchmark-execution:r4",
        selectionHash: hash,
        startedAt: "2026-08-06T00:00:00.000Z",
        finishedAt: "2026-08-06T00:01:00.000Z",
        provenance: {
          ...r4Provenance,
          freezeTag: "v0.3.2-luna-r3-benchmark-freeze",
        },
        attempts: [],
        cells: [],
        scoringProofs: [],
        auditIssues: [],
        status: "invalid",
        aggregate: null,
        reportHash: hash,
      }).success,
    ).toBe(false);
  });

  it("rejects crossed r2 campaign, tag, seed, and provenance pairings", () => {
    expect(
      BenchmarkCampaignV3Schema.safeParse({
        campaignId: "v0.3.2-luna-r2",
        freezeTag: "v0.3.2-luna-r1-benchmark-freeze",
      }).success,
    ).toBe(false);
    expect(
      BenchmarkSuiteSpecV3Schema.safeParse({
        ...r2Suite,
        orderSeed: "chronorift-v0.3.2-luna-r1-formal-1",
      }).success,
    ).toBe(false);
    expect(
      BenchmarkReportV3Schema.safeParse({
        schemaVersion: 3,
        suite: r2Suite,
        executionId: "benchmark-execution:r2",
        selectionHash: hash,
        startedAt: "2026-08-05T00:00:00.000Z",
        finishedAt: "2026-08-05T00:01:00.000Z",
        provenance: {
          ...r2Provenance,
          freezeTag: "v0.3.2-luna-r1-benchmark-freeze",
        },
        attempts: [],
        cells: [],
        scoringProofs: [],
        auditIssues: [],
        status: "invalid",
        aggregate: null,
        reportHash: hash,
      }).success,
    ).toBe(false);
  });
});
