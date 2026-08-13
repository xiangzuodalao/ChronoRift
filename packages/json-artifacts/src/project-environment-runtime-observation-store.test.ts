import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  asProjectEnvironmentTaskId,
} from "@chronorift/domain";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectEnvironmentTaskStoreV1 } from "./project-environment-task-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const receipt = (taskId: string) =>
  ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse({
    schemaVersion: 1,
    receiptId: "runtime-observation-receipt.v1.store-test",
    taskId,
    runtimeId: "runtime.v1.store-test",
    executionId: "execution.v1.store-test",
    buildId: "build.v1.store-test",
    environmentRevisionId: "environment-revision.v1.store-test",
    adapterRevisionId: "adapter-revision.v1.store-test",
    launchTargetId: "main",
    instrumentationMode: "instrumented",
    status: "stopped",
    bridgeHandshakeCount: 1,
    clock: {
      schemaVersion: 1,
      processFrame: 4,
      physicsTick: 2,
      simulationTimeUs: 66_667,
      renderFrame: null,
      hostMonotonicUs: 70_000,
    },
    queryObservations: {
      schemaVersion: 1,
      entityQueryCount: 1,
      entityRows: 1,
      stateQueryCount: 1,
      stateRows: 1,
    },
    captureCount: 1,
    captureWindowIds: ["capture-window.v1.store"],
    coverage: [
      {
        schemaVersion: 1,
        channelId: "project_adapter_observations",
        status: "complete",
        observedRecords: 3,
        droppedRecords: 0,
        overwrittenRecords: 0,
        limitations: [],
      },
    ],
    loss: [],
    cleanup: {
      schemaVersion: 1,
      processTreeTerminated: true,
      runtimeExited: true,
      bridgeExited: true,
      isolationGroupEmpty: true,
      scopeRemoved: true,
      scratchRemoved: true,
      storageReconciled: true,
    },
    outcome: "succeeded",
    failures: [],
    startedAt: "2026-08-13T00:00:00.000Z",
    observedAt: "2026-08-13T00:00:01.000Z",
    completedAt: "2026-08-13T00:00:02.000Z",
  });

describe("ProjectEnvironment runtime observation Task records", () => {
  it("stores one immutable receipt and rejects Task ownership mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-pe-runtime-store-"));
    roots.push(root);
    const taskId = asProjectEnvironmentTaskId("task.v1.runtime-store");
    const store = new ProjectEnvironmentTaskStoreV1({
      storeRoot: join(root, "records"),
      taskId,
    });
    await store.create();
    const value = receipt(taskId);

    await store.putRuntimeObservationReceiptOnce(value);
    await store.putRuntimeObservationReceiptOnce(value);
    await expect(
      store.readRuntimeObservationReceipt(value.receiptId),
    ).resolves.toEqual(value);
    await expect(
      store.putRuntimeObservationReceiptOnce({
        ...value,
        taskId: asProjectEnvironmentTaskId("task.v1.other"),
      }),
    ).rejects.toThrow(/different Task/u);
    await expect(
      store.putRuntimeObservationReceiptOnce({
        ...value,
        captureCount: 2,
      }),
    ).rejects.toThrow();
  });
});
