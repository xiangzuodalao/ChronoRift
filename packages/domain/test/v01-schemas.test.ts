import { describe, expect, it } from "vitest";

import {
  BranchSpecSchema,
  DiagnosisProposalSchema,
  DiagnosisVerdictSchema,
  EvidenceCapsuleSchema,
  ExecutionComparisonSchema,
  ExecutionLogSchema,
  FrozenContractSchema,
  SignalDeliveryEventDraftSchema,
  asBranchId,
  asCapsuleId,
  asCheckpointId,
  asComparisonId,
  asContractId,
  asEventId,
  asExecutionId,
  asInputTraceId,
  asProposalId,
  asRunId,
  asVerdictId,
  type CompletedExecutionLog,
  type EvidenceCapsule,
  type ExecutionTelemetryEvent,
} from "../src/index.js";

const runId = asRunId("run-v01");
const contractId = asContractId("sha256:contract");
const baselineBranchId = asBranchId("branch-baseline");
const candidateBranchId = asBranchId("branch-candidate");
const checkpointId = asCheckpointId("checkpoint-initial");
const inputTraceId = asInputTraceId("trace-baseline");
const baselineExecutionId = asExecutionId("execution-baseline");
const candidateExecutionId = asExecutionId("execution-candidate");

const eventIds = {
  input: asEventId("execution-baseline:0"),
  signal: asEventId("execution-baseline:1"),
  delivery: asEventId("execution-baseline:2"),
  receiverConnected: asEventId("execution-baseline:3"),
} as const;

const baselineEvents: readonly ExecutionTelemetryEvent[] = [
  {
    schemaVersion: 1,
    eventId: eventIds.input,
    executionId: baselineExecutionId,
    runId,
    branchId: baselineBranchId,
    seq: 0,
    tick: 0,
    simTimeUs: 0,
    kind: "input",
    order: 0,
    action: "interact_switch",
    target: "fixture/switch",
    payload: {},
    requestedTick: 0,
    realizedTick: 0,
  },
  {
    schemaVersion: 1,
    eventId: eventIds.signal,
    executionId: baselineExecutionId,
    runId,
    branchId: baselineBranchId,
    seq: 1,
    tick: 0,
    simTimeUs: 0,
    causedByEventId: eventIds.input,
    kind: "signal",
    source: "fixture/switch",
    name: "activated",
    arguments: [],
  },
  {
    schemaVersion: 1,
    eventId: eventIds.delivery,
    executionId: baselineExecutionId,
    runId,
    branchId: baselineBranchId,
    seq: 2,
    tick: 0,
    simTimeUs: 0,
    causedByEventId: eventIds.signal,
    kind: "signal_delivery",
    source: "fixture/switch",
    name: "activated",
    receiver: "fixture/door",
    delivered: false,
    failureReason: "receiver_not_connected",
  },
  {
    schemaVersion: 1,
    eventId: eventIds.receiverConnected,
    executionId: baselineExecutionId,
    runId,
    branchId: baselineBranchId,
    seq: 3,
    tick: 0,
    simTimeUs: 0,
    kind: "property_changed",
    path: "fixture/switch.receiver_connected",
    before: false,
    after: true,
  },
];

const baselineExecution: CompletedExecutionLog = {
  schemaVersion: 1,
  executionId: baselineExecutionId,
  runId,
  branchId: baselineBranchId,
  contractId,
  startCheckpointId: checkpointId,
  inputTraceId,
  restoreReceipt: {
    requestedCheckpointId: checkpointId,
    restoredCheckpointId: checkpointId,
    restored: true,
    nextTick: 0,
    simTimeUs: 0,
    stateDigest: "sha256:initial-state",
  },
  stepReceipts: [
    {
      requestedTick: 0,
      realizedTick: 0,
      requestedDeltaUs: 16_667,
      realizedDeltaUs: 16_667,
      appliedInputOrders: [0],
    },
  ],
  events: baselineEvents,
  timelineDigest: "sha256:baseline-timeline",
  sealed: true,
  status: "completed",
  evaluation: {
    status: "fail",
    triggerEventId: eventIds.signal,
    triggerTick: 0,
    deadlineTick: 1,
    observed: { present: true, value: false },
  },
  finalCheckpointId: asCheckpointId("checkpoint-baseline-final"),
};

const capsule: EvidenceCapsule = {
  schemaVersion: 1,
  capsuleId: asCapsuleId("capsule-baseline"),
  runId,
  contractId,
  branchId: baselineBranchId,
  checkpointId,
  baselineExecutionId,
  observedWindow: {
    fromTick: 0,
    toTick: 1,
    fromSeq: 0,
    toSeq: 3,
    closed: true,
  },
  triggerEventId: eventIds.signal,
  signalDeliveryEventId: eventIds.delivery,
  receiverConnectedEventId: eventIds.receiverConnected,
  eventChain: baselineEvents,
  stateDiff: [
    {
      path: "fixture/door.open",
      status: "unchanged",
      before: { present: true, value: false },
      after: { present: true, value: false },
      changedAtEventIds: [],
    },
  ],
  expected: {
    kind: "property_equals",
    path: "fixture/door.open",
    value: true,
  },
  actual: { present: true, value: false },
  violationSummary: "Door stayed closed after switch activation",
  sourceEventIds: [
    eventIds.signal,
    eventIds.delivery,
    eventIds.receiverConnected,
  ],
  integrity: {
    executionSealed: true,
    eventLossDetected: false,
    timelineDigest: baselineExecution.timelineDigest,
  },
  knownLimitations: [],
  nextMinimalExperiments: ["Delay the input by one tick"],
};

describe("v0.1 domain schemas", () => {
  it("parses a strict frozen switch-door contract without aliasing input", () => {
    const input = {
      schemaVersion: 1,
      contractId,
      fixture: "switch-door",
      authority: { status: "frozen", approvedBy: "fixture-owner" },
      rule: {
        trigger: {
          kind: "signal",
          source: "switch",
          name: "switch.activated",
        },
        expectation: {
          kind: "property_equals",
          path: "door.open",
          value: true,
        },
        withinTicks: 1,
        inclusive: true,
      },
    };

    const parsed = FrozenContractSchema.parse(input);
    input.authority.approvedBy = "attacker";
    expect(parsed.authority.approvedBy).toBe("fixture-owner");
    expect(() =>
      FrozenContractSchema.parse({ ...input, executableCode: "return true" }),
    ).toThrow();
  });

  it("keeps baseline and the sole delay-input intervention immutable in shape", () => {
    const common = {
      schemaVersion: 1,
      runId,
      contractId,
      startCheckpointId: checkpointId,
      controls: { deltaUs: 16_667, maxTicks: 1, variables: {} },
      createdAt: "2026-08-04T00:00:00.000Z",
    } as const;

    expect(
      BranchSpecSchema.parse({
        ...common,
        branchId: baselineBranchId,
        inputTraceId,
        branchKind: "baseline",
      }).branchKind,
    ).toBe("baseline");

    expect(
      BranchSpecSchema.parse({
        ...common,
        branchId: candidateBranchId,
        inputTraceId: asInputTraceId("trace-candidate"),
        branchKind: "intervention",
        parentBranchId: baselineBranchId,
        intervention: { kind: "delay_input", deltaTicks: 1 },
      }).branchKind,
    ).toBe("intervention");

    expect(() =>
      BranchSpecSchema.parse({
        ...common,
        branchId: candidateBranchId,
        inputTraceId,
        branchKind: "intervention",
        parentBranchId: baselineBranchId,
        intervention: { kind: "delay_input", deltaTicks: 2 },
      }),
    ).toThrow();
  });

  it("validates delivery semantics and sealed execution reference integrity", () => {
    expect(ExecutionLogSchema.parse(baselineExecution)).toEqual(
      baselineExecution,
    );
    expect(
      SignalDeliveryEventDraftSchema.parse({
        kind: "signal_delivery",
        localId: "delivery-1",
        causedByLocalId: "signal-1",
        source: "fixture/switch",
        name: "activated",
        receiver: "fixture/door",
        delivered: false,
        failureReason: "receiver_not_connected",
      }).delivered,
    ).toBe(false);
    expect(() =>
      SignalDeliveryEventDraftSchema.parse({
        kind: "signal_delivery",
        localId: "delivery-1",
        causedByLocalId: "signal-1",
        source: "fixture/switch",
        name: "activated",
        receiver: "fixture/door",
        delivered: true,
        failureReason: "unknown",
      }),
    ).toThrow();

    const wrongExecutionEvent = {
      ...baselineEvents[0],
      executionId: asExecutionId("fabricated-execution"),
    };
    expect(() =>
      ExecutionLogSchema.parse({
        ...baselineExecution,
        events: [wrongExecutionEvent, ...baselineEvents.slice(1)],
      }),
    ).toThrow();
  });

  it("requires a closed, internally resolvable evidence capsule", () => {
    expect(EvidenceCapsuleSchema.parse(capsule)).toEqual(capsule);
    expect(() =>
      EvidenceCapsuleSchema.parse({
        ...capsule,
        signalDeliveryEventId: asEventId("fabricated-event"),
      }),
    ).toThrow();
    expect(() =>
      EvidenceCapsuleSchema.parse({
        ...capsule,
        observedWindow: { ...capsule.observedWindow, toSeq: 1 },
      }),
    ).toThrow();
  });

  it("keeps comparisons explicit about comparability", () => {
    const comparison = {
      schemaVersion: 1,
      comparisonId: asComparisonId("comparison-1"),
      runId,
      contractId,
      commonCheckpointId: checkpointId,
      baselineBranchId,
      candidateBranchId,
      baselineExecutionId,
      candidateExecutionId,
      intervention: { kind: "delay_input", deltaTicks: 1 },
      baselineOutcome: "fail",
      candidateOutcome: "pass",
      comparable: true,
      blockers: [],
      digestsEqual: false,
      firstDivergenceTick: 0,
    } as const;

    expect(ExecutionComparisonSchema.parse(comparison)).toEqual(comparison);
    expect(() =>
      ExecutionComparisonSchema.parse({
        ...comparison,
        comparable: false,
        blockers: [],
      }),
    ).toThrow();
  });

  it("separates Agent confidence from the Harness verdict", () => {
    const proposal = {
      schemaVersion: 1,
      proposalId: asProposalId("proposal-1"),
      runId,
      capsuleId: capsule.capsuleId,
      baselineExecutionId,
      replayExecutionId: asExecutionId("execution-replay"),
      candidateExecutionId,
      comparisonId: asComparisonId("comparison-1"),
      claim: {
        kind: "mechanism",
        summary: "The receiver connects too late",
        mechanism:
          "The activation is emitted before the door receiver is connected",
        category: "signal_ordering",
        mechanismCode: "signal_before_receiver_connection",
        assertion: {
          signal: {
            kind: "signal",
            source: "switch",
            name: "switch.activated",
          },
          receiver: "door",
          failedDeliveryReason: "receiver_not_connected",
          expectedEffect: {
            kind: "property_equals",
            path: "door.open",
            value: true,
          },
          intervention: { kind: "delay_input", deltaTicks: 1 },
        },
      },
      observedFacts: [
        {
          statement: "The baseline delivery failed",
          references: [
            { artifactKind: "capsule", capsuleId: capsule.capsuleId },
            { artifactKind: "event", eventId: eventIds.delivery },
          ],
        },
      ],
      hypotheses: ["Initialization order drops the activation"],
      unknowns: [],
      attemptedActions: ["replay", "delay_input", "compare"],
      blockers: [],
      nextExperiment: null,
      confidence: 0,
    } as const;

    expect(DiagnosisProposalSchema.parse(proposal).confidence).toBe(0);
    expect(() =>
      DiagnosisProposalSchema.parse({ ...proposal, status: "confirmed" }),
    ).toThrow();
    expect(() =>
      DiagnosisProposalSchema.parse({
        ...proposal,
        replayExecutionId: undefined,
      }),
    ).toThrow();

    const confirmed = {
      schemaVersion: 1,
      verdictId: asVerdictId("verdict-1"),
      proposalId: proposal.proposalId,
      runId,
      status: "confirmed",
      claimLevel: "mechanism_supported",
      mechanismCode: "signal_before_receiver_connection",
      summary: "Matched replay and intervention support signal ordering",
      validatedReferences: [
        { artifactKind: "contract", contractId },
        { artifactKind: "checkpoint", checkpointId },
        { artifactKind: "capsule", capsuleId: capsule.capsuleId },
        { artifactKind: "comparison", comparisonId: proposal.comparisonId },
        { artifactKind: "execution", executionId: baselineExecutionId },
        { artifactKind: "execution", executionId: proposal.replayExecutionId },
        { artifactKind: "execution", executionId: candidateExecutionId },
        { artifactKind: "event", eventId: eventIds.signal },
        { artifactKind: "event", eventId: eventIds.delivery },
        { artifactKind: "event", eventId: eventIds.receiverConnected },
      ],
      blockers: [],
      nextExperiment: null,
    } as const;
    expect(DiagnosisVerdictSchema.parse(confirmed).status).toBe("confirmed");
    expect(() =>
      DiagnosisVerdictSchema.parse({ ...confirmed, confidence: 1 }),
    ).toThrow();

    const inconclusive = {
      schemaVersion: confirmed.schemaVersion,
      verdictId: confirmed.verdictId,
      proposalId: confirmed.proposalId,
      runId: confirmed.runId,
      summary: confirmed.summary,
      validatedReferences: confirmed.validatedReferences,
      status: "inconclusive",
      claimLevel: "none",
      blockers: [
        {
          code: "REPLAY_DIVERGED",
          message: "Baseline replay digest differs",
          references: [
            { artifactKind: "execution", executionId: baselineExecutionId },
          ],
        },
      ],
      nextExperiment: "Repeat baseline replay",
    } as const;
    expect(DiagnosisVerdictSchema.parse(inconclusive).status).toBe(
      "inconclusive",
    );
    expect(() =>
      DiagnosisVerdictSchema.parse({ ...inconclusive, blockers: [] }),
    ).toThrow();
  });
});
