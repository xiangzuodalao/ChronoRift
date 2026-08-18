import { describe, expect, it } from "vitest";

import {
  E3CampaignManifestV1Schema,
  E3EventEnvelopeV1Schema,
  E3LateAppendRequestV1Schema,
  E3LateAppendResultV1Schema,
  E3PrimaryClosureV1Schema,
  E3PublicPendingStatusV1Schema,
  E3RegistrarTrustRootV1Schema,
  E3RevisionJournalCheckpointV1Schema,
  E3SanitizedSummaryV1Schema,
  E3_EVENT_PAYLOAD_SCHEMA_IDS_V1,
  E3_SCHEMA_IDS_V1,
} from "./contracts.js";

const digest = (character: string): string => character.repeat(64);
const signature = "A".repeat(86);
const timestamp = "2026-08-11T00:00:00.000Z";
const publicKeyPem =
  "-----BEGIN PUBLIC KEY-----\nQQ==\n-----END PUBLIC KEY-----\n";

const roleKey = (character: string) => ({
  keyId: digest(character),
  publicKeyPem,
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: "2027-01-01T00:00:00.000Z",
});

const trustRoot = () => ({
  schemaId: E3_SCHEMA_IDS_V1.trustRoot,
  schemaVersion: 1,
  trustRootVersion: "test-v1",
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: "2027-01-01T00:00:00.000Z",
  signatureThreshold: 2,
  rootKeys: [
    { keyId: digest("1"), publicKeyPem },
    { keyId: digest("2"), publicKeyPem },
  ],
  services: [
    {
      serviceId: "registrar.test",
      hostname: "registrar.test",
      port: 443,
      basePath: "/e3/v1",
      caCertificatePem: "test-ca",
      tlsSpkiSha256: digest("3"),
      namespaces: ["chronorift/e3/test"],
      receiptKey: roleKey("4"),
      clockKey: roleKey("5"),
      closureKey: roleKey("6"),
      logKey: roleKey("7"),
    },
  ],
  signatures: [
    { keyId: digest("1"), signature },
    { keyId: digest("2"), signature },
  ],
});

const manifest = () => ({
  schemaId: E3_SCHEMA_IDS_V1.campaignManifest,
  schemaVersion: 1,
  campaignPurpose: "registrar_conformance",
  claimEligible: false,
  modelCalls: 0,
  evaluatorRuns: 0,
  artifactSinkMode: "configured_external_ci_artifact_directory_v1",
  artifactSinkId: "sink.test",
  artifactSinkCommitment: digest("7"),
  namespace: "chronorift/e3/test",
  registrarServiceId: "registrar.test",
  trustRootVersion: "test-v1",
  productSha256: digest("1"),
  runnerSha256: digest("2"),
  validatorSha256: digest("3"),
  deadline: timestamp,
  assignmentCount: 1,
  assignments: [
    {
      slotOrdinal: 0,
      assignmentCommitment: digest("4"),
      conformanceActorKeyId: digest("5"),
      cleanupActorKeyId: digest("6"),
    },
  ],
});

const event = () => ({
  schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
  schemaVersion: 1,
  campaignId: digest("1"),
  assignmentId: digest("2"),
  eventId: digest("3"),
  ordinal: 1,
  previousHash: null,
  actorRole: "registrar",
  actorKeyId: digest("4"),
  eventKind: "registrar_assignment_registered",
  payloadSchemaId:
    E3_EVENT_PAYLOAD_SCHEMA_IDS_V1.registrar_assignment_registered,
  payloadHash: digest("5"),
  signature,
});

describe("E3.1 strict contracts", () => {
  it("freezes N=1 synthetic campaigns with zero model and evaluator claims", () => {
    expect(E3CampaignManifestV1Schema.safeParse(manifest()).success).toBe(true);
    for (const mutation of [
      { assignmentCount: 2 },
      { claimEligible: true },
      { modelCalls: 1 },
      { evaluatorRuns: 1 },
      { artifactSinkMode: "unbound" },
      { artifactSinkCommitment: "not-a-digest" },
    ]) {
      expect(
        E3CampaignManifestV1Schema.safeParse({ ...manifest(), ...mutation })
          .success,
      ).toBe(false);
    }
  });

  it("rejects unknown fields and event ACL or payload-schema mismatches", () => {
    expect(
      E3CampaignManifestV1Schema.safeParse({ ...manifest(), unexpected: true })
        .success,
    ).toBe(false);
    expect(
      E3EventEnvelopeV1Schema.safeParse({ ...event(), unexpected: true })
        .success,
    ).toBe(false);
    expect(
      E3EventEnvelopeV1Schema.safeParse({
        ...event(),
        actorRole: "conformance_actor",
      }).success,
    ).toBe(false);
    expect(
      E3EventEnvelopeV1Schema.safeParse({
        ...event(),
        payloadSchemaId:
          E3_EVENT_PAYLOAD_SCHEMA_IDS_V1.conformance_actor_started,
      }).success,
    ).toBe(false);
  });

  it("requires global separation between threshold and online role keys", () => {
    const valid = trustRoot();
    expect(E3RegistrarTrustRootV1Schema.safeParse(valid).success).toBe(true);
    expect(
      E3RegistrarTrustRootV1Schema.safeParse({
        ...valid,
        services: [
          {
            ...valid.services[0],
            receiptKey: {
              ...valid.services[0]!.receiptKey,
              keyId: valid.rootKeys[0]!.keyId,
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("strictly binds pending-status closure identity to its state", () => {
    const status = {
      schemaId: E3_SCHEMA_IDS_V1.publicPendingStatus,
      schemaVersion: 1,
      campaignId: digest("1"),
      deadline: timestamp,
      journalHead: digest("2"),
      state: "open",
      closureHash: null,
      observedAt: timestamp,
      registrarServiceId: "registrar.test",
      clockKeyId: digest("3"),
      clockSignature: signature,
      closureKeyId: digest("4"),
      signature,
    };
    expect(E3PublicPendingStatusV1Schema.safeParse(status).success).toBe(true);
    expect(
      E3PublicPendingStatusV1Schema.safeParse({ ...status, unknown: true })
        .success,
    ).toBe(false);
    expect(
      E3PublicPendingStatusV1Schema.safeParse({
        ...status,
        closureHash: digest("5"),
      }).success,
    ).toBe(false);
    expect(
      E3PublicPendingStatusV1Schema.safeParse({
        ...status,
        state: "closure_sealed_publication_pending",
      }).success,
    ).toBe(false);
    expect(
      E3PublicPendingStatusV1Schema.safeParse({
        ...status,
        state: "closure_published",
        closureHash: digest("5"),
      }).success,
    ).toBe(true);
  });

  it("permits only the sealed-publication-pending primary closure state", () => {
    const closure = {
      schemaId: E3_SCHEMA_IDS_V1.primaryClosure,
      schemaVersion: 1,
      campaignId: digest("1"),
      closureHash: digest("2"),
      journalHead: digest("3"),
      deadline: timestamp,
      closedAt: timestamp,
      primaryOutcome: "conformance_complete",
      assignmentCount: 1,
      outcomeCounts: {
        conformanceComplete: 1,
        incompleteUnknown: 0,
        cleanupUnproven: 0,
      },
      eventCount: 5,
      appendAttemptCount: 11,
      rejectionCount: 5,
      idempotentReplayCount: 1,
      publicationState: "closure_sealed_publication_pending",
      claimEligible: false,
      modelCalls: 0,
      evaluatorRuns: 0,
      clockKeyId: digest("4"),
      clockSignature: signature,
      closureKeyId: digest("5"),
      signature,
    };
    expect(E3PrimaryClosureV1Schema.safeParse(closure).success).toBe(true);
    expect(
      E3PrimaryClosureV1Schema.safeParse({
        ...closure,
        publicationState: "closure_published",
      }).success,
    ).toBe(false);
    expect(
      E3PrimaryClosureV1Schema.safeParse({
        ...closure,
        assignmentCount: 2,
      }).success,
    ).toBe(false);
  });

  it("keeps late append input actor-owned and registrar wrapper output-only", () => {
    const payload = { leaseId: "lease:test", startedAt: timestamp };
    const lateEntry = {
      event: {
        ...event(),
        assignmentId: digest("2"),
        ordinal: 2,
        previousHash: digest("9"),
        actorRole: "conformance_actor",
        actorKeyId: digest("6"),
        eventKind: "conformance_actor_started",
        payloadSchemaId:
          E3_EVENT_PAYLOAD_SCHEMA_IDS_V1.conformance_actor_started,
      },
      payload,
    };
    const request = {
      schemaId: E3_SCHEMA_IDS_V1.lateAppendRequest,
      schemaVersion: 1,
      campaignId: digest("1"),
      lateEntry,
    };
    expect(E3LateAppendRequestV1Schema.safeParse(request).success).toBe(true);
    expect(
      E3LateAppendRequestV1Schema.safeParse({
        ...request,
        closureHash: digest("a"),
      }).success,
    ).toBe(false);
    expect(
      E3LateAppendRequestV1Schema.safeParse({
        ...request,
        lateEntry: { event: event(), payload: {} },
      }).success,
    ).toBe(false);

    const revision = {
      schemaId: E3_SCHEMA_IDS_V1.revisionEnvelope,
      schemaVersion: 1,
      campaignId: request.campaignId,
      primaryClosureHash: digest("a"),
      revisionId: digest("b"),
      revisionOrdinal: 1,
      previousRevisionHash: digest("a"),
      lateEntry,
      receivedAt: timestamp,
      registrarKeyId: digest("c"),
      signature,
    };
    const receipt = {
      schemaId: E3_SCHEMA_IDS_V1.appendReceipt,
      schemaVersion: 1,
      campaignId: request.campaignId,
      assignmentId: lateEntry.event.assignmentId,
      eventId: revision.revisionId,
      eventHash: digest("d"),
      journalHead: digest("d"),
      ordinal: 1,
      commitSequence: 6,
      committedAt: timestamp,
      registrarServiceId: "registrar.test",
      receiptKeyId: digest("e"),
      signature,
    };
    const result = {
      schemaId: E3_SCHEMA_IDS_V1.lateAppendResult,
      schemaVersion: 1,
      campaignId: request.campaignId,
      revision,
      receipt,
    };
    expect(E3LateAppendResultV1Schema.safeParse(result).success).toBe(true);
    expect(
      E3LateAppendResultV1Schema.safeParse({
        ...result,
        revision: {
          ...revision,
          previousRevisionHash: digest("f"),
        },
      }).success,
    ).toBe(false);
    expect(
      E3LateAppendResultV1Schema.safeParse({
        ...result,
        receipt: { ...receipt, eventId: digest("f") },
      }).success,
    ).toBe(false);
  });

  it("requires a signed revision checkpoint head for every non-empty chain", () => {
    const checkpoint = {
      schemaId: E3_SCHEMA_IDS_V1.revisionJournalCheckpoint,
      schemaVersion: 1,
      campaignId: digest("1"),
      primaryClosureHash: digest("2"),
      revisionHead: null,
      revisionCount: 0,
      latestKnownEventCount: 5,
      commitSequence: 5,
      asOf: timestamp,
      registrarServiceId: "registrar.test",
      closureKeyId: digest("3"),
      signature,
    };
    expect(
      E3RevisionJournalCheckpointV1Schema.safeParse(checkpoint).success,
    ).toBe(true);
    expect(
      E3RevisionJournalCheckpointV1Schema.safeParse({
        ...checkpoint,
        revisionCount: 1,
      }).success,
    ).toBe(false);
    expect(
      E3RevisionJournalCheckpointV1Schema.safeParse({
        ...checkpoint,
        revisionHead: digest("4"),
      }).success,
    ).toBe(false);
  });

  it("rejects a success summary that claims model or evaluator activity", () => {
    const summary = {
      schemaId: E3_SCHEMA_IDS_V1.sanitizedSummary,
      schemaVersion: 1,
      capability: "campaign_denominator_conformance",
      campaignPurpose: "registrar_conformance",
      viewKind: "latest_known",
      publicationState: "closure_published",
      claimEligible: false,
      modelCalls: 0,
      evaluatorRuns: 0,
      artifactSinkMode: "configured_external_ci_artifact_directory_v1",
      artifactSinkId: "sink.test",
      artifactSinkCommitment: digest("7"),
      productSha256: digest("1"),
      runnerSha256: digest("2"),
      validatorSha256: digest("3"),
      trustRootVersion: "test-v1",
      trustRootFileSha256: digest("0"),
      trustRootFreezeRecordSha256: digest("a"),
      trustRootExternalPinSha256: digest("0"),
      registrarServiceId: "registrar.test",
      tlsSpkiId: digest("4"),
      registrarKeyIds: {
        receipt: digest("5"),
        clock: digest("6"),
        closure: digest("7"),
        log: digest("8"),
      },
      actorKeyIds: {
        conformance: digest("9"),
        cleanup: digest("a"),
      },
      campaignId: digest("6"),
      assignmentIds: [digest("a")],
      assignmentCount: 1,
      eventCount: 5,
      appendAttemptCount: 11,
      idempotentReplayCount: 1,
      revisionCount: 0,
      latestKnownEventCount: 5,
      rejectionCount: 5,
      closureCount: 1,
      primaryOutcome: "conformance_complete",
      outcomeCounts: {
        conformanceComplete: 1,
        incompleteUnknown: 0,
        cleanupUnproven: 0,
      },
      journalHead: digest("b"),
      closureHash: digest("c"),
      deadline: timestamp,
      closedAt: timestamp,
      cleanupReceiptHash: digest("9"),
      revisionCheckpointHash: digest("a"),
      registrationCheckpointRoot: digest("1"),
      registrationCheckpointTreeSize: 1,
      registrationCheckpointIssuedAt: timestamp,
      checkpointRoot: digest("d"),
      checkpointTreeSize: 2,
      checkpointIssuedAt: timestamp,
      registrationInclusionProofHash: digest("0"),
      inclusionProofHash: digest("e"),
      consistencyProofHash: digest("f"),
    };
    expect(E3SanitizedSummaryV1Schema.safeParse(summary).success).toBe(true);
    expect(
      E3SanitizedSummaryV1Schema.safeParse({ ...summary, modelCalls: 1 })
        .success,
    ).toBe(false);
    expect(
      E3SanitizedSummaryV1Schema.safeParse({ ...summary, evaluatorRuns: 1 })
        .success,
    ).toBe(false);
    expect(
      E3SanitizedSummaryV1Schema.safeParse({
        ...summary,
        actorKeyIds: {
          ...summary.actorKeyIds,
          conformance: summary.registrarKeyIds.receipt,
        },
      }).success,
    ).toBe(false);
    expect(
      E3SanitizedSummaryV1Schema.safeParse({
        ...summary,
        assignmentCount: 2,
        assignmentIds: [summary.assignmentIds[0], digest("0")],
      }).success,
    ).toBe(false);
  });
});
