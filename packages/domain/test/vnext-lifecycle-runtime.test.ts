import { describe, expect, it } from "vitest";

import {
  VNextBoundedStreamReceiptV1Schema,
  VNextLifecycleExecutionRecordV1Schema,
  VNextLifecycleExecutionManifestV1Schema,
} from "../src/index.js";

const digest = (value: string): string => value.repeat(64);
const timestamp = "2026-08-10T00:00:00.000Z";

const cleanup = {
  schemaVersion: 1 as const,
  processGroupTerminated: true,
  godotExited: true,
  sidecarExited: true,
  cgroupEmpty: true,
  scopeRemoved: true,
  scratchRemoved: true,
  storageReconciled: true,
};

const stream = {
  schemaVersion: 1 as const,
  totalBytes: 0,
  totalSha256: digest("0"),
  retainedBytes: 0,
  retainedSha256: digest("0"),
  truncated: false,
  droppedBytes: 0,
};

const manifest = VNextLifecycleExecutionManifestV1Schema.parse({
  schemaVersion: 1,
  manifestKind: "lifecycle_execution",
  taskId: "task:v1:test",
  executionId: "execution:v1:test",
  runtimeId: "runtime:v1:test",
  workspaceId: "workspace:v1:test",
  sourceId: "source:v1:test",
  buildId: "build:v1:test",
  adapterId: "adapter:v1:test",
  probeIds: ["probe:v1:test"],
  stateSchemaVersion: "chronorift.lifecycle-shell:v1",
  runtimeProfile: "godot-external-lifecycle-v1",
  protocolProfile: "chronorift-godot-lifecycle-v1",
  launchTarget: "project_main_scene",
  requestedEnvironment: {
    schemaVersion: 1,
    headless: true,
    audioDriver: "Dummy",
    renderingMethod: "gl_compatibility",
    network: "isolated",
    display: "denied",
    gpu: "denied",
  },
  clockDomains: [
    "process_frame",
    "physics_tick",
    "simulation_time",
    "host_monotonic",
  ],
  identities: {
    schemaVersion: 1,
    descriptorSha256: digest("1"),
    sourceSha256: digest("2"),
    buildSha256: digest("3"),
    overlaySha256: digest("4"),
    addonSha256: digest("5"),
    vanillaSidecarSha256: digest("6"),
    lifecycleSidecarSha256: digest("7"),
    managedRuntimeId: `managed-godot-runtime:v1:${"9".repeat(64)}`,
  },
  executionSeal: null,
  startedAt: timestamp,
});

const sealedManifest = VNextLifecycleExecutionManifestV1Schema.parse({
  ...manifest,
  executionSeal: {
    schemaVersion: 1,
    taskId: manifest.taskId,
    executionId: manifest.executionId,
    count: 0,
    headHash: null,
    byteLength: 0,
    contentHash: digest("a"),
  },
});

const phase = {
  schemaVersion: 1 as const,
  sequence: 0,
  phase: "vanilla_import" as const,
  operationId: "operation:v1:test",
  operationState: "started" as const,
  timingFidelity: "operation_bounds" as const,
  processDurationMs: 1,
  stabilityObservedMs: null,
  outcome: "succeeded" as const,
  startedAt: timestamp,
  endedAt: timestamp,
  hostMonotonicStartUs: 1,
  hostMonotonicEndUs: 2,
  exitCode: 0,
  signal: null,
  stdout: stream,
  stderr: stream,
  observation: null,
  cleanup,
  knownSideEffects: ["wrote isolated import cache"],
};

const clock = {
  schemaVersion: 1 as const,
  processFrame: 1,
  physicsTick: 1,
  simulationTimeUs: 1,
  hostMonotonicUs: 1,
  renderFrame: null,
};

const event = {
  schemaVersion: 1 as const,
  eventId: "event:v1:first",
  taskId: manifest.taskId,
  executionId: manifest.executionId,
  runtimeId: manifest.runtimeId,
  buildId: manifest.buildId,
  sequence: 0,
  channel: "clock" as const,
  kind: "clock" as const,
  clock,
  payload: {},
  observedRelations: [],
};

const coverage = {
  schemaVersion: 1 as const,
  channel: "clock" as const,
  status: "sampled" as const,
  availableRange: {
    schemaVersion: 1 as const,
    from: clock,
    through: clock,
  },
  requestedSampleEvery: 1,
  realizedSampleEvery: 2,
  emittedRecords: 1,
  droppedRecords: 0,
  overwrittenRecords: 0,
  observerEffectUs: 0,
  limitations: ["endpoint samples only"],
};

const loss = {
  schemaVersion: 1 as const,
  sequence: 0,
  channel: "clock" as const,
  kind: "sampled" as const,
  count: 1,
  firstClock: clock,
  lastClock: clock,
  reason: "endpoint samples only",
};

describe("vNext lifecycle execution contracts", () => {
  it("does not invent requested frame or physics rates", () => {
    expect(manifest.requestedEnvironment.headless).toBe(true);
    expect(manifest).not.toHaveProperty("controls");
    expect(manifest).not.toHaveProperty("fixedFps");
    expect(manifest).not.toHaveProperty("physicsTicksPerSecond");
  });

  it("requires one digest for a fully retained bounded stream", () => {
    expect(() =>
      VNextBoundedStreamReceiptV1Schema.parse({
        ...stream,
        totalSha256: digest("1"),
      }),
    ).toThrow(/same total and retained digest/iu);
    expect(
      VNextBoundedStreamReceiptV1Schema.parse({
        ...stream,
        totalBytes: 2,
        totalSha256: digest("1"),
        retainedBytes: 1,
        retainedSha256: digest("2"),
        truncated: true,
        droppedBytes: 1,
      }).truncated,
    ).toBe(true);
  });

  it("accepts a sealed record only when phase cleanup is proven", () => {
    const valid = {
      schemaVersion: 1,
      recordKind: "lifecycle_execution",
      taskId: manifest.taskId,
      executionId: manifest.executionId,
      runtimeId: manifest.runtimeId,
      buildId: manifest.buildId,
      manifest: sealedManifest,
      phases: [phase, { ...phase, sequence: 1, phase: "managed_stop" }],
      events: [],
      coverage: [],
      loss: [],
      status: "stopped",
      sealed: true,
      endedAt: timestamp,
      termination: {
        schemaVersion: 1,
        code: "controlled_stop",
        message: null,
      },
      recordHash: digest("8"),
    } as const;

    expect(VNextLifecycleExecutionRecordV1Schema.parse(valid).sealed).toBe(
      true,
    );
    expect(() =>
      VNextLifecycleExecutionRecordV1Schema.parse({
        ...valid,
        phases: [
          {
            ...phase,
            cleanup: { ...cleanup, cgroupEmpty: false },
          },
          {
            ...phase,
            sequence: 1,
            phase: "managed_stop",
          },
        ],
      }),
    ).toThrow(/cleanup/iu);

    expect(() =>
      VNextLifecycleExecutionRecordV1Schema.parse({
        ...valid,
        manifest,
      }),
    ).toThrow(/ledger seal/iu);
    expect(() =>
      VNextLifecycleExecutionRecordV1Schema.parse({
        ...valid,
        manifest: {
          ...sealedManifest,
          executionSeal: {
            ...sealedManifest.executionSeal,
            executionId: "execution:v1:other",
          },
        },
      }),
    ).toThrow(/ledger seal/iu);
  });

  it("seals a failed vanilla launch without inventing a managed cleanup", () => {
    const failedVanilla = {
      schemaVersion: 1,
      recordKind: "lifecycle_execution",
      taskId: manifest.taskId,
      executionId: manifest.executionId,
      runtimeId: manifest.runtimeId,
      buildId: manifest.buildId,
      manifest: sealedManifest,
      phases: [{ ...phase, outcome: "failed", exitCode: 1 }],
      events: [],
      coverage: [],
      loss: [],
      status: "failed",
      sealed: true,
      endedAt: timestamp,
      termination: {
        schemaVersion: 1,
        code: "runtime_termination",
        message: null,
      },
      recordHash: digest("8"),
    } as const;

    expect(
      VNextLifecycleExecutionRecordV1Schema.parse(failedVanilla).sealed,
    ).toBe(true);
    expect(() =>
      VNextLifecycleExecutionRecordV1Schema.parse({
        ...failedVanilla,
        phases: [
          {
            ...phase,
            cleanup: null,
            operationState: "unknown",
            outcome: "failed",
            exitCode: null,
          },
        ],
      }),
    ).toThrow(/requires a proven latest cleanup/iu);
  });

  it("rejects non-contiguous phase sequence", () => {
    expect(() =>
      VNextLifecycleExecutionRecordV1Schema.parse({
        schemaVersion: 1,
        recordKind: "lifecycle_execution",
        taskId: manifest.taskId,
        executionId: manifest.executionId,
        runtimeId: manifest.runtimeId,
        buildId: manifest.buildId,
        manifest,
        phases: [{ ...phase, sequence: 2 }],
        events: [],
        coverage: [],
        loss: [],
        status: "running",
        sealed: false,
      }),
    ).toThrow(/sequence/iu);
  });

  it("rejects duplicate raw event identities and invalid relations", () => {
    const running = {
      schemaVersion: 1,
      recordKind: "lifecycle_execution",
      taskId: manifest.taskId,
      executionId: manifest.executionId,
      runtimeId: manifest.runtimeId,
      buildId: manifest.buildId,
      manifest,
      phases: [phase],
      coverage: [],
      loss: [],
      status: "running",
      sealed: false,
    } as const;

    expect(() =>
      VNextLifecycleExecutionRecordV1Schema.parse({
        ...running,
        events: [event, { ...event, sequence: 1 }],
      }),
    ).toThrow(/event IDs must be unique/iu);
    expect(() =>
      VNextLifecycleExecutionRecordV1Schema.parse({
        ...running,
        events: [
          {
            ...event,
            observedRelations: [
              {
                schemaVersion: 1,
                kind: "scheduled_by",
                targetEventId: event.eventId,
              },
            ],
          },
        ],
      }),
    ).toThrow(/cannot target its own event/iu);
    expect(() =>
      VNextLifecycleExecutionRecordV1Schema.parse({
        ...running,
        events: [
          {
            ...event,
            observedRelations: [
              {
                schemaVersion: 1,
                kind: "scheduled_by",
                targetEventId: "event:v1:missing",
              },
            ],
          },
        ],
      }),
    ).toThrow(/target must exist/iu);
  });

  it("rejects duplicate coverage and incomplete loss accounting", () => {
    const running = {
      schemaVersion: 1,
      recordKind: "lifecycle_execution",
      taskId: manifest.taskId,
      executionId: manifest.executionId,
      runtimeId: manifest.runtimeId,
      buildId: manifest.buildId,
      manifest,
      phases: [phase],
      events: [],
      status: "running",
      sealed: false,
    } as const;

    expect(() =>
      VNextLifecycleExecutionRecordV1Schema.parse({
        ...running,
        coverage: [coverage, coverage],
        loss: [loss],
      }),
    ).toThrow(/duplicate/iu);
    expect(() =>
      VNextLifecycleExecutionRecordV1Schema.parse({
        ...running,
        coverage: [coverage],
        loss: [{ ...loss, sequence: 1 }],
      }),
    ).toThrow(/contiguous/iu);
    expect(() =>
      VNextLifecycleExecutionRecordV1Schema.parse({
        ...running,
        coverage: [coverage],
        loss: [],
      }),
    ).toThrow(/requires an explicit loss record/iu);
  });
});
