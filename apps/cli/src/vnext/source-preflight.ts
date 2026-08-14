import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import {
  asSourceId,
  asSha256DigestV1,
  Sha256DigestV1Schema,
  SourceIdSchema,
  type JsonValue,
  type Sha256DigestV1,
  type SourceId,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

import {
  TaskGodotProjectCapabilityV1Schema,
  type TaskFixtureCapabilityV1,
  type TaskGodotProjectCapabilityV1,
} from "./contracts.js";
import { M1Error } from "./errors.js";
import {
  EXTERNAL_GODOT_MAX_BYTES_V1,
  EXTERNAL_GODOT_MAX_FILES_V1,
  isExternalGodotNativeSourcePathV1,
  isExternalGodotReservedSourcePathV1,
} from "./external-godot-source-policy.js";
import { isProjectEnvironmentSensitivePathV1 } from "./project-environment-source-policy.js";
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
import {
  parseGodotProjectDescriptorSnapshotV1,
  type GodotProjectDescriptorSnapshotV1,
  type HostGodotProjectDescriptorSnapshotV1,
} from "./godot-project-descriptor.js";

const LFS_POINTER_HEADER = Buffer.from(
  "version https://git-lfs.github.com/spec/v1\n",
  "utf8",
);
const MAX_SELECTED_TREE_ENTRIES = 10_000;
const MAX_SELECTED_TREE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PROJECT_CONFIGURATION_BYTES = 1024 * 1024;

export interface CleanGitSubtreePreflightRequest {
  readonly projectPath: string;
  readonly trustedFixtureRoot: string;
  readonly sourceRepositoryExclusionRoots: readonly string[];
}

export interface CleanExternalGodotProjectPreflightRequest {
  readonly projectPath: string;
  readonly descriptorSnapshot: HostGodotProjectDescriptorSnapshotV1;
  readonly sourceRepositoryExclusionRoots: readonly string[];
}

export interface CleanProjectEnvironmentPreflightRequestV1 {
  readonly projectPath: string;
  /** Relative to the enclosing Git repository. Required when discovery is ambiguous. */
  readonly projectRoot?: string | undefined;
  /** Exact untracked files relative to the selected project; never remembered. */
  readonly includeUntrackedPaths?: readonly string[] | undefined;
  readonly sourceRepositoryExclusionRoots: readonly string[];
}

export interface VerifiedGitTreeEntry {
  readonly relativePath: string;
  readonly mode: "100644" | "100755";
  readonly objectId: string;
  readonly byteLength: number;
}

export type ProjectSourceEntryProvenanceV1 = "tracked" | "explicit_untracked";

export interface ProjectSourceClosureEntryV1 {
  readonly relativePath: string;
  readonly mode: "100644" | "100755";
  readonly byteLength: number;
  readonly contentSha256: Sha256DigestV1;
  readonly provenance: ProjectSourceEntryProvenanceV1;
}

export interface ProjectSourceSubmoduleV1 {
  readonly mountPath: string;
  readonly headCommit: string;
  readonly selectedTreeSha256: Sha256DigestV1;
}

export interface ProjectSourceClosureV1 {
  readonly schemaVersion: 1;
  readonly closureKind: "project-source-closure";
  readonly sourceRevision: string;
  /** Empty means the repository root. Host absolute paths are never persisted. */
  readonly projectPath: string;
  readonly includedUntrackedPaths: readonly string[];
  readonly submodules: readonly ProjectSourceSubmoduleV1[];
  readonly entries: readonly ProjectSourceClosureEntryV1[];
  readonly selectedTreeSha256: Sha256DigestV1;
  readonly mainScene: string;
  readonly requestedGodotVersion: "4.7.1";
  readonly sourceId: SourceId;
}

const GitRevisionSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
const ProjectClosureRelativePathSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value !== ".chronorift" &&
      !value.startsWith(".chronorift/") &&
      !value
        .split("/")
        .some(
          (segment) =>
            segment.length === 0 ||
            segment === "." ||
            segment === ".." ||
            segment === ".git",
        ),
    "path must be normalized, relative, and must not enter .git or .chronorift",
  );

export const ProjectSourceClosureV1Schema: z.ZodType<ProjectSourceClosureV1> = z
  .object({
    schemaVersion: z.literal(1),
    closureKind: z.literal("project-source-closure"),
    sourceRevision: GitRevisionSchema,
    projectPath: z.union([z.literal(""), ProjectClosureRelativePathSchema]),
    includedUntrackedPaths: z.array(ProjectClosureRelativePathSchema),
    submodules: z.array(
      z
        .object({
          mountPath: ProjectClosureRelativePathSchema,
          headCommit: GitRevisionSchema,
          selectedTreeSha256: Sha256DigestV1Schema,
        })
        .strict(),
    ),
    entries: z.array(
      z
        .object({
          relativePath: ProjectClosureRelativePathSchema,
          mode: z.enum(["100644", "100755"]),
          byteLength: z.number().int().nonnegative(),
          contentSha256: Sha256DigestV1Schema,
          provenance: z.enum(["tracked", "explicit_untracked"]),
        })
        .strict(),
    ),
    selectedTreeSha256: Sha256DigestV1Schema,
    mainScene: z.string().min(1).max(2_048),
    requestedGodotVersion: z.literal("4.7.1"),
    sourceId: SourceIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const requireStrictBytewiseOrder = (
      values: readonly string[],
      path: "includedUntrackedPaths" | "submodules" | "entries",
    ): void => {
      for (let index = 1; index < values.length; index += 1) {
        if (
          Buffer.compare(
            Buffer.from(values[index - 1] ?? "", "utf8"),
            Buffer.from(values[index] ?? "", "utf8"),
          ) >= 0
        ) {
          context.addIssue({
            code: "custom",
            path: [path, index],
            message: `${path} must be uniquely sorted by UTF-8 bytes`,
          });
          break;
        }
      }
    };
    requireStrictBytewiseOrder(
      value.includedUntrackedPaths,
      "includedUntrackedPaths",
    );
    requireStrictBytewiseOrder(
      value.submodules.map((submodule) => submodule.mountPath),
      "submodules",
    );
    requireStrictBytewiseOrder(
      value.entries.map((entry) => entry.relativePath),
      "entries",
    );
    const explicitUntrackedEntries = value.entries
      .filter((entry) => entry.provenance === "explicit_untracked")
      .map((entry) => entry.relativePath);
    if (
      explicitUntrackedEntries.length !== value.includedUntrackedPaths.length ||
      explicitUntrackedEntries.some(
        (path, index) => path !== value.includedUntrackedPaths[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["includedUntrackedPaths"],
        message:
          "includedUntrackedPaths must exactly match explicit_untracked entries",
      });
    }
    const { sourceId, ...identityContent } = value;
    const expected = asSourceId(`source:v1:${contentHash(identityContent)}`);
    if (sourceId !== expected) {
      context.addIssue({
        code: "custom",
        path: ["sourceId"],
        message: "sourceId does not match the canonical closure identity",
      });
    }
  });

export interface VerifiedProjectEnvironmentTreeEntryV1 extends VerifiedGitTreeEntry {
  readonly contentSha256?: Sha256DigestV1 | undefined;
  readonly provenance?: ProjectSourceEntryProvenanceV1 | undefined;
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

export interface VerifiedExternalGodotProject {
  readonly sourceKind: "godot-external-lifecycle-v1";
  readonly repositoryRoot: string;
  readonly projectRoot: string;
  readonly projectPrefix: "";
  readonly headCommit: string;
  readonly repositoryIdentity: Sha256DigestV1;
  readonly selectedTreeSha256: Sha256DigestV1;
  readonly entries: readonly VerifiedGitTreeEntry[];
  readonly descriptorSnapshot: GodotProjectDescriptorSnapshotV1;
  readonly descriptorCanonicalPath: string;
  readonly projectCapability: TaskGodotProjectCapabilityV1;
}

/**
 * The deliberately narrow PE-A source closure. Host paths are retained only for
 * composition and must not be copied into a persisted Project Environment DTO.
 */
export interface VerifiedProjectEnvironmentSourceV1 {
  readonly sourceKind:
    | "project-environment-v1-clean-git"
    | "project-environment-v1-source-closure";
  readonly repositoryRoot: string;
  readonly projectRoot: string;
  readonly projectPrefix: string;
  readonly headCommit: string;
  readonly selectedTreeSha256: Sha256DigestV1;
  readonly projectSourceIdentity: Sha256DigestV1;
  readonly entries: readonly VerifiedProjectEnvironmentTreeEntryV1[];
  readonly mainScene: string;
  readonly requestedGodotVersion: "4.7.1";
  /** Present for PE-C freezes; absent only on legacy PE-A test/evidence inputs. */
  readonly sourceClosure?: ProjectSourceClosureV1 | undefined;
}

export type VerifiedTaskSource =
  VerifiedGitSubtree | VerifiedExternalGodotProject;

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
  limits: {
    readonly maxEntries: number;
    readonly maxBytes: number;
  } = {
    maxEntries: MAX_SELECTED_TREE_ENTRIES,
    maxBytes: MAX_SELECTED_TREE_BYTES,
  },
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
      entries.length >= limits.maxEntries ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > limits.maxBytes ||
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
  requiredFiles: readonly string[],
): Promise<void> => {
  for (const relativePath of requiredFiles) {
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
  readonly requireFixtureManifest: boolean;
  readonly captureProjectFile?: string | undefined;
}): Promise<{
  readonly selectedTreeSha256: Sha256DigestV1;
  readonly manifest?: unknown;
  readonly projectFileBytes?: Uint8Array | undefined;
}> => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "chronorift-source-blobs-"),
  );
  try {
    const sources: SelectedTreeContentSourceV1[] = [];
    let manifestPath: string | undefined;
    let projectFilePath: string | undefined;
    for (const [index, entry] of input.entries.entries()) {
      if (
        entry.relativePath === input.captureProjectFile &&
        entry.byteLength > MAX_PROJECT_CONFIGURATION_BYTES
      ) {
        return sourceFeatureUnsupported(
          "project.godot exceeds the bounded configuration profile",
        );
      }
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
      if (entry.relativePath === input.captureProjectFile) {
        projectFilePath = blobPath;
      }
    }
    if (input.requireFixtureManifest && manifestPath === undefined) {
      return sourceFeatureUnsupported(
        "tracked fixture manifest is unavailable",
      );
    }
    let manifest: unknown;
    if (input.requireFixtureManifest && manifestPath !== undefined) {
      const manifestBytes = await readFile(manifestPath);
      const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(
        manifestBytes,
      );
      manifest = FixtureManifestV1Schema.parse(
        JSON.parse(manifestText) as unknown,
      );
    }
    return {
      selectedTreeSha256: await selectedTreeSha256FromSources(sources),
      ...(manifest === undefined ? {} : { manifest }),
      ...(projectFilePath === undefined
        ? {}
        : {
            projectFileBytes: Uint8Array.from(await readFile(projectFilePath)),
          }),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

interface CleanGitProjectInspection {
  readonly repositoryRoot: string;
  readonly projectRoot: string;
  readonly projectPrefix: string;
  readonly headCommit: string;
  readonly repositoryIdentity: Sha256DigestV1;
  readonly selectedTreeSha256: Sha256DigestV1;
  readonly entries: readonly VerifiedGitTreeEntry[];
  readonly manifest?: unknown;
  readonly projectFileBytes?: Uint8Array | undefined;
}

const inspectCleanGitProject = async (
  request: {
    readonly projectPath: string;
    readonly sourceRepositoryExclusionRoots: readonly string[];
    readonly requiredFiles: readonly string[];
    readonly requireFixtureManifest: boolean;
    readonly requireRepositoryRootProject: boolean;
    readonly descriptorCanonicalPath?: string | undefined;
    readonly captureProjectFile?: string | undefined;
    readonly sourceLimits?:
      | {
          readonly maxEntries: number;
          readonly maxBytes: number;
        }
      | undefined;
  },
  git: HostGitPort,
): Promise<CleanGitProjectInspection> => {
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
  if (request.requireRepositoryRootProject && projectPrefix !== "") {
    return sourceFeatureUnsupported(
      "external Godot lifecycle profile requires a repository-root project",
    );
  }
  await assertNoRepositoryOverlap(
    repositoryRoot,
    request.sourceRepositoryExclusionRoots,
  );
  if (
    request.descriptorCanonicalPath !== undefined &&
    pathIsWithinOrEqual(repositoryRoot, request.descriptorCanonicalPath)
  ) {
    throw new M1Error(
      "path_denied",
      "external Godot project descriptor must be stored outside the source repository",
    );
  }
  if (request.descriptorCanonicalPath !== undefined) {
    for (const exclusionRoot of request.sourceRepositoryExclusionRoots) {
      const canonicalExclusionRoot = await realpath(exclusionRoot);
      if (
        pathIsWithinOrEqual(
          canonicalExclusionRoot,
          request.descriptorCanonicalPath,
        )
      ) {
        throw new M1Error(
          "path_denied",
          "external Godot project descriptor must not overlap task or runtime storage",
        );
      }
    }
  }
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
  const entries = parseGitTreeListing(
    listing,
    projectPrefix,
    request.sourceLimits,
  );
  await assertTrackedRequiredFiles(projectRoot, entries, request.requiredFiles);
  const inspected = await inspectAndHashBlobs({
    git,
    repositoryRoot,
    entries,
    requireFixtureManifest: request.requireFixtureManifest,
    ...(request.captureProjectFile === undefined
      ? {}
      : { captureProjectFile: request.captureProjectFile }),
  });
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
    ...(inspected.manifest === undefined
      ? {}
      : { manifest: inspected.manifest }),
    ...(inspected.projectFileBytes === undefined
      ? {}
      : { projectFileBytes: inspected.projectFileBytes }),
  };
};

const normalizeSourcePreflightError = (error: unknown): never => {
  if (error instanceof M1Error) throw error;
  throw new M1Error(
    "source_feature_unsupported",
    "Git source preflight failed before task execution",
    error,
  );
};

const PROJECT_ENVIRONMENT_RESERVED_AUTOLOAD = "ChronoRiftProjectEnvironment";

const projectEnvironmentMainScene = (input: Uint8Array): string => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch (error) {
    return sourceFeatureUnsupported("project.godot must be valid UTF-8", error);
  }
  if (
    text.includes("\0") ||
    new RegExp(`^\\s*${PROJECT_ENVIRONMENT_RESERVED_AUTOLOAD}\\s*=`, "mu").test(
      text,
    )
  ) {
    return sourceFeatureUnsupported(
      "project.godot collides with the reserved Project Environment autoload",
    );
  }
  const mainScene =
    /^\s*run\/main_scene\s*=\s*"((?:res|uid):\/\/[^"\r\n]+)"\s*$/mu.exec(
      text,
    )?.[1];
  if (mainScene === undefined || mainScene.length > 2_048) {
    return sourceFeatureUnsupported(
      "project.godot must configure a bounded res:// or uid:// main scene",
    );
  }
  return mainScene;
};

interface GitStatusEntryV1 {
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly relativePath: string;
  readonly sourcePath?: string | undefined;
}

const assertNormalizedRepositoryPath = (
  value: string,
  label: string,
): string => {
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    /^[A-Za-z]:[/\\]/u.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment === ".git",
      )
  ) {
    return sourceFeatureUnsupported(
      `${label} must be a normalized relative file path`,
    );
  }
  return value;
};

const decodeGitPath = (bytes: Buffer, label: string): string => {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    return sourceFeatureUnsupported(`${label} must be canonical UTF-8`, error);
  }
  if (!Buffer.from(value, "utf8").equals(bytes)) {
    return sourceFeatureUnsupported(`${label} must be canonical UTF-8`);
  }
  return assertNormalizedRepositoryPath(value, label);
};

const parseGitStatusPorcelainV1 = (
  status: Uint8Array,
): readonly GitStatusEntryV1[] => {
  const bytes = Buffer.from(status);
  if (bytes.byteLength === 0) return [];
  if (bytes.at(-1) !== 0) {
    return sourceFeatureUnsupported(
      "Git status porcelain is not NUL terminated",
    );
  }
  const entries: GitStatusEntryV1[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const recordEnd = bytes.indexOf(0, offset);
    if (recordEnd < 0 || recordEnd === offset) {
      return sourceFeatureUnsupported(
        "Git status porcelain contains a partial record",
      );
    }
    const record = bytes.subarray(offset, recordEnd);
    if (record.byteLength < 4 || record[2] !== 0x20) {
      return sourceFeatureUnsupported(
        "Git status porcelain record is malformed",
      );
    }
    const indexStatus = String.fromCharCode(record[0] ?? 0);
    const worktreeStatus = String.fromCharCode(record[1] ?? 0);
    if (
      !/^[ MADRCUT?!]$/u.test(indexStatus) ||
      !/^[ MADRCUT?!]$/u.test(worktreeStatus)
    ) {
      return sourceFeatureUnsupported(
        "Git status porcelain has an unsupported state",
      );
    }
    if (
      indexStatus === "U" ||
      worktreeStatus === "U" ||
      (indexStatus === "A" && worktreeStatus === "A") ||
      (indexStatus === "D" && worktreeStatus === "D")
    ) {
      return sourceFeatureUnsupported(
        "unmerged Git index state is unsupported by Project Source Closure",
      );
    }
    const relativePath = decodeGitPath(record.subarray(3), "Git status path");
    offset = recordEnd + 1;
    let sourcePath: string | undefined;
    if (
      indexStatus === "R" ||
      indexStatus === "C" ||
      worktreeStatus === "R" ||
      worktreeStatus === "C"
    ) {
      const sourceEnd = bytes.indexOf(0, offset);
      if (sourceEnd < 0 || sourceEnd === offset) {
        return sourceFeatureUnsupported("Git rename status has no source path");
      }
      sourcePath = decodeGitPath(
        bytes.subarray(offset, sourceEnd),
        "Git rename source path",
      );
      offset = sourceEnd + 1;
    }
    entries.push({
      indexStatus,
      worktreeStatus,
      relativePath,
      ...(sourcePath === undefined ? {} : { sourcePath }),
    });
  }
  return entries;
};

const trackedProjectFilesFromTreeListing = (
  listing: Uint8Array,
): ReadonlySet<string> => {
  const bytes = Buffer.from(listing);
  if (bytes.byteLength !== 0 && bytes.at(-1) !== 0) {
    return sourceFeatureUnsupported("Git tree listing is not NUL terminated");
  }
  const projects = new Set<string>();
  let offset = 0;
  while (offset < bytes.byteLength) {
    const end = bytes.indexOf(0, offset);
    if (end < 0 || end === offset) {
      return sourceFeatureUnsupported(
        "Git tree listing contains a partial record",
      );
    }
    const record = bytes.subarray(offset, end);
    const tab = record.indexOf(0x09);
    if (tab < 0) {
      return sourceFeatureUnsupported("Git tree record has no path delimiter");
    }
    const header = record.subarray(0, tab).toString("ascii");
    const path = decodeGitPath(record.subarray(tab + 1), "Git tree path");
    if (
      /^100(?:644|755) blob /u.test(header) &&
      path.endsWith("project.godot")
    ) {
      const name = path.split("/").at(-1);
      if (name === "project.godot") projects.add(path);
    }
    offset = end + 1;
  }
  return projects;
};

interface ProjectEnvironmentGitlinkV1 {
  readonly mountPath: string;
  readonly headCommit: string;
}

const isProjectEnvironmentReservedPathV1 = (relativePath: string): boolean => {
  const normalized = relativePath.toLocaleLowerCase("en-US");
  return (
    normalized === ".chronorift" ||
    normalized.startsWith(".chronorift/") ||
    normalized === ".godot" ||
    normalized.startsWith(".godot/") ||
    normalized === "override.cfg" ||
    normalized === "addons/chronorift_project_environment" ||
    normalized.startsWith("addons/chronorift_project_environment/")
  );
};

const assertProjectEnvironmentSourcePathAdmittedV1 = (
  relativePath: string,
): void => {
  if (isProjectEnvironmentReservedPathV1(relativePath)) {
    return sourceFeatureUnsupported(
      "Project Environment source collides with a reserved managed path",
    );
  }
  if (isExternalGodotNativeSourcePathV1(relativePath)) {
    return sourceFeatureUnsupported(
      "Project Environment supports GDScript without native or C# extensions",
    );
  }
  if (isProjectEnvironmentSensitivePathV1(relativePath)) {
    throw new M1Error(
      "path_denied",
      "Project Environment source contains a credential-like path",
    );
  }
};

const assertProjectEnvironmentClosureBudgetV1 = (
  entries: readonly VerifiedGitTreeEntry[],
): void => {
  let totalBytes = 0;
  for (const entry of entries) {
    totalBytes += entry.byteLength;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > EXTERNAL_GODOT_MAX_BYTES_V1
    ) {
      return sourceFeatureUnsupported(
        "Project Environment source closure exceeds its bounded profile",
      );
    }
  }
  if (entries.length > EXTERNAL_GODOT_MAX_FILES_V1) {
    return sourceFeatureUnsupported(
      "Project Environment source closure exceeds its bounded profile",
    );
  }
};

const parseProjectEnvironmentTreeListing = (
  listing: Uint8Array,
  projectPrefix: string,
): {
  readonly entries: readonly VerifiedGitTreeEntry[];
  readonly gitlinks: readonly ProjectEnvironmentGitlinkV1[];
} => {
  const bytes = Buffer.from(listing);
  if (bytes.byteLength !== 0 && bytes.at(-1) !== 0) {
    return sourceFeatureUnsupported("Git tree listing is not NUL terminated");
  }
  const prefix = projectPrefix.length === 0 ? "" : `${projectPrefix}/`;
  const entries: VerifiedGitTreeEntry[] = [];
  const gitlinks: ProjectEnvironmentGitlinkV1[] = [];
  let totalBytes = 0;
  let offset = 0;
  while (offset < bytes.byteLength) {
    const end = bytes.indexOf(0, offset);
    if (end < 0 || end === offset) {
      return sourceFeatureUnsupported(
        "Git tree listing contains a partial record",
      );
    }
    const record = bytes.subarray(offset, end);
    const tab = record.indexOf(0x09);
    if (tab < 0) {
      return sourceFeatureUnsupported("Git tree record has no path delimiter");
    }
    const header = record.subarray(0, tab).toString("ascii");
    const match =
      /^(?<mode>[0-7]{6}) (?<type>[a-z]+) (?<objectId>(?:[a-f0-9]{40}|[a-f0-9]{64})) +(?<size>[0-9]+|-)$/u.exec(
        header,
      );
    if (match?.groups === undefined) {
      return sourceFeatureUnsupported("Git tree record header is malformed");
    }
    const rawPath = decodeGitPath(record.subarray(tab + 1), "Git tree path");
    if (prefix.length > 0 && !rawPath.startsWith(prefix)) {
      return sourceFeatureUnsupported(
        "Git subtree listing escaped its project root",
      );
    }
    const relativePath =
      prefix.length === 0 ? rawPath : rawPath.slice(prefix.length);
    assertNormalizedRepositoryPath(relativePath, "Git project path");
    const { mode, type, objectId, size } = match.groups;
    if (
      mode === undefined ||
      type === undefined ||
      objectId === undefined ||
      size === undefined
    ) {
      return sourceFeatureUnsupported("Git tree record fields are missing");
    }
    if (mode === "160000" && type === "commit" && size === "-") {
      gitlinks.push({ mountPath: relativePath, headCommit: objectId });
    } else if (
      (mode === "100644" || mode === "100755") &&
      type === "blob" &&
      size !== "-"
    ) {
      const byteLength = Number(size);
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        return sourceFeatureUnsupported("Git blob size is unsupported");
      }
      totalBytes += byteLength;
      if (
        entries.length + gitlinks.length >= EXTERNAL_GODOT_MAX_FILES_V1 ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > EXTERNAL_GODOT_MAX_BYTES_V1
      ) {
        return sourceFeatureUnsupported(
          "Project Environment source closure exceeds its bounded profile",
        );
      }
      entries.push({ relativePath, mode, objectId, byteLength });
    } else {
      return sourceFeatureUnsupported(
        "Git tree contains a symlink or unsupported entry",
      );
    }
    offset = end + 1;
  }
  const byPath =
    <T extends { readonly [K in P]: string }, P extends string>(field: P) =>
    (left: T, right: T): number =>
      Buffer.compare(
        Buffer.from(left[field], "utf8"),
        Buffer.from(right[field], "utf8"),
      );
  entries.sort(byPath<VerifiedGitTreeEntry, "relativePath">("relativePath"));
  gitlinks.sort(byPath<ProjectEnvironmentGitlinkV1, "mountPath">("mountPath"));
  return { entries, gitlinks };
};

const inspectMaterializedProjectSubmodules = async (input: {
  readonly git: HostGitPort;
  readonly projectRoot: string;
  readonly rootEntries: readonly VerifiedGitTreeEntry[];
  readonly gitlinks: readonly ProjectEnvironmentGitlinkV1[];
}): Promise<{
  readonly entries: readonly VerifiedGitTreeEntry[];
  readonly submodules: readonly ProjectSourceSubmoduleV1[];
}> => {
  interface PendingSubmoduleInspection {
    readonly gitlink: ProjectEnvironmentGitlinkV1;
    readonly submoduleRoot: string;
    readonly observedHead: string;
    readonly entries: readonly VerifiedGitTreeEntry[];
  }

  const expandedEntries: VerifiedGitTreeEntry[] = [];
  const submodules: ProjectSourceSubmoduleV1[] = [];
  const pendingInspections: PendingSubmoduleInspection[] = [];
  const closureEntries = [...input.rootEntries];
  for (const entry of input.rootEntries) {
    assertProjectEnvironmentSourcePathAdmittedV1(entry.relativePath);
  }
  for (const gitlink of input.gitlinks) {
    assertProjectEnvironmentSourcePathAdmittedV1(gitlink.mountPath);
    const submoduleRoot = join(input.projectRoot, gitlink.mountPath);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(submoduleRoot);
    } catch (error) {
      return sourceFeatureUnsupported(
        "Project Environment submodule must already be materialized",
        error,
      );
    }
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (await realpath(submoduleRoot)) !== submoduleRoot
    ) {
      return sourceFeatureUnsupported(
        "Project Environment submodule mount must be a canonical directory",
      );
    }
    let observedRepositoryRoot: string;
    try {
      observedRepositoryRoot = await realpath(
        await input.git.resolveRepositoryRoot(submoduleRoot),
      );
    } catch (error) {
      return sourceFeatureUnsupported(
        "Project Environment submodule is not materialized",
        error,
      );
    }
    if (observedRepositoryRoot !== submoduleRoot) {
      return sourceFeatureUnsupported(
        "Project Environment submodule resolved outside its declared mount",
      );
    }
    const observedHead = await input.git.resolveHeadCommit(submoduleRoot);
    const status = await input.git.statusPorcelain(submoduleRoot);
    if (observedHead !== gitlink.headCommit || status.byteLength !== 0) {
      return sourceFeatureUnsupported(
        "Project Environment submodule must be clean and match its recorded gitlink",
      );
    }
    const listing = await input.git.listTree({
      context: { cwd: submoduleRoot },
      treeish: observedHead,
    });
    const parsed = parseProjectEnvironmentTreeListing(listing, "");
    if (parsed.gitlinks.length > 0) {
      return sourceFeatureUnsupported(
        "recursive Project Environment submodules are unsupported",
      );
    }
    for (const entry of parsed.entries) {
      // Apply each source root's policy before adding its mount prefix. A
      // submodule-local .chronorift, .godot, native binary, or credential must
      // not become admissible merely because it is mounted below another path.
      assertProjectEnvironmentSourcePathAdmittedV1(entry.relativePath);
    }
    closureEntries.push(...parsed.entries);
    assertProjectEnvironmentClosureBudgetV1(closureEntries);
    pendingInspections.push({
      gitlink,
      submoduleRoot,
      observedHead,
      entries: parsed.entries,
    });
  }
  // Do not read any submodule blobs until admission and the whole-closure
  // bounds have succeeded for every selected source root.
  for (const pending of pendingInspections) {
    const inspected = await inspectAndHashBlobs({
      git: input.git,
      repositoryRoot: pending.submoduleRoot,
      entries: pending.entries,
      requireFixtureManifest: false,
    });
    submodules.push({
      mountPath: pending.gitlink.mountPath,
      headCommit: pending.observedHead,
      selectedTreeSha256: inspected.selectedTreeSha256,
    });
    expandedEntries.push(
      ...pending.entries.map((entry) => ({
        ...entry,
        relativePath: `${pending.gitlink.mountPath}/${entry.relativePath}`,
      })),
    );
  }
  expandedEntries.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.relativePath, "utf8"),
      Buffer.from(right.relativePath, "utf8"),
    ),
  );
  return {
    entries: Object.freeze(expandedEntries),
    submodules: Object.freeze(submodules),
  };
};

const pathWithinProject = (
  repositoryPath: string,
  projectPrefix: string,
): string | undefined => {
  if (projectPrefix.length === 0) return repositoryPath;
  const prefix = `${projectPrefix}/`;
  return repositoryPath.startsWith(prefix)
    ? repositoryPath.slice(prefix.length)
    : undefined;
};

const normalizedProjectPrefix = (value: string): string => {
  if (value === "." || value === "") return "";
  return assertNormalizedRepositoryPath(value, "project root");
};

const discoverProjectPrefix = async (input: {
  readonly repositoryRoot: string;
  readonly headCommit: string;
  readonly requestedProjectRoot?: string | undefined;
  readonly statusEntries: readonly GitStatusEntryV1[];
  readonly git: HostGitPort;
}): Promise<string> => {
  const listing = await input.git.listTree({
    context: { cwd: input.repositoryRoot },
    treeish: input.headCommit,
  });
  const candidates = new Set(trackedProjectFilesFromTreeListing(listing));
  for (const status of input.statusEntries) {
    if (
      status.sourcePath !== undefined &&
      (status.indexStatus === "R" || status.worktreeStatus === "R")
    ) {
      candidates.delete(status.sourcePath);
    }
    if (status.indexStatus === "D") {
      candidates.delete(status.relativePath);
    } else if (
      status.indexStatus !== "?" &&
      status.relativePath.split("/").at(-1) === "project.godot"
    ) {
      candidates.add(status.relativePath);
    }
  }

  const realizedCandidates: string[] = [];
  for (const candidate of candidates) {
    try {
      const metadata = await lstat(join(input.repositoryRoot, candidate));
      if (!metadata.isSymbolicLink() && metadata.isFile()) {
        realizedCandidates.push(candidate);
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  realizedCandidates.sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );

  if (input.requestedProjectRoot !== undefined) {
    const projectPrefix = normalizedProjectPrefix(input.requestedProjectRoot);
    const descriptor =
      projectPrefix.length === 0
        ? "project.godot"
        : `${projectPrefix}/project.godot`;
    if (!realizedCandidates.includes(descriptor)) {
      return sourceFeatureUnsupported(
        "selected project root does not contain a tracked project.godot",
      );
    }
    return projectPrefix;
  }
  if (realizedCandidates.length === 0) {
    return sourceFeatureUnsupported(
      "enclosing Git repository contains no tracked Godot project",
    );
  }
  if (realizedCandidates.length !== 1) {
    return sourceFeatureUnsupported(
      "enclosing Git repository contains multiple Godot projects; select project root explicitly",
    );
  }
  return dirname(realizedCandidates[0] ?? "") === "."
    ? ""
    : dirname(realizedCandidates[0] ?? "");
};

const assertCanonicalFileParents = async (
  projectRoot: string,
  relativePath: string,
): Promise<void> => {
  let current = projectRoot;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (await realpath(current)) !== current
    ) {
      return sourceFeatureUnsupported(
        "Project Environment source contains a symlinked directory",
      );
    }
  }
};

interface ProjectWorktreeEntryV1 {
  readonly relativePath: string;
  readonly provenance: ProjectSourceEntryProvenanceV1;
  readonly objectId: string;
}

const selectProjectWorktreeEntries = (input: {
  readonly projectPrefix: string;
  readonly headEntries: readonly VerifiedGitTreeEntry[];
  readonly statusEntries: readonly GitStatusEntryV1[];
  readonly includeUntrackedPaths: readonly string[];
  readonly headCommit: string;
}): readonly ProjectWorktreeEntryV1[] => {
  const tracked = new Map(
    input.headEntries.map((entry) => [
      entry.relativePath,
      { objectId: entry.objectId },
    ]),
  );
  const untrackedRepositoryPaths = new Set<string>();
  for (const status of input.statusEntries) {
    if (status.indexStatus === "?" && status.worktreeStatus === "?") {
      untrackedRepositoryPaths.add(status.relativePath);
      continue;
    }
    if (
      status.sourcePath !== undefined &&
      (status.indexStatus === "R" || status.worktreeStatus === "R")
    ) {
      const sourceRelative = pathWithinProject(
        status.sourcePath,
        input.projectPrefix,
      );
      if (sourceRelative !== undefined) tracked.delete(sourceRelative);
    }
    const relativePath = pathWithinProject(
      status.relativePath,
      input.projectPrefix,
    );
    if (relativePath === undefined) continue;
    if (status.indexStatus === "D") {
      tracked.delete(relativePath);
    } else {
      tracked.set(relativePath, {
        objectId:
          tracked.get(relativePath)?.objectId ??
          "0".repeat(input.headCommit.length),
      });
    }
  }

  const selected: ProjectWorktreeEntryV1[] = [...tracked].map(
    ([relativePath, value]) => ({
      relativePath,
      provenance: "tracked",
      objectId: value.objectId,
    }),
  );
  const seenUntracked = new Set<string>();
  for (const rawPath of input.includeUntrackedPaths) {
    const relativePath = assertNormalizedRepositoryPath(
      rawPath,
      "explicit untracked path",
    );
    if (
      relativePath.split("/").includes(".chronorift") ||
      seenUntracked.has(relativePath)
    ) {
      return sourceFeatureUnsupported(
        "explicit untracked paths must be unique and must exclude .chronorift",
      );
    }
    seenUntracked.add(relativePath);
    const repositoryPath =
      input.projectPrefix.length === 0
        ? relativePath
        : `${input.projectPrefix}/${relativePath}`;
    if (!untrackedRepositoryPaths.has(repositoryPath)) {
      return sourceFeatureUnsupported(
        "explicit untracked path is tracked, ignored, missing, or not an exact file",
      );
    }
    selected.push({
      relativePath,
      provenance: "explicit_untracked",
      objectId: "0".repeat(input.headCommit.length),
    });
  }
  selected.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.relativePath, "utf8"),
      Buffer.from(right.relativePath, "utf8"),
    ),
  );
  return selected;
};

const freezeProjectEnvironmentWorktree = async (input: {
  readonly repositoryRoot: string;
  readonly projectRoot: string;
  readonly projectPrefix: string;
  readonly headCommit: string;
  readonly selectedEntries: readonly ProjectWorktreeEntryV1[];
  readonly includeUntrackedPaths: readonly string[];
  readonly submodules: readonly ProjectSourceSubmoduleV1[];
}): Promise<{
  readonly entries: readonly VerifiedProjectEnvironmentTreeEntryV1[];
  readonly selectedTreeSha256: Sha256DigestV1;
  readonly mainScene: string;
  readonly requestedGodotVersion: "4.7.1";
  readonly projectSourceIdentity: Sha256DigestV1;
  readonly sourceClosure: ProjectSourceClosureV1;
}> => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "chronorift-project-source-closure-"),
  );
  try {
    const frozenEntries: VerifiedProjectEnvironmentTreeEntryV1[] = [];
    const sources: SelectedTreeContentSourceV1[] = [];
    let totalBytes = 0;
    let projectFileBytes: Buffer | undefined;
    let requestedGodotVersion = "4.7.1" as const;
    for (const selected of input.selectedEntries) {
      assertProjectEnvironmentSourcePathAdmittedV1(selected.relativePath);
      await assertCanonicalFileParents(
        input.projectRoot,
        selected.relativePath,
      );
      const absolutePath = join(input.projectRoot, selected.relativePath);
      let expected: Awaited<ReturnType<typeof lstat>>;
      try {
        expected = await lstat(absolutePath);
      } catch (error) {
        if (
          selected.provenance === "tracked" &&
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          continue;
        }
        throw error;
      }
      if (expected.isSymbolicLink() || !expected.isFile()) {
        return sourceFeatureUnsupported(
          "Project Environment closure accepts only regular non-symlink files",
        );
      }
      totalBytes += expected.size;
      if (
        frozenEntries.length >= EXTERNAL_GODOT_MAX_FILES_V1 ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > EXTERNAL_GODOT_MAX_BYTES_V1 ||
        (selected.relativePath === "project.godot" &&
          expected.size > MAX_PROJECT_CONFIGURATION_BYTES)
      ) {
        return sourceFeatureUnsupported(
          "Project Environment source closure exceeds its bounded profile",
        );
      }
      const source = await open(
        absolutePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const frozenPath = join(
        temporaryDirectory,
        frozenEntries.length.toString(16),
      );
      const destination = await open(
        frozenPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      let bytes: Buffer;
      try {
        const before = await source.stat();
        if (
          !before.isFile() ||
          before.dev !== expected.dev ||
          before.ino !== expected.ino ||
          before.mode !== expected.mode ||
          before.size !== expected.size
        ) {
          return sourceFeatureUnsupported(
            "Project Environment source changed before freeze",
          );
        }
        bytes = await source.readFile();
        const after = await source.stat();
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.mode !== before.mode ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          bytes.byteLength !== before.size
        ) {
          return sourceFeatureUnsupported(
            "Project Environment source changed during freeze",
          );
        }
        if (
          bytes
            .subarray(0, LFS_POINTER_HEADER.byteLength)
            .equals(LFS_POINTER_HEADER)
        ) {
          return sourceFeatureUnsupported(
            "Git LFS pointer content is unsupported",
          );
        }
        await destination.writeFile(bytes);
        await destination.sync();
      } finally {
        await source.close();
        await destination.close();
      }
      if (selected.relativePath === "project.godot") {
        projectFileBytes = bytes;
      }
      if (selected.relativePath === ".godot-version") {
        let version: string;
        try {
          version = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (error) {
          return sourceFeatureUnsupported(
            ".godot-version must be valid UTF-8",
            error,
          );
        }
        if (version.trim() !== "4.7.1") {
          return sourceFeatureUnsupported(
            "Project Environment requires .godot-version to request exact Godot 4.7.1",
          );
        }
        requestedGodotVersion = "4.7.1";
      }
      const mode = (expected.mode & 0o111) === 0 ? "100644" : "100755";
      const contentSha256 = asSha256DigestV1(
        createHash("sha256").update(bytes).digest("hex"),
      );
      frozenEntries.push({
        relativePath: selected.relativePath,
        mode,
        objectId: selected.objectId,
        byteLength: bytes.byteLength,
        contentSha256,
        provenance: selected.provenance,
      });
      sources.push({
        relativePath: selected.relativePath,
        mode,
        byteLength: bytes.byteLength,
        async *chunks() {
          const handle = await open(
            frozenPath,
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
    }
    if (
      projectFileBytes === undefined ||
      frozenEntries.find(
        (entry) =>
          entry.relativePath === "project.godot" &&
          entry.provenance === "tracked",
      ) === undefined
    ) {
      return sourceFeatureUnsupported(
        "project.godot must remain a tracked regular file",
      );
    }
    const selectedTreeSha256 = await selectedTreeSha256FromSources(sources);
    const mainScene = projectEnvironmentMainScene(projectFileBytes);
    const includedUntrackedPaths = [...input.includeUntrackedPaths].sort(
      (left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
    const closureEntries = frozenEntries.map((entry) => ({
      relativePath: entry.relativePath,
      mode: entry.mode,
      byteLength: entry.byteLength,
      contentSha256: entry.contentSha256,
      provenance: entry.provenance,
    }));
    const identityContent = {
      schemaVersion: 1 as const,
      closureKind: "project-source-closure" as const,
      sourceRevision: input.headCommit,
      projectPath: input.projectPrefix,
      includedUntrackedPaths,
      submodules: input.submodules,
      entries: closureEntries,
      selectedTreeSha256,
      mainScene,
      requestedGodotVersion,
    };
    const projectSourceIdentity = asSha256DigestV1(
      contentHash(identityContent as unknown as JsonValue),
    );
    const sourceClosure = ProjectSourceClosureV1Schema.parse({
      ...identityContent,
      sourceId: asSourceId(`source:v1:${projectSourceIdentity}`),
    });
    return {
      entries: Object.freeze(frozenEntries),
      selectedTreeSha256,
      mainScene,
      requestedGodotVersion,
      projectSourceIdentity,
      sourceClosure: Object.freeze(sourceClosure),
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
    const inspected = await inspectCleanGitProject(
      {
        projectPath: request.projectPath,
        sourceRepositoryExclusionRoots: request.sourceRepositoryExclusionRoots,
        requiredFiles: ["project.godot", "chronorift.fixture.json"],
        requireFixtureManifest: true,
        requireRepositoryRootProject: false,
      },
      git,
    );
    if (inspected.manifest === undefined) {
      return sourceFeatureUnsupported(
        "tracked fixture manifest is unavailable",
      );
    }
    const catalog = await loadTrustedFixtureCatalog(request.trustedFixtureRoot);
    const fixtureCapability = resolveTaskFixtureCapability(
      {
        manifest: FixtureManifestV1Schema.parse(inspected.manifest),
        selectedTreeSha256: inspected.selectedTreeSha256,
      },
      catalog,
    );
    const { manifest: _manifest, ...source } = inspected;
    void _manifest;
    return { ...source, fixtureCapability };
  } catch (error) {
    return normalizeSourcePreflightError(error);
  }
}

const assertExternalGodotSourceProfile = (
  entries: readonly VerifiedGitTreeEntry[],
): void => {
  for (const entry of entries) {
    if (isExternalGodotReservedSourcePathV1(entry.relativePath)) {
      return sourceFeatureUnsupported(
        "external Godot source collides with a reserved managed root",
      );
    }
    if (isExternalGodotNativeSourcePathV1(entry.relativePath)) {
      return sourceFeatureUnsupported(
        "external Godot lifecycle profile supports GDScript without native extensions",
      );
    }
  }
};

export const assertExternalGodotProjectConfigurationV1 = (
  input: Uint8Array | undefined,
): void => {
  if (input === undefined) {
    return sourceFeatureUnsupported(
      "tracked project.godot bytes are unavailable",
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch (error) {
    return sourceFeatureUnsupported("project.godot must be valid UTF-8", error);
  }
  if (text.includes("\0") || /^\s*ChronoRiftLifecycle\s*=/mu.test(text)) {
    return sourceFeatureUnsupported(
      "project.godot collides with the reserved ChronoRiftLifecycle autoload",
    );
  }
  const mainScene =
    /^\s*run\/main_scene\s*=\s*"((?:res|uid):\/\/[^"\r\n]+)"\s*$/mu.exec(
      text,
    )?.[1];
  if (mainScene === undefined || mainScene.length > 2_048) {
    return sourceFeatureUnsupported(
      "project.godot must configure a bounded res:// or uid:// main scene",
    );
  }
};

export async function preflightCleanExternalGodotProject(
  request: CleanExternalGodotProjectPreflightRequest,
  dependencies?: { readonly git?: HostGitPort },
): Promise<VerifiedExternalGodotProject> {
  const git = dependencies?.git ?? new NodeHostGitPort();
  try {
    const reparsed = parseGodotProjectDescriptorSnapshotV1(
      request.descriptorSnapshot.bytes,
    );
    if (
      reparsed.descriptorSha256 !== request.descriptorSnapshot.descriptorSha256
    ) {
      throw new M1Error(
        "source_configuration_mismatch",
        "external Godot project descriptor snapshot identity is inconsistent",
      );
    }
    const descriptorCanonicalPath = await realpath(
      request.descriptorSnapshot.canonicalPath,
    );
    if (descriptorCanonicalPath !== request.descriptorSnapshot.canonicalPath) {
      throw new M1Error(
        "path_denied",
        "external Godot project descriptor path is no longer canonical",
      );
    }
    const inspected = await inspectCleanGitProject(
      {
        projectPath: request.projectPath,
        sourceRepositoryExclusionRoots: request.sourceRepositoryExclusionRoots,
        requiredFiles: [reparsed.descriptor.projectFile],
        requireFixtureManifest: false,
        requireRepositoryRootProject: true,
        descriptorCanonicalPath,
        captureProjectFile: reparsed.descriptor.projectFile,
        sourceLimits: {
          maxEntries: EXTERNAL_GODOT_MAX_FILES_V1,
          maxBytes: EXTERNAL_GODOT_MAX_BYTES_V1,
        },
      },
      git,
    );
    assertExternalGodotSourceProfile(inspected.entries);
    assertExternalGodotProjectConfigurationV1(inspected.projectFileBytes);
    const capabilityContent = {
      schemaVersion: 1 as const,
      capabilityKind: "godot-external-lifecycle-v1" as const,
      descriptorSha256: reparsed.descriptorSha256,
      declaredSourceUrl: reparsed.descriptor.declaredSourceUrl,
      sourceRevision: inspected.headCommit,
      baselineSelectedTreeSha256: inspected.selectedTreeSha256,
      projectFile: reparsed.descriptor.projectFile,
      engineVersion: reparsed.descriptor.runtime.engineVersion,
      scripting: reparsed.descriptor.runtime.scripting,
      renderer: reparsed.descriptor.runtime.renderer,
      executionMode: reparsed.descriptor.runtime.executionMode,
      startup: reparsed.descriptor.launch.scene,
      runtimeProfile: "chronorift-godot-lifecycle-v1" as const,
      bridgeMode: reparsed.descriptor.bridge.mode,
      protocolVersion: reparsed.descriptor.bridge.protocolVersion,
      ignoredCachePaths: reparsed.descriptor.cache.ignoredPaths,
      reservedSourceRoots: [".chronorift", "addons", "override.cfg"] as const,
    };
    const projectCapability = TaskGodotProjectCapabilityV1Schema.parse({
      ...capabilityContent,
      capabilitySha256: contentHash(capabilityContent as unknown as JsonValue),
    });
    const descriptorSnapshot: GodotProjectDescriptorSnapshotV1 = Object.freeze({
      descriptor: reparsed.descriptor,
      descriptorSha256: reparsed.descriptorSha256,
      bytes: Uint8Array.from(reparsed.bytes),
    });
    return {
      sourceKind: "godot-external-lifecycle-v1",
      repositoryRoot: inspected.repositoryRoot,
      projectRoot: inspected.projectRoot,
      projectPrefix: "",
      headCommit: inspected.headCommit,
      repositoryIdentity: inspected.repositoryIdentity,
      selectedTreeSha256: inspected.selectedTreeSha256,
      entries: inspected.entries,
      descriptorSnapshot,
      descriptorCanonicalPath,
      projectCapability,
    };
  } catch (error) {
    return normalizeSourcePreflightError(error);
  }
}

/**
 * Freezes the selected Godot project's realized worktree. Tracked staged and
 * unstaged bytes are automatic; untracked files are exact, explicit inputs.
 */
export async function preflightCleanProjectEnvironmentV1(
  request: CleanProjectEnvironmentPreflightRequestV1,
  dependencies?: { readonly git?: HostGitPort },
): Promise<VerifiedProjectEnvironmentSourceV1> {
  const git = dependencies?.git ?? new NodeHostGitPort();
  try {
    const startingPath = await realpath(request.projectPath);
    const startingMetadata = await lstat(startingPath);
    if (startingMetadata.isSymbolicLink() || !startingMetadata.isDirectory()) {
      return sourceFeatureUnsupported(
        "project path must be a canonical directory",
      );
    }
    const repositoryRoot = await realpath(
      await git.resolveRepositoryRoot(startingPath),
    );
    await assertNoRepositoryOverlap(
      repositoryRoot,
      request.sourceRepositoryExclusionRoots,
    );
    const headCommit = await git.resolveHeadCommit(repositoryRoot);
    const status = await git.statusPorcelain(repositoryRoot);
    const statusEntries = parseGitStatusPorcelainV1(status);
    const projectPrefix = await discoverProjectPrefix({
      repositoryRoot,
      headCommit,
      requestedProjectRoot: request.projectRoot,
      statusEntries,
      git,
    });
    const projectRoot = resolve(repositoryRoot, projectPrefix || ".");
    if (!pathIsWithinOrEqual(repositoryRoot, projectRoot)) {
      throw new M1Error(
        "path_denied",
        "selected project root escaped its repository",
      );
    }
    const canonicalProjectRoot = await realpath(projectRoot);
    if (canonicalProjectRoot !== projectRoot) {
      return sourceFeatureUnsupported(
        "selected project root must not traverse a symlink",
      );
    }
    const listing = await git.listTree({
      context: { cwd: repositoryRoot },
      treeish: headCommit,
      ...(projectPrefix.length === 0 ? {} : { projectPrefix }),
    });
    const parsedTree = parseProjectEnvironmentTreeListing(
      listing,
      projectPrefix,
    );
    const inspectedSubmodules = await inspectMaterializedProjectSubmodules({
      git,
      projectRoot,
      rootEntries: parsedTree.entries,
      gitlinks: parsedTree.gitlinks,
    });
    const includeUntrackedPaths = request.includeUntrackedPaths ?? [];
    const repositoryWorktreeIsDirty = statusEntries.length > 0;
    const selectedEntries = selectProjectWorktreeEntries({
      projectPrefix,
      headEntries: [...parsedTree.entries, ...inspectedSubmodules.entries],
      statusEntries,
      includeUntrackedPaths,
      headCommit,
    });
    const frozen = await freezeProjectEnvironmentWorktree({
      repositoryRoot,
      projectRoot,
      projectPrefix,
      headCommit,
      selectedEntries,
      includeUntrackedPaths,
      submodules: inspectedSubmodules.submodules,
    });
    return Object.freeze({
      sourceKind:
        repositoryWorktreeIsDirty || includeUntrackedPaths.length > 0
          ? ("project-environment-v1-source-closure" as const)
          : ("project-environment-v1-clean-git" as const),
      repositoryRoot,
      projectRoot,
      projectPrefix,
      headCommit,
      selectedTreeSha256: frozen.selectedTreeSha256,
      projectSourceIdentity: frozen.projectSourceIdentity,
      entries: frozen.entries,
      mainScene: frozen.mainScene,
      requestedGodotVersion: frozen.requestedGodotVersion,
      sourceClosure: frozen.sourceClosure,
    });
  } catch (error) {
    return normalizeSourcePreflightError(error);
  }
}

/** Re-freezes the same selection without relying on remembered CLI state. */
export async function refreezeProjectEnvironmentSourceV1(
  source: VerifiedProjectEnvironmentSourceV1,
  dependencies?: { readonly git?: HostGitPort },
): Promise<VerifiedProjectEnvironmentSourceV1> {
  return preflightCleanProjectEnvironmentV1(
    {
      projectPath: source.repositoryRoot,
      projectRoot:
        source.projectPrefix.length === 0 ? "." : source.projectPrefix,
      includeUntrackedPaths: source.sourceClosure?.includedUntrackedPaths ?? [],
      sourceRepositoryExclusionRoots: [],
    },
    dependencies,
  );
}
