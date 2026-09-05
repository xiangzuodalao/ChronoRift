import { createHash } from "node:crypto";
import { link, mkdtemp, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EnvironmentPublicationIntentV1Schema,
  ProjectAdapterCandidateReferenceV1Schema,
  ProjectInitializationAttemptEventV1Schema,
  VNextBuildV1Schema,
  asAdapterId,
  asBuildId,
  asProjectAdapterCandidateId,
  asProjectAdapterRevisionId,
  asProjectEnvironmentId,
  asProjectEnvironmentOperationId,
  asProjectEnvironmentRevisionId,
  asProjectEnvironmentTaskId,
  asProjectInitializationAttemptId,
  asProjectInitializationAttemptEventId,
  asProjectSessionId,
  asSourceId,
  asWorkspaceId,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import { ArtifactCorruptionError } from "./errors.js";
import {
  ProjectEnvironmentLedgerSealedError,
  ProjectEnvironmentStoreQuotaError,
  ProjectEnvironmentTaskStoreV1,
  projectEnvironmentPackageContentDigestV1,
} from "./project-environment-task-store.js";
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
