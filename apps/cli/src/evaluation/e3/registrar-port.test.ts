import { generateKeyPairSync, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import { asSha256DigestV1, type JsonValue } from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";

import {
  assignmentIdV1,
  campaignIdV1,
  canonicalContentHashV1,
  ed25519KeyIdV1,
  eventIdV1,
  signCanonicalJsonV1,
  verifyCanonicalJsonSignatureV1,
} from "./canonical.js";
import {
  E3_EVENT_ACTOR_ACL_V1,
  E3_EVENT_PAYLOAD_SCHEMA_IDS_V1,
  E3JournalEntryV1Schema,
  E3_SCHEMA_IDS_V1,
  type E3ActorRoleV1,
  type E3AppendReceiptV1,
  type E3CampaignManifestV1,
  type E3EventKindV1,
  type E3JournalEntryV1,
  type E3JournalV1,
  type E3PrimaryClosureV1,
  type E3PrimaryOutcomeV1,
} from "./contracts.js";
import {
  eventHashV1,
  projectPrimaryClosureV1,
  validatePrimaryClosureV1,
} from "./projector.js";

const timestamp = "2026-08-11T00:00:00.000Z";
const deadline = "2026-08-11T00:10:00.000Z";
const digest = (character: string) => asSha256DigestV1(character.repeat(64));

interface ActorKey {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly keyId: ReturnType<typeof ed25519KeyIdV1>;
}

const actorKey = (): ActorKey => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, keyId: ed25519KeyIdV1(publicKey) };
};

class OfflineCompareAndAppendRegistrar {
  public readonly registrar = actorKey();
  public readonly conformance = actorKey();
  public readonly cleanup = actorKey();
  public readonly manifest: E3CampaignManifestV1;
  public readonly campaignId: ReturnType<typeof campaignIdV1>;
  public readonly assignmentId: ReturnType<typeof assignmentIdV1>;

  readonly #events: E3JournalEntryV1[] = [];
  readonly #idempotency = new Map<
    string,
    { readonly bytes: string; readonly receipt: E3AppendReceiptV1 }
  >();
  readonly #payloads = new Set<string>();
  #closed = false;
  #commitSequence = 0;

  public constructor() {
    this.manifest = {
      schemaId: E3_SCHEMA_IDS_V1.campaignManifest,
      schemaVersion: 1,
      campaignPurpose: "registrar_conformance",
      claimEligible: false,
      modelCalls: 0,
      evaluatorRuns: 0,
      artifactSinkMode: "configured_external_ci_artifact_directory_v1",
      artifactSinkId: "sink.test",
      artifactSinkCommitment: digest("f"),
      namespace: "chronorift/e3/offline",
      registrarServiceId: "registrar.offline",
      trustRootVersion: "offline-v1",
      productSha256: digest("1"),
      runnerSha256: digest("2"),
      validatorSha256: digest("3"),
      deadline,
      assignmentCount: 1 as const,
      assignments: [
        {
          assignmentCommitment: digest("4"),
          conformanceActorKeyId: this.conformance.keyId,
          cleanupActorKeyId: this.cleanup.keyId,
          slotOrdinal: 0,
        },
      ],
    };
    this.campaignId = campaignIdV1(this.manifest as unknown as JsonValue);
    this.assignmentId = assignmentIdV1({
      campaignId: this.campaignId,
      slotOrdinal: 0,
      assignmentCommitment: this.manifest.assignments[0].assignmentCommitment,
    });
    this.append(
      this.entry("registrar_assignment_registered", {
        assignmentId: this.assignmentId,
        assignmentCommitment: this.manifest.assignments[0].assignmentCommitment,
        slotOrdinal: 0,
        registeredAt: timestamp,
      }),
      "server",
    );
  }

  public get journal(): E3JournalV1 {
    return {
      schemaId: E3_SCHEMA_IDS_V1.journal,
      schemaVersion: 1,
      campaignId: this.campaignId,
      assignmentId: this.assignmentId,
      events: structuredClone(this.#events),
      eventCount: this.#events.length,
      journalHead: eventHashV1(this.#events.at(-1)!),
    };
  }

  public get appendReceipts(): readonly E3AppendReceiptV1[] {
    return this.#events.map((entry) =>
      structuredClone(this.#idempotency.get(entry.event.eventId)!.receipt),
    );
  }

  public entry(eventKind: E3EventKindV1, payload: JsonValue): E3JournalEntryV1 {
    const ordinal = this.#events.length + 1;
    const previousHash =
      this.#events.length === 0 ? null : eventHashV1(this.#events.at(-1)!);
    return this.entryAt(eventKind, payload, ordinal, previousHash);
  }

  public entryAt(
    eventKind: E3EventKindV1,
    payload: JsonValue,
    ordinal: number,
    previousHash: string | null,
  ): E3JournalEntryV1 {
    const payloadHash = canonicalContentHashV1(payload);
    const role = E3_EVENT_ACTOR_ACL_V1[eventKind] as E3ActorRoleV1;
    const key = this.#key(role);
    const basis = {
      schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
      schemaVersion: 1 as const,
      campaignId: this.campaignId,
      assignmentId: this.assignmentId,
      eventId: eventIdV1({
        campaignId: this.campaignId,
        assignmentId: this.assignmentId,
        ordinal,
        previousHash: previousHash ?? "",
        eventKind,
        payloadHash,
      }),
      ordinal,
      previousHash,
      actorRole: role,
      actorKeyId: key.keyId,
      eventKind,
      payloadSchemaId: E3_EVENT_PAYLOAD_SCHEMA_IDS_V1[eventKind],
      payloadHash,
    };
    return E3JournalEntryV1Schema.parse({
      event: {
        ...basis,
        signature: signCanonicalJsonV1({
          privateKey: key.privateKey,
          domain: "chronorift-e3-event-v1",
          schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
          version: 1,
          value: basis as unknown as JsonValue,
        }),
      },
      payload,
    });
  }

  public append(
    raw: E3JournalEntryV1,
    capability: "actor" | "cleanup" | "server",
    loseResponseAfterCommit = false,
  ): E3AppendReceiptV1 {
    const bytes = canonicalJson(raw as unknown as JsonValue);
    const existing = this.#idempotency.get(raw.event.eventId);
    if (existing !== undefined) {
      if (existing.bytes !== bytes)
        throw new Error("same key with different bytes");
      return existing.receipt;
    }
    if (this.#closed) throw new Error("closed campaign");

    const entry = E3JournalEntryV1Schema.parse(raw);
    const allowedRole = {
      actor: "conformance_actor",
      cleanup: "cleanup_actor",
      server: "registrar",
    }[capability];
    if (entry.event.actorRole !== allowedRole)
      throw new Error("unauthorized actor");
    const expectedKey = this.#key(entry.event.actorRole);
    if (entry.event.actorKeyId !== expectedKey.keyId) {
      throw new Error("unauthorized actor key");
    }
    const { signature, ...eventBasis } = entry.event;
    if (
      !verifyCanonicalJsonSignatureV1({
        publicKey: expectedKey.publicKey,
        domain: "chronorift-e3-event-v1",
        schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
        version: 1,
        value: eventBasis as unknown as JsonValue,
        signature,
      })
    ) {
      throw new Error("bad actor signature");
    }

    const expectedOrdinal = this.#events.length + 1;
    const expectedPrevious =
      this.#events.length === 0 ? null : eventHashV1(this.#events.at(-1)!);
    if (
      entry.event.ordinal !== expectedOrdinal ||
      entry.event.previousHash !== expectedPrevious
    ) {
      throw new Error("stale head or out-of-order ordinal");
    }
    const payloadHash = canonicalContentHashV1(
      entry.payload as unknown as JsonValue,
    );
    if (entry.event.payloadHash !== payloadHash)
      throw new Error("payload mismatch");
    if (this.#payloads.has(payloadHash)) throw new Error("duplicate payload");
    if (
      entry.event.eventId !==
      eventIdV1({
        campaignId: this.campaignId,
        assignmentId: this.assignmentId,
        ordinal: entry.event.ordinal,
        previousHash: entry.event.previousHash ?? "",
        eventKind: entry.event.eventKind,
        payloadHash,
      })
    ) {
      throw new Error("noncanonical idempotency key");
    }
    this.#assertTransition(entry);

    const eventHash = eventHashV1(entry);
    this.#commitSequence += 1;
    const committedAt =
      entry.event.eventKind === "registrar_deadline_elapsed"
        ? (entry.payload as { readonly observedAt: string }).observedAt
        : entry.event.eventKind === "registrar_primary_closed"
          ? (entry.payload as { readonly closedAt: string }).closedAt
          : timestamp;
    const receiptBasis = {
      schemaId: E3_SCHEMA_IDS_V1.appendReceipt,
      schemaVersion: 1 as const,
      campaignId: this.campaignId,
      assignmentId: this.assignmentId,
      eventId: entry.event.eventId,
      eventHash,
      journalHead: eventHash,
      ordinal: entry.event.ordinal,
      commitSequence: this.#commitSequence,
      committedAt,
      registrarServiceId: "registrar.offline",
      receiptKeyId: this.registrar.keyId,
    };
    const receipt: E3AppendReceiptV1 = {
      ...receiptBasis,
      signature: signCanonicalJsonV1({
        privateKey: this.registrar.privateKey,
        domain: "chronorift-e3-append-receipt-v1",
        schemaId: E3_SCHEMA_IDS_V1.appendReceipt,
        version: 1,
        value: receiptBasis as unknown as JsonValue,
      }),
    };
    this.#events.push(entry);
    this.#payloads.add(payloadHash);
    this.#idempotency.set(entry.event.eventId, { bytes, receipt });
    if (entry.event.eventKind === "registrar_primary_closed")
      this.#closed = true;
    if (loseResponseAfterCommit) throw new Error("response lost after commit");
    return receipt;
  }

  public start(): E3JournalEntryV1 {
    const entry = this.entry("conformance_actor_started", {
      leaseId: "lease:offline",
      startedAt: timestamp,
    });
    this.append(entry, "actor");
    return entry;
  }

  public finish(): E3JournalEntryV1 {
    const entry = this.entry("conformance_actor_finished", {
      leaseId: "lease:offline",
      finishedAt: timestamp,
    });
    this.append(entry, "actor");
    return entry;
  }

  public proveCleanup(): E3JournalEntryV1 {
    const entry = this.entry("conformance_cleanup_proven", {
      leaseId: "lease:offline",
      observedAt: timestamp,
      processesEmpty: true,
      cgroupEmpty: true,
      storageEmpty: true,
      networkLeaseClosed: true,
      credentialLeaseRevoked: true,
      observationCoverage: "complete",
    });
    this.append(entry, "cleanup");
    return entry;
  }

  public seal(atDeadline: boolean): E3PrimaryClosureV1 {
    const kinds = new Set(this.#events.map(({ event }) => event.eventKind));
    const finished = kinds.has("conformance_actor_finished");
    const cleanup = kinds.has("conformance_cleanup_proven");
    if (!finished || !cleanup) {
      if (!atDeadline)
        throw new Error("terminal result and cleanup are required");
      this.append(
        this.entry("registrar_deadline_elapsed", {
          deadline,
          observedAt: deadline,
        }),
        "server",
      );
    }
    const primaryOutcome: E3PrimaryOutcomeV1 =
      finished && cleanup
        ? "conformance_complete"
        : finished
          ? "cleanup_unproven"
          : "incomplete_unknown";
    this.append(
      this.entry("registrar_primary_closed", {
        preClosureHead: eventHashV1(this.#events.at(-1)!),
        closedAt: atDeadline ? deadline : timestamp,
        primaryOutcome,
      }),
      "server",
    );
    const journal = this.journal;
    const closureBasis = {
      schemaId: E3_SCHEMA_IDS_V1.primaryClosure,
      schemaVersion: 1 as const,
      campaignId: this.campaignId,
      journalHead: journal.journalHead,
      deadline,
      closedAt: atDeadline ? deadline : timestamp,
      primaryOutcome,
      assignmentCount: 1 as const,
      outcomeCounts: {
        conformanceComplete: primaryOutcome === "conformance_complete" ? 1 : 0,
        incompleteUnknown: primaryOutcome === "incomplete_unknown" ? 1 : 0,
        cleanupUnproven: primaryOutcome === "cleanup_unproven" ? 1 : 0,
      },
      eventCount: journal.eventCount,
      appendAttemptCount: journal.eventCount,
      rejectionCount: 0,
      idempotentReplayCount: 0,
      publicationState: "closure_sealed_publication_pending" as const,
      claimEligible: false as const,
      modelCalls: 0 as const,
      evaluatorRuns: 0 as const,
      clockKeyId: this.registrar.keyId,
      clockSignature: "A".repeat(86),
      closureKeyId: this.registrar.keyId,
    };
    return {
      ...closureBasis,
      closureHash: canonicalContentHashV1(closureBasis as unknown as JsonValue),
      signature: "A".repeat(86),
    };
  }

  #key(role: E3ActorRoleV1): ActorKey {
    if (role === "registrar") return this.registrar;
    if (role === "conformance_actor") return this.conformance;
    return this.cleanup;
  }

  #assertTransition(entry: E3JournalEntryV1): void {
    const kinds = new Set(this.#events.map(({ event }) => event.eventKind));
    if (kinds.has(entry.event.eventKind))
      throw new Error("duplicate event kind");
    switch (entry.event.eventKind) {
      case "registrar_assignment_registered":
        if (this.#events.length !== 0)
          throw new Error("registration is not first");
        return;
      case "conformance_actor_started":
        if (!kinds.has("registrar_assignment_registered")) {
          throw new Error("assignment was not registered");
        }
        return;
      case "conformance_actor_finished":
        if (!kinds.has("conformance_actor_started")) {
          throw new Error("finish precedes start");
        }
        return;
      case "conformance_cleanup_proven":
        if (!kinds.has("conformance_actor_finished")) {
          throw new Error("cleanup precedes finish");
        }
        return;
      case "registrar_deadline_elapsed":
        return;
      case "registrar_primary_closed":
        return;
    }
  }
}

describe("E3.1 offline compare-and-append fault model", () => {
  it("returns the original receipt after a lost response and rejects key reuse", () => {
    const registrar = new OfflineCompareAndAppendRegistrar();
    const entry = registrar.entry("conformance_actor_started", {
      leaseId: "lease:offline",
      startedAt: timestamp,
    });
    expect(() => registrar.append(entry, "actor", true)).toThrow(
      /response lost/u,
    );
    const retried = registrar.append(entry, "actor");
    expect(retried.ordinal).toBe(2);
    expect(registrar.journal.eventCount).toBe(2);

    const changedBytes = structuredClone(entry);
    changedBytes.event.signature = `${entry.event.signature.slice(0, -1)}${
      entry.event.signature.endsWith("A") ? "B" : "A"
    }`;
    expect(() => registrar.append(changedBytes, "actor")).toThrow(
      /same key with different bytes/u,
    );
  });

  it("rejects stale heads, out-of-order ordinals, duplicate payloads, ACL abuse, and bad signatures", () => {
    const outOfOrderRegistrar = new OfflineCompareAndAppendRegistrar();
    const outOfOrder = outOfOrderRegistrar.entryAt(
      "conformance_actor_started",
      {
        leaseId: "lease:offline",
        startedAt: timestamp,
      },
      3,
      outOfOrderRegistrar.journal.journalHead,
    );
    expect(() => outOfOrderRegistrar.append(outOfOrder, "actor")).toThrow(
      /out-of-order/u,
    );

    const staleRegistrar = new OfflineCompareAndAppendRegistrar();
    const stale = staleRegistrar.entryAt(
      "conformance_actor_started",
      {
        leaseId: "lease:offline",
        startedAt: timestamp,
      },
      2,
      digest("f"),
    );
    expect(() => staleRegistrar.append(stale, "actor")).toThrow(/stale/u);

    const unauthorizedRegistrar = new OfflineCompareAndAppendRegistrar();
    const unauthorized = unauthorizedRegistrar.entry(
      "conformance_actor_started",
      {
        leaseId: "lease:offline",
        startedAt: timestamp,
      },
    );
    expect(() => unauthorizedRegistrar.append(unauthorized, "cleanup")).toThrow(
      /unauthorized/u,
    );

    const signatureRegistrar = new OfflineCompareAndAppendRegistrar();
    const badSignature = signatureRegistrar.entry("conformance_actor_started", {
      leaseId: "lease:offline",
      startedAt: timestamp,
    });
    badSignature.event.signature = "A".repeat(86);
    expect(() => signatureRegistrar.append(badSignature, "actor")).toThrow(
      /bad actor signature/u,
    );

    const duplicateRegistrar = new OfflineCompareAndAppendRegistrar();
    duplicateRegistrar.start();
    const duplicatePayload = duplicateRegistrar.entry(
      "conformance_actor_started",
      {
        leaseId: "lease:offline",
        startedAt: timestamp,
      },
    );
    expect(() => duplicateRegistrar.append(duplicatePayload, "actor")).toThrow(
      /duplicate payload/u,
    );
  });

  it("seals complete only after both terminal and cleanup evidence", () => {
    const registrar = new OfflineCompareAndAppendRegistrar();
    registrar.start();
    registrar.finish();
    expect(() => registrar.seal(false)).toThrow(/cleanup are required/u);
    registrar.proveCleanup();
    const closure = registrar.seal(false);
    expect(
      projectPrimaryClosureV1({
        manifest: registrar.manifest,
        journal: registrar.journal,
      }),
    ).toMatchObject({ primaryOutcome: "conformance_complete" });
    expect(
      validatePrimaryClosureV1({
        manifest: registrar.manifest,
        journal: registrar.journal,
        appendReceipts: registrar.appendReceipts,
        closure,
      }),
    ).toEqual(closure);
    expect(() =>
      registrar.append(
        registrar.entry("registrar_deadline_elapsed", {
          deadline,
          observedAt: deadline,
        }),
        "server",
      ),
    ).toThrow(/closed/u);
  });

  it.each([
    {
      label: "runner disappears",
      prepare: (registrar: OfflineCompareAndAppendRegistrar) =>
        registrar.start(),
      outcome: "incomplete_unknown",
    },
    {
      label: "finish arrives without cleanup",
      prepare: (registrar: OfflineCompareAndAppendRegistrar) => {
        registrar.start();
        registrar.finish();
      },
      outcome: "cleanup_unproven",
    },
  ])(
    "projects $label at the server deadline as $outcome",
    ({ prepare, outcome }) => {
      const registrar = new OfflineCompareAndAppendRegistrar();
      prepare(registrar);
      const closure = registrar.seal(true);
      expect(
        projectPrimaryClosureV1({
          manifest: registrar.manifest,
          journal: registrar.journal,
        }).primaryOutcome,
      ).toBe(outcome);
      expect(
        validatePrimaryClosureV1({
          manifest: registrar.manifest,
          journal: registrar.journal,
          appendReceipts: registrar.appendReceipts,
          closure,
        }).primaryOutcome,
      ).toBe(outcome);
    },
  );
});
