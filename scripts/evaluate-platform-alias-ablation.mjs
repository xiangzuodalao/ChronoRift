#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const EXPECTED = Object.freeze({
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  thinkingLevel: "max",
  timeoutMs: 600_000,
  environmentProfile: "coding",
  environmentInstructionProfile: "task-id-v1",
  prompt:
    "A falling platform can activate while the player is still outside its visible width. Investigate the project, make the smallest appropriate fix, and validate the candidate. You choose the investigation, edit, and validation strategy.",
  sourceCommit: "e78b339500dec8e480b33723c4156bf9b74cd25c",
  sourceTree: "9941cb045b3cd73c4554ca1de337a341b383590b",
  sharedToolNames: [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "godot_run",
  ],
  chronoriftToolNames: [
    "game_capabilities",
    "game_launch",
    "game_stop",
    "game_query",
  ],
});

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isSha256 = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const isAbsolutePath = (value) =>
  typeof value === "string" && value.startsWith("/");

const fail = (message) => {
  throw new Error(message);
};

const requireObject = (value, path) =>
  isObject(value) ? value : fail(`${path} must be an object`);

const requireArray = (value, path) =>
  Array.isArray(value) ? value : fail(`${path} must be an array`);

const requireExactKeys = (value, expectedKeys, path) => {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (!same(actual, expected)) {
    fail(`${path} keys must be exactly ${expected.join(",")}`);
  }
};

const requireBoolean = (value, path) => {
  if (typeof value !== "boolean") fail(`${path} must be boolean`);
};

const requireNonEmptyString = (value, path) => {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${path} must be a non-empty string`);
  }
};

const validateObservation = (value, path) => {
  const observation = requireObject(value, path);
  requireExactKeys(
    observation,
    [
      "schemaVersion",
      "buildId",
      "runtimeId",
      "executionId",
      "capabilities",
      "launch",
      "entities",
      "state",
      "stop",
    ],
    path,
  );
  if (observation.schemaVersion !== 1) fail(`${path}.schemaVersion must be 1`);
  for (const key of ["buildId", "runtimeId", "executionId"]) {
    requireNonEmptyString(observation[key], `${path}.${key}`);
  }
};

const validateGameToolCalls = (value, taskId, path) => {
  const calls = requireArray(value, path);
  const successfulLaunches = new Map();
  for (const [index, rawCall] of calls.entries()) {
    const callPath = `${path}[${index}]`;
    const call = requireObject(rawCall, callPath);
    requireExactKeys(
      call,
      ["schemaVersion", "toolCallId", "toolName", "input", "response"],
      callPath,
    );
    if (call.schemaVersion !== 1) fail(`${callPath}.schemaVersion must be 1`);
    requireNonEmptyString(call.toolCallId, `${callPath}.toolCallId`);
    if (
      !["game_capabilities", "game_launch", "game_query", "game_stop"].includes(
        call.toolName,
      )
    ) {
      fail(`${callPath}.toolName is not exposed by this ablation`);
    }
    const input = requireObject(call.input, `${callPath}.input`);
    const response = requireObject(call.response, `${callPath}.response`);
    if (input.schemaVersion !== 1 || input.taskId !== taskId) {
      fail(`${callPath}.input is not bound to the arm task`);
    }
    if (
      response.schemaVersion !== 1 ||
      response.toolCallId !== call.toolCallId ||
      (response.outcome !== "success" && response.outcome !== "error")
    ) {
      fail(`${callPath}.response envelope is not bound to the call`);
    }
    if (response.outcome !== "success") continue;
    const output = requireObject(
      response.output,
      `${callPath}.response.output`,
    );
    if (output.schemaVersion !== 1 || output.taskId !== taskId) {
      fail(`${callPath}.response.output is not bound to the arm task`);
    }
    if (call.toolName === "game_launch") {
      requireNonEmptyString(input.buildId, `${callPath}.input.buildId`);
      requireNonEmptyString(
        output.buildId,
        `${callPath}.response.output.buildId`,
      );
      requireNonEmptyString(
        output.executionId,
        `${callPath}.response.output.executionId`,
      );
      requireNonEmptyString(
        output.runtimeId,
        `${callPath}.response.output.runtimeId`,
      );
      if (input.buildId !== output.buildId) {
        fail(`${callPath} launch Build binding is inconsistent`);
      }
      successfulLaunches.set(output.executionId, output.runtimeId);
    } else if (call.toolName === "game_query") {
      requireNonEmptyString(input.executionId, `${callPath}.input.executionId`);
      requireNonEmptyString(
        output.executionId,
        `${callPath}.response.output.executionId`,
      );
      if (input.executionId !== output.executionId) {
        fail(`${callPath} query Execution binding is inconsistent`);
      }
      if (!successfulLaunches.has(input.executionId)) {
        fail(`${callPath} successful query lacks a prior recorded launch`);
      }
    } else if (call.toolName === "game_stop") {
      requireNonEmptyString(input.runtimeId, `${callPath}.input.runtimeId`);
      requireNonEmptyString(
        output.runtimeId,
        `${callPath}.response.output.runtimeId`,
      );
      if (input.runtimeId !== output.runtimeId) {
        fail(`${callPath} stop Runtime binding is inconsistent`);
      }
    }
  }
  return calls;
};

const validateAgent = (value, taskId, path) => {
  const agent = requireObject(value, path);
  requireExactKeys(
    agent,
    [
      "schemaVersion",
      "status",
      "sessionId",
      "sessionFile",
      "provider",
      "model",
      "requestedThinkingLevel",
      "realizedThinkingLevel",
      "activeTools",
      "assistantText",
      "errorMessage",
      "eventsObserved",
      "stats",
      "gameToolCalls",
    ],
    path,
  );
  if (agent.schemaVersion !== 1) fail(`${path}.schemaVersion must be 1`);
  if (
    ![
      "completed",
      "provider_failed",
      "aborted",
      "timed_out",
      "start_failed",
    ].includes(agent.status)
  ) {
    fail(`${path}.status is unsupported`);
  }
  for (const key of ["provider", "model", "requestedThinkingLevel"]) {
    requireNonEmptyString(agent[key], `${path}.${key}`);
  }
  requireArray(agent.activeTools, `${path}.activeTools`);
  validateGameToolCalls(agent.gameToolCalls, taskId, `${path}.gameToolCalls`);
  if (typeof agent.assistantText !== "string") {
    fail(`${path}.assistantText must be a string`);
  }
  if (!Number.isInteger(agent.eventsObserved) || agent.eventsObserved < 0) {
    fail(`${path}.eventsObserved must be a non-negative integer`);
  }
  if (agent.status === "start_failed") {
    if (
      agent.sessionId !== null ||
      agent.sessionFile !== null ||
      agent.realizedThinkingLevel !== null ||
      agent.stats !== null
    ) {
      fail(`${path} start_failed identity/stats fields must be null`);
    }
  } else {
    requireNonEmptyString(agent.sessionId, `${path}.sessionId`);
    if (!isAbsolutePath(agent.sessionFile)) fail(`${path}.sessionFile invalid`);
    requireNonEmptyString(
      agent.realizedThinkingLevel,
      `${path}.realizedThinkingLevel`,
    );
    requireObject(agent.stats, `${path}.stats`);
  }
};

const validatePatch = (value, path) => {
  const patch = requireObject(value, path);
  requireExactKeys(
    patch,
    ["schemaVersion", "sha256", "byteLength", "unifiedDiff"],
    path,
  );
  if (patch.schemaVersion !== 1) fail(`${path}.schemaVersion must be 1`);
  if (!isSha256(patch.sha256)) fail(`${path}.sha256 is invalid`);
  if (typeof patch.unifiedDiff !== "string") {
    fail(`${path}.unifiedDiff must be a string`);
  }
  const bytes = Buffer.from(patch.unifiedDiff, "utf8");
  if (patch.byteLength !== bytes.byteLength) {
    fail(`${path}.byteLength does not match diff bytes`);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== patch.sha256) {
    fail(`${path}.sha256 does not match diff bytes`);
  }
};

const validateResult = (value, path) => {
  const result = requireObject(value, path);
  requireExactKeys(
    result,
    [
      "schemaVersion",
      "commandStatus",
      "taskId",
      "source",
      "baselineObservation",
      "agent",
      "candidatePatch",
      "candidateObservation",
      "candidateObservationError",
      "workspaceDirectory",
      "taskDirectory",
      "sandboxRuntime",
      "limitations",
    ],
    path,
  );
  if (result.schemaVersion !== 1) fail(`${path}.schemaVersion must be 1`);
  if (
    !["completed", "cleanup_or_source_drift"].includes(result.commandStatus)
  ) {
    fail(`${path}.commandStatus is unsupported`);
  }
  requireNonEmptyString(result.taskId, `${path}.taskId`);
  const source = requireObject(result.source, `${path}.source`);
  requireExactKeys(
    source,
    [
      "schemaVersion",
      "repositoryRoot",
      "commit",
      "tree",
      "selectedTreeSha256",
      "checkoutCleanBefore",
      "checkoutCleanAfter",
    ],
    `${path}.source`,
  );
  if (source.schemaVersion !== 1)
    fail(`${path}.source.schemaVersion must be 1`);
  if (!isAbsolutePath(source.repositoryRoot)) {
    fail(`${path}.source.repositoryRoot must be absolute`);
  }
  if (!isSha256(source.selectedTreeSha256)) {
    fail(`${path}.source.selectedTreeSha256 is invalid`);
  }
  requireBoolean(
    source.checkoutCleanBefore,
    `${path}.source.checkoutCleanBefore`,
  );
  requireBoolean(
    source.checkoutCleanAfter,
    `${path}.source.checkoutCleanAfter`,
  );
  validateObservation(
    result.baselineObservation,
    `${path}.baselineObservation`,
  );
  validateAgent(result.agent, result.taskId, `${path}.agent`);
  validatePatch(result.candidatePatch, `${path}.candidatePatch`);
  if (result.candidateObservation === null) {
    requireNonEmptyString(
      result.candidateObservationError,
      `${path}.candidateObservationError`,
    );
  } else {
    if (result.candidateObservationError !== null) {
      fail(
        `${path}.candidateObservationError must be null when observation exists`,
      );
    }
    validateObservation(
      result.candidateObservation,
      `${path}.candidateObservation`,
    );
  }
  for (const key of ["workspaceDirectory", "taskDirectory"]) {
    if (!isAbsolutePath(result[key])) fail(`${path}.${key} must be absolute`);
  }
  if (result.sandboxRuntime !== "anthropic-srt") {
    fail(`${path}.sandboxRuntime must be anthropic-srt`);
  }
  requireArray(result.limitations, `${path}.limitations`);
  if (result.limitations.length === 0)
    fail(`${path}.limitations must not be empty`);
  if (
    result.commandStatus === "completed" &&
    source.checkoutCleanAfter !== true
  ) {
    fail(`${path}.commandStatus completed requires a clean source checkout`);
  }
  return result;
};

const validateConfigurationShape = (value, path) => {
  const configuration = requireObject(value, path);
  requireExactKeys(
    configuration,
    [
      "schemaVersion",
      "provider",
      "model",
      "thinkingLevel",
      "timeoutMs",
      "environmentProfile",
      "environmentInstructionProfile",
      "prompt",
      "sourceCommit",
      "sourceTree",
      "sharedToolNames",
      "chronoriftToolNames",
    ],
    path,
  );
  if (configuration.schemaVersion !== 1) {
    fail(`${path}.schemaVersion must be 1`);
  }
  for (const key of [
    "provider",
    "model",
    "thinkingLevel",
    "environmentProfile",
    "environmentInstructionProfile",
    "prompt",
    "sourceCommit",
    "sourceTree",
  ]) {
    requireNonEmptyString(configuration[key], `${path}.${key}`);
  }
  if (
    !Number.isInteger(configuration.timeoutMs) ||
    configuration.timeoutMs < 1
  ) {
    fail(`${path}.timeoutMs must be a positive integer`);
  }
  requireArray(configuration.sharedToolNames, `${path}.sharedToolNames`);
  requireArray(
    configuration.chronoriftToolNames,
    `${path}.chronoriftToolNames`,
  );
  return configuration;
};

const validateRawGodotCalls = (value, path) => {
  const calls = requireArray(value, path);
  for (const [index, rawCall] of calls.entries()) {
    const callPath = `${path}[${index}]`;
    const call = requireObject(rawCall, callPath);
    requireExactKeys(call, ["schemaVersion", "toolCallId", "result"], callPath);
    if (call.schemaVersion !== 1) fail(`${callPath}.schemaVersion must be 1`);
    requireNonEmptyString(call.toolCallId, `${callPath}.toolCallId`);
    const result = requireObject(call.result, `${callPath}.result`);
    if (result.schemaVersion !== 1) {
      fail(`${callPath}.result.schemaVersion must be 1`);
    }
    if (result.outcome !== "success" && result.outcome !== "error") {
      fail(`${callPath}.result.outcome is unsupported`);
    }
  }
};

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const parseRun = async (path, expectedArm) => {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  const root = requireObject(parsed, path);
  requireExactKeys(
    root,
    [
      "schemaVersion",
      "arm",
      "configuration",
      "result",
      "rawGodotToolCalls",
      "candidateRuntimeErrors",
      "candidateRuntimeErrorsError",
    ],
    path,
  );
  if (root.schemaVersion !== 1) fail(`${path}.schemaVersion must be 1`);
  if (root.arm !== expectedArm) {
    fail(`${path}.arm must be ${expectedArm}`);
  }
  const configuration = validateConfigurationShape(
    root.configuration,
    `${path}.configuration`,
  );
  const result = validateResult(root.result, `${path}.result`);
  validateRawGodotCalls(root.rawGodotToolCalls, `${path}.rawGodotToolCalls`);
  if (root.candidateRuntimeErrors === null) {
    requireNonEmptyString(
      root.candidateRuntimeErrorsError,
      `${path}.candidateRuntimeErrorsError`,
    );
  } else {
    if (root.candidateRuntimeErrorsError !== null) {
      fail(
        `${path}.candidateRuntimeErrorsError must be null when runtime errors are available`,
      );
    }
    const runtimeErrors = requireObject(
      root.candidateRuntimeErrors,
      `${path}.candidateRuntimeErrors`,
    );
    requireArray(runtimeErrors.rows, `${path}.candidateRuntimeErrors.rows`);
  }
  const expectedTools = [
    ...configuration.sharedToolNames,
    ...configuration.chronoriftToolNames,
  ];
  if (
    result.agent.status !== "start_failed" &&
    !same(result.agent.activeTools, expectedTools)
  ) {
    fail(`${path}.result.agent.activeTools does not match configuration`);
  }
  if (
    expectedArm === "coding-only" &&
    result.agent.gameToolCalls.length !== 0
  ) {
    fail(`${path}.result.agent.gameToolCalls must be empty for coding-only`);
  }
  return { path, root, configuration, result };
};

const platformState = (run) => {
  const candidate = run.result.candidateObservation;
  if (!isObject(candidate)) return null;
  const state = requireObject(
    candidate.state,
    `${run.path}.result.candidateObservation.state`,
  );
  const rows = requireArray(
    state.rows,
    `${run.path}.result.candidateObservation.state.rows`,
  );
  const row = rows.find(
    (candidateRow) =>
      isObject(candidateRow) &&
      isObject(candidateRow.value) &&
      candidateRow.value.kind === "state_sample" &&
      isObject(candidateRow.value.payload) &&
      candidateRow.value.payload.stateDomainId === "platform_geometry",
  );
  if (!isObject(row) || !isObject(row.value) || !isObject(row.value.payload)) {
    return null;
  }
  const value = row.value.payload.value;
  if (!isObject(value) || !Array.isArray(value.platforms)) return null;
  return value.platforms;
};

const usedPlatformGeometryObservation = (run) =>
  run.result.agent.gameToolCalls.some((call) => {
    if (!isObject(call) || call.toolName !== "game_query") return false;
    if (!isObject(call.response) || call.response.outcome !== "success") {
      return false;
    }
    const output = call.response.output;
    if (!isObject(output) || !Array.isArray(output.rows)) return false;
    return output.rows.some(
      (row) =>
        isObject(row) &&
        isObject(row.value) &&
        row.value.kind === "state_sample" &&
        isObject(row.value.payload) &&
        row.value.payload.stateDomainId === "platform_geometry",
    );
  });

const armEvaluation = (run) => {
  const reasons = [];
  const agent = isObject(run.result.agent) ? run.result.agent : {};
  const source = isObject(run.result.source) ? run.result.source : {};
  const patch = isObject(run.result.candidatePatch)
    ? run.result.candidatePatch
    : {};
  const agentCompleted = agent.status === "completed";
  const commandCompleted = run.result.commandStatus === "completed";
  const patchNonEmpty =
    typeof patch.unifiedDiff === "string" && patch.unifiedDiff.length > 0;
  const candidateObservationAvailable =
    isObject(run.result.candidateObservation) &&
    run.result.candidateObservationError === null;
  const checkoutClean =
    source.checkoutCleanBefore === true && source.checkoutCleanAfter === true;
  const candidateBuildChanged =
    candidateObservationAvailable &&
    isObject(run.result.baselineObservation) &&
    run.result.baselineObservation.buildId !==
      run.result.candidateObservation.buildId;
  const semanticObservationUsed = usedPlatformGeometryObservation(run);
  const requiredSemanticObservationUsed =
    run.root.arm !== "chronorift" || semanticObservationUsed;
  const runtimeErrors = run.root.candidateRuntimeErrors;
  const runtimeErrorsEmpty =
    isObject(runtimeErrors) &&
    Array.isArray(runtimeErrors.rows) &&
    runtimeErrors.rows.length === 0 &&
    run.root.candidateRuntimeErrorsError === null;

  if (!commandCompleted) reasons.push("command_not_completed");
  if (!agentCompleted) reasons.push("agent_not_completed");
  if (!patchNonEmpty) reasons.push("patch_empty");
  if (!candidateObservationAvailable) {
    reasons.push("candidate_observation_unavailable");
  }
  if (!checkoutClean) reasons.push("source_checkout_not_clean");
  if (!candidateBuildChanged) reasons.push("candidate_build_unchanged");
  if (!runtimeErrorsEmpty) reasons.push("candidate_runtime_errors_not_empty");
  if (!requiredSemanticObservationUsed) {
    reasons.push("chronorift_platform_observation_not_used");
  }

  const platforms = platformState(run);
  const expected = new Map([
    ["Platforms/Platform", 2],
    ["Platforms/Platform2", 1],
    ["Platforms/Platform3", 3],
    ["Platforms/Platform4", 6],
  ]);
  let geometryMatched = Array.isArray(platforms) && platforms.length === 4;
  const areaIds = [];
  if (geometryMatched) {
    for (const rawPlatform of platforms) {
      if (!isObject(rawPlatform)) {
        geometryMatched = false;
        break;
      }
      const width = expected.get(rawPlatform.node_path);
      if (
        width === undefined ||
        rawPlatform.configured_width_tiles !== width ||
        rawPlatform.rendered_sprite_count !== width ||
        rawPlatform.solid_collision_width_px !== width * 128 ||
        rawPlatform.area_collision_width_px !== width * 128 ||
        typeof rawPlatform.area_shape_instance_id !== "string" ||
        rawPlatform.area_shape_instance_id.length === 0
      ) {
        geometryMatched = false;
        break;
      }
      areaIds.push(rawPlatform.area_shape_instance_id);
    }
  }
  const areaIdentityDistinct =
    geometryMatched && new Set(areaIds).size === expected.size;
  if (!geometryMatched) reasons.push("candidate_geometry_mismatch");
  if (geometryMatched && !areaIdentityDistinct) {
    reasons.push("candidate_area_identity_aliased");
  }

  return {
    commandCompleted,
    agentCompleted,
    patchNonEmpty,
    candidateObservationAvailable,
    checkoutClean,
    candidateBuildChanged,
    runtimeErrorsEmpty,
    semanticObservationUsed,
    geometryMatched,
    areaIdentityDistinct,
    oraclePassed:
      commandCompleted &&
      agentCompleted &&
      patchNonEmpty &&
      candidateObservationAvailable &&
      checkoutClean &&
      candidateBuildChanged &&
      runtimeErrorsEmpty &&
      requiredSemanticObservationUsed &&
      geometryMatched &&
      areaIdentityDistinct,
    reasons,
  };
};

const validateConfiguration = (control, treatment) => {
  const reasons = [];
  for (const key of [
    "provider",
    "model",
    "thinkingLevel",
    "timeoutMs",
    "environmentProfile",
    "environmentInstructionProfile",
    "prompt",
    "sourceCommit",
    "sourceTree",
    "sharedToolNames",
  ]) {
    if (!same(control.configuration[key], treatment.configuration[key])) {
      reasons.push(`configuration_mismatch:${key}`);
    }
  }
  for (const [key, value] of Object.entries(EXPECTED)) {
    if (key === "chronoriftToolNames") continue;
    if (!same(control.configuration[key], value)) {
      reasons.push(`unexpected_configuration:${key}`);
    }
  }
  if (!same(control.configuration.chronoriftToolNames, [])) {
    reasons.push("control_exposes_chronorift_tools");
  }
  if (
    !same(
      treatment.configuration.chronoriftToolNames,
      EXPECTED.chronoriftToolNames,
    )
  ) {
    reasons.push("treatment_chronorift_tools_mismatch");
  }
  const controlAgent = requireObject(
    control.result.agent,
    `${control.path}.result.agent`,
  );
  const treatmentAgent = requireObject(
    treatment.result.agent,
    `${treatment.path}.result.agent`,
  );
  for (const run of [control, treatment]) {
    if (
      run.result.source.commit !== run.configuration.sourceCommit ||
      run.result.source.tree !== run.configuration.sourceTree
    ) {
      reasons.push(`source_binding_mismatch:${run.root.arm}`);
    }
    const agent = run.result.agent;
    if (
      agent.provider !== run.configuration.provider ||
      agent.model !== run.configuration.model ||
      agent.requestedThinkingLevel !== run.configuration.thinkingLevel ||
      (agent.status !== "start_failed" &&
        agent.realizedThinkingLevel !== run.configuration.thinkingLevel)
    ) {
      reasons.push(`realized_agent_configuration_mismatch:${run.root.arm}`);
    }
  }
  for (const [key, left, right] of [
    ["taskId", control.result.taskId, treatment.result.taskId],
    [
      "workspaceDirectory",
      control.result.workspaceDirectory,
      treatment.result.workspaceDirectory,
    ],
    ["sessionId", controlAgent.sessionId, treatmentAgent.sessionId],
    ["sessionFile", controlAgent.sessionFile, treatmentAgent.sessionFile],
  ]) {
    if (
      typeof left !== "string" ||
      typeof right !== "string" ||
      left === right
    ) {
      reasons.push(`arm_identity_not_distinct:${key}`);
    }
  }
  return reasons;
};

const main = async () => {
  if (process.argv.length !== 4) {
    fail(
      "usage: evaluate-platform-alias-ablation.mjs CONTROL.json TREATMENT.json",
    );
  }
  const control = await parseRun(process.argv[2], "coding-only");
  const treatment = await parseRun(process.argv[3], "chronorift");
  const configurationReasons = validateConfiguration(control, treatment);
  const output = {
    schemaVersion: 1,
    configurationMatched: configurationReasons.length === 0,
    configurationReasons,
    arms: {
      codingOnly: armEvaluation(control),
      chronorift: armEvaluation(treatment),
    },
    limitations: [
      "This evaluator reports two case-level candidate outcomes and does not select a winner or support a general superiority claim.",
      "A valid pair requires fresh distinct Task, workspace, and Pi Session identities.",
    ],
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.configurationMatched) process.exitCode = 1;
};

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
