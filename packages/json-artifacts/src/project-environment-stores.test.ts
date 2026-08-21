import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EnvironmentPublicationIntentV1Schema,
  ProjectAdapterCandidateReferenceV1Schema,
  ProjectEnvironmentRevisionV1Schema,
  ProjectInitializationAttemptEventV1Schema,
  VNextBuildV1Schema,
  asAdapterConformanceReceiptId,
  asAdapterId,
  asBuildId,
  asObserverEffectReceiptId,
  asProjectAdapterCandidateId,
  asProjectAdapterRevisionId,
  asProjectEnvironmentId,
  asProjectEnvironmentOperationId,
  asProjectEnvironmentRevisionId,
  asProjectEnvironmentTaskId,
  asProjectInitializationAttemptId,
  asProjectInitializationAttemptEventId,
  asProjectSessionId,
  asProjectToolchainReceiptId,
  asSourceId,
  asWorkspaceId,
  type ProjectEnvironmentId,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import { ArtifactCorruptionError } from "./errors.js";
import {
  ProjectEnvironmentLedgerSealedError,
  ProjectEnvironmentStoreQuotaError,
  ProjectEnvironmentTaskStoreV1,
  projectEnvironmentPackageContentDigestV1,
} from "./project-environment-task-store.js";
import {
  ProjectEnvironmentCurrentConflictError,
  ProjectEnvironmentPublicationRecoveryRequiredError,
  ProjectEnvironmentStoreV1,
} from "./project-environment-store.js";
import { resourceDigest } from "./project-environment-store-internals.js";

const timestamp = (second = 0): string =>
  `2026-08-12T00:00:${String(second).padStart(2, "0")}.000Z`;
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

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

async function taskHarness() {
  const parent = await mkdtemp(join(tmpdir(), "chronorift-pe-task-store-"));
  const taskId = asProjectEnvironmentTaskId("task:pe-a:store-test");
  const storeRoot = join(parent, "project-environment-records");
  const store = new ProjectEnvironmentTaskStoreV1({ storeRoot, taskId });
  await store.create();
  return { parent, store, storeRoot, taskId };
}

function candidateFixture(
  taskId: ReturnType<typeof asProjectEnvironmentTaskId>,
) {
  const files = [
    {
      path: "adapter/project_adapter.gd",
      bytes: Buffer.from("extends Node\n", "utf8"),
    },
    {
      path: "manifest.json",
      bytes: Buffer.from('{"schemaVersion":1}\n', "utf8"),
    },
  ];
  return {
    files,
    reference: ProjectAdapterCandidateReferenceV1Schema.parse({
      schemaVersion: 1,
      taskId,
      attemptId: asProjectInitializationAttemptId("attempt:pe-a:store-test"),
      candidateId: asProjectAdapterCandidateId("candidate:pe-a:store-test"),
      adapterId: asAdapterId("adapter:pe-a:store-test"),
      sourceId: asSourceId("source:pe-a:store-test"),
      contentDigest: projectEnvironmentPackageContentDigestV1(files),
      fileCount: files.length,
      byteLength: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
      frozenAt: timestamp(),
    }),
  };
}

function createdEvent(taskId: ReturnType<typeof asProjectEnvironmentTaskId>) {
  return ProjectInitializationAttemptEventV1Schema.parse({
    schemaVersion: 1,
    eventId: asProjectInitializationAttemptEventId("attempt-event:pe-a:0"),
    attemptId: asProjectInitializationAttemptId("attempt:pe-a:store-test"),
    taskId,
    sequence: 0,
    occurredAt: timestamp(),
    eventKind: "created",
    predecessorAttemptId: null,
    sessionId: asProjectSessionId("session:pe-a:store-test"),
    sourceId: asSourceId("source:pe-a:store-test"),
    providerId: "provider:test",
    modelId: "model:test",
    thinkingLevel: "high",
    budget,
  });
}

describe("ProjectEnvironmentTaskStoreV1", () => {
  it("freezes a content-addressed candidate and reopens only for its exact Task", async () => {
    const { store, storeRoot, taskId } = await taskHarness();
    const candidate = candidateFixture(taskId);

    const first = await store.putCandidateOnce(
      candidate.reference,
      candidate.files,
    );
    const second = await store.putCandidateOnce(
      candidate.reference,
      candidate.files,
    );
    expect(second).toEqual(first);
    await expect(
      store.readCandidate(candidate.reference.candidateId),
    ).resolves.toMatchObject({
      payload: candidate.reference,
      packageHash: first.packageHash,
    });

    const reopened = new ProjectEnvironmentTaskStoreV1({ storeRoot, taskId });
    await reopened.open();
    await expect(
      new ProjectEnvironmentTaskStoreV1({
        storeRoot,
        taskId: asProjectEnvironmentTaskId("task:pe-a:other"),
      }).open(),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);
  });

  it("validates attempt transitions, hash-chains records, and rejects append after seal", async () => {
    const { store, taskId } = await taskHarness();
    const created = createdEvent(taskId);
    const running = ProjectInitializationAttemptEventV1Schema.parse({
      schemaVersion: 1,
      eventId: asProjectInitializationAttemptEventId("attempt-event:pe-a:1"),
      attemptId: created.attemptId,
      taskId,
      sequence: 1,
      occurredAt: timestamp(1),
      eventKind: "agent_running",
    });

    await expect(store.appendAttemptEvent(running)).rejects.toThrow(
      /begin with created/u,
    );
    const first = await store.appendAttemptEvent(created);
    const second = await store.appendAttemptEvent(running);
    expect(first.sequence).toBe(0);
    expect(second.previousRecordHash).toBe(first.recordHash);
    expect(await store.readAttemptEvents()).toEqual([created, running]);
    const seal = await store.sealLedger("attempt-events");
    expect(seal.recordCount).toBe(2);
    await expect(
      store.appendAttemptEvent({
        ...running,
        eventId: asProjectInitializationAttemptEventId("attempt-event:pe-a:2"),
        sequence: 2,
        occurredAt: timestamp(2),
        eventKind: "failed",
        failureCode: "timeout",
        message: "initialization timed out",
      }),
    ).rejects.toBeInstanceOf(ProjectEnvironmentLedgerSealedError);
  });

  it("persists publication intent immutably and enforces Task ownership", async () => {
    const { store, taskId } = await taskHarness();
    const candidate = candidateFixture(taskId);
    const intent = EnvironmentPublicationIntentV1Schema.parse({
      schemaVersion: 1 as const,
      operationId: asProjectEnvironmentOperationId("operation:pe-a:store-test"),
      taskId,
      attemptId: candidate.reference.attemptId,
      environmentId: asProjectEnvironmentId("environment:pe-a:store-test"),
      candidateId: candidate.reference.candidateId,
      sourceId: candidate.reference.sourceId,
      targetEnvironmentRevisionId: asProjectEnvironmentRevisionId(
        "environment-revision:pe-a:store-test",
      ),
      targetAdapterRevisionId: asProjectAdapterRevisionId(
        "adapter-revision:pe-a:store-test",
      ),
      expectedCurrentRevisionId: null,
      targetContentDigest: digest("target"),
      createdAt: timestamp(),
    });
    await store.putPublicationIntentOnce(intent);
    await store.putPublicationIntentOnce(intent);
    await expect(
      store.readPublicationIntent(intent.operationId),
    ).resolves.toEqual(intent);
    await expect(
      store.putPublicationIntentOnce({
        ...intent,
        taskId: asProjectEnvironmentTaskId("task:pe-a:other"),
      }),
    ).rejects.toThrow(/different Task/u);
  });

  it("persists each exact candidate Build as a Task-owned resource", async () => {
    const { store, taskId } = await taskHarness();
    const sourceHash = digest("candidate-source");
    const build = VNextBuildV1Schema.parse({
      schemaVersion: 1,
      taskId,
      workspaceId: asWorkspaceId("workspace:pe-a:store-test"),
      sourceId: asSourceId(`source:${sourceHash}`),
      buildId: asBuildId(`build:${digest("candidate-build")}`),
      sourceHash,
      workspaceDiffHash: digest("candidate-diff"),
      buildConfigurationHash: digest("candidate-configuration"),
      outputHash: digest("candidate-output"),
      createdAt: timestamp(),
    });

    await store.putBuildOnce(build);
    await store.putBuildOnce(build);
    await expect(store.readBuild(build.buildId)).resolves.toEqual(build);
    await expect(
      store.putBuildOnce({
        ...build,
        taskId: asProjectEnvironmentTaskId("task:pe-a:other"),
      }),
    ).rejects.toThrow(/different Task/u);
  });

  it("rejects hard-linked package bytes and bounded-store overflow", async () => {
    const { parent, store, storeRoot, taskId } = await taskHarness();
    const candidate = candidateFixture(taskId);
    await store.putCandidateOnce(candidate.reference, candidate.files);
    const candidateDirectory = resourceDigest(
      "chronorift-project-adapter-candidate-v1",
      taskId,
      candidate.reference.candidateId,
    );
    const implementation = join(
      storeRoot,
      "candidates",
      candidateDirectory,
      "files",
      "adapter",
      "project_adapter.gd",
    );
    await link(implementation, join(parent, "foreign-hard-link"));
    await expect(
      store.readCandidate(candidate.reference.candidateId),
    ).rejects.toThrow(/singly-linked/u);

    const quotaRoot = join(parent, "bounded-task-store");
    const bounded = new ProjectEnvironmentTaskStoreV1({
      storeRoot: quotaRoot,
      taskId: asProjectEnvironmentTaskId("task:pe-a:bounded"),
      quota: {
        maximumTotalBytes: 2_048,
        maximumEntries: 32,
        maximumCanonicalJsonBytes: 1_024,
        maximumPackageBytes: 256,
        maximumPackageFiles: 2,
      },
    });
    await bounded.create();
    const boundedTaskId = asProjectEnvironmentTaskId("task:pe-a:bounded");
    const largeFiles = [{ path: "large.gd", bytes: Buffer.alloc(300) }];
    const boundedCandidate = ProjectAdapterCandidateReferenceV1Schema.parse({
      ...candidateFixture(boundedTaskId).reference,
      taskId: boundedTaskId,
      contentDigest: projectEnvironmentPackageContentDigestV1(largeFiles),
      fileCount: 1,
      byteLength: 300,
    });
    await expect(
      bounded.putCandidateOnce(boundedCandidate, largeFiles),
    ).rejects.toBeInstanceOf(ProjectEnvironmentStoreQuotaError);
  });

  it("fails closed when a restarted Task store marker is missing or corrupt", async () => {
    const { storeRoot, taskId } = await taskHarness();
    await truncate(
      join(storeRoot, ".chronorift-project-environment-task-store-v1.json"),
      3,
    );
    const reopened = new ProjectEnvironmentTaskStoreV1({ storeRoot, taskId });
    await expect(reopened.open()).rejects.toBeInstanceOf(
      ArtifactCorruptionError,
    );
  });
});

async function projectHarness(suffix = "main") {
  const parent = await mkdtemp(
    join(tmpdir(), `chronorift-pe-project-${suffix}-`),
  );
  const chronoriftRoot = join(parent, ".chronorift");
  await mkdir(chronoriftRoot, { mode: 0o700 });
  const namespaceRoot = join(chronoriftRoot, "project-environment-v1");
  const environmentId = asProjectEnvironmentId(`environment:pe-a:${suffix}`);
  const store = new ProjectEnvironmentStoreV1({ namespaceRoot, environmentId });
  await store.create();
  return { environmentId, namespaceRoot, parent, store };
}

function revisionFixture(environmentId: ProjectEnvironmentId, suffix = "main") {
  const files = [
    {
      path: "adapter/project_adapter.gd",
      bytes: Buffer.from(`extends Node\n# ${suffix}\n`, "utf8"),
    },
    {
      path: "evidence/conformance.json",
      bytes: Buffer.from('{"schemaVersion":1}\n', "utf8"),
    },
  ];
  const revisionId = asProjectEnvironmentRevisionId(
    `environment-revision:pe-a:${suffix}`,
  );
  const operationId = asProjectEnvironmentOperationId(
    `operation:pe-a:${suffix}`,
  );
  const revision = ProjectEnvironmentRevisionV1Schema.parse({
    schemaVersion: 1,
    environmentId,
    environmentRevisionId: revisionId,
    sourceId: asSourceId(`source:pe-a:${suffix}`),
    adapterRevisionId: asProjectAdapterRevisionId(
      `adapter-revision:pe-a:${suffix}`,
    ),
    sdkDigest: digest(`sdk-${suffix}`),
    bridgeDigest: digest(`bridge-${suffix}`),
    toolchainReceiptId: asProjectToolchainReceiptId(`toolchain:pe-a:${suffix}`),
    conformanceReceiptId: asAdapterConformanceReceiptId(
      `conformance:pe-a:${suffix}`,
    ),
    observerEffectReceiptId: asObserverEffectReceiptId(
      `observer:pe-a:${suffix}`,
    ),
    policyProfileDigest: digest(`policy-${suffix}`),
    publicationOperationId: operationId,
    contentDigest: projectEnvironmentPackageContentDigestV1(files),
    publishedAt: timestamp(),
  });
  return { files, operationId, revision, revisionId };
}

describe("ProjectEnvironmentStoreV1", () => {
  it("fails closed instead of migrating a pre-freeze physical layout", async () => {
    const { environmentId, namespaceRoot } =
      await projectHarness("pre-freeze-layout");
    await rm(join(namespaceRoot, "publication-orphans"), { recursive: true });

    const reopened = new ProjectEnvironmentStoreV1({
      namespaceRoot,
      environmentId,
    });
    await expect(reopened.open()).rejects.toThrow(
      /layout contains missing or unexpected entries/u,
    );
  });

  it("materializes a revision before atomically committing initial current", async () => {
    const { environmentId, namespaceRoot, store } = await projectHarness();
    const fixture = revisionFixture(environmentId);
    const seal = await store.materializeRevisionOnce(
      fixture.revision,
      fixture.files,
    );
    expect(
      await store.inspectInitialPublication(
        fixture.revisionId,
        fixture.operationId,
      ),
    ).toMatchObject({ state: "revision_materialized", current: null });

    const input = {
      expectedCurrentRevisionId: null,
      environmentRevisionId: fixture.revisionId,
      publicationOperationId: fixture.operationId,
      commitRequestedAt: timestamp(1),
    } as const;
    await store.prepareInitialCurrent(input);
    expect(
      await store.inspectInitialPublication(
        fixture.revisionId,
        fixture.operationId,
      ),
    ).toMatchObject({ state: "pointer_prepared", current: null });
    const reconciled = await store.reconcileInitialPublication(input);
    expect(reconciled).toMatchObject({ state: "committed" });
    await expect(store.readCurrent()).resolves.toMatchObject({
      environmentRevisionId: fixture.revisionId,
      publicationOperationId: fixture.operationId,
    });
    await expect(
      store.readRevision(fixture.revisionId, fixture.operationId),
    ).resolves.toMatchObject({ packageHash: seal.packageHash });

    const reopened = new ProjectEnvironmentStoreV1({
      namespaceRoot,
      environmentId,
    });
    await reopened.open();
    await expect(reopened.readCurrent()).resolves.toMatchObject({
      environmentRevisionId: fixture.revisionId,
    });
  });

  it("reconciles a crash after pointer linking and before transaction cleanup", async () => {
    const { environmentId, namespaceRoot, store } =
      await projectHarness("link-cut");
    const fixture = revisionFixture(environmentId, "link-cut");
    await store.materializeRevisionOnce(fixture.revision, fixture.files);
    const input = {
      expectedCurrentRevisionId: null,
      environmentRevisionId: fixture.revisionId,
      publicationOperationId: fixture.operationId,
      commitRequestedAt: timestamp(2),
    } as const;
    await store.prepareInitialCurrent(input);
    const transaction = resourceDigest(
      "chronorift-project-environment-publication-transaction-v1",
      environmentId,
      `${fixture.revisionId}\0${fixture.operationId}`,
    );
    await link(
      join(namespaceRoot, "transactions", transaction, "current.pointer.json"),
      join(namespaceRoot, "current.json"),
    );

    const reopened = new ProjectEnvironmentStoreV1({
      namespaceRoot,
      environmentId,
    });
    await reopened.open();
    await expect(reopened.readCurrent()).rejects.toBeInstanceOf(
      ProjectEnvironmentPublicationRecoveryRequiredError,
    );
    await expect(
      reopened.reconcileInitialPublication(input),
    ).resolves.toMatchObject({
      state: "committed",
    });
    await expect(reopened.readCurrent()).resolves.toMatchObject({
      environmentRevisionId: fixture.revisionId,
    });
  });

  it("quarantines a partial revision without changing current", async () => {
    const { environmentId, namespaceRoot, store } =
      await projectHarness("partial");
    const fixture = revisionFixture(environmentId, "partial");
    const revisionDirectory = resourceDigest(
      "chronorift-project-environment-revision-v1",
      environmentId,
      fixture.revisionId,
    );
    await mkdir(join(namespaceRoot, "revisions", revisionDirectory), {
      mode: 0o700,
    });
    await expect(
      store.inspectInitialPublication(fixture.revisionId, fixture.operationId),
    ).resolves.toMatchObject({ state: "revision_incomplete", current: null });
    await store.quarantineIncompleteRevision(
      fixture.revisionId,
      fixture.operationId,
    );
    await expect(store.readCurrent()).resolves.toBeNull();
    await expect(store.summary()).resolves.toMatchObject({
      incompleteRevisions: 0,
      quarantinedRevisions: 1,
    });
  });

  it("preserves the committed current on a conflicting initial publication", async () => {
    const { environmentId, store } = await projectHarness("conflict");
    const first = revisionFixture(environmentId, "conflict-first");
    await store.materializeRevisionOnce(first.revision, first.files);
    await store.commitInitialCurrent({
      expectedCurrentRevisionId: null,
      environmentRevisionId: first.revisionId,
      publicationOperationId: first.operationId,
      commitRequestedAt: timestamp(3),
    });
    const second = revisionFixture(environmentId, "conflict-second");
    await store.materializeRevisionOnce(second.revision, second.files);
    await expect(
      store.commitInitialCurrent({
        expectedCurrentRevisionId: null,
        environmentRevisionId: second.revisionId,
        publicationOperationId: second.operationId,
        commitRequestedAt: timestamp(4),
      }),
    ).rejects.toBeInstanceOf(ProjectEnvironmentCurrentConflictError);
    await expect(store.readCurrent()).resolves.toMatchObject({
      environmentRevisionId: first.revisionId,
    });
  });

  it("fails closed for a corrupt current pointer", async () => {
    const { environmentId, namespaceRoot, store } =
      await projectHarness("corrupt");
    const fixture = revisionFixture(environmentId, "corrupt");
    await store.materializeRevisionOnce(fixture.revision, fixture.files);
    await store.commitInitialCurrent({
      expectedCurrentRevisionId: null,
      environmentRevisionId: fixture.revisionId,
      publicationOperationId: fixture.operationId,
      commitRequestedAt: timestamp(5),
    });
    await truncate(join(namespaceRoot, "current.json"), 3);
    const reopened = new ProjectEnvironmentStoreV1({
      namespaceRoot,
      environmentId,
    });
    await expect(reopened.open()).rejects.toBeInstanceOf(
      ArtifactCorruptionError,
    );
    expect(
      await readFile(join(namespaceRoot, "current.json"), "utf8"),
    ).toHaveLength(3);
  });
});
