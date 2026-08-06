import { chmod, lstat, mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { asTaskId, taskNamespaceDigestV1 } from "@chronorift/domain";

import { createTaskDirectoryLayout } from "./task-paths.js";

const roots: string[] = [];

const createRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("vNext task paths", () => {
  it("creates the exact private layout under an opaque Task namespace", async () => {
    const base = await createRoot("chronorift-task-paths-");
    const runtimeRoot = join(base, "runtime");
    const sourceRepositoryRoot = join(base, "source");
    await Promise.all([mkdir(runtimeRoot), mkdir(sourceRepositoryRoot)]);
    const taskId = asTaskId("../malicious/raw-task-id");

    const layout = await createTaskDirectoryLayout({
      runtimeRoot,
      sourceRepositoryRoot,
      taskId,
    });

    expect(basename(layout.taskRootDirectory)).toBe(
      taskNamespaceDigestV1(taskId),
    );
    const directories: readonly string[] = [
      layout.taskRootDirectory,
      layout.taskRecordDirectory,
      layout.workspaceDirectory,
      layout.sandboxTemporaryDirectory,
      layout.sandboxArtifactScratchDirectory,
      layout.hostBaselineGitDirectory,
      layout.hostOperationTemporaryDirectory,
    ];
    expect([...directories].sort()).toEqual(
      [
        layout.taskRootDirectory,
        join(layout.taskRootDirectory, "records"),
        join(layout.taskRootDirectory, "workspace"),
        join(layout.taskRootDirectory, "tmp"),
        join(layout.taskRootDirectory, "sandbox-artifacts"),
        join(layout.taskRootDirectory, "host-baseline.git"),
        join(layout.taskRootDirectory, "host-tmp"),
      ].sort(),
    );
    for (const directory of directories) {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    }
    expect(layout.taskRootDirectory).not.toContain("malicious");
  });

  it("rejects either ancestor direction between runtime and source", async () => {
    const base = await createRoot("chronorift-task-overlap-");
    const source = join(base, "source");
    const runtimeInsideSource = join(source, "runtime");
    await mkdir(runtimeInsideSource, { recursive: true });
    await expect(
      createTaskDirectoryLayout({
        runtimeRoot: runtimeInsideSource,
        sourceRepositoryRoot: source,
        taskId: asTaskId("task_1"),
      }),
    ).rejects.toThrow(/overlap/u);

    const runtime = join(base, "other-runtime");
    const sourceInsideRuntime = join(runtime, "source");
    await mkdir(sourceInsideRuntime, { recursive: true });
    await expect(
      createTaskDirectoryLayout({
        runtimeRoot: runtime,
        sourceRepositoryRoot: sourceInsideRuntime,
        taskId: asTaskId("task_2"),
      }),
    ).rejects.toThrow(/overlap/u);
  });

  it("rejects a symlink component and a duplicate Task namespace", async () => {
    const base = await createRoot("chronorift-task-symlink-");
    const actualRuntime = join(base, "actual-runtime");
    const runtimeLink = join(base, "runtime-link");
    const source = join(base, "source");
    await Promise.all([mkdir(actualRuntime), mkdir(source)]);
    await symlink(actualRuntime, runtimeLink, "dir");
    await expect(
      createTaskDirectoryLayout({
        runtimeRoot: runtimeLink,
        sourceRepositoryRoot: source,
        taskId: asTaskId("task_1"),
      }),
    ).rejects.toThrow(/symbolic link/u);

    const taskId = asTaskId("task_duplicate");
    await createTaskDirectoryLayout({
      runtimeRoot: actualRuntime,
      sourceRepositoryRoot: source,
      taskId,
    });
    await expect(
      createTaskDirectoryLayout({
        runtimeRoot: actualRuntime,
        sourceRepositoryRoot: source,
        taskId,
      }),
    ).rejects.toThrow(/already exists/u);
  });

  it("does not broaden permissions inherited from a permissive umask", async () => {
    const base = await createRoot("chronorift-task-mode-");
    const runtime = join(base, "runtime");
    const source = join(base, "source");
    await Promise.all([mkdir(runtime), mkdir(source)]);
    await chmod(runtime, 0o777);

    const layout = await createTaskDirectoryLayout({
      runtimeRoot: runtime,
      sourceRepositoryRoot: source,
      taskId: asTaskId("task_modes"),
    });
    expect((await lstat(layout.workspaceDirectory)).mode & 0o777).toBe(0o700);
  });
});
