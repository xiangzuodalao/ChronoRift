import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { checkGn1Preview } from "./gn1-preview-check.js";
import { prepareGodotInspectionCandidate } from "./godot-inspection-source.js";

it("checks saved patches through real SRT without granting the Godot binary's Host siblings", async () => {
  const configuredGodot = process.env.GODOT_BIN;
  if (configuredGodot === undefined) throw new Error("GODOT_BIN is required");
  const root = await mkdtemp(join(tmpdir(), "chronorift-gn1-check-sandbox-"));
  const reports: string[] = [];
  try {
    const project = join(root, "project");
    const hostTools = join(root, "host-tools");
    await mkdir(project);
    await mkdir(hostTools);
    const godot = join(hostTools, "godot");
    const canary = join(hostTools, "harmless-host-sibling.txt");
    await copyFile(configuredGodot, godot);
    await writeFile(
      canary,
      "This ordinary test file must not enter the sandbox.",
    );
    await writeFile(
      join(project, "project.godot"),
      'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[autoload]\nGlobal="*res://global.gd"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    );
    await writeFile(join(project, "global.gd"), "extends Node\n");
    await writeFile(
      join(project, "platform.gd"),
      "extends Node2D\nvar width: int = 0\n",
    );
    await writeFile(
      join(project, "main.tscn"),
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n',
    );
    const mainScript = `extends Node2D
var isolate := false
func _ready() -> void:
    print("GN1_HOST_SIBLING_BLOCKED " + str(not FileAccess.file_exists(${JSON.stringify(canary)})))
    var platforms := Node2D.new()
    platforms.name = "Platforms"
    add_child(platforms)
    var shared := RectangleShape2D.new()
    var names := ["Platform", "Platform2", "Platform3", "Platform4"]
    var widths := [2, 1, 3, 6]
    for index in widths.size():
        var platform := preload("res://platform.gd").new()
        platform.name = names[index]
        platform.width = widths[index]
        platforms.add_child(platform)
        var body := RigidBody2D.new()
        body.name = "RigidBody2D"
        body.freeze = true
        platform.add_child(body)
        var sprites := Node2D.new()
        sprites.name = "Sprites"
        body.add_child(sprites)
        for tile in widths[index]:
            sprites.add_child(Sprite2D.new())
        var solid := CollisionShape2D.new()
        solid.name = "CollisionShape2D"
        solid.shape = RectangleShape2D.new()
        solid.shape.size = Vector2(widths[index] * 128, 128)
        body.add_child(solid)
        var area := Area2D.new()
        area.name = "Area2D"
        body.add_child(area)
        var trigger := CollisionShape2D.new()
        trigger.name = "AreaCollisionShape2D"
        trigger.shape = shared.duplicate() if isolate else shared
        trigger.shape.size = Vector2(widths[index] * 128, 40)
        area.add_child(trigger)
`;
    await writeFile(join(project, "main.gd"), mainScript);
    const patch = join(root, "candidate.patch");
    await writeFile(
      patch,
      "--- a/main.gd\n+++ b/main.gd\n@@ -1,3 +1,3 @@\n extends Node2D\n-var isolate := false\n+var isolate := true\n func _ready() -> void:\n",
    );
    const empty = join(root, "empty.patch");
    await writeFile(empty, "");

    // Only source admission is faked: this is a small sandbox regression fixture,
    // not the pinned upstream GN-1 or evidence of another real Agent run.
    const snapshotBaseline = async (path: string) =>
      (await prepareGodotInspectionCandidate(path)).sourceFiles;
    for (const [candidatePatch, expectedExit] of [
      [patch, 0],
      [empty, 1],
    ] as const) {
      const result = await checkGn1Preview(
        { project, godotBin: godot, candidatePatch },
        { snapshotBaseline },
      );
      reports.push(result.directory);
      expect(result.exitCode).toBe(expectedExit);
      for (const side of ["baseline", "candidate"]) {
        const directory = join(result.directory, side);
        expect(
          await readFile(join(directory, "runtime-stdout.log"), "utf8"),
        ).toContain("GN1_HOST_SIBLING_BLOCKED true");
        expect(await readdir(join(directory, "stages"))).toEqual([]);
      }
    }
    expect(await readFile(join(project, "main.gd"), "utf8")).toBe(mainScript);
    expect(await readFile(canary, "utf8")).toBe(
      "This ordinary test file must not enter the sandbox.",
    );
  } finally {
    for (const directory of reports)
      await rm(directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
