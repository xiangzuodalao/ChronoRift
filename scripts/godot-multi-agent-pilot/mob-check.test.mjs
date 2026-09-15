import assert from "node:assert/strict";
import { test } from "node:test";
import { assess } from "./mob-check.mjs";

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
const runtime = (overrides = {}) => ({
  sourceSha256: "fixed",
  observedSourceSha256: "fixed",
  sourceUnchanged: true,
  process: {
    ...complete,
    stdout:
      "CHRONORIFT_MOB_EVAL=" +
      JSON.stringify({
        schemaVersion: 1,
        observations: [7301, 7402, 7503].map((seed) => ({
          seed,
          upAlignment: 1,
          velocityY: 0,
          horizontalSpeed: 12,
          minSpeed: 10,
          maxSpeed: 18,
        })),
      }),
    ...overrides,
  },
});

test("mob oracle distinguishes observed assertions from infrastructure failures", () => {
  assert.equal(assess(complete, runtime()).outcome, "passed");
  const bad = runtime();
  bad.process.stdout = bad.process.stdout.replaceAll(
    '"upAlignment":1',
    '"upAlignment":0.9',
  );
  bad.process.exitCode = 1;
  assert.equal(assess(complete, bad).outcome, "assertions_failed");
  bad.process.exitCode = 0;
  assert.equal(assess(complete, bad).outcome, "requires_review");
});

test("mob oracle refuses incomplete, duplicated, tampered and erroneous output", () => {
  for (const overrides of [
    { timedOut: true },
    { cancelled: true },
    { stdoutTruncated: true },
    { stderrTruncated: true },
    { signal: "SIGTERM" },
    { stdout: "" },
    { stderr: "SCRIPT ERROR: source failed" },
    { stdout: runtime().process.stdout + "\n" + runtime().process.stdout },
    { stdout: runtime().process.stdout.replace('"seed":7402', '"seed":7301') },
  ])
    assert.equal(
      assess(complete, runtime(overrides)).outcome,
      "requires_review",
    );
  assert.equal(
    assess({ ...complete, exitCode: 1 }, runtime()).outcome,
    "requires_review",
  );
  assert.equal(
    assess(complete, { ...runtime(), sourceUnchanged: false }).outcome,
    "requires_review",
  );
  assert.equal(
    assess(complete, { ...runtime(), observedSourceSha256: "changed" }).outcome,
    "requires_review",
  );
});
