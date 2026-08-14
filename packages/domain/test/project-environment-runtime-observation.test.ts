import { describe, expect, it } from "vitest";

import {
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  asBuildId,
  asExecutionId,
  asProjectAdapterRevisionId,
  asProjectEnvironmentRevisionId,
  asProjectEnvironmentRuntimeObservationReceiptId,
  asProjectEnvironmentTaskId,
  asRuntimeId,
} from "../src/index.js";

const completeCleanup = {
  schemaVersion: 1 as const,
  processTreeTerminated: true,
  runtimeExited: true,
  bridgeExited: true,
  isolationGroupEmpty: true,
  scopeRemoved: true,
  scratchRemoved: true,
  storageReconciled: true,
};

const succeededReceipt = () => ({
  schemaVersion: 1 as const,
  receiptId: asProjectEnvironmentRuntimeObservationReceiptId(
    "runtime-observation-receipt.v1.test",
  ),
  taskId: asProjectEnvironmentTaskId("task.v1.runtime-observation"),
  runtimeId: asRuntimeId("runtime.v1.runtime-observation"),
  executionId: asExecutionId("execution.v1.runtime-observation"),
  buildId: asBuildId("build.v1.runtime-observation"),
  environmentRevisionId: asProjectEnvironmentRevisionId(
    "environment-revision.v1.runtime-observation",
  ),
  adapterRevisionId: asProjectAdapterRevisionId(
    "adapter-revision.v1.runtime-observation",
  ),
  launchTargetId: "main",
  instrumentationMode: "instrumented" as const,
  status: "stopped" as const,
  bridgeHandshakeCount: 1,
  clock: {
    schemaVersion: 1 as const,
    processFrame: 12,
    physicsTick: 7,
    simulationTimeUs: 200_000,
    renderFrame: null,
    hostMonotonicUs: 500_000,
  },
  queryObservations: {
    schemaVersion: 1 as const,
    entityQueryCount: 1,
    entityRows: 2,
    stateQueryCount: 1,
    stateRows: 1,
  },
  captureCount: 1,
  captureWindowIds: ["capture-window.v1.runtime-observation"],
  coverage: [
    {
      schemaVersion: 1 as const,
      channelId: "project_adapter_observations",
      status: "complete" as const,
      observedRecords: 4,
      droppedRecords: 0,
      overwrittenRecords: 0,
      limitations: [],
    },
  ],
  loss: [],
  cleanup: completeCleanup,
  outcome: "succeeded" as const,
  failures: [],
  startedAt: "2026-08-13T00:00:00.000Z",
  observedAt: "2026-08-13T00:00:01.000Z",
  completedAt: "2026-08-13T00:00:02.000Z",
});

describe("ProjectEnvironmentRuntimeObservationReceiptV1", () => {
  it("accepts a stopped, lossless, queried and captured runtime observation", () => {
    expect(
      ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse(
        succeededReceipt(),
      ),
    ).toEqual(succeededReceipt());
  });

  it.each([
    ["an observed clock", { clock: null }],
    ["capture", { captureCount: 0 }],
    ["capture identity", { captureWindowIds: [] }],
    [
      "entity query",
      {
        queryObservations: {
          ...succeededReceipt().queryObservations,
          entityQueryCount: 0,
          entityRows: 0,
        },
      },
    ],
    [
      "state query",
      {
        queryObservations: {
          ...succeededReceipt().queryObservations,
          stateQueryCount: 0,
          stateRows: 0,
        },
      },
    ],
    [
      "complete cleanup",
      {
        cleanup: { ...completeCleanup, storageReconciled: false },
      },
    ],
  ])("rejects a succeeded outcome without %s", (_label, change) => {
    expect(() =>
      ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse({
        ...succeededReceipt(),
        ...change,
      }),
    ).toThrow(/runtime observation success|capture count/u);
  });

  it("allows an incomplete pre-handshake observation to report no engine clock", () => {
    expect(
      ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse({
        ...succeededReceipt(),
        bridgeHandshakeCount: 0,
        clock: null,
        queryObservations: {
          schemaVersion: 1,
          entityQueryCount: 0,
          entityRows: 0,
          stateQueryCount: 0,
          stateRows: 0,
        },
        captureCount: 0,
        captureWindowIds: [],
        coverage: [
          {
            schemaVersion: 1,
            channelId: "project_adapter_observations",
            status: "unavailable",
            observedRecords: 0,
            droppedRecords: 0,
            overwrittenRecords: 0,
            limitations: ["Bridge handshake did not complete."],
          },
        ],
        loss: [
          {
            schemaVersion: 1,
            channelId: "project_adapter_observations",
            kind: "unavailable",
            count: 1,
            reason: "Transport loss was not observable.",
          },
        ],
        cleanup: {
          ...completeCleanup,
          runtimeExited: false,
          bridgeExited: false,
        },
        outcome: "incomplete",
        failures: ["Bridge handshake failed."],
      }),
    ).toMatchObject({ clock: null, outcome: "incomplete" });
  });
});
