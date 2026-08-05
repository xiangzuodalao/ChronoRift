import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BenchmarkSuiteSpecV2Schema,
  asFixtureId,
  type BenchmarkCampaignV1,
  type JsonValue,
} from "@chronorift/domain";
import { createBenchmarkSuiteSpecV2 } from "@chronorift/gamebranch";
import { describe, expect, it } from "vitest";

import {
  assertFormalFixtureMaterialBinding,
  formalCampaignForSuite,
  formalFixtureMaterialHashes,
  formalSubjectHash,
  type FormalFixtureMaterialInput,
} from "./v03-formal-suite.js";

const roots = [
  "packages/domain/src/marker.ts",
  "packages/gamebranch/src/services/v03-gamebranch-service.ts",
  "packages/godot-adapter/src/marker.ts",
  "packages/godot-protocol/src/marker.ts",
  "godot/addons/chronorift/marker.gd",
  "fixtures/godot-switch-door/marker.gd",
  "fixtures/godot-frame-input-window/marker.gd",
  "fixtures/godot-entity-reuse/marker.gd",
  "fixtures/godot-physics-tunneling/marker.gd",
  "packages/pi-harness/src/marker.ts",
  "apps/cli/src/v03-runtime.ts",
  "apps/cli/src/v03-agent-game-api.ts",
] as const;

const campaignSpecFor = (
  campaign: "v0.3.1" | "v0.3.1-r2" | undefined,
): BenchmarkCampaignV1 | undefined =>
  campaign === "v0.3.1"
    ? { campaignId: "v0.3.1", freezeTag: "v0.3.1-benchmark-freeze" }
    : campaign === "v0.3.1-r2"
      ? {
          campaignId: "v0.3.1-r2",
          freezeTag: "v0.3.1-r2-benchmark-freeze",
        }
      : undefined;

const suiteFor = (subjectHash: string, campaign?: "v0.3.1" | "v0.3.1-r2") =>
  createBenchmarkSuiteSpecV2({
    schemaVersion: 2,
    ...(campaignSpecFor(campaign) === undefined
      ? {}
      : { campaign: campaignSpecFor(campaign)! }),
    subjectHash,
    runnerHash: "b".repeat(64),
    metricSet: "grounded-diagnosis-v2",
    fixtures: (
      [
        "signal_before_receiver_connection",
        "frame_count_used_for_time_window",
        "discrete_physics_tunneling",
        "stale_effect_crossed_entity_incarnation",
      ] as const
    ).map((expectedMechanism, index) => ({
      fixtureId: asFixtureId(`fixture-${index}`),
      expectedMechanism,
      expectedSource: { virtualPath: "case/main.gd", symbol: `symbol${index}` },
      contractHash: "c".repeat(64),
      inputTraceHash: "d".repeat(64),
      interventionCatalogHash: "e".repeat(64),
      oracleHash: "f".repeat(64),
      aliasMapHash: "1".repeat(64),
    })),
    arms: ["generic", "evidence-only", "chronorift-full"],
    repetitions: 3,
    orderSeed:
      campaign === undefined
        ? "chronorift-v0.3-formal-1"
        : campaign === "v0.3.1"
          ? "chronorift-v0.3.1-formal-1"
          : "chronorift-v0.3.1-r2-formal-1",
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
      fixtureId: asFixtureId("fixture-2"),
      arm: "chronorift-full",
      repetition: 1,
    },
  });

const definitionFor = (subjectHash: string): string =>
  suiteFor(subjectHash).definitionId;

describe("formalSubjectHash", () => {
  it("gives v0.3.1 an isolated campaign identity and strict tag mapping", () => {
    const legacy = suiteFor("a".repeat(64));
    const current = suiteFor("a".repeat(64), "v0.3.1");
    const retry = suiteFor("a".repeat(64), "v0.3.1-r2");
    expect(current.definitionId).not.toBe(legacy.definitionId);
    expect(retry.definitionId).not.toBe(current.definitionId);
    expect(formalCampaignForSuite(legacy)).toMatchObject({
      campaignId: "v0.3",
      freezeTag: "v0.3.0-benchmark-freeze",
    });
    expect(formalCampaignForSuite(current)).toMatchObject({
      campaignId: "v0.3.1",
      freezeTag: "v0.3.1-benchmark-freeze",
    });
    expect(formalCampaignForSuite(retry)).toMatchObject({
      campaignId: "v0.3.1-r2",
      freezeTag: "v0.3.1-r2-benchmark-freeze",
      evidenceDirectory: "docs/benchmarks/v0.3.1-r2",
    });
    expect(() =>
      BenchmarkSuiteSpecV2Schema.parse({
        ...current,
        orderSeed: "chronorift-v0.3-formal-1",
      }),
    ).toThrow("campaign and order seed");
  });

  it("binds Godot adapter, protocol, addon, and Fixture content into definitionId", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "chronorift-formal-subject-"));
    for (const path of roots) {
      const absolute = join(cwd, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, `original:${path}\n`);
    }
    const before = await formalSubjectHash(cwd);
    await writeFile(
      join(cwd, "fixtures/godot-physics-tunneling/marker.gd"),
      "changed\n",
    );
    const after = await formalSubjectHash(cwd);
    expect(after).not.toBe(before);
    expect(definitionFor(after)).not.toBe(definitionFor(before));
  });

  it("rejects every single-field drift in attempt Fixture material", () => {
    const material: FormalFixtureMaterialInput = {
      contract: { schemaVersion: 2, rule: "contract" },
      inputTrace: { schemaVersion: 2, inputs: [] },
      interventionCatalog: [{ kind: "shift_input", deltaTicks: 1 }],
      oracle: { mechanism: "physics", symbol: "_physics_process" },
      sourceText: "extends Node\nfunc _physics_process(): pass\n",
    };
    const expected = {
      fixtureId: asFixtureId("fixture-material"),
      expectedMechanism: "discrete_physics_tunneling" as const,
      expectedSource: {
        virtualPath: "case/main.gd" as const,
        symbol: "_physics_process",
      },
      ...formalFixtureMaterialHashes(material),
    };
    const drifts: readonly [string, FormalFixtureMaterialInput][] = [
      [
        "contractHash",
        { ...material, contract: { schemaVersion: 2, rule: "changed" } },
      ],
      [
        "inputTraceHash",
        { ...material, inputTrace: { schemaVersion: 2, inputs: [1] } },
      ],
      [
        "interventionCatalogHash",
        {
          ...material,
          interventionCatalog: [
            { kind: "shift_input", deltaTicks: 2 },
          ] as JsonValue,
        },
      ],
      [
        "oracleHash",
        {
          ...material,
          oracle: { mechanism: "physics", symbol: "_process" },
        },
      ],
      [
        "aliasMapHash",
        { ...material, sourceText: `${material.sourceText}# drift` },
      ],
    ];
    for (const [field, drift] of drifts) {
      expect(() => assertFormalFixtureMaterialBinding(expected, drift)).toThrow(
        field,
      );
    }
  });
});
