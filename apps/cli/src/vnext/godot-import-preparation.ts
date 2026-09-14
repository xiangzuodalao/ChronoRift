import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  isGodotImportCachePath,
  stageGodotValidation,
  type GodotValidationOverlayFile,
  type GodotValidationSourceFile,
} from "./godot-validation-stage.js";
import {
  assertInspectionSettingsSafe,
  mergeGodotSettingsOverride,
  readGodotTextSettings,
} from "./godot-settings-overlay.js";
import { collectCsvTranslationOutputs } from "./godot-translation-import.js";
import type {
  SrtCommandResult,
  SrtDuplexHandle,
  SrtGodotRequest,
} from "./srt-sandbox-controller.js";

export interface PrepareGodotImportOptions {
  readonly sourceFiles: readonly GodotValidationSourceFile[];
  readonly overlayFiles: readonly GodotValidationOverlayFile[];
  readonly godotPath: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

/** No new receipt: retain the actual SRT result even if output admission fails. */
export class GodotImportPreparationError extends Error {
  public constructor(
    message: string,
    readonly process: SrtCommandResult | null,
    readonly bootstrapProcess: SrtCommandResult | null = null,
  ) {
    super(message);
  }
}

// Importers and @tool scripts are untrusted. Walk only after the sandbox exits;
// never follow links, read devices, or accept an unbounded generated tree.
const readImportTree = async (
  root: string,
): Promise<GodotValidationSourceFile[]> => {
  const files: GodotValidationSourceFile[] = [];
  let entriesSeen = 0;
  let totalBytes = 0;
  const visit = async (
    path: string,
    relativePath: string,
    depth: number,
  ): Promise<void> => {
    if (++entriesSeen > 16_384 || depth > 64)
      throw new Error("Import output entry/depth budget exceeded");
    const status = await lstat(path);
    if (status.isSymbolicLink())
      throw new Error(
        `Import output contains a symbolic link: ${relativePath}`,
      );
    if (status.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (name.includes("\\"))
          throw new Error("Import output contains an invalid path");
        await visit(
          join(path, name),
          relativePath ? `${relativePath}/${name}` : name,
          depth + 1,
        );
      }
      return;
    }
    if (!status.isFile() || status.nlink !== 1)
      throw new Error(
        `Import output is not an ordinary unlinked file: ${relativePath}`,
      );
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const pinned = await handle.stat();
      if (
        !pinned.isFile() ||
        pinned.nlink !== 1 ||
        pinned.ino !== status.ino ||
        pinned.dev !== status.dev
      )
        throw new Error(
          `Import output changed during admission: ${relativePath}`,
        );
      totalBytes += pinned.size;
      if (pinned.size > 64 * 1024 * 1024 || totalBytes > 256 * 1024 * 1024)
        throw new Error("Import output byte budget exceeded");
      const bytes = Buffer.alloc(pinned.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(
          bytes,
          length,
          bytes.length - length,
          length,
        );
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      const after = await handle.stat();
      if (
        length !== pinned.size ||
        after.size !== pinned.size ||
        after.mtimeMs !== pinned.mtimeMs ||
        after.ctimeMs !== pinned.ctimeMs
      )
        throw new Error(
          `Import output changed during admission: ${relativePath}`,
        );
      files.push({
        relativePath,
        bytes: bytes.subarray(0, length),
        executable: (pinned.mode & 0o111) !== 0,
      });
    } finally {
      await handle.close();
    }
  };
  await visit(root, "", 0);
  return files;
};

/** Admit only source-bound metadata and the small set of runtime import caches. */
export const collectGodotImportOutputs = async (
  projectPath: string,
  before: readonly GodotValidationSourceFile[],
): Promise<{
  sourceFiles: GodotValidationSourceFile[];
  importCacheFiles: GodotValidationOverlayFile[];
}> => {
  const originals = new Map(before.map((file) => [file.relativePath, file]));
  const isMetadata = (path: string): boolean => {
    const suffix = path.endsWith(".import")
      ? ".import"
      : path.endsWith(".uid")
        ? ".uid"
        : null;
    if (suffix === null) return false;
    const base = path.slice(0, -suffix.length);
    return (
      originals.has(base) &&
      !base.endsWith(".import") &&
      !base.endsWith(".uid") &&
      (suffix === ".import" || /\.(?:gd|gdshader|gdshaderinc)$/u.test(base))
    );
  };
  const after = await readImportTree(projectPath);
  const translations = collectCsvTranslationOutputs(before, after);
  const present = new Set(after.map((file) => file.relativePath));
  for (const file of before) {
    if (!present.has(file.relativePath))
      throw new Error(`Import deleted source: ${file.relativePath}`);
  }
  const sourceFiles: GodotValidationSourceFile[] = [];
  const importCacheFiles: GodotValidationOverlayFile[] = [];
  for (const file of after) {
    const path = file.relativePath;
    if (path.startsWith(".godot/")) {
      if (isGodotImportCachePath(path)) {
        if (file.executable)
          throw new Error(`Executable import cache: ${path}`);
        importCacheFiles.push(file);
      }
      // Editor layout, locks and logs are not runtime import inputs.
      continue;
    }
    const original = originals.get(path);
    if (isMetadata(path)) {
      if (file.executable)
        throw new Error(`Executable import metadata: ${path}`);
    } else if (translations.has(path)) {
      // Validated native CSV product; existing products also require original declarations.
    } else if (
      original === undefined ||
      original.executable !== file.executable ||
      !Buffer.from(original.bytes).equals(file.bytes)
    ) {
      throw new Error(`Import changed or added ordinary source: ${path}`);
    }
    sourceFiles.push(file);
  }
  return { sourceFiles, importCacheFiles };
};

const IMPORT_SCENE = "addons/chronorift_project_environment/import.tscn";
const IMPORT_SETTINGS = Buffer.from(
  "[editor_plugins]\nenabled=PackedStringArray()\n[internationalization]\nlocale/translations=PackedStringArray()\n",
);
const importErrors = (stderr: string): string[] =>
  stderr
    .replace(/\u001b\[[0-9;]*m/gu, "")
    .split("\n")
    .filter((line) => /^(?:SCRIPT )?ERROR:/u.test(line));

export const prepareGodotImport = async (
  host: {
    readonly candidateWorkspace: string;
    readonly validationRoot: string;
    readonly openImport: (request: SrtGodotRequest) => Promise<SrtDuplexHandle>;
  },
  input: PrepareGodotImportOptions,
) => {
  const deadline = performance.now() + input.timeoutMs;
  const candidateWorkspace = await realpath(host.candidateWorkspace);
  await mkdir(host.validationRoot, { recursive: true, mode: 0o700 });
  // Native resource preparation does not run editor UI plugins. Custom importers
  // need a separate supported lifecycle; never silently omit a declared one.
  if (
    input.sourceFiles.some(
      (file) =>
        file.relativePath.endsWith(".gd") &&
        /\b(?:EditorImportPlugin|add_import_plugin)\b/u.test(
          Buffer.from(file.bytes).toString("utf8"),
        ),
    )
  )
    throw new Error(
      "EditorImportPlugin resource import is not supported by native preparation",
    );
  if (input.sourceFiles.some((file) => file.relativePath === IMPORT_SCENE))
    throw new Error("Candidate occupies the Host-managed import scene");
  const settings = input.sourceFiles
    .filter((file) =>
      ["project.godot", "override.cfg"].includes(file.relativePath),
    )
    .flatMap((file) => readGodotTextSettings(file.bytes));
  assertInspectionSettingsSafe(settings);
  const stage = await stageGodotValidation({
    candidateWorkspace,
    stageRoot: join(host.validationRoot, `import-${randomUUID()}`),
    sourceFiles: input.sourceFiles,
    overlayFiles: input.overlayFiles,
  });
  let process: SrtCommandResult | null = null;
  let bootstrapProcess: SrtCommandResult | null = null;
  let failureMessage: string | undefined;
  try {
    const runtimeSource = await readImportTree(stage.projectStagePath);
    const runtimeProject = runtimeSource.find(
      (file) => file.relativePath === "project.godot",
    );
    if (!runtimeProject)
      throw new Error("Import source requires project.godot");
    // Editor startup ignores override.cfg on supported Godot versions.
    await writeFile(
      join(stage.projectStagePath, "project.godot"),
      mergeGodotSettingsOverride(
        runtimeProject.bytes,
        IMPORT_SETTINGS,
        settings,
      ),
    );
    const runtimeOverride = runtimeSource.find(
      (file) => file.relativePath === "override.cfg",
    );
    // These settings and the empty editor scene exist only in the disposable
    // import copy. Returned runtime source retains the exact original settings.
    await writeFile(
      join(stage.projectStagePath, "override.cfg"),
      mergeGodotSettingsOverride(
        runtimeOverride?.bytes,
        IMPORT_SETTINGS,
        settings,
      ),
      { mode: 0o600 },
    );
    await mkdir(dirname(join(stage.projectStagePath, IMPORT_SCENE)), {
      recursive: true,
    });
    await writeFile(
      join(stage.projectStagePath, IMPORT_SCENE),
      '[gd_scene format=3]\n[node name="Import" type="Node"]\n',
      { flag: "wx", mode: 0o600 },
    );
    const before = await readImportTree(stage.projectStagePath);
    const run = async (): Promise<SrtCommandResult> => {
      input.signal?.throwIfAborted();
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0)
        throw new Error("Godot import preparation exhausted its time budget");
      const handle = await host.openImport({
        argv: [
          input.godotPath,
          "--headless",
          "--path",
          stage.projectStagePath,
          "--editor",
          "--import",
          `res://${IMPORT_SCENE}`,
        ],
        cwd: stage.projectStagePath,
        projectStagePath: stage.projectStagePath,
        mutableWorkspacePath: candidateWorkspace,
        homePath: stage.homePath,
        tempPath: stage.tempPath,
        artifactsPath: stage.artifactsPath,
        readOnlyPaths: [dirname(input.godotPath)],
        timeoutMs: remaining,
        signal: input.signal,
      });
      handle.stdin.on("error", () => undefined);
      handle.stdin.end();
      const result = await handle.wait();
      process = result;
      if (
        result.exitCode !== 0 ||
        result.signal !== null ||
        result.timedOut ||
        result.cancelled
      )
        throw new Error("Godot import did not exit successfully");
      if (result.stderrTruncated)
        throw new Error("Godot import reported errors or incomplete stderr");
      return result;
    };
    process = await run();
    let outputs = await collectGodotImportOutputs(
      stage.projectStagePath,
      before,
    );
    const errors = importErrors(process.stderr);
    // Godot 4.2 can consult @icon editor metadata before its first asset scan.
    // Only this precise cold-cache diagnostic permits one verification pass,
    // after all source/output integrity checks, within the original deadline.
    if (
      errors.length > 0 &&
      errors.every((line) =>
        /^ERROR: Missing required editor-specific import metadata for a texture \(please reimport it using the 'Import' tab\): 'res:\/\/\.godot\/imported\/[^'\r\n]+\.editor\.meta'$/u.test(
          line,
        ),
      )
    ) {
      bootstrapProcess = process;
      process = await run();
      outputs = await collectGodotImportOutputs(stage.projectStagePath, before);
    }
    if (importErrors(process.stderr).length > 0)
      throw new Error("Godot import reported errors or incomplete stderr");
    input.signal?.throwIfAborted();
    const sourceFiles = outputs.sourceFiles.flatMap((file) => {
      if (file.relativePath === IMPORT_SCENE) return [];
      if (file.relativePath === "project.godot") return [runtimeProject];
      if (file.relativePath === "override.cfg")
        return runtimeOverride ? [runtimeOverride] : [];
      return [file];
    });
    return {
      sourceFiles,
      importCacheFiles: outputs.importCacheFiles,
      process,
      bootstrapProcess,
    };
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
    throw new GodotImportPreparationError(
      failureMessage,
      process,
      bootstrapProcess,
    );
  } finally {
    try {
      await stage.cleanup();
    } catch (error) {
      throw new GodotImportPreparationError(
        [
          failureMessage,
          `Godot import cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        ]
          .filter(Boolean)
          .join("; "),
        process,
        bootstrapProcess,
      );
    }
  }
};
