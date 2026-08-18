import { describe, expect, it } from "vitest";

import { asSha256DigestV1, type JsonValue } from "@chronorift/domain";

import {
  assignmentIdV1,
  campaignIdV1,
  canonicalContentHashV1,
  eventIdV1,
  revisionIdV1,
} from "./canonical.js";
import {
  E3_EVENT_ACTOR_ACL_V1,
  E3_EVENT_PAYLOAD_SCHEMA_IDS_V1,
  E3_SCHEMA_IDS_V1,
  type E3ActorRoleV1,
  type E3AppendReceiptV1,
  type E3CampaignManifestV1,
  type E3EventKindV1,
  type E3JournalEntryV1,
  type E3JournalV1,
  type E3PrimaryClosureV1,
} from "./contracts.js";
import {
  eventHashV1,
  projectPrimaryClosureV1,
  projectRevisionJournalV1,
  revisionHashV1,
  validatePrimaryClosureV1,
} from "./projector.js";

const digest = (character: string) => asSha256DigestV1(character.repeat(64));
const signature = "A".repeat(86);
const timestamp = "2026-08-11T00:00:00.000Z";
const deadline = "2026-08-11T00:10:00.000Z";

const manifest = (): E3CampaignManifestV1 => ({
  schemaId: E3_SCHEMA_IDS_V1.campaignManifest,
  schemaVersion: 1,
  campaignPurpose: "registrar_conformance",
  claimEligible: false,
  modelCalls: 0,
  evaluatorRuns: 0,
  artifactSinkMode: "configured_external_ci_artifact_directory_v1",
  artifactSinkId: "sink.test",
  artifactSinkCommitment: digest("f"),
  namespace: "chronorift/e3/test",
  registrarServiceId: "registrar.test",
  trustRootVersion: "test-v1",
  productSha256: digest("1"),
  runnerSha256: digest("2"),
  validatorSha256: digest("3"),
  deadline,
  assignmentCount: 1 as const,
  assignments: [
    {
      slotOrdinal: 0,
      assignmentCommitment: digest("4"),
      conformanceActorKeyId: digest("5"),
      cleanupActorKeyId: digest("6"),
    },
  ],
});

const entry = (input: {
  readonly campaignId: string;
  readonly assignmentId: string;
  readonly ordinal: number;
  readonly previousHash: string | null;
  readonly eventKind: E3EventKindV1;
  readonly payload: JsonValue;
  readonly actorKeyId?: string;
}): E3JournalEntryV1 => {
  const payloadHash = canonicalContentHashV1(input.payload);
  return {
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
      actorRole: E3_EVENT_ACTOR_ACL_V1[input.eventKind] as E3ActorRoleV1,
      actorKeyId: input.actorKeyId ?? digest("7"),
      eventKind: input.eventKind,
      payloadSchemaId: E3_EVENT_PAYLOAD_SCHEMA_IDS_V1[input.eventKind],
      payloadHash,
      signature,
    },
    payload: input.payload,
  } as E3JournalEntryV1;
};

const appendReceipts = (
  journal: E3JournalV1,
  closureCommittedAt: string,
): E3AppendReceiptV1[] =>
  journal.events.map((journalEntry, index) => {
    const eventHash = eventHashV1(journalEntry);
    const committedAt =
      journalEntry.event.eventKind === "registrar_deadline_elapsed" ||
      journalEntry.event.eventKind === "registrar_primary_closed"
        ? closureCommittedAt
        : timestamp;
    return {
      schemaId: E3_SCHEMA_IDS_V1.appendReceipt,
      schemaVersion: 1,
      campaignId: journal.campaignId,
      assignmentId: journal.assignmentId,
      eventId: journalEntry.event.eventId,
      eventHash,
      journalHead: eventHash,
      ordinal: journalEntry.event.ordinal,
      commitSequence: index + 1,
      committedAt,
      registrarServiceId: "registrar.test",
      receiptKeyId: digest("8"),
      signature,
    };
  });

const completeFixture = (): {
  readonly manifest: E3CampaignManifestV1;
  readonly journal: E3JournalV1;
  readonly appendReceipts: readonly E3AppendReceiptV1[];
  readonly closure: E3PrimaryClosureV1;
} => {
  const campaignManifest = manifest();
  const campaignId = campaignIdV1(campaignManifest as unknown as JsonValue);
  const slot = campaignManifest.assignments[0];
  const assignmentId = assignmentIdV1({
    campaignId,
    slotOrdinal: slot.slotOrdinal,
    assignmentCommitment: slot.assignmentCommitment,
  });
  const entries: E3JournalEntryV1[] = [];
  const append = (
    eventKind: E3EventKindV1,
    payload: JsonValue,
    actorKeyId?: string,
  ) => {
    const previousHash =
      entries.length === 0 ? null : eventHashV1(entries.at(-1)!);
    entries.push(
      entry({
        campaignId,
        assignmentId,
        ordinal: entries.length + 1,
        previousHash,
        eventKind,
        payload,
        ...(actorKeyId === undefined ? {} : { actorKeyId }),
      }),
    );
  };
  append(
    "registrar_assignment_registered",
    {
      assignmentId,
      assignmentCommitment: slot.assignmentCommitment,
      slotOrdinal: 0,
      registeredAt: timestamp,
    },
    digest("8"),
  );
  append(
    "conformance_actor_started",
    { leaseId: "lease:test", startedAt: timestamp },
    slot.conformanceActorKeyId,
  );
  append(
    "conformance_actor_finished",
    { leaseId: "lease:test", finishedAt: timestamp },
    slot.conformanceActorKeyId,
  );
  append(
    "conformance_cleanup_proven",
    {
      leaseId: "lease:test",
      observedAt: timestamp,
      processesEmpty: true,
      cgroupEmpty: true,
      storageEmpty: true,
      networkLeaseClosed: true,
      credentialLeaseRevoked: true,
      observationCoverage: "complete",
    },
    slot.cleanupActorKeyId,
  );
  append(
    "registrar_primary_closed",
    {
      preClosureHead: eventHashV1(entries.at(-1)!),
      closedAt: timestamp,
      primaryOutcome: "conformance_complete",
    },
    digest("8"),
  );
  const journal: E3JournalV1 = {
    schemaId: E3_SCHEMA_IDS_V1.journal,
    schemaVersion: 1,
    campaignId,
    assignmentId,
    events: entries,
    eventCount: entries.length,
    journalHead: eventHashV1(entries.at(-1)!),
  };
  const closureHashBasis = {
    schemaId: E3_SCHEMA_IDS_V1.primaryClosure,
    schemaVersion: 1 as const,
    campaignId,
    journalHead: journal.journalHead,
    deadline,
    closedAt: timestamp,
    primaryOutcome: "conformance_complete" as const,
    assignmentCount: 1 as const,
    outcomeCounts: {
      conformanceComplete: 1,
      incompleteUnknown: 0,
      cleanupUnproven: 0,
    },
    eventCount: entries.length,
    appendAttemptCount: entries.length,
    rejectionCount: 0,
    idempotentReplayCount: 0,
    publicationState: "closure_sealed_publication_pending" as const,
    claimEligible: false as const,
    modelCalls: 0 as const,
    evaluatorRuns: 0 as const,
    clockKeyId: digest("9"),
    clockSignature: signature,
    closureKeyId: digest("a"),
  };
  return {
    manifest: campaignManifest,
    journal,
    appendReceipts: appendReceipts(journal, timestamp),
    closure: {
      ...closureHashBasis,
      closureHash: canonicalContentHashV1(
        closureHashBasis as unknown as JsonValue,
      ),
      signature,
    },
  };
};

const incompleteFixture = (): {
  readonly manifest: E3CampaignManifestV1;
  readonly journal: E3JournalV1;
  readonly appendReceipts: readonly E3AppendReceiptV1[];
  readonly closure: E3PrimaryClosureV1;
} => {
  const campaignManifest = manifest();
  const campaignId = campaignIdV1(campaignManifest as unknown as JsonValue);
  const slot = campaignManifest.assignments[0];
  const assignmentId = assignmentIdV1({
    campaignId,
    slotOrdinal: slot.slotOrdinal,
    assignmentCommitment: slot.assignmentCommitment,
  });
  const entries: E3JournalEntryV1[] = [];
  const append = (
    eventKind: E3EventKindV1,
    payload: JsonValue,
    actorKeyId?: string,
  ) => {
    entries.push(
      entry({
        campaignId,
        assignmentId,
        ordinal: entries.length + 1,
        previousHash:
          entries.length === 0 ? null : eventHashV1(entries.at(-1)!),
        eventKind,
        payload,
        ...(actorKeyId === undefined ? {} : { actorKeyId }),
      }),
    );
  };
  append(
    "registrar_assignment_registered",
    {
      assignmentId,
      assignmentCommitment: slot.assignmentCommitment,
      slotOrdinal: 0,
      registeredAt: timestamp,
    },
    digest("8"),
  );
  append(
    "conformance_actor_started",
    { leaseId: "lease:test", startedAt: timestamp },
    slot.conformanceActorKeyId,
  );
  append(
    "registrar_deadline_elapsed",
    { deadline, observedAt: deadline },
    digest("8"),
  );
  append(
    "registrar_primary_closed",
    {
      preClosureHead: eventHashV1(entries.at(-1)!),
      closedAt: deadline,
      primaryOutcome: "incomplete_unknown",
    },
    digest("8"),
  );
  const journal: E3JournalV1 = {
    schemaId: E3_SCHEMA_IDS_V1.journal,
    schemaVersion: 1,
    campaignId,
    assignmentId,
    events: entries,
    eventCount: entries.length,
    journalHead: eventHashV1(entries.at(-1)!),
  };
  const closureHashBasis = {
    schemaId: E3_SCHEMA_IDS_V1.primaryClosure,
    schemaVersion: 1 as const,
    campaignId,
    journalHead: journal.journalHead,
    deadline,
    closedAt: deadline,
    primaryOutcome: "incomplete_unknown" as const,
    assignmentCount: 1 as const,
    outcomeCounts: {
      conformanceComplete: 0,
      incompleteUnknown: 1,
      cleanupUnproven: 0,
    },
    eventCount: entries.length,
    appendAttemptCount: entries.length,
    rejectionCount: 0,
    idempotentReplayCount: 0,
    publicationState: "closure_sealed_publication_pending" as const,
    claimEligible: false as const,
    modelCalls: 0 as const,
    evaluatorRuns: 0 as const,
    clockKeyId: digest("9"),
    clockSignature: signature,
    closureKeyId: digest("a"),
  };
  return {
    manifest: campaignManifest,
    journal,
    appendReceipts: appendReceipts(journal, deadline),
    closure: {
      ...closureHashBasis,
      closureHash: canonicalContentHashV1(
        closureHashBasis as unknown as JsonValue,
      ),
      signature,
    },
  };
};

describe("E3.1 primary and revision projector", () => {
  it("projects only retained finished plus cleanup events as complete", () => {
    const fixture = completeFixture();
    expect(projectPrimaryClosureV1(fixture)).toMatchObject({
      primaryOutcome: "conformance_complete",
      eventCount: 5,
    });
    expect(validatePrimaryClosureV1(fixture)).toEqual(fixture.closure);
  });

  it("rejects a changed payload even when the claimed event hash is retained", () => {
    const fixture = completeFixture();
    const changed = structuredClone(fixture.journal);
    changed.events[1]!.payload = {
      leaseId: "lease:changed",
      startedAt: timestamp,
    };
    expect(() =>
      projectPrimaryClosureV1({
        manifest: fixture.manifest,
        journal: changed,
      }),
    ).toThrow(/payload hash/u);
  });

  it("rejects a finish committed at the deadline from masquerading as early complete", () => {
    const fixture = completeFixture();
    const changedReceipts = structuredClone(fixture.appendReceipts);
    changedReceipts[2]!.committedAt = deadline;
    expect(() =>
      validatePrimaryClosureV1({
        ...fixture,
        appendReceipts: changedReceipts,
      }),
    ).toThrow(/strictly before/u);
  });

  it("rejects a finish retained after the deadline event from masquerading as complete", () => {
    const fixture = incompleteFixture();
    const entries = fixture.journal.events.slice(0, 3);
    const finish = entry({
      campaignId: fixture.journal.campaignId,
      assignmentId: fixture.journal.assignmentId,
      ordinal: 4,
      previousHash: eventHashV1(entries.at(-1)!),
      eventKind: "conformance_actor_finished",
      payload: { leaseId: "lease:test", finishedAt: deadline },
      actorKeyId: fixture.manifest.assignments[0].conformanceActorKeyId,
    });
    entries.push(finish);
    expect(() =>
      projectPrimaryClosureV1({
        manifest: fixture.manifest,
        journal: {
          ...fixture.journal,
          events: entries,
          eventCount: entries.length,
          journalHead: eventHashV1(entries.at(-1)!),
        },
      }),
    ).toThrow(/finish is duplicate, unowned, or out of order/u);
  });

  it("rejects a deadline event inserted after cleanup", () => {
    const fixture = completeFixture();
    const entries = fixture.journal.events.slice(0, 4);
    const deadlineEntry = entry({
      campaignId: fixture.journal.campaignId,
      assignmentId: fixture.journal.assignmentId,
      ordinal: 5,
      previousHash: eventHashV1(entries.at(-1)!),
      eventKind: "registrar_deadline_elapsed",
      payload: { deadline, observedAt: deadline },
      actorKeyId: digest("8"),
    });
    entries.push(deadlineEntry);
    entries.push(
      entry({
        campaignId: fixture.journal.campaignId,
        assignmentId: fixture.journal.assignmentId,
        ordinal: 6,
        previousHash: eventHashV1(deadlineEntry),
        eventKind: "registrar_primary_closed",
        payload: {
          preClosureHead: eventHashV1(deadlineEntry),
          closedAt: deadline,
          primaryOutcome: "conformance_complete",
        },
        actorKeyId: digest("8"),
      }),
    );
    const journal = {
      ...fixture.journal,
      events: entries,
      eventCount: entries.length,
      journalHead: eventHashV1(entries.at(-1)!),
    };
    expect(() =>
      projectPrimaryClosureV1({ manifest: fixture.manifest, journal }),
    ).toThrow(/deadline event/u);
  });

  it("requires exact closure time and strictly increasing receipt sequence", () => {
    const fixture = completeFixture();
    const changedTime = structuredClone(fixture.appendReceipts);
    changedTime.at(-1)!.committedAt = "2026-08-11T00:00:01.000Z";
    expect(() =>
      validatePrimaryClosureV1({ ...fixture, appendReceipts: changedTime }),
    ).toThrow(/exact closedAt/u);

    const changedSequence = structuredClone(fixture.appendReceipts);
    changedSequence[2]!.commitSequence = changedSequence[1]!.commitSequence;
    expect(() =>
      validatePrimaryClosureV1({
        ...fixture,
        appendReceipts: changedSequence,
      }),
    ).toThrow(/strictly increase/u);
  });

  it("keeps deadline-race finish and cleanup bytes on their original branch", () => {
    const fixture = incompleteFixture();
    const primaryStart = fixture.journal.events[1]!;
    const lateFinish = entry({
      campaignId: fixture.journal.campaignId,
      assignmentId: fixture.journal.assignmentId,
      ordinal: 3,
      previousHash: eventHashV1(primaryStart),
      eventKind: "conformance_actor_finished",
      payload: { leaseId: "lease:test", finishedAt: timestamp },
      actorKeyId: fixture.manifest.assignments[0].conformanceActorKeyId,
    });
    const firstRevisionBasis = {
      schemaId: E3_SCHEMA_IDS_V1.revisionEnvelope,
      schemaVersion: 1 as const,
      campaignId: fixture.journal.campaignId,
      primaryClosureHash: fixture.closure.closureHash,
      revisionOrdinal: 1,
      previousRevisionHash: fixture.closure.closureHash,
      lateEntry: lateFinish,
      // Projection preserves registrar bytes and does not infer chronology
      // from this field; the signed receipt proves post-closure commit order.
      receivedAt: "2026-08-11T00:09:59.000Z",
      registrarKeyId: digest("8"),
      signature,
    };
    const firstRevision = {
      ...firstRevisionBasis,
      revisionId: revisionIdV1({
        campaignId: firstRevisionBasis.campaignId,
        primaryClosureHash: firstRevisionBasis.primaryClosureHash,
        revisionOrdinal: 1,
        previousRevisionHash: firstRevisionBasis.previousRevisionHash,
        lateEventId: lateFinish.event.eventId,
      }),
    };
    const lateCleanup = entry({
      campaignId: fixture.journal.campaignId,
      assignmentId: fixture.journal.assignmentId,
      ordinal: 4,
      previousHash: eventHashV1(lateFinish),
      eventKind: "conformance_cleanup_proven",
      payload: {
        leaseId: "lease:test",
        observedAt: timestamp,
        processesEmpty: true,
        cgroupEmpty: true,
        storageEmpty: true,
        networkLeaseClosed: true,
        credentialLeaseRevoked: true,
        observationCoverage: "complete",
      },
      actorKeyId: fixture.manifest.assignments[0].cleanupActorKeyId,
    });
    const secondRevisionBasis = {
      schemaId: E3_SCHEMA_IDS_V1.revisionEnvelope,
      schemaVersion: 1 as const,
      campaignId: fixture.journal.campaignId,
      primaryClosureHash: fixture.closure.closureHash,
      revisionOrdinal: 2,
      previousRevisionHash: revisionHashV1(firstRevision),
      lateEntry: lateCleanup,
      receivedAt: "2026-08-11T00:11:00.000Z",
      registrarKeyId: digest("8"),
      signature,
    };
    const secondRevision = {
      ...secondRevisionBasis,
      revisionId: revisionIdV1({
        campaignId: secondRevisionBasis.campaignId,
        primaryClosureHash: secondRevisionBasis.primaryClosureHash,
        revisionOrdinal: 2,
        previousRevisionHash: secondRevisionBasis.previousRevisionHash,
        lateEventId: lateCleanup.event.eventId,
      }),
    };
    expect(
      projectRevisionJournalV1({
        manifest: fixture.manifest,
        journal: fixture.journal,
        primaryClosure: fixture.closure,
        revisions: [firstRevision, secondRevision],
      }),
    ).toEqual({
      primaryOutcome: "incomplete_unknown",
      primaryClosureHash: fixture.closure.closureHash,
      revisionCount: 2,
      latestKnownEventCount: 6,
    });
    expect(firstRevision.lateEntry).toEqual(lateFinish);
    expect(secondRevision.lateEntry).toEqual(lateCleanup);
  });

  it("rejects a revision that binds a forged late event identity", () => {
    const fixture = incompleteFixture();
    const lateEntry = entry({
      campaignId: fixture.journal.campaignId,
      assignmentId: fixture.journal.assignmentId,
      ordinal: 3,
      previousHash: eventHashV1(fixture.journal.events[1]!),
      eventKind: "conformance_actor_finished",
      payload: { leaseId: "lease:test", finishedAt: timestamp },
      actorKeyId: fixture.manifest.assignments[0].conformanceActorKeyId,
    });
    lateEntry.event.eventId = digest("f");
    const revisionBasis = {
      schemaId: E3_SCHEMA_IDS_V1.revisionEnvelope,
      schemaVersion: 1 as const,
      campaignId: fixture.journal.campaignId,
      primaryClosureHash: fixture.closure.closureHash,
      revisionOrdinal: 1,
      previousRevisionHash: fixture.closure.closureHash,
      lateEntry,
      receivedAt: "2026-08-11T00:11:00.000Z",
      registrarKeyId: digest("8"),
      signature,
    };
    const revision = {
      ...revisionBasis,
      revisionId: revisionIdV1({
        campaignId: revisionBasis.campaignId,
        primaryClosureHash: revisionBasis.primaryClosureHash,
        revisionOrdinal: 1,
        previousRevisionHash: revisionBasis.previousRevisionHash,
        lateEventId: lateEntry.event.eventId,
      }),
    };

    expect(() =>
      projectRevisionJournalV1({
        manifest: fixture.manifest,
        journal: fixture.journal,
        primaryClosure: fixture.closure,
        revisions: [revision],
      }),
    ).toThrow(/late event identity/u);
  });

  it("rejects a late branch whose previousHash is not a real ordinal-1 event", () => {
    const fixture = incompleteFixture();
    const lateEntry = entry({
      campaignId: fixture.journal.campaignId,
      assignmentId: fixture.journal.assignmentId,
      ordinal: 3,
      previousHash: fixture.journal.journalHead,
      eventKind: "conformance_actor_finished",
      payload: { leaseId: "lease:test", finishedAt: timestamp },
      actorKeyId: fixture.manifest.assignments[0].conformanceActorKeyId,
    });
    const revisionBasis = {
      schemaId: E3_SCHEMA_IDS_V1.revisionEnvelope,
      schemaVersion: 1 as const,
      campaignId: fixture.journal.campaignId,
      primaryClosureHash: fixture.closure.closureHash,
      revisionOrdinal: 1,
      previousRevisionHash: fixture.closure.closureHash,
      lateEntry,
      receivedAt: "2026-08-11T00:11:00.000Z",
      registrarKeyId: digest("8"),
      signature,
    };
    const revision = {
      ...revisionBasis,
      revisionId: revisionIdV1({
        campaignId: revisionBasis.campaignId,
        primaryClosureHash: revisionBasis.primaryClosureHash,
        revisionOrdinal: 1,
        previousRevisionHash: revisionBasis.previousRevisionHash,
        lateEventId: lateEntry.event.eventId,
      }),
    };
    expect(() =>
      projectRevisionJournalV1({
        manifest: fixture.manifest,
        journal: fixture.journal,
        primaryClosure: fixture.closure,
        revisions: [revision],
      }),
    ).toThrow(/does not bind a real ordinal-2/u);
  });
});
