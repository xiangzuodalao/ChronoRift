import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { asSha256DigestV1, type Sha256DigestV1 } from "@chronorift/domain";

import { M1Error } from "./errors.js";

export const MAX_GODOT_PROJECT_DESCRIPTOR_BYTES_V1 = 64 * 1024;

export const DeclaredSourceUrlV1Schema = z
  .string()
  .min(1)
  .max(2048)
  .superRefine((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "declaredSourceUrl must be an absolute HTTPS URL",
      });
      return;
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.hostname === ""
    ) {
      context.addIssue({
        code: "custom",
        message:
          "declaredSourceUrl must be HTTPS metadata without credentials, query, or fragment",
      });
    }
  });

export interface GodotProjectDescriptorV1 {
  readonly schemaVersion: 1;
  readonly descriptorKind: "chronorift-godot-external-project";
  readonly declaredSourceUrl: string;
  readonly projectFile: "project.godot";
  readonly runtime: {
    readonly engineVersion: "4.7.1-stable (official)";
    readonly scripting: "gdscript";
    readonly renderer: "gl_compatibility";
    readonly executionMode: "headless";
  };
  readonly launch: { readonly scene: "project-main-scene" };
  readonly cache: { readonly ignoredPaths: readonly [".godot"] };
  readonly bridge: {
    readonly mode: "managed-runtime-overlay";
    readonly protocolVersion: 1;
  };
}

export const GodotProjectDescriptorV1Schema: z.ZodType<GodotProjectDescriptorV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      descriptorKind: z.literal("chronorift-godot-external-project"),
      declaredSourceUrl: DeclaredSourceUrlV1Schema,
      projectFile: z.literal("project.godot"),
      runtime: z
        .object({
          engineVersion: z.literal("4.7.1-stable (official)"),
          scripting: z.literal("gdscript"),
          renderer: z.literal("gl_compatibility"),
          executionMode: z.literal("headless"),
        })
        .strict(),
      launch: z.object({ scene: z.literal("project-main-scene") }).strict(),
      cache: z
        .object({ ignoredPaths: z.tuple([z.literal(".godot")]) })
        .strict(),
      bridge: z
        .object({
          mode: z.literal("managed-runtime-overlay"),
          protocolVersion: z.literal(1),
        })
        .strict(),
    })
    .strict();

export interface GodotProjectDescriptorSnapshotV1 {
  readonly descriptor: GodotProjectDescriptorV1;
  readonly descriptorSha256: Sha256DigestV1;
  readonly bytes: Uint8Array;
}

export interface HostGodotProjectDescriptorSnapshotV1 extends GodotProjectDescriptorSnapshotV1 {
  readonly canonicalPath: string;
}

const sha256 = (bytes: Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const freezeDescriptor = (
  value: GodotProjectDescriptorV1,
): GodotProjectDescriptorV1 =>
  Object.freeze({
    ...value,
    runtime: Object.freeze({ ...value.runtime }),
    launch: Object.freeze({ ...value.launch }),
    cache: Object.freeze({
      ignoredPaths: Object.freeze([".godot"] as const),
    }),
    bridge: Object.freeze({ ...value.bridge }),
  });

export const parseGodotProjectDescriptorSnapshotV1 = (
  input: Uint8Array,
): GodotProjectDescriptorSnapshotV1 => {
  if (!(input instanceof Uint8Array)) {
    throw new M1Error(
      "source_configuration_mismatch",
      "Godot project descriptor must be bytes",
    );
  }
  if (
    input.byteLength === 0 ||
    input.byteLength > MAX_GODOT_PROJECT_DESCRIPTOR_BYTES_V1
  ) {
    throw new M1Error(
      "source_configuration_mismatch",
      "Godot project descriptor exceeds its bounded byte profile",
    );
  }
  const bytes = Uint8Array.from(input);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new M1Error(
      "source_configuration_mismatch",
      "Godot project descriptor must not contain a UTF-8 BOM",
    );
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = GodotProjectDescriptorV1Schema.parse(
      JSON.parse(text) as unknown,
    );
    return Object.freeze({
      descriptor: freezeDescriptor(parsed),
      descriptorSha256: sha256(bytes),
      bytes,
    });
  } catch (error) {
    if (error instanceof M1Error) throw error;
    throw new M1Error(
      "source_configuration_mismatch",
      "Godot project descriptor is not strict UTF-8 JSON for the supported profile",
      error,
    );
  }
};

const sameFileIdentity = (
  left: {
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
  },
  right: {
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
  },
): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

export async function readGodotProjectDescriptorSnapshotV1(
  descriptorPath: string,
): Promise<HostGodotProjectDescriptorSnapshotV1> {
  const requestedPath = resolve(descriptorPath);
  let inspected: Awaited<ReturnType<typeof lstat>>;
  try {
    inspected = await lstat(requestedPath);
  } catch (error) {
    throw new M1Error(
      "path_denied",
      "Godot project descriptor path is unavailable",
      error,
    );
  }
  if (inspected.isSymbolicLink() || !inspected.isFile()) {
    throw new M1Error(
      "path_denied",
      "Godot project descriptor must be a non-symlink regular file",
    );
  }
  const canonicalPath = await realpath(requestedPath);
  if (canonicalPath !== requestedPath) {
    throw new M1Error(
      "path_denied",
      "Godot project descriptor path must be canonical",
    );
  }
  if (
    inspected.size <= 0 ||
    inspected.size > MAX_GODOT_PROJECT_DESCRIPTOR_BYTES_V1
  ) {
    throw new M1Error(
      "source_configuration_mismatch",
      "Godot project descriptor exceeds its bounded byte profile",
    );
  }

  const handle = await open(
    canonicalPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(inspected, opened)) {
      throw new M1Error(
        "path_denied",
        "Godot project descriptor changed while being opened",
      );
    }
    const buffer = Buffer.alloc(inspected.size);
    let position = 0;
    while (position < buffer.byteLength) {
      const read = await handle.read(
        buffer,
        position,
        buffer.byteLength - position,
        position,
      );
      if (read.bytesRead === 0) break;
      position += read.bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await lstat(canonicalPath);
    if (
      position !== buffer.byteLength ||
      !sameFileIdentity(opened, after) ||
      !sameFileIdentity(opened, pathAfter)
    ) {
      throw new M1Error(
        "path_denied",
        "Godot project descriptor changed while being read",
      );
    }
    return Object.freeze({
      ...parseGodotProjectDescriptorSnapshotV1(buffer),
      canonicalPath,
    });
  } finally {
    await handle.close();
  }
}
