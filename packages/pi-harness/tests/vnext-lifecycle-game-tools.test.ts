import { LIFECYCLE_GAME_TOOL_NAMES_V1 } from "@chronorift/agent-protocol";
import { describe, expect, it } from "vitest";

import {
  createVNextLifecycleGameToolDefinitions,
  type VNextGameToolResponseV1,
  type VNextLifecycleGameToolPort,
  type VNextLifecycleGameToolPortRequestV1,
} from "../src/index.js";

const runtime = {
  schemaVersion: 2,
  taskId: "task:v1:test",
  runtimeId: "runtime:v1:test",
  executionId: "execution:v1:test",
  buildId: "build:v1:test",
  status: "running",
  engine: {
    version: "4.7.1",
    build: "official",
    platform: "Linux",
    renderer: "gl_compatibility",
    audioDriver: "Dummy",
    headless: true,
  },
  configuredScene: "res://main.tscn",
  currentScene: "res://main.tscn",
  clocks: {
    processFrame: 130,
    physicsTick: 125,
    simulationTimeUs: 2_000_000,
    hostMonotonicUs: 3_000_000,
    renderFrame: null,
    processFrameDelta: 120,
    physicsTickDelta: 120,
  },
  coverage: [],
  loss: [],
  diagnostics: {
    stdoutTotalBytes: 0,
    stdoutRetainedBytes: 0,
    stdoutTruncated: false,
    stderrTotalBytes: 0,
    stderrRetainedBytes: 0,
    stderrTruncated: false,
  },
  startedAt: "2026-08-10T00:00:00.000Z",
  endedAt: null,
} as const;

class MemoryLifecyclePort implements VNextLifecycleGameToolPort {
  public readonly requests: VNextLifecycleGameToolPortRequestV1[] = [];

  public invoke(
    request: VNextLifecycleGameToolPortRequestV1,
  ): Promise<VNextGameToolResponseV1> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({
      schemaVersion: 1,
      toolCallId: request.toolCallId,
      outcome: "success",
      output: { schemaVersion: 2, runtime },
    });
  }
}

describe("vNext Pi lifecycle game-tool binding", () => {
  it("registers only the additive four-tool catalog", () => {
    const tools = createVNextLifecycleGameToolDefinitions(
      new MemoryLifecyclePort(),
    );
    expect(tools.map((tool) => tool.name)).toEqual(
      LIFECYCLE_GAME_TOOL_NAMES_V1,
    );
    expect(tools).toHaveLength(4);
  });

  it("validates schemaVersion 2 input and output", async () => {
    const port = new MemoryLifecyclePort();
    const tool = createVNextLifecycleGameToolDefinitions(port).find(
      (candidate) => candidate.name === "game_status",
    );
    if (tool === undefined) throw new Error("missing lifecycle status tool");

    const result = await tool.execute(
      "call-lifecycle-status",
      {
        schemaVersion: 2,
        taskId: "task:v1:test",
        runtimeId: "runtime:v1:test",
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.requests).toHaveLength(1);
    expect(result.details).toMatchObject({ outcome: "success" });

    await expect(
      tool.execute(
        "call-invalid",
        {
          schemaVersion: 1,
          taskId: "task:v1:test",
          runtimeId: "runtime:v1:test",
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/Invalid input/iu);
  });
});
