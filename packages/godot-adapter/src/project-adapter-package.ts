import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

import {
  PROJECT_ADAPTER_REQUIRED_MODULES_V1,
  ProjectAdapterManifestV1Schema,
  ProjectAdapterPackagePathV1Schema,
  ProjectAdapterResourceReferenceV1Schema,
  parseProjectAdapterPayloadSchemaV1,
  type ProjectAdapterCapabilityModuleV1,
  type ProjectAdapterManifestV1,
  type ProjectAdapterPayloadSchemaDocumentV1,
} from "@chronorift/godot-protocol";

export const PROJECT_ADAPTER_PACKAGE_LIMITS_V1 = Object.freeze({
  maximumFiles: 256,
  maximumDirectories: 64,
  maximumFileBytes: 1 * 1_024 * 1_024,
  maximumTotalBytes: 8 * 1_024 * 1_024,
});

const unsupportedSuffixes = Object.freeze([
  ".cs",
  ".csproj",
  ".dll",
  ".dylib",
  ".exe",
  ".gdextension",
  ".gdnlib",
  ".o",
  ".sln",
  ".so",
] as const);

const forbiddenGdscriptPatterns = Object.freeze([
  { pattern: /(^|\n)\s*@tool(?:\s|$)/u, label: "@tool" },
  { pattern: /\bEditorPlugin\b/u, label: "EditorPlugin" },
  { pattern: /\bGDExtension\b/u, label: "GDExtension" },
  {
    pattern: /\bOS\.(?:execute|create_process)\s*\(/u,
    label: "process creation",
  },
] as const);

export interface ProjectAdapterPackageValidationOptionsV1 {
  readonly requireSingleLaunchTarget?: boolean | undefined;
  readonly expectedMainScene?: string | undefined;
  readonly requireEmptyLaunchParameters?: boolean | undefined;
  readonly requiredImplementedModules?:
    readonly ProjectAdapterCapabilityModuleV1[] | undefined;
}

export interface ProjectAdapterPackageFileV1 {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LoadedProjectAdapterPackageV1 {
  readonly schemaVersion: 1;
  readonly candidateSha256: string;
  readonly manifestSha256: string;
  readonly manifest: ProjectAdapterManifestV1;
  readonly schemas: readonly ProjectAdapterPayloadSchemaDocumentV1[];
  readonly files: readonly ProjectAdapterPackageFileV1[];
  readonly totalBytes: number;
}

/**
 * A validated package plus defensive copies of the exact bytes that were
 * inspected. This is intended for runtime materialization: callers never need
 * to reopen an untrusted candidate after validation.
 */
export interface LoadedProjectAdapterPackageWithBytesV1 extends LoadedProjectAdapterPackageV1 {
  readonly fileBytes: readonly ProjectAdapterPackageBytesV1[];
}

export class ProjectAdapterPackageValidationError extends Error {
  public override readonly name = "ProjectAdapterPackageValidationError";
}

const fail = (message: string): never => {
  throw new ProjectAdapterPackageValidationError(message);
};

const sameIdentity = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const decodeUtf8 = (bytes: Uint8Array, relativePath: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(`adapter package file is not valid UTF-8: ${relativePath}`);
  }
};

const parseJson = (text: string, relativePath: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail(`adapter package file is not valid JSON: ${relativePath}`);
  }
};

const assertAllowedPath = (relativePath: string): void => {
  ProjectAdapterPackagePathV1Schema.parse(relativePath);
  const normalized = relativePath.toLocaleLowerCase("en-US");
  if (
    relativePath.split("/").some((segment) => segment.startsWith(".")) ||
    unsupportedSuffixes.some((suffix) => normalized.endsWith(suffix))
  ) {
    fail(`adapter package path is not allowed: ${relativePath}`);
  }
  if (
    relativePath !== "manifest.json" &&
    relativePath !== "README.md" &&
    !(relativePath.startsWith("src/") && relativePath.endsWith(".gd")) &&
    !(relativePath.startsWith("schemas/") && relativePath.endsWith(".json"))
  ) {
    fail(`adapter package contains an unsupported file: ${relativePath}`);
  }
};

const inspectGdscript = (text: string, relativePath: string): void => {
  for (const forbidden of forbiddenGdscriptPatterns) {
    if (forbidden.pattern.test(text)) {
      fail(
        `adapter GDScript contains forbidden ${forbidden.label}: ${relativePath}`,
      );
    }
  }
};

const isStrictEmptyObjectSchema = (
  schema: ProjectAdapterPayloadSchemaDocumentV1,
): boolean =>
  "type" in schema.root &&
  schema.root.type === "object" &&
  Object.keys(schema.root.properties).length === 0 &&
  schema.root.required.length === 0 &&
  schema.root.additionalProperties === false;

const validateExpectations = (
  manifest: ProjectAdapterManifestV1,
  schemasById: ReadonlyMap<string, ProjectAdapterPayloadSchemaDocumentV1>,
  options: ProjectAdapterPackageValidationOptionsV1,
): void => {
  if (
    options.requireSingleLaunchTarget === true &&
    manifest.launchTargets.length !== 1
  ) {
    fail("PE-A requires exactly one launch target");
  }
  const defaultTarget = manifest.launchTargets.find((target) => target.default);
  if (defaultTarget === undefined)
    return fail("adapter manifest has no default target");
  if (options.expectedMainScene !== undefined) {
    const expected = ProjectAdapterResourceReferenceV1Schema.parse(
      options.expectedMainScene,
    );
    if (defaultTarget.scene !== expected) {
      fail("adapter default target does not match the realized main scene");
    }
  }
  if (options.requireEmptyLaunchParameters === true) {
    const parameters = schemasById.get(defaultTarget.parametersSchemaId);
    if (parameters === undefined || !isStrictEmptyObjectSchema(parameters)) {
      fail("PE-A requires a strict empty default launch parameter schema");
    }
  }
  const required =
    options.requiredImplementedModules ?? PROJECT_ADAPTER_REQUIRED_MODULES_V1;
  if (new Set(required).size !== required.length) {
    fail("required adapter modules must be unique");
  }
  for (const module of required) {
    const declaration = manifest.modules.modules.find(
      (candidate) => candidate.module === module,
    );
    if (declaration?.status !== "implemented") {
      fail(`required adapter module is not implemented: ${module}`);
    }
  }
};

interface LoadedFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface ProjectAdapterPackageBytesV1 {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const readStableFile = async (
  canonicalRoot: string,
  absolutePath: string,
  relativePath: string,
  inspected: BigIntStats,
): Promise<LoadedFile> => {
  if (
    inspected.size > BigInt(PROJECT_ADAPTER_PACKAGE_LIMITS_V1.maximumFileBytes)
  ) {
    return fail(`adapter package file exceeds its byte limit: ${relativePath}`);
  }
  const canonicalFile = await realpath(absolutePath).catch(() => "");
  if (
    canonicalFile !== absolutePath ||
    !canonicalFile.startsWith(`${canonicalRoot}${sep}`)
  ) {
    return fail(`adapter package path escapes its root: ${relativePath}`);
  }
  const handle = await open(
    absolutePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => undefined);
  if (handle === undefined) {
    return fail(
      `adapter package file could not be opened safely: ${relativePath}`,
    );
  }
  try {
    const opened = await handle.stat({ bigint: true });
    const fdTarget = await realpath(`/proc/self/fd/${handle.fd}`).catch(
      () => "",
    );
    if (
      !opened.isFile() ||
      !sameIdentity(inspected, opened) ||
      fdTarget !== absolutePath
    ) {
      return fail(
        `adapter package file changed during inspection: ${relativePath}`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !sameIdentity(opened, after) ||
      BigInt(bytes.byteLength) !== after.size
    ) {
      return fail(
        `adapter package file changed while reading: ${relativePath}`,
      );
    }
    return {
      relativePath,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await handle.close();
  }
};

const validateLoadedProjectAdapterPackageV1 = (
  untrustedFiles: readonly LoadedFile[],
  options: ProjectAdapterPackageValidationOptionsV1,
): LoadedProjectAdapterPackageV1 => {
  const files = [...untrustedFiles].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en-US"),
  );
  if (files.length > PROJECT_ADAPTER_PACKAGE_LIMITS_V1.maximumFiles) {
    fail("adapter package file limit exceeded");
  }
  if (
    files.some(
      (file, index) =>
        index > 0 && files[index - 1]?.relativePath === file.relativePath,
    )
  ) {
    fail("adapter package paths must be unique");
  }
  const totalBytes = files.reduce(
    (total, file) => total + file.bytes.byteLength,
    0,
  );
  if (totalBytes > PROJECT_ADAPTER_PACKAGE_LIMITS_V1.maximumTotalBytes) {
    fail("adapter package total byte limit exceeded");
  }
  const filesByPath = new Map(files.map((file) => [file.relativePath, file]));
  const manifestFile = filesByPath.get("manifest.json");
  if (manifestFile === undefined)
    return fail("adapter package is missing manifest.json");
  const manifest = ProjectAdapterManifestV1Schema.parse(
    parseJson(decodeUtf8(manifestFile.bytes, "manifest.json"), "manifest.json"),
  );
  const entry = filesByPath.get(manifest.entryScript);
  if (entry === undefined) fail("adapter package entry script does not exist");

  for (const file of files) {
    if (file.relativePath.endsWith(".gd")) {
      inspectGdscript(
        decodeUtf8(file.bytes, file.relativePath),
        file.relativePath,
      );
    }
  }

  const schemas: ProjectAdapterPayloadSchemaDocumentV1[] = [];
  const declaredSchemaPaths = new Set(
    manifest.schemas.map((schema) => schema.path),
  );
  for (const declaration of manifest.schemas) {
    const file = filesByPath.get(declaration.path);
    if (file === undefined)
      return fail(`declared adapter schema is missing: ${declaration.path}`);
    if (file.sha256 !== declaration.sha256) {
      fail(`declared adapter schema hash does not match: ${declaration.path}`);
    }
    const schema = parseProjectAdapterPayloadSchemaV1(
      parseJson(decodeUtf8(file.bytes, declaration.path), declaration.path),
    );
    if (schema.schemaId !== declaration.schemaId) {
      fail(
        `declared adapter schema identity does not match: ${declaration.path}`,
      );
    }
    schemas.push(schema);
  }
  for (const file of files) {
    if (
      file.relativePath.startsWith("schemas/") &&
      file.relativePath.endsWith(".json") &&
      !declaredSchemaPaths.has(file.relativePath)
    ) {
      fail(
        `adapter package contains an undeclared schema: ${file.relativePath}`,
      );
    }
  }
  const schemasById = new Map(
    schemas.map((schema) => [schema.schemaId, schema]),
  );
  validateExpectations(manifest, schemasById, options);

  const identity = createHash("sha256");
  for (const file of files) {
    identity.update(file.relativePath);
    identity.update("\0");
    identity.update(file.sha256);
    identity.update("\0");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    candidateSha256: identity.digest("hex"),
    manifestSha256: manifestFile.sha256,
    manifest,
    schemas: Object.freeze([...schemas]),
    files: Object.freeze(
      files.map((file) =>
        Object.freeze({
          path: file.relativePath,
          bytes: file.bytes.byteLength,
          sha256: file.sha256,
        }),
      ),
    ),
    totalBytes,
  });
};

/** Revalidates published immutable bytes without creating a new candidate. */
export const loadProjectAdapterPackageFilesV1 = (
  input: readonly ProjectAdapterPackageBytesV1[],
  options: ProjectAdapterPackageValidationOptionsV1 = {},
): LoadedProjectAdapterPackageV1 => {
  const files: LoadedFile[] = [];
  let totalBytes = 0;
  for (const file of input) {
    assertAllowedPath(file.path);
    if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength < 1) {
      fail(`adapter package file must contain non-empty bytes: ${file.path}`);
    }
    if (
      file.bytes.byteLength > PROJECT_ADAPTER_PACKAGE_LIMITS_V1.maximumFileBytes
    ) {
      fail(`adapter package file exceeds its byte limit: ${file.path}`);
    }
    totalBytes += file.bytes.byteLength;
    if (totalBytes > PROJECT_ADAPTER_PACKAGE_LIMITS_V1.maximumTotalBytes) {
      fail("adapter package total byte limit exceeded");
    }
    const bytes = Uint8Array.from(file.bytes);
    files.push({
      relativePath: file.path,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return validateLoadedProjectAdapterPackageV1(files, options);
};

const readProjectAdapterPackageV1 = async (
  candidateRoot: string,
): Promise<readonly LoadedFile[]> => {
  const resolvedRoot = resolve(candidateRoot);
  const rootBefore = await lstat(resolvedRoot, { bigint: true }).catch(() =>
    fail("adapter package root does not exist"),
  );
  const canonicalRoot = await realpath(resolvedRoot).catch(() => "");
  if (
    rootBefore.isSymbolicLink() ||
    !rootBefore.isDirectory() ||
    canonicalRoot !== resolvedRoot
  ) {
    fail("adapter package root must be a canonical non-symlink directory");
  }

  const files: LoadedFile[] = [];
  const pending = [""];
  let directories = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    directories += 1;
    if (directories > PROJECT_ADAPTER_PACKAGE_LIMITS_V1.maximumDirectories) {
      fail("adapter package directory limit exceeded");
    }
    const absoluteDirectory =
      directory === "" ? canonicalRoot : `${canonicalRoot}/${directory}`;
    const names = await readdir(absoluteDirectory);
    names.sort((left, right) => left.localeCompare(right, "en-US"));
    for (const name of names) {
      const relativePath = directory === "" ? name : `${directory}/${name}`;
      const absolutePath = `${canonicalRoot}/${relativePath}`;
      const metadata = await lstat(absolutePath, { bigint: true });
      if (metadata.isSymbolicLink()) {
        fail(`adapter package cannot contain symlinks: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        ProjectAdapterPackagePathV1Schema.parse(relativePath);
        if (name.startsWith(".")) {
          fail(`adapter package directory is not allowed: ${relativePath}`);
        }
        pending.push(relativePath);
        continue;
      }
      if (!metadata.isFile()) {
        fail(`adapter package cannot contain special files: ${relativePath}`);
      }
      assertAllowedPath(relativePath);
      if (files.length >= PROJECT_ADAPTER_PACKAGE_LIMITS_V1.maximumFiles) {
        fail("adapter package file limit exceeded");
      }
      const file = await readStableFile(
        canonicalRoot,
        absolutePath,
        relativePath,
        metadata,
      );
      totalBytes += file.bytes.byteLength;
      if (totalBytes > PROJECT_ADAPTER_PACKAGE_LIMITS_V1.maximumTotalBytes) {
        fail("adapter package total byte limit exceeded");
      }
      files.push(file);
    }
  }

  const rootAfter = await lstat(canonicalRoot, { bigint: true });
  if (!sameIdentity(rootBefore, rootAfter)) {
    fail("adapter package root changed during inspection");
  }
  return Object.freeze(files);
};

/**
 * Loads a candidate without following symlinks or special files and exposes
 * the exact validated bytes without a second filesystem read.
 */
export const loadProjectAdapterPackageWithBytesV1 = async (
  candidateRoot: string,
  options: ProjectAdapterPackageValidationOptionsV1 = {},
): Promise<LoadedProjectAdapterPackageWithBytesV1> => {
  const files = await readProjectAdapterPackageV1(candidateRoot);
  const loaded = validateLoadedProjectAdapterPackageV1(files, options);
  return Object.freeze({
    ...loaded,
    fileBytes: Object.freeze(
      [...files]
        .sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath, "en-US"),
        )
        .map((file) =>
          Object.freeze({
            path: file.relativePath,
            bytes: Uint8Array.from(file.bytes),
          }),
        ),
    ),
  });
};

/** Loads a candidate package without following symlinks or special files. */
export const loadProjectAdapterPackageV1 = async (
  candidateRoot: string,
  options: ProjectAdapterPackageValidationOptionsV1 = {},
): Promise<LoadedProjectAdapterPackageV1> => {
  const { fileBytes: _fileBytes, ...loaded } =
    await loadProjectAdapterPackageWithBytesV1(candidateRoot, options);
  void _fileBytes;
  return Object.freeze(loaded);
};
