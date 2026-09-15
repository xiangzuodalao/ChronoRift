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
const providerError = "Provider unavailable after SDK retries were exhausted";
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
const workerResult = (): VNextPiTurnResult => ({
  schemaVersion: 1,
  status: "aborted",
  sessionId: "worker",
  sessionFile: "/worker.jsonl",
  provider: "fixture",
  model: "fixture",
  requestedThinkingLevel: "off",
  realizedThinkingLevel: "off",
  activeTools: ["read"],
  assistantText: "Worker stopped",
  errorMessage: "Worker was interrupted",
  eventsObserved: 1,
  stats,
});

/** Real coordinator and Pi harness with a credential-free Session event fixture. */
async function runScenario(scenario: "failure" | "retry_success" | "success") {
  const directory = await mkdtemp(join(tmpdir(), "chronorift-root-failure-"));
  const workspace = join(directory, "workspace");
  const sessions = join(directory, "sessions");
  const agentDir = join(directory, "agent");
  await Promise.all([mkdir(workspace), mkdir(sessions), mkdir(agentDir)]);
  const workers: AgentWorkerClientOptions[] = [];
  const interrupted: number[] = [];
  const sessionListeners = new Set<(event: SessionEvent) => void>();
  const agentListeners = new Set<(event: SessionEvent) => unknown>();
  let rootIdle = true;
  let rootContinuations = 0;
  let prematureCancellation = false;
  const messages: unknown[] = [];
  const emit = async (event: SessionEvent) => {
    for (const listener of [...sessionListeners]) listener(event);
    for (const listener of [...agentListeners]) await listener(event);
  };
  const agent = {
    subscribe: (listener: (event: SessionEvent) => unknown) => {
      agentListeners.add(listener);
      return () => {
        agentListeners.delete(listener);
      };
    },
    prepareNextTurnWithContext: undefined as
      | ((
          turn: { message: { content: { type: string; text?: string }[] } },
          signal: AbortSignal,
        ) => Promise<unknown>)
      | undefined,
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
            description: "Read",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      invokeTool: async () => ({ content: [] }),
      finishTurn: async () => ({ executions: [] }),
      cancel: async () => undefined,
      close: async () => undefined,
    }),
    workerFactory: async (options) => {
      const index = workers.length;
      workers.push(options);
      return {
        send: async (message) => {
          if (message.type === "interrupt") {
            interrupted.push(index);
            queueMicrotask(() =>
              options.onMessage({
                version: 2,
                type: "completed",
                turnId: message.turnId,
                result: workerResult(),
              }),
            );
          }
          if (message.type === "collaboration")
            options.onMessage({
              version: 2,
              type: "collaboration_accepted",
              requestId: message.requestId,
              acceptedInCurrentTurn: false,
            });
        },
        close: async () => undefined,
      };
    },
  });
  const assistant = async (failed: boolean) => {
    const message = {
      role: "assistant",
      stopReason: failed ? "error" : "stop",
      ...(failed ? { errorMessage: providerError } : {}),
      content: failed ? [] : [{ type: "text", text: "Root investigated" }],
    };
    messages.push(message);
    await emit({ type: "message_end", message } as SessionEvent);
    if (!failed)
      await agent.prepareNextTurnWithContext?.(
        { message },
        new AbortController().signal,
      );
  };
  const createSession: SessionFactory = async (options) => ({
    extensionsResult: options.resourceLoader!.getExtensions(),
    session: {
      agent,
      sessionManager: { getEntries: () => [] },
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
        await emit({ type: "agent_start" } as SessionEvent);
        const first = await supervisor.spawnAgent("Investigate A", {
          taskName: "a",
          forkTurns: "none",
        });
        await supervisor.spawnAgent("Investigate B", {
          taskName: "b",
          forkTurns: "none",
        });
        await supervisor.sendMessage(
          "/root",
          "Worker A is investigating",
          first.agentId,
        );
        await assistant(scenario !== "success");
        if (scenario === "retry_success") {
          await emit({
            type: "agent_end",
            messages: [],
          } as unknown as SessionEvent);
          prematureCancellation = interrupted.length !== 0;
          await emit({ type: "agent_start" } as SessionEvent);
          await assistant(false);
        }
        rootIdle = true;
        await emit({ type: "agent_settled" } as SessionEvent);
      },
      sendCustomMessage: async (
        message: unknown,
        options: { triggerTurn?: boolean },
      ) => {
        if (options.triggerTurn === true) rootContinuations += 1;
        const custom = { ...(message as object), role: "custom" };
        messages.push(custom);
        await emit({ type: "message_end", message: custom } as SessionEvent);
      },
      subscribe: (listener: (event: SessionEvent) => void) => {
        sessionListeners.add(listener);
        return () => {
          sessionListeners.delete(listener);
        };
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
        model: { provider: "fixture", id: "fixture" } as Parameters<
          typeof runVNextPiTurn
        >[0]["model"],
        thinkingLevel: "off",
        prompt: "Investigate with workers",
        tools: [
          {
            name: "read",
            label: "Read",
            description: "Read",
            parameters: Type.Object({}),
            execute: async () => ({ content: [], details: undefined }),
          },
        ],
        timeoutMs: 2000,
        collaboration: supervisor,
      },
      { createSession },
    );
    return {
      result,
      interrupted,
      rootContinuations,
      prematureCancellation,
      workerResults: supervisor.results,
      remainingSubscribers: sessionListeners.size + agentListeners.size,
    };
  } finally {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Root settlement during V2 collaboration", () => {
  it("stops workers after a settled provider failure, without followup-triggered Root prompts", async () => {
    const observed = await runScenario("failure");
    expect(observed.result.status).toBe("provider_failed");
    expect(observed.result.errorMessage).toBe(providerError);
    expect(observed.interrupted.sort()).toEqual([0, 1]);
    expect(observed.rootContinuations).toBe(0);
    expect(
      observed.workerResults.every((result) => result.status === "cancelled"),
    ).toBe(true);
    expect(observed.remainingSubscribers).toBe(0);
  });
  it("lets Pi finish its retry before cancelling the remaining headless workers", async () => {
    const observed = await runScenario("retry_success");
    expect(observed.result.status).toBe("completed");
    expect(observed.result.errorMessage).toBeNull();
    expect(observed.prematureCancellation).toBe(false);
    expect(observed.interrupted.sort()).toEqual([0, 1]);
    expect(observed.rootContinuations).toBe(0);
    expect(observed.remainingSubscribers).toBe(0);
  });
  it("keeps late ordinary messages from extending a successful Root answer", async () => {
    const observed = await runScenario("success");
    expect(observed.result.status).toBe("completed");
    expect(observed.interrupted.sort()).toEqual([0, 1]);
    expect(observed.rootContinuations).toBe(0);
    expect(observed.workerResults).toHaveLength(2);
    expect(observed.remainingSubscribers).toBe(0);
  });
});
