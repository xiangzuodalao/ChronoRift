import {
  asAdapterCompatibilityReceiptId,
  asBuildId,
  asExecutionId,
  asProjectAdapterRevisionId,
  asRuntimeId,
  asSha256DigestV1,
  asSourceId,
  asTaskId,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import {
  M7PatrolTrajectoryClassificationV1Schema,
  M7R3PatrolTrajectoryCaseSpecV1Schema,
  M7R3PatrolTrajectoryExecutionSummaryV1Schema,
  M7R3PatrolTrajectoryUseEvidenceV1Schema,
  M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
  M7_PATROL_TRAJECTORY_WITNESS_KINDS_V1,
  classifyM7PatrolTrajectoryV1,
  createM7PatrolTrajectoryClassifierConfigV1,
  createM7R3PatrolTrajectoryCaseSpecV1,
  createM7R3PatrolTrajectoryExecutionSummaryV1,
  deriveM7R3PatrolTrajectoryUseEvidenceV1,
  type M7R3HostObservedSourceChangeBoundaryV1,
  type M7R3PatrolTrajectoryExecutionSummaryV1,
} from "./m7-patrol-trajectory.js";
import type {
  M7PatrolEntityStateV1,
  M7PatrolStateTimelineV1,
} from "./m7-patrol-sensor.js";

const sha = (label: string): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(label));

const state = (
  input: Partial<M7PatrolEntityStateV1> = {},
): M7PatrolEntityStateV1 => ({
  entity_id: "enemy:generic:1",
  name: "GenericPatrolEnemy",
  start_direction: 0,
  direction: -1,
  fall_off_edge: false,
  speed: 120,
  position_x: 0,
  position_y: 100,
  velocity_x: -120,
  velocity_y: 0,
  grounded: true,
  ...input,
});

const timeline = (
  executionId: string,
  frames: M7PatrolStateTimelineV1["frames"],
): M7PatrolStateTimelineV1 => ({
  schemaVersion: 1,
  execution_id: executionId,
  frames: [...frames],
});

const allKindsTimeline = (): M7PatrolStateTimelineV1 =>
  timeline("execution:all-neutral-trajectories", [
    {
      sample_ordinal: 10,
      entities: [
        state({ entity_id: "enemy:loss" }),
        state({ entity_id: "enemy:deviation" }),
        state({ entity_id: "enemy:stall", velocity_x: 0 }),
        state({ entity_id: "enemy:direction" }),
        state({ entity_id: "enemy:sustained" }),
      ],
    },
    {
      sample_ordinal: 20,
      entities: [
        state({
          entity_id: "enemy:loss",
          grounded: false,
          position_y: 104,
          velocity_y: 40,
        }),
        state({ entity_id: "enemy:deviation", velocity_x: -36 }),
        state({ entity_id: "enemy:stall", velocity_x: 0 }),
        state({
          entity_id: "enemy:direction",
          direction: 1,
          velocity_x: 120,
        }),
        state({
          entity_id: "enemy:sustained",
          position_x: -12,
        }),
      ],
    },
    {
      sample_ordinal: 30,
      entities: [
        state({
          entity_id: "enemy:loss",
          grounded: false,
          position_y: 112,
          velocity_y: 80,
        }),
        state({ entity_id: "enemy:deviation", velocity_x: -36 }),
        state({ entity_id: "enemy:stall", velocity_x: 0 }),
        state({
          entity_id: "enemy:direction",
          direction: 1,
          velocity_x: 120,
          position_x: 12,
        }),
        state({
          entity_id: "enemy:sustained",
          position_x: -24,
        }),
      ],
    },
  ]);

const baselineTimeline = (
  executionId = "execution:baseline",
  fallOffEdge = false,
): M7PatrolStateTimelineV1 =>
  timeline(executionId, [
    {
      sample_ordinal: 1,
      entities: [state({ fall_off_edge: fallOffEdge })],
    },
    {
      sample_ordinal: 2,
      entities: [
        state({
          fall_off_edge: fallOffEdge,
          grounded: false,
          position_y: 108,
          velocity_y: 60,
        }),
      ],
    },
    {
      sample_ordinal: 3,
      entities: [
        state({
          fall_off_edge: fallOffEdge,
          grounded: false,
          position_y: 120,
          velocity_y: 100,
        }),
      ],
    },
  ]);

const candidateTimeline = (
  executionId = "execution:candidate",
): M7PatrolStateTimelineV1 =>
  timeline(executionId, [
    { sample_ordinal: 1, entities: [state()] },
    {
      sample_ordinal: 2,
      entities: [state({ direction: 1, velocity_x: 120, position_x: 4 })],
    },
    {
      sample_ordinal: 3,
      entities: [state({ direction: 1, velocity_x: 120, position_x: 16 })],
    },
    {
      sample_ordinal: 4,
      entities: [state({ direction: 1, velocity_x: 120, position_x: 28 })],
    },
  ]);

const boundary = (
  input: Partial<M7R3HostObservedSourceChangeBoundaryV1> = {},
): M7R3HostObservedSourceChangeBoundaryV1 => ({
  schemaVersion: 1,
  hostToolReturnOrdinal: 5,
  sourceChangingToolIssuedInAgentTurnOrdinal: 2,
  boundary: "coding_tool_return",
  sourceSha256: sha("candidate source"),
  buildId: null,
  observedAt: "2026-08-15T01:05:00.000Z",
  ...input,
});

interface SummaryOptions {
  readonly role: "baseline" | "candidate";
  readonly deliveryOrdinal: number;
  readonly sourceBoundary?: M7R3HostObservedSourceChangeBoundaryV1 | null;
  readonly coverageComplete?: boolean;
  readonly lossObserved?: boolean;
  readonly cleanupProven?: boolean;
  readonly classifierImplementationSha256?: Sha256DigestV1;
  readonly fallOffEdge?: boolean;
  readonly availableToModelAtAgentTurnOrdinal?: number;
}

const summary = (
  input: SummaryOptions,
): M7R3PatrolTrajectoryExecutionSummaryV1 => {
  const isBaseline = input.role === "baseline";
  const executionId = asExecutionId(
    isBaseline ? "execution:baseline" : "execution:candidate",
  );
  const cleanupProven = input.cleanupProven ?? true;
  const lossObserved = input.lossObserved ?? false;
  return createM7R3PatrolTrajectoryExecutionSummaryV1({
    lineage: {
      taskId: asTaskId("task:m7-r3"),
      executionId,
      runtimeId: asRuntimeId(
        isBaseline ? "runtime:baseline" : "runtime:candidate",
      ),
      buildId: asBuildId(isBaseline ? "build:baseline" : "build:candidate"),
      sourceId: asSourceId(isBaseline ? "source:baseline" : "source:candidate"),
      sourceSha256: sha(isBaseline ? "baseline source" : "candidate source"),
      adapterRevisionId: asProjectAdapterRevisionId(
        "adapter:generic-patrol:v1",
      ),
      adapterCompatibilityReceiptId: asAdapterCompatibilityReceiptId(
        isBaseline ? "compat:baseline" : "compat:candidate",
      ),
      adapterCompatibilityReceiptSha256: sha(
        isBaseline ? "compat baseline" : "compat candidate",
      ),
    },
    startedAt: isBaseline
      ? "2026-08-15T01:00:00.000Z"
      : "2026-08-15T01:10:00.000Z",
    endedAt: isBaseline
      ? "2026-08-15T01:01:00.000Z"
      : "2026-08-15T01:11:00.000Z",
    executionSealSha256: sha(`seal ${input.role}`),
    runtimeObservationReceiptSha256: sha(`runtime ${input.role}`),
    classifierImplementationSha256:
      input.classifierImplementationSha256 ?? sha("generic classifier bytes"),
    agentVisibleTimeline: isBaseline
      ? baselineTimeline(executionId, input.fallOffEdge)
      : candidateTimeline(executionId),
    agentVisibleAtHostToolReturnOrdinal: input.deliveryOrdinal,
    agentVisibleExchangeTranscriptSha256: sha(`transcript ${input.role}`),
    agentVisibleExchangeReceiptSha256: sha(`exchange ${input.role}`),
    agentVisibleDeliveryResponseSha256: sha(`response ${input.role}`),
    agentVisibleResponseDetailsSha256: sha(`details ${input.role}`),
    agentVisibleFinalToolResult: {
      schemaVersion: 1,
      eventType: "tool_execution_end",
      resultProjectionKind: "json-roundtrip-v1",
      piEventOrdinal: isBaseline ? 12 : 38,
      toolResultProducedInAgentTurnOrdinal: isBaseline ? 1 : 3,
      availableToModelAtAgentTurnOrdinal:
        input.availableToModelAtAgentTurnOrdinal ?? (isBaseline ? 2 : 4),
      toolCallId: isBaseline ? "tool-call:baseline" : "tool-call:candidate",
      toolName: "game_query_runtime_state",
      hostToolReturnOrdinal: input.deliveryOrdinal,
      finalResultSha256: sha(`response ${input.role}`),
      finalResultDetailsSha256: sha(`details ${input.role}`),
      eventReceiptSha256: sha(`tool result event ${input.role}`),
      modelAvailabilityReceiptSha256: sha(`model availability ${input.role}`),
    },
    firstHostObservedSourceChange:
      input.sourceBoundary === undefined ? boundary() : input.sourceBoundary,
    coverageComplete: input.coverageComplete ?? true,
    coverageReceiptSha256: sha(`coverage ${input.role}`),
    loss: {
      historyLossObserved: lossObserved,
      droppedRecordCount: lossObserved ? 1 : 0,
      overwrittenRecordCount: 0,
      unavailableHistoryObserved: false,
      lossReceiptSha256: sha(`loss ${input.role}`),
    },
    cleanup: {
      proven: cleanupProven,
      cleanupReceiptSha256: cleanupProven ? sha(`cleanup ${input.role}`) : null,
    },
  });
};

const spec = () =>
  createM7R3PatrolTrajectoryCaseSpecV1({
    classifierImplementationSha256: sha("generic classifier bytes"),
    expectedBaselineWitnessKinds: ["ground_contact_loss"],
    expectedRecoveryWitnessKinds: [
      "direction_recovery",
      "sustained_grounded_motion",
    ],
    frozenAt: "2026-08-15T00:00:00.000Z",
  });

const derive = (
  input: {
    readonly summaries?: readonly M7R3PatrolTrajectoryExecutionSummaryV1[];
    readonly sourceBoundary?: M7R3HostObservedSourceChangeBoundaryV1 | null;
    readonly runtimeReceipt?: Sha256DigestV1 | null;
    readonly attemptReceipt?: Sha256DigestV1 | null;
    readonly candidatePresent?: boolean;
  } = {},
) =>
  deriveM7R3PatrolTrajectoryUseEvidenceV1({
    campaignId: "m7-campaign:0123456789abcdef01234567",
    caseSpec: spec(),
    attemptBindingContentSha256: sha("attempt binding"),
    runtimeEvidenceReceiptSha256:
      input.runtimeReceipt === undefined
        ? sha("runtime evidence")
        : input.runtimeReceipt,
    attemptEvidenceReceiptSha256:
      input.attemptReceipt === undefined
        ? sha("attempt evidence")
        : input.attemptReceipt,
    baselineIdentity: {
      buildId: asBuildId("build:baseline"),
      sourceId: asSourceId("source:baseline"),
      sourceSha256: sha("baseline source"),
    },
    candidateIdentity:
      input.candidatePresent === false
        ? null
        : {
            buildId: asBuildId("build:candidate"),
            sourceId: asSourceId("source:candidate"),
            sourceSha256: sha("candidate source"),
          },
    firstHostObservedSourceChange:
      input.sourceBoundary === undefined ? boundary() : input.sourceBoundary,
    summaries: input.summaries ?? [
      summary({ role: "baseline", deliveryOrdinal: 3 }),
      summary({ role: "candidate", deliveryOrdinal: 9 }),
    ],
    derivedAt: "2026-08-15T01:20:00.000Z",
  });

describe("M7 mutation-independent patrol trajectory classifier", () => {
  it("derives the five neutral witness kinds solely from strict patrol.motion rows", () => {
    const classification = classifyM7PatrolTrajectoryV1({
      timeline: allKindsTimeline(),
    });

    expect(
      new Set(classification.witnesses.map((entry) => entry.kind)),
    ).toEqual(new Set(M7_PATROL_TRAJECTORY_WITNESS_KINDS_V1));
    expect(classification.stateDomainId).toBe("patrol.motion");
    expect(classification.classifierConfig).toEqual(
      M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
    );
    expect(classification.classifierLossObserved).toBe(false);
    expect(Object.isFrozen(classification)).toBe(true);

    const raw = structuredClone(classification);
    raw.classifierInput.frames[0]?.entities.push({
      ...state({ entity_id: "enemy:implementation-detail" }),
      leftRayColliding: false,
    } as M7PatrolEntityStateV1);
    expect(
      M7PatrolTrajectoryClassificationV1Schema.safeParse(raw).success,
    ).toBe(false);
  });

  it("rejects classifier output, config, witness, and input hash tampering", () => {
    const classification = structuredClone(
      classifyM7PatrolTrajectoryV1({ timeline: baselineTimeline() }),
    );
    classification.witnesses[0]!.kind = "grounded_stall";
    expect(
      M7PatrolTrajectoryClassificationV1Schema.safeParse(classification)
        .success,
    ).toBe(false);

    const config = structuredClone(M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1);
    config.expectedGroundedAbsoluteSpeedRatioMinimum = 0.2;
    expect(
      M7PatrolTrajectoryClassificationV1Schema.safeParse({
        ...classifyM7PatrolTrajectoryV1({ timeline: baselineTimeline() }),
        classifierConfig: config,
      }).success,
    ).toBe(false);
  });

  it("retains intentional-fall configuration as a neutral fact", () => {
    const classification = classifyM7PatrolTrajectoryV1({
      timeline: baselineTimeline("execution:intentional-control", true),
    });
    expect(classification.witnesses).toEqual([
      expect.objectContaining({
        kind: "ground_contact_loss",
        fallOffEdge: true,
      }),
    ]);
  });

  it("reports classifier retention loss instead of hiding omitted witnesses", () => {
    const config = createM7PatrolTrajectoryClassifierConfigV1({
      schemaVersion: 1,
      stateDomainId: "patrol.motion",
      classifierId: "chronorift.generic-patrol-trajectory.v1",
      groundedStallAbsoluteSpeedRatioMaximum:
        M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1.groundedStallAbsoluteSpeedRatioMaximum,
      expectedGroundedAbsoluteSpeedRatioMinimum:
        M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1.expectedGroundedAbsoluteSpeedRatioMinimum,
      expectedGroundedAbsoluteSpeedRatioMaximum:
        M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1.expectedGroundedAbsoluteSpeedRatioMaximum,
      sustainedGroundedSampleCountMinimum:
        M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1.sustainedGroundedSampleCountMinimum,
      retainedWitnessMaximum: 2,
    });
    const classification = classifyM7PatrolTrajectoryV1({
      timeline: allKindsTimeline(),
      config,
    });
    expect(classification.retainedWitnessCount).toBe(2);
    expect(classification.omittedWitnessCount).toBeGreaterThan(0);
    expect(classification.classifierLossObserved).toBe(true);
  });
});

describe("M7 R3 trajectory execution summary", () => {
  it("retains lineage, seal, Agent delivery, coverage, loss, cleanup, and hashes", () => {
    const execution = summary({ role: "baseline", deliveryOrdinal: 3 });
    expect(execution.lineage).toEqual(
      expect.objectContaining({
        taskId: "task:m7-r3",
        executionId: "execution:baseline",
        buildId: "build:baseline",
        sourceId: "source:baseline",
      }),
    );
    expect(execution.sealed).toBe(true);
    expect(execution.coverage).toEqual(
      expect.objectContaining({
        complete: true,
        observedFrameCount: 3,
        observedEntitySampleCount: 3,
      }),
    );
    expect(execution.loss.historyLossObserved).toBe(false);
    expect(execution.cleanup.proven).toBe(true);
    expect(execution.agentVisibleAtHostToolReturnOrdinal).toBe(3);
    expect(
      M7R3PatrolTrajectoryExecutionSummaryV1Schema.parse(execution),
    ).toEqual(execution);
  });

  it("rejects mismatched lineage, coverage, loss, cleanup, and summary hashes", () => {
    const base = summary({ role: "baseline", deliveryOrdinal: 3 });
    const changedLineage = structuredClone(base);
    changedLineage.lineage.executionId = asExecutionId("execution:other");
    const changedCoverage = structuredClone(base);
    changedCoverage.coverage.observedFrameCount = 4;
    const changedLoss = structuredClone(base);
    changedLoss.loss.droppedRecordCount = 1;
    const changedCleanup = structuredClone(base);
    changedCleanup.cleanup.cleanupReceiptSha256 = null;
    const changedHash = structuredClone(base);
    changedHash.summarySha256 = sha("tampered");
    const changedFinalResult = structuredClone(base);
    changedFinalResult.agentVisibleFinalToolResult.finalResultSha256 =
      sha("another response");
    for (const changed of [
      changedLineage,
      changedCoverage,
      changedLoss,
      changedCleanup,
      changedHash,
      changedFinalResult,
    ]) {
      expect(
        M7R3PatrolTrajectoryExecutionSummaryV1Schema.safeParse(changed).success,
      ).toBe(false);
    }
  });
});

describe("M7 R3 trajectory case and ordering derivation", () => {
  it("freezes only generic expected witness kinds, without a source locus or fix", () => {
    const caseSpec = spec();
    expect(caseSpec.expectedBaselineWitnessKinds).toEqual([
      "ground_contact_loss",
    ]);
    expect(caseSpec.expectedRecoveryWitnessKinds).toEqual([
      "direction_recovery",
      "sustained_grounded_motion",
    ]);
    expect(Object.keys(caseSpec)).toEqual([
      "schemaVersion",
      "recordKind",
      "classifierId",
      "classifierImplementationSha256",
      "classifierConfigSha256",
      "expectedBaselineWitnessKinds",
      "expectedRecoveryWitnessKinds",
      "frozenAt",
      "caseId",
      "caseSpecSha256",
    ]);
    expect(
      M7R3PatrolTrajectoryCaseSpecV1Schema.safeParse({
        ...caseSpec,
        sourceLocus: "some/project/file",
      }).success,
    ).toBe(false);
    expect(
      M7R3PatrolTrajectoryCaseSpecV1Schema.safeParse({
        ...caseSpec,
        prescribedFix: "change an implementation detail",
      }).success,
    ).toBe(false);
  });

  it("establishes a pre-change Agent-visible baseline witness and post-change recovery", () => {
    const evidence = derive();
    expect(evidence.baselineWitnessAgentVisibleBeforeSourceChange).toBe(true);
    expect(evidence.candidateRecoveryAgentVisibleAfterSourceChange).toBe(true);
    expect(evidence.trajectoryUseEstablished).toBe(true);
    expect(evidence.rejectionReasons).toEqual([]);
    expect(evidence.baselineWitnesses.map((entry) => entry.kind)).toEqual([
      "ground_contact_loss",
    ]);
    expect(
      evidence.candidateRecoveryWitnesses.map((entry) => entry.kind),
    ).toEqual(["direction_recovery", "sustained_grounded_motion"]);
    expect(M7R3PatrolTrajectoryUseEvidenceV1Schema.parse(evidence)).toEqual(
      evidence,
    );
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it("does not establish use when either witness crosses the Host-observed edit boundary", () => {
    const lateBaseline = derive({
      summaries: [
        summary({ role: "baseline", deliveryOrdinal: 5 }),
        summary({ role: "candidate", deliveryOrdinal: 9 }),
      ],
    });
    expect(lateBaseline.trajectoryUseEstablished).toBe(false);
    expect(lateBaseline.rejectionReasons).toContain(
      "baseline_not_agent_visible_before_source_change",
    );

    const earlyCandidate = derive({
      summaries: [
        summary({ role: "baseline", deliveryOrdinal: 3 }),
        summary({ role: "candidate", deliveryOrdinal: 5 }),
      ],
    });
    expect(earlyCandidate.trajectoryUseEstablished).toBe(false);
    expect(earlyCandidate.rejectionReasons).toContain(
      "candidate_not_agent_visible_after_source_change",
    );
  });

  it("rejects a parallel same-turn edit issued before runtime data reached the model", () => {
    const evidence = derive({
      summaries: [
        summary({
          role: "baseline",
          deliveryOrdinal: 3,
          availableToModelAtAgentTurnOrdinal: 3,
        }),
        summary({ role: "candidate", deliveryOrdinal: 9 }),
      ],
    });
    expect(evidence.trajectoryUseEstablished).toBe(false);
    expect(evidence.rejectionReasons).toContain(
      "baseline_not_available_to_model_before_edit_issued",
    );
  });

  it("rejects incomplete, lossy, unclean, inconsistent, or detached evidence", () => {
    const lossy = summary({
      role: "baseline",
      deliveryOrdinal: 3,
      coverageComplete: false,
      lossObserved: true,
    });
    const unclean = summary({
      role: "candidate",
      deliveryOrdinal: 9,
      cleanupProven: false,
    });
    const evidence = derive({
      summaries: [lossy, unclean],
      runtimeReceipt: null,
      attemptReceipt: null,
    });
    expect(evidence.trajectoryUseEstablished).toBe(false);
    expect(evidence.rejectionReasons).toEqual(
      expect.arrayContaining([
        "runtime_evidence_receipt_missing",
        "attempt_evidence_receipt_missing",
        "baseline_incomplete_or_lossy",
        "candidate_incomplete_or_lossy",
      ]),
    );

    const inconsistent = derive({
      summaries: [
        summary({ role: "baseline", deliveryOrdinal: 3 }),
        summary({
          role: "candidate",
          deliveryOrdinal: 9,
          sourceBoundary: boundary({ hostToolReturnOrdinal: 6 }),
        }),
      ],
    });
    expect(inconsistent.rejectionReasons).toContain(
      "source_change_inconsistent",
    );
  });

  it("does not use an intentional-fall control as the selected baseline witness", () => {
    const evidence = derive({
      summaries: [
        summary({
          role: "baseline",
          deliveryOrdinal: 3,
          fallOffEdge: true,
        }),
        summary({ role: "candidate", deliveryOrdinal: 9 }),
      ],
    });
    expect(evidence.trajectoryUseEstablished).toBe(false);
    expect(evidence.baselineWitnesses).toEqual([]);
    expect(evidence.rejectionReasons).toContain(
      "baseline_expected_witness_missing",
    );
  });

  it("retains missing candidate and detects derived receipt tampering", () => {
    const missing = derive({
      candidatePresent: false,
      summaries: [summary({ role: "baseline", deliveryOrdinal: 3 })],
    });
    expect(missing.rejectionReasons).toContain("candidate_identity_missing");

    const changed = structuredClone(derive());
    changed.trajectoryUseEstablished = false;
    expect(
      M7R3PatrolTrajectoryUseEvidenceV1Schema.safeParse(changed).success,
    ).toBe(false);
  });
});
