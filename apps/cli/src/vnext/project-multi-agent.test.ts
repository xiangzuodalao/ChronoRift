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
import { AgentWorkspaceManager } from "./agent-workspace.js";
import type {
  AgentWorkerClient,
  AgentWorkerClientOptions,
} from "./agent-worker-client.js";
import { NodeHostGitPort } from "./host-git.js";
import {
  createProjectMultiAgentEnvironment,
  type ProjectMultiAgentEnvironment,
} from "./project-multi-agent.js";
import { SrtSandboxController } from "./srt-sandbox-controller.js";
import { createProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";
import type { ProjectExecutionLimits } from "./project-execution-limits.js";

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

const setup = async (
  spawnPolicy?: AgentSpawnPolicy,
  executionLimits?: ProjectExecutionLimits,
) => {
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
    ...(executionLimits === undefined ? {} : { executionLimits }),
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
  it("records the actual Host limits without changing worker policy", async () => {
    const executionLimits = {
      sharedToolCallLimit: 2048,
      workerTurnTimeoutMs: 2_700_000,
      workerTurnToolCallLimit: 512,
    };
    const { environment } = await setup(undefined, executionLimits);
    await environment.close();
    const summary = await environment.writeSummary(result("root", 0, 0));
    expect(summary).toMatchObject({
      sharedToolCallLimit: 2048,
      sharedToolCalls: 0,
    });
    const record: unknown = JSON.parse(
      await readFile(summary.recordPath, "utf8"),
    );
    expect(record).toMatchObject({
      executionLimits,
      sharedToolCallLimit: 2048,
    });
  });
  it("finishes with zero workers and reports only Root usage", async () => {
    const { environment, workers } = await setup({
      maxCreatedAgents: 3,
      maxDepth: 1,
    });
    await environment.close();
    const summary = await environment.writeSummary(
      result("root-session", 20, 0.2),
    );
    expect(workers).toEqual([]);
    expect(summary.count).toBe(0);
    expect(
      JSON.parse(await readFile(summary.recordPath, "utf8")),
    ).toMatchObject({
      agents: [],
      messages: [],
      turns: [],
      workerUsage: [],
      reportedUsage: { tokens: 20, cost: 0.2, incomplete: false },
    });
  });

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
      schemaVersion: 3,
      spawnPolicy,
    });
  });

  it("isolates worktrees and explicitly integrates frozen patches while retaining execution evidence", async () => {
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
    ).not.toContain(layout.workspaceDirectory);
    const firstWorkspace =
      workers[0]!.options.configuration.resourceWorkspaceDirectory;
    const secondWorkspace =
      workers[1]!.options.configuration.resourceWorkspaceDirectory;
    expect(firstWorkspace).not.toBe(secondWorkspace);
    await writeFile(join(firstWorkspace, "worker.gd"), "extends Node\n");
    await expect(
      readFile(join(secondWorkspace, "worker.gd")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      environment.supervisor.invokeCollaboration("apply_agent_patch", {
        target: target.agentId,
        turn_id: 1,
      }),
    ).rejects.toThrow("frozen");
    expect(workers[0]!.options.configuration.sessionDirectory).not.toBe(
      workers[1]!.options.configuration.sessionDirectory,
    );
    expect(
      environment.tools.some((tool) => tool.name === "apply_agent_patch"),
    ).toBe(true);
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
      schemaVersion: 3,
      workspaceMode: "worktree",
      executions: [recordedExecution],
    });
    expect(JSON.parse(firstRecord)).toHaveProperty(
      "patch.roundTripVerified",
      true,
    );
    const diff = await environment.supervisor.invokeCollaboration(
      "read_agent_patch",
      { target: "first", turn_id: 1 },
    );
    expect(JSON.stringify(diff)).toContain("worker.gd");
    await expect(
      environment.supervisor.invokeCollaboration(
        "apply_agent_patch",
        { target: target.agentId, turn_id: 1 },
        undefined,
        second.agentId,
      ),
    ).rejects.toThrow("parent");
    await expect(
      readFile(join(layout.workspaceDirectory, "worker.gd")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const applied = await environment.supervisor.invokeCollaboration(
      "apply_agent_patch",
      { target: "first", turn_id: 1 },
    );
    expect(applied.details).toMatchObject({ status: "applied" });
    expect(
      await readFile(join(layout.workspaceDirectory, "worker.gd"), "utf8"),
    ).toBe("extends Node\n");
    await writeFile(
      join(layout.workspaceDirectory, "main.tscn"),
      "another agent has started a new edit",
    );
    workers[1]!.complete(20, 0.2);
    await environment.supervisor.waitForTurns([second], "all", 10_000);
    expect(await readFile(path, "utf8")).toBe(firstRecord);
  });

  it("cancels patch application queued behind another worker's result without changing Root", async () => {
    const { environment, layout, workers } = await setup();
    const first = await environment.supervisor.spawnAgent("Prepare a patch", {
      taskName: "first",
      forkTurns: "none",
    });
    await writeFile(
      join(
        workers[0]!.options.configuration.resourceWorkspaceDirectory,
        "worker.gd",
      ),
      "extends Node\n# frozen patch\n",
    );
    workers[0]!.complete(1, 0);
    await environment.supervisor.waitForTurns([first], "all", 10_000);
    const second = await environment.supervisor.spawnAgent(
      "Hold the workspace queue while freezing a result",
      { taskName: "second", forkTurns: "none" },
    );
    let releaseFinish!: () => void;
    const finishReleased = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });
    let notifyFinish!: () => void;
    const finishStarted = new Promise<void>((resolve) => {
      notifyFinish = resolve;
    });
    const git = new NodeHostGitPort();
    const originalDiff = git.streamCachedBinaryDiff.bind(git);
    vi.spyOn(
      NodeHostGitPort.prototype,
      "streamCachedBinaryDiff",
    ).mockImplementationOnce(async (input) => {
      notifyFinish();
      await finishReleased;
      return originalDiff(input);
    });
    const applyTurn = vi.spyOn(AgentWorkspaceManager.prototype, "applyTurn");
    const tool = environment.tools.find(
      (candidate) => candidate.name === "apply_agent_patch",
    )!;
    const abort = new AbortController();
    const reason = new Error("Root cancelled queued patch application");
    workers[1]!.complete(1, 0);
    try {
      await finishStarted;
      const pending = tool.execute(
        "cancelled-apply",
        { target: first.agentId, turn_id: first.turnId },
        abort.signal,
        undefined,
        {} as never,
      );
      const rejected = expect(pending).rejects.toMatchObject({
        code: "cancelled",
      });
      await vi.waitFor(() => {
        expect(applyTurn).toHaveBeenCalled();
      });
      abort.abort(reason);
      await rejected;
      releaseFinish();
      await environment.supervisor.waitForTurns([second], "all", 10_000);
      await expect(
        readFile(join(layout.workspaceDirectory, "worker.gd")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const applied = await tool.execute(
        "retry-apply",
        { target: first.agentId, turn_id: first.turnId },
        undefined,
        undefined,
        {} as never,
      );
      expect(applied.details).toMatchObject({ status: "applied" });
      expect(
        await readFile(join(layout.workspaceDirectory, "worker.gd"), "utf8"),
      ).toBe("extends Node\n# frozen patch\n");
    } finally {
      releaseFinish();
    }
  });

  it("counts the latest owned cumulative usage once, including evicted workers", async () => {
    const { environment, workers } = await setup();
    const first = await environment.supervisor.spawnAgent("First worker turn", {
      taskName: "first",
      forkTurns: "none",
    });
    workers[0]!.complete(100, 1);
    await environment.supervisor.waitForTurns([first], "all", 10_000);
    await writeFile(
      join(
        workers[0]!.options.configuration.resourceWorkspaceDirectory,
        "retained.gd",
      ),
      "extends Node\n",
    );
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
        schemaVersion: z.literal(3),
        workspaceMode: z.literal("worktree"),
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

  it("retains the same worktree and uncommitted edits after idle worker eviction", async () => {
    const { environment, workers } = await setup();
    const first = await environment.supervisor.spawnAgent("Keep changes", {
      taskName: "first",
      forkTurns: "none",
    });
    const workspace =
      workers[0]!.options.configuration.resourceWorkspaceDirectory;
    await writeFile(
      join(workspace, "retained.gd"),
      "extends Node\n# retained\n",
    );
    workers[0]!.complete(1, 0);
    await environment.supervisor.waitForTurns([first], "all", 10000);
    for (const name of ["second", "third"]) {
      const turn = await environment.supervisor.spawnAgent("Finish", {
        taskName: name,
        forkTurns: "none",
      });
      workers.at(-1)!.complete(1, 0);
      await environment.supervisor.waitForTurns([turn], "all", 10000);
    }
    const resumed = await environment.supervisor.followupTask(
      first.agentId,
      "Continue retained changes",
    );
    expect(workers).toHaveLength(4);
    expect(workers[3]!.options.configuration.resourceWorkspaceDirectory).toBe(
      workspace,
    );
    expect(await readFile(join(workspace, "retained.gd"), "utf8")).toContain(
      "retained",
    );
    workers[3]!.complete(2, 0);
    await environment.supervisor.waitForTurns([resumed], "all", 10000);
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
