import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getDefaultWritePaths } from "@anthropic-ai/sandbox-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SrtSandboxController,
  type SrtCodingRequest,
  type SrtEditorRequest,
  type SrtFacade,
  type SrtGodotRequest,
} from "./srt-sandbox-controller.js";

class FakeSrtFacade implements SrtFacade {
  readonly initializeCalls: Parameters<SrtFacade["initialize"]>[] = [];
  readonly wrapCalls: Parameters<SrtFacade["wrapWithSandboxArgv"]>[] = [];
  cleanupCalls = 0;
  resetCalls = 0;

  public async initialize(
    ...args: Parameters<SrtFacade["initialize"]>
  ): Promise<void> {
    this.initializeCalls.push(args);
  }

  public async wrapWithSandboxArgv(
    ...args: Parameters<SrtFacade["wrapWithSandboxArgv"]>
  ): ReturnType<SrtFacade["wrapWithSandboxArgv"]> {
    this.wrapCalls.push(args);
    return {
      argv: ["/bin/bash", "-c", args[0]],
      // The controller must ignore the Host-like environment returned by SRT.
      env: {
        CHRONORIFT_FAKE_HOST_SECRET: "must-not-leak",
        PATH: "/host-only/bin",
      },
    };
  }

  public cleanupAfterCommand(): void {
    this.cleanupCalls += 1;
  }

  public async reset(): Promise<void> {
    this.resetCalls += 1;
  }
}

describe("SrtSandboxController", () => {
  let root: string;
  let workspacePath: string;
  let projectStagePath: string;
  let homePath: string;
  let tempPath: string;
  let artifactsPath: string;
  const controllers: SrtSandboxController[] = [];
  const nonDeviceSrtWritePaths = getDefaultWritePaths().filter(
    (path) => !path.startsWith("/dev/"),
  );

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chronorift-srt-controller-"));
    workspacePath = join(root, "candidate");
    projectStagePath = join(root, "validation-stage");
    homePath = join(root, "home");
    tempPath = join(root, "tmp");
    artifactsPath = join(root, "artifacts");
    await Promise.all(
      [
        workspacePath,
        join(projectStagePath, ".godot"),
        homePath,
        tempPath,
        artifactsPath,
      ].map(async (path) => mkdir(path, { recursive: true })),
    );
    await writeFile(join(projectStagePath, "project.godot"), "[application]\n");
  });

  afterEach(async () => {
    await Promise.allSettled(
      controllers.map(async (controller) => controller.close()),
    );
    await rm(root, { recursive: true, force: true });
  });

  const codingRequest = (
    argv: readonly string[],
    overrides: Partial<SrtCodingRequest> = {},
  ): SrtCodingRequest => ({
    argv,
    cwd: workspacePath,
    workspacePath,
    homePath,
    tempPath,
    artifactsPath,
    ...overrides,
  });

  const godotRequest = (
    argv: readonly string[],
    overrides: Partial<SrtGodotRequest> = {},
  ): SrtGodotRequest => ({
    argv,
    cwd: projectStagePath,
    projectStagePath,
    mutableWorkspacePath: workspacePath,
    homePath,
    tempPath,
    artifactsPath,
    ...overrides,
  });

  const editorRequest = (
    overrides: Partial<SrtEditorRequest> = {},
  ): SrtEditorRequest => ({
    ...codingRequest(["/bin/true"]),
    readOnlyPaths: [],
    ...overrides,
  });

  const setup = (
    facade: FakeSrtFacade,
    options: Omit<
      ConstructorParameters<typeof SrtSandboxController>[0],
      "facade"
    > = {},
  ): SrtSandboxController => {
    const controller = new SrtSandboxController({ ...options, facade });
    controllers.push(controller);
    return controller;
  };

  it("only makes a separate disposable import copy writable, retaining candidate and network denial", async () => {
    const facade = new FakeSrtFacade();
    const controller = setup(facade);
    const imported = await controller.openGodotImport(
      godotRequest([process.execPath, "-e", "process.exit(0)"]),
    );
    await imported.wait();
    expect(facade.wrapCalls[0]?.[2]?.filesystem).toMatchObject({
      allowWrite: [projectStagePath, homePath, tempPath, artifactsPath],
      denyRead: expect.arrayContaining([workspacePath]) as unknown,
    });
    expect(facade.initializeCalls[0]?.[0].network).toMatchObject({
      allowedDomains: [],
      strictAllowlist: true,
    });
    await expect(
      controller.openGodotImport(
        godotRequest(["/bin/true"], {
          projectStagePath: workspacePath,
          cwd: workspacePath,
        }),
      ),
    ).rejects.toThrow("separate");
    await expect(
      controller.openGodotImport(
        godotRequest(["/bin/true"], { readOnlyPaths: [workspacePath] }),
      ),
    ).rejects.toThrow("separate");
  });

  it("mounts Task Godot data only for the editor without exposing its parent", async () => {
    const facade = new FakeSrtFacade();
    const controller = setup(facade);
    const godotDataPath = join(root, "godot-data");
    await mkdir(godotDataPath);

    const editor = await controller.openEditor(
      editorRequest({ godotDataPath, isolationReadRoots: [root] }),
    );
    await editor.wait();
    await controller.runCoding(codingRequest(["/bin/true"]));

    const editorFilesystem = facade.wrapCalls[0]?.[2]?.filesystem;
    expect(editorFilesystem?.allowRead).toContain(godotDataPath);
    expect(editorFilesystem?.allowWrite).toEqual([
      workspacePath,
      homePath,
      tempPath,
      artifactsPath,
      godotDataPath,
    ]);
    expect(editorFilesystem?.denyRead).toContain(root);
    expect(editorFilesystem?.allowRead).not.toContain(root);
    expect(facade.wrapCalls[1]?.[2]?.filesystem?.allowRead).not.toContain(
      godotDataPath,
    );
    expect(facade.wrapCalls[1]?.[2]?.filesystem?.allowWrite).not.toContain(
      godotDataPath,
    );
  });

  it("rejects broad, protected, or overlapping Godot data mounts before starting SRT", async () => {
    const facade = new FakeSrtFacade();
    const protectedPath = join(root, "credentials");
    const dependencyPath = join(root, "tools");
    const controller = setup(facade, {
      protectedReadPaths: [protectedPath],
    });

    for (const godotDataPath of [
      "relative-data",
      "/tmp",
      protectedPath,
      join(protectedPath, "child"),
      root,
      workspacePath,
      join(homePath, "data"),
      tempPath,
      artifactsPath,
      dependencyPath,
      join(dependencyPath, "data"),
    ]) {
      await expect(
        controller.openEditor(
          editorRequest({ godotDataPath, readOnlyPaths: [dependencyPath] }),
        ),
      ).rejects.toThrow();
    }
    expect(facade.initializeCalls).toHaveLength(0);
  });

  it("rejects Godot data symlinks, linked parents, and ordinary files", async () => {
    const facade = new FakeSrtFacade();
    const controller = setup(facade);
    const dataParent = join(root, "data-parent");
    await mkdir(join(dataParent, "data"), { recursive: true });
    const linkedData = join(root, "linked-data");
    const linkedParent = join(root, "linked-parent");
    const dataFile = join(root, "data-file");
    await symlink(join(dataParent, "data"), linkedData);
    await symlink(dataParent, linkedParent);
    await writeFile(dataFile, "not a directory");

    for (const godotDataPath of [
      linkedData,
      join(linkedParent, "data"),
      dataFile,
    ]) {
      await expect(
        controller.openEditor(editorRequest({ godotDataPath })),
      ).rejects.toThrow(/directory without symlink components/u);
    }
    expect(facade.initializeCalls).toHaveLength(0);
  });

  it("initializes once and applies distinct per-call coding and Godot policies", async () => {
    const facade = new FakeSrtFacade();
    const protectedPath = join(root, "credentials");
    const controller = setup(facade, {
      protectedReadPaths: [protectedPath],
    });

    expect(facade.initializeCalls).toHaveLength(0);
    await expect(
      controller.runCoding(
        codingRequest([process.execPath, "-e", "process.exit(0)"]),
      ),
    ).resolves.toMatchObject({ status: "exited", exitCode: 0 });
    const godot = await controller.openGodot(
      godotRequest([process.execPath, "-e", "process.exit(0)"]),
    );
    await expect(godot.wait()).resolves.toMatchObject({
      status: "exited",
      exitCode: 0,
    });

    expect(facade.initializeCalls).toHaveLength(1);
    const seccompPath = facade.initializeCalls[0]?.[0].seccomp?.applyPath;
    if (seccompPath === undefined) {
      throw new Error("SRT seccomp path was not configured");
    }
    expect(seccompPath).toMatch(/vendor\/seccomp\/x64\/apply-seccomp$/u);
    expect(facade.initializeCalls[0]?.[0]).toMatchObject({
      network: {
        allowedDomains: [],
        deniedDomains: [],
        strictAllowlist: true,
        allowLocalBinding: true,
        allowAllUnixSockets: false,
      },
      filesystem: {
        denyRead: [
          "/home",
          "/root",
          "/run/user",
          "/tmp",
          "/var/tmp",
          protectedPath,
        ],
        allowRead: [seccompPath],
        allowWrite: [],
        denyWrite: nonDeviceSrtWritePaths,
      },
      seccomp: { applyPath: seccompPath },
      enableWeakerNestedSandbox: false,
    });
    expect(facade.wrapCalls).toHaveLength(2);

    const codingFilesystem = facade.wrapCalls[0]?.[2]?.filesystem;
    expect(codingFilesystem).toMatchObject({
      denyRead: [
        "/home",
        "/root",
        "/run/user",
        "/tmp",
        "/var/tmp",
        protectedPath,
      ],
      allowRead: [
        seccompPath,
        workspacePath,
        homePath,
        tempPath,
        artifactsPath,
      ],
      allowWrite: [workspacePath, homePath, tempPath, artifactsPath],
      denyWrite: nonDeviceSrtWritePaths,
    });

    const godotFilesystem = facade.wrapCalls[1]?.[2]?.filesystem;
    expect(godotFilesystem).toMatchObject({
      denyRead: [
        "/home",
        "/root",
        "/run/user",
        "/tmp",
        "/var/tmp",
        protectedPath,
        workspacePath,
      ],
      allowRead: [
        seccompPath,
        join(projectStagePath, "project.godot"),
        homePath,
        tempPath,
        artifactsPath,
      ],
      allowWrite: [
        join(projectStagePath, ".godot"),
        homePath,
        tempPath,
        artifactsPath,
      ],
      denyWrite: nonDeviceSrtWritePaths,
    });
    expect(godotFilesystem?.allowWrite).not.toContain(projectStagePath);
    expect(godotFilesystem?.allowWrite).not.toContain(workspacePath);
    expect(facade.cleanupCalls).toBe(2);
  });

  it("round-trips adversarial argv through env -i without inheriting Host env", async () => {
    const facade = new FakeSrtFacade();
    const controller = setup(facade);
    const adversarial = "spaces ; `echo no` $(echo no) 'quote'\nnewline";
    const previous = process.env.CHRONORIFT_FAKE_HOST_SECRET;
    process.env.CHRONORIFT_FAKE_HOST_SECRET = "real-host-secret";
    try {
      const result = await controller.runCoding(
        codingRequest(
          [
            process.execPath,
            "-e",
            "process.stdout.write(JSON.stringify({arg:process.argv[1],host:process.env.CHRONORIFT_FAKE_HOST_SECRET??null,explicit:process.env.EXPLICIT??null,home:process.env.HOME,path:process.env.PATH}))",
            adversarial,
          ],
          { environment: { EXPLICIT: "kept" } },
        ),
      );
      expect(result.status).toBe("exited");
      expect(JSON.parse(result.stdout)).toEqual({
        arg: adversarial,
        host: null,
        explicit: "kept",
        home: homePath,
        path: "/usr/local/bin:/usr/bin:/bin",
      });
    } finally {
      if (previous === undefined)
        delete process.env.CHRONORIFT_FAKE_HOST_SECRET;
      else process.env.CHRONORIFT_FAKE_HOST_SECRET = previous;
    }
  });

  it("drains output while retaining only the configured prefixes", async () => {
    const facade = new FakeSrtFacade();
    const controller = setup(facade, { outputLimitBytes: 4 });
    const updates: string[] = [];
    const result = await controller.runCoding(
      codingRequest(
        [
          process.execPath,
          "-e",
          "process.stdout.write('abcdefgh');process.stderr.write('12345678')",
        ],
        {
          onOutput: (chunk) =>
            updates.push(Buffer.from(chunk).toString("utf8")),
        },
      ),
    );

    expect(result).toMatchObject({
      stdout: "abcd",
      stderr: "1234",
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect(updates).toEqual(expect.arrayContaining(["abcdefgh", "12345678"]));
  });

  it("classifies timeout and AbortSignal cancellation and cleans each command", async () => {
    const facade = new FakeSrtFacade();
    const controller = setup(facade, { defaultTimeoutMs: 2_000 });

    const timedOut = await controller.runCoding(
      codingRequest([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        timeoutMs: 40,
      }),
    );
    expect(timedOut).toMatchObject({
      status: "timed_out",
      timedOut: true,
      cancelled: false,
    });

    const abort = new AbortController();
    const godot = await controller.openGodot(
      godotRequest([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        signal: abort.signal,
      }),
    );
    abort.abort();
    await expect(godot.wait()).resolves.toMatchObject({
      status: "cancelled",
      timedOut: false,
      cancelled: true,
    });
    expect(facade.cleanupCalls).toBe(2);
  });

  it("supports duplex I/O and idempotent close stops every active child", async () => {
    const facade = new FakeSrtFacade();
    const controller = setup(facade, { defaultTimeoutMs: 2_000 });
    const echo = await controller.openGodot(
      godotRequest([
        process.execPath,
        "-e",
        "process.stdin.pipe(process.stdout)",
      ]),
    );
    echo.stdin.end("request\n");
    await expect(echo.wait()).resolves.toMatchObject({
      status: "exited",
      stdout: "request\n",
    });

    const active = await controller.openGodot(
      godotRequest([process.execPath, "-e", "setInterval(() => {}, 1000)"]),
    );
    await Promise.all([controller.close(), controller.close()]);
    await expect(active.wait()).resolves.toMatchObject({ status: "cancelled" });
    expect(facade.resetCalls).toBe(1);
    expect(facade.cleanupCalls).toBe(2);
  });

  it("rejects a validation stage that overlaps the mutable workspace", async () => {
    const facade = new FakeSrtFacade();
    const controller = setup(facade);
    await expect(
      controller.openGodot(
        godotRequest([process.execPath, "-e", "process.exit(0)"], {
          projectStagePath: join(workspacePath, "stage"),
          cwd: join(workspacePath, "stage"),
        }),
      ),
    ).rejects.toThrow(/separate/u);
    expect(facade.initializeCalls).toHaveLength(0);
  });

  it("does not let a Godot allow path reopen the mutable workspace", async () => {
    const facade = new FakeSrtFacade();
    const controller = setup(facade);
    const argv = [process.execPath, "-e", "process.exit(0)"];

    for (const overrides of [
      { homePath: workspacePath },
      { tempPath: workspacePath },
      { artifactsPath: workspacePath },
      { readOnlyPaths: [workspacePath] },
      { readOnlyPaths: [root] },
    ] satisfies Partial<SrtGodotRequest>[]) {
      await expect(
        controller.openGodot(godotRequest(argv, overrides)),
      ).rejects.toThrow(/mutableWorkspacePath/u);
    }
    expect(facade.initializeCalls).toHaveLength(0);
  });

  it("rejects broad or protected allow paths before initializing SRT", async () => {
    const facade = new FakeSrtFacade();
    const protectedPath = join(root, "protected");
    const controller = setup(facade, { protectedReadPaths: [protectedPath] });
    const argv = [process.execPath, "-e", "process.exit(0)"];

    await expect(
      controller.runCoding(
        codingRequest(argv, { workspacePath: "/home", cwd: "/home" }),
      ),
    ).rejects.toThrow(/default deny root/u);
    await expect(
      controller.runCoding(
        codingRequest(argv, { artifactsPath: protectedPath }),
      ),
    ).rejects.toThrow(/protected read path/u);
    await expect(
      controller.runCoding(
        codingRequest(argv, { tempPath: nonDeviceSrtWritePaths[0]! }),
      ),
    ).rejects.toThrow(/compatibility deny-write path/u);
    expect(facade.initializeCalls).toHaveLength(0);
  });
});
