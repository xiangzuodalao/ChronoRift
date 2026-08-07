import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asTaskId, type TaskId } from "@chronorift/domain";
import type {
  RunVNextPiSdkTurnOptions,
  VNextPiTurnResult,
} from "@chronorift/pi-harness";
import { afterEach, describe, expect, it } from "vitest";

import type { M1TaskEnvironment } from "./m1-task-environment.js";
import { continueVNextAgentTask, startVNextAgentTask } from "./task-agent.js";
import {
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
    slot: "task.json" | "agent-task.json",
    parse: (input: unknown) => T,
  ): Promise<T> {
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
  it("starts and continues one persisted Pi session with only broker coding tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-agent-task-"));
    roots.push(root);
    const workspaceDirectory = join(root, "workspace");
    const piSessionDirectory = join(root, "pi-sessions");
    await Promise.all([mkdir(workspaceDirectory), mkdir(piSessionDirectory)]);
    const runtimeRoot = join(root, "runtime");
    await mkdir(runtimeRoot);
    const taskId = asTaskId("task_agent_fixture");
    const environment = {} as M1TaskEnvironment;
    const store = new MemoryAgentStore();
    let suspends = 0;
    const calls: Array<{
      readonly names: readonly string[];
      readonly resumeSessionFile: string | undefined;
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
    expect(calls[1]?.resumeSessionFile).toBe(
      join(piSessionDirectory, "session.jsonl"),
    );
    expect(store.turns).toHaveLength(2);
    expect(store.turns[0]).toMatchObject({ sessionFile: "session.jsonl" });
    expect(suspends).toBe(2);
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
