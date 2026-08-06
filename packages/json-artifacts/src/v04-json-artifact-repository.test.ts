import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  asCapsuleId,
  asCheckpointId,
  asClaimPolicyId,
  asComparisonId,
  asContractId,
  asEventId,
  asEvidenceAccessReceiptId,
  asExecutionId,
  asExperimentReservationId,
  asFixtureId,
  asInputTraceId,
  asInterventionId,
  asInvestigationId,
  asProposalId,
  asRunId,
  asVerdictId,
  executionFingerprintV2Content,
  frozenContractBundleV3Content,
  type DiagnosisProposalV4,
  type DiagnosisVerdictV3,
  type EvidenceAccessReceiptV2,
  type ExecutionFingerprintV2,
  type ExperimentReservationV1,
  type FrozenContractBundleV3,
  type FrozenContractV2,
  type JsonValue,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import { contentHash } from "./canonical-json.js";
import {
  ArtifactIntegrityError,
  ArtifactPathSecurityError,
  ImmutableArtifactConflictError,
} from "./v01-json-artifact-repository.js";
import { V04JsonArtifactRepository } from "./v04-json-artifact-repository.js";

const hash = (character: string): string => character.repeat(64);
const runId = asRunId("run:v04:repository-test");
const investigationId = asInvestigationId("investigation:v04:test");
const baselineExecutionId = asExecutionId("execution:v04:baseline");
const candidateExecutionId = asExecutionId("execution:v04:candidate");
const replayExecutionId = asExecutionId("execution:v04:replay");

const contractContent: Omit<FrozenContractBundleV3, "contractId"> = {
  schemaVersion: 3,
  contractVersion: "1.0.0",
  scope: {
    projectId: "chronorift.fixture.switch-door",
    scenePath: "res://main.tscn",
    fixtureId: asFixtureId("fixture:switch-door"),
    entityBindings: {
      switch: "entity://fixture/switch",
      door: "entity://fixture/door",
    },
  },
  authority: {
    status: "frozen",
    authoredBy: "test-author",
    approvedBy: "test-approver",
    approvedAt: "2026-08-06T00:00:00.000Z",
  },
  evaluator: {
    evaluatorId: "temporal.signal-property",
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
  contractId: asContractId(
    `contract:v3:${contentHash(contractContent as unknown as JsonValue)}`,
  ),
};

const claimPolicyManifestContent = {
  schemaVersion: 1 as const,
  policies: [
    {
      policyId: asClaimPolicyId("godot.signal-ordering-evidence"),
      policyVersion: "1.0.0",
      mechanismId: "signal_before_receiver_connection",
      assertionSchemaId:
        "chronorift.godot.signal-before-receiver-connection.v1",
    },
  ],
};
const claimPolicyManifest = {
  ...claimPolicyManifestContent,
  manifestHash: contentHash(claimPolicyManifestContent),
};

const fingerprintContent: Omit<
  ExecutionFingerprintV2,
  "fingerprintHash" | "comparisonBasisHash"
> = {
  schemaVersion: 2,
  executionId: baselineExecutionId,
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
    engine: "godot",
    engineVersion: "4.6.1",
    platform: "linux",
    renderer: "gl_compatibility",
    physicsEngine: "godot_physics_3d",
    adapterVersion: "0.4.0",
    protocolVersion: "2",
    pluginVersion: "0.4.0",
    configurationHash: hash("d"),
    registeredRngDomains: ["fixture"],
  },
  contract: {
    contractId: contract.contractId,
    bundleHash: contentHash(
      frozenContractBundleV3Content(contract) as unknown as JsonValue,
    ),
  },
  claimPolicyManifest,
  checkpoint: {
    checkpointId: asCheckpointId("checkpoint:v04:test"),
    descriptorHash: hash("e"),
    restoreRecipeHash: hash("f"),
    coverageHash: hash("0"),
  },
  input: {
    inputTraceId: asInputTraceId("trace:v04:test"),
    traceHash: hash("1"),
    inputMapHash: hash("2"),
  },
  controls: {
    requested: { fixed_fps: 60 },
    realized: { fixed_fps: 60 },
  },
  intervention: { interventionId: null, specification: null },
  probe: { profileHash: hash("3") },
  telemetry: { schemaVersion: 2, schemaHash: hash("4") },
};

const { executionId: _fingerprintExecutionId, ...fingerprintSemanticContent } =
  fingerprintContent;
void _fingerprintExecutionId;

const fingerprintComparisonBasis = {
  runId: fingerprintContent.runId,
  investigationId: fingerprintContent.investigationId,
  source: fingerprintContent.source,
  build: fingerprintContent.build,
  runtime: {
    engine: fingerprintContent.runtime.engine,
    engineVersion: fingerprintContent.runtime.engineVersion,
    platform: fingerprintContent.runtime.platform,
    renderer: fingerprintContent.runtime.renderer,
    physicsEngine: fingerprintContent.runtime.physicsEngine,
    adapterVersion: fingerprintContent.runtime.adapterVersion,
    protocolVersion: fingerprintContent.runtime.protocolVersion,
    pluginVersion: fingerprintContent.runtime.pluginVersion,
    registeredRngDomains: fingerprintContent.runtime.registeredRngDomains,
  },
  contract: fingerprintContent.contract,
  claimPolicyManifest: fingerprintContent.claimPolicyManifest,
  checkpoint: fingerprintContent.checkpoint,
  probe: fingerprintContent.probe,
  telemetry: fingerprintContent.telemetry,
} as unknown as JsonValue;

const fingerprint: ExecutionFingerprintV2 = {
  ...fingerprintContent,
  fingerprintHash: contentHash(
    fingerprintSemanticContent as unknown as JsonValue,
  ),
  comparisonBasisHash: contentHash(fingerprintComparisonBasis),
};

const baselineReservation: ExperimentReservationV1 = {
  schemaVersion: 1,
  reservationId: asExperimentReservationId("reservation:v1:baseline"),
  investigationId,
  runId,
  reservedAt: "2026-08-06T00:00:00.000Z",
  reservationKind: "baseline",
  budget: { scope: "investigation", ordinal: 0, maxInterventions: 1 },
};

const interventionId = asInterventionId("intervention:v04:delay");
const interventionReservation: ExperimentReservationV1 = {
  schemaVersion: 1,
  reservationId: asExperimentReservationId(
    `reservation:v1:${contentHash({ investigationId, interventionId })}`,
  ),
  investigationId,
  runId,
  reservedAt: "2026-08-06T00:00:01.000Z",
  reservationKind: "intervention",
  interventionId,
  budget: { scope: "investigation", ordinal: 1, maxInterventions: 1 },
};

const receiptContent: Omit<EvidenceAccessReceiptV2, "receiptId" | "issuedAt"> =
  {
    schemaVersion: 2,
    runId,
    investigationId,
    accessKind: "capsule",
    resourceId: "capsule:v04:test",
    requestHash: hash("6"),
    contentHash: hash("7"),
    sourceCoverage: [],
  };
const receipt: EvidenceAccessReceiptV2 = {
  ...receiptContent,
  receiptId: asEvidenceAccessReceiptId(
    `receipt:v2:${contentHash(receiptContent as unknown as JsonValue)}`,
  ),
  issuedAt: "2026-08-06T00:00:02.000Z",
};

const proposal: DiagnosisProposalV4 = {
  schemaVersion: 4,
  proposalId: asProposalId("proposal:v04:test"),
  runId,
  investigationId,
  capsuleId: asCapsuleId("capsule:v04:test"),
  baselineExecutionId,
  replayExecutionId,
  candidateExecutionIds: [candidateExecutionId],
  comparisonIds: [asComparisonId("comparison:v04:test")],
  accessReceiptIds: [receipt.receiptId],
  claim: {
    kind: "mechanism",
    mechanismId: "chronorift.test/signal-ordering@1",
    assertion: {
      schemaId: "chronorift.test/signal-ordering.assertion@1",
      payload: { source: "switch", receiver: "door" },
    },
  },
  summary: "The intervention supports the proposed mechanism.",
  evidenceEventIds: [asEventId("event:v04:signal")],
  blockers: [],
  nextExperiment: null,
  confidence: 0.2,
};

const verdict: DiagnosisVerdictV3 = {
  schemaVersion: 3,
  verdictId: asVerdictId("verdict:v04:test"),
  proposalId: proposal.proposalId,
  runId,
  investigationId,
  status: "confirmed",
  claimLevel: "mechanism_supported",
  mechanismId: "chronorift.test/signal-ordering@1",
  claimPolicyId: asClaimPolicyId("policy:signal-ordering@1"),
  summary: "The mechanism is supported, without asserting uniqueness.",
  validatedReferences: [
    { artifactKind: "fingerprint", executionId: baselineExecutionId },
    { artifactKind: "receipt", receiptId: receipt.receiptId },
  ],
  blockers: [],
  nextExperiment: null,
};

const legacyContract: FrozenContractV2 = {
  schemaVersion: 2,
  contractId: asContractId("contract:v03:shared-runtime-fact"),
  fixtureId: asFixtureId("fixture:switch-door"),
  authority: { status: "frozen", approvedBy: "test" },
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

describe("V04JsonArtifactRepository", () => {
  it("round-trips v0.4 supplements and shared runtime facts in one v0.4 run", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v04-artifacts-"));
    const repository = new V04JsonArtifactRepository(root, runId);

    await repository.putContract(legacyContract);
    await repository.putContractBundle(contract);
    await repository.putExecutionFingerprint(fingerprint);
    await repository.putExperimentReservation(baselineReservation);
    await repository.putEvidenceAccessReceipt(receipt);
    await repository.putProposalV4(proposal);
    await repository.putVerdictV3(verdict);

    expect(repository.runDirectory).toBe(
      join(root, "v0.4", "runs", encodeURIComponent(runId)),
    );
    await expect(
      repository.getContract(legacyContract.contractId),
    ).resolves.toEqual(legacyContract);
    await expect(
      repository.getContractBundle(contract.contractId),
    ).resolves.toEqual(contract);
    await expect(
      repository.getExecutionFingerprint(fingerprint.executionId),
    ).resolves.toEqual(fingerprint);
    await expect(
      repository.getExperimentReservation(baselineReservation.reservationId),
    ).resolves.toEqual(baselineReservation);
    await expect(
      repository.getEvidenceAccessReceipt(receipt.receiptId),
    ).resolves.toEqual(receipt);
    await expect(
      repository.getProposalV4(proposal.proposalId),
    ).resolves.toEqual(proposal);
    await expect(repository.getVerdictV3(verdict.verdictId)).resolves.toEqual(
      verdict,
    );
  });

  it("allows idempotent writes but rejects replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v04-conflict-"));
    const repository = new V04JsonArtifactRepository(root, runId);
    await repository.putProposalV4(proposal);
    await expect(repository.putProposalV4(proposal)).resolves.toBeUndefined();
    await expect(
      repository.putProposalV4({ ...proposal, summary: "replacement" }),
    ).rejects.toBeInstanceOf(ImmutableArtifactConflictError);
  });

  it("validates content identities on writes and every read", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v04-corrupt-"));
    const repository = new V04JsonArtifactRepository(root, runId);
    await expect(
      repository.putContractBundle({
        ...contract,
        contractVersion: "changed-without-changing-the-ID",
      }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    const staleManifest = {
      ...claimPolicyManifest,
      manifestHash: hash("9"),
    };
    const staleManifestFingerprintContent = {
      ...fingerprintContent,
      claimPolicyManifest: staleManifest,
    };
    const {
      executionId: _staleManifestExecutionId,
      ...staleManifestSemanticContent
    } = staleManifestFingerprintContent;
    void _staleManifestExecutionId;
    await expect(
      repository.putExecutionFingerprint({
        ...staleManifestFingerprintContent,
        fingerprintHash: contentHash(
          staleManifestSemanticContent as unknown as JsonValue,
        ),
        comparisonBasisHash: contentHash({
          ...(fingerprintComparisonBasis as Record<string, JsonValue>),
          claimPolicyManifest: staleManifest,
        }),
      }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    await repository.putExecutionFingerprint(fingerprint);
    const path = join(
      repository.runDirectory,
      "execution-fingerprints-v2",
      `${encodeURIComponent(fingerprint.executionId)}.json`,
    );
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    const changedSource = { ...fingerprint.source, repositoryId: "tampered" };
    await writeFile(path, JSON.stringify({ ...stored, source: changedSource }));
    await expect(
      repository.getExecutionFingerprint(fingerprint.executionId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    expect(executionFingerprintV2Content(fingerprint)).not.toHaveProperty(
      "fingerprintHash",
    );
  });

  it("rebuilds a deterministic investigation reservation list after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v04-restart-"));
    const first = new V04JsonArtifactRepository(root, runId);
    await first.putExperimentReservation(interventionReservation);
    await first.putExperimentReservation(baselineReservation);

    const restarted = new V04JsonArtifactRepository(root, runId);
    await expect(
      restarted.listExperimentReservations(investigationId),
    ).resolves.toEqual([baselineReservation, interventionReservation]);
    await expect(
      restarted.listExperimentReservations(
        asInvestigationId("investigation:v04:other"),
      ),
    ).resolves.toEqual([]);
  });

  it("rejects non-canonical and symbolic-link entries while listing", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v04-list-safe-"));
    const repository = new V04JsonArtifactRepository(root, runId);
    await repository.putExperimentReservation(baselineReservation);
    const directory = join(
      repository.runDirectory,
      "experiment-reservations-v1",
    );
    await writeFile(join(directory, "README"), "not an artifact");
    await expect(
      repository.listExperimentReservations(investigationId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    const rootWithLink = await mkdtemp(
      join(tmpdir(), "chronorift-v04-list-link-"),
    );
    const linkedRepository = new V04JsonArtifactRepository(rootWithLink, runId);
    await linkedRepository.putExperimentReservation(baselineReservation);
    const linkedDirectory = join(
      linkedRepository.runDirectory,
      "experiment-reservations-v1",
    );
    await symlink(
      join(
        linkedDirectory,
        `${encodeURIComponent(baselineReservation.reservationId)}.json`,
      ),
      join(linkedDirectory, "reservation%3Av1%3Aalias.json"),
    );
    await expect(
      linkedRepository.listExperimentReservations(investigationId),
    ).rejects.toBeInstanceOf(ArtifactPathSecurityError);
  });

  it("rejects a namespace symlink without writing outside the artifact root", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v04-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "chronorift-v04-outside-"));
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, "v0.4"), "dir");
    const repository = new V04JsonArtifactRepository(root, runId);
    await expect(repository.putContractBundle(contract)).rejects.toBeInstanceOf(
      ArtifactPathSecurityError,
    );
    await expect(access(join(outside, "runs"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
