#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const [codingPath, treatmentPath] = process.argv.slice(2);
if (!codingPath || !treatmentPath) {
  process.stderr.write(
    "usage: node scripts/evaluate-mob-orientation-ablation.mjs CODING_ONLY.json CHRONORIFT_V2.json\n",
  );
  process.exit(2);
}

const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const coding = await read(codingPath);
const treatment = await read(treatmentPath);
const failures = [];
const require = (condition, message) => {
  if (!condition) failures.push(message);
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const findNumbers = (value, key, output = []) => {
  if (Array.isArray(value)) {
    for (const child of value) findNumbers(child, key, output);
  } else if (value && typeof value === "object") {
    for (const [name, child] of Object.entries(value)) {
      if (name === key && typeof child === "number") output.push(child);
      findNumbers(child, key, output);
    }
  }
  return output;
};

require(coding.arm === "coding-only", "first input is not coding-only");
require(treatment.arm === "chronorift-v2", "second input is not chronorift-v2");
require(coding.taskId !== treatment.taskId, "arms reused a Task identity");
for (const key of [
  "provider",
  "model",
  "thinkingLevel",
  "timeoutMs",
  "toolCallBudget",
  "prompt",
  "sourceCommit",
  "sourceTree",
  "projectPrefix",
  "adapterSha256",
  "sharedToolNames",
]) {
  require(same(
    coding.configuration?.[key],
    treatment.configuration?.[key],
  ), `matched configuration differs at ${key}`);
}
require(same(
  coding.configuration?.chronoriftToolNames,
  [],
), "coding-only exposed ChronoRift tools");
require(same(treatment.configuration?.chronoriftToolNames, [
  "game_capabilities",
  "game_launch",
  "game_stop",
  "game_query",
]), "treatment tool surface drifted");
for (const [label, arm] of [
  ["coding-only", coding],
  ["treatment", treatment],
]) {
  require(arm.runIntegrity === "valid", `${label} run integrity is invalid`);
  require(arm.cleanupComplete === true, `${label} cleanup is incomplete`);
  require(arm.source?.checkoutCleanAfter ===
    true, `${label} changed the Host source checkout`);
  require(typeof arm.candidatePatch?.unifiedDiff === "string" &&
    arm.candidatePatch.unifiedDiff.length >
      0, `${label} produced no candidate patch`);
  require(arm.toolCallBudget?.admitted <= arm.toolCallBudget?.limit &&
    arm.toolCallBudget?.rejected ===
      0, `${label} exceeded the tool-call budget`);
}

require(coding.evaluator?.evaluatorAccepted ===
  false, "coding-only must fail the independent evaluator 0/3");
require(treatment.evaluator?.evaluatorAccepted === true &&
  treatment.evaluator.results?.length === 3 &&
  treatment.evaluator.results.every(
    (result) => result.accepted === true,
  ), "treatment must pass the independent evaluator 3/3");

const launches = new Map();
let parentQuery = null;
for (const call of treatment.gameToolCalls ?? []) {
  const request = call.request ?? {};
  const response = call.response ?? {};
  if (response.outcome !== "success") continue;
  const output = response.output ?? {};
  if (request.toolName === "game_launch") {
    launches.set(output.executionId, output.buildId);
  } else if (
    request.toolName === "game_query" &&
    launches.get(request.input?.executionId) === treatment.initialBuildId &&
    JSON.stringify(output).includes("mob_spawn_orientation")
  ) {
    parentQuery = output;
    break;
  }
}
require(parentQuery !==
  null, "treatment did not query Mob state from the exact initial Build before mutation");
const parentAlignments = findNumbers(parentQuery, "up_alignment");
require(parentAlignments.some(
  (value) => value < 0.999999,
), "treatment initial-Build query did not observe a tilted Mob");
require(treatment.candidateObservation?.buildId !==
  treatment.initialBuildId, "treatment candidate runtime did not use a changed Build");
const candidateAlignments = findNumbers(
  treatment.candidateObservation?.state,
  "up_alignment",
);
const candidateVertical = findNumbers(
  treatment.candidateObservation?.state,
  "velocity_y",
);
const candidateSpeed = findNumbers(
  treatment.candidateObservation?.state,
  "horizontal_speed",
);
require(candidateAlignments.length > 0 &&
  candidateAlignments.every(
    (value) => value >= 0.999999,
  ), "treatment candidate runtime did not observe upright Mobs");
require(candidateVertical.length > 0 &&
  candidateVertical.every(
    (value) => Math.abs(value) <= 0.000001,
  ), "treatment candidate runtime has vertical Mob velocity");
require(candidateSpeed.length > 0 &&
  candidateSpeed.every(
    (value) => value >= 10 && value <= 18,
  ), "treatment candidate runtime did not preserve configured horizontal speed");

const heroPromoted = failures.length === 0;
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      caseId: "godot-demo-mob-orientation",
      heroPromoted,
      outcome: heroPromoted ? "treatment_win" : "not_promoted",
      evaluator: {
        codingOnlyAccepted: coding.evaluator?.evaluatorAccepted === true,
        chronoriftV2Accepted: treatment.evaluator?.evaluatorAccepted === true,
      },
      treatmentInitialBuildRuntimeUsed: parentQuery !== null,
      failures,
      limitations: [
        "One predeclared matched pair is not a statistical estimate.",
        "The result covers one fixed upstream project revision and one fixed Adapter V2.",
      ],
    },
    null,
    2,
  )}\n`,
);
if (!heroPromoted) process.exitCode = 1;
