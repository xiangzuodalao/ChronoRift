import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PiCollaborationMessage,
  PiSessionForkContext,
  RootPiSessionControl,
  VNextPiTurnResult,
} from "@chronorift/pi-harness";
import {
  AgentSupervisor,
  createAgentSupervisorTools,
  type AgentResource,
  type AgentSpawnPolicy,
} from "./agent-supervisor.js";
import type { AgentHostMessage, AgentWorkerMessage } from "./agent-ipc.js";
import type { AgentWorkerClientOptions } from "./agent-worker-client.js";

const piResult = (
  session = "fixture",
  text = "Investigated",
): VNextPiTurnResult => ({
  schemaVersion: 1,
  status: "completed",
  sessionId: session,
  sessionFile: `/host/${session}.jsonl`,
  provider: "fixture",
  model: "fixture",
  requestedThinkingLevel: "off",
  realizedThinkingLevel: "off",
  activeTools: ["read"],
  assistantText: text,
  errorMessage: null,
  eventsObserved: 1,
  stats: {
    sessionFile: `/host/${session}.jsonl`,
    sessionId: session,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: 0.1,
  },
});
const forkContext: PiSessionForkContext = {
  schemaVersion: 1,
  parentSessionId: "root-session",
  forkTurns: "all",
  messages: [{ role: "user", text: "Original symptom", turnStart: true }],
};

function fixture(
  options: {
    maxAgents?: number;
    turnTimeoutMs?: number;
    interruptGraceMs?: number;
    cooperative?: boolean;
    acceptTask?: boolean;
    beforeResourceReady?: () => Promise<void>;
    spawnPolicy?: AgentSpawnPolicy;
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
              description: "Read",
              parameters: { type: "object" },
            },
            {
              name: "game_stop",
              description: "Stop",
              parameters: { type: "object" },
            },
          ],
        },
        invokeTool: vi.fn(async () => ({
          content: [{ type: "text" as const, text: "observed" }],
        })),
        finishTurn: vi.fn(async (turnId: number) => ({
          execution: `execution-${turnId}`,
        })),
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
          if (message.type === "interrupt" && options.cooperative !== false)
            queueMicrotask(() =>
              workerOptions.onMessage({
                version: 2,
                type: "completed",
                turnId: message.turnId,
                result: {
                  ...piResult(workerOptions.configuration.agentId),
                  status: "aborted",
                },
              }),
            );
          if (message.type === "collaboration")
            workerOptions.onMessage({
              version: 2,
              type: "collaboration_accepted",
              requestId: message.requestId,
              acceptedInCurrentTurn:
                message.envelope.kind === "task" &&
                options.acceptTask !== false,
            });
          if (message.type === "export_context")
            workerOptions.onMessage({
              version: 2,
              type: "context_exported",
              requestId: message.requestId,
              context: {
                ...forkContext,
                parentSessionId:
                  workerOptions.configuration.agentId ?? "worker",
                forkTurns: message.forkTurns,
              },
            });
        },
        close: worker.close,
      };
    },
  });
  const emit = (index: number, message: AgentWorkerMessage) =>
    workers[index]!.options.onMessage(message);
  const complete = (index: number, turnId = 1, text?: string) =>
    emit(index, {
      version: 2,
      type: "completed",
      turnId,
      result: piResult(workers[index]!.options.configuration.agentId, text),
    });
  const spawn = (taskName: string, caller = "/root") =>
    supervisor.spawnAgent(
      `Investigate ${taskName}`,
      { taskName, forkTurns: "none" },
      caller,
    );
  const rootMessages: PiCollaborationMessage[] = [];
  let consumption: (ids: readonly string[]) => void = () => undefined;
  let activity: () => void = () => undefined;
  const rootAbort = vi.fn(async () => undefined);
  const rootDeliver = vi.fn(async (message: PiCollaborationMessage) => {
    rootMessages.push(message);
    activity();
    return "next-turn" as const;
  });
  const rootExport = vi.fn((selected: string) => ({
    ...forkContext,
    forkTurns: selected,
  }));
  const root: RootPiSessionControl = {
    isIdle: () => true,
    collaborationPhase: "idle",
    abort: rootAbort,
    deliver: rootDeliver,
    exportForkContext: rootExport,
    hasPendingMessages: () => rootMessages.length > 0,
    subscribeActivity: (listener) => {
      activity = listener;
      return () => {
        activity = () => undefined;
      };
    },
    subscribeConsumption: (listener) => {
      consumption = listener;
      return () => {
        consumption = () => undefined;
      };
    },
    subscribeCollaborationPhase: () => () => undefined,
    onUserInput: vi.fn(),
  };
  const consumeRoot = () => {
    consumption(rootMessages.splice(0).map((message) => message.id));
  };
  return {
    supervisor,
    workers,
    resources,
    emit,
    complete,
    spawn,
    root,
    rootMessages,
    consumeRoot,
    rootAbort,
    rootDeliver,
    rootExport,
  };
}
afterEach(() => vi.useRealTimers());

describe("Host spawn policy", () => {
  const lockedRuntime = {
    provider: "pinned-provider",
    model: "pinned-model",
    thinkingLevel: "max" as const,
  };

  it("copies and freezes the effective policy while leaving ordinary V2 unrestricted", async () => {
    const policy = {
      maxCreatedAgents: 3,
      maxDepth: 1,
      lockedRuntime: { ...lockedRuntime },
    };
    const f = fixture({ spawnPolicy: policy });
    policy.maxCreatedAgents = 99;
    policy.lockedRuntime.model = "changed";
    expect(f.supervisor.effectiveSpawnPolicy).toEqual({
      maxCreatedAgents: 3,
      maxDepth: 1,
      lockedRuntime,
    });
    expect(Object.isFrozen(f.supervisor.effectiveSpawnPolicy)).toBe(true);
    expect(
      Object.isFrozen(f.supervisor.effectiveSpawnPolicy?.lockedRuntime),
    ).toBe(true);
    await f.supervisor.close();
    const ordinary = fixture();
    try {
      expect(ordinary.supervisor.effectiveSpawnPolicy).toBeNull();
      const first = await ordinary.supervisor.spawnAgent("First", {
        taskName: "a",
        forkTurns: "none",
        model: "other",
        reasoningEffort: "high",
      });
      expect(ordinary.workers[0]!.options.configuration).toMatchObject({
        model: "other",
        thinkingLevel: "high",
      });
      const second = await ordinary.spawn("child", first.agentId);
      const third = await ordinary.spawn("grandchild", second.agentId);
      ordinary.complete(2);
      await ordinary.supervisor.waitForTurns([third]);
      await ordinary.spawn("fourth_identity");
      expect(ordinary.supervisor.listAllAgents()).toHaveLength(4);
    } finally {
      await ordinary.supervisor.close();
    }
  });

  it("removes forbidden overrides from Root and worker tools and rejects bypasses before allocation", async () => {
    const f = fixture({
      spawnPolicy: { maxCreatedAgents: 3, maxDepth: 1, lockedRuntime },
    });
    f.supervisor.bindRoot(f.root);
    try {
      const rootSpawn = createAgentSupervisorTools(f.supervisor).find(
        (tool) => tool.name === "spawn_agent",
      );
      expect(rootSpawn?.parameters).not.toHaveProperty("properties.model");
      expect(rootSpawn?.parameters).not.toHaveProperty(
        "properties.reasoning_effort",
      );
      expect(rootSpawn?.parameters).toHaveProperty("properties.fork_turns");
      for (const forbidden of [
        { model: "inherit" },
        { model: lockedRuntime.model },
        { reasoning_effort: "high" },
        { reasoning_effort: "max" },
      ])
        await expect(
          f.supervisor.invokeCollaboration("spawn_agent", {
            task_name: "a",
            message: "Task",
            ...forbidden,
          }),
        ).rejects.toThrow();
      for (const forbidden of [
        { model: "inherit" },
        { model: lockedRuntime.model },
        { reasoningEffort: "high" as const },
      ])
        await expect(
          f.supervisor.spawnAgent("Task", { taskName: "a", ...forbidden }),
        ).rejects.toThrow("Host spawn policy");
      expect(f.supervisor.listAllAgents()).toEqual([]);
      expect(f.resources).toEqual([]);
      expect(f.workers).toEqual([]);
      expect(f.supervisor.messages).toEqual([]);
      expect(f.rootExport).not.toHaveBeenCalled();
      await f.spawn("a");
      const workerSpawn = f.workers[0]!.options.configuration.tools.find(
        (tool) => tool.name === "spawn_agent",
      );
      expect(workerSpawn?.parameters).not.toHaveProperty("properties.model");
      expect(workerSpawn?.parameters).not.toHaveProperty(
        "properties.reasoning_effort",
      );
      expect(f.workers[0]!.options.configuration).toMatchObject(lockedRuntime);
    } finally {
      await f.supervisor.close();
    }
  });

  it("admits only one concurrent request for the final identity quota", async () => {
    const f = fixture({ maxAgents: 4, spawnPolicy: { maxCreatedAgents: 3 } });
    try {
      await f.spawn("first");
      await f.spawn("second");
      const results = await Promise.allSettled([
        f.spawn("third"),
        f.spawn("fourth"),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      expect(f.resources).toHaveLength(3);
      expect(f.supervisor.listAllAgents()).toHaveLength(3);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.reason).toBeInstanceOf(Error);
    } finally {
      await f.supervisor.close();
    }
  });

  it("counts completed, closed and evicted identities but permits followup and reload", async () => {
    const f = fixture({
      maxAgents: 1,
      spawnPolicy: { maxCreatedAgents: 3, maxDepth: 1, lockedRuntime },
    });
    try {
      const first = await f.spawn("a");
      f.complete(0);
      await f.supervisor.waitForTurns([first]);
      const second = await f.spawn("b");
      f.complete(1);
      await f.supervisor.waitForTurns([second]);
      await f.supervisor.closeAgent(second.agentId);
      const third = await f.spawn("c");
      f.complete(2);
      await f.supervisor.waitForTurns([third]);
      expect(f.supervisor.listAllAgents()[0]?.resident).toBe(false);
      await expect(f.spawn("replacement")).rejects.toThrow(
        "at most 3 created agent identities",
      );
      expect(f.resources).toHaveLength(3);
      const resumed = await f.supervisor.followupTask(
        first.agentId,
        "Continue existing identity",
      );
      expect(resumed.agentId).toBe(first.agentId);
      expect(resumed.turnId).toBe(2);
      expect(f.resources).toHaveLength(3);
      expect(f.workers[3]!.options.configuration).toMatchObject({
        ...lockedRuntime,
        resumeSessionFile: `/host/${first.agentId}.jsonl`,
      });
    } finally {
      await f.supervisor.close();
    }
  });

  it("counts allocated startup failures and rejects recursive children before resource or fork work", async () => {
    const failed = fixture({
      spawnPolicy: { maxCreatedAgents: 1 },
      beforeResourceReady: async () => {
        throw new Error("Startup failed");
      },
    });
    try {
      await expect(failed.spawn("a")).rejects.toThrow("Startup failed");
      await expect(failed.spawn("replacement")).rejects.toThrow(
        "at most 1 created agent identities",
      );
      expect(failed.resources).toHaveLength(1);
      expect(failed.supervisor.listAllAgents()).toHaveLength(1);
    } finally {
      await failed.supervisor.close();
    }
    const limited = fixture({ spawnPolicy: { maxDepth: 1 } });
    try {
      const parent = await limited.spawn("a");
      await expect(
        limited.supervisor.spawnAgent(
          "Nested",
          { taskName: "child" },
          parent.agentId,
        ),
      ).rejects.toThrow("maximum agent depth of 1");
      expect(limited.resources).toHaveLength(1);
      expect(limited.supervisor.listAllAgents()).toHaveLength(1);
      expect(
        limited.workers[0]!.sent.some(
          (message) => message.type === "export_context",
        ),
      ).toBe(false);
    } finally {
      await limited.supervisor.close();
    }
  });

  it("leaves all, none, and recent-turn context selection under Pi control", async () => {
    const f = fixture({
      spawnPolicy: { maxCreatedAgents: 3, maxDepth: 1, lockedRuntime },
    });
    f.supervisor.bindRoot(f.root);
    try {
      await f.supervisor.spawnAgent("Default fork", { taskName: "a" });
      await f.supervisor.spawnAgent("No fork", {
        taskName: "b",
        forkTurns: "none",
      });
      await f.supervisor.spawnAgent("Recent fork", {
        taskName: "c",
        forkTurns: "2",
      });
      expect(f.rootExport.mock.calls.map((call) => call[0])).toEqual([
        "all",
        "2",
      ]);
      expect(f.workers[1]!.options.configuration.forkContext).toBeUndefined();
      for (const worker of f.workers)
        expect(worker.options.configuration).toMatchObject(lockedRuntime);
    } finally {
      await f.supervisor.close();
    }
  });

  it("validates Host policy limits and permits an explicit zero-identity cap", async () => {
    for (const policy of [
      { maxCreatedAgents: -1 },
      { maxDepth: 1.5 },
      { maxCreatedAgents: Infinity },
      { lockedRuntime: { ...lockedRuntime, model: "" } },
    ])
      expect(() => fixture({ spawnPolicy: policy })).toThrow();
    const f = fixture({ spawnPolicy: { maxCreatedAgents: 0 } });
    await expect(f.spawn("forbidden")).rejects.toThrow(
      "at most 0 created agent identities",
    );
    expect(f.resources).toEqual([]);
    await f.supervisor.close();
  });
});

describe("MultiAgentV2 supervisor", () => {
  it("delivers the adaptive policy to Root tools and each worker without spawning by default", async () => {
    const f = fixture();
    try {
      const rootTools = createAgentSupervisorTools(f.supervisor);
      const rootSpawn = rootTools.find((tool) => tool.name === "spawn_agent");
      expect(rootSpawn?.promptGuidelines?.join("\n")).toMatch(
        /zero workers.*independently completable/su,
      );
      expect(rootSpawn?.promptGuidelines?.join("\n")).toContain(
        "Do not fully repeat a completed investigation with concrete evidence",
      );
      expect(rootSpawn?.promptGuidelines?.join("\n")).toContain(
        "A worker suggesting an alternative alone is not a reason to reopen a validated fix",
      );
      expect(f.workers).toEqual([]);
      expect(f.supervisor.listAllAgents()).toEqual([]);

      await f.spawn("inspect");
      const worker = f.workers[0]!.options.configuration;
      const workerSpawn = worker.tools.find(
        (tool) => tool.name === "spawn_agent",
      );
      expect(workerSpawn?.promptGuidelines).toEqual(
        rootSpawn?.promptGuidelines,
      );
      expect(worker.additionalEnvironmentInstructions).toContain(
        "conclusion, concrete evidence references, and uncovered items",
      );
      expect(worker.additionalEnvironmentInstructions).toContain(
        "do not also send the same result as a separate message or loop on wait_agent",
      );
      expect(worker.additionalEnvironmentInstructions).toContain(
        "resume you with followup_task",
      );
    } finally {
      await f.supervisor.close();
    }
  });

  it("exposes exactly six collaboration tools to Root and workers", async () => {
    const f = fixture();
    try {
      await f.spawn("inspect");
      const expected = [
        "spawn_agent",
        "list_agents",
        "send_message",
        "followup_task",
        "wait_agent",
        "interrupt_agent",
      ];
      expect(
        createAgentSupervisorTools(f.supervisor).map((tool) => tool.name),
      ).toEqual(expected);
      expect(
        f.workers[0]!.options.configuration.tools.map((tool) => tool.name),
      ).toEqual(["read", "game_stop", ...expected]);
    } finally {
      await f.supervisor.close();
    }
  });
  it("routes UUIDs, local descendants and canonical sibling paths without global short-name lookup", async () => {
    const f = fixture();
    try {
      const first = await f.spawn("a");
      const nested = await f.spawn("child", first.agentId);
      const sibling = await f.spawn("b");
      expect(nested.taskName).toBe("/root/a/child");
      expect(first.agentId).toMatch(/^[0-9a-f-]{36}$/u);
      await f.supervisor.sendMessage("child", "Local finding", first.agentId);
      await f.supervisor.sendMessage(
        "/root/a/child",
        "Sibling finding",
        sibling.agentId,
      );
      await f.supervisor.sendMessage(
        nested.agentId,
        "UUID finding",
        sibling.agentId,
      );
      expect(
        f.workers[1]!.sent.filter(
          (message) => message.type === "collaboration",
        ).map((message) => message.envelope.from),
      ).toEqual(["/root/a", "/root/b", "/root/b"]);
      await expect(
        f.supervisor.sendMessage("child", "Wrong path", sibling.agentId),
      ).rejects.toThrow("/root/b/child");
      await expect(
        f.supervisor.sendMessage("../a", "No traversal", sibling.agentId),
      ).rejects.toThrow();
      await expect(f.spawn("a")).rejects.toThrow("already exists");
    } finally {
      await f.supervisor.close();
    }
  });
  it("reserves capacity before asynchronous startup and waits for creation during shutdown", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({ maxAgents: 1, beforeResourceReady: () => gate });
    const spawning = f.spawn("first");
    const stopped = expect(spawning).rejects.toThrow("startup was cancelled");
    await expect(f.spawn("second")).rejects.toThrow("occupied");
    const closing = f.supervisor.close();
    expect(f.resources[0]!.close).not.toHaveBeenCalled();
    release();
    await stopped;
    await closing;
    expect(f.workers).toHaveLength(0);
    expect(f.resources[0]!.close).toHaveBeenCalled();
    expect(f.supervisor.listAllAgents()[0]?.state).toBe("closed");
  });
  it("fails recursive spawn promptly at the shared limit while wait retains its slot", async () => {
    const f = fixture({ maxAgents: 2 });
    const controller = new AbortController();
    try {
      const parent = await f.spawn("parent");
      await f.spawn("child", parent.agentId);
      const wait = f.supervisor.waitAgent(
        30_000,
        controller.signal,
        parent.agentId,
      );
      await expect(f.spawn("extra", parent.agentId)).rejects.toThrow(
        "occupied",
      );
      controller.abort(new Error("stop wait"));
      await expect(wait).rejects.toThrow("stop wait");
      expect(
        f.supervisor
          .listAllAgents()
          .every((agent) => agent.state === "running"),
      ).toBe(true);
    } finally {
      await f.supervisor.close();
    }
  });
  it("keeps busy followup in the same logical turn", async () => {
    const f = fixture();
    try {
      const first = await f.spawn("inspect");
      const next = await f.supervisor.followupTask(
        first.agentId,
        "Check input too",
      );
      expect(next.turnId).toBe(first.turnId);
      expect(
        f.workers[0]!.sent.filter((message) => message.type === "prompt"),
      ).toHaveLength(1);
      expect(
        f.workers[0]!.sent.find((message) => message.type === "collaboration"),
      ).toMatchObject({
        envelope: { kind: "task", from: "/root", to: "/root/inspect" },
      });
      f.complete(0);
      await f.supervisor.waitForTurns([first]);
      expect(f.supervisor.results).toHaveLength(1);
    } finally {
      await f.supervisor.close();
    }
  });
  it("admits one deferred turn when followups race the worker final boundary", async () => {
    const f = fixture({ maxAgents: 1, acceptTask: false });
    try {
      const first = await f.spawn("inspect");
      const next = await f.supervisor.followupTask(
        first.agentId,
        "First new task",
      );
      const same = await f.supervisor.followupTask(
        first.agentId,
        "Second new task",
      );
      expect(next.turnId).toBe(2);
      expect(same.turnId).toBe(2);
      await expect(f.spawn("other")).rejects.toThrow("occupied");
      f.complete(0);
      await vi.waitFor(() =>
        expect(
          f.workers[0]!.sent.filter((message) => message.type === "prompt"),
        ).toHaveLength(2),
      );
      expect(
        f.workers[0]!.sent.filter((message) => message.type === "prompt")[1]
          ?.text,
      ).toContain("Second new task");
      f.complete(0, 2);
      await f.supervisor.waitForTurns([next]);
    } finally {
      await f.supervisor.close();
    }
  });
  it("keeps idle messages queued without a prompt and resumes on explicit followup", async () => {
    const f = fixture();
    try {
      const first = await f.spawn("inspect");
      f.complete(0);
      await f.supervisor.waitForTurns([first]);
      await f.supervisor.sendMessage(first.agentId, "Information while idle");
      expect(
        f.workers[0]!.sent.filter((message) => message.type === "prompt"),
      ).toHaveLength(1);
      const second = await f.supervisor.followupTask(first.agentId, "Continue");
      expect(second.turnId).toBe(2);
      expect(
        f.workers[0]!.sent.filter((message) => message.type === "prompt"),
      ).toHaveLength(2);
    } finally {
      await f.supervisor.close();
    }
  });
  it("wakes for intermediate information without consuming or duplicating the body", async () => {
    const f = fixture();
    f.supervisor.bindRoot(f.root);
    try {
      const sender = await f.spawn("inspect");
      const waiting = f.supervisor.waitAgent();
      await f.supervisor.sendMessage(
        "/root",
        "The relevant scene is main",
        sender.agentId,
      );
      expect(await waiting).toEqual({
        message: "Mailbox activity is available.",
        timed_out: false,
      });
      await vi.waitFor(() => expect(f.rootMessages).toHaveLength(1));
      expect((await f.supervisor.waitAgent()).message).not.toContain("main");
      expect(f.rootDeliver).toHaveBeenCalledTimes(1);
      f.consumeRoot();
      expect(
        f.supervisor.messages.find(
          (record) => record.envelope.kind === "message",
        )?.consumedAt,
      ).not.toBeNull();
    } finally {
      await f.supervisor.close();
    }
  });
  it("wait handles user input, the minimum timeout, and cancellation independently", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const wait = f.supervisor.waitAgent(1);
      await vi.advanceTimersByTimeAsync(9_999);
      let settled = false;
      void wait.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await wait).toMatchObject({ timed_out: true });
      const steered = f.supervisor.waitAgent();
      f.supervisor.onUserInput();
      expect(await steered).toMatchObject({
        message: "Wait interrupted by new user input.",
      });
      const controller = new AbortController();
      const cancelled = f.supervisor.waitAgent(30_000, controller.signal);
      controller.abort(new Error("stop"));
      await expect(cancelled).rejects.toThrow("stop");
    } finally {
      await f.supervisor.close();
    }
  });
  it("evicts idle empty-mailbox residents but retains identity, history and the original session", async () => {
    const f = fixture({ maxAgents: 1 });
    try {
      const first = await f.spawn("a");
      f.complete(0);
      await f.supervisor.waitForTurns([first]);
      const second = await f.spawn("b");
      expect(f.workers[0]!.close).toHaveBeenCalledOnce();
      expect(f.resources[0]!.close).not.toHaveBeenCalled();
      expect(f.supervisor.listAllAgents()[0]).toMatchObject({
        agentId: first.agentId,
        resident: false,
        state: "idle",
      });
      f.complete(1);
      await f.supervisor.waitForTurns([second]);
      const followup = await f.supervisor.followupTask(
        first.agentId,
        "Return to earlier task",
      );
      expect(f.resources).toHaveLength(2);
      expect(f.workers[2]!.options.configuration).toMatchObject({
        agentId: first.agentId,
        taskName: "/root/a",
        resumeSessionFile: `/host/${first.agentId}.jsonl`,
      });
      expect(followup.turnId).toBe(2);
      expect(f.supervisor.results).toHaveLength(2);
      expect(
        (await f.supervisor.invokeCollaboration("list_agents", {})).details,
      ).toMatchObject({
        agents: [{ agent_name: "/root" }, { agent_name: "/root/a" }],
      });
    } finally {
      await f.supervisor.close();
    }
  });
  it("does not evict a worker with pending ordinary mail", async () => {
    const f = fixture({ maxAgents: 1 });
    try {
      const first = await f.spawn("a");
      f.complete(0);
      await f.supervisor.waitForTurns([first]);
      await f.supervisor.sendMessage(first.agentId, "Unread information");
      await expect(f.spawn("b")).rejects.toThrow("residency slots");
      expect(f.workers[0]!.close).not.toHaveBeenCalled();
      const mail = f.workers[0]!.sent.find(
        (message) => message.type === "collaboration",
      );
      if (mail?.type !== "collaboration") throw new Error("Missing mail");
      f.emit(0, {
        version: 2,
        type: "collaboration_consumed",
        ids: [mail.envelope.id],
      });
      await f.spawn("c");
      expect(f.workers[0]!.close).toHaveBeenCalledOnce();
    } finally {
      await f.supervisor.close();
    }
  });
  it("exports Root context by default and nested worker context with inherited model settings", async () => {
    const f = fixture();
    f.supervisor.bindRoot(f.root);
    try {
      const first = await f.supervisor.spawnAgent("Locate fault", {
        taskName: "a",
        model: "other",
        reasoningEffort: "high",
      });
      expect(f.rootExport).toHaveBeenCalledWith("all");
      expect(f.workers[0]!.options.configuration).toMatchObject({
        model: "other",
        thinkingLevel: "high",
        forkContext,
      });
      await f.supervisor.spawnAgent(
        "Inspect related scene",
        { taskName: "child", forkTurns: "2" },
        first.agentId,
      );
      expect(f.workers[1]!.options.configuration).toMatchObject({
        model: "other",
        thinkingLevel: "high",
        forkContext: { parentSessionId: first.agentId, forkTurns: "2" },
      });
      await expect(
        f.supervisor.spawnAgent("Bad fork", {
          taskName: "bad",
          forkTurns: "0",
        }),
      ).rejects.toThrow("positive integer");
    } finally {
      await f.supervisor.close();
    }
  });
  it("interrupts only the target, leaves descendants running, and rejects Root/self", async () => {
    const f = fixture();
    try {
      const parent = await f.spawn("parent");
      const child = await f.spawn("child", parent.agentId);
      await expect(f.supervisor.interruptAgent("/root")).rejects.toThrow(
        "not a spawned",
      );
      await expect(
        f.supervisor.interruptAgent(parent.agentId, parent.agentId),
      ).rejects.toThrow("itself");
      await expect(
        f.supervisor.followupTask("/root", "wake", child.agentId),
      ).rejects.toThrow("cannot target Root");
      expect(await f.supervisor.interruptAgent(parent.agentId)).toEqual({
        previous_status: "running",
      });
      expect(
        f.supervisor
          .listAllAgents()
          .find((agent) => agent.agentId === child.agentId)?.state,
      ).toBe("running");
      expect(
        (await f.supervisor.followupTask(parent.agentId, "Resume")).turnId,
      ).toBe(2);
    } finally {
      await f.supervisor.close();
    }
  });
  it("stops all writers after headless Root settles without restarting Root", async () => {
    const f = fixture();
    f.supervisor.bindRoot(f.root);
    const first = await f.spawn("a");
    await f.spawn("b");
    await f.supervisor.drain();
    expect(f.supervisor.results).toHaveLength(2);
    expect(
      f.supervisor.results.every((result) => result.status === "cancelled"),
    ).toBe(true);
    expect(f.rootAbort).not.toHaveBeenCalled();
    await expect(
      f.supervisor.followupTask(first.agentId, "Too late"),
    ).rejects.toThrow("admission is closed");
    await f.supervisor.close();
  });
  it("rejects unadvertised tools and ignores stale turn messages", async () => {
    const f = fixture();
    try {
      const first = await f.spawn("a");
      f.emit(0, {
        version: 2,
        type: "tool_request",
        turnId: 1,
        requestId: "forged",
        name: "hidden_host_tool",
        arguments: {},
      });
      await vi.waitFor(() =>
        expect(
          f.workers[0]!.sent.find(
            (message) =>
              message.type === "tool_result" && message.requestId === "forged",
          ),
        ).toMatchObject({ result: { isError: true } }),
      );
      f.complete(0);
      await f.supervisor.waitForTurns([first]);
      const next = await f.supervisor.followupTask(first.agentId, "Again");
      f.complete(0, 1, "Late duplicate");
      expect(f.supervisor.listAllAgents()[0]?.currentTurnId).toBe(next.turnId);
      expect(f.supervisor.results).toHaveLength(1);
    } finally {
      await f.supervisor.close();
    }
  });
  it("retains a client after close fails, blocks reuse, and retries Host cleanup", async () => {
    const f = fixture({ maxAgents: 1 });
    try {
      const first = await f.spawn("a");
      f.complete(0);
      await f.supervisor.waitForTurns([first]);
      f.workers[0]!.close.mockRejectedValueOnce(
        new Error("Process termination failed"),
      );
      await expect(f.supervisor.closeAgent(first.agentId)).rejects.toThrow(
        "Agent cleanup failed",
      );
      expect(f.supervisor.listAllAgents()[0]).toMatchObject({
        state: "failed",
        resident: true,
        cleanupBlocked: true,
      });
      await expect(
        f.supervisor.followupTask(first.agentId, "Do not reuse"),
      ).rejects.toThrow("cleanup is incomplete");
      await expect(f.spawn("b")).rejects.toThrow(
        "execution slots are occupied",
      );
      expect(f.resources).toHaveLength(1);
      await f.supervisor.closeAgent(first.agentId);
      expect(f.workers[0]!.close).toHaveBeenCalledTimes(2);
      expect(f.supervisor.listAllAgents()[0]).toMatchObject({
        state: "closed",
        resident: false,
        cleanupBlocked: false,
      });
      await f.spawn("b");
    } finally {
      await f.supervisor.close();
    }
  });
  it("does not forget a failed worker client whose cleanup also failed", async () => {
    const f = fixture({ maxAgents: 1 });
    try {
      const first = await f.spawn("a");
      f.workers[0]!.close.mockRejectedValueOnce(
        new Error("Could not stop worker"),
      );
      f.workers[0]!.options.onExit(new Error("IPC failure"));
      await f.supervisor.waitForTurns([first]);
      await vi.waitFor(() =>
        expect(f.supervisor.listAllAgents()[0]?.cleanupBlocked).toBe(true),
      );
      expect(f.supervisor.listAllAgents()[0]?.resident).toBe(true);
      await expect(
        f.supervisor.followupTask(first.agentId, "Unsafe restart"),
      ).rejects.toThrow("cleanup is incomplete");
      await expect(f.spawn("b")).rejects.toThrow(
        "execution slots are occupied",
      );
      await f.supervisor.closeAgent(first.agentId);
      expect(f.workers[0]!.close).toHaveBeenCalledTimes(2);
    } finally {
      await f.supervisor.close();
    }
  });
  it("retains failed eviction clients until an explicit Host cleanup succeeds", async () => {
    const f = fixture({ maxAgents: 1 });
    try {
      const first = await f.spawn("a");
      f.complete(0);
      await f.supervisor.waitForTurns([first]);
      f.workers[0]!.close.mockRejectedValueOnce(
        new Error("Eviction termination failed"),
      );
      await expect(f.spawn("b")).rejects.toThrow("eviction cleanup failed");
      expect(f.supervisor.listAllAgents()[0]).toMatchObject({
        resident: true,
        cleanupBlocked: true,
      });
      await expect(
        f.supervisor.followupTask(first.agentId, "Unsafe reuse"),
      ).rejects.toThrow("cleanup is incomplete");
      await expect(f.spawn("c")).rejects.toThrow(
        "execution slots are occupied",
      );
      await f.supervisor.closeAgent(first.agentId);
      expect(f.workers[0]!.close).toHaveBeenCalledTimes(2);
      await f.spawn("d");
    } finally {
      await f.supervisor.close();
    }
  });
  it("holds failed worker capacity during cleanup and retries it when Host stops agents", async () => {
    const f = fixture({ maxAgents: 1 });
    let rejectClose: ((reason: Error) => void) | undefined;
    const pendingClose = new Promise<void>((_resolve, reject) => {
      rejectClose = reject;
    });
    try {
      const first = await f.spawn("a");
      f.workers[0]!.close.mockReturnValueOnce(pendingClose);
      f.workers[0]!.options.onExit(new Error("IPC failed"));
      await f.supervisor.waitForTurns([first]);
      await vi.waitFor(() =>
        expect(f.workers[0]!.close).toHaveBeenCalledOnce(),
      );
      const followupRejected = expect(
        f.supervisor.followupTask(first.agentId, "Race with pending cleanup"),
      ).rejects.toThrow("cleanup is incomplete");
      await expect(f.spawn("b")).rejects.toThrow(
        "execution slots are occupied",
      );
      expect(f.supervisor.listAllAgents()).toHaveLength(1);
      expect(f.supervisor.listAllAgents()[0]).toMatchObject({
        resident: true,
        cleanupBlocked: true,
        queuedTurns: 0,
      });
      expect(f.supervisor.results).toHaveLength(1);
      expect(f.resources).toHaveLength(1);
      rejectClose!(new Error("Termination still unconfirmed"));
      await followupRejected;
      await vi.waitFor(() =>
        expect(f.supervisor.listAllAgents()[0]?.failure).toContain(
          "Termination still unconfirmed",
        ),
      );
      await f.supervisor.stopAgents();
      expect(f.workers[0]!.close).toHaveBeenCalledTimes(2);
      expect(f.supervisor.listAllAgents()[0]).toMatchObject({
        resident: false,
        cleanupBlocked: false,
        state: "closed",
      });
    } finally {
      rejectClose?.(new Error("Fixture cleanup"));
      await f.supervisor.close();
    }
  });
  it("does not count a rejected current-turn task as consumed before its later activation", async () => {
    const f = fixture({ acceptTask: false });
    try {
      const first = await f.spawn("a");
      await f.supervisor.followupTask(first.agentId, "After final");
      const mail = f.supervisor.messages.find(
        (record) => record.envelope.text === "After final",
      );
      expect(mail?.deferredAt).not.toBeNull();
      expect(mail?.consumedAt).toBeNull();
      expect(mail?.submittedAt).toBeNull();
      f.complete(0);
      await vi.waitFor(() => expect(mail?.submittedAt).not.toBeNull());
      expect(mail?.consumedAt).toBeNull();
      f.emit(0, { version: 2, type: "phase", phase: "current" });
      expect(mail?.consumedAt).not.toBeNull();
    } finally {
      await f.supervisor.close();
    }
  });
  it("reloads forked agents without importing their parent context again", async () => {
    const f = fixture({ maxAgents: 1 });
    f.supervisor.bindRoot(f.root);
    try {
      const first = await f.supervisor.spawnAgent("First", { taskName: "a" });
      f.complete(0);
      await f.supervisor.waitForTurns([first]);
      const second = await f.spawn("b");
      f.complete(1);
      await f.supervisor.waitForTurns([second]);
      await f.supervisor.followupTask(first.agentId, "Continue");
      expect(f.workers[0]!.options.configuration.forkContext).toEqual(
        forkContext,
      );
      expect(f.workers[2]!.options.configuration.forkContext).toBeUndefined();
      expect(f.workers[2]!.options.configuration.resumeSessionFile).toBe(
        `/host/${first.agentId}.jsonl`,
      );
    } finally {
      await f.supervisor.close();
    }
  });
  it("handles a second process failure after the same agent resumes", async () => {
    const f = fixture();
    try {
      const first = await f.spawn("a");
      f.workers[0]!.options.onExit(new Error("First process failed"));
      await f.supervisor.waitForTurns([first]);
      const next = await f.supervisor.followupTask(first.agentId, "Retry");
      f.workers[1]!.options.onExit(new Error("Second process failed"));
      const result = await f.supervisor.waitForTurns([next]);
      expect(result.results[0]).toMatchObject({
        status: "failed",
        errorMessage: "Second process failed",
      });
      expect(f.supervisor.results).toHaveLength(2);
    } finally {
      await f.supervisor.close();
    }
  });
  it("fails closed when execution cleanup fails instead of starting deferred tasks", async () => {
    const f = fixture({ acceptTask: false });
    try {
      const first = await f.spawn("a");
      const next = await f.supervisor.followupTask(first.agentId, "Deferred");
      vi.mocked(f.resources[0]!.cancel).mockRejectedValue(
        new Error("sandbox cleanup failed"),
      );
      f.complete(0);
      const result = await f.supervisor.waitForTurns([first, next]);
      expect(result.results.every((record) => record.status === "failed")).toBe(
        true,
      );
      expect(f.resources[0]!.finishTurn).not.toHaveBeenCalled();
      expect(f.workers[0]!.close).toHaveBeenCalled();
      expect(f.resources[0]!.close).toHaveBeenCalled();
      await expect(
        f.supervisor.followupTask(first.agentId, "Unsafe restart"),
      ).rejects.toThrow("closed");
      expect(
        f.workers[0]!.sent.filter((message) => message.type === "prompt"),
      ).toHaveLength(1);
    } finally {
      await f.supervisor.close();
    }
  });
  it("revokes a worker that duplicates an in-flight request ID", async () => {
    const f = fixture();
    try {
      const first = await f.spawn("a");
      vi.mocked(f.resources[0]!.invokeTool).mockImplementation(
        async (_request, signal) => {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { content: [] };
        },
      );
      const request: AgentWorkerMessage = {
        version: 2,
        type: "tool_request",
        turnId: 1,
        requestId: "duplicate",
        name: "read",
        arguments: {},
      };
      f.emit(0, request);
      await Promise.resolve();
      f.emit(0, request);
      const result = await f.supervisor.waitForTurns([first]);
      expect(result.results[0]).toMatchObject({
        status: "failed",
        errorMessage: "Worker reused a tool request ID",
        evidence: { execution: "execution-1" },
      });
    } finally {
      await f.supervisor.close();
    }
  });
  it("bounds execution calls while keeping stop and collaboration tools available", async () => {
    const f = fixture();
    try {
      await f.spawn("a");
      for (let index = 0; index < 64; index += 1) {
        f.emit(0, {
          version: 2,
          type: "tool_request",
          turnId: 1,
          requestId: `read-${index}`,
          name: "read",
          arguments: {},
        });
        await vi.waitFor(
          () =>
            expect(
              f.workers[0]!.sent.some(
                (message) =>
                  message.type === "tool_result" &&
                  message.requestId === `read-${index}`,
              ),
            ).toBe(true),
          { interval: 1 },
        );
      }
      for (const [requestId, name] of [
        ["over", "read"],
        ["stop", "game_stop"],
        ["list", "list_agents"],
      ] as const)
        f.emit(0, {
          version: 2,
          type: "tool_request",
          turnId: 1,
          requestId,
          name,
          arguments: {},
        });
      await vi.waitFor(() =>
        expect(
          f.workers[0]!.sent.filter(
            (message) => message.type === "tool_result",
          ),
        ).toHaveLength(67),
      );
      expect(
        f.workers[0]!.sent.find(
          (message) =>
            message.type === "tool_result" && message.requestId === "over",
        ),
      ).toMatchObject({ result: { isError: true } });
      expect(f.resources[0]!.invokeTool).toHaveBeenCalledTimes(65);
    } finally {
      await f.supervisor.close();
    }
  });
  it("rejects oversized names, unknown fields and oversized deferred task batches before activation", async () => {
    const f = fixture({ acceptTask: false });
    try {
      await expect(f.spawn("a".repeat(129))).rejects.toThrow();
      expect(f.resources).toHaveLength(0);
      await expect(
        f.supervisor.invokeCollaboration("spawn_agent", {
          task_name: "a",
          message: "Hi",
          cwd: "/host",
        }),
      ).rejects.toThrow();
      const first = await f.spawn("a");
      await f.supervisor.followupTask(first.agentId, "x".repeat(32_000));
      await expect(
        f.supervisor.followupTask(first.agentId, "y".repeat(34_000)),
      ).rejects.toThrow();
      expect(
        f.workers[0]!.sent.filter((message) => message.type === "prompt"),
      ).toHaveLength(1);
    } finally {
      await f.supervisor.close();
    }
  });
  it("terminates an uncooperative timeout and ignores late process output", async () => {
    vi.useFakeTimers();
    const f = fixture({
      cooperative: false,
      turnTimeoutMs: 10,
      interruptGraceMs: 5,
    });
    const first = await f.spawn("a");
    await vi.advanceTimersByTimeAsync(20);
    expect(f.workers[0]!.close).toHaveBeenCalledOnce();
    expect(f.supervisor.results[0]?.status).toBe("timed_out");
    f.complete(0);
    expect(f.supervisor.results).toHaveLength(1);
    expect(f.supervisor.results[0]?.agentId).toBe(first.agentId);
    await f.supervisor.close();
  });
});
