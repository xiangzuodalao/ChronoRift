import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_FINAL_FILENAME_BYTES = 216;
const TEMPORARY_NAME =
  /^\.(?<final>[A-Za-z0-9._-]{1,216})\.tmp-(?<id>[a-f0-9]{32})$/u;

const currentUid = (): number => {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw new Error("private publication requires Unix ownership");
  }
  return uid;
};

const requirePrivateRoot = async (rootInput: string): Promise<string> => {
  const root = resolve(rootInput);
  const [metadata, canonical] = await Promise.all([
    lstat(root),
    realpath(root),
  ]);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE ||
    canonical !== root
  ) {
    throw new Error("private publication root must be canonical and private");
  }
  return root;
};

const requireSafeFilename = (filename: string): string => {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(filename) ||
    Buffer.byteLength(filename, "utf8") > MAX_FINAL_FILENAME_BYTES ||
    basename(filename) !== filename
  ) {
    throw new Error("private publication filename is not bounded");
  }
  return filename;
};

const syncDirectory = async (root: string): Promise<void> => {
  const directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

const writeAll = async (
  handle: FileHandle,
  bytes: Uint8Array,
  write: (
    handle: FileHandle,
    bytes: Uint8Array,
    offset: number,
  ) => Promise<number>,
): Promise<void> => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await write(handle, bytes, offset);
    if (
      !Number.isSafeInteger(written) ||
      written <= 0 ||
      written > bytes.byteLength - offset
    ) {
      throw new Error("private publication write made invalid progress");
    }
    offset += written;
  }
};

const defaultWrite = async (
  handle: FileHandle,
  bytes: Uint8Array,
  offset: number,
): Promise<number> => {
  const { bytesWritten } = await handle.write(
    bytes,
    offset,
    bytes.byteLength - offset,
    offset,
  );
  return bytesWritten;
};

export interface PrivateAtomicPublicationDependenciesV1 {
  readonly write?: typeof defaultWrite | undefined;
  readonly beforePublish?: (() => Promise<void>) | undefined;
}

/**
 * Publishes complete private bytes without opening the authoritative path for
 * a partial write. The same-directory hard link is the atomic no-replace
 * commit point. Callers must still validate their DTO after reading it back.
 */
export const publishPrivateFileOnceV1 = async (
  input: {
    readonly root: string;
    readonly filename: string;
    readonly bytes: Uint8Array;
  },
  dependencies: PrivateAtomicPublicationDependenciesV1 = {},
): Promise<string> => {
  const root = await requirePrivateRoot(input.root);
  const filename = requireSafeFilename(input.filename);
  const finalPath = join(root, filename);
  const temporaryPath = join(
    root,
    `.${filename}.tmp-${randomUUID().replaceAll("-", "")}`,
  );
  let handle: FileHandle | undefined;
  let temporaryCreated = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    temporaryCreated = true;
    await writeAll(handle, input.bytes, dependencies.write ?? defaultWrite);
    await handle.sync();
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== currentUid() ||
      (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
      metadata.nlink !== 1 ||
      metadata.size !== input.bytes.byteLength
    ) {
      throw new Error("private publication temporary identity changed");
    }
    await handle.close();
    handle = undefined;
    const retained = await readFile(temporaryPath);
    if (!Buffer.from(retained).equals(Buffer.from(input.bytes))) {
      throw new Error("private publication temporary bytes changed");
    }
    await dependencies.beforePublish?.();
    await link(temporaryPath, finalPath);
    await syncDirectory(root);
    await unlink(temporaryPath);
    temporaryCreated = false;
    await syncDirectory(root);
    const [finalMetadata, canonical, finalBytes] = await Promise.all([
      lstat(finalPath),
      realpath(finalPath),
      readFile(finalPath),
    ]);
    if (
      !finalMetadata.isFile() ||
      finalMetadata.isSymbolicLink() ||
      finalMetadata.uid !== currentUid() ||
      (finalMetadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
      finalMetadata.nlink !== 1 ||
      canonical !== finalPath ||
      !Buffer.from(finalBytes).equals(Buffer.from(input.bytes))
    ) {
      throw new Error("private publication final identity changed");
    }
    return finalPath;
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
      await syncDirectory(root).catch(() => undefined);
    }
  }
};

export interface PrivateAtomicPublicationRepairV1 {
  readonly removedUnpublishedTemporaryCount: number;
  readonly repairedPublishedLinkCount: number;
}

/**
 * Repairs exact publication temporaries only after their writer is known to
 * be quiescent. A two-link publication is accepted only after the caller's
 * strict validator accepts the authoritative bytes.
 */
export const repairPrivatePublicationsV1 = async (input: {
  readonly root: string;
  readonly filenames?: readonly string[] | undefined;
  readonly validatePublishedBytes: (
    filename: string,
    bytes: Uint8Array,
  ) => Promise<void> | void;
}): Promise<PrivateAtomicPublicationRepairV1> => {
  const root = await requirePrivateRoot(input.root);
  const selectedFilenames =
    input.filenames === undefined
      ? null
      : new Set(input.filenames.map(requireSafeFilename));
  let removedUnpublishedTemporaryCount = 0;
  let repairedPublishedLinkCount = 0;
  for (const name of (await readdir(root)).sort((left, right) =>
    left.localeCompare(right, "en"),
  )) {
    const match = TEMPORARY_NAME.exec(name);
    if (match?.groups === undefined) continue;
    const filename = requireSafeFilename(match.groups.final!);
    if (selectedFilenames !== null && !selectedFilenames.has(filename)) {
      continue;
    }
    const temporaryPath = join(root, name);
    const finalPath = join(root, filename);
    const [temporaryMetadata, temporaryCanonical] = await Promise.all([
      lstat(temporaryPath),
      realpath(temporaryPath),
    ]);
    if (
      !temporaryMetadata.isFile() ||
      temporaryMetadata.isSymbolicLink() ||
      temporaryMetadata.uid !== currentUid() ||
      (temporaryMetadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
      (temporaryMetadata.nlink !== 1 && temporaryMetadata.nlink !== 2) ||
      temporaryCanonical !== temporaryPath
    ) {
      throw new Error("private publication temporary repair target is unsafe");
    }
    let finalMetadata;
    try {
      finalMetadata = await lstat(finalPath);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !Object.hasOwn(error, "code") ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      if (temporaryMetadata.nlink !== 1) {
        throw new Error("unpublished temporary file has an extra link");
      }
      await unlink(temporaryPath);
      removedUnpublishedTemporaryCount += 1;
      continue;
    }
    if (
      !finalMetadata.isFile() ||
      finalMetadata.isSymbolicLink() ||
      finalMetadata.uid !== currentUid() ||
      (finalMetadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
      (await realpath(finalPath)) !== finalPath
    ) {
      throw new Error("private publication final repair target is unsafe");
    }
    if (
      finalMetadata.dev === temporaryMetadata.dev &&
      finalMetadata.ino === temporaryMetadata.ino
    ) {
      if (finalMetadata.nlink !== 2 || temporaryMetadata.nlink !== 2) {
        throw new Error("published temporary link count is invalid");
      }
      await input.validatePublishedBytes(filename, await readFile(finalPath));
      await unlink(temporaryPath);
      repairedPublishedLinkCount += 1;
    } else {
      if (temporaryMetadata.nlink !== 1 || finalMetadata.nlink !== 1) {
        throw new Error("unrelated publication repair link count is invalid");
      }
      await input.validatePublishedBytes(filename, await readFile(finalPath));
      await unlink(temporaryPath);
      removedUnpublishedTemporaryCount += 1;
    }
  }
  if (
    removedUnpublishedTemporaryCount !== 0 ||
    repairedPublishedLinkCount !== 0
  ) {
    await syncDirectory(root);
  }
  return Object.freeze({
    removedUnpublishedTemporaryCount,
    repairedPublishedLinkCount,
  });
};

export const privatePublicationRootForPathV1 = (pathInput: string) =>
  Object.freeze({
    root: dirname(resolve(pathInput)),
    filename: basename(pathInput),
  });
