import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  TaskPatchIdentityV1Schema,
  asPatchId,
  asSha256DigestV1,
  type Sha256DigestV1,
  type TaskId,
  type TaskPatchIdentityV1,
} from "@chronorift/domain";

import {
  FixtureManifestV1Schema,
  PatchExportReceiptV1Schema,
  RelativeExportPathV1Schema,
  TaskFixtureCapabilityV1Schema,
  type PatchExportReceiptV1,
  type TaskFixtureCapabilityV1,
} from "./contracts.js";
import { M1Error, M1PatchExportError } from "./errors.js";
import { assertCandidateFixtureCompatible } from "./fixture-manifest.js";
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

const PATCH_BYTE_LIMIT = 512 * 1024 * 1024;
const CANDIDATE_ENTRY_LIMIT = 10_000;
const MANIFEST_BYTE_LIMIT = 1024 * 1024;
const FILE_CHUNK_BYTES = 64 * 1024;
const MANIFEST_PATH = "chronorift.fixture.json";
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

interface PatchGitPort extends HostGitPort {
  streamCachedBinaryDiff(input: {
    readonly context: HostGitRepositoryContext;
    readonly baselineCommit: string;
    readonly destination: FileHandle;
    readonly maxBytes: number;
  }): Promise<{
    readonly byteLength: number;
    readonly sha256: Sha256DigestV1;
  }>;
  applyPatch(input: {
    readonly context: HostGitRepositoryContext;
    readonly patch: FileHandle;
    readonly checkOnly: boolean;
  }): Promise<void>;
}

export interface ExtractedTaskPatch {
  readonly identity: TaskPatchIdentityV1;
  readonly patchBytes: Uint8Array;
  readonly roundTripVerified: true;
}

export interface ExtractTaskPatchRequest {
  readonly taskId: TaskId;
  readonly workspaceDirectory: string;
  readonly hostBaselineGitDirectory: string;
  readonly hostBaselineCommit: string;
  readonly baselineSourceHash: Sha256DigestV1;
  readonly ignoredCachePaths: readonly string[];
  readonly fixtureCapability: TaskFixtureCapabilityV1;
  readonly hostOperationTemporaryDirectory: string;
}

interface ExtractionDependencies {
  readonly git?: PatchGitPort | undefined;
}

interface Fingerprint {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface CandidateEntry extends HostGitIndexEntry {
  readonly byteLength: number;
  readonly contentSha256: Sha256DigestV1;
  readonly fingerprint: Fingerprint;
}

interface TreeWalkFile {
  readonly relativePath: string;
  readonly mode: "100644" | "100755";
  readonly byteLength: number;
  readonly fingerprint: Fingerprint;
  readonly handle: FileHandle;
}

interface OpenedDirectory {
  readonly canonicalPath: string;
  readonly handle: FileHandle;
  readonly fingerprint: Fingerprint;
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const fingerprint = (statistics: Stats): Fingerprint => ({
  dev: statistics.dev,
  ino: statistics.ino,
  mode: statistics.mode,
  size: statistics.size,
  mtimeMs: statistics.mtimeMs,
  ctimeMs: statistics.ctimeMs,
});

const sameFingerprint = (left: Fingerprint, right: Fingerprint): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const assertRegularFingerprint = (
  expected: Fingerprint,
  statistics: Stats,
  message: string,
): void => {
  if (
    !statistics.isFile() ||
    !sameFingerprint(expected, fingerprint(statistics))
  ) {
    throw new M1Error("artifact_write_failed", message);
  }
};

const assertDirectoryFingerprint = (
  expected: Fingerprint,
  statistics: Stats,
  message: string,
): void => {
  if (
    !statistics.isDirectory() ||
    !sameFingerprint(expected, fingerprint(statistics))
  ) {
    throw new M1Error("artifact_write_failed", message);
  }
};

const pathWithinOrEqual = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
};

const openCanonicalDirectory = async (
  path: string,
  label: string,
): Promise<OpenedDirectory> => {
  const absolutePath = resolve(path);
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new M1Error(
      "artifact_write_failed",
      `${label} must be a real directory`,
    );
  }
  const canonicalPath = await realpath(absolutePath);
  if (canonicalPath !== absolutePath) {
    throw new M1Error(
      "artifact_write_failed",
      `${label} must already be canonical and contain no symbolic link`,
    );
  }
  const handle = await open(
    canonicalPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino
    ) {
      throw new M1Error(
        "artifact_write_failed",
        `${label} changed while it was opened`,
      );
    }
    return { canonicalPath, handle, fingerprint: fingerprint(opened) };
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const assertDirectoryStillBound = async (
  opened: OpenedDirectory,
  label: string,
): Promise<void> => {
  const [fromHandle, fromPath] = await Promise.all([
    opened.handle.stat(),
    lstat(opened.canonicalPath),
  ]);
  if (
    !fromHandle.isDirectory() ||
    fromHandle.dev !== opened.fingerprint.dev ||
    fromHandle.ino !== opened.fingerprint.ino
  ) {
    throw new M1Error("artifact_write_failed", `${label} identity changed`);
  }
  if (
    !fromPath.isDirectory() ||
    fromPath.dev !== opened.fingerprint.dev ||
    fromPath.ino !== opened.fingerprint.ino
  ) {
    throw new M1Error("artifact_write_failed", `${label} path was replaced`);
  }
  if ((await realpath(opened.canonicalPath)) !== opened.canonicalPath) {
    throw new M1Error("artifact_write_failed", `${label} path was replaced`);
  }
};

const assertSafeRelativePath = (value: string): void => {
  const encoded = Buffer.from(value, "utf8");
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    encoded.byteLength > 4096
  ) {
    throw new M1Error(
      "artifact_write_failed",
      "candidate contains an unsafe source path",
    );
  }
  if (
    value
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          Buffer.byteLength(segment, "utf8") > 255,
      )
  ) {
    throw new M1Error(
      "artifact_write_failed",
      "candidate contains an unsafe source path",
    );
  }
  if (encoded.toString("utf8") !== value) {
    throw new M1Error(
      "artifact_write_failed",
      "candidate source paths must be valid UTF-8",
    );
  }
};

const decodeFileName = (bytes: Buffer): string => {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (Buffer.from(value, "utf8").compare(bytes) !== 0) throw new Error();
    return value;
  } catch (error) {
    throw new M1Error(
      "artifact_write_failed",
      "candidate source paths must be valid UTF-8",
      error,
    );
  }
};

const validateIgnoredRoots = (values: readonly string[]): readonly string[] => {
  const result = [...values];
  for (const value of result) {
    assertSafeRelativePath(value);
    if (value.split("/").includes(".git")) {
      throw new M1Error(
        "source_configuration_mismatch",
        "ignored cache paths must not overlap Git metadata",
      );
    }
  }
  result.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  for (let index = 1; index < result.length; index += 1) {
    if (result[index] === result[index - 1]) {
      throw new M1Error(
        "source_configuration_mismatch",
        "ignored cache paths must be unique",
      );
    }
  }
  return result;
};

const isPrunedPath = (
  relativePath: string,
  ignoredRoots: readonly string[],
): boolean =>
  relativePath === ".git" ||
  ignoredRoots.some(
    (root) => relativePath === root || relativePath.startsWith(`${root}/`),
  );

const fdChildPath = (directory: FileHandle, name: string): string =>
  `/proc/self/fd/${directory.fd}/${name}`;

const walkTree = async (
  root: FileHandle,
  ignoredRoots: readonly string[],
  visit: (file: TreeWalkFile) => void | Promise<void>,
): Promise<void> => {
  const bytePaths = new Set<string>();
  const foldedPaths = new Set<string>();

  const registerPath = (relativePath: string): void => {
    assertSafeRelativePath(relativePath);
    if (bytePaths.size >= CANDIDATE_ENTRY_LIMIT) {
      throw new M1Error(
        "artifact_write_failed",
        "candidate source exceeds the bounded M1 path profile",
      );
    }
    const byteKey = Buffer.from(relativePath, "utf8").toString("hex");
    const foldedKey = relativePath.normalize("NFC").toLocaleLowerCase("en-US");
    if (bytePaths.has(byteKey) || foldedPaths.has(foldedKey)) {
      throw new M1Error(
        "artifact_write_failed",
        "candidate contains duplicate or case-colliding source paths",
      );
    }
    bytePaths.add(byteKey);
    foldedPaths.add(foldedKey);
  };

  const walkDirectory = async (
    directory: FileHandle,
    relativeDirectory: string,
  ): Promise<void> => {
    const directoryBefore = fingerprint(await directory.stat());
    const rawNames = (await readdir(`/proc/self/fd/${directory.fd}`, {
      encoding: "buffer",
    })) as Buffer[];
    rawNames.sort((left, right) => Buffer.compare(left, right));

    for (const rawName of rawNames) {
      const name = decodeFileName(rawName);
      const relativePath =
        relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
      registerPath(relativePath);
      if (isPrunedPath(relativePath, ignoredRoots)) continue;
      if (relativePath.split("/").includes(".git")) {
        throw new M1Error(
          "artifact_write_failed",
          "nested Git metadata is not candidate source",
        );
      }

      const path = fdChildPath(directory, name);
      const before = await lstat(path);
      if (before.isSymbolicLink()) {
        throw new M1Error(
          "artifact_write_failed",
          "candidate source must not contain symbolic links",
        );
      }
      if (before.isDirectory()) {
        const child = await open(
          path,
          constants.O_RDONLY |
            constants.O_DIRECTORY |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
        );
        try {
          const opened = await child.stat();
          if (
            !opened.isDirectory() ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino
          ) {
            throw new M1Error(
              "artifact_write_failed",
              "candidate directory changed while being opened",
            );
          }
          const childIdentity = fingerprint(opened);
          await walkDirectory(child, relativePath);
          assertDirectoryFingerprint(
            childIdentity,
            await child.stat(),
            "candidate directory changed during snapshot",
          );
        } finally {
          await child.close();
        }
        continue;
      }
      if (!before.isFile()) {
        throw new M1Error(
          "artifact_write_failed",
          "candidate source must contain only regular files and directories",
        );
      }

      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino
        ) {
          throw new M1Error(
            "artifact_write_failed",
            "candidate file changed while being opened",
          );
        }
        const fileIdentity = fingerprint(opened);
        await visit({
          relativePath,
          mode: (opened.mode & 0o111) === 0 ? "100644" : "100755",
          byteLength: opened.size,
          fingerprint: fileIdentity,
          handle,
        });
        assertRegularFingerprint(
          fileIdentity,
          await handle.stat(),
          "candidate file changed during snapshot",
        );
      } finally {
        await handle.close();
      }
    }
    assertDirectoryFingerprint(
      directoryBefore,
      await directory.stat(),
      "candidate directory changed during snapshot",
    );
  };

  await walkDirectory(root, "");
};

const readAndHashFile = async (
  handle: FileHandle,
  captureBytes: boolean,
  maximumCapturedBytes = Number.MAX_SAFE_INTEGER,
  maximumReadBytes = Number.MAX_SAFE_INTEGER,
): Promise<{
  readonly sha256: Sha256DigestV1;
  readonly byteLength: number;
  readonly bytes?: Buffer | undefined;
}> => {
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(FILE_CHUNK_BYTES);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.byteLength,
      position,
    );
    if (bytesRead === 0) break;
    const chunk = Buffer.from(buffer.subarray(0, bytesRead));
    hash.update(chunk);
    position += bytesRead;
    if (position > maximumReadBytes) {
      throw new M1Error(
        "artifact_write_failed",
        "file exceeds the bounded read limit",
      );
    }
    if (captureBytes) {
      if (position > maximumCapturedBytes) {
        throw new M1Error(
          "artifact_write_failed",
          "file exceeds the bounded capture limit",
        );
      }
      chunks.push(chunk);
    }
  }
  return {
    sha256: asSha256DigestV1(hash.digest("hex")),
    byteLength: position,
    ...(captureBytes ? { bytes: Buffer.concat(chunks, position) } : {}),
  };
};

const collectCandidate = async (
  root: OpenedDirectory,
  ignoredRoots: readonly string[],
  git: PatchGitPort,
  gitContext: HostGitRepositoryContext,
): Promise<{
  readonly entries: readonly CandidateEntry[];
  readonly manifestBytes: Buffer;
}> => {
  const entries: CandidateEntry[] = [];
  let manifestBytes: Buffer | undefined;
  let candidateBytes = 0;
  await walkTree(root.handle, ignoredRoots, async (file) => {
    candidateBytes += file.byteLength;
    if (
      !Number.isSafeInteger(candidateBytes) ||
      candidateBytes > PATCH_BYTE_LIMIT
    ) {
      throw new M1Error(
        "artifact_write_failed",
        "candidate source exceeds the bounded M1 patch profile",
      );
    }
    if (
      file.relativePath === MANIFEST_PATH &&
      file.byteLength > MANIFEST_BYTE_LIMIT
    ) {
      throw new M1Error(
        "source_configuration_mismatch",
        "candidate fixture manifest exceeds the supported size",
      );
    }
    const objectId = await git.hashBlob({
      context: gitContext,
      source: file.handle,
    });
    const content = await readAndHashFile(
      file.handle,
      file.relativePath === MANIFEST_PATH,
      MANIFEST_BYTE_LIMIT,
      file.relativePath === MANIFEST_PATH
        ? MANIFEST_BYTE_LIMIT
        : Number.MAX_SAFE_INTEGER,
    );
    if (content.byteLength !== file.byteLength) {
      throw new M1Error(
        "artifact_write_failed",
        "candidate file length changed during snapshot",
      );
    }
    if (file.relativePath === MANIFEST_PATH) manifestBytes = content.bytes;
    entries.push({
      relativePath: file.relativePath,
      mode: file.mode,
      byteLength: file.byteLength,
      fingerprint: file.fingerprint,
      contentSha256: content.sha256,
      objectId,
    });
  });
  if (manifestBytes === undefined) {
    throw new M1Error(
      "source_configuration_mismatch",
      "candidate fixture manifest is missing",
    );
  }
  entries.sort((left, right) =>
    Buffer.from(left.relativePath).compare(Buffer.from(right.relativePath)),
  );
  return { entries, manifestBytes };
};

const openRelativeFile = async (
  root: FileHandle,
  relativePath: string,
): Promise<FileHandle> => {
  assertSafeRelativePath(relativePath);
  const segments = relativePath.split("/");
  let directory = root;
  let ownedDirectory: FileHandle | undefined;
  try {
    for (const segment of segments.slice(0, -1)) {
      const child = await open(
        fdChildPath(directory, segment),
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
      if (ownedDirectory !== undefined) await ownedDirectory.close();
      ownedDirectory = child;
      directory = child;
    }
    const finalName = segments.at(-1);
    if (finalName === undefined) throw new Error("relative path is empty");
    return await open(
      fdChildPath(directory, finalName),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } finally {
    if (ownedDirectory !== undefined) await ownedDirectory.close();
  }
};

const candidateSources = (
  root: FileHandle,
  entries: readonly CandidateEntry[],
): readonly SelectedTreeContentSourceV1[] =>
  entries.map((entry) => ({
    relativePath: entry.relativePath,
    mode: entry.mode,
    byteLength: entry.byteLength,
    async *chunks(): AsyncIterable<Uint8Array> {
      const handle = await openRelativeFile(root, entry.relativePath);
      try {
        assertRegularFingerprint(
          entry.fingerprint,
          await handle.stat(),
          "candidate file changed between snapshot passes",
        );
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(FILE_CHUNK_BYTES);
        let position = 0;
        while (true) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.byteLength,
            position,
          );
          if (bytesRead === 0) break;
          const chunk = Buffer.from(buffer.subarray(0, bytesRead));
          hash.update(chunk);
          position += bytesRead;
          yield chunk;
        }
        if (
          position !== entry.byteLength ||
          hash.digest("hex") !== entry.contentSha256
        ) {
          throw new M1Error(
            "artifact_write_failed",
            "candidate file changed between snapshot passes",
          );
        }
        assertRegularFingerprint(
          entry.fingerprint,
          await handle.stat(),
          "candidate file changed between snapshot passes",
        );
      } finally {
        await handle.close();
      }
    },
  }));

const collectMetadata = async (
  root: FileHandle,
  ignoredRoots: readonly string[],
): Promise<readonly Omit<CandidateEntry, "objectId" | "contentSha256">[]> => {
  const result: Omit<CandidateEntry, "objectId" | "contentSha256">[] = [];
  await walkTree(root, ignoredRoots, (file) => {
    result.push({
      relativePath: file.relativePath,
      mode: file.mode,
      byteLength: file.byteLength,
      fingerprint: file.fingerprint,
    });
  });
  return result.sort((left, right) =>
    Buffer.from(left.relativePath).compare(Buffer.from(right.relativePath)),
  );
};

const assertMetadataMatches = (
  expected: readonly CandidateEntry[],
  actual: readonly Omit<CandidateEntry, "objectId" | "contentSha256">[],
): void => {
  if (expected.length !== actual.length) {
    throw new M1Error(
      "artifact_write_failed",
      "candidate source membership changed during snapshot",
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (
      left === undefined ||
      right === undefined ||
      left.relativePath !== right.relativePath ||
      left.mode !== right.mode ||
      left.byteLength !== right.byteLength ||
      !sameFingerprint(left.fingerprint, right.fingerprint)
    ) {
      throw new M1Error(
        "artifact_write_failed",
        "candidate source membership changed during snapshot",
      );
    }
  }
};

interface BaselineTreeEntry {
  readonly relativePath: string;
  readonly mode: "100644" | "100755";
  readonly objectId: string;
  readonly byteLength: number;
}

const parseBaselineTree = (bytes: Uint8Array): readonly BaselineTreeEntry[] => {
  const entries: BaselineTreeEntry[] = [];
  for (const record of Buffer.from(bytes).toString("utf8").split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) {
      throw new M1Error(
        "artifact_write_failed",
        "Host baseline tree is corrupt",
      );
    }
    const header =
      /^(?<mode>\d{6}) (?<type>\S+) (?<object>[a-f0-9]+) +(?<size>\d+)$/u.exec(
        record.slice(0, tab),
      );
    const relativePath = record.slice(tab + 1);
    if (
      header?.groups === undefined ||
      header.groups.type !== "blob" ||
      (header.groups.mode !== "100644" && header.groups.mode !== "100755") ||
      !GIT_OBJECT_ID.test(header.groups.object ?? "")
    ) {
      throw new M1Error(
        "artifact_write_failed",
        "Host baseline contains an unsupported tree entry",
      );
    }
    assertSafeRelativePath(relativePath);
    if (relativePath.split("/").includes(".git")) {
      throw new M1Error(
        "artifact_write_failed",
        "Host baseline contains forbidden Git metadata",
      );
    }
    const objectId = header.groups.object;
    if (objectId === undefined) {
      throw new M1Error(
        "artifact_write_failed",
        "Host baseline tree is corrupt",
      );
    }
    const byteLength = Number(header.groups.size);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new M1Error(
        "artifact_write_failed",
        "Host baseline tree is corrupt",
      );
    }
    entries.push({
      relativePath,
      mode: header.groups.mode,
      objectId,
      byteLength,
    });
  }
  entries.sort((left, right) =>
    Buffer.from(left.relativePath).compare(Buffer.from(right.relativePath)),
  );
  return entries;
};

const createUniqueName = (prefix: string, suffix = ""): string =>
  `${prefix}-${randomBytes(16).toString("hex")}${suffix}`;

const materializeBaseline = async (
  git: PatchGitPort,
  baselineContext: HostGitRepositoryContext,
  commit: string,
  directory: string,
): Promise<void> => {
  const entries = parseBaselineTree(
    await git.listTree({ context: baselineContext, treeish: commit }),
  );
  for (const entry of entries) {
    const destinationPath = join(directory, ...entry.relativePath.split("/"));
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    const destination = await open(
      destinationPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const streamed = await git.streamBlob({
        cwd: baselineContext.cwd,
        objectId: entry.objectId,
        destination,
        ...(baselineContext.gitDirectory === undefined
          ? {}
          : { gitDirectory: baselineContext.gitDirectory }),
        ...(baselineContext.workTree === undefined
          ? {}
          : { workTree: baselineContext.workTree }),
      });
      if (streamed.byteLength !== entry.byteLength) {
        throw new M1Error(
          "artifact_write_failed",
          "Host baseline blob length does not match its tree",
        );
      }
      await destination.sync();
    } finally {
      await destination.close();
    }
    await chmod(destinationPath, entry.mode === "100755" ? 0o755 : 0o644);
  }
};

const hashDirectoryTree = async (
  directory: OpenedDirectory,
): Promise<Sha256DigestV1> => {
  const entries: Array<{
    readonly relativePath: string;
    readonly mode: "100644" | "100755";
    readonly byteLength: number;
    readonly fingerprint: Fingerprint;
  }> = [];
  await walkTree(directory.handle, [], (file) => {
    entries.push({
      relativePath: file.relativePath,
      mode: file.mode,
      byteLength: file.byteLength,
      fingerprint: file.fingerprint,
    });
  });
  const sources = entries.map((entry): SelectedTreeContentSourceV1 => ({
    relativePath: entry.relativePath,
    mode: entry.mode,
    byteLength: entry.byteLength,
    async *chunks(): AsyncIterable<Uint8Array> {
      const handle = await openRelativeFile(
        directory.handle,
        entry.relativePath,
      );
      try {
        assertRegularFingerprint(
          entry.fingerprint,
          await handle.stat(),
          "verification tree changed while being hashed",
        );
        const buffer = Buffer.allocUnsafe(FILE_CHUNK_BYTES);
        let position = 0;
        while (true) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.byteLength,
            position,
          );
          if (bytesRead === 0) break;
          position += bytesRead;
          yield Buffer.from(buffer.subarray(0, bytesRead));
        }
      } finally {
        await handle.close();
      }
    },
  }));
  return selectedTreeSha256FromSources(sources);
};

const removeCreatedDirectory = async (
  path: string,
  expected: Fingerprint | undefined,
): Promise<void> => {
  if (expected === undefined) return;
  try {
    const current = await lstat(path);
    if (
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev === expected.dev &&
      current.ino === expected.ino
    ) {
      await rm(path, { recursive: true, force: false });
    }
  } catch {
    // Cleanup must never broaden beyond the create-new directory identity.
  }
};

const verifyRoundTrip = async (input: {
  readonly git: PatchGitPort;
  readonly baselineContext: HostGitRepositoryContext;
  readonly baselineCommit: string;
  readonly baselineSourceHash: Sha256DigestV1;
  readonly candidateSourceHash: Sha256DigestV1;
  readonly patch: FileHandle;
  readonly hostTemporaryDirectory: OpenedDirectory;
}): Promise<void> => {
  const verificationName = createUniqueName("verify");
  const verificationPath = join(
    input.hostTemporaryDirectory.canonicalPath,
    verificationName,
  );
  let verificationIdentity: Fingerprint | undefined;
  let verification: OpenedDirectory | undefined;
  try {
    await mkdir(verificationPath, { mode: 0o700 });
    verificationIdentity = fingerprint(await lstat(verificationPath));
    await materializeBaseline(
      input.git,
      input.baselineContext,
      input.baselineCommit,
      verificationPath,
    );
    verification = await openCanonicalDirectory(
      verificationPath,
      "patch verification directory",
    );
    if ((await hashDirectoryTree(verification)) !== input.baselineSourceHash) {
      throw new M1Error(
        "artifact_write_failed",
        "Host baseline tree does not match the recorded baseline source",
      );
    }
    const verificationContext: HostGitRepositoryContext = {
      cwd: verificationPath,
      gitDirectory: input.baselineContext.gitDirectory,
      workTree: verificationPath,
    };
    await input.git.applyPatch({
      context: verificationContext,
      patch: input.patch,
      checkOnly: true,
    });
    await input.git.applyPatch({
      context: verificationContext,
      patch: input.patch,
      checkOnly: false,
    });
    if ((await hashDirectoryTree(verification)) !== input.candidateSourceHash) {
      throw new M1Error(
        "artifact_write_failed",
        "patch round-trip does not reproduce the candidate source",
      );
    }
  } finally {
    if (verification !== undefined) await verification.handle.close();
    await removeCreatedDirectory(verificationPath, verificationIdentity);
  }
};

export async function extractTaskPatch(
  request: ExtractTaskPatchRequest,
  dependencies: ExtractionDependencies = {},
): Promise<ExtractedTaskPatch> {
  const git = dependencies.git ?? new NodeHostGitPort();
  if (!GIT_OBJECT_ID.test(request.hostBaselineCommit)) {
    throw new M1Error(
      "artifact_write_failed",
      "Host baseline commit identity is invalid",
    );
  }
  const parsedFixtureCapability = TaskFixtureCapabilityV1Schema.safeParse(
    request.fixtureCapability,
  );
  if (!parsedFixtureCapability.success) {
    throw new M1Error(
      "source_configuration_mismatch",
      "frozen task fixture capability is invalid",
      parsedFixtureCapability.error,
    );
  }
  const fixtureCapability = parsedFixtureCapability.data;
  const ignoredRoots = validateIgnoredRoots(request.ignoredCachePaths);
  if (
    ignoredRoots.length !== fixtureCapability.ignoredCachePaths.length ||
    ignoredRoots.some(
      (value, index) => value !== fixtureCapability.ignoredCachePaths[index],
    )
  ) {
    throw new M1Error(
      "source_configuration_mismatch",
      "ignored cache paths do not match the frozen fixture capability",
    );
  }

  const opened: OpenedDirectory[] = [];
  let indexPath: string | undefined;
  let patchPath: string | undefined;
  let indexHandle: FileHandle | undefined;
  let patchHandle: FileHandle | undefined;
  try {
    const workspace = await openCanonicalDirectory(
      request.workspaceDirectory,
      "candidate workspace",
    );
    opened.push(workspace);
    const baseline = await openCanonicalDirectory(
      request.hostBaselineGitDirectory,
      "Host baseline Git directory",
    );
    opened.push(baseline);
    const hostTemporary = await openCanonicalDirectory(
      request.hostOperationTemporaryDirectory,
      "Host operation temporary directory",
    );
    opened.push(hostTemporary);
    if (
      pathWithinOrEqual(workspace.canonicalPath, baseline.canonicalPath) ||
      pathWithinOrEqual(baseline.canonicalPath, workspace.canonicalPath) ||
      pathWithinOrEqual(workspace.canonicalPath, hostTemporary.canonicalPath) ||
      pathWithinOrEqual(hostTemporary.canonicalPath, workspace.canonicalPath) ||
      pathWithinOrEqual(baseline.canonicalPath, hostTemporary.canonicalPath) ||
      pathWithinOrEqual(hostTemporary.canonicalPath, baseline.canonicalPath)
    ) {
      throw new M1Error(
        "artifact_write_failed",
        "workspace, Host baseline, and Host temporary roots must be separate",
      );
    }

    indexPath = join(hostTemporary.canonicalPath, createUniqueName("index"));
    indexHandle = await open(
      indexPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await indexHandle.close();
    indexHandle = undefined;

    const baselineContext: HostGitRepositoryContext = {
      cwd: hostTemporary.canonicalPath,
      gitDirectory: baseline.canonicalPath,
    };
    const candidateContext: HostGitRepositoryContext = {
      ...baselineContext,
      indexFile: indexPath,
    };
    await git.readTreeEmpty(candidateContext);
    const candidate = await collectCandidate(
      workspace,
      ignoredRoots,
      git,
      candidateContext,
    );
    let manifest: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        candidate.manifestBytes,
      );
      manifest = JSON.parse(text) as unknown;
    } catch (error) {
      throw new M1Error(
        "source_configuration_mismatch",
        "candidate fixture manifest is not valid UTF-8 JSON",
        error,
      );
    }
    const parsedManifest = FixtureManifestV1Schema.safeParse(manifest);
    if (!parsedManifest.success) {
      throw new M1Error(
        "source_configuration_mismatch",
        "candidate fixture manifest does not match the frozen task capability",
        parsedManifest.error,
      );
    }
    assertCandidateFixtureCompatible(parsedManifest.data, fixtureCapability);
    await git.updateIndex({
      context: candidateContext,
      entries: candidate.entries,
    });
    assertMetadataMatches(
      candidate.entries,
      await collectMetadata(workspace.handle, ignoredRoots),
    );
    const candidateSourceHash = await selectedTreeSha256FromSources(
      candidateSources(workspace.handle, candidate.entries),
    );
    assertMetadataMatches(
      candidate.entries,
      await collectMetadata(workspace.handle, ignoredRoots),
    );
    await git.writeTree(candidateContext);

    patchPath = join(
      hostTemporary.canonicalPath,
      createUniqueName("patch", ".diff"),
    );
    patchHandle = await open(
      patchPath,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const patchReceipt = await git.streamCachedBinaryDiff({
      context: candidateContext,
      baselineCommit: request.hostBaselineCommit,
      destination: patchHandle,
      maxBytes: PATCH_BYTE_LIMIT,
    });
    if (
      !Number.isSafeInteger(patchReceipt.byteLength) ||
      patchReceipt.byteLength < 0 ||
      patchReceipt.byteLength > PATCH_BYTE_LIMIT
    ) {
      throw new M1Error(
        "artifact_write_failed",
        "generated patch exceeds the supported size",
      );
    }
    await patchHandle.sync();
    const patchStatistics = await patchHandle.stat();
    if (
      !patchStatistics.isFile() ||
      patchStatistics.size !== patchReceipt.byteLength
    ) {
      throw new M1Error(
        "artifact_write_failed",
        "generated patch file does not match its stream receipt",
      );
    }
    await verifyRoundTrip({
      git,
      baselineContext,
      baselineCommit: request.hostBaselineCommit,
      baselineSourceHash: request.baselineSourceHash,
      candidateSourceHash,
      patch: patchHandle,
      hostTemporaryDirectory: hostTemporary,
    });
    const patchReadback = await readAndHashFile(
      patchHandle,
      true,
      PATCH_BYTE_LIMIT,
      PATCH_BYTE_LIMIT,
    );
    const patchBytes = patchReadback.bytes;
    if (patchBytes === undefined) {
      throw new M1Error(
        "artifact_write_failed",
        "generated patch could not be read back",
      );
    }
    if (
      patchReadback.byteLength !== patchReceipt.byteLength ||
      patchReadback.sha256 !== patchReceipt.sha256
    ) {
      throw new M1Error(
        "artifact_write_failed",
        "generated patch bytes changed after round-trip verification",
      );
    }
    const identity = TaskPatchIdentityV1Schema.parse({
      schemaVersion: 1,
      patchId: asPatchId(`patch:v1:${patchReceipt.sha256}`),
      taskId: request.taskId,
      baselineSourceHash: request.baselineSourceHash,
      candidateSourceHash,
      patchHash: patchReceipt.sha256,
      byteLength: patchReceipt.byteLength,
    });
    await Promise.all([
      assertDirectoryStillBound(workspace, "candidate workspace"),
      assertDirectoryStillBound(baseline, "Host baseline Git directory"),
      assertDirectoryStillBound(
        hostTemporary,
        "Host operation temporary directory",
      ),
    ]);
    return { identity, patchBytes, roundTripVerified: true };
  } catch (error) {
    if (error instanceof M1Error) throw error;
    throw new M1Error(
      "artifact_write_failed",
      "candidate patch extraction failed",
      error,
    );
  } finally {
    if (indexHandle !== undefined)
      await indexHandle.close().catch(() => undefined);
    if (patchHandle !== undefined)
      await patchHandle.close().catch(() => undefined);
    if (indexPath !== undefined) await unlink(indexPath).catch(() => undefined);
    if (patchPath !== undefined) await unlink(patchPath).catch(() => undefined);
    for (const directory of opened.reverse()) {
      await directory.handle.close().catch(() => undefined);
    }
  }
}

const hashOpenFile = async (
  handle: FileHandle,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): Promise<{ readonly byteLength: number; readonly sha256: string }> => {
  const result = await readAndHashFile(
    handle,
    false,
    Number.MAX_SAFE_INTEGER,
    maximumBytes,
  );
  return { byteLength: result.byteLength, sha256: result.sha256 };
};

const inspectPublishedTarget = async (
  parent: FileHandle,
  targetName: string,
  extracted: ExtractedTaskPatch,
): Promise<boolean> => {
  let handle: FileHandle | undefined;
  try {
    const targetPath = fdChildPath(parent, targetName);
    const pathBefore = await lstat(targetPath);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) return false;
    handle = await open(
      targetPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== pathBefore.dev ||
      opened.ino !== pathBefore.ino
    ) {
      return false;
    }
    if (opened.size !== extracted.identity.byteLength) return false;
    const expected = fingerprint(opened);
    const actual = await hashOpenFile(handle, extracted.identity.byteLength);
    const [handleAfter, pathAfter] = await Promise.all([
      handle.stat(),
      lstat(targetPath),
    ]);
    return (
      pathAfter.isFile() &&
      !pathAfter.isSymbolicLink() &&
      sameFingerprint(expected, fingerprint(handleAfter)) &&
      sameFingerprint(expected, fingerprint(pathAfter)) &&
      actual.byteLength === extracted.identity.byteLength &&
      actual.sha256 === extracted.identity.patchHash
    );
  } catch {
    return false;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
};

const openExportParent = async (
  canonicalCwd: string,
  expectedCwdIdentity: Fingerprint,
  outputPath: string,
): Promise<OpenedDirectory> => {
  const parentRelative = dirname(outputPath);
  const segments = parentRelative === "." ? [] : parentRelative.split("/");
  const expectedPath = join(canonicalCwd, ...segments);
  if (!pathWithinOrEqual(canonicalCwd, expectedPath)) {
    throw new M1PatchExportError(
      "patch_export_failed",
      "patch export parent escapes the Host working directory",
      outputPath,
      false,
    );
  }
  let current: FileHandle | undefined;
  try {
    current = await open(
      canonicalCwd,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const openedCwd = await current.stat();
    if (
      !openedCwd.isDirectory() ||
      openedCwd.dev !== expectedCwdIdentity.dev ||
      openedCwd.ino !== expectedCwdIdentity.ino
    ) {
      throw new M1PatchExportError(
        "patch_export_failed",
        "Host working directory changed while being opened",
        outputPath,
        false,
      );
    }
    for (const segment of segments) {
      const childPath = fdChildPath(current, segment);
      const pathMetadata = await lstat(childPath);
      if (pathMetadata.isSymbolicLink() || !pathMetadata.isDirectory()) {
        throw new M1PatchExportError(
          "patch_export_failed",
          "patch export parent must contain only real directories",
          outputPath,
          false,
        );
      }
      const child = await open(
        childPath,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
      try {
        const opened = await child.stat();
        if (
          !opened.isDirectory() ||
          opened.dev !== pathMetadata.dev ||
          opened.ino !== pathMetadata.ino
        ) {
          throw new M1PatchExportError(
            "patch_export_failed",
            "patch export parent changed while being opened",
            outputPath,
            false,
          );
        }
      } catch (error) {
        await child.close().catch(() => undefined);
        throw error;
      }
      const previous = current;
      current = child;
      await previous.close();
    }
    const opened = await current.stat();
    const pathMetadata = await lstat(expectedPath);
    const cwdPathMetadata = await lstat(canonicalCwd);
    if (
      !opened.isDirectory() ||
      !cwdPathMetadata.isDirectory() ||
      cwdPathMetadata.isSymbolicLink() ||
      cwdPathMetadata.dev !== expectedCwdIdentity.dev ||
      cwdPathMetadata.ino !== expectedCwdIdentity.ino ||
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isDirectory() ||
      opened.dev !== pathMetadata.dev ||
      opened.ino !== pathMetadata.ino ||
      (await realpath(`/proc/self/fd/${current.fd}`)) !== expectedPath ||
      (await realpath(expectedPath)) !== expectedPath
    ) {
      throw new M1PatchExportError(
        "patch_export_failed",
        "patch export parent changed while being opened",
        outputPath,
        false,
      );
    }
    const result: OpenedDirectory = {
      canonicalPath: expectedPath,
      handle: current,
      fingerprint: fingerprint(opened),
    };
    current = undefined;
    return result;
  } finally {
    if (current !== undefined) await current.close().catch(() => undefined);
  }
};

export async function exportTaskPatch(request: {
  readonly taskId: TaskId;
  readonly hostCwd: string;
  readonly outputPath: string;
  readonly extracted: ExtractedTaskPatch;
  readonly now: () => string;
  readonly onPublished?:
    ((receipt: PatchExportReceiptV1) => void | Promise<void>) | undefined;
}): Promise<PatchExportReceiptV1> {
  let parent: FileHandle | undefined;
  let temporaryName: string | undefined;
  let linkAttempted = false;
  try {
    const outputPath = RelativeExportPathV1Schema.parse(request.outputPath);
    const parsedIdentity = TaskPatchIdentityV1Schema.safeParse(
      request.extracted.identity,
    );
    if (!parsedIdentity.success) {
      throw new M1PatchExportError(
        "artifact_write_failed",
        "patch identity is invalid",
        request.outputPath,
        false,
        parsedIdentity.error,
      );
    }
    const identity = parsedIdentity.data;
    if (
      request.extracted.roundTripVerified !== true ||
      identity.taskId !== request.taskId
    ) {
      throw new M1PatchExportError(
        "artifact_write_failed",
        "patch does not belong to the requested Task",
        request.outputPath,
        false,
      );
    }
    const patchHash = createHash("sha256")
      .update(request.extracted.patchBytes)
      .digest("hex");
    if (
      request.extracted.patchBytes.byteLength !== identity.byteLength ||
      patchHash !== identity.patchHash
    ) {
      throw new M1PatchExportError(
        "artifact_write_failed",
        "patch bytes do not match the extracted patch identity",
        request.outputPath,
        false,
      );
    }

    const canonicalCwd = await realpath(resolve(request.hostCwd));
    const cwdMetadata = await lstat(canonicalCwd);
    if (!cwdMetadata.isDirectory() || cwdMetadata.isSymbolicLink()) {
      throw new M1PatchExportError(
        "patch_export_failed",
        "Host working directory is unavailable",
        outputPath,
        false,
      );
    }
    const cwdIdentity = fingerprint(cwdMetadata);
    const openedParent = await openExportParent(
      canonicalCwd,
      cwdIdentity,
      outputPath,
    );
    parent = openedParent.handle;
    const parentPath = openedParent.canonicalPath;
    const parentDevice = openedParent.fingerprint.dev;
    const parentInode = openedParent.fingerprint.ino;
    const targetName = basename(outputPath);
    const targetPath = fdChildPath(parent, targetName);
    try {
      await lstat(targetPath);
      throw new M1PatchExportError(
        "patch_export_failed",
        "patch export target already exists",
        outputPath,
        false,
      );
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }

    temporaryName = createUniqueName(`.${targetName}.chronorift`);
    const temporaryPath = fdChildPath(parent, temporaryName);
    const temporary = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      let position = 0;
      const bytes = Buffer.from(request.extracted.patchBytes);
      while (position < bytes.byteLength) {
        const result = await temporary.write(
          bytes,
          position,
          bytes.byteLength - position,
          position,
        );
        if (result.bytesWritten === 0) {
          throw new Error("patch export made no write progress");
        }
        position += result.bytesWritten;
      }
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    const temporaryRead = await open(
      temporaryPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const temporaryHash = await hashOpenFile(
        temporaryRead,
        identity.byteLength,
      );
      if (
        temporaryHash.byteLength !== identity.byteLength ||
        temporaryHash.sha256 !== identity.patchHash
      ) {
        throw new M1PatchExportError(
          "artifact_write_failed",
          "temporary patch export failed integrity verification",
          outputPath,
          false,
        );
      }
    } finally {
      await temporaryRead.close();
    }

    linkAttempted = true;
    await link(temporaryPath, targetPath);
    await parent.sync();
    await unlink(temporaryPath);
    temporaryName = undefined;
    const exportedAt = request.now();
    const receipt = PatchExportReceiptV1Schema.parse({
      schemaVersion: 1,
      taskId: request.taskId,
      patchId: identity.patchId,
      patchSha256: identity.patchHash,
      outputPath,
      byteLength: identity.byteLength,
      exportedAt,
      status: "completed",
    });
    if (
      !(await inspectPublishedTarget(parent, targetName, request.extracted))
    ) {
      throw new M1PatchExportError(
        "artifact_write_failed",
        "published patch failed integrity verification",
        outputPath,
        false,
      );
    }
    const [currentPathMetadata, currentCwdMetadata] = await Promise.all([
      lstat(parentPath),
      lstat(canonicalCwd),
    ]);
    if (
      !currentCwdMetadata.isDirectory() ||
      currentCwdMetadata.isSymbolicLink() ||
      currentCwdMetadata.dev !== cwdIdentity.dev ||
      currentCwdMetadata.ino !== cwdIdentity.ino ||
      !currentPathMetadata.isDirectory() ||
      currentPathMetadata.dev !== parentDevice ||
      currentPathMetadata.ino !== parentInode ||
      (await realpath(canonicalCwd)) !== canonicalCwd ||
      (await realpath(parentPath)) !== parentPath
    ) {
      throw new M1PatchExportError(
        "patch_export_failed",
        "patch export parent changed after publication",
        outputPath,
        true,
      );
    }
    await request.onPublished?.(receipt);
    return receipt;
  } catch (error) {
    const targetPublished =
      linkAttempted && parent !== undefined
        ? await inspectPublishedTarget(
            parent,
            basename(request.outputPath),
            request.extracted,
          )
        : false;
    if (error instanceof M1PatchExportError && !linkAttempted) throw error;
    throw new M1PatchExportError(
      error instanceof M1Error && error.code === "artifact_write_failed"
        ? "artifact_write_failed"
        : "patch_export_failed",
      error instanceof M1PatchExportError
        ? error.message
        : "patch export failed",
      request.outputPath,
      targetPublished,
      error,
    );
  } finally {
    if (parent !== undefined && temporaryName !== undefined) {
      await unlink(fdChildPath(parent, temporaryName)).catch(() => undefined);
    }
    if (parent !== undefined) await parent.close().catch(() => undefined);
  }
}
