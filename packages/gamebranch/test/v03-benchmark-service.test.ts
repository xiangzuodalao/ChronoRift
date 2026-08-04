import {
  asBenchmarkRunId,
  asBranchId,
  asEventId,
  asExecutionId,
  asFixtureId,
  asRunId,
  type BenchmarkArmV1,
  type BenchmarkCellResultV1,
  type MechanismCodeV2,
  type V03TelemetryEvent,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import { buildV03BenchmarkReport, v03TimelineDigest } from "../src/index.js";

const benchmarkRunId = asBenchmarkRunId("benchmark:test");
const mechanisms: readonly Exclude<MechanismCodeV2, "unknown">[] = [
  "signal_before_receiver_connection",
  "frame_count_used_for_time_window",
  "discrete_physics_tunneling",
  "stale_effect_crossed_entity_incarnation",
];

const cell = (
  index: number,
  arm: BenchmarkArmV1,
  correct: boolean,
  verdict: "confirmed" | "inconclusive" = "inconclusive",
): BenchmarkCellResultV1 => {
  const expected = mechanisms[index];
  if (expected === undefined) throw new Error("Missing mechanism Fixture");
  return {
    schemaVersion: 1,
    benchmarkRunId,
    suiteHash: "b".repeat(64),
    fixtureId: asFixtureId(`fixture-${index}`),
    arm,
    repetition: 1,
    provider: "provider",
    model: "model",
    thinkingLevel: "low",
    expectedMechanism: expected,
    proposedMechanism: correct ? expected : "unknown",
    mechanismCorrect: correct,
    verdict,
    incorrectConfirmation: verdict === "confirmed" && !correct,
    sourceLocationCorrect: null,
    gameExecutions: 2,
    toolCalls: 3,
    wallTimeMs: 1,
    tokens: { input: 1, output: 1, total: 2 },
    rawManifestHash: "a".repeat(64),
  };
};

describe("v0.3 benchmark advantage Gate", () => {
  it("requires 75% full accuracy, zero false confirmation, and +20pp", () => {
    const cells = [
      ...mechanisms.map((_, index) =>
        cell(index, "chronorift-full", index < 3),
      ),
      ...mechanisms.map((_, index) => cell(index, "generic", index < 2)),
    ];
    const report = buildV03BenchmarkReport({
      benchmarkRunId,
      suiteHash: "b".repeat(64),
      seed: "seed",
      provider: "provider",
      model: "model",
      thinkingLevel: "low",
      repetitions: 1,
      cells,
    });
    expect(report.advantage).toEqual({
      fullAccuracy: 0.75,
      genericAccuracy: 0.5,
      delta: 0.25,
      incorrectConfirmations: 0,
      thresholdMet: true,
    });
  });

  it("fails on an incorrect confirmation even when accuracy thresholds pass", () => {
    const cells = [
      ...mechanisms.map((_, index) => cell(index, "chronorift-full", true)),
      ...mechanisms.map((_, index) =>
        cell(
          index,
          "generic",
          index === 0,
          index === 1 ? "confirmed" : "inconclusive",
        ),
      ),
    ];
    const report = buildV03BenchmarkReport({
      benchmarkRunId,
      suiteHash: "b".repeat(64),
      seed: "seed",
      provider: "provider",
      model: "model",
      thinkingLevel: "low",
      repetitions: 1,
      cells,
    });
    expect(report.advantage.incorrectConfirmations).toBe(1);
    expect(report.advantage.thresholdMet).toBe(false);
  });

  it("rejects duplicate benchmark cells", () => {
    const duplicate = cell(0, "generic", false);
    expect(() =>
      buildV03BenchmarkReport({
        benchmarkRunId,
        suiteHash: "b".repeat(64),
        seed: "seed",
        provider: "provider",
        model: "model",
        thinkingLevel: "low",
        repetitions: 1,
        cells: [duplicate, duplicate],
      }),
    ).toThrow("duplicate");
  });
});

describe("v0.3 semantic timeline digest", () => {
  it("preserves causal edges while ignoring execution-specific IDs", () => {
    const executionId = asExecutionId("execution:digest");
    const runId = asRunId("run:digest");
    const branchId = asBranchId("branch:digest");
    const first = asEventId("event:first");
    const second = asEventId("event:second");
    const common = { schemaVersion: 2 as const, executionId, runId, branchId };
    const events: readonly V03TelemetryEvent[] = [
      {
        ...common,
        eventId: first,
        seq: 0,
        tick: 0,
        simTimeUs: 0,
        kind: "signal",
        source: "source",
        name: "first",
        arguments: [],
      },
      {
        ...common,
        eventId: second,
        seq: 1,
        tick: 0,
        simTimeUs: 0,
        kind: "signal",
        source: "source",
        name: "second",
        arguments: [],
      },
      {
        ...common,
        eventId: asEventId("event:delivery"),
        seq: 2,
        tick: 0,
        simTimeUs: 0,
        kind: "signal_delivery",
        causedByEventId: first,
        source: "source",
        name: "delivered",
        receiver: "receiver",
        delivered: true,
      },
    ];
    const changedCause: readonly V03TelemetryEvent[] = [
      events[0]!,
      events[1]!,
      { ...events[2]!, causedByEventId: second },
    ];
    expect(v03TimelineDigest(events, { values: {} })).not.toBe(
      v03TimelineDigest(changedCause, { values: {} }),
    );
  });
});
