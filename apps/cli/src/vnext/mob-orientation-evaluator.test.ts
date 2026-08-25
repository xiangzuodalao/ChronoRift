import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const parentSource = `extends CharacterBody3D

@export var min_speed = 10
@export var max_speed = 18

func initialize(start_position, player_position):
\tlook_at_from_position(start_position, player_position, Vector3.UP)
\trotate_y(randf_range(-PI / 4, PI / 4))
\tvar random_speed = randf_range(min_speed, max_speed)
\tvelocity = Vector3.FORWARD * random_speed
\tvelocity = velocity.rotated(Vector3.UP, rotation.y)
\t$AnimationPlayer.speed_scale = random_speed / min_speed
`;

const runEvaluator = async (projectRoot: string) => {
  const child = spawn(
    process.execPath,
    [
      "scripts/evaluate-mob-orientation-candidate.mjs",
      projectRoot,
      "--repeat",
      "3",
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exit = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    ...exit,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
};

describe("the independent Mob orientation evaluator", () => {
  it("fails the parent behavior and accepts the isolated target fix 3/3", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-mob-eval-test-"));
    roots.push(root);
    await writeFile(join(root, "Mob.gd"), parentSource);

    const parent = await runEvaluator(root);
    expect(parent.code, parent.stderr).toBe(1);
    expect(JSON.parse(parent.stdout)).toMatchObject({
      evaluatorAccepted: false,
      repeat: 3,
    });

    await writeFile(
      join(root, "Mob.gd"),
      parentSource.replace(
        "\tlook_at_from_position(start_position, player_position, Vector3.UP)",
        "\tvar target = Vector3(player_position.x, start_position.y, player_position.z)\n\tlook_at_from_position(start_position, target, Vector3.UP)",
      ),
    );
    const fixed = await runEvaluator(root);
    expect(fixed.code, fixed.stderr).toBe(0);
    const result = JSON.parse(fixed.stdout) as {
      readonly evaluatorAccepted: boolean;
      readonly results: readonly { readonly observation: unknown }[];
    };
    expect(result.evaluatorAccepted).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results.every((run) => run.observation !== null)).toBe(true);

    const script = await readFile(join(root, "Mob.gd"), "utf8");
    expect(script).toContain("start_position.y");

    await writeFile(
      join(root, "Mob.gd"),
      parentSource.replace(
        "\tlook_at_from_position(start_position, player_position, Vector3.UP)",
        "\t# Ignore the player's height, so that the mob's orientation is not slightly\n\t# shifted if the mob spawns while the player is jumping.\n\tvar target = Vector3(player_position.x, start_position.y, player_position.z)\n\tlook_at_from_position(start_position, target, Vector3.UP)\n\n\t# Rotate this mob randomly within range of -45 and +45 degrees,\n\t# so that it doesn't move directly towards the player.",
      ),
    );
    const upstream = await runEvaluator(root);
    expect(upstream.code, upstream.stderr).toBe(0);
    expect(JSON.parse(upstream.stdout)).toMatchObject({
      evaluatorAccepted: true,
      repeat: 3,
    });
  }, 60_000);
});
