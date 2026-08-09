import {
  GAME_TOOL_DEFINITIONS_V1,
  GAME_TOOL_NAMES_V1,
} from "@chronorift/agent-protocol";
import { describe, expect, it } from "vitest";

import {
  createVNextGameToolDefinitions,
  type VNextGameToolPort,
  type VNextGameToolPortRequestV1,
  type VNextGameToolResponseV1,
} from "../src/index.js";

const success = (
  toolCallId: string,
  output: unknown = statusOutput(),
): VNextGameToolResponseV1 =>
  ({
    schemaVersion: 1,
    toolCallId,
    outcome: "success",
    output,
  }) as VNextGameToolResponseV1;

const runtimeFacts = {
  runtime: {
    schemaVersion: 1,
    taskId: "task:m3",
    runtimeId: "runtime:m3",
    buildId: "build:m3",
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
  runtimeId: "runtime:m3",
  executionId: "execution:m3",
  state: { values: {} },
  clocks: {
    schemaVersion: 1,
    processFrame: 0,
    physicsTick: 0,
    simulationTimeUs: 0,
    hostMonotonicUs: 0,
    renderFrame: null,
  },
  controls: {
    fixedFps: 120,
    physicsTicksPerSecond: 60,
    maxTicks: 10,
    stepsUsed: 0,
  },
  coverage: [],
  loss: [],
};

function statusOutput() {
  return { ...runtimeFacts };
}

const outputFor = (toolName: string): unknown => {
  switch (toolName) {
    case "game_capabilities":
      return {
        schemaVersion: 1,
        taskId: "task:m3",
        workspaceId: "workspace:m3",
        build: {},
        fixture: {},
        tools: [],
        costs: {},
        unsupported: [],
        runtime: null,
      };
    case "game_launch":
      return { ...runtimeFacts, build: {} };
    case "game_status":
      return statusOutput();
    case "game_stop":
      return { ...runtimeFacts, sealed: true };
    case "game_capture_configure":
      return {
        runtimeId: "runtime:m3",
        requested: {},
        realized: {},
        coverage: [],
        loss: [],
      };
    case "game_capture_pin":
      return { window: {}, events: [] };
    case "game_query":
      return { result: {} };
    case "game_input":
      return {
        runtimeId: "runtime:m3",
        requestId: "input-request:m3",
        action: "attempt_jump",
        requested: {},
        queued: true,
        realized: null,
      };
    case "game_step":
      return {
        runtimeId: "runtime:m3",
        executionId: "execution:m3",
        requested: {},
        realized: {},
        state: {},
        clocks: {},
        receipts: [],
        stepReceipts: [],
        pendingInputs: [],
        coverage: [],
        loss: [],
      };
    case "game_set_controls":
      return {
        runtimeId: "runtime:m3",
        requested: {},
        realized: {},
        mismatches: [],
        knownSideEffects: [],
      };
    case "game_checkpoint_create":
      return {
        manifest: {},
        state: {},
        participantStates: {},
        certificate: {},
      };
    case "game_checkpoint_restore":
      return { receipt: {}, state: {}, clocks: {} };
    case "game_fork":
      return {
        branch: {},
        runtimeId: "runtime:m3",
        executionId: "execution:m3",
        restore: null,
        replay: null,
        state: {},
        clocks: {},
      };
    case "game_trace_create":
      return {
        trace: {
          schemaVersion: 1,
          taskId: "task:m3",
          traceId: "trace:m3",
          sourceExecutionId: null,
          sourceRuntimeId: null,
          sourceId: "source:m3",
          sourceBuildId: "build:m3",
          sourceAdapterId: null,
          sourceProbeIds: [],
          sourceCaptureWindowId: null,
          createdAt: "2026-08-07T00:00:00.000Z",
          events: [],
        },
      };
    case "game_trace_replay":
      return { trace: {}, receipt: {} };
    case "game_compare":
      return { comparison: {} };
    default:
      throw new Error(`missing output sample for ${toolName}`);
  }
};

class MemoryGameToolPort implements VNextGameToolPort {
  public readonly requests: VNextGameToolPortRequestV1[] = [];
  public readonly signals: (AbortSignal | undefined)[] = [];
  public response: unknown;

  public invoke(
    request: VNextGameToolPortRequestV1,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.requests.push(structuredClone(request));
    this.signals.push(signal);
    return Promise.resolve(
      this.response ?? success(request.toolCallId, outputFor(request.toolName)),
    );
  }
}

const execute = async (
  port: MemoryGameToolPort,
  name: string,
  toolCallId: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => {
  const tool = createVNextGameToolDefinitions(port).find(
    (entry) => entry.name === name,
  );
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool.execute(toolCallId, input, signal, undefined, {} as never);
};

describe("vNext Pi game-tool binding", () => {
  it("registers all 16 atomic protocol tools without replacing metadata", () => {
    const tools = createVNextGameToolDefinitions(new MemoryGameToolPort());
    expect(tools.map((tool) => tool.name)).toEqual(
      Object.values(GAME_TOOL_NAMES_V1),
    );
    expect(tools).toHaveLength(16);
    for (const [index, tool] of tools.entries()) {
      expect(tool.label).toBe(GAME_TOOL_DEFINITIONS_V1[index]?.label);
      expect(tool.description).toBe(
        GAME_TOOL_DEFINITIONS_V1[index]?.description,
      );
      expect(tool.parameters).toBe(GAME_TOOL_DEFINITIONS_V1[index]?.parameters);
    }
  });

  it("forwards the actual Pi toolCallId, validated input, and AbortSignal", async () => {
    const port = new MemoryGameToolPort();
    const controller = new AbortController();
    const input = {
      schemaVersion: 1,
      taskId: "task:m3",
      runtimeId: "runtime:m3",
    };
    const result = await execute(
      port,
      "game_status",
      "call_pi_actual_42",
      input,
      controller.signal,
    );

    expect(port.requests).toEqual([
      {
        schemaVersion: 1,
        toolCallId: "call_pi_actual_42",
        toolName: "game_status",
        input,
      },
    ]);
    expect(port.signals).toEqual([controller.signal]);
    expect(result.details).toEqual(success("call_pi_actual_42"));
  });

  it("rejects malformed strict input without invoking the port", async () => {
    const port = new MemoryGameToolPort();
    await expect(
      execute(port, "game_status", "call_invalid", {
        schemaVersion: 1,
        taskId: "task:m3",
        runtimeId: "runtime:m3",
        unexpected: true,
      }),
    ).rejects.toThrow(/Invalid input for game_status/u);
    await expect(
      execute(port, "game_status", "", {
        schemaVersion: 1,
        taskId: "task:m3",
        runtimeId: "runtime:m3",
      }),
    ).rejects.toThrow(/toolCallId/u);
    expect(port.requests).toEqual([]);
  });

  it("validates success envelopes, JSON output, and call correlation", async () => {
    const port = new MemoryGameToolPort();
    port.response = {
      ...success("call_wrong"),
      toolCallId: "call_other",
    };
    await expect(
      execute(port, "game_capabilities", "call_wrong", {
        schemaVersion: 1,
        taskId: "task:m3",
      }),
    ).rejects.toThrow(/toolCallId/u);

    port.response = {
      ...success("call_extra"),
      extra: true,
    };
    await expect(
      execute(port, "game_capabilities", "call_extra", {
        schemaVersion: 1,
        taskId: "task:m3",
      }),
    ).rejects.toThrow(/Invalid response envelope/u);

    port.response = {
      schemaVersion: 1,
      toolCallId: "call_non_json",
      outcome: "success",
      output: undefined,
    };
    await expect(
      execute(port, "game_capabilities", "call_non_json", {
        schemaVersion: 1,
        taskId: "task:m3",
      }),
    ).rejects.toThrow(/response envelope|JSON output/u);
  });

  it("returns strict recoverable error envelopes to the Loop", async () => {
    const port = new MemoryGameToolPort();
    port.response = {
      schemaVersion: 1,
      toolCallId: "call_history",
      outcome: "error",
      error: {
        code: "history_window_unavailable",
        message: "The requested ticks have been overwritten.",
        recoverable: true,
        details: {
          coverage: "partial",
          lostBeforeTick: 17,
        },
      },
    };
    const result = await execute(port, "game_capture_pin", "call_history", {
      schemaVersion: 1,
      taskId: "task:m3",
      runtimeId: "runtime:m3",
      beforeTicks: 10,
      afterTicks: 0,
    });

    expect(result.details).toEqual(port.response);
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(port.response, null, 2),
      },
    ]);

    port.response = {
      schemaVersion: 1,
      toolCallId: "call_bad_error",
      outcome: "error",
      error: {
        code: "history_window_unavailable",
        message: "unavailable",
        recoverable: true,
        unexpected: true,
      },
    };
    await expect(
      execute(port, "game_capture_pin", "call_bad_error", {
        schemaVersion: 1,
        taskId: "task:m3",
        runtimeId: "runtime:m3",
        beforeTicks: 10,
        afterTicks: 0,
      }),
    ).rejects.toThrow(/Invalid response envelope/u);
  });

  it("does not impose a tool order or shared flow state", async () => {
    const port = new MemoryGameToolPort();
    await Promise.all([
      execute(port, "game_stop", "call_stop", {
        schemaVersion: 1,
        taskId: "task:m3",
        runtimeId: "runtime:m3",
      }),
      execute(port, "game_trace_create", "call_trace", {
        schemaVersion: 1,
        taskId: "task:m3",
        events: [],
      }),
    ]);
    expect(port.requests.map((request) => request.toolName)).toEqual(
      expect.arrayContaining(["game_stop", "game_trace_create"]),
    );
  });

  it("keeps tool descriptions free of workflow and judgment language", () => {
    const descriptions = createVNextGameToolDefinitions(
      new MemoryGameToolPort(),
    )
      .map((tool) => tool.description)
      .join("\n");
    expect(descriptions).not.toMatch(
      /call first|only after|exactly once|diagnos|caus|verdict|proposal|claim/i,
    );
  });
});
