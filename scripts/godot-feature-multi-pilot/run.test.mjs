import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  argumentsFor,
  trialOrder,
  eligibleCases,
  goalFor,
  MULTI_APPENDIX,
  sourceIdentity,
  CONFIG,
  PILOT_SPAWN_POLICY,
} from "./run.mjs";

test("freeze retains requested order, excludes blocked cases, alternates the first arm", () => {
  assert.deepEqual(trialOrder(["pr332", "pr498", "pr180"]), [
    "pr498-single",
    "pr498-multi",
    "pr180-multi",
    "pr180-single",
    "pr332-single",
    "pr332-multi",
  ]);
  assert.deepEqual(trialOrder(["pr498", "pr332"]), [
    "pr498-single",
    "pr498-multi",
    "pr332-multi",
    "pr332-single",
  ]);
  assert.deepEqual(trialOrder([]), []);
  assert.throws(() => trialOrder(["pr498", "pr498"]));
  assert.throws(() => trialOrder(["unknown"]));
});

test("both arms receive the same task, coding, stopping, validation and team budget instructions", () => {
  assert.equal(
    goalFor("Feature contract\n", "multi"),
    goalFor("Feature contract\n", "single") + "\n\n" + MULTI_APPENDIX,
  );
  assert.equal(CONFIG.timeoutMs, 1_200_000);
  assert.equal(CONFIG.sharedToolCallLimit, 256);
  assert.equal(PILOT_SPAWN_POLICY.maxCreatedAgents, 3);
  assert.equal(PILOT_SPAWN_POLICY.maxDepth, 1);
  assert.equal(PILOT_SPAWN_POLICY.lockedRuntime.model, "gpt-5.6-luna");
  assert.equal(PILOT_SPAWN_POLICY.lockedRuntime.thinkingLevel, "max");
  assert.throws(() => goalFor("task", "other"));
});

test("all preparation decisions are required, failed or incomplete controls cannot become eligible", () => {
  const tasks = ["pr498", "pr180", "pr332"].map((caseId) => ({
    caseId,
    status: "blocked",
  }));
  assert.deepEqual(eligibleCases(tasks), []);
  assert.throws(() => eligibleCases(tasks.slice(0, 2)));
  assert.throws(() => eligibleCases([...tasks].reverse()));
  tasks[1] = {
    ...tasks[1],
    status: "ready",
    modelSource: "/source",
    taskPath: "/task",
    godotBin: "/godot",
    evaluator: { module: "/check.mjs" },
    controls: { passed: true },
    base: { commit: "a".repeat(40) },
    reference: { commit: "b".repeat(40) },
  };
  assert.deepEqual(eligibleCases(tasks), ["pr180"]);
  tasks[1].controls.passed = false;
  assert.throws(() => eligibleCases(tasks));
});

test("live mode requires a known command and explicit new output; duplicate and malformed arguments fail", () => {
  assert.equal(argumentsFor(["run", "--output", "/tmp/batch"]).mode, "run");
  for (const args of [
    ["run"],
    ["rerun", "--output", "/tmp/x"],
    ["freeze", "--output", "/tmp/x"],
    ["run", "--output", "/tmp/x", "--output", "/tmp/y"],
    ["run", "--output", "/tmp/x", "--unknown", "true"],
  ])
    assert.throws(() => argumentsFor(args));
});

test("offline source guard rejects remotes, visible history, and unreachable history objects", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "chronorift-feature-source-test-"),
  );
  const project = join(directory, "source"),
    state = join(directory, "state");
  const command = promisify(execFile);
  const git = (...args) => command("git", ["-C", project, ...args]);
  try {
    await mkdir(project);
    await mkdir(state);
    await git("init");
    await git("config", "user.name", "Offline Test");
    await git("config", "user.email", "offline@example.invalid");
    await writeFile(
      join(project, "project.godot"),
      'config_version=5\n[application]\nconfig/name="Offline source test"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    );
    await writeFile(
      join(project, "main.tscn"),
      '[gd_scene format=3]\n[node name="Main" type="Node"]\n',
    );
    await git("add", "project.godot", "main.tscn");
    await git("commit", "-m", "baseline");
    const task = {
      modelSource: project,
      projectRoot: ".",
      base: { tree: (await git("rev-parse", "HEAD^{tree}")).stdout.trim() },
    };
    const identity = await sourceIdentity(task, state);
    assert.equal(identity.baselineHistoryOnly, true);
    await assert.rejects(
      sourceIdentity({ ...task, base: { tree: "0".repeat(40) } }, state),
      /upstream base tree/u,
    );
    await git("remote", "add", "origin", "https://example.invalid/reference");
    await assert.rejects(sourceIdentity(task, state), /without remotes/u);
    await git("remote", "remove", "origin");
    await git("commit", "--allow-empty", "-m", "hidden reference");
    await assert.rejects(sourceIdentity(task, state), /one-commit/u);
    await git("reset", "--hard", identity.commit);
    await assert.rejects(sourceIdentity(task, state), /history objects/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source guard rejects an unreachable answer blob even without later commits", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "chronorift-feature-blob-test-"),
  );
  const project = join(directory, "source"),
    state = join(directory, "state");
  const command = promisify(execFile);
  const git = (...args) => command("git", ["-C", project, ...args]);
  try {
    await mkdir(project);
    await mkdir(state);
    await git("init");
    await git("config", "user.name", "Offline Test");
    await git("config", "user.email", "offline@example.invalid");
    await writeFile(join(project, "project.godot"), "config_version=5\n");
    await git("add", ".");
    await git("commit", "-m", "baseline");
    await writeFile(
      join(state, "answer"),
      "Unreachable future reference content",
    );
    await git("hash-object", "-w", join(state, "answer"));
    await assert.rejects(
      sourceIdentity({ modelSource: project }, state),
      /unreachable non-baseline/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an all-blocked batch freezes without auth or model calls, preserves decisions, and refuses a second run", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "chronorift-feature-blocked-test-"),
  );
  const preparation = join(directory, "prep"),
    output = join(directory, "batch");
  const command = promisify(execFile);
  const entry = fileURLToPath(new URL("run.mjs", import.meta.url));
  const invoke = (...args) =>
    command(
      process.execPath,
      ["--dns-result-order=ipv4first", "--import", "tsx", entry, ...args],
      { maxBuffer: 1024 * 1024 },
    );
  try {
    for (const caseId of ["pr498", "pr180", "pr332"]) {
      await mkdir(join(preparation, caseId), { recursive: true });
      await writeFile(
        join(preparation, caseId, "manifest.json"),
        JSON.stringify({
          caseId,
          status: "blocked",
          reason: "Offline fixture reference fails behavior",
        }),
      );
    }
    await invoke("freeze", "--preparation", preparation, "--output", output);
    const manifest = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    );
    assert.deepEqual(manifest.ids, []);
    assert.equal(manifest.model, null);
    assert.equal(Object.keys(manifest.tasks).length, 3);
    await invoke("run", "--output", output);
    await assert.rejects(invoke("run", "--output", output), /EEXIST/u);
    await invoke("evaluate", "--output", output);
    await invoke("summarize", "--output", output);
    const summary = JSON.parse(
      await readFile(join(output, "derived", "summary.json"), "utf8"),
    );
    assert.equal(summary.modelTrials, 0);
    assert.equal(summary.performanceComparisonAvailable, false);
    assert.deepEqual(summary.rows, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const entry of [
  new URL("./run.mjs", import.meta.url),
  new URL("../godot-capacity-multi-pilot/run.mjs", import.meta.url),
]) {
  test(`${entry.pathname} summarizes a nonempty cohort without a model`, async () => {
    const output = await mkdtemp(
      join(tmpdir(), "chronorift-summary-dispatch-"),
    );
    const command = promisify(execFile);
    const save = (path, value) => writeFile(path, JSON.stringify(value));
    try {
      await mkdir(join(output, "evaluation"));
      await mkdir(join(output, "pr180-single"));
      await save(join(output, "manifest.json"), {
        ids: ["pr180-single"],
        cohort: "offline-dispatch-fixture",
        collaborationPolicy: "adaptive",
        config: { provider: "fixture", model: "fixture", thinkingLevel: "off" },
      });
      await save(
        join(output, "evaluation", "results.json"),
        [1, 2].map((repeat) => ({
          id: "pr180-single",
          repeat,
          outcome: "requires_review",
          reason: "Stopped before any model or candidate existed",
        })),
      );
      await save(join(output, "pr180-single", "completion.json"), {
        status: "cancelled",
        durationMs: 123,
        failure: "Offline fixture cancellation",
      });
      await save(join(output, "live-completion.json"), {
        observedProcesses: [],
        survivingObservedProcesses: [],
      });
      const before = await readFile(
        join(output, "pr180-single", "completion.json"),
        "utf8",
      );
      await command(
        process.execPath,
        [
          "--dns-result-order=ipv4first",
          "--import",
          "tsx",
          fileURLToPath(entry),
          "summarize",
          "--output",
          output,
        ],
        { maxBuffer: 1024 * 1024 },
      );
      const summary = JSON.parse(
        await readFile(join(output, "derived", "summary.json"), "utf8"),
      );
      assert.equal(summary.rows.length, 1);
      assert.equal(summary.rows[0].status, "cancelled");
      assert.equal(summary.rows[0].acceptance, "requires_review");
      assert.equal(summary.rows[0].tokens, null);
      assert.equal(summary.rows[0].usageIncomplete, true);
      assert.match(
        await readFile(join(output, "derived", "results.csv"), "utf8"),
        /pr180-single/u,
      );
      assert.equal(
        await readFile(join(output, "pr180-single", "completion.json"), "utf8"),
        before,
      );
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
}
