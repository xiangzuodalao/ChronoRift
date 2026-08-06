import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { TaskId } from "@chronorift/domain";

import {
  WorkspaceMaterializationReceiptV1Schema,
  type TaskFixtureCapabilityV1,
  type WorkspaceMaterializationReceiptV1,
} from "./contracts.js";
import { M1Error } from "./errors.js";
import {
  NodeHostGitPort,
  type HostGitIndexEntry,
  type HostGitPort,
  type HostGitRepositoryContext,
} from "./host-git.js";
import {
  selectedTreeSha256FromSources,
  type SelectedTreeContentSourceV1,
} from "./selected-tree.js";
import {
  parseGitTreeListing,
  type VerifiedGitSubtree,
  type VerifiedGitTreeEntry,
} from "./source-preflight.js";
import type { TaskDirectoryLayout } from "./task-paths.js";

export interface MaterializedPrivateTaskWorkspace {
  readonly workspaceDirectory: string;
  readonly hostBaselineGitDirectory: string;
  readonly agentBaselineCommit: string;
  readonly hostBaselineCommit: string;
  readonly receipt: WorkspaceMaterializationReceiptV1;
  readonly fixtureCapability: TaskFixtureCapabilityV1;
}

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

const verifyLayoutBoundary = async (
  layout: TaskDirectoryLayout,
): Promise<void> => {
  const paths = [
    layout.taskRootDirectory,
    layout.workspaceDirectory,
    layout.hostBaselineGitDirectory,
    layout.hostOperationTemporaryDirectory,
  ];
  for (const path of paths) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new M1Error(
        "artifact_write_failed",
        "private Task layout contains a non-directory or symbolic link",
      );
    }
    if ((await realpath(path)) !== path) {
      throw new M1Error(
        "artifact_write_failed",
        "private Task layout path is not canonical",
      );
    }
    if (!pathIsWithinOrEqual(layout.taskRootDirectory, path)) {
      throw new M1Error(
        "artifact_write_failed",
        "private Task layout escaped its Task root",
      );
    }
  }
  for (const writableRoot of [
    layout.workspaceDirectory,
    layout.sandboxTemporaryDirectory,
    layout.sandboxArtifactScratchDirectory,
  ]) {
    if (pathIsWithinOrEqual(writableRoot, layout.hostBaselineGitDirectory)) {
      throw new M1Error(
        "artifact_write_failed",
        "Host baseline Git must be outside sandbox-writable roots",
      );
    }
  }
};

const ensureSafeParentDirectories = async (
  workspaceRoot: string,
  relativePath: string,
): Promise<void> => {
  const parts = relativePath.split("/");
  if (
    parts.length === 0 ||
    parts.some(
      (part) =>
        part.length === 0 || part === "." || part === ".." || part === ".git",
    ) ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) {
    throw new M1Error(
      "artifact_write_failed",
      "verified source contains an unsafe materialization path",
    );
  }

  let current = workspaceRoot;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
      await chmod(current, 0o700);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new M1Error(
        "artifact_write_failed",
        "materialization parent is not a real directory",
      );
    }
  }
};

const materializeSourceFiles = async (input: {
  readonly git: HostGitPort;
  readonly source: VerifiedGitSubtree;
  readonly workspaceDirectory: string;
}): Promise<void> => {
  for (const entry of input.source.entries) {
    await ensureSafeParentDirectories(
      input.workspaceDirectory,
      entry.relativePath,
    );
    const destinationPath = join(input.workspaceDirectory, entry.relativePath);
    const destination = await open(
      destinationPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const receipt = await input.git.streamBlob({
        cwd: input.source.repositoryRoot,
        objectId: entry.objectId,
        destination,
      });
      if (receipt.byteLength !== entry.byteLength) {
        throw new M1Error(
          "artifact_write_failed",
          "materialized blob length does not match verified source metadata",
        );
      }
      await destination.chmod(entry.mode === "100755" ? 0o755 : 0o644);
      await destination.sync();
    } finally {
      await destination.close();
    }
  }
};

const hashWorkspaceIntoRepository = async (input: {
  readonly git: HostGitPort;
  readonly workspaceDirectory: string;
  readonly context: HostGitRepositoryContext;
  readonly entries: readonly VerifiedGitTreeEntry[];
}): Promise<readonly HostGitIndexEntry[]> => {
  const indexEntries: HostGitIndexEntry[] = [];
  for (const entry of input.entries) {
    const absolutePath = join(input.workspaceDirectory, entry.relativePath);
    const before = await lstat(absolutePath);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new M1Error(
        "artifact_write_failed",
        "workspace file changed type before baseline hashing",
      );
    }
    const source = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const objectId = await input.git.hashBlob({
        context: input.context,
        source,
      });
      const after = await source.stat();
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mode !== before.mode ||
        after.size !== before.size ||
        after.size !== entry.byteLength
      ) {
        throw new M1Error(
          "artifact_write_failed",
          "workspace file changed while baseline was hashed",
        );
      }
      indexEntries.push({
        relativePath: entry.relativePath,
        mode: entry.mode,
        objectId,
      });
    } finally {
      await source.close();
    }
  }
  return indexEntries;
};

const createBaselineCommit = async (input: {
  readonly git: HostGitPort;
  readonly context: HostGitRepositoryContext;
  readonly indexEntries: readonly HostGitIndexEntry[];
  readonly setAgentHead: boolean;
}): Promise<string> => {
  await input.git.readTreeEmpty(input.context);
  await input.git.updateIndex({
    context: input.context,
    entries: input.indexEntries,
  });
  const treeId = await input.git.writeTree(input.context);
  const commit = await input.git.commitTree({
    context: input.context,
    treeId,
  });
  if (input.setAgentHead) {
    await input.git.setAgentBaselineHead({
      context: input.context,
      commit,
    });
  }
  return commit;
};

const assertSameTreeMetadata = (
  expected: readonly VerifiedGitTreeEntry[],
  actual: readonly VerifiedGitTreeEntry[],
): void => {
  if (expected.length !== actual.length) {
    throw new M1Error(
      "artifact_write_failed",
      "private baseline tree entry count does not match source",
    );
  }
  for (const [index, expectedEntry] of expected.entries()) {
    const actualEntry = actual[index];
    if (
      actualEntry === undefined ||
      actualEntry.relativePath !== expectedEntry.relativePath ||
      actualEntry.mode !== expectedEntry.mode ||
      actualEntry.byteLength !== expectedEntry.byteLength
    ) {
      throw new M1Error(
        "artifact_write_failed",
        "private baseline tree metadata does not match source",
      );
    }
  }
};

const verifyBaselineTree = async (input: {
  readonly git: HostGitPort;
  readonly context: HostGitRepositoryContext;
  readonly commit: string;
  readonly expectedEntries: readonly VerifiedGitTreeEntry[];
  readonly expectedSelectedTreeSha256: string;
  readonly temporaryRoot: string;
  readonly label: string;
}): Promise<void> => {
  const listing = await input.git.listTree({
    context: input.context,
    treeish: input.commit,
  });
  const entries = parseGitTreeListing(listing, "");
  assertSameTreeMetadata(input.expectedEntries, entries);
  const verificationDirectory = await mkdtemp(
    join(input.temporaryRoot, `verify-${input.label}-`),
  );
  try {
    const sources: SelectedTreeContentSourceV1[] = [];
    for (const [index, entry] of entries.entries()) {
      const blobPath = join(verificationDirectory, index.toString(16));
      const destination = await open(
        blobPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const receipt = await input.git.streamBlob({
          cwd: input.context.cwd,
          objectId: entry.objectId,
          destination,
          ...(input.context.gitDirectory === undefined
            ? {}
            : { gitDirectory: input.context.gitDirectory }),
          ...(input.context.workTree === undefined
            ? {}
            : { workTree: input.context.workTree }),
        });
        if (receipt.byteLength !== entry.byteLength) {
          throw new M1Error(
            "artifact_write_failed",
            "private baseline blob length does not match its tree",
          );
        }
        await destination.sync();
      } finally {
        await destination.close();
      }
      sources.push({
        relativePath: entry.relativePath,
        mode: entry.mode,
        byteLength: entry.byteLength,
        async *chunks() {
          const source = await open(
            blobPath,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            for await (const chunk of source.createReadStream({
              autoClose: false,
              start: 0,
            })) {
              yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            }
          } finally {
            await source.close();
          }
        },
      });
    }
    const selectedTreeSha256 = await selectedTreeSha256FromSources(sources);
    if (selectedTreeSha256 !== input.expectedSelectedTreeSha256) {
      throw new M1Error(
        "artifact_write_failed",
        "private baseline Git does not reproduce the selected source tree",
      );
    }
  } finally {
    await rm(verificationDirectory, { recursive: true, force: true });
  }
};

const stagingIsRegistered = (
  worktreeListing: Uint8Array,
  stagingPath: string,
): boolean => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    worktreeListing,
  );
  return text.split("\n").some((line) => line === `worktree ${stagingPath}`);
};

const cleanupStagingWorktree = async (input: {
  readonly git: HostGitPort;
  readonly repositoryRoot: string;
  readonly stagingPath: string;
  readonly addWasAttempted: boolean;
}): Promise<void> => {
  const before = await input.git.listWorktrees(input.repositoryRoot);
  if (input.addWasAttempted || stagingIsRegistered(before, input.stagingPath)) {
    try {
      await input.git.removeWorktree({
        repositoryRoot: input.repositoryRoot,
        worktreePath: input.stagingPath,
      });
    } catch (error) {
      const afterFailure = await input.git.listWorktrees(input.repositoryRoot);
      if (stagingIsRegistered(afterFailure, input.stagingPath)) throw error;
    }
  }
  const after = await input.git.listWorktrees(input.repositoryRoot);
  if (stagingIsRegistered(after, input.stagingPath)) {
    throw new Error("staging worktree remains registered after cleanup");
  }
};

export async function materializePrivateTaskWorkspace(
  request: {
    readonly taskId: TaskId;
    readonly source: VerifiedGitSubtree;
    readonly layout: TaskDirectoryLayout;
  },
  dependencies?: { readonly git?: HostGitPort },
): Promise<MaterializedPrivateTaskWorkspace> {
  const git = dependencies?.git ?? new NodeHostGitPort();
  await verifyLayoutBoundary(request.layout);
  const stagingPath = join(
    request.layout.hostOperationTemporaryDirectory,
    "staging-worktree",
  );
  let addWasAttempted = false;
  let result: MaterializedPrivateTaskWorkspace | undefined;
  let operationError: unknown;
  try {
    try {
      await lstat(stagingPath);
      throw new M1Error(
        "artifact_write_failed",
        "staging worktree path must not already exist",
      );
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    addWasAttempted = true;
    await git.addDetachedNoCheckoutWorktree({
      repositoryRoot: request.source.repositoryRoot,
      worktreePath: stagingPath,
      commit: request.source.headCommit,
    });

    await materializeSourceFiles({
      git,
      source: request.source,
      workspaceDirectory: request.layout.workspaceDirectory,
    });
    await git.initializeRepository({
      directory: request.layout.workspaceDirectory,
      bare: false,
    });
    await git.initializeRepository({
      directory: request.layout.hostBaselineGitDirectory,
      bare: true,
    });

    const agentContext: HostGitRepositoryContext = {
      cwd: request.layout.workspaceDirectory,
      gitDirectory: join(request.layout.workspaceDirectory, ".git"),
      workTree: request.layout.workspaceDirectory,
      indexFile: join(request.layout.workspaceDirectory, ".git", "index"),
    };
    const hostIndexFile = join(
      request.layout.hostOperationTemporaryDirectory,
      "host-baseline.index",
    );
    const hostContext: HostGitRepositoryContext = {
      cwd: request.layout.hostBaselineGitDirectory,
      gitDirectory: request.layout.hostBaselineGitDirectory,
      indexFile: hostIndexFile,
    };

    try {
      const agentIndexEntries = await hashWorkspaceIntoRepository({
        git,
        workspaceDirectory: request.layout.workspaceDirectory,
        context: agentContext,
        entries: request.source.entries,
      });
      const hostIndexEntries = await hashWorkspaceIntoRepository({
        git,
        workspaceDirectory: request.layout.workspaceDirectory,
        context: hostContext,
        entries: request.source.entries,
      });
      const agentBaselineCommit = await createBaselineCommit({
        git,
        context: agentContext,
        indexEntries: agentIndexEntries,
        setAgentHead: true,
      });
      const hostBaselineCommit = await createBaselineCommit({
        git,
        context: hostContext,
        indexEntries: hostIndexEntries,
        setAgentHead: false,
      });
      await verifyBaselineTree({
        git,
        context: agentContext,
        commit: agentBaselineCommit,
        expectedEntries: request.source.entries,
        expectedSelectedTreeSha256: request.source.selectedTreeSha256,
        temporaryRoot: request.layout.hostOperationTemporaryDirectory,
        label: "agent",
      });
      await verifyBaselineTree({
        git,
        context: hostContext,
        commit: hostBaselineCommit,
        expectedEntries: request.source.entries,
        expectedSelectedTreeSha256: request.source.selectedTreeSha256,
        temporaryRoot: request.layout.hostOperationTemporaryDirectory,
        label: "host",
      });

      const receipt = WorkspaceMaterializationReceiptV1Schema.parse({
        schemaVersion: 1,
        taskId: request.taskId,
        repositoryIdentity: request.source.repositoryIdentity,
        sourceRevision: request.source.headCommit,
        projectPrefix: request.source.projectPrefix,
        selectedTreeSha256: request.source.selectedTreeSha256,
        agentBaselineCommit,
        hostBaselineCommit,
        copyRule: "git-object-plumbing-v1",
        excludedCachePaths: request.source.fixtureCapability.ignoredCachePaths,
        fixtureCapabilitySha256:
          request.source.fixtureCapability.capabilitySha256,
      });
      result = {
        workspaceDirectory: request.layout.workspaceDirectory,
        hostBaselineGitDirectory: request.layout.hostBaselineGitDirectory,
        agentBaselineCommit,
        hostBaselineCommit,
        receipt,
        fixtureCapability: request.source.fixtureCapability,
      };
    } finally {
      await unlink(hostIndexFile).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
    }
  } catch (error) {
    operationError = error;
  }

  try {
    await cleanupStagingWorktree({
      git,
      repositoryRoot: request.source.repositoryRoot,
      stagingPath,
      addWasAttempted,
    });
  } catch (cleanupError) {
    throw new M1Error(
      "artifact_write_failed",
      "staging worktree cleanup could not be proven",
      cleanupError,
    );
  }
  if (operationError !== undefined) {
    if (operationError instanceof M1Error) throw operationError;
    throw new M1Error(
      "artifact_write_failed",
      "private Task workspace materialization failed",
      operationError,
    );
  }
  if (result === undefined) {
    throw new M1Error(
      "artifact_write_failed",
      "private Task workspace materialization produced no result",
    );
  }
  return result;
}
