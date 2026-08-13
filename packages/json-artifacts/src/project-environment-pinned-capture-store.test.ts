import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonValueSchema,
  ProjectEnvironmentPinnedCaptureV1Schema,
  asBuildId,
  asCaptureWindowId,
  asExecutionId,
  asProjectAdapterRevisionId,
  asProjectEnvironmentRevisionId,
  asProjectEnvironmentTaskId,
  asRuntimeId,
  type JsonValue,
  type TaskId,
} from "@chronorift/domain";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical-json.js";
import { ArtifactCorruptionError } from "./json-artifact-repository.js";
import {
  ProjectEnvironmentStoreQuotaError,
  ProjectEnvironmentTaskStoreV1,
  projectEnvironmentPackageContentDigestV1,
} from "./project-environment-task-store.js";
import { resourceDigest } from "./project-environment-store-internals.js";
import {
  ArtifactPathSecurityError,
  ImmutableArtifactConflictError,
} from "./v01-json-artifact-repository.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const canonicalRecordsBytes = (records: JsonValue[]): Buffer =>
  Buffer.from(`${canonicalJson(JsonValueSchema.parse(records))}\n`, "utf8");

const recordsFixture = (): JsonValue[] => [
  {
    schemaVersion: 1,
    kind: "entity_state",
    sequence: 4,
    state: { velocity: [1, 2], grounded: true },
  },
  {
    schemaVersion: 1,
    kind: "custom_event",
    sequence: 5,
    payload: { eventType: "landed", strength: 0.75 },
  },
];

const captureFixture = (taskId: TaskId, records = recordsFixture()) => {
  const recordsBytes = canonicalRecordsBytes(records);
  const capture = ProjectEnvironmentPinnedCaptureV1Schema.parse({
    schemaVersion: 1,
    captureWindowId: asCaptureWindowId("capture-window.v1.store-test"),
    taskId,
    runtimeId: asRuntimeId("runtime.v1.store-test"),
    executionId: asExecutionId("execution.v1.store-test"),
    buildId: asBuildId("build.v1.store-test"),
    environmentRevisionId: asProjectEnvironmentRevisionId(
      "environment-revision.v1.store-test",
    ),
    adapterRevisionId: asProjectAdapterRevisionId(
      "adapter-revision.v1.store-test",
    ),
    recordCount: records.length,
    contentDigest: projectEnvironmentPackageContentDigestV1([
      { path: "records.json", bytes: recordsBytes },
    ]),
    anchorClock: {
      schemaVersion: 1,
      processFrame: 10,
      physicsTick: 5,
      simulationTimeUs: 166_667,
      renderFrame: null,
      hostMonotonicUs: 170_000,
    },
    coverage: [
      {
        schemaVersion: 1,
        channelId: "project_adapter_observations",
        status: "complete",
        observedRecords: records.length,
        droppedRecords: 0,
        overwrittenRecords: 0,
        limitations: [],
      },
    ],
    loss: [],
    createdAt: "2026-08-13T00:00:00.000Z",
  });
  return { capture, records, recordsBytes };
};

async function harness(taskName = "main") {
  const root = await mkdtemp(
    join(tmpdir(), `chronorift-pe-pinned-capture-${taskName}-`),
  );
  roots.push(root);
  const taskId = asProjectEnvironmentTaskId(`task.v1.${taskName}`);
  const storeRoot = join(root, "project-environment-records");
  const store = new ProjectEnvironmentTaskStoreV1({ storeRoot, taskId });
  await store.create();
  return { root, store, storeRoot, taskId };
}

const packagePath = (
  storeRoot: string,
  taskId: TaskId,
  captureWindowId: string,
): string =>
  join(
    storeRoot,
    "capture-windows",
    resourceDigest(
      "chronorift-project-environment-pinned-capture-v1",
      taskId,
      captureWindowId,
    ),
  );

describe("ProjectEnvironmentTaskStoreV1 pinned captures", () => {
  it("stores exact canonical records.json bytes and reads an immutable package", async () => {
    const { store, storeRoot, taskId } = await harness();
    const fixture = captureFixture(taskId);

    const first = await store.putPinnedCaptureOnce(
      fixture.capture,
      fixture.records,
    );
    const second = await store.putPinnedCaptureOnce(
      fixture.capture,
      fixture.records,
    );
    expect(second).toEqual(first);

    const stored = await store.readPinnedCapture(
      fixture.capture.captureWindowId,
    );
    expect(stored.payload).toEqual(fixture.capture);
    expect(stored.records).toEqual(fixture.records);
    expect(Buffer.from(stored.recordsBytes)).toEqual(fixture.recordsBytes);
    expect(stored.packageHash).toBe(first.packageHash);
    await expect(
      readFile(
        join(
          packagePath(storeRoot, taskId, fixture.capture.captureWindowId),
          "files",
          "records.json",
        ),
      ),
    ).resolves.toEqual(fixture.recordsBytes);

    const reopened = new ProjectEnvironmentTaskStoreV1({ storeRoot, taskId });
    await reopened.open();
    await expect(
      reopened.readPinnedCapture(fixture.capture.captureWindowId),
    ).resolves.toMatchObject({ records: fixture.records });
  });

  it("rejects mismatched records, replacement content, and cross-Task ownership", async () => {
    const { store, taskId } = await harness();
    const fixture = captureFixture(taskId);

    await expect(
      store.putPinnedCaptureOnce(
        { ...fixture.capture, recordCount: fixture.capture.recordCount + 1 },
        fixture.records,
      ),
    ).rejects.toThrow(/record count or content digest/u);
    await expect(
      store.putPinnedCaptureOnce(
        {
          ...fixture.capture,
          taskId: asProjectEnvironmentTaskId("task.v1.foreign"),
        },
        fixture.records,
      ),
    ).rejects.toBeInstanceOf(ArtifactPathSecurityError);

    await store.putPinnedCaptureOnce(fixture.capture, fixture.records);
    const changedRecords = fixture.records.map((record, index) =>
      index === 0 && typeof record === "object" && record !== null
        ? { ...record, changed: true }
        : record,
    );
    const changed = captureFixture(taskId, changedRecords);
    await expect(
      store.putPinnedCaptureOnce(changed.capture, changed.records),
    ).rejects.toBeInstanceOf(ImmutableArtifactConflictError);
  });

  it("detects records.json corruption and a package transplanted across Tasks", async () => {
    const first = await harness("capture-owner");
    const fixture = captureFixture(first.taskId);
    await first.store.putPinnedCaptureOnce(fixture.capture, fixture.records);
    const firstPackage = packagePath(
      first.storeRoot,
      first.taskId,
      fixture.capture.captureWindowId,
    );
    await writeFile(
      join(firstPackage, "files", "records.json"),
      canonicalRecordsBytes([{ corrupted: true }]),
    );
    await expect(
      first.store.readPinnedCapture(fixture.capture.captureWindowId),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);

    const source = await harness("source-owner");
    const sourceFixture = captureFixture(source.taskId);
    await source.store.putPinnedCaptureOnce(
      sourceFixture.capture,
      sourceFixture.records,
    );
    const target = await harness("target-owner");
    const sourcePackage = packagePath(
      source.storeRoot,
      source.taskId,
      sourceFixture.capture.captureWindowId,
    );
    await cp(
      sourcePackage,
      join(
        target.storeRoot,
        "capture-windows",
        sourcePackage.split("/").at(-1)!,
      ),
      { recursive: true },
    );
    await expect(
      new ProjectEnvironmentTaskStoreV1({
        storeRoot: target.storeRoot,
        taskId: target.taskId,
      }).open(),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);
  });

  it("applies package quotas to canonical capture records", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-pe-capture-quota-"));
    roots.push(root);
    const taskId = asProjectEnvironmentTaskId("task.v1.capture-quota");
    const store = new ProjectEnvironmentTaskStoreV1({
      storeRoot: join(root, "records"),
      taskId,
      quota: {
        maximumTotalBytes: 16_384,
        maximumEntries: 64,
        maximumCanonicalJsonBytes: 4_096,
        maximumPackageBytes: 64,
        maximumPackageFiles: 1,
      },
    });
    await store.create();
    const records: JsonValue[] = [{ payload: "x".repeat(128) }];
    const fixture = captureFixture(taskId, records);

    await expect(
      store.putPinnedCaptureOnce(fixture.capture, fixture.records),
    ).rejects.toBeInstanceOf(ProjectEnvironmentStoreQuotaError);
  });
});
