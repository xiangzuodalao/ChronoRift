// Historical 20-minute feature profile. Keep budgets and shared instructions stable.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, PILOT_SPAWN_POLICY } from "../godot-multi-agent-pilot/run.mjs";
import { createFeaturePilot } from "./pilot.mjs";
export { REPO } from "./pilot.mjs";
export { CONFIG, PILOT_SPAWN_POLICY };
export const CASE_ORDER = Object.freeze(["pr498", "pr180", "pr332"]);
export const COMMON_INSTRUCTIONS =
  "Implement the complete requested feature in the candidate workspace. You may change code and add focused tests. Choose the investigation, implementation, and validation steps. Preserve unrelated behavior and use existing project conventions where useful; acceptance depends on behavior and the stated public API, not copying a particular code structure. After the relevant final-candidate checks pass, finish and report evidence and unverified requirements. Repeat equivalent work or validation only for an observed failure, a concrete uncovered requirement, conflicting evidence, or source changes. A successful tool call or completed investigation does not prove acceptance; inspect game operation outcomes. Stop live game executions when finished with them and before validating newer source. The overall investigation budget is 20 minutes and the execution-call budget is 256; cleanup calls remain available. Work autonomously within that budget.";
// Only collaboration capabilities and their necessary resource/write-sharing explanation differ.
// Adaptive delegation/settlement guidance is the unchanged HEAD tool metadata.
export const MULTI_APPENDIX =
  "Collaboration is enabled with the current Adaptive policy. You may create up to three direct workers, including zero. Workers may implement code within a clearly bounded scope as well as investigate or validate. All agents share the candidate workspace; coordinate overlapping edits. Worker turns have a 10-minute and 64-execution-call limit within the same team budget. No fixed number, roles, or division of work is required.";

const entryPath = fileURLToPath(import.meta.url);
export const {
  trialOrder,
  goalFor,
  sourceIdentity,
  eligibleCases,
  fileIdentity,
  argumentsFor,
  main,
} = createFeaturePilot({
  entryPath,
  config: CONFIG,
  spawnPolicy: PILOT_SPAWN_POLICY,
  caseOrder: CASE_ORDER,
  cohort: "godot-feature-multi-v1",
  commonInstructions: COMMON_INSTRUCTIONS,
  multiAppendix: MULTI_APPENDIX,
});
if (process.argv[1] && resolve(process.argv[1]) === entryPath) {
  try {
    await main();
  } catch (error) {
    console.error(String(error));
    process.exitCode = 2;
  }
}
