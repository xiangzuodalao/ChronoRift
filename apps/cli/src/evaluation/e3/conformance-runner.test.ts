import { generateKeyPairSync } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { asSha256DigestV1, type JsonValue } from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";

import {
  artifactSinkCommitmentV1,
  assignmentIdV1,
  campaignIdV1,
  campaignRegistrationLeafBytesV1,
  canonicalContentHashV1,
  closurePublicationLeafBytesV1,
  ed25519KeyIdV1,
  eventIdV1,
  merkleLeafHashV1,
  merkleNodeHashV1,
  revisionIdV1,
  sha256HexV1,
  signCanonicalJsonV1,
} from "./canonical.js";
import {
  E3AppendReceiptV1Schema,
  E3JournalEntryV1Schema,
  E3PrimaryClosureV1Schema,
  E3PublicationProofV1Schema,
  E3RevisionJournalCheckpointV1Schema,
  E3_EVENT_ACTOR_ACL_V1,
  E3_EVENT_PAYLOAD_SCHEMA_IDS_V1,
  E3_SCHEMA_IDS_V1,
  type E3AppendReceiptV1,
  type E3CampaignManifestV1,
  type E3EventKindV1,
  type E3JournalEntryV1,
  type E3PublicationProofV1,
  type E3RegistrarServiceBindingV1,
  type E3RegistrarTrustRootV1,
} from "./contracts.js";
import {
  E3ResponseLossObservationTransportV1,
  E3_CONFORMANCE_EVIDENCE_FILE_V1,
  E3_CONFORMANCE_FAULT_CONTROL_POLICY_SCHEMA_ID_V1,
  E3_CONFORMANCE_FAULT_CONTROL_REQUEST_SCHEMA_ID_V1,
  E3_CONFORMANCE_FAULT_CONTROL_RESPONSE_SCHEMA_ID_V1,
  E3_CONFORMANCE_RUNNER_RELATIVE_PATH_V1,
  E3_CONFORMANCE_VALIDATOR_RELATIVE_PATH_V1,
  campaignConformanceFaultControlRequestIdV1,
  campaignConformanceFaultReceiptIdV1,
  createE3CampaignConformanceFaultControlDuplexPortV1,
  createRegistrarClosureEvidencePortV1,
  preflightE3CampaignLiveV1,
  runE3CampaignConformanceV1,
  runE3CampaignLiveFromEnvironmentV1,
  runPreparedE3CampaignLiveV1,
  runPreparedE3CampaignLiveSuiteV1,
  verifyCampaignConformanceFaultReceiptV1,
  verifyConfiguredArtifactSinkBindingV1,
  verifyFaultControlPolicyV1,
  verifyRegistrarRoleKeyCoverageV1,
  verifyTrustRootFreezeRecordV1,
  type E3CampaignClosedEvidenceV1,
  type E3CampaignConformanceFaultControlPortV1,
  type E3CampaignConformanceFaultCaseV1,
  type E3CampaignConformanceFaultControlPolicyV1,
  type E3CampaignConformancePreflightV1,
  type E3ConformanceRunnerError,
} from "./conformance-runner.js";
import { eventHashV1, revisionHashV1 } from "./projector.js";
import { E3RegistrarError, type E3RegistrarPortV1 } from "./registrar-port.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const digest = (character: string) => asSha256DigestV1(character.repeat(64));
const signature = "A".repeat(86);
const timestamp = "2026-08-11T00:00:01.000Z";
const deadline = "2026-08-11T00:05:00.000Z";

const publicPem = (
  publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"],
) => publicKey.export({ type: "spki", format: "pem" }).toString();

const faultPair = generateKeyPairSync("ed25519");
const faultPublicPem = publicPem(faultPair.publicKey);
const faultKeyId = ed25519KeyIdV1(faultPair.publicKey);

const faultReceipt = (
  faultCase: E3CampaignConformanceFaultCaseV1,
  input: {
    readonly requestId: string;
    readonly serviceId: string;
    readonly namespace: string;
    readonly faultControlId: string;
    readonly faultPlanId: string;
    readonly faultKeyId: string;
  },
) => {
  const basis = {
    schemaId: "chronorift.e3.campaign-conformance-fault-receipt" as const,
    schemaVersion: 1 as const,
    requestId: input.requestId,
    faultCase,
    faultControlId: input.faultControlId,
    faultPlanId: input.faultPlanId,
    faultKeyId: input.faultKeyId,
    registrarServiceId: input.serviceId,
    namespace: input.namespace,
    startedAt: timestamp,
    completedAt: timestamp,
    observedRunnerExitCode: 1,
    observedErrorCode: "live_dependency_unavailable" as const,
    finalEvidencePresent: false as const,
    successSummaryPresent: false as const,
  };
  const signedBasis = {
    ...basis,
    receiptId: campaignConformanceFaultReceiptIdV1(
      basis as unknown as JsonValue,
    ),
  };
  return {
    ...signedBasis,
    signature: signCanonicalJsonV1({
      privateKey: faultPair.privateKey,
      domain: "chronorift-e3-conformance-fault-receipt-signature-v1",
      schemaId: basis.schemaId,
      version: basis.schemaVersion,
      value: signedBasis as unknown as JsonValue,
    }),
  };
};

const faultControl = (
  observed: E3CampaignConformanceFaultCaseV1[] = [],
): E3CampaignConformanceFaultControlPortV1 => ({
  runFaultCase: ({
    requestId,
    faultCase,
    registrarServiceId,
    namespace,
    faultControlId,
    faultPlanId,
    faultKeyId: expectedFaultKeyId,
  }) => {
    observed.push(faultCase);
    return Promise.resolve(
      faultReceipt(faultCase, {
        requestId,
        serviceId: registrarServiceId,
        namespace,
        faultControlId,
        faultPlanId,
        faultKeyId: expectedFaultKeyId,
      }),
    );
  },
});

const faultControlRequest = (faultCase: E3CampaignConformanceFaultCaseV1) => {
  const input = {
    faultCase,
    registrarServiceId: "registrar.fault-test",
    namespace: "chronorift/e3/fault-test",
    evidenceDirectory: "/tmp/chronorift-e3-fault-test",
    evidenceFileName: E3_CONFORMANCE_EVIDENCE_FILE_V1,
    faultControlId: "fault-control.test",
    faultPlanId: digest("e"),
    faultKeyId,
  } as const;
  return {
    requestId: campaignConformanceFaultControlRequestIdV1({
      schemaId: E3_CONFORMANCE_FAULT_CONTROL_REQUEST_SCHEMA_ID_V1,
      schemaVersion: 1,
      ...input,
    }),
    ...input,
  };
};

const faultControlDuplexPair = () => {
  const requests = new PassThrough();
  const responses = new PassThrough();
  return {
    channel: Duplex.from({ readable: responses, writable: requests }),
    requests,
    responses,
  };
};

const roleKey = (
  keyId: E3RegistrarServiceBindingV1["receiptKey"]["keyId"],
  publicKeyPem: string,
): E3RegistrarServiceBindingV1["receiptKey"] => ({
  keyId,
  publicKeyPem,
  validFrom: "2026-08-10T00:00:00.000Z",
  validUntil: "2026-08-12T00:00:00.000Z",
});

const appendReceipt = (input: {
  readonly entry: E3JournalEntryV1;
  readonly sequence: number;
  readonly service: E3RegistrarServiceBindingV1;
  readonly committedAt?: string;
}): E3AppendReceiptV1 => {
  const eventHash = eventHashV1(input.entry);
  return E3AppendReceiptV1Schema.parse({
    schemaId: E3_SCHEMA_IDS_V1.appendReceipt,
    schemaVersion: 1,
    campaignId: input.entry.event.campaignId,
    assignmentId: input.entry.event.assignmentId,
    eventId: input.entry.event.eventId,
    eventHash,
    journalHead: eventHash,
    ordinal: input.entry.event.ordinal,
    commitSequence: input.sequence,
    committedAt: input.committedAt ?? timestamp,
    registrarServiceId: input.service.serviceId,
    receiptKeyId: input.service.receiptKey.keyId,
    signature,
  });
};

const unsignedEntry = (input: {
  readonly campaignId: string;
  readonly assignmentId: string;
  readonly ordinal: number;
  readonly previousHash: string | null;
  readonly eventKind: E3EventKindV1;
  readonly actorKeyId: string;
  readonly payload: JsonValue;
}): E3JournalEntryV1 => {
  const payloadHash = canonicalContentHashV1(input.payload);
  return E3JournalEntryV1Schema.parse({
    event: {
      schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
      schemaVersion: 1,
      campaignId: input.campaignId,
      assignmentId: input.assignmentId,
      eventId: eventIdV1({
        campaignId: input.campaignId,
        assignmentId: input.assignmentId,
        ordinal: input.ordinal,
        previousHash: input.previousHash ?? "",
        eventKind: input.eventKind,
        payloadHash,
      }),
      ordinal: input.ordinal,
      previousHash: input.previousHash,
      actorRole: E3_EVENT_ACTOR_ACL_V1[input.eventKind],
      actorKeyId: input.actorKeyId,
      eventKind: input.eventKind,
      payloadSchemaId: E3_EVENT_PAYLOAD_SCHEMA_IDS_V1[input.eventKind],
      payloadHash,
      signature,
    },
    payload: input.payload,
  });
};

const fixture = async (options?: {
  readonly evidenceDirectory?: string;
  readonly assignmentCharacter?: string;
  readonly capabilitySuffix?: string;
  readonly sharedPreflight?: E3CampaignConformancePreflightV1;
  readonly caseId?:
    | "early_complete"
    | "deadline_incomplete"
    | "deadline_cleanup_unproven_with_late_cleanup";
}): Promise<{
  readonly preflight: E3CampaignConformancePreflightV1;
  readonly registrar: E3RegistrarPortV1;
  readonly closedEvidence: (
    outcome?:
      "conformance_complete" | "incomplete_unknown" | "cleanup_unproven",
  ) => E3CampaignClosedEvidenceV1;
  readonly observedCapabilities: string[];
}> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-e3-runner-"));
  roots.push(root);
  const evidenceDirectory =
    options?.evidenceDirectory ?? join(root, "evidence");
  if (options?.evidenceDirectory === undefined) {
    await mkdir(evidenceDirectory);
  }

  const actorPair = generateKeyPairSync("ed25519");
  const cleanupPair = generateKeyPairSync("ed25519");
  const registrarPair = generateKeyPairSync("ed25519");
  const actorPublicPem = publicPem(actorPair.publicKey);
  const cleanupPublicPem = publicPem(cleanupPair.publicKey);
  const registrarPublicPem = publicPem(registrarPair.publicKey);
  const actorKeyId = ed25519KeyIdV1(actorPair.publicKey);
  const cleanupKeyId = ed25519KeyIdV1(cleanupPair.publicKey);
  const generatedService: E3RegistrarServiceBindingV1 = {
    serviceId: "registrar.test",
    hostname: "registrar.test",
    port: 443,
    basePath: "/e3/v1",
    caCertificatePem: "test-ca",
    tlsSpkiSha256: digest("1"),
    namespaces: ["chronorift/e3/test"],
    receiptKey: roleKey(digest("2"), registrarPublicPem),
    clockKey: roleKey(digest("3"), registrarPublicPem),
    closureKey: roleKey(digest("4"), registrarPublicPem),
    logKey: roleKey(digest("5"), registrarPublicPem),
  };
  const service = options?.sharedPreflight?.service ?? generatedService;
  const generatedTrustRoot = {
    schemaId: E3_SCHEMA_IDS_V1.trustRoot,
    schemaVersion: 1 as const,
    trustRootVersion: "test-v1",
    validFrom: "2026-08-10T00:00:00.000Z",
    validUntil: "2026-08-12T00:00:00.000Z",
    signatureThreshold: 2,
    rootKeys: [
      { keyId: digest("6"), publicKeyPem: registrarPublicPem },
      { keyId: digest("7"), publicKeyPem: registrarPublicPem },
    ],
    services: [service],
    signatures: [
      { keyId: digest("6"), signature },
      { keyId: digest("7"), signature },
    ],
  } satisfies E3RegistrarTrustRootV1;
  const trustRoot = options?.sharedPreflight?.trustRoot ?? generatedTrustRoot;
  const artifactSinkId = "ci-artifacts.test";
  const leaseId = "lease:test";
  const artifactSinkCommitment = artifactSinkCommitmentV1({
    namespace: "chronorift/e3/test",
    leaseId,
    artifactSinkId,
    canonicalAbsolutePath: evidenceDirectory,
    evidenceFileName: E3_CONFORMANCE_EVIDENCE_FILE_V1,
  });
  const manifest: E3CampaignManifestV1 = {
    schemaId: E3_SCHEMA_IDS_V1.campaignManifest,
    schemaVersion: 1,
    campaignPurpose: "registrar_conformance",
    claimEligible: false,
    modelCalls: 0,
    evaluatorRuns: 0,
    artifactSinkMode: "configured_external_ci_artifact_directory_v1",
    artifactSinkId,
    artifactSinkCommitment,
    namespace: "chronorift/e3/test",
    registrarServiceId: service.serviceId,
    trustRootVersion: trustRoot.trustRootVersion,
    productSha256: digest("8"),
    runnerSha256: digest("9"),
    validatorSha256: digest("a"),
    deadline,
    assignmentCount: 1,
    assignments: [
      {
        slotOrdinal: 0,
        assignmentCommitment: digest(options?.assignmentCharacter ?? "b"),
        conformanceActorKeyId: actorKeyId,
        cleanupActorKeyId: cleanupKeyId,
      },
    ],
  };
  const faultControlPolicy: E3CampaignConformanceFaultControlPolicyV1 = options
    ?.sharedPreflight?.faultControlPolicy ?? {
    schemaId: E3_CONFORMANCE_FAULT_CONTROL_POLICY_SCHEMA_ID_V1,
    schemaVersion: 1,
    trustRootVersion: trustRoot.trustRootVersion,
    serviceId: service.serviceId,
    namespace: manifest.namespace,
    faultControlId: "fault-control.test",
    faultPlanId: digest("e"),
    faultKey: {
      keyId: faultKeyId,
      publicKeyPem: faultPublicPem,
      validFrom: "2026-08-10T00:00:00.000Z",
      validUntil: "2026-08-12T00:00:00.000Z",
    },
    runnerSha256: manifest.runnerSha256,
    validatorSha256: manifest.validatorSha256,
    allowedFaultCases: [
      "registrar_unreachable",
      "transparency_log_unavailable",
    ],
    signatures: [
      { keyId: digest("6"), signature },
      { keyId: digest("7"), signature },
    ],
  };
  const preflight: E3CampaignConformancePreflightV1 = {
    caseId: options?.caseId ?? "early_complete",
    cleanupWitnessMode:
      options?.caseId === "deadline_incomplete"
        ? "external_deadline_no_finish_v1"
        : options?.caseId === "deadline_cleanup_unproven_with_late_cleanup"
          ? "external_withhold_cleanup_until_closed_then_revision_v1"
          : "external_auto_append_v1",
    repositoryRoot: process.cwd(),
    evidenceDirectory,
    validatorPath: join(
      process.cwd(),
      ".github/scripts/validate-vnext-e3-campaign.mjs",
    ),
    trustRoot,
    trustRootFileSha256: digest("c"),
    trustRootFreezeRecordSha256: digest("d"),
    trustRootExternalPinSha256: digest("c"),
    faultControlPolicy,
    faultControlPolicySha256:
      options?.sharedPreflight?.faultControlPolicySha256 ?? digest("f"),
    service,
    manifest,
    actorKeys: [
      {
        actorRole: "conformance_actor",
        keyId: actorKeyId,
        publicKeyPem: actorPublicPem,
        validFrom: "2026-08-10T00:00:00.000Z",
        validUntil: "2026-08-12T00:00:00.000Z",
      },
      {
        actorRole: "cleanup_actor",
        keyId: cleanupKeyId,
        publicKeyPem: cleanupPublicPem,
        validFrom: "2026-08-10T00:00:00.000Z",
        validUntil: "2026-08-12T00:00:00.000Z",
      },
    ],
    actorPrivateKey: actorPair.privateKey,
    leaseId,
    registrationCapability: `registration-capability-test${options?.capabilitySuffix ?? ""}`,
    actorAppendCapability: `actor-append-capability-test${options?.capabilitySuffix ?? ""}`,
  };

  const entries: E3JournalEntryV1[] = [];
  const receipts: E3AppendReceiptV1[] = [];
  const acceptedByEventId = new Map<
    string,
    { readonly eventHash: string; readonly receipt: E3AppendReceiptV1 }
  >();
  const acceptedPayloadHashes = new Set<string>();
  const observedCapabilities: string[] = [];
  let registrationCheckpoint:
    E3PublicationProofV1["registrationCheckpoint"] | undefined;
  const registrar: E3RegistrarPortV1 = {
    registerCampaign: ({ manifest: input, actorCapability }) => {
      observedCapabilities.push(actorCapability);
      const campaignId = campaignIdV1(input as unknown as JsonValue);
      const slot = input.assignments[0];
      const assignmentId = assignmentIdV1({
        campaignId,
        slotOrdinal: slot.slotOrdinal,
        assignmentCommitment: slot.assignmentCommitment,
      });
      const registered = unsignedEntry({
        campaignId,
        assignmentId,
        ordinal: 1,
        previousHash: null,
        eventKind: "registrar_assignment_registered",
        actorKeyId: service.receiptKey.keyId,
        payload: {
          assignmentId,
          assignmentCommitment: slot.assignmentCommitment,
          slotOrdinal: 0,
          registeredAt: timestamp,
        },
      });
      entries.push(registered);
      const receipt = appendReceipt({
        entry: registered,
        sequence: 1,
        service,
      });
      receipts.push(receipt);
      acceptedByEventId.set(registered.event.eventId, {
        eventHash: eventHashV1(registered),
        receipt,
      });
      acceptedPayloadHashes.add(registered.event.payloadHash);
      const rootHash = merkleLeafHashV1(
        campaignRegistrationLeafBytesV1({
          campaignId,
          deadline: input.deadline,
        }),
      );
      registrationCheckpoint = {
        logId: "log.test",
        treeSize: 1,
        rootHash,
        issuedAt: timestamp,
        logKeyId: service.logKey.keyId,
        signature,
      };
      return Promise.resolve({
        campaignId,
        assignmentId,
        receipt,
        registrationProof: {
          schemaId: E3_SCHEMA_IDS_V1.registrationProof,
          schemaVersion: 1,
          campaignId,
          checkpoint: registrationCheckpoint,
          inclusionProof: { leafIndex: 0, treeSize: 1, auditPath: [] },
        },
      });
    },
    appendEvent: ({ entry, actorCapability }) => {
      observedCapabilities.push(actorCapability);
      const submittedHash = eventHashV1(entry);
      const existing = acceptedByEventId.get(entry.event.eventId);
      if (existing !== undefined) {
        return existing.eventHash === submittedHash
          ? Promise.resolve(existing.receipt)
          : Promise.reject(
              new E3RegistrarError(
                "conflict",
                "same idempotency key with different bytes",
              ),
            );
      }
      if (entry.event.actorRole !== "conformance_actor") {
        return Promise.reject(
          new E3RegistrarError("unauthorized", "event kind is not actor-owned"),
        );
      }
      if (entry.event.signature === signature) {
        return Promise.reject(
          new E3RegistrarError("unauthorized", "actor signature is invalid"),
        );
      }
      if (
        entry.event.ordinal !== entries.length + 1 ||
        entry.event.previousHash !== receipts.at(-1)!.journalHead
      ) {
        return Promise.reject(
          new E3RegistrarError(
            "conflict",
            "stale head or out-of-order ordinal",
          ),
        );
      }
      if (acceptedPayloadHashes.has(entry.event.payloadHash)) {
        return Promise.reject(
          new E3RegistrarError("conflict", "payload was already retained"),
        );
      }
      entries.push(entry);
      const receipt = appendReceipt({
        entry,
        sequence: receipts.length + 1,
        service,
      });
      receipts.push(receipt);
      acceptedByEventId.set(entry.event.eventId, {
        eventHash: submittedHash,
        receipt,
      });
      acceptedPayloadHashes.add(entry.event.payloadHash);
      return Promise.resolve(receipt);
    },
    readJournal: () => Promise.reject(new Error("not used")),
    readPrimaryClosure: () => Promise.reject(new Error("not used")),
    readPendingStatus: () => Promise.reject(new Error("not used")),
    appendRevision: () => Promise.reject(new Error("not used")),
    readPublicationProof: () => Promise.reject(new Error("not used")),
    readClosedEvidence: () => Promise.resolve(null),
  };

  const closedEvidence = (
    outcome:
      | "conformance_complete"
      | "incomplete_unknown"
      | "cleanup_unproven" = "conformance_complete",
  ): E3CampaignClosedEvidenceV1 => {
    const campaignId = campaignIdV1(manifest as unknown as JsonValue);
    const assignmentId = assignmentIdV1({
      campaignId,
      slotOrdinal: 0,
      assignmentCommitment: manifest.assignments[0].assignmentCommitment,
    });
    const cleanupPayload = {
      leaseId: "lease:test",
      observedAt: outcome === "conformance_complete" ? timestamp : deadline,
      processesEmpty: true,
      cgroupEmpty: true,
      storageEmpty: true,
      networkLeaseClosed: true,
      credentialLeaseRevoked: true,
      observationCoverage: "complete" as const,
    };
    if (outcome === "conformance_complete") {
      const cleanup = unsignedEntry({
        campaignId,
        assignmentId,
        ordinal: 4,
        previousHash: receipts.at(-1)!.journalHead,
        eventKind: "conformance_cleanup_proven",
        actorKeyId: cleanupKeyId,
        payload: cleanupPayload,
      });
      entries.push(cleanup);
      receipts.push(
        appendReceipt({
          entry: cleanup,
          sequence: receipts.length + 1,
          service,
        }),
      );
    } else {
      const deadlineElapsed = unsignedEntry({
        campaignId,
        assignmentId,
        ordinal: entries.length + 1,
        previousHash: receipts.at(-1)!.journalHead,
        eventKind: "registrar_deadline_elapsed",
        actorKeyId: service.clockKey.keyId,
        payload: { deadline, observedAt: deadline },
      });
      entries.push(deadlineElapsed);
      receipts.push(
        appendReceipt({
          entry: deadlineElapsed,
          sequence: receipts.length + 1,
          service,
          committedAt: deadline,
        }),
      );
    }
    const closedAt = outcome === "conformance_complete" ? timestamp : deadline;
    const closed = unsignedEntry({
      campaignId,
      assignmentId,
      ordinal: entries.length + 1,
      previousHash: receipts.at(-1)!.journalHead,
      eventKind: "registrar_primary_closed",
      actorKeyId: service.receiptKey.keyId,
      payload: {
        preClosureHead: receipts.at(-1)!.journalHead,
        closedAt,
        primaryOutcome: outcome,
      },
    });
    entries.push(closed);
    receipts.push(
      appendReceipt({
        entry: closed,
        sequence: receipts.length + 1,
        service,
        committedAt: closedAt,
      }),
    );
    const journal = {
      schemaId: E3_SCHEMA_IDS_V1.journal,
      schemaVersion: 1 as const,
      campaignId,
      assignmentId,
      events: [...entries],
      eventCount: entries.length,
      journalHead: receipts.at(-1)!.journalHead,
    };
    const closureBasis = {
      schemaId: E3_SCHEMA_IDS_V1.primaryClosure,
      schemaVersion: 1 as const,
      campaignId,
      journalHead: journal.journalHead,
      deadline,
      closedAt,
      primaryOutcome: outcome,
      assignmentCount: 1,
      outcomeCounts: {
        conformanceComplete: outcome === "conformance_complete" ? 1 : 0,
        incompleteUnknown: outcome === "incomplete_unknown" ? 1 : 0,
        cleanupUnproven: outcome === "cleanup_unproven" ? 1 : 0,
      },
      eventCount: journal.eventCount,
      appendAttemptCount:
        outcome === "conformance_complete"
          ? journal.eventCount + 7
          : journal.eventCount,
      rejectionCount: outcome === "conformance_complete" ? 6 : 0,
      idempotentReplayCount: outcome === "conformance_complete" ? 1 : 0,
      publicationState: "closure_sealed_publication_pending" as const,
      claimEligible: false as const,
      modelCalls: 0 as const,
      evaluatorRuns: 0 as const,
      clockKeyId: service.clockKey.keyId,
      clockSignature: signature,
      closureKeyId: service.closureKey.keyId,
    };
    const primaryClosure = E3PrimaryClosureV1Schema.parse({
      ...closureBasis,
      closureHash: canonicalContentHashV1(closureBasis as unknown as JsonValue),
      signature,
    });
    const registration = registrationCheckpoint!;
    const closureLeaf = merkleLeafHashV1(
      closurePublicationLeafBytesV1({
        campaignId,
        closureHash: primaryClosure.closureHash,
      }),
    );
    const closureRoot = merkleNodeHashV1(registration.rootHash, closureLeaf);
    const publicationProof = E3PublicationProofV1Schema.parse({
      schemaId: E3_SCHEMA_IDS_V1.publicationProof,
      schemaVersion: 1,
      campaignId,
      closureHash: primaryClosure.closureHash,
      registrationCheckpoint: registration,
      closureCheckpoint: {
        logId: registration.logId,
        treeSize: 2,
        rootHash: closureRoot,
        issuedAt: timestamp,
        logKeyId: service.logKey.keyId,
        signature,
      },
      closureInclusionProof: {
        leafIndex: 1,
        treeSize: 2,
        auditPath: [registration.rootHash],
      },
      registrationToClosureConsistencyProof: {
        firstTreeSize: 1,
        secondTreeSize: 2,
        auditPath: [closureLeaf],
      },
    });
    const revisions = [];
    const revisionReceipts = [];
    if (outcome === "cleanup_unproven") {
      const lateCleanup = unsignedEntry({
        campaignId,
        assignmentId,
        ordinal: 4,
        previousHash: receipts[2]!.journalHead,
        eventKind: "conformance_cleanup_proven",
        actorKeyId: cleanupKeyId,
        payload: cleanupPayload,
      });
      const revisionBasis = {
        schemaId: E3_SCHEMA_IDS_V1.revisionEnvelope,
        schemaVersion: 1 as const,
        campaignId,
        primaryClosureHash: primaryClosure.closureHash,
        revisionOrdinal: 1,
        previousRevisionHash: primaryClosure.closureHash,
        lateEntry: lateCleanup,
        receivedAt: deadline,
        registrarKeyId: service.closureKey.keyId,
      };
      const revision = {
        ...revisionBasis,
        revisionId: revisionIdV1({
          campaignId,
          primaryClosureHash: primaryClosure.closureHash,
          revisionOrdinal: 1,
          previousRevisionHash: primaryClosure.closureHash,
          lateEventId: lateCleanup.event.eventId,
        }),
        signature,
      };
      revisions.push(revision);
      const revisionHash = revisionHashV1(revision);
      revisionReceipts.push(
        E3AppendReceiptV1Schema.parse({
          schemaId: E3_SCHEMA_IDS_V1.appendReceipt,
          schemaVersion: 1,
          campaignId,
          assignmentId,
          eventId: revision.revisionId,
          eventHash: revisionHash,
          journalHead: revisionHash,
          ordinal: 1,
          commitSequence: receipts.at(-1)!.commitSequence + 1,
          committedAt: deadline,
          registrarServiceId: service.serviceId,
          receiptKeyId: service.receiptKey.keyId,
          signature,
        }),
      );
    }
    const revisionHead =
      revisions.length === 0 ? null : revisionHashV1(revisions[0]!);
    const revisionJournalCheckpoint = E3RevisionJournalCheckpointV1Schema.parse(
      {
        schemaId: E3_SCHEMA_IDS_V1.revisionJournalCheckpoint,
        schemaVersion: 1,
        campaignId,
        primaryClosureHash: primaryClosure.closureHash,
        revisionHead,
        revisionCount: revisions.length,
        latestKnownEventCount: journal.eventCount + revisions.length,
        commitSequence:
          revisionReceipts.at(-1)?.commitSequence ??
          receipts.at(-1)!.commitSequence,
        asOf: outcome === "conformance_complete" ? timestamp : deadline,
        registrarServiceId: service.serviceId,
        closureKeyId: service.closureKey.keyId,
        signature,
      },
    );
    return {
      journal,
      appendReceipts: [...receipts],
      primaryClosure,
      revisions,
      revisionReceipts,
      revisionJournalCheckpoint,
      publicationProof,
      rejectionCount: outcome === "conformance_complete" ? 6 : 0,
    };
  };

  return { preflight, registrar, closedEvidence, observedCapabilities };
};

describe("E3.1 synthetic campaign conformance runner", () => {
  it("requires the repository freeze record to satisfy the same offline threshold", () => {
    const firstRoot = generateKeyPairSync("ed25519");
    const secondRoot = generateKeyPairSync("ed25519");
    const firstRootId = ed25519KeyIdV1(firstRoot.publicKey);
    const secondRootId = ed25519KeyIdV1(secondRoot.publicKey);
    const rolePairs = Array.from({ length: 4 }, () =>
      generateKeyPairSync("ed25519"),
    );
    const service: E3RegistrarServiceBindingV1 = {
      serviceId: "registrar.freeze-test",
      hostname: "registrar.freeze.test",
      port: 443,
      basePath: "/e3/v1",
      caCertificatePem: "test-ca",
      tlsSpkiSha256: digest("1"),
      namespaces: ["chronorift/e3/freeze-test"],
      receiptKey: roleKey(
        ed25519KeyIdV1(rolePairs[0]!.publicKey),
        publicPem(rolePairs[0]!.publicKey),
      ),
      clockKey: roleKey(
        ed25519KeyIdV1(rolePairs[1]!.publicKey),
        publicPem(rolePairs[1]!.publicKey),
      ),
      closureKey: roleKey(
        ed25519KeyIdV1(rolePairs[2]!.publicKey),
        publicPem(rolePairs[2]!.publicKey),
      ),
      logKey: roleKey(
        ed25519KeyIdV1(rolePairs[3]!.publicKey),
        publicPem(rolePairs[3]!.publicKey),
      ),
    };
    const trustRoot: E3RegistrarTrustRootV1 = {
      schemaId: E3_SCHEMA_IDS_V1.trustRoot,
      schemaVersion: 1,
      trustRootVersion: "freeze-test-v1",
      validFrom: "2026-08-10T00:00:00.000Z",
      validUntil: "2026-08-12T00:00:00.000Z",
      signatureThreshold: 2,
      rootKeys: [
        { keyId: firstRootId, publicKeyPem: publicPem(firstRoot.publicKey) },
        { keyId: secondRootId, publicKeyPem: publicPem(secondRoot.publicKey) },
      ],
      services: [service],
      signatures: [
        { keyId: firstRootId, signature },
        { keyId: secondRootId, signature },
      ],
    };
    const trustRootBytes = Buffer.from("frozen-root-bytes\n", "utf8");
    const basis = {
      schemaId: "chronorift.e3.registrar-trust-root-freeze",
      schemaVersion: 1 as const,
      trustRootVersion: trustRoot.trustRootVersion,
      trustRootFileSha256: sha256HexV1(trustRootBytes),
      externalChannelPinSha256: sha256HexV1(trustRootBytes),
      signedAt: timestamp,
      predecessor: null,
    };
    const freezeRecord = {
      ...basis,
      signatures: [
        {
          keyId: firstRootId,
          signature: signCanonicalJsonV1({
            privateKey: firstRoot.privateKey,
            domain: "chronorift-e3-trust-root-freeze-v1",
            schemaId: basis.schemaId,
            version: 1,
            value: basis,
          }),
        },
        {
          keyId: secondRootId,
          signature: signCanonicalJsonV1({
            privateKey: secondRoot.privateKey,
            domain: "chronorift-e3-trust-root-freeze-v1",
            schemaId: basis.schemaId,
            version: 1,
            value: basis,
          }),
        },
      ],
    };
    expect(() =>
      verifyTrustRootFreezeRecordV1({
        trustRoot,
        trustRootBytes,
        freezeRecord,
        expectedExternalTrustRootSha256: sha256HexV1(trustRootBytes),
      }),
    ).not.toThrow();
    expect(() =>
      verifyTrustRootFreezeRecordV1({
        trustRoot,
        trustRootBytes: Buffer.from("changed\n", "utf8"),
        freezeRecord,
        expectedExternalTrustRootSha256: sha256HexV1(trustRootBytes),
      }),
    ).toThrow(/does not match/u);
    expect(() =>
      verifyTrustRootFreezeRecordV1({
        trustRoot,
        trustRootBytes,
        freezeRecord: {
          ...freezeRecord,
          signatures: [freezeRecord.signatures[0], freezeRecord.signatures[0]],
        },
        expectedExternalTrustRootSha256: sha256HexV1(trustRootBytes),
      }),
    ).toThrow(/threshold/u);
  });

  it("requires a threshold-authorized fault policy and its independent receipt signature", () => {
    const roots = [
      generateKeyPairSync("ed25519"),
      generateKeyPairSync("ed25519"),
    ] as const;
    const rootIds = roots.map(({ publicKey }) => ed25519KeyIdV1(publicKey));
    const rolePairs = Array.from({ length: 4 }, () =>
      generateKeyPairSync("ed25519"),
    );
    const service: E3RegistrarServiceBindingV1 = {
      serviceId: "registrar.fault-test",
      hostname: "registrar.fault.test",
      port: 443,
      basePath: "/e3/v1",
      caCertificatePem: "test-ca",
      tlsSpkiSha256: digest("1"),
      namespaces: ["chronorift/e3/fault-test"],
      receiptKey: roleKey(
        ed25519KeyIdV1(rolePairs[0]!.publicKey),
        publicPem(rolePairs[0]!.publicKey),
      ),
      clockKey: roleKey(
        ed25519KeyIdV1(rolePairs[1]!.publicKey),
        publicPem(rolePairs[1]!.publicKey),
      ),
      closureKey: roleKey(
        ed25519KeyIdV1(rolePairs[2]!.publicKey),
        publicPem(rolePairs[2]!.publicKey),
      ),
      logKey: roleKey(
        ed25519KeyIdV1(rolePairs[3]!.publicKey),
        publicPem(rolePairs[3]!.publicKey),
      ),
    };
    const trustRoot: E3RegistrarTrustRootV1 = {
      schemaId: E3_SCHEMA_IDS_V1.trustRoot,
      schemaVersion: 1,
      trustRootVersion: "fault-test-v1",
      validFrom: "2026-08-10T00:00:00.000Z",
      validUntil: "2026-08-12T00:00:00.000Z",
      signatureThreshold: 2,
      rootKeys: roots.map(({ publicKey }, index) => ({
        keyId: rootIds[index]!,
        publicKeyPem: publicPem(publicKey),
      })),
      services: [service],
      signatures: rootIds.map((keyId) => ({ keyId, signature })),
    };
    const policyBasis = {
      schemaId: E3_CONFORMANCE_FAULT_CONTROL_POLICY_SCHEMA_ID_V1,
      schemaVersion: 1 as const,
      trustRootVersion: trustRoot.trustRootVersion,
      serviceId: service.serviceId,
      namespace: service.namespaces[0]!,
      faultControlId: "fault-control.test",
      faultPlanId: digest("e"),
      faultKey: {
        keyId: faultKeyId,
        publicKeyPem: faultPublicPem,
        validFrom: "2026-08-10T00:00:00.000Z",
        validUntil: "2026-08-12T00:00:00.000Z",
      },
      runnerSha256: digest("9"),
      validatorSha256: digest("a"),
      allowedFaultCases: [
        "registrar_unreachable",
        "transparency_log_unavailable",
      ] as const,
    };
    const policy = {
      ...policyBasis,
      signatures: roots.map(({ privateKey }, index) => ({
        keyId: rootIds[index]!,
        signature: signCanonicalJsonV1({
          privateKey,
          domain: "chronorift-e3-registrar-fault-control-policy-v1",
          schemaId: policyBasis.schemaId,
          version: policyBasis.schemaVersion,
          value: policyBasis as unknown as JsonValue,
        }),
      })),
    };
    const verified = verifyFaultControlPolicyV1({
      policy,
      trustRoot,
      service,
      namespace: policy.namespace,
      runnerSha256: policy.runnerSha256,
      validatorSha256: policy.validatorSha256,
      now: new Date(timestamp),
      requiredUntil: new Date(deadline),
    });
    expect(verified.faultKey.keyId).toBe(faultKeyId);
    expect(() =>
      verifyFaultControlPolicyV1({
        policy: { ...policy, faultPlanId: digest("f") },
        trustRoot,
        service,
        namespace: policy.namespace,
        runnerSha256: policy.runnerSha256,
        validatorSha256: policy.validatorSha256,
        now: new Date(timestamp),
        requiredUntil: new Date(deadline),
      }),
    ).toThrow(/signature|threshold/u);

    const requestId = digest("9");
    const receipt = faultReceipt("registrar_unreachable", {
      requestId,
      serviceId: service.serviceId,
      namespace: policy.namespace,
      faultControlId: policy.faultControlId,
      faultPlanId: policy.faultPlanId,
      faultKeyId,
    });
    expect(() =>
      verifyCampaignConformanceFaultReceiptV1({
        receipt,
        policy: verified,
        expectedRequestId: requestId,
        expectedCase: "registrar_unreachable",
        registrarServiceId: service.serviceId,
        namespace: policy.namespace,
      }),
    ).not.toThrow();
    expect(() =>
      verifyCampaignConformanceFaultReceiptV1({
        receipt: { ...receipt, signature: `B${receipt.signature.slice(1)}` },
        policy: verified,
        expectedRequestId: requestId,
        expectedCase: "registrar_unreachable",
        registrarServiceId: service.serviceId,
        namespace: policy.namespace,
      }),
    ).toThrow(/signature/u);
    expect(() =>
      verifyCampaignConformanceFaultReceiptV1({
        receipt,
        policy: verified,
        expectedRequestId: digest("8"),
        expectedCase: "registrar_unreachable",
        registrarServiceId: service.serviceId,
        namespace: policy.namespace,
      }),
    ).toThrow(/policy/u);
  });

  it("exchanges the frozen fault cases as canonical request-bound frames", async () => {
    const pair = faultControlDuplexPair();
    const observedRequests: unknown[] = [];
    pair.requests.on("data", (chunk: Buffer) => {
      const frame = chunk.toString("utf8");
      expect(frame.endsWith("\n")).toBe(true);
      const request = JSON.parse(frame.slice(0, -1)) as {
        readonly requestId: string;
        readonly faultCase: E3CampaignConformanceFaultCaseV1;
        readonly registrarServiceId: string;
        readonly namespace: string;
        readonly faultControlId: string;
        readonly faultPlanId: string;
        readonly faultKeyId: string;
      };
      expect(`${canonicalJson(request as unknown as JsonValue)}\n`).toBe(frame);
      observedRequests.push(request);
      const receipt = faultReceipt(request.faultCase, {
        requestId: request.requestId,
        serviceId: request.registrarServiceId,
        namespace: request.namespace,
        faultControlId: request.faultControlId,
        faultPlanId: request.faultPlanId,
        faultKeyId: request.faultKeyId,
      });
      pair.responses.write(
        `${canonicalJson({
          schemaId: E3_CONFORMANCE_FAULT_CONTROL_RESPONSE_SCHEMA_ID_V1,
          schemaVersion: 1,
          requestId: request.requestId,
          status: "completed",
          receipt,
        } as unknown as JsonValue)}\n`,
      );
    });
    const port = createE3CampaignConformanceFaultControlDuplexPortV1({
      channel: pair.channel,
      responseTimeoutMs: 1_000,
    });

    for (const faultCase of [
      "registrar_unreachable",
      "transparency_log_unavailable",
    ] as const) {
      await expect(
        port.runFaultCase(faultControlRequest(faultCase)),
      ).resolves.toMatchObject({ faultCase });
    }
    expect(observedRequests).toHaveLength(2);
  });

  it("fails closed on noncanonical, oversized, and missing fault-control responses", async () => {
    for (const responseMode of [
      "noncanonical",
      "oversized",
      "missing",
    ] as const) {
      const pair = faultControlDuplexPair();
      pair.requests.once("data", (chunk: Buffer) => {
        if (responseMode === "missing") return;
        if (responseMode === "oversized") {
          pair.responses.write("x".repeat(129));
          return;
        }
        const request = JSON.parse(chunk.toString("utf8")) as {
          readonly requestId: string;
        };
        pair.responses.write(
          `${JSON.stringify(
            {
              schemaId: E3_CONFORMANCE_FAULT_CONTROL_RESPONSE_SCHEMA_ID_V1,
              schemaVersion: 1,
              requestId: request.requestId,
              status: "completed",
              receipt: faultReceipt("registrar_unreachable", {
                requestId: request.requestId,
                serviceId: "registrar.fault-test",
                namespace: "chronorift/e3/fault-test",
                faultControlId: "fault-control.test",
                faultPlanId: digest("e"),
                faultKeyId,
              }),
            },
            undefined,
            2,
          )}\n`,
        );
      });
      const port = createE3CampaignConformanceFaultControlDuplexPortV1({
        channel: pair.channel,
        responseTimeoutMs: 10,
        maximumResponseBytes: responseMode === "oversized" ? 128 : 64 * 1024,
      });
      await expect(
        port.runFaultCase(faultControlRequest("registrar_unreachable")),
      ).rejects.toMatchObject({ code: "live_dependency_unavailable" });
    }
  });

  it("only observes a real unavailable response and binds the identical retry to the signed closure count", async () => {
    const entry = unsignedEntry({
      campaignId: digest("a"),
      assignmentId: digest("b"),
      ordinal: 2,
      previousHash: digest("c"),
      eventKind: "conformance_actor_started",
      actorKeyId: digest("d"),
      payload: { leaseId: "lease:test", startedAt: timestamp },
    });
    const request = {
      method: "POST" as const,
      path: "/e3/v1/events:compare-and-append",
      body: entry as unknown as JsonValue,
      actorCapability: "opaque-actor-capability",
    };
    const observedRequests: (typeof request)[] = [];
    const actualUnavailable = new E3RegistrarError(
      "unavailable",
      "upstream response ended after commit",
    );
    const expectedResponse = { appendReceipt: "retained" };
    const observation = new E3ResponseLossObservationTransportV1({
      request: (input) => {
        observedRequests.push(input as typeof request);
        return observedRequests.length === 1
          ? Promise.reject(actualUnavailable)
          : Promise.resolve(expectedResponse);
      },
    });

    await expect(observation.request(request)).rejects.toBe(actualUnavailable);
    await expect(observation.request(structuredClone(request))).resolves.toBe(
      expectedResponse,
    );
    expect(observedRequests).toHaveLength(2);
    expect(() => observation.assertObservedAndBoundToClosure(1)).not.toThrow();
    expect(() => observation.assertObservedAndBoundToClosure(0)).toThrow(
      /signed closure replay count/u,
    );

    const noLoss = new E3ResponseLossObservationTransportV1({
      request: () => Promise.resolve(expectedResponse),
    });
    await expect(noLoss.request(request)).rejects.toThrow(
      /no external response loss was observed/u,
    );
  });

  it("registers before its no-op actor, retains Host cleanup, and emits only zero-run evidence", async () => {
    const built = await fixture();
    let validatedPath: string | undefined;
    const result = await runE3CampaignConformanceV1(built.preflight, {
      registrar: built.registrar,
      closureEvidence: {
        awaitClosedEvidence: () => Promise.resolve(built.closedEvidence()),
      },
      now: () => new Date(timestamp),
      validateEvidence: (path) => {
        validatedPath = path;
        return Promise.resolve("[chronorift-e3-campaign] offline-validator\n");
      },
    });

    expect(result.primaryOutcome).toBe("conformance_complete");
    expect(result.summary).toMatchObject({
      campaignPurpose: "registrar_conformance",
      claimEligible: false,
      modelCalls: 0,
      evaluatorRuns: 0,
      artifactSinkMode: "configured_external_ci_artifact_directory_v1",
      artifactSinkId: "ci-artifacts.test",
      artifactSinkCommitment: built.preflight.manifest.artifactSinkCommitment,
      assignmentCount: 1,
      eventCount: 5,
      appendAttemptCount: 12,
      rejectionCount: 6,
      idempotentReplayCount: 1,
      revisionCount: 0,
      latestKnownEventCount: 5,
    });
    expect(built.observedCapabilities).toEqual([
      "registration-capability-test",
      ...Array.from({ length: 8 }, () => "actor-append-capability-test"),
    ]);
    expect(validatedPath).toMatch(/\.pending$/u);
    expect(result.evidencePath).toBe(
      join(built.preflight.evidenceDirectory, E3_CONFORMANCE_EVIDENCE_FILE_V1),
    );
    const evidence = JSON.parse(
      await readFile(result.evidencePath, "utf8"),
    ) as {
      readonly journal: {
        readonly events: readonly {
          readonly event: { readonly eventKind: string };
        }[];
      };
    };
    expect(evidence.journal.events.map(({ event }) => event.eventKind)).toEqual(
      [
        "registrar_assignment_registered",
        "conformance_actor_started",
        "conformance_actor_finished",
        "conformance_cleanup_proven",
        "registrar_primary_closed",
      ],
    );
    const serialized = await readFile(result.evidencePath, "utf8");
    expect(serialized).not.toContain("registration-capability-test");
    expect(serialized).not.toContain("actor-append-capability-test");
  });

  it("does not publish success evidence when registrar or closure publication becomes unavailable", async () => {
    const registrarFailure = await fixture();
    const unavailableRegistrar: E3RegistrarPortV1 = {
      ...registrarFailure.registrar,
      appendEvent: () =>
        Promise.reject(
          new E3RegistrarError("unavailable", "registrar unavailable"),
        ),
    };
    await expect(
      runE3CampaignConformanceV1(registrarFailure.preflight, {
        registrar: unavailableRegistrar,
        closureEvidence: {
          awaitClosedEvidence: () =>
            Promise.resolve(registrarFailure.closedEvidence()),
        },
        now: () => new Date(timestamp),
      }),
    ).rejects.toThrow(/unavailable/u);
    expect(await readdir(registrarFailure.preflight.evidenceDirectory)).toEqual(
      [],
    );

    const publicationFailure = await fixture();
    await expect(
      runE3CampaignConformanceV1(publicationFailure.preflight, {
        registrar: publicationFailure.registrar,
        closureEvidence: {
          awaitClosedEvidence: () =>
            Promise.reject(new Error("transparency log unavailable")),
        },
        now: () => new Date(timestamp),
      }),
    ).rejects.toThrow(/transparency log unavailable/u);
    expect(
      await readdir(publicationFailure.preflight.evidenceDirectory),
    ).toEqual([]);
  });

  it("runs all three live cases before publishing one success artifact", async () => {
    const complete = await fixture();
    const incomplete = await fixture({
      evidenceDirectory: complete.preflight.evidenceDirectory,
      assignmentCharacter: "c",
      capabilitySuffix: "-incomplete",
      sharedPreflight: complete.preflight,
      caseId: "deadline_incomplete",
    });
    const cleanupUnproven = await fixture({
      evidenceDirectory: complete.preflight.evidenceDirectory,
      assignmentCharacter: "d",
      capabilitySuffix: "-cleanup",
      sharedPreflight: complete.preflight,
      caseId: "deadline_cleanup_unproven_with_late_cleanup",
    });
    const observedFaults: E3CampaignConformanceFaultCaseV1[] = [];
    const mutationPaths: string[] = [];
    const result = await runPreparedE3CampaignLiveSuiteV1({
      faultControl: faultControl(observedFaults),
      deadlineIncomplete: {
        preflight: incomplete.preflight,
        registrar: incomplete.registrar,
        closureEvidence: {
          awaitClosedEvidence: () =>
            Promise.resolve(incomplete.closedEvidence("incomplete_unknown")),
        },
        now: () => new Date(timestamp),
      },
      deadlineCleanupUnproven: {
        preflight: cleanupUnproven.preflight,
        registrar: cleanupUnproven.registrar,
        closureEvidence: {
          awaitClosedEvidence: () =>
            Promise.resolve(cleanupUnproven.closedEvidence("cleanup_unproven")),
        },
        now: () => new Date(timestamp),
      },
      earlyComplete: {
        preflight: complete.preflight,
        registrar: complete.registrar,
        closureEvidence: {
          awaitClosedEvidence: () =>
            Promise.resolve(complete.closedEvidence("conformance_complete")),
        },
        now: () => new Date(timestamp),
        validateEvidence: () => Promise.resolve("validated\n"),
        assertEvidenceRejected: (path) => {
          mutationPaths.push(path);
          return Promise.resolve();
        },
      },
    });

    expect(
      result.cases.map(({ caseId, primaryOutcome, revisionCount }) => ({
        caseId,
        primaryOutcome,
        revisionCount,
      })),
    ).toEqual([
      {
        caseId: "early_complete",
        primaryOutcome: "conformance_complete",
        revisionCount: 0,
      },
      {
        caseId: "deadline_incomplete",
        primaryOutcome: "incomplete_unknown",
        revisionCount: 0,
      },
      {
        caseId: "deadline_cleanup_unproven_with_late_cleanup",
        primaryOutcome: "cleanup_unproven",
        revisionCount: 1,
      },
    ]);
    expect(await readdir(complete.preflight.evidenceDirectory)).toEqual([
      E3_CONFORMANCE_EVIDENCE_FILE_V1,
    ]);
    expect(observedFaults).toEqual([
      "registrar_unreachable",
      "transparency_log_unavailable",
    ]);
    expect(
      mutationPaths.map((path) => path.split(".mutation-").at(-1)),
    ).toEqual(["journal", "signature", "inclusion", "consistency"]);
    const suiteEvidence = JSON.parse(
      await readFile(result.evidencePath, "utf8"),
    ) as {
      readonly faultControlPolicySha256: string;
      readonly cases: readonly {
        readonly caseId: string;
        readonly evidence: {
          readonly primaryClosure: { primaryOutcome: string };
        };
      }[];
      readonly faultReceipts: readonly {
        readonly faultCase: string;
        readonly faultKeyId: string;
        readonly signature: string;
      }[];
      readonly summary: { readonly faultControlPolicySha256: string };
    };
    expect(suiteEvidence.faultControlPolicySha256).toBe(
      complete.preflight.faultControlPolicySha256,
    );
    expect(suiteEvidence.summary.faultControlPolicySha256).toBe(
      suiteEvidence.faultControlPolicySha256,
    );
    expect(
      suiteEvidence.cases.map(({ caseId, evidence }) => [
        caseId,
        evidence.primaryClosure.primaryOutcome,
      ]),
    ).toEqual([
      ["early_complete", "conformance_complete"],
      ["deadline_incomplete", "incomplete_unknown"],
      ["deadline_cleanup_unproven_with_late_cleanup", "cleanup_unproven"],
    ]);
    expect(
      suiteEvidence.faultReceipts.map(({ faultCase }) => faultCase),
    ).toEqual(["registrar_unreachable", "transparency_log_unavailable"]);
    expect(
      suiteEvidence.faultReceipts.every(
        (receipt) =>
          receipt.faultKeyId === faultKeyId && receipt.signature.length === 86,
      ),
    ).toBe(true);
  });

  it("publishes nothing when a prerequisite deadline case fails", async () => {
    const complete = await fixture();
    const incomplete = await fixture({
      evidenceDirectory: complete.preflight.evidenceDirectory,
      assignmentCharacter: "c",
      capabilitySuffix: "-incomplete",
      sharedPreflight: complete.preflight,
      caseId: "deadline_incomplete",
    });
    const cleanupUnproven = await fixture({
      evidenceDirectory: complete.preflight.evidenceDirectory,
      assignmentCharacter: "d",
      capabilitySuffix: "-cleanup",
      sharedPreflight: complete.preflight,
      caseId: "deadline_cleanup_unproven_with_late_cleanup",
    });
    await expect(
      runPreparedE3CampaignLiveSuiteV1({
        faultControl: faultControl(),
        deadlineIncomplete: {
          preflight: incomplete.preflight,
          registrar: incomplete.registrar,
          closureEvidence: {
            awaitClosedEvidence: () =>
              Promise.reject(new Error("deadline closure unavailable")),
          },
          now: () => new Date(timestamp),
        },
        deadlineCleanupUnproven: {
          preflight: cleanupUnproven.preflight,
          registrar: cleanupUnproven.registrar,
          closureEvidence: {
            awaitClosedEvidence: () =>
              Promise.resolve(
                cleanupUnproven.closedEvidence("cleanup_unproven"),
              ),
          },
          now: () => new Date(timestamp),
        },
        earlyComplete: {
          preflight: complete.preflight,
          registrar: complete.registrar,
          closureEvidence: {
            awaitClosedEvidence: () =>
              Promise.resolve(complete.closedEvidence()),
          },
          now: () => new Date(timestamp),
          validateEvidence: () => Promise.resolve("validated\n"),
        },
      }),
    ).rejects.toThrow(/deadline closure unavailable/u);
    expect(await readdir(complete.preflight.evidenceDirectory)).toEqual([]);

    const mutationComplete = await fixture();
    const mutationIncomplete = await fixture({
      evidenceDirectory: mutationComplete.preflight.evidenceDirectory,
      assignmentCharacter: "c",
      capabilitySuffix: "-incomplete",
      sharedPreflight: mutationComplete.preflight,
      caseId: "deadline_incomplete",
    });
    const mutationCleanup = await fixture({
      evidenceDirectory: mutationComplete.preflight.evidenceDirectory,
      assignmentCharacter: "d",
      capabilitySuffix: "-cleanup",
      sharedPreflight: mutationComplete.preflight,
      caseId: "deadline_cleanup_unproven_with_late_cleanup",
    });
    await expect(
      runPreparedE3CampaignLiveSuiteV1({
        faultControl: faultControl(),
        deadlineIncomplete: {
          preflight: mutationIncomplete.preflight,
          registrar: mutationIncomplete.registrar,
          closureEvidence: {
            awaitClosedEvidence: () =>
              Promise.resolve(
                mutationIncomplete.closedEvidence("incomplete_unknown"),
              ),
          },
          now: () => new Date(timestamp),
        },
        deadlineCleanupUnproven: {
          preflight: mutationCleanup.preflight,
          registrar: mutationCleanup.registrar,
          closureEvidence: {
            awaitClosedEvidence: () =>
              Promise.resolve(
                mutationCleanup.closedEvidence("cleanup_unproven"),
              ),
          },
          now: () => new Date(timestamp),
        },
        earlyComplete: {
          preflight: mutationComplete.preflight,
          registrar: mutationComplete.registrar,
          closureEvidence: {
            awaitClosedEvidence: () =>
              Promise.resolve(mutationComplete.closedEvidence()),
          },
          now: () => new Date(timestamp),
          validateEvidence: () => Promise.resolve("validated\n"),
          assertEvidenceRejected: () =>
            Promise.reject(new Error("mutated evidence was accepted")),
        },
      }),
    ).rejects.toThrow(/mutated evidence was accepted/u);
    expect(
      await readdir(mutationComplete.preflight.evidenceDirectory),
    ).not.toContain(E3_CONFORMANCE_EVIDENCE_FILE_V1);
  });

  it("fails closed before touching repository inputs on the wrong Node version", async () => {
    await expect(
      preflightE3CampaignLiveV1({
        nodeVersion: "26.5.0",
        repositoryRoot: process.cwd(),
        environment: {},
      }),
    ).rejects.toMatchObject({
      name: "E3ConformanceRunnerError",
      code: "preflight_failed",
    } satisfies Partial<E3ConformanceRunnerError>);
  });

  it("rejects a configured artifact sink commitment mismatch during preflight validation", () => {
    const binding = {
      artifactSinkMode: "configured_external_ci_artifact_directory_v1",
      artifactSinkId: "ci-artifacts.test",
      namespace: "chronorift/e3/test",
      leaseId: "lease:test",
      canonicalAbsolutePath: "/ci/artifacts/e3",
      evidenceFileName: E3_CONFORMANCE_EVIDENCE_FILE_V1,
    } as const;
    const artifactSinkCommitment = artifactSinkCommitmentV1(binding);

    expect(() =>
      verifyConfiguredArtifactSinkBindingV1({
        ...binding,
        artifactSinkCommitment,
      }),
    ).not.toThrow();
    expect(() =>
      verifyConfiguredArtifactSinkBindingV1({
        ...binding,
        artifactSinkCommitment: digest("f"),
      }),
    ).toThrow(/artifact sink/u);
  });

  it("requires registrar signing keys to cover publication after deadline", async () => {
    const built = await fixture();
    expect(() =>
      verifyRegistrarRoleKeyCoverageV1({
        trustRoot: built.preflight.trustRoot,
        service: built.preflight.service,
        now: new Date(timestamp),
        deadline,
      }),
    ).not.toThrow();
    expect(() =>
      verifyRegistrarRoleKeyCoverageV1({
        trustRoot: built.preflight.trustRoot,
        service: {
          ...built.preflight.service,
          logKey: {
            ...built.preflight.service.logKey,
            validUntil: "2026-08-11T00:05:10.000Z",
          },
        },
        now: new Date(timestamp),
        deadline,
      }),
    ).toThrow(/log key does not cover/u);
  });

  it("rejects provider credentials and loader injection before repository I/O", async () => {
    for (const environment of [
      { OPENAI_API_KEY: "forbidden" },
      { NODE_OPTIONS: "--import=/tmp/forbidden.mjs" },
    ]) {
      await expect(
        preflightE3CampaignLiveV1({
          nodeVersion: "22.23.1",
          platform: "linux",
          repositoryRoot: process.cwd(),
          environment,
        }),
      ).rejects.toMatchObject({
        code: "preflight_failed",
      });
    }
  });

  it("does not register when the external Host closure-evidence port is absent", async () => {
    const built = await fixture();
    await expect(
      runPreparedE3CampaignLiveV1({ preflight: built.preflight }),
    ).rejects.toMatchObject({
      code: "live_dependency_unavailable",
    });
    expect(built.observedCapabilities).toEqual([]);
  });

  it("waits for the required late-cleanup revision after primary publication", async () => {
    const built = await fixture({
      caseId: "deadline_cleanup_unproven_with_late_cleanup",
    });
    const registration = await built.registrar.registerCampaign({
      manifest: built.preflight.manifest,
      actorCapability: built.preflight.registrationCapability,
    });
    const retained = built.closedEvidence("cleanup_unproven");
    const completeSnapshot = {
      schemaId: E3_SCHEMA_IDS_V1.closedEvidenceSnapshot,
      schemaVersion: 1 as const,
      campaignId: asSha256DigestV1(registration.campaignId),
      assignmentId: asSha256DigestV1(registration.assignmentId),
      ...retained,
      appendReceipts: [...retained.appendReceipts],
      revisions: [...retained.revisions],
      revisionReceipts: [...retained.revisionReceipts],
    };
    const zeroRevisionSnapshot = {
      ...completeSnapshot,
      revisions: [],
      revisionReceipts: [],
      revisionJournalCheckpoint: {
        ...completeSnapshot.revisionJournalCheckpoint,
        revisionHead: null,
        revisionCount: 0,
        latestKnownEventCount: completeSnapshot.journal.eventCount,
        commitSequence: completeSnapshot.appendReceipts.at(-1)!.commitSequence,
      },
    };
    let reads = 0;
    const registrar: E3RegistrarPortV1 = {
      ...built.registrar,
      readClosedEvidence: () =>
        Promise.resolve(
          reads++ === 0 ? zeroRevisionSnapshot : completeSnapshot,
        ),
    };
    const evidence = await createRegistrarClosureEvidencePortV1(registrar, {
      minimumRevisionCount: 1,
    }).awaitClosedEvidence({
      manifest: {
        ...built.preflight.manifest,
        deadline: new Date(Date.now() + 60_000).toISOString(),
      },
      campaignId: registration.campaignId,
      assignmentId: registration.assignmentId,
      knownAppendReceipts: [registration.receipt],
    });
    expect(reads).toBe(2);
    expect(evidence.revisions).toHaveLength(1);
  });

  it("keeps the completed matrix entry fail-closed before external root release", async () => {
    await expect(runE3CampaignLiveFromEnvironmentV1()).rejects.toMatchObject({
      code: "preflight_failed",
    });
  });

  it("fails before repository I/O while the external trust-root pin is unpublished", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "chronorift-e3-repo-"));
    roots.push(repositoryRoot);
    const runnerPath = join(
      repositoryRoot,
      E3_CONFORMANCE_RUNNER_RELATIVE_PATH_V1,
    );
    const validatorPath = join(
      repositoryRoot,
      E3_CONFORMANCE_VALIDATOR_RELATIVE_PATH_V1,
    );
    await Promise.all([
      mkdir(join(runnerPath, ".."), { recursive: true }),
      mkdir(join(validatorPath, ".."), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(runnerPath, "runner\n", "utf8"),
      writeFile(validatorPath, "validator\n", "utf8"),
    ]);
    await expect(
      preflightE3CampaignLiveV1({
        nodeVersion: "22.23.1",
        repositoryRoot,
        environment: {},
      }),
    ).rejects.toThrow(/trust-root pin has not been published/u);
  });
});
