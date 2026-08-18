import { generateKeyPairSync, type KeyObject } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { asSha256DigestV1, type JsonValue } from "@chronorift/domain";

import {
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
  signCanonicalJsonV1,
} from "./canonical.js";
import {
  E3_EVENT_ACTOR_ACL_V1,
  E3_EVENT_PAYLOAD_SCHEMA_IDS_V1,
  E3_SCHEMA_IDS_V1,
  type E3AppendReceiptV1,
  type E3CampaignManifestV1,
  type E3JournalEntryV1,
  type E3JournalV1,
  type E3EventKindV1,
  type E3LateAppendResultV1,
  type E3PrimaryClosureV1,
  type E3PublicationProofV1,
  type E3PublicPendingStatusV1,
  type E3RegistrarServiceBindingV1,
  type E3RegistrarTrustRootV1,
  type E3RevisionEnvelopeV1,
  type E3TransparencyCheckpointV1,
} from "./contracts.js";
import { E3ResponseLossObservationTransportV1 } from "./conformance-runner.js";
import {
  E3RegistrarClientV1,
  canonicalRegistrarTransportRequestBytesV1,
  createPinnedHttpsTransportV1,
  parseStrictRegistrarJsonV1,
  serviceFromTrustRootV1,
  verifyTrustRootV1,
  type E3StrictJsonTransportV1,
} from "./registrar-client.js";
import { eventHashV1, revisionHashV1 } from "./projector.js";
import { E3RegistrarError } from "./registrar-port.js";

const at = "2026-08-11T00:00:00.000Z";
const deadline = "2026-08-11T00:10:00.000Z";
const validFrom = "2026-08-10T00:00:00.000Z";
const validUntil = "2026-08-12T00:00:00.000Z";
const digest = (character: string) => asSha256DigestV1(character.repeat(64));
type Digest = ReturnType<typeof digest>;

interface SigningKeyFixture {
  readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
  readonly keyId: ReturnType<typeof ed25519KeyIdV1>;
}

const signingKey = (): SigningKeyFixture => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKeyPem: publicKey
      .export({ type: "spki", format: "pem" })
      .toString("utf8"),
    keyId: ed25519KeyIdV1(publicKey),
  };
};

const roleKey = (key: SigningKeyFixture) => ({
  keyId: key.keyId,
  publicKeyPem: key.publicKeyPem,
  validFrom,
  validUntil,
});

const trustFixture = (): {
  readonly root: E3RegistrarTrustRootV1;
  readonly service: E3RegistrarServiceBindingV1;
  readonly receipt: SigningKeyFixture;
  readonly clock: SigningKeyFixture;
  readonly closure: SigningKeyFixture;
  readonly log: SigningKeyFixture;
} => {
  const firstRoot = signingKey();
  const secondRoot = signingKey();
  const receipt = signingKey();
  const clock = signingKey();
  const closure = signingKey();
  const log = signingKey();
  const service: E3RegistrarServiceBindingV1 = {
    serviceId: "registrar.test",
    hostname: "registrar.test.invalid",
    port: 443,
    basePath: "/e3/v1",
    caCertificatePem: "test-only-ca",
    tlsSpkiSha256: digest("1"),
    namespaces: ["chronorift/e3/test"],
    receiptKey: roleKey(receipt),
    clockKey: roleKey(clock),
    closureKey: roleKey(closure),
    logKey: roleKey(log),
  };
  const basis = {
    schemaId: E3_SCHEMA_IDS_V1.trustRoot,
    schemaVersion: 1 as const,
    trustRootVersion: "test-v1",
    validFrom,
    validUntil,
    signatureThreshold: 2,
    rootKeys: [
      { keyId: firstRoot.keyId, publicKeyPem: firstRoot.publicKeyPem },
      { keyId: secondRoot.keyId, publicKeyPem: secondRoot.publicKeyPem },
    ],
    services: [service],
  };
  const root: E3RegistrarTrustRootV1 = {
    ...basis,
    signatures: [firstRoot, secondRoot].map((key) => ({
      keyId: key.keyId,
      signature: signCanonicalJsonV1({
        privateKey: key.privateKey,
        domain: "chronorift-e3-trust-root-v1",
        schemaId: E3_SCHEMA_IDS_V1.trustRoot,
        version: 1,
        value: basis as unknown as JsonValue,
      }),
    })),
  };
  return { root, service, receipt, clock, closure, log };
};

const manifestFixture = (service: E3RegistrarServiceBindingV1) =>
  ({
    schemaId: E3_SCHEMA_IDS_V1.campaignManifest,
    schemaVersion: 1,
    campaignPurpose: "registrar_conformance",
    claimEligible: false,
    modelCalls: 0,
    evaluatorRuns: 0,
    artifactSinkMode: "configured_external_ci_artifact_directory_v1",
    artifactSinkId: "sink.test",
    artifactSinkCommitment: digest("f"),
    namespace: service.namespaces[0]!,
    registrarServiceId: service.serviceId,
    trustRootVersion: "test-v1",
    productSha256: digest("2"),
    runnerSha256: digest("3"),
    validatorSha256: digest("4"),
    deadline,
    assignmentCount: 1 as const,
    assignments: [
      {
        assignmentCommitment: digest("5"),
        cleanupActorKeyId: digest("6"),
        conformanceActorKeyId: digest("7"),
        slotOrdinal: 0,
      },
    ],
  }) satisfies E3CampaignManifestV1;

const signedReceipt = (input: {
  readonly key: SigningKeyFixture;
  readonly service: E3RegistrarServiceBindingV1;
  readonly campaignId: Digest;
  readonly assignmentId: Digest;
  readonly eventId: Digest;
  readonly eventHash: Digest;
  readonly ordinal: number;
  readonly commitSequence?: number;
  readonly committedAt?: string;
}): E3AppendReceiptV1 => {
  const basis = {
    schemaId: E3_SCHEMA_IDS_V1.appendReceipt,
    schemaVersion: 1 as const,
    campaignId: input.campaignId,
    assignmentId: input.assignmentId,
    eventId: input.eventId,
    eventHash: input.eventHash,
    journalHead: input.eventHash,
    ordinal: input.ordinal,
    commitSequence: input.commitSequence ?? input.ordinal,
    committedAt: input.committedAt ?? at,
    registrarServiceId: input.service.serviceId,
    receiptKeyId: input.key.keyId,
  };
  return {
    ...basis,
    signature: signCanonicalJsonV1({
      privateKey: input.key.privateKey,
      domain: "chronorift-e3-append-receipt-v1",
      schemaId: E3_SCHEMA_IDS_V1.appendReceipt,
      version: 1,
      value: basis as unknown as JsonValue,
    }),
  };
};

const signedRevision = (input: {
  readonly key: SigningKeyFixture;
  readonly campaignId: Digest;
  readonly primaryClosureHash: Digest;
  readonly lateEntry: E3JournalEntryV1;
  readonly receivedAt: string;
}): E3RevisionEnvelopeV1 => {
  const basis = {
    schemaId: E3_SCHEMA_IDS_V1.revisionEnvelope,
    schemaVersion: 1 as const,
    campaignId: input.campaignId,
    primaryClosureHash: input.primaryClosureHash,
    revisionId: revisionIdV1({
      campaignId: input.campaignId,
      primaryClosureHash: input.primaryClosureHash,
      revisionOrdinal: 1,
      previousRevisionHash: input.primaryClosureHash,
      lateEventId: input.lateEntry.event.eventId,
    }),
    revisionOrdinal: 1,
    previousRevisionHash: input.primaryClosureHash,
    lateEntry: input.lateEntry,
    receivedAt: input.receivedAt,
    registrarKeyId: input.key.keyId,
  };
  return {
    ...basis,
    signature: signCanonicalJsonV1({
      privateKey: input.key.privateKey,
      domain: "chronorift-e3-revision-envelope-v1",
      schemaId: E3_SCHEMA_IDS_V1.revisionEnvelope,
      version: 1,
      value: basis as unknown as JsonValue,
    }),
  };
};

const signedPrimaryClosure = (input: {
  readonly fixture: ReturnType<typeof trustFixture>;
  readonly campaignId: Digest;
  readonly journalHead: Digest;
  readonly closedAt: string;
}): E3PrimaryClosureV1 => {
  const clockBasis = {
    campaignId: input.campaignId,
    journalHead: input.journalHead,
    deadline,
    closedAt: input.closedAt,
    primaryOutcome: "cleanup_unproven" as const,
  };
  const closureHashBasis = {
    schemaId: E3_SCHEMA_IDS_V1.primaryClosure,
    schemaVersion: 1 as const,
    ...clockBasis,
    assignmentCount: 1 as const,
    outcomeCounts: {
      conformanceComplete: 0,
      incompleteUnknown: 0,
      cleanupUnproven: 1,
    },
    eventCount: 5,
    appendAttemptCount: 5,
    rejectionCount: 0,
    idempotentReplayCount: 0,
    publicationState: "closure_sealed_publication_pending" as const,
    claimEligible: false as const,
    modelCalls: 0 as const,
    evaluatorRuns: 0 as const,
    clockKeyId: input.fixture.clock.keyId,
    clockSignature: signCanonicalJsonV1({
      privateKey: input.fixture.clock.privateKey,
      domain: "chronorift-e3-clock-v1",
      schemaId: E3_SCHEMA_IDS_V1.primaryClosure,
      version: 1,
      value: clockBasis as unknown as JsonValue,
    }),
    closureKeyId: input.fixture.closure.keyId,
  };
  const closureHash = canonicalContentHashV1(
    closureHashBasis as unknown as JsonValue,
  );
  const closureBasis = { ...closureHashBasis, closureHash };
  return {
    ...closureBasis,
    signature: signCanonicalJsonV1({
      privateKey: input.fixture.closure.privateKey,
      domain: "chronorift-e3-primary-closure-v1",
      schemaId: E3_SCHEMA_IDS_V1.primaryClosure,
      version: 1,
      value: closureBasis as unknown as JsonValue,
    }),
  };
};

const signedCheckpoint = (input: {
  readonly key: SigningKeyFixture;
  readonly rootHash: Digest;
  readonly treeSize: number;
  readonly issuedAt?: string;
}): E3TransparencyCheckpointV1 => {
  const basis = {
    logId: "log.test",
    treeSize: input.treeSize,
    rootHash: input.rootHash,
    issuedAt: input.issuedAt ?? at,
    logKeyId: input.key.keyId,
  };
  return {
    ...basis,
    signature: signCanonicalJsonV1({
      privateKey: input.key.privateKey,
      domain: "chronorift-e3-transparency-checkpoint-v1",
      schemaId: "chronorift.e3.transparency-checkpoint",
      version: 1,
      value: basis as unknown as JsonValue,
    }),
  };
};

const signedPendingStatus = (input: {
  readonly fixture: ReturnType<typeof trustFixture>;
  readonly campaignId: Digest;
  readonly state?: E3PublicPendingStatusV1["state"];
  readonly closureHash?: Digest | null;
}): E3PublicPendingStatusV1 => {
  const state = input.state ?? "closure_sealed_publication_pending";
  const closureHash = input.closureHash ?? digest("b");
  const clockBasis = {
    campaignId: input.campaignId,
    deadline,
    observedAt: at,
  };
  const statusBasis = {
    schemaId: E3_SCHEMA_IDS_V1.publicPendingStatus,
    schemaVersion: 1 as const,
    campaignId: input.campaignId,
    deadline,
    journalHead: digest("a"),
    state,
    closureHash,
    observedAt: at,
    registrarServiceId: input.fixture.service.serviceId,
    clockKeyId: input.fixture.clock.keyId,
    clockSignature: signCanonicalJsonV1({
      privateKey: input.fixture.clock.privateKey,
      domain: "chronorift-e3-pending-status-clock-v1",
      schemaId: E3_SCHEMA_IDS_V1.publicPendingStatus,
      version: 1,
      value: clockBasis,
    }),
    closureKeyId: input.fixture.closure.keyId,
  };
  return {
    ...statusBasis,
    signature: signCanonicalJsonV1({
      privateKey: input.fixture.closure.privateKey,
      domain: "chronorift-e3-pending-status-v1",
      schemaId: E3_SCHEMA_IDS_V1.publicPendingStatus,
      version: 1,
      value: statusBasis,
    }),
  };
};

describe("E3.1 strict registrar client", () => {
  it("rejects ambiguous or structurally unbounded JSON before parsing", () => {
    expect(parseStrictRegistrarJsonV1(Buffer.from('{"a":1}', "utf8"))).toEqual({
      a: 1,
    });
    expect(() =>
      parseStrictRegistrarJsonV1(Buffer.from('{"a":1,"a":2}', "utf8")),
    ).toThrow(/duplicate key/u);
    expect(() =>
      parseStrictRegistrarJsonV1(Buffer.from('{"a":1}null', "utf8")),
    ).toThrow(/trailing data/u);
    expect(() =>
      parseStrictRegistrarJsonV1(Buffer.from(`\uFEFF{"a":1}`, "utf8")),
    ).toThrow(/BOM/u);
    expect(() =>
      parseStrictRegistrarJsonV1(
        Buffer.from(`${"[".repeat(42)}0${"]".repeat(42)}`, "utf8"),
      ),
    ).toThrow(/structural bounds/u);
  });

  it("requires a current threshold-signed root and pinned service namespace", () => {
    const fixture = trustFixture();
    expect(
      verifyTrustRootV1({
        trustRoot: fixture.root,
        now: new Date(at),
      }),
    ).toEqual(fixture.root);
    expect(
      serviceFromTrustRootV1({
        trustRoot: fixture.root,
        serviceId: fixture.service.serviceId,
        namespace: fixture.service.namespaces[0]!,
        now: new Date(at),
      }),
    ).toEqual(fixture.service);

    const corrupted = structuredClone(fixture.root);
    corrupted.services[0]!.clockKey.keyId = digest("f");
    expect(() =>
      verifyTrustRootV1({ trustRoot: corrupted, now: new Date(at) }),
    ).toThrow(/mismatched identity/u);
    expect(() =>
      verifyTrustRootV1({
        trustRoot: { ...fixture.root, signatureThreshold: 1 },
        now: new Date(at),
      }),
    ).toThrow();
    expect(() =>
      serviceFromTrustRootV1({
        trustRoot: fixture.root,
        serviceId: fixture.service.serviceId,
        namespace: "unauthorized/namespace",
        now: new Date(at),
      }),
    ).toThrow(/not authorized/u);
  });

  it("reads the fixed public pending-status endpoint and verifies both signatures", async () => {
    const fixture = trustFixture();
    const campaignId = digest("a");
    const status = signedPendingStatus({ fixture, campaignId });
    const request = vi.fn(async () => status);
    await expect(
      new E3RegistrarClientV1(
        fixture.service.namespaces[0]!,
        { request },
        fixture.service,
      ).readPendingStatus({ campaignId }),
    ).resolves.toEqual(status);
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: `/namespaces/${encodeURIComponent(fixture.service.namespaces[0]!)}/campaigns/${campaignId}/pending-status`,
    });

    const badClockSignature = {
      ...status,
      clockSignature: `${status.clockSignature.slice(0, -1)}${
        status.clockSignature.endsWith("A") ? "B" : "A"
      }`,
    };
    await expect(
      new E3RegistrarClientV1(
        fixture.service.namespaces[0]!,
        { request: async () => badClockSignature },
        fixture.service,
      ).readPendingStatus({ campaignId }),
    ).rejects.toThrow(/signature is invalid/u);

    const changedHead = { ...status, journalHead: digest("c") };
    await expect(
      new E3RegistrarClientV1(
        fixture.service.namespaces[0]!,
        { request: async () => changedHead },
        fixture.service,
      ).readPendingStatus({ campaignId }),
    ).rejects.toThrow(/signature is invalid/u);
  });

  it("verifies registration identity, receipt, and pre-release log inclusion", async () => {
    const fixture = trustFixture();
    const manifest = manifestFixture(fixture.service);
    const campaignId = campaignIdV1(manifest as unknown as JsonValue);
    const slot = manifest.assignments[0];
    const assignmentId = assignmentIdV1({
      campaignId,
      slotOrdinal: slot.slotOrdinal,
      assignmentCommitment: slot.assignmentCommitment,
    });
    const registrationLeaf = campaignRegistrationLeafBytesV1({
      campaignId,
      deadline: manifest.deadline,
    });
    const rootHash = merkleLeafHashV1(registrationLeaf);
    const checkpoint = signedCheckpoint({
      key: fixture.log,
      rootHash,
      treeSize: 1,
    });
    const receipt = signedReceipt({
      key: fixture.receipt,
      service: fixture.service,
      campaignId,
      assignmentId,
      eventId: digest("8"),
      eventHash: digest("9"),
      ordinal: 1,
    });
    const request = vi.fn(async () => ({
      campaignId,
      assignmentId,
      receipt,
      registrationProof: {
        schemaId: E3_SCHEMA_IDS_V1.registrationProof,
        schemaVersion: 1,
        campaignId,
        checkpoint,
        inclusionProof: { leafIndex: 0, treeSize: 1, auditPath: [] },
      },
    }));
    const client = new E3RegistrarClientV1(
      manifest.namespace,
      { request } satisfies E3StrictJsonTransportV1,
      fixture.service,
    );

    await expect(
      client.registerCampaign({ manifest, actorCapability: "secret" }),
    ).resolves.toMatchObject({ campaignId, assignmentId });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "PUT", actorCapability: "secret" }),
    );

    const corruptedTransport: E3StrictJsonTransportV1 = {
      request: async () => ({
        campaignId,
        assignmentId,
        receipt,
        registrationProof: {
          schemaId: E3_SCHEMA_IDS_V1.registrationProof,
          schemaVersion: 1,
          campaignId,
          checkpoint: { ...checkpoint, rootHash: digest("a") },
          inclusionProof: { leafIndex: 0, treeSize: 1, auditPath: [] },
        },
      }),
    };
    await expect(
      new E3RegistrarClientV1(
        manifest.namespace,
        corruptedTransport,
        fixture.service,
      ).registerCampaign({ manifest, actorCapability: "secret" }),
    ).rejects.toThrow(/checkpoint signature/u);
  });

  it("latches an unresolved registration across changed manifests and appends", async () => {
    const fixture = trustFixture();
    const manifest = manifestFixture(fixture.service);
    const campaignId = campaignIdV1(manifest as unknown as JsonValue);
    const slot = manifest.assignments[0];
    const assignmentId = assignmentIdV1({
      campaignId,
      slotOrdinal: slot.slotOrdinal,
      assignmentCommitment: slot.assignmentCommitment,
    });
    const checkpoint = signedCheckpoint({
      key: fixture.log,
      rootHash: merkleLeafHashV1(
        campaignRegistrationLeafBytesV1({
          campaignId,
          deadline: manifest.deadline,
        }),
      ),
      treeSize: 1,
    });
    const registrationReceipt = signedReceipt({
      key: fixture.receipt,
      service: fixture.service,
      campaignId,
      assignmentId,
      eventId: digest("8"),
      eventHash: digest("9"),
      ordinal: 1,
    });
    const registration = {
      campaignId,
      assignmentId,
      receipt: registrationReceipt,
      registrationProof: {
        schemaId: E3_SCHEMA_IDS_V1.registrationProof,
        schemaVersion: 1 as const,
        campaignId,
        checkpoint,
        inclusionProof: { leafIndex: 0, treeSize: 1, auditPath: [] },
      },
    };
    const payload = { leaseId: "lease:test", startedAt: at };
    const payloadHash = canonicalContentHashV1(payload);
    const entry: E3JournalEntryV1 = {
      event: {
        schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
        schemaVersion: 1,
        campaignId,
        assignmentId,
        eventId: eventIdV1({
          campaignId,
          assignmentId,
          ordinal: 2,
          previousHash: registrationReceipt.eventHash,
          eventKind: "conformance_actor_started",
          payloadHash,
        }),
        ordinal: 2,
        previousHash: registrationReceipt.eventHash,
        actorRole: "conformance_actor",
        actorKeyId: slot.conformanceActorKeyId,
        eventKind: "conformance_actor_started",
        payloadSchemaId:
          E3_EVENT_PAYLOAD_SCHEMA_IDS_V1.conformance_actor_started,
        payloadHash,
        signature: "A".repeat(86),
      },
      payload,
    };
    const appendReceipt = signedReceipt({
      key: fixture.receipt,
      service: fixture.service,
      campaignId,
      assignmentId,
      eventId: entry.event.eventId,
      eventHash: eventHashV1(entry),
      ordinal: 2,
    });
    const transport = vi
      .fn<E3StrictJsonTransportV1["request"]>()
      .mockRejectedValueOnce(
        new E3RegistrarError(
          "unavailable",
          "registration response remained unknown",
        ),
      )
      .mockRejectedValueOnce(
        new E3RegistrarError(
          "unavailable",
          "registration response remained unknown",
        ),
      )
      .mockResolvedValueOnce(registration)
      .mockResolvedValueOnce(appendReceipt);
    const client = new E3RegistrarClientV1(
      fixture.service.namespaces[0]!,
      { request: transport },
      fixture.service,
    );

    await expect(
      client.registerCampaign({
        manifest,
        actorCapability: "registration-capability",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    const changedManifest: E3CampaignManifestV1 = {
      ...manifest,
      productSha256: digest("f"),
    };
    await expect(
      client.registerCampaign({
        manifest: changedManifest,
        actorCapability: "registration-capability",
      }),
    ).rejects.toThrow(/registration remains unresolved.*changed manifest/u);
    await expect(
      client.appendEvent({
        campaignId,
        entry,
        actorCapability: "actor-capability",
      }),
    ).rejects.toThrow(/registration remains unresolved.*append is forbidden/u);
    expect(transport).toHaveBeenCalledTimes(2);

    await expect(
      client.registerCampaign({
        manifest: structuredClone(manifest),
        actorCapability: "registration-capability",
      }),
    ).resolves.toEqual(registration);
    await expect(
      client.appendEvent({
        campaignId,
        entry,
        actorCapability: "actor-capability",
      }),
    ).resolves.toEqual(appendReceipt);
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("recomputes submitted events and verifies the exact signed append receipt", async () => {
    const fixture = trustFixture();
    const payload = { leaseId: "lease:test", startedAt: at };
    const campaignId = digest("a");
    const assignmentId = digest("b");
    const payloadHash = canonicalContentHashV1(payload);
    const eventId = eventIdV1({
      campaignId,
      assignmentId,
      ordinal: 2,
      previousHash: digest("c"),
      eventKind: "conformance_actor_started",
      payloadHash,
    });
    const entry: E3JournalEntryV1 = {
      event: {
        schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
        schemaVersion: 1,
        campaignId,
        assignmentId,
        eventId,
        ordinal: 2,
        previousHash: digest("c"),
        actorRole: "conformance_actor",
        actorKeyId: digest("d"),
        eventKind: "conformance_actor_started",
        payloadSchemaId:
          E3_EVENT_PAYLOAD_SCHEMA_IDS_V1.conformance_actor_started,
        payloadHash,
        signature: "A".repeat(86),
      },
      payload,
    };
    const eventHash = eventHashV1(entry);
    const receipt = signedReceipt({
      key: fixture.receipt,
      service: fixture.service,
      campaignId,
      assignmentId,
      eventId,
      eventHash,
      ordinal: 2,
    });
    const client = new E3RegistrarClientV1(
      fixture.service.namespaces[0]!,
      { request: async () => receipt },
      fixture.service,
    );
    await expect(
      client.appendEvent({ campaignId, entry, actorCapability: "secret" }),
    ).resolves.toEqual(receipt);

    const responseLost = vi
      .fn<E3StrictJsonTransportV1["request"]>()
      .mockRejectedValueOnce(
        new E3RegistrarError("unavailable", "response lost after commit"),
      )
      .mockResolvedValueOnce(receipt);
    const responseLossObservation = new E3ResponseLossObservationTransportV1({
      request: responseLost,
    });
    await expect(
      new E3RegistrarClientV1(
        fixture.service.namespaces[0]!,
        responseLossObservation,
        fixture.service,
      ).appendEvent({ campaignId, entry, actorCapability: "secret" }),
    ).resolves.toEqual(receipt);
    expect(responseLost).toHaveBeenCalledTimes(2);
    expect(
      canonicalRegistrarTransportRequestBytesV1(
        responseLost.mock.calls[0]![0],
      ).equals(
        canonicalRegistrarTransportRequestBytesV1(
          responseLost.mock.calls[1]![0],
        ),
      ),
    ).toBe(true);
    expect(() =>
      responseLossObservation.assertObservedAndBoundToClosure(1),
    ).not.toThrow();

    const changed = {
      ...structuredClone(entry),
      payload: { ...payload, startedAt: "2026-08-11T00:00:01.000Z" },
    } as E3JournalEntryV1;
    await expect(
      client.appendEvent({
        campaignId,
        entry: changed,
        actorCapability: "secret",
      }),
    ).rejects.toThrow(/not canonical/u);

    const badSignature = `${receipt.signature.slice(0, -1)}${
      receipt.signature.endsWith("A") ? "B" : "A"
    }`;
    await expect(
      new E3RegistrarClientV1(
        fixture.service.namespaces[0]!,
        { request: async () => ({ ...receipt, signature: badSignature }) },
        fixture.service,
      ).appendEvent({ campaignId, entry, actorCapability: "secret" }),
    ).rejects.toThrow(/signature is invalid/u);

    const invalidThenValid = vi
      .fn<E3StrictJsonTransportV1["request"]>()
      .mockResolvedValueOnce({ ...receipt, signature: badSignature })
      .mockResolvedValueOnce(receipt);
    const latchedClient = new E3RegistrarClientV1(
      fixture.service.namespaces[0]!,
      { request: invalidThenValid },
      fixture.service,
    );
    await expect(
      latchedClient.appendEvent({
        campaignId,
        entry,
        actorCapability: "secret",
      }),
    ).rejects.toThrow(/signature is invalid/u);
    await expect(
      latchedClient.appendEvent({
        campaignId,
        entry,
        actorCapability: "different-secret",
      }),
    ).rejects.toThrow(/different request.*byte-identical/u);
    expect(invalidThenValid).toHaveBeenCalledTimes(1);
    await expect(
      latchedClient.appendEvent({
        campaignId,
        entry: structuredClone(entry),
        actorCapability: "secret",
      }),
    ).resolves.toEqual(receipt);
  });

  it("latches an unresolved append until the byte-identical request resolves", async () => {
    const fixture = trustFixture();
    const campaignId = digest("a");
    const assignmentId = digest("b");
    const startedPayload = { leaseId: "lease:test", startedAt: at };
    const startedPayloadHash = canonicalContentHashV1(startedPayload);
    const startedEntry: E3JournalEntryV1 = {
      event: {
        schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
        schemaVersion: 1,
        campaignId,
        assignmentId,
        eventId: eventIdV1({
          campaignId,
          assignmentId,
          ordinal: 2,
          previousHash: digest("c"),
          eventKind: "conformance_actor_started",
          payloadHash: startedPayloadHash,
        }),
        ordinal: 2,
        previousHash: digest("c"),
        actorRole: "conformance_actor",
        actorKeyId: digest("d"),
        eventKind: "conformance_actor_started",
        payloadSchemaId:
          E3_EVENT_PAYLOAD_SCHEMA_IDS_V1.conformance_actor_started,
        payloadHash: startedPayloadHash,
        signature: "A".repeat(86),
      },
      payload: startedPayload,
    };
    const startedReceipt = signedReceipt({
      key: fixture.receipt,
      service: fixture.service,
      campaignId,
      assignmentId,
      eventId: startedEntry.event.eventId,
      eventHash: eventHashV1(startedEntry),
      ordinal: 2,
    });
    const finishedPayload = {
      leaseId: "lease:test",
      finishedAt: "2026-08-11T00:00:01.000Z",
    };
    const finishedPayloadHash = canonicalContentHashV1(finishedPayload);
    const finishedEntry: E3JournalEntryV1 = {
      event: {
        schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
        schemaVersion: 1,
        campaignId,
        assignmentId,
        eventId: eventIdV1({
          campaignId,
          assignmentId,
          ordinal: 3,
          previousHash: eventHashV1(startedEntry),
          eventKind: "conformance_actor_finished",
          payloadHash: finishedPayloadHash,
        }),
        ordinal: 3,
        previousHash: eventHashV1(startedEntry),
        actorRole: "conformance_actor",
        actorKeyId: digest("d"),
        eventKind: "conformance_actor_finished",
        payloadSchemaId:
          E3_EVENT_PAYLOAD_SCHEMA_IDS_V1.conformance_actor_finished,
        payloadHash: finishedPayloadHash,
        signature: "A".repeat(86),
      },
      payload: finishedPayload,
    };
    const finishedReceipt = signedReceipt({
      key: fixture.receipt,
      service: fixture.service,
      campaignId,
      assignmentId,
      eventId: finishedEntry.event.eventId,
      eventHash: eventHashV1(finishedEntry),
      ordinal: 3,
    });
    const transport = vi
      .fn<E3StrictJsonTransportV1["request"]>()
      .mockRejectedValueOnce(
        new E3RegistrarError("unavailable", "response remained unknown"),
      )
      .mockRejectedValueOnce(
        new E3RegistrarError("unavailable", "response remained unknown"),
      )
      .mockResolvedValueOnce(startedReceipt)
      .mockResolvedValueOnce(finishedReceipt);
    const client = new E3RegistrarClientV1(
      fixture.service.namespaces[0]!,
      { request: transport },
      fixture.service,
    );

    await expect(
      client.appendEvent({
        campaignId,
        entry: startedEntry,
        actorCapability: "actor-capability",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(transport).toHaveBeenCalledTimes(2);

    await expect(
      client.appendEvent({
        campaignId,
        entry: startedEntry,
        actorCapability: "changed-capability",
      }),
    ).rejects.toThrow(/different request.*byte-identical/u);
    await expect(
      client.appendEvent({
        campaignId,
        entry: finishedEntry,
        actorCapability: "actor-capability",
      }),
    ).rejects.toThrow(/higher-ordinal request.*byte-identical/u);
    expect(transport).toHaveBeenCalledTimes(2);

    await expect(
      client.appendEvent({
        campaignId,
        entry: structuredClone(startedEntry),
        actorCapability: "actor-capability",
      }),
    ).resolves.toEqual(startedReceipt);
    await expect(
      client.appendEvent({
        campaignId,
        entry: finishedEntry,
        actorCapability: "actor-capability",
      }),
    ).resolves.toEqual(finishedReceipt);
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("releases an unresolved append only after a definitive rejection", async () => {
    const fixture = trustFixture();
    const campaignId = digest("a");
    const assignmentId = digest("b");
    const payload = { leaseId: "lease:test", startedAt: at };
    const payloadHash = canonicalContentHashV1(payload);
    const entry: E3JournalEntryV1 = {
      event: {
        schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
        schemaVersion: 1,
        campaignId,
        assignmentId,
        eventId: eventIdV1({
          campaignId,
          assignmentId,
          ordinal: 2,
          previousHash: digest("c"),
          eventKind: "conformance_actor_started",
          payloadHash,
        }),
        ordinal: 2,
        previousHash: digest("c"),
        actorRole: "conformance_actor",
        actorKeyId: digest("d"),
        eventKind: "conformance_actor_started",
        payloadSchemaId:
          E3_EVENT_PAYLOAD_SCHEMA_IDS_V1.conformance_actor_started,
        payloadHash,
        signature: "A".repeat(86),
      },
      payload,
    };
    const transport = vi
      .fn<E3StrictJsonTransportV1["request"]>()
      .mockRejectedValueOnce(
        new E3RegistrarError("unavailable", "response remained unknown"),
      )
      .mockRejectedValueOnce(
        new E3RegistrarError("unavailable", "response remained unknown"),
      )
      .mockRejectedValueOnce(
        new E3RegistrarError("conflict", "definitive server rejection"),
      )
      .mockRejectedValueOnce(
        new E3RegistrarError("unavailable", "new request reached transport"),
      )
      .mockRejectedValueOnce(
        new E3RegistrarError("unavailable", "new request reached transport"),
      );
    const client = new E3RegistrarClientV1(
      fixture.service.namespaces[0]!,
      { request: transport },
      fixture.service,
    );
    const append = (actorCapability: string) =>
      client.appendEvent({ campaignId, entry, actorCapability });

    await expect(append("actor-capability")).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(append("actor-capability")).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(append("replacement-capability")).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(transport).toHaveBeenCalledTimes(5);
  });

  it("submits only raw late actor bytes and verifies the registrar-created revision", async () => {
    const fixture = trustFixture();
    const campaignId = digest("a");
    const assignmentId = digest("b");
    const payload = {
      leaseId: "lease:test",
      observedAt: at,
      processesEmpty: true as const,
      cgroupEmpty: true as const,
      storageEmpty: true as const,
      networkLeaseClosed: true as const,
      credentialLeaseRevoked: true as const,
      observationCoverage: "complete" as const,
    };
    const payloadHash = canonicalContentHashV1(payload);
    const lateEventId = eventIdV1({
      campaignId,
      assignmentId,
      ordinal: 4,
      previousHash: digest("c"),
      eventKind: "conformance_cleanup_proven",
      payloadHash,
    });
    const lateEntry: E3JournalEntryV1 = {
      event: {
        schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
        schemaVersion: 1,
        campaignId,
        assignmentId,
        eventId: lateEventId,
        ordinal: 4,
        previousHash: digest("c"),
        actorRole: "cleanup_actor",
        actorKeyId: digest("d"),
        eventKind: "conformance_cleanup_proven",
        payloadSchemaId:
          E3_EVENT_PAYLOAD_SCHEMA_IDS_V1.conformance_cleanup_proven,
        payloadHash,
        signature: "A".repeat(86),
      },
      payload,
    };
    const closure = signedPrimaryClosure({
      fixture,
      campaignId,
      journalHead: digest("e"),
      closedAt: "2026-08-11T00:01:00.000Z",
    });
    const revision = signedRevision({
      key: fixture.receipt,
      campaignId,
      primaryClosureHash: closure.closureHash,
      lateEntry,
      // This preserves the producer's arrival observation. It need not be
      // rewritten to the later primary closure time.
      receivedAt: at,
    });
    const receipt = signedReceipt({
      key: fixture.receipt,
      service: fixture.service,
      campaignId,
      assignmentId,
      eventId: revision.revisionId,
      eventHash: revisionHashV1(revision),
      ordinal: revision.revisionOrdinal,
      commitSequence: 6,
      committedAt: "2026-08-11T00:02:00.000Z",
    });
    const result: E3LateAppendResultV1 = {
      schemaId: E3_SCHEMA_IDS_V1.lateAppendResult,
      schemaVersion: 1,
      campaignId,
      revision,
      receipt,
    };
    const transport = vi
      .fn<E3StrictJsonTransportV1["request"]>()
      .mockRejectedValueOnce(
        new E3RegistrarError("unavailable", "response lost after commit"),
      )
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce(closure);
    const client = new E3RegistrarClientV1(
      fixture.service.namespaces[0]!,
      { request: transport },
      fixture.service,
    );

    await expect(
      client.appendRevision({
        campaignId,
        lateEntry,
        actorCapability: "cleanup-only-capability",
      }),
    ).resolves.toEqual(result);
    expect(transport).toHaveBeenCalledTimes(3);
    const firstRequest = transport.mock.calls[0]![0];
    const retriedRequest = transport.mock.calls[1]![0];
    expect(firstRequest.path).toMatch(/late-events:compare-and-append$/u);
    expect(firstRequest.body).toEqual({
      schemaId: E3_SCHEMA_IDS_V1.lateAppendRequest,
      schemaVersion: 1,
      campaignId,
      lateEntry,
    });
    expect(firstRequest.body).not.toHaveProperty("primaryClosureHash");
    expect(firstRequest.body).not.toHaveProperty("revisionId");
    expect(firstRequest.body).not.toHaveProperty("registrarKeyId");
    expect(canonicalContentHashV1(firstRequest.body!)).toBe(
      canonicalContentHashV1(retriedRequest.body!),
    );
    expect(transport.mock.calls[2]![0].path).toMatch(/primary-closure$/u);

    const preClosureReceipt = signedReceipt({
      key: fixture.receipt,
      service: fixture.service,
      campaignId,
      assignmentId,
      eventId: revision.revisionId,
      eventHash: revisionHashV1(revision),
      ordinal: revision.revisionOrdinal,
      commitSequence: 6,
      committedAt: "2026-08-11T00:00:30.000Z",
    });
    const preClosureTransport = vi
      .fn<E3StrictJsonTransportV1["request"]>()
      .mockResolvedValueOnce({ ...result, receipt: preClosureReceipt })
      .mockResolvedValueOnce(closure);
    await expect(
      new E3RegistrarClientV1(
        fixture.service.namespaces[0]!,
        { request: preClosureTransport },
        fixture.service,
      ).appendRevision({
        campaignId,
        lateEntry,
        actorCapability: "cleanup-only-capability",
      }),
    ).rejects.toThrow(/does not occur after/u);

    const changedLateEntryResult = {
      ...result,
      revision: {
        ...result.revision,
        lateEntry: {
          ...result.revision.lateEntry,
          payload: {
            ...payload,
            observedAt: "2026-08-11T00:00:01.000Z",
          },
        },
      },
    };
    await expect(
      new E3RegistrarClientV1(
        fixture.service.namespaces[0]!,
        { request: async () => changedLateEntryResult },
        fixture.service,
      ).appendRevision({
        campaignId,
        lateEntry,
        actorCapability: "cleanup-only-capability",
      }),
    ).rejects.toThrow(/does not preserve/u);

    const unresolvedTransport = vi
      .fn<E3StrictJsonTransportV1["request"]>()
      .mockResolvedValueOnce(result)
      .mockRejectedValueOnce(
        new E3RegistrarError(
          "unavailable",
          "contextual primary closure read failed",
        ),
      )
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce(closure);
    const unresolvedClient = new E3RegistrarClientV1(
      fixture.service.namespaces[0]!,
      { request: unresolvedTransport },
      fixture.service,
    );
    await expect(
      unresolvedClient.appendRevision({
        campaignId,
        lateEntry,
        actorCapability: "cleanup-only-capability",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      unresolvedClient.appendRevision({
        campaignId,
        lateEntry,
        actorCapability: "changed-cleanup-capability",
      }),
    ).rejects.toThrow(/different request.*byte-identical/u);
    expect(unresolvedTransport).toHaveBeenCalledTimes(2);
    await expect(
      unresolvedClient.appendRevision({
        campaignId,
        lateEntry: structuredClone(lateEntry),
        actorCapability: "cleanup-only-capability",
      }),
    ).resolves.toEqual(result);
    expect(unresolvedTransport).toHaveBeenCalledTimes(4);
  });

  it("verifies closure inclusion and registration-to-closure consistency", async () => {
    const fixture = trustFixture();
    const campaignId = digest("a");
    const closureHash = digest("b");
    const registrationLeafHash = merkleLeafHashV1(
      Buffer.from("registration", "utf8"),
    );
    const closureLeafHash = merkleLeafHashV1(
      closurePublicationLeafBytesV1({ campaignId, closureHash }),
    );
    const closureRoot = merkleNodeHashV1(registrationLeafHash, closureLeafHash);
    const registrationCheckpoint = signedCheckpoint({
      key: fixture.log,
      rootHash: registrationLeafHash,
      treeSize: 1,
    });
    const closureCheckpoint = signedCheckpoint({
      key: fixture.log,
      rootHash: closureRoot,
      treeSize: 2,
      issuedAt: "2026-08-11T00:01:00.000Z",
    });
    const proof: E3PublicationProofV1 = {
      schemaId: E3_SCHEMA_IDS_V1.publicationProof,
      schemaVersion: 1,
      campaignId,
      closureHash,
      registrationCheckpoint,
      closureCheckpoint,
      closureInclusionProof: {
        leafIndex: 1,
        treeSize: 2,
        auditPath: [registrationLeafHash],
      },
      registrationToClosureConsistencyProof: {
        firstTreeSize: 1,
        secondTreeSize: 2,
        auditPath: [closureLeafHash],
      },
    };
    const client = new E3RegistrarClientV1(
      fixture.service.namespaces[0]!,
      { request: async () => proof },
      fixture.service,
    );
    await expect(
      client.readPublicationProof({ campaignId, closureHash }),
    ).resolves.toEqual(proof);

    await expect(
      new E3RegistrarClientV1(
        fixture.service.namespaces[0]!,
        {
          request: async () => ({
            ...proof,
            closureInclusionProof: {
              ...proof.closureInclusionProof,
              auditPath: [digest("f")],
            },
          }),
        },
        fixture.service,
      ).readPublicationProof({ campaignId, closureHash }),
    ).rejects.toThrow(/inclusion or consistency/u);

    await expect(
      new E3RegistrarClientV1(
        fixture.service.namespaces[0]!,
        {
          request: async () => ({
            ...proof,
            closureCheckpoint: registrationCheckpoint,
            closureInclusionProof: {
              leafIndex: 0,
              treeSize: 1,
              auditPath: [],
            },
            registrationToClosureConsistencyProof: {
              firstTreeSize: 1,
              secondTreeSize: 1,
              auditPath: [],
            },
          }),
        },
        fixture.service,
      ).readPublicationProof({ campaignId, closureHash }),
    ).rejects.toThrow(/advance beyond/u);
  });

  it("requires closed-snapshot checkpoints to bracket actor and closure commits", async () => {
    const fixture = trustFixture();
    const manifest = manifestFixture(fixture.service);
    const campaignId = campaignIdV1(manifest as unknown as JsonValue);
    const slot = manifest.assignments[0];
    const assignmentId = assignmentIdV1({
      campaignId,
      slotOrdinal: slot.slotOrdinal,
      assignmentCommitment: slot.assignmentCommitment,
    });
    const events: E3JournalEntryV1[] = [];
    const append = (
      eventKind: E3EventKindV1,
      payload: JsonValue,
      actorKeyId: Digest,
    ): void => {
      const previousHash =
        events.length === 0 ? null : eventHashV1(events.at(-1)!);
      const payloadHash = canonicalContentHashV1(payload);
      events.push({
        event: {
          schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
          schemaVersion: 1,
          campaignId,
          assignmentId,
          eventId: eventIdV1({
            campaignId,
            assignmentId,
            ordinal: events.length + 1,
            previousHash: previousHash ?? "",
            eventKind,
            payloadHash,
          }),
          ordinal: events.length + 1,
          previousHash,
          actorRole: E3_EVENT_ACTOR_ACL_V1[eventKind],
          actorKeyId,
          eventKind,
          payloadSchemaId: E3_EVENT_PAYLOAD_SCHEMA_IDS_V1[eventKind],
          payloadHash,
          signature: "A".repeat(86),
        },
        payload,
      } as E3JournalEntryV1);
    };
    append(
      "registrar_assignment_registered",
      {
        assignmentId,
        assignmentCommitment: slot.assignmentCommitment,
        slotOrdinal: 0,
        registeredAt: "2026-08-11T00:00:10.000Z",
      },
      fixture.receipt.keyId,
    );
    append(
      "conformance_actor_started",
      { leaseId: "lease:test", startedAt: "2026-08-11T00:01:00.000Z" },
      slot.conformanceActorKeyId,
    );
    append(
      "conformance_actor_finished",
      { leaseId: "lease:test", finishedAt: "2026-08-11T00:02:00.000Z" },
      slot.conformanceActorKeyId,
    );
    append(
      "registrar_deadline_elapsed",
      { deadline, observedAt: deadline },
      fixture.receipt.keyId,
    );
    append(
      "registrar_primary_closed",
      {
        preClosureHead: eventHashV1(events.at(-1)!),
        closedAt: deadline,
        primaryOutcome: "cleanup_unproven",
      },
      fixture.receipt.keyId,
    );
    const journal: E3JournalV1 = {
      schemaId: E3_SCHEMA_IDS_V1.journal,
      schemaVersion: 1,
      campaignId,
      assignmentId,
      events,
      eventCount: events.length,
      journalHead: eventHashV1(events.at(-1)!),
    };
    const primaryClosure = signedPrimaryClosure({
      fixture,
      campaignId,
      journalHead: journal.journalHead,
      closedAt: deadline,
    });
    const commitTimes = [
      "2026-08-11T00:00:10.000Z",
      "2026-08-11T00:01:00.000Z",
      "2026-08-11T00:02:00.000Z",
      deadline,
      deadline,
    ];
    const appendReceipts = events.map((journalEntry, index) =>
      signedReceipt({
        key: fixture.receipt,
        service: fixture.service,
        campaignId,
        assignmentId,
        eventId: journalEntry.event.eventId,
        eventHash: eventHashV1(journalEntry),
        ordinal: journalEntry.event.ordinal,
        commitSequence: index + 1,
        committedAt: commitTimes[index]!,
      }),
    );
    const registrationLeafHash = merkleLeafHashV1(
      Buffer.from("registration", "utf8"),
    );
    const closureLeafHash = merkleLeafHashV1(
      closurePublicationLeafBytesV1({
        campaignId,
        closureHash: primaryClosure.closureHash,
      }),
    );
    const closureRoot = merkleNodeHashV1(registrationLeafHash, closureLeafHash);
    const proofWithTimes = (
      registrationIssuedAt: string,
      closureIssuedAt: string,
    ): E3PublicationProofV1 => ({
      schemaId: E3_SCHEMA_IDS_V1.publicationProof,
      schemaVersion: 1,
      campaignId,
      closureHash: primaryClosure.closureHash,
      registrationCheckpoint: signedCheckpoint({
        key: fixture.log,
        rootHash: registrationLeafHash,
        treeSize: 1,
        issuedAt: registrationIssuedAt,
      }),
      closureCheckpoint: signedCheckpoint({
        key: fixture.log,
        rootHash: closureRoot,
        treeSize: 2,
        issuedAt: closureIssuedAt,
      }),
      closureInclusionProof: {
        leafIndex: 1,
        treeSize: 2,
        auditPath: [registrationLeafHash],
      },
      registrationToClosureConsistencyProof: {
        firstTreeSize: 1,
        secondTreeSize: 2,
        auditPath: [closureLeafHash],
      },
    });
    const checkpointBasis = {
      schemaId: E3_SCHEMA_IDS_V1.revisionJournalCheckpoint,
      schemaVersion: 1 as const,
      campaignId,
      primaryClosureHash: primaryClosure.closureHash,
      revisionHead: null,
      revisionCount: 0,
      latestKnownEventCount: events.length,
      commitSequence: appendReceipts.at(-1)!.commitSequence,
      asOf: "2026-08-11T00:11:00.000Z",
      registrarServiceId: fixture.service.serviceId,
      closureKeyId: fixture.closure.keyId,
    };
    const revisionJournalCheckpoint = {
      ...checkpointBasis,
      signature: signCanonicalJsonV1({
        privateKey: fixture.closure.privateKey,
        domain: "chronorift-e3-revision-journal-checkpoint-v1",
        schemaId: E3_SCHEMA_IDS_V1.revisionJournalCheckpoint,
        version: 1,
        value: checkpointBasis as unknown as JsonValue,
      }),
    };
    const snapshot = (publicationProof: E3PublicationProofV1) => ({
      schemaId: E3_SCHEMA_IDS_V1.closedEvidenceSnapshot,
      schemaVersion: 1,
      campaignId,
      assignmentId,
      journal,
      appendReceipts,
      primaryClosure,
      revisions: [],
      revisionReceipts: [],
      revisionJournalCheckpoint,
      publicationProof,
      rejectionCount: 0,
    });
    const validProof = proofWithTimes(
      "2026-08-11T00:00:30.000Z",
      "2026-08-11T00:11:00.000Z",
    );
    await expect(
      new E3RegistrarClientV1(
        fixture.service.namespaces[0]!,
        { request: async () => snapshot(validProof) },
        fixture.service,
      ).readClosedEvidence({ campaignId }),
    ).resolves.toMatchObject({ campaignId });

    const lateRegistration = proofWithTimes(
      "2026-08-11T00:01:01.000Z",
      "2026-08-11T00:11:00.000Z",
    );
    await expect(
      new E3RegistrarClientV1(
        fixture.service.namespaces[0]!,
        { request: async () => snapshot(lateRegistration) },
        fixture.service,
      ).readClosedEvidence({ campaignId }),
    ).rejects.toThrow(/do not bracket/u);

    const earlyClosureCheckpoint = proofWithTimes(
      "2026-08-11T00:00:30.000Z",
      "2026-08-11T00:09:59.000Z",
    );
    await expect(
      new E3RegistrarClientV1(
        fixture.service.namespaces[0]!,
        { request: async () => snapshot(earlyClosureCheckpoint) },
        fixture.service,
      ).readClosedEvidence({ campaignId }),
    ).rejects.toThrow(/do not bracket/u);
  });

  it("does not honor ambient proxy configuration for the pinned endpoint", () => {
    const fixture = trustFixture();
    expect(() =>
      createPinnedHttpsTransportV1({
        service: fixture.service,
        environment: { HTTPS_PROXY: "https://operator.invalid" },
      }),
    ).toThrow(/proxy environment/u);
  });
});
