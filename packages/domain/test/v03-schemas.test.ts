import {
  V03ExecutionLogSchema,
  asBranchId,
  asCheckpointId,
  asContractId,
  asEventId,
  asExecutionId,
  asFixtureId,
  asInputTraceId,
  asRunId,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const executionId = asExecutionId("execution:v03:test");
const runId = asRunId("run:v03:test");
const branchId = asBranchId("branch:v03:test");
const signalId = asEventId("event:v03:signal");

const execution = {
  schemaVersion: 2 as const,
  executionId,
  runId,
  fixtureId: asFixtureId("fixture"),
  branchId,
  contractId: asContractId("contract"),
  startCheckpointId: asCheckpointId("checkpoint"),
  inputTraceId: asInputTraceId("trace"),
  status: "completed" as const,
  evaluation: {
    status: "fail" as const,
    triggerEventId: signalId,
    triggerTick: 0,
    deadlineTick: 1,
    observed: { present: true as const, value: false },
  },
  controlReceipt: {
    schemaVersion: 1 as const,
    requested: { fixed_fps: 60 },
    realized: { fixed_fps: 60 },
    accepted: true,
    mismatches: [],
  },
  observationHealth: {
    schemaVersion: 1 as const,
    emittedEvents: 2,
    droppedEvents: 0,
    truncatedEvents: 0,
    bufferedBytes: 1,
    backpressure: false,
    probeOverheadUs: 0,
  },
  events: [
    {
      schemaVersion: 2 as const,
      eventId: signalId,
      executionId,
      runId,
      branchId,
      seq: 0,
      tick: 0,
      simTimeUs: 0,
      kind: "signal" as const,
      source: "source",
      name: "activated",
      arguments: [],
    },
    {
      schemaVersion: 2 as const,
      eventId: asEventId("event:v03:delivery"),
      executionId,
      runId,
      branchId,
      seq: 1,
      tick: 0,
      simTimeUs: 0,
      kind: "signal_delivery" as const,
      causedByEventId: signalId,
      source: "source",
      name: "activated",
      receiver: "receiver",
      delivered: false,
      failureReason: "receiver_not_connected" as const,
    },
  ],
  finalState: { values: { "receiver.open": false } },
  timelineDigest: "a".repeat(64),
  sealed: true as const,
};

describe("v0.3 wire schemas", () => {
  it("accepts a sealed execution with resolvable causal references", () => {
    expect(V03ExecutionLogSchema.parse(execution).events).toHaveLength(2);
  });

  it("rejects forward or missing causal references", () => {
    const invalid = structuredClone(execution);
    invalid.events[1]!.causedByEventId = asEventId("event:v03:missing");
    expect(() => V03ExecutionLogSchema.parse(invalid)).toThrow();
  });

  it("rejects unversioned or unknown execution fields", () => {
    expect(() =>
      V03ExecutionLogSchema.parse({ ...execution, untrustedExtra: true }),
    ).toThrow();
  });
});
