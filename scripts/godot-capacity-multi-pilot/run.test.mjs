import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  CASE_ORDER,
  COMMON_INSTRUCTIONS,
  CONFIG,
  EXECUTION_LIMITS,
  MULTI_APPENDIX,
  goalFor,
  trialOrder,
} from "./run.mjs";
import {
  COMMON_INSTRUCTIONS as PREVIOUS_COMMON,
  CONFIG as PREVIOUS_CONFIG,
  MULTI_APPENDIX as PREVIOUS_MULTI,
} from "../godot-feature-multi-pilot/run.mjs";

test("capacity profile changes resource limits while preserving shared task instructions and Adaptive policy", () => {
  assert.equal(CONFIG.timeoutMs, 90 * 60_000);
  assert.equal(CONFIG.sharedToolCallLimit, 2048);
  assert.deepEqual(EXECUTION_LIMITS, {
    sharedToolCallLimit: 2048,
    workerTurnTimeoutMs: 45 * 60_000,
    workerTurnToolCallLimit: 512,
  });
  assert.equal(PREVIOUS_CONFIG.timeoutMs, 20 * 60_000);
  assert.equal(PREVIOUS_CONFIG.sharedToolCallLimit, 256);
  assert.equal(
    COMMON_INSTRUCTIONS,
    PREVIOUS_COMMON.replace("20 minutes", "90 minutes").replace(
      "budget is 256",
      "budget is 2048",
    ),
  );
  assert.equal(
    MULTI_APPENDIX,
    PREVIOUS_MULTI.replace(
      "10-minute and 64-execution-call",
      "45-minute and 512-execution-call",
    ),
  );
  assert.equal(
    goalFor("Feature contract", "multi"),
    goalFor("Feature contract", "single") + "\n\n" + MULTI_APPENDIX,
  );
  assert.deepEqual(trialOrder(CASE_ORDER), [
    "pr180-single",
    "pr180-multi",
    "truck1295-multi",
    "truck1295-single",
    "gloot313-single",
    "gloot313-multi",
  ]);
});

test("freeze persists enlarged execution limits and rejects changed limits before any live invocation", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "chronorift-capacity-freeze-"),
  );
  const preparation = join(directory, "prep");
  const output = join(directory, "batch");
  const command = promisify(execFile);
  const entry = fileURLToPath(new URL("run.mjs", import.meta.url));
  const invoke = (...args) =>
    command(
      process.execPath,
      ["--dns-result-order=ipv4first", "--import", "tsx", entry, ...args],
      { maxBuffer: 1024 * 1024 },
    );
  try {
    for (const caseId of CASE_ORDER) {
      await mkdir(join(preparation, caseId), { recursive: true });
      await writeFile(
        join(preparation, caseId, "manifest.json"),
        JSON.stringify({
          caseId,
          status: "blocked",
          reason: "Offline fixture",
        }),
      );
    }
    await invoke("freeze", "--preparation", preparation, "--output", output);
    const manifestPath = join(output, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.cohort, "godot-capacity-multi-v1");
    assert.deepEqual(manifest.executionLimits, EXECUTION_LIMITS);
    assert.equal(manifest.config.timeoutMs, 5_400_000);
    assert.equal(manifest.model, null);
    assert.deepEqual(manifest.ids, []);
    manifest.executionLimits.workerTurnToolCallLimit = 64;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      invoke("run", "--output", output),
      /resource limits changed after freeze/u,
    );
    await assert.rejects(readFile(join(output, "live-start.json")), /ENOENT/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
