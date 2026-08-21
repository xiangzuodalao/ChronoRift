import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateProjectAdapterObservationV1 } from "./project-adapter-observation.js";
import { loadProjectAdapterPackageWithBytesV1 } from "./project-adapter-package.js";
import { PROJECT_ADAPTER_SDK_FILES_V1 } from "./project-environment-runtime-assets.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const waitForExit = (
  child: ReturnType<typeof spawn>,
): Promise<{ readonly code: number | null; readonly signal: string | null }> =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

const runGodot = async (
  godotPath: string,
  root: string,
  extraArguments: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> => {
  const child = spawn(
    godotPath,
    ["--headless", "--path", root, ...extraArguments],
    {
      cwd: root,
      env: {
        HOME: root,
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exit = await waitForExit(child);
  const output = {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
  expect(exit, `${output.stdout}\n${output.stderr}`).toEqual({
    code: 0,
    signal: null,
  });
  expect(output.stderr).not.toMatch(/SCRIPT ERROR|Parse Error/u);
  return output;
};

describe("the GN-1 platform geometry adapter", () => {
  it("observes realized collision resource identity without interpreting it", async () => {
    const godotPath =
      process.env.CHRONORIFT_TEST_GODOT_BIN ??
      join(
        process.cwd(),
        ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
      );
    const packageRoot = join(
      process.cwd(),
      "testdata/vnext/external-project/moddable-platformer-platform-alias-adapter",
    );
    const loaded = await loadProjectAdapterPackageWithBytesV1(packageRoot, {
      requireSingleLaunchTarget: true,
      expectedMainScene: "res://main.tscn",
      requireEmptyLaunchParameters: true,
    });
    const root = await mkdtemp(join(tmpdir(), "chronorift-platform-alias-"));
    roots.push(root);
    const sdkRoot = join(
      root,
      "addons",
      "chronorift_project_environment",
      "sdk",
    );
    const adapterRoot = join(root, ".chronorift", "project-adapter");
    const componentRoot = join(root, "components", "platform");
    await Promise.all([
      mkdir(sdkRoot, { recursive: true }),
      mkdir(join(adapterRoot, "src"), { recursive: true }),
      mkdir(componentRoot, { recursive: true }),
    ]);
    await Promise.all([
      ...PROJECT_ADAPTER_SDK_FILES_V1.map(async (file) => {
        const target = join(
          root,
          "addons",
          "chronorift_project_environment",
          file.relativePath,
        );
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, file.bytes);
      }),
      ...loaded.fileBytes.map(async (file) => {
        const target = join(adapterRoot, ...file.path.split("/"));
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, file.bytes);
      }),
      writeFile(
        join(root, "project.godot"),
        `config_version=5

[application]
run/main_scene="res://main.tscn"

[rendering]
renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
`,
      ),
      writeFile(
        join(root, "main.tscn"),
        `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://runner.gd" id="1"]

[node name="Main" type="Node"]
script = ExtResource("1")
`,
      ),
      writeFile(
        join(componentRoot, "platform.gd"),
        `extends Node2D

@export var width: int = 3
@export var one_way: bool = false
@export var fall_time: float = -1.0
`,
      ),
      writeFile(
        join(root, "runner.gd"),
        `extends Node

const PLATFORM_SCRIPT := preload("res://components/platform/platform.gd")
const ADAPTER_SCRIPT := preload("res://.chronorift/project-adapter/src/project_adapter.gd")

func _ready() -> void:
	var shared_area_shape := RectangleShape2D.new()
	var widths := [2, 1, 3, 6]
	for index in widths.size():
		var platform := PLATFORM_SCRIPT.new() as Node2D
		platform.name = "Platform" if index == 0 else "Platform%d" % (index + 1)
		platform.set("width", widths[index])
		platform.set("one_way", index == 2)
		platform.set("fall_time", 2.0 if index == 2 else -1.0)
		add_child(platform)

		var rigid_body := RigidBody2D.new()
		rigid_body.name = "RigidBody2D"
		platform.add_child(rigid_body)
		var solid_collision := CollisionShape2D.new()
		solid_collision.name = "CollisionShape2D"
		var solid_shape := RectangleShape2D.new()
		solid_shape.size = Vector2(widths[index] * 128, 128)
		solid_collision.shape = solid_shape
		rigid_body.add_child(solid_collision)

		var area := Area2D.new()
		area.name = "Area2D"
		rigid_body.add_child(area)
		var area_collision := CollisionShape2D.new()
		area_collision.name = "AreaCollisionShape2D"
		area_collision.shape = shared_area_shape
		area.add_child(area_collision)
		shared_area_shape.size = Vector2(widths[index] * 128, 40)

		var sprites := Node2D.new()
		sprites.name = "Sprites"
		rigid_body.add_child(sprites)
		for sprite_index in widths[index]:
			var sprite := Node2D.new()
			sprite.name = "Sprite%d" % sprite_index
			sprites.add_child(sprite)

	var adapter: Variant = ADAPTER_SCRIPT.new()
	var modules: Dictionary = adapter.call("create_modules")
	var empty_scene := Node.new()
	var partial_states: Array = modules["state_projection"].call("sample", empty_scene)
	empty_scene.free()
	var entities: Array = modules["entity_projection"].call("sample", self)
	var shared_states: Array = modules["state_projection"].call("sample", self)
	var unchanged_states: Array = modules["state_projection"].call("sample", self)
	for index in widths.size():
		var area_collision := get_child(index).get_node("RigidBody2D/Area2D/AreaCollisionShape2D") as CollisionShape2D
		var isolated_area_shape := RectangleShape2D.new()
		isolated_area_shape.size = Vector2(widths[index] * 128, 40)
		area_collision.shape = isolated_area_shape
	var isolated_states: Array = modules["state_projection"].call("sample", self)
	var unchanged_isolated_states: Array = modules["state_projection"].call("sample", self)
	print("CHRONORIFT_PLATFORM_ALIAS=" + JSON.stringify({"entities": entities, "partial_states": partial_states, "shared_states": shared_states, "unchanged_states": unchanged_states, "isolated_states": isolated_states, "unchanged_isolated_states": unchanged_isolated_states}))
	get_tree().quit()
`,
      ),
    ]);

    await runGodot(godotPath, root, ["--editor", "--quit"]);
    const run = await runGodot(godotPath, root, [
      "--rendering-method",
      "gl_compatibility",
      "--audio-driver",
      "Dummy",
    ]);
    const line = run.stdout
      .split(/\r?\n/u)
      .find((candidate) => candidate.startsWith("CHRONORIFT_PLATFORM_ALIAS="));
    expect(line, run.stdout).toBeDefined();
    const observed = JSON.parse(
      line!.slice("CHRONORIFT_PLATFORM_ALIAS=".length),
    ) as {
      readonly entities: readonly unknown[];
      readonly partial_states: readonly {
        readonly semanticCoverage: string;
        readonly value: { readonly platforms: readonly unknown[] };
      }[];
      readonly unchanged_isolated_states: readonly unknown[];
      readonly shared_states: readonly {
        readonly value: {
          readonly platforms: readonly {
            readonly configured_width_tiles: number;
            readonly rendered_sprite_count: number;
            readonly solid_shape_instance_id: string;
            readonly solid_collision_width_px: number;
            readonly area_shape_instance_id: string;
            readonly area_collision_width_px: number;
          }[];
        };
      }[];
      readonly unchanged_states: readonly unknown[];
      readonly isolated_states: readonly {
        readonly value: {
          readonly platforms: readonly {
            readonly configured_width_tiles: number;
            readonly rendered_sprite_count: number;
            readonly solid_shape_instance_id: string;
            readonly solid_collision_width_px: number;
            readonly area_shape_instance_id: string;
            readonly area_collision_width_px: number;
          }[];
        };
      }[];
    };
    expect(observed.entities).toHaveLength(4);
    expect(observed.partial_states).toEqual([
      {
        stateDomainId: "platform_geometry",
        value: { platforms: [] },
        semanticCoverage: "partial",
      },
    ]);
    expect(() =>
      validateProjectAdapterObservationV1(loaded, {
        schemaVersion: 1,
        recordSequence: 0,
        clock: {
          processFrame: 0,
          physicsTick: 0,
          simulationTimeUs: 0,
          renderFrame: null,
        },
        kind: "state_sample",
        payload: observed.partial_states[0],
      }),
    ).not.toThrow();
    expect(observed.shared_states).toHaveLength(1);
    expect(observed.unchanged_states).toEqual([]);
    const platforms = observed.shared_states[0]?.value.platforms ?? [];
    expect(platforms.map((value) => value.configured_width_tiles)).toEqual([
      2, 1, 3, 6,
    ]);
    expect(platforms.map((value) => value.rendered_sprite_count)).toEqual([
      2, 1, 3, 6,
    ]);
    expect(platforms.map((value) => value.solid_collision_width_px)).toEqual([
      256, 128, 384, 768,
    ]);
    expect(
      new Set(platforms.map((value) => value.solid_shape_instance_id)).size,
    ).toBe(4);
    expect(
      new Set(platforms.map((value) => value.area_shape_instance_id)).size,
    ).toBe(1);
    expect(platforms.map((value) => value.area_collision_width_px)).toEqual([
      768, 768, 768, 768,
    ]);
    expect(observed.isolated_states).toHaveLength(1);
    const isolated = observed.isolated_states[0]?.value.platforms ?? [];
    expect(
      new Set(isolated.map((value) => value.area_shape_instance_id)).size,
    ).toBe(4);
    expect(isolated.map((value) => value.area_collision_width_px)).toEqual([
      256, 128, 384, 768,
    ]);
    expect(observed.unchanged_isolated_states).toEqual([]);
  });
});
