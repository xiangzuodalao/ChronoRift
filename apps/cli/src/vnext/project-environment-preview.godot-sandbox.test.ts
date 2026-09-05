import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  InspectionLaunchOutputV1Schema,
  InspectionQueryOutputV1Schema,
  InspectionRunRecordV1Schema,
  InspectionToolResponseV1Schema,
} from "@chronorift/domain";
import type {
  RunVNextPiSdkTurnOptions,
  VNextPiTurnResult,
} from "@chronorift/pi-harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runProjectEnvironmentPreviewV2,
  type ProjectEnvironmentPreviewDependenciesV2,
} from "./project-environment-preview.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const git = async (cwd: string, args: string[]) => {
  await execFileAsync("/usr/bin/git", args, {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Preview Test",
      GIT_AUTHOR_EMAIL: "test@chronorift.invalid",
      GIT_COMMITTER_NAME: "Preview Test",
      GIT_COMMITTER_EMAIL: "test@chronorift.invalid",
    },
  });
};
const setup = async () => {
  const godotBin = process.env.GODOT_BIN;
  if (!godotBin)
    throw new Error("GODOT_BIN is required for Preview sandbox integration");
  const root = await mkdtemp(join(tmpdir(), "chronorift-inspection-preview-"));
  roots.push(root);
  const repository = join(root, "repository");
  const project = join(repository, "game");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, ".godot-version"), "4.7.1\n");
  await writeFile(
    join(project, "project.godot"),
    'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  );
  await writeFile(
    join(project, "main.tscn"),
    '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n',
  );
  await writeFile(join(project, "main.gd"), "extends Node\nvar answer := 41\n");
  await writeFile(join(repository, ".gitignore"), ".chronorift/\n");
  await git(repository, ["init", "--quiet", "--initial-branch=main"]);
  await git(repository, ["add", "--all"]);
  await git(repository, ["commit", "--quiet", "-m", "fixture"]);
  // A dirty tracked file and explicitly included untracked file are source input.
  await writeFile(join(project, "main.gd"), "extends Node\nvar answer := 42\n");
  await writeFile(join(project, "notes.txt"), "selected untracked input\n");
  await mkdir(join(project, ".chronorift"));
  const oldState = join(project, ".chronorift/old-preview.json");
  await writeFile(oldState, "obsolete and deliberately invalid state\n");
  return {
    project,
    repository,
    oldState,
    request: {
      projectPath: repository,
      projectRoot: "game",
      includeUntrackedPaths: ["notes.txt"],
      stateRoot: join(root, "state"),
      godotBin,
      provider: "offline-test",
      model: "fake-pi",
      thinkingLevel: "off" as const,
      goal: "Inspect the answer and update it to 43",
    },
  };
};
const finish = async (
  options: RunVNextPiSdkTurnOptions,
): Promise<VNextPiTurnResult> => {
  const sessionId = options.newSessionId;
  if (!sessionId) throw new Error("Preview did not allocate a Session");
  const sessionFile = join(options.sessionDirectory, sessionId + ".jsonl");
  await writeFile(
    sessionFile,
    JSON.stringify({ type: "session", id: sessionId }) + "\n",
  );
  return {
    schemaVersion: 1,
    status: "completed",
    sessionId,
    sessionFile,
    provider: options.provider,
    model: options.model,
    requestedThinkingLevel: options.thinkingLevel,
    realizedThinkingLevel: options.thinkingLevel,
    activeTools: options.tools.map((tool) => tool.name),
    assistantText: "fake Pi completed",
    errorMessage: null,
    eventsObserved: 0,
    stats: {
      sessionFile,
      sessionId,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      cost: 0,
    },
  };
};
const toolInvoker = (options: RunVNextPiSdkTurnOptions) => {
  let sequence = 0;
  return async (name: string, input: unknown) => {
    const tool = options.tools.find((tool) => tool.name === name);
    if (!tool) throw new Error("Missing tool " + name);
    const result = await tool.execute(
      "test:" + ++sequence,
      input,
      undefined,
      undefined,
      {} as never,
    );
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("Expected text tool result");
    return content.text;
  };
};
const success = (text: string) => {
  const response = InspectionToolResponseV1Schema.parse(JSON.parse(text));
  if (response.outcome !== "success") throw new Error(text);
  return response.output;
};

describe("adapter-free Preview in the real SRT sandbox", () => {
  it("runs one direct Pi goal, inspects and relaunches edited source, and retains only ordinary run records and patch", async () => {
    const { project, oldState, request } = await setup();
    const runPiTurn: ProjectEnvironmentPreviewDependenciesV2["runPiTurn"] =
      vi.fn(async (options: RunVNextPiSdkTurnOptions) => {
        expect(options.prompt).toBe(request.goal);
        expect(options.environmentProfile).toBe("coding");
        expect(
          options.tools
            .filter((tool) => tool.name.startsWith("game_"))
            .map((tool) => tool.name),
        ).toEqual(["game_launch", "game_query", "game_watch", "game_stop"]);
        expect(
          options.tools.some((tool) => tool.name.includes("adapter")),
        ).toBe(false);
        expect(
          await readFile(
            join(options.resourceWorkspaceDirectory, "notes.txt"),
            "utf8",
          ),
        ).toBe("selected untracked input\n");
        const invoke = toolInvoker(options);
        const first = InspectionLaunchOutputV1Schema.parse(
          success(await invoke("game_launch", { schemaVersion: 1 })),
        );
        const query = async (executionId: string) => {
          const result = InspectionQueryOutputV1Schema.parse(
            success(
              await invoke("game_query", {
                schemaVersion: 1,
                executionId,
                select: "values",
                names: ["answer"],
              }),
            ),
          );
          if (result.select !== "values")
            throw new Error("Unexpected query result");
          return result.values[0];
        };
        expect(await query(first.executionId)).toMatchObject({
          status: "success",
          value: 42,
        });
        await invoke("edit", {
          path: "main.gd",
          edits: [{ oldText: "answer := 42", newText: "answer := 43" }],
        });
        expect(await query(first.executionId)).toMatchObject({
          status: "success",
          value: 42,
        });
        success(
          await invoke("game_stop", {
            schemaVersion: 1,
            executionId: first.executionId,
          }),
        );
        const second = InspectionLaunchOutputV1Schema.parse(
          success(await invoke("game_launch", { schemaVersion: 1 })),
        );
        expect(second.executionId).not.toBe(first.executionId);
        expect(second.sourceSha256).not.toBe(first.sourceSha256);
        expect(await query(second.executionId)).toMatchObject({
          status: "success",
          value: 43,
        });
        // Deliberately leave this execution running: Preview owns final cleanup.
        return finish(options);
      });
    const result = await runProjectEnvironmentPreviewV2(request, { runPiTurn });
    expect(runPiTurn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      schemaVersion: 2,
      status: "completed",
      goalDelivered: true,
      candidateSourceChanged: true,
      failureCode: null,
    });
    expect(result.executions).toHaveLength(2);
    for (const path of result.executions) {
      const record = InspectionRunRecordV1Schema.parse(
        JSON.parse(await readFile(path, "utf8")),
      );
      expect(record.sourceUnchanged).toBe(true);
      expect(record.error).toBeNull();
    }
    expect(await readFile(result.candidatePatch!.path, "utf8")).toContain(
      "+var answer := 43",
    );
    expect(await readFile(join(project, "main.gd"), "utf8")).toBe(
      "extends Node\nvar answer := 42\n",
    );
    expect(await readFile(oldState, "utf8")).toBe(
      "obsolete and deliberately invalid state\n",
    );
    expect(await readdir(join(project, ".chronorift"))).toEqual([
      "old-preview.json",
    ]);
    expect(await readdir(join(result.taskDirectory, "records"))).toEqual([
      "candidate.patch",
      "preview.v2.json",
    ]);
  });

  it("completes ordinary coding without requiring any game tool", async () => {
    const { request } = await setup();
    const result = await runProjectEnvironmentPreviewV2(request, {
      runPiTurn: finish,
    });
    expect(result).toMatchObject({
      status: "completed",
      executions: [],
      candidateSourceChanged: false,
      goalDelivered: true,
      failureCode: null,
    });
    expect(result.candidatePatch?.byteLength).toBe(0);
  });

  it("cleans up a live game and retains records when Pi fails", async () => {
    const { request } = await setup();
    const result = await runProjectEnvironmentPreviewV2(request, {
      runPiTurn: async (options) => {
        const invoke = toolInvoker(options);
        success(await invoke("game_launch", { schemaVersion: 1 }));
        throw new Error("deliberate provider failure");
      },
    });
    expect(result).toMatchObject({
      status: "failed",
      failureMessage: "deliberate provider failure",
    });
    expect(result.executions).toHaveLength(1);
    expect(
      InspectionRunRecordV1Schema.parse(
        JSON.parse(await readFile(result.executions[0]!, "utf8")),
      ).sourceUnchanged,
    ).toBe(true);
  });

  it("starts native interactive Pi directly without an authoring turn", async () => {
    const { request } = await setup();
    const runPiTurn = vi.fn(finish);
    const runInteractive: NonNullable<
      ProjectEnvironmentPreviewDependenciesV2["runInteractive"]
    > = vi.fn(
      async (
        options: Parameters<
          NonNullable<ProjectEnvironmentPreviewDependenciesV2["runInteractive"]>
        >[0],
      ) => {
        expect(options.sessionFile).toBeUndefined();
        expect(
          options.tools.filter((tool) => tool.name.startsWith("game_")),
        ).toHaveLength(4);
        const path = join(
          options.sessionDirectory,
          options.expectedSessionId + ".jsonl",
        );
        await writeFile(
          path,
          JSON.stringify({ type: "session", id: options.expectedSessionId }) +
            "\n",
        );
        return path;
      },
    );
    const result = await runProjectEnvironmentPreviewV2(
      { ...request, goal: null, interactive: true },
      { runPiTurn, runInteractive },
    );
    expect(result.status).toBe("completed");
    expect(runPiTurn).not.toHaveBeenCalled();
    expect(runInteractive).toHaveBeenCalledTimes(1);
  });
});
