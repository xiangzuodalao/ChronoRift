import { createServer, type Server } from "node:net";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stageGodotValidation } from "./godot-validation-stage.js";
import { SrtGodotRunner } from "./srt-godot-runner.js";
import type {
  SrtCommandResult,
  SrtDuplexHandle,
  SrtGodotRequest,
} from "./srt-sandbox-controller.js";

describe("stageGodotValidation", () => {
  let root: string;
  let candidateWorkspace: string;
  const servers: Server[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chronorift-godot-stage-"));
    candidateWorkspace = join(root, "candidate");
    await mkdir(join(candidateWorkspace, "scenes"), { recursive: true });
    await writeFile(
      join(candidateWorkspace, "project.godot"),
      "[application]\n",
    );
    await writeFile(
      join(candidateWorkspace, "scenes", "main.gd"),
      "extends Node\n",
    );
  });

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    await rm(root, { recursive: true, force: true });
  });

  it("copies source, skips product state, applies overlays, and creates SRT paths", async () => {
    await Promise.all([
      mkdir(join(candidateWorkspace, ".git")),
      mkdir(join(candidateWorkspace, ".godot")),
      mkdir(join(candidateWorkspace, ".chronorift")),
    ]);
    await Promise.all([
      writeFile(join(candidateWorkspace, ".git", "config"), "secret"),
      writeFile(join(candidateWorkspace, ".godot", "cache"), "generated"),
      writeFile(join(candidateWorkspace, ".chronorift", "state"), "private"),
    ]);

    const stage = await stageGodotValidation({
      candidateWorkspace,
      stageRoot: join(root, "run"),
      overlayFiles: [
        {
          relativePath: "override.cfg",
          bytes: Buffer.from("[autoload]\n"),
        },
        {
          relativePath: "addons/chronorift_project_environment/plugin.cfg",
          bytes: Buffer.from("[plugin]\n"),
        },
        {
          relativePath: "addons/chronorift_inspection/observer.gd",
          bytes: Buffer.from("extends Node\n"),
        },
        {
          relativePath: ".chronorift/project-adapter/manifest.json",
          bytes: Buffer.from("{}\n"),
        },
      ],
    });

    await expect(
      readFile(join(stage.projectStagePath, "scenes/main.gd"), "utf8"),
    ).resolves.toBe("extends Node\n");
    await expect(
      readFile(join(stage.projectStagePath, "override.cfg"), "utf8"),
    ).resolves.toBe("[autoload]\n");
    await expect(
      readFile(
        join(
          stage.projectStagePath,
          "addons/chronorift_project_environment/plugin.cfg",
        ),
        "utf8",
      ),
    ).resolves.toBe("[plugin]\n");
    await expect(
      readFile(
        join(
          stage.projectStagePath,
          "addons/chronorift_inspection/observer.gd",
        ),
        "utf8",
      ),
    ).resolves.toBe("extends Node\n");
    await expect(
      readFile(
        join(
          stage.projectStagePath,
          ".chronorift/project-adapter/manifest.json",
        ),
        "utf8",
      ),
    ).resolves.toBe("{}\n");
    await expect(
      lstat(join(stage.projectStagePath, ".git")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(join(stage.projectStagePath, ".chronorift", "state")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const path of [
      stage.godotCachePath,
      stage.homePath,
      stage.tempPath,
      stage.artifactsPath,
    ]) {
      expect((await lstat(path)).isDirectory()).toBe(true);
    }

    await writeFile(join(stage.godotCachePath, "generated.cache"), "ignored");
    await writeFile(join(stage.homePath, "user-data"), "ignored");
    await expect(stage.verifySourceUnchanged()).resolves.toEqual({
      observedSourceSha256: stage.sourceSha256,
      sourceUnchanged: true,
    });
    await writeFile(
      join(stage.projectStagePath, ".chronorift", "unexpected"),
      "x",
    );
    await expect(stage.verifySourceUnchanged()).resolves.toMatchObject({
      sourceUnchanged: false,
    });
    await stage.cleanup();
    await expect(lstat(stage.stageRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("detects changes to staged project source", async () => {
    const stage = await stageGodotValidation({
      candidateWorkspace,
      stageRoot: join(root, "run"),
    });
    await writeFile(join(stage.projectStagePath, "project.godot"), "changed\n");

    const result = await stage.verifySourceUnchanged();
    expect(result.sourceUnchanged).toBe(false);
    expect(result.observedSourceSha256).not.toBe(stage.sourceSha256);
  });

  it("keeps the candidate outside the run and cleans the stage on terminate", async () => {
    const processResult: SrtCommandResult = {
      status: "cancelled",
      exitCode: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      cancelled: true,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    let finishProcess: ((result: SrtCommandResult) => void) | undefined;
    const processCompletion = new Promise<SrtCommandResult>((resolve) => {
      finishProcess = resolve;
    });
    let stopped = false;
    const fakeProcess: SrtDuplexHandle = {
      pid: 123,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      wait: () => processCompletion,
      stop: () => {
        stopped = true;
        finishProcess?.(processResult);
        return processCompletion;
      },
    };
    let sandboxRequest: SrtGodotRequest | undefined;
    const candidateParentAlias = join(root, "candidate-parent-alias");
    await symlink(root, candidateParentAlias, "dir");
    const requestedCandidate = join(candidateParentAlias, "candidate");
    const runner = new SrtGodotRunner({
      controller: {
        openGodot: async (request) => {
          sandboxRequest = request;
          return fakeProcess;
        },
      },
      candidateWorkspace: requestedCandidate,
      validationRoot: join(root, "validation-runs"),
    });

    const run = await runner.open({
      argv: (stage) => ["/opt/godot", "--path", stage.projectStagePath],
      timeoutMs: 1_000,
    });
    expect(run.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
    if (sandboxRequest === undefined)
      throw new Error("missing sandbox request");
    const request = sandboxRequest;
    expect(request.mutableWorkspacePath).toBe(candidateWorkspace);
    expect(request.mutableWorkspacePath).not.toBe(requestedCandidate);
    expect(request.cwd).toBe(request.projectStagePath);
    expect(request.homePath).not.toBe(candidateWorkspace);
    expect(request.tempPath).not.toBe(candidateWorkspace);
    expect(request.artifactsPath).not.toBe(candidateWorkspace);
    await writeFile(join(candidateWorkspace, "project.godot"), "changed\n");
    await expect(
      readFile(join(request.projectStagePath, "project.godot"), "utf8"),
    ).resolves.toBe("[application]\n");

    await run.terminate();
    expect(stopped).toBe(true);
    await expect(run.completion).resolves.toMatchObject({
      process: processResult,
      sourceUnchanged: true,
    });
    await expect(
      lstat(dirname(request.projectStagePath)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects source symlinks and removes a partially-created stage", async () => {
    await symlink(
      "project.godot",
      join(candidateWorkspace, "linked-project.godot"),
    );
    const stageRoot = join(root, "run");

    await expect(
      stageGodotValidation({ candidateWorkspace, stageRoot }),
    ).rejects.toThrow(/symbolic link/u);
    await expect(lstat(stageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages pinned source bytes when the mutable candidate becomes a symlink after admission", async () => {
    const snapshot = await readFile(join(candidateWorkspace, "scenes/main.gd"));
    const secret = join(root, "host-secret.gd");
    await writeFile(secret, "host-only bytes");
    await rm(join(candidateWorkspace, "scenes/main.gd"));
    await symlink(secret, join(candidateWorkspace, "scenes/main.gd"));
    const stage = await stageGodotValidation({
      candidateWorkspace,
      stageRoot: join(root, "run"),
      sourceFiles: [
        { relativePath: "scenes/main.gd", bytes: snapshot, executable: false },
      ],
    });
    expect(
      await readFile(join(stage.projectStagePath, "scenes/main.gd"), "utf8"),
    ).toBe("extends Node\n");
    expect(await readdir(stage.projectStagePath)).not.toContain(
      "project.godot",
    );
    expect((await stage.verifySourceUnchanged()).sourceUnchanged).toBe(true);
    await stage.cleanup();
  });

  it.each([
    "../host-secret.gd",
    "/absolute.gd",
    "sub/../escape.gd",
    ".godot/cache",
    "a\\b.gd",
    "a//b.gd",
  ])(
    "rejects unsafe pinned-source path %s before creating a stage",
    async (relativePath) => {
      const stageRoot = join(root, "run");
      await expect(
        stageGodotValidation({
          candidateWorkspace,
          stageRoot,
          sourceFiles: [
            { relativePath, bytes: Buffer.from("x"), executable: false },
          ],
        }),
      ).rejects.toThrow(/snapshot path/u);
      await expect(lstat(stageRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["override.cfg", "addons/chronorift_inspection/observer.gd"])(
    "does not overwrite candidate-owned inspection source at %s",
    async (reservedPath) => {
      await mkdir(dirname(join(candidateWorkspace, reservedPath)), {
        recursive: true,
      });
      await writeFile(
        join(candidateWorkspace, reservedPath),
        "candidate bytes",
      );
      const stageRoot = join(root, "run");
      await expect(
        stageGodotValidation({
          candidateWorkspace,
          stageRoot,
          overlayFiles: [
            {
              relativePath: "addons/chronorift_inspection/observer.gd",
              bytes: Buffer.from("managed bytes"),
            },
          ],
        }),
      ).rejects.toThrow(/occupies Host-managed inspection path/u);
      await expect(
        readFile(join(candidateWorkspace, reservedPath), "utf8"),
      ).resolves.toBe("candidate bytes");
      await expect(lstat(stageRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects special source files", async () => {
    const socketPath = join(candidateWorkspace, "editor.sock");
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    await expect(
      stageGodotValidation({
        candidateWorkspace,
        stageRoot: join(root, "run"),
      }),
    ).rejects.toThrow(/special file/u);
  });

  it.each([
    "../escape",
    "/absolute",
    ".godot/injected",
    ".chronorift/private",
    "project.godot",
    "scenes/main.gd",
    "addons/unmanaged/plugin.gd",
    "a//b",
  ])(
    "rejects unsafe overlay path %s before creating the stage",
    async (relativePath) => {
      const stageRoot = join(root, "run");
      await expect(
        stageGodotValidation({
          candidateWorkspace,
          stageRoot,
          overlayFiles: [{ relativePath, bytes: Buffer.from("x") }],
        }),
      ).rejects.toThrow(/overlay path/u);
      await expect(lstat(stageRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("requires a fresh stage outside the candidate workspace", async () => {
    const existingStage = join(root, "existing");
    await mkdir(existingStage);
    await expect(
      stageGodotValidation({ candidateWorkspace, stageRoot: existingStage }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      stageGodotValidation({
        candidateWorkspace,
        stageRoot: join(candidateWorkspace, "run"),
      }),
    ).rejects.toThrow(/must be disjoint/u);
  });
});
