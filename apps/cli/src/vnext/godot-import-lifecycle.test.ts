import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GodotImportPreparationError,
  prepareGodotImport,
} from "./godot-import-preparation.js";
import * as stages from "./godot-validation-stage.js";
import type {
  SrtCommandResult,
  SrtGodotRequest,
} from "./srt-sandbox-controller.js";

const complete: SrtCommandResult = {
  status: "exited",
  exitCode: 0,
  signal: null,
  stdout: "actual final import output",
  stderr: "",
  timedOut: false,
  cancelled: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 1,
};
const bootstrap: SrtCommandResult = {
  ...complete,
  stdout: "actual bootstrap output",
  stderr:
    "ERROR: Missing required editor-specific import metadata for a texture (please reimport it using the 'Import' tab): 'res://.godot/imported/icon.editor.meta'\n",
};
const project = Buffer.from(
  'config_version=5\n[application]\nconfig/name="Original"\n[editor_plugins]\nenabled=PackedStringArray("res://plugin.cfg")\n',
);

describe("Godot import lifecycle boundaries", () => {
  let root: string;
  let candidate: string;
  let requests: SrtGodotRequest[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chronorift-import-lifecycle-"));
    candidate = join(root, "candidate");
    await mkdir(candidate);
    requests = [];
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  const prepare = (
    imported: (
      request: SrtGodotRequest,
      attempt: number,
    ) => Promise<SrtCommandResult> = async () => complete,
  ) =>
    prepareGodotImport(
      {
        candidateWorkspace: candidate,
        validationRoot: join(root, "stages"),
        openImport: async (request) => {
          requests.push(request);
          const result = await imported(request, requests.length);
          return {
            pid: 1,
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            wait: async () => result,
            stop: async () => result,
          };
        },
      },
      {
        sourceFiles: [
          { relativePath: "project.godot", bytes: project, executable: false },
          {
            relativePath: "main.gd",
            bytes: Buffer.from("extends Node\n"),
            executable: false,
          },
        ],
        overlayFiles: [],
        godotPath: "/opt/godot",
        timeoutMs: 1_000,
      },
    );

  it("restores exact project settings and removes an import-only override absent from runtime source", async () => {
    const result = await prepare(async (request) => {
      const temporary = await readFile(
        join(request.projectStagePath, "project.godot"),
        "utf8",
      );
      expect(temporary.startsWith(project.toString())).toBe(true);
      expect(temporary).toContain("enabled=PackedStringArray()");
      expect(temporary).toContain("locale/translations=PackedStringArray()");
      expect(
        await readFile(join(request.projectStagePath, "override.cfg"), "utf8"),
      ).toContain("enabled=PackedStringArray()");
      return complete;
    });
    expect(
      result.sourceFiles.find((file) => file.relativePath === "project.godot")
        ?.bytes,
    ).toEqual(project);
    expect(result.sourceFiles.map((file) => file.relativePath)).toEqual([
      "main.gd",
      "project.godot",
    ]);
  });

  it("rejects changed temporary project settings before restoring the originals", async () => {
    await expect(
      prepare(async (request) => {
        await writeFile(
          join(request.projectStagePath, "project.godot"),
          "config_version=5\n",
        );
        return complete;
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "ordinary source: project.godot",
      ) as unknown,
      process: complete,
    });
  });

  it("rechecks source integrity after bootstrap and preserves both actual process results", async () => {
    await expect(
      prepare(async (request, attempt) => {
        if (attempt === 1) return bootstrap;
        await writeFile(join(request.projectStagePath, "main.gd"), "tampered");
        return complete;
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("ordinary source: main.gd") as unknown,
      process: complete,
      bootstrapProcess: bootstrap,
    });
    expect(requests).toHaveLength(2);
  });

  it("does not start a bootstrap verification once the original deadline is exhausted", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await expect(
      prepare(async () => {
        now = 1_000;
        return bootstrap;
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("exhausted its time budget") as unknown,
      process: bootstrap,
      bootstrapProcess: bootstrap,
    });
    expect(requests).toHaveLength(1);
  });

  it.each([false, true])(
    "preserves import evidence and the primary failure when cleanup fails (source changed: %s)",
    async (tamper) => {
      const stage = stages.stageGodotValidation;
      vi.spyOn(stages, "stageGodotValidation").mockImplementation(
        async (options) => ({
          ...(await stage(options)),
          cleanup: async () => {
            throw new Error("simulated cleanup I/O failure");
          },
        }),
      );
      let caught: unknown;
      try {
        await prepare(async (request, attempt) => {
          if (attempt === 1) return bootstrap;
          if (tamper)
            await writeFile(
              join(request.projectStagePath, "main.gd"),
              "tampered",
            );
          return complete;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GodotImportPreparationError);
      expect(caught).toMatchObject({
        message: expect.stringContaining(
          "simulated cleanup I/O failure",
        ) as unknown,
        process: complete,
        bootstrapProcess: bootstrap,
      });
      if (tamper)
        expect((caught as Error).message).toContain("ordinary source: main.gd");
    },
  );
});
