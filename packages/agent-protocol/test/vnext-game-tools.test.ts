import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  GAME_TOOL_CAPABILITIES_V1,
  GAME_TOOL_DEFINITIONS_V1,
  GAME_TOOL_NAMES_V1,
  GAME_TOOL_OUTPUT_SCHEMAS_V1,
  GameCapabilitiesInputV1Schema,
  GameCaptureConfigureInputV1Schema,
  GameCapturePinInputV1Schema,
  GameCheckpointCreateInputV1Schema,
  GameCheckpointRestoreInputV1Schema,
  GameCompareInputV1Schema,
  GameForkInputV1Schema,
  GameInputInputV1Schema,
  GameLaunchInputV1Schema,
  GameQueryInputV1Schema,
  GameSetControlsInputV1Schema,
  GameStatusInputV1Schema,
  GameStepInputV1Schema,
  GameStopInputV1Schema,
  GameTraceCreateInputV1Schema,
  GameTraceReplayInputV1Schema,
  GameStatusOutputV1Schema,
} from "../src/index.js";

const taskId = "task:m3";
const runtimeId = "runtime:m3";
const buildId = "build:m3";
const executionId = "execution:m3";
const checkpointId = "checkpoint:m3";
const traceId = "trace:m3";

const requestedPoint = {
  clock: "process_frame",
  requestedTick: 9,
  requestedPhase: "process_frame_start",
} as const;

const validInputs = new Map<string, unknown>([
  ["game_capabilities", { schemaVersion: 1, taskId }],
  [
    "game_launch",
    {
      schemaVersion: 1,
      taskId,
      buildId,
      controls: {
        fixedFps: 120,
        physicsTicksPerSecond: 60,
        maxTicks: 10,
      },
    },
  ],
  ["game_status", { schemaVersion: 1, taskId, runtimeId }],
  ["game_stop", { schemaVersion: 1, taskId, runtimeId }],
  [
    "game_capture_configure",
    {
      schemaVersion: 1,
      taskId,
      runtimeId,
      historySeconds: 10,
      maxTicks: 600,
      channels: ["input", "clocks", "state", "runtime_error"],
      stateSampleEveryTicks: 1,
      triggers: [
        { kind: "runtime_event", event: "engine_error" },
        {
          kind: "state_equals",
          statePath: "player.jumping",
          value: true,
        },
      ],
    },
  ],
  [
    "game_capture_pin",
    {
      schemaVersion: 1,
      taskId,
      runtimeId,
      anchor: requestedPoint,
      beforeTicks: 10,
      afterTicks: 2,
    },
  ],
  [
    "game_query",
    {
      schemaVersion: 1,
      taskId,
      executionId,
      select: "events",
      filters: {
        entityIds: ["player"],
        eventTypes: ["input.requested", "state.changed"],
        statePaths: ["player.jumping"],
        tickRange: {
          clock: "process_frame",
          fromTick: 0,
          toTick: 10,
        },
      },
      limit: 100,
    },
  ],
  [
    "game_input",
    {
      schemaVersion: 1,
      taskId,
      runtimeId,
      action: "attempt_jump",
      requested: requestedPoint,
    },
  ],
  [
    "game_step",
    {
      schemaVersion: 1,
      taskId,
      runtimeId,
      clock: "process_frame",
      count: 1,
    },
  ],
  [
    "game_set_controls",
    {
      schemaVersion: 1,
      taskId,
      runtimeId,
      controls: { fixedFps: 60, physicsTicksPerSecond: 120 },
    },
  ],
  [
    "game_checkpoint_create",
    {
      schemaVersion: 1,
      taskId,
      runtimeId,
      barrier: "process_frame_end",
    },
  ],
  [
    "game_checkpoint_restore",
    { schemaVersion: 1, taskId, runtimeId, checkpointId },
  ],
  [
    "game_fork",
    {
      schemaVersion: 1,
      taskId,
      source: { kind: "checkpoint", checkpointId },
      changes: {
        traceId,
        controls: { fixedFps: 60, physicsTicksPerSecond: 120 },
      },
    },
  ],
  [
    "game_trace_create",
    {
      schemaVersion: 1,
      taskId,
      events: [
        {
          action: "attempt_jump",
          requested: requestedPoint,
        },
      ],
    },
  ],
  [
    "game_trace_replay",
    {
      schemaVersion: 1,
      taskId,
      runtimeId,
      traceId,
      maxTicks: 10,
    },
  ],
  [
    "game_compare",
    {
      schemaVersion: 1,
      taskId,
      baselineExecutionId: executionId,
      candidateExecutionId: "execution:candidate",
      maxDifferences: 100,
    },
  ],
]);

describe("vNext game tool catalog", () => {
  it("publishes the frozen resource-oriented atomic tool set", () => {
    expect(Object.values(GAME_TOOL_NAMES_V1)).toEqual([
      "game_capabilities",
      "game_launch",
      "game_status",
      "game_stop",
      "game_capture_configure",
      "game_capture_pin",
      "game_query",
      "game_input",
      "game_step",
      "game_set_controls",
      "game_checkpoint_create",
      "game_checkpoint_restore",
      "game_fork",
      "game_trace_create",
      "game_trace_replay",
      "game_compare",
    ]);
    expect(GAME_TOOL_DEFINITIONS_V1).toHaveLength(
      Object.values(GAME_TOOL_NAMES_V1).length,
    );
    expect(
      new Set(GAME_TOOL_DEFINITIONS_V1.map((tool) => tool.name)).size,
    ).toBe(GAME_TOOL_DEFINITIONS_V1.length);
    expect(
      new Set(GAME_TOOL_DEFINITIONS_V1.map((tool) => tool.capability)),
    ).toEqual(new Set(GAME_TOOL_CAPABILITIES_V1));
  });

  it("accepts one bounded frame-input-window request for every tool", () => {
    for (const tool of GAME_TOOL_DEFINITIONS_V1) {
      expect(
        Check(tool.parameters, validInputs.get(tool.name)),
        tool.name,
      ).toBe(true);
    }
  });

  it("requires schemaVersion 1 and rejects unknown input properties", () => {
    for (const tool of GAME_TOOL_DEFINITIONS_V1) {
      const input = validInputs.get(tool.name) as Record<string, unknown>;
      expect(Check(tool.parameters, { ...input, schemaVersion: 2 })).toBe(
        false,
      );
      expect(Check(tool.parameters, { ...input, unexpected: true })).toBe(
        false,
      );
    }
  });

  it("uses task resource IDs rather than paths or legacy handles", () => {
    expect(
      Check(GameCapabilitiesInputV1Schema, {
        schemaVersion: 1,
        taskId: "/tmp/task",
      }),
    ).toBe(false);
    expect(
      Check(GameStatusInputV1Schema, {
        schemaVersion: 1,
        taskId,
        runtimeId: "rh_runtime000",
      }),
    ).toBe(true);
    expect(
      Check(GameCheckpointRestoreInputV1Schema, {
        schemaVersion: 1,
        taskId,
        runtimeId,
        checkpointId: "../checkpoint.json",
      }),
    ).toBe(false);
    for (const unsafeId of [
      "/absolute",
      "path\\escape",
      "resource..escape",
      `resource:${"a".repeat(249)}`,
    ]) {
      expect(
        Check(GameStatusInputV1Schema, {
          schemaVersion: 1,
          taskId,
          runtimeId: unsafeId,
        }),
        unsafeId,
      ).toBe(false);
    }
    expect(
      Check(GameCapabilitiesInputV1Schema, {
        schemaVersion: 1,
        taskId: "custom_task_01",
      }),
    ).toBe(true);
  });

  it("bounds capture, query, stepping, and trace inputs", () => {
    const capture = validInputs.get("game_capture_configure") as Record<
      string,
      unknown
    >;
    expect(
      Check(GameCaptureConfigureInputV1Schema, {
        ...capture,
        maxTicks: 601,
      }),
    ).toBe(false);

    const query = validInputs.get("game_query") as Record<string, unknown>;
    expect(Check(GameQueryInputV1Schema, { ...query, limit: 201 })).toBe(false);
    expect(Check(GameQueryInputV1Schema, { ...query, cursor: "200" })).toBe(
      true,
    );
    for (const cursor of ["", "-1", "01", "1.5", "1000000"]) {
      expect(Check(GameQueryInputV1Schema, { ...query, cursor })).toBe(false);
    }

    expect(
      Check(GameStepInputV1Schema, {
        schemaVersion: 1,
        taskId,
        runtimeId,
        clock: "process_frame",
        count: 601,
      }),
    ).toBe(false);

    const trace = validInputs.get("game_trace_create") as Record<
      string,
      unknown
    >;
    expect(
      Check(GameTraceCreateInputV1Schema, {
        ...trace,
        events: Array.from({ length: 129 }, () => ({
          action: "attempt_jump",
          requested: requestedPoint,
        })),
      }),
    ).toBe(false);
  });

  it("limits the migrated fixture controls and action", () => {
    expect(
      Check(GameLaunchInputV1Schema, {
        schemaVersion: 1,
        taskId,
        buildId,
        controls: { fixedFps: 144, physicsTicksPerSecond: 60 },
      }),
    ).toBe(false);
    expect(
      Check(GameSetControlsInputV1Schema, {
        schemaVersion: 1,
        taskId,
        runtimeId,
        controls: { fixedFps: 60, physicsTicksPerSecond: 30 },
      }),
    ).toBe(false);
    expect(
      Check(GameInputInputV1Schema, {
        schemaVersion: 1,
        taskId,
        runtimeId,
        action: "always_jump",
        requested: requestedPoint,
      }),
    ).toBe(false);
  });

  it("keeps every nested request schema strict", () => {
    expect(
      Check(GameInputInputV1Schema, {
        ...(validInputs.get("game_input") as Record<string, unknown>),
        requested: { ...requestedPoint, extra: true },
      }),
    ).toBe(false);
    expect(
      Check(GameCapturePinInputV1Schema, {
        ...(validInputs.get("game_capture_pin") as Record<string, unknown>),
        anchor: { ...requestedPoint, extra: true },
      }),
    ).toBe(false);
    expect(
      Check(GameForkInputV1Schema, {
        ...(validInputs.get("game_fork") as Record<string, unknown>),
        source: { kind: "checkpoint", checkpointId, path: "/tmp/state" },
      }),
    ).toBe(false);
  });

  it("does not encode a workflow or product judgment in descriptions", () => {
    const descriptions = GAME_TOOL_DEFINITIONS_V1.map(
      (tool) => tool.description,
    ).join("\n");
    expect(descriptions).not.toMatch(
      /call first|only after|exactly once|must .* before|diagnos|caus|verdict|proposal|claim/i,
    );
  });

  it("exports each standalone input schema", () => {
    expect([
      GameCapabilitiesInputV1Schema,
      GameLaunchInputV1Schema,
      GameStatusInputV1Schema,
      GameStopInputV1Schema,
      GameCaptureConfigureInputV1Schema,
      GameCapturePinInputV1Schema,
      GameQueryInputV1Schema,
      GameInputInputV1Schema,
      GameStepInputV1Schema,
      GameSetControlsInputV1Schema,
      GameCheckpointCreateInputV1Schema,
      GameCheckpointRestoreInputV1Schema,
      GameForkInputV1Schema,
      GameTraceCreateInputV1Schema,
      GameTraceReplayInputV1Schema,
      GameCompareInputV1Schema,
    ]).toHaveLength(16);
  });

  it("publishes one strict bounded success schema for every tool", () => {
    expect(Object.keys(GAME_TOOL_OUTPUT_SCHEMAS_V1).sort()).toEqual(
      Object.values(GAME_TOOL_NAMES_V1).sort(),
    );
    for (const schema of Object.values(GAME_TOOL_OUTPUT_SCHEMAS_V1)) {
      expect(schema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
    const status = {
      runtime: {
        schemaVersion: 1,
        taskId,
        runtimeId,
        buildId,
        sourceId: "source:m3",
        adapter: {
          schemaVersion: 1,
          adapterId: "adapter:m3",
          contentHash: "a".repeat(64),
          protocolVersion: "2",
        },
        probes: [],
        capabilities: [],
        startedAt: "2026-08-07T00:00:00.000Z",
        status: "running",
      },
      runtimeId,
      executionId,
      state: { values: {} },
      clocks: {
        schemaVersion: 1,
        processFrame: 1,
        physicsTick: 0,
        simulationTimeUs: 8_333,
        hostMonotonicUs: 1,
        renderFrame: null,
      },
      controls: {
        fixedFps: 120,
        physicsTicksPerSecond: 60,
        maxTicks: 10,
        stepsUsed: 1,
      },
      coverage: [],
      loss: [],
    };
    expect(Check(GameStatusOutputV1Schema, status)).toBe(true);
    expect(
      Check(GameStatusOutputV1Schema, { ...status, unexpected: true }),
    ).toBe(false);
    expect(
      Check(GameStatusOutputV1Schema, {
        ...status,
        state: { value: "x".repeat(65_537) },
      }),
    ).toBe(false);
  });
});
