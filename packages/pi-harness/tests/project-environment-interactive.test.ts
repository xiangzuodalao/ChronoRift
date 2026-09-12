import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentSession,
  AgentSessionEvent,
  CreateAgentSessionFromServicesOptions,
  ExtensionContext,
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
  run: vi.fn<() => Promise<void>>(),
  dispose: vi.fn<() => Promise<void>>(),
  abort: vi.fn<() => Promise<void>>(),
  session: undefined as unknown as AgentSession,
  created: undefined as CreateAgentSessionFromServicesOptions | undefined,
  listener: undefined as ((event: AgentSessionEvent) => void) | undefined,
}));

vi.mock("../src/vnext-host-http.js", () => ({
  configureVNextPiHostHttpTransport: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof PiSdk>();
  return {
    ...actual,
    initTheme: vi.fn(),
    ModelRuntime: {
      create: async () => ({
        getModel: () => ({ provider: "fixture", id: "fixture-model" }),
        getAvailable: async () => [{ id: "fixture-model" }],
      }),
    },
    createAgentSessionFromServices: async (
      options: CreateAgentSessionFromServicesOptions,
    ) => {
      sdk.created = options;
      Object.assign(sdk.session, {
        sessionId: options.sessionManager.getSessionId(),
        sessionFile: options.sessionManager.getSessionFile(),
      });
      return {
        session: sdk.session,
        extensionsResult: options.services.resourceLoader.getExtensions(),
      };
    },
    createAgentSessionRuntime: async (factory: () => Promise<unknown>) => {
      await factory();
      return { dispose: sdk.dispose };
    },
    InteractiveMode: class {
      run(): Promise<void> {
        return sdk.run();
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
  sdk.created = undefined;
  sdk.listener = undefined;
  sdk.run.mockResolvedValue(undefined);
  sdk.dispose.mockResolvedValue(undefined);
  sdk.abort.mockResolvedValue(undefined);
  sdk.session = {
    model: { provider: "fixture", id: "fixture-model" },
    thinkingLevel: "low",
    isIdle: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Final interactive investigation" }],
        stopReason: "stop",
      },
    ],
    clearQueue: vi.fn(),
    abortCompaction: vi.fn(),
    abortBranchSummary: vi.fn(),
    abort: sdk.abort,
    dispose: vi.fn(),
    getActiveToolNames: () => ["read"],
    getSessionStats: () => ({
      sessionId: "interactive-fixture",
      sessionFile: "/session.jsonl",
      userMessages: 3,
      assistantMessages: 4,
      toolCalls: 2,
      toolResults: 2,
      totalMessages: 9,
      tokens: { input: 40, output: 20, cacheRead: 4, cacheWrite: 0, total: 64 },
      cost: 0.25,
    }),
    subscribe: (listener: (event: AgentSessionEvent) => void) => {
      sdk.listener = listener;
      return () => {
        sdk.listener = undefined;
      };
    },
  } as unknown as AgentSession;
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

const createOptions = async (
  onShutdown: (result: VNextPiTurnResult) => Promise<void>,
): Promise<RunProjectEnvironmentInteractivePiSessionV1Options> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-interactive-pi-"));
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

const emitShutdown = async (reason: "quit" | "new"): Promise<void> => {
  const extensions = sdk.created!.services.resourceLoader.getExtensions();
  for (const extension of extensions.extensions) {
    for (const handler of extension.handlers.get("session_shutdown") ?? []) {
      await handler(
        { type: "session_shutdown", reason },
        {} as ExtensionContext,
      );
    }
  }
};

describe("Project Environment TUI Host shutdown", () => {
  it("awaits one final snapshot before Pi exits, including without multi agent", async () => {
    const order: string[] = [];
    const onShutdown = vi.fn(async (result: VNextPiTurnResult) => {
      expect(result.assistantText).toBe("Final interactive investigation");
      expect(result.stats.tokens.total).toBe(64);
      expect(result.eventsObserved).toBe(1);
      await Promise.resolve();
      order.push("host-finalized");
    });
    sdk.run.mockImplementation(async () => {
      const extensions = sdk.created!.services.resourceLoader.getExtensions();
      expect(extensions.extensions).toHaveLength(1);
      expect(extensions.extensions[0]!.commands.size).toBe(0);
      sdk.listener!({ type: "agent_start" });
      await emitShutdown("new");
      expect(onShutdown).not.toHaveBeenCalled();
      await emitShutdown("quit");
      order.push("pi-exit");
    });
    await runProjectEnvironmentInteractivePiSessionV1(
      await createOptions(onShutdown),
    );
    expect(order).toEqual(["host-finalized", "pi-exit"]);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(sdk.dispose).toHaveBeenCalledTimes(1);
    expect(sdk.listener).toBeUndefined();
  });

  it("finalizes once when an injected TUI returns without emitting quit", async () => {
    const onShutdown = vi.fn<(result: VNextPiTurnResult) => Promise<void>>(
      async () => undefined,
    );
    sdk.dispose.mockImplementation(async () => {
      await emitShutdown("quit");
    });
    await runProjectEnvironmentInteractivePiSessionV1(
      await createOptions(onShutdown),
    );
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onShutdown.mock.calls[0]![0].stats.toolCalls).toBe(2);
    expect(sdk.abort).toHaveBeenCalledTimes(1);
  });

  it("reports cleanup failures to Host finalization and still disposes the runtime", async () => {
    const onShutdown = vi.fn<(result: VNextPiTurnResult) => Promise<void>>(
      async () => undefined,
    );
    sdk.abort.mockRejectedValue(new Error("Root cancellation failed"));
    const options = await createOptions(onShutdown);
    await expect(
      runProjectEnvironmentInteractivePiSessionV1(options),
    ).rejects.toThrow("Pi collaboration cleanup failed");
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onShutdown.mock.calls[0]![0].status).toBe("aborted");
    expect(onShutdown.mock.calls[0]![0].errorMessage).toContain(
      "Root cancellation failed",
    );
    expect(sdk.dispose).toHaveBeenCalledTimes(1);
    expect(sdk.listener).toBeUndefined();
  });
});
