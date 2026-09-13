import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import {
  SessionManager,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import type * as PiSdk from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runProjectEnvironmentInteractivePiSessionV1,
  type RunProjectEnvironmentInteractivePiSessionV1Options,
} from "../src/project-environment-interactive.js";
import type { VNextPiTurnResult } from "../src/vnext-session.js";

const sdk = vi.hoisted(() => ({
  run: vi.fn<(runtime: AgentSessionRuntime) => Promise<void>>(),
  stream: vi.fn<() => AssistantMessageEventStream>(() => {
    throw new Error("Interactive runtime regression must not call a provider");
  }),
}));

vi.mock("../src/vnext-host-http.js", () => ({
  configureVNextPiHostHttpTransport: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof PiSdk>();
  const model: Model<Api> = {
    provider: "fixture",
    id: "fixture-model",
    name: "Fixture",
    api: "openai-completions",
    baseUrl: "https://fixture.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 512,
  };
  return {
    ...actual,
    initTheme: vi.fn(),
    ModelRuntime: {
      create: async () => ({
        getModel: () => model,
        getAvailable: async () => [model],
        streamSimple: sdk.stream,
      }),
    },
    InteractiveMode: class {
      constructor(private readonly runtime: AgentSessionRuntime) {}

      run(): Promise<void> {
        return sdk.run(this.runtime);
      }
    },
  };
});

const roots: string[] = [];
const ttyDescriptors = [process.stdin, process.stdout].map((stream) => ({
  stream,
  descriptor: Object.getOwnPropertyDescriptor(stream, "isTTY"),
}));

beforeEach(() => {
  vi.clearAllMocks();
  for (const { stream } of ttyDescriptors) {
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  }
});

afterEach(async () => {
  for (const { stream, descriptor } of ttyDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(stream, "isTTY");
    else Object.defineProperty(stream, "isTTY", descriptor);
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const assistantMessage: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Saved investigation" }],
  api: "openai-completions",
  provider: "fixture",
  model: "fixture-model",
  usage: {
    input: 2,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
};

const createOptions = async (
  onShutdown: (result: VNextPiTurnResult) => Promise<void>,
): Promise<RunProjectEnvironmentInteractivePiSessionV1Options> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-interactive-runtime-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  return {
    resourceWorkspaceDirectory: workspace,
    sessionDirectory: join(root, "sessions"),
    expectedSessionId: "interactive-fixture",
    provider: "fixture",
    model: "fixture-model",
    thinkingLevel: "low",
    tools: [
      {
        name: "read",
        label: "Read",
        description: "Read fixture",
        parameters: Type.Object({}),
        execute: async () => ({ content: [], details: undefined }),
      },
    ],
    additionalEnvironmentInstructions: "Host fixture",
    agentDir,
    onShutdown,
  };
};

describe("Project Environment TUI native runtime replacement", () => {
  it("retains observed request timings across native runtime replacements", async () => {
    const onShutdown = vi.fn<(result: VNextPiTurnResult) => Promise<void>>(
      async () => undefined,
    );
    const completedStream = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: assistantMessage });
      return stream;
    };
    sdk.stream
      .mockImplementationOnce(completedStream)
      .mockImplementationOnce(completedStream);
    sdk.run.mockImplementation(async (runtime) => {
      for (let turn = 0; turn < 2; turn += 1) {
        const response = await runtime.session.agent.streamFunction(
          runtime.session.model as Model<Api>,
          { messages: [] },
        );
        await response.result();
        await runtime.newSession();
      }
    });
    await runProjectEnvironmentInteractivePiSessionV1(
      await createOptions(onShutdown),
    );
    const requests = onShutdown.mock.calls[0]![0].modelRequests!;
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((request) => request.requestId)).size).toBe(2);
    expect(requests.every((request) => request.outcome === "completed")).toBe(
      true,
    );
    expect(sdk.stream).toHaveBeenCalledTimes(2);
  });

  it("retains an unwritten Task Session through /new and reopens it after persistence", async () => {
    const onShutdown = vi.fn<(result: VNextPiTurnResult) => Promise<void>>(
      async () => undefined,
    );
    const options = await createOptions(onShutdown);
    let pinnedFile: string | undefined;
    sdk.run.mockImplementation(async (runtime) => {
      const initialSession = runtime.session;
      const initialManager = initialSession.sessionManager;
      pinnedFile = initialManager.getSessionFile();
      expect(pinnedFile).toBeDefined();
      expect(existsSync(pinnedFile!)).toBe(false);
      const dispose = vi.spyOn(initialSession, "dispose");

      await expect(runtime.newSession()).resolves.toEqual({
        cancelled: false,
      });
      expect(runtime.session).not.toBe(initialSession);
      expect(runtime.session.sessionManager).toBe(initialManager);
      expect(runtime.session.messages).toEqual([]);
      expect(existsSync(pinnedFile!)).toBe(false);
      initialManager.appendMessage({
        role: "user",
        content: "Pending investigation",
        timestamp: 0,
      });

      for (let replacement = 0; replacement < 2; replacement += 1) {
        await expect(runtime.newSession()).resolves.toEqual({
          cancelled: false,
        });
        expect(runtime.session).not.toBe(initialSession);
        expect(runtime.session.sessionManager).toBe(initialManager);
        expect(runtime.session.sessionId).toBe(options.expectedSessionId);
        expect(runtime.session.sessionFile).toBe(pinnedFile);
        expect(runtime.session.messages).toEqual([
          expect.objectContaining({
            role: "user",
            content: "Pending investigation",
          }),
        ]);
        expect(runtime.session.getActiveToolNames()).toEqual(["read"]);
        expect(existsSync(pinnedFile!)).toBe(false);
      }
      expect(dispose).toHaveBeenCalledTimes(1);
      initialManager.appendMessage(assistantMessage);
      expect(existsSync(pinnedFile!)).toBe(true);

      await runtime.newSession();
      expect(runtime.session.sessionManager).not.toBe(initialManager);
      expect(runtime.session.sessionId).toBe(options.expectedSessionId);
      expect(runtime.session.sessionFile).toBe(pinnedFile);
      expect(runtime.session.messages).toHaveLength(2);
      expect(onShutdown).not.toHaveBeenCalled();
    });

    const realizedFile =
      await runProjectEnvironmentInteractivePiSessionV1(options);
    expect(realizedFile).toBe(pinnedFile);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onShutdown.mock.calls[0]![0].assistantText).toBe(
      "Saved investigation",
    );
    expect(onShutdown.mock.calls[0]![0].stats.tokens.total).toBe(5);
    expect(sdk.stream).not.toHaveBeenCalled();
  });

  it("keeps an existing Task Session file and history when /new rebuilds the runtime", async () => {
    const onShutdown = vi.fn<(result: VNextPiTurnResult) => Promise<void>>(
      async () => undefined,
    );
    const options = await createOptions(onShutdown);
    const manager = SessionManager.create(
      options.resourceWorkspaceDirectory,
      options.sessionDirectory,
      { id: options.expectedSessionId },
    );
    manager.appendModelChange(options.provider, options.model);
    manager.appendThinkingLevelChange(options.thinkingLevel);
    manager.appendMessage(assistantMessage);
    const sessionFile = manager.getSessionFile()!;
    const original = await readFile(sessionFile, "utf8");
    sdk.run.mockImplementation(async (runtime) => {
      const initialManager = runtime.session.sessionManager;
      await runtime.newSession();
      expect(runtime.session.sessionManager).not.toBe(initialManager);
      expect(runtime.session.sessionId).toBe(options.expectedSessionId);
      expect(runtime.session.sessionFile).toBe(sessionFile);
      expect(runtime.session.messages).toEqual([assistantMessage]);
      expect(runtime.session.getActiveToolNames()).toEqual(["read"]);
      expect(onShutdown).not.toHaveBeenCalled();
    });

    await expect(
      runProjectEnvironmentInteractivePiSessionV1({ ...options, sessionFile }),
    ).resolves.toBe(sessionFile);
    expect(await readFile(sessionFile, "utf8")).toBe(original);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onShutdown.mock.calls[0]![0].assistantText).toBe(
      "Saved investigation",
    );
    expect(sdk.stream).not.toHaveBeenCalled();
  });
});
