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
    mode: "complete" | "wait-for-abort" = "complete",
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
        };
      },
      dispose: () => undefined,
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
});
