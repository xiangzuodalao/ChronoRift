import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GAME_TOOL_DEFINITIONS_V1,
  GAME_TOOL_NAMES_V1,
} from "@chronorift/agent-protocol";
import {
  TaskPatchIdentityV1Schema,
  TaskIdentityV1Schema,
  asTaskId,
  taskNamespaceDigestV1,
  type TaskId,
} from "@chronorift/domain";
import {
  ArtifactNotFoundError,
  VNextTaskStore,
} from "@chronorift/json-artifacts";
import type {
  RunVNextPiSdkTurnOptions,
  VNextGameToolPortRequestV1,
  VNextPiTurnResult,
} from "@chronorift/pi-harness";
import { afterEach, describe, expect, it } from "vitest";

import type { M1TaskEnvironment } from "./m1-task-environment.js";
import {
  continueVNextAgentTask,
  showVNextAgentTask,
  startVNextAgentTask,
} from "./task-agent.js";
import {
  createVNextAgentGameCapabilityV1,
  VNextAgentTaskSchema,
  VNextAgentTaskV1Schema,
  VNextAgentTurnV1Schema,
} from "./task-agent-contracts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

class MemoryAgentStore {
  public task: unknown;
  public patch: unknown;
  public readonly turns: unknown[] = [];

  public create(): Promise<void> {
    return Promise.resolve();
  }

  public putJsonOnce<T>(
    _taskId: TaskId,
    _slot: "agent-task.json",
    value: T,
    parse: (input: unknown) => T,
  ): Promise<void> {
    if (this.task !== undefined) return Promise.reject(new Error("conflict"));
    this.task = parse(value);
    return Promise.resolve();
  }

  public readJson<T>(
    _taskId: TaskId,
    slot: "task.json" | "agent-task.json" | "patch.json",
    parse: (input: unknown) => T,
  ): Promise<T> {
    if (slot === "patch.json") {
      if (this.patch === undefined) {
        return Promise.reject(new ArtifactNotFoundError("patch.json"));
      }
      return Promise.resolve(parse(this.patch));
    }
    return Promise.resolve(
      parse(
        slot === "task.json"
          ? {
              schemaVersion: 1,
              taskId: asTaskId("task_agent_fixture"),
              createdAt: "2026-08-07T00:00:00.000Z",
            }
          : this.task,
      ),
    );
  }

  public append<T>(
    _taskId: TaskId,
    _slot: "agent-turns.jsonl",
    value: T,
    parse: (input: unknown) => T,
  ): Promise<unknown> {
    this.turns.push(parse(value));
    return Promise.resolve({});
  }

  public readLedger<T>(
    _taskId: TaskId,
    _slot: "agent-turns.jsonl",
    parse: (input: unknown) => T,
  ): Promise<readonly T[]> {
    return Promise.resolve(this.turns.map((turn) => parse(turn)));
  }
}

const stats = {
  sessionFile: undefined,
  sessionId: "session-agent-fixture",
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 2,
  toolResults: 2,
  totalMessages: 6,
  tokens: {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    total: 120,
  },
  cost: 0,
};

describe("vNext Agent Task composition", () => {
  it("rejects a path-like M3 Task identity before preparing any Host environment", async () => {
    let prepared = false;
    await expect(
      startVNextAgentTask(
        {
          taskId: asTaskId("../m3-escape"),
          projectPath: "/unused",
          trustedFixtureRoot: "/unused",
          runtimeRoot: "/unused",
          sandboxHost: {
            delegatedCgroupRoot: "/unused",
            bwrapPath: "/unused",
            prlimitPath: "/unused",
            busyboxPath: "/unused",
          },
          goal: "Do not prepare this invalid Task",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          thinkingLevel: "max",
          enableGameTools: true,
        },
        {
          prepare: async () => {
            prepared = true;
            throw new Error("prepare must not run");
          },
        },
      ),
    ).rejects.toThrow(/safe opaque resource identity/u);
    expect(prepared).toBe(false);
  });

  it("starts and continues one persisted Pi session with only broker coding tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-agent-task-"));
    roots.push(root);
    const workspaceDirectory = join(root, "workspace");
    const piSessionDirectory = join(root, "pi-sessions");
    await Promise.all([mkdir(workspaceDirectory), mkdir(piSessionDirectory)]);
    const runtimeRoot = join(root, "runtime");
    await mkdir(runtimeRoot);
    const taskId = asTaskId("task_agent_fixture");
    const environment = {
      managedRuntimeCapability: {
        managedRuntimeId: `managed-godot-runtime:v1:${"d".repeat(64)}`,
      },
    } as unknown as M1TaskEnvironment;
    const store = new MemoryAgentStore();
    let suspends = 0;
    let gamePortCreations = 0;
    const calls: Array<{
      readonly names: readonly string[];
      readonly resumeSessionFile: string | undefined;
      readonly additionalEnvironmentInstructions: string | undefined;
    }> = [];
    const runTurn = async (
      request: RunVNextPiSdkTurnOptions,
    ): Promise<VNextPiTurnResult> => {
      const sessionFile =
        request.resumeSessionFile ??
        join(request.sessionDirectory, "session.jsonl");
      await writeFile(sessionFile, "session\n");
      calls.push({
        names: request.tools.map((tool) => tool.name),
        resumeSessionFile: request.resumeSessionFile,
        additionalEnvironmentInstructions:
          request.additionalEnvironmentInstructions,
      });
      return {
        schemaVersion: 1,
        status: "completed",
        sessionId: "session-agent-fixture",
        sessionFile,
        provider: request.provider,
        model: request.model,
        requestedThinkingLevel: request.thinkingLevel,
        realizedThinkingLevel: request.thinkingLevel,
        activeTools: request.tools.map((tool) => tool.name),
        assistantText: `turn ${calls.length}`,
        errorMessage: null,
        eventsObserved: 4,
        stats: { ...stats, sessionFile },
      };
    };
    const dependencies = {
      now: () => "2026-08-07T00:00:00.000Z",
      createStore: () => store,
      prepare: async () => environment,
      resume: async () => environment,
      suspend: async () => {
        suspends += 1;
        return {
          processGroupTerminated: true,
          cgroupPopulated: false,
          termSent: false,
          killSent: false,
          scopeRemoved: true,
        };
      },
      hostContext: () => ({ workspaceDirectory, piSessionDirectory }),
      createGameToolPort: async () => {
        gamePortCreations += 1;
        return {
          invoke: async () => undefined,
          cleanup: async () => undefined,
        };
      },
      runTurn,
    };

    const started = await startVNextAgentTask(
      {
        taskId,
        projectPath: root,
        trustedFixtureRoot: root,
        runtimeRoot,
        sandboxHost: {
          delegatedCgroupRoot: "/cgroup",
          bwrapPath: "/bwrap",
          prlimitPath: "/prlimit",
          busyboxPath: "/busybox",
        },
        goal: "Fix the intermittent jump input",
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        thinkingLevel: "max",
      },
      dependencies,
    );
    const continued = await continueVNextAgentTask(
      {
        taskId,
        runtimeRoot,
        sandboxHost: {
          delegatedCgroupRoot: "/cgroup",
          bwrapPath: "/bwrap",
          prlimitPath: "/prlimit",
          busyboxPath: "/busybox",
        },
        prompt: "Review the diff and run another check",
      },
      dependencies,
    );

    expect(started).toMatchObject({ turn: 1, assistantText: "turn 1" });
    expect(continued).toMatchObject({ turn: 2, assistantText: "turn 2" });
    expect(calls[0]?.names).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]);
    expect(calls[1]?.names).toEqual(calls[0]?.names);
    expect(calls.map((call) => call.additionalEnvironmentInstructions)).toEqual(
      [undefined, undefined],
    );
    expect(calls[1]?.resumeSessionFile).toBe(
      join(piSessionDirectory, "session.jsonl"),
    );
    expect(store.task).toMatchObject({ schemaVersion: 1 });
    expect(gamePortCreations).toBe(0);
    expect(store.turns).toHaveLength(2);
    expect(store.turns[0]).toMatchObject({ sessionFile: "session.jsonl" });
    expect(suspends).toBe(2);
  });

  it("rejects continuation after the immutable patch handoff is sealed", async () => {
    const taskId = asTaskId("task:sealed-handoff");
    const store = new MemoryAgentStore();
    store.task = VNextAgentTaskV1Schema.parse({
      schemaVersion: 1,
      taskId,
      goal: "Produce one final candidate",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "max",
      createdAt: "2026-08-07T00:00:00.000Z",
    });
    store.turns.push(
      VNextAgentTurnV1Schema.parse({
        schemaVersion: 1,
        taskId,
        turn: 1,
        kind: "start",
        prompt: "Produce one final candidate",
        sessionId: "session-sealed-handoff",
        sessionFile: "session.jsonl",
        status: "completed",
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        requestedThinkingLevel: "max",
        realizedThinkingLevel: "max",
        activeTools: ["read"],
        assistantText: "candidate ready",
        errorMessage: null,
        eventsObserved: 1,
        stats: {
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 2,
          toolResults: 2,
          totalMessages: 6,
          tokens: stats.tokens,
          cost: 0,
        },
        completedAt: "2026-08-07T00:01:00.000Z",
      }),
    );
    store.patch = TaskPatchIdentityV1Schema.parse({
      schemaVersion: 1,
      patchId: `patch:v1:${"c".repeat(64)}`,
      taskId,
      baselineSourceHash: "a".repeat(64),
      candidateSourceHash: "b".repeat(64),
      patchHash: "c".repeat(64),
      byteLength: 42,
    });
    let resumed = false;

    await expect(
      continueVNextAgentTask(
        {
          taskId,
          runtimeRoot: "/unused",
          sandboxHost: {
            delegatedCgroupRoot: "/unused",
            bwrapPath: "/unused",
            prlimitPath: "/unused",
            busyboxPath: "/unused",
          },
          prompt: "Change the already exported candidate",
        },
        {
          createStore: () => store,
          resume: async () => {
            resumed = true;
            throw new Error("resume must not run after handoff");
          },
        },
      ),
    ).rejects.toThrow(/patch handoff is already sealed/u);
    expect(resumed).toBe(false);
  });

  it("freezes an explicit M3 capability and exposes all 16 game tools on every M3 turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-agent-task-m3-"));
    roots.push(root);
    const workspaceDirectory = join(root, "workspace");
    const piSessionDirectory = join(root, "pi-sessions");
    await Promise.all([mkdir(workspaceDirectory), mkdir(piSessionDirectory)]);
    const runtimeRoot = join(root, "runtime");
    await mkdir(runtimeRoot);
    const taskId = asTaskId("task:m3-agent");
    const gameCapability = createVNextAgentGameCapabilityV1(
      `managed-godot-runtime:v1:${"a".repeat(64)}`,
    );
    const managedRuntimeCapability = {
      managedRuntimeId: gameCapability.managedRuntimeId,
    };
    const environment = {
      managedRuntimeCapability,
    } as unknown as M1TaskEnvironment;
    const store = new MemoryAgentStore();
    const turnContexts: unknown[] = [];
    const gameRequests: VNextGameToolPortRequestV1[] = [];
    const cleanups: number[] = [];
    const toolLists: string[][] = [];
    const environmentInstructions: Array<string | undefined> = [];
    let suspends = 0;
    const dependencies = {
      now: () => "2026-08-07T00:00:00.000Z",
      createStore: () => store,
      prepare: async () => environment,
      resume: async () => environment,
      suspend: async () => {
        suspends += 1;
        return {
          processGroupTerminated: true,
          cgroupPopulated: false,
          termSent: false,
          killSent: false,
          scopeRemoved: true,
        };
      },
      hostContext: () => ({ workspaceDirectory, piSessionDirectory }),
      createGameToolPort: async (
        _environment: M1TaskEnvironment,
        context: unknown,
      ) => {
        const portIndex = cleanups.length;
        turnContexts.push(context);
        cleanups.push(0);
        return {
          invoke: async (request: VNextGameToolPortRequestV1) => {
            gameRequests.push(structuredClone(request));
            return {
              schemaVersion: 1 as const,
              toolCallId: request.toolCallId,
              outcome: "success" as const,
              output: {
                schemaVersion: 1,
                taskId,
                workspaceId: "workspace:m3-agent",
                build: {
                  schemaVersion: 1,
                  taskId,
                  workspaceId: "workspace:m3-agent",
                  sourceId: "source:m3-agent",
                  buildId: "build:m3-agent",
                  sourceHash: "a".repeat(64),
                  workspaceDiffHash: "b".repeat(64),
                  buildConfigurationHash: "c".repeat(64),
                  outputHash: "d".repeat(64),
                  createdAt: "2026-08-07T00:00:00.000Z",
                },
                fixture: {
                  fixtureId: "frame-input-window",
                  inputActions: ["attempt_jump"],
                  frameRates: [60, 120],
                  physicsRates: [60, 120],
                  maxTicks: 600,
                },
                tools: GAME_TOOL_DEFINITIONS_V1.map((tool) => ({
                  name: tool.name,
                  capability: tool.capability,
                })),
                costs: {
                  rollingHistorySecondsMaximum: 10,
                  queryRowMaximum: 200,
                  traceEventMaximum: 128,
                },
                unsupported: [],
                runtime: null,
              },
            };
          },
          cleanup: async () => {
            cleanups[portIndex] = (cleanups[portIndex] ?? 0) + 1;
          },
        };
      },
      runTurn: async (
        request: RunVNextPiSdkTurnOptions,
      ): Promise<VNextPiTurnResult> => {
        const turn = toolLists.length + 1;
        toolLists.push(request.tools.map((tool) => tool.name));
        environmentInstructions.push(request.additionalEnvironmentInstructions);
        const capabilities = request.tools.find(
          (tool) => tool.name === GAME_TOOL_NAMES_V1.capabilities,
        );
        if (capabilities === undefined) {
          throw new Error("missing game_capabilities tool");
        }
        await capabilities.execute(
          `tool-call-${turn}`,
          { schemaVersion: 1, taskId },
          undefined,
          undefined,
          {} as never,
        );
        const sessionFile =
          request.resumeSessionFile ??
          join(request.sessionDirectory, "session-m3.jsonl");
        await writeFile(sessionFile, "session\n");
        return {
          schemaVersion: 1,
          status: "completed",
          sessionId: "session-agent-m3",
          sessionFile,
          provider: request.provider,
          model: request.model,
          requestedThinkingLevel: request.thinkingLevel,
          realizedThinkingLevel: request.thinkingLevel,
          activeTools: request.tools.map((tool) => tool.name),
          assistantText: `m3 turn ${turn}`,
          errorMessage: null,
          eventsObserved: 1,
          stats: { ...stats, sessionFile },
        };
      },
    };

    await startVNextAgentTask(
      {
        taskId,
        projectPath: root,
        trustedFixtureRoot: root,
        runtimeRoot,
        sandboxHost: {
          delegatedCgroupRoot: "/cgroup",
          bwrapPath: "/bwrap",
          prlimitPath: "/prlimit",
          busyboxPath: "/busybox",
        },
        goal: "Investigate the runtime input window",
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        thinkingLevel: "max",
        enableGameTools: true,
      },
      dependencies,
    );
    const continueRequest = {
      taskId,
      runtimeRoot,
      sandboxHost: {
        delegatedCgroupRoot: "/cgroup",
        bwrapPath: "/bwrap",
        prlimitPath: "/prlimit",
        busyboxPath: "/busybox",
      },
      prompt: "Run one more runtime observation",
    } as const;
    managedRuntimeCapability.managedRuntimeId = `managed-godot-runtime:v1:${"e".repeat(64)}`;
    await expect(
      continueVNextAgentTask(continueRequest, dependencies),
    ).rejects.toThrow(/does not match the persisted M3 Task capability/u);
    managedRuntimeCapability.managedRuntimeId = gameCapability.managedRuntimeId;
    await continueVNextAgentTask(continueRequest, dependencies);

    const expectedTools = [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      ...Object.values(GAME_TOOL_NAMES_V1),
    ];
    expect(toolLists).toEqual([expectedTools, expectedTools]);
    expect(environmentInstructions).toEqual([
      expect.stringContaining(`Exact taskId: ${taskId}`),
      expect.stringContaining(`Exact taskId: ${taskId}`),
    ]);
    expect(
      environmentInstructions.every((instructions) =>
        instructions?.includes("Exact fixtureId: frame-input-window"),
      ),
    ).toBe(true);
    expect(gameRequests.map((request) => request.toolCallId)).toEqual([
      "tool-call-1",
      "tool-call-2",
    ]);
    expect(gameRequests.every((request) => request.input !== undefined)).toBe(
      true,
    );
    expect(turnContexts).toEqual([
      expect.objectContaining({ taskId, turn: 1, kind: "start" }),
      expect.objectContaining({ taskId, turn: 2, kind: "continue" }),
    ]);
    expect(cleanups).toEqual([1, 1]);
    expect(suspends).toBe(3);
    expect(store.task).toMatchObject({
      schemaVersion: 2,
      gameCapability: { managedRuntimeId: gameCapability.managedRuntimeId },
    });
  });

  it("cleans up the M3 game port and suspends the environment when a turn fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-agent-failure-"));
    roots.push(root);
    const workspaceDirectory = join(root, "workspace");
    const piSessionDirectory = join(root, "pi-sessions");
    await Promise.all([mkdir(workspaceDirectory), mkdir(piSessionDirectory)]);
    const runtimeRoot = join(root, "runtime");
    await mkdir(runtimeRoot);
    const taskId = asTaskId("task:m3-failure");
    const managedRuntimeId = `managed-godot-runtime:v1:${"b".repeat(64)}`;
    const environment = {
      managedRuntimeCapability: { managedRuntimeId },
    } as unknown as M1TaskEnvironment;
    const store = new MemoryAgentStore();
    let cleanups = 0;
    let suspends = 0;

    await expect(
      startVNextAgentTask(
        {
          taskId,
          projectPath: root,
          trustedFixtureRoot: root,
          runtimeRoot,
          sandboxHost: {
            delegatedCgroupRoot: "/cgroup",
            bwrapPath: "/bwrap",
            prlimitPath: "/prlimit",
            busyboxPath: "/busybox",
          },
          goal: "Observe a failing turn",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          thinkingLevel: "max",
          enableGameTools: true,
        },
        {
          now: () => "2026-08-07T00:00:00.000Z",
          createStore: () => store,
          prepare: async () => environment,
          suspend: async () => {
            suspends += 1;
            return {
              processGroupTerminated: true,
              cgroupPopulated: false,
              termSent: false,
              killSent: false,
              scopeRemoved: true,
            };
          },
          hostContext: () => ({ workspaceDirectory, piSessionDirectory }),
          createGameToolPort: async () => ({
            invoke: async () => undefined,
            cleanup: async () => {
              cleanups += 1;
              if (cleanups === 1) {
                throw new Error("transient execution seal failure");
              }
            },
          }),
          runTurn: async () => {
            throw new Error("provider turn failed");
          },
        },
      ),
    ).rejects.toThrow("provider turn failed");
    expect(cleanups).toBe(2);
    expect(suspends).toBe(1);
  });

  it("strictly versions the M3 capability without accepting a partial tool catalog", () => {
    const capability = createVNextAgentGameCapabilityV1(
      `managed-godot-runtime:v1:${"c".repeat(64)}`,
    );
    const parsed = VNextAgentTaskSchema.parse({
      schemaVersion: 2,
      taskId: asTaskId("task:m3-contract"),
      goal: "goal",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "max",
      createdAt: "2026-08-07T00:00:00.000Z",
      gameCapability: capability,
    });
    expect(parsed.schemaVersion).toBe(2);
    if (parsed.schemaVersion !== 2) throw new Error("expected M3 Task V2");
    expect(Object.isFrozen(parsed.gameCapability)).toBe(true);
    expect(Object.isFrozen(parsed.gameCapability.toolNames)).toBe(true);
    expect(() =>
      VNextAgentTaskSchema.parse({
        ...parsed,
        gameCapability: {
          ...parsed.gameCapability,
          toolNames: parsed.gameCapability.toolNames.slice(1),
        },
      }),
    ).toThrow(/catalog/u);
  });

  it("shows a pre-M3 V1 Task with a strict empty runtime inventory", async () => {
    const runtimeRoot = await mkdtemp(
      join(tmpdir(), "chronorift-agent-v1-show-"),
    );
    roots.push(runtimeRoot);
    await chmod(runtimeRoot, 0o700);
    const taskId = asTaskId("task_legacy_show");
    const taskRoot = join(runtimeRoot, "tasks", taskNamespaceDigestV1(taskId));
    await mkdir(join(taskRoot, "records"), { recursive: true, mode: 0o700 });
    await Promise.all([
      chmod(join(runtimeRoot, "tasks"), 0o700),
      chmod(taskRoot, 0o700),
      chmod(join(taskRoot, "records"), 0o700),
    ]);
    const store = new VNextTaskStore(runtimeRoot);
    await store.create(taskId);
    await store.putJsonOnce(
      taskId,
      "task.json",
      TaskIdentityV1Schema.parse({
        schemaVersion: 1,
        taskId,
        createdAt: "2026-08-07T00:00:00.000Z",
      }),
      (value) => TaskIdentityV1Schema.parse(value),
    );
    await store.putJsonOnce(
      taskId,
      "agent-task.json",
      VNextAgentTaskV1Schema.parse({
        schemaVersion: 1,
        taskId,
        goal: "legacy goal",
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        thinkingLevel: "max",
        createdAt: "2026-08-07T00:00:00.000Z",
      }),
      (value) => VNextAgentTaskV1Schema.parse(value),
    );

    const shown = await showVNextAgentTask({ taskId, runtimeRoot });

    expect(shown.task.schemaVersion).toBe(1);
    expect(shown.runtimeResources.kinds).toHaveLength(10);
    expect(shown.runtimeResources.kinds.every((kind) => kind.count === 0)).toBe(
      true,
    );
    expect(shown.runtimeResources.executions).toEqual([]);
  });

  it("strictly rejects a persisted session path instead of treating it as a Host path", () => {
    const task = VNextAgentTaskV1Schema.parse({
      schemaVersion: 1,
      taskId: asTaskId("task_contract"),
      goal: "goal",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "max",
      createdAt: "2026-08-07T00:00:00.000Z",
    });
    expect(() =>
      VNextAgentTurnV1Schema.parse({
        schemaVersion: 1,
        taskId: task.taskId,
        turn: 1,
        kind: "start",
        prompt: task.goal,
        sessionId: "session",
        sessionFile: "../session.jsonl",
        status: "completed",
        provider: task.provider,
        model: task.model,
        requestedThinkingLevel: task.thinkingLevel,
        realizedThinkingLevel: task.thinkingLevel,
        activeTools: ["read"],
        assistantText: "done",
        errorMessage: null,
        eventsObserved: 0,
        stats,
        completedAt: "2026-08-07T00:00:00.000Z",
      }),
    ).toThrow(/basename/u);
  });
});
