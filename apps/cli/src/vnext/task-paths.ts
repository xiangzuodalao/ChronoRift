import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rmdir,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { taskNamespaceDigestV1, type TaskId } from "@chronorift/domain";

import { M1Error } from "./errors.js";

export interface TaskDirectoryLayout {
  readonly taskRootDirectory: string;
  readonly taskRecordDirectory: string;
  readonly runtimeRecordDirectory: string;
  readonly workspaceDirectory: string;
  readonly sandboxTemporaryDirectory: string;
  readonly sandboxArtifactScratchDirectory: string;
  readonly piSessionDirectory: string;
  readonly hostBaselineGitDirectory: string;
  readonly hostOperationTemporaryDirectory: string;
}

const TASK_CHILDREN = [
  "records",
  "runtime-records",
  "workspace",
  "tmp",
  "sandbox-artifacts",
  "pi-sessions",
  "host-baseline.git",
  "host-tmp",
] as const;

const LEGACY_TASK_CHILDREN = TASK_CHILDREN.filter(
  (child) => child !== "runtime-records",
);

const layoutForRoot = (taskRootDirectory: string): TaskDirectoryLayout => ({
  taskRootDirectory,
  taskRecordDirectory: join(taskRootDirectory, "records"),
  runtimeRecordDirectory: join(taskRootDirectory, "runtime-records"),
  workspaceDirectory: join(taskRootDirectory, "workspace"),
  sandboxTemporaryDirectory: join(taskRootDirectory, "tmp"),
  sandboxArtifactScratchDirectory: join(taskRootDirectory, "sandbox-artifacts"),
  piSessionDirectory: join(taskRootDirectory, "pi-sessions"),
  hostBaselineGitDirectory: join(taskRootDirectory, "host-baseline.git"),
  hostOperationTemporaryDirectory: join(taskRootDirectory, "host-tmp"),
});

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const pathIsWithinOrEqual = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) &&
      difference !== ".." &&
      !isAbsolute(difference))
  );
};

const canonicalizeExistingDirectoryWithoutSymlinks = async (
  inputPath: string,
): Promise<string> => {
  const absolutePath = resolve(inputPath);
  const root = parse(absolutePath).root;
  let currentPath = root;
  const segments = absolutePath.slice(root.length).split(sep).filter(Boolean);
  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    let statistics: Stats;
    try {
      statistics = await lstat(currentPath);
    } catch (error) {
      throw new M1Error(
        "path_denied",
        "task path contains a missing or inaccessible component",
        error,
      );
    }
    if (statistics.isSymbolicLink()) {
      throw new M1Error(
        "path_denied",
        "task path must not contain a symbolic link component",
      );
    }
  }

  const finalStatistics = await lstat(absolutePath);
  if (!finalStatistics.isDirectory()) {
    throw new M1Error("path_denied", "task path must name a directory");
  }
  const canonicalPath = await realpath(absolutePath);
  if (canonicalPath !== absolutePath) {
    throw new M1Error(
      "path_denied",
      "task path must already be canonical and contain no symbolic links",
    );
  }
  return canonicalPath;
};

const verifyPrivateOwnedDirectory = async (
  inputPath: string,
  label: string,
): Promise<string> => {
  const canonicalPath =
    await canonicalizeExistingDirectoryWithoutSymlinks(inputPath);
  const effectiveUserId = process.geteuid?.();
  if (effectiveUserId === undefined) {
    throw new M1Error(
      "path_denied",
      `unable to verify ${label} ownership on this platform`,
    );
  }
  const statistics = await lstat(canonicalPath);
  if (statistics.isSymbolicLink() || !statistics.isDirectory()) {
    throw new M1Error("path_denied", `${label} must remain a real directory`);
  }
  if (statistics.uid !== effectiveUserId) {
    throw new M1Error("path_denied", `${label} ownership changed`);
  }
  if ((statistics.mode & 0o7777) !== 0o700) {
    throw new M1Error("path_denied", `${label} permissions changed`);
  }
  return canonicalPath;
};

const ensureTasksDirectory = async (runtimeRoot: string): Promise<string> => {
  const tasksDirectory = join(runtimeRoot, "tasks");
  let created = false;
  try {
    await mkdir(tasksDirectory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw new M1Error(
        "artifact_write_failed",
        "unable to create the vNext tasks directory",
        error,
      );
    }
  }
  if (created) {
    try {
      await chmod(tasksDirectory, 0o700);
    } catch (error) {
      throw new M1Error(
        "artifact_write_failed",
        "unable to make the new vNext tasks directory private",
        error,
      );
    }
  }
  return verifyPrivateOwnedDirectory(tasksDirectory, "vNext tasks directory");
};

const rollbackCreatedRoot = async (
  taskRootDirectory: string,
  expectedRoot: Pick<Stats, "dev" | "ino">,
  createdChildren: readonly string[],
): Promise<void> => {
  let current: Stats;
  try {
    current = await lstat(taskRootDirectory);
  } catch {
    return;
  }
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== expectedRoot.dev ||
    current.ino !== expectedRoot.ino
  ) {
    return;
  }
  for (const child of [...createdChildren].reverse()) {
    await rmdir(child).catch(() => undefined);
  }
  await rmdir(taskRootDirectory).catch(() => undefined);
};

export async function createTaskDirectoryLayout(input: {
  readonly runtimeRoot: string;
  readonly sourceRepositoryRoot: string;
  readonly taskId: TaskId;
}): Promise<TaskDirectoryLayout> {
  const [runtimeRoot, sourceRepositoryRoot] = await Promise.all([
    canonicalizeExistingDirectoryWithoutSymlinks(input.runtimeRoot),
    canonicalizeExistingDirectoryWithoutSymlinks(input.sourceRepositoryRoot),
  ]);
  if (
    pathIsWithinOrEqual(runtimeRoot, sourceRepositoryRoot) ||
    pathIsWithinOrEqual(sourceRepositoryRoot, runtimeRoot)
  ) {
    throw new M1Error(
      "path_denied",
      "runtime root and source repository must not overlap",
    );
  }

  const tasksDirectory = await ensureTasksDirectory(runtimeRoot);
  const taskRootDirectory = join(
    tasksDirectory,
    taskNamespaceDigestV1(input.taskId),
  );
  try {
    await mkdir(taskRootDirectory, { mode: 0o700 });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new M1Error(
        "artifact_write_failed",
        "Task namespace already exists",
        error,
      );
    }
    throw new M1Error(
      "artifact_write_failed",
      "unable to create the Task namespace",
      error,
    );
  }

  let createdRoot: Stats;
  try {
    createdRoot = await lstat(taskRootDirectory);
  } catch (error) {
    throw new M1Error(
      "artifact_write_failed",
      "unable to verify the newly created Task namespace",
      error,
    );
  }
  const createdChildren: string[] = [];
  try {
    await chmod(taskRootDirectory, 0o700);
    await verifyPrivateOwnedDirectory(taskRootDirectory, "Task root directory");
    for (const child of TASK_CHILDREN) {
      const childPath = join(taskRootDirectory, child);
      await mkdir(childPath, { mode: 0o700 });
      createdChildren.push(childPath);
      await chmod(childPath, 0o700);
      await verifyPrivateOwnedDirectory(childPath, "Task lifecycle directory");
    }
  } catch (error) {
    await rollbackCreatedRoot(taskRootDirectory, createdRoot, createdChildren);
    throw new M1Error(
      "artifact_write_failed",
      "unable to create the complete private Task directory layout",
      error,
    );
  }

  return layoutForRoot(taskRootDirectory);
}

export async function openTaskDirectoryLayout(input: {
  readonly runtimeRoot: string;
  readonly taskId: TaskId;
}): Promise<TaskDirectoryLayout> {
  const runtimeRoot = await canonicalizeExistingDirectoryWithoutSymlinks(
    input.runtimeRoot,
  );
  const tasksDirectory = await verifyPrivateOwnedDirectory(
    join(runtimeRoot, "tasks"),
    "vNext tasks directory",
  );
  const taskRootDirectory = await verifyPrivateOwnedDirectory(
    join(tasksDirectory, taskNamespaceDigestV1(input.taskId)),
    "Task root directory",
  );
  const entries = (await readdir(taskRootDirectory)).sort();
  const currentEntries = JSON.stringify(entries);
  const currentLayout = JSON.stringify([...TASK_CHILDREN].sort());
  const legacyLayout = JSON.stringify([...LEGACY_TASK_CHILDREN].sort());
  if (currentEntries !== currentLayout && currentEntries !== legacyLayout) {
    throw new M1Error(
      "path_denied",
      "Task root does not contain the exact owned lifecycle directories",
    );
  }
  for (const child of entries) {
    const path = join(taskRootDirectory, child);
    await verifyPrivateOwnedDirectory(path, "Task lifecycle directory");
  }
  return layoutForRoot(taskRootDirectory);
}
