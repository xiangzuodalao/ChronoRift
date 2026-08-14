import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

import {
  PROJECT_ADAPTER_REQUIRED_MODULES_V2,
  ProjectAdapterManifestV2Schema,
  ProjectAdapterPackagePathV1Schema,
  ProjectAdapterResourceReferenceV1Schema,
  parseProjectAdapterPayloadSchemaV2,
  type ProjectAdapterCapabilityModuleV2,
  type ProjectAdapterManifestV2,
  type ProjectAdapterPayloadSchemaDocumentV2,
} from "@chronorift/godot-protocol";

import { PROJECT_ADAPTER_PACKAGE_LIMITS_V1 } from "./project-adapter-package.js";
import type { LoadedProjectAdapterPackageV1 } from "./project-adapter-package.js";

export interface ProjectAdapterPackageValidationOptionsV2 {
  readonly requireSingleLaunchTarget?: boolean | undefined;
  readonly selectedLaunchTargetId?: string | undefined;
  readonly expectedMainScene?: string | undefined;
  readonly requireEmptyLaunchParameters?: boolean | undefined;
  readonly requiredImplementedModules?:
    readonly ProjectAdapterCapabilityModuleV2[] | undefined;
}

export type ProjectAdapterLaunchTargetV2 =
  ProjectAdapterManifestV2["launchTargets"][number];

export interface ProjectAdapterLaunchTargetSelectionV2 {
  readonly defaultTarget: ProjectAdapterLaunchTargetV2;
  readonly selectedTarget: ProjectAdapterLaunchTargetV2;
  readonly targetsToValidate: readonly ProjectAdapterLaunchTargetV2[];
}

export interface ProjectAdapterPackageBytesV2 {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface LoadedProjectAdapterPackageV2 {
  readonly schemaVersion: 2;
  readonly candidateSha256: string;
  readonly manifestSha256: string;
  readonly manifest: ProjectAdapterManifestV2;
  readonly launchTargetSelection: ProjectAdapterLaunchTargetSelectionV2;
  readonly schemas: readonly ProjectAdapterPayloadSchemaDocumentV2[];
  readonly files: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly totalBytes: number;
}

export class ProjectAdapterPackageV2ValidationError extends Error {
  public override readonly name = "ProjectAdapterPackageV2ValidationError";

  public constructor(
    message: string,
    public readonly code?: "target_not_validated",
  ) {
    super(message);
  }
}

export const resolveProjectAdapterLaunchTargetSelectionV2 = (
  manifest: ProjectAdapterManifestV2,
  selectedLaunchTargetId?: string,
): ProjectAdapterLaunchTargetSelectionV2 => {
  const defaultTarget =
    manifest.launchTargets.find((value) => value.default) ??
    fail("adapter manifest has no default target");
  const selectedTarget =
    selectedLaunchTargetId === undefined
      ? defaultTarget
      : (manifest.launchTargets.find(
          (value) => value.targetId === selectedLaunchTargetId,
        ) ??
        fail(
          `adapter manifest does not declare launch target: ${selectedLaunchTargetId}`,
          "target_not_validated",
        ));
  return Object.freeze({
    defaultTarget,
    selectedTarget,
    targetsToValidate: Object.freeze(
      defaultTarget.targetId === selectedTarget.targetId
        ? [defaultTarget]
        : [defaultTarget, selectedTarget],
    ),
  });
};

interface LoadedFileV2 {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

const fail = (message: string, code?: "target_not_validated"): never => {
  throw new ProjectAdapterPackageV2ValidationError(message, code);
};
const decode = (bytes: Uint8Array, path: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(`adapter package file is not valid UTF-8: ${path}`);
  }
};
const parseJson = (bytes: Uint8Array, path: string): unknown => {
  try {
    return JSON.parse(decode(bytes, path)) as unknown;
  } catch {
    return fail(`adapter package file is not valid JSON: ${path}`);
  }
};
const unsupported =
  /\.(?:cs|csproj|dll|dylib|exe|gdextension|gdnlib|o|sln|so)$/iu;
const assertPath = (path: string): void => {
  ProjectAdapterPackagePathV1Schema.parse(path);
  if (
    path.split("/").some((segment) => segment.startsWith(".")) ||
    unsupported.test(path) ||
    (path !== "manifest.json" &&
      path !== "README.md" &&
      !(path.startsWith("src/") && path.endsWith(".gd")) &&
      !(path.startsWith("schemas/") && path.endsWith(".json")))
  ) {
    fail(`adapter package path is not allowed: ${path}`);
  }
};
const inspectScript = (bytes: Uint8Array, path: string): void => {
  const text = decode(bytes, path);
  for (const [pattern, label] of [
    [/(^|\n)\s*@tool(?:\s|$)/u, "@tool"],
    [/\bEditorPlugin\b/u, "EditorPlugin"],
    [/\bGDExtension\b/u, "GDExtension"],
    [/\bOS\.(?:execute|create_process)\s*\(/u, "process creation"],
  ] as const) {
    if (pattern.test(text))
      fail(`adapter GDScript contains forbidden ${label}: ${path}`);
  }
};

const validateFiles = (
  input: readonly LoadedFileV2[],
  options: ProjectAdapterPackageValidationOptionsV2,
): LoadedProjectAdapterPackageV2 => {
  const files = [...input].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, "en-US"),
  );
  if (
    files.length < 2 ||
    files.length > PROJECT_ADAPTER_PACKAGE_LIMITS_V1.maximumFiles
  )
    fail("adapter package file count is invalid");
  if (
    files.some(
      (file, index) =>
        index > 0 && files[index - 1]?.relativePath === file.relativePath,
    )
  )
    fail("adapter package paths must be unique");
  const totalBytes = files.reduce(
    (sum, file) => sum + file.bytes.byteLength,
    0,
  );
  if (totalBytes > PROJECT_ADAPTER_PACKAGE_LIMITS_V1.maximumTotalBytes)
    fail("adapter package total byte limit exceeded");
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  const manifestFile =
    byPath.get("manifest.json") ??
    fail("adapter package is missing manifest.json");
  const manifest = ProjectAdapterManifestV2Schema.parse(
    parseJson(manifestFile.bytes, "manifest.json"),
  );
  if (!byPath.has(manifest.entryScript))
    fail("adapter package entry script does not exist");
  files
    .filter((file) => file.relativePath.endsWith(".gd"))
    .forEach((file) => inspectScript(file.bytes, file.relativePath));
  const schemas = manifest.schemas.map((declaration) => {
    const file =
      byPath.get(declaration.path) ??
      fail(`declared adapter schema is missing: ${declaration.path}`);
    if (file.sha256 !== declaration.sha256)
      fail(`declared adapter schema hash does not match: ${declaration.path}`);
    const schema = parseProjectAdapterPayloadSchemaV2(
      parseJson(file.bytes, declaration.path),
    );
    if (schema.schemaId !== declaration.schemaId)
      fail(
        `declared adapter schema identity does not match: ${declaration.path}`,
      );
    return schema;
  });
  const declaredPaths = new Set(manifest.schemas.map((value) => value.path));
  if (
    files.some(
      (file) =>
        file.relativePath.startsWith("schemas/") &&
        !declaredPaths.has(file.relativePath),
    )
  )
    fail("adapter package contains an undeclared schema");
  if (
    options.requireSingleLaunchTarget === true &&
    manifest.launchTargets.length !== 1
  )
    fail("PE-B requires exactly one launch target");
  const launchTargetSelection = resolveProjectAdapterLaunchTargetSelectionV2(
    manifest,
    options.selectedLaunchTargetId,
  );
  const target = launchTargetSelection.defaultTarget;
  if (
    options.expectedMainScene !== undefined &&
    target.scene !==
      ProjectAdapterResourceReferenceV1Schema.parse(options.expectedMainScene)
  )
    fail("adapter default target does not match the realized main scene");
  const schemaById = new Map(schemas.map((value) => [value.schemaId, value]));
  if (options.requireEmptyLaunchParameters === true) {
    for (const launchTarget of manifest.launchTargets) {
      const parameters = schemaById.get(launchTarget.parametersSchemaId);
      if (
        parameters === undefined ||
        !("type" in parameters.root) ||
        parameters.root.type !== "object" ||
        Object.keys(parameters.root.properties).length !== 0 ||
        parameters.root.required.length !== 0 ||
        parameters.root.additionalProperties !== false
      )
        fail(
          `PE-C requires strict empty launch parameters for target ${launchTarget.targetId}`,
        );
    }
  }
  for (const module of options.requiredImplementedModules ??
    PROJECT_ADAPTER_REQUIRED_MODULES_V2) {
    if (
      manifest.modules.modules.find((value) => value.module === module)
        ?.status !== "implemented"
    )
      fail(`required adapter module is not implemented: ${module}`);
  }
  const identity = createHash("sha256");
  for (const file of files)
    identity
      .update(file.relativePath)
      .update("\0")
      .update(file.sha256)
      .update("\0");
  return Object.freeze({
    schemaVersion: 2,
    candidateSha256: identity.digest("hex"),
    manifestSha256: manifestFile.sha256,
    manifest,
    launchTargetSelection,
    schemas: Object.freeze(schemas),
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

export const loadProjectAdapterPackageFilesV2 = (
  input: readonly ProjectAdapterPackageBytesV2[],
  options: ProjectAdapterPackageValidationOptionsV2 = {},
): LoadedProjectAdapterPackageV2 => {
  let totalBytes = 0;
  const files = input.map((file) => {
    assertPath(file.path);
    if (
      !(file.bytes instanceof Uint8Array) ||
      file.bytes.byteLength < 1 ||
      file.bytes.byteLength > PROJECT_ADAPTER_PACKAGE_LIMITS_V1.maximumFileBytes
    )
      fail(`adapter package file bytes are invalid: ${file.path}`);
    totalBytes += file.bytes.byteLength;
    if (totalBytes > PROJECT_ADAPTER_PACKAGE_LIMITS_V1.maximumTotalBytes)
      fail("adapter package total byte limit exceeded");
    const bytes = Uint8Array.from(file.bytes);
    return {
      relativePath: file.path,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  return validateFiles(files, options);
};

const sameIdentity = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

export const loadProjectAdapterPackageV2 = async (
  candidateRoot: string,
  options: ProjectAdapterPackageValidationOptionsV2 = {},
): Promise<LoadedProjectAdapterPackageV2> => {
  const root = resolve(candidateRoot);
  const before = await lstat(root, { bigint: true }).catch(() =>
    fail("adapter package root does not exist"),
  );
  const canonical = await realpath(root).catch(() => "");
  if (!before.isDirectory() || before.isSymbolicLink() || canonical !== root)
    fail("adapter package root must be a canonical non-symlink directory");
  const pending = [""];
  const files: LoadedFileV2[] = [];
  let directories = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    directories += 1;
    if (directories > PROJECT_ADAPTER_PACKAGE_LIMITS_V1.maximumDirectories)
      fail("adapter package directory limit exceeded");
    const absoluteDirectory =
      directory === "" ? canonical : `${canonical}/${directory}`;
    for (const name of (await readdir(absoluteDirectory)).sort()) {
      const relativePath = directory === "" ? name : `${directory}/${name}`;
      const absolutePath = `${canonical}/${relativePath}`;
      const metadata = await lstat(absolutePath, { bigint: true });
      if (metadata.isSymbolicLink())
        fail(`adapter package cannot contain symlinks: ${relativePath}`);
      if (metadata.isDirectory()) {
        ProjectAdapterPackagePathV1Schema.parse(relativePath);
        if (name.startsWith("."))
          fail(`adapter package directory is not allowed: ${relativePath}`);
        pending.push(relativePath);
        continue;
      }
      if (!metadata.isFile())
        fail(`adapter package cannot contain special files: ${relativePath}`);
      assertPath(relativePath);
      if (
        metadata.size >
        BigInt(PROJECT_ADAPTER_PACKAGE_LIMITS_V1.maximumFileBytes)
      )
        fail(`adapter package file exceeds byte limit: ${relativePath}`);
      const canonicalFile = await realpath(absolutePath).catch(() => "");
      if (
        canonicalFile !== absolutePath ||
        !canonicalFile.startsWith(`${canonical}${sep}`)
      )
        fail(`adapter package path escapes root: ${relativePath}`);
      const handle = await open(
        absolutePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || !sameIdentity(metadata, opened))
          fail(
            `adapter package file changed during inspection: ${relativePath}`,
          );
        const bytes = await handle.readFile();
        const after = await handle.stat({ bigint: true });
        if (
          !sameIdentity(opened, after) ||
          BigInt(bytes.byteLength) !== after.size
        )
          fail(`adapter package file changed while reading: ${relativePath}`);
        files.push({
          relativePath,
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } finally {
        await handle.close();
      }
    }
  }
  return validateFiles(files, options);
};

export type LoadedProjectAdapterPackage =
  LoadedProjectAdapterPackageV1 | LoadedProjectAdapterPackageV2;

export const inspectProjectAdapterPackageVersion = (
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
): 1 | 2 => {
  const manifest =
    files.find((file) => file.path === "manifest.json") ??
    fail("adapter package is missing manifest.json");
  const parsed = parseJson(manifest.bytes, "manifest.json");
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object")
    fail("adapter manifest is not an object");
  const version: unknown = (parsed as Record<string, unknown>).schemaVersion;
  if (version !== 1 && version !== 2)
    fail("review_required: adapter manifest version is unsupported");
  return version as 1 | 2;
};
