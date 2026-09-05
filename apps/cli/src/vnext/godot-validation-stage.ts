import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
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

const EXCLUDED_SOURCE_ENTRIES = new Set([".git", ".godot", ".chronorift"]);
const HASH_EXCLUDED_ENTRIES = new Set([".godot"]);

export interface GodotValidationOverlayFile {
  /** Normalized project-relative POSIX path. */
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

/** Ordinary files read through the Host's pinned source-admission handles. */
export interface GodotValidationSourceFile extends GodotValidationOverlayFile {
  readonly executable: boolean;
}

export interface GodotValidationSourceCheck {
  readonly observedSourceSha256: string;
  readonly sourceUnchanged: boolean;
}

export interface GodotValidationStage {
  readonly stageRoot: string;
  /** Read-only project root; pass directly to SRT as `projectStagePath`. */
  readonly projectStagePath: string;
  /** The only writable directory below `projectStagePath`. */
  readonly godotCachePath: string;
  readonly homePath: string;
  readonly tempPath: string;
  readonly artifactsPath: string;
  /** Hash of the copied source plus managed overlays, excluding `.godot`. */
  readonly sourceSha256: string;
  verifySourceUnchanged(): Promise<GodotValidationSourceCheck>;
  cleanup(): Promise<void>;
}

export interface StageGodotValidationOptions {
  readonly candidateWorkspace: string;
  /** Must be an absolute path that does not already exist. */
  readonly stageRoot: string;
  readonly overlayFiles?: readonly GodotValidationOverlayFile[] | undefined;
  /** If supplied, stage exactly this snapshot without rereading mutable source. */
  readonly sourceFiles?: readonly GodotValidationSourceFile[] | undefined;
  /** Validated outputs of a completed disposable import, never candidate cache. */
  readonly importCacheFiles?: readonly GodotValidationOverlayFile[] | undefined;
}

export const isGodotImportCachePath = (path: string): boolean =>
  !path.includes("\\") &&
  !path.includes("\0") &&
  !path
    .split("/")
    .some((part) => part === "" || part === "." || part === "..") &&
  (path.startsWith(".godot/imported/") ||
    path === ".godot/global_script_class_cache.cfg" ||
    path === ".godot/uid_cache.bin");

const compareNames = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isWithin = (parent: string, candidate: string): boolean => {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!isAbsolute(pathFromParent) &&
      pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`))
  );
};

const assertAbsolutePath = (path: string, label: string): void => {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new TypeError(`${label} must be an absolute path without NUL bytes`);
  }
};

const assertRealDirectory = async (
  path: string,
  label: string,
): Promise<string> => {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return realpath(path);
};

const assertOverlayPath = (path: string): readonly string[] => {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path)
  ) {
    throw new TypeError(
      `overlay path must be a normalized relative path: ${path}`,
    );
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment === ".git" ||
        segment === ".godot",
    )
  ) {
    throw new TypeError(
      `overlay path must stay inside project source: ${path}`,
    );
  }
  const isManagedOverlay =
    path === "override.cfg" ||
    (segments.length >= 3 &&
      segments[0] === "addons" &&
      segments[1] === "chronorift_project_environment") ||
    (segments.length >= 3 &&
      segments[0] === "addons" &&
      segments[1] === "chronorift_inspection") ||
    (segments.length >= 3 &&
      segments[0] === ".chronorift" &&
      segments[1] === "project-adapter");
  if (!isManagedOverlay) {
    throw new TypeError(
      `overlay path must target a Host-managed runtime file: ${path}`,
    );
  }
  return segments;
};

const copySourceDirectory = async (
  sourceDirectory: string,
  targetDirectory: string,
): Promise<void> => {
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  entries.sort((left, right) => compareNames(left.name, right.name));

  for (const entry of entries) {
    if (EXCLUDED_SOURCE_ENTRIES.has(entry.name)) continue;
    const sourcePath = join(sourceDirectory, entry.name);
    const targetPath = join(targetDirectory, entry.name);
    const status = await lstat(sourcePath);
    if (status.isSymbolicLink()) {
      throw new Error(
        `candidate source contains a symbolic link: ${sourcePath}`,
      );
    }
    if (status.isDirectory()) {
      await mkdir(targetPath);
      await copySourceDirectory(sourcePath, targetPath);
      continue;
    }
    if (!status.isFile()) {
      throw new Error(
        `candidate source contains a special file: ${sourcePath}`,
      );
    }
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, status.mode & 0o777);
  }
};

const validateSnapshotPaths = (
  files: readonly GodotValidationSourceFile[],
): void => {
  const seen = new Set<string>();
  for (const file of files) {
    const path = file.relativePath;
    if (
      isAbsolute(path) ||
      path.includes("\\") ||
      path.includes("\0") ||
      path
        .split("/")
        .some(
          (segment) =>
            segment.length === 0 ||
            segment === "." ||
            segment === ".." ||
            EXCLUDED_SOURCE_ENTRIES.has(segment),
        ) ||
      seen.has(path)
    )
      throw new TypeError(
        `source snapshot path must be a unique ordinary project-relative file: ${path}`,
      );
    seen.add(path);
  }
};

const writeSourceSnapshot = async (
  projectPath: string,
  files: readonly GodotValidationSourceFile[],
): Promise<void> => {
  for (const file of files) {
    const target = join(projectPath, file.relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes, {
      flag: "wx",
      mode: file.executable ? 0o700 : 0o600,
    });
  }
};

const hashSourceTree = async (projectPath: string): Promise<string> => {
  const hash = createHash("sha256");

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      if (HASH_EXCLUDED_ENTRIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const status = await lstat(path);
      if (status.isSymbolicLink()) {
        throw new Error(`validation source contains a symbolic link: ${path}`);
      }
      if (status.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!status.isFile()) {
        throw new Error(`validation source contains a special file: ${path}`);
      }
      hash.update(relative(projectPath, path).split(sep).join("/"));
      hash.update("\0");
      hash.update(await readFile(path));
      hash.update("\0");
    }
  };

  await visit(projectPath);
  return hash.digest("hex");
};

const writeOverlays = async (
  projectPath: string,
  overlayFiles: readonly GodotValidationOverlayFile[],
): Promise<void> => {
  const seen = new Set<string>();
  for (const overlay of overlayFiles) {
    const segments = assertOverlayPath(overlay.relativePath);
    if (seen.has(overlay.relativePath)) {
      throw new TypeError(`duplicate overlay path: ${overlay.relativePath}`);
    }
    seen.add(overlay.relativePath);
    const target = join(projectPath, ...segments);
    if (!isWithin(projectPath, target)) {
      throw new TypeError(
        `overlay path escapes project source: ${overlay.relativePath}`,
      );
    }
    await mkdir(dirname(target), { recursive: true });
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(
          `overlay target must be a regular file: ${overlay.relativePath}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(target, overlay.bytes, { mode: 0o600 });
  }
};

export const stageGodotValidation = async (
  options: StageGodotValidationOptions,
): Promise<GodotValidationStage> => {
  assertAbsolutePath(options.candidateWorkspace, "candidateWorkspace");
  assertAbsolutePath(options.stageRoot, "stageRoot");

  const candidateWorkspace = await assertRealDirectory(
    resolve(options.candidateWorkspace),
    "candidateWorkspace",
  );
  const requestedStageRoot = resolve(options.stageRoot);
  const stageParent = await assertRealDirectory(
    dirname(requestedStageRoot),
    "stageRoot parent",
  );
  const stageRoot = join(stageParent, basename(requestedStageRoot));
  if (
    isWithin(candidateWorkspace, stageRoot) ||
    isWithin(stageRoot, candidateWorkspace)
  ) {
    throw new Error("candidateWorkspace and stageRoot must be disjoint");
  }

  const overlayFiles = options.overlayFiles ?? [];
  // Validate every caller-controlled path before creating the stage.
  for (const overlay of overlayFiles) assertOverlayPath(overlay.relativePath);
  if (options.sourceFiles !== undefined)
    validateSnapshotPaths(options.sourceFiles);
  const cacheFiles = options.importCacheFiles ?? [];
  if (
    cacheFiles.some((file) => !isGodotImportCachePath(file.relativePath)) ||
    new Set(cacheFiles.map((file) => file.relativePath)).size !==
      cacheFiles.length
  )
    throw new TypeError(
      "import cache must contain unique supported .godot paths",
    );

  let stageCreated = false;
  try {
    await mkdir(stageRoot, { mode: 0o700 });
    stageCreated = true;
    const projectStagePath = join(stageRoot, "project");
    const godotCachePath = join(projectStagePath, ".godot");
    const homePath = join(stageRoot, "home");
    const tempPath = join(stageRoot, "tmp");
    const artifactsPath = join(stageRoot, "artifacts");

    await mkdir(projectStagePath);
    if (options.sourceFiles === undefined)
      await copySourceDirectory(candidateWorkspace, projectStagePath);
    else await writeSourceSnapshot(projectStagePath, options.sourceFiles);
    if (
      overlayFiles.some((file) =>
        file.relativePath.startsWith("addons/chronorift_inspection/"),
      )
    ) {
      for (const reserved of ["override.cfg", "addons/chronorift_inspection"]) {
        try {
          await lstat(join(projectStagePath, reserved));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        throw new Error(
          `candidate source occupies Host-managed inspection path: ${reserved}`,
        );
      }
    }
    await writeOverlays(projectStagePath, overlayFiles);
    await Promise.all(
      [godotCachePath, homePath, tempPath, artifactsPath].map(async (path) =>
        mkdir(path, { mode: 0o700 }),
      ),
    );
    for (const file of cacheFiles) {
      const target = join(projectStagePath, file.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes, { flag: "wx", mode: 0o600 });
    }
    const sourceSha256 = await hashSourceTree(projectStagePath);

    return {
      stageRoot,
      projectStagePath,
      godotCachePath,
      homePath,
      tempPath,
      artifactsPath,
      sourceSha256,
      async verifySourceUnchanged(): Promise<GodotValidationSourceCheck> {
        const observedSourceSha256 = await hashSourceTree(projectStagePath);
        return {
          observedSourceSha256,
          sourceUnchanged: observedSourceSha256 === sourceSha256,
        };
      },
      cleanup: () => rm(stageRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    if (stageCreated) {
      await rm(stageRoot, { recursive: true, force: true });
    }
    throw error;
  }
};
