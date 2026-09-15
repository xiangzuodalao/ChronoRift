// Generous-budget profile; each frozen case/arm runs once in serial order.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFeaturePilot } from "../godot-feature-multi-pilot/pilot.mjs";
import {
  CONFIG as ORIGINAL_CONFIG,
  PILOT_SPAWN_POLICY,
  COMMON_INSTRUCTIONS as ORIGINAL_COMMON,
  MULTI_APPENDIX as ORIGINAL_MULTI,
} from "../godot-feature-multi-pilot/run.mjs";
export { PILOT_SPAWN_POLICY };
export const CONFIG = Object.freeze({
  ...ORIGINAL_CONFIG,
  timeoutMs: 5_400_000,
  sharedToolCallLimit: 2048,
});
export const EXECUTION_LIMITS = Object.freeze({
  sharedToolCallLimit: 2048,
  workerTurnTimeoutMs: 2_700_000,
  workerTurnToolCallLimit: 512,
});
export const CASE_ORDER = Object.freeze(["pr180", "truck1295", "gloot313"]);
export const COMMON_INSTRUCTIONS = ORIGINAL_COMMON.replace(
  "20 minutes",
  "90 minutes",
).replace("budget is 256", "budget is 2048");
export const MULTI_APPENDIX = ORIGINAL_MULTI.replace(
  "10-minute and 64-execution-call",
  "45-minute and 512-execution-call",
);
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
  executionLimits: EXECUTION_LIMITS,
  spawnPolicy: PILOT_SPAWN_POLICY,
  caseOrder: CASE_ORDER,
  cohort: "godot-capacity-multi-v1",
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
