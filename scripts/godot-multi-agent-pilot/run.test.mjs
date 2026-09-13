import assert from "node:assert/strict";
import { test } from "node:test";
import {
  argumentsFor,
  CONFIG,
  GOALS,
  MULTI_APPENDIX,
  PILOT_SPAWN_POLICY,
  assertPilotWorkerRuntime,
} from "./run.mjs";

test("pilot fixes twenty-minute investigations and three same-model workers", () => {
  assert.equal(CONFIG.timeoutMs, 1_200_000);
  assert.equal(CONFIG.maxAgents, 3);
  assert.equal(CONFIG.dnsOrder, "ipv4first");
  assert.equal(Object.keys(GOALS).length, 2);
  assert.match(MULTI_APPENDIX, /恰好三个 worker/u);
});
test("pilot refuses runtime drift before starting a model worker", () => {
  assert.equal(PILOT_SPAWN_POLICY.maxCreatedAgents, 3);
  assert.equal(PILOT_SPAWN_POLICY.maxDepth, 1);
  assert.doesNotThrow(() =>
    assertPilotWorkerRuntime(PILOT_SPAWN_POLICY.lockedRuntime),
  );
  for (const replacement of [
    { model: "inherit" },
    { thinkingLevel: "high" },
    { provider: "different" },
  ])
    assert.throws(
      () =>
        assertPilotWorkerRuntime({
          ...PILOT_SPAWN_POLICY.lockedRuntime,
          ...replacement,
        }),
      /differs from the locked configuration/,
    );
});
test("CLI rejects duplicate options, unknown modes and missing output before effects", () => {
  for (const args of [
    ["run"],
    ["unknown", "--output", "/tmp/x"],
    ["run", "--output", "/tmp/x", "--output", "/tmp/y"],
    ["run", "--output", "/tmp/x", "--timeout-ms", "1"],
    ["arm", "--output", "/tmp/x", "--id", "\0"],
  ])
    assert.throws(() => argumentsFor(args));
  assert.equal(argumentsFor(["run", "--output", "/tmp/x"]).output, "/tmp/x");
});
