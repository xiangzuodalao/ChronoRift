import { describe, expect, it } from "vitest";

import {
  VNextBranchLineageV1Schema,
  VNextBuildV1Schema,
  VNextCapturePolicyV1Schema,
  VNextCaptureProfileV1Schema,
  VNextCaptureWindowV1Schema,
  VNextCheckpointManifestV1Schema,
  VNextComparisonV1Schema,
  VNextExecutionRecordV1Schema,
  VNextRawRuntimeEventV1Schema,
  VNextRestoreReceiptV1Schema,
  VNextRuntimeStateQueryResultV1Schema,
  VNextRuntimeTraceV1Schema,
  VNextRuntimeV1Schema,
  VNextTraceReplayReceiptV1Schema,
} from "../src/index.js";

const digest = (value: string): string => value.repeat(64);
const createdAt = "2026-08-07T00:00:00.000Z";

const clocks = {
  schemaVersion: 1,
  processFrame: 5,
  physicsTick: 3,
  simulationTimeUs: 50_000,
  hostMonotonicUs: 900_000,
  renderFrame: null,
} as const;

const coverage = {
  schemaVersion: 1,
  channel: "state_summary",
  status: "sampled",
  availableRange: { schemaVersion: 1, from: clocks, through: clocks },
  requestedSampleEvery: 1,
  realizedSampleEvery: 2,
  emittedRecords: 3,
  droppedRecords: 1,
  overwrittenRecords: 0,
  observerEffectUs: 40,
  limitations: ["budget degradation"],
} as const;

const loss = {
  schemaVersion: 1,
  sequence: 0,
  channel: "state_summary",
  kind: "degraded",
  count: 1,
  firstClock: clocks,
  lastClock: clocks,
  reason: "memory budget",
} as const;

const build = {
  schemaVersion: 1,
  taskId: "task:m3",
  workspaceId: "workspace:m3",
  sourceId: "source:baseline",
  buildId: "build:baseline",
  sourceHash: digest("a"),
  workspaceDiffHash: digest("b"),
  buildConfigurationHash: digest("c"),
  outputHash: digest("d"),
  createdAt,
} as const;

const runtime = {
  schemaVersion: 1,
  taskId: "task:m3",
  runtimeId: "runtime:baseline",
  buildId: "build:baseline",
  sourceId: "source:baseline",
  adapter: {
    schemaVersion: 1,
    adapterId: "adapter:fixture",
    contentHash: digest("e"),
    protocolVersion: "fixture-v1",
  },
  probes: [
    {
      schemaVersion: 1,
      probeId: "probe:fixture",
      contentHash: digest("f"),
      channels: ["input", "state_summary"],
    },
  ],
  capabilities: ["capture.rolling", "checkpoint.fixture"],
  status: "running",
  startedAt: createdAt,
} as const;

const controlReceipt = {
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
    fixedFps: 119,
    physicsTicksPerSecond: 60,
    timeScale: 1,
    paused: false,
    headless: true,
  },
  mismatches: [
    {
      schemaVersion: 1,
      control: "fixed_fps",
      requested: 120,
      realized: 119,
      reason: "runtime quantization",
    },
  ],
  knownSideEffects: ["fixed pacing changes process scheduling"],
} as const;

const capturePolicy = {
  schemaVersion: 1,
  requestedRetentionUs: 10_000_000,
  requestedRetentionTicks: 600,
  memoryBudgetBytes: 268_435_456,
  diskBudgetBytes: 1_073_741_824,
  maxAverageOverheadRatio: 0.05,
  maxMainThreadBlockUs: 2_000,
  channels: [
    {
      schemaVersion: 1,
      channel: "state_summary",
      priority: "low",
      sampleEvery: 1,
    },
  ],
} as const;

const captureProfile = {
  schemaVersion: 1,
  requested: capturePolicy,
  realizedRetentionUs: 9_000_000,
  realizedRetentionTicks: 540,
  peakMemoryBytes: 1_024,
  writtenBytes: 2_048,
  averageOverheadRatio: 0.01,
  maxMainThreadBlockUs: 100,
  budgetStatus: "degraded",
  degradationReasons: ["state summaries sampled every two frames"],
  gameplayPausedForCapture: false,
} as const;

const executionManifest = {
  schemaVersion: 1,
  taskId: "task:m3",
  executionId: "execution:baseline",
  runtimeId: "runtime:baseline",
  workspaceId: "workspace:m3",
  sourceId: "source:baseline",
  buildId: "build:baseline",
  adapterId: "adapter:fixture",
  stateSchemaVersion: "fixture-state-v1",
  probeIds: ["probe:fixture"],
  traceId: "trace:baseline",
  startCheckpointId: null,
  branchId: null,
  launchTarget: "fixture.main",
  launchParameters: {},
  controls: controlReceipt,
  clockDomains: [
    "process_frame",
    "physics_tick",
    "simulation_time",
    "host_monotonic",
  ],
  capturePolicy,
  startedAt: createdAt,
} as const;

const rawEvent = {
  schemaVersion: 1,
  eventId: "event:0",
  taskId: "task:m3",
  executionId: "execution:baseline",
  runtimeId: "runtime:baseline",
  buildId: "build:baseline",
  sequence: 0,
  channel: "input",
  kind: "input",
  clock: clocks,
  payload: { action: "jump", pressed: true },
  observedRelations: [],
} as const;

describe("vNext runtime resources", () => {
  it("strictly validates task-owned build and runtime identities", () => {
    expect(VNextBuildV1Schema.parse(build)).toEqual(build);
    expect(VNextRuntimeV1Schema.parse(runtime)).toEqual(runtime);

    expect(() =>
      VNextBuildV1Schema.parse({ ...build, hostPath: "/workspace" }),
    ).toThrow();
    expect(() =>
      VNextBuildV1Schema.parse({ ...build, buildId: "../escape" }),
    ).toThrow();
    for (const unsafe of ["/absolute", "task:two..dots", "back\\slash"]) {
      expect(() =>
        VNextRuntimeV1Schema.parse({ ...runtime, taskId: unsafe }),
      ).toThrow(/opaque|resource ID/u);
    }
    expect(() =>
      VNextRawRuntimeEventV1Schema.parse({
        ...rawEvent,
        eventId: "event:bad..id",
      }),
    ).toThrow(/opaque|resource ID/u);
    expect(() =>
      VNextRawRuntimeEventV1Schema.parse({
        ...rawEvent,
        executionId: "/execution",
      }),
    ).toThrow(/opaque|resource ID/u);
    expect(() =>
      VNextRuntimeV1Schema.parse({
        ...runtime,
        probes: [...runtime.probes, runtime.probes[0]],
      }),
    ).toThrow(/probe/u);
  });

  it("keeps requested and realized controls and clock domains distinct", () => {
    const parsed = VNextExecutionRecordV1Schema.parse({
      schemaVersion: 1,
      taskId: "task:m3",
      executionId: "execution:baseline",
      runtimeId: "runtime:baseline",
      buildId: "build:baseline",
      manifest: executionManifest,
      status: "running",
      sealed: false,
      captureProfile,
      events: [rawEvent],
      coverage: [coverage],
      loss: [loss],
    });

    expect(parsed.manifest.controls.realized.fixedFps).toBe(119);
    expect(parsed.events[0]?.clock.physicsTick).toBe(3);

    expect(() =>
      VNextExecutionRecordV1Schema.parse({
        ...parsed,
        taskId: "task:other",
      }),
    ).toThrow(/task/u);
    expect(() =>
      VNextExecutionRecordV1Schema.parse({
        ...parsed,
        coverage: [],
        loss: [],
      }),
    ).toThrow(/every requested capture channel/u);
  });

  it.each(["event:missing", "event:0"])(
    "rejects dangling or self raw-event relations to %s",
    (targetEventId) => {
      expect(() =>
        VNextExecutionRecordV1Schema.parse({
          schemaVersion: 1,
          taskId: "task:m3",
          executionId: "execution:baseline",
          runtimeId: "runtime:baseline",
          buildId: "build:baseline",
          manifest: executionManifest,
          status: "running",
          sealed: false,
          captureProfile,
          events: [
            {
              ...rawEvent,
              observedRelations: [
                {
                  schemaVersion: 1,
                  kind: "scheduled_by",
                  targetEventId,
                },
              ],
            },
          ],
          coverage: [coverage],
          loss: [loss],
        }),
      ).toThrow(/relation|target|self/iu);
    },
  );
});

describe("vNext rolling capture", () => {
  it("records realized budgets and protects replay-critical channels", () => {
    expect(VNextCaptureProfileV1Schema.parse(captureProfile).budgetStatus).toBe(
      "degraded",
    );
    expect(() =>
      VNextCaptureProfileV1Schema.parse({
        ...captureProfile,
        budgetStatus: "within_budget",
        degradationReasons: [],
      }),
    ).toThrow(/degraded/u);
    expect(() =>
      VNextCapturePolicyV1Schema.parse({
        ...capturePolicy,
        channels: [
          {
            schemaVersion: 1,
            channel: "input",
            priority: "low",
            sampleEvery: 1,
          },
        ],
      }),
    ).toThrow(/protected/u);
  });

  it("requires explicit loss records for sampled, dropped, or overwritten data", () => {
    const window = {
      schemaVersion: 1,
      taskId: "task:m3",
      captureWindowId: "capture:failure",
      executionId: "execution:baseline",
      runtimeId: "runtime:baseline",
      sourceId: "source:baseline",
      buildId: "build:baseline",
      adapterId: "adapter:fixture",
      probeIds: ["probe:fixture"],
      status: "partial",
      requestedRange: {
        schemaVersion: 1,
        from: clocks,
        through: clocks,
      },
      realizedRange: {
        schemaVersion: 1,
        from: clocks,
        through: clocks,
      },
      captureProfile,
      coverage: [coverage],
      loss: [loss],
      frozenBy: "manual_pin",
      pinnedAt: createdAt,
      firstVisibleAnomalyEventId: null,
    } as const;

    expect(VNextCaptureWindowV1Schema.parse(window).loss).toHaveLength(1);
    expect(() =>
      VNextCaptureWindowV1Schema.parse({ ...window, loss: [] }),
    ).toThrow(/loss/u);
    expect(() =>
      VNextCaptureWindowV1Schema.parse({
        ...window,
        status: "unavailable",
        realizedRange: window.realizedRange,
      }),
    ).toThrow(/realizedRange/u);
  });
});

const capturedDomain = {
  schemaVersion: 1,
  domain: "fixture.window_open",
  classification: "captured",
  serializationRule: "boolean-v1",
  canonicalizationRule: "identity",
  stateHash: digest("1"),
  tolerance: null,
  restoreOrder: 0,
} as const;

const checkpoint = {
  schemaVersion: 1,
  taskId: "task:m3",
  checkpointId: "checkpoint:window",
  executionId: "execution:baseline",
  runtimeId: "runtime:baseline",
  workspaceId: "workspace:m3",
  sourceId: "source:baseline",
  buildId: "build:baseline",
  adapterId: "adapter:fixture",
  stateSchemaVersion: "fixture-state-v1",
  probeIds: ["probe:fixture"],
  captureWindowId: "capture:failure",
  capturedAt: clocks,
  consistencyModel: "frame_end_barrier",
  semanticBarrier: "fixture.frame_end",
  domains: [
    capturedDomain,
    {
      schemaVersion: 1,
      domain: "engine.physics_internal",
      classification: "unsupported",
      reason: "no engine snapshot adapter",
    },
  ],
  restoreDependencyOrder: ["fixture.window_open"],
  inFlightState: ["deferred calls are not captured"],
  limitations: ["fixture-owned fields only"],
  portability: "same_build_only",
  fidelity: "descriptive_only",
} as const;

describe("vNext checkpoint and restore", () => {
  it("classifies every state domain without implying complete fidelity", () => {
    expect(VNextCheckpointManifestV1Schema.parse(checkpoint).domains).toEqual(
      checkpoint.domains,
    );
    expect(() =>
      VNextCheckpointManifestV1Schema.parse({
        ...checkpoint,
        fidelity: "equivalent_candidate",
      }),
    ).toThrow(/fidelity/u);
    expect(() =>
      VNextCheckpointManifestV1Schema.parse({
        ...checkpoint,
        checkpointId: "checkpoint:bad..id",
      }),
    ).toThrow(/opaque|resource ID/u);
  });

  it("distinguishes captured, reset, external, unsupported, and uncontrolled domains", () => {
    const domains = [
      capturedDomain,
      {
        schemaVersion: 1,
        domain: "fixture.transient_cache",
        classification: "reset",
        resetRule: "empty-on-restore",
        restoreOrder: 1,
      },
      {
        schemaVersion: 1,
        domain: "harness.input_queue",
        classification: "externally_controlled",
        controller: "trace replay",
        limitation: "only declared trace events are controlled",
      },
      {
        schemaVersion: 1,
        domain: "engine.physics_internal",
        classification: "unsupported",
        reason: "no engine snapshot adapter",
      },
      {
        schemaVersion: 1,
        domain: "platform.scheduler",
        classification: "uncontrolled",
        reason: "outside task runtime control",
      },
    ] as const;

    expect(
      VNextCheckpointManifestV1Schema.parse({
        ...checkpoint,
        domains,
        restoreDependencyOrder: [
          "fixture.window_open",
          "fixture.transient_cache",
        ],
      }).domains.map((domain) => domain.classification),
    ).toEqual([
      "captured",
      "reset",
      "externally_controlled",
      "unsupported",
      "uncontrolled",
    ]);
  });

  it("rejects cross-build restore as an equivalent or successful restore", () => {
    const rejection = {
      schemaVersion: 1,
      taskId: "task:m3",
      restoreReceiptId: "restore:cross-build",
      checkpointId: "checkpoint:window",
      checkpointBuildId: "build:baseline",
      currentBuildId: "build:candidate",
      checkpointAdapterId: "adapter:fixture",
      currentAdapterId: "adapter:fixture",
      checkpointStateSchemaVersion: "fixture-state-v1",
      currentStateSchemaVersion: "fixture-state-v1",
      targetRuntimeId: "runtime:candidate",
      targetExecutionId: "execution:candidate",
      compatibility: "build_mismatch",
      status: "rejected",
      equivalentForkEligible: false,
      equivalence: "unavailable",
      domains: [],
      uncoveredDomains: ["fixture.window_open"],
      fidelity: "descriptive_only",
      deterministicBoundary: "fresh runtime and trace replay required",
      validations: [],
      firstDivergence: null,
    } as const;

    expect(VNextRestoreReceiptV1Schema.parse(rejection).status).toBe(
      "rejected",
    );
    expect(
      VNextRestoreReceiptV1Schema.parse({
        ...rejection,
        currentBuildId: "build:baseline",
        currentAdapterId: "adapter:other",
        compatibility: "adapter_mismatch",
      }).compatibility,
    ).toBe("adapter_mismatch");
    expect(() =>
      VNextRestoreReceiptV1Schema.parse({
        ...rejection,
        status: "restored",
        equivalentForkEligible: true,
        equivalence: "registered_state_restored_but_equivalence_unestablished",
      }),
    ).toThrow(/build/u);
  });

  it("reports the first observed divergence without turning it into a verdict", () => {
    const parsed = VNextRestoreReceiptV1Schema.parse({
      schemaVersion: 1,
      taskId: "task:m3",
      restoreReceiptId: "restore:same-build",
      checkpointId: "checkpoint:window",
      checkpointBuildId: "build:baseline",
      currentBuildId: "build:baseline",
      checkpointAdapterId: "adapter:fixture",
      currentAdapterId: "adapter:fixture",
      checkpointStateSchemaVersion: "fixture-state-v1",
      currentStateSchemaVersion: "fixture-state-v1",
      targetRuntimeId: "runtime:fork",
      targetExecutionId: "execution:fork",
      compatibility: "same_build",
      status: "restored",
      equivalentForkEligible: false,
      equivalence: "registered_state_restored_but_equivalence_unestablished",
      domains: [
        {
          schemaVersion: 1,
          domain: "fixture.window_open",
          requested: true,
          status: "restored",
          beforeHash: digest("2"),
          afterHash: digest("1"),
          message: null,
        },
      ],
      uncoveredDomains: ["engine.physics_internal"],
      fidelity: "descriptive_only",
      deterministicBoundary: "registered fixture fields",
      validations: [
        {
          schemaVersion: 1,
          name: "fixture.self_check",
          status: "pass",
          expectedHash: digest("1"),
          actualHash: digest("1"),
          message: null,
        },
      ],
      firstDivergence: {
        schemaVersion: 1,
        status: "observed",
        clock: { ...clocks, physicsTick: 0 },
        phase: "physics_tick_start",
        differenceKind: "field",
        subject: "fixture.window_open",
        left: true,
        right: false,
        fidelityBoundary: "engine internals uncontrolled",
      },
    });

    expect(parsed.firstDivergence?.status).toBe("observed");
  });

  it("allows equivalent-fork eligibility only for a complete same-build registered-state restore", () => {
    expect(
      VNextRestoreReceiptV1Schema.parse({
        schemaVersion: 1,
        taskId: "task:m3",
        restoreReceiptId: "restore:eligible",
        checkpointId: "checkpoint:complete",
        checkpointBuildId: "build:baseline",
        currentBuildId: "build:baseline",
        checkpointAdapterId: "adapter:fixture",
        currentAdapterId: "adapter:fixture",
        checkpointStateSchemaVersion: "fixture-state-v1",
        currentStateSchemaVersion: "fixture-state-v1",
        targetRuntimeId: "runtime:fork",
        targetExecutionId: "execution:fork",
        compatibility: "same_build",
        status: "restored",
        equivalentForkEligible: true,
        equivalence: "registered_state_restored_but_equivalence_unestablished",
        domains: [
          {
            schemaVersion: 1,
            domain: "fixture.window_open",
            requested: true,
            status: "restored",
            beforeHash: digest("2"),
            afterHash: digest("1"),
            message: null,
          },
        ],
        uncoveredDomains: [],
        fidelity: "equivalent_candidate",
        deterministicBoundary: "registered fixture-owned state only",
        validations: [
          {
            schemaVersion: 1,
            name: "fixture.self_check",
            status: "pass",
            expectedHash: digest("1"),
            actualHash: digest("1"),
            message: null,
          },
        ],
        firstDivergence: null,
      }).equivalentForkEligible,
    ).toBe(true);
  });
});

describe("vNext trace and branch lineage", () => {
  it("preserves requested/realized input timing and all fork changes", () => {
    const trace = {
      schemaVersion: 1,
      taskId: "task:m3",
      traceId: "trace:baseline",
      sourceExecutionId: "execution:baseline",
      sourceRuntimeId: "runtime:baseline",
      sourceId: "source:baseline",
      sourceBuildId: "build:baseline",
      sourceAdapterId: "adapter:fixture",
      sourceProbeIds: ["probe:fixture"],
      sourceCaptureWindowId: "capture:failure",
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
            clockDomain: "process_frame",
            position: 4,
            phase: "process_frame_start",
          },
          realized: {
            schemaVersion: 1,
            clock: clocks,
            phase: "process_frame_start",
            quantized: false,
            mismatchReason: null,
          },
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
            clockDomain: "process_frame",
            position: 5,
            phase: "process_frame_start",
          },
          realized: {
            schemaVersion: 1,
            clock: { ...clocks, processFrame: 6 },
            phase: "process_frame_start",
            quantized: true,
            mismatchReason: "release was quantized to the next process frame",
          },
        },
      ],
    } as const;

    expect(VNextRuntimeTraceV1Schema.parse(trace).events).toHaveLength(2);
    expect(() =>
      VNextRuntimeTraceV1Schema.parse({
        ...trace,
        events: [{ ...trace.events[0], sequence: 1 }],
      }),
    ).toThrow(/sequence/u);

    expect(
      VNextBranchLineageV1Schema.parse({
        schemaVersion: 1,
        taskId: "task:m3",
        branchId: "branch:candidate",
        parent: {
          schemaVersion: 1,
          kind: "checkpoint",
          checkpointId: "checkpoint:window",
          buildId: "build:baseline",
        },
        childWorkspaceId: "workspace:candidate",
        childSourceId: "source:candidate",
        childBuildId: "build:candidate",
        childAdapterId: "adapter:fixture",
        childProbeIds: ["probe:fixture"],
        childCaptureWindowId: null,
        childTraceId: "trace:candidate",
        childExecutionId: null,
        requestedChanges: [
          {
            schemaVersion: 1,
            dimension: "input",
            requested: { physicsTick: 4 },
          },
        ],
        realizedChanges: [
          {
            schemaVersion: 1,
            dimension: "input",
            requested: { physicsTick: 4 },
            realized: { physicsTick: 5 },
            status: "partially_applied",
            knownSideEffects: ["input was quantized"],
          },
        ],
        createdAt,
      }).realizedChanges[0]?.status,
    ).toBe("partially_applied");
  });

  it("marks cross-build trace replay descriptive", () => {
    const receipt = {
      schemaVersion: 1,
      taskId: "task:m3",
      traceId: "trace:baseline",
      sourceExecutionId: "execution:baseline",
      targetExecutionId: "execution:candidate",
      sourceBuildId: "build:baseline",
      targetBuildId: "build:candidate",
      mode: "descriptive_only",
      status: "completed",
      applications: [],
      firstDivergence: {
        schemaVersion: 1,
        status: "unavailable",
        fidelityBoundary: "different build initialization",
        reason: "no common state projection",
      },
      limitations: ["cross-build replay"],
    } as const;

    expect(VNextTraceReplayReceiptV1Schema.parse(receipt).mode).toBe(
      "descriptive_only",
    );
    expect(() =>
      VNextTraceReplayReceiptV1Schema.parse({
        ...receipt,
        mode: "same_build_replay",
      }),
    ).toThrow(/cross-build/u);
  });
});

describe("vNext Runtime State Index and descriptive compare", () => {
  it("keeps query provenance, coverage, and loss attached to filtered rows", () => {
    const result = {
      schemaVersion: 1,
      taskId: "task:m3",
      indexId: "index:baseline",
      executionId: "execution:baseline",
      runtimeId: "runtime:baseline",
      sourceId: "source:baseline",
      buildId: "build:baseline",
      adapterId: "adapter:fixture",
      probeIds: ["probe:fixture"],
      captureWindowIds: ["capture:failure"],
      rawRecordHash: digest("9"),
      query: {
        schemaVersion: 1,
        taskId: "task:m3",
        executionId: "execution:baseline",
        entityIds: ["player"],
        eventKinds: ["state"],
        statePaths: ["player.window_open"],
        clockRange: null,
        limit: 100,
        cursor: null,
      },
      rows: [
        {
          schemaVersion: 1,
          rawEventId: "event:0",
          rawSequence: 0,
          clock: clocks,
          kind: "state",
          entity: {
            schemaVersion: 1,
            stableId: "player",
            incarnation: 1,
            sceneId: "fixture.main",
            parentStableId: null,
            ownerStableId: null,
          },
          statePath: "player.window_open",
          value: true,
          observedRelations: [],
          checkpointId: "checkpoint:window",
        },
      ],
      coverage: [coverage],
      loss: [loss],
      incomplete: true,
      nextCursor: null,
    } as const;

    expect(
      VNextRuntimeStateQueryResultV1Schema.parse(result).rows[0]?.rawEventId,
    ).toBe("event:0");
    expect(() =>
      VNextRuntimeStateQueryResultV1Schema.parse({
        ...result,
        query: { ...result.query, taskId: "task:other" },
      }),
    ).toThrow(/task/u);
    expect(() =>
      VNextRuntimeStateQueryResultV1Schema.parse({
        ...result,
        candidateCause: "input timing",
      }),
    ).toThrow();
  });

  it("requires identity mismatches to remain confounded and rejects verdict fields", () => {
    const comparison = {
      schemaVersion: 1,
      taskId: "task:m3",
      comparisonId: "comparison:baseline-candidate",
      mode: "confounded",
      left: {
        schemaVersion: 1,
        executionId: "execution:baseline",
        runtimeId: "runtime:baseline",
        sourceId: "source:baseline",
        buildId: "build:baseline",
        adapterId: "adapter:fixture",
        probeIds: ["probe:fixture"],
        traceId: "trace:baseline",
        checkpointId: "checkpoint:window",
        captureWindowIds: ["capture:failure"],
        executionRecordHash: digest("1"),
        rawRecordHash: digest("2"),
        captureCoverageHash: digest("3"),
        checkpointFidelity: "descriptive_only",
      },
      right: {
        schemaVersion: 1,
        executionId: "execution:candidate",
        runtimeId: "runtime:candidate",
        sourceId: "source:candidate",
        buildId: "build:candidate",
        adapterId: "adapter:fixture",
        probeIds: ["probe:fixture"],
        traceId: "trace:candidate",
        checkpointId: null,
        captureWindowIds: ["capture:candidate"],
        executionRecordHash: digest("1"),
        rawRecordHash: digest("2"),
        captureCoverageHash: digest("3"),
        checkpointFidelity: "not_applicable",
      },
      alignment: {
        schemaVersion: 1,
        status: "partial",
        clockUncertaintyUs: 100,
        matchedEntities: ["player"],
        unmatchedLeftEntities: [],
        unmatchedRightEntities: [],
        ambiguousEntities: [],
        limitations: ["different builds"],
      },
      confounders: [
        {
          schemaVersion: 1,
          category: "build",
          description: "candidate source was rebuilt",
          left: "build:baseline",
          right: "build:candidate",
        },
        {
          schemaVersion: 1,
          category: "checkpoint_fidelity",
          description: "candidate started fresh rather than from a checkpoint",
          left: "descriptive_only",
          right: "not_applicable",
        },
      ],
      differences: [
        {
          schemaVersion: 1,
          category: "state",
          subject: "player.jumping",
          left: false,
          right: true,
          observability: "full",
          clock: clocks,
          details: [],
        },
      ],
      firstDivergence: {
        schemaVersion: 1,
        status: "observed",
        clock: clocks,
        phase: "process_frame_start",
        differenceKind: "field",
        subject: "player.jumping",
        left: false,
        right: true,
        fidelityBoundary: "registered fixture fields",
      },
      limitations: ["descriptive comparison only"],
      createdAt,
    } as const;

    expect(VNextComparisonV1Schema.parse(comparison).mode).toBe("confounded");
    expect(() =>
      VNextComparisonV1Schema.parse({
        ...comparison,
        mode: "descriptive_only",
        confounders: [],
      }),
    ).toThrow(/build/u);
    expect(() =>
      VNextComparisonV1Schema.parse({
        ...comparison,
        verdict: "fixed",
      }),
    ).toThrow();
    expect(() =>
      VNextComparisonV1Schema.parse({
        ...comparison,
        right: { ...comparison.right, adapterId: "adapter:other" },
      }),
    ).toThrow(/adapter/u);
    expect(() =>
      VNextComparisonV1Schema.parse({
        ...comparison,
        alignment: {
          ...comparison.alignment,
          status: "aligned",
          clockUncertaintyUs: null,
        },
      }),
    ).toThrow(/clock|uncertainty/iu);
    expect(() =>
      VNextComparisonV1Schema.parse({
        ...comparison,
        left: {
          ...comparison.left,
          checkpointId: "checkpoint:left",
        },
        right: {
          ...comparison.left,
          executionId: "execution:candidate",
          runtimeId: "runtime:candidate",
          checkpointId: "checkpoint:right",
        },
        confounders: [],
      }),
    ).toThrow(/checkpoint/iu);
  });
});
