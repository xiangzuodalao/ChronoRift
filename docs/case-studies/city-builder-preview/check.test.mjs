import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assess, check, parseArguments } from "./check.mjs";

const successfulProcess = () => ({
  status: "exited",
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  durationMs: 1,
  timedOut: false,
  cancelled: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

// Synthetic observations test Host assessment; they are not runtime evidence.
function acceptedObservations() {
  const names = [
    "road-straight",
    "road-straight-lightposts",
    "road-corner",
    "road-split",
    "road-intersection",
    "pavement",
    "pavement-fountain",
    "building-small-a",
    "building-small-b",
    "building-small-c",
    "building-small-d",
    "building-garage",
    "grass",
    "grass-trees",
    "grass-trees-tall",
  ];
  const models = names.map((name) => `res://models/${name}.glb`);
  let state = {
    index: 0,
    additions: 1,
    removals: 0,
    process_frame: 0,
    physics_tick: 0,
    observed_process_completions: 0,
    selector_basis: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    children: [
      { instance_id: "100", model: models[0], position: [0, 0.25, 0] },
    ],
  };
  const copy = () => structuredClone(state);
  const events = [{ kind: "added" }];
  const scenarios = [
    {
      name: "initialization",
      kind: "initialization",
      expected_index: 0,
      after: copy(),
    },
  ];
  const step = (name, kind, frames, index = 0) => {
    const before = copy();
    state.observed_process_completions += frames;
    state.process_frame = state.observed_process_completions - 1;
    state.physics_tick += 1;
    if (kind === "switch") {
      state.index = index;
      state.additions++;
      state.removals++;
      state.children = [
        {
          instance_id: String(state.additions + 99),
          model: models[index],
          position: [0, 0.25, 0],
        },
      ];
      events.push({ kind: "removed" }, { kind: "added" });
    }
    if (kind === "rotate") state.selector_basis = [0, 0, -1, 0, 1, 0, 1, 0, 0];
    scenarios.push({
      name,
      kind,
      frames,
      expected_index: index,
      before,
      after: copy(),
    });
  };
  step("idle_120", "stable", 120);
  for (const action of ["structure_next", "structure_previous"])
    for (let i = 0; i < 15; i++) {
      const selected =
        action === "structure_next" ? (i + 1) % 15 : (29 - i) % 15;
      step(`${action}_${i}`, "switch", 1, selected);
      step(`${action}_${i}_idle`, "stable", 3, selected);
    }
  step("simultaneous_opposites", "stable", 1);
  step("simultaneous_opposites_idle", "stable", 3);
  step("rotate", "rotate", 1);
  step("rotate_idle", "stable", 120);
  return {
    schema_version: 1,
    main_scene: "res://scenes/main.tscn",
    audio_autoload: "/root/Audio",
    configured_models: models,
    scenarios,
    events,
    events_truncated: false,
  };
}

function runtime(observations = acceptedObservations()) {
  return {
    process: {
      ...successfulProcess(),
      stdout: `CITY_CHECK_OBSERVATIONS ${JSON.stringify(observations)}\n`,
    },
    sourceUnchanged: true,
    sourceSha256: "same",
    observedSourceSha256: "same",
  };
}

test("assessment accepts complete valid observations and rejects missing initialization and incorrect switching", () => {
  assert.equal(assess(successfulProcess(), runtime()).outcome, "passed");
  const missingInit = acceptedObservations();
  missingInit.scenarios[0].after.children = [];
  const initResult = assess(successfulProcess(), runtime(missingInit));
  assert.equal(initResult.outcome, "assertions_failed");
  assert.equal(initResult.scenarios[0].passed, false);
  const staleSwitch = acceptedObservations();
  staleSwitch.scenarios[2].after.children[0].model =
    staleSwitch.configured_models[0];
  const switchResult = assess(successfulProcess(), runtime(staleSwitch));
  assert.equal(switchResult.outcome, "assertions_failed");
  assert.deepEqual(switchResult.scenarios[2].problems, [
    "preview model differs",
  ]);
});

test("assessment catches rebuilding with a stable index, offset regression, and missing rotation", () => {
  const rebuilt = acceptedObservations();
  rebuilt.scenarios[1].after.children[0].instance_id = "777";
  assert.equal(
    assess(successfulProcess(), runtime(rebuilt)).scenarios[1].passed,
    false,
  );
  const offset = acceptedObservations();
  offset.scenarios[0].after.children[0].position[1] = 0;
  assert.equal(
    assess(successfulProcess(), runtime(offset)).scenarios[0].passed,
    false,
  );
  const rotation = acceptedObservations();
  const rotate = rotation.scenarios.find(
    (scenario) => scenario.name === "rotate",
  );
  rotate.after.selector_basis = [...rotate.before.selector_basis];
  assert.equal(
    assess(successfulProcess(), runtime(rotation)).scenarios.find(
      (scenario) => scenario.name === "rotate",
    ).passed,
    false,
  );
});

test("execution, integrity, output, and frame-count failures require review instead of becoming assertions", () => {
  for (const key of [
    "timedOut",
    "cancelled",
    "stdoutTruncated",
    "stderrTruncated",
  ]) {
    const value = runtime();
    value.process[key] = true;
    assert.equal(
      assess(successfulProcess(), value).outcome,
      "requires_review",
      key,
    );
  }
  for (const mutation of [
    (value) => {
      value.sourceUnchanged = false;
    },
    (value) => {
      value.observedSourceSha256 = "changed";
    },
    (value) => {
      value.process.stderr = "SCRIPT ERROR: parse failed\n";
    },
    (value) => {
      value.process.stdout += value.process.stdout;
    },
    (value) => {
      value.process.stdout = "";
    },
  ]) {
    const value = runtime();
    mutation(value);
    assert.equal(assess(successfulProcess(), value).outcome, "requires_review");
  }
  const observations = acceptedObservations();
  observations.scenarios[1].after.observed_process_completions = 119;
  assert.equal(
    assess(successfulProcess(), runtime(observations)).outcome,
    "requires_review",
  );
});

test("argument parsing rejects missing, duplicate, unknown, and NUL arguments", () => {
  const base = [
    "--project",
    "/source",
    "--godot-bin",
    "/godot",
    "--output",
    "/evidence",
  ];
  assert.equal(parseArguments(base).candidatePatch, undefined);
  for (const args of [
    [],
    [...base, "--output", "/other"],
    [...base, "--bogus", "yes"],
    [...base.slice(0, -1), "bad\0path"],
  ])
    assert.throws(() => parseArguments(args));
});

test("output inside baseline or through a symlink is rejected without polluting the source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "city-check-output-test-"));
  try {
    const project = join(directory, "source");
    await mkdir(project);
    await symlink(project, join(directory, "link"));
    for (const output of [
      join(project, "evidence"),
      join(directory, "link", "evidence"),
    ]) {
      await assert.rejects(
        check({ project, godotBin: "/missing", output }),
        /Output must not overlap/u,
      );
    }
    assert.deepEqual(await readdir(project), []);
    await assert.rejects(
      check({ project, godotBin: "/missing", output: directory }),
      /Output must not overlap/u,
    );
    const existing = join(directory, "existing");
    await mkdir(existing);
    await assert.rejects(
      check({ project, godotBin: "/missing", output: existing }),
      /EEXIST/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
