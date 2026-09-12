import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asTaskId, InspectionRunRecordV1Schema } from "@chronorift/domain";
import type { VNextPiTurnResult } from "@chronorift/pi-harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AgentExecutionScope } from "./agent-execution-scope.js";
import type { AgentHostMessage } from "./agent-ipc.js";
import type {
  AgentWorkerClient,
  AgentWorkerClientOptions,
} from "./agent-worker-client.js";
import { AgentWorkspaceManager } from "./agent-workspace.js";
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
      version: 1,
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

const setup = async () => {
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
  it("keeps recorded execution evidence readable when candidate snapshot capture fails", async () => {
    // This injected record represents already persisted runtime evidence; it is
    // deliberately independent from the later source/patch capture operation.
    const recordedExecution = InspectionRunRecordV1Schema.parse({
      schemaVersion: 1,
      executionId: "inspection.recorded-before-capture-failure",
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
        stdout: "Previously captured fixture observation\n",
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
    const capture = vi
      .spyOn(AgentWorkspaceManager.prototype, "finishTurn")
      .mockRejectedValueOnce(new Error("Injected candidate source drift"));
    const { environment, layout, workers } = await setup();
    const target = await environment.supervisor.spawnAgent(
      "Finish after an execution was recorded",
    );
    workers[0]!.complete(10, 0.1);
    const finished = await environment.supervisor.waitAgent(
      [target],
      "all",
      10_000,
    );
    expect(finished).toMatchObject({
      timedOut: false,
      results: [
        {
          status: "failed",
        },
      ],
    });
    expect(finished.results[0]?.errorMessage).toContain(
      "Injected candidate source drift",
    );
    expect(capture).toHaveBeenCalledOnce();
    const page = z
      .object({ text: z.string(), truncated: z.boolean() })
      .parse(
        await environment.supervisor.readAgentResult(
          target.agentId,
          target.turnId,
          "evidence",
        ),
      );
    expect(page.truncated).toBe(false);
    expect(JSON.parse(page.text)).toEqual([recordedExecution]);
    const published = z
      .object({
        patch: z.null(),
        captureError: z.string(),
        executions: z.array(InspectionRunRecordV1Schema),
      })
      .parse(
        JSON.parse(
          await readFile(
            join(
              layout.taskRecordDirectory,
              "agents",
              target.agentId,
              `result-${target.turnId}.json`,
            ),
            "utf8",
          ),
        ),
      );
    expect(published.captureError).toContain("Injected candidate source drift");
    expect(published.executions).toEqual([recordedExecution]);
    await expect(
      environment.supervisor.applyAgentPatch(target.agentId, target.turnId),
    ).rejects.toThrow("frozen candidate");
    const summary = await environment.writeSummary();
    const summaryText = await readFile(summary.recordPath, "utf8");
    expect(JSON.parse(summaryText)).toMatchObject({
      turns: [
        {
          ...target,
          status: "failed",
        },
      ],
    });
    expect(summaryText).toContain("Injected candidate source drift");
  });

  it("counts only each Session's latest cumulative usage and retains queued cancellations", async () => {
    const { environment, workers } = await setup();
    const first = await environment.supervisor.spawnAgent("First worker turn");
    workers[0]!.complete(100, 1);
    await environment.supervisor.waitAgent([first], "all", 10_000);
    const firstFollowup = environment.supervisor.followupTask(
      first.agentId,
      "Second turn in the same Session",
    );
    workers[0]!.complete(250, 2.5);
    await environment.supervisor.waitAgent([firstFollowup], "all", 10_000);

    const second = await environment.supervisor.spawnAgent(
      "Another independent Session",
    );
    workers[1]!.complete(70, 0.7);
    await environment.supervisor.waitAgent([second], "all", 10_000);
    const interrupted = environment.supervisor.followupTask(
      second.agentId,
      "Active turn to interrupt",
    );
    const queued = environment.supervisor.followupTask(
      second.agentId,
      "Queued turn must remain in the final record",
    );
    workers[1]!.interruptionUsage = { tokens: 80, cost: 0.8 };
    await environment.supervisor.stopAgents();
    const cancelled = await environment.supervisor.waitAgent(
      [interrupted, queued],
      "all",
      10_000,
    );
    expect(cancelled).toMatchObject({
      timedOut: false,
      results: [{ status: "cancelled" }, { status: "cancelled" }],
    });

    const summary = await environment.writeSummary(
      result("root-session", 500, 5),
    );
    const parsed = z
      .object({
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
            startedAt: z.string().nullable(),
          }),
        ),
      })
      .parse(JSON.parse(await readFile(summary.recordPath, "utf8")));
    expect(parsed.reportedUsage.tokens).toBe(500 + 250 + 80);
    expect(parsed.reportedUsage.cost).toBeCloseTo(5 + 2.5 + 0.8);
    expect(parsed.reportedUsage.incomplete).toBe(true);
    expect(parsed.workerUsage).toEqual([
      {
        agentId: first.agentId,
        throughTurnId: firstFollowup.turnId,
        incomplete: false,
      },
      {
        agentId: second.agentId,
        throughTurnId: interrupted.turnId,
        incomplete: true,
      },
    ]);
    expect(parsed.turns).toHaveLength(5);
    expect(parsed.turns).toContainEqual({
      ...queued,
      status: "cancelled",
      startedAt: null,
    });
  });
});
