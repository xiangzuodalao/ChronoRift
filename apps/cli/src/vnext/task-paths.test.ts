import { chmod, lstat, mkdir, mkdtemp, rmdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { asTaskId, taskNamespaceDigestV1 } from "@chronorift/domain";

import {
  createTaskDirectoryLayout,
  openTaskDirectoryLayout,
} from "./task-paths.js";

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
      layout.runtimeRecordDirectory,
      layout.workspaceDirectory,
      layout.sandboxTemporaryDirectory,
      layout.sandboxArtifactScratchDirectory,
      layout.piSessionDirectory,
      layout.hostBaselineGitDirectory,
      layout.hostOperationTemporaryDirectory,
    ];
    expect([...directories].sort()).toEqual(
      [
        layout.taskRootDirectory,
        join(layout.taskRootDirectory, "records"),
        join(layout.taskRootDirectory, "runtime-records"),
        join(layout.taskRootDirectory, "workspace"),
        join(layout.taskRootDirectory, "tmp"),
        join(layout.taskRootDirectory, "sandbox-artifacts"),
        join(layout.taskRootDirectory, "pi-sessions"),
        join(layout.taskRootDirectory, "host-baseline.git"),
        join(layout.taskRootDirectory, "host-tmp"),
      ].sort(),
    );
    for (const directory of directories) {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    }
    expect(layout.taskRootDirectory).not.toContain("malicious");
  });

  it("opens the exact pre-M3 layout without inventing its runtime store", async () => {
    const base = await createRoot("chronorift-task-paths-legacy-");
    const runtimeRoot = join(base, "runtime");
    const sourceRepositoryRoot = join(base, "source");
    await Promise.all([mkdir(runtimeRoot), mkdir(sourceRepositoryRoot)]);
    const taskId = asTaskId("task_legacy_layout");
    const created = await createTaskDirectoryLayout({
      runtimeRoot,
      sourceRepositoryRoot,
      taskId,
    });
    await rmdir(created.runtimeRecordDirectory);

    const opened = await openTaskDirectoryLayout({ runtimeRoot, taskId });

    expect(opened.runtimeRecordDirectory).toBe(
      join(opened.taskRootDirectory, "runtime-records"),
    );
    await expect(lstat(opened.runtimeRecordDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
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

  it("fails closed instead of taking over an existing permissive tasks directory", async () => {
    const base = await createRoot("chronorift-task-existing-mode-");
    const runtime = join(base, "runtime");
    const source = join(base, "source");
    const tasks = join(runtime, "tasks");
    await Promise.all([mkdir(runtime), mkdir(source)]);
    await mkdir(tasks);
    await chmod(tasks, 0o755);

    await expect(
      createTaskDirectoryLayout({
        runtimeRoot: runtime,
        sourceRepositoryRoot: source,
        taskId: asTaskId("task_existing_mode"),
      }),
    ).rejects.toThrow(/permissions changed/u);
    expect((await lstat(tasks)).mode & 0o777).toBe(0o755);
  });

  it("reopens only the exact private Task layout", async () => {
    const base = await createRoot("chronorift-task-reopen-");
    const runtime = join(base, "runtime");
    const source = join(base, "source");
    await Promise.all([mkdir(runtime), mkdir(source)]);
    const taskId = asTaskId("task_reopen");
    const created = await createTaskDirectoryLayout({
      runtimeRoot: runtime,
      sourceRepositoryRoot: source,
      taskId,
    });

    await expect(
      openTaskDirectoryLayout({ runtimeRoot: runtime, taskId }),
    ).resolves.toEqual(created);
    await chmod(created.piSessionDirectory, 0o755);
    await expect(
      openTaskDirectoryLayout({ runtimeRoot: runtime, taskId }),
    ).rejects.toThrow(/permissions changed/u);
  });

  it("rejects mode tampering at every owned resume boundary", async () => {
    const modeTamperCases = ["tasks", "task-root"] as const;
    for (const tamperCase of modeTamperCases) {
      const base = await createRoot(`chronorift-task-resume-${tamperCase}-`);
      const runtime = join(base, "runtime");
      const source = join(base, "source");
      await Promise.all([mkdir(runtime), mkdir(source)]);
      const taskId = asTaskId(`task_resume_${tamperCase}`);
      const created = await createTaskDirectoryLayout({
        runtimeRoot: runtime,
        sourceRepositoryRoot: source,
        taskId,
      });
      const tamperedPath =
        tamperCase === "tasks"
          ? join(runtime, "tasks")
          : created.taskRootDirectory;
      await chmod(tamperedPath, 0o755);

      await expect(
        openTaskDirectoryLayout({ runtimeRoot: runtime, taskId }),
      ).rejects.toThrow(/permissions changed/u);
    }
  });

  it("rejects lifecycle directories not owned by the current effective user", async () => {
    const actualEffectiveUserId = process.geteuid?.();
    if (actualEffectiveUserId === undefined) {
      throw new Error("this Linux-only boundary test requires process.geteuid");
    }

    const resumeBase = await createRoot("chronorift-task-owner-resume-");
    const resumeRuntime = join(resumeBase, "runtime");
    const resumeSource = join(resumeBase, "source");
    await Promise.all([mkdir(resumeRuntime), mkdir(resumeSource)]);
    const resumeTaskId = asTaskId("task_owner_resume");
    await createTaskDirectoryLayout({
      runtimeRoot: resumeRuntime,
      sourceRepositoryRoot: resumeSource,
      taskId: resumeTaskId,
    });

    const createBase = await createRoot("chronorift-task-owner-create-");
    const createRuntime = join(createBase, "runtime");
    const createSource = join(createBase, "source");
    await Promise.all([mkdir(createRuntime), mkdir(createSource)]);
    await mkdir(join(createRuntime, "tasks"), { mode: 0o700 });

    const getEffectiveUserId = vi
      .spyOn(process, "geteuid")
      .mockReturnValue(actualEffectiveUserId + 1);
    try {
      await expect(
        openTaskDirectoryLayout({
          runtimeRoot: resumeRuntime,
          taskId: resumeTaskId,
        }),
      ).rejects.toThrow(/ownership changed/u);
      await expect(
        createTaskDirectoryLayout({
          runtimeRoot: createRuntime,
          sourceRepositoryRoot: createSource,
          taskId: asTaskId("task_owner_create"),
        }),
      ).rejects.toThrow(/ownership changed/u);
    } finally {
      getEffectiveUserId.mockRestore();
    }
  });
});
