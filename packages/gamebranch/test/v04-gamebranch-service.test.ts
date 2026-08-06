import {
  asBranchId,
  asCapsuleId,
  asComparisonId,
  asEventId,
  asExecutionId,
  asFixtureId,
  asInterventionId,
  asInvestigationId,
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
  type DiagnosisProposalV4,
  type DiagnosisVerdictV2,
  type DiagnosisVerdictV3,
  type EvidenceAccessReceiptId,
  type EvidenceAccessReceiptV2,
  type EvidenceCapsuleV2,
  type ExecutionFingerprintV2,
  type ExecutionId,
  type ExperimentReservationId,
  type ExperimentReservationV1,
  type FrozenContractBundleV3,
  type FrozenContractV2,
  type InputTraceId,
  type InputTraceV2,
  type InvestigationId,
  type ProposalId,
  type V03BranchSpec,
  type V03ExecutionComparison,
  type V03ExecutionLog,
  type VerdictId,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import type {
  GameEnvironmentFactoryPort,
  InvestigationSpecV1,
  V03IdGeneratorPort,
  V04ArtifactRepositoryPort,
} from "../src/index.js";
import {
  ClaimEvidencePolicyRegistry,
  V04GameBranchError,
  V04GameBranchService,
  v03CheckpointIdFor,
  v03ContractIdFor,
  v03InputTraceIdFor,
  v03StateDigest,
  v03TimelineDigest,
  v04ComparisonBasisContent,
  v04ClaimPolicyManifestFor,
  v04ContentHash,
  v04ContractBundleHash,
  v04ContractIdFor,
  v04FingerprintSemanticContent,
} from "../src/index.js";

const required = <T>(values: ReadonlyMap<string, T>, id: string): T => {
  const value = values.get(id);
  if (value === undefined) throw new Error(`missing ${id}`);
  return value;
};

class MemoryV04Repository implements V04ArtifactRepositoryPort {
  public readonly checkpoints = new Map<string, Checkpoint>();
  public readonly contracts = new Map<string, FrozenContractV2>();
  public readonly traces = new Map<string, InputTraceV2>();
  public readonly branches = new Map<string, V03BranchSpec>();
  public readonly executions = new Map<string, V03ExecutionLog>();
  public readonly capsules = new Map<string, EvidenceCapsuleV2>();
  public readonly comparisons = new Map<string, V03ExecutionComparison>();
  public readonly proposalsV2 = new Map<string, DiagnosisProposalV2>();
  public readonly proposalsV3 = new Map<string, DiagnosisProposalV3>();
  public readonly verdictsV2 = new Map<string, DiagnosisVerdictV2>();
  public readonly contractBundles = new Map<string, FrozenContractBundleV3>();
  public readonly fingerprints = new Map<string, ExecutionFingerprintV2>();
  public readonly reservations = new Map<string, ExperimentReservationV1>();
  public readonly receipts = new Map<string, EvidenceAccessReceiptV2>();
  public readonly proposalsV4 = new Map<string, DiagnosisProposalV4>();
  public readonly verdictsV3 = new Map<string, DiagnosisVerdictV3>();

  public putCheckpoint(content: CheckpointContent): Promise<Checkpoint> {
    const checkpoint = {
      checkpointId: v03CheckpointIdFor(content),
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
    this.verdictsV2.set(value.verdictId, value);
    return Promise.resolve();
  }

  public getVerdict(id: VerdictId): Promise<DiagnosisVerdictV2> {
    return Promise.resolve(required(this.verdictsV2, id));
  }

  public putContractBundle(value: FrozenContractBundleV3): Promise<void> {
    this.contractBundles.set(value.contractId, value);
    return Promise.resolve();
  }

  public getContractBundle(id: ContractId): Promise<FrozenContractBundleV3> {
    return Promise.resolve(required(this.contractBundles, id));
  }

  public putExecutionFingerprint(value: ExecutionFingerprintV2): Promise<void> {
    this.fingerprints.set(value.executionId, value);
    return Promise.resolve();
  }

  public getExecutionFingerprint(
    id: ExecutionId,
  ): Promise<ExecutionFingerprintV2> {
    return Promise.resolve(required(this.fingerprints, id));
  }

  public putExperimentReservation(
    value: ExperimentReservationV1,
  ): Promise<void> {
    this.reservations.set(value.reservationId, value);
    return Promise.resolve();
  }

  public getExperimentReservation(
    id: ExperimentReservationId,
  ): Promise<ExperimentReservationV1> {
    return Promise.resolve(required(this.reservations, id));
  }

  public listExperimentReservations(
    investigationId: InvestigationId,
  ): Promise<readonly ExperimentReservationV1[]> {
    return Promise.resolve(
      [...this.reservations.values()].filter(
        (reservation) => reservation.investigationId === investigationId,
      ),
    );
  }

  public putEvidenceAccessReceipt(
    value: EvidenceAccessReceiptV2,
  ): Promise<void> {
    this.receipts.set(value.receiptId, value);
    return Promise.resolve();
  }

  public getEvidenceAccessReceipt(
    id: EvidenceAccessReceiptId,
  ): Promise<EvidenceAccessReceiptV2> {
    return Promise.resolve(required(this.receipts, id));
  }

  public putProposalV4(value: DiagnosisProposalV4): Promise<void> {
    this.proposalsV4.set(value.proposalId, value);
    return Promise.resolve();
  }

  public getProposalV4(id: ProposalId): Promise<DiagnosisProposalV4> {
    return Promise.resolve(required(this.proposalsV4, id));
  }

  public putVerdictV3(value: DiagnosisVerdictV3): Promise<void> {
    this.verdictsV3.set(value.verdictId, value);
    return Promise.resolve();
  }

  public getVerdictV3(id: VerdictId): Promise<DiagnosisVerdictV3> {
    return Promise.resolve(required(this.verdictsV3, id));
  }
}

class SequentialIds implements V03IdGeneratorPort {
  private value = 0;

  public next(
    kind: "branch" | "execution" | "comparison" | "capsule" | "verdict",
  ): string {
    this.value += 1;
    return `${kind}:v04-test:${this.value}`;
  }
}

const hash = (character: string): string => character.repeat(64);
const fixtureId = asFixtureId("fixture:v04:test");
const investigationId = asInvestigationId("investigation:v04:test");
const runId = asRunId("run:v04:test");
const baselineBranchId = asBranchId("branch:v04:baseline");
const candidateBranchId = asBranchId("branch:v04:candidate");
const baselineExecutionId = asExecutionId("execution:v04:baseline");
const candidateExecutionId = asExecutionId("execution:v04:candidate");
const interventionOne = asInterventionId("intervention:v04:one");
const interventionTwo = asInterventionId("intervention:v04:two");

const contractContent: Omit<FrozenContractBundleV3, "contractId"> = {
  schemaVersion: 3,
  contractVersion: "1.0.0",
  scope: {
    projectId: "chronorift.test",
    scenePath: "res://test.tscn",
    fixtureId,
    entityBindings: { switch: "switch", door: "door" },
  },
  authority: {
    status: "frozen",
    authoredBy: "test",
    approvedBy: "test",
    approvedAt: "2026-08-06T00:00:00.000Z",
  },
  evaluator: {
    evaluatorId: "test.temporal-contract",
    evaluatorVersion: "1.0.0",
    evaluatorHash: hash("a"),
  },
  rule: {
    trigger: { kind: "signal", source: "switch", name: "activated" },
    expectation: {
      kind: "property_equals",
      path: "door.open",
      value: true,
    },
    withinTicks: 1,
    inclusive: true,
  },
};

const contract: FrozenContractBundleV3 = {
  ...contractContent,
  contractId: v04ContractIdFor(contractContent),
};

const checkpointContent: CheckpointContent = {
  schemaVersion: 1,
  environment: { adapter: "fake", adapterVersion: "1", scene: "test" },
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

const traceContent = {
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
const trace: InputTraceV2 = {
  ...traceContent,
  inputTraceId: v03InputTraceIdFor(traceContent),
};
const candidateTraceContent = {
  schemaVersion: 2 as const,
  inputs: [{ ...trace.inputs[0]!, relativeTick: 1 }],
};
const candidateTrace: InputTraceV2 = {
  ...candidateTraceContent,
  inputTraceId: v03InputTraceIdFor(candidateTraceContent),
};

const executionContractContent = {
  schemaVersion: 2 as const,
  fixtureId,
  authority: { status: "frozen" as const, approvedBy: "test" },
  rule: contract.rule,
};
const executionContractId = v03ContractIdFor(executionContractContent);
const controls = { deltaUs: 16_667, maxTicks: 2, variables: {} };

const baselineBranch: V03BranchSpec = {
  schemaVersion: 2,
  branchId: baselineBranchId,
  runId,
  fixtureId,
  branchKind: "baseline",
  contractId: executionContractId,
  startCheckpointId: checkpointId,
  inputTraceId: trace.inputTraceId,
  controls,
  createdAt: "2026-08-06T00:00:00.000Z",
};

const candidateBranch: V03BranchSpec = {
  ...baselineBranch,
  branchId: candidateBranchId,
  branchKind: "intervention",
  parentBranchId: baselineBranchId,
  interventionId: interventionOne,
  intervention: { kind: "shift_input", inputOrder: 0, deltaTicks: 1 },
  inputTraceId: candidateTrace.inputTraceId,
  createdAt: "2026-08-06T00:00:01.000Z",
};

const executionFor = (
  executionId: ExecutionId,
  branchId: BranchId,
  inputTraceId: InputTraceId,
  status: "fail" | "pass",
): V03ExecutionLog => {
  const finalState = { values: { "door.open": status === "pass" } };
  return {
    schemaVersion: 2,
    executionId,
    runId,
    fixtureId,
    branchId,
    contractId: executionContractId,
    startCheckpointId: checkpointId,
    inputTraceId,
    status: "completed",
    evaluation: {
      status,
      triggerEventId: asEventId(`event:${executionId}:trigger`),
      triggerTick: 0,
      deadlineTick: 1,
      observed: { present: true, value: status === "pass" },
      ...(status === "pass" ? { satisfiedTick: 1 } : {}),
    },
    restoreReceipt: {
      requestedCheckpointId: checkpointId,
      restoredCheckpointId: checkpointId,
      restored: true,
      nextTick: 0,
      simTimeUs: 0,
      stateDigest: v03StateDigest({ values: { "door.open": false } }),
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
    controlReceipt: {
      schemaVersion: 1,
      requested: { fixed_fps: 60, physics_ticks_per_second: 60 },
      realized: { fixed_fps: 60, physics_ticks_per_second: 60 },
      accepted: true,
      mismatches: [],
    },
    observationHealth: {
      schemaVersion: 1,
      emittedEvents: 0,
      droppedEvents: 0,
      truncatedEvents: 0,
      bufferedBytes: 0,
      backpressure: false,
      probeOverheadUs: 0,
    },
    events: [],
    finalState,
    timelineDigest: v03TimelineDigest([], finalState),
    sealed: true,
  };
};

const baselineExecution = executionFor(
  baselineExecutionId,
  baselineBranchId,
  trace.inputTraceId,
  "fail",
);
const candidateExecution = executionFor(
  candidateExecutionId,
  candidateBranchId,
  candidateTrace.inputTraceId,
  "pass",
);

const claimPolicyManifest = v04ClaimPolicyManifestFor([]);

const spec = (maxInterventions = 1): InvestigationSpecV1 => ({
  schemaVersion: 1,
  investigationId,
  executionSubjectId: fixtureId,
  contract,
  claimPolicyManifest,
  initialCheckpointContent: checkpointContent,
  inputTrace: trace,
  baselineControls: controls,
  probeProperties: ["door.open"],
  interventions: [
    {
      schemaVersion: 1,
      interventionId: interventionOne,
      label: "shift once",
      intervention: { kind: "shift_input", inputOrder: 0, deltaTicks: 1 },
    },
    {
      schemaVersion: 1,
      interventionId: interventionTwo,
      label: "shift twice",
      intervention: { kind: "shift_input", inputOrder: 0, deltaTicks: 2 },
    },
  ],
  experimentBudget: { maxInterventions },
  runtimeControlDefaults: {},
  checkpointLimitations: [],
  fingerprint: {
    repositoryId: "chronorift",
    sourceTreeHash: hash("b"),
    gitRevision: "deadbeef",
    dirtyPatchHash: null,
    gameBuildHash: hash("c"),
    importCacheHash: null,
    physicsEngine: "fake-physics",
    pluginVersion: "0.4.0",
    inputMapHash: hash("d"),
    probeProfileHash: hash("e"),
    telemetrySchemaHash: hash("f"),
  },
});

const unavailableEnvironment: GameEnvironmentFactoryPort = {
  create: () => Promise.reject(new Error("offline environment not available")),
};
const clock = { nowIso: (): string => "2026-08-06T00:00:00.000Z" };

const createService = (
  repository: MemoryV04Repository,
  investigation = spec(),
): V04GameBranchService =>
  new V04GameBranchService(
    repository,
    unavailableEnvironment,
    investigation,
    new ClaimEvidencePolicyRegistry(),
    new SequentialIds(),
    clock,
  );

const seedRuntimeLineage = (repository: MemoryV04Repository): void => {
  repository.contracts.set(executionContractId, {
    ...executionContractContent,
    contractId: executionContractId,
  });
  repository.checkpoints.set(checkpointId, {
    checkpointId,
    content: checkpointContent,
  });
  repository.traces.set(trace.inputTraceId, trace);
  repository.traces.set(candidateTrace.inputTraceId, candidateTrace);
  repository.branches.set(baselineBranchId, baselineBranch);
  repository.branches.set(candidateBranchId, candidateBranch);
  repository.executions.set(baselineExecutionId, baselineExecution);
  repository.executions.set(candidateExecutionId, candidateExecution);
};

const fingerprintFor = (
  executionId: ExecutionId,
  comparisonBasisHash: string,
): ExecutionFingerprintV2 => {
  const content: Omit<
    ExecutionFingerprintV2,
    "fingerprintHash" | "comparisonBasisHash"
  > = {
    schemaVersion: 2,
    executionId,
    runId,
    investigationId,
    source: {
      repositoryId: "chronorift",
      treeHash: hash("b"),
      gitRevision: "deadbeef",
      dirtyPatchHash: null,
    },
    build: { gameBuildHash: hash("c"), importCacheHash: null },
    runtime: {
      engine: "fake",
      engineVersion: "1",
      platform: "test",
      renderer: "headless",
      physicsEngine: "fake-physics",
      adapterVersion: "1",
      protocolVersion: "2",
      pluginVersion: "0.4.0",
      configurationHash: hash("0"),
      registeredRngDomains: [],
    },
    contract: {
      contractId: contract.contractId,
      bundleHash: v04ContractBundleHash(contract),
    },
    claimPolicyManifest,
    checkpoint: {
      checkpointId,
      descriptorHash: hash("1"),
      restoreRecipeHash: hash("2"),
      coverageHash: hash("3"),
    },
    input: {
      inputTraceId:
        executionId === baselineExecutionId
          ? trace.inputTraceId
          : candidateTrace.inputTraceId,
      traceHash: hash("4"),
      inputMapHash: hash("d"),
    },
    controls: { requested: {}, realized: {} },
    intervention:
      executionId === baselineExecutionId
        ? { interventionId: null, specification: null }
        : {
            interventionId: interventionOne,
            specification: {
              kind: "shift_input",
              inputOrder: 0,
              deltaTicks: 1,
            },
          },
    probe: { profileHash: hash("e") },
    telemetry: { schemaVersion: 2, schemaHash: hash("f") },
  };
  return {
    ...content,
    fingerprintHash: v04ContentHash(v04FingerprintSemanticContent(content)),
    comparisonBasisHash,
  };
};

describe("V04GameBranchService", () => {
  it("rejects a schema-valid Contract v3 whose content-addressed ID is stale", () => {
    const staleContract: FrozenContractBundleV3 = {
      ...contract,
      rule: { ...contract.rule, withinTicks: 2 },
    };

    expect(() =>
      createService(new MemoryV04Repository(), {
        ...spec(),
        contract: staleContract,
      }),
    ).toThrowError(
      new V04GameBranchError(
        "INVALID_INVESTIGATION",
        "The frozen Contract bundle has an invalid content-addressed ID",
      ),
    );
  });

  it("rejects a Claim Policy manifest that differs from the active registry", () => {
    expect(() =>
      createService(new MemoryV04Repository(), {
        ...spec(),
        claimPolicyManifest: {
          ...claimPolicyManifest,
          manifestHash: hash("9"),
        },
      }),
    ).toThrowError(
      new V04GameBranchError(
        "INVALID_INVESTIGATION",
        "The Claim Policy manifest does not match the active registry",
      ),
    );
  });

  it("enforces persisted duplicate and budget reservations after service reconstruction", async () => {
    const repository = new MemoryV04Repository();
    seedRuntimeLineage(repository);

    await expect(
      createService(repository).runIntervention(
        baselineExecutionId,
        interventionOne,
      ),
    ).rejects.toThrow("offline environment not available");
    expect(repository.reservations.size).toBe(1);

    const reconstructed = createService(repository);
    await expect(
      reconstructed.runIntervention(baselineExecutionId, interventionOne),
    ).rejects.toThrow(`Intervention ${interventionOne} is already reserved`);
    await expect(
      reconstructed.runIntervention(baselineExecutionId, interventionTwo),
    ).rejects.toThrow("The persisted intervention budget is exhausted");
    expect(repository.reservations.size).toBe(1);
  });

  it("keeps a confidence-one proposal inconclusive when evidence is missing", async () => {
    const repository = new MemoryV04Repository();
    repository.contractBundles.set(contract.contractId, contract);
    const proposal: DiagnosisProposalV4 = {
      schemaVersion: 4,
      proposalId: asProposalId("proposal:v04:confidence-only"),
      runId,
      investigationId,
      capsuleId: asCapsuleId("capsule:v04:missing"),
      baselineExecutionId,
      replayExecutionId: asExecutionId("execution:v04:missing-replay"),
      candidateExecutionIds: [candidateExecutionId],
      comparisonIds: [asComparisonId("comparison:v04:missing")],
      accessReceiptIds: [],
      claim: {
        kind: "mechanism",
        mechanismId: "chronorift.test.mechanism",
        assertion: { schemaId: "chronorift.test.assertion.v1", payload: {} },
      },
      summary: "Confidence is metadata, not proof.",
      evidenceEventIds: [],
      blockers: [],
      nextExperiment: null,
      confidence: 1,
    };

    const verdict = await createService(repository).conclude(proposal, []);

    expect(verdict.status).toBe("inconclusive");
    expect(verdict.claimLevel).toBe("none");
    expect(verdict.blockers).toContain(
      "At least one evidence receipt is required",
    );
    expect(verdict.blockers).toContain(
      "A matching failing strict replay is required",
    );
    expect(proposal.confidence).toBe(1);
  });

  it("rejects execution comparison when mandatory fingerprints have different bases", async () => {
    const repository = new MemoryV04Repository();
    seedRuntimeLineage(repository);
    repository.fingerprints.set(
      baselineExecutionId,
      fingerprintFor(baselineExecutionId, hash("8")),
    );
    repository.fingerprints.set(
      candidateExecutionId,
      fingerprintFor(candidateExecutionId, hash("9")),
    );

    await expect(
      createService(repository).compareExecutions(
        baselineExecutionId,
        candidateExecutionId,
      ),
    ).rejects.toMatchObject({
      name: "V04GameBranchError",
      code: "INVALID_FINGERPRINT",
    });
    expect(repository.comparisons.size).toBe(1);
  });

  it("defines a stable comparison basis that excludes input and intervention", () => {
    const baseline = fingerprintFor(
      baselineExecutionId,
      v04ContentHash(
        v04ComparisonBasisContent(
          fingerprintFor(baselineExecutionId, hash("0")),
        ),
      ),
    );
    const candidate = fingerprintFor(
      candidateExecutionId,
      v04ContentHash(
        v04ComparisonBasisContent(
          fingerprintFor(candidateExecutionId, hash("0")),
        ),
      ),
    );

    expect(v04ContentHash(v04ComparisonBasisContent(baseline))).toBe(
      v04ContentHash(v04ComparisonBasisContent(candidate)),
    );
    expect(baseline.fingerprintHash).not.toBe(candidate.fingerprintHash);
    expect(
      v04ContentHash(
        v04ComparisonBasisContent({
          ...candidate,
          source: { ...candidate.source, treeHash: hash("7") },
        }),
      ),
    ).not.toBe(v04ContentHash(v04ComparisonBasisContent(baseline)));
    expect(
      v04ContentHash(
        v04ComparisonBasisContent({
          ...candidate,
          claimPolicyManifest: {
            ...candidate.claimPolicyManifest,
            manifestHash: hash("6"),
          },
        }),
      ),
    ).not.toBe(v04ContentHash(v04ComparisonBasisContent(baseline)));
  });
});
