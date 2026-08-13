import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { M1Error } from "./errors.js";
import { NodeHostGitPort, type HostGitPort } from "./host-git.js";
import type { VerifiedProjectEnvironmentSourceV1 } from "./source-preflight.js";

export const PROJECT_ENVIRONMENT_LOCAL_ROOT_V1 = ".chronorift" as const;
export const PROJECT_ENVIRONMENT_LOCAL_IGNORE_BYTES_V1 = "*\n" as const;
export const PROJECT_ENVIRONMENT_LOCAL_NAMESPACE_V1 =
  "project-environment-v1" as const;

export interface PreparedProjectEnvironmentProjectStoreV1 {
  readonly projectRoot: string;
  readonly localRoot: string;
  readonly namespaceRoot: string;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
};

const assertCanonicalDirectory = async (
  path: string,
  label: string,
): Promise<void> => {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (await realpath(path)) !== path
  ) {
    throw new M1Error(
      "path_denied",
      `${label} must be a canonical non-symlink directory`,
    );
  }
};

const sameFileIdentity = (
  left: Awaited<ReturnType<FileHandle["stat"]>>,
  right: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const readExactLocalIgnore = async (path: string): Promise<void> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 16) {
      throw new M1Error(
        "path_denied",
        "Project Environment local ignore marker is not a bounded regular file",
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      !sameFileIdentity(before, after) ||
      !bytes.equals(Buffer.from(PROJECT_ENVIRONMENT_LOCAL_IGNORE_BYTES_V1))
    ) {
      throw new M1Error(
        "source_configuration_mismatch",
        "Project Environment requires .chronorift/.gitignore to contain exactly '*\\n'",
      );
    }
  } finally {
    await handle.close();
  }
};

const createExactLocalIgnore = async (path: string): Promise<void> => {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(PROJECT_ENVIRONMENT_LOCAL_IGNORE_BYTES_V1, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * Creates only the local, self-ignoring project namespace. Immutable revision
 * bytes and the current pointer remain owned by the project-store adapter.
 */
export async function prepareProjectEnvironmentProjectStoreV1(
  source: VerifiedProjectEnvironmentSourceV1,
  git: HostGitPort = new NodeHostGitPort(),
): Promise<PreparedProjectEnvironmentProjectStoreV1> {
  const projectRoot = resolve(source.projectRoot);
  if (
    projectRoot !== source.projectRoot ||
    projectRoot !== source.repositoryRoot ||
    source.projectPrefix !== ""
  ) {
    throw new M1Error(
      "path_denied",
      "PE-A project store requires the verified repository-root project",
    );
  }
  await assertCanonicalDirectory(projectRoot, "Project root");
  if (
    source.entries.some(
      (entry) =>
        entry.relativePath === PROJECT_ENVIRONMENT_LOCAL_ROOT_V1 ||
        entry.relativePath.startsWith(`${PROJECT_ENVIRONMENT_LOCAL_ROOT_V1}/`),
    )
  ) {
    throw new M1Error(
      "path_denied",
      "tracked .chronorift content prevents local Project Environment initialization",
    );
  }

  const localRoot = join(projectRoot, PROJECT_ENVIRONMENT_LOCAL_ROOT_V1);
  if (!(await exists(localRoot))) {
    await mkdir(localRoot, { mode: 0o700 });
  }
  await assertCanonicalDirectory(localRoot, "Project Environment local root");

  const ignorePath = join(localRoot, ".gitignore");
  if (await exists(ignorePath)) {
    await readExactLocalIgnore(ignorePath);
  } else {
    await createExactLocalIgnore(ignorePath);
    await readExactLocalIgnore(ignorePath);
  }

  const namespaceRoot = join(localRoot, PROJECT_ENVIRONMENT_LOCAL_NAMESPACE_V1);
  if (!(await exists(namespaceRoot))) {
    await mkdir(namespaceRoot, { mode: 0o700 });
  }
  await assertCanonicalDirectory(
    namespaceRoot,
    "Project Environment revision namespace",
  );

  const status = await git.statusPorcelain(projectRoot);
  if (status.byteLength !== 0) {
    throw new M1Error(
      "source_not_clean",
      "local Project Environment setup did not preserve a clean Git worktree",
    );
  }
  return Object.freeze({ projectRoot, localRoot, namespaceRoot });
}
