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
import { afterEach, describe, expect, it } from "vitest";

import {
  PROJECT_ADAPTER_SKILL_V1_DIRECTORY,
  PROJECT_ADAPTER_SKILL_V1_NAME,
  runVNextPiTurn,
  VNEXT_ENVIRONMENT_APPENDIX,
  VNEXT_PI_WORKSPACE_CWD,
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
        Promise.resolve({ content: [{ type: "text" as const, text: "ok" }] }),
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
    let listener: ((event: AgentSessionEvent) => void) | undefined;
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
      prompt: () => {
        if (mode === "complete") {
          listener?.({ type: "tool_execution_end", isError: true } as never);
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
        listener = next;
        return () => {
          listener = undefined;
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
      cwd: VNEXT_PI_WORKSPACE_CWD,
      noTools: "all",
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    });
    expect(captures[0]?.resourceLoader?.getAppendSystemPrompt()).toContain(
      VNEXT_ENVIRONMENT_APPENDIX,
    );
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
    expect(continuedCaptures[0]?.sessionManager?.getCwd()).toBe(
      VNEXT_PI_WORKSPACE_CWD,
    );
  });

  it("adds the pinned Project Adapter skill without replacing normal Pi resources", async () => {
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
        prompt: "Author the project adapter candidate.",
        tools,
        loadProjectAdapterSkillV1: true,
      },
      { createSession: fakeSessionFactory(captures) },
    );

    const loader = captures[0]?.resourceLoader;
    expect(loader?.getSkills().skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: PROJECT_ADAPTER_SKILL_V1_NAME,
          baseDir: PROJECT_ADAPTER_SKILL_V1_DIRECTORY,
        }),
      ]),
    );
    expect(loader?.getAgentsFiles().agentsFiles).toEqual([
      expect.objectContaining({ content: "# Project guidance\n" }),
    ]);
    expect(loader?.getExtensions().extensions).toEqual([]);
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
});
