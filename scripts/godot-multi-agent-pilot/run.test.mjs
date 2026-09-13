import assert from "node:assert/strict";
import { test } from "node:test";
import {
  argumentsFor,
  COHORTS,
  idsForCases,
  CONFIG,
  GOALS,
  MULTI_APPENDIX,
  PILOT_SPAWN_POLICY,
  assertPilotWorkerRuntime,
  holdoutOrchestrationAmendment,
} from "./run.mjs";

test("adaptive pilot preserves budgets while allowing zero through three same-model workers", () => {
  assert.equal(CONFIG.timeoutMs, 1_200_000);
  assert.equal(CONFIG.maxAgents, 3);
  assert.equal(CONFIG.dnsOrder, "ipv4first");
  assert.equal(CONFIG.sharedToolCallLimit, 256);
  assert.equal(CONFIG.provider, "openai-codex");
  assert.equal(CONFIG.model, "gpt-5.6-luna");
  assert.equal(CONFIG.thinkingLevel, "max");
  assert.deepEqual(Object.keys(GOALS), ["gn1", "city", "mob"]);
  assert.match(MULTI_APPENDIX, /零个 worker/u);
  assert.match(MULTI_APPENDIX, /替代 Root 后续工作/u);
  assert.match(MULTI_APPENDIX, /followup_task/u);
  assert.doesNotMatch(MULTI_APPENDIX, /恰好三个/u);
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

test("development and holdout cohorts each contain exactly one attempt per arm", () => {
  assert.deepEqual(idsForCases(COHORTS.development), [
    "gn1-single",
    "gn1-multi",
    "city-single",
    "city-multi",
  ]);
  assert.deepEqual(idsForCases(COHORTS.holdout), ["mob-single", "mob-multi"]);
  for (const cases of [[], ["gn1", "gn1"], ["unknown"], null])
    assert.throws(() => idsForCases(cases));
  assert.throws(() =>
    argumentsFor(["prepare", "--output", "/tmp/new", "--cohort", "unknown"]),
  );
});

const amendmentFixture = () => {
  const previous = structuredClone({
    config: CONFIG,
    spawnPolicy: PILOT_SPAWN_POLICY,
    multiAppendix: MULTI_APPENDIX,
    cases: COHORTS.development,
    goals: { gn1: GOALS.gn1, city: GOALS.city },
    product: {
      sha256: "a".repeat(64),
      files: [
        {
          path: "apps/cli/src/vnext/project-environment-preview.ts",
          sha256: "b".repeat(64),
        },
        {
          path: "scripts/godot-multi-agent-pilot/run.mjs",
          sha256: "c".repeat(64),
        },
      ],
    },
  });
  const currentProduct = structuredClone(previous.product);
  currentProduct.sha256 = "d".repeat(64);
  currentProduct.files[1].sha256 = "e".repeat(64);
  return { previous, currentProduct };
};

test("holdout records an explicit runner-only startup repair without claiming unchanged product identity", () => {
  const { previous, currentProduct } = amendmentFixture();
  assert.equal(holdoutOrchestrationAmendment(previous, previous.product), null);
  const amendment = holdoutOrchestrationAmendment(previous, currentProduct);
  assert.deepEqual(amendment.changedPaths, [
    "scripts/godot-multi-agent-pilot/run.mjs",
  ]);
  assert.equal(
    amendment.previousRunnerSha256,
    previous.product.files[1].sha256,
  );
  assert.equal(amendment.currentRunnerSha256, currentProduct.files[1].sha256);
  assert.equal(amendment.projectRoot, "3d/squash_the_creeps");
  assert.match(amendment.reason, /Startup-only repair/u);
});

test("holdout runner repair refuses other product changes, file-set changes and absent source hashes", () => {
  for (const mutate of [
    (product) => {
      product.files[0].sha256 = "changed-runtime";
    },
    (product) => {
      product.files.push({ path: "scripts/extra.mjs", sha256: "new-file" });
    },
    (product) => {
      product.files.pop();
    },
    (product) => {
      product.files[1] = { path: product.files[1].path, deleted: true };
    },
  ]) {
    const { previous, currentProduct } = amendmentFixture();
    mutate(currentProduct);
    assert.throws(
      () => holdoutOrchestrationAmendment(previous, currentProduct),
      /Holdout/u,
    );
  }
  const { previous, currentProduct } = amendmentFixture();
  previous.product.files[1] = {
    path: previous.product.files[1].path,
    deleted: true,
  };
  assert.throws(
    () => holdoutOrchestrationAmendment(previous, currentProduct),
    /Holdout/u,
  );
});

test("holdout startup recovery preserves model, budgets, worker policy, goals and strategy", () => {
  for (const mutate of [
    (previous) => {
      previous.config.model = "different";
    },
    (previous) => {
      previous.config.sharedToolCallLimit = 999;
    },
    (previous) => {
      previous.spawnPolicy.maxCreatedAgents = 4;
    },
    (previous) => {
      previous.goals.gn1 = "different task";
    },
    (previous) => {
      previous.multiAppendix += " different strategy";
    },
  ]) {
    const { previous, currentProduct } = amendmentFixture();
    mutate(previous);
    assert.throws(
      () => holdoutOrchestrationAmendment(previous, currentProduct),
      /configuration or strategy changed/u,
    );
    assert.throws(
      () => holdoutOrchestrationAmendment(previous, previous.product),
      /configuration or strategy changed/u,
    );
  }
});
