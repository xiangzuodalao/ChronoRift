import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { observePiModelRequests } from "../src/model-request-telemetry.js";

const model = { provider: "offline", id: "fixture" } as Model<Api>;
const fixture = (streamFunction: AgentSession["agent"]["streamFunction"]) => {
  const appendCustomEntry = vi.fn(() => "entry");
  const session = {
    agent: { streamFunction },
    sessionManager: { appendCustomEntry },
  } as unknown as Pick<AgentSession, "agent" | "sessionManager">;
  return {
    session,
    appendCustomEntry,
    observer: observePiModelRequests(session),
  };
};

describe("Pi model request telemetry", () => {
  it("observes preparation through completion without consuming stream events or payloads", async () => {
    const stream = createAssistantMessageEventStream();
    let supplyStream: ((value: typeof stream) => void) | undefined;
    const original = vi.fn(
      () =>
        new Promise<typeof stream>((resolve) => {
          supplyStream = resolve;
        }),
    );
    const { session, observer, appendCustomEntry } = fixture(original);
    const context = { messages: [], systemPrompt: "private prompt" };
    const options = { apiKey: "private credential" };
    const pending = session.agent.streamFunction(model, context, options);
    expect(observer.snapshot()).toEqual([
      expect.objectContaining({
        boundary: "pi-stream-function",
        provider: "offline",
        model: "fixture",
        outcome: "in_flight",
        finishedAt: null,
        durationMs: null,
      }),
    ]);
    supplyStream!(stream);
    expect(await pending).toBe(stream);
    expect(original).toHaveBeenCalledWith(model, context, options);
    const response = {
      ...fauxAssistantMessage("private result"),
      stopReason: "stop" as const,
    };
    stream.push({ type: "start", partial: response });
    stream.push({ type: "done", reason: "stop", message: response });
    await stream.result();
    const received = [];
    for await (const event of stream) received.push(event.type);
    expect(received).toEqual(["start", "done"]);
    const [request] = observer.snapshot();
    expect(request).toMatchObject({ outcome: "completed", stopReason: "stop" });
    expect(request?.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(request!.finishedAt!)).toBeGreaterThanOrEqual(
      Date.parse(request!.startedAt),
    );
    expect(appendCustomEntry.mock.calls).toEqual([
      [
        "chronorift.model-request.v1",
        expect.objectContaining({ schemaVersion: 1, phase: "started" }),
      ],
      [
        "chronorift.model-request.v1",
        expect.objectContaining({ schemaVersion: 1, phase: "finished" }),
      ],
    ]);
    expect(JSON.stringify(appendCustomEntry.mock.calls)).not.toContain(
      "private",
    );
    observer.dispose();
    expect(session.agent.streamFunction).toBe(original);
  });

  it("records a failed stream and its retry separately, preserving cancellation and thrown failures", async () => {
    const streams = [
      createAssistantMessageEventStream(),
      createAssistantMessageEventStream(),
    ];
    const original = vi
      .fn<AgentSession["agent"]["streamFunction"]>()
      .mockReturnValueOnce(streams[0]!)
      .mockReturnValueOnce(streams[1]!)
      .mockRejectedValueOnce(new Error("private provider failure"));
    const { session, observer } = fixture(original);
    for (const [index, stopReason] of (
      ["error", "aborted"] as const
    ).entries()) {
      const stream = await session.agent.streamFunction(model, {
        messages: [],
      });
      const response = { ...fauxAssistantMessage(""), stopReason };
      stream.push({ type: "error", reason: stopReason, error: response });
      await stream.result();
      expect(observer.snapshot()[index]?.outcome).toBe(stopReason);
    }
    await expect(
      session.agent.streamFunction(model, { messages: [] }),
    ).rejects.toThrow("private provider failure");
    const requests = observer.snapshot();
    expect(requests.map((request) => request.outcome)).toEqual([
      "error",
      "aborted",
      "error",
    ]);
    expect(new Set(requests.map((request) => request.requestId)).size).toBe(3);
    expect(requests.every((request) => request.finishedAt !== null)).toBe(true);
    expect(JSON.stringify(requests)).not.toContain("private");
  });

  it("retains an unobserved request end and reports telemetry persistence failures without retrying model work", async () => {
    const stream = createAssistantMessageEventStream();
    const original = vi.fn(() => stream);
    const { session, observer, appendCustomEntry } = fixture(original);
    appendCustomEntry.mockImplementation(() => {
      throw new Error("disk full");
    });
    await session.agent.streamFunction(model, { messages: [] });
    expect(observer.snapshot()[0]).toMatchObject({
      outcome: "in_flight",
      finishedAt: null,
      durationMs: null,
      persistenceFailed: true,
    });
    expect(original).toHaveBeenCalledOnce();
    observer.dispose();
  });
});
