import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createManagedPiSession,
  runVNextPiTurn,
  VNEXT_CODING_ENVIRONMENT_APPENDIX,
  VNEXT_ENVIRONMENT_APPENDIX,
  type RootPiSessionControl,
} from "../src/index.js";

const roots: string[] = [];
const model = {
  provider: "openai-codex",
  id: "gpt-5.6-luna",
} as Model<Api>;
const modelRuntime = {} as ModelRuntime;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const createRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-vnext-pi-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const sessions = join(root, "sessions");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(sessions), mkdir(agentDir)]);
  await writeFile(join(workspace, "AGENTS.md"), "# Project guidance\n");
  return { root, workspace, sessions, agentDir };
};

const tools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(
  (name) =>
    defineTool({
      name,
      label: name,
      description: `${name} fixture`,
      parameters: Type.Object({}),
      execute: () =>
        Promise.resolve({
          content: [{ type: "text" as const, text: "ok" }],
          details: undefined,
        }),
    }),
);

const stats = {
  sessionFile: "/session.jsonl",
  sessionId: "session-fixture",
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 1,
  toolResults: 1,
  totalMessages: 4,
  tokens: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    total: 15,
  },
  cost: 0,
};

const fakeSessionFactory =
  (
    captures: CreateAgentSessionOptions[],
    mode: "complete" | "wait-for-abort" | "reject" = "complete",
    lifecycle?: { disposeCalls: number; unsubscribeCalls: number },
  ) =>
  async (
    options: CreateAgentSessionOptions,
  ): Promise<CreateAgentSessionResult> => {
    captures.push(options);
    if (options.sessionManager?.getEntries().length === 0) {
      options.sessionManager.appendModelChange(model.provider, model.id);
      options.sessionManager.appendThinkingLevelChange("max");
    }
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    let abortCalls = 0;
    let settlePrompt: (() => void) | undefined;
    const sessionFile = options.sessionManager?.getSessionFile();
    const sessionId = options.sessionManager?.getSessionId() ?? "missing";
    if (sessionFile !== undefined && options.sessionManager !== undefined) {
      await writeFile(
        sessionFile,
        [
          options.sessionManager.getHeader(),
          ...options.sessionManager.getEntries(),
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
    }
    let messages = [
      {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "Candidate ready; tests passed." },
        ],
      },
    ];
    const session = {
      isIdle: true,
      clearQueue: () => ({ steering: [], followUp: [] }),
      abortCompaction: () => undefined,
      abortBranchSummary: () => undefined,
      waitForIdle: () => Promise.resolve(),
      prompt: () => {
        if (mode === "complete") {
          for (const listener of listeners)
            listener({ type: "tool_execution_end", isError: true } as never);
          return Promise.resolve();
        }
        if (mode === "reject") {
          return Promise.reject(new Error("provider request failed"));
        }
        return new Promise<void>((resolvePrompt) => {
          settlePrompt = resolvePrompt;
        });
      },
      abort: () => {
        abortCalls += 1;
        messages = [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "Stopped" }],
          },
        ];
        settlePrompt?.();
        return Promise.resolve();
      },
      subscribe: (next: (event: AgentSessionEvent) => void) => {
        listeners.add(next);
        return () => {
          listeners.delete(next);
          if (lifecycle !== undefined) lifecycle.unsubscribeCalls += 1;
        };
      },
      dispose: () => {
        if (lifecycle !== undefined) lifecycle.disposeCalls += 1;
      },
      getActiveToolNames: () => tools.map((tool) => tool.name),
      getSessionStats: () => ({ ...stats, sessionFile, sessionId }),
      sessionFile,
      sessionId,
      thinkingLevel: "max",
      get messages() {
        return messages;
      },
      get abortCalls() {
        return abortCalls;
      },
    };
    return {
      session: session as never,
      extensionsResult: options.resourceLoader!.getExtensions(),
    };
  };

describe("vNext Pi AgentSession host", () => {
  it("retains an independent session across tasks and preserves message provenance", async () => {
    const root = await createRoot();
    const captures: CreateAgentSessionOptions[] = [];
    const lifecycle = { disposeCalls: 0, unsubscribeCalls: 0 };
    const messages = vi.fn(async () => undefined);
    const session = await createManagedPiSession(
      {
        resourceWorkspaceDirectory: root.workspace,
        sessionDirectory: root.sessions,
        agentDir: root.agentDir,
        modelRuntime,
        model,
        thinkingLevel: "max",
        tools,
      },
      {
        createSession: async (options) => {
          const created = await fakeSessionFactory(
            captures,
            "complete",
            lifecycle,
          )(options);
          created.session.sendCustomMessage = messages;
          return created;
        },
      },
    );
    await session.prompt("Investigate the initial failure.");
    const initial = session.snapshot();
    await session.sendMessage("A worker observed a failure.", {
      triggerTurn: true,
      source: { agentId: "worker-1", messageId: "message-1" },
    });
    await session.prompt("Check the alternate hypothesis.");
    expect(session.snapshot().sessionId).toBe(initial.sessionId);
    expect(captures).toHaveLength(1);
    expect(lifecycle.disposeCalls).toBe(0);
    expect(messages).toHaveBeenCalledWith(
      {
        customType: "chronorift.collaboration",
        content: "A worker observed a failure.",
        display: true,
        details: { source: { agentId: "worker-1", messageId: "message-1" } },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    session.dispose();
    session.dispose();
    expect(lifecycle).toEqual({ disposeCalls: 1, unsubscribeCalls: 1 });
    await expect(session.prompt("Another task")).rejects.toThrow("disposed");
  });

  it("drains child results before taking the final snapshot and disposing", async () => {
    const root = await createRoot();
    const captures: CreateAgentSessionOptions[] = [];
    const lifecycle = { disposeCalls: 0, unsubscribeCalls: 0 };
    let control: RootPiSessionControl | undefined;
    let reviewed = false;
    const delivered = vi.fn(async () => {
      reviewed = true;
    });
    const unbind = vi.fn();
    const result = await runVNextPiTurn(
      {
        resourceWorkspaceDirectory: root.workspace,
        sessionDirectory: root.sessions,
        agentDir: root.agentDir,
        modelRuntime,
        model,
        thinkingLevel: "max",
        prompt: "Investigate with a worker.",
        tools,
        collaboration: {
          bindRoot: (value) => {
            control = value;
            return unbind;
          },
          drain: async () => {
            expect(lifecycle.disposeCalls).toBe(0);
            await control!.deliver("Worker result: issue reproduced.");
          },
          interrupt: vi.fn(),
          stopAgents: vi.fn(async () => undefined),
          describeAgents: () => "worker-1 idle",
        },
      },
      {
        createSession: async (options) => {
          const created = await fakeSessionFactory(
            captures,
            "complete",
            lifecycle,
          )(options);
          created.session.sendCustomMessage = delivered;
          Object.defineProperty(created.session, "messages", {
            get: () => [
              {
                role: "assistant",
                stopReason: "stop",
                content: [
                  {
                    type: "text",
                    text: reviewed
                      ? "Worker evidence reviewed."
                      : "Waiting for worker.",
                  },
                ],
              },
            ],
          });
          return created;
        },
      },
    );
    expect(result.status).toBe("completed");
    expect(result.assistantText).toBe("Worker evidence reviewed.");
    expect(delivered).toHaveBeenCalledOnce();
    expect(delivered.mock.invocationCallOrder[0]).toBeLessThan(
      unbind.mock.invocationCallOrder[0]!,
    );
    expect(lifecycle.disposeCalls).toBe(1);
  });

  it("cancels a root waiting for workers even when drain never settles", async () => {
    const root = await createRoot();
    const interrupt = vi.fn();
    const stopAgents = vi.fn(async () => undefined);
    let drainSignal: AbortSignal | undefined;
    const result = await runVNextPiTurn(
      {
        resourceWorkspaceDirectory: root.workspace,
        sessionDirectory: root.sessions,
        agentDir: root.agentDir,
        modelRuntime,
        model,
        thinkingLevel: "max",
        prompt: "Investigate with a worker.",
        tools,
        timeoutMs: 5,
        collaboration: {
          bindRoot: () => undefined,
          drain: (signal) => {
            drainSignal = signal;
            return new Promise(() => undefined);
          },
          interrupt,
          stopAgents,
          describeAgents: () => "worker-1 running",
        },
      },
      { createSession: fakeSessionFactory([]) },
    );
    expect(result.status).toBe("timed_out");
    expect(drainSignal?.aborted).toBe(true);
    expect(interrupt).toHaveBeenCalledOnce();
    expect(stopAgents).toHaveBeenCalledOnce();
  });

  it("retains a failed continuation even when stopping the team changes the Session or fails", async () => {
    const root = await createRoot();
    let control: RootPiSessionControl | undefined;
    const stopAgents = vi.fn(() =>
      Promise.reject(new Error("worker cleanup failed")),
    );
    const result = await runVNextPiTurn(
      {
        resourceWorkspaceDirectory: root.workspace,
        sessionDirectory: root.sessions,
        agentDir: root.agentDir,
        modelRuntime,
        model,
        thinkingLevel: "max",
        prompt: "Investigate with workers.",
        tools,
        collaboration: {
          bindRoot: (value) => {
            control = value;
          },
          drain: async () => {
            await control!.deliver("Worker result");
          },
          interrupt: vi.fn(),
          stopAgents,
          describeAgents: () => "worker running",
        },
      },
      {
        createSession: async (options) => {
          const created = await fakeSessionFactory([])(options);
          let messages: readonly unknown[] = created.session.messages;
          Object.defineProperty(created.session, "messages", {
            get: () => messages,
          });
          created.session.sendCustomMessage = () => {
            messages = [
              {
                role: "assistant",
                stopReason: "error",
                errorMessage: "Provider retries exhausted",
                content: [],
              },
            ];
            return Promise.resolve();
          };
          created.session.abort = () => {
            messages = [
              { role: "assistant", stopReason: "aborted", content: [] },
            ];
            return Promise.resolve();
          };
          return created;
        },
      },
    );
    expect(stopAgents).toHaveBeenCalledOnce();
    expect(result.status).toBe("provider_failed");
    expect(result.errorMessage).toContain("Provider retries exhausted");
    expect(result.errorMessage).toContain("worker cleanup failed");
  });

  it("describes game resources and observation limits without a tool workflow", () => {
    expect(VNEXT_ENVIRONMENT_APPENDIX).toMatch(/task-owned resource IDs/u);
    expect(VNEXT_ENVIRONMENT_APPENDIX).toMatch(/coverage/u);
    expect(VNEXT_ENVIRONMENT_APPENDIX).toMatch(/fidelity/u);
    expect(VNEXT_ENVIRONMENT_APPENDIX).toMatch(/loss/u);
    expect(VNEXT_ENVIRONMENT_APPENDIX).toMatch(/recoverable tool results/u);
    expect(VNEXT_ENVIRONMENT_APPENDIX).not.toMatch(
      /call first|only after|exactly once|must .* before|diagnos|caus|verdict|proposal|claim/iu,
    );
  });

  it("provides a coding-only appendix without game or semantic runtime affordances", async () => {
    expect(VNEXT_CODING_ENVIRONMENT_APPENDIX).toMatch(
      /task workspace shown as your current working directory/u,
    );
    expect(VNEXT_CODING_ENVIRONMENT_APPENDIX).toMatch(
      /checks you actually ran/u,
    );
    expect(VNEXT_CODING_ENVIRONMENT_APPENDIX).not.toMatch(
      /ChronoRift|game|runtime|observation|resource IDs|checkpoint|capture|control/iu,
    );
    const root = await createRoot();
    const captures: CreateAgentSessionOptions[] = [];

    await runVNextPiTurn(
      {
        resourceWorkspaceDirectory: root.workspace,
        sessionDirectory: root.sessions,
        agentDir: root.agentDir,
        modelRuntime,
        model,
        thinkingLevel: "max",
        prompt: "Investigate and fix the project bug.",
        tools,
        environmentProfile: "coding",
      },
      { createSession: fakeSessionFactory(captures) },
    );

    expect(captures[0]?.resourceLoader?.getAppendSystemPrompt()).toEqual([
      VNEXT_CODING_ENVIRONMENT_APPENDIX,
    ]);
  });

  it("keeps Pi's Loop, resources, and persistence while exposing only the declared tools", async () => {
    const root = await createRoot();
    const captures: CreateAgentSessionOptions[] = [];
    const events: AgentSessionEvent[] = [];
    const result = await runVNextPiTurn(
      {
        resourceWorkspaceDirectory: root.workspace,
        sessionDirectory: root.sessions,
        agentDir: root.agentDir,
        modelRuntime,
        model,
        thinkingLevel: "max",
        prompt: "Investigate and fix the timing bug.",
        tools,
        providerRequestTimeoutMs: 60_000,
        agentRetryMaxRetries: 1,
        transport: "sse",
        onEvent: (event) => events.push(event),
      },
      { createSession: fakeSessionFactory(captures) },
    );

    expect(result).toMatchObject({
      status: "completed",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      requestedThinkingLevel: "max",
      realizedThinkingLevel: "max",
      activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      assistantText: "Candidate ready; tests passed.",
      eventsObserved: 1,
      errorMessage: null,
    });
    expect(events).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      cwd: root.workspace,
      noTools: "all",
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    });
    expect(captures[0]?.resourceLoader?.getAppendSystemPrompt()).toContain(
      VNEXT_ENVIRONMENT_APPENDIX,
    );
    expect(captures[0]?.settingsManager?.getTransport()).toBe("sse");
    expect(captures[0]?.settingsManager?.getHttpIdleTimeoutMs()).toBe(60_000);
    expect(captures[0]?.settingsManager?.getRetrySettings()).toMatchObject({
      enabled: true,
      maxRetries: 1,
    });
    expect(captures[0]?.settingsManager?.getProviderRetrySettings()).toEqual({
      timeoutMs: 60_000,
      maxRetries: 0,
      maxRetryDelayMs: 1_000,
    });
    expect(captures[0]?.resourceLoader?.getAgentsFiles().agentsFiles).toEqual([
      expect.objectContaining({ content: "# Project guidance\n" }),
    ]);
  });

  it("uses the Host-selected durable Session identity for a new Project Environment turn", async () => {
    const root = await createRoot();
    const captures: CreateAgentSessionOptions[] = [];
    const result = await runVNextPiTurn(
      {
        resourceWorkspaceDirectory: root.workspace,
        sessionDirectory: root.sessions,
        newSessionId: "019ff4ae-576f-7a32-8969-b6dfb414befa",
        agentDir: root.agentDir,
        modelRuntime,
        model,
        thinkingLevel: "max",
        prompt: "Initialize the project environment.",
        tools,
      },
      { createSession: fakeSessionFactory(captures) },
    );

    expect(result.sessionId).toBe("019ff4ae-576f-7a32-8969-b6dfb414befa");
    expect(captures[0]?.sessionManager?.getSessionId()).toBe(result.sessionId);
  });

  it("opens the exact persisted session for a continuation turn", async () => {
    const root = await createRoot();
    const firstCaptures: CreateAgentSessionOptions[] = [];
    const first = await runVNextPiTurn(
      {
        resourceWorkspaceDirectory: root.workspace,
        sessionDirectory: root.sessions,
        agentDir: root.agentDir,
        modelRuntime,
        model,
        thinkingLevel: "max",
        prompt: "First turn",
        tools,
      },
      { createSession: fakeSessionFactory(firstCaptures) },
    );
    const continuedCaptures: CreateAgentSessionOptions[] = [];
    const continued = await runVNextPiTurn(
      {
        resourceWorkspaceDirectory: root.workspace,
        sessionDirectory: root.sessions,
        resumeSessionFile: first.sessionFile,
        agentDir: root.agentDir,
        modelRuntime,
        model,
        thinkingLevel: "max",
        prompt: "Continue from the evidence",
        tools,
      },
      { createSession: fakeSessionFactory(continuedCaptures) },
    );

    expect(continued.sessionId).toBe(first.sessionId);
    expect(continued.sessionFile).toBe(first.sessionFile);
    expect(continuedCaptures[0]?.sessionManager?.getCwd()).toBe(root.workspace);
  });

  it("aborts only for a turn timeout and reports the observed termination", async () => {
    const root = await createRoot();
    const captures: CreateAgentSessionOptions[] = [];
    const result = await runVNextPiTurn(
      {
        resourceWorkspaceDirectory: root.workspace,
        sessionDirectory: root.sessions,
        agentDir: root.agentDir,
        modelRuntime,
        model,
        thinkingLevel: "max",
        prompt: "Keep investigating",
        tools,
        timeoutMs: 5,
      },
      { createSession: fakeSessionFactory(captures, "wait-for-abort") },
    );

    expect(result).toMatchObject({
      status: "timed_out",
      assistantText: "Stopped",
      errorMessage: "Pi turn timed out after 5ms",
    });
  });

  it("unsubscribes and disposes the Pi session when prompt rejects", async () => {
    const root = await createRoot();
    const captures: CreateAgentSessionOptions[] = [];
    const lifecycle = { disposeCalls: 0, unsubscribeCalls: 0 };

    await expect(
      runVNextPiTurn(
        {
          resourceWorkspaceDirectory: root.workspace,
          sessionDirectory: root.sessions,
          agentDir: root.agentDir,
          modelRuntime,
          model,
          thinkingLevel: "max",
          prompt: "Initialize the environment",
          tools,
        },
        { createSession: fakeSessionFactory(captures, "reject", lifecycle) },
      ),
    ).rejects.toThrow("provider request failed");
    expect(lifecycle).toEqual({ disposeCalls: 1, unsubscribeCalls: 1 });
  });

  it.each([
    [{ providerRequestTimeoutMs: 0 }, "providerRequestTimeoutMs"],
    [{ providerRequestTimeoutMs: 600_001 }, "providerRequestTimeoutMs"],
    [{ agentRetryMaxRetries: -1 }, "agentRetryMaxRetries"],
    [{ agentRetryMaxRetries: 11 }, "agentRetryMaxRetries"],
  ] as const)(
    "rejects invalid provider request controls %#",
    async (controls, message) => {
      const root = await createRoot();
      await expect(
        runVNextPiTurn(
          {
            resourceWorkspaceDirectory: root.workspace,
            sessionDirectory: root.sessions,
            agentDir: root.agentDir,
            modelRuntime,
            model,
            thinkingLevel: "max",
            prompt: "Investigate the environment",
            tools,
            ...controls,
          },
          { createSession: fakeSessionFactory([]) },
        ),
      ).rejects.toThrow(message);
    },
  );
});
