import { createHash } from "node:crypto";
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
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { z } from "zod";

import {
  Sha256DigestV1Schema,
  SourceIdSchema,
  TaskIdSchema,
  type Sha256DigestV1,
  type SourceId,
  type TaskId,
} from "@chronorift/domain";

import {
  WorkspaceMaterializationReceiptV2Schema,
  WorkspaceMaterializationReceiptV1Schema,
  type TaskGodotProjectCapabilityV1,
  type TaskFixtureCapabilityV1,
  type WorkspaceMaterializationReceiptV1,
  type WorkspaceMaterializationReceiptV2,
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
  refreezeProjectEnvironmentSourceV1,
  type VerifiedExternalGodotProject,
  type VerifiedGitSubtree,
  type VerifiedProjectEnvironmentSourceV1,
  type VerifiedTaskSource,
  type VerifiedGitTreeEntry,
} from "./source-preflight.js";
import type { GodotProjectDescriptorSnapshotV1 } from "./godot-project-descriptor.js";
import type { ProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";

export interface MaterializedPrivateTaskWorkspace {
  readonly workspaceDirectory: string;
  readonly hostBaselineGitDirectory: string;
  readonly agentBaselineCommit: string;
  readonly hostBaselineCommit: string;
  readonly receipt: WorkspaceMaterializationReceiptV1;
  readonly fixtureCapability: TaskFixtureCapabilityV1;
}

export interface MaterializedExternalGodotProjectWorkspace {
  readonly sourceKind: "godot-external-lifecycle-v1";
  readonly workspaceDirectory: string;
  readonly hostBaselineGitDirectory: string;
  readonly agentBaselineCommit: string;
  readonly hostBaselineCommit: string;
  readonly receipt: WorkspaceMaterializationReceiptV2;
  readonly projectCapability: TaskGodotProjectCapabilityV1;
  readonly descriptorSnapshot: GodotProjectDescriptorSnapshotV1;
}

export interface ProjectEnvironmentWorkspaceMaterializationReceiptV1 {
  readonly schemaVersion: 1;
  readonly receiptKind: "project-environment-workspace-materialization";
  readonly taskId: TaskId;
  readonly projectSourceIdentity: Sha256DigestV1;
  readonly sourceRevision: string;
  readonly selectedTreeSha256: Sha256DigestV1;
  readonly agentBaselineCommit: string;
  readonly hostBaselineCommit: string;
  readonly copyRule: "git-object-plumbing-v1";
  readonly excludedPaths: readonly [".git", ".godot", ".chronorift"];
  readonly sourcePostflight: {
    readonly observedHeadCommit: string;
    readonly observedSelectedTreeSha256: Sha256DigestV1;
    readonly statusPorcelainSha256: Sha256DigestV1;
    readonly stagingWorktreeRegistered: false;
  };
}

export interface ProjectEnvironmentWorkspaceMaterializationReceiptV2 {
  readonly schemaVersion: 2;
  readonly receiptKind: "project-environment-workspace-materialization";
  readonly taskId: TaskId;
  readonly sourceId: SourceId;
  readonly projectSourceIdentity: Sha256DigestV1;
  readonly sourceRevision: string;
  readonly projectPrefix: string;
  readonly selectedTreeSha256: Sha256DigestV1;
  readonly agentBaselineCommit: string;
  readonly hostBaselineCommit: string;
  readonly copyRule: "verified-source-closure-v1";
  readonly excludedPaths: readonly [".git", ".godot", ".chronorift"];
  readonly sourcePostflight: {
    readonly observedHeadCommit: string;
    readonly observedSelectedTreeSha256: Sha256DigestV1;
    readonly observedProjectSourceIdentity: Sha256DigestV1;
    readonly statusPorcelainSha256: Sha256DigestV1;
    readonly status: "stable";
    readonly stagingWorktreeRegistered: false;
  };
}

const GitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);

export const ProjectEnvironmentWorkspaceMaterializationReceiptV1Schema: z.ZodType<ProjectEnvironmentWorkspaceMaterializationReceiptV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      receiptKind: z.literal("project-environment-workspace-materialization"),
      taskId: TaskIdSchema,
      projectSourceIdentity: Sha256DigestV1Schema,
      sourceRevision: GitObjectIdSchema,
      selectedTreeSha256: Sha256DigestV1Schema,
      agentBaselineCommit: GitObjectIdSchema,
      hostBaselineCommit: GitObjectIdSchema,
      copyRule: z.literal("git-object-plumbing-v1"),
      excludedPaths: z.tuple([
        z.literal(".git"),
        z.literal(".godot"),
        z.literal(".chronorift"),
      ]),
      sourcePostflight: z
        .object({
          observedHeadCommit: GitObjectIdSchema,
          observedSelectedTreeSha256: Sha256DigestV1Schema,
          statusPorcelainSha256: Sha256DigestV1Schema,
          stagingWorktreeRegistered: z.literal(false),
        })
        .strict(),
    })
    .strict();

const ProjectPrefixSchema = z
  .string()
  .max(8_192)
  .refine(
    (value) =>
      value.length === 0 ||
      (!isAbsolute(value) &&
        !value.includes("\\") &&
        !value.includes("\0") &&
        !value
          .split("/")
          .some(
            (segment) =>
              segment.length === 0 ||
              segment === "." ||
              segment === ".." ||
              segment === ".git",
          )),
    "projectPrefix must be empty or a normalized relative path",
  );

export const ProjectEnvironmentWorkspaceMaterializationReceiptV2Schema: z.ZodType<ProjectEnvironmentWorkspaceMaterializationReceiptV2> =
  z
    .object({
      schemaVersion: z.literal(2),
      receiptKind: z.literal("project-environment-workspace-materialization"),
      taskId: TaskIdSchema,
      sourceId: SourceIdSchema,
      projectSourceIdentity: Sha256DigestV1Schema,
      sourceRevision: GitObjectIdSchema,
      projectPrefix: ProjectPrefixSchema,
      selectedTreeSha256: Sha256DigestV1Schema,
      agentBaselineCommit: GitObjectIdSchema,
      hostBaselineCommit: GitObjectIdSchema,
      copyRule: z.literal("verified-source-closure-v1"),
      excludedPaths: z.tuple([
        z.literal(".git"),
        z.literal(".godot"),
        z.literal(".chronorift"),
      ]),
      sourcePostflight: z
        .object({
          observedHeadCommit: GitObjectIdSchema,
          observedSelectedTreeSha256: Sha256DigestV1Schema,
          observedProjectSourceIdentity: Sha256DigestV1Schema,
          statusPorcelainSha256: Sha256DigestV1Schema,
          status: z.literal("stable"),
          stagingWorktreeRegistered: z.literal(false),
        })
        .strict(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.sourceId !== `source:v1:${value.projectSourceIdentity}`) {
        context.addIssue({
          code: "custom",
          path: ["sourceId"],
          message: "sourceId does not match projectSourceIdentity",
        });
      }
      for (const [field, matches] of [
        [
          "observedHeadCommit",
          value.sourcePostflight.observedHeadCommit === value.sourceRevision,
        ],
        [
          "observedSelectedTreeSha256",
          value.sourcePostflight.observedSelectedTreeSha256 ===
            value.selectedTreeSha256,
        ],
        [
          "observedProjectSourceIdentity",
          value.sourcePostflight.observedProjectSourceIdentity ===
            value.projectSourceIdentity,
        ],
      ] as const) {
        if (!matches) {
          context.addIssue({
            code: "custom",
            path: ["sourcePostflight", field],
            message: `${field} does not match the frozen source`,
          });
        }
      }
    });

export interface MaterializedProjectEnvironmentWorkspaceV1 {
  readonly sourceKind:
    | "project-environment-v1-clean-git"
    | "project-environment-v1-source-closure";
  readonly workspaceDirectory: string;
  readonly hostBaselineGitDirectory: string;
  readonly agentBaselineCommit: string;
  readonly hostBaselineCommit: string;
  readonly receipt:
    | ProjectEnvironmentWorkspaceMaterializationReceiptV1
    | ProjectEnvironmentWorkspaceMaterializationReceiptV2;
  readonly projectSourceIdentity: Sha256DigestV1;
  readonly mainScene: string;
}

export type MaterializedTaskWorkspace =
  MaterializedPrivateTaskWorkspace | MaterializedExternalGodotProjectWorkspace;

type MaterializedWorkspaceResult =
  MaterializedTaskWorkspace | MaterializedProjectEnvironmentWorkspaceV1;

type MaterializableSource =
  VerifiedTaskSource | VerifiedProjectEnvironmentSourceV1;

export interface MaterializeTaskWorkspaceRequest {
  readonly taskId: TaskId;
  readonly source: VerifiedTaskSource;
  readonly layout: ProjectEnvironmentTaskDirectoryLayout;
}

export interface MaterializeProjectEnvironmentWorkspaceRequestV1 {
  readonly taskId: TaskId;
  readonly source: VerifiedProjectEnvironmentSourceV1;
  readonly layout: ProjectEnvironmentTaskDirectoryLayout;
}

const isExternalGodotSource = (
  source: MaterializableSource,
): source is VerifiedExternalGodotProject => "projectCapability" in source;

const isProjectEnvironmentSource = (
  source: MaterializableSource,
): source is VerifiedProjectEnvironmentSourceV1 =>
  "sourceKind" in source &&
  (source.sourceKind === "project-environment-v1-clean-git" ||
    source.sourceKind === "project-environment-v1-source-closure");

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
  layout: ProjectEnvironmentTaskDirectoryLayout,
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

const materializeVerifiedProjectClosureFile = async (input: {
  readonly source: VerifiedProjectEnvironmentSourceV1;
  readonly entry: VerifiedProjectEnvironmentSourceV1["entries"][number];
  readonly destination: Awaited<ReturnType<typeof open>>;
}): Promise<void> => {
  const closureEntry = input.source.sourceClosure?.entries.find(
    (entry) => entry.relativePath === input.entry.relativePath,
  );
  if (closureEntry === undefined) {
    throw new M1Error(
      "source_drift",
      "source_drift: verified Project Source Closure entry disappeared",
    );
  }
  const absolutePath = join(input.source.projectRoot, input.entry.relativePath);
  const parent = dirname(absolutePath);
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(parent);
  } catch (error) {
    throw new M1Error(
      "source_drift",
      "source_drift: source closure parent disappeared before materialization",
      error,
    );
  }
  if (
    !pathIsWithinOrEqual(input.source.projectRoot, absolutePath) ||
    canonicalParent !== parent
  ) {
    throw new M1Error(
      "source_drift",
      "source_drift: source path traversed a symbolic link",
    );
  }
  let expected: Awaited<ReturnType<typeof lstat>>;
  try {
    expected = await lstat(absolutePath);
  } catch (error) {
    throw new M1Error(
      "source_drift",
      "source_drift: source closure entry disappeared before materialization",
      error,
    );
  }
  if (expected.isSymbolicLink() || !expected.isFile()) {
    throw new M1Error(
      "source_drift",
      "source_drift: source closure entry is no longer a regular file",
    );
  }
  let source: Awaited<ReturnType<typeof open>>;
  try {
    source = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new M1Error(
      "source_drift",
      "source_drift: source closure entry could not be reopened for materialization",
      error,
    );
  }
  try {
    const before = await source.stat();
    if (
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      before.mode !== expected.mode ||
      before.size !== closureEntry.byteLength ||
      ((before.mode & 0o111) === 0 ? "100644" : "100755") !== closureEntry.mode
    ) {
      throw new M1Error(
        "source_drift",
        "source_drift: source closure metadata changed before materialization",
      );
    }
    const bytes = await source.readFile();
    const after = await source.stat();
    const observedSha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      bytes.byteLength !== closureEntry.byteLength ||
      observedSha256 !== closureEntry.contentSha256
    ) {
      throw new M1Error(
        "source_drift",
        "source_drift: source closure bytes changed during materialization",
      );
    }
    await input.destination.writeFile(bytes);
  } finally {
    await source.close();
  }
};

const materializeSourceFiles = async (input: {
  readonly git: HostGitPort;
  readonly source: MaterializableSource;
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
      if (
        isProjectEnvironmentSource(input.source) &&
        input.source.sourceClosure !== undefined
      ) {
        await materializeVerifiedProjectClosureFile({
          source: input.source,
          entry,
          destination,
        });
      } else {
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

export function materializePrivateTaskWorkspace(
  request: {
    readonly taskId: TaskId;
    readonly source: VerifiedGitSubtree;
    readonly layout: ProjectEnvironmentTaskDirectoryLayout;
  },
  dependencies?: { readonly git?: HostGitPort },
): Promise<MaterializedPrivateTaskWorkspace>;
export function materializePrivateTaskWorkspace(
  request: {
    readonly taskId: TaskId;
    readonly source: VerifiedExternalGodotProject;
    readonly layout: ProjectEnvironmentTaskDirectoryLayout;
  },
  dependencies?: { readonly git?: HostGitPort },
): Promise<MaterializedExternalGodotProjectWorkspace>;
export function materializePrivateTaskWorkspace(
  request: MaterializeProjectEnvironmentWorkspaceRequestV1,
  dependencies?: { readonly git?: HostGitPort },
): Promise<MaterializedProjectEnvironmentWorkspaceV1>;
export function materializePrivateTaskWorkspace(
  request: MaterializeTaskWorkspaceRequest,
  dependencies?: { readonly git?: HostGitPort },
): Promise<MaterializedTaskWorkspace>;
export async function materializePrivateTaskWorkspace(
  request:
    | MaterializeTaskWorkspaceRequest
    | MaterializeProjectEnvironmentWorkspaceRequestV1,
  dependencies?: { readonly git?: HostGitPort },
): Promise<MaterializedWorkspaceResult> {
  const git = dependencies?.git ?? new NodeHostGitPort();
  await verifyLayoutBoundary(request.layout);
  const stagingPath = join(
    request.layout.hostOperationTemporaryDirectory,
    "staging-worktree",
  );
  let addWasAttempted = false;
  let result: MaterializedWorkspaceResult | undefined;
  let externalPending:
    | {
        readonly agentBaselineCommit: string;
        readonly hostBaselineCommit: string;
      }
    | undefined;
  let projectEnvironmentPending:
    | {
        readonly agentBaselineCommit: string;
        readonly hostBaselineCommit: string;
      }
    | undefined;
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

      if (isExternalGodotSource(request.source)) {
        externalPending = { agentBaselineCommit, hostBaselineCommit };
      } else if (isProjectEnvironmentSource(request.source)) {
        projectEnvironmentPending = {
          agentBaselineCommit,
          hostBaselineCommit,
        };
      } else {
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
          excludedCachePaths:
            request.source.fixtureCapability.ignoredCachePaths,
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
      }
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
  if (externalPending !== undefined && isExternalGodotSource(request.source)) {
    try {
      const observedHeadCommit = await git.resolveHeadCommit(
        request.source.repositoryRoot,
      );
      const status = await git.statusPorcelain(request.source.repositoryRoot);
      if (
        observedHeadCommit !== request.source.headCommit ||
        status.byteLength !== 0
      ) {
        throw new M1Error(
          "artifact_write_failed",
          "source checkout changed during external project materialization",
        );
      }
      await verifyBaselineTree({
        git,
        context: { cwd: request.source.repositoryRoot },
        commit: observedHeadCommit,
        expectedEntries: request.source.entries,
        expectedSelectedTreeSha256: request.source.selectedTreeSha256,
        temporaryRoot: request.layout.hostOperationTemporaryDirectory,
        label: "source-postflight",
      });
      const receipt = WorkspaceMaterializationReceiptV2Schema.parse({
        schemaVersion: 2,
        taskId: request.taskId,
        repositoryIdentity: request.source.repositoryIdentity,
        sourceRevision: request.source.headCommit,
        projectPrefix: "",
        selectedTreeSha256: request.source.selectedTreeSha256,
        agentBaselineCommit: externalPending.agentBaselineCommit,
        hostBaselineCommit: externalPending.hostBaselineCommit,
        copyRule: "git-object-plumbing-v1",
        excludedCachePaths: request.source.projectCapability.ignoredCachePaths,
        sourceCapabilityKind: "godot-external-lifecycle-v1",
        projectCapabilitySha256:
          request.source.projectCapability.capabilitySha256,
        descriptorSha256: request.source.descriptorSnapshot.descriptorSha256,
        sourcePostflight: {
          observedHeadCommit,
          observedSelectedTreeSha256: request.source.selectedTreeSha256,
          statusPorcelainSha256: createHash("sha256")
            .update(status)
            .digest("hex"),
          stagingWorktreeRegistered: false,
        },
      });
      result = {
        sourceKind: "godot-external-lifecycle-v1",
        workspaceDirectory: request.layout.workspaceDirectory,
        hostBaselineGitDirectory: request.layout.hostBaselineGitDirectory,
        agentBaselineCommit: externalPending.agentBaselineCommit,
        hostBaselineCommit: externalPending.hostBaselineCommit,
        receipt,
        projectCapability: request.source.projectCapability,
        descriptorSnapshot: Object.freeze({
          descriptor: request.source.descriptorSnapshot.descriptor,
          descriptorSha256: request.source.descriptorSnapshot.descriptorSha256,
          bytes: Uint8Array.from(request.source.descriptorSnapshot.bytes),
        }),
      };
    } catch (error) {
      if (error instanceof M1Error) throw error;
      throw new M1Error(
        "artifact_write_failed",
        "external source checkout postflight could not be proven",
        error,
      );
    }
  }
  if (
    projectEnvironmentPending !== undefined &&
    isProjectEnvironmentSource(request.source)
  ) {
    try {
      let receipt:
        | ProjectEnvironmentWorkspaceMaterializationReceiptV1
        | ProjectEnvironmentWorkspaceMaterializationReceiptV2;
      if (request.source.sourceClosure !== undefined) {
        let observed: VerifiedProjectEnvironmentSourceV1;
        let status: Uint8Array;
        try {
          status = await git.statusPorcelain(request.source.repositoryRoot);
          observed = await refreezeProjectEnvironmentSourceV1(request.source, {
            git,
          });
        } catch (error) {
          throw new M1Error(
            "source_drift",
            "source_drift: source checkout could not be re-frozen after materialization",
            error,
          );
        }
        if (
          observed.headCommit !== request.source.headCommit ||
          observed.projectPrefix !== request.source.projectPrefix ||
          observed.selectedTreeSha256 !== request.source.selectedTreeSha256 ||
          observed.projectSourceIdentity !==
            request.source.projectSourceIdentity
        ) {
          throw new M1Error(
            "source_drift",
            "source_drift: source checkout changed during Project Environment materialization",
          );
        }
        receipt =
          ProjectEnvironmentWorkspaceMaterializationReceiptV2Schema.parse({
            schemaVersion: 2,
            receiptKind: "project-environment-workspace-materialization",
            taskId: request.taskId,
            sourceId: request.source.sourceClosure.sourceId,
            projectSourceIdentity: request.source.projectSourceIdentity,
            sourceRevision: request.source.headCommit,
            projectPrefix: request.source.projectPrefix,
            selectedTreeSha256: request.source.selectedTreeSha256,
            agentBaselineCommit: projectEnvironmentPending.agentBaselineCommit,
            hostBaselineCommit: projectEnvironmentPending.hostBaselineCommit,
            copyRule: "verified-source-closure-v1",
            excludedPaths: [".git", ".godot", ".chronorift"],
            sourcePostflight: {
              observedHeadCommit: observed.headCommit,
              observedSelectedTreeSha256: observed.selectedTreeSha256,
              observedProjectSourceIdentity: observed.projectSourceIdentity,
              statusPorcelainSha256: createHash("sha256")
                .update(status)
                .digest("hex"),
              status: "stable",
              stagingWorktreeRegistered: false,
            },
          });
      } else {
        const status = await git.statusPorcelain(request.source.repositoryRoot);
        const observedHeadCommit = await git.resolveHeadCommit(
          request.source.repositoryRoot,
        );
        if (
          observedHeadCommit !== request.source.headCommit ||
          status.byteLength !== 0
        ) {
          throw new M1Error(
            "artifact_write_failed",
            "source checkout changed during legacy Project Environment materialization",
          );
        }
        await verifyBaselineTree({
          git,
          context: { cwd: request.source.repositoryRoot },
          commit: observedHeadCommit,
          expectedEntries: request.source.entries,
          expectedSelectedTreeSha256: request.source.selectedTreeSha256,
          temporaryRoot: request.layout.hostOperationTemporaryDirectory,
          label: "project-environment-source-postflight",
        });
        receipt =
          ProjectEnvironmentWorkspaceMaterializationReceiptV1Schema.parse({
            schemaVersion: 1,
            receiptKind: "project-environment-workspace-materialization",
            taskId: request.taskId,
            projectSourceIdentity: request.source.projectSourceIdentity,
            sourceRevision: request.source.headCommit,
            selectedTreeSha256: request.source.selectedTreeSha256,
            agentBaselineCommit: projectEnvironmentPending.agentBaselineCommit,
            hostBaselineCommit: projectEnvironmentPending.hostBaselineCommit,
            copyRule: "git-object-plumbing-v1",
            excludedPaths: [".git", ".godot", ".chronorift"],
            sourcePostflight: {
              observedHeadCommit,
              observedSelectedTreeSha256: request.source.selectedTreeSha256,
              statusPorcelainSha256: createHash("sha256")
                .update(status)
                .digest("hex"),
              stagingWorktreeRegistered: false,
            },
          });
      }
      result = {
        sourceKind: request.source.sourceKind,
        workspaceDirectory: request.layout.workspaceDirectory,
        hostBaselineGitDirectory: request.layout.hostBaselineGitDirectory,
        agentBaselineCommit: projectEnvironmentPending.agentBaselineCommit,
        hostBaselineCommit: projectEnvironmentPending.hostBaselineCommit,
        receipt,
        projectSourceIdentity: request.source.projectSourceIdentity,
        mainScene: request.source.mainScene,
      };
    } catch (error) {
      if (error instanceof M1Error) throw error;
      throw new M1Error(
        "artifact_write_failed",
        "Project Environment source checkout postflight could not be proven",
        error,
      );
    }
  }
  if (result === undefined) {
    throw new M1Error(
      "artifact_write_failed",
      "private Task workspace materialization produced no result",
    );
  }
  return result;
}
