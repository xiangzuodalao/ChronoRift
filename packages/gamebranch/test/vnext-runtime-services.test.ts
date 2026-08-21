import { describe, expect, it } from "vitest";

import {
  VNEXT_MAX_CAPTURE_RECORD_BYTES,
  VNEXT_MAX_PINNED_EVENTS,
  VNEXT_MAX_ROLLING_BUFFER_BYTES,
  VNextCaptureCapacityError,
  VNextCheckpointRestoreService,
  VNextDescriptiveComparisonService,
  VNextRollingCapture,
  VNextRuntimeStateIndex,
  VNextTraceReplayService,
  jsonEqual,
  type VNextCheckpointRestorePort,
  type VNextRuntimeEventIdPort,
  type VNextTraceReplayPort,
} from "../src/index.js";
import {
  VNextComparisonV1Schema,
  asAdapterId,
  asBuildId,
  asCaptureWindowId,
  asCheckpointId,
  asComparisonId,
  asEventId,
  asExecutionId,
  asProbeId,
  asRestoreReceiptId,
  asRuntimeId,
  asRuntimeStateIndexId,
  asSha256DigestV1,
  asSourceId,
  asTaskId,
  asTraceId,
  asWorkspaceId,
  type VNextCaptureCoverageV1,
  type VNextCaptureLossV1,
  type VNextCheckpointManifestV1,
  type VNextClockPositionV1,
  type VNextComparisonExecutionRefV1,
  type VNextRawRuntimeEventV1,
  type VNextRuntimeControlReceiptV1,
  type VNextRuntimeStateQueryResultV1,
  type VNextRuntimeTraceV1,
} from "@chronorift/domain";

const taskId = asTaskId("task:m3-service");
const workspaceId = asWorkspaceId("workspace:m3-service");
const sourceId = asSourceId("source:baseline");
const buildId = asBuildId("build:baseline");
const runtimeId = asRuntimeId("runtime:baseline");
const executionId = asExecutionId("execution:baseline");
const adapterId = asAdapterId("adapter:fixture");
const probeId = asProbeId("probe:fixture");
const digest = (character: string) => asSha256DigestV1(character.repeat(64));
const createdAt = "2026-08-07T00:00:00.000Z";

describe("canonical JSON equality", () => {
  it("ignores object key order while preserving nested array and value differences", () => {
    expect(
      jsonEqual(
        { second: [1, { enabled: true, value: null }], first: "value" },
        { first: "value", second: [1, { value: null, enabled: true }] },
      ),
    ).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({ value: 1 }, { value: "1" })).toBe(false);
  });
});

const clock = (
  physicsTick: number,
  simulationTimeUs: number,
  processFrame = physicsTick,
): VNextClockPositionV1 => ({
  schemaVersion: 1,
  processFrame,
  physicsTick,
  simulationTimeUs,
  hostMonotonicUs: simulationTimeUs + 1_000_000,
  renderFrame: null,
});

class SequentialEventIds implements VNextRuntimeEventIdPort {
  private next = 0;

  public nextEventId() {
    const id = asEventId(`event:capture:${this.next}`);
    this.next += 1;
    return id;
  }
}

const capturePolicy = (memoryBudgetBytes = 1_000_000) => ({
  schemaVersion: 1 as const,
  requestedRetentionUs: 10_000_000,
  requestedRetentionTicks: 600,
  memoryBudgetBytes,
  diskBudgetBytes: 1_000_000,
  maxAverageOverheadRatio: 0.05,
  maxMainThreadBlockUs: 2_000,
  channels: [
    {
      schemaVersion: 1 as const,
      channel: "input" as const,
      priority: "protected" as const,
      sampleEvery: 1,
    },
    {
      schemaVersion: 1 as const,
      channel: "state_summary" as const,
      priority: "low" as const,
      sampleEvery: 1,
    },
    {
      schemaVersion: 1 as const,
      channel: "error" as const,
      priority: "protected" as const,
      sampleEvery: 1,
    },
  ],
});

const rollingCapture = (memoryBudgetBytes = 1_000_000) =>
  new VNextRollingCapture({
    taskId,
    executionId,
    runtimeId,
    sourceId,
    buildId,
    adapterId,
    probeIds: [probeId],
    policy: capturePolicy(memoryBudgetBytes),
    eventIds: new SequentialEventIds(),
  });

describe("VNextRollingCapture", () => {
  it("fails closed before retaining a single oversized raw record", () => {
    const capture = rollingCapture();
    expect(() =>
      capture.append({
        channel: "input",
        kind: "input",
        clock: clock(0, 0),
        payload: { bounded: false },
        observedRelations: [],
        recordedBytes: VNEXT_MAX_CAPTURE_RECORD_BYTES + 1,
        observerEffectUs: 0,
        mainThreadBlockUs: 0,
        overheadRatio: 0,
      }),
    ).toThrow(VNextCaptureCapacityError);
    expect(capture.records()).toEqual([]);
  });

  it("fails closed at the absolute rolling-buffer byte ceiling even for protected data", () => {
    const capture = new VNextRollingCapture({
      taskId,
      executionId,
      runtimeId,
      sourceId,
      buildId,
      adapterId,
      probeIds: [probeId],
      policy: {
        ...capturePolicy(VNEXT_MAX_ROLLING_BUFFER_BYTES * 2),
        diskBudgetBytes: VNEXT_MAX_ROLLING_BUFFER_BYTES * 4,
      },
      eventIds: new SequentialEventIds(),
    });
    const append = () =>
      capture.append({
        channel: "input",
        kind: "input",
        clock: clock(0, 0),
        payload: { bounded: true },
        observedRelations: [],
        recordedBytes: VNEXT_MAX_CAPTURE_RECORD_BYTES,
        observerEffectUs: 0,
        mainThreadBlockUs: 0,
        overheadRatio: 0,
      });

    for (
      let index = 0;
      index < VNEXT_MAX_ROLLING_BUFFER_BYTES / VNEXT_MAX_CAPTURE_RECORD_BYTES;
      index += 1
    ) {
      expect(append()).not.toBeNull();
    }
    expect(append).toThrow(VNextCaptureCapacityError);
    expect(capture.records()).toHaveLength(
      VNEXT_MAX_ROLLING_BUFFER_BYTES / VNEXT_MAX_CAPTURE_RECORD_BYTES,
    );
  });

  it("degrades low-priority state before protected input and emits raw loss markers", () => {
    const capture = rollingCapture(250);

    capture.append({
      channel: "state_summary",
      kind: "state",
      clock: clock(0, 0),
      payload: { entity: "player", statePath: "player.jumping", value: false },
      observedRelations: [],
      recordedBytes: 200,
      observerEffectUs: 20,
      mainThreadBlockUs: 20,
      overheadRatio: 0.01,
    });
    capture.append({
      channel: "input",
      kind: "input",
      clock: clock(1, 16_667),
      payload: { action: "jump", pressed: true },
      observedRelations: [],
      recordedBytes: 200,
      observerEffectUs: 20,
      mainThreadBlockUs: 20,
      overheadRatio: 0.01,
    });

    const records = capture.records();
    expect(records.some((event) => event.kind === "input")).toBe(true);
    expect(records.some((event) => event.kind === "capture_loss")).toBe(true);
    expect(capture.loss()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "state_summary" }),
      ]),
    );
    expect(capture.profile().gameplayPausedForCapture).toBe(false);

    const result = capture.pin({
      captureWindowId: asCaptureWindowId("capture:budget"),
      requestedRange: {
        schemaVersion: 1,
        from: clock(0, 0),
        through: clock(1, 16_667),
      },
      frozenBy: "manual_pin",
      pinnedAt: createdAt,
    });

    expect(result.code).toBe("pinned");
    expect(result.window.status).toBe("partial");
    expect(result.window.loss.length).toBeGreaterThan(0);
  });

  it("reports history_window_unavailable after either rolling boundary overwrites history", () => {
    const capture = rollingCapture();
    capture.append({
      channel: "input",
      kind: "input",
      clock: clock(0, 0),
      payload: { action: "jump", pressed: true },
      observedRelations: [],
      recordedBytes: 10,
      observerEffectUs: 1,
      mainThreadBlockUs: 1,
      overheadRatio: 0.001,
    });
    capture.append({
      channel: "input",
      kind: "input",
      clock: clock(601, 10_000_001),
      payload: { action: "jump", pressed: false },
      observedRelations: [],
      recordedBytes: 10,
      observerEffectUs: 1,
      mainThreadBlockUs: 1,
      overheadRatio: 0.001,
    });

    const result = capture.pin({
      captureWindowId: asCaptureWindowId("capture:old-history"),
      requestedRange: {
        schemaVersion: 1,
        from: clock(0, 0),
        through: clock(0, 0),
      },
      frozenBy: "manual_pin",
      pinnedAt: createdAt,
    });

    expect(result.code).toBe("history_window_unavailable");
    expect(result.window.status).toBe("unavailable");
    expect(result.window.realizedRange).toBeNull();
    expect(result.window.loss).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "overwritten" }),
      ]),
    );
    expect(
      capture.records().some((event) => event.kind === "capture_loss"),
    ).toBe(true);
  });

  it("pins a bounding clock envelope and expires pre-restore history on a monotonic retention axis", () => {
    const capture = rollingCapture();
    capture.append({
      channel: "input",
      kind: "input",
      clock: clock(600, 10_000_000, 600),
      payload: { phase: "before_restore" },
      observedRelations: [],
      recordedBytes: 10,
      observerEffectUs: 1,
      mainThreadBlockUs: 1,
      overheadRatio: 0.001,
    });
    capture.append({
      channel: "input",
      kind: "input",
      clock: clock(0, 0, 0),
      payload: { phase: "after_restore" },
      observedRelations: [],
      recordedBytes: 10,
      observerEffectUs: 1,
      mainThreadBlockUs: 1,
      overheadRatio: 0.001,
    });

    const pinned = capture.pin({
      captureWindowId: asCaptureWindowId("capture:restore-envelope"),
      requestedRange: {
        schemaVersion: 1,
        from: clock(0, 0, 0),
        through: clock(600, 10_000_000, 600),
      },
      frozenBy: "manual_pin",
      pinnedAt: createdAt,
    });
    expect(pinned.code).toBe("pinned");
    expect(pinned.window.realizedRange).toEqual({
      schemaVersion: 1,
      from: clock(0, 0, 0),
      through: clock(600, 10_000_000, 600),
    });

    for (let tick = 1; tick <= 601; tick += 1) {
      capture.append({
        channel: "input",
        kind: "input",
        clock: clock(tick, tick * 10_000, tick),
        payload: { phase: "new_epoch", tick },
        observedRelations: [],
        recordedBytes: 10,
        observerEffectUs: 1,
        mainThreadBlockUs: 1,
        overheadRatio: 0.001,
      });
    }
    expect(
      capture
        .records()
        .some((event) => event.payload["phase"] === "before_restore"),
    ).toBe(false);
    expect(capture.loss()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "overwritten" }),
      ]),
    );
  });

  it("caps pinned event materialization and reports the omitted prefix as explicit loss", () => {
    const capture = rollingCapture();
    for (
      let sequence = 0;
      sequence < VNEXT_MAX_PINNED_EVENTS + 105;
      sequence += 1
    ) {
      capture.append({
        channel: "input",
        kind: "input",
        clock: clock(1, 1_000, 1),
        payload: { sequence },
        observedRelations: [],
        recordedBytes: 10,
        observerEffectUs: 0,
        mainThreadBlockUs: 0,
        overheadRatio: 0,
      });
    }

    const pinned = capture.pin({
      captureWindowId: asCaptureWindowId("capture:bounded-output"),
      requestedRange: {
        schemaVersion: 1,
        from: clock(1, 1_000, 1),
        through: clock(1, 1_000, 1),
      },
      frozenBy: "manual_pin",
      pinnedAt: createdAt,
    });

    expect(pinned.code).toBe("pinned");
    expect(pinned.events).toHaveLength(VNEXT_MAX_PINNED_EVENTS);
    expect(pinned.window.status).toBe("partial");
    expect(pinned.window.loss).toEqual([
      expect.objectContaining({
        sequence: 0,
        channel: "input",
        kind: "unavailable",
        count: 105,
      }),
    ]);
  });
});

const checkpointManifest: VNextCheckpointManifestV1 = {
  schemaVersion: 1,
  taskId,
  checkpointId: asCheckpointId("checkpoint:window"),
  executionId,
  runtimeId,
  workspaceId,
  sourceId,
  buildId,
  adapterId,
  stateSchemaVersion: "fixture-state-v1",
  probeIds: [probeId],
  captureWindowId: asCaptureWindowId("capture:window"),
  capturedAt: clock(3, 50_000),
  consistencyModel: "frame_end_barrier",
  semanticBarrier: "fixture.frame_end",
  domains: [
    {
      schemaVersion: 1,
      domain: "fixture.window_open",
      classification: "captured",
      serializationRule: "boolean-v1",
      canonicalizationRule: "identity",
      stateHash: digest("a"),
      tolerance: null,
      restoreOrder: 0,
    },
    {
      schemaVersion: 1,
      domain: "engine.physics_internal",
      classification: "unsupported",
      reason: "not exposed by the snapshot adapter",
    },
  ],
  restoreDependencyOrder: ["fixture.window_open"],
  inFlightState: [],
  limitations: ["fixture-owned state only"],
  portability: "same_build_only",
  fidelity: "descriptive_only",
};

class RestorePort implements VNextCheckpointRestorePort {
  public restoreCalls = 0;

  public constructor(private readonly fail = false) {}

  public restoreCapturedDomain() {
    this.restoreCalls += 1;
    return this.fail
      ? {
          status: "rejected" as const,
          beforeHash: digest("b"),
          afterHash: null,
          message: "fixture rejected state",
        }
      : {
          status: "restored" as const,
          beforeHash: digest("b"),
          afterHash: digest("a"),
          message: null,
        };
  }

  public resetDomain(): ReturnType<VNextCheckpointRestorePort["resetDomain"]> {
    throw new Error("not used");
  }

  public validateRestore() {
    return [
      {
        schemaVersion: 1 as const,
        name: "fixture.self_check",
        status: this.fail ? ("fail" as const) : ("pass" as const),
        expectedHash: digest("a"),
        actualHash: this.fail ? digest("c") : digest("a"),
        message: this.fail ? "state differs" : null,
      },
    ];
  }
}

const restoreRequest = {
  taskId,
  restoreReceiptId: asRestoreReceiptId("restore:window"),
  targetRuntimeId: asRuntimeId("runtime:fork"),
  targetExecutionId: asExecutionId("execution:fork"),
  currentBuildId: buildId,
  currentAdapterId: adapterId,
  currentStateSchemaVersion: "fixture-state-v1",
};

describe("VNextCheckpointRestoreService", () => {
  it("restores declared captured state while preserving unsupported coverage", () => {
    const port = new RestorePort();
    const receipt = new VNextCheckpointRestoreService(port).restore(
      checkpointManifest,
      restoreRequest,
    );

    expect(receipt.status).toBe("restored");
    expect(receipt.equivalentForkEligible).toBe(false);
    expect(receipt.uncoveredDomains).toEqual(["engine.physics_internal"]);
    expect(receipt.domains).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: "fixture.window_open",
          status: "restored",
        }),
        expect.objectContaining({
          domain: "engine.physics_internal",
          status: "unsupported",
        }),
      ]),
    );
  });

  it("classifies domain restore failure without claiming restored equivalence", () => {
    const receipt = new VNextCheckpointRestoreService(
      new RestorePort(true),
    ).restore(checkpointManifest, restoreRequest);

    expect(receipt.status).toBe("partially_restored");
    expect(receipt.equivalence).toBe("unavailable");
    expect(receipt.fidelity).toBe("descriptive_only");
    expect(receipt.domains[0]?.status).toBe("rejected");
  });

  it("rejects cross-build restore before calling the runtime port", () => {
    const port = new RestorePort();
    const receipt = new VNextCheckpointRestoreService(port).restore(
      checkpointManifest,
      { ...restoreRequest, currentBuildId: asBuildId("build:candidate") },
    );

    expect(receipt.compatibility).toBe("build_mismatch");
    expect(receipt.status).toBe("rejected");
    expect(port.restoreCalls).toBe(0);
  });
});

const trace: VNextRuntimeTraceV1 = {
  schemaVersion: 1,
  taskId,
  traceId: asTraceId("trace:jump"),
  sourceExecutionId: executionId,
  sourceRuntimeId: runtimeId,
  sourceId,
  sourceBuildId: buildId,
  sourceAdapterId: adapterId,
  sourceProbeIds: [probeId],
  sourceCaptureWindowId: asCaptureWindowId("capture:window"),
  createdAt,
  events: [
    {
      schemaVersion: 1,
      sequence: 0,
      kind: "input_press",
      name: "jump",
      value: 1,
      inputPairId: "jump:1",
      requested: {
        schemaVersion: 1,
        clockDomain: "physics_tick",
        position: 0,
        phase: "physics_tick_start",
      },
      realized: null,
    },
    {
      schemaVersion: 1,
      sequence: 1,
      kind: "input_release",
      name: "jump",
      value: 0,
      inputPairId: "jump:1",
      requested: {
        schemaVersion: 1,
        clockDomain: "physics_tick",
        position: 1,
        phase: "physics_tick_start",
      },
      realized: null,
    },
  ],
};

class ReplayPort implements VNextTraceReplayPort {
  public apply(event: VNextRuntimeTraceV1["events"][number]) {
    const realizedClock = clock(event.sequence, event.sequence * 16_667);
    return {
      realized: {
        schemaVersion: 1 as const,
        clock: realizedClock,
        phase: "physics_tick_start" as const,
        quantized: false,
        mismatchReason: null,
      },
      observed: {
        subject: "player.jumping",
        value: event.sequence === 0 ? true : false,
      },
      knownSideEffects: [],
    };
  }
}

describe("VNextTraceReplayService", () => {
  it("preserves requested timing, records realized timing, and reports first-tick divergence", () => {
    const result = new VNextTraceReplayService(new ReplayPort()).replay(trace, {
      taskId,
      targetExecutionId: asExecutionId("execution:replay"),
      targetBuildId: buildId,
      fidelityBoundary: "registered fixture state",
      expected: [
        {
          traceSequence: 0,
          subject: "player.jumping",
          value: false,
        },
        {
          traceSequence: 1,
          subject: "player.jumping",
          value: false,
        },
      ],
    });

    expect(result.trace.events[0]?.requested.position).toBe(0);
    expect(result.trace.events[0]?.realized?.clock.physicsTick).toBe(0);
    expect(result.receipt.firstDivergence).toMatchObject({
      status: "observed",
      clock: { physicsTick: 0 },
      phase: "physics_tick_start",
      subject: "player.jumping",
      left: false,
      right: true,
    });
  });
});

const fullCoverage: VNextCaptureCoverageV1[] = [
  {
    schemaVersion: 1,
    channel: "state_summary",
    status: "full",
    availableRange: {
      schemaVersion: 1,
      from: clock(0, 0),
      through: clock(2, 33_334),
    },
    requestedSampleEvery: 1,
    realizedSampleEvery: 1,
    emittedRecords: 3,
    droppedRecords: 0,
    overwrittenRecords: 0,
    observerEffectUs: 5,
    limitations: [],
  },
];

const degradedCoverage: VNextCaptureCoverageV1[] = [
  {
    ...fullCoverage[0]!,
    status: "partial",
    droppedRecords: 1,
    limitations: ["one state record dropped"],
  },
];

const stateLoss: VNextCaptureLossV1[] = [
  {
    schemaVersion: 1,
    sequence: 0,
    channel: "state_summary",
    kind: "dropped",
    count: 1,
    firstClock: clock(1, 16_667),
    lastClock: clock(1, 16_667),
    reason: "capture budget",
  },
];

const rawEvent = (
  sequence: number,
  kind: VNextRawRuntimeEventV1["kind"],
  payload: VNextRawRuntimeEventV1["payload"],
  at = clock(sequence, sequence * 16_667),
): VNextRawRuntimeEventV1 => ({
  schemaVersion: 1,
  eventId: asEventId(`event:index:${sequence}`),
  taskId,
  executionId,
  runtimeId,
  buildId,
  sequence,
  channel:
    kind === "input" ? "input" : kind === "error" ? "error" : "state_summary",
  kind,
  clock: at,
  payload,
  observedRelations: [],
});

const indexRecords = [
  rawEvent(0, "entity_lifecycle", {
    entity: {
      stableId: "player",
      incarnation: 1,
      sceneId: "fixture.main",
      parentStableId: null,
      ownerStableId: null,
    },
    lifecycle: "spawned",
  }),
  rawEvent(1, "input", { action: "jump", pressed: true }),
  rawEvent(2, "state", {
    entity: {
      stableId: "player",
      incarnation: 1,
      sceneId: "fixture.main",
      parentStableId: null,
      ownerStableId: null,
    },
    statePath: "player.jumping",
    value: true,
  }),
];

describe("VNextRuntimeStateIndex", () => {
  it("marks a paginated projection incomplete even with full capture coverage", () => {
    const index = VNextRuntimeStateIndex.rebuild({
      taskId,
      indexId: asRuntimeStateIndexId("index:paginated"),
      executionId,
      runtimeId,
      sourceId,
      buildId,
      adapterId,
      probeIds: [probeId],
      captureWindowIds: [],
      rawRecordHash: digest("e"),
      records: indexRecords,
      coverage: fullCoverage,
      loss: [],
    });

    const first = index.query({
      schemaVersion: 1,
      taskId,
      executionId,
      entityIds: [],
      eventKinds: [],
      statePaths: [],
      clockRange: null,
      limit: 1,
      cursor: null,
    });
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).toBe("1");
    expect(first.incomplete).toBe(true);

    const last = index.query({
      ...first.query,
      limit: 10,
      cursor: first.nextCursor,
    });
    expect(last.rows).toHaveLength(2);
    expect(last.nextCursor).toBeNull();
    expect(last.incomplete).toBe(false);
  });

  it("rebuilds queryable entity/clock/input/state rows with raw provenance and loss", () => {
    const index = VNextRuntimeStateIndex.rebuild({
      taskId,
      indexId: asRuntimeStateIndexId("index:baseline"),
      executionId,
      runtimeId,
      sourceId,
      buildId,
      adapterId,
      probeIds: [probeId],
      captureWindowIds: [asCaptureWindowId("capture:window")],
      rawRecordHash: digest("d"),
      records: indexRecords,
      coverage: degradedCoverage,
      loss: stateLoss,
    });

    const state = index.query({
      schemaVersion: 1,
      taskId,
      executionId,
      entityIds: ["player"],
      eventKinds: ["state"],
      statePaths: ["player.jumping"],
      clockRange: null,
      limit: 100,
      cursor: null,
    });
    const input = index.query({
      schemaVersion: 1,
      taskId,
      executionId,
      entityIds: [],
      eventKinds: ["input"],
      statePaths: [],
      clockRange: {
        schemaVersion: 1,
        from: clock(1, 16_667),
        through: clock(1, 16_667),
      },
      limit: 100,
      cursor: null,
    });

    expect(state.rows).toEqual([
      expect.objectContaining({
        rawEventId: asEventId("event:index:2"),
        rawSequence: 2,
        kind: "state",
        statePath: "player.jumping",
        value: true,
      }),
    ]);
    expect(state.incomplete).toBe(true);
    expect(state.loss).toEqual(stateLoss);
    expect(input.rows[0]?.kind).toBe("input");
    expect(input.rows[0]?.clock.physicsTick).toBe(1);
  });
});

const comparisonRef = (
  side: "left" | "right",
): VNextComparisonExecutionRefV1 => ({
  schemaVersion: 1,
  executionId: asExecutionId(`execution:${side}`),
  runtimeId: asRuntimeId(`runtime:${side}`),
  sourceId: asSourceId(`source:${side}`),
  buildId: asBuildId(`build:${side}`),
  adapterId,
  probeIds: [probeId],
  traceId: asTraceId(`trace:${side}`),
  checkpointId: null,
  captureWindowIds: [asCaptureWindowId(`capture:${side}`)],
  executionRecordHash: digest(side === "left" ? "a" : "b"),
  rawRecordHash: digest(side === "left" ? "c" : "d"),
  captureCoverageHash: digest(side === "left" ? "1" : "2"),
  checkpointFidelity: "not_applicable",
});

const comparisonControls: VNextRuntimeControlReceiptV1 = {
  schemaVersion: 1,
  requested: {
    schemaVersion: 1,
    fixedFps: 120,
    physicsTicksPerSecond: 60,
    timeScale: 1,
    paused: false,
    headless: true,
  },
  realized: {
    schemaVersion: 1,
    fixedFps: 120,
    physicsTicksPerSecond: 60,
    timeScale: 1,
    paused: false,
    headless: true,
  },
  mismatches: [],
  knownSideEffects: [],
};

const queryResult = (
  side: "left" | "right",
  rows: VNextRuntimeStateQueryResultV1["rows"],
): VNextRuntimeStateQueryResultV1 => ({
  schemaVersion: 1,
  taskId,
  indexId: asRuntimeStateIndexId(`index:${side}`),
  executionId: asExecutionId(`execution:${side}`),
  runtimeId: asRuntimeId(`runtime:${side}`),
  sourceId: asSourceId(`source:${side}`),
  buildId: asBuildId(`build:${side}`),
  adapterId,
  probeIds: [probeId],
  captureWindowIds: [asCaptureWindowId(`capture:${side}`)],
  rawRecordHash: digest(side === "left" ? "3" : "4"),
  query: {
    schemaVersion: 1,
    taskId,
    executionId: asExecutionId(`execution:${side}`),
    entityIds: [],
    eventKinds: [],
    statePaths: [],
    clockRange: null,
    limit: 100,
    cursor: null,
  },
  rows,
  coverage: side === "left" ? fullCoverage : degradedCoverage,
  loss: side === "left" ? [] : stateLoss,
  incomplete: side === "right",
  nextCursor: null,
});

const entityRow = (
  rawSequence: number,
  stableId: string,
  incarnation: number,
  value: boolean,
): VNextRuntimeStateQueryResultV1["rows"][number] => ({
  schemaVersion: 1,
  rawEventId: asEventId(`event:compare:${stableId}:${incarnation}`),
  rawSequence,
  clock: clock(rawSequence, rawSequence * 16_667),
  kind: "state",
  entity: {
    schemaVersion: 1,
    stableId,
    incarnation,
    sceneId: "fixture.main",
    parentStableId: null,
    ownerStableId: null,
  },
  statePath: `${stableId}.active`,
  value,
  observedRelations: [],
  checkpointId: null,
});

describe("VNextDescriptiveComparisonService", () => {
  it("reports matches, unmatched/ambiguous entities, observable differences, and confounders only", () => {
    const left = queryResult("left", [
      entityRow(0, "player", 1, false),
      entityRow(1, "enemy", 1, true),
      entityRow(2, "ghost", 1, true),
      entityRow(3, "ghost", 2, false),
    ]);
    const right = queryResult("right", [
      entityRow(0, "player", 1, true),
      entityRow(1, "npc", 1, true),
      entityRow(2, "ghost", 1, true),
      entityRow(3, "ghost", 2, false),
    ]);

    const comparison = new VNextDescriptiveComparisonService().compare({
      taskId,
      comparisonId: asComparisonId("comparison:left-right"),
      leftRef: comparisonRef("left"),
      rightRef: comparisonRef("right"),
      leftControls: comparisonControls,
      rightControls: comparisonControls,
      left,
      right,
      firstDivergencePhase: "process_frame_end",
      createdAt,
    });

    expect(comparison.mode).toBe("confounded");
    expect(comparison.alignment.matchedEntities).toContain("player#1");
    expect(comparison.alignment.unmatchedLeftEntities).toContain("enemy#1");
    expect(comparison.alignment.unmatchedRightEntities).toContain("npc#1");
    expect(comparison.alignment.ambiguousEntities).toContain("ghost");
    expect(comparison.confounders.map((item) => item.category)).toEqual(
      expect.arrayContaining(["build", "coverage", "trace"]),
    );
    expect(comparison.differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "state",
          subject: "player.active",
          left: false,
          right: true,
        }),
      ]),
    );
    expect(comparison.firstDivergence?.status).toBe("observed");
    expect("verdict" in comparison).toBe(false);
    expect("cause" in comparison).toBe(false);
    expect(() =>
      VNextComparisonV1Schema.parse({ ...comparison, verdict: "fixed" }),
    ).toThrow();
  });

  it("marks alignment and first divergence unavailable when both projections omit coverage", () => {
    const leftRef = comparisonRef("left");
    const rightRef: VNextComparisonExecutionRefV1 = {
      ...comparisonRef("right"),
      sourceId: leftRef.sourceId,
      buildId: leftRef.buildId,
      traceId: leftRef.traceId,
      captureCoverageHash: leftRef.captureCoverageHash,
    };
    const left: VNextRuntimeStateQueryResultV1 = {
      ...queryResult("left", []),
      sourceId: leftRef.sourceId,
      buildId: leftRef.buildId,
      coverage: [],
      loss: [],
      incomplete: false,
    };
    const right: VNextRuntimeStateQueryResultV1 = {
      ...queryResult("right", []),
      sourceId: rightRef.sourceId,
      buildId: rightRef.buildId,
      coverage: [],
      loss: [],
      incomplete: false,
    };

    const comparison = new VNextDescriptiveComparisonService().compare({
      taskId,
      comparisonId: asComparisonId("comparison:missing-coverage"),
      leftRef,
      rightRef,
      leftControls: comparisonControls,
      rightControls: comparisonControls,
      left,
      right,
      createdAt,
    });

    expect(comparison.mode).toBe("confounded");
    expect(comparison.alignment.status).toBe("unavailable");
    expect(
      comparison.alignment.limitations.some((limitation) =>
        /coverage is unavailable/iu.test(limitation),
      ),
    ).toBe(true);
    expect(comparison.confounders).toHaveLength(1);
    expect(comparison.confounders[0]?.category).toBe("coverage");
    expect(comparison.confounders[0]?.description).toMatch(/unavailable/iu);
    expect(comparison.firstDivergence.status).toBe("unavailable");
    expect(
      comparison.firstDivergence.status === "unavailable"
        ? comparison.firstDivergence.reason
        : "",
    ).toMatch(/coverage is unavailable/iu);
  });

  it("keeps alignment and first divergence uncertain when both projections have the same partial coverage", () => {
    const leftRef = comparisonRef("left");
    const rightRef: VNextComparisonExecutionRefV1 = {
      ...comparisonRef("right"),
      sourceId: leftRef.sourceId,
      buildId: leftRef.buildId,
      traceId: leftRef.traceId,
      captureCoverageHash: leftRef.captureCoverageHash,
    };
    const left: VNextRuntimeStateQueryResultV1 = {
      ...queryResult("left", []),
      sourceId: leftRef.sourceId,
      buildId: leftRef.buildId,
      coverage: degradedCoverage,
      loss: stateLoss,
      incomplete: true,
    };
    const right: VNextRuntimeStateQueryResultV1 = {
      ...queryResult("right", []),
      sourceId: rightRef.sourceId,
      buildId: rightRef.buildId,
      coverage: degradedCoverage,
      loss: stateLoss,
      incomplete: true,
    };

    const comparison = new VNextDescriptiveComparisonService().compare({
      taskId,
      comparisonId: asComparisonId("comparison:partial-coverage"),
      leftRef,
      rightRef,
      leftControls: comparisonControls,
      rightControls: comparisonControls,
      left,
      right,
      createdAt,
    });

    expect(comparison.mode).toBe("confounded");
    expect(comparison.alignment.status).toBe("partial");
    expect(comparison.confounders).toHaveLength(1);
    expect(comparison.confounders[0]?.category).toBe("coverage");
    expect(comparison.confounders[0]?.description).toMatch(/incomplete/iu);
    expect(comparison.firstDivergence.status).toBe("unavailable");
    expect(
      comparison.firstDivergence.status === "unavailable"
        ? comparison.firstDivergence.reason
        : "",
    ).toMatch(/incomplete coverage/iu);
  });

  it("keeps clock alignment partial when cross-execution uncertainty is unknown", () => {
    const leftRef = comparisonRef("left");
    const rightRef: VNextComparisonExecutionRefV1 = {
      ...comparisonRef("right"),
      sourceId: leftRef.sourceId,
      buildId: leftRef.buildId,
      traceId: leftRef.traceId,
      captureCoverageHash: leftRef.captureCoverageHash,
    };
    const left: VNextRuntimeStateQueryResultV1 = {
      ...queryResult("left", []),
      sourceId: leftRef.sourceId,
      buildId: leftRef.buildId,
      coverage: fullCoverage,
      loss: [],
      incomplete: false,
    };
    const right: VNextRuntimeStateQueryResultV1 = {
      ...queryResult("right", []),
      sourceId: rightRef.sourceId,
      buildId: rightRef.buildId,
      coverage: fullCoverage,
      loss: [],
      incomplete: false,
    };

    const comparison = new VNextDescriptiveComparisonService().compare({
      taskId,
      comparisonId: asComparisonId("comparison:complete-coverage"),
      leftRef,
      rightRef,
      leftControls: comparisonControls,
      rightControls: comparisonControls,
      left,
      right,
      createdAt,
    });

    expect(comparison.mode).toBe("descriptive_only");
    expect(comparison.alignment.status).toBe("partial");
    expect(comparison.alignment.clockUncertaintyUs).toBeNull();
    expect(comparison.alignment.limitations).toContain(
      "cross-execution clock uncertainty is not measured",
    );
    expect(comparison.confounders).toEqual([]);
    expect(comparison.firstDivergence?.status).toBe("none_observed");
  });

  it("confounds realized runtime controls and distinct checkpoint identities", () => {
    const leftRef: VNextComparisonExecutionRefV1 = {
      ...comparisonRef("left"),
      sourceId,
      buildId,
      traceId: null,
      checkpointId: asCheckpointId("checkpoint:left"),
      checkpointFidelity: "descriptive_only",
      captureCoverageHash: digest("7"),
    };
    const rightRef: VNextComparisonExecutionRefV1 = {
      ...comparisonRef("right"),
      sourceId,
      buildId,
      traceId: null,
      checkpointId: asCheckpointId("checkpoint:right"),
      checkpointFidelity: "descriptive_only",
      captureCoverageHash: digest("7"),
    };
    const left = {
      ...queryResult("left", []),
      sourceId,
      buildId,
      coverage: fullCoverage,
      loss: [],
      incomplete: false,
    };
    const right = {
      ...queryResult("right", []),
      sourceId,
      buildId,
      coverage: fullCoverage,
      loss: [],
      incomplete: false,
    };
    const comparison = new VNextDescriptiveComparisonService().compare({
      taskId,
      comparisonId: asComparisonId("comparison:runtime-controls"),
      leftRef,
      rightRef,
      leftControls: comparisonControls,
      rightControls: {
        ...comparisonControls,
        requested: {
          ...comparisonControls.requested,
          fixedFps: 60,
        },
        realized: {
          ...comparisonControls.realized,
          fixedFps: 60,
        },
      },
      left,
      right,
      createdAt,
    });

    expect(comparison.mode).toBe("confounded");
    expect(comparison.confounders.map((item) => item.category)).toEqual(
      expect.arrayContaining(["runtime", "checkpoint_fidelity"]),
    );
  });
});
