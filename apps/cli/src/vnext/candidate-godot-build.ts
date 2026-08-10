import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { resolve } from "node:path";

import {
  VNextBuildV1Schema,
  asBuildId,
  asSha256DigestV1,
  asSourceId,
  type Sha256DigestV1,
  type TaskId,
  type VNextBuildV1,
  type WorkspaceId,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

import {
  FixtureManifestV1Schema,
  type TaskFixtureCapabilityV1,
} from "./contracts.js";
import { assertCandidateFixtureCompatible } from "./fixture-manifest.js";
import {
  EXTERNAL_GODOT_MAX_BYTES_V1,
  EXTERNAL_GODOT_MAX_FILES_V1,
  isExternalGodotNativeSourcePathV1,
  isExternalGodotReservedSourcePathV1,
} from "./external-godot-source-policy.js";
import type { ManagedGodotRuntimeCapabilityV1 } from "./managed-godot-runtime.js";
import {
  selectedTreeSha256,
  type SelectedTreeEntryV1,
} from "./selected-tree.js";

const MAX_FILES = EXTERNAL_GODOT_MAX_FILES_V1;
const MAX_BYTES = EXTERNAL_GODOT_MAX_BYTES_V1;
const PROC_SELF_FD = "/proc/self/fd";

export interface PreparedCandidateGodotBuildV1 {
  readonly build: VNextBuildV1;
  readonly fixtureHash: Sha256DigestV1;
  readonly projectHash: Sha256DigestV1;
  readonly addonHash: Sha256DigestV1;
  readonly fileCount: number;
  readonly byteLength: number;
}

export interface PreparedExternalGodotLifecycleBuildV1 {
  readonly build: VNextBuildV1;
  readonly configuredMainScene: string;
  readonly projectHash: Sha256DigestV1;
  readonly descriptorHash: Sha256DigestV1;
  readonly overlayHash: Sha256DigestV1;
  readonly addonHash: Sha256DigestV1;
  readonly vanillaSidecarHash: Sha256DigestV1;
  readonly lifecycleSidecarHash: Sha256DigestV1;
  readonly fileCount: number;
  readonly byteLength: number;
}

const inspectExternalProjectConfiguration = (
  entry: SelectedTreeEntryV1,
): { readonly configuredMainScene: string } => {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(entry.content);
  } catch (error) {
    throw new TypeError("candidate project.godot is not valid UTF-8", {
      cause: error,
    });
  }
  if (/^\s*ChronoRiftLifecycle\s*=/mu.test(source)) {
    throw new TypeError(
      "candidate project.godot defines the reserved ChronoRiftLifecycle autoload",
    );
  }
  const scenes = [
    ...source.matchAll(/^\s*run\/main_scene\s*=\s*"([^"\r\n]+)"\s*$/gmu),
  ].map((match) => match[1]);
  const configuredMainScene = scenes[0];
  if (
    scenes.length !== 1 ||
    configuredMainScene === undefined ||
    (!configuredMainScene.startsWith("res://") &&
      !configuredMainScene.startsWith("uid://"))
  ) {
    throw new TypeError(
      "candidate project.godot must declare exactly one supported run/main_scene",
    );
  }
  return { configuredMainScene };
};

const fdPath = (handle: FileHandle, name?: string): string =>
  name === undefined
    ? `${PROC_SELF_FD}/${handle.fd}`
    : `${PROC_SELF_FD}/${handle.fd}/${name}`;

const sameSnapshotIdentity = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const pinnedStat = (handle: FileHandle): Promise<BigIntStats> =>
  handle.stat({ bigint: true });

const openPinnedEntry = async (
  parent: FileHandle,
  name: string,
  relativePath: string,
): Promise<{ readonly handle: FileHandle; readonly stat: BigIntStats }> => {
  const path = fdPath(parent, name);
  const inspected = await lstat(path, { bigint: true });
  if (inspected.isSymbolicLink()) {
    throw new TypeError(`candidate source contains a symlink: ${relativePath}`);
  }
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    throw new TypeError(
      `candidate source changed or contains a symlink: ${relativePath}`,
      { cause: error },
    );
  }
  try {
    const stat = await pinnedStat(handle);
    if (!sameSnapshotIdentity(inspected, stat)) {
      throw new TypeError(
        `candidate source changed during snapshot: ${relativePath}`,
      );
    }
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const collectCandidate = async (
  workspaceDirectory: string,
  policy: "m3-fixture" | "external-lifecycle" = "m3-fixture",
): Promise<readonly SelectedTreeEntryV1[]> => {
  const root = resolve(workspaceDirectory);
  const inspectedRoot = await lstat(root, { bigint: true });
  if (inspectedRoot.isSymbolicLink() || !inspectedRoot.isDirectory()) {
    throw new TypeError("candidate workspace must be a real directory");
  }
  let rootHandle: FileHandle;
  try {
    rootHandle = await open(
      root,
      constants.O_RDONLY |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
    );
  } catch (error) {
    throw new TypeError("candidate workspace changed before snapshot", {
      cause: error,
    });
  }
  const files: SelectedTreeEntryV1[] = [];
  let totalBytes = 0;
  const visit = async (
    directory: FileHandle,
    prefix: string,
    rootDevice: bigint,
  ): Promise<void> => {
    const directoryBefore = await pinnedStat(directory);
    if (!directoryBefore.isDirectory() || directoryBefore.dev !== rootDevice) {
      throw new TypeError("candidate source crossed a filesystem boundary");
    }
    const names = await readdir(fdPath(directory));
    names.sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
    for (const name of names) {
      if (prefix === "" && (name === ".git" || name === ".godot")) continue;
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      if (
        policy === "external-lifecycle" &&
        isExternalGodotReservedSourcePathV1(relativePath)
      ) {
        throw new TypeError(
          `candidate source collides with reserved lifecycle overlay state: ${relativePath}`,
        );
      }
      if (
        policy === "external-lifecycle" &&
        isExternalGodotNativeSourcePathV1(relativePath)
      ) {
        throw new TypeError(
          `external Godot lifecycle candidate contains a native or non-GDScript path: ${relativePath}`,
        );
      }
      if (relativePath === "addons" || relativePath.startsWith("addons/")) {
        throw new TypeError(
          "candidate source collides with the managed read-only addons mount",
        );
      }
      const pinned = await openPinnedEntry(directory, name, relativePath);
      try {
        if (pinned.stat.dev !== rootDevice) {
          throw new TypeError(
            `candidate source crossed a filesystem boundary: ${relativePath}`,
          );
        }
        if (pinned.stat.isDirectory()) {
          await visit(pinned.handle, relativePath, rootDevice);
          continue;
        }
        if (!pinned.stat.isFile()) {
          throw new TypeError(
            `candidate source contains an unsupported file: ${relativePath}`,
          );
        }
        const bytes = await pinned.handle.readFile();
        const after = await pinnedStat(pinned.handle);
        if (
          !sameSnapshotIdentity(pinned.stat, after) ||
          BigInt(bytes.byteLength) !== pinned.stat.size
        ) {
          throw new TypeError(
            `candidate source changed during snapshot: ${relativePath}`,
          );
        }
        totalBytes += bytes.byteLength;
        if (files.length >= MAX_FILES || totalBytes > MAX_BYTES) {
          throw new TypeError(
            "candidate source exceeds its bounded build profile",
          );
        }
        files.push({
          relativePath,
          mode: (pinned.stat.mode & 0o111n) === 0n ? "100644" : "100755",
          content: bytes,
        });
      } finally {
        await pinned.handle.close();
      }
    }
    const directoryAfter = await pinnedStat(directory);
    if (!sameSnapshotIdentity(directoryBefore, directoryAfter)) {
      throw new TypeError("candidate directory changed during snapshot");
    }
  };
  try {
    const rootStat = await pinnedStat(rootHandle);
    if (
      !rootStat.isDirectory() ||
      !sameSnapshotIdentity(inspectedRoot, rootStat) ||
      (await realpath(root)) !== root ||
      (await realpath(fdPath(rootHandle))) !== root
    ) {
      throw new TypeError("candidate workspace changed before snapshot");
    }
    await visit(rootHandle, "", rootStat.dev);
    const finalRoot = await lstat(root, { bigint: true });
    if (
      finalRoot.isSymbolicLink() ||
      !sameSnapshotIdentity(rootStat, finalRoot) ||
      (await realpath(fdPath(rootHandle))) !== root
    ) {
      throw new TypeError("candidate workspace changed during snapshot");
    }
    return files;
  } finally {
    await rootHandle.close();
  }
};

export const collectCandidateGodotSourceV1 = (
  workspaceDirectory: string,
  profile: "m3-fixture" | "external-lifecycle",
): Promise<readonly SelectedTreeEntryV1[]> =>
  collectCandidate(workspaceDirectory, profile);

const fixtureTreeHash = (
  files: readonly SelectedTreeEntryV1[],
): Sha256DigestV1 => {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return asSha256DigestV1(hash.digest("hex"));
};

export const prepareCandidateGodotBuildV1 = async (input: {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly workspaceDirectory: string;
  readonly baselineSourceHash: Sha256DigestV1;
  readonly fixtureCapability: TaskFixtureCapabilityV1;
  readonly managedRuntime: ManagedGodotRuntimeCapabilityV1;
  readonly now: string;
}): Promise<PreparedCandidateGodotBuildV1> => {
  const files = await collectCandidate(input.workspaceDirectory);
  const manifestEntry = files.find(
    (entry) => entry.relativePath === "chronorift.fixture.json",
  );
  if (manifestEntry === undefined) {
    throw new TypeError("candidate fixture manifest is missing");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestEntry.content),
    ) as unknown;
  } catch (error) {
    throw new TypeError("candidate fixture manifest is invalid", {
      cause: error,
    });
  }
  const parsedManifest = FixtureManifestV1Schema.parse(manifest);
  assertCandidateFixtureCompatible(parsedManifest, input.fixtureCapability);

  const sourceHash = selectedTreeSha256(files);
  const fixtureHash = fixtureTreeHash(files);
  const addonHash = input.managedRuntime.addonHash;
  const projectHash = asSha256DigestV1(
    createHash("sha256").update(`${fixtureHash}\0${addonHash}`).digest("hex"),
  );
  const workspaceDiffHash = asSha256DigestV1(
    contentHash({
      schemaVersion: 1,
      baselineSourceHash: input.baselineSourceHash,
      candidateSourceHash: sourceHash,
    }),
  );
  const buildConfigurationHash = asSha256DigestV1(
    contentHash({
      schemaVersion: 1,
      fixtureCapabilitySha256: input.fixtureCapability.capabilitySha256,
      managedRuntimeId: input.managedRuntime.managedRuntimeId,
      startupScene: input.fixtureCapability.startupScene,
      protocolVersion: input.fixtureCapability.protocolVersion,
    }),
  );
  const outputHash = projectHash;
  const buildIdentityHash = contentHash({
    schemaVersion: 1,
    projectHash,
    buildConfigurationHash,
    outputHash,
  });
  const build = VNextBuildV1Schema.parse({
    schemaVersion: 1,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    sourceId: asSourceId(`source:${sourceHash}`),
    buildId: asBuildId(`build:${buildIdentityHash}`),
    sourceHash,
    workspaceDiffHash,
    buildConfigurationHash,
    outputHash,
    createdAt: input.now,
  });
  return {
    build,
    fixtureHash,
    projectHash,
    addonHash,
    fileCount: files.length,
    byteLength: files.reduce(
      (total, file) => total + file.content.byteLength,
      0,
    ),
  };
};

export const prepareExternalGodotLifecycleBuildV1 = async (input: {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly workspaceDirectory: string;
  readonly baselineSourceHash: Sha256DigestV1;
  readonly projectCapability: {
    readonly capabilitySha256: Sha256DigestV1;
    readonly descriptorSha256: Sha256DigestV1;
  };
  readonly managedRuntime: {
    readonly managedRuntimeId: string;
    readonly addonHash: Sha256DigestV1;
    readonly overlayHash: Sha256DigestV1;
    readonly vanillaSidecarSourceSha256: Sha256DigestV1;
    readonly lifecycleSidecarSourceSha256: Sha256DigestV1;
    readonly protocolProfile: "chronorift-godot-lifecycle-v1";
  };
  readonly now: string;
}): Promise<PreparedExternalGodotLifecycleBuildV1> => {
  const files = await collectCandidate(
    input.workspaceDirectory,
    "external-lifecycle",
  );
  const projectFile = files.find(
    (entry) => entry.relativePath === "project.godot",
  );
  if (projectFile === undefined) {
    throw new TypeError(
      "candidate external Godot project is missing project.godot",
    );
  }
  const { configuredMainScene } =
    inspectExternalProjectConfiguration(projectFile);
  const sourceHash = selectedTreeSha256(files);
  const descriptorHash = input.projectCapability.descriptorSha256;
  const overlayHash = input.managedRuntime.overlayHash;
  const addonHash = input.managedRuntime.addonHash;
  const vanillaSidecarHash = input.managedRuntime.vanillaSidecarSourceSha256;
  const lifecycleSidecarHash =
    input.managedRuntime.lifecycleSidecarSourceSha256;
  const projectHash = asSha256DigestV1(
    createHash("sha256")
      .update("chronorift-external-godot-project-v1\0")
      .update(sourceHash)
      .update("\0")
      .update(descriptorHash)
      .update("\0")
      .update(overlayHash)
      .update("\0")
      .update(addonHash)
      .digest("hex"),
  );
  const workspaceDiffHash = asSha256DigestV1(
    contentHash({
      schemaVersion: 1,
      baselineSourceHash: input.baselineSourceHash,
      candidateSourceHash: sourceHash,
    }),
  );
  const buildConfigurationHash = asSha256DigestV1(
    contentHash({
      schemaVersion: 1,
      runtimeProfile: "godot-external-lifecycle-v1",
      protocolProfile: input.managedRuntime.protocolProfile,
      projectCapabilitySha256: input.projectCapability.capabilitySha256,
      managedRuntimeId: input.managedRuntime.managedRuntimeId,
      descriptorHash,
      overlayHash,
      addonHash,
      vanillaSidecarHash,
      lifecycleSidecarHash,
      configuredMainScene,
    }),
  );
  const outputHash = projectHash;
  const buildIdentityHash = contentHash({
    schemaVersion: 1,
    projectHash,
    buildConfigurationHash,
    outputHash,
  });
  const build = VNextBuildV1Schema.parse({
    schemaVersion: 1,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    sourceId: asSourceId(`source:${sourceHash}`),
    buildId: asBuildId(`build:${buildIdentityHash}`),
    sourceHash,
    workspaceDiffHash,
    buildConfigurationHash,
    outputHash,
    createdAt: input.now,
  });
  return Object.freeze({
    build,
    configuredMainScene,
    projectHash,
    descriptorHash,
    overlayHash,
    addonHash,
    vanillaSidecarHash,
    lifecycleSidecarHash,
    fileCount: files.length,
    byteLength: files.reduce(
      (total, file) => total + file.content.byteLength,
      0,
    ),
  });
};
