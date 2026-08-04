import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BenchmarkCellAttemptV2Schema,
  BenchmarkCellResultV2Schema,
  BenchmarkExecutionStartedV2Schema,
  asBenchmarkAttemptId,
  asBenchmarkDefinitionId,
  asBenchmarkExecutionId,
  asFixtureId,
  type BenchmarkFixtureSpecV2,
  type JsonValue,
} from "@chronorift/domain";
import {
  benchmarkAttemptHashV2,
  benchmarkCellIdV2,
  createBenchmarkSuiteSpecV2,
  scoreBenchmarkDiagnosisV2,
} from "@chronorift/gamebranch";
import { describe, expect, it } from "vitest";

import { ArtifactIntegrityError } from "./v01-json-artifact-repository.js";
import { contentHash } from "./canonical-json.js";
import { V03BenchmarkJsonArtifactRepository } from "./v03-benchmark-json-artifact-repository.js";

const hash = "a".repeat(64);
const rawManifest = { schemaVersion: 1, proof: "test" } as const;
const rawManifestHash = contentHash(rawManifest);
const fixture = (
  id: string,
  expectedMechanism: BenchmarkFixtureSpecV2["expectedMechanism"],
  symbol: string,
): BenchmarkFixtureSpecV2 => ({
  fixtureId: asFixtureId(id),
  expectedMechanism,
  expectedSource: { virtualPath: "case/main.gd", symbol },
  contractHash: hash,
  inputTraceHash: hash,
  interventionCatalogHash: hash,
  oracleHash: hash,
  aliasMapHash: hash,
});

const fixtures = [
  fixture("opaque-01", "signal_before_receiver_connection", "_process"),
  fixture("opaque-02", "frame_count_used_for_time_window", "_process"),
  fixture("opaque-03", "discrete_physics_tunneling", "_physics_process"),
  fixture(
    "opaque-04",
    "stale_effect_crossed_entity_incarnation",
    "_resolve_pending_effects",
  ),
] as const;

const suite = createBenchmarkSuiteSpecV2({
  schemaVersion: 2,
  subjectHash: hash,
  runnerHash: hash,
  metricSet: "grounded-diagnosis-v2",
  fixtures: [...fixtures],
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
    fixtureId: fixtures[2].fixtureId,
    arm: "chronorift-full",
    repetition: 1,
  },
});

describe("V03BenchmarkJsonArtifactRepository", () => {
  it("round-trips strict definition, execution, attempt, and cell records", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-benchmark-typed-"));
    const repository = new V03BenchmarkJsonArtifactRepository(root);
    const executionId = asBenchmarkExecutionId("benchmark-execution:test");
    const startedAt = "2026-08-05T00:00:00.000Z";
    const execution = BenchmarkExecutionStartedV2Schema.parse({
      schemaVersion: 2,
      suiteId: suite.suiteId,
      definitionId: suite.definitionId,
      executionId,
      selectionHash: hash,
      startedAt,
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
        resolvedModelName: "test",
        resolvedContextWindow: 1_000_000,
        resolvedMaxTokens: 128_000,
        mappedThinkingLevel: "max",
        requestedThinkingLevel: "max",
        os: "linux",
        arch: "x64",
        platform: "linux-x64",
      },
    });
    const cellId = benchmarkCellIdV2(
      suite,
      fixtures[0].fixtureId,
      "chronorift-full",
      1,
    );
    const attemptId = asBenchmarkAttemptId("benchmark-attempt:test");
    const attemptBasis = {
      schemaVersion: 2,
      suiteId: suite.suiteId,
      definitionId: suite.definitionId,
      executionId,
      cellId,
      attemptId,
      fixtureId: fixtures[0].fixtureId,
      arm: "chronorift-full",
      repetition: 1,
      ordinal: 1,
      kind: "initial",
      previousAttemptHash: null,
      startedAt,
      finishedAt: "2026-08-05T00:00:01.000Z",
      progressObserved: true,
      metrics: {
        gameExecutions: 1,
        toolCalls: 1,
        wallTimeMs: 1_000,
        tokens: { input: 1, output: 1, total: 2 },
      },
      outcome: { status: "completed", rawManifestHash },
    } as const;
    const attempt = BenchmarkCellAttemptV2Schema.parse({
      ...attemptBasis,
      attemptHash: benchmarkAttemptHashV2(attemptBasis),
    });
    const cell = BenchmarkCellResultV2Schema.parse({
      schemaVersion: 2,
      suiteId: suite.suiteId,
      definitionId: suite.definitionId,
      executionId,
      cellId,
      fixtureId: fixtures[0].fixtureId,
      arm: "chronorift-full",
      repetition: 1,
      expectedMechanism: fixtures[0].expectedMechanism,
      status: "scored",
      terminalCode: null,
      attemptIds: [attemptId],
      selectedAttemptId: attemptId,
      score: scoreBenchmarkDiagnosisV2({
        proposalId: null,
        candidateExecutionIds: [],
        accessReceiptIds: [],
        expectedMechanism: fixtures[0].expectedMechanism,
        proposedMechanism: fixtures[0].expectedMechanism,
        verdict: "inconclusive",
        sourceLocationCorrect: null,
        sourceGrounded: false,
        confidence: null,
      }),
      metrics: {
        gameExecutions: 1,
        toolCalls: 0,
        wallTimeMs: 1_000,
        tokens: { input: 0, output: 0, total: 0 },
      },
      rawManifestHash,
    });

    await repository.putDefinition(suite);
    await repository.putExecutionStarted(execution);
    await repository.putAttemptStarted({
      schemaVersion: 2,
      suiteId: suite.suiteId,
      definitionId: suite.definitionId,
      executionId,
      cellId,
      attemptId,
      fixtureId: fixtures[0].fixtureId,
      arm: "chronorift-full",
      repetition: 1,
      ordinal: 1,
      kind: "initial",
      previousAttemptHash: null,
      startedAt,
    });
    for (const sequence of [1, 2]) {
      await repository.putAttemptProgress({
        schemaVersion: 2,
        suiteId: suite.suiteId,
        definitionId: suite.definitionId,
        executionId,
        cellId,
        attemptId,
        ordinal: 1,
        sequence,
        observedAt: `2026-08-05T00:00:0${sequence}.000Z`,
        progressObserved: true,
        validationStage:
          sequence === 1
            ? "baseline_completed_unvalidated"
            : "fixture_material_validated",
        metrics: {
          gameExecutions: sequence,
          toolCalls: sequence,
          wallTimeMs: sequence,
          tokens: { input: sequence, output: 0, total: sequence },
        },
        rawManifest: { schemaVersion: 2, sequence },
      });
    }
    await repository.putAttemptFinished({
      schemaVersion: 2,
      attempt,
      terminalCell: cell,
      rawManifest,
    });
    await repository.putCell(cell);

    await expect(repository.getDefinition(suite.definitionId)).resolves.toEqual(
      suite,
    );
    await expect(
      repository.getLatestAttemptProgress(
        suite.definitionId,
        executionId,
        cellId,
        1,
        attemptId,
      ),
    ).resolves.toMatchObject({ sequence: 2, metrics: { toolCalls: 2 } });
    await expect(
      repository.getAttemptFinished(
        suite.definitionId,
        executionId,
        cellId,
        1,
        attemptId,
      ),
    ).resolves.toEqual({
      schemaVersion: 2,
      attempt,
      terminalCell: cell,
      rawManifest,
    });
    await expect(
      repository.getCell(suite.definitionId, executionId, cellId),
    ).resolves.toEqual(cell);
  });

  it("turns a schema-corrupted definition into an integrity error", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-benchmark-schema-"));
    const repository = new V03BenchmarkJsonArtifactRepository(root);
    await repository.putDefinition(suite);
    await writeFile(
      repository.ledger.definitionPath(suite.definitionId),
      JSON.stringify({ ...suite, schemaVersion: 99 }),
    );
    await expect(
      repository.getDefinition(suite.definitionId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("rejects a schema-valid record whose identity does not match its lookup path", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "chronorift-benchmark-identity-"),
    );
    const repository = new V03BenchmarkJsonArtifactRepository(root);
    const other = {
      ...suite,
      definitionId: asBenchmarkDefinitionId("benchmark-definition:other"),
    };
    await repository.ledger.writeDefinition(
      suite.definitionId,
      other as unknown as JsonValue,
    );
    await expect(
      repository.getDefinition(suite.definitionId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });
});
