import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asTaskId, TaskIdentityV1Schema } from "@chronorift/domain";
import { VNextTaskStore } from "@chronorift/json-artifacts";
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
      };
      expect(output.task.taskId).toBe(taskId);
      expect(output.turns).toEqual([
        expect.objectContaining({ assistantText: "Candidate ready" }),
      ]);
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
