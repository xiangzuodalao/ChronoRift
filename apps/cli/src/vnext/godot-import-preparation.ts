import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  isGodotImportCachePath,
  stageGodotValidation,
  type GodotValidationOverlayFile,
  type GodotValidationSourceFile,
} from "./godot-validation-stage.js";
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

export const prepareGodotImport = async (
  host: {
    readonly candidateWorkspace: string;
    readonly validationRoot: string;
    readonly openImport: (request: SrtGodotRequest) => Promise<SrtDuplexHandle>;
  },
  input: PrepareGodotImportOptions,
) => {
  const candidateWorkspace = await realpath(host.candidateWorkspace);
  await mkdir(host.validationRoot, { recursive: true, mode: 0o700 });
  const stage = await stageGodotValidation({
    candidateWorkspace,
    stageRoot: join(host.validationRoot, `import-${randomUUID()}`),
    sourceFiles: input.sourceFiles,
    overlayFiles: input.overlayFiles,
  });
  let process: SrtCommandResult | null = null;
  try {
    const before = await readImportTree(stage.projectStagePath);
    input.signal?.throwIfAborted();
    const handle = await host.openImport({
      argv: [
        input.godotPath,
        "--headless",
        "--path",
        stage.projectStagePath,
        "--editor",
        "--import",
      ],
      cwd: stage.projectStagePath,
      projectStagePath: stage.projectStagePath,
      mutableWorkspacePath: candidateWorkspace,
      homePath: stage.homePath,
      tempPath: stage.tempPath,
      artifactsPath: stage.artifactsPath,
      readOnlyPaths: [dirname(input.godotPath)],
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    handle.stdin.on("error", () => undefined);
    handle.stdin.end();
    process = await handle.wait();
    if (
      process.exitCode !== 0 ||
      process.signal !== null ||
      process.timedOut ||
      process.cancelled
    )
      throw new Error("Godot import did not exit successfully");
    // Godot can return 0 despite import/script errors. Keep the log and fail closed.
    if (
      process.stderrTruncated ||
      /(?:^|\n)(?:\u001b\[[0-9;]*m)*(?:SCRIPT )?ERROR:/u.test(process.stderr)
    )
      throw new Error("Godot import reported errors or incomplete stderr");
    const outputs = await collectGodotImportOutputs(
      stage.projectStagePath,
      before,
    );
    input.signal?.throwIfAborted();
    return { ...outputs, process };
  } catch (error) {
    throw new GodotImportPreparationError(
      error instanceof Error ? error.message : String(error),
      process,
    );
  } finally {
    await stage.cleanup();
  }
};
