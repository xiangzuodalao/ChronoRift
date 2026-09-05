import { execFileSync } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GodotImportPreparationError,
  prepareGodotImport,
} from "./godot-import-preparation.js";
import type {
  SrtCommandResult,
  SrtGodotRequest,
} from "./srt-sandbox-controller.js";

describe("disposable Godot import preparation", () => {
  let root: string;
  let candidate: string;
  let lastRequest: SrtGodotRequest | undefined;
  const result: SrtCommandResult = {
    status: "exited",
    exitCode: 0,
    signal: null,
    stdout: "actual import output",
    stderr: "",
    timedOut: false,
    cancelled: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chronorift-import-test-"));
    candidate = join(root, "candidate");
    await mkdir(candidate);
    await writeFile(
      join(candidate, "host-secret"),
      "must not reread candidate",
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const prepare = async (
    mutate: (path: string) => Promise<void> = async () => {},
    processResult = result,
    signal?: AbortSignal,
  ) =>
    prepareGodotImport(
      {
        candidateWorkspace: candidate,
        validationRoot: join(root, "stages"),
        openImport: async (request) => {
          lastRequest = request;
          await mutate(request.projectStagePath);
          return {
            pid: 1,
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            wait: async () => processResult,
            stop: async () => processResult,
          };
        },
      },
      {
        sourceFiles: [
          {
            relativePath: "project.godot",
            bytes: Buffer.from("config_version=5\n"),
            executable: false,
          },
          {
            relativePath: "main.gd",
            bytes: Buffer.from("extends Node\n"),
            executable: false,
          },
          {
            relativePath: "assets/icon.svg",
            bytes: Buffer.from("<svg/>"),
            executable: false,
          },
          {
            relativePath: "assets/icon.svg.import",
            bytes: Buffer.from("original metadata"),
            executable: false,
          },
        ],
        overlayFiles: [
          { relativePath: "override.cfg", bytes: Buffer.from("[autoload]\n") },
        ],
        godotPath: "/opt/godot",
        timeoutMs: 1000,
        signal,
      },
    );
  const put = async (root: string, path: string, bytes: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  };

  it("pins source, accepts related metadata and runtime caches, discards editor state, and removes the import copy", async () => {
    const prepared = await prepare(async (path) => {
      await put(path, "assets/icon.svg.import", "updated metadata");
      await put(path, "main.gd.uid", "uid://b123\n");
      await put(path, ".godot/imported/icon.ctex", "texture bytes");
      await put(path, ".godot/uid_cache.bin", "uid cache");
      await put(path, ".godot/global_script_class_cache.cfg", "class cache");
      await put(path, ".godot/editor/layout.cfg", "do not promote");
      await writeFile(join(candidate, "main.gd"), "later candidate edit");
    });
    expect(prepared.process).toEqual(result);
    expect(prepared.sourceFiles.map((f) => f.relativePath)).toEqual([
      "assets/icon.svg",
      "assets/icon.svg.import",
      "main.gd",
      "main.gd.uid",
      "override.cfg",
      "project.godot",
    ]);
    expect(
      prepared.sourceFiles
        .find((f) => f.relativePath === "main.gd")
        ?.bytes.toString(),
    ).toBe("extends Node\n");
    expect(prepared.importCacheFiles.map((f) => f.relativePath)).toEqual([
      ".godot/global_script_class_cache.cfg",
      ".godot/imported/icon.ctex",
      ".godot/uid_cache.bin",
    ]);
    expect(lastRequest?.mutableWorkspacePath).toBe(candidate);
    expect(lastRequest?.projectStagePath).not.toBe(candidate);
    expect(await readdir(join(root, "stages"))).toEqual([]);
    expect(await readFile(join(candidate, "main.gd"), "utf8")).toBe(
      "later candidate edit",
    );
  });

  it.each([
    "source-edit",
    "source-delete",
    "source-mode",
    "new-script",
    "overlay-edit",
    "orphan-import",
    "orphan-uid",
    "source-symlink",
    "cache-symlink",
    "directory-symlink",
    "hardlink",
    "fifo",
    "oversize-cache",
    "executable-cache",
  ])(
    "rejects %s and keeps the actual import output on the error",
    async (mode) => {
      const mutate = async (path: string) => {
        switch (mode) {
          case "source-edit":
            await put(path, "main.gd", "tampered");
            break;
          case "source-delete":
            await rm(join(path, "main.gd"));
            break;
          case "source-mode":
            await chmod(join(path, "main.gd"), 0o700);
            break;
          case "new-script":
            await put(path, "extra.gd", "extends Node");
            break;
          case "overlay-edit":
            await put(path, "override.cfg", "tampered");
            break;
          case "orphan-import":
            await put(path, "other.png.import", "metadata");
            break;
          case "orphan-uid":
            await put(path, "other.gd.uid", "uid://x");
            break;
          case "source-symlink":
            await rm(join(path, "main.gd"));
            await symlink(
              join(candidate, "host-secret"),
              join(path, "main.gd"),
            );
            break;
          case "cache-symlink":
            await symlink(
              join(candidate, "host-secret"),
              join(path, ".godot/linked"),
            );
            break;
          case "directory-symlink":
            await symlink(candidate, join(path, ".godot/editor"));
            break;
          case "hardlink":
            await link(join(path, "main.gd"), join(path, "main.gd.uid"));
            break;
          case "fifo":
            execFileSync("mkfifo", [join(path, ".godot/pipe")]);
            break;
          case "oversize-cache":
            await put(path, ".godot/imported/large.ctex", "");
            await truncate(
              join(path, ".godot/imported/large.ctex"),
              64 * 1024 * 1024 + 1,
            );
            break;
          case "executable-cache":
            await put(path, ".godot/imported/tool", "executable");
            await chmod(join(path, ".godot/imported/tool"), 0o700);
            break;
        }
      };
      let error: unknown;
      try {
        await prepare(mutate);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GodotImportPreparationError);
      expect((error as GodotImportPreparationError).process).toEqual(result);
      expect(await readdir(join(root, "stages"))).toEqual([]);
    },
  );

  it.each([
    { ...result, exitCode: 1 },
    { ...result, status: "timed_out" as const, exitCode: null, timedOut: true },
    {
      ...result,
      status: "cancelled" as const,
      exitCode: null,
      cancelled: true,
    },
    { ...result, stderr: "ERROR: failed to import texture\n" },
    { ...result, stderr: "SCRIPT ERROR: tool script failed\n" },
    { ...result, stderrTruncated: true },
  ])(
    "does not promote an unsuccessful or incomplete import %j",
    async (failed) => {
      await expect(prepare(undefined, failed)).rejects.toMatchObject({
        process: failed,
      });
      expect(await readdir(join(root, "stages"))).toEqual([]);
    },
  );

  it("does not promote outputs after cancellation, even if import exited 0", async () => {
    const abort = new AbortController();
    await expect(
      prepare(async () => abort.abort(), result, abort.signal),
    ).rejects.toMatchObject({ process: result });
    expect(await readdir(join(root, "stages"))).toEqual([]);
  });
});
