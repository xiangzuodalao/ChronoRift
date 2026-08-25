#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const usage = () => {
  process.stderr.write(
    "usage: node scripts/evaluate-mob-orientation-candidate.mjs PROJECT_ROOT [--godot-bin ABSOLUTE_PATH] [--repeat 3]\n",
  );
  process.exitCode = 2;
};

const args = process.argv.slice(2);
if (args.length === 0) {
  usage();
} else {
  const projectRoot = resolve(args[0]);
  let godotBin = resolve(".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64");
  let repeat = 3;
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--godot-bin" && value && isAbsolute(value)) godotBin = value;
    else if (flag === "--repeat" && /^\d+$/u.test(value ?? ""))
      repeat = Number(value);
    else {
      usage();
      process.exit(2);
    }
  }
  if (repeat < 1 || repeat > 20) {
    throw new Error("repeat must be between 1 and 20");
  }
  await access(godotBin, constants.X_OK);
  const mobSource = await readFile(join(projectRoot, "Mob.gd"), "utf8");
  const root = await mkdtemp(join(tmpdir(), "chronorift-mob-evaluator-"));
  const results = [];
  try {
    await writeFile(
      join(root, "project.godot"),
      `config_version=5\n\n[application]\nrun/main_scene="res://runner.tscn"\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nrenderer/rendering_method.mobile="gl_compatibility"\n`,
    );
    await writeFile(join(root, "Mob.gd"), mobSource);
    await writeFile(
      join(root, "runner.tscn"),
      `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://runner.gd" id="1"]\n\n[node name="Runner" type="Node"]\nscript = ExtResource("1")\n`,
    );
    await writeFile(
      join(root, "runner.gd"),
      `extends Node\n\nconst MOB_SCRIPT := preload("res://Mob.gd")\n\nfunc _ready() -> void:\n\tvar seed_value := int(OS.get_cmdline_user_args()[0])\n\tseed(seed_value)\n\tvar mob := MOB_SCRIPT.new() as CharacterBody3D\n\tvar animation := AnimationPlayer.new()\n\tanimation.name = "AnimationPlayer"\n\tmob.add_child(animation)\n\tadd_child(mob)\n\tvar start := Vector3(10.0, 0.0, 10.0)\n\tvar player := Vector3(-2.0, 6.0, -4.0)\n\tmob.initialize(start, player)\n\tvar up_alignment := mob.global_basis.y.normalized().dot(Vector3.UP)\n\tvar horizontal_speed := Vector2(mob.velocity.x, mob.velocity.z).length()\n\tvar accepted := up_alignment >= 0.999999 and absf(mob.velocity.y) <= 0.000001 and horizontal_speed >= float(mob.min_speed) - 0.000001 and horizontal_speed <= float(mob.max_speed) + 0.000001\n\tprint("CHRONORIFT_MOB_EVAL=" + JSON.stringify({"seed": seed_value, "upAlignment": up_alignment, "velocityY": mob.velocity.y, "horizontalSpeed": horizontal_speed, "accepted": accepted}))\n\tget_tree().quit(0 if accepted else 1)\n`,
    );
    for (let attempt = 0; attempt < repeat; attempt += 1) {
      const seed = 7301 + attempt * 101;
      const result = await new Promise((resolveRun, rejectRun) => {
        const child = spawn(
          godotBin,
          [
            "--headless",
            "--path",
            root,
            "--audio-driver",
            "Dummy",
            "--",
            String(seed),
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
        const stdout = [];
        const stderr = [];
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.once("error", rejectRun);
        child.once("exit", (code, signal) =>
          resolveRun({
            code,
            signal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          }),
        );
      });
      const line = result.stdout
        .split(/\r?\n/u)
        .find((value) => value.startsWith("CHRONORIFT_MOB_EVAL="));
      const observation =
        line === undefined
          ? null
          : JSON.parse(line.slice("CHRONORIFT_MOB_EVAL=".length));
      results.push({
        attempt: attempt + 1,
        seed,
        exitCode: result.code,
        signal: result.signal,
        observation,
        stderr: result.stderr.slice(0, 4096),
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const evaluatorAccepted = results.every(
    (result) =>
      result.exitCode === 0 &&
      result.signal === null &&
      result.observation?.accepted === true,
  );
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, evaluatorAccepted, repeat, results }, null, 2)}\n`,
  );
  if (!evaluatorAccepted) process.exitCode = 1;
}
