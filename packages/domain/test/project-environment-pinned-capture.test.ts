import {
  ProjectEnvironmentPinnedCaptureV1Schema,
  asBuildId,
  asCaptureWindowId,
  asExecutionId,
  asProjectAdapterRevisionId,
  asProjectEnvironmentRevisionId,
  asProjectEnvironmentTaskId,
  asRuntimeId,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

const capture = () =>
  ProjectEnvironmentPinnedCaptureV1Schema.parse({
    schemaVersion: 1,
    captureWindowId: asCaptureWindowId("capture-window.v1.batch-1"),
    taskId: asProjectEnvironmentTaskId("task.v1.pinned-capture"),
    runtimeId: asRuntimeId("runtime.v1.pinned-capture"),
    executionId: asExecutionId("execution.v1.pinned-capture"),
    buildId: asBuildId("build.v1.pinned-capture"),
    environmentRevisionId: asProjectEnvironmentRevisionId(
      "environment-revision.v1.pinned-capture",
    ),
    adapterRevisionId: asProjectAdapterRevisionId(
      "adapter-revision.v1.pinned-capture",
    ),
    recordCount: 2,
    contentDigest: "a".repeat(64),
    anchorClock: {
      schemaVersion: 1,
      processFrame: 12,
      physicsTick: 6,
      simulationTimeUs: 200_000,
      renderFrame: null,
      hostMonotonicUs: 210_000,
    },
    coverage: [
      {
        schemaVersion: 1,
        channelId: "project_adapter_observations",
        status: "complete",
        observedRecords: 2,
        droppedRecords: 0,
        overwrittenRecords: 0,
        limitations: [],
      },
    ],
    loss: [],
    createdAt: "2026-08-13T00:00:00.000Z",
  });

describe("ProjectEnvironmentPinnedCaptureV1", () => {
  it("strictly records all capture and runtime lineage", () => {
    const value = capture();

    expect(value.captureWindowId).toBe("capture-window.v1.batch-1");
    expect(value.recordCount).toBe(2);
    expect(() =>
      ProjectEnvironmentPinnedCaptureV1Schema.parse({
        ...value,
        untrustedVerdict: "fixed",
      }),
    ).toThrow();
    expect(() =>
      ProjectEnvironmentPinnedCaptureV1Schema.parse({
        ...value,
        captureWindowId: "../foreign-capture",
      }),
    ).toThrow();
    expect(() =>
      ProjectEnvironmentPinnedCaptureV1Schema.parse({
        ...value,
        executionId: "../foreign-execution",
      }),
    ).toThrow();
    expect(() =>
      ProjectEnvironmentPinnedCaptureV1Schema.parse({
        ...value,
        recordCount: 0,
      }),
    ).toThrow();
  });

  it("rejects duplicate coverage and loss outside covered channels", () => {
    const value = capture();
    expect(() =>
      ProjectEnvironmentPinnedCaptureV1Schema.parse({
        ...value,
        coverage: [...value.coverage, value.coverage[0]],
      }),
    ).toThrow(/coverage channels must be unique/u);
    expect(() =>
      ProjectEnvironmentPinnedCaptureV1Schema.parse({
        ...value,
        loss: [
          {
            schemaVersion: 1,
            channelId: "foreign-channel",
            kind: "dropped",
            count: 1,
            reason: "transport reported one dropped record",
          },
        ],
      }),
    ).toThrow(/loss must reference a covered channel/u);
  });
});
