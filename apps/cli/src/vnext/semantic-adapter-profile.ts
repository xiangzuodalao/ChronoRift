import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  GodotSemanticAdapterProfileV1Schema,
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type GodotSemanticAdapterProfileV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";
import { z } from "zod";

export interface HostGodotSemanticAdapterProfileSnapshotV1 {
  readonly canonicalPath: string;
  readonly bytes: Uint8Array;
}

export interface GodotSemanticAdapterProfileSnapshotV1 {
  readonly schemaVersion: 1;
  readonly bytesBase64: string;
  readonly byteLength: number;
  readonly rawBytesSha256: Sha256DigestV1;
  readonly adapterProfileSha256: Sha256DigestV1;
  readonly profile: GodotSemanticAdapterProfileV1;
}

const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    bytesBase64: z
      .string()
      .min(4)
      .max(256 * 1024),
    byteLength: z
      .number()
      .int()
      .min(2)
      .max(128 * 1024),
    rawBytesSha256: Sha256DigestV1Schema,
    adapterProfileSha256: Sha256DigestV1Schema,
    profile: GodotSemanticAdapterProfileV1Schema,
  })
  .strict();

const rawHash = (bytes: Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

export const parseGodotSemanticAdapterProfileSnapshotV1 = (
  bytes: Uint8Array,
): GodotSemanticAdapterProfileSnapshotV1 => {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 2 ||
    bytes.byteLength > 128 * 1024
  ) {
    throw new TypeError("semantic adapter profile bytes exceed their bound");
  }
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new TypeError("semantic adapter profile must be UTF-8 JSON", {
      cause: error,
    });
  }
  const profile = GodotSemanticAdapterProfileV1Schema.parse(input);
  return Object.freeze({
    schemaVersion: 1,
    bytesBase64: Buffer.from(bytes).toString("base64"),
    byteLength: bytes.byteLength,
    rawBytesSha256: rawHash(bytes),
    adapterProfileSha256: asSha256DigestV1(
      contentHash(profile as unknown as JsonValue),
    ),
    profile,
  });
};

export const GodotSemanticAdapterProfileSnapshotV1Schema: z.ZodType<GodotSemanticAdapterProfileSnapshotV1> =
  snapshotSchema.superRefine((value, context) => {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(value.bytesBase64, "base64");
    } catch {
      context.addIssue({
        code: "custom",
        path: ["bytesBase64"],
        message: "semantic adapter profile bytes are not base64",
      });
      return;
    }
    if (
      bytes.toString("base64") !== value.bytesBase64 ||
      bytes.byteLength !== value.byteLength ||
      rawHash(bytes) !== value.rawBytesSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["rawBytesSha256"],
        message: "semantic adapter raw identity mismatch",
      });
    }
    let reparsed: GodotSemanticAdapterProfileSnapshotV1;
    try {
      reparsed = parseGodotSemanticAdapterProfileSnapshotV1(bytes);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["bytesBase64"],
        message: "semantic adapter bytes do not contain a valid profile",
      });
      return;
    }
    if (
      JSON.stringify(reparsed.profile) !== JSON.stringify(value.profile) ||
      reparsed.adapterProfileSha256 !== value.adapterProfileSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["adapterProfileSha256"],
        message: "semantic adapter canonical identity mismatch",
      });
    }
  });

const sameIdentity = (
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

export async function readGodotSemanticAdapterProfileSnapshotV1(
  profilePath: string,
): Promise<HostGodotSemanticAdapterProfileSnapshotV1> {
  const requestedPath = resolve(profilePath);
  const inspected = await lstat(requestedPath);
  if (
    inspected.isSymbolicLink() ||
    !inspected.isFile() ||
    inspected.size < 2 ||
    inspected.size > 128 * 1024 ||
    (await realpath(requestedPath)) !== requestedPath
  ) {
    throw new TypeError(
      "semantic adapter profile must be a bounded canonical regular file",
    );
  }
  const handle = await open(
    requestedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (!sameIdentity(inspected, opened)) {
      throw new TypeError("semantic adapter profile changed while opening");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(requestedPath);
    if (
      bytes.byteLength !== inspected.size ||
      !sameIdentity(opened, after) ||
      !sameIdentity(opened, pathAfter)
    ) {
      throw new TypeError("semantic adapter profile changed while reading");
    }
    return Object.freeze({
      canonicalPath: requestedPath,
      bytes: Uint8Array.from(bytes),
    });
  } finally {
    await handle.close();
  }
}
