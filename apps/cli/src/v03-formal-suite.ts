import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  BenchmarkSuiteSpecV3Schema,
  BenchmarkSuiteSpecV2Schema,
  FrozenContractV2Schema,
  type BenchmarkCampaignV1,
  type BenchmarkFixtureSpecV2,
  type BenchmarkFixtureSpecV3,
  type BenchmarkFreezeTagV1,
  type BenchmarkSuiteSpecV2,
  type BenchmarkSuiteSpecV3,
  type JsonValue,
} from "@chronorift/domain";
import {
  assertBenchmarkSuiteSpecV3Integrity,
  assertBenchmarkSuiteSpecV2Integrity,
  createBenchmarkSuiteSpecV3,
  createBenchmarkSuiteSpecV2,
  v03ContractIdFor,
} from "@chronorift/gamebranch";
import {
  V03_FIXTURE_IDS,
  prepareV03GodotFixture,
} from "@chronorift/godot-adapter";
import { canonicalJson, contentHash } from "@chronorift/json-artifacts";

const SUBJECT_ROOTS = [
  "packages/domain/src",
  "packages/gamebranch/src",
  "packages/godot-adapter/src",
  "packages/godot-protocol/src",
  "godot/addons/chronorift",
  "fixtures/godot-switch-door",
  "fixtures/godot-frame-input-window",
  "fixtures/godot-entity-reuse",
  "fixtures/godot-physics-tunneling",
  "packages/pi-harness/src",
  "apps/cli/src/v03-runtime.ts",
  "apps/cli/src/v03-agent-game-api.ts",
] as const;

const RUNNER_ROOTS = [
  "apps/cli/src",
  "packages/gamebranch/src/services/v03-benchmark-v2-service.ts",
  "packages/gamebranch/src/services/v03-benchmark-v3-service.ts",
  "packages/gamebranch/src/ports/v03-benchmark-artifact-repository.ts",
  "packages/gamebranch/src/ports/v03-benchmark-artifact-repository-v3.ts",
  "packages/json-artifacts/src",
] as const;

const isTestFile = (path: string): boolean =>
  path.endsWith(".test.ts") ||
  path.endsWith(".live.test.ts") ||
  path.endsWith(".godot.test.ts");

async function sourceFiles(path: string): Promise<readonly string[]> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Formal benchmark hash input is a symlink: ${path}`);
  }
  if (metadata.isFile()) return isTestFile(path) ? [] : [path];
  if (!metadata.isDirectory()) return [];
  const files: string[] = [];
  for (const entry of await readdir(path)) {
    files.push(...(await sourceFiles(join(path, entry))));
  }
  return files;
}

async function hashRoots(
  cwd: string,
  roots: readonly string[],
): Promise<string> {
  const files = (
    await Promise.all(roots.map((root) => sourceFiles(resolve(cwd, root))))
  )
    .flat()
    .sort();
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(cwd, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export const formalSubjectHash = (cwd: string): Promise<string> =>
  hashRoots(cwd, SUBJECT_ROOTS);

export const formalRunnerHash = (cwd: string): Promise<string> =>
  hashRoots(cwd, RUNNER_ROOTS);

export interface BuildFormalBenchmarkSuiteOptions {
  readonly cwd: string;
  readonly artifactRoot: string;
  readonly godotBin?: string | undefined;
  readonly campaign?: "v0.3.1" | "v0.3.1-r2" | undefined;
}

export interface FormalCampaignDescriptor {
  readonly campaignId: "v0.3" | "v0.3.1" | "v0.3.1-r2";
  readonly freezeTag: BenchmarkFreezeTagV1;
  readonly evidenceDirectory:
    | "docs/benchmarks/v0.3"
    | "docs/benchmarks/v0.3.1"
    | "docs/benchmarks/v0.3.1-r2";
  readonly orderSeed:
    | "chronorift-v0.3-formal-1"
    | "chronorift-v0.3.1-formal-1"
    | "chronorift-v0.3.1-r2-formal-1";
}

export const V032_LUNA_CAMPAIGN = {
  campaignId: "v0.3.2-luna",
  freezeTag: "v0.3.2-luna-benchmark-freeze",
  evidenceDirectory: "docs/benchmarks/v0.3.2-luna",
  orderSeed: "chronorift-v0.3.2-luna-formal-1",
} as const;

export const V032_LUNA_R1_CAMPAIGN = {
  campaignId: "v0.3.2-luna-r1",
  freezeTag: "v0.3.2-luna-r1-benchmark-freeze",
  evidenceDirectory: "docs/benchmarks/v0.3.2-luna-r1",
  orderSeed: "chronorift-v0.3.2-luna-r1-formal-1",
} as const;

type FormalCampaignDescriptorV3 =
  typeof V032_LUNA_CAMPAIGN | typeof V032_LUNA_R1_CAMPAIGN;

export function formalCampaignForSuiteV3(
  suite: BenchmarkSuiteSpecV3,
): FormalCampaignDescriptorV3 {
  return suite.campaign.campaignId === "v0.3.2-luna"
    ? V032_LUNA_CAMPAIGN
    : V032_LUNA_R1_CAMPAIGN;
}

const LEGACY_CAMPAIGN: FormalCampaignDescriptor = {
  campaignId: "v0.3",
  freezeTag: "v0.3.0-benchmark-freeze",
  evidenceDirectory: "docs/benchmarks/v0.3",
  orderSeed: "chronorift-v0.3-formal-1",
};

const V031_CAMPAIGN: FormalCampaignDescriptor = {
  campaignId: "v0.3.1",
  freezeTag: "v0.3.1-benchmark-freeze",
  evidenceDirectory: "docs/benchmarks/v0.3.1",
  orderSeed: "chronorift-v0.3.1-formal-1",
};

const V031_R2_CAMPAIGN: FormalCampaignDescriptor = {
  campaignId: "v0.3.1-r2",
  freezeTag: "v0.3.1-r2-benchmark-freeze",
  evidenceDirectory: "docs/benchmarks/v0.3.1-r2",
  orderSeed: "chronorift-v0.3.1-r2-formal-1",
};

export function formalCampaignForSuite(
  suite: BenchmarkSuiteSpecV2,
): FormalCampaignDescriptor {
  return suite.campaign === undefined
    ? LEGACY_CAMPAIGN
    : suite.campaign.campaignId === "v0.3.1"
      ? V031_CAMPAIGN
      : V031_R2_CAMPAIGN;
}

export interface FormalFixtureMaterialInput {
  readonly contract: JsonValue;
  readonly inputTrace: JsonValue;
  readonly interventionCatalog: JsonValue;
  readonly oracle: JsonValue;
  readonly sourceText: string;
}

export type FormalFixtureMaterialHashes = Pick<
  BenchmarkFixtureSpecV2,
  | "contractHash"
  | "inputTraceHash"
  | "interventionCatalogHash"
  | "oracleHash"
  | "aliasMapHash"
>;

/** Canonical material identity shared by spec construction and every attempt. */
export function formalFixtureMaterialHashes(
  input: FormalFixtureMaterialInput,
): FormalFixtureMaterialHashes {
  return {
    contractHash: contentHash(input.contract),
    inputTraceHash: contentHash(input.inputTrace),
    interventionCatalogHash: contentHash(input.interventionCatalog),
    oracleHash: contentHash(input.oracle),
    aliasMapHash: contentHash({
      virtualPath: "case/main.gd",
      contentHash: createHash("sha256").update(input.sourceText).digest("hex"),
    }),
  };
}

export function assertFormalFixtureMaterialBinding(
  expected: BenchmarkFixtureSpecV2,
  input: FormalFixtureMaterialInput,
): FormalFixtureMaterialHashes {
  const actual = formalFixtureMaterialHashes(input);
  for (const key of [
    "contractHash",
    "inputTraceHash",
    "interventionCatalogHash",
    "oracleHash",
    "aliasMapHash",
  ] as const) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Formal Fixture ${key} does not match the frozen suite`);
    }
  }
  return actual;
}

export async function buildFormalBenchmarkSuiteSpecV2(
  options: BuildFormalBenchmarkSuiteOptions,
): Promise<BenchmarkSuiteSpecV2> {
  const campaign =
    options.campaign === "v0.3.1"
      ? V031_CAMPAIGN
      : options.campaign === "v0.3.1-r2"
        ? V031_R2_CAMPAIGN
        : LEGACY_CAMPAIGN;
  const campaignSpec: BenchmarkCampaignV1 | undefined =
    options.campaign === "v0.3.1"
      ? {
          campaignId: "v0.3.1",
          freezeTag: "v0.3.1-benchmark-freeze",
        }
      : options.campaign === "v0.3.1-r2"
        ? {
            campaignId: "v0.3.1-r2",
            freezeTag: "v0.3.1-r2-benchmark-freeze",
          }
        : undefined;
  const [subjectHash, runnerHash] = await Promise.all([
    formalSubjectHash(options.cwd),
    formalRunnerHash(options.cwd),
  ]);
  const fixtures: BenchmarkFixtureSpecV2[] = [];
  for (const fixtureName of V03_FIXTURE_IDS) {
    const prepared = await prepareV03GodotFixture(fixtureName, {
      cwd: options.cwd,
      artifactRoot: options.artifactRoot,
      ...(options.godotBin === undefined ? {} : { godotBin: options.godotBin }),
    });
    const contract = FrozenContractV2Schema.parse({
      ...prepared.fixture.contractInput,
      contractId: v03ContractIdFor(prepared.fixture.contractInput),
    });
    const sourceText = await readFile(
      resolve(prepared.sourceDirectory, prepared.oracle.sourcePath),
      "utf8",
    );
    const materialHashes = formalFixtureMaterialHashes({
      contract: contract as unknown as JsonValue,
      inputTrace: prepared.fixture.inputTrace as unknown as JsonValue,
      interventionCatalog: prepared.fixture.experiments as unknown as JsonValue,
      oracle: prepared.oracle as unknown as JsonValue,
      sourceText,
    });
    fixtures.push({
      fixtureId: prepared.fixture.fixtureId,
      expectedMechanism: prepared.oracle.mechanismCode,
      expectedSource: {
        virtualPath: "case/main.gd",
        symbol: prepared.oracle.sourceSymbol,
      },
      ...materialHashes,
    });
  }
  const physics = fixtures.find(
    (fixture) => fixture.expectedMechanism === "discrete_physics_tunneling",
  );
  if (physics === undefined)
    throw new Error("Formal physics Fixture is missing");
  return createBenchmarkSuiteSpecV2({
    schemaVersion: 2,
    ...(campaignSpec === undefined ? {} : { campaign: campaignSpec }),
    subjectHash,
    runnerHash,
    metricSet: "grounded-diagnosis-v2",
    fixtures,
    arms: ["generic", "evidence-only", "chronorift-full"],
    repetitions: 3,
    orderSeed: campaign.orderSeed,
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
      fixtureId: physics.fixtureId,
      arm: "chronorift-full",
      repetition: 1,
    },
  });
}

export function parseFormalBenchmarkSuiteSpecV2(
  input: unknown,
): BenchmarkSuiteSpecV2 {
  return assertBenchmarkSuiteSpecV2Integrity(
    BenchmarkSuiteSpecV2Schema.parse(input),
  );
}

export function sameFormalSuite(
  left: BenchmarkSuiteSpecV2,
  right: BenchmarkSuiteSpecV2,
): boolean {
  return (
    canonicalJson(left as unknown as JsonValue) ===
    canonicalJson(right as unknown as JsonValue)
  );
}

export interface BuildFormalBenchmarkSuiteV3Options {
  readonly cwd: string;
  readonly artifactRoot: string;
  readonly godotBin?: string | undefined;
  readonly campaign?: "v0.3.2-luna" | "v0.3.2-luna-r1" | undefined;
}

export function assertFormalFixtureMaterialBindingV3(
  expected: BenchmarkFixtureSpecV3,
  input: FormalFixtureMaterialInput,
): FormalFixtureMaterialHashes {
  return assertFormalFixtureMaterialBinding(expected, input);
}

export async function buildFormalBenchmarkSuiteSpecV3(
  options: BuildFormalBenchmarkSuiteV3Options,
): Promise<BenchmarkSuiteSpecV3> {
  const campaign =
    options.campaign === "v0.3.2-luna-r1"
      ? V032_LUNA_R1_CAMPAIGN
      : V032_LUNA_CAMPAIGN;
  const campaignIdentity =
    campaign.campaignId === "v0.3.2-luna"
      ? {
          campaignId: campaign.campaignId,
          freezeTag: campaign.freezeTag,
        }
      : {
          campaignId: campaign.campaignId,
          freezeTag: campaign.freezeTag,
        };
  const [subjectHash, runnerHash] = await Promise.all([
    formalSubjectHash(options.cwd),
    formalRunnerHash(options.cwd),
  ]);
  const fixtures: BenchmarkFixtureSpecV3[] = [];
  for (const fixtureName of V03_FIXTURE_IDS) {
    const prepared = await prepareV03GodotFixture(fixtureName, {
      cwd: options.cwd,
      artifactRoot: options.artifactRoot,
      ...(options.godotBin === undefined ? {} : { godotBin: options.godotBin }),
    });
    const contract = FrozenContractV2Schema.parse({
      ...prepared.fixture.contractInput,
      contractId: v03ContractIdFor(prepared.fixture.contractInput),
    });
    const sourceText = await readFile(
      resolve(prepared.sourceDirectory, prepared.oracle.sourcePath),
      "utf8",
    );
    fixtures.push({
      fixtureId: prepared.fixture.fixtureId,
      expectedMechanism: prepared.oracle.mechanismCode,
      expectedSource: {
        virtualPath: "case/main.gd",
        symbol: prepared.oracle.sourceSymbol,
      },
      ...formalFixtureMaterialHashes({
        contract: contract as unknown as JsonValue,
        inputTrace: prepared.fixture.inputTrace as unknown as JsonValue,
        interventionCatalog: prepared.fixture
          .experiments as unknown as JsonValue,
        oracle: prepared.oracle as unknown as JsonValue,
        sourceText,
      }),
    });
  }
  const physics = fixtures.find(
    (fixture) => fixture.expectedMechanism === "discrete_physics_tunneling",
  );
  if (physics === undefined) {
    throw new Error("Formal physics Fixture is missing");
  }
  return createBenchmarkSuiteSpecV3({
    schemaVersion: 3,
    campaign: campaignIdentity,
    subjectHash,
    runnerHash,
    metricSet: "grounded-diagnosis-v3",
    fixtures,
    arms: ["generic", "evidence-only", "chronorift-full"],
    repetitions: 3,
    orderSeed: campaign.orderSeed,
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
      fixtureId: physics.fixtureId,
      arm: "chronorift-full",
      repetition: 1,
    },
  });
}

export function parseFormalBenchmarkSuiteSpecV3(
  input: unknown,
): BenchmarkSuiteSpecV3 {
  return assertBenchmarkSuiteSpecV3Integrity(
    BenchmarkSuiteSpecV3Schema.parse(input),
  );
}

export function sameFormalSuiteV3(
  left: BenchmarkSuiteSpecV3,
  right: BenchmarkSuiteSpecV3,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
