import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asTaskId, InspectionRunRecordV1Schema } from "@chronorift/domain";
import type { VNextPiTurnResult } from "@chronorift/pi-harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AgentExecutionScope } from "./agent-execution-scope.js";
import type { AgentSpawnPolicy } from "./agent-supervisor.js";
import { AGENT_IPC_VERSION, type AgentHostMessage } from "./agent-ipc.js";
import type {
  AgentWorkerClient,
  AgentWorkerClientOptions,
} from "./agent-worker-client.js";
import {
  createProjectMultiAgentEnvironment,
  type ProjectMultiAgentEnvironment,
} from "./project-multi-agent.js";
import { SrtSandboxController } from "./srt-sandbox-controller.js";
import { createProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";

const result = (
  sessionId: string,
  tokens: number,
  cost: number,
  status: VNextPiTurnResult["status"] = "completed",
): VNextPiTurnResult => ({
  schemaVersion: 1,
  status,
  sessionId,
  sessionFile: sessionId,
  provider: "offline-fixture",
  model: "offline-fixture",
  requestedThinkingLevel: "off",
  realizedThinkingLevel: "off",
  activeTools: [],
  assistantText: "Fixture loop finished; this is not an acceptance result.",
  errorMessage: null,
  eventsObserved: 0,
  usageOwnership: {
    scope: "session-owned",
    sessionId,
    parentSessionId: null,
    inheritedContextMessages: 0,
  },
  stats: {
    sessionFile: undefined,
    sessionId,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: tokens,
    },
    cost,
  },
});

/** No Pi Session, model, coding tool, or game process is started in this suite. */
class OfflineWorker implements AgentWorkerClient {
  #turnId = 0;
  #tokens = 0;
  #cost = 0;
  public interruptionUsage: { tokens: number; cost: number } | undefined;

  public constructor(public readonly options: AgentWorkerClientOptions) {}

  public async send(message: AgentHostMessage): Promise<void> {
    if (message.type === "prompt") this.#turnId = message.turnId;
    if (message.type === "interrupt") {
      this.complete(
        this.interruptionUsage?.tokens ?? this.#tokens,
        this.interruptionUsage?.cost ?? this.#cost,
        "aborted",
      );
    }
  }

  public async close(): Promise<void> {}

  public complete(
    tokens: number,
    cost: number,
    status: VNextPiTurnResult["status"] = "completed",
  ): void {
    this.#tokens = tokens;
    this.#cost = cost;
    this.options.onMessage({
      version: AGENT_IPC_VERSION,
      type: "completed",
      turnId: this.#turnId,
      result: result(
        this.options.configuration.sessionDirectory,
        tokens,
        cost,
        status,
      ),
    });
  }
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

const setup = async (spawnPolicy?: AgentSpawnPolicy) => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-multi-agent-offline-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const state = join(root, "state");
  await mkdir(source, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  const taskId = asTaskId("task-multi-agent-offline");
  const layout = await createProjectEnvironmentTaskDirectoryLayout({
    runtimeRoot: state,
    sourceRepositoryRoot: source,
    taskId,
  });
  await writeFile(
    join(layout.workspaceDirectory, "project.godot"),
    '[application]\nrun/main_scene="res://main.tscn"\n',
  );
  await writeFile(
    join(layout.workspaceDirectory, "main.tscn"),
    '[gd_scene format=3]\n[node name="Main" type="Node"]\n',
  );
  const controller = new SrtSandboxController();
  const forbiddenSandbox = () => {
    throw new Error("Offline evidence tests must not start SRT");
  };
  const runCoding = vi
    .spyOn(controller, "runCoding")
    .mockImplementation(forbiddenSandbox);
  const openGodot = vi
    .spyOn(controller, "openGodot")
    .mockImplementation(forbiddenSandbox);
  const openGodotImport = vi
    .spyOn(controller, "openGodotImport")
    .mockImplementation(forbiddenSandbox);
  const workers: OfflineWorker[] = [];
  const lifecycle: { environment?: ProjectMultiAgentEnvironment } = {};
  cleanups.push(async () => {
    try {
      await lifecycle.environment?.close();
    } finally {
      await controller.close();
    }
    expect(runCoding).not.toHaveBeenCalled();
    expect(openGodot).not.toHaveBeenCalled();
    expect(openGodotImport).not.toHaveBeenCalled();
  });
  const environment = await createProjectMultiAgentEnvironment({
    taskId,
    layout,
    controller,
    nodePath: process.execPath,
    godotPath: "/not-started/offline-godot",
    provider: "offline-fixture",
    model: "offline-fixture",
    thinkingLevel: "off",
    instructions:
      "No model or tool execution is allowed in this offline fixture.",
    configuration: { maxAgents: 2 },
    ...(spawnPolicy === undefined ? {} : { spawnPolicy }),
    workerFactory: async (options) => {
      const worker = new OfflineWorker(options);
      workers.push(worker);
      return worker;
    },
  });
  lifecycle.environment = environment;
  return { environment, layout, workers };
};

describe("Project multi-agent evidence and summaries", () => {
  it("enforces and records Host-only spawn constraints at the project boundary", async () => {
    const spawnPolicy: AgentSpawnPolicy = {
      maxCreatedAgents: 1,
      maxDepth: 1,
      lockedRuntime: {
        provider: "offline-fixture",
        model: "offline-fixture",
        thinkingLevel: "max",
      },
    };
    const { environment, workers } = await setup(spawnPolicy);
    await expect(
      environment.supervisor.spawnAgent(
        "Try changing the experiment configuration",
        {
          taskName: "rejected",
          forkTurns: "none",
          reasoningEffort: "high",
        },
      ),
    ).rejects.toThrow();
    expect(workers).toHaveLength(0);
    expect(environment.supervisor.listAllAgents()).toHaveLength(0);
    const first = await environment.supervisor.spawnAgent(
      "Use the Host configuration",
      {
        taskName: "first",
        forkTurns: "none",
      },
    );
    expect(workers[0]!.options.configuration).toMatchObject(
      spawnPolicy.lockedRuntime!,
    );
    workers[0]!.complete(10, 0.1);
    await environment.supervisor.waitForTurns([first], "all", 10_000);
    await expect(
      environment.supervisor.spawnAgent("Try a replacement identity", {
        taskName: "replacement",
        forkTurns: "none",
      }),
    ).rejects.toThrow();
    expect(workers).toHaveLength(1);
    expect(environment.supervisor.listAllAgents()).toHaveLength(1);
    const summary = await environment.writeSummary(
      result("root-session", 20, 0.2),
    );
    expect(
      JSON.parse(await readFile(summary.recordPath, "utf8")),
    ).toMatchObject({
      schemaVersion: 2,
      spawnPolicy,
    });
  });

  it("shares one candidate and freezes execution evidence without claiming a worker patch", async () => {
    const recordedExecution = InspectionRunRecordV1Schema.parse({
      schemaVersion: 1,
      executionId: "inspection.recorded-before-shared-edit",
      sourceSha256: "a".repeat(64),
      observedSourceSha256: "a".repeat(64),
      sourceUnchanged: true,
      mainScene: "res://main.tscn",
      engineVersion: "4.7.1.stable.fixture",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      status: "exited",
      exitCode: 0,
      signal: null,
      import: null,
      run: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "captured observation",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      },
      stderr: "",
      stderrTruncated: false,
      error: null,
    });
    vi.spyOn(AgentExecutionScope.prototype, "records").mockReturnValue([
      recordedExecution,
    ]);
    const { environment, layout, workers } = await setup();
    const target = await environment.supervisor.spawnAgent(
      "Finish after an execution was recorded",
      { taskName: "first", forkTurns: "none" },
    );
    const second = await environment.supervisor.spawnAgent(
      "Continue sharing the candidate",
      { taskName: "second", forkTurns: "none" },
    );
    expect(
      workers.map(
        (worker) => worker.options.configuration.resourceWorkspaceDirectory,
      ),
    ).toEqual([layout.workspaceDirectory, layout.workspaceDirectory]);
    expect(workers[0]!.options.configuration.sessionDirectory).not.toBe(
      workers[1]!.options.configuration.sessionDirectory,
    );
    expect(
      environment.tools.some((tool) => tool.name === "apply_agent_patch"),
    ).toBe(false);
    workers[0]!.complete(10, 0.1);
    const finished = await environment.supervisor.waitForTurns(
      [target],
      "all",
      10_000,
    );
    expect(finished.results[0]).toMatchObject({
      status: "completed",
      evidence: { executions: [recordedExecution.executionId] },
    });
    const path = join(
      layout.taskRecordDirectory,
      "agents",
      target.agentId,
      `result-${target.turnId}.json`,
    );
    const firstRecord = await readFile(path, "utf8");
    expect(JSON.parse(firstRecord)).toMatchObject({
      schemaVersion: 2,
      workspaceMode: "shared",
      executions: [recordedExecution],
    });
    expect(JSON.parse(firstRecord)).not.toHaveProperty("patch");
    await writeFile(
      join(layout.workspaceDirectory, "main.tscn"),
      "another agent has started a new edit",
    );
    workers[1]!.complete(20, 0.2);
    await environment.supervisor.waitForTurns([second], "all", 10_000);
    expect(await readFile(path, "utf8")).toBe(firstRecord);
  });

  it("counts the latest owned cumulative usage once, including evicted workers", async () => {
    const { environment, workers } = await setup();
    const first = await environment.supervisor.spawnAgent("First worker turn", {
      taskName: "first",
      forkTurns: "none",
    });
    workers[0]!.complete(100, 1);
    await environment.supervisor.waitForTurns([first], "all", 10_000);
    const firstFollowup = await environment.supervisor.followupTask(
      first.agentId,
      "Second turn in the same Session",
    );
    workers[0]!.complete(250, 2.5);
    await environment.supervisor.waitForTurns([firstFollowup], "all", 10_000);
    const second = await environment.supervisor.spawnAgent("Another Session", {
      taskName: "second",
      forkTurns: "none",
    });
    workers[1]!.complete(70, 0.7);
    await environment.supervisor.waitForTurns([second], "all", 10_000);
    const third = await environment.supervisor.spawnAgent(
      "Evict an idle Session",
      { taskName: "third", forkTurns: "none" },
    );
    workers[2]!.complete(30, 0.3);
    await environment.supervisor.waitForTurns([third], "all", 10_000);
    const summary = await environment.writeSummary(
      result("root-session", 500, 5),
    );
    const parsed = z
      .object({
        schemaVersion: z.literal(2),
        workspaceMode: z.literal("shared"),
        reportedUsage: z.object({
          tokens: z.number(),
          cost: z.number(),
          incomplete: z.boolean(),
        }),
        workerUsage: z.array(
          z.object({
            agentId: z.string(),
            throughTurnId: z.number().nullable(),
            incomplete: z.boolean(),
          }),
        ),
        turns: z.array(
          z.object({
            agentId: z.string(),
            turnId: z.number(),
            status: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(await readFile(summary.recordPath, "utf8")));
    expect(parsed.reportedUsage).toMatchObject({
      tokens: 850,
      incomplete: false,
    });
    expect(parsed.reportedUsage.cost).toBeCloseTo(8.5);
    expect(parsed.workerUsage).toHaveLength(3);
    expect(parsed.workerUsage).toContainEqual({
      agentId: first.agentId,
      throughTurnId: firstFollowup.turnId,
      incomplete: false,
    });
    expect(parsed.turns).toHaveLength(4);
    const raw = JSON.parse(await readFile(summary.recordPath, "utf8")) as {
      spawnPolicy: unknown;
      messages: unknown[];
      rootUsageOwnership: unknown;
      workerUsage: { usageOwnership: unknown }[];
    };
    expect(raw.spawnPolicy).toBeNull();
    expect(raw.messages).toEqual(environment.supervisor.messages);
    expect(raw.messages.length).toBeGreaterThan(0);
    expect(raw.rootUsageOwnership).toMatchObject({
      scope: "session-owned",
      sessionId: "root-session",
    });
    expect(
      raw.workerUsage.every((worker) => worker.usageOwnership !== null),
    ).toBe(true);
  });

  it("retains a cancelled worker's latest snapshot while flagging incomplete provider usage", async () => {
    const { environment, workers } = await setup();
    const first = await environment.supervisor.spawnAgent("First worker turn", {
      taskName: "worker",
      forkTurns: "none",
    });
    workers[0]!.complete(100, 1);
    await environment.supervisor.waitForTurns([first], "all", 10_000);
    const interrupted = await environment.supervisor.followupTask(
      first.agentId,
      "Continue investigating",
    );
    workers[0]!.interruptionUsage = { tokens: 150, cost: 1.5 };
    await environment.supervisor.interruptAgent(first.agentId);
    const finished = await environment.supervisor.waitForTurns(
      [interrupted],
      "all",
      10_000,
    );
    expect(finished.results[0]).toMatchObject({
      status: "cancelled",
      piResult: {
        status: "aborted",
        stats: { tokens: { total: 150 }, cost: 1.5 },
      },
    });
    const summary = await environment.writeSummary(
      result("root-session", 500, 5),
    );
    expect(
      JSON.parse(await readFile(summary.recordPath, "utf8")),
    ).toMatchObject({
      reportedUsage: { tokens: 650, cost: 6.5, incomplete: true },
      workerUsage: [
        {
          agentId: first.agentId,
          throughTurnId: interrupted.turnId,
          incomplete: true,
          sessionStats: { tokens: { total: 150 }, cost: 1.5 },
        },
      ],
    });
  });

  it.each(["aborted", "provider_failed", "timed_out"] as const)(
    "flags a %s Root snapshot as incomplete without dropping its usage",
    async (status) => {
      const { environment } = await setup();
      const summary = await environment.writeSummary(
        result("root-session", 500, 5, status),
      );
      expect(
        JSON.parse(await readFile(summary.recordPath, "utf8")),
      ).toMatchObject({
        reportedUsage: { tokens: 500, cost: 5, incomplete: true },
        rootStats: { tokens: { total: 500 }, cost: 5 },
      });
    },
  );
});
