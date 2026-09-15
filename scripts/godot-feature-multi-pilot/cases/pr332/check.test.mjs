import assert from "node:assert/strict";
import { test } from "node:test";
import { assess, parseArguments } from "./check.mjs";

const complete = {
  status: "exited",
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdout: "",
  stderr: "",
};
const record = (passed = true) => ({
  schemaVersion: 1,
  caseId: "pr332",
  observations: [{ name: "primary/result", passed }],
});
const runtime = (data = record(), overrides = {}) => ({
  sourceSha256: "fixed",
  observedSourceSha256: "fixed",
  sourceUnchanged: true,
  process: {
    ...complete,
    stdout: "CHRONORIFT_PR332_EVAL=" + JSON.stringify(data),
    ...overrides,
  },
});

test("PR332 assessment separates behavioral failure from incomplete evidence", () => {
  assert.equal(assess(complete, runtime()).outcome, "passed");
  assert.equal(
    assess(complete, runtime(record(false), { exitCode: 1 })).outcome,
    "assertions_failed",
  );
  assert.equal(
    assess(complete, runtime(record(false))).outcome,
    "requires_review",
  );
  assert.equal(
    assess(complete, runtime(record(), { exitCode: 1 })).outcome,
    "requires_review",
  );
});

test("PR332 assessment refuses errors, partial output and stage mutation", () => {
  for (const overrides of [
    { timedOut: true },
    { cancelled: true },
    { stdoutTruncated: true },
    { stderrTruncated: true },
    { signal: "SIGTERM" },
    { stdout: "" },
    { stderr: "SCRIPT ERROR: bad script" },
    { stdout: runtime().process.stdout + "\n" + runtime().process.stdout },
  ]) {
    assert.equal(
      assess(complete, runtime(record(), overrides)).outcome,
      "requires_review",
    );
  }
  for (const overrides of [
    { exitCode: 1 },
    { stderr: "ERROR: failed import" },
    { stderrTruncated: true },
  ]) {
    assert.equal(
      assess({ ...complete, ...overrides }, runtime()).outcome,
      "requires_review",
    );
  }
  for (const overrides of [
    { sourceUnchanged: false },
    { observedSourceSha256: "changed" },
  ]) {
    assert.equal(
      assess(complete, { ...runtime(), ...overrides }).outcome,
      "requires_review",
    );
  }
  for (const data of [
    { ...record(), caseId: "other" },
    { ...record(), observations: [] },
    { ...record(), observations: [{ name: "bad", passed: "true" }] },
  ]) {
    assert.equal(assess(complete, runtime(data)).outcome, "requires_review");
  }
});

test("PR332 checker requires explicit private oracle and rejects duplicate flags", () => {
  const args = [
    "--project",
    "/tmp/project",
    "--godot-bin",
    "/tmp/godot",
    "--output",
    "/tmp/output",
    "--checker",
    "/tmp/hidden-check.gd",
  ];
  assert.equal(parseArguments(args).checkerPath, "/tmp/hidden-check.gd");
  assert.throws(
    () => parseArguments(args.slice(0, -2)),
    /checker is required/u,
  );
  assert.throws(() => parseArguments([...args, "--checker", "/tmp/other"]));
});
