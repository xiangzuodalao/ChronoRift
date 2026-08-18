import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { JsonValue } from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it } from "vitest";

import {
  assignmentIdV1,
  campaignIdV1,
  canonicalBytesV1,
  canonicalContentHashV1,
  ed25519KeyIdV1,
  eventIdV1,
  merkleLeafHashV1,
  merkleNodeHashV1,
  revisionIdV1,
  sha256HexV1,
  signCanonicalJsonV1,
} from "./canonical.js";
import { E3CampaignConformanceEvidenceV1Schema } from "./contracts.js";

type JsonRecord = Record<string, unknown>;
type SigningPair = {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly publicKeyPem: string;
  readonly keyId: string;
};

const execFileAsync = promisify(execFile);
const validatorPath = resolve(".github/scripts/validate-vnext-e3-campaign.mjs");
const temporaryRoots: string[] = [];
const trustRootSigners = new WeakMap<
  JsonRecord,
  readonly [SigningPair, SigningPair]
>();
const evidenceRoleSigners = new WeakMap<
  JsonRecord,
  { readonly receipt: SigningPair; readonly log: SigningPair }
>();
const validatorHarnesses = new Map<
  string,
  {
    readonly validatorPath: string;
    readonly trustRootPath: string;
    readonly freezePath: string;
  }
>();

const json = (value: unknown): JsonValue => value as JsonValue;
const record = (value: unknown): JsonRecord => value as JsonRecord;

const corruptSignature = (value: JsonRecord, field = "signature"): void => {
  const signature = String(value[field]);
  value[field] = `${signature.slice(0, -1)}${
    signature.endsWith("A") ? "B" : "A"
  }`;
};

const signingPair = (): SigningPair => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    keyId: ed25519KeyIdV1(publicKey),
  };
};

const sign = (
  pair: SigningPair,
  domain: string,
  schemaId: string,
  value: unknown,
): string =>
  signCanonicalJsonV1({
    privateKey: pair.privateKey,
    domain,
    schemaId,
    version: 1,
    value: json(value),
  });

const resign = (
  value: JsonRecord,
  pair: SigningPair,
  domain: string,
  schemaId: string,
): void => {
  const basis = { ...value };
  delete basis.signature;
  value.signature = sign(pair, domain, schemaId, basis);
};

const canonicalFileBytes = (value: unknown): string =>
  `${canonicalJson(json(value))}\n`;

const roleKey = (
  pair: SigningPair,
  validFrom: string,
  validUntil: string,
): JsonRecord => ({
  keyId: pair.keyId,
  publicKeyPem: pair.publicKeyPem,
  validFrom,
  validUntil,
});

const freezeTrustRoot = (
  trustRoot: JsonRecord,
  signers: readonly SigningPair[],
): JsonRecord => {
  const trustRootBytes = canonicalFileBytes(trustRoot);
  const trustRootFileHash = sha256HexV1(Buffer.from(trustRootBytes, "utf8"));
  const threshold = trustRoot.signatureThreshold;
  if (!Number.isSafeInteger(threshold)) {
    throw new Error("fixture trust root has an invalid threshold");
  }
  const freezeBasis = {
    schemaId: "chronorift.e3.registrar-trust-root-freeze",
    schemaVersion: 1,
    trustRootVersion: trustRoot.trustRootVersion,
    trustRootFileSha256: trustRootFileHash,
    externalChannelPinSha256: trustRootFileHash,
    signedAt: "2026-01-01T00:00:00Z",
    predecessor: null,
  };
  return {
    ...freezeBasis,
    signatures: signers.slice(0, threshold as number).map((pair) => ({
      keyId: pair.keyId,
      signature: sign(
        pair,
        "chronorift-e3-trust-root-freeze-v1",
        "chronorift.e3.registrar-trust-root-freeze",
        freezeBasis,
      ),
    })),
  };
};

const createEvidence = (
  withRevision = false,
  keyAlias?: "root_service" | "actor_service",
): JsonRecord => {
  const validFrom = "2025-01-01T00:00:00Z";
  const validUntil = "2030-01-01T00:00:00Z";
  const deadline = "2026-01-01T00:10:00Z";
  const registeredAt = "2026-01-01T00:00:00Z";
  const rootOne = signingPair();
  const rootTwo = signingPair();
  const receipt = keyAlias === "root_service" ? rootOne : signingPair();
  const clock = signingPair();
  const closureSigner = signingPair();
  const log = signingPair();
  const conformanceActor =
    keyAlias === "actor_service" ? receipt : signingPair();
  const cleanupActor = signingPair();

  const service = {
    serviceId: "independent-registrar",
    hostname: "registrar.example.test",
    port: 443,
    basePath: "/v1",
    caCertificatePem: "test-only-ca-certificate",
    tlsSpkiSha256: "a".repeat(64),
    namespaces: ["chronorift/e3-test"],
    receiptKey: roleKey(receipt, validFrom, validUntil),
    clockKey: roleKey(clock, validFrom, validUntil),
    closureKey: roleKey(closureSigner, validFrom, validUntil),
    logKey: roleKey(log, validFrom, validUntil),
  };
  const rootKeys = [
    { keyId: rootOne.keyId, publicKeyPem: rootOne.publicKeyPem },
    { keyId: rootTwo.keyId, publicKeyPem: rootTwo.publicKeyPem },
  ];
  const trustRootBasis = {
    schemaId: "chronorift.e3.registrar-trust-root",
    schemaVersion: 1,
    trustRootVersion: "independent-test-root-v1",
    validFrom,
    validUntil,
    signatureThreshold: 2,
    rootKeys,
    services: [service],
  };
  const trustRoot = {
    ...trustRootBasis,
    signatures: [rootOne, rootTwo].map((pair) => ({
      keyId: pair.keyId,
      signature: sign(
        pair,
        "chronorift-e3-trust-root-v1",
        "chronorift.e3.registrar-trust-root",
        trustRootBasis,
      ),
    })),
  };
  const trustRootFileSha256 = sha256HexV1(
    Buffer.from(canonicalFileBytes(trustRoot), "utf8"),
  );
  const trustRootFreezeRecordSha256 = sha256HexV1(
    Buffer.from(
      canonicalFileBytes(freezeTrustRoot(trustRoot, [rootOne, rootTwo])),
      "utf8",
    ),
  );

  const assignmentCommitment = "b".repeat(64);
  const manifest = {
    schemaId: "chronorift.e3.campaign-manifest",
    schemaVersion: 1,
    campaignPurpose: "registrar_conformance",
    claimEligible: false,
    modelCalls: 0,
    evaluatorRuns: 0,
    artifactSinkMode: "configured_external_ci_artifact_directory_v1",
    artifactSinkId: "sink.test",
    artifactSinkCommitment: "a".repeat(64),
    namespace: "chronorift/e3-test",
    registrarServiceId: service.serviceId,
    trustRootVersion: trustRoot.trustRootVersion,
    productSha256: "c".repeat(64),
    runnerSha256: "d".repeat(64),
    validatorSha256: "e".repeat(64),
    deadline,
    assignmentCount: 1,
    assignments: [
      {
        assignmentCommitment,
        cleanupActorKeyId: cleanupActor.keyId,
        conformanceActorKeyId: conformanceActor.keyId,
        slotOrdinal: 0,
      },
    ],
  };
  const campaignId = campaignIdV1(json(manifest));
  const assignmentId = assignmentIdV1({
    campaignId,
    slotOrdinal: 0,
    assignmentCommitment,
  });
  const actorKeys = [
    {
      actorRole: "conformance_actor",
      ...roleKey(conformanceActor, validFrom, validUntil),
    },
    {
      actorRole: "cleanup_actor",
      ...roleKey(cleanupActor, validFrom, validUntil),
    },
  ];

  const eventInputs: Array<{
    readonly eventKind: string;
    readonly actorRole: string;
    readonly pair: SigningPair;
    readonly payloadSchemaId: string;
    readonly payload: JsonRecord;
  }> = [
    {
      eventKind: "registrar_assignment_registered",
      actorRole: "registrar",
      pair: receipt,
      payloadSchemaId: "chronorift.e3.payload.registrar-assignment-registered",
      payload: {
        assignmentId,
        assignmentCommitment,
        slotOrdinal: 0,
        registeredAt,
      },
    },
    {
      eventKind: "conformance_actor_started",
      actorRole: "conformance_actor",
      pair: conformanceActor,
      payloadSchemaId: "chronorift.e3.payload.conformance-actor-started",
      payload: { leaseId: "lease-1", startedAt: "2026-01-01T00:01:00Z" },
    },
    {
      eventKind: "conformance_actor_finished",
      actorRole: "conformance_actor",
      pair: conformanceActor,
      payloadSchemaId: "chronorift.e3.payload.conformance-actor-finished",
      payload: { leaseId: "lease-1", finishedAt: "2026-01-01T00:02:00Z" },
    },
  ];
  if (withRevision) {
    eventInputs.push({
      eventKind: "registrar_deadline_elapsed",
      actorRole: "registrar",
      pair: receipt,
      payloadSchemaId: "chronorift.e3.payload.registrar-deadline-elapsed",
      payload: { deadline, observedAt: deadline },
    });
  } else {
    eventInputs.push({
      eventKind: "conformance_cleanup_proven",
      actorRole: "cleanup_actor",
      pair: cleanupActor,
      payloadSchemaId: "chronorift.e3.payload.conformance-cleanup-proven",
      payload: {
        leaseId: "lease-1",
        observedAt: "2026-01-01T00:03:00Z",
        processesEmpty: true,
        cgroupEmpty: true,
        storageEmpty: true,
        networkLeaseClosed: true,
        credentialLeaseRevoked: true,
        observationCoverage: "complete",
      },
    });
  }
  const events: Array<{ event: JsonRecord; payload: JsonRecord }> = [];
  const appendReceipts: JsonRecord[] = [];
  const primaryOutcome = withRevision
    ? "cleanup_unproven"
    : "conformance_complete";
  const primaryClosedAt = withRevision
    ? "2026-01-01T00:10:01Z"
    : "2026-01-01T00:05:00Z";
  let previousHash: string | null = null;
  let ordinal = 1;

  const append = (input: (typeof eventInputs)[number]): void => {
    const payloadHash = canonicalContentHashV1(json(input.payload));
    const eventBasis = {
      schemaId: "chronorift.e3.event-envelope",
      schemaVersion: 1,
      campaignId,
      assignmentId,
      eventId: eventIdV1({
        campaignId,
        assignmentId,
        ordinal,
        previousHash: previousHash ?? "",
        eventKind: input.eventKind,
        payloadHash,
      }),
      ordinal,
      previousHash,
      actorRole: input.actorRole,
      actorKeyId: input.pair.keyId,
      eventKind: input.eventKind,
      payloadSchemaId: input.payloadSchemaId,
      payloadHash,
    };
    const event = {
      ...eventBasis,
      signature: sign(
        input.pair,
        "chronorift-e3-event-v1",
        "chronorift.e3.event-envelope",
        eventBasis,
      ),
    };
    const eventHash = canonicalContentHashV1(json(event));
    const committedAt =
      input.eventKind === "registrar_assignment_registered"
        ? "2026-01-01T00:00:15Z"
        : input.eventKind === "registrar_deadline_elapsed"
          ? "2026-01-01T00:10:00.500Z"
          : input.eventKind === "registrar_primary_closed"
            ? primaryClosedAt
            : `2026-01-01T00:0${String(ordinal)}:30Z`;
    const receiptBasis = {
      schemaId: "chronorift.e3.append-receipt",
      schemaVersion: 1,
      campaignId,
      assignmentId,
      eventId: event.eventId,
      eventHash,
      journalHead: eventHash,
      ordinal,
      commitSequence: ordinal,
      committedAt,
      registrarServiceId: service.serviceId,
      receiptKeyId: receipt.keyId,
    };
    appendReceipts.push({
      ...receiptBasis,
      signature: sign(
        receipt,
        "chronorift-e3-append-receipt-v1",
        "chronorift.e3.append-receipt",
        receiptBasis,
      ),
    });
    events.push({ event, payload: input.payload });
    previousHash = eventHash;
    ordinal += 1;
  };

  for (const input of eventInputs) append(input);
  append({
    eventKind: "registrar_primary_closed",
    actorRole: "registrar",
    pair: receipt,
    payloadSchemaId: "chronorift.e3.payload.registrar-primary-closed",
    payload: {
      preClosureHead: previousHash,
      closedAt: primaryClosedAt,
      primaryOutcome,
    },
  });
  if (previousHash === null) throw new Error("fixture journal has no head");
  const primaryJournalHead: string = previousHash;

  const journal = {
    schemaId: "chronorift.e3.journal",
    schemaVersion: 1,
    campaignId,
    assignmentId,
    events,
    eventCount: events.length,
    journalHead: primaryJournalHead,
  };
  const clockBasis = {
    campaignId,
    journalHead: primaryJournalHead,
    deadline,
    closedAt: primaryClosedAt,
    primaryOutcome,
  };
  const closureHashBasis = {
    schemaId: "chronorift.e3.primary-closure",
    schemaVersion: 1,
    campaignId,
    journalHead: primaryJournalHead,
    deadline,
    closedAt: clockBasis.closedAt,
    primaryOutcome: clockBasis.primaryOutcome,
    assignmentCount: 1,
    outcomeCounts: {
      conformanceComplete: withRevision ? 0 : 1,
      incompleteUnknown: 0,
      cleanupUnproven: withRevision ? 1 : 0,
    },
    eventCount: events.length,
    appendAttemptCount: events.length + 7,
    rejectionCount: 6,
    idempotentReplayCount: 1,
    publicationState: "closure_sealed_publication_pending",
    claimEligible: false,
    modelCalls: 0,
    evaluatorRuns: 0,
    clockKeyId: clock.keyId,
    clockSignature: sign(
      clock,
      "chronorift-e3-clock-v1",
      "chronorift.e3.primary-closure",
      clockBasis,
    ),
    closureKeyId: closureSigner.keyId,
  };
  const closureHash = canonicalContentHashV1(json(closureHashBasis));
  const closureSignatureBasis = { ...closureHashBasis, closureHash };
  const primaryClosure = {
    ...closureSignatureBasis,
    signature: sign(
      closureSigner,
      "chronorift-e3-primary-closure-v1",
      "chronorift.e3.primary-closure",
      closureSignatureBasis,
    ),
  };

  const revisions: JsonRecord[] = [];
  const revisionReceipts: JsonRecord[] = [];
  if (withRevision) {
    const latePayload = {
      leaseId: "lease-1",
      observedAt: "2026-01-01T00:03:00Z",
      processesEmpty: true,
      cgroupEmpty: true,
      storageEmpty: true,
      networkLeaseClosed: true,
      credentialLeaseRevoked: true,
      observationCoverage: "complete",
    };
    const latePayloadHash = canonicalContentHashV1(json(latePayload));
    const latePreviousHash = appendReceipts[2]!.eventHash as string;
    const lateEventBasis = {
      schemaId: "chronorift.e3.event-envelope",
      schemaVersion: 1,
      campaignId,
      assignmentId,
      eventId: eventIdV1({
        campaignId,
        assignmentId,
        ordinal: 4,
        previousHash: latePreviousHash,
        eventKind: "conformance_cleanup_proven",
        payloadHash: latePayloadHash,
      }),
      ordinal: 4,
      previousHash: latePreviousHash,
      actorRole: "cleanup_actor",
      actorKeyId: cleanupActor.keyId,
      eventKind: "conformance_cleanup_proven",
      payloadSchemaId: "chronorift.e3.payload.conformance-cleanup-proven",
      payloadHash: latePayloadHash,
    };
    const lateEvent = {
      ...lateEventBasis,
      signature: sign(
        cleanupActor,
        "chronorift-e3-event-v1",
        "chronorift.e3.event-envelope",
        lateEventBasis,
      ),
    };
    const lateEntry = { event: lateEvent, payload: latePayload };
    const revisionIdentity = {
      campaignId,
      primaryClosureHash: closureHash,
      revisionOrdinal: 1,
      previousRevisionHash: closureHash,
      lateEventId: lateEvent.eventId,
    };
    const revisionBasis = {
      schemaId: "chronorift.e3.revision-envelope",
      schemaVersion: 1,
      campaignId,
      primaryClosureHash: closureHash,
      revisionId: revisionIdV1(revisionIdentity),
      revisionOrdinal: 1,
      previousRevisionHash: closureHash,
      lateEntry,
      receivedAt: "2026-01-01T00:09:30Z",
      registrarKeyId: receipt.keyId,
    };
    const revision = {
      ...revisionBasis,
      signature: sign(
        receipt,
        "chronorift-e3-revision-envelope-v1",
        "chronorift.e3.revision-envelope",
        revisionBasis,
      ),
    };
    const revisionHash = canonicalContentHashV1(json(revision));
    const revisionReceiptBasis = {
      schemaId: "chronorift.e3.append-receipt",
      schemaVersion: 1,
      campaignId,
      assignmentId,
      eventId: revision.revisionId,
      eventHash: revisionHash,
      journalHead: revisionHash,
      ordinal: 1,
      commitSequence: events.length + 1,
      committedAt: "2026-01-01T00:10:02Z",
      registrarServiceId: service.serviceId,
      receiptKeyId: receipt.keyId,
    };
    revisions.push(revision);
    revisionReceipts.push({
      ...revisionReceiptBasis,
      signature: sign(
        receipt,
        "chronorift-e3-append-receipt-v1",
        "chronorift.e3.append-receipt",
        revisionReceiptBasis,
      ),
    });
  }
  const lastRevision = revisions.at(-1);
  const lastReceipt = revisionReceipts.at(-1) ?? appendReceipts.at(-1)!;
  const revisionCheckpointBasis = {
    schemaId: "chronorift.e3.revision-journal-checkpoint",
    schemaVersion: 1,
    campaignId,
    primaryClosureHash: closureHash,
    revisionHead:
      lastRevision === undefined
        ? null
        : canonicalContentHashV1(json(lastRevision)),
    revisionCount: revisions.length,
    latestKnownEventCount: events.length + revisions.length,
    commitSequence: lastReceipt.commitSequence,
    asOf: withRevision ? "2026-01-01T00:10:03Z" : "2026-01-01T00:06:00Z",
    registrarServiceId: service.serviceId,
    closureKeyId: closureSigner.keyId,
  };
  const revisionJournalCheckpoint = {
    ...revisionCheckpointBasis,
    signature: sign(
      closureSigner,
      "chronorift-e3-revision-journal-checkpoint-v1",
      "chronorift.e3.revision-journal-checkpoint",
      revisionCheckpointBasis,
    ),
  };

  const closureLeafBytes = canonicalBytesV1(json({ campaignId, closureHash }));
  const closureLeafHash = merkleLeafHashV1(closureLeafBytes);
  const registrationRoot = merkleLeafHashV1(
    canonicalBytesV1(json({ campaignId, deadline })),
  );
  const closureRoot = merkleNodeHashV1(registrationRoot, closureLeafHash);
  const checkpoint = (
    treeSize: number,
    rootHash: string,
    issuedAt: string,
  ): JsonRecord => {
    const basis = {
      logId: "independent-log",
      treeSize,
      rootHash,
      issuedAt,
      logKeyId: log.keyId,
    };
    return {
      ...basis,
      signature: sign(
        log,
        "chronorift-e3-transparency-checkpoint-v1",
        "chronorift.e3.transparency-checkpoint",
        basis,
      ),
    };
  };
  const registrationCheckpoint = checkpoint(
    1,
    registrationRoot,
    "2026-01-01T00:00:30Z",
  );
  const registrationProof = {
    schemaId: "chronorift.e3.registration-proof",
    schemaVersion: 1,
    campaignId,
    checkpoint: registrationCheckpoint,
    inclusionProof: {
      leafIndex: 0,
      treeSize: 1,
      auditPath: [],
    },
  };
  const publicationProof = {
    schemaId: "chronorift.e3.publication-proof",
    schemaVersion: 1,
    campaignId,
    closureHash,
    registrationCheckpoint,
    closureCheckpoint: checkpoint(
      2,
      closureRoot,
      withRevision ? "2026-01-01T00:10:03Z" : "2026-01-01T00:06:00Z",
    ),
    closureInclusionProof: {
      leafIndex: 1,
      treeSize: 2,
      auditPath: [registrationRoot],
    },
    registrationToClosureConsistencyProof: {
      firstTreeSize: 1,
      secondTreeSize: 2,
      auditPath: [closureLeafHash],
    },
  };
  const cleanupReceiptHash = withRevision
    ? null
    : canonicalContentHashV1(json(appendReceipts[3]!));
  const summary = {
    schemaId: "chronorift.e3.sanitized-summary",
    schemaVersion: 1,
    capability: "campaign_denominator_conformance",
    campaignPurpose: "registrar_conformance",
    viewKind: "latest_known",
    publicationState: "closure_published",
    claimEligible: false,
    modelCalls: 0,
    evaluatorRuns: 0,
    artifactSinkMode: manifest.artifactSinkMode,
    artifactSinkId: manifest.artifactSinkId,
    artifactSinkCommitment: manifest.artifactSinkCommitment,
    productSha256: manifest.productSha256,
    runnerSha256: manifest.runnerSha256,
    validatorSha256: manifest.validatorSha256,
    trustRootVersion: manifest.trustRootVersion,
    trustRootFileSha256,
    trustRootFreezeRecordSha256,
    trustRootExternalPinSha256: trustRootFileSha256,
    registrarServiceId: service.serviceId,
    tlsSpkiId: service.tlsSpkiSha256,
    registrarKeyIds: {
      receipt: receipt.keyId,
      clock: clock.keyId,
      closure: closureSigner.keyId,
      log: log.keyId,
    },
    actorKeyIds: {
      conformance: conformanceActor.keyId,
      cleanup: cleanupActor.keyId,
    },
    campaignId,
    assignmentIds: [assignmentId],
    assignmentCount: 1,
    eventCount: events.length,
    appendAttemptCount: events.length + 7,
    idempotentReplayCount: 1,
    revisionCount: revisions.length,
    latestKnownEventCount: events.length + revisions.length,
    rejectionCount: 6,
    closureCount: 1,
    primaryOutcome,
    outcomeCounts: closureHashBasis.outcomeCounts,
    journalHead: primaryJournalHead,
    closureHash,
    deadline,
    closedAt: primaryClosedAt,
    cleanupReceiptHash,
    revisionCheckpointHash: canonicalContentHashV1(
      json(revisionJournalCheckpoint),
    ),
    registrationCheckpointRoot: registrationRoot,
    registrationCheckpointTreeSize: 1,
    registrationCheckpointIssuedAt: registrationCheckpoint.issuedAt,
    checkpointRoot: closureRoot,
    checkpointTreeSize: 2,
    checkpointIssuedAt: record(publicationProof.closureCheckpoint).issuedAt,
    registrationInclusionProofHash: canonicalContentHashV1(
      json(registrationProof.inclusionProof),
    ),
    inclusionProofHash: canonicalContentHashV1(
      json(publicationProof.closureInclusionProof),
    ),
    consistencyProofHash: canonicalContentHashV1(
      json(publicationProof.registrationToClosureConsistencyProof),
    ),
  };
  const evidence: JsonRecord = {
    schemaId: "chronorift.e3.campaign-conformance-evidence",
    schemaVersion: 1,
    trustRoot,
    actorKeys,
    manifest,
    journal,
    appendReceipts,
    primaryClosure,
    revisions,
    revisionReceipts,
    revisionJournalCheckpoint,
    registrationProof,
    publicationProof,
    rejectionCount: 6,
    summary,
  };
  trustRootSigners.set(evidence, [rootOne, rootTwo]);
  evidenceRoleSigners.set(evidence, { receipt, log });
  return evidence;
};

const writeEvidence = async (
  root: string,
  name: string,
  evidence: JsonRecord,
  pinnedEvidence: JsonRecord = evidence,
): Promise<string> => {
  const path = join(root, name);
  await writeFile(path, canonicalFileBytes(evidence), "utf8");
  const signers = trustRootSigners.get(pinnedEvidence);
  if (signers === undefined) {
    throw new Error("pinned evidence fixture has no threshold signers");
  }
  const trustRoot = record(pinnedEvidence.trustRoot);
  if (
    typeof trustRoot.trustRootVersion !== "string" ||
    !Number.isSafeInteger(trustRoot.signatureThreshold)
  ) {
    throw new Error("pinned evidence fixture has an invalid trust root");
  }
  const trustRootBytes = canonicalFileBytes(trustRoot);
  const trustRootFileHash = sha256HexV1(Buffer.from(trustRootBytes, "utf8"));
  const freeze = freezeTrustRoot(trustRoot, signers);
  const harnessRoot = join(
    root,
    `.validator-${name.replace(/[^A-Za-z0-9._-]/gu, "_")}`,
  );
  const harnessValidatorPath = join(
    harnessRoot,
    ".github/scripts/validate-vnext-e3-campaign.mjs",
  );
  const trustRootPath = join(
    harnessRoot,
    "testdata/vnext/e3/registrar-trust-root.v1.json",
  );
  const freezePath = join(
    harnessRoot,
    "testdata/vnext/e3/registrar-trust-root.v1.freeze.json",
  );
  await Promise.all([
    mkdir(join(harnessValidatorPath, ".."), { recursive: true }),
    mkdir(join(trustRootPath, ".."), { recursive: true }),
  ]);
  const source = await readFile(validatorPath, "utf8");
  const sentinel = "const PINNED_EXTERNAL_TRUST_ROOT_SHA256 = null;";
  if (source.split(sentinel).length !== 2) {
    throw new Error("validator release-pin sentinel is missing or ambiguous");
  }
  const pinnedSource = source.replace(
    sentinel,
    `const PINNED_EXTERNAL_TRUST_ROOT_SHA256 = ${JSON.stringify(
      trustRootFileHash,
    )};`,
  );
  await Promise.all([
    writeFile(harnessValidatorPath, pinnedSource, "utf8"),
    writeFile(trustRootPath, trustRootBytes, "utf8"),
    writeFile(freezePath, canonicalFileBytes(freeze), "utf8"),
  ]);
  validatorHarnesses.set(path, {
    validatorPath: harnessValidatorPath,
    trustRootPath,
    freezePath,
  });
  return path;
};

const validate = async (path: string): Promise<string> => {
  const harness = validatorHarnesses.get(path);
  if (harness === undefined)
    throw new Error("validator harness is unavailable");
  const result = await execFileAsync(
    process.execPath,
    [harness.validatorPath, path],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  return result.stdout;
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("independent E3.1 campaign evidence validator", () => {
  it("fails closed while the release external trust-root pin is unselected", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e3-validator-"));
    temporaryRoots.push(root);
    const evidence = createEvidence();
    const path = await writeEvidence(root, "unselected-pin.json", evidence);

    await expect(
      execFileAsync(process.execPath, [validatorPath, path], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      }),
    ).rejects.toThrow(/has not been release-pinned/u);
  });

  it("rejects an internally valid self-signed replacement trust root", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e3-validator-"));
    temporaryRoots.push(root);
    const pinnedEvidence = createEvidence();
    const replacementEvidence = createEvidence();
    const path = await writeEvidence(
      root,
      "self-signed-replacement.json",
      replacementEvidence,
      pinnedEvidence,
    );

    await expect(validate(path)).rejects.toThrow(/does not byte-match/u);
  });

  it("rejects key reuse across threshold, registrar, and actor roles", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e3-validator-"));
    temporaryRoots.push(root);
    for (const keyAlias of ["root_service", "actor_service"] as const) {
      const evidence = createEvidence(false, keyAlias);
      const path = await writeEvidence(root, `${keyAlias}.json`, evidence);
      await expect(validate(path)).rejects.toThrow(/distinct/u);
    }
  });

  it("rejects trust-root and freeze bytes that diverge from the fixed external pin", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e3-validator-"));
    temporaryRoots.push(root);
    const evidence = createEvidence();
    const rootTamperPath = await writeEvidence(
      root,
      "root-tamper.json",
      evidence,
    );
    const rootHarness = validatorHarnesses.get(rootTamperPath)!;
    await writeFile(
      rootHarness.trustRootPath,
      canonicalFileBytes(record(createEvidence().trustRoot)),
      "utf8",
    );
    await expect(validate(rootTamperPath)).rejects.toThrow(/external hash/u);

    const freezeTamperPath = await writeEvidence(
      root,
      "freeze-tamper.json",
      evidence,
    );
    const freezeHarness = validatorHarnesses.get(freezeTamperPath)!;
    const freeze = JSON.parse(
      await readFile(freezeHarness.freezePath, "utf8"),
    ) as JsonRecord;
    freeze.externalChannelPinSha256 = "f".repeat(64);
    await writeFile(
      freezeHarness.freezePath,
      canonicalFileBytes(freeze),
      "utf8",
    );
    await expect(validate(freezeTamperPath)).rejects.toThrow(
      /externalChannelPinSha256/u,
    );
  });

  it("rejects a service role key whose validity escapes the pinned root", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e3-validator-"));
    temporaryRoots.push(root);
    const evidence = createEvidence();
    const trustRoot = record(evidence.trustRoot);
    const service = record((trustRoot.services as JsonRecord[])[0]);
    record(service.receiptKey).validUntil = "2031-01-01T00:00:00Z";
    const signers = trustRootSigners.get(evidence)!;
    const basis = { ...trustRoot };
    delete basis.signatures;
    trustRoot.signatures = signers.map((pair) => ({
      keyId: pair.keyId,
      signature: sign(
        pair,
        "chronorift-e3-trust-root-v1",
        "chronorift.e3.registrar-trust-root",
        basis,
      ),
    }));
    const path = await writeEvidence(root, "role-validity.json", evidence);

    await expect(validate(path)).rejects.toThrow(/validity escapes/u);
  });

  it("rejects a freeze signature time outside the pinned root interval", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e3-validator-"));
    temporaryRoots.push(root);
    const evidence = createEvidence();
    const path = await writeEvidence(root, "freeze-time.json", evidence);
    const harness = validatorHarnesses.get(path)!;
    const freeze = JSON.parse(
      await readFile(harness.freezePath, "utf8"),
    ) as JsonRecord;
    freeze.signedAt = "2030-01-01T00:00:00Z";
    await writeFile(harness.freezePath, canonicalFileBytes(freeze), "utf8");

    await expect(validate(path)).rejects.toThrow(/outside the trust-root/u);
  });

  it("accepts a fully signed synthetic denominator-conformance artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e3-validator-"));
    temporaryRoots.push(root);
    const evidence = createEvidence();
    expect(
      E3CampaignConformanceEvidenceV1Schema.safeParse(evidence).success,
    ).toBe(true);
    const path = await writeEvidence(root, "valid.json", evidence);

    const stdout = await validate(path);

    expect(stdout).toBe(
      `[chronorift-e3-campaign] ${canonicalJson(json(evidence.summary))}\n`,
    );
    expect(stdout).toContain('"capability":"campaign_denominator_conformance"');
    expect(stdout).toContain('"modelCalls":0');
    expect(stdout).toContain('"evaluatorRuns":0');
    expect(stdout).toContain('"claimEligible":false');
  });

  it("rejects a sanitized summary that does not bind the registered artifact sink", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e3-validator-"));
    temporaryRoots.push(root);
    const evidence = createEvidence();
    record(evidence.summary).artifactSinkId = "different.sink";
    const path = await writeEvidence(
      root,
      "artifact-sink-mismatch.json",
      evidence,
    );

    await expect(validate(path)).rejects.toThrow(/summary\.artifactSinkId/u);
  });

  it("rejects primary receipt and transparency time-boundary violations", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e3-validator-"));
    temporaryRoots.push(root);

    const lateCleanup = createEvidence();
    const lateCleanupSigners = evidenceRoleSigners.get(lateCleanup)!;
    const cleanupReceipt = (lateCleanup.appendReceipts as JsonRecord[])[3]!;
    cleanupReceipt.committedAt = record(lateCleanup.manifest).deadline;
    resign(
      cleanupReceipt,
      lateCleanupSigners.receipt,
      "chronorift-e3-append-receipt-v1",
      "chronorift.e3.append-receipt",
    );
    const lateCleanupPath = await writeEvidence(
      root,
      "cleanup-at-deadline.json",
      lateCleanup,
    );
    await expect(validate(lateCleanupPath)).rejects.toThrow(
      /strictly before the campaign deadline/u,
    );

    const mismatchedClosureReceipt = createEvidence();
    const closureReceiptSigners = evidenceRoleSigners.get(
      mismatchedClosureReceipt,
    )!;
    const closureReceipt = (
      mismatchedClosureReceipt.appendReceipts as JsonRecord[]
    )[4]!;
    closureReceipt.committedAt = "2026-01-01T00:05:01Z";
    resign(
      closureReceipt,
      closureReceiptSigners.receipt,
      "chronorift-e3-append-receipt-v1",
      "chronorift.e3.append-receipt",
    );
    const closureReceiptPath = await writeEvidence(
      root,
      "closure-receipt-time.json",
      mismatchedClosureReceipt,
    );
    await expect(validate(closureReceiptPath)).rejects.toThrow(
      /share the exact closedAt/u,
    );

    const lateRegistration = createEvidence();
    const registrationSigners = evidenceRoleSigners.get(lateRegistration)!;
    const registrationCheckpoint = record(
      record(lateRegistration.registrationProof).checkpoint,
    );
    registrationCheckpoint.issuedAt = "2026-01-01T00:02:31Z";
    resign(
      registrationCheckpoint,
      registrationSigners.log,
      "chronorift-e3-transparency-checkpoint-v1",
      "chronorift.e3.transparency-checkpoint",
    );
    record(lateRegistration.summary).registrationCheckpointIssuedAt =
      registrationCheckpoint.issuedAt;
    const lateRegistrationPath = await writeEvidence(
      root,
      "late-registration-checkpoint.json",
      lateRegistration,
    );
    await expect(validate(lateRegistrationPath)).rejects.toThrow(
      /after actor execution began/u,
    );

    const earlyRegistration = createEvidence();
    const earlyRegistrationSigners =
      evidenceRoleSigners.get(earlyRegistration)!;
    const earlyRegistrationCheckpoint = record(
      record(earlyRegistration.registrationProof).checkpoint,
    );
    earlyRegistrationCheckpoint.issuedAt = "2026-01-01T00:00:14Z";
    resign(
      earlyRegistrationCheckpoint,
      earlyRegistrationSigners.log,
      "chronorift-e3-transparency-checkpoint-v1",
      "chronorift.e3.transparency-checkpoint",
    );
    record(earlyRegistration.summary).registrationCheckpointIssuedAt =
      earlyRegistrationCheckpoint.issuedAt;
    const earlyRegistrationPath = await writeEvidence(
      root,
      "early-registration-checkpoint.json",
      earlyRegistration,
    );
    await expect(validate(earlyRegistrationPath)).rejects.toThrow(
      /predates the registration commit/u,
    );

    const earlyClosurePublication = createEvidence();
    const publicationSigners = evidenceRoleSigners.get(
      earlyClosurePublication,
    )!;
    const closureCheckpoint = record(
      record(earlyClosurePublication.publicationProof).closureCheckpoint,
    );
    closureCheckpoint.issuedAt = "2026-01-01T00:04:59Z";
    resign(
      closureCheckpoint,
      publicationSigners.log,
      "chronorift-e3-transparency-checkpoint-v1",
      "chronorift.e3.transparency-checkpoint",
    );
    record(earlyClosurePublication.summary).checkpointIssuedAt =
      closureCheckpoint.issuedAt;
    const earlyClosurePublicationPath = await writeEvidence(
      root,
      "early-closure-checkpoint.json",
      earlyClosurePublication,
    );
    await expect(validate(earlyClosurePublicationPath)).rejects.toThrow(
      /checkpoint predates registration or primary closure/u,
    );
  });

  it("retains a signed late revision without rewriting the primary result", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e3-validator-"));
    temporaryRoots.push(root);
    const evidence = createEvidence(true);
    const path = await writeEvidence(root, "revision.json", evidence);

    const stdout = await validate(path);

    expect(stdout).toContain('"primaryOutcome":"cleanup_unproven"');
    expect(stdout).toContain('"eventCount":5');
    expect(stdout).toContain('"revisionCount":1');
    expect(stdout).toContain('"latestKnownEventCount":6');

    const revision = record((evidence.revisions as JsonRecord[])[0]);
    const lateEntry = record(revision.lateEntry);
    record(lateEntry.payload).leaseId = "tampered-lease";
    const tamperedPath = await writeEvidence(
      root,
      "revision-tamper.json",
      evidence,
    );
    await expect(validate(tamperedPath)).rejects.toThrow(/payloadHash/u);
  });

  it("rejects an unrooted revision and a tampered signed revision checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e3-validator-"));
    temporaryRoots.push(root);

    const unrootedEvidence = createEvidence(true);
    record(
      (unrootedEvidence.revisions as JsonRecord[])[0],
    ).previousRevisionHash = null;
    const unrootedPath = await writeEvidence(
      root,
      "unrooted-revision.json",
      unrootedEvidence,
    );
    await expect(validate(unrootedPath)).rejects.toThrow(
      /previousRevisionHash/u,
    );

    const checkpointEvidence = createEvidence(true);
    const checkpoint = record(checkpointEvidence.revisionJournalCheckpoint);
    const checkpointSignature = String(checkpoint.signature);
    checkpoint.signature = `${checkpointSignature.slice(0, -1)}${
      checkpointSignature.endsWith("A") ? "B" : "A"
    }`;
    const checkpointPath = await writeEvidence(
      root,
      "revision-checkpoint-signature.json",
      checkpointEvidence,
    );
    await expect(validate(checkpointPath)).rejects.toThrow(
      /revisionJournalCheckpoint.*signature/u,
    );

    const summaryEvidence = createEvidence();
    record(summaryEvidence.summary).revisionCheckpointHash = "f".repeat(64);
    const summaryPath = await writeEvidence(
      root,
      "revision-checkpoint-summary.json",
      summaryEvidence,
    );
    await expect(validate(summaryPath)).rejects.toThrow(
      /summary.revisionCheckpointHash/u,
    );
  });

  it("rejects duplicate JSON keys before ordinary JSON parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e3-validator-"));
    temporaryRoots.push(root);
    const evidence = createEvidence();
    const canonical = canonicalFileBytes(evidence);
    const path = await writeEvidence(root, "duplicate.json", evidence);
    await writeFile(
      path,
      canonical.replace("{", '{"schemaVersion":1,'),
      "utf8",
    );

    await expect(validate(path)).rejects.toThrow(/duplicate object key/u);
  });

  it("rejects unknown fields at every strict boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e3-validator-"));
    temporaryRoots.push(root);
    const evidence = createEvidence();
    record(evidence.summary).unexpected = true;
    const path = await writeEvidence(root, "unknown.json", evidence);

    await expect(validate(path)).rejects.toThrow(/missing or unknown field/u);
  });

  it("fails closed when signed data or a Merkle proof is tampered", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e3-validator-"));
    temporaryRoots.push(root);
    const signedEvidence = createEvidence();
    const receipts = signedEvidence.appendReceipts as JsonRecord[];
    receipts[1]!.committedAt = "2026-01-01T00:02:31Z";
    const signedPath = await writeEvidence(
      root,
      "signed-tamper.json",
      signedEvidence,
    );
    await expect(validate(signedPath)).rejects.toThrow(
      /invalid Ed25519 signature/u,
    );

    const metricEvidence = createEvidence();
    record(metricEvidence.primaryClosure).appendAttemptCount = 13;
    const metricPath = await writeEvidence(
      root,
      "metric-tamper.json",
      metricEvidence,
    );
    await expect(validate(metricPath)).rejects.toThrow(
      /append-attempt accounting/u,
    );

    const proofEvidence = createEvidence();
    const publication = record(proofEvidence.publicationProof);
    const inclusion = record(publication.closureInclusionProof);
    inclusion.auditPath = ["f".repeat(64)];
    const proofPath = await writeEvidence(
      root,
      "proof-tamper.json",
      proofEvidence,
    );
    await expect(validate(proofPath)).rejects.toThrow(
      /inclusion proof is invalid/u,
    );

    const registrationEvidence = createEvidence();
    const registration = record(registrationEvidence.registrationProof);
    const registrationInclusion = record(registration.inclusionProof);
    registrationInclusion.auditPath = ["f".repeat(64)];
    const registrationPath = await writeEvidence(
      root,
      "registration-proof-tamper.json",
      registrationEvidence,
    );
    await expect(validate(registrationPath)).rejects.toThrow(
      /registration RFC6962 inclusion proof is invalid/u,
    );
  });

  it("fails closed for every signing role and signed revision layer", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e3-validator-"));
    temporaryRoots.push(root);
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly revision?: boolean;
      readonly mutate: (evidence: JsonRecord) => void;
    }> = [
      {
        label: "registrar-event",
        mutate: (evidence) =>
          corruptSignature(
            record((record(evidence.journal).events as JsonRecord[])[0]!.event),
          ),
      },
      {
        label: "conformance-actor-event",
        mutate: (evidence) =>
          corruptSignature(
            record((record(evidence.journal).events as JsonRecord[])[1]!.event),
          ),
      },
      {
        label: "cleanup-actor-event",
        mutate: (evidence) =>
          corruptSignature(
            record((record(evidence.journal).events as JsonRecord[])[3]!.event),
          ),
      },
      {
        label: "append-receipt",
        mutate: (evidence) =>
          corruptSignature((evidence.appendReceipts as JsonRecord[])[1]!),
      },
      {
        label: "clock",
        mutate: (evidence) =>
          corruptSignature(record(evidence.primaryClosure), "clockSignature"),
      },
      {
        label: "closure",
        mutate: (evidence) => corruptSignature(record(evidence.primaryClosure)),
      },
      {
        label: "log-checkpoint",
        mutate: (evidence) =>
          corruptSignature(
            record(record(evidence.publicationProof).closureCheckpoint),
          ),
      },
      {
        label: "revision-envelope",
        revision: true,
        mutate: (evidence) =>
          corruptSignature((evidence.revisions as JsonRecord[])[0]!),
      },
      {
        label: "revision-receipt",
        revision: true,
        mutate: (evidence) =>
          corruptSignature((evidence.revisionReceipts as JsonRecord[])[0]!),
      },
    ];
    for (const mutation of cases) {
      const evidence = createEvidence(mutation.revision ?? false);
      mutation.mutate(evidence);
      const path = await writeEvidence(
        root,
        `${mutation.label}.json`,
        evidence,
      );
      await expect(validate(path), mutation.label).rejects.toThrow();
    }

    const rootSignatureEvidence = createEvidence();
    corruptSignature(
      (record(rootSignatureEvidence.trustRoot).signatures as JsonRecord[])[0]!,
    );
    const rootSignaturePath = await writeEvidence(
      root,
      "root-signature.json",
      rootSignatureEvidence,
    );
    await expect(validate(rootSignaturePath)).rejects.toThrow(/signature/u);

    const freezeSignatureEvidence = createEvidence();
    const freezeSignaturePath = await writeEvidence(
      root,
      "freeze-signature.json",
      freezeSignatureEvidence,
    );
    const harness = validatorHarnesses.get(freezeSignaturePath)!;
    const freeze = JSON.parse(
      await readFile(harness.freezePath, "utf8"),
    ) as JsonRecord;
    corruptSignature((freeze.signatures as JsonRecord[])[0]!);
    await writeFile(harness.freezePath, canonicalFileBytes(freeze), "utf8");
    await expect(validate(freezeSignaturePath)).rejects.toThrow(/signature/u);
  });
});
