import { describe, expect, it, vi } from "vitest";

import {
  createInspectionGameToolDefinitions,
  createProjectEnvironmentToolCallAdmissionV1,
  ProjectEnvironmentToolCallBudgetExhaustedErrorV1,
} from "../src/index.js";

const launchOutput = {
  schemaVersion: 1,
  executionId: "run:one",
  sourceSha256: "a".repeat(64),
  mainScene: "res://world.tscn",
  engineVersion: "4.5.2",
  root: { objectRef: "run:one:object:1", className: "Node2D" },
};
const launchResponse = {
  schemaVersion: 1,
  outcome: "success",
  output: launchOutput,
};
const queryInput = {
  schemaVersion: 1,
  executionId: "run:one",
  select: "children",
};
const queryResponse = {
  schemaVersion: 1,
  outcome: "success",
  output: {
    schemaVersion: 1,
    executionId: "run:one",
    select: "children",
    sample: { processFrame: 12, physicsTick: 8 },
    hostReceivedAt: "2026-09-05T01:02:03.000Z",
    target: launchOutput.root,
    offset: 0,
    total: 0,
    items: [],
  },
};

describe("inspection Pi bridge", () => {
  it("preserves ordinary agent choice with four sequential tools and no forced workflow", () => {
    const tools = createInspectionGameToolDefinitions({
      invoke: () => Promise.resolve(launchResponse),
    });
    expect(tools.map(({ name }) => name)).toEqual([
      "game_launch",
      "game_query",
      "game_watch",
      "game_stop",
    ]);
    for (const tool of tools) {
      expect(tool.executionMode).toBe("sequential");
      expect(tool.promptGuidelines).toBeUndefined();
      expect(tool.promptSnippet).toBe(tool.description);
    }
  });

  it("normalizes input once, forwards cancellation, and retains the validated response", async () => {
    const invoke = vi.fn(() => Promise.resolve(queryResponse));
    const tool = createInspectionGameToolDefinitions({ invoke })[1];
    if (tool === undefined) throw new Error("Missing query tool");
    const signal = new AbortController().signal;
    const result = await tool.execute(
      "call:query",
      queryInput,
      signal,
      undefined,
      {} as never,
    );
    expect(invoke).toHaveBeenCalledWith(
      {
        schemaVersion: 1,
        toolCallId: "call:query",
        toolName: "game_query",
        input: { ...queryInput, target: { path: "." }, offset: 0, limit: 100 },
      },
      signal,
    );
    expect(result.details).toEqual(queryResponse);
  });

  it("rejects invalid input before the Host port", async () => {
    const invoke = vi.fn();
    const tool = createInspectionGameToolDefinitions({ invoke })[1];
    if (tool === undefined) throw new Error("Missing query tool");
    await expect(
      tool.execute(
        "call:query",
        { ...queryInput, cursor: "old" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    { ...launchResponse, output: { ...launchOutput, adapter: "legacy" } },
    launchResponse,
    {
      ...queryResponse,
      output: { ...queryResponse.output, executionId: "run:other" },
    },
    {
      ...queryResponse,
      output: { ...queryResponse.output, select: "properties" },
    },
  ])("rejects malformed or mismatched Host responses", async (response) => {
    const tool = createInspectionGameToolDefinitions({
      invoke: () => Promise.resolve(response),
    })[1];
    if (tool === undefined) throw new Error("Missing query tool");
    await expect(
      tool.execute("call:query", queryInput, undefined, undefined, {} as never),
    ).rejects.toThrow();
  });

  it("returns explicit Host errors without claiming an observation", async () => {
    const response = {
      schemaVersion: 1,
      outcome: "error",
      error: {
        code: "execution_exited",
        message: "The process exited before the query",
      },
    };
    const tool = createInspectionGameToolDefinitions({
      invoke: () => Promise.resolve(response),
    })[1];
    if (tool === undefined) throw new Error("Missing query tool");
    expect(
      (
        await tool.execute(
          "call:query",
          queryInput,
          undefined,
          undefined,
          {} as never,
        )
      ).details,
    ).toEqual(response);
  });

  it("shares the existing admission budget without calling the Host after exhaustion", async () => {
    const invoke = vi.fn(() => Promise.resolve(launchResponse));
    const tool = createInspectionGameToolDefinitions(
      { invoke },
      { toolCallAdmission: createProjectEnvironmentToolCallAdmissionV1(1) },
    )[0];
    if (tool === undefined) throw new Error("Missing launch tool");
    await tool.execute(
      "call:one",
      { schemaVersion: 1 },
      undefined,
      undefined,
      {} as never,
    );
    await expect(
      tool.execute(
        "call:two",
        { schemaVersion: 1 },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ProjectEnvironmentToolCallBudgetExhaustedErrorV1);
    expect(invoke).toHaveBeenCalledOnce();
  });
});

const watchInput = {
  schemaVersion: 1,
  executionId: "run:one",
  action: "read",
  watchId: "run:one:watch:1",
};
const watchResponse = {
  schemaVersion: 1,
  outcome: "success",
  output: {
    ...watchInput,
    phase: "physics_frame_signal_before_node_physics_process",
    status: "sampling",
    stopReason: null,
    sampleCount: 2,
    recordedCount: 0,
    boundTargets: [{ target: launchOutput.root, names: ["value"] }],
    records: [],
    nextSequence: 0,
    bytesUsed: 0,
    requiredByteBudget: null,
    deliveryComplete: true,
  },
};

it("normalizes watch pagination and forwards the existing cancellation signal", async () => {
  const invoke = vi.fn(() => Promise.resolve(watchResponse));
  const tool = createInspectionGameToolDefinitions({ invoke }).find(
    ({ name }) => name === "game_watch",
  )!;
  const signal = new AbortController().signal;
  expect(
    (
      await tool.execute(
        "call:watch",
        watchInput,
        signal,
        undefined,
        {} as never,
      )
    ).details,
  ).toEqual(watchResponse);
  expect(invoke).toHaveBeenCalledWith(
    {
      schemaVersion: 1,
      toolCallId: "call:watch",
      toolName: "game_watch",
      input: { ...watchInput, afterSequence: 0, byteBudget: 65_536 },
    },
    signal,
  );
});

it.each([
  { executionId: "run:other" },
  { watchId: "run:other:watch:1" },
  { action: "start" },
])("rejects mismatched watch responses %j", async (fields) => {
  const tool = createInspectionGameToolDefinitions({
    invoke: () =>
      Promise.resolve({
        ...watchResponse,
        output: { ...watchResponse.output, ...fields },
      }),
  }).find(({ name }) => name === "game_watch")!;
  await expect(
    tool.execute("call:watch", watchInput, undefined, undefined, {} as never),
  ).rejects.toThrow();
});
