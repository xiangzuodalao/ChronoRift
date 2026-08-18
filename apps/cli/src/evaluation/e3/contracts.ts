import { z } from "zod";

import { Sha256DigestV1Schema } from "@chronorift/domain";

export const E3_SCHEMA_VERSION_V1 = 1 as const;
export const E3_ARTIFACT_SINK_MODE_V1 =
  "configured_external_ci_artifact_directory_v1" as const;

export const E3_SCHEMA_IDS_V1 = {
  appendReceipt: "chronorift.e3.append-receipt",
  campaignEvidence: "chronorift.e3.campaign-conformance-evidence",
  campaignManifest: "chronorift.e3.campaign-manifest",
  closedEvidenceSnapshot: "chronorift.e3.closed-evidence-snapshot",
  eventEnvelope: "chronorift.e3.event-envelope",
  journal: "chronorift.e3.journal",
  lateAppendRequest: "chronorift.e3.late-append-request",
  lateAppendResult: "chronorift.e3.late-append-result",
  primaryClosure: "chronorift.e3.primary-closure",
  publicationProof: "chronorift.e3.publication-proof",
  publicPendingStatus: "chronorift.e3.public-pending-status",
  registrationProof: "chronorift.e3.registration-proof",
  revisionEnvelope: "chronorift.e3.revision-envelope",
  revisionJournalCheckpoint: "chronorift.e3.revision-journal-checkpoint",
  sanitizedSummary: "chronorift.e3.sanitized-summary",
  trustRoot: "chronorift.e3.registrar-trust-root",
} as const;

export const E3_EVENT_KINDS_V1 = [
  "registrar_assignment_registered",
  "conformance_actor_started",
  "conformance_actor_finished",
  "conformance_cleanup_proven",
  "registrar_deadline_elapsed",
  "registrar_primary_closed",
] as const;

export const E3_PRIMARY_OUTCOMES_V1 = [
  "conformance_complete",
  "incomplete_unknown",
  "cleanup_unproven",
] as const;

export const E3_ACTOR_ROLES_V1 = [
  "registrar",
  "conformance_actor",
  "cleanup_actor",
] as const;

export const E3_EVENT_PAYLOAD_SCHEMA_IDS_V1 = {
  registrar_assignment_registered:
    "chronorift.e3.payload.registrar-assignment-registered",
  conformance_actor_started: "chronorift.e3.payload.conformance-actor-started",
  conformance_actor_finished:
    "chronorift.e3.payload.conformance-actor-finished",
  conformance_cleanup_proven:
    "chronorift.e3.payload.conformance-cleanup-proven",
  registrar_deadline_elapsed:
    "chronorift.e3.payload.registrar-deadline-elapsed",
  registrar_primary_closed: "chronorift.e3.payload.registrar-primary-closed",
} as const;

export const E3_EVENT_ACTOR_ACL_V1 = {
  registrar_assignment_registered: "registrar",
  conformance_actor_started: "conformance_actor",
  conformance_actor_finished: "conformance_actor",
  conformance_cleanup_proven: "cleanup_actor",
  registrar_deadline_elapsed: "registrar",
  registrar_primary_closed: "registrar",
} as const satisfies Readonly<
  Record<(typeof E3_EVENT_KINDS_V1)[number], (typeof E3_ACTOR_ROLES_V1)[number]>
>;

const SchemaVersionV1Schema = z.literal(E3_SCHEMA_VERSION_V1);
const IdentifierV1Schema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const NamespaceV1Schema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const IsoTimestampV1Schema = z.string().datetime({ offset: true });
const SafeIntegerV1Schema = z.number().int().nonnegative().safe();
const PositiveSafeIntegerV1Schema = z.number().int().positive().safe();
const ThresholdSafeIntegerV1Schema = z.number().int().min(2).safe();
const SignatureV1Schema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{86}$/u, "expected an unpadded Ed25519 signature");
const PublicKeyPemV1Schema = z
  .string()
  .min(1)
  .max(16 * 1024)
  .regex(
    /^-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/=]+\n)+-----END PUBLIC KEY-----\n?$/u,
    "expected a bounded PEM public key",
  );
const HostnameV1Schema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/u,
  );

export const E3EventKindV1Schema = z.enum(E3_EVENT_KINDS_V1);
export const E3PrimaryOutcomeV1Schema = z.enum(E3_PRIMARY_OUTCOMES_V1);
export const E3ActorRoleV1Schema = z.enum(E3_ACTOR_ROLES_V1);
export const E3PublicPendingStateV1Schema = z.enum([
  "open",
  "closure_sealed_publication_pending",
  "closure_published",
]);

export const E3AssignmentSlotV1Schema = z
  .object({
    assignmentCommitment: Sha256DigestV1Schema,
    cleanupActorKeyId: Sha256DigestV1Schema,
    conformanceActorKeyId: Sha256DigestV1Schema,
    slotOrdinal: SafeIntegerV1Schema,
  })
  .strict();

export const E3CampaignManifestV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.campaignManifest),
    schemaVersion: SchemaVersionV1Schema,
    campaignPurpose: z.literal("registrar_conformance"),
    claimEligible: z.literal(false),
    modelCalls: z.literal(0),
    evaluatorRuns: z.literal(0),
    artifactSinkMode: z.literal(E3_ARTIFACT_SINK_MODE_V1),
    artifactSinkId: IdentifierV1Schema,
    artifactSinkCommitment: Sha256DigestV1Schema,
    namespace: NamespaceV1Schema,
    registrarServiceId: IdentifierV1Schema,
    trustRootVersion: IdentifierV1Schema,
    productSha256: Sha256DigestV1Schema,
    runnerSha256: Sha256DigestV1Schema,
    validatorSha256: Sha256DigestV1Schema,
    deadline: IsoTimestampV1Schema,
    assignmentCount: z.literal(1),
    assignments: z.tuple([E3AssignmentSlotV1Schema]),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.assignmentCount !== manifest.assignments.length) {
      context.addIssue({
        code: "custom",
        path: ["assignmentCount"],
        message: "assignmentCount must equal assignments.length",
      });
    }
    const ordinals = manifest.assignments.map(({ slotOrdinal }) => slotOrdinal);
    const expected = ordinals.map((_, index) => index);
    if (ordinals.some((ordinal, index) => ordinal !== expected[index])) {
      context.addIssue({
        code: "custom",
        path: ["assignments"],
        message: "assignment slot ordinals must be contiguous from zero",
      });
    }
    for (const field of [
      "assignmentCommitment",
      "cleanupActorKeyId",
      "conformanceActorKeyId",
    ] as const) {
      const values = manifest.assignments.map(
        (assignment) => assignment[field],
      );
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: ["assignments"],
          message: `${field} values must be unique`,
        });
      }
    }
  });

export const E3RolePublicKeyV1Schema = z
  .object({
    keyId: Sha256DigestV1Schema,
    publicKeyPem: PublicKeyPemV1Schema,
    validFrom: IsoTimestampV1Schema,
    validUntil: IsoTimestampV1Schema,
  })
  .strict()
  .refine((key) => Date.parse(key.validFrom) < Date.parse(key.validUntil), {
    path: ["validUntil"],
    message: "key validity interval must be increasing",
  });

export const E3RegistrarServiceBindingV1Schema = z
  .object({
    serviceId: IdentifierV1Schema,
    hostname: HostnameV1Schema,
    port: z.number().int().min(1).max(65_535),
    basePath: z
      .string()
      .min(1)
      .max(256)
      .regex(/^\/(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._~/-]+$/u),
    caCertificatePem: z
      .string()
      .min(1)
      .max(64 * 1024),
    tlsSpkiSha256: Sha256DigestV1Schema,
    namespaces: z.array(NamespaceV1Schema).min(1).max(64),
    receiptKey: E3RolePublicKeyV1Schema,
    clockKey: E3RolePublicKeyV1Schema,
    closureKey: E3RolePublicKeyV1Schema,
    logKey: E3RolePublicKeyV1Schema,
  })
  .strict()
  .superRefine((service, context) => {
    if (new Set(service.namespaces).size !== service.namespaces.length) {
      context.addIssue({
        code: "custom",
        path: ["namespaces"],
        message: "service namespaces must be unique",
      });
    }
    const keyIds = [
      service.receiptKey.keyId,
      service.clockKey.keyId,
      service.closureKey.keyId,
      service.logKey.keyId,
    ];
    if (new Set(keyIds).size !== keyIds.length) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "registrar role keys must be distinct",
      });
    }
  });

export const E3ThresholdRootKeyV1Schema = z
  .object({
    keyId: Sha256DigestV1Schema,
    publicKeyPem: PublicKeyPemV1Schema,
  })
  .strict();

export const E3ThresholdSignatureV1Schema = z
  .object({
    keyId: Sha256DigestV1Schema,
    signature: SignatureV1Schema,
  })
  .strict();

export const E3RegistrarTrustRootV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.trustRoot),
    schemaVersion: SchemaVersionV1Schema,
    trustRootVersion: IdentifierV1Schema,
    validFrom: IsoTimestampV1Schema,
    validUntil: IsoTimestampV1Schema,
    signatureThreshold: ThresholdSafeIntegerV1Schema,
    rootKeys: z.array(E3ThresholdRootKeyV1Schema).min(2).max(16),
    services: z.array(E3RegistrarServiceBindingV1Schema).min(1).max(16),
    signatures: z.array(E3ThresholdSignatureV1Schema).min(1).max(16),
  })
  .strict()
  .superRefine((root, context) => {
    if (Date.parse(root.validFrom) >= Date.parse(root.validUntil)) {
      context.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "trust-root validity interval must be increasing",
      });
    }
    if (
      root.signatureThreshold > root.rootKeys.length ||
      root.signatures.length < root.signatureThreshold
    ) {
      context.addIssue({
        code: "custom",
        path: ["signatureThreshold"],
        message: "threshold must be satisfiable by declared signatures",
      });
    }
    for (const [field, values] of [
      ["rootKeys", root.rootKeys.map(({ keyId }) => keyId)],
      ["services", root.services.map(({ serviceId }) => serviceId)],
      ["signatures", root.signatures.map(({ keyId }) => keyId)],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} identities must be unique`,
        });
      }
    }
    const rootKeyIds = new Set(root.rootKeys.map(({ keyId }) => keyId));
    if (root.signatures.some(({ keyId }) => !rootKeyIds.has(keyId))) {
      context.addIssue({
        code: "custom",
        path: ["signatures"],
        message: "every signature must reference a declared root key",
      });
    }
    for (const [serviceIndex, service] of root.services.entries()) {
      for (const role of [
        "receiptKey",
        "clockKey",
        "closureKey",
        "logKey",
      ] as const) {
        const key = service[role];
        if (
          Date.parse(key.validFrom) < Date.parse(root.validFrom) ||
          Date.parse(key.validUntil) > Date.parse(root.validUntil)
        ) {
          context.addIssue({
            code: "custom",
            path: ["services", serviceIndex, role],
            message:
              "service role key validity must be contained by the trust root",
          });
        }
      }
    }
    const allRoleKeyIds = root.services.flatMap((service) => [
      service.receiptKey.keyId,
      service.clockKey.keyId,
      service.closureKey.keyId,
      service.logKey.keyId,
    ]);
    if (
      new Set([...rootKeyIds, ...allRoleKeyIds]).size !==
      rootKeyIds.size + allRoleKeyIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["services"],
        message:
          "threshold-root and online service role keys must be globally distinct",
      });
    }
  });

export const E3EventEnvelopeV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.eventEnvelope),
    schemaVersion: SchemaVersionV1Schema,
    campaignId: Sha256DigestV1Schema,
    assignmentId: Sha256DigestV1Schema,
    eventId: Sha256DigestV1Schema,
    ordinal: PositiveSafeIntegerV1Schema,
    previousHash: Sha256DigestV1Schema.nullable(),
    actorRole: E3ActorRoleV1Schema,
    actorKeyId: Sha256DigestV1Schema,
    eventKind: E3EventKindV1Schema,
    payloadSchemaId: IdentifierV1Schema,
    payloadHash: Sha256DigestV1Schema,
    signature: SignatureV1Schema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.actorRole !== E3_EVENT_ACTOR_ACL_V1[event.eventKind]) {
      context.addIssue({
        code: "custom",
        path: ["actorRole"],
        message: "actor role is not authorized for this event kind",
      });
    }
    if (
      event.payloadSchemaId !== E3_EVENT_PAYLOAD_SCHEMA_IDS_V1[event.eventKind]
    ) {
      context.addIssue({
        code: "custom",
        path: ["payloadSchemaId"],
        message: "payload schema is not authorized for this event kind",
      });
    }
    if (event.ordinal === 1 && event.previousHash !== null) {
      context.addIssue({
        code: "custom",
        path: ["previousHash"],
        message: "the first event must have a null previousHash",
      });
    }
    if (event.ordinal > 1 && event.previousHash === null) {
      context.addIssue({
        code: "custom",
        path: ["previousHash"],
        message: "events after the first must bind the previous event hash",
      });
    }
  });

const E3LeaseIdV1Schema = IdentifierV1Schema;

export const E3RegistrarAssignmentRegisteredPayloadV1Schema = z
  .object({
    assignmentId: Sha256DigestV1Schema,
    assignmentCommitment: Sha256DigestV1Schema,
    slotOrdinal: z.literal(0),
    registeredAt: IsoTimestampV1Schema,
  })
  .strict();

export const E3ConformanceActorStartedPayloadV1Schema = z
  .object({
    leaseId: E3LeaseIdV1Schema,
    startedAt: IsoTimestampV1Schema,
  })
  .strict();

export const E3ConformanceActorFinishedPayloadV1Schema = z
  .object({
    leaseId: E3LeaseIdV1Schema,
    finishedAt: IsoTimestampV1Schema,
  })
  .strict();

export const E3ConformanceCleanupProvenPayloadV1Schema = z
  .object({
    leaseId: E3LeaseIdV1Schema,
    observedAt: IsoTimestampV1Schema,
    processesEmpty: z.literal(true),
    cgroupEmpty: z.literal(true),
    storageEmpty: z.literal(true),
    networkLeaseClosed: z.literal(true),
    credentialLeaseRevoked: z.literal(true),
    observationCoverage: z.literal("complete"),
  })
  .strict();

export const E3RegistrarDeadlineElapsedPayloadV1Schema = z
  .object({
    deadline: IsoTimestampV1Schema,
    observedAt: IsoTimestampV1Schema,
  })
  .strict()
  .refine(
    (payload) => Date.parse(payload.observedAt) >= Date.parse(payload.deadline),
    {
      path: ["observedAt"],
      message: "deadline observation cannot precede the deadline",
    },
  );

export const E3RegistrarPrimaryClosedPayloadV1Schema = z
  .object({
    preClosureHead: Sha256DigestV1Schema,
    closedAt: IsoTimestampV1Schema,
    primaryOutcome: E3PrimaryOutcomeV1Schema,
  })
  .strict();

const journalVariant = <T extends E3EventKindV1>(
  eventKind: T,
  payloadSchema: z.ZodType,
) =>
  z
    .object({
      event: E3EventEnvelopeV1Schema.refine(
        (event) => event.eventKind === eventKind,
        { message: `expected ${eventKind} event` },
      ),
      payload: payloadSchema,
    })
    .strict();

export const E3JournalEntryV1Schema = z.union([
  journalVariant(
    "registrar_assignment_registered",
    E3RegistrarAssignmentRegisteredPayloadV1Schema,
  ),
  journalVariant(
    "conformance_actor_started",
    E3ConformanceActorStartedPayloadV1Schema,
  ),
  journalVariant(
    "conformance_actor_finished",
    E3ConformanceActorFinishedPayloadV1Schema,
  ),
  journalVariant(
    "conformance_cleanup_proven",
    E3ConformanceCleanupProvenPayloadV1Schema,
  ),
  journalVariant(
    "registrar_deadline_elapsed",
    E3RegistrarDeadlineElapsedPayloadV1Schema,
  ),
  journalVariant(
    "registrar_primary_closed",
    E3RegistrarPrimaryClosedPayloadV1Schema,
  ),
]);

export const E3JournalV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.journal),
    schemaVersion: SchemaVersionV1Schema,
    campaignId: Sha256DigestV1Schema,
    assignmentId: Sha256DigestV1Schema,
    events: z.array(E3JournalEntryV1Schema).min(1).max(64),
    eventCount: PositiveSafeIntegerV1Schema,
    journalHead: Sha256DigestV1Schema,
  })
  .strict()
  .refine((journal) => journal.eventCount === journal.events.length, {
    path: ["eventCount"],
    message: "eventCount must equal events.length",
  });

export const E3AppendReceiptV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.appendReceipt),
    schemaVersion: SchemaVersionV1Schema,
    campaignId: Sha256DigestV1Schema,
    assignmentId: Sha256DigestV1Schema,
    eventId: Sha256DigestV1Schema,
    eventHash: Sha256DigestV1Schema,
    journalHead: Sha256DigestV1Schema,
    ordinal: PositiveSafeIntegerV1Schema,
    commitSequence: PositiveSafeIntegerV1Schema,
    committedAt: IsoTimestampV1Schema,
    registrarServiceId: IdentifierV1Schema,
    receiptKeyId: Sha256DigestV1Schema,
    signature: SignatureV1Schema,
  })
  .strict();

export const E3OutcomeCountsV1Schema = z
  .object({
    conformanceComplete: SafeIntegerV1Schema,
    incompleteUnknown: SafeIntegerV1Schema,
    cleanupUnproven: SafeIntegerV1Schema,
  })
  .strict();

export const E3PrimaryClosureV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.primaryClosure),
    schemaVersion: SchemaVersionV1Schema,
    campaignId: Sha256DigestV1Schema,
    closureHash: Sha256DigestV1Schema,
    journalHead: Sha256DigestV1Schema,
    deadline: IsoTimestampV1Schema,
    closedAt: IsoTimestampV1Schema,
    primaryOutcome: E3PrimaryOutcomeV1Schema,
    assignmentCount: z.literal(1),
    outcomeCounts: E3OutcomeCountsV1Schema,
    eventCount: PositiveSafeIntegerV1Schema,
    appendAttemptCount: PositiveSafeIntegerV1Schema,
    rejectionCount: SafeIntegerV1Schema,
    idempotentReplayCount: SafeIntegerV1Schema,
    publicationState: z.literal("closure_sealed_publication_pending"),
    claimEligible: z.literal(false),
    modelCalls: z.literal(0),
    evaluatorRuns: z.literal(0),
    clockKeyId: Sha256DigestV1Schema,
    clockSignature: SignatureV1Schema,
    closureKeyId: Sha256DigestV1Schema,
    signature: SignatureV1Schema,
  })
  .strict()
  .superRefine((closure, context) => {
    const total =
      closure.outcomeCounts.conformanceComplete +
      closure.outcomeCounts.incompleteUnknown +
      closure.outcomeCounts.cleanupUnproven;
    if (total !== closure.assignmentCount) {
      context.addIssue({
        code: "custom",
        path: ["outcomeCounts"],
        message: "outcome counts must equal assignmentCount",
      });
    }
    if (
      closure.appendAttemptCount !==
      closure.eventCount +
        closure.rejectionCount +
        closure.idempotentReplayCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["appendAttemptCount"],
        message:
          "appendAttemptCount must retain accepted, rejected, and idempotently replayed appends",
      });
    }
  });

/**
 * Signed public observability for a registered campaign. This feed exposes a
 * registrar state observation; it is not transparency-log inclusion evidence.
 */
export const E3PublicPendingStatusV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.publicPendingStatus),
    schemaVersion: SchemaVersionV1Schema,
    campaignId: Sha256DigestV1Schema,
    deadline: IsoTimestampV1Schema,
    journalHead: Sha256DigestV1Schema,
    state: E3PublicPendingStateV1Schema,
    closureHash: Sha256DigestV1Schema.nullable(),
    observedAt: IsoTimestampV1Schema,
    registrarServiceId: IdentifierV1Schema,
    clockKeyId: Sha256DigestV1Schema,
    clockSignature: SignatureV1Schema,
    closureKeyId: Sha256DigestV1Schema,
    signature: SignatureV1Schema,
  })
  .strict()
  .superRefine((status, context) => {
    const expectsClosure = status.state !== "open";
    if (expectsClosure !== (status.closureHash !== null)) {
      context.addIssue({
        code: "custom",
        path: ["closureHash"],
        message:
          "closureHash must be absent while open and present once closure is sealed",
      });
    }
  });

export const E3RevisionEnvelopeV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.revisionEnvelope),
    schemaVersion: SchemaVersionV1Schema,
    campaignId: Sha256DigestV1Schema,
    primaryClosureHash: Sha256DigestV1Schema,
    revisionId: Sha256DigestV1Schema,
    revisionOrdinal: PositiveSafeIntegerV1Schema,
    previousRevisionHash: Sha256DigestV1Schema,
    lateEntry: E3JournalEntryV1Schema,
    receivedAt: IsoTimestampV1Schema,
    registrarKeyId: Sha256DigestV1Schema,
    signature: SignatureV1Schema,
  })
  .strict()
  .superRefine((revision, context) => {
    if (revision.lateEntry.event.campaignId !== revision.campaignId) {
      context.addIssue({
        code: "custom",
        path: ["lateEntry", "event", "campaignId"],
        message: "late event must belong to the revision campaign",
      });
    }
    if (
      revision.revisionOrdinal === 1 &&
      revision.previousRevisionHash !== revision.primaryClosureHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["previousRevisionHash"],
        message: "the first revision must be rooted at primaryClosureHash",
      });
    }
  });

/**
 * The actor submits only the event bytes it produced before learning anything
 * about primary closure. The registrar, not the caller, chooses and signs the
 * closure-rooted revision wrapper.
 */
export const E3LateAppendRequestV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.lateAppendRequest),
    schemaVersion: SchemaVersionV1Schema,
    campaignId: Sha256DigestV1Schema,
    lateEntry: E3JournalEntryV1Schema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.lateEntry.event.campaignId !== request.campaignId) {
      context.addIssue({
        code: "custom",
        path: ["lateEntry", "event", "campaignId"],
        message: "late event must belong to the requested campaign",
      });
    }
    if (request.lateEntry.event.actorRole === "registrar") {
      context.addIssue({
        code: "custom",
        path: ["lateEntry", "event", "actorRole"],
        message: "registrar-owned events cannot be submitted as late evidence",
      });
    }
  });

/**
 * A successful late append returns the registrar-created wrapper and its
 * independently signed append receipt. No registrar signing material is part
 * of the request DTO.
 */
export const E3LateAppendResultV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.lateAppendResult),
    schemaVersion: SchemaVersionV1Schema,
    campaignId: Sha256DigestV1Schema,
    revision: E3RevisionEnvelopeV1Schema,
    receipt: E3AppendReceiptV1Schema,
  })
  .strict()
  .superRefine((result, context) => {
    const { revision, receipt } = result;
    if (
      revision.campaignId !== result.campaignId ||
      receipt.campaignId !== result.campaignId
    ) {
      context.addIssue({
        code: "custom",
        path: ["campaignId"],
        message: "late append result must bind one campaign",
      });
    }
    if (
      receipt.assignmentId !== revision.lateEntry.event.assignmentId ||
      receipt.eventId !== revision.revisionId ||
      receipt.ordinal !== revision.revisionOrdinal
    ) {
      context.addIssue({
        code: "custom",
        path: ["receipt"],
        message: "late append receipt must bind the returned revision",
      });
    }
    if (Date.parse(receipt.committedAt) < Date.parse(revision.receivedAt)) {
      context.addIssue({
        code: "custom",
        path: ["receipt", "committedAt"],
        message: "late append receipt cannot precede registrar receipt",
      });
    }
  });

export const E3RevisionJournalCheckpointV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.revisionJournalCheckpoint),
    schemaVersion: SchemaVersionV1Schema,
    campaignId: Sha256DigestV1Schema,
    primaryClosureHash: Sha256DigestV1Schema,
    revisionHead: Sha256DigestV1Schema.nullable(),
    revisionCount: SafeIntegerV1Schema,
    latestKnownEventCount: PositiveSafeIntegerV1Schema,
    commitSequence: PositiveSafeIntegerV1Schema,
    asOf: IsoTimestampV1Schema,
    registrarServiceId: IdentifierV1Schema,
    closureKeyId: Sha256DigestV1Schema,
    signature: SignatureV1Schema,
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (
      (checkpoint.revisionCount === 0 && checkpoint.revisionHead !== null) ||
      (checkpoint.revisionCount > 0 && checkpoint.revisionHead === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["revisionHead"],
        message: "revisionHead presence must match revisionCount",
      });
    }
    if (checkpoint.latestKnownEventCount < checkpoint.revisionCount + 1) {
      context.addIssue({
        code: "custom",
        path: ["latestKnownEventCount"],
        message:
          "latestKnownEventCount cannot be smaller than retained revisions",
      });
    }
  });

export const E3TransparencyCheckpointV1Schema = z
  .object({
    logId: IdentifierV1Schema,
    treeSize: PositiveSafeIntegerV1Schema,
    rootHash: Sha256DigestV1Schema,
    issuedAt: IsoTimestampV1Schema,
    logKeyId: Sha256DigestV1Schema,
    signature: SignatureV1Schema,
  })
  .strict();

export const E3MerkleInclusionProofV1Schema = z
  .object({
    leafIndex: SafeIntegerV1Schema,
    treeSize: PositiveSafeIntegerV1Schema,
    auditPath: z.array(Sha256DigestV1Schema).max(64),
  })
  .strict()
  .refine((proof) => proof.leafIndex < proof.treeSize, {
    path: ["leafIndex"],
    message: "leafIndex must be smaller than treeSize",
  });

export const E3MerkleConsistencyProofV1Schema = z
  .object({
    firstTreeSize: PositiveSafeIntegerV1Schema,
    secondTreeSize: PositiveSafeIntegerV1Schema,
    auditPath: z.array(Sha256DigestV1Schema).max(64),
  })
  .strict()
  .refine((proof) => proof.firstTreeSize <= proof.secondTreeSize, {
    path: ["firstTreeSize"],
    message: "firstTreeSize must not exceed secondTreeSize",
  });

export const E3PublicationProofV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.publicationProof),
    schemaVersion: SchemaVersionV1Schema,
    campaignId: Sha256DigestV1Schema,
    closureHash: Sha256DigestV1Schema,
    registrationCheckpoint: E3TransparencyCheckpointV1Schema,
    closureCheckpoint: E3TransparencyCheckpointV1Schema,
    closureInclusionProof: E3MerkleInclusionProofV1Schema,
    registrationToClosureConsistencyProof: E3MerkleConsistencyProofV1Schema,
  })
  .strict()
  .superRefine((proof, context) => {
    if (proof.registrationCheckpoint.logId !== proof.closureCheckpoint.logId) {
      context.addIssue({
        code: "custom",
        path: ["closureCheckpoint", "logId"],
        message: "publication checkpoints must come from the same log",
      });
    }
    if (
      proof.closureCheckpoint.treeSize <= proof.registrationCheckpoint.treeSize
    ) {
      context.addIssue({
        code: "custom",
        path: ["closureCheckpoint", "treeSize"],
        message:
          "closure publication must advance beyond the registration checkpoint",
      });
    }
    if (
      proof.closureInclusionProof.treeSize !== proof.closureCheckpoint.treeSize
    ) {
      context.addIssue({
        code: "custom",
        path: ["closureInclusionProof", "treeSize"],
        message: "inclusion proof must bind the closure checkpoint tree size",
      });
    }
    if (
      proof.registrationToClosureConsistencyProof.firstTreeSize !==
        proof.registrationCheckpoint.treeSize ||
      proof.registrationToClosureConsistencyProof.secondTreeSize !==
        proof.closureCheckpoint.treeSize
    ) {
      context.addIssue({
        code: "custom",
        path: ["registrationToClosureConsistencyProof"],
        message: "consistency proof sizes must bind both checkpoints",
      });
    }
  });

export const E3CampaignRegistrationProofV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.registrationProof),
    schemaVersion: SchemaVersionV1Schema,
    campaignId: Sha256DigestV1Schema,
    checkpoint: E3TransparencyCheckpointV1Schema,
    inclusionProof: E3MerkleInclusionProofV1Schema,
  })
  .strict()
  .refine(
    (proof) => proof.inclusionProof.treeSize === proof.checkpoint.treeSize,
    {
      path: ["inclusionProof", "treeSize"],
      message: "registration inclusion proof must bind its checkpoint",
    },
  );

export const E3SanitizedSummaryV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.sanitizedSummary),
    schemaVersion: SchemaVersionV1Schema,
    capability: z.literal("campaign_denominator_conformance"),
    campaignPurpose: z.literal("registrar_conformance"),
    viewKind: z.literal("latest_known"),
    publicationState: z.literal("closure_published"),
    claimEligible: z.literal(false),
    modelCalls: z.literal(0),
    evaluatorRuns: z.literal(0),
    artifactSinkMode: z.literal(E3_ARTIFACT_SINK_MODE_V1),
    artifactSinkId: IdentifierV1Schema,
    artifactSinkCommitment: Sha256DigestV1Schema,
    productSha256: Sha256DigestV1Schema,
    runnerSha256: Sha256DigestV1Schema,
    validatorSha256: Sha256DigestV1Schema,
    trustRootVersion: IdentifierV1Schema,
    trustRootFileSha256: Sha256DigestV1Schema,
    trustRootFreezeRecordSha256: Sha256DigestV1Schema,
    trustRootExternalPinSha256: Sha256DigestV1Schema,
    registrarServiceId: IdentifierV1Schema,
    tlsSpkiId: Sha256DigestV1Schema,
    registrarKeyIds: z
      .object({
        receipt: Sha256DigestV1Schema,
        clock: Sha256DigestV1Schema,
        closure: Sha256DigestV1Schema,
        log: Sha256DigestV1Schema,
      })
      .strict(),
    actorKeyIds: z
      .object({
        conformance: Sha256DigestV1Schema,
        cleanup: Sha256DigestV1Schema,
      })
      .strict(),
    campaignId: Sha256DigestV1Schema,
    assignmentIds: z.tuple([Sha256DigestV1Schema]),
    assignmentCount: z.literal(1),
    eventCount: PositiveSafeIntegerV1Schema,
    appendAttemptCount: PositiveSafeIntegerV1Schema,
    idempotentReplayCount: SafeIntegerV1Schema,
    revisionCount: SafeIntegerV1Schema,
    latestKnownEventCount: PositiveSafeIntegerV1Schema,
    rejectionCount: SafeIntegerV1Schema,
    closureCount: z.literal(1),
    primaryOutcome: E3PrimaryOutcomeV1Schema,
    outcomeCounts: E3OutcomeCountsV1Schema,
    journalHead: Sha256DigestV1Schema,
    closureHash: Sha256DigestV1Schema,
    deadline: IsoTimestampV1Schema,
    closedAt: IsoTimestampV1Schema,
    cleanupReceiptHash: Sha256DigestV1Schema.nullable(),
    revisionCheckpointHash: Sha256DigestV1Schema,
    registrationCheckpointRoot: Sha256DigestV1Schema,
    registrationCheckpointTreeSize: PositiveSafeIntegerV1Schema,
    registrationCheckpointIssuedAt: IsoTimestampV1Schema,
    checkpointRoot: Sha256DigestV1Schema,
    checkpointTreeSize: PositiveSafeIntegerV1Schema,
    checkpointIssuedAt: IsoTimestampV1Schema,
    registrationInclusionProofHash: Sha256DigestV1Schema,
    inclusionProofHash: Sha256DigestV1Schema,
    consistencyProofHash: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.assignmentIds.length !== summary.assignmentCount) {
      context.addIssue({
        code: "custom",
        path: ["assignmentIds"],
        message: "assignmentIds length must equal assignmentCount",
      });
    }
    if (new Set(summary.assignmentIds).size !== summary.assignmentIds.length) {
      context.addIssue({
        code: "custom",
        path: ["assignmentIds"],
        message: "assignmentIds must be unique",
      });
    }
    if (new Set(Object.values(summary.registrarKeyIds)).size !== 4) {
      context.addIssue({
        code: "custom",
        path: ["registrarKeyIds"],
        message: "registrar role key identities must be distinct",
      });
    }
    const allOperationalKeyIds = [
      ...Object.values(summary.registrarKeyIds),
      ...Object.values(summary.actorKeyIds),
    ];
    if (new Set(allOperationalKeyIds).size !== allOperationalKeyIds.length) {
      context.addIssue({
        code: "custom",
        path: ["actorKeyIds"],
        message: "registrar and actor role key identities must be distinct",
      });
    }
  });

export const E3EvidenceActorKeyV1Schema = E3RolePublicKeyV1Schema.extend({
  actorRole: z.enum(["conformance_actor", "cleanup_actor"]),
}).strict();

const E3_FORBIDDEN_EVIDENCE_VOCABULARY_V1 =
  /(?:candidate|scenario|accepted|rejected|acceptance)/iu;

export const E3CampaignConformanceEvidenceV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.campaignEvidence),
    schemaVersion: SchemaVersionV1Schema,
    trustRoot: E3RegistrarTrustRootV1Schema,
    actorKeys: z.tuple([
      E3EvidenceActorKeyV1Schema,
      E3EvidenceActorKeyV1Schema,
    ]),
    manifest: E3CampaignManifestV1Schema,
    registrationProof: E3CampaignRegistrationProofV1Schema,
    journal: E3JournalV1Schema,
    appendReceipts: z.array(E3AppendReceiptV1Schema).min(1).max(64),
    primaryClosure: E3PrimaryClosureV1Schema,
    revisions: z.array(E3RevisionEnvelopeV1Schema).max(64),
    revisionReceipts: z.array(E3AppendReceiptV1Schema).max(64),
    revisionJournalCheckpoint: E3RevisionJournalCheckpointV1Schema,
    publicationProof: E3PublicationProofV1Schema,
    rejectionCount: SafeIntegerV1Schema,
    summary: E3SanitizedSummaryV1Schema,
  })
  .strict()
  .superRefine((evidence, context) => {
    const roles = new Set(evidence.actorKeys.map(({ actorRole }) => actorRole));
    if (
      roles.size !== 2 ||
      !roles.has("conformance_actor") ||
      !roles.has("cleanup_actor")
    ) {
      context.addIssue({
        code: "custom",
        path: ["actorKeys"],
        message: "actorKeys must contain exactly one key for each actor role",
      });
    }
    const slot = evidence.manifest.assignments[0];
    for (const actor of evidence.actorKeys) {
      const expected =
        actor.actorRole === "conformance_actor"
          ? slot.conformanceActorKeyId
          : slot.cleanupActorKeyId;
      if (actor.keyId !== expected) {
        context.addIssue({
          code: "custom",
          path: ["actorKeys"],
          message: "actor key identity does not match the manifest assignment",
        });
      }
    }
    const nonActorKeyIds = new Set([
      ...evidence.trustRoot.rootKeys.map(({ keyId }) => keyId),
      ...evidence.trustRoot.services.flatMap((service) => [
        service.receiptKey.keyId,
        service.clockKey.keyId,
        service.closureKey.keyId,
        service.logKey.keyId,
      ]),
    ]);
    if (evidence.actorKeys.some(({ keyId }) => nonActorKeyIds.has(keyId))) {
      context.addIssue({
        code: "custom",
        path: ["actorKeys"],
        message:
          "actor keys must be distinct from threshold-root and registrar service role keys",
      });
    }
    if (evidence.appendReceipts.length !== evidence.journal.eventCount) {
      context.addIssue({
        code: "custom",
        path: ["appendReceipts"],
        message: "every retained primary event must have one append receipt",
      });
    }
    if (evidence.revisionReceipts.length !== evidence.revisions.length) {
      context.addIssue({
        code: "custom",
        path: ["revisionReceipts"],
        message: "every retained revision must have one append receipt",
      });
    }
    const latestReceipt =
      evidence.revisionReceipts.at(-1) ?? evidence.appendReceipts.at(-1);
    if (
      evidence.revisionJournalCheckpoint.campaignId !==
        evidence.primaryClosure.campaignId ||
      evidence.revisionJournalCheckpoint.primaryClosureHash !==
        evidence.primaryClosure.closureHash ||
      evidence.revisionJournalCheckpoint.revisionCount !==
        evidence.revisions.length ||
      evidence.revisionJournalCheckpoint.latestKnownEventCount !==
        evidence.journal.eventCount + evidence.revisions.length ||
      latestReceipt === undefined ||
      evidence.revisionJournalCheckpoint.commitSequence !==
        latestReceipt.commitSequence ||
      Date.parse(evidence.revisionJournalCheckpoint.asOf) <
        Date.parse(latestReceipt.committedAt) ||
      Date.parse(evidence.revisionJournalCheckpoint.asOf) <
        Date.parse(evidence.primaryClosure.closedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["revisionJournalCheckpoint"],
        message:
          "revision journal checkpoint must bind the complete post-closure chain",
      });
    }
    if (
      evidence.summary.revisionCount !== evidence.revisions.length ||
      evidence.summary.latestKnownEventCount !==
        evidence.journal.eventCount + evidence.revisions.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["summary", "revisionCount"],
        message: "summary revision counts do not match the retained chains",
      });
    }
    if (
      evidence.summary.artifactSinkMode !==
        evidence.manifest.artifactSinkMode ||
      evidence.summary.artifactSinkId !== evidence.manifest.artifactSinkId ||
      evidence.summary.artifactSinkCommitment !==
        evidence.manifest.artifactSinkCommitment ||
      evidence.summary.primaryOutcome !==
        evidence.primaryClosure.primaryOutcome ||
      evidence.summary.outcomeCounts.conformanceComplete !==
        evidence.primaryClosure.outcomeCounts.conformanceComplete ||
      evidence.summary.outcomeCounts.incompleteUnknown !==
        evidence.primaryClosure.outcomeCounts.incompleteUnknown ||
      evidence.summary.outcomeCounts.cleanupUnproven !==
        evidence.primaryClosure.outcomeCounts.cleanupUnproven ||
      evidence.summary.deadline !== evidence.primaryClosure.deadline ||
      evidence.summary.closedAt !== evidence.primaryClosure.closedAt ||
      evidence.summary.registrationCheckpointRoot !==
        evidence.registrationProof.checkpoint.rootHash ||
      evidence.summary.registrationCheckpointTreeSize !==
        evidence.registrationProof.checkpoint.treeSize ||
      evidence.summary.registrationCheckpointIssuedAt !==
        evidence.registrationProof.checkpoint.issuedAt ||
      evidence.summary.checkpointRoot !==
        evidence.publicationProof.closureCheckpoint.rootHash ||
      evidence.summary.checkpointTreeSize !==
        evidence.publicationProof.closureCheckpoint.treeSize ||
      evidence.summary.checkpointIssuedAt !==
        evidence.publicationProof.closureCheckpoint.issuedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["summary"],
        message: "summary lifecycle, cleanup, revision, or log binding differs",
      });
    }
    if (
      evidence.rejectionCount !== evidence.primaryClosure.rejectionCount ||
      evidence.summary.rejectionCount !==
        evidence.primaryClosure.rejectionCount ||
      evidence.summary.appendAttemptCount !==
        evidence.primaryClosure.appendAttemptCount ||
      evidence.summary.idempotentReplayCount !==
        evidence.primaryClosure.idempotentReplayCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["summary", "appendAttemptCount"],
        message:
          "summary attempt metrics do not match the signed primary closure",
      });
    }
    if (E3_FORBIDDEN_EVIDENCE_VOCABULARY_V1.test(JSON.stringify(evidence))) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "E3.1 evidence contains forbidden evaluation vocabulary",
      });
    }
  });

export const E3ClosedEvidenceSnapshotV1Schema = z
  .object({
    schemaId: z.literal(E3_SCHEMA_IDS_V1.closedEvidenceSnapshot),
    schemaVersion: SchemaVersionV1Schema,
    campaignId: Sha256DigestV1Schema,
    assignmentId: Sha256DigestV1Schema,
    journal: E3JournalV1Schema,
    appendReceipts: z.array(E3AppendReceiptV1Schema).min(1).max(64),
    primaryClosure: E3PrimaryClosureV1Schema,
    revisions: z.array(E3RevisionEnvelopeV1Schema).max(64),
    revisionReceipts: z.array(E3AppendReceiptV1Schema).max(64),
    revisionJournalCheckpoint: E3RevisionJournalCheckpointV1Schema,
    publicationProof: E3PublicationProofV1Schema,
    rejectionCount: SafeIntegerV1Schema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.appendReceipts.length !== snapshot.journal.eventCount) {
      context.addIssue({
        code: "custom",
        path: ["appendReceipts"],
        message: "every retained primary event must have one append receipt",
      });
    }
    if (snapshot.revisionReceipts.length !== snapshot.revisions.length) {
      context.addIssue({
        code: "custom",
        path: ["revisionReceipts"],
        message: "every retained revision must have one append receipt",
      });
    }
    const latestReceipt =
      snapshot.revisionReceipts.at(-1) ?? snapshot.appendReceipts.at(-1);
    if (
      snapshot.revisionJournalCheckpoint.campaignId !== snapshot.campaignId ||
      snapshot.revisionJournalCheckpoint.primaryClosureHash !==
        snapshot.primaryClosure.closureHash ||
      snapshot.revisionJournalCheckpoint.revisionCount !==
        snapshot.revisions.length ||
      snapshot.revisionJournalCheckpoint.latestKnownEventCount !==
        snapshot.journal.eventCount + snapshot.revisions.length ||
      latestReceipt === undefined ||
      snapshot.revisionJournalCheckpoint.commitSequence !==
        latestReceipt.commitSequence ||
      Date.parse(snapshot.revisionJournalCheckpoint.asOf) <
        Date.parse(latestReceipt.committedAt) ||
      Date.parse(snapshot.revisionJournalCheckpoint.asOf) <
        Date.parse(snapshot.primaryClosure.closedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["revisionJournalCheckpoint"],
        message:
          "revision journal checkpoint must bind the complete post-closure chain",
      });
    }
    if (snapshot.rejectionCount !== snapshot.primaryClosure.rejectionCount) {
      context.addIssue({
        code: "custom",
        path: ["rejectionCount"],
        message:
          "snapshot rejectionCount must match the signed primary closure",
      });
    }
  });

export type E3EventKindV1 = z.infer<typeof E3EventKindV1Schema>;
export type E3PrimaryOutcomeV1 = z.infer<typeof E3PrimaryOutcomeV1Schema>;
export type E3ActorRoleV1 = z.infer<typeof E3ActorRoleV1Schema>;
export type E3AssignmentSlotV1 = z.infer<typeof E3AssignmentSlotV1Schema>;
export type E3RegistrarTrustRootV1 = z.infer<
  typeof E3RegistrarTrustRootV1Schema
>;
export type E3RegistrarServiceBindingV1 = z.infer<
  typeof E3RegistrarServiceBindingV1Schema
>;
export type E3CampaignManifestV1 = z.infer<typeof E3CampaignManifestV1Schema>;
export type E3EventEnvelopeV1 = z.infer<typeof E3EventEnvelopeV1Schema>;
export type E3JournalEntryV1 = z.infer<typeof E3JournalEntryV1Schema>;
export type E3JournalV1 = z.infer<typeof E3JournalV1Schema>;
export type E3AppendReceiptV1 = z.infer<typeof E3AppendReceiptV1Schema>;
export type E3PrimaryClosureV1 = z.infer<typeof E3PrimaryClosureV1Schema>;
export type E3PublicPendingStateV1 = z.infer<
  typeof E3PublicPendingStateV1Schema
>;
export type E3PublicPendingStatusV1 = z.infer<
  typeof E3PublicPendingStatusV1Schema
>;
export type E3RevisionEnvelopeV1 = z.infer<typeof E3RevisionEnvelopeV1Schema>;
export type E3LateAppendRequestV1 = z.infer<typeof E3LateAppendRequestV1Schema>;
export type E3LateAppendResultV1 = z.infer<typeof E3LateAppendResultV1Schema>;
export type E3RevisionJournalCheckpointV1 = z.infer<
  typeof E3RevisionJournalCheckpointV1Schema
>;
export type E3TransparencyCheckpointV1 = z.infer<
  typeof E3TransparencyCheckpointV1Schema
>;
export type E3PublicationProofV1 = z.infer<typeof E3PublicationProofV1Schema>;
export type E3CampaignRegistrationProofV1 = z.infer<
  typeof E3CampaignRegistrationProofV1Schema
>;
export type E3SanitizedSummaryV1 = z.infer<typeof E3SanitizedSummaryV1Schema>;
export type E3EvidenceActorKeyV1 = z.infer<typeof E3EvidenceActorKeyV1Schema>;
export type E3CampaignConformanceEvidenceV1 = z.infer<
  typeof E3CampaignConformanceEvidenceV1Schema
>;
export type E3ClosedEvidenceSnapshotV1 = z.infer<
  typeof E3ClosedEvidenceSnapshotV1Schema
>;
