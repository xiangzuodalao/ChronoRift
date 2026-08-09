import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asTaskId, TaskIdentityV1Schema } from "@chronorift/domain";
import { VNextRuntimeStore, VNextTaskStore } from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../main.js";
import {
  VNextAgentTaskV1Schema,
  VNextAgentTurnV1Schema,
} from "./task-agent-contracts.js";
import { createTaskDirectoryLayout } from "./task-paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("vNext task CLI", () => {
  it("requires bounded Task storage before starting an M3 Task", async () => {
    const prior = process.env.CHRONORIFT_TASK_STORAGE_ROOT;
    delete process.env.CHRONORIFT_TASK_STORAGE_ROOT;
    try {
      await expect(
        main(["task", "start", "--goal", "inspect"]),
      ).rejects.toThrow(
        "Missing --task-storage-root or CHRONORIFT_TASK_STORAGE_ROOT",
      );
    } finally {
      if (prior === undefined) delete process.env.CHRONORIFT_TASK_STORAGE_ROOT;
      else process.env.CHRONORIFT_TASK_STORAGE_ROOT = prior;
    }
  });

  it("rejects an M3 runtime root outside its bounded storage root", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-task-cli-"));
    roots.push(root);
    const taskStorageRoot = join(root, "bounded");
    const runtimeRoot = join(root, "outside-runtime");
    await Promise.all([mkdir(taskStorageRoot), mkdir(runtimeRoot)]);

    await expect(
      main([
        "task",
        "start",
        "--goal",
        "inspect",
        "--task-storage-root",
        taskStorageRoot,
        "--runtime-root",
        runtimeRoot,
      ]),
    ).rejects.toThrow(/strict child of --task-storage-root/iu);
  });

  it("does not create a runtime root through a task-storage symlink before admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-task-cli-"));
    roots.push(root);
    const taskStorageRoot = join(root, "storage");
    const outside = join(root, "outside");
    const escapedRuntimeRoot = join(taskStorageRoot, "link", "new");
    await Promise.all([mkdir(taskStorageRoot), mkdir(outside)]);
    await symlink(outside, join(taskStorageRoot, "link"));

    await expect(
      main([
        "task",
        "start",
        "--goal",
        "inspect",
        "--task-storage-root",
        taskStorageRoot,
        "--runtime-root",
        escapedRuntimeRoot,
      ]),
    ).rejects.toThrow();

    await expect(lstat(join(outside, "new"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not create the derived runtime root before environment-provided storage is admitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-task-cli-"));
    roots.push(root);
    const priorStorage = process.env.CHRONORIFT_TASK_STORAGE_ROOT;
    const priorCgroup = process.env.CHRONORIFT_CGROUP_ROOT;
    process.env.CHRONORIFT_TASK_STORAGE_ROOT = root;
    delete process.env.CHRONORIFT_CGROUP_ROOT;
    try {
      await expect(
        main(["task", "start", "--goal", "inspect"]),
      ).rejects.toThrow(/task storage/iu);
      await expect(lstat(join(root, "runtime"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (priorStorage === undefined)
        delete process.env.CHRONORIFT_TASK_STORAGE_ROOT;
      else process.env.CHRONORIFT_TASK_STORAGE_ROOT = priorStorage;
      if (priorCgroup === undefined) delete process.env.CHRONORIFT_CGROUP_ROOT;
      else process.env.CHRONORIFT_CGROUP_ROOT = priorCgroup;
    }
  });

  it("documents the M3 Task storage boundary", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await main(["help"]);
      const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(output).toContain("--task-storage-root PATH");
      expect(output).toContain("TASK_STORAGE_ROOT/runtime");
    } finally {
      write.mockRestore();
    }
  });

  it("parses the two-part task show command and returns persisted facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-task-cli-"));
    roots.push(root);
    const runtimeRoot = join(root, "runtime");
    const sourceRoot = join(root, "source");
    await Promise.all([mkdir(runtimeRoot), mkdir(sourceRoot)]);
    const taskId = asTaskId("task_cli_show");
    await createTaskDirectoryLayout({
      runtimeRoot,
      sourceRepositoryRoot: sourceRoot,
      taskId,
    });
    const runtimeStore = new VNextRuntimeStore(runtimeRoot);
    await runtimeStore.create(taskId);
    for (const [kind, resourceId] of [
      ["build", "build:cli"],
      ["execution", "execution:cli"],
    ] as const) {
      await runtimeStore.putResourceOnce(
        taskId,
        kind,
        resourceId,
        {
          schemaVersion: 1,
          taskId,
          createdAt: "2026-08-07T00:00:00.000Z",
        },
        (value) => TaskIdentityV1Schema.parse(value),
      );
    }
    await runtimeStore.sealExecution(taskId, "execution:cli");
    const store = new VNextTaskStore(runtimeRoot);
    await store.create(taskId);
    await store.putJsonOnce(
      taskId,
      "task.json",
      {
        schemaVersion: 1,
        taskId,
        createdAt: "2026-08-07T00:00:00.000Z",
      },
      (value) => TaskIdentityV1Schema.parse(value),
    );
    const task = VNextAgentTaskV1Schema.parse({
      schemaVersion: 1,
      taskId,
      goal: "Investigate the jump input",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "max",
      createdAt: "2026-08-07T00:00:00.000Z",
    });
    await store.putJsonOnce(taskId, "agent-task.json", task, (value) =>
      VNextAgentTaskV1Schema.parse(value),
    );
    const turn = VNextAgentTurnV1Schema.parse({
      schemaVersion: 1,
      taskId,
      turn: 1,
      kind: "start",
      prompt: task.goal,
      sessionId: "session-cli",
      sessionFile: "session.jsonl",
      status: "completed",
      provider: task.provider,
      model: task.model,
      requestedThinkingLevel: task.thinkingLevel,
      realizedThinkingLevel: task.thinkingLevel,
      activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      assistantText: "Candidate ready",
      errorMessage: null,
      eventsObserved: 3,
      stats: {
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: 4,
        tokens: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          total: 15,
        },
        cost: 0,
      },
      completedAt: "2026-08-07T00:01:00.000Z",
    });
    await store.append(taskId, "agent-turns.jsonl", turn, (value) =>
      VNextAgentTurnV1Schema.parse(value),
    );

    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await main([
        "task",
        "show",
        "--task-id",
        taskId,
        "--runtime-root",
        runtimeRoot,
      ]);
      const output = JSON.parse(
        write.mock.calls.map(([chunk]) => String(chunk)).join(""),
      ) as {
        task: { taskId: string };
        turns: Array<{ assistantText: string }>;
        runtimeResources: {
          kinds: Array<{
            resourceKind: string;
            count: number;
            resourceIds: string[];
          }>;
          executions: Array<{ executionId: string; sealed: boolean }>;
        };
      };
      expect(output.task.taskId).toBe(taskId);
      expect(output.turns).toEqual([
        expect.objectContaining({ assistantText: "Candidate ready" }),
      ]);
      expect(
        output.runtimeResources.kinds.find(
          (entry) => entry.resourceKind === "build",
        ),
      ).toEqual({
        resourceKind: "build",
        count: 1,
        resourceIds: ["build:cli"],
      });
      expect(output.runtimeResources.executions).toEqual([
        { executionId: "execution:cli", sealed: true },
      ]);
      expect(JSON.stringify(output.runtimeResources)).not.toMatch(
        /oracle|verdict|evaluator/iu,
      );
    } finally {
      write.mockRestore();
    }
  });

  it("rejects unknown task subcommands before any environment action", async () => {
    await expect(main(["task", "unknown"])).rejects.toThrow(
      "Unknown command: task-unknown",
    );
  });

  it("rejects a Task identity record detached from the requested namespace", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-task-cli-"));
    roots.push(root);
    const runtimeRoot = join(root, "runtime");
    const sourceRoot = join(root, "source");
    await Promise.all([mkdir(runtimeRoot), mkdir(sourceRoot)]);
    const taskId = asTaskId("task_cli_requested");
    await createTaskDirectoryLayout({
      runtimeRoot,
      sourceRepositoryRoot: sourceRoot,
      taskId,
    });
    const store = new VNextTaskStore(runtimeRoot);
    await store.create(taskId);
    await store.putJsonOnce(
      taskId,
      "task.json",
      {
        schemaVersion: 1,
        taskId: asTaskId("task_cli_detached"),
        createdAt: "2026-08-07T00:00:00.000Z",
      },
      (value) => TaskIdentityV1Schema.parse(value),
    );

    await expect(
      main([
        "task",
        "show",
        "--task-id",
        taskId,
        "--runtime-root",
        runtimeRoot,
      ]),
    ).rejects.toThrow("Task identity does not match");
  });
});
