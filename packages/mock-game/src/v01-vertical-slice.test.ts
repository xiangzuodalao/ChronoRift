import {
  BranchSpecSchema,
  CheckpointSchema,
  DiagnosisProposalSchema,
  DiagnosisVerdictSchema,
  EvidenceCapsuleSchema,
  ExecutionComparisonSchema,
  ExecutionLogSchema,
  FrozenContractSchema,
  InputTraceSchema,
  asCheckpointId,
  asComparisonId,
  asEventId,
  asProposalId,
  asRunId,
  type BranchId,
  type BranchSpec,
  type CapsuleId,
  type Checkpoint,
  type CheckpointContent,
  type CheckpointId,
  type ComparisonId,
  type ContractId,
  type DiagnosisProposal,
  type DiagnosisVerdict,
  type EvidenceCapsule,
  type ExecutionComparison,
  type ExecutionId,
  type ExecutionLog,
  type FrozenContract,
  type InputTrace,
  type InputTraceId,
  type JsonValue,
  type ProposalId,
  type VerdictId,
} from "@chronorift/domain";
import {
  V01GameBranchService,
  digestJson,
  type ClockPort,
  type V01ArtifactRepositoryPort,
  type V01GameBranchError,
  type V01IdGeneratorPort,
} from "@chronorift/gamebranch";
import { describe, expect, it } from "vitest";

import { MockGameEnvironmentFactory } from "./mock-game-environment.js";
import { buildV01SwitchDoorFixture } from "./scenario.js";

const missing = (kind: string, id: string): never => {
  throw new Error(`Missing ${kind}: ${id}`);
};

class MemoryV01Repository implements V01ArtifactRepositoryPort {
  readonly checkpoints = new Map<CheckpointId, Checkpoint>();
  readonly traces = new Map<InputTraceId, InputTrace>();
  readonly contracts = new Map<ContractId, FrozenContract>();
  readonly branches = new Map<BranchId, BranchSpec>();
  readonly executions = new Map<ExecutionId, ExecutionLog>();
  readonly capsules = new Map<CapsuleId, EvidenceCapsule>();
  readonly comparisons = new Map<ComparisonId, ExecutionComparison>();
  readonly proposals = new Map<ProposalId, DiagnosisProposal>();
  readonly verdicts = new Map<VerdictId, DiagnosisVerdict>();

  async putCheckpoint(content: CheckpointContent): Promise<Checkpoint> {
    const checkpoint = CheckpointSchema.parse({
      checkpointId: asCheckpointId(
        `checkpoint:${digestJson(content as unknown as JsonValue)}`,
      ),
      content,
    });
    this.checkpoints.set(checkpoint.checkpointId, checkpoint);
    return checkpoint;
  }

  async getCheckpoint(checkpointId: CheckpointId): Promise<Checkpoint> {
    return (
      this.checkpoints.get(checkpointId) ?? missing("checkpoint", checkpointId)
    );
  }

  async putInputTrace(trace: InputTrace): Promise<void> {
    const parsed = InputTraceSchema.parse(trace);
    this.traces.set(parsed.inputTraceId, parsed);
  }

  async getInputTrace(inputTraceId: InputTraceId): Promise<InputTrace> {
    return this.traces.get(inputTraceId) ?? missing("trace", inputTraceId);
  }

  async putFrozenContract(contract: FrozenContract): Promise<void> {
    const parsed = FrozenContractSchema.parse(contract);
    this.contracts.set(parsed.contractId, parsed);
  }

  async getFrozenContract(contractId: ContractId): Promise<FrozenContract> {
    return this.contracts.get(contractId) ?? missing("contract", contractId);
  }

  async putBranchSpec(branch: BranchSpec): Promise<void> {
    const parsed = BranchSpecSchema.parse(branch);
    this.branches.set(parsed.branchId, parsed);
  }

  async getBranchSpec(branchId: BranchId): Promise<BranchSpec> {
    return this.branches.get(branchId) ?? missing("branch", branchId);
  }

  async putExecutionLog(execution: ExecutionLog): Promise<void> {
    const parsed = ExecutionLogSchema.parse(execution);
    this.executions.set(parsed.executionId, parsed);
  }

  async getExecutionLog(executionId: ExecutionId): Promise<ExecutionLog> {
    return (
      this.executions.get(executionId) ?? missing("execution", executionId)
    );
  }

  async putEvidenceCapsule(capsule: EvidenceCapsule): Promise<void> {
    const parsed = EvidenceCapsuleSchema.parse(capsule);
    this.capsules.set(parsed.capsuleId, parsed);
  }

  async getEvidenceCapsule(capsuleId: CapsuleId): Promise<EvidenceCapsule> {
    return this.capsules.get(capsuleId) ?? missing("capsule", capsuleId);
  }

  async putExecutionComparison(comparison: ExecutionComparison): Promise<void> {
    const parsed = ExecutionComparisonSchema.parse(comparison);
    this.comparisons.set(parsed.comparisonId, parsed);
  }

  async getExecutionComparison(
    comparisonId: ComparisonId,
  ): Promise<ExecutionComparison> {
    return (
      this.comparisons.get(comparisonId) ?? missing("comparison", comparisonId)
    );
  }

  async putDiagnosisProposal(proposal: DiagnosisProposal): Promise<void> {
    const parsed = DiagnosisProposalSchema.parse(proposal);
    this.proposals.set(parsed.proposalId, parsed);
  }

  async getDiagnosisProposal(
    proposalId: ProposalId,
  ): Promise<DiagnosisProposal> {
    return this.proposals.get(proposalId) ?? missing("proposal", proposalId);
  }

  async putDiagnosisVerdict(verdict: DiagnosisVerdict): Promise<void> {
    const parsed = DiagnosisVerdictSchema.parse(verdict);
    this.verdicts.set(parsed.verdictId, parsed);
  }

  async getDiagnosisVerdict(verdictId: VerdictId): Promise<DiagnosisVerdict> {
    return this.verdicts.get(verdictId) ?? missing("verdict", verdictId);
  }
}

class SequentialV01Ids implements V01IdGeneratorPort {
  private readonly counters = new Map<string, number>();

  next(
    kind: "branch" | "execution" | "comparison" | "capsule" | "verdict",
  ): string {
    const value = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, value);
    return `${kind}-${value}`;
  }
}

const clock: ClockPort = { nowIso: () => "2026-08-04T00:00:00.000Z" };

const supportedMechanismAssertion = {
  mechanismCode: "signal_before_receiver_connection" as const,
  assertion: {
    signal: {
      kind: "signal" as const,
      source: "switch",
      name: "switch.activated",
    },
    receiver: "door",
    failedDeliveryReason: "receiver_not_connected" as const,
    expectedEffect: {
      kind: "property_equals" as const,
      path: "door.open",
      value: true,
    },
    intervention: { kind: "delay_input" as const, deltaTicks: 1 as const },
  },
};

const testRuntimeFingerprint = {
  schemaVersion: 1,
  engine: "godot",
  engineVersion: "4.7.1-stable (official)",
  adapterVersion: "0.2.0",
  protocolVersion: 1,
  platform: "Linux",
  renderer: "gl_compatibility",
  physicsTicksPerSecond: 60,
  fixedFps: 60,
  projectHash: "a".repeat(64),
  addonHash: "b".repeat(64),
  capabilities: [
    "observe.signal_allowlist",
    "observe.property_sampling",
    "control.input_event_action",
    "clock.process_frame",
    "clock.physics_tick",
    "launch.fixed_fps",
    "checkpoint.l0_restart",
    "checkpoint.fixture_semantic",
  ],
} as const;

const setup = async (): Promise<{
  readonly repository: MemoryV01Repository;
  readonly service: V01GameBranchService;
  readonly baseline: ExecutionLog;
  readonly capsule: EvidenceCapsule;
}> => {
  const repository = new MemoryV01Repository();
  const service = new V01GameBranchService(
    repository,
    new MockGameEnvironmentFactory(),
    new SequentialV01Ids(),
    clock,
  );
  const fixture = buildV01SwitchDoorFixture();
  const contract = await service.freezeContract(fixture.contractInput);
  const checkpoint = await repository.putCheckpoint(
    fixture.initialCheckpointContent,
  );
  await repository.putInputTrace(fixture.inputTrace);
  const branch = await service.createBaseline({
    runId: asRunId("run-v01"),
    contractId: contract.contractId,
    checkpointId: checkpoint.checkpointId,
    inputTraceId: fixture.inputTrace.inputTraceId,
    controls: fixture.controls,
  });
  const baseline = await service.execute(branch.branchId);
  const capsule = await service.compileEvidence({
    executionId: baseline.executionId,
  });
  return { repository, service, baseline, capsule };
};

const completeExperiment = async (
  context: Awaited<ReturnType<typeof setup>>,
) => {
  const replay = await context.service.replayExecution({
    executionId: context.baseline.executionId,
  });
  const intervention = await context.service.runIntervention({
    baselineExecutionId: context.baseline.executionId,
    deltaTicks: 1,
  });
  const comparison = await context.service.compareExecutions({
    baselineExecutionId: replay.execution.executionId,
    candidateExecutionId: intervention.execution.executionId,
  });
  return { replay, intervention, comparison };
};

const mechanismProposal = (
  context: Awaited<ReturnType<typeof setup>>,
  experiment: Awaited<ReturnType<typeof completeExperiment>>,
  proposalId: string,
  comparisonId: ComparisonId = experiment.comparison.comparisonId,
): DiagnosisProposal =>
  DiagnosisProposalSchema.parse({
    schemaVersion: 1,
    proposalId: asProposalId(proposalId),
    runId: context.baseline.runId,
    capsuleId: context.capsule.capsuleId,
    baselineExecutionId: context.baseline.executionId,
    replayExecutionId: experiment.replay.execution.executionId,
    candidateExecutionId: experiment.intervention.execution.executionId,
    comparisonId,
    claim: {
      kind: "mechanism",
      summary: "Door connected after the activation Signal",
      mechanism:
        "The tick-0 Signal was missed because the receiver connected later",
      category: "signal_ordering",
      ...supportedMechanismAssertion,
    },
    observedFacts: [
      {
        statement: "The persisted Capsule contains the missed delivery",
        references: [
          {
            artifactKind: "capsule",
            capsuleId: context.capsule.capsuleId,
          },
        ],
      },
    ],
    hypotheses: ["Receiver initialization order is the mechanism"],
    unknowns: [],
    attemptedActions: ["strict replay", "one-tick input delay"],
    blockers: [],
    nextExperiment: null,
    confidence: 1,
  });

describe("ChronoRift v0.1 vertical slice", () => {
  it("runs baseline, replay, one-tick intervention, comparison, and a closed capsule", async () => {
    const context = await setup();
    expect(context.baseline.status).toBe("completed");
    if (context.baseline.status !== "completed") return;
    expect(context.baseline.evaluation.status).toBe("fail");
    expect(
      context.baseline.events.find((event) => event.kind === "signal_delivery"),
    ).toMatchObject({
      delivered: false,
      failureReason: "receiver_not_connected",
    });
    expect(context.capsule.eventChain.map((event) => event.kind)).toEqual([
      "input",
      "property_changed",
      "signal",
      "signal_delivery",
      "property_changed",
    ]);

    const experiment = await completeExperiment(context);
    expect(experiment.replay.execution.executionId).not.toBe(
      context.baseline.executionId,
    );
    expect(experiment.replay.matches).toBe(true);
    expect(experiment.intervention.branch).toMatchObject({
      branchKind: "intervention",
      intervention: { kind: "delay_input", deltaTicks: 1 },
    });
    expect(experiment.intervention.execution.status).toBe("completed");
    if (experiment.intervention.execution.status !== "completed") return;
    expect(experiment.intervention.execution.evaluation.status).toBe("pass");
    expect(experiment.comparison).toMatchObject({
      baselineExecutionId: experiment.replay.execution.executionId,
      candidateExecutionId: experiment.intervention.execution.executionId,
      baselineOutcome: "fail",
      candidateOutcome: "pass",
      comparable: true,
      blockers: [],
    });
  });

  it("ignores Agent confidence and confirms only after canonical evidence gates", async () => {
    const context = await setup();
    const experiment = await completeExperiment(context);
    const delivery = context.baseline.events.find(
      (event) => event.kind === "signal_delivery",
    );
    if (delivery === undefined) throw new Error("Missing delivery event");
    const replayInput = experiment.replay.execution.events.find(
      (event) => event.kind === "input",
    );
    const candidateInput = experiment.intervention.execution.events.find(
      (event) => event.kind === "input",
    );
    if (replayInput === undefined || candidateInput === undefined) {
      throw new Error("Missing experiment input event");
    }

    for (const [index, confidence] of [0, 1].entries()) {
      const proposal = DiagnosisProposalSchema.parse({
        schemaVersion: 1,
        proposalId: asProposalId(`proposal-confirmed-${index}`),
        runId: context.baseline.runId,
        capsuleId: context.capsule.capsuleId,
        baselineExecutionId: context.baseline.executionId,
        replayExecutionId: experiment.replay.execution.executionId,
        candidateExecutionId: experiment.intervention.execution.executionId,
        comparisonId: experiment.comparison.comparisonId,
        claim: {
          kind: "mechanism",
          summary: "Door connected after the activation Signal",
          mechanism:
            "The tick-0 Signal was missed because the receiver connected later",
          category: "signal_ordering",
          ...supportedMechanismAssertion,
        },
        observedFacts: [
          {
            statement: "The Signal delivery failed before receiver connection",
            references: [
              {
                artifactKind: "capsule",
                capsuleId: context.capsule.capsuleId,
              },
              { artifactKind: "event", eventId: delivery.eventId },
              {
                artifactKind: "comparison",
                comparisonId: experiment.comparison.comparisonId,
              },
              { artifactKind: "event", eventId: replayInput.eventId },
              { artifactKind: "event", eventId: candidateInput.eventId },
            ],
          },
        ],
        hypotheses: ["Receiver initialization order is the mechanism"],
        unknowns: [],
        attemptedActions: ["strict replay", "one-tick input delay"],
        blockers: [],
        nextExperiment: null,
        confidence,
      });
      await context.repository.putDiagnosisProposal(proposal);
      await expect(
        context.service.conclude({ proposalId: proposal.proposalId }),
      ).resolves.toMatchObject({ status: "confirmed", blockers: [] });
    }
  });

  it("returns inconclusive when the Agent abstains without replay evidence", async () => {
    const context = await setup();
    const proposal = DiagnosisProposalSchema.parse({
      schemaVersion: 1,
      proposalId: asProposalId("proposal-inconclusive"),
      runId: context.baseline.runId,
      capsuleId: context.capsule.capsuleId,
      baselineExecutionId: context.baseline.executionId,
      claim: { kind: "unknown", summary: "More evidence is required" },
      observedFacts: [
        {
          statement: "The baseline Contract failed",
          references: [
            {
              artifactKind: "capsule",
              capsuleId: context.capsule.capsuleId,
            },
          ],
        },
      ],
      hypotheses: [],
      unknowns: ["Replay stability is unknown"],
      attemptedActions: ["read capsule"],
      blockers: ["No replay was run"],
      nextExperiment: "Replay the baseline from its checkpoint",
      confidence: 1,
    });
    await context.repository.putDiagnosisProposal(proposal);

    const verdict = await context.service.conclude({
      proposalId: proposal.proposalId,
    });
    expect(verdict.status).toBe("inconclusive");
    if (verdict.status !== "inconclusive") return;
    expect(verdict.blockers.map((blocker) => blocker.code)).toContain(
      "EXECUTION_NOT_ADMISSIBLE",
    );
    expect(verdict.nextExperiment).toBe(
      "Replay the baseline from its checkpoint",
    );
  });

  it("rejects a fabricated Agent event reference", async () => {
    const context = await setup();
    const experiment = await completeExperiment(context);
    const proposal = DiagnosisProposalSchema.parse({
      schemaVersion: 1,
      proposalId: asProposalId("proposal-fabricated"),
      runId: context.baseline.runId,
      capsuleId: context.capsule.capsuleId,
      baselineExecutionId: context.baseline.executionId,
      replayExecutionId: experiment.replay.execution.executionId,
      candidateExecutionId: experiment.intervention.execution.executionId,
      comparisonId: experiment.comparison.comparisonId,
      claim: {
        kind: "mechanism",
        summary: "Fabricated evidence",
        mechanism: "Unsupported",
        category: "signal_ordering",
        ...supportedMechanismAssertion,
      },
      observedFacts: [
        {
          statement: "A fabricated event occurred",
          references: [
            { artifactKind: "event", eventId: asEventId("event:not-real") },
          ],
        },
      ],
      hypotheses: [],
      unknowns: [],
      attemptedActions: ["invent event"],
      blockers: [],
      nextExperiment: null,
      confidence: 1,
    });
    await context.repository.putDiagnosisProposal(proposal);

    await expect(
      context.service.conclude({ proposalId: proposal.proposalId }),
    ).rejects.toMatchObject({
      code: "INVALID_PROPOSAL",
    } satisfies Partial<V01GameBranchError>);
  });

  it("rejects a schema-valid comparison reference from another run", async () => {
    const context = await setup();
    const experiment = await completeExperiment(context);
    const crossRunComparison = ExecutionComparisonSchema.parse({
      ...experiment.comparison,
      comparisonId: asComparisonId("comparison-cross-run"),
      runId: asRunId("run-other"),
    });
    await context.repository.putExecutionComparison(crossRunComparison);
    const proposal = mechanismProposal(
      context,
      experiment,
      "proposal-cross-run",
      crossRunComparison.comparisonId,
    );
    await context.repository.putDiagnosisProposal(proposal);

    await expect(
      context.service.conclude({ proposalId: proposal.proposalId }),
    ).rejects.toMatchObject({
      code: "INVALID_PROPOSAL",
    } satisfies Partial<V01GameBranchError>);
  });

  it("returns inconclusive when the replay digest is no longer admissible", async () => {
    const context = await setup();
    const experiment = await completeExperiment(context);
    const replay = experiment.replay.execution;
    const corruptedReplay = ExecutionLogSchema.parse({
      ...replay,
      timelineDigest: "sha256:replay-digest-does-not-match-events",
    });
    context.repository.executions.set(replay.executionId, corruptedReplay);
    const proposal = mechanismProposal(
      context,
      experiment,
      "proposal-replay-diverged",
    );
    await context.repository.putDiagnosisProposal(proposal);

    const verdict = await context.service.conclude({
      proposalId: proposal.proposalId,
    });
    expect(verdict.status).toBe("inconclusive");
    if (verdict.status !== "inconclusive") return;
    expect(verdict.blockers.map((blocker) => blocker.code)).toContain(
      "REPLAY_DIVERGED",
    );
  });

  it("returns inconclusive when runtime health reports event loss", async () => {
    const context = await setup();
    const experiment = await completeExperiment(context);
    const replay = experiment.replay.execution;
    const lossyReplay = ExecutionLogSchema.parse({
      ...replay,
      runtimeFingerprint: testRuntimeFingerprint,
      restoreReceipt: {
        ...replay.restoreReceipt,
        runtimeValidation: {
          schemaVersion: 1,
          level: "fixture_semantic_l2",
          semanticStateHash: "c".repeat(64),
          validations: [
            {
              participantId: "switch-door",
              status: "pass",
              stateHash: "d".repeat(64),
            },
          ],
        },
      },
      stepReceipts: replay.stepReceipts.map((receipt, index) => ({
        ...receipt,
        runtime: {
          schemaVersion: 1,
          phase: "process_frame_start",
          idleFramesExecuted: 1,
          physicsTicksExecuted: 0,
          actualIdleDeltasUs: [receipt.realizedDeltaUs],
          actualPhysicsDeltasUs: [],
          engineProcessFrame: index,
          enginePhysicsFrame: index,
          hostMonotonicStartUs: index,
          hostMonotonicEndUs: index + 1,
          inputApplications: receipt.appliedInputOrders.map((order) => ({
            order,
            eventsInjected: 2,
            pressed: true,
            released: true,
          })),
          observationHealth: {
            schemaVersion: 1,
            emittedEvents: 0,
            droppedEvents: index === 0 ? 1 : 0,
            truncatedEvents: 0,
            bufferedBytes: 0,
            backpressure: false,
            probeOverheadUs: 0,
          },
        },
      })),
    });
    context.repository.executions.set(replay.executionId, lossyReplay);
    const proposal = mechanismProposal(
      context,
      experiment,
      "proposal-runtime-event-loss",
    );
    await context.repository.putDiagnosisProposal(proposal);

    const verdict = await context.service.conclude({
      proposalId: proposal.proposalId,
    });
    expect(verdict.status).toBe("inconclusive");
    if (verdict.status !== "inconclusive") return;
    expect(verdict.blockers.map((blocker) => blocker.code)).toContain(
      "REPLAY_DIVERGED",
    );
  });

  it("returns inconclusive when the original execution is reused as its replay", async () => {
    const context = await setup();
    const experiment = await completeExperiment(context);
    const proposal = DiagnosisProposalSchema.parse({
      ...mechanismProposal(
        context,
        experiment,
        "proposal-original-as-replay-source",
      ),
      proposalId: asProposalId("proposal-original-as-replay"),
      replayExecutionId: context.baseline.executionId,
    });
    await context.repository.putDiagnosisProposal(proposal);

    const verdict = await context.service.conclude({
      proposalId: proposal.proposalId,
    });
    expect(verdict.status).toBe("inconclusive");
    if (verdict.status !== "inconclusive") return;
    expect(verdict.blockers.map((blocker) => blocker.code)).toContain(
      "REPLAY_DIVERGED",
    );
  });

  it("recomputes and rejects a schema-valid replay pass evaluation", async () => {
    const context = await setup();
    const experiment = await completeExperiment(context);
    const replay = experiment.replay.execution;
    if (replay.status !== "completed")
      throw new Error("Replay did not complete");
    const tamperedReplay = ExecutionLogSchema.parse({
      ...replay,
      evaluation: {
        ...replay.evaluation,
        status: "pass",
        observed: { present: true, value: true },
        satisfiedTick: replay.evaluation.triggerTick,
      },
    });
    context.repository.executions.set(replay.executionId, tamperedReplay);
    const proposal = mechanismProposal(
      context,
      experiment,
      "proposal-tampered-replay-evaluation",
    );
    await context.repository.putDiagnosisProposal(proposal);

    const verdict = await context.service.conclude({
      proposalId: proposal.proposalId,
    });
    expect(verdict.status).toBe("inconclusive");
    if (verdict.status !== "inconclusive") return;
    expect(verdict.blockers.map((blocker) => blocker.code)).toContain(
      "REPLAY_DIVERGED",
    );
  });

  it("does not confirm an unrelated typed mechanism claim", async () => {
    const context = await setup();
    const experiment = await completeExperiment(context);
    const supported = mechanismProposal(
      context,
      experiment,
      "proposal-unrelated-source",
    );
    if (supported.claim.kind !== "mechanism") {
      throw new Error("Expected a mechanism claim");
    }
    const proposal = DiagnosisProposalSchema.parse({
      ...supported,
      proposalId: asProposalId("proposal-unrelated"),
      claim: {
        ...supported.claim,
        mechanismCode: "input_not_applied",
        summary: "The runtime ignored the input",
        mechanism: "The input was never applied",
        category: "input",
      },
    });
    await context.repository.putDiagnosisProposal(proposal);

    const verdict = await context.service.conclude({
      proposalId: proposal.proposalId,
    });
    expect(verdict.status).toBe("inconclusive");
    if (verdict.status !== "inconclusive") return;
    expect(verdict.blockers.map((blocker) => blocker.code)).toContain(
      "CLAIM_NOT_SUPPORTED",
    );
  });

  it("returns inconclusive when a canonical final checkpoint is missing", async () => {
    const context = await setup();
    const experiment = await completeExperiment(context);
    const replay = experiment.replay.execution;
    if (replay.status !== "completed")
      throw new Error("Replay did not complete");
    context.repository.checkpoints.delete(replay.finalCheckpointId);
    const proposal = mechanismProposal(
      context,
      experiment,
      "proposal-missing-final-checkpoint",
    );
    await context.repository.putDiagnosisProposal(proposal);

    const verdict = await context.service.conclude({
      proposalId: proposal.proposalId,
    });
    expect(verdict.status).toBe("inconclusive");
    if (verdict.status !== "inconclusive") return;
    expect(verdict.blockers.map((blocker) => blocker.code)).toContain(
      "CHECKPOINT_MISMATCH",
    );
  });
});
