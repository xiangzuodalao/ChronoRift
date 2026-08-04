import {
  BranchSpecSchema,
  EvidenceCapsuleSchema,
  ExecutionComparisonSchema,
  ExecutionLogSchema,
  asBranchId,
  asCapsuleId,
  asCheckpointId,
  asComparisonId,
  asContractId,
  asEventId,
  asExecutionId,
  asInputTraceId,
  asRunId,
  type BranchSpec,
  type EvidenceCapsule,
  type ExecutionComparison,
  type ExecutionLog,
} from "@chronorift/domain";

import type { AgentGameApi } from "../src/types.js";

export const FIXTURE_CAPSULE_ID = asCapsuleId("capsule-switch-door");
const RUN_ID = asRunId("run-switch-door");
const CONTRACT_ID = asContractId("contract-switch-door-v1");
const CHECKPOINT_ID = asCheckpointId("checkpoint-initial");
const BASELINE_BRANCH_ID = asBranchId("branch-baseline");
const CANDIDATE_BRANCH_ID = asBranchId("branch-candidate-delay-1");
const BASELINE_EXECUTION_ID = asExecutionId("execution-baseline");
const REPLAY_EXECUTION_ID = asExecutionId("execution-baseline-replay");
const CANDIDATE_EXECUTION_ID = asExecutionId("execution-candidate");
const COMPARISON_ID = asComparisonId("comparison-delay-1");

const controls = {
  deltaUs: 16_667,
  maxTicks: 1,
  variables: {},
} as const;

function baselineEvents(executionId: ReturnType<typeof asExecutionId>) {
  const signalId = asEventId(`${executionId}:signal`);
  return [
    {
      schemaVersion: 1 as const,
      eventId: asEventId(`${executionId}:input`),
      executionId,
      runId: RUN_ID,
      branchId: BASELINE_BRANCH_ID,
      seq: 0,
      tick: 0,
      simTimeUs: 0,
      kind: "input" as const,
      order: 0,
      action: "interact_switch",
      target: "switch",
      payload: {},
      requestedTick: 0,
      realizedTick: 0,
    },
    {
      schemaVersion: 1 as const,
      eventId: signalId,
      executionId,
      runId: RUN_ID,
      branchId: BASELINE_BRANCH_ID,
      seq: 1,
      tick: 0,
      simTimeUs: 0,
      kind: "signal" as const,
      source: "switch",
      name: "switch.activated",
      arguments: [],
    },
    {
      schemaVersion: 1 as const,
      eventId: asEventId(`${executionId}:delivery`),
      executionId,
      runId: RUN_ID,
      branchId: BASELINE_BRANCH_ID,
      seq: 2,
      tick: 0,
      simTimeUs: 0,
      causedByEventId: signalId,
      kind: "signal_delivery" as const,
      source: "switch",
      name: "switch.activated",
      receiver: "door",
      delivered: false,
      failureReason: "receiver_not_connected" as const,
    },
    {
      schemaVersion: 1 as const,
      eventId: asEventId(`${executionId}:receiver-connected`),
      executionId,
      runId: RUN_ID,
      branchId: BASELINE_BRANCH_ID,
      seq: 3,
      tick: 0,
      simTimeUs: 0,
      kind: "property_changed" as const,
      path: "door.receiver_connected",
      before: false,
      after: true,
    },
  ];
}

function candidateEvents() {
  const signalId = asEventId(`${CANDIDATE_EXECUTION_ID}:signal`);
  return [
    {
      schemaVersion: 1 as const,
      eventId: asEventId(`${CANDIDATE_EXECUTION_ID}:receiver-connected`),
      executionId: CANDIDATE_EXECUTION_ID,
      runId: RUN_ID,
      branchId: CANDIDATE_BRANCH_ID,
      seq: 0,
      tick: 0,
      simTimeUs: 0,
      kind: "property_changed" as const,
      path: "door.receiver_connected",
      before: false,
      after: true,
    },
    {
      schemaVersion: 1 as const,
      eventId: asEventId(`${CANDIDATE_EXECUTION_ID}:input`),
      executionId: CANDIDATE_EXECUTION_ID,
      runId: RUN_ID,
      branchId: CANDIDATE_BRANCH_ID,
      seq: 1,
      tick: 1,
      simTimeUs: 16_667,
      kind: "input" as const,
      order: 0,
      action: "interact_switch",
      target: "switch",
      payload: {},
      requestedTick: 1,
      realizedTick: 1,
    },
    {
      schemaVersion: 1 as const,
      eventId: signalId,
      executionId: CANDIDATE_EXECUTION_ID,
      runId: RUN_ID,
      branchId: CANDIDATE_BRANCH_ID,
      seq: 2,
      tick: 1,
      simTimeUs: 16_667,
      kind: "signal" as const,
      source: "switch",
      name: "switch.activated",
      arguments: [],
    },
    {
      schemaVersion: 1 as const,
      eventId: asEventId(`${CANDIDATE_EXECUTION_ID}:delivery`),
      executionId: CANDIDATE_EXECUTION_ID,
      runId: RUN_ID,
      branchId: CANDIDATE_BRANCH_ID,
      seq: 3,
      tick: 1,
      simTimeUs: 16_667,
      causedByEventId: signalId,
      kind: "signal_delivery" as const,
      source: "switch",
      name: "switch.activated",
      receiver: "door",
      delivered: true,
    },
    {
      schemaVersion: 1 as const,
      eventId: asEventId(`${CANDIDATE_EXECUTION_ID}:door-open`),
      executionId: CANDIDATE_EXECUTION_ID,
      runId: RUN_ID,
      branchId: CANDIDATE_BRANCH_ID,
      seq: 4,
      tick: 1,
      simTimeUs: 16_667,
      causedByEventId: asEventId(`${CANDIDATE_EXECUTION_ID}:delivery`),
      kind: "property_changed" as const,
      path: "door.open",
      before: false,
      after: true,
    },
  ];
}

function execution(
  executionId: ReturnType<typeof asExecutionId>,
  branchId: ReturnType<typeof asBranchId>,
  outcome: "fail" | "pass",
): ExecutionLog {
  const isCandidate = branchId === CANDIDATE_BRANCH_ID;
  const events = isCandidate ? candidateEvents() : baselineEvents(executionId);
  const trigger = events.find((event) => event.kind === "signal");
  if (!trigger) throw new Error("fixture trigger missing");
  return ExecutionLogSchema.parse({
    schemaVersion: 1,
    executionId,
    runId: RUN_ID,
    branchId,
    contractId: CONTRACT_ID,
    startCheckpointId: CHECKPOINT_ID,
    inputTraceId: asInputTraceId(
      isCandidate ? "trace-delay-one" : "trace-baseline",
    ),
    restoreReceipt: {
      requestedCheckpointId: CHECKPOINT_ID,
      restoredCheckpointId: CHECKPOINT_ID,
      restored: true,
      nextTick: 0,
      simTimeUs: 0,
      stateDigest: "state-initial",
    },
    stepReceipts: [
      {
        requestedTick: 0,
        realizedTick: 0,
        requestedDeltaUs: 16_667,
        realizedDeltaUs: 16_667,
        appliedInputOrders: isCandidate ? [] : [0],
      },
      {
        requestedTick: 1,
        realizedTick: 1,
        requestedDeltaUs: 16_667,
        realizedDeltaUs: 16_667,
        appliedInputOrders: isCandidate ? [0] : [],
      },
    ],
    events,
    timelineDigest: isCandidate ? "digest-candidate" : "digest-baseline",
    sealed: true,
    status: "completed",
    evaluation: {
      status: outcome,
      triggerEventId: trigger.eventId,
      triggerTick: isCandidate ? 1 : 0,
      deadlineTick: isCandidate ? 2 : 1,
      observed: { present: true, value: outcome === "pass" },
      ...(outcome === "pass" ? { satisfiedTick: 1 } : {}),
    },
    finalCheckpointId: asCheckpointId(`checkpoint-final-${executionId}`),
  });
}

const replayExecution = execution(
  REPLAY_EXECUTION_ID,
  BASELINE_BRANCH_ID,
  "fail",
);
export const fixtureCandidateExecution = execution(
  CANDIDATE_EXECUTION_ID,
  CANDIDATE_BRANCH_ID,
  "pass",
);

const candidateBranch: BranchSpec = BranchSpecSchema.parse({
  schemaVersion: 1,
  branchId: CANDIDATE_BRANCH_ID,
  runId: RUN_ID,
  contractId: CONTRACT_ID,
  startCheckpointId: CHECKPOINT_ID,
  inputTraceId: asInputTraceId("trace-delay-one"),
  controls,
  createdAt: "2026-01-01T00:00:00.000Z",
  branchKind: "intervention",
  parentBranchId: BASELINE_BRANCH_ID,
  intervention: { kind: "delay_input", deltaTicks: 1 },
});

export const fixtureCapsule: EvidenceCapsule = EvidenceCapsuleSchema.parse({
  schemaVersion: 1,
  capsuleId: FIXTURE_CAPSULE_ID,
  runId: RUN_ID,
  contractId: CONTRACT_ID,
  branchId: BASELINE_BRANCH_ID,
  checkpointId: CHECKPOINT_ID,
  baselineExecutionId: BASELINE_EXECUTION_ID,
  observedWindow: {
    fromTick: 0,
    toTick: 1,
    fromSeq: 0,
    toSeq: 3,
    closed: true,
  },
  triggerEventId: asEventId(`${BASELINE_EXECUTION_ID}:signal`),
  signalDeliveryEventId: asEventId(`${BASELINE_EXECUTION_ID}:delivery`),
  receiverConnectedEventId: asEventId(
    `${BASELINE_EXECUTION_ID}:receiver-connected`,
  ),
  eventChain: baselineEvents(BASELINE_EXECUTION_ID),
  stateDiff: [
    {
      path: "door.open",
      status: "unchanged",
      before: { present: true, value: false },
      after: { present: true, value: false },
      changedAtEventIds: [],
    },
  ],
  expected: { kind: "property_equals", path: "door.open", value: true },
  actual: { present: true, value: false },
  violationSummary:
    "switch.activated was emitted but delivery missed the disconnected door receiver.",
  sourceEventIds: [
    asEventId(`${BASELINE_EXECUTION_ID}:signal`),
    asEventId(`${BASELINE_EXECUTION_ID}:delivery`),
    asEventId(`${BASELINE_EXECUTION_ID}:receiver-connected`),
  ],
  integrity: {
    executionSealed: true,
    eventLossDetected: false,
    timelineDigest: "digest-baseline",
  },
  knownLimitations: [],
  nextMinimalExperiments: ["Delay the switch interaction by one tick."],
});

const fixtureComparison: ExecutionComparison = ExecutionComparisonSchema.parse({
  schemaVersion: 1,
  comparisonId: COMPARISON_ID,
  runId: RUN_ID,
  contractId: CONTRACT_ID,
  commonCheckpointId: CHECKPOINT_ID,
  baselineBranchId: BASELINE_BRANCH_ID,
  candidateBranchId: CANDIDATE_BRANCH_ID,
  baselineExecutionId: REPLAY_EXECUTION_ID,
  candidateExecutionId: CANDIDATE_EXECUTION_ID,
  intervention: { kind: "delay_input", deltaTicks: 1 },
  baselineOutcome: "fail",
  candidateOutcome: "pass",
  comparable: true,
  blockers: [],
  digestsEqual: false,
  firstDivergenceTick: 0,
});

export interface FixtureApiState {
  readonly calls: string[];
}

export function createV01AgentFixtureApi(options?: {
  readonly replayMatches?: boolean;
  readonly capsule?: EvidenceCapsule;
  readonly candidateExecution?: ExecutionLog;
}): { readonly api: AgentGameApi; readonly state: FixtureApiState } {
  const calls: string[] = [];
  const replayMatches = options?.replayMatches ?? true;
  const evidenceCapsule = options?.capsule ?? fixtureCapsule;
  const realizedCandidateExecution =
    options?.candidateExecution ?? fixtureCandidateExecution;
  return {
    state: { calls },
    api: {
      async getEvidenceCapsule(capsuleId) {
        calls.push(`capsule:${capsuleId}`);
        return capsuleId === evidenceCapsule.capsuleId ? evidenceCapsule : null;
      },
      async replayExecution({ executionId }) {
        calls.push(`replay:${executionId}`);
        const realizedReplay = replayMatches
          ? replayExecution
          : ExecutionLogSchema.parse({
              ...replayExecution,
              timelineDigest: "digest-diverged",
            });
        return {
          execution: realizedReplay,
          matches: replayMatches,
          sourceDigest: "digest-baseline",
          replayDigest: replayMatches ? "digest-baseline" : "digest-diverged",
        };
      },
      async runIntervention({ baselineExecutionId, deltaTicks }) {
        calls.push(`intervention:${baselineExecutionId}:${deltaTicks}`);
        return {
          branch: candidateBranch,
          execution: realizedCandidateExecution,
        };
      },
      async compareExecutions({ baselineExecutionId, candidateExecutionId }) {
        calls.push(`compare:${baselineExecutionId}:${candidateExecutionId}`);
        return fixtureComparison;
      },
    },
  };
}
