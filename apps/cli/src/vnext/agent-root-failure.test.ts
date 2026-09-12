import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runVNextPiTurn, type VNextPiTurnResult } from "@chronorift/pi-harness";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { AgentSupervisor, type AgentResource } from "./agent-supervisor.js";
import type { AgentWorkerClientOptions } from "./agent-worker-client.js";

type SessionFactory = NonNullable<
  NonNullable<Parameters<typeof runVNextPiTurn>[1]>["createSession"]
>;
type Session = Awaited<ReturnType<SessionFactory>>["session"];
type SessionEvent = Parameters<Parameters<Session["subscribe"]>[0]>[0];
type Scenario = "settled_failure" | "queued_message_failure" | "retry_success";

const providerError = "Provider unavailable after SDK retries were exhausted";
const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const stats: VNextPiTurnResult["stats"] = {
  sessionFile: "/fixture.jsonl",
  sessionId: "fixture",
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 2,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
};

const workerResult = (
  status: "completed" | "aborted" = "completed",
): VNextPiTurnResult => ({
  schemaVersion: 1,
  status,
  sessionId: "worker",
  sessionFile: "/worker.jsonl",
  provider: "fixture",
  model: "fixture",
  requestedThinkingLevel: "off",
  realizedThinkingLevel: "off",
  activeTools: ["read"],
  assistantText: status === "completed" ? "Worker finished" : "Worker stopped",
  errorMessage: status === "completed" ? null : "Worker was interrupted",
  eventsObserved: 1,
  stats,
});

/** Real coordination and Pi harness; the Session models SDK events without a provider. */
async function runScenario(scenario: Scenario) {
  const directory = await mkdtemp(join(tmpdir(), "chronorift-root-failure-"));
  const workspace = join(directory, "workspace");
  const sessions = join(directory, "sessions");
  const agentDir = join(directory, "agent");
  await Promise.all([mkdir(workspace), mkdir(sessions), mkdir(agentDir)]);
  const workers: AgentWorkerClientOptions[] = [];
  const interruptedWorkers: number[] = [];
  const listeners = new Set<(event: SessionEvent) => void>();
  let rootIdle = true;
  let rootContinuations = 0;
  let queuedDeliveries = 0;
  let cancelledBeforeContinuationReturned = false;
  let lateWorkerCompletion: Promise<void> | undefined;
  let messages: unknown[] = [];
  let resolveQueuedDelivery = (): void => undefined;
  const queuedDelivery = new Promise<void>((resolve) => {
    resolveQueuedDelivery = resolve;
  });
  const emit = (event: SessionEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const assistant = (failed: boolean): void => {
    const message = {
      role: "assistant",
      stopReason: failed ? "error" : "stop",
      ...(failed ? { errorMessage: providerError } : {}),
      content: failed ? [] : [{ type: "text", text: "Root investigated" }],
    };
    messages = [message];
    emit({ type: "message_end", message } as SessionEvent);
  };
  const settle = (): void => {
    rootIdle = true;
    emit({ type: "agent_settled" } as SessionEvent);
  };
  const completeWorker = (index: number): void => {
    workers[index]!.onMessage({
      version: 1,
      type: "completed",
      turnId: 1,
      result: workerResult(),
    });
  };
  const supervisor = new AgentSupervisor({
    createResource: async (): Promise<AgentResource> => ({
      workerConfiguration: {
        resourceWorkspaceDirectory: "/private/candidate",
        sessionDirectory: "/host/sessions",
        provider: "fixture",
        model: "fixture",
        thinkingLevel: "off",
        tools: [
          {
            name: "read",
            description: "Read fixture",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      invokeTool: async () => ({ content: [] }),
      finishTurn: async () => ({ frozen: true }),
      readResult: async () => ({}),
      apply: async () => ({}),
      cancel: async () => undefined,
      close: async () => undefined,
    }),
    workerFactory: async (options) => {
      const index = workers.length;
      workers.push(options);
      return {
        send: async (message) => {
          if (message.type !== "interrupt") return;
          interruptedWorkers.push(index);
          queueMicrotask(() =>
            options.onMessage({
              version: 1,
              type: "completed",
              turnId: message.turnId,
              result: workerResult("aborted"),
            }),
          );
        },
        close: async () => undefined,
      };
    },
  });
  const createSession: SessionFactory = async (options) => ({
    extensionsResult: options.resourceLoader!.getExtensions(),
    session: {
      get isIdle() {
        return rootIdle;
      },
      clearQueue: () => ({ steering: [], followUp: [] }),
      abortCompaction: () => undefined,
      abortBranchSummary: () => undefined,
      abort: async () => undefined,
      waitForIdle: async () => undefined,
      prompt: async () => {
        rootIdle = false;
        emit({ type: "agent_start" } as SessionEvent);
        await supervisor.spawnAgent("Investigate A");
        await supervisor.spawnAgent("Investigate B");
        assistant(false);
        settle();
        // Complete A after the initial prompt returns and Root can begin waiting.
        void pause(5).then(() => completeWorker(0));
      },
      sendCustomMessage: async () => {
        if (!rootIdle) {
          // Pi queues follow-ups during streaming and resolves immediately.
          queuedDeliveries += 1;
          resolveQueuedDelivery();
          return;
        }
        rootContinuations += 1;
        rootIdle = false;
        emit({ type: "agent_start" } as SessionEvent);
        if (rootContinuations === 1) {
          if (scenario === "queued_message_failure") {
            workers[1]!.onMessage({
              version: 1,
              type: "tool_request",
              turnId: 1,
              requestId: "worker-progress",
              name: "send_message",
              arguments: { message: "B is still investigating" },
            });
            await queuedDelivery;
          }
          assistant(true);
          if (scenario === "retry_success") {
            // A message_end error can be followed by Pi's own successful retry.
            await pause(5);
            assistant(false);
          }
          settle();
          // Pi emits settled before the enclosing sendCustomMessage resolves.
          // Observe cancellation here so checking only its return value is insufficient.
          await Promise.resolve();
          cancelledBeforeContinuationReturned = interruptedWorkers.includes(1);
          // Simulate a late completion even if B acknowledged cancellation first.
          lateWorkerCompletion = pause(20).then(() => completeWorker(1));
          return;
        }
        assistant(false);
        settle();
      },
      subscribe: (listener: (event: SessionEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose: () => undefined,
      getActiveToolNames: () => ["read"],
      getSessionStats: () => stats,
      sessionFile: "/fixture.jsonl",
      sessionId: "fixture",
      thinkingLevel: "off",
      get messages() {
        return messages;
      },
    } as unknown as Session,
  });
  try {
    const result = await runVNextPiTurn(
      {
        resourceWorkspaceDirectory: workspace,
        sessionDirectory: sessions,
        agentDir,
        modelRuntime: {} as Parameters<
          typeof runVNextPiTurn
        >[0]["modelRuntime"],
        model: {
          provider: "fixture",
          id: "fixture",
        } as Parameters<typeof runVNextPiTurn>[0]["model"],
        thinkingLevel: "off",
        prompt: "Investigate with two workers",
        tools: [
          {
            name: "read",
            label: "Read",
            description: "Read fixture",
            parameters: Type.Object({}),
            execute: async () => ({ content: [], details: undefined }),
          },
        ],
        timeoutMs: 2000,
        collaboration: supervisor,
      },
      { createSession },
    );
    await lateWorkerCompletion;
    return {
      result,
      rootContinuations,
      queuedDeliveries,
      cancelledBeforeContinuationReturned,
      interruptedWorkers: [...interruptedWorkers],
      workerResults: supervisor.results,
      remainingSubscribers: listeners.size,
    };
  } finally {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Root provider failure during agent collaboration", () => {
  it("cancels B after A wakes a failing Root and ignores B's late completion", async () => {
    const observed = await runScenario("settled_failure");
    expect(observed.result.status).toBe("provider_failed");
    expect(observed.result.errorMessage).toBe(providerError);
    expect(observed.interruptedWorkers).toEqual([1]);
    expect(observed.rootContinuations).toBe(1);
    expect(
      observed.workerResults.find((result) => result.agentId === "agent-2")
        ?.status,
    ).toBe("cancelled");
    expect(observed.remainingSubscribers).toBe(0);
  });

  it("stops when Root fails after accepting an already-resolved streaming follow-up", async () => {
    const observed = await runScenario("queued_message_failure");
    expect(observed.queuedDeliveries).toBe(1);
    expect(observed.cancelledBeforeContinuationReturned).toBe(true);
    expect(observed.result.status).toBe("provider_failed");
    expect(observed.result.errorMessage).toBe(providerError);
    expect(observed.interruptedWorkers).toEqual([1]);
    expect(observed.rootContinuations).toBe(1);
    expect(observed.remainingSubscribers).toBe(0);
  });

  it("lets Pi retry a message error before deciding the settled Root failed", async () => {
    const observed = await runScenario("retry_success");
    expect(observed.result.status).toBe("completed");
    expect(observed.result.errorMessage).toBeNull();
    expect(observed.interruptedWorkers).toEqual([]);
    expect(observed.rootContinuations).toBe(2);
    expect(
      observed.workerResults.every((result) => result.status === "completed"),
    ).toBe(true);
    expect(observed.remainingSubscribers).toBe(0);
  });
});
