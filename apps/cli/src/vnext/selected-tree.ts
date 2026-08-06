import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { createHash, type Hash } from "node:crypto";
import { join } from "node:path";

import { asSha256DigestV1, type Sha256DigestV1 } from "@chronorift/domain";

export interface SelectedTreeEntryV1 {
  readonly relativePath: string;
  readonly mode: "100644" | "100755";
  readonly content: Uint8Array;
}

export interface SelectedTreeContentSourceV1 {
  readonly relativePath: string;
  readonly mode: "100644" | "100755";
  readonly byteLength: number;
  chunks(): AsyncIterable<Uint8Array>;
}

interface PreparedSelectedTreeEntry {
  readonly relativePath: string;
  readonly pathBytes: Buffer;
  readonly mode: "100644" | "100755";
  readonly byteLength: number;
}

const assertSafeRelativePath = (relativePath: string): Buffer => {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new TypeError("selected-tree path must be nonempty");
  }
  if (
    relativePath.startsWith("/") ||
    /^[A-Za-z]:\//u.test(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) {
    throw new TypeError("selected-tree path must be a relative POSIX path");
  }

  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment === ".git",
    )
  ) {
    throw new TypeError(
      "selected-tree path must be normalized and must not contain .git",
    );
  }

  const pathBytes = Buffer.from(relativePath, "utf8");
  if (pathBytes.toString("utf8") !== relativePath) {
    throw new TypeError("selected-tree path must contain valid UTF-8 text");
  }
  return pathBytes;
};

const prepareEntries = <Entry>(
  entries: readonly Entry[],
  readMetadata: (entry: Entry) => {
    readonly relativePath: string;
    readonly mode: string;
    readonly byteLength: number;
  },
): readonly PreparedSelectedTreeEntry[] => {
  const seenPaths = new Set<string>();
  const prepared = entries.map((entry) => {
    const metadata = readMetadata(entry);
    const pathBytes = assertSafeRelativePath(metadata.relativePath);
    const mode = metadata.mode;
    if (mode !== "100644" && mode !== "100755") {
      throw new TypeError("selected-tree mode must be 100644 or 100755");
    }
    if (!Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 0) {
      throw new TypeError(
        "selected-tree byteLength must be a nonnegative safe integer",
      );
    }

    const bytePathKey = pathBytes.toString("hex");
    if (seenPaths.has(bytePathKey)) {
      throw new TypeError("duplicate selected-tree UTF-8 byte path");
    }
    seenPaths.add(bytePathKey);

    const preparedEntry: PreparedSelectedTreeEntry = {
      relativePath: metadata.relativePath,
      pathBytes,
      mode,
      byteLength: metadata.byteLength,
    };
    return preparedEntry;
  });

  return prepared.sort((left, right) =>
    Buffer.compare(left.pathBytes, right.pathBytes),
  );
};

const beginSelectedTreeHash = (): Hash =>
  createHash("sha256").update("chronorift-selected-tree-v1\0");

const updateEntryHeader = (
  hash: Hash,
  entry: PreparedSelectedTreeEntry,
): void => {
  hash.update(`${entry.pathBytes.byteLength}:`);
  hash.update(entry.pathBytes);
  hash.update(`\0${entry.mode}\0${entry.byteLength}:`);
};

const finishEntry = (hash: Hash): void => {
  hash.update("\0");
};

export function selectedTreeSha256(
  entries: readonly SelectedTreeEntryV1[],
): Sha256DigestV1 {
  const prepared = prepareEntries(entries, (entry) => {
    if (!(entry.content instanceof Uint8Array)) {
      throw new TypeError("selected-tree content must be a Uint8Array");
    }
    return {
      relativePath: entry.relativePath,
      mode: entry.mode,
      byteLength: entry.content.byteLength,
    };
  });
  const byPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
  const hash = beginSelectedTreeHash();

  for (const metadata of prepared) {
    const entry = byPath.get(metadata.relativePath);
    if (entry === undefined) {
      throw new TypeError("selected-tree entry disappeared during hashing");
    }
    updateEntryHeader(hash, metadata);
    hash.update(entry.content);
    finishEntry(hash);
  }
  return asSha256DigestV1(hash.digest("hex"));
}

export async function selectedTreeSha256FromSources(
  entries: readonly SelectedTreeContentSourceV1[],
): Promise<Sha256DigestV1> {
  const prepared = prepareEntries(entries, (entry) => ({
    relativePath: entry.relativePath,
    mode: entry.mode,
    byteLength: entry.byteLength,
  }));
  const byPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
  const hash = beginSelectedTreeHash();

  for (const metadata of prepared) {
    const source = byPath.get(metadata.relativePath);
    if (source === undefined) {
      throw new TypeError("selected-tree source disappeared during hashing");
    }
    updateEntryHeader(hash, metadata);

    let observedBytes = 0;
    for await (const chunk of source.chunks()) {
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("selected-tree chunks must be Uint8Array values");
      }
      observedBytes += chunk.byteLength;
      if (observedBytes > metadata.byteLength) {
        throw new RangeError(
          `selected-tree source ${metadata.relativePath} yielded more bytes than byteLength`,
        );
      }
      hash.update(chunk);
    }
    if (observedBytes !== metadata.byteLength) {
      throw new RangeError(
        `selected-tree source ${metadata.relativePath} yielded fewer bytes than byteLength`,
      );
    }
    finishEntry(hash);
  }

  return asSha256DigestV1(hash.digest("hex"));
}

const readRegularFileWithoutFollowing = async (
  absolutePath: string,
  expected: Awaited<ReturnType<typeof lstat>>,
): Promise<Uint8Array> => {
  const handle = await open(
    absolutePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      before.mode !== expected.mode ||
      before.size !== expected.size
    ) {
      throw new Error(
        "trusted selected-tree file identity changed before read",
      );
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.size !== before.size ||
      content.byteLength !== before.size
    ) {
      throw new Error(
        "trusted selected-tree file identity changed during read",
      );
    }
    return content;
  } finally {
    await handle.close();
  }
};

export async function readTrustedSelectedTree(
  root: string,
): Promise<Sha256DigestV1> {
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink()) {
    throw new TypeError("trusted selected-tree root must not be a symlink");
  }
  if (!rootMetadata.isDirectory()) {
    throw new TypeError("trusted selected-tree root must be a directory");
  }

  const entries: SelectedTreeEntryV1[] = [];
  const walk = async (
    absoluteDirectory: string,
    relativeDirectory: string,
  ): Promise<void> => {
    const names = await readdir(absoluteDirectory);
    names.sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );

    for (const name of names) {
      const relativePath =
        relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
      assertSafeRelativePath(relativePath);
      const absolutePath = join(absoluteDirectory, name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new TypeError(
          `trusted selected-tree entry ${relativePath} is a symbolic link`,
        );
      }
      if (metadata.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new TypeError(
          `trusted selected-tree entry ${relativePath} is not a regular file`,
        );
      }

      entries.push({
        relativePath,
        mode: (metadata.mode & 0o111) === 0 ? "100644" : "100755",
        content: await readRegularFileWithoutFollowing(absolutePath, metadata),
      });
    }
  };

  await walk(root, "");
  return selectedTreeSha256(entries);
}
