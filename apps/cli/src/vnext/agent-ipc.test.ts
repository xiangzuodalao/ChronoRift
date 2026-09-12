import { describe, expect, it } from "vitest";

import {
  AGENT_IPC_MAX_BYTES,
  parseAgentHostMessage,
  parseAgentWorkerMessage,
} from "./agent-ipc.js";

describe("agent IPC boundary", () => {
  it("rejects protocol mismatches, impersonation, unknown fields and malformed completions", () => {
    expect(() =>
      parseAgentWorkerMessage({ version: 2, type: "ready" }),
    ).toThrow();
    expect(() =>
      parseAgentWorkerMessage({
        version: 1,
        type: "tool_request",
        agentId: "root",
        turnId: 1,
        requestId: "request",
        name: "read",
        arguments: {},
      }),
    ).toThrow();
    expect(() =>
      parseAgentWorkerMessage({
        version: 1,
        type: "completed",
        turnId: 1,
        result: { status: "completed" },
      }),
    ).toThrow();
    expect(() =>
      parseAgentHostMessage({
        version: 1,
        type: "prompt",
        turnId: -1,
        text: "task",
      }),
    ).toThrow();
  });

  it("bounds large messages before inspecting schemas and validates image/tool envelopes", () => {
    expect(() =>
      parseAgentHostMessage({
        version: 1,
        type: "message",
        text: "x".repeat(AGENT_IPC_MAX_BYTES),
      }),
    ).toThrow("size limit");
    expect(
      parseAgentHostMessage({
        version: 1,
        type: "tool_result",
        turnId: 2,
        requestId: "request",
        result: {
          content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
          details: { loss: "none" },
        },
      }),
    ).toMatchObject({ type: "tool_result", turnId: 2 });
    expect(() =>
      parseAgentHostMessage({
        version: 1,
        type: "tool_result",
        turnId: 2,
        requestId: "request",
        result: { content: [{ type: "file", path: "/host/secret" }] },
      }),
    ).toThrow();
  });
});
