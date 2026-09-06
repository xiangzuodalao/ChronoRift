import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assess, checkCandidate, parseArguments } from "./check.mjs";

const successfulProcess = () => ({
  status: "exited",
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  cancelled: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

// Synthetic inputs validate assessment only; they are never runtime evidence.
function observations(immediateReady = false) {
  const configurations = [
    { name: "default", capacity: 100, increment: 7, cycle_length: 120 },
    { name: "smaller_capacity", capacity: 40, increment: 6, cycle_length: 120 },
    {
      name: "increment_above_capacity",
      capacity: 1,
      increment: 2,
      cycle_length: 120,
    },
  ];
  return {
    schema_version: 1,
    phase: "checker_physics_process_after_subject_callbacks",
    checker_physics_priority: 1000000,
    scenarios: configurations.map((configuration, index) => ({
      configuration,
      samples: Array.from({ length: 360 }, (_, offset) => {
        const cycleTick = (offset % 120) + 1;
        const charge = Math.min(
          configuration.capacity,
          (cycleTick - 1) * configuration.increment,
        );
        const ready =
          cycleTick >=
          Math.ceil(configuration.capacity / configuration.increment) +
            (immediateReady ? 1 : 2);
        return {
          ordinal: offset + 1,
          physics_tick: offset + 9,
          process_frame: offset + 3,
          instance_id: String(index + 100),
          charge,
          capacity: configuration.capacity,
          increment: configuration.increment,
          cycle_length: 120,
          elapsed_ticks: offset + 1,
          phase: ready ? "ready" : "charging",
          completed_cycles: Math.floor(offset / 120) + (ready ? 1 : 0),
          physics_processing: true,
          physics_priority: 0,
        };
      }),
    })),
  };
}

function runtime(data = observations()) {
  return {
    process: {
      ...successfulProcess(),
      stdout: `CAPACITOR_CHECK_OBSERVATIONS ${JSON.stringify(data)}\n`,
    },
    sourceUnchanged: true,
    sourceSha256: "same",
    observedSourceSha256: "same",
  };
}

test("acceptance permits clamp with immediate or next-tick ready transition", () => {
  for (const immediate of [true, false])
    assert.equal(
      assess(successfulProcess(), runtime(observations(immediate))).outcome,
      "passed",
    );
});

test("acceptance catches the transient, disabled updates, removed cycling, and hard-coded capacity", () => {
  for (const mutate of [
    (data) => {
      data.scenarios[0].samples[15].charge = 105;
    },
    (data) => {
      data.scenarios[0].samples[0].physics_processing = false;
    },
    (data) => {
      data.scenarios[0].samples[120].charge = 100;
    },
    (data) => {
      data.scenarios[1].samples[7].charge = 42;
    },
    (data) => {
      data.scenarios[0].samples[30].completed_cycles = 0;
    },
    (data) => {
      data.scenarios[0].samples[30].phase = "charging";
    },
  ]) {
    const data = observations();
    mutate(data);
    assert.equal(
      assess(successfulProcess(), runtime(data)).outcome,
      "assertions_failed",
    );
  }
});

test("incomplete process/output/integrity or sample order requires review", () => {
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
  for (const mutate of [
    (value) => {
      value.sourceUnchanged = false;
    },
    (value) => {
      value.observedSourceSha256 = "different";
    },
    (value) => {
      value.process.stdout = "";
    },
    (value) => {
      value.process.stdout += value.process.stdout;
    },
    (value) => {
      value.process.stderr = "SCRIPT ERROR: failed\n";
    },
  ]) {
    const value = runtime();
    mutate(value);
    assert.equal(assess(successfulProcess(), value).outcome, "requires_review");
  }
  for (const mutate of [
    (data) => {
      data.scenarios[0].samples.pop();
    },
    (data) => {
      data.scenarios[0].samples[3].physics_tick += 1;
    },
    (data) => {
      data.scenarios[0].samples[3].instance_id = "changed";
    },
    (data) => {
      data.phase = "physics_frame_end";
    },
  ]) {
    const data = observations();
    mutate(data);
    assert.equal(
      assess(successfulProcess(), runtime(data)).outcome,
      "requires_review",
    );
  }
});

test("argument parsing requires unique bounded known arguments", () => {
  const args = [
    "--project",
    "/project",
    "--godot-bin",
    "/godot",
    "--output",
    "/output",
  ];
  assert.deepEqual(parseArguments(args), {
    project: "/project",
    godotBin: "/godot",
    output: "/output",
  });
  for (const invalid of [
    [],
    [...args, "--output", "/other"],
    [...args, "--unknown", "yes"],
    [...args.slice(0, -1), "bad\0path"],
  ])
    assert.throws(() => parseArguments(invalid));
});

test("output overlap and existing records fail before modifying source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "capacitor-check-output-"));
  try {
    const project = join(directory, "source");
    await mkdir(project);
    await symlink(project, join(directory, "linked"));
    for (const output of [
      join(project, "output"),
      join(directory, "linked", "output"),
      directory,
    ]) {
      await assert.rejects(
        checkCandidate({ project, godotBin: "/missing", output }),
        /Output must not overlap/u,
      );
    }
    assert.deepEqual(await readdir(project), []);
    const existing = join(directory, "existing");
    await mkdir(existing);
    await assert.rejects(
      checkCandidate({ project, godotBin: "/missing", output: existing }),
      /EEXIST/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
