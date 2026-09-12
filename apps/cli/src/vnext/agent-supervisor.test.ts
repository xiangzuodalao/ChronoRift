import { describe, expect, it, vi } from "vitest";

import type { VNextPiTurnResult } from "@chronorift/pi-harness";

import { AgentSupervisor, type AgentResource } from "./agent-supervisor.js";
import type { AgentHostMessage, AgentWorkerMessage } from "./agent-ipc.js";
import type { AgentWorkerClientOptions } from "./agent-worker-client.js";

const piResult = (text = "Investigated"): VNextPiTurnResult => ({
  schemaVersion: 1,
  status: "completed",
  sessionId: "session",
  sessionFile: "/host/session.jsonl",
  provider: "fixture",
  model: "fixture",
  requestedThinkingLevel: "off",
  realizedThinkingLevel: "off",
  activeTools: ["read"],
  assistantText: text,
  errorMessage: null,
  eventsObserved: 1,
  stats: {
    sessionFile: "/host/session.jsonl",
    sessionId: "session",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  },
});

function fixture(
  options: {
    turnTimeoutMs?: number;
    interruptGraceMs?: number;
    cooperative?: boolean;
    beforeResourceReady?: () => Promise<void>;
  } = {},
) {
  const workers: {
    options: AgentWorkerClientOptions;
    sent: AgentHostMessage[];
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const resources: AgentResource[] = [];
  const supervisor = new AgentSupervisor({
    ...options,
    createResource: async () => {
      const resource: AgentResource = {
        workerConfiguration: {
          resourceWorkspaceDirectory: "/private/candidate",
          sessionDirectory: "/host/sessions",
          provider: "fixture",
          model: "fixture",
          thinkingLevel: "off",
          tools: [
            {
              name: "read",
              description: "read",
              parameters: { type: "object" },
            },
            {
              name: "game_stop",
              description: "stop",
              parameters: { type: "object" },
            },
          ],
        },
        invokeTool: vi.fn(async () => ({
          content: [{ type: "text" as const, text: "observed" }],
        })),
        finishTurn: vi.fn(async (turnId: number) => ({
          turnId,
          hash: `snapshot-${turnId}`,
        })),
        readResult: vi.fn(async (turnId: number) => ({
          turnId,
          patch: "diff",
        })),
        apply: vi.fn(async () => ({ status: "applied" })),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      };
      resources.push(resource);
      await options.beforeResourceReady?.();
      return resource;
    },
    workerFactory: async (workerOptions) => {
      const worker = {
        options: workerOptions,
        sent: [] as AgentHostMessage[],
        close: vi.fn(async () => undefined),
      };
      workers.push(worker);
      return {
        send: async (message) => {
          worker.sent.push(message);
          if (message.type === "interrupt" && options.cooperative !== false) {
            queueMicrotask(() =>
              workerOptions.onMessage({
                version: 1,
                type: "completed",
                turnId: message.turnId,
                result: { ...piResult(), status: "aborted" },
              }),
            );
          }
        },
        close: worker.close,
      };
    },
  });
  const emit = (index: number, message: AgentWorkerMessage): void => {
    workers[index]!.options.onMessage(message);
  };
  const complete = (index: number, turnId: number, text?: string): void =>
    emit(index, {
      version: 1,
      type: "completed",
      turnId,
      result: piResult(text),
    });
  return { supervisor, workers, resources, emit, complete };
}

describe("AgentSupervisor", () => {
  it("waits for pending resource creation before completing Host shutdown", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({ beforeResourceReady: () => gate });
    const spawning = f.supervisor.spawnAgent("inspect");
    const rejected = expect(spawning).rejects.toThrow("startup was cancelled");
    const closing = f.supervisor.close();
    expect(f.resources[0]!.close).not.toHaveBeenCalled();
    release();
    await rejected;
    await closing;
    expect(f.resources[0]!.close).toHaveBeenCalled();
    expect(f.workers).toHaveLength(0);
    expect(f.supervisor.listAgents()[0]?.state).toBe("closed");
  });

  it("does not start queued work when the preceding execution cannot be stopped", async () => {
    const f = fixture();
    const first = await f.supervisor.spawnAgent("inspect");
    const next = f.supervisor.followupTask(first.agentId, "followup");
    vi.mocked(f.resources[0]!.cancel).mockRejectedValue(
      new Error("sandbox cleanup failed"),
    );
    f.complete(0, 1);
    const result = await f.supervisor.waitAgent([first, next]);
    expect(result.results.every((record) => record.status === "failed")).toBe(
      true,
    );
    expect(f.resources[0]!.finishTurn).not.toHaveBeenCalled();
    expect(f.supervisor.listAgents()[0]?.state).toBe("failed");
    expect(
      f.workers[0]!.sent.filter((message) => message.type === "prompt"),
    ).toHaveLength(1);
    await f.supervisor.close();
  });

  it("runs independent workers, retains sessions for FIFO followups, and releases only closed slots", async () => {
    const f = fixture();
    try {
      const first = await f.supervisor.spawnAgent("inspect collision");
      const second = await f.supervisor.spawnAgent("inspect dimensions");
      await expect(f.supervisor.spawnAgent("third")).rejects.toThrow(
        "occupied",
      );
      const followup = f.supervisor.followupTask(
        first.agentId,
        "check candidate",
      );
      expect(
        f.workers[0]!.sent.filter((message) => message.type === "prompt"),
      ).toHaveLength(1);
      f.complete(0, first.turnId, "first finding");
      await f.supervisor.waitAgent([first]);
      expect(
        f.workers[0]!.sent.filter((message) => message.type === "prompt"),
      ).toHaveLength(2);
      f.complete(0, followup.turnId, "second finding");
      f.complete(1, second.turnId);
      await f.supervisor.waitAgent([followup, second]);
      expect(f.resources[0]!.finishTurn).toHaveBeenCalledTimes(2);
      expect(
        await f.supervisor.readAgentResult(first.agentId, first.turnId),
      ).toMatchObject({ text: "first finding" });
      await expect(f.supervisor.spawnAgent("third")).rejects.toThrow(
        "occupied",
      );
      await f.supervisor.closeAgent(first.agentId);
      const third = await f.supervisor.spawnAgent("new worker");
      expect(third.agentId).toBe("agent-3");
      expect(
        f.workers[2]!.options.configuration.tools.map((tool) => tool.name),
      ).toEqual(["read", "game_stop", "send_message"]);
    } finally {
      await f.supervisor.close();
    }
  });

  it("bounds queued tasks, wait deadlines, and aborts without cancelling the worker", async () => {
    const f = fixture();
    try {
      const target = await f.supervisor.spawnAgent("work");
      for (let index = 0; index < 8; index += 1)
        f.supervisor.followupTask(target.agentId, `queued ${index}`);
      expect(() =>
        f.supervisor.followupTask(target.agentId, "overflow"),
      ).toThrow("8 queued");
      expect(await f.supervisor.waitAgent([target], "all", 5)).toEqual({
        timedOut: true,
        results: [],
      });
      const controller = new AbortController();
      const waited = f.supervisor.waitAgent(
        [target],
        "all",
        10_000,
        controller.signal,
      );
      controller.abort(new Error("stop waiting"));
      await expect(waited).rejects.toThrow("stop waiting");
      expect(f.supervisor.listAgents()[0]?.state).toBe("running");
      await f.supervisor.interruptAgent(target.agentId);
      expect(f.supervisor.results).toHaveLength(9);
      expect(
        f.supervisor.results.every((result) => result.status === "cancelled"),
      ).toBe(true);
      const next = f.supervisor.followupTask(target.agentId, "retry");
      f.complete(0, target.turnId, "late previous result");
      expect(f.supervisor.listAgents()[0]?.currentTurnId).toBe(next.turnId);
      f.complete(0, next.turnId);
      await f.supervisor.waitAgent([next]);
    } finally {
      await f.supervisor.close();
    }
  });

  it("revokes only the failed worker and captures an immutable partial result", async () => {
    const f = fixture();
    try {
      const first = await f.supervisor.spawnAgent("first");
      const second = await f.supervisor.spawnAgent("second");
      f.workers[0]!.options.onExit(new Error("IPC disconnected"));
      const result = await f.supervisor.waitAgent([first]);
      expect(result.results[0]).toMatchObject({
        status: "failed",
        evidence: { hash: "snapshot-1" },
      });
      expect(f.resources[0]!.cancel).toHaveBeenCalled();
      expect(f.resources[1]!.cancel).not.toHaveBeenCalled();
      expect(f.supervisor.listAgents()[1]?.state).toBe("running");
      f.complete(1, second.turnId);
      await f.supervisor.waitAgent([second]);
      await expect(
        f.supervisor.applyAgentPatch(first.agentId, first.turnId),
      ).resolves.toEqual({ status: "applied" });
    } finally {
      await f.supervisor.close();
    }
  });

  it("enforces per-turn tool budget, permits game_stop, and rejects unavailable tools", async () => {
    const f = fixture();
    try {
      const target = await f.supervisor.spawnAgent("work");
      for (let index = 0; index < 66; index += 1) {
        const name = index === 65 ? "game_stop" : "read";
        f.emit(0, {
          version: 1,
          type: "tool_request",
          turnId: 1,
          requestId: `request-${index}`,
          name,
          arguments: {},
        });
        await vi.waitFor(() =>
          expect(
            f.workers[0]!.sent.some(
              (message) =>
                message.type === "tool_result" &&
                message.requestId === `request-${index}`,
            ),
          ).toBe(true),
        );
      }
      expect(f.resources[0]!.invokeTool).toHaveBeenCalledTimes(65);
      expect(
        f.workers[0]!.sent.find(
          (message) =>
            message.type === "tool_result" &&
            message.requestId === "request-64",
        ),
      ).toMatchObject({ result: { isError: true } });
      f.emit(0, {
        version: 1,
        type: "tool_request",
        turnId: 1,
        requestId: "escape",
        name: "spawn_agent",
        arguments: {},
      });
      await vi.waitFor(() =>
        expect(
          f.workers[0]!.sent.find(
            (message) =>
              message.type === "tool_result" && message.requestId === "escape",
          ),
        ).toMatchObject({ result: { isError: true } }),
      );
      f.complete(0, 1);
      await f.supervisor.waitAgent([target]);
    } finally {
      await f.supervisor.close();
    }
  }, 10_000);

  it("times out an uncooperative worker and reclaims its resources", async () => {
    const f = fixture({
      turnTimeoutMs: 10,
      interruptGraceMs: 5,
      cooperative: false,
    });
    try {
      const target = await f.supervisor.spawnAgent("never finishes");
      const waited = await f.supervisor.waitAgent([target], "all", 1000);
      expect(waited.results[0]?.status).toBe("timed_out");
      expect(f.workers[0]!.close).toHaveBeenCalled();
      expect(f.resources[0]!.cancel).toHaveBeenCalled();
      expect(f.supervisor.listAgents()[0]?.state).toBe("failed");
    } finally {
      await f.supervisor.close();
    }
  });

  it("delivers findings during Root work, pauses automatic continuation, and discards obsolete bindings", async () => {
    const f = fixture();
    let idle = false;
    const deliver = vi.fn(async () => undefined);
    const unbind = f.supervisor.bindRoot({
      isIdle: () => idle,
      deliver,
      abort: async () => undefined,
    });
    try {
      const target = await f.supervisor.spawnAgent("work");
      f.emit(0, {
        version: 1,
        type: "tool_request",
        turnId: 1,
        requestId: "notice",
        name: "send_message",
        arguments: { message: "found shared shape" },
      });
      await vi.waitFor(() =>
        expect(deliver).toHaveBeenCalledWith(
          expect.stringContaining("found shared shape"),
        ),
      );
      f.supervisor.interrupt();
      f.complete(0, 1, "finished while paused");
      await vi.waitFor(() => expect(f.supervisor.results).toHaveLength(1));
      idle = true;
      await f.supervisor.drain();
      expect(deliver).toHaveBeenCalledTimes(1);
      unbind();
      f.supervisor.onUserInput();
      await f.supervisor.drain();
      expect(deliver).toHaveBeenCalledTimes(1);
      const nextDeliver = vi.fn(async () => undefined);
      f.supervisor.bindRoot({
        isIdle: () => true,
        deliver: nextDeliver,
        abort: async () => undefined,
      });
      await f.supervisor.drain();
      expect(nextDeliver).toHaveBeenCalledWith(
        expect.stringContaining("finished while paused"),
      );
      expect((await f.supervisor.waitAgent([target])).results[0]?.status).toBe(
        "completed",
      );
    } finally {
      await f.supervisor.close();
    }
  });
});
