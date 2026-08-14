import {
  EnvironmentPublicationIntentV1Schema,
  EnvironmentPublicationRecoveryResolutionV1Schema,
  ProjectInitializationAttemptEventV1Schema,
  asProjectInitializationAttemptEventId,
  foldProjectInitializationAttemptV1,
  type EnvironmentBindingEpochV1,
  type EnvironmentPublicationIntentV1,
  type EnvironmentPublicationRecoveryAuthorityV1,
  type EnvironmentPublicationRecoveryResolutionV1,
  type EnvironmentPublicationReceiptV1,
  type ProjectEnvironmentRevisionV1,
  type ProjectInitializationAttemptEventV1,
  type SourceId,
} from "@chronorift/domain";
import {
  ArtifactNotFoundError,
  ProjectEnvironmentCurrentConflictError,
  ProjectEnvironmentTaskStoreV1,
  contentHash,
  type ProjectEnvironmentStoreV1,
} from "@chronorift/json-artifacts";

import { openProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";
import {
  bindPublishedProjectEnvironmentV1,
  createEnvironmentPublicationReceiptV1,
  resolveInitialProjectEnvironmentPublicationV1,
} from "./project-environment-publication.js";

export interface ProjectEnvironmentPublicationReconciliationV1 {
  readonly schemaVersion: 1;
  readonly authority: EnvironmentPublicationRecoveryAuthorityV1;
  readonly resolution: EnvironmentPublicationRecoveryResolutionV1;
  readonly partialRevisionQuarantined: boolean;
}

export interface ReconcilePendingProjectEnvironmentPublicationV1Input {
  readonly projectStore: ProjectEnvironmentStoreV1;
  readonly resolveTaskStore: (
    authority: EnvironmentPublicationRecoveryAuthorityV1,
  ) => Promise<ProjectEnvironmentTaskStoreV1>;
  readonly inspectedSourceId: SourceId;
  readonly now?: (() => string) | undefined;
}

const cleanFailure = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\0]/gu, " ")
    .trim()
    .slice(0, 4_096) || "Project Environment publication recovery failed";

const authorityMatchesIntent = (
  authority: EnvironmentPublicationRecoveryAuthorityV1,
  intent: EnvironmentPublicationIntentV1,
): boolean =>
  authority.operationId === intent.operationId &&
  authority.taskId === intent.taskId &&
  authority.attemptId === intent.attemptId &&
  authority.environmentId === intent.environmentId &&
  authority.candidateId === intent.candidateId &&
  authority.sourceId === intent.sourceId &&
  authority.targetEnvironmentRevisionId ===
    intent.targetEnvironmentRevisionId &&
  authority.targetAdapterRevisionId === intent.targetAdapterRevisionId &&
  authority.expectedCurrentRevisionId === intent.expectedCurrentRevisionId &&
  authority.targetContentDigest === intent.targetContentDigest &&
  authority.createdAt === intent.createdAt;

const assertRevisionBindings = (
  authority: EnvironmentPublicationRecoveryAuthorityV1,
  revision: ProjectEnvironmentRevisionV1,
): void => {
  if (
    revision.environmentId !== authority.environmentId ||
    revision.environmentRevisionId !== authority.targetEnvironmentRevisionId ||
    revision.adapterRevisionId !== authority.targetAdapterRevisionId ||
    revision.sourceId !== authority.sourceId ||
    revision.publicationOperationId !== authority.operationId ||
    revision.contentDigest !== authority.targetContentDigest
  ) {
    throw new Error(
      "materialized revision does not match its publication recovery authority",
    );
  }
};

const recoveryResolution = (input: {
  readonly authority: EnvironmentPublicationRecoveryAuthorityV1;
  readonly outcome: "failed" | "binding_failed";
  readonly publicationCommitted: boolean;
  readonly publicationReceiptId:
    EnvironmentPublicationReceiptV1["receiptId"] | null;
  readonly failureCode: string;
  readonly failureMessage: string;
  readonly resolvedAt: string;
}): EnvironmentPublicationRecoveryResolutionV1 =>
  EnvironmentPublicationRecoveryResolutionV1Schema.parse({
    schemaVersion: 1,
    operationId: input.authority.operationId,
    taskId: input.authority.taskId,
    attemptId: input.authority.attemptId,
    environmentId: input.authority.environmentId,
    targetEnvironmentRevisionId: input.authority.targetEnvironmentRevisionId,
    outcome: input.outcome,
    publicationCommitted: input.publicationCommitted,
    publicationReceiptId: input.publicationReceiptId,
    bindingEpochId: null,
    failureCode: input.failureCode,
    failureMessage: input.failureMessage,
    resolvedAt: input.resolvedAt,
  });

const receiptFor = (input: {
  readonly authority: EnvironmentPublicationRecoveryAuthorityV1;
  readonly state: "absent" | "revision_incomplete" | "committed" | "conflict";
  readonly revisionMaterialized: boolean;
  readonly observedCurrentRevisionId:
    | EnvironmentPublicationRecoveryAuthorityV1["targetEnvironmentRevisionId"]
    | null;
  readonly completedAt: string;
}): EnvironmentPublicationReceiptV1 => {
  const committed = input.state === "committed";
  const conflict = input.state === "conflict";
  return createEnvironmentPublicationReceiptV1({
    schemaVersion: 1,
    operationId: input.authority.operationId,
    taskId: input.authority.taskId,
    attemptId: input.authority.attemptId,
    environmentId: input.authority.environmentId,
    targetEnvironmentRevisionId: input.authority.targetEnvironmentRevisionId,
    expectedCurrentRevisionId: null,
    observedCurrentRevisionId: input.observedCurrentRevisionId,
    realizedCurrentRevisionId: committed
      ? input.authority.targetEnvironmentRevisionId
      : input.observedCurrentRevisionId,
    revisionMaterialized: input.revisionMaterialized,
    pointerCommitted: committed,
    outcome: committed ? "committed" : conflict ? "conflict" : "failed",
    failures: committed
      ? []
      : [
          conflict
            ? "initial Project Environment current changed before recovery CAS"
            : input.state === "revision_incomplete"
              ? "incomplete Project Environment revision was quarantined during recovery"
              : "Project Environment revision was absent during recovery",
        ],
    completedAt: input.completedAt,
  });
};

const putOrReusePublicationReceipt = async (
  taskStore: ProjectEnvironmentTaskStoreV1,
  operationId: EnvironmentPublicationRecoveryAuthorityV1["operationId"],
  completedAt: string,
  build: (completedAt: string) => EnvironmentPublicationReceiptV1,
): Promise<EnvironmentPublicationReceiptV1> => {
  const existing =
    await taskStore.findPublicationReceiptByOperation(operationId);
  const expected = build(existing?.completedAt ?? completedAt);
  if (
    existing !== null &&
    JSON.stringify(existing) !== JSON.stringify(expected)
  ) {
    throw new Error(
      "existing publication receipt does not match its recovery authority and durable state",
    );
  }
  if (existing === null) await taskStore.putPublicationReceiptOnce(expected);
  return existing ?? expected;
};

const eventTime = (
  events: readonly ProjectInitializationAttemptEventV1[],
  now: () => string,
): string => {
  const observed = now();
  if (!Number.isFinite(Date.parse(observed))) {
    throw new TypeError(
      "publication recovery clock returned an invalid timestamp",
    );
  }
  const previous = events.at(-1)?.occurredAt;
  return previous === undefined || Date.parse(observed) >= Date.parse(previous)
    ? observed
    : previous;
};

const recoveryEventId = (
  authority: EnvironmentPublicationRecoveryAuthorityV1,
  sequence: number,
) =>
  asProjectInitializationAttemptEventId(
    `attempt-recovery-event.v1.${contentHash({
      schemaVersion: 1,
      operationId: authority.operationId,
      sequence,
    })}`,
  );

async function resolveWithoutTaskStore(input: {
  readonly projectStore: ProjectEnvironmentStoreV1;
  readonly authority: EnvironmentPublicationRecoveryAuthorityV1;
  readonly inspectionState:
    | "absent"
    | "revision_incomplete"
    | "revision_materialized"
    | "pointer_prepared"
    | "committed"
    | "conflict";
  readonly taskError: unknown;
  readonly partialRevisionQuarantined: boolean;
  readonly now: () => string;
}): Promise<ProjectEnvironmentPublicationReconciliationV1> {
  const publicationCommitted = input.inspectionState === "committed";
  const resolution = recoveryResolution({
    authority: input.authority,
    outcome: publicationCommitted ? "binding_failed" : "failed",
    publicationCommitted,
    publicationReceiptId: null,
    failureCode: publicationCommitted
      ? "publication_task_store_unavailable"
      : "publication_recovery_authority_unavailable",
    failureMessage: publicationCommitted
      ? `current revision remains committed, but its Task store could not be recovered: ${cleanFailure(input.taskError)}`
      : `publication stopped because its exact Task intent could not be recovered: ${cleanFailure(input.taskError)}`,
    resolvedAt: input.now(),
  });
  await input.projectStore.putPublicationRecoveryResolutionOnce(resolution);
  return Object.freeze({
    schemaVersion: 1,
    authority: input.authority,
    resolution,
    partialRevisionQuarantined: input.partialRevisionQuarantined,
  });
}

/**
 * Reconciles at most one discoverable PE-A publication. It never resumes the
 * Pi Session or dispatches a queued goal; the invoking command must stop after
 * returning this result.
 */
export async function reconcilePendingProjectEnvironmentPublicationV1(
  input: ReconcilePendingProjectEnvironmentPublicationV1Input,
): Promise<ProjectEnvironmentPublicationReconciliationV1 | null> {
  const now = input.now ?? (() => new Date().toISOString());
  const pending =
    await input.projectStore.listPendingPublicationRecoveryAuthorities();
  if (pending.length === 0) return null;
  if (pending.length !== 1) {
    throw new Error(
      "PE-A publication recovery found multiple unresolved authorities",
    );
  }
  const authority = pending[0]!;
  let inspection = await input.projectStore.inspectInitialPublication(
    authority.targetEnvironmentRevisionId,
    authority.operationId,
  );
  let partialRevisionQuarantined = false;
  if (inspection.state === "revision_incomplete") {
    await input.projectStore.quarantineIncompleteRevision(
      authority.targetEnvironmentRevisionId,
      authority.operationId,
    );
    partialRevisionQuarantined = true;
    inspection = await input.projectStore.inspectInitialPublication(
      authority.targetEnvironmentRevisionId,
      authority.operationId,
    );
  }

  let taskStore: ProjectEnvironmentTaskStoreV1;
  try {
    taskStore = await input.resolveTaskStore(authority);
  } catch (error) {
    return resolveWithoutTaskStore({
      projectStore: input.projectStore,
      authority,
      inspectionState: inspection.state,
      taskError: error,
      partialRevisionQuarantined,
      now,
    });
  }

  let intent: EnvironmentPublicationIntentV1;
  try {
    intent = EnvironmentPublicationIntentV1Schema.parse(
      await taskStore.readPublicationIntent(authority.operationId),
    );
  } catch (error) {
    return resolveWithoutTaskStore({
      projectStore: input.projectStore,
      authority,
      inspectionState: inspection.state,
      taskError: error,
      partialRevisionQuarantined,
      now,
    });
  }
  if (!authorityMatchesIntent(authority, intent)) {
    throw new Error(
      "Task publication intent does not match project recovery authority",
    );
  }
  try {
    const candidate = await taskStore.readCandidate(authority.candidateId);
    if (
      candidate.payload.taskId !== authority.taskId ||
      candidate.payload.attemptId !== authority.attemptId ||
      candidate.payload.candidateId !== authority.candidateId ||
      candidate.payload.sourceId !== authority.sourceId
    ) {
      throw new Error(
        "Task candidate does not match project publication recovery authority",
      );
    }
  } catch (error) {
    return resolveWithoutTaskStore({
      projectStore: input.projectStore,
      authority,
      inspectionState: inspection.state,
      taskError: error,
      partialRevisionQuarantined,
      now,
    });
  }

  const allEvents = await taskStore.readAttemptEvents();
  const events = allEvents.filter(
    (event) => event.attemptId === authority.attemptId,
  );
  let attempt = foldProjectInitializationAttemptV1(events);
  if (
    attempt.taskId !== authority.taskId ||
    attempt.sessionId !== authority.sessionId ||
    attempt.sourceId !== authority.sourceId ||
    attempt.candidateId !== authority.candidateId ||
    attempt.publicationOperationId !== authority.operationId
  ) {
    throw new Error(
      "Task attempt does not match project publication recovery authority",
    );
  }

  const storedRevision =
    inspection.state === "revision_materialized" ||
    inspection.state === "pointer_prepared" ||
    inspection.state === "committed"
      ? await input.projectStore.readRevision(
          authority.targetEnvironmentRevisionId,
          authority.operationId,
        )
      : null;
  if (storedRevision !== null) {
    assertRevisionBindings(authority, storedRevision.payload);
  }

  const append = async (
    fields: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    const event = ProjectInitializationAttemptEventV1Schema.parse({
      schemaVersion: 1,
      eventId: recoveryEventId(authority, events.length),
      attemptId: authority.attemptId,
      taskId: authority.taskId,
      sequence: events.length,
      occurredAt: eventTime(events, now),
      ...fields,
    });
    await taskStore.appendAttemptEvent(event);
    events.push(event);
    attempt = foldProjectInitializationAttemptV1(events);
  };

  if (
    attempt.state === "succeeded" ||
    attempt.state === "failed" ||
    attempt.state === "cancelled" ||
    attempt.state === "binding_failed"
  ) {
    if (attempt.state === "succeeded") {
      if (inspection.state !== "committed" || storedRevision === null) {
        throw new Error(
          "succeeded Task attempt has no exact committed project revision",
        );
      }
      const existingReceipt = await taskStore.findPublicationReceiptByOperation(
        authority.operationId,
      );
      if (existingReceipt === null) {
        throw new Error(
          "succeeded Task attempt is missing its publication receipt",
        );
      }
      const receipt = receiptFor({
        authority,
        state: "committed",
        revisionMaterialized: true,
        observedCurrentRevisionId: null,
        completedAt: existingReceipt.completedAt,
      });
      const binding = (await taskStore.readBindingEpochs()).find(
        (
          epoch,
        ): epoch is Extract<EnvironmentBindingEpochV1, { state: "bound" }> =>
          epoch.state === "bound" &&
          epoch.bindingEpochId === authority.bindingEpochId,
      );
      if (
        JSON.stringify(existingReceipt) !== JSON.stringify(receipt) ||
        binding === undefined
      ) {
        throw new Error(
          "succeeded Task attempt is missing its exact receipt or binding",
        );
      }
      const resolution = await resolveInitialProjectEnvironmentPublicationV1({
        projectStore: input.projectStore,
        intent,
        attempt,
        publication: receipt,
        binding,
        resolvedAt: now(),
      });
      return Object.freeze({
        schemaVersion: 1,
        authority,
        resolution,
        partialRevisionQuarantined,
      });
    }
    const committed = inspection.state === "committed";
    const resolution = recoveryResolution({
      authority,
      outcome:
        committed || attempt.state === "binding_failed"
          ? "binding_failed"
          : "failed",
      publicationCommitted: committed,
      publicationReceiptId: attempt.publicationReceiptId,
      failureCode:
        committed && attempt.state !== "binding_failed"
          ? "publication_binding_missing"
          : (attempt.terminalCode ?? "publication_recovery_failed"),
      failureMessage:
        committed && attempt.state !== "binding_failed"
          ? "current revision committed before the Task reached a recoverable binding state"
          : (attempt.terminalMessage ?? "publication recovery failed"),
      resolvedAt: now(),
    });
    await input.projectStore.putPublicationRecoveryResolutionOnce(resolution);
    return Object.freeze({
      schemaVersion: 1,
      authority,
      resolution,
      partialRevisionQuarantined,
    });
  }

  if (attempt.state !== "reconciling") {
    await append({
      eventKind: "reconciling",
      operationId: authority.operationId,
    });
  }

  if (
    inspection.state !== "committed" &&
    input.inspectedSourceId !== authority.sourceId
  ) {
    const receipt = await putOrReusePublicationReceipt(
      taskStore,
      authority.operationId,
      eventTime(events, now),
      (completedAt) =>
        createEnvironmentPublicationReceiptV1({
          schemaVersion: 1,
          operationId: authority.operationId,
          taskId: authority.taskId,
          attemptId: authority.attemptId,
          environmentId: authority.environmentId,
          targetEnvironmentRevisionId: authority.targetEnvironmentRevisionId,
          expectedCurrentRevisionId: null,
          observedCurrentRevisionId:
            inspection.current?.environmentRevisionId ?? null,
          realizedCurrentRevisionId:
            inspection.current?.environmentRevisionId ?? null,
          revisionMaterialized:
            inspection.state === "revision_materialized" ||
            inspection.state === "pointer_prepared",
          pointerCommitted: false,
          outcome: "failed",
          failures: [
            "inspected project source changed before publication recovery commit",
          ],
          completedAt,
        }),
    );
    await append({
      eventKind: "failed",
      failureCode: "publication_source_drift",
      message: receipt.failures[0],
    });
    await taskStore.putInitializationAttemptOnce(attempt);
    const resolution = await resolveInitialProjectEnvironmentPublicationV1({
      projectStore: input.projectStore,
      intent,
      attempt,
      publication: receipt,
      binding: null,
      resolvedAt: now(),
    });
    return Object.freeze({
      schemaVersion: 1,
      authority,
      resolution,
      partialRevisionQuarantined,
    });
  }

  if (
    inspection.state === "revision_materialized" ||
    inspection.state === "pointer_prepared" ||
    inspection.state === "committed"
  ) {
    try {
      inspection = await input.projectStore.reconcileInitialPublication({
        expectedCurrentRevisionId: null,
        environmentRevisionId: authority.targetEnvironmentRevisionId,
        publicationOperationId: authority.operationId,
        commitRequestedAt: authority.pointerCommitRequestedAt,
      });
    } catch (error) {
      if (!(error instanceof ProjectEnvironmentCurrentConflictError)) {
        throw error;
      }
      inspection = await input.projectStore.inspectInitialPublication(
        authority.targetEnvironmentRevisionId,
        authority.operationId,
      );
      if (inspection.state !== "conflict") throw error;
    }
  }

  if (inspection.state !== "committed") {
    const observed = inspection.current?.environmentRevisionId ?? null;
    let revisionMaterialized = false;
    if (inspection.state === "conflict") {
      try {
        const conflictingTarget = await input.projectStore.readRevision(
          authority.targetEnvironmentRevisionId,
          authority.operationId,
        );
        assertRevisionBindings(authority, conflictingTarget.payload);
        revisionMaterialized = true;
      } catch (error) {
        if (!(error instanceof ArtifactNotFoundError)) throw error;
      }
    }
    const failedState =
      inspection.state === "conflict"
        ? "conflict"
        : partialRevisionQuarantined
          ? "revision_incomplete"
          : "absent";
    const receipt = await putOrReusePublicationReceipt(
      taskStore,
      authority.operationId,
      eventTime(events, now),
      (completedAt) =>
        receiptFor({
          authority,
          state: failedState,
          revisionMaterialized,
          observedCurrentRevisionId: observed,
          completedAt,
        }),
    );
    await append({
      eventKind: "failed",
      failureCode:
        inspection.state === "conflict"
          ? "publication_conflict"
          : partialRevisionQuarantined
            ? "publication_revision_incomplete"
            : "publication_revision_absent",
      message: receipt.failures[0],
    });
    await taskStore.putInitializationAttemptOnce(attempt);
    const resolution = await resolveInitialProjectEnvironmentPublicationV1({
      projectStore: input.projectStore,
      intent,
      attempt,
      publication: receipt,
      binding: null,
      resolvedAt: now(),
    });
    return Object.freeze({
      schemaVersion: 1,
      authority,
      resolution,
      partialRevisionQuarantined,
    });
  }

  const revision =
    storedRevision?.payload ??
    (
      await input.projectStore.readRevision(
        authority.targetEnvironmentRevisionId,
        authority.operationId,
      )
    ).payload;
  assertRevisionBindings(authority, revision);
  const receipt = await putOrReusePublicationReceipt(
    taskStore,
    authority.operationId,
    eventTime(events, now),
    (completedAt) =>
      receiptFor({
        authority,
        state: "committed",
        revisionMaterialized: true,
        observedCurrentRevisionId: null,
        completedAt,
      }),
  );
  await append({
    eventKind: "publication_committed",
    operationId: authority.operationId,
    environmentRevisionId: authority.targetEnvironmentRevisionId,
    adapterRevisionId: authority.targetAdapterRevisionId,
    publicationReceiptId: receipt.receiptId,
  });
  await append({ eventKind: "binding" });

  let binding: EnvironmentBindingEpochV1;
  try {
    const existing = (await taskStore.readBindingEpochs()).find(
      (epoch) => epoch.bindingEpochId === authority.bindingEpochId,
    );
    binding = await bindPublishedProjectEnvironmentV1({
      taskStore,
      taskId: authority.taskId,
      attemptId: authority.attemptId,
      bindingEpochId: authority.bindingEpochId,
      ordinal: authority.bindingOrdinal,
      revision,
      publication: receipt,
      createdAt:
        existing?.state === "bound"
          ? existing.createdAt
          : eventTime(events, now),
      boundAt:
        existing?.state === "bound" ? existing.boundAt : eventTime(events, now),
    });
  } catch (error) {
    await append({
      eventKind: "binding_failed",
      failureCode: "publication_binding_conflict",
      message: cleanFailure(error),
    });
    await taskStore.putInitializationAttemptOnce(attempt);
    const resolution = recoveryResolution({
      authority,
      outcome: "binding_failed",
      publicationCommitted: true,
      publicationReceiptId: receipt.receiptId,
      failureCode: "publication_binding_conflict",
      failureMessage: cleanFailure(error),
      resolvedAt: now(),
    });
    await input.projectStore.putPublicationRecoveryResolutionOnce(resolution);
    return Object.freeze({
      schemaVersion: 1,
      authority,
      resolution,
      partialRevisionQuarantined,
    });
  }

  if (binding.state !== "bound") {
    throw new Error("publication recovery produced a non-bound binding epoch");
  }
  await append({
    eventKind: "succeeded",
    bindingEpochId: authority.bindingEpochId,
  });
  await taskStore.putInitializationAttemptOnce(attempt);
  const resolution = await resolveInitialProjectEnvironmentPublicationV1({
    projectStore: input.projectStore,
    intent,
    attempt,
    publication: receipt,
    binding,
    resolvedAt: now(),
  });
  return Object.freeze({
    schemaVersion: 1,
    authority,
    resolution,
    partialRevisionQuarantined,
  });
}

/** Resolve the opaque Task ID only beneath the already admitted Host root. */
export function reconcilePendingProjectEnvironmentPublicationFromRuntimeRootV1(input: {
  readonly projectStore: ProjectEnvironmentStoreV1;
  readonly runtimeRoot: string;
  readonly inspectedSourceId: SourceId;
  readonly now?: (() => string) | undefined;
}): Promise<ProjectEnvironmentPublicationReconciliationV1 | null> {
  return reconcilePendingProjectEnvironmentPublicationV1({
    projectStore: input.projectStore,
    inspectedSourceId: input.inspectedSourceId,
    ...(input.now === undefined ? {} : { now: input.now }),
    resolveTaskStore: async (authority) => {
      const layout = await openProjectEnvironmentTaskDirectoryLayout({
        runtimeRoot: input.runtimeRoot,
        taskId: authority.taskId,
      });
      const taskStore = new ProjectEnvironmentTaskStoreV1({
        storeRoot: layout.projectEnvironmentRecordDirectory,
        taskId: authority.taskId,
      });
      await taskStore.open();
      return taskStore;
    },
  });
}
