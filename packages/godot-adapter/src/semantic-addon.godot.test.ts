import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";

import { asSha256DigestV1, type JsonValue } from "@chronorift/domain";
import { payloadHash } from "@chronorift/godot-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { createSocketGodotTransport } from "./godot-wire-client.js";
import { GODOT_SEMANTIC_OVERRIDE_SOURCE } from "./lifecycle-sidecar-source.js";
import { connectGodotSemanticRuntime } from "./semantic-wire-client.js";

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
        rejectListen(new Error("semantic test server has no TCP port"));
        return;
      }
      resolveListen(address.port);
    });
  });

const acceptOne = (server: ReturnType<typeof createServer>): Promise<Socket> =>
  new Promise((resolveSocket, rejectSocket) => {
    const timer = setTimeout(
      () => rejectSocket(new Error("Godot semantic probe did not connect")),
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

describe("Godot semantic addon", () => {
  it("observes and descriptively restores a Timer/spawn projection", async () => {
    const godotPath =
      process.env.CHRONORIFT_TEST_GODOT_BIN ??
      join(
        process.cwd(),
        ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
      );
    const root = await mkdtemp(join(tmpdir(), "chronorift-semantic-godot-"));
    roots.push(root);
    const addonRoot = join(root, "addons", "chronorift_semantic");
    await mkdir(addonRoot, { recursive: true });
    await copyFile(
      join(process.cwd(), "godot/addons/chronorift_semantic/semantic_probe.gd"),
      join(addonRoot, "semantic_probe.gd"),
    );
    await Promise.all([
      writeFile(
        join(root, "project.godot"),
        [
          "config_version=5",
          "",
          "[application]",
          'run/main_scene="res://main.tscn"',
          "",
          "[rendering]",
          'renderer/rendering_method="gl_compatibility"',
          'renderer/rendering_method.mobile="gl_compatibility"',
          "",
        ].join("\n"),
      ),
      writeFile(join(root, "override.cfg"), GODOT_SEMANTIC_OVERRIDE_SOURCE),
      writeFile(join(root, "main.gd"), "extends Node\n"),
      writeFile(
        join(root, "main.tscn"),
        [
          "[gd_scene load_steps=2 format=3]",
          '[ext_resource path="res://main.gd" type="Script" id="1"]',
          '[node name="Main" type="Node"]',
          'script = ExtResource("1")',
          "",
        ].join("\n"),
      ),
      writeFile(
        join(root, "spawner.gd"),
        [
          "extends Node",
          "@export var spawn_interval := 1.0",
          "@export var scene_to_spawn: PackedScene",
          "@onready var timer: Timer = $Timer",
          "func _ready() -> void:",
          "\ttimer.timeout.connect(_spawn)",
          "\ttimer.start(spawn_interval)",
          "func _spawn() -> void:",
          "\tget_parent().add_child(scene_to_spawn.instantiate())",
          "",
        ].join("\n"),
      ),
      writeFile(
        join(root, "entity.gd"),
        "extends Node2D\nvar velocity := Vector2(1, 2)\n",
      ),
      writeFile(
        join(root, "entity.tscn"),
        [
          "[gd_scene load_steps=2 format=3]",
          '[ext_resource path="res://entity.gd" type="Script" id="1"]',
          '[node name="Entity" type="Node2D"]',
          'script = ExtResource("1")',
          "",
        ].join("\n"),
      ),
      writeFile(
        join(root, "spawner.tscn"),
        [
          "[gd_scene load_steps=3 format=3]",
          '[ext_resource path="res://spawner.gd" type="Script" id="1"]',
          '[ext_resource path="res://entity.tscn" type="PackedScene" id="2"]',
          '[node name="Spawner" type="Node"]',
          'script = ExtResource("1")',
          'scene_to_spawn = ExtResource("2")',
          '[node name="Timer" type="Timer" parent="."]',
          "",
        ].join("\n"),
      ),
    ]);

    const profile = {
      schemaVersion: 1 as const,
      profileKind: "chronorift-godot-semantic-adapter" as const,
      adapterKind: "timer_spawn_v1" as const,
      projectCapabilitySha256: asSha256DigestV1("f".repeat(64)),
      targetScene: "res://spawner.tscn",
      spawnIntervalSeconds: 1,
      checkpointBarrier: "adapter_process_tail" as const,
      limits: {
        activeRuntimesMaximum: 2 as const,
        launchesPerTurnMaximum: 8 as const,
        entityMaximum: 256 as const,
        eventMaximum: 4096 as const,
        rawSemanticBytesMaximum: 2_097_152 as const,
        checkpointBytesMaximum: 1_048_576 as const,
        traceSamplesMaximum: 32 as const,
        traceTicksMaximum: 600 as const,
        queryRowsMaximum: 200 as const,
      },
    };
    const adapterProfileSha256 = asSha256DigestV1(
      payloadHash(profile as unknown as JsonValue),
    );
    const identity = {
      taskId: "task:characterization",
      buildId: "build:characterization",
      runtimeId: "runtime:characterization",
      executionId: "execution:characterization",
      managedRuntimeId: `managed-godot-semantic-runtime:v1:${"a".repeat(64)}`,
      candidateSourceHash: "b".repeat(64),
      adapterProfileSha256,
      overlayHash: "c".repeat(64),
      addonHash: "d".repeat(64),
    } as const;
    const token = "e".repeat(64);
    const server = createServer();
    const port = await listen(server);
    const socketPromise = acceptOne(server);
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
          CHRONORIFT_ADAPTER_PROFILE_HASH: adapterProfileSha256,
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
      const runtime = await connectGodotSemanticRuntime(
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
          adapterProfile: profile,
          adapterProfileSha256,
          handshakeTimeoutMs: 15_000,
        },
      );
      expect(runtime.ready.sample.projection.subject.targetScene).toBe(
        "res://spawner.tscn",
      );
      const checkpoint = await runtime.checkpoint();
      const restored = await runtime.restore(checkpoint.sample.projection);
      expect(
        restored.limitations.some((limitation) =>
          limitation.includes("does not establish"),
        ),
      ).toBe(true);
      await runtime.shutdown();
      await expect(waitForExit(child)).resolves.toEqual({
        code: 0,
        signal: null,
      });
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
