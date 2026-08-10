import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { GODOT_LIFECYCLE_OVERRIDE_SOURCE } from "./lifecycle-sidecar-source.js";
import { createSocketGodotTransport } from "./godot-wire-client.js";
import { connectGodotLifecycleRuntime } from "./lifecycle-wire-client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
  new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectListen(new Error("lifecycle test server has no TCP port"));
        return;
      }
      resolveListen(address.port);
    });
  });

const acceptOne = (server: ReturnType<typeof createServer>): Promise<Socket> =>
  new Promise((resolveSocket, rejectSocket) => {
    const timer = setTimeout(
      () => rejectSocket(new Error("Godot lifecycle probe did not connect")),
      15_000,
    );
    server.once("connection", (socket) => {
      clearTimeout(timer);
      resolveSocket(socket);
    });
    server.once("error", (error) => {
      clearTimeout(timer);
      rejectSocket(error);
    });
  });

const waitForExit = (
  child: ReturnType<typeof spawn>,
): Promise<{ readonly code: number | null; readonly signal: string | null }> =>
  new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

describe("Godot lifecycle addon", () => {
  it("merges the managed override with upstream autoloads and reports real lifecycle readiness", async () => {
    const godotPath =
      process.env.CHRONORIFT_TEST_GODOT_BIN ??
      join(
        process.cwd(),
        ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
      );
    const root = await mkdtemp(join(tmpdir(), "chronorift-addon-godot-"));
    roots.push(root);
    const addonRoot = join(root, "addons", "chronorift_lifecycle");
    await mkdir(addonRoot, { recursive: true });
    await copyFile(
      join(
        process.cwd(),
        "godot/addons/chronorift_lifecycle/lifecycle_probe.gd",
      ),
      join(addonRoot, "lifecycle_probe.gd"),
    );
    await Promise.all([
      writeFile(
        join(root, "project.godot"),
        [
          "config_version=5",
          "",
          "[application]",
          'config/name="ChronoRiftLifecycleCharacterization"',
          'run/main_scene="res://main.tscn"',
          "",
          "[autoload]",
          'ExistingOne="*res://existing_one.gd"',
          'ExistingTwo="*res://existing_two.gd"',
          "",
          "[rendering]",
          'renderer/rendering_method="gl_compatibility"',
          'renderer/rendering_method.mobile="gl_compatibility"',
          "",
        ].join("\n"),
      ),
      writeFile(join(root, "override.cfg"), GODOT_LIFECYCLE_OVERRIDE_SOURCE),
      writeFile(
        join(root, "existing_one.gd"),
        'extends Node\nfunc _ready() -> void:\n\tprint("existing-one-ready")\n',
      ),
      writeFile(
        join(root, "existing_two.gd"),
        'extends Node\nfunc _ready() -> void:\n\tprint("existing-two-ready")\n',
      ),
      writeFile(
        join(root, "main.gd"),
        'extends Node\nfunc _ready() -> void:\n\tprint("main-scene-ready")\n',
      ),
      writeFile(
        join(root, "main.tscn"),
        [
          "[gd_scene load_steps=2 format=3]",
          "",
          '[ext_resource path="res://main.gd" type="Script" id="1"]',
          "",
          '[node name="Main" type="Node"]',
          'script = ExtResource("1")',
          "",
        ].join("\n"),
      ),
    ]);

    const server = createServer();
    const port = await listen(server);
    const socketPromise = acceptOne(server);
    const identity = {
      taskId: "task:characterization",
      buildId: "build:characterization",
      runtimeId: "runtime:characterization",
      executionId: "execution:characterization",
      managedRuntimeId: `managed-godot-runtime:v1:${"a".repeat(64)}`,
      candidateSourceHash: "b".repeat(64),
      overlayHash: "c".repeat(64),
      addonHash: "d".repeat(64),
    } as const;
    const token = "e".repeat(64);
    const child = spawn(
      godotPath,
      [
        "--headless",
        "--path",
        root,
        "--rendering-method",
        "gl_compatibility",
        "--audio-driver",
        "Dummy",
      ],
      {
        cwd: root,
        env: {
          HOME: root,
          PATH: "/usr/bin:/bin",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          CHRONORIFT_HOST: "127.0.0.1",
          CHRONORIFT_PORT: String(port),
          CHRONORIFT_TOKEN: token,
          CHRONORIFT_TASK_ID: identity.taskId,
          CHRONORIFT_BUILD_ID: identity.buildId,
          CHRONORIFT_RUNTIME_ID: identity.runtimeId,
          CHRONORIFT_EXECUTION_ID: identity.executionId,
          CHRONORIFT_MANAGED_RUNTIME_ID: identity.managedRuntimeId,
          CHRONORIFT_CANDIDATE_SOURCE_HASH: identity.candidateSourceHash,
          CHRONORIFT_OVERLAY_HASH: identity.overlayHash,
          CHRONORIFT_ADDON_HASH: identity.addonHash,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    try {
      const socket = await socketPromise.catch((error: unknown) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nstdout:\n${Buffer.concat(stdout).toString("utf8")}\nstderr:\n${Buffer.concat(stderr).toString("utf8")}`,
        );
      });
      server.close();
      const runtime = await connectGodotLifecycleRuntime(
        createSocketGodotTransport(socket),
        {
          schemaVersion: 1,
          token,
          expectedIdentity: identity,
          expectedEngineVersion: "4.7.1-stable (official)",
          expectedPlatform: "Linux",
          expectedRenderer: "gl_compatibility",
          expectedDisplayServer: "headless",
          expectedAudioDriver: "Dummy",
          expectedMainScene: "res://main.tscn",
          handshakeTimeoutMs: 15_000,
        },
      );
      expect(runtime.fingerprint).toMatchObject({
        engineVersion: "4.7.1-stable (official)",
        platform: "Linux",
        renderer: "gl_compatibility",
        configuredMainScene: "res://main.tscn",
        identity,
      });
      expect(
        runtime.ready.observed.processFrames -
          runtime.ready.baseline.processFrames,
      ).toBeGreaterThanOrEqual(120);
      expect(
        runtime.ready.observed.physicsFrames -
          runtime.ready.baseline.physicsFrames,
      ).toBeGreaterThanOrEqual(120);
      expect(runtime.ready.observed.currentScene).toBe("res://main.tscn");
      await expect(runtime.status()).resolves.toMatchObject({
        sample: {
          configuredMainScene: "res://main.tscn",
          currentScene: "res://main.tscn",
        },
      });
      await runtime.shutdown();
      await expect(waitForExit(child)).resolves.toEqual({
        code: 0,
        signal: null,
      });
      const output = Buffer.concat(stdout).toString("utf8");
      expect(output).toContain("existing-one-ready");
      expect(output).toContain("existing-two-ready");
      expect(output).toContain("main-scene-ready");
      expect(Buffer.concat(stderr).toString("utf8")).not.toContain(
        "SCRIPT ERROR",
      );
    } finally {
      server.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child).catch(() => undefined);
      }
    }
  }, 60_000);
});
