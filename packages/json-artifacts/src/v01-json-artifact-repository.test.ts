import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  asBranchId,
  asCapsuleId,
  asCheckpointId,
  asComparisonId,
  asEventId,
  asExecutionId,
  asInputTraceId,
  asProposalId,
  asRunId,
  asVerdictId,
  type BranchSpec,
  type CheckpointContent,
  type DiagnosisProposal,
  type DiagnosisVerdict,
  type EvidenceCapsule,
  type ExecutionComparison,
  type ExecutionLog,
  type FrozenContract,
  type InputTrace,
  type JsonValue,
} from "@chronorift/domain";
import { contractIdFor } from "@chronorift/gamebranch";
import { describe, expect, it } from "vitest";

import {
  ArtifactIntegrityError,
  ArtifactPathSecurityError,
  ArtifactCorruptionError,
  ImmutableArtifactConflictError,
  V01JsonArtifactRepository,
  contentHash,
} from "./index.js";

const contractInput: Omit<FrozenContract, "contractId"> = {
  schemaVersion: 1,
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
const contract: FrozenContract = {
  ...contractInput,
  contractId: contractIdFor(contractInput),
};

const baselineBranch: BranchSpec = {
  schemaVersion: 1,
  branchId: asBranchId("branch_fixture"),
  runId: asRunId("run_fixture"),
  branchKind: "baseline",
  contractId: contract.contractId,
  startCheckpointId: asCheckpointId("checkpoint_fixture"),
  inputTraceId: asInputTraceId("trace_fixture"),
  controls: { deltaUs: 16_667, maxTicks: 1, variables: {} },
  createdAt: "2026-08-04T00:00:00.000Z",
};

const executionId = asExecutionId("execution_fixture");
const execution: ExecutionLog = {
  schemaVersion: 1,
  executionId,
  runId: baselineBranch.runId,
  branchId: baselineBranch.branchId,
  contractId: contract.contractId,
  startCheckpointId: baselineBranch.startCheckpointId,
  inputTraceId: baselineBranch.inputTraceId,
  restoreReceipt: {
    requestedCheckpointId: baselineBranch.startCheckpointId,
    restoredCheckpointId: baselineBranch.startCheckpointId,
    restored: true,
    nextTick: 0,
    simTimeUs: 0,
    stateDigest: "state_fixture",
  },
  stepReceipts: [],
  events: [],
  timelineDigest: "digest_fixture",
  sealed: true,
  status: "failed",
  failure: { code: "fixture_failure", message: "fixture execution failed" },
};

function capsuleWithId(
  capsuleId: ReturnType<typeof asCapsuleId>,
): EvidenceCapsule {
  const signalId = asEventId(`${capsuleId}:signal`);
  const deliveryId = asEventId(`${capsuleId}:delivery`);
  const receiverId = asEventId(`${capsuleId}:receiver`);
  const capsuleExecutionId = asExecutionId(`${capsuleId}:execution`);
  return {
    schemaVersion: 1,
    capsuleId,
    runId: baselineBranch.runId,
    contractId: contract.contractId,
    branchId: baselineBranch.branchId,
    checkpointId: baselineBranch.startCheckpointId,
    baselineExecutionId: capsuleExecutionId,
    observedWindow: {
      fromTick: 0,
      toTick: 1,
      fromSeq: 0,
      toSeq: 2,
      closed: true,
    },
    triggerEventId: signalId,
    signalDeliveryEventId: deliveryId,
    receiverConnectedEventId: receiverId,
    eventChain: [
      {
        schemaVersion: 1,
        eventId: signalId,
        executionId: capsuleExecutionId,
        runId: baselineBranch.runId,
        branchId: baselineBranch.branchId,
        seq: 0,
        tick: 0,
        simTimeUs: 0,
        kind: "signal",
        source: "switch",
        name: "switch.activated",
        arguments: [],
      },
      {
        schemaVersion: 1,
        eventId: deliveryId,
        executionId: capsuleExecutionId,
        runId: baselineBranch.runId,
        branchId: baselineBranch.branchId,
        seq: 1,
        tick: 0,
        simTimeUs: 0,
        causedByEventId: signalId,
        kind: "signal_delivery",
        source: "switch",
        name: "switch.activated",
        receiver: "door",
        delivered: false,
        failureReason: "receiver_not_connected",
      },
      {
        schemaVersion: 1,
        eventId: receiverId,
        executionId: capsuleExecutionId,
        runId: baselineBranch.runId,
        branchId: baselineBranch.branchId,
        seq: 2,
        tick: 0,
        simTimeUs: 0,
        kind: "property_changed",
        path: "door.receiver_connected",
        before: false,
        after: true,
      },
    ],
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
    violationSummary: "Signal delivery failed before the receiver connected.",
    sourceEventIds: [signalId, deliveryId, receiverId],
    integrity: {
      executionSealed: true,
      eventLossDetected: false,
      timelineDigest: "digest_fixture",
    },
    knownLimitations: [],
    nextMinimalExperiments: ["Delay input by one tick."],
  };
}

const capsule = capsuleWithId(asCapsuleId("capsule_fixture"));
const candidateBranchId = asBranchId("branch_candidate_fixture");
const comparison: ExecutionComparison = {
  schemaVersion: 1,
  comparisonId: asComparisonId("comparison_fixture"),
  runId: baselineBranch.runId,
  contractId: contract.contractId,
  commonCheckpointId: baselineBranch.startCheckpointId,
  baselineBranchId: baselineBranch.branchId,
  candidateBranchId,
  baselineExecutionId: asExecutionId("execution_replay_fixture"),
  candidateExecutionId: asExecutionId("execution_candidate_fixture"),
  intervention: { kind: "delay_input", deltaTicks: 1 },
  baselineOutcome: "fail",
  candidateOutcome: "pass",
  comparable: true,
  blockers: [],
  digestsEqual: false,
  firstDivergenceTick: 0,
};

const proposal: DiagnosisProposal = {
  schemaVersion: 1,
  proposalId: asProposalId("proposal_fixture"),
  runId: baselineBranch.runId,
  capsuleId: capsule.capsuleId,
  baselineExecutionId: capsule.baselineExecutionId,
  claim: { kind: "unknown", summary: "Evidence is incomplete." },
  observedFacts: [
    {
      statement: "A Capsule was produced.",
      references: [{ artifactKind: "capsule", capsuleId: capsule.capsuleId }],
    },
  ],
  hypotheses: [],
  unknowns: ["Replay availability"],
  attemptedActions: ["Read capsule"],
  blockers: ["Replay unavailable"],
  nextExperiment: "Replay the baseline once.",
  confidence: 1,
};

const verdict: DiagnosisVerdict = {
  schemaVersion: 1,
  verdictId: asVerdictId("verdict_fixture"),
  proposalId: proposal.proposalId,
  runId: proposal.runId,
  status: "inconclusive",
  claimLevel: "none",
  summary: "Evidence is incomplete.",
  validatedReferences: [],
  blockers: [
    {
      code: "CLAIM_NOT_SUPPORTED",
      message: "Replay is unavailable.",
      references: [],
    },
  ],
  nextExperiment: "Replay the baseline once.",
};

const artifactFile = (root: string, collection: string, id: string): string =>
  join(
    root,
    "v0.1",
    collection,
    `${encodeURIComponent(id).replaceAll(".", "%2E")}.json`,
  );

const checkpointContent = (scene: string): CheckpointContent => ({
  schemaVersion: 1,
  environment: { adapter: "test", adapterVersion: "1", scene },
  nextTick: 0,
  simTimeUs: 0,
  snapshot: {
    state: { values: { "door.open": false } },
    runtimeState: {},
    rngState: { seed: "fixture" },
    pendingEffects: [],
  },
});

const traceWithInputs = (inputs: InputTrace["inputs"]): InputTrace => {
  const identityContent = {
    schemaVersion: 1,
    scheduleBasis: "relative_tick",
    inputs,
  } as const;
  return {
    ...identityContent,
    inputTraceId: asInputTraceId(
      `trace:sha256:${contentHash(identityContent as unknown as JsonValue)}`,
    ),
  };
};

describe("V01JsonArtifactRepository", () => {
  it("persists immutable schema-valid artifacts across instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v01-artifacts-"));
    const first = new V01JsonArtifactRepository(root);

    await first.putFrozenContract(contract);
    await first.putFrozenContract(contract);

    const reopened = new V01JsonArtifactRepository(root);
    await expect(
      reopened.getFrozenContract(contract.contractId),
    ).resolves.toEqual(contract);
  });

  it("rejects a second value for an existing artifact identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v01-artifacts-"));
    const repository = new V01JsonArtifactRepository(root);
    await repository.putBranchSpec(baselineBranch);

    await expect(
      repository.putBranchSpec({
        ...baselineBranch,
        createdAt: "2026-08-04T00:00:01.000Z",
      }),
    ).rejects.toBeInstanceOf(ImmutableArtifactConflictError);
  });

  it("rejects schema-valid Contract content that no longer matches its hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v01-artifacts-"));
    const repository = new V01JsonArtifactRepository(root);
    await repository.putFrozenContract(contract);
    const path = join(
      root,
      "v0.1",
      "contracts",
      `${encodeURIComponent(contract.contractId).replaceAll(".", "%2E")}.json`,
    );
    await writeFile(
      path,
      JSON.stringify({
        ...contract,
        authority: { status: "frozen", approvedBy: "tampered-owner" },
      }),
      "utf8",
    );

    await expect(
      repository.getFrozenContract(contract.contractId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("rejects corrupted persisted data at the read boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v01-artifacts-"));
    const path = join(
      root,
      "v0.1",
      "contracts",
      `${encodeURIComponent(contract.contractId)}.json`,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"schemaVersion":1}', "utf8");

    const repository = new V01JsonArtifactRepository(root);
    await expect(
      repository.getFrozenContract(contract.contractId),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);
  });

  it("rejects every schema-valid artifact stored under a mismatched requested ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v01-identity-"));
    const repository = new V01JsonArtifactRepository(root);

    const otherContractInput = {
      ...contractInput,
      authority: { status: "frozen" as const, approvedBy: "other-owner" },
    };
    const otherContract: FrozenContract = {
      ...otherContractInput,
      contractId: contractIdFor(otherContractInput),
    };
    await repository.putFrozenContract(contract);
    await repository.putFrozenContract(otherContract);
    await copyFile(
      artifactFile(root, "contracts", otherContract.contractId),
      artifactFile(root, "contracts", contract.contractId),
    );
    await expect(
      repository.getFrozenContract(contract.contractId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    const otherBranch = {
      ...baselineBranch,
      branchId: asBranchId("branch_other"),
    };
    await repository.putBranchSpec(baselineBranch);
    await repository.putBranchSpec(otherBranch);
    await copyFile(
      artifactFile(root, "branch-specs", otherBranch.branchId),
      artifactFile(root, "branch-specs", baselineBranch.branchId),
    );
    await expect(
      repository.getBranchSpec(baselineBranch.branchId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    const otherExecution = {
      ...execution,
      executionId: asExecutionId("execution_other"),
    };
    await repository.putExecutionLog(execution);
    await repository.putExecutionLog(otherExecution);
    await copyFile(
      artifactFile(root, "executions", otherExecution.executionId),
      artifactFile(root, "executions", execution.executionId),
    );
    await expect(
      repository.getExecutionLog(execution.executionId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    const otherCapsule = capsuleWithId(asCapsuleId("capsule_other"));
    await repository.putEvidenceCapsule(capsule);
    await repository.putEvidenceCapsule(otherCapsule);
    await copyFile(
      artifactFile(root, "capsules", otherCapsule.capsuleId),
      artifactFile(root, "capsules", capsule.capsuleId),
    );
    await expect(
      repository.getEvidenceCapsule(capsule.capsuleId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    const otherComparison = {
      ...comparison,
      comparisonId: asComparisonId("comparison_other"),
    };
    await repository.putExecutionComparison(comparison);
    await repository.putExecutionComparison(otherComparison);
    await copyFile(
      artifactFile(root, "comparisons", otherComparison.comparisonId),
      artifactFile(root, "comparisons", comparison.comparisonId),
    );
    await expect(
      repository.getExecutionComparison(comparison.comparisonId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    const otherProposal = {
      ...proposal,
      proposalId: asProposalId("proposal_other"),
    };
    await repository.putDiagnosisProposal(proposal);
    await repository.putDiagnosisProposal(otherProposal);
    await copyFile(
      artifactFile(root, "proposals", otherProposal.proposalId),
      artifactFile(root, "proposals", proposal.proposalId),
    );
    await expect(
      repository.getDiagnosisProposal(proposal.proposalId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    const otherVerdict = {
      ...verdict,
      verdictId: asVerdictId("verdict_other"),
    };
    await repository.putDiagnosisVerdict(verdict);
    await repository.putDiagnosisVerdict(otherVerdict);
    await copyFile(
      artifactFile(root, "verdicts", otherVerdict.verdictId),
      artifactFile(root, "verdicts", verdict.verdictId),
    );
    await expect(
      repository.getDiagnosisVerdict(verdict.verdictId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("retains content-addressed identity checks for checkpoints and input traces", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v01-content-id-"));
    const repository = new V01JsonArtifactRepository(root);
    const checkpoint = await repository.putCheckpoint(
      checkpointContent("fixture-a"),
    );
    const otherCheckpoint = await repository.putCheckpoint(
      checkpointContent("fixture-b"),
    );
    await copyFile(
      artifactFile(root, "checkpoints", otherCheckpoint.checkpointId),
      artifactFile(root, "checkpoints", checkpoint.checkpointId),
    );
    await expect(
      repository.getCheckpoint(checkpoint.checkpointId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    const trace = traceWithInputs([]);
    const otherTrace = traceWithInputs([
      {
        relativeTick: 1,
        order: 0,
        action: "interact_switch",
        target: "switch",
        payload: {},
      },
    ]);
    await repository.putInputTrace(trace);
    await repository.putInputTrace(otherTrace);
    await copyFile(
      artifactFile(root, "input-traces", otherTrace.inputTraceId),
      artifactFile(root, "input-traces", trace.inputTraceId),
    );
    await expect(
      repository.getInputTrace(trace.inputTraceId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it.each([
    "..",
    "../outside",
    "safe/../outside",
    "/absolute/path",
    "C:\\absolute\\path",
    "safe\\..\\outside",
  ])("rejects dangerous branded artifact ID %s", async (dangerousId) => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v01-id-path-"));
    const repository = new V01JsonArtifactRepository(root);

    await expect(
      repository.getBranchSpec(asBranchId(dangerousId)),
    ).rejects.toBeInstanceOf(ArtifactPathSecurityError);
    await expect(
      repository.resolveRunDirectory(asRunId(dangerousId)),
    ).rejects.toBeInstanceOf(ArtifactPathSecurityError);
  });

  it("rejects a symbolic-link escape inside the artifact root", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v01-root-"));
    const outside = await mkdtemp(join(tmpdir(), "chronorift-v01-outside-"));
    await mkdir(join(root, "v0.1"));
    await symlink(outside, join(root, "v0.1", "contracts"), "dir");

    const repository = new V01JsonArtifactRepository(root);
    await expect(repository.putFrozenContract(contract)).rejects.toBeInstanceOf(
      ArtifactPathSecurityError,
    );
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("rejects a symbolic link at the final artifact file", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v01-file-link-"));
    const outside = await mkdtemp(join(tmpdir(), "chronorift-v01-outside-"));
    const outsideFile = join(outside, "contract.json");
    await writeFile(outsideFile, JSON.stringify(contract), "utf8");
    const artifactPath = artifactFile(root, "contracts", contract.contractId);
    await mkdir(dirname(artifactPath), { recursive: true });
    await symlink(outsideFile, artifactPath, "file");

    const repository = new V01JsonArtifactRepository(root);
    await expect(
      repository.getFrozenContract(contract.contractId),
    ).rejects.toBeInstanceOf(ArtifactPathSecurityError);
    await expect(repository.putFrozenContract(contract)).rejects.toBeInstanceOf(
      ArtifactPathSecurityError,
    );
  });

  it("rejects repository-root and static-directory symbolic links", async () => {
    const parent = await mkdtemp(join(tmpdir(), "chronorift-v01-parent-"));
    const outside = await mkdtemp(join(tmpdir(), "chronorift-v01-outside-"));
    const linkedRoot = join(parent, "artifacts");
    await symlink(outside, linkedRoot, "dir");

    await expect(
      new V01JsonArtifactRepository(linkedRoot).putFrozenContract(contract),
    ).rejects.toBeInstanceOf(ArtifactPathSecurityError);

    const directRoot = await mkdtemp(join(tmpdir(), "chronorift-v01-root-"));
    await symlink(outside, join(directRoot, "v0.1"), "dir");
    await expect(
      new V01JsonArtifactRepository(directRoot).putFrozenContract(contract),
    ).rejects.toBeInstanceOf(ArtifactPathSecurityError);
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("fails closed if the repository root changes after canonicalization", async () => {
    const parent = await mkdtemp(join(tmpdir(), "chronorift-v01-swap-"));
    const root = join(parent, "artifacts");
    const movedRoot = join(parent, "artifacts-original");
    const outside = await mkdtemp(join(tmpdir(), "chronorift-v01-outside-"));
    const repository = new V01JsonArtifactRepository(root);
    await repository.resolveRunDirectory(asRunId("run_safe"));

    await rename(root, movedRoot);
    await symlink(outside, root, "dir");
    await expect(repository.putFrozenContract(contract)).rejects.toBeInstanceOf(
      ArtifactPathSecurityError,
    );
    await expect(readdir(outside)).resolves.toEqual([]);

    await rm(root);
    await rename(movedRoot, root);
  });
});
