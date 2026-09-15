import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assess, ASSERTION_IDS, snapshotBaseline } from "./check.mjs";

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
const runtime = (failed = false) => ({
  sourceSha256: "unchanged",
  observedSourceSha256: "unchanged",
  sourceUnchanged: true,
  process: {
    ...complete,
    exitCode: failed ? 1 : 0,
    stdout:
      "CHRONORIFT_PR498_EVAL=" +
      JSON.stringify({
        schemaVersion: 1,
        assertions: ASSERTION_IDS.map((id, index) => ({
          id,
          passed: !(failed && index === 10),
          observed: [],
        })),
      }),
  },
});

test("feature assertions cannot pass when import, output or source integrity fails", () => {
  assert.equal(assess(complete, runtime()).outcome, "passed");
  assert.equal(assess(complete, runtime(true)).outcome, "assertions_failed");
  for (const changes of [
    { timedOut: true },
    { cancelled: true },
    { stdoutTruncated: true },
    { stderrTruncated: true },
    { exitCode: 2 },
    { stderr: "ERROR: network is unavailable" },
  ]) {
    assert.equal(
      assess({ ...complete, ...changes }, runtime()).outcome,
      "requires_review",
    );
  }
  for (const change of [
    { sourceUnchanged: false },
    { observedSourceSha256: "changed" },
  ]) {
    assert.equal(
      assess(complete, { ...runtime(), ...change }).outcome,
      "requires_review",
    );
  }
  for (const stdout of [
    "",
    runtime().process.stdout + "\n" + runtime().process.stdout,
    runtime().process.stdout.replace(
      "combined_keyboard_mouse_cycle",
      "different_assertion",
    ),
  ]) {
    const result = runtime();
    result.process.stdout = stdout;
    assert.equal(assess(complete, result).outcome, "requires_review");
  }
});

test("standalone snapshot retains upstream override and addons without permitting unsafe files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pr498-snapshot-test-"));
  try {
    await writeFile(join(root, "project.godot"), "config_version=5\n");
    await writeFile(join(root, "override.cfg"), "[input]\n");
    await mkdir(join(root, "addons"));
    await writeFile(join(root, "addons", "example.gd"), "extends Node\n");
    const files = await snapshotBaseline(root);
    assert.deepEqual(
      files.map((file) => file.relativePath),
      ["addons/example.gd", "override.cfg", "project.godot"],
    );
    await symlink("project.godot", join(root, "unsafe-link"));
    await assert.rejects(snapshotBaseline(root), /link or special/u);
    await rm(join(root, "unsafe-link"));
    await link(join(root, "project.godot"), join(root, "hard-link"));
    await assert.rejects(snapshotBaseline(root), /hard link/u);
    await rm(join(root, "hard-link"));
    for (const name of ["native.gdextension", "auth.json"]) {
      await writeFile(join(root, name), "{}");
      await assert.rejects(snapshotBaseline(root), /sensitive or native/u);
      await rm(join(root, name));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
