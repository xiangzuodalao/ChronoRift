import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  asTaskId,
  InspectionLaunchOutputV1Schema,
  InspectionQueryOutputV1Schema,
  InspectionRunRecordV1Schema,
  InspectionStopOutputV1Schema,
  InspectionToolResponseV1Schema,
} from "@chronorift/domain";
import type {
  PiProxyToolResult,
  VNextPiTurnResult,
} from "@chronorift/pi-harness";
import { expect, it } from "vitest";
import { z } from "zod";

import { AGENT_IPC_VERSION, type AgentHostMessage } from "./agent-ipc.js";
import type {
  AgentWorkerClient,
  AgentWorkerClientOptions,
} from "./agent-worker-client.js";
import {
  createProjectMultiAgentEnvironment,
  type ProjectMultiAgentEnvironment,
} from "./project-multi-agent.js";
import {
  quotePosixShellArg,
  SrtSandboxController,
} from "./srt-sandbox-controller.js";
import { createProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";

/** Only Pi/model behavior is replaced. Every coding and game request crosses the actual Host broker and SRT. */
class ScriptedWorker implements AgentWorkerClient {
  #turnId = 0;
  #nextRequest = 0;
  readonly #requests = new Map<string, (result: PiProxyToolResult) => void>();

  public constructor(public readonly options: AgentWorkerClientOptions) {}

  public async send(message: AgentHostMessage): Promise<void> {
    if (message.type === "prompt") this.#turnId = message.turnId;
    else if (message.type === "tool_result") {
      this.#requests.get(message.requestId)?.(message.result);
      this.#requests.delete(message.requestId);
    } else if (message.type === "interrupt")
      this.complete("Scripted worker interrupted", "aborted");
  }

  public async close(): Promise<void> {
    for (const resolve of this.#requests.values())
      resolve({
        content: [{ type: "text", text: "Worker closed" }],
        isError: true,
      });
    this.#requests.clear();
  }

  public request(
    name: string,
    arguments_: unknown,
  ): Promise<PiProxyToolResult> {
    if (this.#turnId === 0) throw new Error("Worker has no active turn");
    const requestId = `request-${++this.#nextRequest}`;
    return new Promise((resolve) => {
      this.#requests.set(requestId, resolve);
      this.options.onMessage({
        version: AGENT_IPC_VERSION,
        type: "tool_request",
        turnId: this.#turnId,
        requestId,
        name,
        arguments: arguments_,
      });
    });
  }

  public complete(
    assistantText: string,
    status: VNextPiTurnResult["status"] = "completed",
  ): void {
    const result: VNextPiTurnResult = {
      schemaVersion: 1,
      status,
      sessionId: "scripted-no-provider-session",
      sessionFile: "scripted-no-provider-session",
      provider: "test-no-provider",
      model: "test-no-model",
      requestedThinkingLevel: "off",
      realizedThinkingLevel: "off",
      activeTools: this.options.configuration.tools.map((tool) => tool.name),
      assistantText,
      errorMessage: null,
      eventsObserved: 0,
      stats: {
        sessionFile: undefined,
        sessionId: "scripted-no-provider-session",
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      },
    };
    this.options.onMessage({
      version: AGENT_IPC_VERSION,
      type: "completed",
      turnId: this.#turnId,
      result,
    });
  }
}

const script = (answer: number): string => `extends Node
var answer: int = ${answer}
var source_write_blocked: bool = false
func _ready() -> void:
    source_write_blocked = FileAccess.open("res://main.gd", FileAccess.WRITE) == null
`;

const gameOutput = (result: PiProxyToolResult) => {
  const response = InspectionToolResponseV1Schema.parse(result.details);
  if (response.outcome !== "success") throw new Error(JSON.stringify(response));
  return response.output;
};

const queryArguments = (executionId: string) => ({
  schemaVersion: 1,
  executionId,
  target: { path: "." },
  select: "values",
  names: ["answer", "source_write_blocked"],
});

const assertAnswer = (result: PiProxyToolResult, answer: number): void => {
  const output = InspectionQueryOutputV1Schema.parse(gameOutput(result));
  if (output.select !== "values")
    throw new Error("Expected actual runtime property values");
  expect(output.values).toMatchObject([
    { status: "success", value: answer },
    { status: "success", value: true },
  ]);
};

it("shares candidate edits while pinning independent Godot executions and scoped cancellation", async () => {
  if (process.env.GODOT_BIN === undefined)
    throw new Error(
      "GODOT_BIN is required for the multi-agent sandbox integration test",
    );
  const root = await mkdtemp(join(tmpdir(), "chronorift-multi-agent-sandbox-"));
  const source = join(root, "source");
  const state = join(root, "state");
  await mkdir(source, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  const taskId = asTaskId("task-multi-agent-sandbox");
  const layout = await createProjectEnvironmentTaskDirectoryLayout({
    runtimeRoot: state,
    sourceRepositoryRoot: source,
    taskId,
  });
  await writeFile(
    join(layout.workspaceDirectory, "project.godot"),
    'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  );
  await writeFile(
    join(layout.workspaceDirectory, "main.tscn"),
    '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n',
  );
  await writeFile(join(layout.workspaceDirectory, "main.gd"), script(0));
  const controller = new SrtSandboxController();
  const workers: ScriptedWorker[] = [];
  let environment: ProjectMultiAgentEnvironment | undefined;
  try {
    environment = await createProjectMultiAgentEnvironment({
      taskId,
      layout,
      controller,
      nodePath: await realpath(process.execPath),
      godotPath: await realpath(process.env.GODOT_BIN),
      provider: "test-no-provider",
      model: "test-no-model",
      thinkingLevel: "off",
      instructions: "Offline integration fixture; no provider calls.",
      configuration: { maxAgents: 2 },
      workerFactory: async (options) => {
        const worker = new ScriptedWorker(options);
        workers.push(worker);
        return worker;
      },
    });
    const activeEnvironment = environment;
    let rootCallId = 0;
    const rootTool = async (
      name: string,
      input: unknown,
    ): Promise<PiProxyToolResult> => {
      const tool = activeEnvironment.tools.find((tool) => tool.name === name);
      if (tool === undefined) throw new Error(`Missing Root tool ${name}`);
      return tool.execute(
        `root-${++rootCallId}`,
        input,
        undefined,
        undefined,
        {} as never,
      );
    };
    const rootLaunch = InspectionLaunchOutputV1Schema.parse(
      gameOutput(await rootTool("game_launch", { schemaVersion: 1 })),
    );
    assertAnswer(
      await rootTool("game_query", queryArguments(rootLaunch.executionId)),
      0,
    );
    const firstTarget = await environment.supervisor.spawnAgent(
      "Investigate candidate answer 11",
      { taskName: "first", forkTurns: "none" },
    );
    const secondTarget = await environment.supervisor.spawnAgent(
      "Investigate candidate answer 22",
      { taskName: "second", forkTurns: "none" },
    );
    const first = workers[0]!;
    const second = workers[1]!;
    const malformed = await first.request("write", {
      path: "main.gd",
      content: 123,
    });
    expect(malformed.isError).toBe(true);
    expect(
      await readFile(
        join(first.options.configuration.resourceWorkspaceDirectory, "main.gd"),
        "utf8",
      ),
    ).toBe(script(0));
    expect(
      (await first.request("write", { path: "main.gd", content: script(11) }))
        .isError,
    ).not.toBe(true);
    const firstLaunch = InspectionLaunchOutputV1Schema.parse(
      gameOutput(await first.request("game_launch", { schemaVersion: 1 })),
    );
    expect(first.options.configuration.resourceWorkspaceDirectory).toBe(
      layout.workspaceDirectory,
    );
    expect(second.options.configuration.resourceWorkspaceDirectory).toBe(
      layout.workspaceDirectory,
    );
    expect(
      (await second.request("write", { path: "main.gd", content: script(22) }))
        .isError,
    ).not.toBe(true);
    const secondLaunch = InspectionLaunchOutputV1Schema.parse(
      gameOutput(await second.request("game_launch", { schemaVersion: 1 })),
    );
    expect(
      new Set([
        rootLaunch.executionId,
        firstLaunch.executionId,
        secondLaunch.executionId,
      ]).size,
    ).toBe(3);
    expect(
      new Set([
        rootLaunch.sourceSha256,
        firstLaunch.sourceSha256,
        secondLaunch.sourceSha256,
      ]).size,
    ).toBe(3);
    assertAnswer(
      await first.request(
        "game_query",
        queryArguments(firstLaunch.executionId),
      ),
      11,
    );
    assertAnswer(
      await second.request(
        "game_query",
        queryArguments(secondLaunch.executionId),
      ),
      22,
    );
    assertAnswer(
      await rootTool("game_query", queryArguments(rootLaunch.executionId)),
      0,
    );
    const wrongExecution = InspectionToolResponseV1Schema.parse(
      (
        await first.request(
          "game_query",
          queryArguments(secondLaunch.executionId),
        )
      ).details,
    );
    expect(wrongExecution).toMatchObject({
      outcome: "error",
      error: { code: "execution_not_found" },
    });
    const privateRecord = join(
      second.options.configuration.sessionDirectory,
      "host-only.txt",
    );
    await writeFile(privateRecord, "private session data");
    const deniedRead = await first.request("bash", {
      command: `/usr/bin/cat -- ${quotePosixShellArg(privateRecord)}`,
      timeout: 5,
    });
    const deniedText = deniedRead.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    expect(deniedText).toMatch(/Permission denied|No such file or directory/u);
    expect(deniedText).not.toContain("private session data");
    expect(
      await readFile(join(layout.workspaceDirectory, "main.gd"), "utf8"),
    ).toBe(script(22));

    await environment.supervisor.interruptAgent(secondTarget.agentId);
    const cancelled = await environment.supervisor.waitForTurns(
      [secondTarget],
      "all",
      30_000,
    );
    expect(cancelled).toMatchObject({
      timedOut: false,
      results: [{ status: "cancelled" }],
    });
    const completedRecord = JSON.parse(
      await readFile(
        join(
          layout.taskRecordDirectory,
          "agents",
          secondTarget.agentId,
          `result-${secondTarget.turnId}.json`,
        ),
        "utf8",
      ),
    ) as { executions: unknown };
    const terminated = z
      .array(InspectionRunRecordV1Schema)
      .parse(completedRecord.executions);
    expect(terminated).toHaveLength(1);
    expect(terminated[0]).toMatchObject({
      executionId: secondLaunch.executionId,
      sourceUnchanged: true,
      run: { timedOut: false },
      error: null,
    });
    assertAnswer(
      await first.request(
        "game_query",
        queryArguments(firstLaunch.executionId),
      ),
      11,
    );
    assertAnswer(
      await rootTool("game_query", queryArguments(rootLaunch.executionId)),
      0,
    );
    expect(
      await readFile(join(layout.workspaceDirectory, "main.gd"), "utf8"),
    ).toBe(script(22));

    first.complete("The actual property query returned answer 11.");
    const finished = await environment.supervisor.waitForTurns(
      [firstTarget],
      "all",
      30_000,
    );
    expect(finished).toMatchObject({
      timedOut: false,
      results: [{ status: "completed" }],
    });
    expect(
      await readFile(join(layout.workspaceDirectory, "main.gd"), "utf8"),
    ).toBe(script(22));
    expect(
      environment.tools.some((tool) => tool.name === "apply_agent_patch"),
    ).toBe(false);
    // A previous execution still describes its own staged source after shared edits.
    assertAnswer(
      await rootTool("game_query", queryArguments(rootLaunch.executionId)),
      0,
    );
    const stopped = InspectionStopOutputV1Schema.parse(
      gameOutput(
        await rootTool("game_stop", {
          schemaVersion: 1,
          executionId: rootLaunch.executionId,
        }),
      ),
    );
    expect(stopped.record).toMatchObject({
      sourceUnchanged: true,
      error: null,
    });
    const integratedLaunch = InspectionLaunchOutputV1Schema.parse(
      gameOutput(await rootTool("game_launch", { schemaVersion: 1 })),
    );
    expect(integratedLaunch.executionId).not.toBe(rootLaunch.executionId);
    // Import-generated UID metadata can differ between independent stages.
    expect(integratedLaunch.sourceSha256).not.toBe(rootLaunch.sourceSha256);
    assertAnswer(
      await rootTool(
        "game_query",
        queryArguments(integratedLaunch.executionId),
      ),
      22,
    );
    const resumed = await environment.supervisor.followupTask(
      secondTarget.agentId,
      "Continue the existing worker Session",
    );
    await environment.supervisor.stopAgents();
    const stoppedTurns = await environment.supervisor.waitForTurns(
      [resumed],
      "all",
      30_000,
    );
    expect(stoppedTurns).toMatchObject({
      timedOut: false,
      results: [{ status: "cancelled" }],
    });
    const rootRecords = await Promise.all(
      environment
        .rootRecordPaths()
        .map(async (path) =>
          InspectionRunRecordV1Schema.parse(
            JSON.parse(await readFile(path, "utf8")),
          ),
        ),
    );
    expect(
      rootRecords.find(
        (record) => record.executionId === integratedLaunch.executionId,
      ),
    ).toMatchObject({
      sourceUnchanged: true,
      run: { timedOut: false },
      error: null,
    });
    const summary = await environment.writeSummary();
    const summaryRecord = z
      .object({
        turns: z.array(
          z.object({
            agentId: z.string(),
            turnId: z.number(),
            status: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(await readFile(summary.recordPath, "utf8")));
    expect(summaryRecord.turns).toContainEqual({
      agentId: resumed.agentId,
      turnId: resumed.turnId,
      status: "cancelled",
    });
  } finally {
    try {
      await environment?.close();
    } finally {
      try {
        await controller.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});
