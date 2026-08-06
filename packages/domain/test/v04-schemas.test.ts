import { describe, expect, it } from "vitest";

import {
  ArtifactReferenceV4Schema,
  ClaimPolicyManifestV1Schema,
  DiagnosisProposalV4Schema,
  DiagnosisVerdictV3Schema,
  EvidenceAccessReceiptV2Schema,
  ExecutionFingerprintV2Schema,
  ExperimentReservationV1Schema,
  FrozenContractBundleV3Schema,
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
  claimPolicyManifestV1Content,
  executionFingerprintV2Content,
  frozenContractBundleV3Content,
} from "../src/index.js";

const hash = (character: string): string => character.repeat(64);
const investigationId = asInvestigationId("investigation:v04:test");
const runId = asRunId("run:v04:test");
const baselineExecutionId = asExecutionId("execution:v04:baseline");
const candidateExecutionId = asExecutionId("execution:v04:candidate");
const replayExecutionId = asExecutionId("execution:v04:replay");
const receiptId = asEvidenceAccessReceiptId("receipt:v2:test");

const claimPolicyManifest = {
  schemaVersion: 1 as const,
  policies: [
    {
      policyId: asClaimPolicyId("chronorift.signal-ordering-evidence"),
      policyVersion: "1.0.0",
      mechanismId: "signal_before_receiver_connection",
      assertionSchemaId:
        "chronorift.godot.signal-before-receiver-connection.v1",
    },
  ],
  manifestHash: hash("0"),
};

const contract = {
  schemaVersion: 3 as const,
  contractId: asContractId(`contract:v3:${hash("a")}`),
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
    status: "frozen" as const,
    authoredBy: "gameplay-team",
    approvedBy: "test-owner",
    approvedAt: "2026-08-06T00:00:00.000Z",
  },
  evaluator: {
    evaluatorId: "temporal.signal-property",
    evaluatorVersion: "1.0.0",
    evaluatorHash: hash("b"),
  },
  rule: {
    trigger: { kind: "signal" as const, source: "switch", name: "activated" },
    expectation: {
      kind: "property_equals" as const,
      path: "door.open",
      value: true,
    },
    withinTicks: 1,
    inclusive: true as const,
  },
};

const fingerprint = {
  schemaVersion: 2 as const,
  executionId: baselineExecutionId,
  runId,
  investigationId,
  source: {
    repositoryId: "chronorift",
    treeHash: hash("c"),
    gitRevision: "deadbeef",
    dirtyPatchHash: null,
  },
  build: {
    gameBuildHash: hash("d"),
    importCacheHash: null,
  },
  runtime: {
    engine: "godot",
    engineVersion: "4.6.1",
    platform: "linux",
    renderer: "gl_compatibility",
    physicsEngine: "godot_physics_3d",
    adapterVersion: "0.4.0",
    protocolVersion: "2",
    pluginVersion: "0.4.0",
    configurationHash: hash("e"),
    registeredRngDomains: ["fixture"],
  },
  contract: {
    contractId: contract.contractId,
    bundleHash: hash("a"),
  },
  claimPolicyManifest,
  checkpoint: {
    checkpointId: asCheckpointId("checkpoint:v04:test"),
    descriptorHash: hash("f"),
    restoreRecipeHash: hash("0"),
    coverageHash: hash("1"),
  },
  input: {
    inputTraceId: asInputTraceId("trace:v04:test"),
    traceHash: hash("2"),
    inputMapHash: hash("3"),
  },
  controls: {
    requested: { fixed_fps: 60 },
    realized: { fixed_fps: 60 },
  },
  intervention: {
    interventionId: null,
    specification: null,
  },
  probe: { profileHash: hash("4") },
  telemetry: { schemaVersion: 2, schemaHash: hash("5") },
  fingerprintHash: hash("6"),
  comparisonBasisHash: hash("7"),
};

const proposal = {
  schemaVersion: 4 as const,
  proposalId: asProposalId("proposal:v04:test"),
  runId,
  investigationId,
  capsuleId: asCapsuleId("capsule:v04:test"),
  baselineExecutionId,
  replayExecutionId,
  candidateExecutionIds: [candidateExecutionId],
  comparisonIds: [asComparisonId("comparison:v04:test")],
  accessReceiptIds: [receiptId],
  claim: {
    kind: "mechanism" as const,
    mechanismId: "vendor.example/custom-runtime-mechanism@1",
    assertion: {
      schemaId: "vendor.example/custom-runtime-mechanism.assertion@1",
      payload: { receiver: "door", expectedProperty: "door.open" },
    },
  },
  summary: "The controlled intervention supports the proposed mechanism.",
  evidenceEventIds: [asEventId("event:v04:signal")],
  blockers: [],
  nextExperiment: null,
  confidence: 0.1,
};

describe("v0.4 domain contracts", () => {
  it("validates a canonical Claim Policy registry manifest", () => {
    expect(ClaimPolicyManifestV1Schema.parse(claimPolicyManifest)).toEqual(
      claimPolicyManifest,
    );
    expect(
      claimPolicyManifestV1Content(claimPolicyManifest),
    ).not.toHaveProperty("manifestHash");
    expect(() =>
      ClaimPolicyManifestV1Schema.parse({
        ...claimPolicyManifest,
        policies: [
          {
            ...claimPolicyManifest.policies[0],
            policyId: asClaimPolicyId("z.last"),
          },
          {
            ...claimPolicyManifest.policies[0],
            policyId: asClaimPolicyId("a.first"),
            mechanismId: "other_mechanism",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      ClaimPolicyManifestV1Schema.parse({
        ...claimPolicyManifest,
        policies: [
          claimPolicyManifest.policies[0],
          claimPolicyManifest.policies[0],
        ],
      }),
    ).toThrow();
  });

  it("validates a strict, content-addressed frozen Contract bundle", () => {
    expect(FrozenContractBundleV3Schema.parse(contract)).toEqual(contract);
    expect(frozenContractBundleV3Content(contract)).not.toHaveProperty(
      "contractId",
    );
    expect(() =>
      FrozenContractBundleV3Schema.parse({
        ...contract,
        contractId: asContractId("contract:not-content-addressed"),
      }),
    ).toThrow();
    expect(() =>
      FrozenContractBundleV3Schema.parse({
        ...contract,
        evaluator: { ...contract.evaluator, executableCode: "return true" },
      }),
    ).toThrow();
  });

  it("validates complete fingerprint provenance and hash inputs strictly", () => {
    expect(ExecutionFingerprintV2Schema.parse(fingerprint)).toEqual(
      fingerprint,
    );
    const content = executionFingerprintV2Content(fingerprint);
    expect(content).not.toHaveProperty("fingerprintHash");
    expect(content).not.toHaveProperty("comparisonBasisHash");
    expect(content.contract.contractId).toBe(contract.contractId);

    expect(() =>
      ExecutionFingerprintV2Schema.parse({
        ...fingerprint,
        source: { ...fingerprint.source, treeHash: "not-a-sha256" },
      }),
    ).toThrow();
    expect(() =>
      ExecutionFingerprintV2Schema.parse({
        ...fingerprint,
        intervention: {
          interventionId: asInterventionId("intervention:v04:test"),
          specification: null,
        },
      }),
    ).toThrow();
    expect(() =>
      ExecutionFingerprintV2Schema.parse({
        ...fingerprint,
        runtime: {
          ...fingerprint.runtime,
          registeredRngDomains: ["fixture", "fixture"],
        },
      }),
    ).toThrow();
  });

  it("scopes V2 evidence receipts to an investigation rather than a fixture", () => {
    const receipt = {
      schemaVersion: 2 as const,
      receiptId,
      runId,
      investigationId,
      accessKind: "capsule" as const,
      resourceId: "capsule:v04:test",
      requestHash: hash("8"),
      contentHash: hash("9"),
      sourceCoverage: [],
      issuedAt: "2026-08-06T00:00:00.000Z",
    };
    expect(EvidenceAccessReceiptV2Schema.parse(receipt)).toEqual(receipt);
    expect(() =>
      EvidenceAccessReceiptV2Schema.parse({
        ...receipt,
        fixtureId: asFixtureId("fixture:must-not-leak"),
      }),
    ).toThrow();
  });

  it("accepts an open mechanism identifier without letting confidence alter shape", () => {
    expect(DiagnosisProposalV4Schema.parse(proposal).claim).toEqual(
      proposal.claim,
    );
    expect(
      DiagnosisProposalV4Schema.parse({ ...proposal, confidence: 0 })
        .confidence,
    ).toBe(0);
    expect(
      DiagnosisProposalV4Schema.parse({ ...proposal, confidence: 1 })
        .confidence,
    ).toBe(1);
    expect(() =>
      DiagnosisProposalV4Schema.parse({
        ...proposal,
        replayExecutionId: undefined,
      }),
    ).toThrow();
  });

  it("requires an unknown claim to explain the blocker and next experiment", () => {
    const unknown = {
      ...proposal,
      replayExecutionId: undefined,
      candidateExecutionIds: [],
      comparisonIds: [],
      claim: { kind: "unknown" as const },
      blockers: ["No admissible replay is available."],
      nextExperiment: "Restore a checkpoint with complete coverage.",
    };
    expect(DiagnosisProposalV4Schema.parse(unknown).claim.kind).toBe("unknown");
    expect(() =>
      DiagnosisProposalV4Schema.parse({
        ...unknown,
        blockers: [],
        nextExperiment: null,
      }),
    ).toThrow();
  });

  it("constrains canonical verdicts independently from proposal confidence", () => {
    const confirmed = {
      schemaVersion: 3 as const,
      verdictId: asVerdictId("verdict:v04:test"),
      proposalId: proposal.proposalId,
      runId,
      investigationId,
      status: "confirmed" as const,
      claimLevel: "mechanism_supported" as const,
      mechanismId: proposal.claim.mechanismId,
      claimPolicyId: asClaimPolicyId("policy:custom-runtime@1"),
      summary: "The mechanism is supported, without claiming uniqueness.",
      validatedReferences: [
        {
          artifactKind: "fingerprint" as const,
          executionId: baselineExecutionId,
        },
        { artifactKind: "receipt" as const, receiptId },
      ],
      blockers: [] as const,
      nextExperiment: null,
    };
    expect(DiagnosisVerdictV3Schema.parse(confirmed).status).toBe("confirmed");
    expect(() =>
      DiagnosisVerdictV3Schema.parse({ ...confirmed, confidence: 1 }),
    ).toThrow();
    expect(() =>
      DiagnosisVerdictV3Schema.parse({
        ...confirmed,
        claimLevel: "root_cause_unique",
      }),
    ).toThrow();
    expect(() =>
      DiagnosisVerdictV3Schema.parse({
        ...confirmed,
        blockers: ["Evidence is missing"],
      }),
    ).toThrow();

    const inconclusive = {
      ...confirmed,
      status: "inconclusive" as const,
      claimLevel: "none" as const,
      mechanismId: null,
      claimPolicyId: null,
      blockers: ["Evidence is missing"],
      nextExperiment: "Run the smallest admissible experiment.",
    };
    expect(DiagnosisVerdictV3Schema.parse(inconclusive).status).toBe(
      "inconclusive",
    );
    expect(() =>
      DiagnosisVerdictV3Schema.parse({ ...inconclusive, blockers: [] }),
    ).toThrow();
  });

  it("validates v0.4 artifact references and durable budget reservations", () => {
    expect(
      ArtifactReferenceV4Schema.parse({
        artifactKind: "reservation",
        reservationId: asExperimentReservationId("reservation:v04:1"),
      }).artifactKind,
    ).toBe("reservation");

    const reservation = {
      schemaVersion: 1 as const,
      reservationId: asExperimentReservationId("reservation:v04:1"),
      investigationId,
      runId,
      reservedAt: "2026-08-06T00:00:00.000Z",
      reservationKind: "intervention" as const,
      interventionId: asInterventionId("intervention:v04:delay"),
      budget: {
        scope: "investigation" as const,
        ordinal: 1,
        maxInterventions: 2,
      },
    };
    expect(ExperimentReservationV1Schema.parse(reservation)).toEqual(
      reservation,
    );
    expect(() =>
      ExperimentReservationV1Schema.parse({
        ...reservation,
        budget: { ...reservation.budget, ordinal: 3 },
      }),
    ).toThrow();
    expect(() =>
      ExperimentReservationV1Schema.parse({
        ...reservation,
        reservationKind: "baseline",
      }),
    ).toThrow();
  });
});
