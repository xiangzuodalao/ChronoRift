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

const SRT_TASKS_DIRECTORY = "srt-tasks-v1" as const;

export interface ProjectEnvironmentTaskDirectoryLayout {
  readonly taskRootDirectory: string;
  readonly taskRecordDirectory: string;
  readonly runtimeRecordDirectory: string;
  readonly workspaceDirectory: string;
  readonly sandboxTemporaryDirectory: string;
  readonly sandboxArtifactScratchDirectory: string;
  readonly piSessionDirectory: string;
  readonly hostBaselineGitDirectory: string;
  readonly hostOperationTemporaryDirectory: string;
  readonly projectEnvironmentRecordDirectory: string;
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

const PROJECT_ENVIRONMENT_TASK_CHILDREN = [
  ...TASK_CHILDREN,
  "project-environment-records",
] as const;

const layoutForRoot = (
  taskRootDirectory: string,
): ProjectEnvironmentTaskDirectoryLayout => ({
  taskRootDirectory,
  taskRecordDirectory: join(taskRootDirectory, "records"),
  runtimeRecordDirectory: join(taskRootDirectory, "runtime-records"),
  workspaceDirectory: join(taskRootDirectory, "workspace"),
  sandboxTemporaryDirectory: join(taskRootDirectory, "tmp"),
  sandboxArtifactScratchDirectory: join(taskRootDirectory, "sandbox-artifacts"),
  piSessionDirectory: join(taskRootDirectory, "pi-sessions"),
  hostBaselineGitDirectory: join(taskRootDirectory, "host-baseline.git"),
  hostOperationTemporaryDirectory: join(taskRootDirectory, "host-tmp"),
  projectEnvironmentRecordDirectory: join(
    taskRootDirectory,
    "project-environment-records",
  ),
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
  const tasksDirectory = join(runtimeRoot, SRT_TASKS_DIRECTORY);
  let created = false;
  try {
    await mkdir(tasksDirectory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw new M1Error(
        "artifact_write_failed",
        "unable to create the SRT tasks directory",
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
        "unable to make the new SRT tasks directory private",
        error,
      );
    }
  }
  return verifyPrivateOwnedDirectory(tasksDirectory, "SRT tasks directory");
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

/** One exact SRT task layout shared by the maintained Project Environment paths. */
export async function createProjectEnvironmentTaskDirectoryLayout(input: {
  readonly runtimeRoot: string;
  readonly sourceRepositoryRoot: string;
  readonly taskId: TaskId;
}): Promise<ProjectEnvironmentTaskDirectoryLayout> {
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
      "unable to create the Project Environment Task namespace",
      error,
    );
  }
  const createdRoot = await lstat(taskRootDirectory);
  const createdChildren: string[] = [];
  try {
    await chmod(taskRootDirectory, 0o700);
    await verifyPrivateOwnedDirectory(taskRootDirectory, "Task root directory");
    for (const child of PROJECT_ENVIRONMENT_TASK_CHILDREN) {
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
      "unable to create the complete Project Environment Task layout",
      error,
    );
  }
  return layoutForRoot(taskRootDirectory);
}

export async function openProjectEnvironmentTaskDirectoryLayout(input: {
  readonly runtimeRoot: string;
  readonly taskId: TaskId;
}): Promise<ProjectEnvironmentTaskDirectoryLayout> {
  const runtimeRoot = await canonicalizeExistingDirectoryWithoutSymlinks(
    input.runtimeRoot,
  );
  const tasksDirectory = await verifyPrivateOwnedDirectory(
    join(runtimeRoot, SRT_TASKS_DIRECTORY),
    "SRT tasks directory",
  );
  const taskRootDirectory = await verifyPrivateOwnedDirectory(
    join(tasksDirectory, taskNamespaceDigestV1(input.taskId)),
    "Task root directory",
  );
  const entries = (await readdir(taskRootDirectory)).sort();
  if (
    JSON.stringify(entries) !==
    JSON.stringify([...PROJECT_ENVIRONMENT_TASK_CHILDREN].sort())
  ) {
    throw new M1Error(
      "path_denied",
      "Task root is not the exact Project Environment V1 layout",
    );
  }
  for (const child of entries) {
    await verifyPrivateOwnedDirectory(
      join(taskRootDirectory, child),
      "Task lifecycle directory",
    );
  }
  return layoutForRoot(taskRootDirectory);
}
