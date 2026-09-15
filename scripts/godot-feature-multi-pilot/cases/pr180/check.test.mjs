import assert from "node:assert/strict";
import { test } from "node:test";
import { assess, ASSERTION_IDS } from "./check.mjs";

const completed = (stdout = "", exitCode = 0) => ({
  status: "exited",
  exitCode,
  signal: null,
  timedOut: false,
  cancelled: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdout,
  stderr: "",
});
const runtime = (
  assertions = ASSERTION_IDS.map((id) => ({ id, passed: true })),
) => ({
  sourceUnchanged: true,
  sourceSha256: "same",
  observedSourceSha256: "same",
  process: completed(
    "CHRONORIFT_FEATURE_EVAL=" +
      JSON.stringify({ schemaVersion: 1, assertions }) +
      "\n",
    assertions.every((a) => a.passed) ? 0 : 1,
  ),
});

test("requires complete frozen scope for a feature pass", () => {
  assert.equal(assess(completed(), runtime()).outcome, "passed");
  assert.equal(
    assess(completed(), runtime([{ id: ASSERTION_IDS[0], passed: true }]))
      .outcome,
    "requires_review",
  );
  assert.equal(
    assess(completed(), runtime([{ id: ASSERTION_IDS[0], passed: false }]))
      .outcome,
    "assertions_failed",
  );
});

test("rejects script errors, process failures, truncation and source mutation", () => {
  for (const fields of [
    { stderr: "SCRIPT ERROR: broken" },
    { exitCode: 3 },
    { timedOut: true },
    { cancelled: true },
    { stdoutTruncated: true },
    { stderrTruncated: true },
  ]) {
    const result = runtime();
    Object.assign(result.process, fields);
    assert.equal(assess(completed(), result).outcome, "requires_review");
  }
  assert.equal(
    assess(completed(), { ...runtime(), sourceUnchanged: false }).outcome,
    "requires_review",
  );
  assert.equal(
    assess(completed(), { ...runtime(), observedSourceSha256: "changed" })
      .outcome,
    "requires_review",
  );
  assert.equal(
    assess({ ...completed(), stderr: "ERROR: import failed" }, runtime())
      .outcome,
    "requires_review",
  );
});

test("rejects missing, duplicated and contradictory evaluator evidence", () => {
  const missing = runtime();
  missing.process.stdout = "";
  assert.equal(assess(completed(), missing).outcome, "requires_review");
  const duplicate = runtime();
  duplicate.process.stdout += duplicate.process.stdout;
  assert.equal(assess(completed(), duplicate).outcome, "requires_review");
  const contradiction = runtime();
  contradiction.process.exitCode = 1;
  assert.equal(assess(completed(), contradiction).outcome, "requires_review");
});
