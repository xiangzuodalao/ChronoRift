import {
  asBranchId,
  asCapsuleId,
  asCheckpointId,
  asComparisonId,
  asContractId,
  asEventId,
  asExecutionId,
  asFixtureId,
  asInputTraceId,
  asInterventionId,
  asRunId,
  type EvidenceCapsuleV2,
  type ExecutionId,
  type V03ExecutionComparison,
  type V03ExecutionLog,
  type V03TelemetryEvent,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import { validateV03MechanismEvidence } from "../src/index.js";

const runId = asRunId("run:mechanism");
const fixtureId = asFixtureId("fixture:mechanism");
const contractId = asContractId("contract:mechanism");
const checkpointId = asCheckpointId("checkpoint:mechanism");
const traceId = asInputTraceId("trace:mechanism");

const eventBase = (
  executionId: ExecutionId,
  branch: string,
  seq: number,
  tick: number,
) => ({
  schemaVersion: 2 as const,
  eventId: asEventId(`event:${executionId}:${seq}`),
  executionId,
  runId,
  branchId: asBranchId(branch),
  seq,
  tick,
  simTimeUs: tick * 1_000,
});

const execution = (
  executionId: ExecutionId,
  events: readonly V03TelemetryEvent[],
  finalValues: Readonly<Record<string, number | boolean>>,
  frameCount = 2,
): V03ExecutionLog =>
  ({
    schemaVersion: 2,
    executionId,
    runId,
    fixtureId,
    branchId: events[0]?.branchId ?? asBranchId("branch:empty"),
    contractId,
    startCheckpointId: checkpointId,
    inputTraceId: traceId,
    status: "completed",
    evaluation: {
      status: "pass",
      triggerEventId: events[0]?.eventId ?? asEventId("event:missing"),
      triggerTick: 0,
      deadlineTick: 1,
      satisfiedTick: 0,
      observed: { present: true, value: true },
    },
    restoreReceipt: {},
    stepReceipts: Array.from({ length: frameCount }, (_, tick) => ({
      requestedTick: tick,
      realizedTick: tick,
      requestedDeltaUs: 1_000,
      realizedDeltaUs: 1_000,
      appliedInputOrders: [],
      runtime: { idleFramesExecuted: 1 },
    })),
    controlReceipt: {},
    observationHealth: {},
    events,
    finalState: { values: finalValues },
    timelineDigest: "0".repeat(64),
    sealed: true,
  }) as unknown as V03ExecutionLog;

const comparison = (
  candidateExecutionId: ExecutionId,
  intervention: V03ExecutionComparison["intervention"],
): V03ExecutionComparison =>
  ({
    schemaVersion: 2,
    comparisonId: asComparisonId(`comparison:${candidateExecutionId}`),
    runId,
    fixtureId,
    contractId,
    baselineExecutionId: asExecutionId("execution:baseline"),
    candidateExecutionId,
    interventionId: asInterventionId("intervention:opaque"),
    intervention,
    baselineOutcome: "fail",
    candidateOutcome: "pass",
    comparable: true,
    blockers: [],
    firstDivergenceTick: 0,
  }) as V03ExecutionComparison;

const capsule = (
  events: readonly V03TelemetryEvent[],
  path: string,
): EvidenceCapsuleV2 =>
  ({
    schemaVersion: 2,
    capsuleId: asCapsuleId("capsule:mechanism"),
    runId,
    fixtureId,
    contractId,
    baselineExecutionId: asExecutionId("execution:baseline"),
    checkpointId,
    eventChain: events,
    evidenceLinks: [],
    expected: { kind: "property_equals", path, value: true },
    actual: { present: true, value: false },
    violationSummary: "expected true",
    timelineDigest: "0".repeat(64),
    eventLossDetected: false,
    knownLimitations: [],
  }) as EvidenceCapsuleV2;

describe("typed v0.3 mechanism evidence", () => {
  it("requires a frame-counted window to close before the rejected input", () => {
    const baselineId = asExecutionId("execution:baseline");
    const candidateId = asExecutionId("execution:frame-candidate");
    const baselineBranch = "branch:frame-baseline";
    const candidateBranch = "branch:frame-candidate";
    const opened = {
      ...eventBase(baselineId, baselineBranch, 0, 0),
      kind: "property_changed" as const,
      path: "player.window_open",
      before: false,
      after: true,
    };
    const closed = {
      ...eventBase(baselineId, baselineBranch, 1, 9),
      kind: "property_changed" as const,
      path: "player.window_open",
      before: true,
      after: false,
    };
    const rejected = {
      ...eventBase(baselineId, baselineBranch, 2, 10),
      kind: "input" as const,
      order: 0,
      action: "attempt_jump",
      target: "player",
      payload: {},
      requestedTick: 10,
      realizedTick: 10,
    };
    const accepted = {
      ...eventBase(candidateId, candidateBranch, 1, 5),
      kind: "input" as const,
      order: 0,
      action: "attempt_jump",
      target: "player",
      payload: {},
      requestedTick: 5,
      realizedTick: 5,
    };
    const candidateEvents: readonly V03TelemetryEvent[] = [
      {
        ...eventBase(candidateId, candidateBranch, 0, 0),
        kind: "property_changed",
        path: "player.window_open",
        before: false,
        after: true,
      },
      accepted,
      {
        ...eventBase(candidateId, candidateBranch, 2, 5),
        causedByEventId: accepted.eventId,
        kind: "property_changed",
        path: "player.jumping",
        before: false,
        after: true,
      },
      {
        ...eventBase(candidateId, candidateBranch, 3, 9),
        kind: "property_changed",
        path: "player.window_open",
        before: true,
        after: false,
      },
    ];
    const baseline = execution(baselineId, [opened, closed, rejected], {
      "player.process_callbacks": 2,
    });
    const candidate = execution(candidateId, candidateEvents, {
      "player.process_callbacks": 2,
      "player.jumping": true,
    });
    const compared = comparison(candidateId, {
      kind: "set_runtime_control",
      name: "fixed_fps",
      value: 60,
    });

    expect(
      validateV03MechanismEvidence(
        "frame_count_used_for_time_window",
        capsule([opened, closed, rejected], "player.jumping"),
        [compared],
        [candidate],
        baseline,
      ),
    ).toBe(true);
    expect(
      validateV03MechanismEvidence(
        "frame_count_used_for_time_window",
        capsule([opened, rejected], "player.jumping"),
        [compared],
        [candidate],
        baseline,
      ),
    ).toBe(false);
    expect(
      validateV03MechanismEvidence(
        "frame_count_used_for_time_window",
        capsule([opened, closed, rejected], "player.jumping"),
        [compared],
        [candidate],
        execution(baselineId, [opened, closed, rejected], {
          "player.process_callbacks": 3,
        }),
      ),
    ).toBe(false);
  });

  it("requires a baseline crossing and a causally grounded candidate hit", () => {
    const baselineId = asExecutionId("execution:baseline");
    const candidateId = asExecutionId("execution:physics-candidate");
    const baselineFire = {
      ...eventBase(baselineId, "branch:physics-baseline", 0, 0),
      kind: "signal" as const,
      source: "projectile",
      name: "projectile.fired",
      arguments: [],
    };
    const movement = {
      ...eventBase(baselineId, "branch:physics-baseline", 1, 0),
      causedByEventId: baselineFire.eventId,
      kind: "property_changed" as const,
      path: "projectile.x",
      before: 0,
      after: 20,
    };
    const sample = {
      ...eventBase(baselineId, "branch:physics-baseline", 2, 0),
      causedByEventId: movement.eventId,
      kind: "spatial_sample" as const,
      entity: { stableId: "projectile", incarnation: 1 },
      position: [20, 0] as const,
    };
    const candidateFire = {
      ...eventBase(candidateId, "branch:physics-candidate", 0, 0),
      kind: "signal" as const,
      source: "projectile",
      name: "projectile.fired",
      arguments: [],
    };
    const hitSample = {
      ...eventBase(candidateId, "branch:physics-candidate", 1, 0),
      causedByEventId: candidateFire.eventId,
      kind: "spatial_sample" as const,
      entity: { stableId: "projectile", incarnation: 1 },
      position: [10, 0] as const,
    };
    const hit = {
      ...eventBase(candidateId, "branch:physics-candidate", 2, 0),
      causedByEventId: hitSample.eventId,
      kind: "property_changed" as const,
      path: "target.hit",
      before: false,
      after: true,
    };
    const candidate = execution(candidateId, [candidateFire, hitSample, hit], {
      "target.hit": true,
    });
    const compared = comparison(candidateId, {
      kind: "set_runtime_control",
      name: "physics_ticks_per_second",
      value: 120,
    });

    expect(
      validateV03MechanismEvidence(
        "discrete_physics_tunneling",
        capsule([baselineFire, movement, sample], "target.hit"),
        [compared],
        [candidate],
        undefined,
      ),
    ).toBe(true);
    expect(
      validateV03MechanismEvidence(
        "discrete_physics_tunneling",
        capsule(
          [baselineFire, { ...movement, after: 8 }, sample],
          "target.hit",
        ),
        [compared],
        [candidate],
        undefined,
      ),
    ).toBe(false);
    expect(
      validateV03MechanismEvidence(
        "discrete_physics_tunneling",
        capsule([baselineFire, movement, sample], "target.hit"),
        [compared],
        [
          execution(
            candidateId,
            [candidateFire, hitSample, { ...hit, causedByEventId: undefined }],
            { "target.hit": true },
          ),
        ],
        undefined,
      ),
    ).toBe(false);
  });
});
