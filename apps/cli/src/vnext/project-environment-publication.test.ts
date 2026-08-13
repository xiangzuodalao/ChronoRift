import { createHash } from "node:crypto";
import { link, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EnvironmentPublicationIntentV1Schema,
  ProjectEnvironmentRevisionV1Schema,
  asAdapterConformanceReceiptId,
  asEnvironmentBindingEpochId,
  asObserverEffectReceiptId,
  asProjectAdapterCandidateId,
  asProjectAdapterRevisionId,
  asProjectEnvironmentId,
  asProjectEnvironmentOperationId,
  asProjectEnvironmentRevisionId,
  asProjectEnvironmentTaskId,
  asProjectInitializationAttemptId,
  asProjectSessionId,
  asProjectToolchainReceiptId,
  asSha256DigestV1,
  asSourceId,
} from "@chronorift/domain";
import {
  ProjectEnvironmentStoreV1,
  ProjectEnvironmentTaskStoreV1,
  projectEnvironmentPackageContentDigestV1,
} from "@chronorift/json-artifacts";

import {
  bindPublishedProjectEnvironmentV1,
  publishInitialProjectEnvironmentV1,
  readReusableProjectEnvironmentRevisionV1,
} from "./project-environment-publication.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const digest = (character: string) => asSha256DigestV1(character.repeat(64));
const timestamp = "2026-08-12T00:00:00.000Z";
const laterTimestamp = "2026-08-12T00:00:01.000Z";
const resourceDigest = (
  storeKind: string,
  ownerId: string,
  resourceId: string,
): string =>
  createHash("sha256")
    .update(`${storeKind}\0${ownerId}\0${resourceId}`)
    .digest("hex");

const setup = async (suffix: string) => {
  const root = await mkdtemp(
    join(tmpdir(), `chronorift-pe-publish-${suffix}-`),
  );
  roots.push(root);
  const taskId = asProjectEnvironmentTaskId(`task:pe:${suffix}`);
  const attemptId = asProjectInitializationAttemptId(`attempt:pe:${suffix}`);
  const environmentId = asProjectEnvironmentId(`environment:pe:${suffix}`);
  const sourceId = asSourceId(`source:pe:${suffix}`);
  const operationId = asProjectEnvironmentOperationId(`operation:pe:${suffix}`);
  const sessionId = asProjectSessionId(`session:pe:${suffix}`);
  const bindingEpochId = asEnvironmentBindingEpochId(`binding:pe:${suffix}`);
  const environmentRevisionId = asProjectEnvironmentRevisionId(
    `environment-revision:pe:${suffix}`,
  );
  const adapterRevisionId = asProjectAdapterRevisionId(
    `adapter-revision:pe:${suffix}`,
  );
  const files = [
    { path: "adapter/manifest.json", bytes: Buffer.from("{}\n") },
    {
      path: "adapter/src/adapter.gd",
      bytes: Buffer.from("extends RefCounted\n"),
    },
  ];
  const toolchainReceiptId = asProjectToolchainReceiptId(
    `toolchain:pe:${suffix}`,
  );
  const revision = ProjectEnvironmentRevisionV1Schema.parse({
    schemaVersion: 1,
    environmentId,
    environmentRevisionId,
    sourceId,
    adapterRevisionId,
    sdkDigest: digest("a"),
    bridgeDigest: digest("b"),
    toolchainReceiptId,
    conformanceReceiptId: asAdapterConformanceReceiptId(
      `conformance:pe:${suffix}`,
    ),
    observerEffectReceiptId: asObserverEffectReceiptId(`observer:pe:${suffix}`),
    policyProfileDigest: digest("c"),
    publicationOperationId: operationId,
    contentDigest: projectEnvironmentPackageContentDigestV1(files),
    publishedAt: timestamp,
  });
  const intent = EnvironmentPublicationIntentV1Schema.parse({
    schemaVersion: 1,
    operationId,
    taskId,
    attemptId,
    environmentId,
    candidateId: asProjectAdapterCandidateId(`candidate:pe:${suffix}`),
    sourceId,
    targetEnvironmentRevisionId: environmentRevisionId,
    targetAdapterRevisionId: adapterRevisionId,
    expectedCurrentRevisionId: null,
    targetContentDigest: revision.contentDigest,
    createdAt: timestamp,
  });
  const taskStore = new ProjectEnvironmentTaskStoreV1({
    storeRoot: join(root, "task"),
    taskId,
  });
  const projectStore = new ProjectEnvironmentStoreV1({
    namespaceRoot: join(root, "project"),
    environmentId,
  });
  await Promise.all([taskStore.create(), projectStore.create()]);
  return {
    taskId,
    attemptId,
    environmentId,
    sourceId,
    operationId,
    sessionId,
    bindingEpochId,
    environmentRevisionId,
    toolchainReceiptId,
    files,
    revision,
    intent,
    taskStore,
    projectStore,
  };
};

describe("Project Environment initial publication", () => {
  it("materializes, commits, records, binds, and reuses one exact revision", async () => {
    const value = await setup("success");
    const publication = await publishInitialProjectEnvironmentV1({
      taskStore: value.taskStore,
      projectStore: value.projectStore,
      intent: value.intent,
      sessionId: value.sessionId,
      bindingEpochId: value.bindingEpochId,
      revision: value.revision,
      revisionFiles: value.files,
      pointerCommitRequestedAt: timestamp,
      now: () => timestamp,
    });
    expect(publication).toMatchObject({
      outcome: "committed",
      expectedCurrentRevisionId: null,
      observedCurrentRevisionId: null,
      realizedCurrentRevisionId: value.environmentRevisionId,
    });
    await expect(value.projectStore.readCurrent()).resolves.toMatchObject({
      environmentRevisionId: value.environmentRevisionId,
    });

    const binding = await bindPublishedProjectEnvironmentV1({
      taskStore: value.taskStore,
      taskId: value.taskId,
      attemptId: value.attemptId,
      bindingEpochId: asEnvironmentBindingEpochId("binding:pe:success"),
      ordinal: 0,
      revision: value.revision,
      publication,
      createdAt: timestamp,
      boundAt: timestamp,
    });
    expect(binding.state).toBe("bound");
    await expect(value.taskStore.readBindingEpochs()).resolves.toHaveLength(1);

    const reusable = await readReusableProjectEnvironmentRevisionV1({
      projectStore: value.projectStore,
      sourceId: value.sourceId,
      sdkDigest: digest("a"),
      bridgeDigest: digest("b"),
      toolchainReceiptId: value.toolchainReceiptId,
      policyProfileDigest: digest("c"),
    });
    expect(reusable?.revision.environmentRevisionId).toBe(
      value.environmentRevisionId,
    );
    expect(reusable?.files).toHaveLength(2);
  });

  it("records a CAS conflict without replacing the existing current revision", async () => {
    const first = await setup("conflict-first");
    await publishInitialProjectEnvironmentV1({
      taskStore: first.taskStore,
      projectStore: first.projectStore,
      intent: first.intent,
      sessionId: first.sessionId,
      bindingEpochId: first.bindingEpochId,
      revision: first.revision,
      revisionFiles: first.files,
      pointerCommitRequestedAt: timestamp,
      now: () => timestamp,
    });

    const secondTaskRoot = await mkdtemp(
      join(tmpdir(), "chronorift-pe-second-"),
    );
    roots.push(secondTaskRoot);
    const secondTaskId = asProjectEnvironmentTaskId("task:pe:conflict-second");
    const secondTaskStore = new ProjectEnvironmentTaskStoreV1({
      storeRoot: join(secondTaskRoot, "task"),
      taskId: secondTaskId,
    });
    await secondTaskStore.create();
    const secondRevisionId = asProjectEnvironmentRevisionId(
      "environment-revision:pe:conflict-second",
    );
    const secondOperation = asProjectEnvironmentOperationId(
      "operation:pe:conflict-second",
    );
    const secondRevision = ProjectEnvironmentRevisionV1Schema.parse({
      ...first.revision,
      environmentRevisionId: secondRevisionId,
      publicationOperationId: secondOperation,
    });
    const secondIntent = EnvironmentPublicationIntentV1Schema.parse({
      ...first.intent,
      taskId: secondTaskId,
      attemptId: asProjectInitializationAttemptId("attempt:pe:conflict-second"),
      candidateId: asProjectAdapterCandidateId("candidate:pe:conflict-second"),
      operationId: secondOperation,
      targetEnvironmentRevisionId: secondRevisionId,
    });
    const conflict = await publishInitialProjectEnvironmentV1({
      taskStore: secondTaskStore,
      projectStore: first.projectStore,
      intent: secondIntent,
      sessionId: asProjectSessionId("session:pe:conflict-second"),
      bindingEpochId: asEnvironmentBindingEpochId("binding:pe:conflict-second"),
      revision: secondRevision,
      revisionFiles: first.files,
      pointerCommitRequestedAt: timestamp,
      now: () => timestamp,
    });
    expect(conflict).toMatchObject({
      outcome: "conflict",
      expectedCurrentRevisionId: null,
      observedCurrentRevisionId: first.environmentRevisionId,
      realizedCurrentRevisionId: first.environmentRevisionId,
    });
    await expect(first.projectStore.readCurrent()).resolves.toMatchObject({
      environmentRevisionId: first.environmentRevisionId,
    });
  });

  it("treats a post-CAS cleanup exception as a durable commit", async () => {
    const value = await setup("post-cas-exception");
    const transaction = resourceDigest(
      "chronorift-project-environment-publication-transaction-v1",
      value.environmentId,
      `${value.environmentRevisionId}\0${value.operationId}`,
    );
    vi.spyOn(
      value.projectStore,
      "reconcileInitialPublication",
    ).mockImplementationOnce(async () => {
      await link(
        join(
          value.projectStore.namespaceRoot,
          "transactions",
          transaction,
          "current.pointer.json",
        ),
        join(value.projectStore.namespaceRoot, "current.json"),
      );
      throw new Error("injected failure after current link");
    });

    const receipt = await publishInitialProjectEnvironmentV1({
      taskStore: value.taskStore,
      projectStore: value.projectStore,
      intent: value.intent,
      sessionId: value.sessionId,
      bindingEpochId: value.bindingEpochId,
      revision: value.revision,
      revisionFiles: value.files,
      pointerCommitRequestedAt: timestamp,
      now: () => laterTimestamp,
    });
    expect(receipt).toMatchObject({
      outcome: "committed",
      pointerCommitted: true,
      failures: [],
      completedAt: laterTimestamp,
    });
    await expect(
      value.projectStore.inspectInitialPublication(
        value.environmentRevisionId,
        value.operationId,
      ),
    ).resolves.toMatchObject({ state: "committed" });
    await expect(
      value.projectStore.reconcileInitialPublication({
        expectedCurrentRevisionId: null,
        environmentRevisionId: value.environmentRevisionId,
        publicationOperationId: value.operationId,
        commitRequestedAt: timestamp,
      }),
    ).resolves.toMatchObject({ state: "committed" });
    await expect(value.projectStore.readCurrent()).resolves.toMatchObject({
      commitRequestedAt: timestamp,
    });
  });

  it("reconciles a crash after current commit and records/binds exactly once on restart", async () => {
    const value = await setup("restart-after-current");
    await value.taskStore.putPublicationIntentOnce(value.intent);
    await value.projectStore.materializeRevisionOnce(
      value.revision,
      value.files,
    );
    const commit = {
      expectedCurrentRevisionId: null,
      environmentRevisionId: value.environmentRevisionId,
      publicationOperationId: value.operationId,
      commitRequestedAt: timestamp,
    } as const;
    await value.projectStore.prepareInitialCurrent(commit);
    await value.projectStore.reconcileInitialPublication(commit);

    const reopenedTask = new ProjectEnvironmentTaskStoreV1({
      storeRoot: join(value.taskStore.storeRoot),
      taskId: value.taskId,
    });
    const reopenedProject = new ProjectEnvironmentStoreV1({
      namespaceRoot: value.projectStore.namespaceRoot,
      environmentId: value.environmentId,
    });
    await Promise.all([reopenedTask.open(), reopenedProject.open()]);
    const receipt = await publishInitialProjectEnvironmentV1({
      taskStore: reopenedTask,
      projectStore: reopenedProject,
      intent: value.intent,
      sessionId: value.sessionId,
      bindingEpochId: value.bindingEpochId,
      revision: value.revision,
      revisionFiles: value.files,
      pointerCommitRequestedAt: timestamp,
      now: () => timestamp,
    });
    expect(receipt).toMatchObject({
      outcome: "committed",
      pointerCommitted: true,
      observedCurrentRevisionId: null,
      realizedCurrentRevisionId: value.environmentRevisionId,
    });

    const bindingInput = {
      taskStore: reopenedTask,
      taskId: value.taskId,
      attemptId: value.attemptId,
      bindingEpochId: asEnvironmentBindingEpochId(
        "binding:pe:restart-after-current",
      ),
      ordinal: 0,
      revision: value.revision,
      publication: receipt,
      createdAt: timestamp,
      boundAt: timestamp,
    } as const;
    const first = await bindPublishedProjectEnvironmentV1(bindingInput);
    const second = await bindPublishedProjectEnvironmentV1(bindingInput);
    expect(second).toEqual(first);
    await expect(reopenedTask.readBindingEpochs()).resolves.toHaveLength(1);
  });

  it("rejects bytes that do not match the intent and revision digest", async () => {
    const value = await setup("mismatch");
    await expect(
      publishInitialProjectEnvironmentV1({
        taskStore: value.taskStore,
        projectStore: value.projectStore,
        intent: value.intent,
        sessionId: value.sessionId,
        bindingEpochId: value.bindingEpochId,
        revision: value.revision,
        revisionFiles: [
          { path: "adapter/manifest.json", bytes: Buffer.from("x") },
        ],
        pointerCommitRequestedAt: timestamp,
        now: () => timestamp,
      }),
    ).rejects.toThrow(/content binding/u);
  });
});
