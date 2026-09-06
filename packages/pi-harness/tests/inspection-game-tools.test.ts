import { describe, expect, it, vi } from "vitest";
import {
  InspectionToolResponseV1Schema,
  InspectionWatchReadOutputV1Schema,
  inspectionWatchRecordBytesV1,
} from "@chronorift/domain";
import type { Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
  convertToLlm,
  estimateTokens,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";

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

it.each(["game_watch", "game_stop"] as const)(
  "sends compact %s content through Pi's actual provider and compaction serializers while retaining canonical details",
  async (toolName) => {
    const records = [
      {
        sequence: 1,
        sample: { processFrame: 10, physicsTick: 8 },
        targets: [
          {
            target: launchOutput.root,
            values: [
              {
                name: "value",
                status: "missing",
                message: "Temporarily absent",
              },
            ],
          },
        ],
      },
      {
        sequence: 2,
        sample: { processFrame: 10, physicsTick: 9 },
        targets: [
          {
            target: launchOutput.root,
            values: [{ name: "value", status: "success", value: 105 }],
          },
        ],
      },
    ];
    const page = InspectionWatchReadOutputV1Schema.parse({
      ...watchResponse.output,
      status: "stopped",
      stopReason: "sample_count",
      recordedCount: 2,
      records,
      nextSequence: 2,
      bytesUsed: records.reduce(
        (total, record) => total + inspectionWatchRecordBytesV1(record),
        0,
      ),
    });
    const stopOutput = {
      schemaVersion: 1,
      executionId: page.executionId,
      recordPath: "/records/run.json",
      record: {
        schemaVersion: 1,
        executionId: page.executionId,
        sourceSha256: null,
        observedSourceSha256: null,
        sourceUnchanged: null,
        mainScene: null,
        engineVersion: null,
        startedAt: "2026-09-06T00:00:00.000Z",
        endedAt: "2026-09-06T00:00:01.000Z",
        status: "exited",
        exitCode: 0,
        signal: null,
        import: null,
        run: null,
        stderr: "",
        stderrTruncated: false,
        error: null,
        watch: {
          state: {
            schemaVersion: page.schemaVersion,
            executionId: page.executionId,
            watchId: page.watchId,
            phase: page.phase,
            status: page.status,
            stopReason: page.stopReason,
            sampleCount: page.sampleCount,
            recordedCount: page.recordedCount,
            boundTargets: page.boundTargets,
          },
          records,
          deliveryComplete: true,
        },
      },
    };
    const response = {
      schemaVersion: 1,
      outcome: "success",
      output: toolName === "game_watch" ? page : stopOutput,
    };
    const original = structuredClone(response);
    const tool = createInspectionGameToolDefinitions({
      invoke: () => Promise.resolve(response),
    }).find(({ name }) => name === toolName)!;
    const input =
      toolName === "game_watch"
        ? watchInput
        : { schemaVersion: 1, executionId: page.executionId };
    const result = await tool.execute(
      "call_watch_1",
      input,
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toEqual(original);
    expect(response).toEqual(original);
    expect(result.content).toHaveLength(1);
    const block = result.content[0];
    if (block?.type !== "text")
      throw new Error("Expected compact text content");
    expect(
      block.text.startsWith(
        toolName === "game_watch" ? "game_watch read\n" : "game_stop\n",
      ),
    ).toBe(true);
    expect(block.text).not.toBe(JSON.stringify(response, null, 2));
    const header: unknown = JSON.parse(block.text.split("\n")[1]!);
    const { records: headerRecords, ...pageHeader } = page;
    expect(headerRecords).toHaveLength(2);
    const stopHeader = structuredClone(stopOutput);
    Reflect.deleteProperty(stopHeader.record.watch, "records");
    expect(header).toEqual({
      schemaVersion: 1,
      outcome: "success",
      output: toolName === "game_watch" ? pageHeader : stopHeader,
    });
    if (toolName === "game_stop") {
      const repeated = await tool.execute(
        "call_stop_again",
        input,
        undefined,
        undefined,
        {} as never,
      );
      expect(repeated).toEqual(result);
      const withoutWatch = structuredClone(stopOutput);
      Reflect.deleteProperty(withoutWatch.record, "watch");
      const plainResponse = {
        schemaVersion: 1,
        outcome: "success",
        output: withoutWatch,
      };
      const plainTool = createInspectionGameToolDefinitions({
        invoke: () => Promise.resolve(plainResponse),
      }).find(({ name }) => name === "game_stop")!;
      const plainResult = await plainTool.execute(
        "call_stop_plain",
        input,
        undefined,
        undefined,
        {} as never,
      );
      expect(plainResult.details).toEqual(plainResponse);
      expect(plainResult.content).toEqual([
        { type: "text", text: JSON.stringify(plainResponse, null, 2) },
      ]);
    }

    const message: ToolResultMessage<unknown> = {
      role: "toolResult",
      toolCallId: "call_watch_1",
      toolName,
      content: result.content,
      details: result.details,
      isError: false,
      timestamp: 1,
    };
    const messages = convertToLlm([message]);
    // The intermediate SDK context retains details; only provider serialization
    // decides the visible payload. No ModelRuntime, credentials or stream calls.
    expect(messages[0]).toBe(message);
    const model: Model<"openai-codex-responses"> = {
      id: "offline-contract",
      name: "Offline serializer contract",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://example.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272000,
      maxTokens: 100,
    };
    const payload = convertResponsesMessages(
      model,
      { messages },
      new Set(["openai-codex"]),
      { includeSystemPrompt: false },
    );
    expect(payload).toEqual([
      {
        type: "function_call_output",
        call_id: "call_watch_1",
        output: block.text,
      },
    ]);
    // Keep this fixture below Pi's independent 2,000-character summary limit.
    if (toolName === "game_watch") {
      expect(block.text.length).toBeLessThan(2000);
      expect(serializeConversation(messages)).toBe(
        `[Tool result]: ${block.text}`,
      );
    }
    expect(
      serializeConversation(
        convertToLlm([
          { ...message, details: { unused: "CANONICAL_DETAILS_ONLY" } },
        ]),
      ),
    ).toBe(serializeConversation(messages));
    expect(
      estimateTokens({ ...message, details: { unused: "x".repeat(100000) } }),
    ).toBe(estimateTokens(message));
  },
);

it.each(["start", "stop"] as const)(
  "keeps watch %s content in the original JSON form",
  async (action) => {
    const response = InspectionToolResponseV1Schema.parse({
      schemaVersion: 1,
      outcome: "success",
      output: {
        schemaVersion: 1,
        executionId: watchInput.executionId,
        watchId: watchInput.watchId,
        action,
        phase: watchResponse.output.phase,
        status: action === "start" ? "sampling" : "stopped",
        stopReason: action === "start" ? null : "stopped",
        sampleCount: 2,
        recordedCount: 0,
        boundTargets: watchResponse.output.boundTargets,
      },
    });
    const input =
      action === "start"
        ? {
            schemaVersion: 1,
            executionId: watchInput.executionId,
            action,
            targets: [{ target: { path: "." }, names: ["value"] }],
            sampleCount: 2,
          }
        : {
            schemaVersion: 1,
            executionId: watchInput.executionId,
            action,
            watchId: watchInput.watchId,
          };
    const tool = createInspectionGameToolDefinitions({
      invoke: () => Promise.resolve(response),
    }).find(({ name }) => name === "game_watch")!;
    const result = await tool.execute(
      "call_watch",
      input,
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toEqual(response);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(response, null, 2) },
    ]);
  },
);

it.each(["game_watch", "game_stop"] as const)(
  "keeps a %s failure in the original JSON form without inventing records",
  async (toolName) => {
    const response = {
      schemaVersion: 1,
      outcome: "error",
      error: {
        code: "execution_exited",
        message: "No further observations were acquired",
      },
    };
    const tool = createInspectionGameToolDefinitions({
      invoke: () => Promise.resolve(response),
    }).find(({ name }) => name === toolName)!;
    const result = await tool.execute(
      "call_watch",
      toolName === "game_watch"
        ? watchInput
        : { schemaVersion: 1, executionId: watchInput.executionId },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toEqual(response);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(response, null, 2) },
    ]);
  },
);
