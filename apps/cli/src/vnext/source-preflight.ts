import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { asSha256DigestV1, type Sha256DigestV1 } from "@chronorift/domain";

import type { TaskFixtureCapabilityV1 } from "./contracts.js";
import { M1Error } from "./errors.js";
import {
  loadTrustedFixtureCatalog,
  resolveTaskFixtureCapability,
} from "./fixture-manifest.js";
import { NodeHostGitPort, type HostGitPort } from "./host-git.js";
import {
  selectedTreeSha256,
  selectedTreeSha256FromSources,
  type SelectedTreeContentSourceV1,
} from "./selected-tree.js";
import { FixtureManifestV1Schema } from "./contracts.js";

const LFS_POINTER_HEADER = Buffer.from(
  "version https://git-lfs.github.com/spec/v1\n",
  "utf8",
);
const MAX_SELECTED_TREE_ENTRIES = 10_000;
const MAX_SELECTED_TREE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface CleanGitSubtreePreflightRequest {
  readonly projectPath: string;
  readonly trustedFixtureRoot: string;
  readonly sourceRepositoryExclusionRoots: readonly string[];
}

export interface VerifiedGitTreeEntry {
  readonly relativePath: string;
  readonly mode: "100644" | "100755";
  readonly objectId: string;
  readonly byteLength: number;
}

export interface VerifiedGitSubtree {
  readonly repositoryRoot: string;
  readonly projectRoot: string;
  readonly projectPrefix: string;
  readonly headCommit: string;
  readonly repositoryIdentity: Sha256DigestV1;
  readonly selectedTreeSha256: Sha256DigestV1;
  readonly entries: readonly VerifiedGitTreeEntry[];
  readonly fixtureCapability: TaskFixtureCapabilityV1;
}

const sourceFeatureUnsupported = (message: string, cause?: unknown): never => {
  throw new M1Error("source_feature_unsupported", message, cause);
};

const findByte = (bytes: Buffer, value: number, start: number): number =>
  bytes.indexOf(value, start);

const decodeUtf8Path = (bytes: Buffer): string => {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!Buffer.from(value, "utf8").equals(bytes)) {
    return sourceFeatureUnsupported("Git tree path is not canonical UTF-8");
  }
  return value;
};

export function parseGitTreeListing(
  listing: Uint8Array,
  projectPrefix: string,
): readonly VerifiedGitTreeEntry[] {
  const bytes = Buffer.from(listing);
  if (bytes.byteLength === 0) return [];
  if (bytes.at(-1) !== 0) {
    return sourceFeatureUnsupported("Git tree listing is not NUL terminated");
  }

  const prefixBytes =
    projectPrefix.length === 0
      ? undefined
      : Buffer.from(`${projectPrefix}/`, "utf8");
  const entries: VerifiedGitTreeEntry[] = [];
  let totalBytes = 0;
  let offset = 0;
  while (offset < bytes.byteLength) {
    const recordEnd = findByte(bytes, 0, offset);
    if (recordEnd < 0) {
      return sourceFeatureUnsupported("Git tree listing has a partial record");
    }
    if (recordEnd === offset) {
      if (recordEnd === bytes.byteLength - 1) break;
      return sourceFeatureUnsupported("Git tree listing has an empty record");
    }
    const record = bytes.subarray(offset, recordEnd);
    const tab = findByte(record, 0x09, 0);
    if (tab < 0) {
      return sourceFeatureUnsupported("Git tree record has no path delimiter");
    }
    const headerBytes = record.subarray(0, tab);
    if (headerBytes.some((byte) => byte > 0x7f)) {
      return sourceFeatureUnsupported("Git tree record header is not ASCII");
    }
    const header = headerBytes.toString("ascii");
    const match =
      /^(?<mode>[0-7]{6}) (?<type>[a-z]+) (?<objectId>(?:[a-f0-9]{40}|[a-f0-9]{64})) +(?<size>[0-9]+|-)$/u.exec(
        header,
      );
    if (match?.groups === undefined) {
      return sourceFeatureUnsupported("Git tree record header is malformed");
    }
    const { mode, type, objectId, size } = match.groups;
    if (
      mode === undefined ||
      type === undefined ||
      objectId === undefined ||
      size === undefined
    ) {
      return sourceFeatureUnsupported("Git tree record fields are missing");
    }
    if ((mode !== "100644" && mode !== "100755") || type !== "blob") {
      return sourceFeatureUnsupported(
        "Git tree contains a symlink, submodule, or unsupported entry",
      );
    }
    if (size === "-") {
      return sourceFeatureUnsupported("Git tree blob has no declared size");
    }
    const byteLength = Number(size);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      return sourceFeatureUnsupported("Git tree blob size is unsupported");
    }

    let pathBytes = record.subarray(tab + 1);
    if (prefixBytes !== undefined) {
      if (
        pathBytes.byteLength <= prefixBytes.byteLength ||
        !pathBytes.subarray(0, prefixBytes.byteLength).equals(prefixBytes)
      ) {
        return sourceFeatureUnsupported(
          "Git literal subtree listing escaped its project prefix",
        );
      }
      pathBytes = pathBytes.subarray(prefixBytes.byteLength);
    }
    const relativePath = decodeUtf8Path(pathBytes);
    totalBytes += byteLength;
    if (
      entries.length >= MAX_SELECTED_TREE_ENTRIES ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > MAX_SELECTED_TREE_BYTES ||
      (relativePath === "chronorift.fixture.json" &&
        byteLength > MAX_MANIFEST_BYTES)
    ) {
      return sourceFeatureUnsupported(
        "Git project subtree exceeds the bounded M1 source profile",
      );
    }
    entries.push({
      relativePath,
      mode,
      objectId,
      byteLength,
    });
    offset = recordEnd + 1;
  }

  entries.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.relativePath, "utf8"),
      Buffer.from(right.relativePath, "utf8"),
    ),
  );
  selectedTreeSha256(
    entries.map((entry) => ({
      relativePath: entry.relativePath,
      mode: entry.mode,
      content: Buffer.alloc(0),
    })),
  );
  return entries;
}

const pathIsWithinOrEqual = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) &&
      difference !== ".." &&
      !isAbsolute(difference))
  );
};

const assertNoRepositoryOverlap = async (
  repositoryRoot: string,
  exclusionRoots: readonly string[],
): Promise<void> => {
  for (const exclusionRoot of exclusionRoots) {
    let canonicalExclusionRoot: string;
    try {
      canonicalExclusionRoot = await realpath(exclusionRoot);
    } catch (error) {
      throw new M1Error(
        "path_denied",
        "source exclusion root must be an existing canonical directory",
        error,
      );
    }
    if (
      pathIsWithinOrEqual(repositoryRoot, canonicalExclusionRoot) ||
      pathIsWithinOrEqual(canonicalExclusionRoot, repositoryRoot)
    ) {
      throw new M1Error(
        "path_denied",
        "source repository and task or runtime roots must not overlap",
      );
    }
  }
};

const assertTrackedRequiredFiles = async (
  projectRoot: string,
  entries: readonly VerifiedGitTreeEntry[],
): Promise<void> => {
  for (const relativePath of [
    "project.godot",
    "chronorift.fixture.json",
  ] as const) {
    const entry = entries.find(
      (candidate) => candidate.relativePath === relativePath,
    );
    if (entry === undefined) {
      return sourceFeatureUnsupported(
        `${relativePath} must be a tracked regular file`,
      );
    }
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(join(projectRoot, relativePath));
    } catch (error) {
      return sourceFeatureUnsupported(
        `${relativePath} must exist in the source worktree`,
        error,
      );
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return sourceFeatureUnsupported(
        `${relativePath} must be a non-symlink regular file`,
      );
    }
  }
};

const inspectAndHashBlobs = async (input: {
  readonly git: HostGitPort;
  readonly repositoryRoot: string;
  readonly entries: readonly VerifiedGitTreeEntry[];
}): Promise<{
  readonly selectedTreeSha256: Sha256DigestV1;
  readonly manifest: unknown;
}> => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "chronorift-source-blobs-"),
  );
  try {
    const sources: SelectedTreeContentSourceV1[] = [];
    let manifestPath: string | undefined;
    for (const [index, entry] of input.entries.entries()) {
      const blobPath = join(temporaryDirectory, index.toString(16));
      const destination = await open(
        blobPath,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      let receipt: Awaited<ReturnType<HostGitPort["streamBlob"]>>;
      try {
        receipt = await input.git.streamBlob({
          cwd: input.repositoryRoot,
          objectId: entry.objectId,
          destination,
        });
        await destination.sync();
        const header = Buffer.alloc(LFS_POINTER_HEADER.byteLength);
        const read = await destination.read(header, 0, header.byteLength, 0);
        if (
          read.bytesRead === LFS_POINTER_HEADER.byteLength &&
          header.equals(LFS_POINTER_HEADER)
        ) {
          return sourceFeatureUnsupported(
            "Git LFS pointer content is unsupported",
          );
        }
      } finally {
        await destination.close();
      }
      if (receipt.byteLength !== entry.byteLength) {
        return sourceFeatureUnsupported(
          "Git blob byte length does not match the frozen tree metadata",
        );
      }
      sources.push({
        relativePath: entry.relativePath,
        mode: entry.mode,
        byteLength: entry.byteLength,
        async *chunks() {
          const handle = await open(
            blobPath,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            for await (const chunk of handle.createReadStream({
              autoClose: false,
              start: 0,
            })) {
              yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            }
          } finally {
            await handle.close();
          }
        },
      });
      if (entry.relativePath === "chronorift.fixture.json") {
        manifestPath = blobPath;
      }
    }
    if (manifestPath === undefined) {
      return sourceFeatureUnsupported(
        "tracked fixture manifest is unavailable",
      );
    }
    const manifestBytes = await readFile(manifestPath);
    const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(
      manifestBytes,
    );
    return {
      selectedTreeSha256: await selectedTreeSha256FromSources(sources),
      manifest: FixtureManifestV1Schema.parse(
        JSON.parse(manifestText) as unknown,
      ),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

export async function preflightCleanGitSubtree(
  request: CleanGitSubtreePreflightRequest,
  dependencies?: { readonly git?: HostGitPort },
): Promise<VerifiedGitSubtree> {
  const git = dependencies?.git ?? new NodeHostGitPort();
  try {
    const projectRoot = await realpath(request.projectPath);
    const projectMetadata = await lstat(projectRoot);
    if (!projectMetadata.isDirectory()) {
      return sourceFeatureUnsupported("project path must be a directory");
    }
    const repositoryRoot = await realpath(
      await git.resolveRepositoryRoot(projectRoot),
    );
    const prefix = relative(repositoryRoot, projectRoot);
    if (
      isAbsolute(prefix) ||
      prefix === ".." ||
      prefix.startsWith(`..${sep}`) ||
      prefix.includes("\\") ||
      prefix.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      return sourceFeatureUnsupported(
        "project path must be contained by its enclosing repository",
      );
    }
    const projectPrefix = prefix === "." ? "" : prefix;
    await assertNoRepositoryOverlap(
      repositoryRoot,
      request.sourceRepositoryExclusionRoots,
    );
    const headCommit = await git.resolveHeadCommit(repositoryRoot);
    const status = await git.statusPorcelain(repositoryRoot);
    if (status.byteLength !== 0) {
      throw new M1Error(
        "source_not_clean",
        "the entire enclosing Git worktree must be clean",
      );
    }
    const listing = await git.listTree({
      context: { cwd: repositoryRoot },
      treeish: headCommit,
      ...(projectPrefix.length === 0 ? {} : { projectPrefix }),
    });
    const entries = parseGitTreeListing(listing, projectPrefix);
    await assertTrackedRequiredFiles(projectRoot, entries);
    const inspected = await inspectAndHashBlobs({
      git,
      repositoryRoot,
      entries,
    });
    const catalog = await loadTrustedFixtureCatalog(request.trustedFixtureRoot);
    const fixtureCapability = resolveTaskFixtureCapability(
      {
        manifest: FixtureManifestV1Schema.parse(inspected.manifest),
        selectedTreeSha256: inspected.selectedTreeSha256,
      },
      catalog,
    );
    const repositoryIdentity = asSha256DigestV1(
      createHash("sha256")
        .update("chronorift-repository-identity-v1\0")
        .update(repositoryRoot)
        .digest("hex"),
    );
    return {
      repositoryRoot,
      projectRoot,
      projectPrefix,
      headCommit,
      repositoryIdentity,
      selectedTreeSha256: inspected.selectedTreeSha256,
      entries,
      fixtureCapability,
    };
  } catch (error) {
    if (error instanceof M1Error) throw error;
    throw new M1Error(
      "source_feature_unsupported",
      "Git source preflight failed before task execution",
      error,
    );
  }
}
