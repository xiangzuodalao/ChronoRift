import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProjectAdapterPackageV2 } from "./project-adapter-package-v2.js";
import { ProjectAdapterObservationExecutionValidatorV2 } from "./project-adapter-observation-v2.js";
import { PROJECT_ADAPTER_SDK_FILES_V2 } from "./project-environment-runtime-assets-v2.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const digest = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");

const runGodot = async (
  godotPath: string,
  root: string,
  extraArguments: readonly string[] = [],
) => {
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
      ...extraArguments,
    ],
    {
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
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
  const exit = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  const output = {
    ...exit,
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

describe("the Squash the Creeps V2 runtime projection", () => {
  it("passively emits lifecycle and orientation state without changing source", async () => {
    const godotPath =
      process.env.CHRONORIFT_TEST_GODOT_BIN ??
      join(
        process.cwd(),
        ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
      );
    const adapterRoot = join(
      process.cwd(),
      "testdata/vnext/external-project/squash-the-creeps-mob-orientation-adapter",
    );
    const loaded = await loadProjectAdapterPackageV2(adapterRoot, {
      requireSingleLaunchTarget: true,
      expectedMainScene: "res://Main.tscn",
      requireEmptyLaunchParameters: true,
    });
    const root = await mkdtemp(join(tmpdir(), "chronorift-mob-adapter-"));
    roots.push(root);
    for (const file of PROJECT_ADAPTER_SDK_FILES_V2) {
      const target = join(
        root,
        "addons",
        "chronorift_project_environment",
        file.relativePath,
      );
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
    }
    const adapterTarget = join(root, ".chronorift", "project-adapter");
    await mkdir(join(adapterTarget, "src"), { recursive: true });
    await writeFile(
      join(adapterTarget, "src", "project_adapter.gd"),
      await readFile(join(adapterRoot, "src", "project_adapter.gd")),
    );
    const mobSource = `extends CharacterBody3D

@export var min_speed = 10
@export var max_speed = 18

func initialize(start_position, player_position):
\tlook_at_from_position(start_position, player_position, Vector3.UP)
\trotate_y(randf_range(-PI / 4, PI / 4))
\tvar random_speed = randf_range(min_speed, max_speed)
\tvelocity = Vector3.FORWARD.rotated(Vector3.UP, rotation.y) * random_speed
\t$AnimationPlayer.speed_scale = random_speed / min_speed
`;
    await Promise.all([
      writeFile(
        join(root, "project.godot"),
        `config_version=5\n\n[application]\nrun/main_scene="res://Main.tscn"\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nrenderer/rendering_method.mobile="gl_compatibility"\n`,
      ),
      writeFile(join(root, "Mob.gd"), mobSource),
      writeFile(
        join(root, "Main.tscn"),
        `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://runner.gd" id="1"]\n\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n`,
      ),
      writeFile(
        join(root, "runner.gd"),
        `extends Node

const MOB := preload("res://Mob.gd")
const ADAPTER := preload("res://.chronorift/project-adapter/src/project_adapter.gd")
const CONTEXT := preload("res://addons/chronorift_project_environment/sdk/observation_context_v2.gd")
var observations: Array = []

func _capture(kind: String, payload: Dictionary) -> void:
\tobservations.append({"kind": kind, "payload": payload})

func _ready() -> void:
\tvar player := Node3D.new()
\tplayer.name = "Player"
\tplayer.position = Vector3(-2.0, 6.0, -4.0)
\tadd_child(player)
\tvar context: Variant = CONTEXT.new()
\tcontext.configure("execution.mob-test", Callable(self, "_capture"))
\tvar adapter: Variant = ADAPTER.new()
\tassert(adapter.start(context, self) == OK)
\tseed(7301)
\tvar mob := MOB.new() as CharacterBody3D
\tmob.name = "Mob"
\tvar animation := AnimationPlayer.new()
\tanimation.name = "AnimationPlayer"
\tmob.add_child(animation)
\tmob.initialize(Vector3(10.0, 0.0, 10.0), player.position)
\tadd_child(mob)
\tawait get_tree().process_frame
\tawait get_tree().process_frame
\tprint("CHRONORIFT_MOB_ADAPTER=" + JSON.stringify(observations))
\tget_tree().quit()
`,
      ),
    ]);
    const before = digest(await readFile(join(root, "Mob.gd")));
    await runGodot(godotPath, root, ["--editor", "--quit"]);
    const run = await runGodot(godotPath, root);
    const after = digest(await readFile(join(root, "Mob.gd")));
    expect(after).toBe(before);
    const line = run.stdout
      .split(/\r?\n/u)
      .find((value) => value.startsWith("CHRONORIFT_MOB_ADAPTER="));
    expect(line, run.stdout).toBeDefined();
    const values = JSON.parse(
      line!.slice("CHRONORIFT_MOB_ADAPTER=".length),
    ) as readonly { readonly kind: string; readonly payload: unknown }[];
    const validator = new ProjectAdapterObservationExecutionValidatorV2(
      loaded,
      "execution.mob-test",
    );
    const validated = values.map((value, index) =>
      validator.validate({
        schemaVersion: 2,
        executionId: "execution.mob-test",
        recordSequence: index,
        clock: {
          processFrame: index,
          physicsTick: index,
          simulationTimeUs: index,
          renderFrame: null,
        },
        ...value,
      }),
    );
    expect(validated.map((value) => value.kind)).toEqual([
      "entity_lifecycle",
      "state_sample",
    ]);
    const state = validated[1];
    expect(state?.kind).toBe("state_sample");
    if (state?.kind === "state_sample") {
      expect(state.payload.stateDomainId).toBe("mob_spawn_orientation");
      expect(state.payload.value).toMatchObject({
        player_y: 6,
        mob_y: 0,
        height_delta: 6,
        velocity_y: 0,
      });
      expect(
        (state.payload.value as { up_alignment: number }).up_alignment,
      ).toBeLessThan(0.999999);
    }
  });
});
