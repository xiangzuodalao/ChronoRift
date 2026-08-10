import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
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
