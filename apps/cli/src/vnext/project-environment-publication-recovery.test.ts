import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EnvironmentBindingEpochV1Schema,
  EnvironmentPublicationIntentV1Schema,
  EnvironmentPublicationRecoveryAuthorityV1Schema,
  ProjectAdapterCandidateReferenceV1Schema,
  ProjectEnvironmentRevisionV1Schema,
  ProjectInitializationAttemptEventV1Schema,
  asAdapterConformanceReceiptId,
  asAdapterId,
  asEnvironmentBindingEpochId,
  asObserverEffectReceiptId,
  asProjectAdapterCandidateId,
  asProjectAdapterRevisionId,
  asProjectEnvironmentId,
  asProjectEnvironmentOperationId,
  asProjectEnvironmentRevisionId,
  asProjectEnvironmentTaskId,
  asProjectInitializationAttemptEventId,
  asProjectInitializationAttemptId,
  asProjectSessionId,
  asProjectToolchainReceiptId,
  asSha256DigestV1,
  asSourceId,
  type EnvironmentPublicationRecoveryAuthorityV1,
  type ProjectInitializationAttemptEventV1,
} from "@chronorift/domain";
import {
  ArtifactPathSecurityError,
  ProjectEnvironmentStoreV1,
  ProjectEnvironmentTaskStoreV1,
  projectEnvironmentPackageContentDigestV1,
} from "@chronorift/json-artifacts";

import {
  initialProjectEnvironmentRecoveryAuthorityV1,
  createEnvironmentPublicationReceiptV1,
} from "./project-environment-publication.js";
import { reconcilePendingProjectEnvironmentPublicationV1 } from "./project-environment-publication-recovery.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const timestamp = (second = 0): string =>
  `2026-08-12T00:00:${String(second).padStart(2, "0")}.000Z`;
const digest = (value: string) =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));
const resourceDigest = (
  storeKind: string,
  ownerId: string,
  resourceId: string,
): string =>
  createHash("sha256")
    .update(`${storeKind}\0${ownerId}\0${resourceId}`)
    .digest("hex");

const budget = {
  schemaVersion: 1 as const,
  wallTimeMs: 60_000,
  toolCallLimit: 32,
  runtimeTimeMs: 30_000,
  tokenPolicy: "observe_only" as const,
  tokenLimit: null,
  storageByteLimit: 16_777_216,
  storageInodeLimit: 1_024,
};

async function setup(suffix: string) {
  const root = await mkdtemp(
    join(tmpdir(), `chronorift-pe-recovery-${suffix}-`),
  );
  roots.push(root);
  const taskId = asProjectEnvironmentTaskId(`task:recovery:${suffix}`);
  const attemptId = asProjectInitializationAttemptId(
    `attempt:recovery:${suffix}`,
  );
  const sessionId = asProjectSessionId(`session:recovery:${suffix}`);
  const bindingEpochId = asEnvironmentBindingEpochId(
    `binding:recovery:${suffix}`,
  );
  const environmentId = asProjectEnvironmentId(
    `environment:recovery:${suffix}`,
  );
  const sourceId = asSourceId(`source:recovery:${suffix}`);
  const operationId = asProjectEnvironmentOperationId(
    `operation:recovery:${suffix}`,
  );
  const environmentRevisionId = asProjectEnvironmentRevisionId(
    `environment-revision:recovery:${suffix}`,
  );
  const adapterRevisionId = asProjectAdapterRevisionId(
    `adapter-revision:recovery:${suffix}`,
  );
  const candidateId = asProjectAdapterCandidateId(
    `candidate:recovery:${suffix}`,
  );
  const adapterId = asAdapterId(`adapter:recovery:${suffix}`);
  const files = [
    { path: "adapter/manifest.json", bytes: Buffer.from("{}\n") },
    {
      path: "adapter/src/project_adapter.gd",
      bytes: Buffer.from("extends RefCounted\n"),
    },
  ];
  const candidate = ProjectAdapterCandidateReferenceV1Schema.parse({
    schemaVersion: 1,
    taskId,
    attemptId,
    candidateId,
    adapterId,
    sourceId,
    contentDigest: projectEnvironmentPackageContentDigestV1(files),
    fileCount: files.length,
    byteLength: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
    frozenAt: timestamp(2),
  });
  const revision = ProjectEnvironmentRevisionV1Schema.parse({
    schemaVersion: 1,
    environmentId,
    environmentRevisionId,
    sourceId,
    adapterRevisionId,
    sdkDigest: digest(`sdk:${suffix}`),
    bridgeDigest: digest(`bridge:${suffix}`),
    toolchainReceiptId: asProjectToolchainReceiptId(
      `toolchain:recovery:${suffix}`,
    ),
    conformanceReceiptId: asAdapterConformanceReceiptId(
      `conformance:recovery:${suffix}`,
    ),
    observerEffectReceiptId: asObserverEffectReceiptId(
      `observer:recovery:${suffix}`,
    ),
    policyProfileDigest: digest(`policy:${suffix}`),
    publicationOperationId: operationId,
    contentDigest: projectEnvironmentPackageContentDigestV1(files),
    publishedAt: timestamp(4),
  });
  const intent = EnvironmentPublicationIntentV1Schema.parse({
    schemaVersion: 1,
    operationId,
    taskId,
    attemptId,
    environmentId,
    candidateId,
    sourceId,
    targetEnvironmentRevisionId: environmentRevisionId,
    targetAdapterRevisionId: adapterRevisionId,
    expectedCurrentRevisionId: null,
    targetContentDigest: revision.contentDigest,
    createdAt: timestamp(4),
  });
  const taskStoreRoot = join(root, "task");
  const projectNamespace = join(root, "project");
  const taskStore = new ProjectEnvironmentTaskStoreV1({
    storeRoot: taskStoreRoot,
    taskId,
  });
  const projectStore = new ProjectEnvironmentStoreV1({
    namespaceRoot: projectNamespace,
    environmentId,
  });
  await Promise.all([taskStore.create(), projectStore.create()]);
  await taskStore.putCandidateOnce(candidate, files);

  const events: ProjectInitializationAttemptEventV1[] = [
    ProjectInitializationAttemptEventV1Schema.parse({
      schemaVersion: 1,
      eventId: asProjectInitializationAttemptEventId(
        `event:recovery:${suffix}:0`,
      ),
      attemptId,
      taskId,
      sequence: 0,
      occurredAt: timestamp(0),
      eventKind: "created",
      predecessorAttemptId: null,
      sessionId,
      sourceId,
      providerId: "provider:test",
      modelId: "model:test",
      thinkingLevel: "high",
      budget,
    }),
    ProjectInitializationAttemptEventV1Schema.parse({
      schemaVersion: 1,
      eventId: asProjectInitializationAttemptEventId(
        `event:recovery:${suffix}:1`,
      ),
      attemptId,
      taskId,
      sequence: 1,
      occurredAt: timestamp(1),
      eventKind: "agent_running",
    }),
    ProjectInitializationAttemptEventV1Schema.parse({
      schemaVersion: 1,
      eventId: asProjectInitializationAttemptEventId(
        `event:recovery:${suffix}:2`,
      ),
      attemptId,
      taskId,
      sequence: 2,
      occurredAt: timestamp(2),
      eventKind: "candidate_frozen",
      candidate,
    }),
    ProjectInitializationAttemptEventV1Schema.parse({
      schemaVersion: 1,
      eventId: asProjectInitializationAttemptEventId(
        `event:recovery:${suffix}:3`,
      ),
      attemptId,
      taskId,
      sequence: 3,
      occurredAt: timestamp(3),
      eventKind: "validating",
    }),
    ProjectInitializationAttemptEventV1Schema.parse({
      schemaVersion: 1,
      eventId: asProjectInitializationAttemptEventId(
        `event:recovery:${suffix}:4`,
      ),
      attemptId,
      taskId,
      sequence: 4,
      occurredAt: timestamp(4),
      eventKind: "publishing",
      operationId,
    }),
  ];
  for (const event of events) await taskStore.appendAttemptEvent(event);
  await taskStore.putPublicationIntentOnce(intent);
  const authority = initialProjectEnvironmentRecoveryAuthorityV1({
    taskStore,
    projectStore,
    intent,
    sessionId,
    bindingEpochId,
    revision,
    revisionFiles: files,
    pointerCommitRequestedAt: timestamp(5),
    now: () => timestamp(5),
  });
  await projectStore.putPublicationRecoveryAuthorityOnce(authority);

  const reopen = async () => {
    const reopenedProject = new ProjectEnvironmentStoreV1({
      namespaceRoot: projectNamespace,
      environmentId,
    });
    await reopenedProject.open();
    const resolveTaskStore = async (
      observed: EnvironmentPublicationRecoveryAuthorityV1,
    ) => {
      expect(observed.taskId).toBe(taskId);
      const reopenedTask = new ProjectEnvironmentTaskStoreV1({
        storeRoot: taskStoreRoot,
        taskId: observed.taskId,
      });
      await reopenedTask.open();
      return reopenedTask;
    };
    return { reopenedProject, resolveTaskStore };
  };
  const reconcile = async () => {
    const reopened = await reopen();
    return {
      ...reopened,
      result: await reconcilePendingProjectEnvironmentPublicationV1({
        projectStore: reopened.reopenedProject,
        resolveTaskStore: reopened.resolveTaskStore,
        inspectedSourceId: sourceId,
        now: () => timestamp(10),
      }),
    };
  };
  return {
    root,
    taskId,
    attemptId,
    bindingEpochId,
    environmentId,
    operationId,
    environmentRevisionId,
    adapterRevisionId,
    taskStoreRoot,
    projectNamespace,
    taskStore,
    projectStore,
    revision,
    files,
    intent,
    authority,
    events,
    reopen,
    reconcile,
    sourceId,
  };
}

async function expectRecoveredExactly(
  value: Awaited<ReturnType<typeof setup>>,
) {
  const recovered = await value.reconcile();
  expect(recovered.result).toMatchObject({
    resolution: { outcome: "succeeded", publicationCommitted: true },
  });
  await expect(recovered.reopenedProject.readCurrent()).resolves.toMatchObject({
    environmentRevisionId: value.environmentRevisionId,
    publicationOperationId: value.operationId,
    commitRequestedAt: timestamp(5),
  });
  const task = await recovered.resolveTaskStore(value.authority);
  await expect(task.readBindingEpochs()).resolves.toEqual([
    expect.objectContaining({
      state: "bound",
      bindingEpochId: value.bindingEpochId,
      publicationOperationId: value.operationId,
    }),
  ]);
  const resolutionReceiptId = recovered.result?.resolution.publicationReceiptId;
  expect(resolutionReceiptId).not.toBeNull();
  if (resolutionReceiptId === null || resolutionReceiptId === undefined) {
    throw new Error("successful recovery did not preserve its receipt ID");
  }
  await expect(
    task.readPublicationReceipt(resolutionReceiptId),
  ).resolves.toMatchObject({
    expectedCurrentRevisionId: null,
    observedCurrentRevisionId: null,
    realizedCurrentRevisionId: value.environmentRevisionId,
  });
  const attemptEvents = (await task.readAttemptEvents()).filter(
    (event) => event.attemptId === value.attemptId,
  );
  expect(attemptEvents.at(-1)?.eventKind).toBe("succeeded");
  const second = await value.reopen();
  await expect(
    reconcilePendingProjectEnvironmentPublicationV1({
      projectStore: second.reopenedProject,
      resolveTaskStore: second.resolveTaskStore,
      inspectedSourceId: value.sourceId,
      now: () => timestamp(11),
    }),
  ).resolves.toBeNull();
}

describe("PE-A cross-command publication reconciliation", () => {
  it("persists a strict path-free recovery authority before project mutation", async () => {
    const value = await setup("authority");
    await expect(
      value.projectStore.readPublicationRecoveryAuthority(value.operationId),
    ).resolves.toEqual(value.authority);
    await expect(value.projectStore.summary()).resolves.toMatchObject({
      pendingPublicationRecoveries: 1,
      resolvedPublicationRecoveries: 0,
    });
    expect(JSON.stringify(value.authority)).not.toContain(value.root);
    expect(() =>
      EnvironmentPublicationRecoveryAuthorityV1Schema.parse({
        ...value.authority,
        taskStoreRoot: "/host/tasks/guessed",
      }),
    ).toThrow();
    await expect(value.projectStore.readCurrent()).resolves.toBeNull();
  });

  it("quarantines an empty authority pre-record directory and reopens safely", async () => {
    const value = await setup("authority-empty-cut");
    const authorityDigest = resourceDigest(
      "chronorift-project-environment-publication-recovery-v1",
      value.environmentId,
      value.operationId,
    );
    const record = join(
      value.projectNamespace,
      "publication-recovery",
      authorityDigest,
    );
    await rm(record, { recursive: true });
    await mkdir(record, { mode: 0o700 });

    const reopened = await value.reopen();
    await expect(
      reopened.reopenedProject.listPendingPublicationRecoveryAuthorities(),
    ).resolves.toEqual([]);
    await expect(reopened.reopenedProject.summary()).resolves.toMatchObject({
      interruptedPublicationRecords: 1,
      pendingPublicationRecoveries: 0,
      current: null,
    });
  });

  it("preserves a pre-link authority stage in quarantine across reopen", async () => {
    const value = await setup("authority-stage-cut");
    const authorityDigest = resourceDigest(
      "chronorift-project-environment-publication-recovery-v1",
      value.environmentId,
      value.operationId,
    );
    const record = join(
      value.projectNamespace,
      "publication-recovery",
      authorityDigest,
    );
    const authorityBytes = await readFile(join(record, "authority.json"));
    await rm(record, { recursive: true });
    await mkdir(record, { mode: 0o700 });
    const stageName =
      ".chronorift-stage-00000000-0000-4000-8000-000000000001.tmp";
    await writeFile(join(record, stageName), authorityBytes, { mode: 0o600 });

    const reopened = await value.reopen();
    const orphanNames = await readdir(
      join(value.projectNamespace, "publication-orphans"),
    );
    expect(orphanNames).toHaveLength(1);
    expect(
      await readFile(
        join(
          value.projectNamespace,
          "publication-orphans",
          orphanNames[0]!,
          stageName,
        ),
      ),
    ).toEqual(authorityBytes);
    await expect(reopened.reopenedProject.summary()).resolves.toMatchObject({
      interruptedPublicationRecords: 1,
      pendingPublicationRecoveries: 0,
    });
  });

  it("cleans only an explained post-link authority stage duplicate", async () => {
    const value = await setup("authority-post-link-cut");
    const authorityDigest = resourceDigest(
      "chronorift-project-environment-publication-recovery-v1",
      value.environmentId,
      value.operationId,
    );
    const record = join(
      value.projectNamespace,
      "publication-recovery",
      authorityDigest,
    );
    await link(
      join(record, "authority.json"),
      join(
        record,
        ".chronorift-stage-00000000-0000-4000-8000-000000000002.tmp",
      ),
    );

    const reopened = await value.reopen();
    await expect(
      reopened.reopenedProject.readPublicationRecoveryAuthority(
        value.operationId,
      ),
    ).resolves.toEqual(value.authority);
    await expect(reopened.reopenedProject.summary()).resolves.toMatchObject({
      interruptedPublicationRecords: 0,
      pendingPublicationRecoveries: 1,
    });
  });

  it("fails closed instead of quarantining unexplained authority bytes", async () => {
    const value = await setup("authority-unknown-cut");
    const authorityDigest = resourceDigest(
      "chronorift-project-environment-publication-recovery-v1",
      value.environmentId,
      value.operationId,
    );
    await writeFile(
      join(
        value.projectNamespace,
        "publication-recovery",
        authorityDigest,
        "unknown.bin",
      ),
      "unknown",
      { mode: 0o600 },
    );
    await expect(value.reopen()).rejects.toBeInstanceOf(
      ArtifactPathSecurityError,
    );
  });

  it("quarantines an empty transaction pre-record and recovers after reopen", async () => {
    const value = await setup("transaction-empty-cut");
    await value.projectStore.materializeRevisionOnce(
      value.revision,
      value.files,
    );
    const transaction = resourceDigest(
      "chronorift-project-environment-publication-transaction-v1",
      value.environmentId,
      `${value.environmentRevisionId}\0${value.operationId}`,
    );
    await mkdir(join(value.projectNamespace, "transactions", transaction), {
      mode: 0o700,
    });

    await expectRecoveredExactly(value);
    await expect(value.projectStore.summary()).resolves.toMatchObject({
      interruptedPublicationRecords: 1,
    });
  });

  it("quarantines an incomplete revision and seals the original attempt", async () => {
    const value = await setup("partial");
    const revisionDirectory = resourceDigest(
      "chronorift-project-environment-revision-v1",
      value.environmentId,
      value.environmentRevisionId,
    );
    await mkdir(join(value.projectNamespace, "revisions", revisionDirectory), {
      mode: 0o700,
    });

    const recovered = await value.reconcile();
    expect(recovered.result).toMatchObject({
      partialRevisionQuarantined: true,
      resolution: {
        outcome: "failed",
        publicationCommitted: false,
        failureCode: "publication_revision_incomplete",
      },
    });
    await expect(recovered.reopenedProject.readCurrent()).resolves.toBeNull();
    await expect(recovered.reopenedProject.summary()).resolves.toMatchObject({
      incompleteRevisions: 0,
      quarantinedRevisions: 1,
    });
    const task = await recovered.resolveTaskStore(value.authority);
    const events = await task.readAttemptEvents();
    expect(events.at(-1)).toMatchObject({
      eventKind: "failed",
      failureCode: "publication_revision_incomplete",
    });
  });

  it("commits and binds a fully materialized revision after reopen", async () => {
    const value = await setup("materialized");
    await value.projectStore.materializeRevisionOnce(
      value.revision,
      value.files,
    );
    await expectRecoveredExactly(value);
    const task = await value
      .reopen()
      .then((reopened) => reopened.resolveTaskStore(value.authority));
    const receipt = await task.findPublicationReceiptByOperation(
      value.operationId,
    );
    expect(receipt?.completedAt).toBe(timestamp(10));
  });

  it("commits a durably prepared pointer and binds after reopen", async () => {
    const value = await setup("prepared");
    await value.projectStore.materializeRevisionOnce(
      value.revision,
      value.files,
    );
    await value.projectStore.prepareInitialCurrent({
      expectedCurrentRevisionId: null,
      environmentRevisionId: value.environmentRevisionId,
      publicationOperationId: value.operationId,
      commitRequestedAt: timestamp(5),
    });
    await expectRecoveredExactly(value);
  });

  it("finishes a linked current pointer transaction before binding after reopen", async () => {
    const value = await setup("linked-current");
    await value.projectStore.materializeRevisionOnce(
      value.revision,
      value.files,
    );
    await value.projectStore.prepareInitialCurrent({
      expectedCurrentRevisionId: null,
      environmentRevisionId: value.environmentRevisionId,
      publicationOperationId: value.operationId,
      commitRequestedAt: timestamp(5),
    });
    const transaction = resourceDigest(
      "chronorift-project-environment-publication-transaction-v1",
      value.environmentId,
      `${value.environmentRevisionId}\0${value.operationId}`,
    );
    await link(
      join(
        value.projectNamespace,
        "transactions",
        transaction,
        "current.pointer.json",
      ),
      join(value.projectNamespace, "current.json"),
    );
    await expectRecoveredExactly(value);
  });

  it("refuses a pre-CAS recovery when the inspected Host source changed", async () => {
    const value = await setup("source-drift");
    await value.projectStore.materializeRevisionOnce(
      value.revision,
      value.files,
    );
    const reopened = await value.reopen();
    const result = await reconcilePendingProjectEnvironmentPublicationV1({
      projectStore: reopened.reopenedProject,
      resolveTaskStore: reopened.resolveTaskStore,
      inspectedSourceId: asSourceId("source:recovery:changed"),
      now: () => timestamp(10),
    });
    expect(result?.resolution).toMatchObject({
      outcome: "failed",
      publicationCommitted: false,
      failureCode: "publication_source_drift",
    });
    await expect(reopened.reopenedProject.readCurrent()).resolves.toBeNull();
  });

  it("reconstructs a missing Task receipt and binding after current commit", async () => {
    const value = await setup("committed-before-receipt");
    await value.projectStore.materializeRevisionOnce(
      value.revision,
      value.files,
    );
    await value.projectStore.commitInitialCurrent({
      expectedCurrentRevisionId: null,
      environmentRevisionId: value.environmentRevisionId,
      publicationOperationId: value.operationId,
      commitRequestedAt: timestamp(5),
    });
    await expect(value.taskStore.readBindingEpochs()).resolves.toEqual([]);
    await expectRecoveredExactly(value);
  });

  it("completes exactly once when current and receipt exist but binding is missing", async () => {
    const value = await setup("committed-before-binding");
    await value.projectStore.materializeRevisionOnce(
      value.revision,
      value.files,
    );
    await value.projectStore.commitInitialCurrent({
      expectedCurrentRevisionId: null,
      environmentRevisionId: value.environmentRevisionId,
      publicationOperationId: value.operationId,
      commitRequestedAt: timestamp(5),
    });
    const receipt = createEnvironmentPublicationReceiptV1({
      schemaVersion: 1,
      operationId: value.operationId,
      taskId: value.taskId,
      attemptId: value.attemptId,
      environmentId: value.environmentId,
      targetEnvironmentRevisionId: value.environmentRevisionId,
      expectedCurrentRevisionId: null,
      observedCurrentRevisionId: null,
      realizedCurrentRevisionId: value.environmentRevisionId,
      revisionMaterialized: true,
      pointerCommitted: true,
      outcome: "committed",
      failures: [],
      completedAt: timestamp(5),
    });
    await value.taskStore.putPublicationReceiptOnce(receipt);
    await value.taskStore.appendAttemptEvent(
      ProjectInitializationAttemptEventV1Schema.parse({
        schemaVersion: 1,
        eventId: asProjectInitializationAttemptEventId(
          "event:recovery:committed-before-binding:5",
        ),
        attemptId: value.attemptId,
        taskId: value.taskId,
        sequence: 5,
        occurredAt: timestamp(5),
        eventKind: "publication_committed",
        operationId: value.operationId,
        environmentRevisionId: value.environmentRevisionId,
        adapterRevisionId: value.adapterRevisionId,
        publicationReceiptId: receipt.receiptId,
      }),
    );
    await expectRecoveredExactly(value);
  });

  it("seals binding_failed when a committed publication meets a conflicting binding epoch", async () => {
    const value = await setup("binding-conflict");
    await value.projectStore.materializeRevisionOnce(
      value.revision,
      value.files,
    );
    await value.projectStore.commitInitialCurrent({
      expectedCurrentRevisionId: null,
      environmentRevisionId: value.environmentRevisionId,
      publicationOperationId: value.operationId,
      commitRequestedAt: timestamp(5),
    });
    await value.taskStore.appendBindingEpoch(
      EnvironmentBindingEpochV1Schema.parse({
        schemaVersion: 1,
        bindingEpochId: asEnvironmentBindingEpochId("binding:recovery:foreign"),
        taskId: value.taskId,
        ordinal: 0,
        state: "pending",
        attemptId: value.attemptId,
        createdAt: timestamp(5),
      }),
    );

    const recovered = await value.reconcile();
    expect(recovered.result?.resolution).toMatchObject({
      outcome: "binding_failed",
      publicationCommitted: true,
      failureCode: "publication_binding_conflict",
    });
    const task = await recovered.resolveTaskStore(value.authority);
    expect((await task.readAttemptEvents()).at(-1)).toMatchObject({
      eventKind: "binding_failed",
      failureCode: "publication_binding_conflict",
    });
    await expect(
      recovered.reopenedProject.readCurrent(),
    ).resolves.toMatchObject({
      environmentRevisionId: value.environmentRevisionId,
    });
  });

  it("fails closed on CAS conflict and preserves the observed current", async () => {
    const value = await setup("conflict");
    await value.projectStore.materializeRevisionOnce(
      value.revision,
      value.files,
    );
    const foreignFiles = [
      {
        path: "adapter/manifest.json",
        bytes: Buffer.from('{"foreign":true}\n'),
      },
    ];
    const foreignRevisionId = asProjectEnvironmentRevisionId(
      "environment-revision:recovery:foreign",
    );
    const foreignOperationId = asProjectEnvironmentOperationId(
      "operation:recovery:foreign",
    );
    const foreign = ProjectEnvironmentRevisionV1Schema.parse({
      ...value.revision,
      environmentRevisionId: foreignRevisionId,
      adapterRevisionId: asProjectAdapterRevisionId(
        "adapter-revision:recovery:foreign",
      ),
      publicationOperationId: foreignOperationId,
      contentDigest: projectEnvironmentPackageContentDigestV1(foreignFiles),
    });
    await value.projectStore.materializeRevisionOnce(foreign, foreignFiles);
    await value.projectStore.commitInitialCurrent({
      expectedCurrentRevisionId: null,
      environmentRevisionId: foreignRevisionId,
      publicationOperationId: foreignOperationId,
      commitRequestedAt: timestamp(6),
    });

    const recovered = await value.reconcile();
    expect(recovered.result?.resolution).toMatchObject({
      outcome: "failed",
      publicationCommitted: false,
      failureCode: "publication_conflict",
    });
    await expect(
      recovered.reopenedProject.readCurrent(),
    ).resolves.toMatchObject({
      environmentRevisionId: foreignRevisionId,
      publicationOperationId: foreignOperationId,
    });
  });

  it("records project-local binding_failed when committed current loses its Task store", async () => {
    const value = await setup("missing-task");
    await value.projectStore.materializeRevisionOnce(
      value.revision,
      value.files,
    );
    await value.projectStore.commitInitialCurrent({
      expectedCurrentRevisionId: null,
      environmentRevisionId: value.environmentRevisionId,
      publicationOperationId: value.operationId,
      commitRequestedAt: timestamp(5),
    });
    const reopened = await value.reopen();
    const result = await reconcilePendingProjectEnvironmentPublicationV1({
      projectStore: reopened.reopenedProject,
      resolveTaskStore: async () => {
        throw new Error("Task store is unavailable under this runtime root");
      },
      inspectedSourceId: value.sourceId,
      now: () => timestamp(10),
    });
    expect(result?.resolution).toMatchObject({
      outcome: "binding_failed",
      publicationCommitted: true,
      failureCode: "publication_task_store_unavailable",
      bindingEpochId: null,
    });
    await expect(reopened.reopenedProject.readCurrent()).resolves.toMatchObject(
      {
        environmentRevisionId: value.environmentRevisionId,
      },
    );
    await expect(
      reopened.reopenedProject.readPublicationRecoveryResolution(
        value.operationId,
      ),
    ).resolves.toEqual(result?.resolution);
  });
});
