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
import type { Dispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import {
  PROJECT_ADAPTER_SKILL_V1_DIRECTORY,
  PROJECT_ADAPTER_SKILL_V1_NAME,
  VNextPiTurnFailure,
  runVNextPiTurn,
  runVNextPiTurnWithSdk,
  VNEXT_ENVIRONMENT_APPENDIX,
  VNEXT_PI_WORKSPACE_CWD,
  type VNextPiLifecycleEventV1,
  type VNextPiTurnResult,
} from "../src/index.js";
import { observeVNextPiHostHttpDispatchV1 } from "../src/internal/vnext-host-http-observation.js";

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
      observedTurnCount: 1,
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

  it("passes an explicit Host transport into Pi settings", async () => {
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
        transport: "sse",
        prompt: "Run the transport fixture.",
        tools,
      },
      { createSession: fakeSessionFactory(captures) },
    );

    expect(captures[0]?.settingsManager?.getTransport()).toBe("sse");
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

    const thrown = await runVNextPiTurn(
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
    ).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(VNextPiTurnFailure);
    expect((thrown as VNextPiTurnFailure).receipt.primaryFailure).toMatchObject(
      { stage: "agent_turn", category: "provider" },
    );
    expect(lifecycle).toEqual({ disposeCalls: 1, unsubscribeCalls: 1 });
  });

  it("emits only completed lifecycle milestones in their fixed order", async () => {
    const root = await createRoot();
    const captures: CreateAgentSessionOptions[] = [];
    const lifecycle: VNextPiLifecycleEventV1[] = [];

    await runVNextPiTurn(
      {
        resourceWorkspaceDirectory: root.workspace,
        sessionDirectory: root.sessions,
        agentDir: root.agentDir,
        modelRuntime,
        model,
        thinkingLevel: "max",
        prompt: "Initialize the environment",
        tools,
        onLifecycleEvent: (event) => lifecycle.push(event),
      },
      { createSession: fakeSessionFactory(captures) },
    );

    expect(lifecycle).toEqual([
      { schemaVersion: 1, ordinal: 5, stage: "resources_loaded" },
      { schemaVersion: 1, ordinal: 6, stage: "session_created" },
      { schemaVersion: 1, ordinal: 7, stage: "tools_activated" },
      { schemaVersion: 1, ordinal: 8, stage: "prompt_submitted" },
    ]);
  });

  it("retains a bounded sanitized primary failure before a turn starts", async () => {
    const root = await createRoot();
    const failure = Object.assign(
      new Error("cannot mkdir /pi-agent/auth.json.lock TOKEN_DO_NOT_RETAIN", {
        cause: new Error("nested /host/private/credential"),
      }),
      { code: "EROFS", syscall: "mkdir" },
    );

    const thrown = await runVNextPiTurn(
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
      {
        createSession: () => Promise.reject(failure),
      },
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(VNextPiTurnFailure);
    const receipt = (thrown as VNextPiTurnFailure).receipt;
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      stage: "session_create",
      primaryFailure: {
        category: "permission",
        errorName: "Error",
        platformCode: "EROFS",
        syscall: "mkdir",
      },
      cleanupFailures: [],
    });
    expect(receipt.lifecycle).toEqual([
      { schemaVersion: 1, ordinal: 5, stage: "resources_loaded" },
    ]);
    expect(receipt.primaryFailure?.messageSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.primaryFailure?.causeSha256s).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    ]);
    expect(JSON.stringify(receipt)).not.toMatch(
      /pi-agent|TOKEN_DO_NOT_RETAIN|host\/private/u,
    );
  });

  it("keeps prompt and cleanup failures separate", async () => {
    const root = await createRoot();
    const captures: CreateAgentSessionOptions[] = [];
    const factory = fakeSessionFactory(captures, "reject");

    const thrown = await runVNextPiTurn(
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
      {
        createSession: async (options) => {
          const created = await factory(options);
          const originalDispose = created.session.dispose.bind(created.session);
          created.session.dispose = (() => {
            originalDispose();
            throw Object.assign(new Error("cleanup /private/session"), {
              code: "EIO",
              syscall: "unlink",
            });
          }) as never;
          return created;
        },
      },
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(VNextPiTurnFailure);
    const receipt = (thrown as VNextPiTurnFailure).receipt;
    expect(receipt.stage).toBe("agent_turn");
    expect(receipt.primaryFailure?.category).toBe("provider");
    expect(receipt.cleanupFailures).toHaveLength(1);
    expect(receipt.cleanupFailures[0]).toMatchObject({
      category: "filesystem",
      platformCode: "EIO",
      syscall: "unlink",
    });
    expect(receipt.lifecycle.at(-1)?.stage).toBe("prompt_submitted");
    expect(JSON.stringify(receipt)).not.toContain("/private/session");
  });

  it("emits the complete SDK lifecycle without contacting a provider", async () => {
    const root = await createRoot();
    const lifecycle: VNextPiLifecycleEventV1[] = [];
    const runtime = {
      getAvailable: () => Promise.resolve([model]),
      getModel: () => model,
    } as unknown as ModelRuntime;

    const result = await runVNextPiTurnWithSdk(
      {
        resourceWorkspaceDirectory: root.workspace,
        sessionDirectory: root.sessions,
        agentDir: root.agentDir,
        provider: model.provider,
        model: model.id,
        thinkingLevel: "max",
        transport: "sse",
        prompt: "Initialize the environment",
        tools,
        onLifecycleEvent: (event) => lifecycle.push(event),
      },
      {
        configureTransport: () => undefined,
        createModelRuntime: () => Promise.resolve(runtime),
        runTurn: async (options) => {
          expect(options.transport).toBe("sse");
          for (const event of [
            { schemaVersion: 1, ordinal: 5, stage: "resources_loaded" },
            { schemaVersion: 1, ordinal: 6, stage: "session_created" },
            { schemaVersion: 1, ordinal: 7, stage: "tools_activated" },
            { schemaVersion: 1, ordinal: 8, stage: "prompt_submitted" },
          ] as const) {
            options.onLifecycleEvent?.(event);
          }
          return {
            schemaVersion: 1,
            status: "completed",
            sessionId: "session-fixture",
            sessionFile: "/session.jsonl",
            provider: model.provider,
            model: model.id,
            requestedThinkingLevel: "max",
            realizedThinkingLevel: "max",
            activeTools: tools.map((tool) => tool.name),
            assistantText: "done",
            errorMessage: null,
            eventsObserved: 0,
            observedTurnCount: 1,
            stats,
          };
        },
      },
    );

    expect(result.status).toBe("completed");
    const transportObservation = result.hostHttpTransportObservation;
    expect(transportObservation).toBeDefined();
    if (transportObservation === undefined) {
      throw new Error("SDK result omitted Host HTTP transport observation");
    }
    expect(transportObservation).toMatchObject({
      schemaVersion: 1,
      recordKind: "vnext-pi-host-http-transport-observation",
      requestStartedCount: 0,
      responseHeadersCount: 0,
      responseCompleteCount: 0,
      requestErrorCount: 0,
    });
    expect(transportObservation.recordContentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(lifecycle.map((event) => event.stage)).toEqual([
      "sdk_call_started",
      "model_runtime_created",
      "auth_availability_checked",
      "model_selected",
      "resources_loaded",
      "session_created",
      "tools_activated",
      "prompt_submitted",
    ]);
  });

  it("binds exact Host HTTP transport callbacks to the SDK result", async () => {
    const root = await createRoot();
    const runtime = {
      getAvailable: () => Promise.resolve([model]),
      getModel: () => model,
    } as unknown as ModelRuntime;
    const dispatch = observeVNextPiHostHttpDispatchV1((_options, handler) => {
      const controller = {} as Dispatcher.DispatchController;
      handler.onRequestStart?.(controller, null);
      handler.onResponseStart?.(controller, 200, {});
      handler.onResponseEnd?.(controller, {});
      return true;
    });

    const result = await runVNextPiTurnWithSdk(
      {
        resourceWorkspaceDirectory: root.workspace,
        sessionDirectory: root.sessions,
        agentDir: root.agentDir,
        provider: model.provider,
        model: model.id,
        thinkingLevel: "max",
        prompt: "Initialize the environment",
        tools,
      },
      {
        configureTransport: () => undefined,
        createModelRuntime: () => Promise.resolve(runtime),
        runTurn: async (): Promise<VNextPiTurnResult> => {
          dispatch(
            {
              origin: "https://provider.invalid",
              path: "/private",
              method: "POST",
              headers: { authorization: "DO_NOT_RETAIN" },
              body: "secret-body",
            },
            {},
          );
          return {
            schemaVersion: 1,
            status: "completed",
            sessionId: "session-fixture",
            sessionFile: "/session.jsonl",
            provider: model.provider,
            model: model.id,
            requestedThinkingLevel: "max",
            realizedThinkingLevel: "max",
            activeTools: tools.map((tool) => tool.name),
            assistantText: "done",
            errorMessage: null,
            eventsObserved: 0,
            observedTurnCount: 1,
            stats,
          };
        },
      },
    );

    expect(result.hostHttpTransportObservation).toMatchObject({
      requestStartedCount: 1,
      responseHeadersCount: 1,
      responseCompleteCount: 1,
      requestErrorCount: 0,
    });
    expect(JSON.stringify(result.hostHttpTransportObservation)).not.toMatch(
      /provider\.invalid|private|authorization|DO_NOT_RETAIN|secret-body/u,
    );
  });

  it("binds the same turn-scoped observation to a sanitized SDK failure", async () => {
    const root = await createRoot();
    const runtime = {
      getAvailable: () => Promise.resolve([model]),
      getModel: () => model,
    } as unknown as ModelRuntime;
    const dispatch = observeVNextPiHostHttpDispatchV1((_options, handler) => {
      const controller = {} as Dispatcher.DispatchController;
      handler.onRequestStart?.(controller, null);
      handler.onResponseError?.(
        controller,
        new Error("https://provider.invalid TOKEN_DO_NOT_RETAIN"),
      );
      return true;
    });

    const thrown = await runVNextPiTurnWithSdk(
      {
        resourceWorkspaceDirectory: root.workspace,
        sessionDirectory: root.sessions,
        agentDir: root.agentDir,
        provider: model.provider,
        model: model.id,
        thinkingLevel: "max",
        prompt: "Initialize the environment",
        tools,
      },
      {
        configureTransport: () => undefined,
        createModelRuntime: () => Promise.resolve(runtime),
        runTurn: async () => {
          dispatch(
            { path: "/private", method: "POST", body: "TOKEN_DO_NOT_RETAIN" },
            {},
          );
          throw new Error("provider request failed TOKEN_DO_NOT_RETAIN");
        },
      },
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(VNextPiTurnFailure);
    const receipt = (thrown as VNextPiTurnFailure).receipt;
    expect(receipt.hostHttpTransportObservation).toMatchObject({
      requestStartedCount: 1,
      responseHeadersCount: 0,
      responseCompleteCount: 0,
      requestErrorCount: 1,
    });
    expect(JSON.stringify(receipt)).not.toMatch(
      /provider\.invalid|private|TOKEN_DO_NOT_RETAIN/u,
    );
  });
});
