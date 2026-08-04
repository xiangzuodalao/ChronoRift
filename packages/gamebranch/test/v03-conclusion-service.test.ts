import { createHash } from "node:crypto";

import {
  asBranchId,
  asCapsuleId,
  asCheckpointId,
  asComparisonId,
  asEventId,
  asEvidenceAccessReceiptId,
  asExecutionId,
  asFixtureId,
  asInterventionId,
  asProposalId,
  asRunId,
  type BranchId,
  type CapsuleId,
  type Checkpoint,
  type CheckpointContent,
  type CheckpointId,
  type ComparisonId,
  type ContractId,
  type DiagnosisProposalV2,
  type DiagnosisProposalV3,
  type DiagnosisVerdictV2,
  type EvidenceAccessKindV1,
  type EvidenceAccessReceiptV1,
  type EvidenceCapsuleV2,
  type ExecutionId,
  type FrozenContractV2,
  type InputTraceId,
  type InputTraceV2,
  type ProposalId,
  type RunId,
  type V03BranchSpec,
  type V03ExecutionComparison,
  type V03ExecutionLog,
  type V03TelemetryEvent,
  type VerdictId,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import type {
  GameEnvironmentFactoryPort,
  V03ArtifactRepositoryPort,
  V03FixtureDefinition,
} from "../src/index.js";
import {
  V03GameBranchError,
  V03GameBranchService,
  buildFailureBriefV1,
  canonicalStringify,
  v03CheckpointIdFor,
  v03ContractIdFor,
  v03InputTraceIdFor,
  v03StateDigest,
  v03EvidenceAccessReceiptIdFor,
  v03TimelineDigest,
  type V03IdGeneratorPort,
} from "../src/index.js";

const required = <T>(values: ReadonlyMap<string, T>, id: string): T => {
  const value = values.get(id);
  if (value === undefined) throw new Error(`missing ${id}`);
  return value;
};

class MemoryV03Repository implements V03ArtifactRepositoryPort {
  public readonly checkpoints = new Map<string, Checkpoint>();
  public readonly contracts = new Map<string, FrozenContractV2>();
  public readonly traces = new Map<string, InputTraceV2>();
  public readonly branches = new Map<string, V03BranchSpec>();
  public readonly executions = new Map<string, V03ExecutionLog>();
  public readonly capsules = new Map<string, EvidenceCapsuleV2>();
  public readonly comparisons = new Map<string, V03ExecutionComparison>();
  public readonly proposalsV2 = new Map<string, DiagnosisProposalV2>();
  public readonly proposalsV3 = new Map<string, DiagnosisProposalV3>();
  public readonly verdicts = new Map<string, DiagnosisVerdictV2>();

  public putCheckpoint(content: CheckpointContent): Promise<Checkpoint> {
    const checkpoint = {
      checkpointId: asCheckpointId("checkpoint:test"),
      content,
    };
    this.checkpoints.set(checkpoint.checkpointId, checkpoint);
    return Promise.resolve(checkpoint);
  }
  public getCheckpoint(id: CheckpointId): Promise<Checkpoint> {
    return Promise.resolve(required(this.checkpoints, id));
  }
  public putContract(value: FrozenContractV2): Promise<void> {
    this.contracts.set(value.contractId, value);
    return Promise.resolve();
  }
  public getContract(id: ContractId): Promise<FrozenContractV2> {
    return Promise.resolve(required(this.contracts, id));
  }
  public putInputTrace(value: InputTraceV2): Promise<void> {
    this.traces.set(value.inputTraceId, value);
    return Promise.resolve();
  }
  public getInputTrace(id: InputTraceId): Promise<InputTraceV2> {
    return Promise.resolve(required(this.traces, id));
  }
  public putBranch(value: V03BranchSpec): Promise<void> {
    this.branches.set(value.branchId, value);
    return Promise.resolve();
  }
  public getBranch(id: BranchId): Promise<V03BranchSpec> {
    return Promise.resolve(required(this.branches, id));
  }
  public putExecution(value: V03ExecutionLog): Promise<void> {
    this.executions.set(value.executionId, value);
    return Promise.resolve();
  }
  public getExecution(id: ExecutionId): Promise<V03ExecutionLog> {
    return Promise.resolve(required(this.executions, id));
  }
  public putCapsule(value: EvidenceCapsuleV2): Promise<void> {
    this.capsules.set(value.capsuleId, value);
    return Promise.resolve();
  }
  public getCapsule(id: CapsuleId): Promise<EvidenceCapsuleV2> {
    return Promise.resolve(required(this.capsules, id));
  }
  public putComparison(value: V03ExecutionComparison): Promise<void> {
    this.comparisons.set(value.comparisonId, value);
    return Promise.resolve();
  }
  public getComparison(id: ComparisonId): Promise<V03ExecutionComparison> {
    return Promise.resolve(required(this.comparisons, id));
  }
  public putProposal(value: DiagnosisProposalV2): Promise<void> {
    this.proposalsV2.set(value.proposalId, value);
    return Promise.resolve();
  }
  public getProposal(id: ProposalId): Promise<DiagnosisProposalV2> {
    return Promise.resolve(required(this.proposalsV2, id));
  }
  public putProposalV3(value: DiagnosisProposalV3): Promise<void> {
    this.proposalsV3.set(value.proposalId, value);
    return Promise.resolve();
  }
  public getProposalV3(id: ProposalId): Promise<DiagnosisProposalV3> {
    return Promise.resolve(required(this.proposalsV3, id));
  }
  public putVerdict(value: DiagnosisVerdictV2): Promise<void> {
    this.verdicts.set(value.verdictId, value);
    return Promise.resolve();
  }
  public getVerdict(id: VerdictId): Promise<DiagnosisVerdictV2> {
    return Promise.resolve(required(this.verdicts, id));
  }
}

class SequentialIds implements V03IdGeneratorPort {
  private nextValue = 0;

  public next(
    kind: "branch" | "execution" | "comparison" | "capsule" | "verdict",
  ): string {
    this.nextValue += 1;
    return `${kind}:generated:${this.nextValue}`;
  }
}

const unavailableEnvironment: GameEnvironmentFactoryPort = {
  create: () => Promise.reject(new Error("not used by conclusion tests")),
};

const fixtureId = asFixtureId("fixture:signal-ordering");
const runId = asRunId("run:conclusion");
const contractWithoutId = {
  schemaVersion: 2 as const,
  fixtureId,
  authority: { status: "frozen" as const, approvedBy: "benchmark" },
  rule: {
    trigger: { kind: "signal" as const, source: "switch", name: "activated" },
    expectation: {
      kind: "property_equals" as const,
      path: "door.open",
      value: true,
    },
    withinTicks: 1,
    inclusive: true,
  },
};
const contractId = v03ContractIdFor(contractWithoutId);
const checkpointContent: CheckpointContent = {
  schemaVersion: 1,
  environment: { adapter: "fake", adapterVersion: "1", scene: "case" },
  nextTick: 0,
  simTimeUs: 0,
  snapshot: {
    state: { values: { "door.open": false } },
    runtimeState: {},
    rngState: {},
    pendingEffects: [],
  },
};
const checkpointId = v03CheckpointIdFor(checkpointContent);
const baselineTraceWithoutId = {
  schemaVersion: 2 as const,
  inputs: [
    {
      scheduleBasis: "relative_tick" as const,
      relativeTick: 0,
      order: 0,
      action: "interact_switch",
      target: "switch",
      payload: {},
    },
  ],
};
const traceId = v03InputTraceIdFor(baselineTraceWithoutId);
const baselineTrace: InputTraceV2 = {
  ...baselineTraceWithoutId,
  inputTraceId: traceId,
};
const candidateTraceWithoutId = {
  schemaVersion: 2 as const,
  inputs: [{ ...baselineTrace.inputs[0]!, relativeTick: 1 }],
};
const candidateTrace: InputTraceV2 = {
  ...candidateTraceWithoutId,
  inputTraceId: v03InputTraceIdFor(candidateTraceWithoutId),
};
const baselineBranchId = asBranchId("branch:baseline");
const candidateBranchId = asBranchId("branch:candidate");
const baselineExecutionId = asExecutionId("execution:baseline");
const replayExecutionId = asExecutionId("execution:replay");
const candidateExecutionId = asExecutionId("execution:candidate");
const capsuleId = asCapsuleId("capsule:conclusion");

const contract: FrozenContractV2 = {
  ...contractWithoutId,
  contractId,
};

const baselineBranch: V03BranchSpec = {
  schemaVersion: 2,
  branchId: baselineBranchId,
  runId,
  fixtureId,
  branchKind: "baseline",
  contractId,
  startCheckpointId: checkpointId,
  inputTraceId: traceId,
  controls: { deltaUs: 16_667, maxTicks: 2, variables: {} },
  createdAt: "2025-01-01T00:00:00.000Z",
};

const intervention = {
  kind: "shift_input" as const,
  inputOrder: 0,
  deltaTicks: 1,
};

const candidateBranch = (
  candidateRunId: RunId = runId,
): Extract<V03BranchSpec, { readonly branchKind: "intervention" }> => ({
  schemaVersion: 2,
  branchId: candidateBranchId,
  runId: candidateRunId,
  fixtureId,
  branchKind: "intervention",
  parentBranchId: baselineBranchId,
  interventionId: asInterventionId("intervention:receiver-first"),
  intervention,
  contractId,
  startCheckpointId: checkpointId,
  inputTraceId: candidateTrace.inputTraceId,
  controls: { deltaUs: 16_667, maxTicks: 2, variables: {} },
  createdAt: "2025-01-01T00:00:01.000Z",
});

const eventsFor = (
  executionId: ExecutionId,
  branchId: BranchId,
  eventRunId: RunId,
  delivered: boolean,
): readonly V03TelemetryEvent[] => {
  const inputTick = delivered ? 1 : 0;
  const inputId = asEventId(`event:${executionId}:input`);
  const signalId = asEventId(`event:${executionId}:signal`);
  const deliveryId = asEventId(`event:${executionId}:delivery`);
  return [
    {
      schemaVersion: 2,
      eventId: inputId,
      executionId,
      runId: eventRunId,
      branchId,
      seq: 0,
      tick: inputTick,
      simTimeUs: inputTick * 16_667,
      kind: "input",
      order: 0,
      action: "interact_switch",
      target: "switch",
      payload: {},
      requestedTick: inputTick,
      realizedTick: inputTick,
    },
    {
      schemaVersion: 2,
      eventId: signalId,
      executionId,
      runId: eventRunId,
      branchId,
      seq: 1,
      tick: inputTick,
      simTimeUs: inputTick * 16_667,
      causedByEventId: inputId,
      kind: "signal",
      source: "switch",
      name: "activated",
      arguments: [],
    },
    {
      schemaVersion: 2,
      eventId: deliveryId,
      executionId,
      runId: eventRunId,
      branchId,
      seq: 2,
      tick: inputTick,
      simTimeUs: inputTick * 16_667,
      causedByEventId: signalId,
      kind: "signal_delivery",
      source: "switch",
      name: "activated",
      receiver: "door",
      delivered,
      ...(delivered
        ? {}
        : { failureReason: "receiver_not_connected" as const }),
    },
    ...(delivered
      ? [
          {
            schemaVersion: 2 as const,
            eventId: asEventId(`event:${executionId}:door-open`),
            executionId,
            runId: eventRunId,
            branchId,
            seq: 3,
            tick: inputTick,
            simTimeUs: inputTick * 16_667,
            causedByEventId: deliveryId,
            kind: "property_changed" as const,
            path: "door.open",
            before: false,
            after: true,
          },
        ]
      : [
          {
            schemaVersion: 2 as const,
            eventId: asEventId(`event:${executionId}:connected`),
            executionId,
            runId: eventRunId,
            branchId,
            seq: 3,
            tick: 1,
            simTimeUs: 16_667,
            kind: "property_changed" as const,
            path: "switch.receiver_connected",
            before: false,
            after: true,
          },
        ]),
  ];
};

const executionFor = (options: {
  readonly executionId: ExecutionId;
  readonly branchId: BranchId;
  readonly executionRunId?: RunId;
  readonly delivered: boolean;
  readonly inputTraceId?: InputTraceId;
}): V03ExecutionLog => {
  const executionRunId = options.executionRunId ?? runId;
  const events = eventsFor(
    options.executionId,
    options.branchId,
    executionRunId,
    options.delivered,
  );
  const finalState = { values: { "door.open": options.delivered } };
  return {
    schemaVersion: 2,
    executionId: options.executionId,
    runId: executionRunId,
    fixtureId,
    branchId: options.branchId,
    contractId,
    startCheckpointId: checkpointId,
    inputTraceId:
      options.inputTraceId ??
      (options.delivered ? candidateTrace.inputTraceId : traceId),
    status: "completed",
    evaluation: {
      status: options.delivered ? "pass" : "fail",
      triggerEventId: events[1]!.eventId,
      triggerTick: options.delivered ? 1 : 0,
      deadlineTick: options.delivered ? 2 : 1,
      observed: { present: true, value: options.delivered },
      ...(options.delivered ? { satisfiedTick: 1 } : {}),
    },
    restoreReceipt: {
      requestedCheckpointId: checkpointId,
      restoredCheckpointId: checkpointId,
      restored: true,
      nextTick: 0,
      simTimeUs: 0,
      stateDigest: v03StateDigest({ values: { "door.open": false } }),
    },
    stepReceipts: [0, 1, 2].map((tick) => ({
      requestedTick: tick,
      realizedTick: tick,
      requestedDeltaUs: 16_667,
      realizedDeltaUs: 16_667,
      appliedInputOrders: [options.delivered ? 1 : 0].includes(tick) ? [0] : [],
    })),
    controlReceipt: {
      schemaVersion: 1,
      requested: { fixed_fps: 60, physics_ticks_per_second: 60 },
      realized: { fixed_fps: 60, physics_ticks_per_second: 60 },
      accepted: true,
      mismatches: [],
    },
    observationHealth: {
      schemaVersion: 1,
      emittedEvents: events.length,
      droppedEvents: 0,
      truncatedEvents: 0,
      bufferedBytes: 0,
      backpressure: false,
      probeOverheadUs: 0,
    },
    events,
    finalState,
    timelineDigest: v03TimelineDigest(events, finalState),
    sealed: true,
  };
};

const fixture: V03FixtureDefinition = {
  fixtureId,
  contractInput: {
    schemaVersion: 2,
    fixtureId,
    authority: contract.authority,
    rule: contract.rule,
  },
  initialCheckpointContent: checkpointContent,
  inputTrace: baselineTrace,
  baselineControls: baselineBranch.controls,
  probeProperties: ["door.open", "switch.receiver_connected"],
  experiments: [],
  fixtureControlDefaults: {},
  checkpointLimitations: [],
};

interface ConclusionContext {
  readonly repository: MemoryV03Repository;
  readonly service: V03GameBranchService;
  readonly baseline: V03ExecutionLog;
  readonly replay: V03ExecutionLog;
  readonly candidate: V03ExecutionLog;
  readonly capsule: EvidenceCapsuleV2;
}

const createContext = (): ConclusionContext => {
  const repository = new MemoryV03Repository();
  const baseline = executionFor({
    executionId: baselineExecutionId,
    branchId: baselineBranchId,
    delivered: false,
  });
  const replay = executionFor({
    executionId: replayExecutionId,
    branchId: baselineBranchId,
    delivered: false,
  });
  const candidate = executionFor({
    executionId: candidateExecutionId,
    branchId: candidateBranchId,
    delivered: true,
  });
  const capsule: EvidenceCapsuleV2 = {
    schemaVersion: 2,
    capsuleId,
    runId,
    fixtureId,
    contractId,
    baselineExecutionId,
    checkpointId,
    eventChain: baseline.events,
    evidenceLinks: baseline.events.map((event) => ({
      role:
        event.kind === "signal"
          ? "trigger"
          : event.kind === "signal_delivery"
            ? "delivery"
            : "state_transition",
      eventId: event.eventId,
    })),
    expected: contract.rule.expectation,
    actual: baseline.evaluation.observed,
    violationSummary: "door.open remained false through tick 1",
    timelineDigest: baseline.timelineDigest,
    eventLossDetected: false,
    knownLimitations: [],
  };
  repository.contracts.set(contractId, contract);
  repository.checkpoints.set(checkpointId, {
    checkpointId,
    content: fixture.initialCheckpointContent,
  });
  repository.branches.set(baselineBranchId, baselineBranch);
  repository.branches.set(candidateBranchId, candidateBranch());
  repository.traces.set(traceId, baselineTrace);
  repository.traces.set(candidateTrace.inputTraceId, candidateTrace);
  repository.executions.set(baselineExecutionId, baseline);
  repository.executions.set(replayExecutionId, replay);
  repository.executions.set(candidateExecutionId, candidate);
  repository.capsules.set(capsuleId, capsule);
  return {
    repository,
    service: new V03GameBranchService(
      repository,
      unavailableEnvironment,
      fixture,
      new SequentialIds(),
      { nowIso: () => "2025-01-01T00:00:00.000Z" },
    ),
    baseline,
    replay,
    candidate,
    capsule,
  };
};

const receiptFor = (
  accessKind: EvidenceAccessKindV1,
  resourceId: string,
  _suffix: string,
  receiptRunId: RunId = runId,
): EvidenceAccessReceiptV1 => {
  const context = createContext();
  const comparison: V03ExecutionComparison = {
    schemaVersion: 2,
    comparisonId: asComparisonId(resourceId),
    runId,
    fixtureId,
    contractId,
    baselineExecutionId,
    candidateExecutionId,
    interventionId: candidateBranch().interventionId,
    intervention,
    baselineOutcome: "fail",
    candidateOutcome: "pass",
    comparable: true,
    blockers: [],
    firstDivergenceTick: 0,
  };
  const request: unknown =
    accessKind === "failure_brief"
      ? { delivery: "initial_prompt" }
      : accessKind === "raw_execution" || accessKind === "replay"
        ? { executionId: baselineExecutionId }
        : accessKind === "capsule"
          ? { capsuleId }
          : accessKind === "experiment"
            ? {
                baselineExecutionId,
                interventionId: candidateBranch().interventionId,
              }
            : accessKind === "comparison"
              ? { baselineExecutionId, candidateExecutionId }
              : {};
  const toolContent: unknown =
    accessKind === "failure_brief"
      ? buildFailureBriefV1({
          contract,
          capsule: context.capsule,
          execution: context.baseline,
        })
      : accessKind === "raw_execution"
        ? { schemaVersion: 1, execution: context.baseline }
        : accessKind === "capsule"
          ? context.capsule
          : accessKind === "replay"
            ? {
                execution: context.replay,
                matches: true,
                sourceDigest: context.capsule.timelineDigest,
                replayDigest: context.replay.timelineDigest,
              }
            : accessKind === "experiment"
              ? {
                  interventionId: candidateBranch().interventionId,
                  executionId: context.candidate.executionId,
                  rawEvents: context.candidate.events,
                  finalState: context.candidate.finalState,
                  contractOutcome: context.candidate.evaluation.status,
                }
              : accessKind === "comparison"
                ? comparison
                : {};
  const digest = (value: unknown): string =>
    createHash("sha256")
      .update(canonicalStringify(value as never))
      .digest("hex");
  const receiptContent = {
    schemaVersion: 1 as const,
    runId: receiptRunId,
    fixtureId,
    accessKind,
    resourceId,
    requestHash: digest(request),
    contentHash: digest(toolContent),
    sourceCoverage: [],
  };
  return {
    ...receiptContent,
    receiptId: v03EvidenceAccessReceiptIdFor(receiptContent),
    issuedAt: "2025-01-01T00:00:00.000Z",
  };
};

const proposalFor = (
  proposalSuffix: string,
  receipts: readonly EvidenceAccessReceiptV1[],
): DiagnosisProposalV3 => ({
  schemaVersion: 3,
  proposalId: asProposalId(`proposal:${proposalSuffix}`),
  runId,
  fixtureId,
  capsuleId,
  baselineExecutionId,
  replayExecutionId,
  candidateExecutionIds: [candidateExecutionId],
  comparisonIds: [],
  accessReceiptIds: receipts.map((receipt) => receipt.receiptId),
  mechanismCode: "signal_before_receiver_connection",
  summary: "The signal fired before the receiver connected",
  evidenceEventIds: [
    asEventId(`event:${baselineExecutionId}:delivery`),
    asEventId(`event:${baselineExecutionId}:connected`),
    asEventId(`event:${candidateExecutionId}:delivery`),
    asEventId(`event:${candidateExecutionId}:door-open`),
  ],
  blockers: [],
  nextExperiment: null,
  confidence: 0,
});

const groundedReceipts = (): readonly EvidenceAccessReceiptV1[] => [
  receiptFor("failure_brief", capsuleId, "brief"),
  receiptFor("raw_execution", baselineExecutionId, "baseline"),
  receiptFor("replay", replayExecutionId, "replay"),
  receiptFor("experiment", candidateExecutionId, "candidate"),
];

describe("V03 Failure Brief and Conclusion Gate", () => {
  it("builds a strict Failure Brief only from matching frozen evidence", () => {
    const context = createContext();
    expect(
      buildFailureBriefV1({
        contract,
        capsule: context.capsule,
        execution: context.baseline,
      }),
    ).toEqual({
      schemaVersion: 1,
      runId,
      fixtureId,
      contractId,
      capsuleId,
      baselineExecutionId,
      trigger: contract.rule.trigger,
      triggerEventId: context.baseline.evaluation.triggerEventId,
      triggerTick: 0,
      expectation: contract.rule.expectation,
      deadlineTick: 1,
      actual: { present: true, value: false },
      violationSummary: context.capsule.violationSummary,
    });
    expect(() =>
      buildFailureBriefV1({
        contract,
        capsule: context.capsule,
        execution: { ...context.baseline, timelineDigest: "0".repeat(64) },
      }),
    ).toThrow(V03GameBranchError);
  });

  it("confirms a generic proposal by creating its missing canonical comparison", async () => {
    const context = createContext();
    const receipts = groundedReceipts();
    const proposal = proposalFor("generic", receipts);

    const verdict = await context.service.concludeV3(proposal, receipts);

    expect(verdict.blockers).toEqual([]);
    expect(verdict.status).toBe("confirmed");
    expect(proposal.confidence).toBe(0);
    expect(context.repository.comparisons.size).toBe(1);
    await expect(
      context.repository.getProposalV3(proposal.proposalId),
    ).resolves.toEqual(proposal);
  });

  it("does not let the Gate supply an uncited mechanism-specific causal chain", async () => {
    const context = createContext();
    const receipts = groundedReceipts();
    const proposal = {
      ...proposalFor("uncited-chain", receipts),
      evidenceEventIds: [asEventId(`event:${baselineExecutionId}:delivery`)],
    };

    const verdict = await context.service.concludeV3(proposal, receipts);

    expect(verdict.status).toBe("inconclusive");
    expect(verdict.blockers).toContain(
      "Evidence does not validate the proposed mechanism",
    );
  });

  it("rejects schema-valid Contract and trace content under stale content IDs", async () => {
    const context = createContext();
    const receipts = groundedReceipts();
    context.repository.contracts.set(contractId, {
      ...contract,
      rule: { ...contract.rule, withinTicks: 2 },
    });
    context.repository.traces.set(traceId, {
      ...baselineTrace,
      inputs: [{ ...baselineTrace.inputs[0]!, relativeTick: 1 }],
    });

    const verdict = await context.service.concludeV3(
      proposalFor("stale-content-ids", receipts),
      receipts,
    );

    expect(verdict.status).toBe("inconclusive");
    expect(verdict.blockers).toContain(
      "Baseline evidence does not pass the canonical integrity Gate",
    );
    expect(verdict.blockers).toContain(
      "Frozen Contract does not match the Capsule",
    );
  });

  it("does not let a full evidence path omit its required comparison", async () => {
    const context = createContext();
    const receipts = [
      receiptFor("failure_brief", capsuleId, "full-brief"),
      receiptFor("capsule", capsuleId, "full-capsule"),
      receiptFor("replay", replayExecutionId, "full-replay"),
      receiptFor("experiment", candidateExecutionId, "full-candidate"),
    ];
    const proposal = proposalFor("full-without-compare", receipts);

    const verdict = await context.service.concludeV3(proposal, receipts);

    expect(verdict.status).toBe("inconclusive");
    expect(verdict.blockers).toContain(
      `Candidate execution ${candidateExecutionId} has no Agent-cited comparison`,
    );
    expect(context.repository.comparisons.size).toBe(0);
  });

  it("does not auto-compare candidates omitted by a partial full comparison set", async () => {
    const context = createContext();
    const comparison = await context.service.compareExecutions(
      baselineExecutionId,
      candidateExecutionId,
    );
    const secondCandidateId = asExecutionId("execution:candidate:second");
    context.repository.executions.set(
      secondCandidateId,
      executionFor({
        executionId: secondCandidateId,
        branchId: candidateBranchId,
        delivered: true,
      }),
    );
    const receipts = [
      receiptFor("failure_brief", capsuleId, "partial-brief"),
      receiptFor("capsule", capsuleId, "partial-capsule"),
      receiptFor("replay", replayExecutionId, "partial-replay"),
      receiptFor("experiment", candidateExecutionId, "partial-candidate-1"),
      receiptFor("experiment", secondCandidateId, "partial-candidate-2"),
      receiptFor("comparison", comparison.comparisonId, "partial-comparison"),
    ];
    const proposal: DiagnosisProposalV3 = {
      ...proposalFor("partial-full", receipts),
      candidateExecutionIds: [candidateExecutionId, secondCandidateId],
      comparisonIds: [comparison.comparisonId],
    };

    const verdict = await context.service.concludeV3(proposal, receipts);

    expect(verdict.status).toBe("inconclusive");
    expect(verdict.blockers).toContain(
      `Candidate execution ${secondCandidateId} has no Agent-cited comparison`,
    );
    expect(context.repository.comparisons.size).toBe(1);
  });

  it("keeps confidence-only evidence inconclusive when replay is missing", async () => {
    const context = createContext();
    const receipts = groundedReceipts().filter(
      (receipt) => receipt.accessKind !== "replay",
    );
    const proposal = {
      ...proposalFor("confidence", receipts),
      replayExecutionId: undefined,
      confidence: 1,
    };

    const verdict = await context.service.concludeV3(proposal, receipts);

    expect(verdict.status).toBe("inconclusive");
    expect(verdict.blockers).toContain(
      "A matching failing strict replay is required",
    );
  });

  it("rejects an unresolved candidate even when its receipt is syntactically valid", async () => {
    const context = createContext();
    const forgedId = asExecutionId("execution:forged");
    const receipts = [
      ...groundedReceipts().filter(
        (receipt) => receipt.accessKind !== "experiment",
      ),
      receiptFor("experiment", forgedId, "forged-candidate"),
    ];
    const proposal = {
      ...proposalFor("forged-candidate", receipts),
      candidateExecutionIds: [forgedId],
    };

    const verdict = await context.service.concludeV3(proposal, receipts);

    expect(verdict.status).toBe("inconclusive");
    expect(verdict.blockers).toContain(
      `Referenced candidate execution ${forgedId} could not be resolved`,
    );
  });

  it("rejects a candidate execution from another run", async () => {
    const context = createContext();
    const otherRunId = asRunId("run:other");
    const crossRunCandidate = executionFor({
      executionId: candidateExecutionId,
      branchId: candidateBranchId,
      executionRunId: otherRunId,
      delivered: true,
    });
    context.repository.executions.set(candidateExecutionId, crossRunCandidate);
    context.repository.branches.set(
      candidateBranchId,
      candidateBranch(otherRunId),
    );
    const receipts = groundedReceipts();

    const verdict = await context.service.concludeV3(
      proposalFor("cross-run-candidate", receipts),
      receipts,
    );

    expect(verdict.status).toBe("inconclusive");
    expect(
      verdict.blockers.some((blocker) =>
        blocker.includes("canonical comparison Gate"),
      ),
    ).toBe(true);
  });

  it("rejects a comparison whose candidate was not explicitly cited", async () => {
    const context = createContext();
    const comparison = await context.service.compareExecutions(
      baselineExecutionId,
      candidateExecutionId,
    );
    const receipts = [
      ...groundedReceipts().filter(
        (receipt) => receipt.accessKind !== "experiment",
      ),
      receiptFor("comparison", comparison.comparisonId, "comparison"),
    ];
    const proposal: DiagnosisProposalV3 = {
      ...proposalFor("unseen-candidate", receipts),
      candidateExecutionIds: [],
      comparisonIds: [comparison.comparisonId],
    };

    const verdict = await context.service.concludeV3(proposal, receipts);

    expect(verdict.status).toBe("inconclusive");
    expect(verdict.blockers).toContain(
      `Comparison ${comparison.comparisonId} cites a candidate the Agent did not explicitly cite`,
    );
  });

  it("rejects missing and cross-run access receipts", async () => {
    const context = createContext();
    const receipts = groundedReceipts();
    const missingReceiptId = asEvidenceAccessReceiptId("receipt:not-supplied");
    const proposal = {
      ...proposalFor("bad-receipts", receipts),
      accessReceiptIds: [
        ...receipts.map((receipt) => receipt.receiptId),
        missingReceiptId,
      ],
    };
    const crossRunReceipts = receipts.map((receipt) =>
      receipt.accessKind === "failure_brief"
        ? { ...receipt, runId: asRunId("run:foreign") }
        : receipt,
    );

    const verdict = await context.service.concludeV3(
      proposal,
      crossRunReceipts,
    );

    expect(verdict.status).toBe("inconclusive");
    expect(verdict.blockers).toContain(
      `Referenced evidence-access receipt ${missingReceiptId} is missing`,
    );
    expect(
      verdict.blockers.some((blocker) =>
        blocker.includes("invalid content ID"),
      ),
    ).toBe(true);
  });

  it("recomputes receipt IDs and binds their hashes to resolved tool material", async () => {
    const context = createContext();
    const receipts = groundedReceipts().map((receipt) => {
      if (receipt.accessKind !== "raw_execution") return receipt;
      const basis = {
        schemaVersion: 1 as const,
        runId: receipt.runId,
        fixtureId: receipt.fixtureId,
        accessKind: receipt.accessKind,
        resourceId: receipt.resourceId,
        requestHash: receipt.requestHash,
        contentHash: "f".repeat(64),
        sourceCoverage: receipt.sourceCoverage,
      };
      return {
        ...basis,
        receiptId: v03EvidenceAccessReceiptIdFor(basis),
        issuedAt: receipt.issuedAt,
      };
    });
    const proposal = proposalFor("material-tamper", receipts);

    const verdict = await context.service.concludeV3(proposal, receipts);

    expect(verdict.status).toBe("inconclusive");
    expect(
      verdict.blockers.some((blocker) =>
        blocker.includes("does not match the resolved tool material"),
      ),
    ).toBe(true);
  });

  it("does not accept a forged stored comparison", async () => {
    const context = createContext();
    const forgedComparison: V03ExecutionComparison = {
      schemaVersion: 2,
      comparisonId: asComparisonId("comparison:forged"),
      runId,
      fixtureId,
      contractId,
      baselineExecutionId,
      candidateExecutionId,
      interventionId: asInterventionId("intervention:receiver-first"),
      intervention,
      baselineOutcome: "fail",
      candidateOutcome: "pass",
      comparable: true,
      blockers: [],
      firstDivergenceTick: 0,
    };
    context.repository.comparisons.set(
      forgedComparison.comparisonId,
      forgedComparison,
    );
    context.repository.branches.set(candidateBranchId, {
      ...candidateBranch(),
      parentBranchId: asBranchId("branch:forged-parent"),
    });
    const receipts = [
      ...groundedReceipts(),
      receiptFor(
        "comparison",
        forgedComparison.comparisonId,
        "forged-comparison",
      ),
    ];
    const proposal = {
      ...proposalFor("forged-comparison", receipts),
      comparisonIds: [forgedComparison.comparisonId],
    };

    const verdict = await context.service.concludeV3(proposal, receipts);

    expect(verdict.status).toBe("inconclusive");
    expect(verdict.blockers).toContain(
      `Comparison ${forgedComparison.comparisonId} does not pass the canonical comparison Gate`,
    );
  });
});
