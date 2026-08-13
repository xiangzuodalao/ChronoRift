import {
  EnvironmentBindingEpochV1Schema,
  EnvironmentPublicationIntentV1Schema,
  EnvironmentPublicationRecoveryAuthorityV1Schema,
  EnvironmentPublicationRecoveryResolutionV1Schema,
  EnvironmentPublicationReceiptV1Schema,
  ProjectEnvironmentRevisionReferenceV1Schema,
  asEnvironmentPublicationReceiptId,
  type EnvironmentBindingEpochId,
  type EnvironmentBindingEpochV1,
  type EnvironmentPublicationIntentV1,
  type EnvironmentPublicationRecoveryAuthorityV1,
  type EnvironmentPublicationRecoveryResolutionV1,
  type EnvironmentPublicationReceiptV1,
  type ProjectEnvironmentRevisionV1,
  type ProjectInitializationAttemptV1,
  type ProjectInitializationAttemptId,
  type ProjectSessionId,
  type ProjectToolchainReceiptId,
  type Sha256DigestV1,
  type SourceId,
  type TaskId,
} from "@chronorift/domain";
import {
  ProjectEnvironmentCurrentConflictError,
  type ProjectEnvironmentPackageFileInputV1,
  type ProjectEnvironmentStoreV1,
  type ProjectEnvironmentTaskStoreV1,
  contentHash,
  projectEnvironmentPackageContentDigestV1,
} from "@chronorift/json-artifacts";

const jsonFact = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Parameters<typeof contentHash>[0];

const receiptId = (value: unknown) =>
  asEnvironmentPublicationReceiptId(
    `publication-receipt:v1:${contentHash(jsonFact(value))}`,
  );

export const createEnvironmentPublicationReceiptV1 = (
  value: Omit<EnvironmentPublicationReceiptV1, "receiptId">,
): EnvironmentPublicationReceiptV1 =>
  EnvironmentPublicationReceiptV1Schema.parse({
    ...value,
    receiptId: receiptId(value),
  });

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\0]/gu, " ")
    .slice(0, 4_096) || "Project Environment publication failed";

const revisionReference = (revision: ProjectEnvironmentRevisionV1) =>
  ProjectEnvironmentRevisionReferenceV1Schema.parse({
    schemaVersion: 1,
    environmentId: revision.environmentId,
    environmentRevisionId: revision.environmentRevisionId,
    sourceId: revision.sourceId,
    adapterRevisionId: revision.adapterRevisionId,
    sdkDigest: revision.sdkDigest,
    bridgeDigest: revision.bridgeDigest,
    toolchainReceiptId: revision.toolchainReceiptId,
    conformanceReceiptId: revision.conformanceReceiptId,
    observerEffectReceiptId: revision.observerEffectReceiptId,
    policyProfileDigest: revision.policyProfileDigest,
    contentDigest: revision.contentDigest,
  });

export interface InitialProjectEnvironmentPublicationV1Request {
  readonly taskStore: ProjectEnvironmentTaskStoreV1;
  readonly projectStore: ProjectEnvironmentStoreV1;
  readonly intent: EnvironmentPublicationIntentV1;
  readonly sessionId: ProjectSessionId;
  readonly bindingEpochId: EnvironmentBindingEpochId;
  readonly revision: ProjectEnvironmentRevisionV1;
  readonly revisionFiles: readonly ProjectEnvironmentPackageFileInputV1[];
  /** Timestamp selected before the atomic pointer CAS; it is not completion. */
  readonly pointerCommitRequestedAt: string;
  readonly now?: (() => string) | undefined;
}

export const initialProjectEnvironmentRecoveryAuthorityV1 = (
  request: InitialProjectEnvironmentPublicationV1Request,
): EnvironmentPublicationRecoveryAuthorityV1 =>
  EnvironmentPublicationRecoveryAuthorityV1Schema.parse({
    schemaVersion: 1,
    operationId: request.intent.operationId,
    taskId: request.intent.taskId,
    attemptId: request.intent.attemptId,
    sessionId: request.sessionId,
    bindingEpochId: request.bindingEpochId,
    bindingOrdinal: 0,
    environmentId: request.intent.environmentId,
    candidateId: request.intent.candidateId,
    sourceId: request.intent.sourceId,
    targetEnvironmentRevisionId: request.intent.targetEnvironmentRevisionId,
    targetAdapterRevisionId: request.intent.targetAdapterRevisionId,
    expectedCurrentRevisionId: null,
    targetContentDigest: request.intent.targetContentDigest,
    pointerCommitRequestedAt: request.pointerCommitRequestedAt,
    createdAt: request.intent.createdAt,
  });

const assertPublicationBindings = (
  request: InitialProjectEnvironmentPublicationV1Request,
): EnvironmentPublicationIntentV1 => {
  const intent = EnvironmentPublicationIntentV1Schema.parse(request.intent);
  if (
    request.taskStore.taskId !== intent.taskId ||
    request.projectStore.environmentId !== intent.environmentId ||
    request.revision.environmentId !== intent.environmentId ||
    request.revision.environmentRevisionId !==
      intent.targetEnvironmentRevisionId ||
    request.revision.adapterRevisionId !== intent.targetAdapterRevisionId ||
    request.revision.sourceId !== intent.sourceId ||
    request.revision.publicationOperationId !== intent.operationId ||
    request.revision.contentDigest !== intent.targetContentDigest ||
    intent.expectedCurrentRevisionId !== null ||
    request.revision.contentDigest !==
      projectEnvironmentPackageContentDigestV1(request.revisionFiles)
  ) {
    throw new TypeError(
      "initial publication crossed its Task, environment, source, revision, operation, or content binding",
    );
  }
  return intent;
};

/**
 * Publish a fully materialized immutable revision, then atomically make it
 * current. The persisted Task intent is the recovery authority; current is
 * never used to infer which attempted publication a Task meant.
 */
export async function publishInitialProjectEnvironmentV1(
  request: InitialProjectEnvironmentPublicationV1Request,
): Promise<EnvironmentPublicationReceiptV1> {
  const intent = assertPublicationBindings(request);
  await request.taskStore.putPublicationIntentOnce(intent);
  await request.projectStore.putPublicationRecoveryAuthorityOnce(
    initialProjectEnvironmentRecoveryAuthorityV1(request),
  );
  let revisionMaterialized = false;
  let pointerCommitted = false;
  const initialCurrent = await request.projectStore.readCurrent();
  let observedCurrentRevisionId =
    initialCurrent?.environmentRevisionId ===
      intent.targetEnvironmentRevisionId &&
    initialCurrent.publicationOperationId === intent.operationId
      ? null
      : (initialCurrent?.environmentRevisionId ?? null);
  const failures: string[] = [];
  let outcome: "committed" | "conflict" | "failed" = "failed";
  const commit = {
    expectedCurrentRevisionId: null,
    environmentRevisionId: request.revision.environmentRevisionId,
    publicationOperationId: intent.operationId,
    commitRequestedAt: request.pointerCommitRequestedAt,
  } as const;
  try {
    await request.projectStore.materializeRevisionOnce(
      request.revision,
      request.revisionFiles,
    );
    revisionMaterialized = true;
    await request.projectStore.prepareInitialCurrent(commit);
    const reconciled =
      await request.projectStore.reconcileInitialPublication(commit);
    pointerCommitted = reconciled.state === "committed";
    if (!pointerCommitted) {
      throw new Error(
        `initial publication reconciliation stopped at ${reconciled.state}`,
      );
    }
    outcome = "committed";
  } catch (error) {
    const durable = await request.projectStore
      .inspectInitialPublication(
        request.revision.environmentRevisionId,
        intent.operationId,
      )
      .catch(() => null);
    if (durable?.state === "committed") {
      revisionMaterialized = true;
      pointerCommitted = true;
      outcome = "committed";
      const cleaned =
        await request.projectStore.reconcileInitialPublication(commit);
      if (cleaned.state !== "committed") {
        throw new Error(
          `durable publication cleanup stopped at ${cleaned.state}`,
        );
      }
    } else {
      observedCurrentRevisionId =
        durable?.current?.environmentRevisionId ?? observedCurrentRevisionId;
      outcome =
        durable?.state === "conflict" ||
        error instanceof ProjectEnvironmentCurrentConflictError
          ? "conflict"
          : "failed";
      failures.push(message(error));
    }
  }
  const completedAt = (request.now ?? (() => new Date().toISOString()))();
  if (!Number.isFinite(Date.parse(completedAt))) {
    throw new TypeError(
      "publication completion clock returned an invalid timestamp",
    );
  }
  const realizedCurrentRevisionId = pointerCommitted
    ? request.revision.environmentRevisionId
    : observedCurrentRevisionId;
  const receiptContent = {
    schemaVersion: 1 as const,
    operationId: intent.operationId,
    taskId: intent.taskId,
    attemptId: intent.attemptId,
    environmentId: intent.environmentId,
    targetEnvironmentRevisionId: intent.targetEnvironmentRevisionId,
    expectedCurrentRevisionId: null,
    observedCurrentRevisionId,
    realizedCurrentRevisionId,
    revisionMaterialized,
    pointerCommitted,
    outcome,
    failures,
    completedAt,
  };
  const existing = await request.taskStore.findPublicationReceiptByOperation(
    intent.operationId,
  );
  const receipt =
    existing ?? createEnvironmentPublicationReceiptV1(receiptContent);
  if (
    existing !== null &&
    (existing.taskId !== intent.taskId ||
      existing.attemptId !== intent.attemptId ||
      existing.environmentId !== intent.environmentId ||
      existing.targetEnvironmentRevisionId !==
        intent.targetEnvironmentRevisionId ||
      existing.expectedCurrentRevisionId !== null ||
      existing.observedCurrentRevisionId !== observedCurrentRevisionId ||
      existing.realizedCurrentRevisionId !== realizedCurrentRevisionId ||
      existing.revisionMaterialized !== revisionMaterialized ||
      existing.pointerCommitted !== pointerCommitted ||
      existing.outcome !== outcome)
  ) {
    throw new TypeError(
      "existing publication receipt does not match its exact publication operation",
    );
  }
  await request.taskStore.putPublicationReceiptOnce(receipt);
  return receipt;
}

export async function resolveInitialProjectEnvironmentPublicationV1(input: {
  readonly projectStore: ProjectEnvironmentStoreV1;
  readonly intent: EnvironmentPublicationIntentV1;
  readonly attempt: ProjectInitializationAttemptV1;
  readonly publication: EnvironmentPublicationReceiptV1;
  readonly binding: EnvironmentBindingEpochV1 | null;
  readonly resolvedAt: string;
}): Promise<EnvironmentPublicationRecoveryResolutionV1> {
  const intent = EnvironmentPublicationIntentV1Schema.parse(input.intent);
  const publication = EnvironmentPublicationReceiptV1Schema.parse(
    input.publication,
  );
  const authority = await input.projectStore.readPublicationRecoveryAuthority(
    intent.operationId,
  );
  if (
    authority.taskId !== intent.taskId ||
    authority.attemptId !== intent.attemptId ||
    authority.environmentId !== intent.environmentId ||
    authority.candidateId !== intent.candidateId ||
    authority.sourceId !== intent.sourceId ||
    authority.targetEnvironmentRevisionId !==
      intent.targetEnvironmentRevisionId ||
    authority.targetAdapterRevisionId !== intent.targetAdapterRevisionId ||
    authority.expectedCurrentRevisionId !== intent.expectedCurrentRevisionId ||
    authority.targetContentDigest !== intent.targetContentDigest ||
    input.attempt.taskId !== intent.taskId ||
    input.attempt.attemptId !== intent.attemptId ||
    input.attempt.sessionId !== authority.sessionId ||
    input.attempt.sourceId !== authority.sourceId ||
    input.attempt.candidateId !== authority.candidateId ||
    input.attempt.publicationOperationId !== authority.operationId ||
    publication.operationId !== intent.operationId ||
    publication.taskId !== intent.taskId ||
    publication.attemptId !== intent.attemptId ||
    publication.environmentId !== authority.environmentId ||
    publication.targetEnvironmentRevisionId !==
      authority.targetEnvironmentRevisionId ||
    publication.expectedCurrentRevisionId !== null
  ) {
    throw new TypeError(
      "publication recovery resolution crossed its authority, intent, attempt, or receipt binding",
    );
  }
  const terminal = input.attempt.state;
  const succeeded = terminal === "succeeded";
  const bindingFailed = terminal === "binding_failed";
  if (
    !succeeded &&
    !bindingFailed &&
    terminal !== "failed" &&
    terminal !== "cancelled"
  ) {
    throw new TypeError(
      "publication recovery can be resolved only from a terminal attempt",
    );
  }
  const binding =
    input.binding === null
      ? null
      : EnvironmentBindingEpochV1Schema.parse(input.binding);
  if (binding !== null && binding.state !== "bound") {
    throw new TypeError(
      "initial publication recovery accepts only a bound binding epoch",
    );
  }
  if (
    succeeded !== (binding?.state === "bound") ||
    (binding !== null &&
      (binding.taskId !== authority.taskId ||
        binding.attemptId !== authority.attemptId ||
        binding.bindingEpochId !== authority.bindingEpochId ||
        binding.publicationOperationId !== authority.operationId ||
        binding.publicationReceiptId !== publication.receiptId ||
        binding.environment.environmentId !== authority.environmentId ||
        binding.environment.environmentRevisionId !==
          authority.targetEnvironmentRevisionId ||
        binding.environment.adapterRevisionId !==
          authority.targetAdapterRevisionId ||
        binding.environment.sourceId !== authority.sourceId ||
        binding.environment.contentDigest !== authority.targetContentDigest)) ||
    (succeeded && publication.outcome !== "committed") ||
    (bindingFailed && publication.outcome !== "committed") ||
    (!succeeded && !bindingFailed && publication.outcome === "committed")
  ) {
    throw new TypeError(
      "terminal attempt does not match its publication recovery facts",
    );
  }
  const resolution = EnvironmentPublicationRecoveryResolutionV1Schema.parse({
    schemaVersion: 1,
    operationId: authority.operationId,
    taskId: authority.taskId,
    attemptId: authority.attemptId,
    environmentId: authority.environmentId,
    targetEnvironmentRevisionId: authority.targetEnvironmentRevisionId,
    outcome: succeeded
      ? "succeeded"
      : bindingFailed
        ? "binding_failed"
        : "failed",
    publicationCommitted: publication.outcome === "committed",
    publicationReceiptId: publication.receiptId,
    bindingEpochId: binding?.bindingEpochId ?? null,
    failureCode: succeeded ? null : input.attempt.terminalCode,
    failureMessage: succeeded ? null : input.attempt.terminalMessage,
    resolvedAt: input.resolvedAt,
  });
  await input.projectStore.putPublicationRecoveryResolutionOnce(resolution);
  return resolution;
}

export async function bindPublishedProjectEnvironmentV1(input: {
  readonly taskStore: ProjectEnvironmentTaskStoreV1;
  readonly taskId: TaskId;
  readonly attemptId: ProjectInitializationAttemptId;
  readonly bindingEpochId: EnvironmentBindingEpochId;
  readonly ordinal: number;
  readonly revision: ProjectEnvironmentRevisionV1;
  readonly publication: EnvironmentPublicationReceiptV1;
  readonly createdAt: string;
  readonly boundAt: string;
}): Promise<EnvironmentBindingEpochV1> {
  const publication = EnvironmentPublicationReceiptV1Schema.parse(
    input.publication,
  );
  if (
    input.taskStore.taskId !== input.taskId ||
    publication.outcome !== "committed" ||
    publication.taskId !== input.taskId ||
    publication.attemptId !== input.attemptId ||
    publication.targetEnvironmentRevisionId !==
      input.revision.environmentRevisionId
  ) {
    throw new TypeError("Task binding does not match a committed publication");
  }
  const binding = EnvironmentBindingEpochV1Schema.parse({
    schemaVersion: 1,
    bindingEpochId: input.bindingEpochId,
    taskId: input.taskId,
    ordinal: input.ordinal,
    state: "bound",
    attemptId: input.attemptId,
    environment: revisionReference(input.revision),
    publicationOperationId: publication.operationId,
    publicationReceiptId: publication.receiptId,
    createdAt: input.createdAt,
    boundAt: input.boundAt,
  });
  const epochs = await input.taskStore.readBindingEpochs();
  const existing = epochs.find(
    (epoch) => epoch.bindingEpochId === binding.bindingEpochId,
  );
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(binding)) {
      throw new TypeError(
        "Task binding recovery found a conflicting binding epoch",
      );
    }
    return existing;
  }
  if (
    epochs.some(
      (epoch) =>
        epoch.ordinal === binding.ordinal ||
        ("attemptId" in epoch && epoch.attemptId === input.attemptId),
    )
  ) {
    throw new TypeError(
      "Task binding recovery found an existing epoch for this attempt or ordinal",
    );
  }
  await input.taskStore.appendBindingEpoch(binding);
  return binding;
}

export interface ReusableProjectEnvironmentRevisionV1 {
  readonly revision: ProjectEnvironmentRevisionV1;
  readonly files: readonly ProjectEnvironmentPackageFileInputV1[];
}

/** Exact identity review only; the caller must still run the PE-A reuse smoke. */
export async function readReusableProjectEnvironmentRevisionV1(input: {
  readonly projectStore: ProjectEnvironmentStoreV1;
  readonly sourceId: SourceId;
  readonly sdkDigest: Sha256DigestV1;
  readonly bridgeDigest: Sha256DigestV1;
  readonly toolchainReceiptId: ProjectToolchainReceiptId;
  readonly policyProfileDigest: Sha256DigestV1;
}): Promise<ReusableProjectEnvironmentRevisionV1 | null> {
  const current = await input.projectStore.readCurrent();
  if (current === null) return null;
  const stored = await input.projectStore.readRevision(
    current.environmentRevisionId,
    current.publicationOperationId,
  );
  const revision = stored.payload;
  if (
    revision.sourceId !== input.sourceId ||
    revision.sdkDigest !== input.sdkDigest ||
    revision.bridgeDigest !== input.bridgeDigest ||
    revision.toolchainReceiptId !== input.toolchainReceiptId ||
    revision.policyProfileDigest !== input.policyProfileDigest
  ) {
    return null;
  }
  return Object.freeze({
    revision,
    files: Object.freeze(
      stored.files.map((file) =>
        Object.freeze({ path: file.path, bytes: Uint8Array.from(file.bytes) }),
      ),
    ),
  });
}
