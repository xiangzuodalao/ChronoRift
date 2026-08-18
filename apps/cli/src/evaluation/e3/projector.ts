import type { JsonValue, Sha256DigestV1 } from "@chronorift/domain";

import {
  assignmentIdV1,
  campaignIdV1,
  canonicalContentHashV1,
  eventIdV1,
  revisionIdV1,
} from "./canonical.js";
import {
  E3AppendReceiptV1Schema,
  E3CampaignManifestV1Schema,
  E3ConformanceActorFinishedPayloadV1Schema,
  E3ConformanceActorStartedPayloadV1Schema,
  E3ConformanceCleanupProvenPayloadV1Schema,
  E3JournalV1Schema,
  E3PrimaryClosureV1Schema,
  E3RegistrarAssignmentRegisteredPayloadV1Schema,
  E3RegistrarDeadlineElapsedPayloadV1Schema,
  E3RegistrarPrimaryClosedPayloadV1Schema,
  E3RevisionEnvelopeV1Schema,
  type E3AppendReceiptV1,
  type E3CampaignManifestV1,
  type E3JournalEntryV1,
  type E3JournalV1,
  type E3PrimaryClosureV1,
  type E3PrimaryOutcomeV1,
  type E3RevisionEnvelopeV1,
} from "./contracts.js";

export class E3ProjectionError extends Error {
  public constructor(message: string) {
    super(`invalid E3.1 campaign projection: ${message}`);
    this.name = "E3ProjectionError";
  }
}

const json = (value: unknown): JsonValue => value as JsonValue;
const fail = (message: string): never => {
  throw new E3ProjectionError(message);
};

export const eventHashV1 = (entry: E3JournalEntryV1): Sha256DigestV1 =>
  canonicalContentHashV1(json(entry.event));

export const revisionHashV1 = (
  revision: E3RevisionEnvelopeV1,
): Sha256DigestV1 => canonicalContentHashV1(json(revision));

export interface E3PrimaryReceiptProjectionV1 {
  readonly appendReceipts: readonly E3AppendReceiptV1[];
  readonly firstActorCommittedAt: string | null;
  readonly closureCommittedAt: string;
}

/**
 * Validates the registrar commit order and wall-clock boundary independently
 * of manifest identity. This is also used for closed snapshots, whose wire DTO
 * carries the frozen deadline in the primary closure rather than a manifest.
 */
export const validatePrimaryAppendReceiptsV1 = (input: {
  readonly journal: unknown;
  readonly appendReceipts: unknown;
  readonly closure: unknown;
}): E3PrimaryReceiptProjectionV1 => {
  const journal = E3JournalV1Schema.parse(input.journal);
  const receipts = E3AppendReceiptV1Schema.array().parse(input.appendReceipts);
  const closure = E3PrimaryClosureV1Schema.parse(input.closure);
  if (receipts.length !== journal.events.length) {
    fail("every primary event must have exactly one append receipt");
  }
  if (
    closure.campaignId !== journal.campaignId ||
    closure.journalHead !== journal.journalHead ||
    closure.eventCount !== journal.eventCount
  ) {
    fail("primary closure does not bind the receipt-backed journal");
  }

  const deadlineMs = Date.parse(closure.deadline);
  const closedAtMs = Date.parse(closure.closedAt);
  let previousCommitSequence = 0;
  let previousCommittedAt = -Infinity;
  let firstActorCommittedAt: string | null = null;
  let cleanupIndex: number | undefined;
  let deadlineObservedAt: string | undefined;
  let closureCommittedAt: string | undefined;

  for (const [index, entry] of journal.events.entries()) {
    const receipt = receipts[index]!;
    const eventHash = eventHashV1(entry);
    const committedAt = Date.parse(receipt.committedAt);
    if (
      receipt.campaignId !== journal.campaignId ||
      receipt.assignmentId !== journal.assignmentId ||
      receipt.eventId !== entry.event.eventId ||
      receipt.eventHash !== eventHash ||
      receipt.journalHead !== eventHash ||
      receipt.ordinal !== entry.event.ordinal
    ) {
      fail(
        `append receipt ${String(index + 1)} does not bind its primary event`,
      );
    }
    if (receipt.commitSequence <= previousCommitSequence) {
      fail(
        "primary append receipt commitSequence values must strictly increase",
      );
    }
    if (committedAt < previousCommittedAt) {
      fail("primary append receipt committedAt values must be monotonic");
    }

    switch (entry.event.eventKind) {
      case "registrar_assignment_registered":
      case "conformance_actor_started":
      case "conformance_actor_finished":
      case "conformance_cleanup_proven": {
        if (committedAt >= deadlineMs) {
          fail(
            `${entry.event.eventKind} was not committed strictly before the campaign deadline`,
          );
        }
        if (
          firstActorCommittedAt === null &&
          entry.event.actorRole !== "registrar"
        ) {
          firstActorCommittedAt = receipt.committedAt;
        }
        if (entry.event.eventKind === "conformance_cleanup_proven") {
          cleanupIndex = index;
        }
        break;
      }
      case "registrar_deadline_elapsed": {
        if (committedAt < deadlineMs) {
          fail("deadline event was committed before the campaign deadline");
        }
        deadlineObservedAt = E3RegistrarDeadlineElapsedPayloadV1Schema.parse(
          entry.payload,
        ).observedAt;
        if (Date.parse(deadlineObservedAt) < deadlineMs) {
          fail("deadline event observedAt precedes the campaign deadline");
        }
        break;
      }
      case "registrar_primary_closed": {
        const payload = E3RegistrarPrimaryClosedPayloadV1Schema.parse(
          entry.payload,
        );
        if (
          index !== journal.events.length - 1 ||
          payload.closedAt !== closure.closedAt ||
          receipt.committedAt !== closure.closedAt
        ) {
          fail(
            "closure event payload, primary closure, and closure receipt must share the exact closedAt",
          );
        }
        closureCommittedAt = receipt.committedAt;
        break;
      }
    }
    previousCommitSequence = receipt.commitSequence;
    previousCommittedAt = committedAt;
  }

  const validatedClosureCommittedAt =
    closureCommittedAt ??
    fail("receipt-backed primary journal has no closure event");
  if (
    cleanupIndex !== undefined &&
    journal.events[cleanupIndex + 1]?.event.eventKind !==
      "registrar_primary_closed"
  ) {
    fail("cleanup must be followed immediately by primary closure");
  }
  if (closure.primaryOutcome === "conformance_complete") {
    if (cleanupIndex === undefined || deadlineObservedAt !== undefined) {
      fail("early complete closure requires cleanup and no deadline event");
    }
    if (closedAtMs >= deadlineMs) {
      fail("early complete closure must be committed before the deadline");
    }
  }
  if (
    deadlineObservedAt !== undefined &&
    Date.parse(deadlineObservedAt) > closedAtMs
  ) {
    fail("deadline observation cannot occur after primary closure");
  }

  return {
    appendReceipts: receipts,
    firstActorCommittedAt,
    closureCommittedAt: validatedClosureCommittedAt,
  };
};

const validateJournalChain = (
  manifest: E3CampaignManifestV1,
  journal: E3JournalV1,
): {
  readonly campaignId: string;
  readonly assignmentId: string;
  readonly primaryOutcome: E3PrimaryOutcomeV1;
  readonly closedAt: string;
} => {
  const derivedCampaignId = campaignIdV1(json(manifest));
  if (journal.campaignId !== derivedCampaignId) {
    fail("journal campaign identity does not match the canonical manifest");
  }
  const slot = manifest.assignments[0];
  const derivedAssignmentId = assignmentIdV1({
    campaignId: derivedCampaignId,
    slotOrdinal: slot.slotOrdinal,
    assignmentCommitment: slot.assignmentCommitment,
  });
  if (journal.assignmentId !== derivedAssignmentId) {
    fail("journal assignment identity does not match the registered slot");
  }

  let previousHash: string | null = null;
  let startedLease: string | undefined;
  let finished = false;
  let cleanup = false;
  let deadlineElapsed = false;
  let deadlineObservedAt: string | undefined;
  let closedAt: string | undefined;
  let projectedOutcome: E3PrimaryOutcomeV1 | undefined;

  for (const [index, entry] of journal.events.entries()) {
    const { event, payload } = entry;
    if (
      event.campaignId !== derivedCampaignId ||
      event.assignmentId !== derivedAssignmentId
    ) {
      fail(
        `event ${String(index + 1)} belongs to another campaign or assignment`,
      );
    }
    if (event.ordinal !== index + 1 || event.previousHash !== previousHash) {
      fail(
        `event ${String(index + 1)} breaks ordinal/previous-hash continuity`,
      );
    }
    const payloadHash = canonicalContentHashV1(json(payload));
    if (event.payloadHash !== payloadHash) {
      fail(
        `event ${String(index + 1)} payload hash does not match its payload`,
      );
    }
    const derivedEventId = eventIdV1({
      campaignId: event.campaignId,
      assignmentId: event.assignmentId,
      ordinal: event.ordinal,
      previousHash: event.previousHash ?? "",
      eventKind: event.eventKind,
      payloadHash,
    });
    if (event.eventId !== derivedEventId) {
      fail(`event ${String(index + 1)} identity is not canonical`);
    }

    switch (event.eventKind) {
      case "registrar_assignment_registered": {
        if (index !== 0)
          fail("assignment registration must be the first event");
        const value =
          E3RegistrarAssignmentRegisteredPayloadV1Schema.parse(payload);
        if (
          value.assignmentId !== derivedAssignmentId ||
          value.assignmentCommitment !== slot.assignmentCommitment ||
          value.slotOrdinal !== slot.slotOrdinal
        ) {
          fail(
            "assignment registration payload does not bind the manifest slot",
          );
        }
        break;
      }
      case "conformance_actor_started": {
        if (
          index === 0 ||
          startedLease !== undefined ||
          deadlineElapsed ||
          closedAt !== undefined ||
          event.actorKeyId !== slot.conformanceActorKeyId
        ) {
          fail("conformance actor start is duplicate or out of order");
        }
        startedLease =
          E3ConformanceActorStartedPayloadV1Schema.parse(payload).leaseId;
        break;
      }
      case "conformance_actor_finished": {
        const value = E3ConformanceActorFinishedPayloadV1Schema.parse(payload);
        if (
          startedLease === undefined ||
          finished ||
          deadlineElapsed ||
          closedAt !== undefined ||
          value.leaseId !== startedLease ||
          event.actorKeyId !== slot.conformanceActorKeyId
        ) {
          fail(
            "conformance actor finish is duplicate, unowned, or out of order",
          );
        }
        finished = true;
        break;
      }
      case "conformance_cleanup_proven": {
        const value = E3ConformanceCleanupProvenPayloadV1Schema.parse(payload);
        if (
          !finished ||
          cleanup ||
          deadlineElapsed ||
          closedAt !== undefined ||
          value.leaseId !== startedLease ||
          event.actorKeyId !== slot.cleanupActorKeyId
        ) {
          fail("cleanup proof is duplicate, unowned, or precedes actor finish");
        }
        cleanup = true;
        break;
      }
      case "registrar_deadline_elapsed": {
        const value = E3RegistrarDeadlineElapsedPayloadV1Schema.parse(payload);
        if (
          deadlineElapsed ||
          cleanup ||
          closedAt !== undefined ||
          value.deadline !== manifest.deadline
        ) {
          fail("deadline event is duplicate, mismatched, or follows closure");
        }
        deadlineElapsed = true;
        deadlineObservedAt = value.observedAt;
        break;
      }
      case "registrar_primary_closed": {
        const value = E3RegistrarPrimaryClosedPayloadV1Schema.parse(payload);
        if (closedAt !== undefined || index !== journal.events.length - 1) {
          fail(
            "primary closure must be unique and final in the primary journal",
          );
        }
        if (value.preClosureHead !== previousHash) {
          fail("primary closure payload does not bind the pre-closure head");
        }
        if (
          (deadlineElapsed &&
            (Date.parse(value.closedAt) < Date.parse(manifest.deadline) ||
              (deadlineObservedAt !== undefined &&
                Date.parse(deadlineObservedAt) >
                  Date.parse(value.closedAt)))) ||
          (!deadlineElapsed &&
            Date.parse(value.closedAt) >= Date.parse(manifest.deadline))
        ) {
          fail("primary closure time is inconsistent with the deadline event");
        }
        const expectedOutcome: E3PrimaryOutcomeV1 =
          finished && cleanup
            ? "conformance_complete"
            : finished
              ? "cleanup_unproven"
              : "incomplete_unknown";
        if (!cleanup && !deadlineElapsed) {
          fail("non-complete primary closure requires a deadline event");
        }
        if (value.primaryOutcome !== expectedOutcome) {
          fail("primary closure outcome does not match retained events");
        }
        closedAt = value.closedAt;
        projectedOutcome = expectedOutcome;
        break;
      }
    }
    previousHash = eventHashV1(entry);
  }

  if (previousHash !== journal.journalHead) {
    fail("journal head does not match the final event hash");
  }
  if (closedAt === undefined || projectedOutcome === undefined) {
    fail("primary journal is not closed");
  }
  return {
    campaignId: derivedCampaignId,
    assignmentId: derivedAssignmentId,
    primaryOutcome: projectedOutcome as E3PrimaryOutcomeV1,
    closedAt: closedAt as string,
  };
};

export const projectPrimaryClosureV1 = (input: {
  readonly manifest: unknown;
  readonly journal: unknown;
}): {
  readonly campaignId: string;
  readonly assignmentId: string;
  readonly primaryOutcome: E3PrimaryOutcomeV1;
  readonly closedAt: string;
  readonly eventCount: number;
  readonly journalHead: string;
} => {
  const manifest = E3CampaignManifestV1Schema.parse(input.manifest);
  const journal = E3JournalV1Schema.parse(input.journal);
  return {
    ...validateJournalChain(manifest, journal),
    eventCount: journal.eventCount,
    journalHead: journal.journalHead,
  };
};

const validatePrimaryClosureProjectionV1 = (
  manifest: E3CampaignManifestV1,
  journal: E3JournalV1,
  closure: E3PrimaryClosureV1,
): E3PrimaryClosureV1 => {
  const projected = validateJournalChain(manifest, journal);
  if (
    closure.campaignId !== projected.campaignId ||
    closure.journalHead !== journal.journalHead ||
    closure.deadline !== manifest.deadline ||
    closure.closedAt !== projected.closedAt ||
    closure.primaryOutcome !== projected.primaryOutcome ||
    closure.assignmentCount !== 1 ||
    closure.eventCount !== journal.eventCount
  ) {
    fail("primary closure does not equal the raw journal projection");
  }
  const expectedCounts = {
    conformanceComplete:
      projected.primaryOutcome === "conformance_complete" ? 1 : 0,
    incompleteUnknown:
      projected.primaryOutcome === "incomplete_unknown" ? 1 : 0,
    cleanupUnproven: projected.primaryOutcome === "cleanup_unproven" ? 1 : 0,
  };
  if (
    canonicalContentHashV1(json(closure.outcomeCounts)) !==
    canonicalContentHashV1(json(expectedCounts))
  ) {
    fail("primary closure outcome counts do not match the projected outcome");
  }
  const closureHash = closure.closureHash;
  const closureHashBasis = { ...closure } as Partial<E3PrimaryClosureV1>;
  delete closureHashBasis.closureHash;
  delete closureHashBasis.signature;
  if (closureHash !== canonicalContentHashV1(json(closureHashBasis))) {
    fail("primary closure hash does not match its canonical basis");
  }
  return closure;
};

export const validatePrimaryClosureV1 = (input: {
  readonly manifest: unknown;
  readonly journal: unknown;
  readonly appendReceipts: unknown;
  readonly closure: unknown;
}): E3PrimaryClosureV1 => {
  const manifest = E3CampaignManifestV1Schema.parse(input.manifest);
  const journal = E3JournalV1Schema.parse(input.journal);
  const closure = E3PrimaryClosureV1Schema.parse(input.closure);
  const validated = validatePrimaryClosureProjectionV1(
    manifest,
    journal,
    closure,
  );
  validatePrimaryAppendReceiptsV1({
    journal,
    appendReceipts: input.appendReceipts,
    closure,
  });
  return validated;
};

export const projectRevisionJournalV1 = (input: {
  readonly manifest: unknown;
  readonly journal: unknown;
  readonly primaryClosure: unknown;
  readonly revisions: readonly unknown[];
}): {
  readonly primaryOutcome: E3PrimaryOutcomeV1;
  readonly primaryClosureHash: string;
  readonly revisionCount: number;
  readonly latestKnownEventCount: number;
} => {
  const manifest = E3CampaignManifestV1Schema.parse(input.manifest);
  const journal = E3JournalV1Schema.parse(input.journal);
  const closure = validatePrimaryClosureProjectionV1(
    manifest,
    journal,
    E3PrimaryClosureV1Schema.parse(input.primaryClosure),
  );
  const slot = manifest.assignments[0];
  const assignmentId = assignmentIdV1({
    campaignId: closure.campaignId,
    slotOrdinal: slot.slotOrdinal,
    assignmentCommitment: slot.assignmentCommitment,
  });
  let startedLease: string | undefined;
  let finished = false;
  let cleanup = false;
  for (const entry of journal.events) {
    if (entry.event.eventKind === "conformance_actor_started") {
      startedLease = E3ConformanceActorStartedPayloadV1Schema.parse(
        entry.payload,
      ).leaseId;
    } else if (entry.event.eventKind === "conformance_actor_finished") {
      finished = true;
    } else if (entry.event.eventKind === "conformance_cleanup_proven") {
      cleanup = true;
    }
  }
  let previousRevisionHash: string = closure.closureHash;
  const eventHashesByOrdinal = new Map<number, Set<string>>();
  for (const entry of journal.events) {
    eventHashesByOrdinal.set(
      entry.event.ordinal,
      new Set([eventHashV1(entry)]),
    );
  }
  for (const [index, raw] of input.revisions.entries()) {
    const revision = E3RevisionEnvelopeV1Schema.parse(raw);
    const event = revision.lateEntry.event;
    if (
      revision.campaignId !== closure.campaignId ||
      revision.primaryClosureHash !== closure.closureHash ||
      revision.revisionOrdinal !== index + 1 ||
      revision.previousRevisionHash !== previousRevisionHash ||
      event.campaignId !== closure.campaignId ||
      event.assignmentId !== assignmentId
    ) {
      fail(`revision ${String(index + 1)} breaks the immutable revision chain`);
    }
    const payloadHash = canonicalContentHashV1(
      json(revision.lateEntry.payload),
    );
    if (event.payloadHash !== payloadHash) {
      fail(`revision ${String(index + 1)} has an invalid late event payload`);
    }
    const expectedLateEventId = eventIdV1({
      campaignId: event.campaignId,
      assignmentId: event.assignmentId,
      ordinal: event.ordinal,
      previousHash: event.previousHash ?? "",
      eventKind: event.eventKind,
      payloadHash,
    });
    if (event.eventId !== expectedLateEventId) {
      fail(
        `revision ${String(index + 1)} has a non-canonical late event identity`,
      );
    }
    const predecessorHashes = eventHashesByOrdinal.get(event.ordinal - 1);
    if (
      event.previousHash === null ||
      predecessorHashes === undefined ||
      !predecessorHashes.has(event.previousHash)
    ) {
      fail(
        `revision ${String(index + 1)} does not bind a real ordinal-${String(event.ordinal - 1)} primary or earlier revision event`,
      );
    }
    if (
      event.eventKind === "registrar_assignment_registered" ||
      event.eventKind === "registrar_deadline_elapsed" ||
      event.eventKind === "registrar_primary_closed"
    ) {
      fail(
        `revision ${String(index + 1)} contains a registrar-owned late event`,
      );
    }
    if (event.eventKind === "conformance_actor_started") {
      const value = E3ConformanceActorStartedPayloadV1Schema.parse(
        revision.lateEntry.payload,
      );
      if (
        startedLease !== undefined ||
        event.actorKeyId !== slot.conformanceActorKeyId
      ) {
        fail(`revision ${String(index + 1)} has a duplicate or unbound start`);
      }
      startedLease = value.leaseId;
    } else if (event.eventKind === "conformance_actor_finished") {
      const value = E3ConformanceActorFinishedPayloadV1Schema.parse(
        revision.lateEntry.payload,
      );
      if (
        startedLease === undefined ||
        finished ||
        value.leaseId !== startedLease ||
        event.actorKeyId !== slot.conformanceActorKeyId
      ) {
        fail(`revision ${String(index + 1)} has a duplicate or unbound finish`);
      }
      finished = true;
    } else {
      const value = E3ConformanceCleanupProvenPayloadV1Schema.parse(
        revision.lateEntry.payload,
      );
      if (
        startedLease === undefined ||
        !finished ||
        cleanup ||
        value.leaseId !== startedLease ||
        event.actorKeyId !== slot.cleanupActorKeyId
      ) {
        fail(`revision ${String(index + 1)} has duplicate or unbound cleanup`);
      }
      cleanup = true;
    }
    const expectedRevisionId = revisionIdV1({
      campaignId: revision.campaignId,
      primaryClosureHash: revision.primaryClosureHash,
      revisionOrdinal: revision.revisionOrdinal,
      previousRevisionHash,
      lateEventId: event.eventId,
    });
    if (revision.revisionId !== expectedRevisionId) {
      fail(`revision ${String(index + 1)} identity is not canonical`);
    }
    const eventHash = eventHashV1(revision.lateEntry);
    const sameOrdinalHashes = eventHashesByOrdinal.get(event.ordinal);
    if (sameOrdinalHashes === undefined) {
      eventHashesByOrdinal.set(event.ordinal, new Set([eventHash]));
    } else {
      sameOrdinalHashes.add(eventHash);
    }
    previousRevisionHash = revisionHashV1(revision);
  }
  return {
    primaryOutcome: closure.primaryOutcome,
    primaryClosureHash: closure.closureHash,
    revisionCount: input.revisions.length,
    latestKnownEventCount: closure.eventCount + input.revisions.length,
  };
};
