import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  rm,
  statfs,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  asSha256DigestV1,
  asTaskId,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

import { buildSandboxProcessPlan } from "./bubblewrap-command.js";
import { BoundedOutputCapture } from "./bounded-output.js";
import {
  CgroupV2Controller,
  type ExecutionCgroupScope,
  type CgroupRootIdentity,
  waitForCgroupEmpty,
} from "./cgroup-v2.js";
import {
  SandboxHostCapabilityV1Schema,
  SandboxPreflightReceiptV1Schema,
  SandboxTaskStorageCapabilityV1Schema,
  type AggregateStorageUsageV1,
  type SandboxHostCapabilityV1,
  type SandboxPreflightReceiptV1,
  type SandboxTaskStorageCapabilityV1,
} from "./contracts.js";
import { M1Error, sanitizeM1Diagnostic } from "./errors.js";
import {
  startSandboxBootstrap,
  type SandboxBootstrapSession,
} from "./sandbox-bootstrap.js";
import { resolveResourceLimitsV1 } from "./sandbox-policy.js";

const REQUIRED_BWRAP_FEATURES = [
  "block-fd",
  "json-status-fd",
  "bind-fd",
  "ro-bind-fd",
  "remount-ro",
] as const;
const REQUIRED_NAMESPACES = [
  "mnt",
  "pid",
  "ipc",
  "uts",
  "net",
  "user",
  "cgroup",
] as const;

export function assertRequiredBubblewrapFeatures(help: string): void {
  for (const feature of REQUIRED_BWRAP_FEATURES) {
    if (!help.includes(`--${feature}`)) {
      throw new M1Error(
        "sandbox_preflight_failed",
        `bubblewrap lacks required feature ${feature}`,
      );
    }
  }
}

export interface SandboxHostPreflightRequest {
  readonly delegatedCgroupRoot: string;
  readonly bwrapPath: string;
  readonly prlimitPath: string;
  readonly busyboxPath: string;
  readonly taskStorageRoot?: string | undefined;
}

export interface SandboxHostBinding {
  readonly delegatedCgroupRoot: string;
  readonly bwrapPath: string;
  readonly prlimitPath: string;
  readonly busyboxPath: string;
  readonly taskStorageRoot?: string | undefined;
}

export type SandboxHostPreflightResult =
  | {
      readonly kind: "supported";
      readonly capability: SandboxHostCapabilityV1;
      readonly binding: SandboxHostBinding;
      readonly receipt: Extract<
        SandboxPreflightReceiptV1,
        { readonly status: "supported" }
      >;
    }
  | {
      readonly kind: "unsupported";
      readonly receipt: Extract<
        SandboxPreflightReceiptV1,
        { readonly status: "unsupported" }
      >;
    };

export interface SandboxHostProbeEvidence {
  readonly binding: SandboxHostBinding;
  readonly bwrapIdentity: Sha256DigestV1;
  readonly bwrapVersion: string;
  readonly prlimitIdentity: Sha256DigestV1;
  readonly runtimeIdentity: Sha256DigestV1;
  readonly delegatedCgroupRootIdentity: Sha256DigestV1;
  readonly cgroupNamespaceUnshared: boolean;
  readonly activeProbeSha256: Sha256DigestV1;
}

export interface SandboxHostProbePort {
  now(): string;
  probe(
    request: SandboxHostPreflightRequest,
  ): Promise<SandboxHostProbeEvidence>;
}

interface InspectedExecutable {
  readonly canonicalPath: string;
  readonly identity: Sha256DigestV1;
  readonly bytes: Buffer;
}

interface SandboxHostPathTrustEntry {
  readonly kind: "directory" | "file" | "other" | "symbolic-link";
  readonly mode: number;
  readonly uid: number;
}

export interface SandboxHostPathTrustPort {
  currentUid(): number | undefined;
  canonicalize(path: string): Promise<string>;
  inspect(path: string): Promise<SandboxHostPathTrustEntry>;
  canWrite(path: string): Promise<boolean>;
}

export interface SandboxTaskStorageInspectionPort {
  currentUid(): number | undefined;
  canonicalize(path: string): Promise<string>;
  inspectPath(path: string): Promise<{
    readonly kind: "directory" | "other" | "symbolic-link";
    readonly device: bigint;
    readonly inode: bigint;
    readonly uid: number;
    readonly mode: number;
  }>;
  inspectFileSystem(path: string): Promise<{
    readonly name: string;
    readonly type: bigint;
    readonly blockSize: bigint;
    readonly totalBlocks: bigint;
    readonly freeBlocks: bigint;
    readonly totalInodes: bigint;
    readonly freeInodes: bigint;
  }>;
}

export interface SandboxTaskStorageInspection {
  readonly capability: SandboxTaskStorageCapabilityV1;
  readonly binding: { readonly taskStorageRoot: string };
  readonly usage: AggregateStorageUsageV1;
}

const nodeHostPathTrustPort: SandboxHostPathTrustPort = {
  currentUid: () => process.getuid?.(),
  canonicalize: (path) => realpath(path),
  inspect: async (path) => {
    const statistics = await lstat(path);
    const kind = statistics.isSymbolicLink()
      ? "symbolic-link"
      : statistics.isFile()
        ? "file"
        : statistics.isDirectory()
          ? "directory"
          : "other";
    return { kind, mode: statistics.mode, uid: statistics.uid };
  },
  canWrite: async (path) => {
    try {
      await access(path, constants.W_OK);
      return true;
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
        return false;
      }
      throw error;
    }
  },
};

const nodeTaskStorageInspectionPort: SandboxTaskStorageInspectionPort = {
  currentUid: () => process.geteuid?.(),
  canonicalize: (path) => realpath(path),
  inspectPath: async (path) => {
    const statistics = await lstat(path, { bigint: true });
    return {
      kind: statistics.isSymbolicLink()
        ? "symbolic-link"
        : statistics.isDirectory()
          ? "directory"
          : "other",
      device: statistics.dev,
      inode: statistics.ino,
      uid: Number(statistics.uid),
      mode: Number(statistics.mode),
    };
  },
  inspectFileSystem: async (path) => {
    const [statistics, mountInfo] = await Promise.all([
      statfs(path, { bigint: true }),
      readFile("/proc/self/mountinfo", "utf8"),
    ]);
    const name = exactMountFileSystemName(mountInfo, path);
    return {
      name,
      type: statistics.type,
      blockSize: statistics.bsize,
      totalBlocks: statistics.blocks,
      freeBlocks: statistics.bfree,
      totalInodes: statistics.files,
      freeInodes: statistics.ffree,
    };
  },
};

const MOUNT_INFO_ESCAPE = /\\(040|011|012|134)/gu;
const MOUNT_INFO_ESCAPES = new Map([
  ["040", " "],
  ["011", "\t"],
  ["012", "\n"],
  ["134", "\\"],
]);

const decodeMountInfoPath = (value: string): string =>
  value.replace(MOUNT_INFO_ESCAPE, (_match, code: string) => {
    const decoded = MOUNT_INFO_ESCAPES.get(code);
    if (decoded === undefined) {
      throw new Error("mountinfo path contains an unsupported escape");
    }
    return decoded;
  });

const exactMountFileSystemName = (
  mountInfo: string,
  canonicalRoot: string,
): string => {
  let matched: string | undefined;
  for (const line of mountInfo.split("\n")) {
    if (line.length === 0) continue;
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || separator + 1 >= fields.length) continue;
    const mountPoint = fields[4];
    const fileSystem = fields[separator + 1];
    if (
      mountPoint !== undefined &&
      fileSystem !== undefined &&
      decodeMountInfoPath(mountPoint) === canonicalRoot
    ) {
      // Later entries are the visible top mount when the same path is
      // over-mounted in this mount namespace.
      matched = fileSystem;
    }
  }
  if (matched === undefined) {
    throw new Error("task storage root is not an exact mountinfo mount point");
  }
  return matched;
};

async function assertTrustedHostRegularFilePath(
  path: string,
  requireExecutable: boolean,
  trust: SandboxHostPathTrustPort,
): Promise<string> {
  const label = requireExecutable ? "executable" : "runtime file";
  const uid = trust.currentUid();
  if (uid === undefined || uid === 0) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox Host must run as a known non-root user",
    );
  }
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new M1Error(
      "sandbox_preflight_failed",
      `sandbox ${label} path must be absolute and normalized`,
    );
  }
  const canonicalPath = await trust.canonicalize(path);
  if (canonicalPath !== path) {
    throw new M1Error(
      "sandbox_preflight_failed",
      `sandbox ${label} path must already be canonical`,
    );
  }

  const chain: string[] = [canonicalPath];
  for (let parent = dirname(canonicalPath); ; parent = dirname(parent)) {
    chain.push(parent);
    if (parent === dirname(parent)) break;
  }
  for (const [index, component] of chain.entries()) {
    const entry = await trust.inspect(component);
    const expectedKind = index === 0 ? "file" : "directory";
    if (entry.kind === "symbolic-link") {
      throw new M1Error(
        "sandbox_preflight_failed",
        `sandbox ${label} path must not contain a symbolic link`,
      );
    }
    if (entry.kind !== expectedKind) {
      throw new M1Error(
        "sandbox_preflight_failed",
        `sandbox ${label} ${index === 0 ? "must be a regular file" : "ancestor must be a directory"}`,
      );
    }
    if (entry.uid !== 0) {
      throw new M1Error(
        "sandbox_preflight_failed",
        `sandbox ${label} and every ancestor must be root-owned`,
      );
    }
    if ((entry.mode & 0o022) !== 0) {
      throw new M1Error(
        "sandbox_preflight_failed",
        `sandbox ${label} and every ancestor must not be group or world writable`,
      );
    }
    if (await trust.canWrite(component)) {
      throw new M1Error(
        "sandbox_preflight_failed",
        `sandbox Host process must not have write access to the ${label} path`,
      );
    }
    if (requireExecutable && index === 0 && (entry.mode & 0o111) === 0) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox executable must have an executable mode bit",
      );
    }
  }
  return canonicalPath;
}

export const assertTrustedHostExecutablePath = (
  path: string,
  trust: SandboxHostPathTrustPort = nodeHostPathTrustPort,
): Promise<string> => assertTrustedHostRegularFilePath(path, true, trust);

export const assertTrustedHostRuntimeFilePath = (
  path: string,
  trust: SandboxHostPathTrustPort = nodeHostPathTrustPort,
): Promise<string> => assertTrustedHostRegularFilePath(path, false, trust);

const sha256Bytes = (bytes: Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const jsonHash = (value: JsonValue): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(value));

const TASK_STORAGE_MAX_BYTES = 1_073_741_824n;
const TASK_STORAGE_MAX_INODES = 131_072n;
const TASK_STORAGE_FILESYSTEMS = new Map<
  SandboxTaskStorageCapabilityV1["filesystem"],
  bigint
>([
  ["tmpfs", 0x01021994n],
  ["ext4", 0xef53n],
  ["xfs", 0x58465342n],
]);

const taskStorageError = (message: string, cause?: unknown): M1Error =>
  new M1Error("resource_limit_unavailable", message, cause);

export async function inspectSandboxTaskStorageRoot(
  root: string,
  inspection: SandboxTaskStorageInspectionPort = nodeTaskStorageInspectionPort,
): Promise<SandboxTaskStorageInspection> {
  const currentUid = inspection.currentUid();
  if (
    currentUid === undefined ||
    !Number.isInteger(currentUid) ||
    currentUid <= 0
  ) {
    throw taskStorageError(
      "task storage requires a known non-root Host effective user",
    );
  }
  if (!isAbsolute(root) || resolve(root) !== root) {
    throw taskStorageError(
      "task storage root must be an absolute normalized path",
    );
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await inspection.canonicalize(root);
  } catch (error) {
    throw taskStorageError("task storage root canonicalization failed", error);
  }
  if (canonicalRoot !== root) {
    throw taskStorageError(
      "task storage root must already be canonical and symlink-free",
    );
  }
  const parent = dirname(canonicalRoot);
  if (parent === canonicalRoot) {
    throw taskStorageError("task storage root must not be the Host root");
  }

  let rootPath: Awaited<ReturnType<typeof inspection.inspectPath>>;
  let parentPath: Awaited<ReturnType<typeof inspection.inspectPath>>;
  let filesystem: Awaited<ReturnType<typeof inspection.inspectFileSystem>>;
  try {
    [rootPath, parentPath, filesystem] = await Promise.all([
      inspection.inspectPath(canonicalRoot),
      inspection.inspectPath(parent),
      inspection.inspectFileSystem(canonicalRoot),
    ]);
  } catch (error) {
    throw taskStorageError("task storage mount inspection failed", error);
  }
  if (rootPath.kind !== "directory" || parentPath.kind !== "directory") {
    throw taskStorageError(
      "task storage root and its parent must be real directories",
    );
  }
  if (rootPath.uid !== currentUid || (rootPath.mode & 0o7777) !== 0o700) {
    throw taskStorageError(
      "task storage root must be owned by the Host user with mode 0700",
    );
  }
  if (rootPath.device === parentPath.device) {
    throw taskStorageError(
      "task storage root must be a distinct filesystem mount point",
    );
  }
  const filesystemName =
    filesystem.name === "tmpfs" ||
    filesystem.name === "ext4" ||
    filesystem.name === "xfs"
      ? filesystem.name
      : undefined;
  const expectedMagic =
    filesystemName === undefined
      ? undefined
      : TASK_STORAGE_FILESYSTEMS.get(filesystemName);
  if (filesystemName === undefined || expectedMagic !== filesystem.type) {
    throw taskStorageError(
      "task storage root must use an exact allowed non-FUSE filesystem",
    );
  }
  if (
    filesystem.blockSize <= 0n ||
    filesystem.totalBlocks <= 0n ||
    filesystem.freeBlocks < 0n ||
    filesystem.freeBlocks > filesystem.totalBlocks ||
    filesystem.totalInodes <= 0n ||
    filesystem.freeInodes < 0n ||
    filesystem.freeInodes > filesystem.totalInodes
  ) {
    throw taskStorageError("task storage statfs values are invalid");
  }
  const totalBytes = filesystem.blockSize * filesystem.totalBlocks;
  if (totalBytes > TASK_STORAGE_MAX_BYTES) {
    throw taskStorageError(
      "task storage filesystem exceeds the 1 GiB hard capacity bound",
    );
  }
  if (filesystem.totalInodes > TASK_STORAGE_MAX_INODES) {
    throw taskStorageError(
      "task storage filesystem exceeds the 131072 inode hard bound",
    );
  }
  const rootIdentitySha256 = jsonHash({
    schemaVersion: 1,
    canonicalRoot,
    device: rootPath.device.toString(),
    inode: rootPath.inode.toString(),
  });
  const capability = SandboxTaskStorageCapabilityV1Schema.parse({
    kind: "dedicated-capacity-bounded-filesystem-v1",
    filesystem: filesystemName,
    totalBytes: Number(totalBytes),
    totalInodes: Number(filesystem.totalInodes),
    rootIdentitySha256,
  });
  return Object.freeze({
    capability: Object.freeze(capability),
    binding: Object.freeze({ taskStorageRoot: canonicalRoot }),
    usage: Object.freeze({
      usedBytes: Number(
        filesystem.blockSize * (filesystem.totalBlocks - filesystem.freeBlocks),
      ),
      usedInodes: Number(filesystem.totalInodes - filesystem.freeInodes),
    }),
  });
}

const isStrictChildPath = (parent: string, child: string): boolean => {
  const difference = relative(parent, child);
  return !(
    difference === "" ||
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  );
};

const errnoCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;

/**
 * Admits the bounded storage mount before creating a runtime root, then walks
 * every missing component through pinned directory descriptors. The procfs
 * descriptor paths give Node an openat-like boundary while O_NOFOLLOW keeps a
 * pre-existing component from redirecting creation outside the admitted mount.
 */
export async function createSandboxTaskRuntimeRoot(
  taskStorageRoot: string,
  configuredRuntimeRoot: string,
  inspection: SandboxTaskStorageInspectionPort = nodeTaskStorageInspectionPort,
): Promise<string> {
  const runtimeRoot = resolve(configuredRuntimeRoot);
  if (!isStrictChildPath(taskStorageRoot, runtimeRoot)) {
    throw taskStorageError(
      "--runtime-root must be a strict child of --task-storage-root for M3 Tasks",
    );
  }
  const components = relative(taskStorageRoot, runtimeRoot).split(sep);
  if (components.some((component) => component.length === 0)) {
    throw taskStorageError("runtime root contains an invalid path component");
  }

  const admitted = await inspectSandboxTaskStorageRoot(
    taskStorageRoot,
    inspection,
  );
  const descriptorFlags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let rootHandle: Awaited<ReturnType<typeof open>>;
  try {
    rootHandle = await open(taskStorageRoot, descriptorFlags);
  } catch (error) {
    throw taskStorageError(
      "task storage root could not be pinned after admission",
      error,
    );
  }

  let currentHandle = rootHandle;
  let failed = false;
  try {
    const rootStatistics = await rootHandle.stat({ bigint: true });
    const openedRootIdentity = jsonHash({
      schemaVersion: 1,
      canonicalRoot: taskStorageRoot,
      device: rootStatistics.dev.toString(),
      inode: rootStatistics.ino.toString(),
    });
    if (
      !rootStatistics.isDirectory() ||
      openedRootIdentity !== admitted.capability.rootIdentitySha256
    ) {
      throw taskStorageError(
        "task storage root changed between admission and descriptor pinning",
      );
    }

    for (const component of components) {
      const descriptorChild = join(
        "/proc/self/fd",
        String(currentHandle.fd),
        component,
      );
      try {
        await mkdir(descriptorChild, { mode: 0o700 });
      } catch (error) {
        if (errnoCode(error) !== "EEXIST") throw error;
      }

      const nextHandle = await open(descriptorChild, descriptorFlags);
      try {
        const childStatistics = await nextHandle.stat({ bigint: true });
        if (
          !childStatistics.isDirectory() ||
          childStatistics.dev !== rootStatistics.dev
        ) {
          throw taskStorageError(
            "runtime root component left the admitted task storage filesystem",
          );
        }
      } catch (error) {
        await nextHandle.close();
        throw error;
      }
      if (currentHandle !== rootHandle) await currentHandle.close();
      currentHandle = nextHandle;
    }

    const [
      canonicalRuntimeRoot,
      pathStatistics,
      descriptorStatistics,
      current,
    ] = await Promise.all([
      realpath(runtimeRoot),
      lstat(runtimeRoot, { bigint: true }),
      currentHandle.stat({ bigint: true }),
      inspectSandboxTaskStorageRoot(taskStorageRoot, inspection),
    ]);
    if (
      canonicalRuntimeRoot !== runtimeRoot ||
      !isStrictChildPath(
        current.binding.taskStorageRoot,
        canonicalRuntimeRoot,
      ) ||
      pathStatistics.isSymbolicLink() ||
      !pathStatistics.isDirectory() ||
      pathStatistics.dev !== rootStatistics.dev ||
      pathStatistics.dev !== descriptorStatistics.dev ||
      pathStatistics.ino !== descriptorStatistics.ino ||
      jsonHash(current.capability as unknown as JsonValue) !==
        jsonHash(admitted.capability as unknown as JsonValue)
    ) {
      throw taskStorageError(
        "runtime root or task storage changed during bounded creation",
      );
    }
    return runtimeRoot;
  } catch (error) {
    failed = true;
    if (error instanceof M1Error) throw error;
    throw taskStorageError(
      "runtime root creation failed inside admitted task storage",
      error,
    );
  } finally {
    let closeError: unknown;
    if (currentHandle !== rootHandle) {
      try {
        await currentHandle.close();
      } catch (error) {
        closeError = error;
      }
    }
    try {
      await rootHandle.close();
    } catch (error) {
      closeError ??= error;
    }
    if (!failed && closeError !== undefined) {
      throw taskStorageError(
        "runtime root descriptor cleanup could not be proven",
        closeError,
      );
    }
  }
}

export async function assertSandboxTaskStorageBindingMatches(
  capability: SandboxTaskStorageCapabilityV1,
  taskStorageRoot: string,
  inspection: SandboxTaskStorageInspectionPort = nodeTaskStorageInspectionPort,
): Promise<AggregateStorageUsageV1> {
  const current = await inspectSandboxTaskStorageRoot(
    taskStorageRoot,
    inspection,
  );
  if (
    contentHash(current.capability as unknown as JsonValue) !==
    contentHash(capability as unknown as JsonValue)
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "task storage binding no longer matches the frozen capability",
    );
  }
  return current.usage;
}

export async function assertSandboxTaskStorageLayoutMatches(
  capability: SandboxTaskStorageCapabilityV1,
  taskStorageRoot: string,
  layoutPaths: readonly string[],
  inspection: SandboxTaskStorageInspectionPort = nodeTaskStorageInspectionPort,
): Promise<AggregateStorageUsageV1> {
  const usage = await assertSandboxTaskStorageBindingMatches(
    capability,
    taskStorageRoot,
    inspection,
  );
  let rootPath: Awaited<ReturnType<typeof inspection.inspectPath>>;
  try {
    rootPath = await inspection.inspectPath(taskStorageRoot);
    for (const layoutPath of layoutPaths) {
      if (!isAbsolute(layoutPath) || resolve(layoutPath) !== layoutPath) {
        throw new Error("Task layout path is not absolute and normalized");
      }
      const [canonicalPath, path] = await Promise.all([
        inspection.canonicalize(layoutPath),
        inspection.inspectPath(layoutPath),
      ]);
      const difference = relative(taskStorageRoot, canonicalPath);
      if (
        canonicalPath !== layoutPath ||
        difference === "" ||
        difference === ".." ||
        difference.startsWith("../") ||
        isAbsolute(difference) ||
        path.kind !== "directory" ||
        path.device !== rootPath.device
      ) {
        throw new Error(
          "Task layout no longer resolves inside the bounded storage filesystem",
        );
      }
    }
  } catch (error) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "Task layout no longer matches bounded aggregate Task storage",
      error,
    );
  }
  return usage;
}

const normalizeBwrapVersion = (rawVersion: string): string => {
  const version = rawVersion.trim();
  const printableAscii = [...version].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint >= 0x20 && codePoint <= 0x7e;
  });
  if (
    version.length === 0 ||
    version.length > 128 ||
    !printableAscii ||
    version.includes("/") ||
    version.includes("\\")
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "bubblewrap version must be a short printable single-line value without paths",
    );
  }
  return version;
};

const inspectExecutable = async (
  path: string,
): Promise<InspectedExecutable> => {
  const canonicalPath = await assertTrustedHostExecutablePath(path);
  const bytes = await readFile(canonicalPath);
  return { canonicalPath, identity: sha256Bytes(bytes), bytes };
};

const assertStaticX8664Elf = (bytes: Buffer): void => {
  if (
    bytes.byteLength < 64 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== 62
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox runtime must be a little-endian x86-64 ELF executable",
    );
  }
  const programHeaderOffset = Number(bytes.readBigUInt64LE(32));
  const programHeaderSize = bytes.readUInt16LE(54);
  const programHeaderCount = bytes.readUInt16LE(56);
  if (
    !Number.isSafeInteger(programHeaderOffset) ||
    programHeaderSize < 56 ||
    programHeaderOffset + programHeaderSize * programHeaderCount >
      bytes.byteLength
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox runtime has an invalid ELF program header table",
    );
  }
  for (let index = 0; index < programHeaderCount; index += 1) {
    const offset = programHeaderOffset + index * programHeaderSize;
    if (bytes.readUInt32LE(offset) === 3) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox runtime must not require a dynamic ELF interpreter",
      );
    }
  }
};

const runHostExecutable = (
  executable: string,
  args: readonly string[],
): Promise<string> =>
  new Promise((resolveRun, rejectRun) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        env: {
          HOME: "/nonexistent",
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
        },
        maxBuffer: 1024 * 1024,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          rejectRun(
            new M1Error(
              "sandbox_preflight_failed",
              `sandbox executable probe failed: ${stderr.trim()}`,
              error,
            ),
          );
          return;
        }
        resolveRun(stdout);
      },
    );
  });

const cgroupRootDigest = (identity: CgroupRootIdentity): Sha256DigestV1 =>
  jsonHash({
    schemaVersion: 1,
    canonicalPath: identity.canonicalPath,
    device: identity.device.toString(),
    inode: identity.inode.toString(),
  });

const namespaceIdentities = async (
  pid: number | "self",
): Promise<Readonly<Record<(typeof REQUIRED_NAMESPACES)[number], string>>> => {
  const entries = await Promise.all(
    REQUIRED_NAMESPACES.map(
      async (namespace) =>
        [namespace, await readlink(`/proc/${pid}/ns/${namespace}`)] as const,
    ),
  );
  return Object.fromEntries(entries) as Readonly<
    Record<(typeof REQUIRED_NAMESPACES)[number], string>
  >;
};

const markerExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
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

const within = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> =>
  new Promise<T>((resolveValue, rejectValue) => {
    const timer = setTimeout(() => {
      rejectValue(
        new M1Error(
          "sandbox_preflight_failed",
          `${description} timed out during active sandbox preflight`,
        ),
      );
    }, timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolveValue(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectValue(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

export const cleanupActiveProbe = async (input: {
  readonly session:
    | Pick<SandboxBootstrapSession, "terminate" | "waitForBootstrapExit">
    | undefined;
  readonly scope: ExecutionCgroupScope | undefined;
  readonly controller: Pick<CgroupV2Controller, "cleanup"> | undefined;
  readonly bootstrapExitTimeoutMs?: number;
  readonly cleanupOperationTimeoutMs?: number;
}): Promise<void> => {
  const failures: unknown[] = [];
  let bootstrapExitProven = input.session === undefined;
  let scopeRemovalProven = input.scope === undefined;
  let controllerCleanupProven = input.controller === undefined;
  const cleanupOperationTimeoutMs = input.cleanupOperationTimeoutMs ?? 2_000;
  const attempt = async (
    description: string,
    operation: () => Promise<unknown>,
  ): Promise<boolean> => {
    try {
      await within(
        operation(),
        cleanupOperationTimeoutMs,
        `active-probe cleanup ${description}`,
      );
      return true;
    } catch (error) {
      failures.push(error);
      return false;
    }
  };

  const session = input.session;
  if (session !== undefined) {
    await attempt("termination request", () => session.terminate());
  }
  const scope = input.scope;
  if (scope !== undefined) {
    await attempt("cgroup kill", () => scope.kill());
    await attempt("cgroup empty wait", () => waitForCgroupEmpty(scope));
    if (await attempt("cgroup scope removal", () => scope.remove())) {
      scopeRemovalProven = true;
    }
  }
  const controller = input.controller;
  if (controller !== undefined) {
    if (
      await attempt("cgroup controller cleanup", () => controller.cleanup())
    ) {
      controllerCleanupProven = true;
      scopeRemovalProven = true;
    }
  }
  if (session !== undefined) {
    try {
      await within(
        session.waitForBootstrapExit(),
        input.bootstrapExitTimeoutMs ?? 2_000,
        "bootstrap cleanup",
      );
      bootstrapExitProven = true;
    } catch (error) {
      failures.push(error);
    }
  }

  if (!bootstrapExitProven || !scopeRemovalProven || !controllerCleanupProven) {
    throw new M1Error(
      "resource_limit_unavailable",
      "active sandbox probe cleanup could not be proven",
      new AggregateError(failures, "active sandbox probe cleanup failed"),
    );
  }
};

const runActiveSandboxProbe = async (input: {
  readonly binding: SandboxHostBinding;
  readonly cgroupRoot: CgroupRootIdentity;
}): Promise<Sha256DigestV1> => {
  const probeRoot = await mkdtemp(join(tmpdir(), "chronorift-sandbox-probe-"));
  const workspace = join(probeRoot, "workspace");
  const temporary = join(probeRoot, "tmp");
  const artifacts = join(probeRoot, "artifacts");
  const marker = join(workspace, "authorized-marker");
  const namespaceReceipt = join(workspace, "namespace-receipt");
  await Promise.all([
    mkdir(workspace, { mode: 0o700 }),
    mkdir(temporary, { mode: 0o700 }),
    mkdir(artifacts, { mode: 0o700 }),
  ]);

  let controller: CgroupV2Controller | undefined;
  let scope: ExecutionCgroupScope | undefined;
  let session: SandboxBootstrapSession | undefined;
  const stderrCapture = new BoundedOutputCapture(16 * 1024);
  const handles = [] as Awaited<ReturnType<typeof open>>[];
  try {
    controller = await CgroupV2Controller.create(
      input.cgroupRoot.canonicalPath,
      asTaskId(`sandbox-preflight:${randomUUID()}`),
    );
    const limits = resolveResourceLimitsV1("coding-default", 30_000);
    scope = await controller.createExecutionScope("active-probe", limits);
    handles.push(
      await open(
        workspace,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
      await open(
        temporary,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
      await open(
        artifacts,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
      await open(
        input.binding.busyboxPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ),
    );
    session = await startSandboxBootstrap({
      cwd: probeRoot,
      inheritedFds: handles.map((handle) => handle.fd),
      readinessTimeoutMs: 5_000,
      terminationTimeoutMs: 2_000,
    });
    session.stdout.on("data", () => undefined);
    session.stderr.on("data", (chunk: Buffer | string) => {
      stderrCapture.add(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      );
    });
    await scope.attach(session.pid);
    await scope.verifyAttached(await session.inspectCgroupMembership());

    const plan = buildSandboxProcessPlan({
      request: {
        schemaVersion: 1,
        operationId: "active-probe",
        profile: "coding-default",
        argv: [
          "/bin/busybox",
          "sh",
          "-c",
          'set -eu; for namespace in mnt pid ipc uts net user cgroup; do printf \'%s=\' "$namespace"; readlink "/proc/self/ns/$namespace"; done > /workspace/namespace-receipt; printf authorized > /workspace/authorized-marker',
        ],
        cwd: "/workspace",
        environment: {},
        timeoutMs: 30_000,
      },
      limits,
      binaries: {
        prlimit: input.binding.prlimitPath,
        bwrap: input.binding.bwrapPath,
      },
      runtimeTargets: [{ fd: 8, target: "/bin/busybox" }],
      unshareCgroupNamespace: true,
    });
    await session.launch(plan);
    const [, status] = await within(
      Promise.all([
        session.waitForChildStarted(),
        session.waitForSandboxStatus(),
      ]),
      10_000,
      "bubblewrap status",
    );
    const sandboxPid = status["child-pid"];
    if (typeof sandboxPid !== "number" || !Number.isInteger(sandboxPid)) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "bubblewrap status did not provide a valid child pid",
      );
    }
    if (await markerExists(marker)) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox target ran before Host authorization",
      );
    }
    await session.authorize();
    const childExit = await within(
      session.waitForChildExit(),
      30_000,
      "sandbox target",
    );
    await within(session.waitForBootstrapExit(), 2_000, "bootstrap exit");
    if (childExit.exitCode !== 0 || childExit.signal !== null) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "active sandbox target did not exit successfully",
      );
    }
    if ((await readFile(marker, "utf8")) !== "authorized") {
      throw new M1Error(
        "sandbox_preflight_failed",
        "active sandbox target marker did not match",
      );
    }
    const namespaceLines = (await readFile(namespaceReceipt, "utf8"))
      .trim()
      .split("\n");
    const namespaceEntries = namespaceLines.map((line) => {
      const separator = line.indexOf("=");
      if (separator <= 0 || separator === line.length - 1) {
        throw new M1Error(
          "sandbox_preflight_failed",
          "sandbox namespace receipt is malformed",
        );
      }
      return [line.slice(0, separator), line.slice(separator + 1)];
    }) as readonly (readonly [string, string])[];
    const namespaceNames = namespaceEntries.map(([name]) => name);
    if (
      namespaceEntries.length !== REQUIRED_NAMESPACES.length ||
      new Set(namespaceNames).size !== REQUIRED_NAMESPACES.length ||
      [...namespaceNames].sort().join(",") !==
        [...REQUIRED_NAMESPACES].sort().join(",")
    ) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox namespace receipt has unexpected fields",
      );
    }
    const sandboxNamespaces = Object.fromEntries(namespaceEntries) as Readonly<
      Record<string, string>
    >;
    const hostNamespaces = await namespaceIdentities("self");
    for (const namespace of REQUIRED_NAMESPACES) {
      if (
        sandboxNamespaces[namespace] === undefined ||
        hostNamespaces[namespace] === sandboxNamespaces[namespace]
      ) {
        throw new M1Error(
          "sandbox_preflight_failed",
          `${namespace} namespace was not isolated`,
        );
      }
    }
    const usage = await scope.usage();
    await waitForCgroupEmpty(scope);
    await scope.remove();
    scope = undefined;
    await controller.cleanup();
    controller = undefined;
    const activeProbeRecord: JsonValue = {
      schemaVersion: 1,
      targetBlockedBeforeAuthorization: true,
      targetCompletedAfterAuthorization: true,
      childExitCode: childExit.exitCode,
      namespaces: Object.fromEntries(
        REQUIRED_NAMESPACES.map((namespace) => [namespace, "isolated"]),
      ),
      resourceUsage: {
        cpuUsageUsec: usage.cpuUsageUsec,
        memoryPeakBytes: usage.memoryPeakBytes,
        pidsPeak: usage.pidsPeak,
      },
    };
    return jsonHash(activeProbeRecord);
  } catch (error) {
    let cleanupError: unknown;
    try {
      await cleanupActiveProbe({ session, scope, controller });
    } catch (caughtCleanupError) {
      cleanupError = caughtCleanupError;
    }
    const stderr = sanitizeM1Diagnostic(
      Buffer.from(stderrCapture.bytes()).toString("utf8").trim(),
      [probeRoot, workspace, temporary, artifacts],
    );
    if (cleanupError !== undefined) {
      const primaryMessage =
        error instanceof Error ? error.message : String(error);
      const cleanupMessage =
        cleanupError instanceof Error
          ? cleanupError.message
          : typeof cleanupError === "string"
            ? cleanupError
            : "active sandbox probe cleanup failed";
      throw new M1Error(
        "resource_limit_unavailable",
        sanitizeM1Diagnostic(
          `${primaryMessage}; ${cleanupMessage}${stderr.length > 0 ? `; launcher stderr: ${stderr}` : ""}`,
          [probeRoot, workspace, temporary, artifacts],
        ),
        new AggregateError(
          [error, cleanupError],
          "active sandbox probe failed without proven cleanup",
        ),
      );
    }
    if (stderr.length > 0) {
      const code =
        error instanceof M1Error ? error.code : "sandbox_preflight_failed";
      const message = error instanceof Error ? error.message : String(error);
      throw new M1Error(code, `${message}; launcher stderr: ${stderr}`, error);
    }
    throw error;
  } finally {
    await Promise.all(
      handles.map((handle) => handle.close().catch(() => undefined)),
    );
    await rm(probeRoot, { recursive: true, force: true });
  }
};

class RealSandboxHostProbe implements SandboxHostProbePort {
  public now(): string {
    return new Date().toISOString();
  }

  public async probe(
    request: SandboxHostPreflightRequest,
  ): Promise<SandboxHostProbeEvidence> {
    if (process.platform !== "linux" || process.arch !== "x64") {
      throw new M1Error(
        "unsupported_platform",
        "M1 sandbox requires Linux x86-64",
      );
    }
    const [bwrap, prlimit, busybox] = await Promise.all([
      inspectExecutable(request.bwrapPath),
      inspectExecutable(request.prlimitPath),
      inspectExecutable(request.busyboxPath),
    ]);
    assertStaticX8664Elf(busybox.bytes);
    const [bwrapHelp, bwrapVersion] = await Promise.all([
      runHostExecutable(bwrap.canonicalPath, ["--help"]),
      runHostExecutable(bwrap.canonicalPath, ["--version"]),
      runHostExecutable(prlimit.canonicalPath, ["--version"]),
    ]);
    assertRequiredBubblewrapFeatures(bwrapHelp);
    const cgroupRoot = await CgroupV2Controller.preflight(
      request.delegatedCgroupRoot,
    );
    const binding = Object.freeze({
      delegatedCgroupRoot: cgroupRoot.canonicalPath,
      bwrapPath: bwrap.canonicalPath,
      prlimitPath: prlimit.canonicalPath,
      busyboxPath: busybox.canonicalPath,
    });
    const activeProbeSha256 = await runActiveSandboxProbe({
      binding,
      cgroupRoot,
    });
    return {
      binding,
      bwrapIdentity: bwrap.identity,
      bwrapVersion,
      prlimitIdentity: prlimit.identity,
      runtimeIdentity: busybox.identity,
      delegatedCgroupRootIdentity: cgroupRootDigest(cgroupRoot),
      cgroupNamespaceUnshared: true,
      activeProbeSha256,
    };
  }
}

export async function preflightSandboxHost(
  request: SandboxHostPreflightRequest,
  dependencies: SandboxHostProbePort = new RealSandboxHostProbe(),
  taskStorageInspection: SandboxTaskStorageInspectionPort = nodeTaskStorageInspectionPort,
): Promise<SandboxHostPreflightResult> {
  const checkedAt = dependencies.now();
  try {
    const [evidence, taskStorage] = await Promise.all([
      dependencies.probe(request),
      request.taskStorageRoot === undefined
        ? Promise.resolve(undefined)
        : inspectSandboxTaskStorageRoot(
            request.taskStorageRoot,
            taskStorageInspection,
          ),
    ]);
    const bwrapVersion = normalizeBwrapVersion(evidence.bwrapVersion);
    const capability = SandboxHostCapabilityV1Schema.parse({
      schemaVersion: 1,
      platform: "linux",
      architecture: "x64",
      bwrap: {
        identity: evidence.bwrapIdentity,
        version: bwrapVersion,
        features: REQUIRED_BWRAP_FEATURES,
      },
      prlimitIdentity: evidence.prlimitIdentity,
      runtimeIdentity: evidence.runtimeIdentity,
      delegatedCgroupRootIdentity: evidence.delegatedCgroupRootIdentity,
      controllers: ["cpu", "memory", "pids"],
      cgroupNamespaceUnshared: evidence.cgroupNamespaceUnshared,
      activeProbeSha256: evidence.activeProbeSha256,
      ...(taskStorage === undefined
        ? {}
        : { taskStorage: taskStorage.capability }),
    });
    const capabilitySha256 = jsonHash(capability as unknown as JsonValue);
    const receipt = SandboxPreflightReceiptV1Schema.parse({
      schemaVersion: 1,
      status: "supported",
      checkedAt,
      capabilitySha256,
      blockers: [],
    });
    if (receipt.status !== "supported")
      throw new Error("invalid receipt branch");
    return {
      kind: "supported",
      capability: Object.freeze(capability),
      binding: Object.freeze({
        delegatedCgroupRoot: evidence.binding.delegatedCgroupRoot,
        bwrapPath: evidence.binding.bwrapPath,
        prlimitPath: evidence.binding.prlimitPath,
        busyboxPath: evidence.binding.busyboxPath,
        ...(taskStorage === undefined ? {} : taskStorage.binding),
      }),
      receipt,
    };
  } catch (error) {
    const code =
      error instanceof M1Error ? error.code : "sandbox_preflight_failed";
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message =
      sanitizeM1Diagnostic(rawMessage, [
        request.delegatedCgroupRoot,
        request.bwrapPath,
        request.prlimitPath,
        request.busyboxPath,
        ...(request.taskStorageRoot === undefined
          ? []
          : [request.taskStorageRoot]),
      ]) || "sandbox preflight failed";
    const receipt = SandboxPreflightReceiptV1Schema.parse({
      schemaVersion: 1,
      status: "unsupported",
      checkedAt,
      capabilitySha256: null,
      blockers: [{ code, message }],
    });
    if (receipt.status !== "unsupported")
      throw new Error("invalid receipt branch");
    return { kind: "unsupported", receipt };
  }
}

export async function assertSandboxHostBindingMatches(
  capability: SandboxHostCapabilityV1,
  binding: SandboxHostBinding,
  taskStorageInspection: SandboxTaskStorageInspectionPort = nodeTaskStorageInspectionPort,
): Promise<void> {
  const [bwrap, prlimit, busybox, cgroupRoot] = await Promise.all([
    inspectExecutable(binding.bwrapPath),
    inspectExecutable(binding.prlimitPath),
    inspectExecutable(binding.busyboxPath),
    CgroupV2Controller.preflight(binding.delegatedCgroupRoot),
  ]);
  if (
    bwrap.identity !== capability.bwrap.identity ||
    prlimit.identity !== capability.prlimitIdentity ||
    busybox.identity !== capability.runtimeIdentity ||
    cgroupRootDigest(cgroupRoot) !== capability.delegatedCgroupRootIdentity
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox Host binding no longer matches the preflight capability",
    );
  }
  if (
    (capability.taskStorage === undefined) !==
    (binding.taskStorageRoot === undefined)
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox task storage capability and Host binding disagree",
    );
  }
  if (
    capability.taskStorage !== undefined &&
    binding.taskStorageRoot !== undefined
  ) {
    await assertSandboxTaskStorageBindingMatches(
      capability.taskStorage,
      binding.taskStorageRoot,
      taskStorageInspection,
    );
  }
}
