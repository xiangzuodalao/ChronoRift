import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

import {
  BenchmarkCellAttemptV3Schema,
  BenchmarkCellResultV3Schema,
  BenchmarkCellScoringProofV3Schema,
  BenchmarkInfrastructureFailureV3Schema,
  BenchmarkProvenanceV3Schema,
  BenchmarkRawAttemptManifestV3Schema,
  BenchmarkSuiteSpecV3Schema,
  asBenchmarkExecutionId,
  asCapsuleId,
  asCheckpointId,
  asContractId,
  asEvidenceAccessReceiptId,
  asEventId,
  asExecutionId,
  asFixtureId,
  asInputTraceId,
  asProposalId,
  asRunId,
  asVerdictId,
  benchmarkProgressHasDiagnosticActivityV3,
  type BenchmarkAttemptProgressStateV3,
  type BenchmarkAttemptProgressV3,
  type BenchmarkCellAttemptV3,
  type BenchmarkCellMetricsV3,
  type BenchmarkCellResultV3,
  type BenchmarkCellScoringProofV3,
  type BenchmarkInfrastructureFailureV3,
  type BenchmarkProvenanceV3,
  type BenchmarkSuiteSpecV3,
  type EvidenceAccessReceiptV1,
  type JsonValue,
  type MechanismCodeV2,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import {
  assertBenchmarkAttemptProgressSequenceV3,
  assertBenchmarkCellScoringProofV3Integrity,
  assertBenchmarkRawAttemptManifestV3Integrity,
  assertBenchmarkAttemptBudgetsV3,
  benchmarkAttemptHashV3,
  benchmarkAttemptIdV3,
  benchmarkCellOrderV3,
  benchmarkReportHashV3,
  buildBenchmarkReportV3,
  createBenchmarkSuiteSpecV3,
  diagnosticFailureScoreV3,
  evaluateBenchmarkGateV3,
  scoreBenchmarkDiagnosisV3,
  verifyBenchmarkReportV2,
  verifyBenchmarkReportV3,
  canonicalStringify,
} from "../src/index.js";

const hash = (character: string): string => character.repeat(64);
const hashJson = (value: unknown): string =>
  createHash("sha256")
    .update(canonicalStringify(value as JsonValue))
    .digest("hex");
const mechanisms = [
  "signal_before_receiver_connection",
  "frame_count_used_for_time_window",
  "discrete_physics_tunneling",
  "stale_effect_crossed_entity_incarnation",
] as const satisfies readonly Exclude<MechanismCodeV2, "unknown">[];

const suite = (
  campaignId: "v0.3.2-luna" | "v0.3.2-luna-r1" = "v0.3.2-luna",
): BenchmarkSuiteSpecV3 => {
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
    subjectHash: hash("a"),
    runnerHash: hash("b"),
    metricSet: "grounded-diagnosis-v3",
    fixtures: mechanisms.map((expectedMechanism, index) => ({
      fixtureId: asFixtureId(`opaque-fixture-${index + 1}`),
      expectedMechanism,
      expectedSource: {
        virtualPath: "case/main.gd",
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
      fixtureId: asFixtureId("opaque-fixture-3"),
      arm: "chronorift-full",
      repetition: 1,
    },
  });
};

const provenance: BenchmarkProvenanceV3 = {
  gitCommit: "a".repeat(40),
  freezeTag: "v0.3.2-luna-benchmark-freeze",
  dirty: false,
  lockfileHash: hash("2"),
  piPackageVersion: "0.83.0",
  nodeVersion: "22.23.1",
  pnpmVersion: "10.0.0",
  godotVersion: "4.5.1",
  godotExecutableHash: hash("3"),
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
};

const zeroTokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
} as const;

const progress = (
  overrides: Partial<BenchmarkAttemptProgressStateV3> = {},
): BenchmarkAttemptProgressStateV3 => ({
  fixtureStage: overrides.fixtureStage ?? "fixture_validated",
  model: overrides.model ?? {
    requestStarted: true,
    outputObserved: true,
    turnCompleted: true,
  },
  tools: overrides.tools ?? {
    started: 1,
    completed: 1,
    failed: 0,
    semanticRevision: 1,
  },
  game: overrides.game ?? {
    baselineExecutions: 1,
    diagnosticExecutions: 0,
  },
  proposalSubmitted: overrides.proposalSubmitted ?? true,
});

const completedRawAttempt = (spec: BenchmarkSuiteSpecV3) => {
  const ordered = benchmarkCellOrderV3(spec)[0]!;
  const fixture = spec.fixtures.find(
    (candidate) => candidate.fixtureId === ordered.fixtureId,
  )!;
  const executionId = asBenchmarkExecutionId(
    "benchmark-execution:raw-manifest",
  );
  const attemptId = benchmarkAttemptIdV3(executionId, ordered.cellId, 1);
  const runId = asRunId("run:raw-manifest");
  const capsuleId = asCapsuleId("capsule:raw-manifest");
  const baselineExecutionId = asExecutionId("execution:raw-baseline");
  const contractId = asContractId("contract:raw-manifest");
  const checkpointId = asCheckpointId("checkpoint:raw-manifest");
  const inputTraceId = asInputTraceId("trace:raw-manifest");
  const eventId = asEventId("event:raw-trigger");
  const proposalId = asProposalId("proposal:raw-manifest");
  const receiptBasis = {
    schemaVersion: 1 as const,
    runId,
    fixtureId: fixture.fixtureId,
    accessKind: "failure_brief" as const,
    resourceId: capsuleId,
    requestHash: hash("2"),
    contentHash: hash("3"),
    sourceCoverage: [],
    issuedAt: "2026-08-05T00:00:00.000Z",
  };
  const receiptId = asEvidenceAccessReceiptId(
    `receipt:v1:${hashJson({
      runId: receiptBasis.runId,
      fixtureId: receiptBasis.fixtureId,
      accessKind: receiptBasis.accessKind,
      resourceId: receiptBasis.resourceId,
      requestHash: receiptBasis.requestHash,
      contentHash: receiptBasis.contentHash,
      sourceCoverage: receiptBasis.sourceCoverage,
    })}`,
  );
  const receipt = { ...receiptBasis, receiptId };
  const terminalProgress = progress();
  const metrics: BenchmarkCellMetricsV3 = {
    gameExecutions: 1,
    toolCalls: 1,
    wallTimeMs: 100,
    tokens: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3 },
  };
  const observationHealth = {
    schemaVersion: 1 as const,
    emittedEvents: 0,
    droppedEvents: 0,
    truncatedEvents: 0,
    bufferedBytes: 0,
    backpressure: false,
    probeOverheadUs: 0,
  };
  const caseEvidence = {
    schemaVersion: 2 as const,
    contract: { contractId, contentHash: fixture.contractHash },
    checkpoint: {
      checkpointId,
      contentHash: hash("5"),
      certificateHash: null,
      certificate: null,
    },
    inputTrace: { inputTraceId, contentHash: fixture.inputTraceHash },
    capsule: {
      capsuleId,
      contentHash: hash("7"),
      timelineDigest: hash("8"),
      eventChainHash: hash("9"),
      evidenceLinks: [],
      causalEvents: [],
      omittedRuntimeLogCount: 0,
      expected: {
        kind: "property_equals" as const,
        path: "door.open",
        value: true,
      },
      actual: { present: true as const, value: false },
      eventLossDetected: false,
      limitationsHash: hash("a"),
    },
    baseline: {
      executionId: baselineExecutionId,
      contractId,
      checkpointId,
      inputTraceId,
      evaluationStatus: "fail" as const,
      evaluation: {
        status: "fail" as const,
        triggerEventId: eventId,
        triggerTick: 0,
        deadlineTick: 1,
        observed: { present: true as const, value: false },
      },
      timelineDigest: hash("8"),
      contentHash: hash("b"),
      restoreReceiptHash: hash("c"),
      controlReceiptHash: hash("d"),
      stepReceiptsHash: hash("e"),
      observationHealthHash: hash("f"),
      finalStateHash: hash("1"),
      finalState: { values: { "door.open": false } },
      runtimeFingerprintHash: hash("2"),
      timelineMatchesBaseline: true,
      restoreReceipt: {
        requestedCheckpointId: checkpointId,
        restoredCheckpointId: checkpointId,
        restored: true as const,
        nextTick: 0,
        simTimeUs: 0,
        stateDigest: hash("3"),
      },
      controlReceipt: {
        schemaVersion: 1 as const,
        requested: {},
        realized: {},
        accepted: true,
        mismatches: [],
      },
      stepReceipts: [
        {
          requestedTick: 0,
          realizedTick: 0,
          requestedDeltaUs: 1,
          realizedDeltaUs: 1,
          appliedInputOrders: [],
        },
      ],
      observationHealth,
      causalEvents: [],
    },
    replay: null,
    candidates: [],
    comparisons: [],
    accessReceipts: [receipt],
  };
  const manifest = BenchmarkRawAttemptManifestV3Schema.parse({
    schemaVersion: 3,
    manifestKind: "benchmark_attempt_terminal",
    terminalStatus: "completed",
    suiteId: spec.suiteId,
    definitionId: spec.definitionId,
    executionId,
    cellId: ordered.cellId,
    attemptId,
    fixtureId: fixture.fixtureId,
    arm: ordered.arm,
    repetition: ordered.repetition,
    ordinal: 1,
    runId,
    promptAudit: {
      failureBriefHash: receipt.contentHash,
      failureBriefReceiptId: receiptId,
      systemHash: hash("2"),
      userHash: hash("3"),
      baselineTimelineDigest: caseEvidence.baseline.timelineDigest,
      checkpointId,
      checkpointHash: caseEvidence.checkpoint.contentHash,
      contractId,
      contractHash: caseEvidence.contract.contentHash,
      inputTraceId,
      inputTraceHash: caseEvidence.inputTrace.contentHash,
      runtimeFingerprintHash: caseEvidence.baseline.runtimeFingerprintHash,
      sourceViewHash: fixture.aliasMapHash,
      experimentCatalogHash: fixture.interventionCatalogHash,
      oracleHash: fixture.oracleHash,
    },
    caseEvidence,
    progress: terminalProgress,
    metrics,
    oracle: {
      oracleHash: fixture.oracleHash,
      expectedMechanism: fixture.expectedMechanism,
      expectedSource: fixture.expectedSource,
    },
    proposal: {
      schemaVersion: 3,
      proposalId,
      runId,
      fixtureId: fixture.fixtureId,
      capsuleId,
      baselineExecutionId,
      candidateExecutionIds: [],
      comparisonIds: [],
      accessReceiptIds: [receiptId],
      mechanismCode: fixture.expectedMechanism,
      summary: "Evidence remains incomplete",
      evidenceEventIds: [],
      blockers: ["A replay and intervention are required"],
      nextExperiment: "Run one intervention",
      confidence: 1,
    },
    accessReceipts: [receipt],
    verdict: {
      schemaVersion: 2,
      verdictId: asVerdictId("verdict:raw-manifest"),
      proposalId,
      runId,
      fixtureId: fixture.fixtureId,
      status: "inconclusive",
      mechanismCode: fixture.expectedMechanism,
      summary: "Evidence is insufficient for a canonical diagnosis",
      blockers: ["A replay and intervention are required"],
    },
  });
  const attemptBasis: Omit<BenchmarkCellAttemptV3, "attemptHash"> = {
    schemaVersion: 3,
    suiteId: spec.suiteId,
    definitionId: spec.definitionId,
    executionId,
    cellId: ordered.cellId,
    attemptId,
    fixtureId: fixture.fixtureId,
    arm: ordered.arm,
    repetition: ordered.repetition,
    ordinal: 1,
    kind: "initial",
    previousAttemptHash: null,
    startedAt: "2026-08-05T00:00:00.000Z",
    finishedAt: "2026-08-05T00:00:01.000Z",
    progress: terminalProgress,
    metrics,
    outcome: {
      status: "completed",
      rawManifestHash: hashJson(manifest),
    },
  };
  const attempt = BenchmarkCellAttemptV3Schema.parse({
    ...attemptBasis,
    attemptHash: benchmarkAttemptHashV3(attemptBasis),
  });
  return { attempt, manifest };
};

const evidenceReceipt = (
  scope: Pick<EvidenceAccessReceiptV1, "runId" | "fixtureId">,
  accessKind: EvidenceAccessReceiptV1["accessKind"],
  resourceId: string,
  ordinal: number,
): EvidenceAccessReceiptV1 => {
  const basis = {
    schemaVersion: 1 as const,
    runId: scope.runId,
    fixtureId: scope.fixtureId,
    accessKind,
    resourceId,
    requestHash: hashJson({ accessKind, resourceId, ordinal, request: true }),
    contentHash: hashJson({ accessKind, resourceId, ordinal, content: true }),
    sourceCoverage: [],
    issuedAt: "2026-08-05T00:00:00.000Z",
  };
  return {
    ...basis,
    receiptId: asEvidenceAccessReceiptId(
      `receipt:v1:${hashJson({
        runId: basis.runId,
        fixtureId: basis.fixtureId,
        accessKind: basis.accessKind,
        resourceId: basis.resourceId,
        requestHash: basis.requestHash,
        contentHash: basis.contentHash,
        sourceCoverage: basis.sourceCoverage,
      })}`,
    ),
  };
};

const attemptBoundToManifest = (
  attempt: BenchmarkCellAttemptV3,
  manifest: ReturnType<typeof completedRawAttempt>["manifest"],
): BenchmarkCellAttemptV3 => {
  const { attemptHash: _attemptHash, ...oldBasis } = attempt;
  void _attemptHash;
  const basis = {
    ...oldBasis,
    outcome: {
      status: "completed" as const,
      rawManifestHash: hashJson(manifest),
    },
  };
  return BenchmarkCellAttemptV3Schema.parse({
    ...basis,
    attemptHash: benchmarkAttemptHashV3(basis),
  });
};

const scoringProofFor = (
  spec: BenchmarkSuiteSpecV3,
  cell: ReturnType<typeof benchmarkCellOrderV3>[number],
  attemptId: BenchmarkCellAttemptV3["attemptId"],
  rawManifestHash: string,
  confirmed: boolean,
): {
  readonly proof: BenchmarkCellScoringProofV3;
  readonly score: BenchmarkCellResultV3["score"];
} => {
  const fixture = spec.fixtures.find(
    (candidate) => candidate.fixtureId === cell.fixtureId,
  )!;
  const suffix = hashJson({ cellId: cell.cellId }).slice(0, 12);
  const runId = asRunId(`run:proof:${suffix}`);
  const capsuleId = asCapsuleId(`capsule:proof:${suffix}`);
  const baselineId = asExecutionId(`execution:proof:baseline:${suffix}`);
  const replayId = asExecutionId(`execution:proof:replay:${suffix}`);
  const candidateId = asExecutionId(`execution:proof:candidate:${suffix}`);
  const comparisonId = `comparison:proof:${suffix}`;
  const contractId = asContractId(`contract:proof:${suffix}`);
  const checkpointId = asCheckpointId(`checkpoint:proof:${suffix}`);
  const inputTraceId = asInputTraceId(`trace:proof:${suffix}`);
  const event = (
    name: string,
    seq: number,
    detail: Record<string, unknown>,
  ) => ({
    eventId: asEventId(`event:proof:${suffix}:${name}`),
    role: "agent_citation" as const,
    seq,
    tick: seq,
    simTimeUs: seq,
    causedByEventId: null,
    contentHash: hashJson({ suffix, name, detail }),
    ...detail,
  });
  let baselineEvents: readonly Record<string, unknown>[] = [];
  let candidateEvents: readonly Record<string, unknown>[] = [];
  let baselineControls: Record<string, boolean | number | null> = {};
  let candidateControls: Record<string, boolean | number | null> = {};
  if (fixture.expectedMechanism === "signal_before_receiver_connection") {
    const input = event("input", 0, {
      kind: "input",
      action: "interact_switch",
      target: "switch",
      requestedTick: 0,
      realizedTick: 0,
    });
    const failed = event("failed", 1, {
      kind: "signal_delivery",
      source: "switch",
      name: "activated",
      receiver: "door",
      delivered: false,
      failureReason: "receiver_not_connected",
      sourceEntity: null,
      receiverEntity: null,
    });
    const connected = event("connected", 2, {
      kind: "property_changed",
      path: "door.receiver_connected",
      before: false,
      after: true,
      entity: null,
    });
    const candidateInput = event("candidate-input", 0, {
      kind: "input",
      action: "interact_switch",
      target: "switch",
      requestedTick: 1,
      realizedTick: 1,
    });
    const delivered = {
      ...event("delivered", 1, {
        kind: "signal_delivery",
        source: "switch",
        name: "activated",
        receiver: "door",
        delivered: true,
        failureReason: null,
        sourceEntity: null,
        receiverEntity: null,
      }),
      causedByEventId: candidateInput.eventId,
    };
    const opened = {
      ...event("opened", 2, {
        kind: "property_changed",
        path: "door.open",
        before: false,
        after: true,
        entity: null,
      }),
      causedByEventId: delivered.eventId,
    };
    baselineEvents = [input, failed, connected];
    candidateEvents = [candidateInput, delivered, opened];
  } else if (fixture.expectedMechanism === "frame_count_used_for_time_window") {
    const opened = event("opened", 0, {
      kind: "property_changed",
      path: "player.window_open",
      before: false,
      after: true,
      entity: null,
    });
    const closed = event("closed", 1, {
      kind: "property_changed",
      path: "player.window_open",
      before: true,
      after: false,
      entity: null,
    });
    const rejected = event("rejected", 2, {
      kind: "input",
      action: "attempt_jump",
      target: "player",
      requestedTick: 2,
      realizedTick: 2,
    });
    const candidateOpened = event("candidate-opened", 0, {
      kind: "property_changed",
      path: "player.window_open",
      before: false,
      after: true,
      entity: null,
    });
    const accepted = event("accepted", 1, {
      kind: "input",
      action: "attempt_jump",
      target: "player",
      requestedTick: 1,
      realizedTick: 1,
    });
    const jumped = {
      ...event("jumped", 2, {
        kind: "property_changed",
        path:
          fixture.expectedMechanism === "frame_count_used_for_time_window"
            ? "player.jumping"
            : "unused",
        before: false,
        after: true,
        entity: null,
      }),
      causedByEventId: accepted.eventId,
    };
    baselineEvents = [opened, closed, rejected];
    candidateEvents = [candidateOpened, accepted, jumped];
    baselineControls = { fixed_fps: 60 };
    candidateControls = { fixed_fps: 30 };
  } else if (fixture.expectedMechanism === "discrete_physics_tunneling") {
    const fired = event("fired", 0, {
      kind: "signal",
      source: "projectile",
      name: "projectile.fired",
      sourceEntity: null,
    });
    const crossed = {
      ...event("crossed", 1, {
        kind: "property_changed",
        path: "projectile.x",
        before: 0,
        after: 10,
        entity: null,
      }),
      causedByEventId: fired.eventId,
    };
    const crossedSample = {
      ...event("crossed-sample", 2, {
        kind: "spatial_sample",
        entity: { stableId: "projectile", incarnation: 1 },
        position: [10, 0],
      }),
      causedByEventId: crossed.eventId,
    };
    const candidateFire = event("candidate-fired", 0, {
      kind: "signal",
      source: "projectile",
      name: "projectile.fired",
      sourceEntity: null,
    });
    const sample = {
      ...event("sample", 1, {
        kind: "spatial_sample",
        entity: { stableId: "target", incarnation: 1 },
        position: [5, 0],
      }),
      causedByEventId: candidateFire.eventId,
    };
    const hit = {
      ...event("hit", 2, {
        kind: "property_changed",
        path: "target.hit",
        before: false,
        after: true,
        entity: null,
      }),
      causedByEventId: sample.eventId,
    };
    baselineEvents = [fired, crossed, crossedSample];
    candidateEvents = [candidateFire, sample, hit];
    baselineControls = { physics_ticks_per_second: 60 };
    candidateControls = { physics_ticks_per_second: 120 };
  } else {
    const scheduled = event("scheduled", 0, {
      kind: "pending_effect",
      action: "scheduled",
      effectId: "damage:1",
      target: { stableId: "enemy", incarnation: 1 },
      resolvedTarget: null,
      dueTick: 1,
      reason: null,
    });
    const despawned = {
      ...event("despawned", 1, {
        kind: "entity_lifecycle",
        action: "despawned",
        entity: { stableId: "enemy", incarnation: 1 },
      }),
      causedByEventId: scheduled.eventId,
    };
    const spawned = {
      ...event("spawned", 2, {
        kind: "entity_lifecycle",
        action: "spawned",
        entity: { stableId: "enemy", incarnation: 2 },
      }),
      causedByEventId: despawned.eventId,
    };
    const applied = {
      ...event("applied", 3, {
        kind: "pending_effect",
        action: "applied",
        effectId: "damage:1",
        target: { stableId: "enemy", incarnation: 1 },
        resolvedTarget: { stableId: "enemy", incarnation: 2 },
        dueTick: 1,
        reason: null,
      }),
      causedByEventId: spawned.eventId,
    };
    const mutation = {
      ...event("mutation", 4, {
        kind: "property_changed",
        path: "enemy.health",
        before: 100,
        after: 90,
        entity: null,
      }),
      causedByEventId: applied.eventId,
    };
    const discarded = event("discarded", 0, {
      kind: "pending_effect",
      action: "discarded",
      effectId: "damage:1",
      target: { stableId: "enemy", incarnation: 1 },
      resolvedTarget: null,
      dueTick: 1,
      reason: "owner_destroyed",
    });
    baselineEvents = [scheduled, despawned, spawned, applied, mutation];
    candidateEvents = [discarded];
    baselineControls = { "fixture.pooling_enabled": true };
    candidateControls = { "fixture.pooling_enabled": false };
  }
  const health = {
    schemaVersion: 1 as const,
    emittedEvents: 0,
    droppedEvents: 0,
    truncatedEvents: 0,
    bufferedBytes: 0,
    backpressure: false,
    probeOverheadUs: 0,
  };
  const executionEvidence = (
    executionId: ReturnType<typeof asExecutionId>,
    status: "pass" | "fail",
    events: readonly Record<string, unknown>[],
    controls: Readonly<Record<string, boolean | number | null>>,
  ) => ({
    executionId,
    contractId,
    checkpointId,
    inputTraceId,
    evaluationStatus: status,
    evaluation: {
      status,
      triggerEventId: asEventId(`event:proof:${suffix}:trigger`),
      triggerTick: 0,
      deadlineTick: 1,
      observed: { present: true as const, value: status === "pass" },
      ...(status === "pass" ? { satisfiedTick: 1 } : {}),
    },
    timelineDigest: hashJson({ executionId }),
    contentHash: hashJson({ executionId, content: true }),
    restoreReceiptHash: hash("1"),
    controlReceiptHash: hash("2"),
    stepReceiptsHash: hash("3"),
    observationHealthHash: hash("4"),
    finalStateHash: hash("5"),
    finalState: {
      values: {
        ...(fixture.expectedMechanism === "frame_count_used_for_time_window"
          ? { "player.process_callbacks": 1 }
          : {}),
      },
    },
    runtimeFingerprintHash: hash("6"),
    timelineMatchesBaseline: executionId !== candidateId,
    restoreReceipt: {
      requestedCheckpointId: checkpointId,
      restoredCheckpointId: checkpointId,
      restored: true as const,
      nextTick: 0,
      simTimeUs: 0,
      stateDigest: hash("7"),
    },
    controlReceipt: {
      schemaVersion: 1 as const,
      requested: controls,
      realized: controls,
      accepted: true,
      mismatches: [],
    },
    stepReceipts: [
      {
        requestedTick: 0,
        realizedTick: 0,
        requestedDeltaUs: 1,
        realizedDeltaUs: 1,
        appliedInputOrders: [],
        ...(fixture.expectedMechanism === "frame_count_used_for_time_window"
          ? {
              runtime: {
                schemaVersion: 1 as const,
                phase: "process_frame_start" as const,
                idleFramesExecuted: 1,
                physicsTicksExecuted: 1,
                actualIdleDeltasUs: [1],
                actualPhysicsDeltasUs: [1],
                engineProcessFrame: 1,
                enginePhysicsFrame: 1,
                hostMonotonicStartUs: 0,
                hostMonotonicEndUs: 1,
                inputApplications: [],
                observationHealth: health,
              },
            }
          : {}),
      },
    ],
    observationHealth: health,
    causalEvents: events,
  });
  const baseline = executionEvidence(
    baselineId,
    "fail",
    baselineEvents,
    baselineControls,
  );
  const replay = executionEvidence(
    replayId,
    "fail",
    baselineEvents,
    baselineControls,
  );
  const candidate = executionEvidence(
    candidateId,
    "pass",
    candidateEvents,
    candidateControls,
  );
  const receipt = (
    accessKind: "failure_brief" | "replay" | "experiment" | "comparison",
    resourceId: string,
  ) => {
    const basis = {
      schemaVersion: 1 as const,
      runId,
      fixtureId: fixture.fixtureId,
      accessKind,
      resourceId,
      requestHash: hash("8"),
      contentHash: hash("9"),
      sourceCoverage: [],
      issuedAt: "2026-08-05T00:00:00.000Z",
    };
    return {
      ...basis,
      receiptId: asEvidenceAccessReceiptId(
        `receipt:v1:${hashJson({
          runId: basis.runId,
          fixtureId: basis.fixtureId,
          accessKind: basis.accessKind,
          resourceId: basis.resourceId,
          requestHash: basis.requestHash,
          contentHash: basis.contentHash,
          sourceCoverage: basis.sourceCoverage,
        })}`,
      ),
    };
  };
  const receipts = [
    receipt("failure_brief", capsuleId),
    ...(confirmed
      ? [
          receipt("replay", replayId),
          receipt("experiment", candidateId),
          receipt("comparison", comparisonId),
        ]
      : []),
  ];
  const proposalId = asProposalId(`proposal:proof:${suffix}`);
  const evidenceEventIds = confirmed
    ? [
        ...baselineEvents.map((item) => item["eventId"] as string),
        ...candidateEvents.map((item) => item["eventId"] as string),
      ]
    : [];
  const capsuleEvents: readonly Record<string, unknown>[] = baselineEvents.map(
    (item) => {
      const kind = item["kind"];
      const role =
        kind === "signal_delivery"
          ? "delivery"
          : kind === "property_changed"
            ? "state_transition"
            : kind === "entity_lifecycle"
              ? "lifecycle"
              : kind === "spatial_sample"
                ? "spatial_sample"
                : kind === "pending_effect"
                  ? "pending_effect"
                  : "trigger";
      return { ...item, role };
    },
  );
  const caseEvidence = {
    schemaVersion: 2 as const,
    contract: { contractId, contentHash: hash("a") },
    checkpoint: {
      checkpointId,
      contentHash: hash("b"),
      certificateHash: null,
      certificate: null,
    },
    inputTrace: { inputTraceId, contentHash: hash("c") },
    capsule: {
      capsuleId,
      contentHash: hash("d"),
      timelineDigest: baseline.timelineDigest,
      eventChainHash: hash("e"),
      evidenceLinks: capsuleEvents.map((item) => ({
        role: item["role"],
        eventId: item["eventId"],
      })),
      causalEvents: capsuleEvents,
      omittedRuntimeLogCount: 0,
      expected: {
        kind: "property_equals" as const,
        path:
          fixture.expectedMechanism === "frame_count_used_for_time_window"
            ? "player.jumping"
            : fixture.expectedMechanism === "discrete_physics_tunneling"
              ? "target.hit"
              : fixture.expectedMechanism ===
                  "stale_effect_crossed_entity_incarnation"
                ? "enemy.health"
                : "door.open",
        value:
          fixture.expectedMechanism ===
          "stale_effect_crossed_entity_incarnation"
            ? 100
            : true,
      },
      actual: { present: true as const, value: false },
      eventLossDetected: false,
      limitationsHash: hash("f"),
    },
    baseline,
    replay: confirmed ? replay : null,
    candidates: confirmed ? [candidate] : [],
    comparisons: confirmed
      ? [
          {
            comparisonId,
            baselineExecutionId: baselineId,
            candidateExecutionId: candidateId,
            interventionId: `intervention:proof:${suffix}`,
            baselineOutcome: "fail" as const,
            candidateOutcome: "pass" as const,
            comparable: true,
            blockersHash: hash("1"),
            firstDivergenceTick: 1,
            contentHash: hash("2"),
          },
        ]
      : [],
    accessReceipts: receipts,
  };
  const proof = BenchmarkCellScoringProofV3Schema.parse({
    schemaVersion: 3,
    proofKind: "scored",
    cellId: cell.cellId,
    selectedAttemptId: attemptId,
    rawManifestHash,
    caseEvidence,
    proposal: {
      proposalId,
      runId,
      fixtureId: fixture.fixtureId,
      capsuleId,
      baselineExecutionId: baselineId,
      replayExecutionId: confirmed ? replayId : null,
      candidateExecutionIds: confirmed ? [candidateId] : [],
      comparisonIds: confirmed ? [comparisonId] : [],
      accessReceiptIds: receipts.map((item) => item.receiptId),
      mechanismCode: confirmed ? fixture.expectedMechanism : "unknown",
      evidenceEventIds,
      suspectedSource: null,
      hasBlockers: !confirmed,
      confidence: 0,
    },
    accessReceipts: receipts,
    verdict: {
      verdictId: asVerdictId(`verdict:proof:${suffix}`),
      proposalId,
      runId,
      fixtureId: fixture.fixtureId,
      status: confirmed ? "confirmed" : "inconclusive",
      mechanismCode: confirmed ? fixture.expectedMechanism : "unknown",
      blockerCount: confirmed ? 0 : 1,
    },
    oracle: {
      oracleHash: fixture.oracleHash,
      expectedMechanism: fixture.expectedMechanism,
      expectedSource: fixture.expectedSource,
    },
  });
  return {
    proof,
    score: scoreBenchmarkDiagnosisV3({
      proposalId,
      candidateExecutionIds: confirmed ? [candidateId] : [],
      accessReceiptIds: receipts.map((item) => item.receiptId),
      expectedMechanism: fixture.expectedMechanism,
      proposedMechanism: confirmed ? fixture.expectedMechanism : "unknown",
      verdict: confirmed ? "confirmed" : "inconclusive",
      sourceLocationCorrect: null,
      sourceGrounded: false,
      confidence: 0,
    }),
  };
};

interface MatrixOptions {
  readonly genericSuccesses: number;
  readonly fullSuccesses: number;
  readonly infraCellIndex?: number | undefined;
  readonly diagnosticCellIndex?: number | undefined;
}

const matrix = (
  spec: BenchmarkSuiteSpecV3,
  options: MatrixOptions,
): {
  readonly attempts: readonly BenchmarkCellAttemptV3[];
  readonly cells: readonly BenchmarkCellResultV3[];
  readonly scoringProofs: readonly BenchmarkCellScoringProofV3[];
} => {
  const executionId = asBenchmarkExecutionId("benchmark-execution:v3-test");
  const attempts: BenchmarkCellAttemptV3[] = [];
  const cells: BenchmarkCellResultV3[] = [];
  const scoringProofs: BenchmarkCellScoringProofV3[] = [];
  const armIndexes = new Map<string, number>();
  const fixtures = new Map(
    spec.fixtures.map((fixture) => [fixture.fixtureId, fixture] as const),
  );
  for (const [globalIndex, ordered] of benchmarkCellOrderV3(spec).entries()) {
    const fixture = fixtures.get(ordered.fixtureId);
    if (fixture === undefined) throw new Error("Missing test Fixture");
    const armIndex = armIndexes.get(ordered.arm) ?? 0;
    armIndexes.set(ordered.arm, armIndex + 1);
    const rawManifestHash = hash("9");
    const attemptId = benchmarkAttemptIdV3(executionId, ordered.cellId, 1);
    const startedAt = new Date(
      Date.UTC(2026, 7, 5) + globalIndex * 2_000,
    ).toISOString();
    const finishedAt = new Date(
      Date.UTC(2026, 7, 5) + globalIndex * 2_000 + 1_000,
    ).toISOString();
    const isInfra = options.infraCellIndex === globalIndex;
    const isDiagnostic = options.diagnosticCellIndex === globalIndex;
    const shouldSucceed =
      ordered.arm === "chronorift-full"
        ? armIndex < options.fullSuccesses
        : ordered.arm === "generic"
          ? armIndex < options.genericSuccesses
          : false;
    const metrics: BenchmarkCellMetricsV3 = {
      gameExecutions: 1,
      toolCalls: isInfra ? 0 : 1,
      wallTimeMs: 1_000,
      tokens: isInfra
        ? { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 }
        : { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3 },
    };
    const attemptProgress = isInfra
      ? progress({
          model: {
            requestStarted: true,
            outputObserved: true,
            turnCompleted: false,
          },
          tools: {
            started: 0,
            completed: 0,
            failed: 0,
            semanticRevision: 0,
          },
          proposalSubmitted: false,
        })
      : progress();
    const failure: BenchmarkInfrastructureFailureV3 = {
      kind: "provider",
      provider: {
        phase: "response_stream",
        code: "connection",
        httpStatus: null,
        retryClass: "transient",
      },
      retryClass: "transient",
    };
    const outcome = isInfra
      ? {
          status: "infra_failure" as const,
          failure,
          message: "Infrastructure failure" as const,
          retryable: false,
        }
      : isDiagnostic
        ? {
            status: "diagnostic_failure" as const,
            code: "proposal_missing" as const,
            message: "Terminal diagnostic failure" as const,
            rawManifestHash,
          }
        : { status: "completed" as const, rawManifestHash };
    const attemptBasis: Omit<BenchmarkCellAttemptV3, "attemptHash"> = {
      schemaVersion: 3,
      suiteId: spec.suiteId,
      definitionId: spec.definitionId,
      executionId,
      cellId: ordered.cellId,
      attemptId,
      fixtureId: ordered.fixtureId,
      arm: ordered.arm,
      repetition: ordered.repetition,
      ordinal: 1,
      kind: "initial",
      previousAttemptHash: null,
      startedAt,
      finishedAt,
      progress: attemptProgress,
      metrics,
      outcome,
    };
    attempts.push({
      ...attemptBasis,
      attemptHash: benchmarkAttemptHashV3(attemptBasis),
    });
    const proofAndScore = isInfra
      ? null
      : isDiagnostic
        ? {
            proof: BenchmarkCellScoringProofV3Schema.parse({
              schemaVersion: 3,
              proofKind: "diagnostic_failure",
              cellId: ordered.cellId,
              selectedAttemptId: attemptId,
              rawManifestHash,
              diagnosticCode: "proposal_missing",
              oracle: {
                oracleHash: fixture.oracleHash,
                expectedMechanism: fixture.expectedMechanism,
                expectedSource: fixture.expectedSource,
              },
            }),
            score: diagnosticFailureScoreV3(fixture.expectedMechanism),
          }
        : scoringProofFor(
            spec,
            ordered,
            attemptId,
            rawManifestHash,
            shouldSucceed,
          );
    if (proofAndScore !== null) scoringProofs.push(proofAndScore.proof);
    const score = proofAndScore?.score ?? null;
    cells.push(
      BenchmarkCellResultV3Schema.parse({
        schemaVersion: 3,
        suiteId: spec.suiteId,
        definitionId: spec.definitionId,
        executionId,
        cellId: ordered.cellId,
        fixtureId: ordered.fixtureId,
        arm: ordered.arm,
        repetition: ordered.repetition,
        expectedMechanism: fixture.expectedMechanism,
        status: isInfra
          ? "infra_unavailable"
          : isDiagnostic
            ? "diagnostic_failure"
            : "scored",
        terminalCode: isInfra
          ? "connection"
          : isDiagnostic
            ? "proposal_missing"
            : null,
        infrastructureFailure: isInfra ? failure : null,
        attemptIds: [attemptId],
        selectedAttemptId: attemptId,
        score,
        metrics,
        rawManifestHash: isInfra ? null : rawManifestHash,
      }),
    );
  }
  return { attempts, cells, scoringProofs };
};

const report = (
  spec: BenchmarkSuiteSpecV3,
  entries: ReturnType<typeof matrix>,
) =>
  buildBenchmarkReportV3({
    suite: spec,
    executionId: asBenchmarkExecutionId("benchmark-execution:v3-test"),
    startedAt: "2026-08-05T00:00:00.000Z",
    finishedAt: "2026-08-05T00:02:00.000Z",
    provenance,
    attempts: entries.attempts,
    cells: entries.cells,
    scoringProofs: entries.scoringProofs,
  });

describe("Benchmark V3 semantics", () => {
  it("freezes the Luna campaign metadata and rejects unknown fields", () => {
    const spec = suite();
    expect(spec).toMatchObject({
      schemaVersion: 3,
      campaign: { campaignId: "v0.3.2-luna" },
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      modelRequirements: { contextWindow: 272_000, maxTokens: 128_000 },
      budgets: {
        maxToolCalls: 12,
        maxToolErrors: 0,
        maxConsecutiveNonProgressToolResults: 0,
      },
    });
    expect(
      BenchmarkSuiteSpecV3Schema.safeParse({ ...spec, unexpected: true })
        .success,
    ).toBe(false);
    expect(BenchmarkProvenanceV3Schema.parse(provenance)).toMatchObject({
      resolvedProvider: "openai-codex",
      resolvedModelId: "gpt-5.6-luna",
      resolvedModelName: "GPT-5.6 Luna",
    });
  });

  it("isolates the Luna r1 campaign, tag, provenance, and order seed", () => {
    const original = suite();
    const r1 = suite("v0.3.2-luna-r1");
    const r1Provenance = BenchmarkProvenanceV3Schema.parse({
      ...provenance,
      freezeTag: "v0.3.2-luna-r1-benchmark-freeze",
    });

    expect(r1.campaign).toEqual({
      campaignId: "v0.3.2-luna-r1",
      freezeTag: "v0.3.2-luna-r1-benchmark-freeze",
    });
    expect(r1.orderSeed).toBe("chronorift-v0.3.2-luna-r1-formal-1");
    expect(r1.definitionId).not.toBe(original.definitionId);
    expect(r1Provenance.freezeTag).toBe("v0.3.2-luna-r1-benchmark-freeze");

    const crossedSuites: readonly unknown[] = [
      {
        ...r1,
        campaign: {
          campaignId: "v0.3.2-luna-r1",
          freezeTag: "v0.3.2-luna-benchmark-freeze",
        },
      },
      { ...r1, orderSeed: "chronorift-v0.3.2-luna-formal-1" },
      {
        ...original,
        campaign: {
          campaignId: "v0.3.2-luna",
          freezeTag: "v0.3.2-luna-r1-benchmark-freeze",
        },
      },
      { ...original, orderSeed: "chronorift-v0.3.2-luna-r1-formal-1" },
    ];
    for (const crossed of crossedSuites) {
      expect(BenchmarkSuiteSpecV3Schema.safeParse(crossed).success).toBe(false);
    }

    const reportInput = {
      suite: r1,
      executionId: asBenchmarkExecutionId("benchmark-execution:r1-pairing"),
      startedAt: "2026-08-05T00:00:00.000Z",
      finishedAt: "2026-08-05T00:01:00.000Z",
      attempts: [],
      cells: [],
      scoringProofs: [],
    } as const;
    expect(() =>
      buildBenchmarkReportV3({ ...reportInput, provenance }),
    ).toThrow("provenance");
    expect(
      buildBenchmarkReportV3({ ...reportInput, provenance: r1Provenance }).suite
        .campaign,
    ).toEqual(r1.campaign);
  });

  it("keeps typed non-provider infrastructure failures outside scoring", () => {
    expect(
      BenchmarkInfrastructureFailureV3Schema.parse({
        kind: "harness_timeout",
        code: "no_progress_timeout",
        retryClass: "transient",
      }),
    ).toEqual({
      kind: "harness_timeout",
      code: "no_progress_timeout",
      retryClass: "transient",
    });
    expect(
      BenchmarkInfrastructureFailureV3Schema.parse({
        kind: "process_interrupted",
        code: "process_interrupted",
        retryClass: "transient",
      }),
    ).toEqual({
      kind: "process_interrupted",
      code: "process_interrupted",
      retryClass: "transient",
    });
  });

  it("allows retries only for transient infrastructure before progress", () => {
    const spec = suite();
    const existing = matrix(spec, {
      genericSuccesses: 0,
      fullSuccesses: 0,
    }).attempts[0];
    if (existing === undefined) throw new Error("Missing test attempt");
    const candidate = {
      ...existing,
      progress: progress({
        model: {
          requestStarted: true,
          outputObserved: false,
          turnCompleted: false,
        },
        tools: {
          started: 0,
          completed: 0,
          failed: 0,
          semanticRevision: 0,
        },
        game: { baselineExecutions: 1, diagnosticExecutions: 0 },
        proposalSubmitted: false,
      }),
      metrics: {
        gameExecutions: 1,
        toolCalls: 0,
        wallTimeMs: 1,
        tokens: zeroTokens,
      },
      outcome: {
        status: "infra_failure" as const,
        failure: {
          kind: "provider" as const,
          provider: {
            phase: "request" as const,
            code: "provider_error_unknown" as const,
            httpStatus: null,
            retryClass: "unknown" as const,
          },
          retryClass: "unknown" as const,
        },
        message: "Infrastructure failure" as const,
        retryable: false,
      },
    };
    expect(BenchmarkCellAttemptV3Schema.safeParse(candidate).success).toBe(
      true,
    );
    expect(
      BenchmarkCellAttemptV3Schema.safeParse({
        ...candidate,
        outcome: { ...candidate.outcome, retryable: true },
      }).success,
    ).toBe(false);
  });

  it("passes only with complete coverage and the frozen advantage", () => {
    const spec = suite();
    const built = report(
      spec,
      matrix(spec, { genericSuccesses: 6, fullSuccesses: 9 }),
    );
    expect(built.status).toBe("complete");
    expect(built.aggregate?.scoreEligibleCells).toBe(36);
    expect(built.aggregate?.advantage).toMatchObject({
      fullGroundedSuccesses: 9,
      fullMinusGeneric: 0.25,
      thresholdMet: true,
    });
    expect(evaluateBenchmarkGateV3(built)).toEqual({
      status: "pass",
      reasons: [],
    });
    expect(verifyBenchmarkReportV3(built)).toMatchObject({ valid: true });
  });

  it("seals provider unavailability without scoring and does not evaluate Gate", () => {
    const spec = suite();
    const entries = matrix(spec, {
      genericSuccesses: 6,
      fullSuccesses: 9,
      infraCellIndex: 0,
    });
    const built = report(spec, entries);
    expect(built.status).toBe("complete");
    expect(built.cells[0]).toMatchObject({
      status: "infra_unavailable",
      score: null,
      infrastructureFailure: {
        kind: "provider",
        provider: { code: "connection" },
      },
    });
    expect(built.aggregate?.scoreEligibleCells).toBe(35);
    expect(built.aggregate?.advantage).toBeNull();
    expect(
      Object.values(built.aggregate?.byArm ?? {}).some(
        (arm) => arm.groundedSuccessRate === null,
      ),
    ).toBe(true);
    expect(evaluateBenchmarkGateV3(built)).toMatchObject({
      status: "not_evaluated",
    });
  });

  it("counts a diagnostic failure as a fixed unsuccessful eligible cell", () => {
    const spec = suite();
    const built = report(
      spec,
      matrix(spec, {
        genericSuccesses: 6,
        fullSuccesses: 8,
        diagnosticCellIndex: 0,
      }),
    );
    expect(built.aggregate?.scoreEligibleCells).toBe(36);
    expect(built.cells[0]?.score).toEqual(
      diagnosticFailureScoreV3(built.cells[0]!.expectedMechanism),
    );
    expect(evaluateBenchmarkGateV3(built)).toMatchObject({ status: "fail" });
  });

  it("rejects report tampering", () => {
    const spec = suite();
    const built = report(
      spec,
      matrix(spec, { genericSuccesses: 6, fullSuccesses: 9 }),
    );
    expect(
      verifyBenchmarkReportV3({
        ...built,
        aggregate: built.aggregate && {
          ...built.aggregate,
          scoreEligibleCells: 35,
        },
      }),
    ).toMatchObject({ valid: false });
  });

  it("recomputes a terminal manifest without treating confidence as confirmation", () => {
    const spec = suite();
    const { attempt, manifest } = completedRawAttempt(spec);
    expect(
      assertBenchmarkRawAttemptManifestV3Integrity({
        suite: spec,
        attempt,
        manifest,
      }).score,
    ).toMatchObject({
      mechanismCorrect: true,
      verdict: "inconclusive",
      groundedSuccess: false,
      confidence: 1,
    });
    expect(
      BenchmarkRawAttemptManifestV3Schema.safeParse({
        ...manifest,
        modelClaim: "trusted",
      }).success,
    ).toBe(false);
  });

  it("binds every suite-frozen material hash and the delivered Failure Brief", () => {
    const spec = suite();
    const original = completedRawAttempt(spec);
    if (original.manifest.terminalStatus !== "completed") {
      throw new Error("Expected completed test manifest");
    }
    const expectMaterialTamperRejected = (
      mutate: (manifest: typeof original.manifest) => void,
    ): void => {
      const manifest = structuredClone(original.manifest);
      mutate(manifest);
      const parsed = BenchmarkRawAttemptManifestV3Schema.parse(manifest);
      const attempt = attemptBoundToManifest(original.attempt, parsed);
      expect(() =>
        assertBenchmarkRawAttemptManifestV3Integrity({
          suite: spec,
          attempt,
          manifest: parsed,
        }),
      ).toThrow("frozen Fixture material binding is invalid");
    };

    expectMaterialTamperRejected((manifest) => {
      manifest.promptAudit.sourceViewHash = hash("0");
    });
    expectMaterialTamperRejected((manifest) => {
      manifest.promptAudit.experimentCatalogHash = hash("0");
    });
    expectMaterialTamperRejected((manifest) => {
      manifest.promptAudit.contractHash = hash("0");
      manifest.caseEvidence.contract.contentHash = hash("0");
    });
    expectMaterialTamperRejected((manifest) => {
      manifest.promptAudit.inputTraceHash = hash("0");
      manifest.caseEvidence.inputTrace.contentHash = hash("0");
    });

    const failureBriefTamper = BenchmarkRawAttemptManifestV3Schema.parse({
      ...original.manifest,
      promptAudit: {
        ...original.manifest.promptAudit,
        failureBriefHash: hash("0"),
      },
    });
    expect(() =>
      assertBenchmarkRawAttemptManifestV3Integrity({
        suite: spec,
        attempt: attemptBoundToManifest(original.attempt, failureBriefTamper),
        manifest: failureBriefTamper,
      }),
    ).toThrow("Failure Brief receipt binding is invalid");
  });

  it.each([
    {
      label: "replay",
      accessKind: "replay" as const,
      count: 2,
      error: "replay budget",
    },
    {
      label: "intervention",
      accessKind: "experiment" as const,
      count: 3,
      error: "intervention budget",
    },
    {
      label: "source-call",
      accessKind: "source_read" as const,
      count: 5,
      error: "source-call budget",
    },
  ])("rejects a scored raw manifest over its $label budget", (testCase) => {
    const spec = suite();
    const original = completedRawAttempt(spec);
    if (original.manifest.terminalStatus !== "completed") {
      throw new Error("Expected completed test manifest");
    }
    const extraReceipts = Array.from({ length: testCase.count }, (_, index) =>
      evidenceReceipt(
        original.manifest,
        testCase.accessKind,
        testCase.accessKind === "experiment"
          ? `execution:extra-intervention:${index}`
          : `${testCase.accessKind}:extra:${index}`,
        index,
      ),
    );
    const accessReceipts = [
      ...original.manifest.accessReceipts,
      ...extraReceipts,
    ];
    const manifest = BenchmarkRawAttemptManifestV3Schema.parse({
      ...original.manifest,
      accessReceipts,
      caseEvidence: {
        ...original.manifest.caseEvidence,
        accessReceipts,
      },
    });
    expect(() =>
      assertBenchmarkRawAttemptManifestV3Integrity({
        suite: spec,
        attempt: attemptBoundToManifest(original.attempt, manifest),
        manifest,
      }),
    ).toThrow(testCase.error);
  });

  it("rejects a standalone scoring proof over a fine-grained access budget", () => {
    const spec = suite();
    const entries = matrix(spec, {
      genericSuccesses: 0,
      fullSuccesses: 0,
    });
    const proof = entries.scoringProofs.find(
      (candidate) => candidate.proofKind === "scored",
    );
    if (proof?.proofKind !== "scored") {
      throw new Error("Expected a scored proof");
    }
    const attempt = entries.attempts.find(
      (candidate) => candidate.attemptId === proof.selectedAttemptId,
    );
    const cell = entries.cells.find(
      (candidate) => candidate.cellId === proof.cellId,
    );
    if (attempt === undefined || cell === undefined) {
      throw new Error("Expected proof lineage");
    }
    const extraReceipts = Array.from({ length: 5 }, (_, index) =>
      evidenceReceipt(
        proof.proposal,
        "source_search",
        `case/main.gd:search:${index}`,
        index,
      ),
    );
    const accessReceipts = [...proof.accessReceipts, ...extraReceipts];
    const overBudget = BenchmarkCellScoringProofV3Schema.parse({
      ...proof,
      accessReceipts,
      caseEvidence: { ...proof.caseEvidence, accessReceipts },
    });
    expect(() =>
      assertBenchmarkCellScoringProofV3Integrity({
        suite: spec,
        attempt,
        cell,
        proof: overBudget,
      }),
    ).toThrow("source-call budget");
  });

  it("rejects a forged confirmed manifest without mechanism evidence", () => {
    const spec = suite();
    const original = completedRawAttempt(spec);
    if (original.manifest.terminalStatus !== "completed") {
      throw new Error("Expected completed test manifest");
    }
    const manifest = BenchmarkRawAttemptManifestV3Schema.parse({
      ...original.manifest,
      verdict: {
        ...original.manifest.verdict,
        status: "confirmed",
        summary: `Harness evidence confirms ${original.manifest.proposal.mechanismCode}`,
        blockers: [],
      },
    });
    const { attemptHash: _attemptHash, ...oldBasis } = original.attempt;
    void _attemptHash;
    const basis = {
      ...oldBasis,
      outcome: {
        status: "completed" as const,
        rawManifestHash: hashJson(manifest),
      },
    };
    const attempt = BenchmarkCellAttemptV3Schema.parse({
      ...basis,
      attemptHash: benchmarkAttemptHashV3(basis),
    });
    expect(() =>
      assertBenchmarkRawAttemptManifestV3Integrity({
        suite: spec,
        attempt,
        manifest,
      }),
    ).toThrow("lacks grounding evidence");
  });

  it("rejects an over-budget scored attempt", () => {
    const spec = suite();
    const original = completedRawAttempt(spec).attempt;
    const progressOverBudget = {
      ...original.progress,
      tools: {
        started: 13,
        completed: 13,
        failed: 0,
        semanticRevision: 13,
      },
    };
    const { attemptHash: _attemptHash, ...oldBasis } = original;
    void _attemptHash;
    const basis = {
      ...oldBasis,
      progress: progressOverBudget,
      metrics: { ...original.metrics, toolCalls: 13 },
    };
    const attempt = BenchmarkCellAttemptV3Schema.parse({
      ...basis,
      attemptHash: benchmarkAttemptHashV3(basis),
    });
    expect(() => assertBenchmarkAttemptBudgetsV3(spec, attempt)).toThrow(
      "scored attempt exceeded frozen budgets",
    );
  });

  it("accepts exactly one failed proposal submission as invalid_proposal evidence", () => {
    const spec = suite();
    const original = completedRawAttempt(spec).attempt;
    const failedProgress = {
      ...original.progress,
      tools: {
        started: 1,
        completed: 1,
        failed: 1,
        semanticRevision: 0,
      },
      proposalSubmitted: false,
    };
    const { attemptHash: _attemptHash, ...oldBasis } = original;
    void _attemptHash;
    const basis = {
      ...oldBasis,
      progress: failedProgress,
      outcome: {
        status: "diagnostic_failure" as const,
        code: "invalid_proposal" as const,
        message: "Terminal diagnostic failure",
        rawManifestHash: hash("4"),
      },
    };
    const attempt = BenchmarkCellAttemptV3Schema.parse({
      ...basis,
      attemptHash: benchmarkAttemptHashV3(basis),
    });

    expect(assertBenchmarkAttemptBudgetsV3(spec, attempt)).toEqual([
      "tool_errors",
    ]);
  });

  it.each([
    {
      name: "more than one failed tool",
      tools: {
        started: 2,
        completed: 2,
        failed: 2,
        semanticRevision: 0,
      },
      game: { baselineExecutions: 1, diagnosticExecutions: 0 },
      metrics: { toolCalls: 2, gameExecutions: 1 },
    },
    {
      name: "a failed tool plus a game-execution violation",
      tools: {
        started: 1,
        completed: 1,
        failed: 1,
        semanticRevision: 0,
      },
      game: { baselineExecutions: 1, diagnosticExecutions: 4 },
      metrics: { toolCalls: 1, gameExecutions: 5 },
    },
  ])("rejects invalid_proposal with $name", ({ tools, game, metrics }) => {
    const spec = suite();
    const original = completedRawAttempt(spec).attempt;
    const { attemptHash: _attemptHash, ...oldBasis } = original;
    void _attemptHash;
    const basis = {
      ...oldBasis,
      progress: {
        ...original.progress,
        tools,
        game,
        proposalSubmitted: false,
      },
      metrics: {
        ...original.metrics,
        ...metrics,
      },
      outcome: {
        status: "diagnostic_failure" as const,
        code: "invalid_proposal" as const,
        message: "Terminal diagnostic failure",
        rawManifestHash: hash("4"),
      },
    };
    const attempt = BenchmarkCellAttemptV3Schema.parse({
      ...basis,
      attemptHash: benchmarkAttemptHashV3(basis),
    });

    expect(() => assertBenchmarkAttemptBudgetsV3(spec, attempt)).toThrow(
      "budget violation contradicts diagnostic terminal code",
    );
  });

  it("rejects a rehashed report whose mechanism evidence was removed", () => {
    const spec = suite();
    const built = report(
      spec,
      matrix(spec, { genericSuccesses: 6, fullSuccesses: 9 }),
    );
    const forged = structuredClone(built);
    const proof = forged.scoringProofs.find(
      (candidate) =>
        candidate.proofKind === "scored" &&
        candidate.verdict.status === "confirmed",
    );
    if (
      proof?.proofKind !== "scored" ||
      proof.caseEvidence.candidates[0] === undefined
    ) {
      throw new Error("Expected a confirmed scoring proof");
    }
    proof.caseEvidence.candidates[0].causalEvents = [];
    const { reportHash: _reportHash, ...basis } = forged;
    void _reportHash;
    const rehashed = { ...basis, reportHash: benchmarkReportHashV3(basis) };
    expect(verifyBenchmarkReportV3(rehashed)).toMatchObject({ valid: false });
  });
});

describe("Benchmark V3 progress", () => {
  const spec = suite();
  const ordered = benchmarkCellOrderV3(spec)[0]!;
  const attemptId = benchmarkAttemptIdV3(
    asBenchmarkExecutionId("benchmark-execution:progress"),
    ordered.cellId,
    1,
  );
  const snapshot = (
    sequence: number,
    state: BenchmarkAttemptProgressStateV3,
    metrics: BenchmarkCellMetricsV3,
  ): BenchmarkAttemptProgressV3 => ({
    schemaVersion: 3,
    suiteId: spec.suiteId,
    definitionId: spec.definitionId,
    executionId: asBenchmarkExecutionId("benchmark-execution:progress"),
    cellId: ordered.cellId,
    attemptId,
    ordinal: 1,
    sequence,
    observedAt: new Date(Date.UTC(2026, 7, 5) + sequence * 1_000).toISOString(),
    progress: state,
    metrics,
    rawManifest: { schemaVersion: 3, sequence },
  });

  it("keeps baseline separate and validates monotonic semantic revisions", () => {
    const baseline = progress({
      fixtureStage: "baseline_captured",
      model: {
        requestStarted: false,
        outputObserved: false,
        turnCompleted: false,
      },
      tools: {
        started: 0,
        completed: 0,
        failed: 0,
        semanticRevision: 0,
      },
      game: { baselineExecutions: 1, diagnosticExecutions: 0 },
      proposalSubmitted: false,
    });
    expect(benchmarkProgressHasDiagnosticActivityV3(baseline)).toBe(false);
    const afterTool = progress({
      fixtureStage: "fixture_validated",
      tools: {
        started: 1,
        completed: 1,
        failed: 0,
        semanticRevision: 1,
      },
      proposalSubmitted: true,
    });
    const journal = [
      snapshot(1, baseline, {
        gameExecutions: 1,
        toolCalls: 0,
        wallTimeMs: 10,
        tokens: zeroTokens,
      }),
      snapshot(2, afterTool, {
        gameExecutions: 1,
        toolCalls: 1,
        wallTimeMs: 20,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      }),
      snapshot(
        3,
        progress({
          fixtureStage: "fixture_validated",
          tools: {
            started: 2,
            completed: 2,
            failed: 0,
            semanticRevision: 2,
          },
          proposalSubmitted: true,
        }),
        {
          gameExecutions: 1,
          toolCalls: 2,
          wallTimeMs: 30,
          tokens: {
            input: 2,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            total: 4,
          },
        },
      ),
    ];
    expect(assertBenchmarkAttemptProgressSequenceV3(journal)).toHaveLength(3);
    const regressed = structuredClone(journal);
    regressed[2]!.progress.tools.semanticRevision = 0;
    expect(() => assertBenchmarkAttemptProgressSequenceV3(regressed)).toThrow(
      "semanticRevision decreased",
    );
  });
});

describe("Benchmark V2 historical compatibility", () => {
  it.each([
    [
      "docs/benchmarks/v0.3/benchmark-report.v2.json",
      "d58b4b9525a370f2f13731a49df9f2dbe926f2e03c12a8687550b07d55e2d430",
    ],
    [
      "docs/benchmarks/v0.3.1-r2/benchmark-report.v2.json",
      "cfb29c7878500dcbd7ac0cbd3683fdf52362088ea26d7bf55573e11227f4457a",
    ],
  ] as const)("preserves %s", async (relativePath, expectedHash) => {
    const input: unknown = JSON.parse(
      await readFile(resolve(process.cwd(), relativePath), "utf8"),
    );
    const verified = verifyBenchmarkReportV2(input);
    expect(verified).toMatchObject({
      valid: true,
      report: { reportHash: expectedHash },
      gate: {
        status: "fail",
        reasons: [
          "ChronoRift full grounded successes 0/12 are below 9/12",
          "ChronoRift full minus generic is below 0.2",
        ],
      },
    });
  });
});
