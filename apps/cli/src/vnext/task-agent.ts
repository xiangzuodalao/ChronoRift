import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { validateGameTaskIdV1 } from "@chronorift/agent-protocol";
import {
  TaskIdentityV1Schema,
  TaskPatchIdentityV1Schema,
  type TaskId,
} from "@chronorift/domain";
import {
  ArtifactNotFoundError,
  VNEXT_RUNTIME_RESOURCE_DIRECTORIES,
  VNextRuntimeStore,
  VNextTaskStore,
  type VNextRuntimeResourceSummaryV1,
} from "@chronorift/json-artifacts";
import {
  createVNextCodingToolDefinitions,
  createVNextGameToolDefinitions,
  createVNextLifecycleGameToolDefinitions,
  createVNextSemanticGameToolDefinitions,
  runVNextPiTurnWithSdk,
  type PiThinkingLevel,
  type VNextGameToolPort,
  type VNextLifecycleGameToolPort,
  type VNextSemanticGameToolPort,
  type VNextPiTurnResult,
} from "@chronorift/pi-harness";

import {
  discardM1Task,
  executeAndRecordM1Command,
  exportM1Patch,
  extractAndPersistM1Patch,
  getM1TaskExternalGodotRuntimeContext,
  getM1TaskExternalGodotSemanticRuntimeContext,
  getM1TaskGameRuntimeContext,
  getM1TaskHostContext,
  prepareM1TaskEnvironment,
  resumeM1TaskEnvironment,
  suspendM1Task,
  type M1TaskEnvironment,
  type PrepareM1TaskEnvironmentRequest,
  type ResumeM1TaskEnvironmentRequest,
} from "./m1-task-environment.js";
import { SandboxPiCodingToolPort } from "./pi-coding-tool-port.js";
import type {
  SandboxExecutionOptionsV1,
  TaskSandboxBrokerV1,
} from "./sandbox-broker.js";
import type {
  PatchExportReceiptV1,
  SandboxCleanupReceiptV1,
} from "./contracts.js";
import { createExternalGodotLifecycleCoordinator } from "./external-godot-lifecycle-coordinator.js";
import { createExternalGodotLifecycleSandboxDriverV1 } from "./external-godot-lifecycle-driver.js";
import { createExternalGodotSemanticCoordinator } from "./external-godot-semantic-coordinator.js";
import { createVNextGodotRuntimeCoordinator } from "./vnext-godot-runtime-coordinator.js";
import {
  createVNextAgentGameCapabilityV1,
  createVNextAgentLifecycleProfileV1,
  createVNextAgentSemanticProfileV1,
  VNextAgentTaskSchema,
  VNextAgentTaskV1Schema,
  VNextAgentTaskV2Schema,
  VNextAgentTaskV3Schema,
  VNextAgentTaskV4Schema,
  VNextAgentTurnV1Schema,
  type VNextAgentGameCapabilityV1,
  type VNextAgentLifecycleProfileV1,
  type VNextAgentSemanticProfileV1,
  type VNextAgentTask,
  type VNextAgentTurnV1,
} from "./task-agent-contracts.js";

export interface StartVNextAgentTaskRequest extends PrepareM1TaskEnvironmentRequest {
  readonly goal: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly timeoutMs?: number | undefined;
  readonly agentDir?: string | undefined;
  readonly enableGameTools?: true | undefined;
}

export interface ContinueVNextAgentTaskRequest extends ResumeM1TaskEnvironmentRequest {
  readonly prompt: string;
  readonly timeoutMs?: number | undefined;
  readonly agentDir?: string | undefined;
}

export interface VNextAgentTaskResult {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly turn: number;
  readonly loopStatus: VNextPiTurnResult["status"];
  readonly sessionId: string;
  readonly assistantText: string;
  readonly errorMessage: string | null;
  readonly activeTools: readonly string[];
}

interface AgentTaskStore {
  create(taskId: TaskId): Promise<void>;
  putJsonOnce<T>(
    taskId: TaskId,
    slot: "agent-task.json",
    value: T,
    parse: (input: unknown) => T,
  ): Promise<void>;
  readJson<T>(
    taskId: TaskId,
    slot: "task.json" | "agent-task.json" | "patch.json",
    parse: (input: unknown) => T,
  ): Promise<T>;
  append<T>(
    taskId: TaskId,
    slot: "agent-turns.jsonl",
    value: T,
    parse: (input: unknown) => T,
  ): Promise<unknown>;
  readLedger<T>(
    taskId: TaskId,
    slot: "agent-turns.jsonl",
    parse: (input: unknown) => T,
  ): Promise<readonly T[]>;
}

export interface VNextAgentGameToolTurnContextV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly turn: number;
  readonly kind: "start" | "continue";
  readonly prompt: string;
  readonly gameCapability: VNextAgentGameCapabilityV1;
}

export interface VNextAgentGameToolPort extends VNextGameToolPort {
  cleanup(): Promise<void>;
}

export interface VNextAgentLifecycleGameToolTurnContextV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly turn: number;
  readonly kind: "start" | "continue";
  readonly prompt: string;
  readonly profile: VNextAgentLifecycleProfileV1;
}

export interface VNextAgentLifecycleGameToolPort extends VNextLifecycleGameToolPort {
  reconcileSandboxCleanup?(cleanup: SandboxCleanupReceiptV1): Promise<void>;
  cleanup(): Promise<void>;
}

export interface VNextAgentSemanticGameToolTurnContextV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly turn: number;
  readonly kind: "start" | "continue";
  readonly prompt: string;
  readonly profile: VNextAgentSemanticProfileV1;
}

export interface VNextAgentSemanticGameToolPort extends VNextSemanticGameToolPort {
  reconcileSandboxCleanup?(cleanup: SandboxCleanupReceiptV1): Promise<void>;
  cleanup(): Promise<void>;
}

type AgentRuntimeToolPort =
  | VNextAgentGameToolPort
  | VNextAgentLifecycleGameToolPort
  | VNextAgentSemanticGameToolPort;

const cleanupGameToolPort = async (
  port: AgentRuntimeToolPort | undefined,
  cleanupSandbox?: () => Promise<SandboxCleanupReceiptV1>,
): Promise<void> => {
  if (port === undefined) return;
  let firstFailure: unknown;
  try {
    await port.cleanup();
    return;
  } catch (error) {
    firstFailure = error;
  }
  if (
    cleanupSandbox !== undefined &&
    "reconcileSandboxCleanup" in port &&
    typeof port.reconcileSandboxCleanup === "function"
  ) {
    try {
      const sandboxCleanup = await cleanupSandbox();
      await port.reconcileSandboxCleanup(sandboxCleanup);
      await port.cleanup();
      return;
    } catch (error) {
      throw new AggregateError(
        [firstFailure, error],
        "game runtime cleanup failed before and after Task sandbox reconciliation",
      );
    }
  }
  try {
    await port.cleanup();
  } catch (error) {
    throw new AggregateError(
      [firstFailure, error],
      "game runtime cleanup failed after an in-place retry",
    );
  }
};

interface VNextAgentTaskDependencies {
  readonly now: () => string;
  readonly createStore: (runtimeRoot: string) => AgentTaskStore;
  readonly prepare: typeof prepareM1TaskEnvironment;
  readonly resume: typeof resumeM1TaskEnvironment;
  readonly suspend: typeof suspendM1Task;
  readonly discard: typeof discardM1Task;
  readonly extractPatch: typeof extractAndPersistM1Patch;
  readonly exportPatch: typeof exportM1Patch;
  readonly hostContext: typeof getM1TaskHostContext;
  readonly externalRuntimeContext: typeof getM1TaskExternalGodotRuntimeContext;
  readonly semanticRuntimeContext: typeof getM1TaskExternalGodotSemanticRuntimeContext;
  readonly execute: typeof executeAndRecordM1Command;
  readonly createGameToolPort: (
    environment: M1TaskEnvironment,
    context: VNextAgentGameToolTurnContextV1,
  ) => Promise<VNextAgentGameToolPort>;
  readonly createLifecycleGameToolPort: (
    environment: M1TaskEnvironment,
    context: VNextAgentLifecycleGameToolTurnContextV1,
  ) => Promise<VNextAgentLifecycleGameToolPort>;
  readonly createSemanticGameToolPort: (
    environment: M1TaskEnvironment,
    context: VNextAgentSemanticGameToolTurnContextV1,
  ) => Promise<VNextAgentSemanticGameToolPort>;
  readonly runTurn: typeof runVNextPiTurnWithSdk;
}

const DEFAULT_DEPENDENCIES: VNextAgentTaskDependencies = {
  now: () => new Date().toISOString(),
  createStore: (runtimeRoot) => new VNextTaskStore(runtimeRoot),
  prepare: (request) => prepareM1TaskEnvironment(request),
  resume: (request) => resumeM1TaskEnvironment(request),
  suspend: (environment) => suspendM1Task(environment),
  discard: (environment) => discardM1Task(environment),
  extractPatch: (environment) => extractAndPersistM1Patch(environment),
  exportPatch: (environment, extracted, request) =>
    exportM1Patch(environment, extracted, request),
  hostContext: (environment) => getM1TaskHostContext(environment),
  externalRuntimeContext: (environment) =>
    getM1TaskExternalGodotRuntimeContext(environment),
  semanticRuntimeContext: (environment) =>
    getM1TaskExternalGodotSemanticRuntimeContext(environment),
  execute: (environment, request, options) =>
    executeAndRecordM1Command(environment, request, options),
  createGameToolPort: (environment) => {
    const runtime = getM1TaskGameRuntimeContext(environment);
    const coordinator = createVNextGodotRuntimeCoordinator({
      taskId: runtime.taskId,
      workspaceId: runtime.workspaceId,
      workspaceDirectory: runtime.workspaceDirectory,
      baselineSourceHash: runtime.baselineSourceHash,
      fixtureCapability: runtime.fixtureCapability,
      managedRuntime: runtime.managedRuntime,
      sidecarPort: runtime.sidecarPort,
      runtimeStore: runtime.runtimeStore,
    });
    return Promise.resolve(
      Object.freeze({
        invoke: (
          request: Parameters<VNextGameToolPort["invoke"]>[0],
          signal?: AbortSignal,
        ) => coordinator.invoke(request, signal),
        cleanup: () => coordinator.close(),
      }),
    );
  },
  createLifecycleGameToolPort: (environment) => {
    const runtime = getM1TaskExternalGodotRuntimeContext(environment);
    const coordinator = createExternalGodotLifecycleCoordinator({
      taskId: runtime.taskId,
      workspaceId: runtime.workspaceId,
      workspaceDirectory: runtime.workspaceDirectory,
      baselineSourceHash: runtime.baselineSourceHash,
      projectCapability: runtime.projectCapability,
      managedRuntime: runtime.managedLifecycleRuntime,
      driver: createExternalGodotLifecycleSandboxDriverV1({
        sidecarPort: runtime.sidecarPort,
        managedRuntime: runtime.managedLifecycleRuntime,
      }),
      runtimeStore: runtime.runtimeStore,
    });
    return Promise.resolve(
      Object.freeze({
        invoke: (
          request: Parameters<VNextLifecycleGameToolPort["invoke"]>[0],
          signal?: AbortSignal,
        ) => coordinator.invoke(request, signal),
        cleanup: () => coordinator.close(),
        reconcileSandboxCleanup: (cleanup: SandboxCleanupReceiptV1) =>
          coordinator.reconcileSandboxCleanup(cleanup),
      }),
    );
  },
  createSemanticGameToolPort: (environment) => {
    const runtime = getM1TaskExternalGodotSemanticRuntimeContext(environment);
    const coordinator = createExternalGodotSemanticCoordinator({
      taskId: runtime.taskId,
      workspaceId: runtime.workspaceId,
      workspaceDirectory: runtime.workspaceDirectory,
      baselineSourceHash: runtime.baselineSourceHash,
      projectCapability: runtime.projectCapability,
      managedRuntime: runtime.managedSemanticRuntime,
      adapterProfile: runtime.semanticAdapterProfile.profile,
      adapterProfileSha256: runtime.semanticAdapterProfile.adapterProfileSha256,
      sidecarPort: runtime.sidecarPort,
      runtimeStore: runtime.runtimeStore,
    });
    return Promise.resolve(
      Object.freeze({
        invoke: (
          request: Parameters<VNextSemanticGameToolPort["invoke"]>[0],
          signal?: AbortSignal,
        ) => coordinator.invoke(request, signal),
        cleanup: () => coordinator.close(),
        reconcileSandboxCleanup: (cleanup: SandboxCleanupReceiptV1) =>
          coordinator.reconcileSandboxCleanup(cleanup),
      }),
    );
  },
  runTurn: (request) => runVNextPiTurnWithSdk(request),
};

const validatedText = (value: string, name: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${name} must not be empty`);
  return value;
};

const requireOpenPatchHandoff = async (
  store: AgentTaskStore,
  taskId: TaskId,
): Promise<void> => {
  try {
    const patch = await store.readJson(taskId, "patch.json", (value) =>
      TaskPatchIdentityV1Schema.parse(value),
    );
    if (patch.taskId !== taskId) {
      throw new Error("Persisted patch handoff belongs to a different Task");
    }
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) return;
    throw error;
  }
  throw new Error(
    "Task patch handoff is already sealed; continue before exporting the final candidate",
  );
};

const gameCapabilityFromEnvironment = (
  environment: M1TaskEnvironment,
): VNextAgentGameCapabilityV1 => {
  const capability = environment.managedRuntimeCapability;
  if (capability === undefined) {
    throw new Error(
      "M3 game tools require a prepared managed Godot runtime capability",
    );
  }
  // M1's strict TaskFixtureCapabilityV1 has one accepted fixture identity.
  return createVNextAgentGameCapabilityV1(capability.managedRuntimeId);
};

const executionBroker = (
  environment: M1TaskEnvironment,
  dependencies: VNextAgentTaskDependencies,
): TaskSandboxBrokerV1 => ({
  execute: (request, options?: SandboxExecutionOptionsV1) =>
    dependencies.execute(environment, request, options),
  cleanup: () => dependencies.suspend(environment),
});

const gameEnvironmentInstructions = (
  task: Exclude<VNextAgentTask, { readonly schemaVersion: 1 }>,
): string =>
  task.schemaVersion === 2
    ? `ChronoRift game tools:\n- Exact taskId: ${task.taskId}\n- Exact fixtureId: ${task.gameCapability.fixtureId}\n- The game_* tools declared for this Task are available.\n- Game resource IDs are identifiers, not filesystem paths.`
    : task.schemaVersion === 3
      ? `ChronoRift lifecycle-only game tools:\n- Exact taskId: ${task.taskId}\n- Exact project capability: ${task.profile.projectCapabilitySha256}\n- Available game tools: ${task.profile.toolNames.join(", ")}\n- Other game_* capabilities are unsupported in this profile.\n- Game resource IDs are identifiers, not filesystem paths.`
      : `ChronoRift external semantic game tools:\n- Exact taskId: ${task.taskId}\n- Exact project capability: ${task.profile.projectCapabilitySha256}\n- Exact semantic adapter profile: ${task.profile.semanticAdapterProfileSha256}\n- Available game tools: ${task.profile.toolNames.join(", ")}\n- Checkpoints, restores, forks, traces, and comparisons are descriptive evidence; they do not establish equivalent execution or causality.\n- Other game_* capabilities are unsupported in this profile.\n- Game resource IDs are identifiers, not filesystem paths.`;

const composeTurnTools = async (input: {
  readonly task: VNextAgentTask;
  readonly environment: M1TaskEnvironment;
  readonly turn: number;
  readonly kind: "start" | "continue";
  readonly prompt: string;
  readonly dependencies: VNextAgentTaskDependencies;
}): Promise<{
  readonly tools: ReturnType<typeof createVNextCodingToolDefinitions>;
  readonly gamePort: AgentRuntimeToolPort | undefined;
}> => {
  const codingPort = new SandboxPiCodingToolPort(
    executionBroker(input.environment, input.dependencies),
  );
  const codingTools = createVNextCodingToolDefinitions(codingPort);
  if (input.task.schemaVersion === 1) {
    return { tools: codingTools, gamePort: undefined };
  }
  if (input.task.schemaVersion === 3) {
    const runtime = input.dependencies.externalRuntimeContext(
      input.environment,
    );
    if (
      runtime.projectCapability.capabilitySha256 !==
        input.task.profile.projectCapabilitySha256 ||
      runtime.managedLifecycleRuntime.managedRuntimeId !==
        input.task.profile.managedRuntimeId
    ) {
      throw new Error(
        "Prepared external Godot runtime does not match the persisted lifecycle Task profile",
      );
    }
    const lifecyclePort = await input.dependencies.createLifecycleGameToolPort(
      input.environment,
      Object.freeze({
        schemaVersion: 1,
        taskId: input.task.taskId,
        turn: input.turn,
        kind: input.kind,
        prompt: input.prompt,
        profile: input.task.profile,
      }),
    );
    return {
      tools: Object.freeze([
        ...codingTools,
        ...createVNextLifecycleGameToolDefinitions(lifecyclePort),
      ]),
      gamePort: lifecyclePort,
    };
  }
  if (input.task.schemaVersion === 4) {
    const runtime = input.dependencies.semanticRuntimeContext(
      input.environment,
    );
    if (
      runtime.projectCapability.capabilitySha256 !==
        input.task.profile.projectCapabilitySha256 ||
      runtime.semanticAdapterProfile.adapterProfileSha256 !==
        input.task.profile.semanticAdapterProfileSha256 ||
      runtime.managedSemanticRuntime.managedRuntimeId !==
        input.task.profile.managedRuntimeId
    ) {
      throw new Error(
        "Prepared external Godot semantic runtime does not match the persisted Task profile",
      );
    }
    const semanticPort = await input.dependencies.createSemanticGameToolPort(
      input.environment,
      Object.freeze({
        schemaVersion: 1,
        taskId: input.task.taskId,
        turn: input.turn,
        kind: input.kind,
        prompt: input.prompt,
        profile: input.task.profile,
      }),
    );
    return {
      tools: Object.freeze([
        ...codingTools,
        ...createVNextSemanticGameToolDefinitions(semanticPort),
      ]),
      gamePort: semanticPort,
    };
  }
  const environmentGameCapability = gameCapabilityFromEnvironment(
    input.environment,
  );
  if (
    environmentGameCapability.managedRuntimeId !==
    input.task.gameCapability.managedRuntimeId
  ) {
    throw new Error(
      "Prepared managed Godot runtime does not match the persisted M3 Task capability",
    );
  }
  const context: VNextAgentGameToolTurnContextV1 = Object.freeze({
    schemaVersion: 1,
    taskId: input.task.taskId,
    turn: input.turn,
    kind: input.kind,
    prompt: input.prompt,
    gameCapability: input.task.gameCapability,
  });
  const gamePort = await input.dependencies.createGameToolPort(
    input.environment,
    context,
  );
  return {
    tools: Object.freeze([
      ...codingTools,
      ...createVNextGameToolDefinitions(gamePort),
    ]),
    gamePort,
  };
};

const requireSessionBasename = async (
  sessionFile: string,
  sessionDirectory: string,
): Promise<string> => {
  const absolute = resolve(sessionFile);
  if (dirname(absolute) !== resolve(sessionDirectory)) {
    throw new Error("Pi session file escaped the Task session directory");
  }
  const name = basename(absolute);
  if (name === "." || name === ".." || name.includes("\\")) {
    throw new Error("Pi returned an invalid session filename");
  }
  const statistics = await lstat(absolute);
  if (!statistics.isFile() || statistics.isSymbolicLink()) {
    throw new Error("Pi session must be a regular Host-owned file");
  }
  if ((await realpath(absolute)) !== absolute) {
    throw new Error("Pi session file must not traverse a symbolic link");
  }
  return name;
};

const validateTurnHistory = (
  task: VNextAgentTask,
  turns: readonly VNextAgentTurnV1[],
): void => {
  for (const [index, turn] of turns.entries()) {
    if (
      turn.taskId !== task.taskId ||
      turn.turn !== index + 1 ||
      turn.provider !== task.provider ||
      turn.model !== task.model ||
      turn.requestedThinkingLevel !== task.thinkingLevel
    ) {
      throw new Error(
        "Agent turn history is detached from its Task configuration",
      );
    }
  }
};

const persistTurn = async (input: {
  readonly store: AgentTaskStore;
  readonly taskId: TaskId;
  readonly turn: number;
  readonly kind: "start" | "continue";
  readonly prompt: string;
  readonly sessionDirectory: string;
  readonly result: VNextPiTurnResult;
  readonly completedAt: string;
}): Promise<VNextAgentTurnV1> => {
  const sessionFile = await requireSessionBasename(
    input.result.sessionFile,
    input.sessionDirectory,
  );
  const record = VNextAgentTurnV1Schema.parse({
    schemaVersion: 1,
    taskId: input.taskId,
    turn: input.turn,
    kind: input.kind,
    prompt: input.prompt,
    sessionId: input.result.sessionId,
    sessionFile,
    status: input.result.status,
    provider: input.result.provider,
    model: input.result.model,
    requestedThinkingLevel: input.result.requestedThinkingLevel,
    realizedThinkingLevel: input.result.realizedThinkingLevel,
    activeTools: input.result.activeTools,
    assistantText: input.result.assistantText,
    errorMessage: input.result.errorMessage,
    eventsObserved: input.result.eventsObserved,
    stats: {
      userMessages: input.result.stats.userMessages,
      assistantMessages: input.result.stats.assistantMessages,
      toolCalls: input.result.stats.toolCalls,
      toolResults: input.result.stats.toolResults,
      totalMessages: input.result.stats.totalMessages,
      tokens: input.result.stats.tokens,
      cost: input.result.stats.cost,
    },
    completedAt: input.completedAt,
  });
  await input.store.append(input.taskId, "agent-turns.jsonl", record, (value) =>
    VNextAgentTurnV1Schema.parse(value),
  );
  return record;
};

const publicResult = (turn: VNextAgentTurnV1): VNextAgentTaskResult => ({
  schemaVersion: 1,
  taskId: turn.taskId,
  turn: turn.turn,
  loopStatus: turn.status,
  sessionId: turn.sessionId,
  assistantText: turn.assistantText,
  errorMessage: turn.errorMessage,
  activeTools: turn.activeTools,
});

export async function startVNextAgentTask(
  request: StartVNextAgentTaskRequest,
  overrides: Partial<VNextAgentTaskDependencies> = {},
): Promise<VNextAgentTaskResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const goal = validatedText(request.goal, "goal");
  validatedText(request.provider, "provider");
  validatedText(request.model, "model");
  if (
    request.enableGameTools !== undefined &&
    request.enableGameTools !== true
  ) {
    throw new Error("enableGameTools must be true when provided");
  }
  if (
    (request.enableGameTools === true ||
      request.externalProjectDescriptor !== undefined) &&
    !validateGameTaskIdV1(request.taskId)
  ) {
    throw new Error(
      "game taskId must be a safe opaque resource identity, not a path",
    );
  }
  const environment = await dependencies.prepare(request);
  let gamePort: AgentRuntimeToolPort | undefined;
  try {
    const context = dependencies.hostContext(environment);
    const store = dependencies.createStore(request.runtimeRoot);
    await store.create(request.taskId);
    const externalRuntime =
      environment.sourceKind === "godot-external-lifecycle-v1"
        ? dependencies.externalRuntimeContext(environment)
        : undefined;
    const semanticRuntime =
      environment.sourceKind === "godot-external-semantic-v1"
        ? dependencies.semanticRuntimeContext(environment)
        : undefined;
    const lifecycleProfile =
      externalRuntime === undefined
        ? undefined
        : createVNextAgentLifecycleProfileV1({
            projectCapabilitySha256:
              externalRuntime.projectCapability.capabilitySha256,
            managedRuntimeId:
              externalRuntime.managedLifecycleRuntime.managedRuntimeId,
          });
    const gameCapability =
      lifecycleProfile === undefined &&
      semanticRuntime === undefined &&
      request.enableGameTools === true
        ? gameCapabilityFromEnvironment(environment)
        : undefined;
    const semanticProfile =
      semanticRuntime === undefined
        ? undefined
        : createVNextAgentSemanticProfileV1({
            projectCapabilitySha256:
              semanticRuntime.projectCapability.capabilitySha256,
            semanticAdapterProfileSha256:
              semanticRuntime.semanticAdapterProfile.adapterProfileSha256,
            managedRuntimeId:
              semanticRuntime.managedSemanticRuntime.managedRuntimeId,
          });
    const task: VNextAgentTask =
      semanticProfile !== undefined
        ? VNextAgentTaskV4Schema.parse({
            schemaVersion: 4,
            taskId: request.taskId,
            goal,
            provider: request.provider,
            model: request.model,
            thinkingLevel: request.thinkingLevel,
            createdAt: dependencies.now(),
            profile: semanticProfile,
          })
        : lifecycleProfile !== undefined
          ? VNextAgentTaskV3Schema.parse({
              schemaVersion: 3,
              taskId: request.taskId,
              goal,
              provider: request.provider,
              model: request.model,
              thinkingLevel: request.thinkingLevel,
              createdAt: dependencies.now(),
              profile: lifecycleProfile,
            })
          : gameCapability === undefined
            ? VNextAgentTaskV1Schema.parse({
                schemaVersion: 1,
                taskId: request.taskId,
                goal,
                provider: request.provider,
                model: request.model,
                thinkingLevel: request.thinkingLevel,
                createdAt: dependencies.now(),
              })
            : VNextAgentTaskV2Schema.parse({
                schemaVersion: 2,
                taskId: request.taskId,
                goal,
                provider: request.provider,
                model: request.model,
                thinkingLevel: request.thinkingLevel,
                createdAt: dependencies.now(),
                gameCapability,
              });
    await store.putJsonOnce(request.taskId, "agent-task.json", task, (value) =>
      VNextAgentTaskSchema.parse(value),
    );
    const composition = await composeTurnTools({
      task,
      environment,
      turn: 1,
      kind: "start",
      prompt: goal,
      dependencies,
    });
    gamePort = composition.gamePort;
    const result = await dependencies.runTurn({
      resourceWorkspaceDirectory: context.workspaceDirectory,
      sessionDirectory: context.piSessionDirectory,
      ...(request.agentDir === undefined ? {} : { agentDir: request.agentDir }),
      provider: request.provider,
      model: request.model,
      thinkingLevel: request.thinkingLevel,
      prompt: goal,
      tools: composition.tools,
      ...(task.schemaVersion === 1
        ? {}
        : {
            additionalEnvironmentInstructions:
              gameEnvironmentInstructions(task),
          }),
      ...(request.timeoutMs === undefined
        ? {}
        : { timeoutMs: request.timeoutMs }),
    });
    const turn = await persistTurn({
      store,
      taskId: request.taskId,
      turn: 1,
      kind: "start",
      prompt: goal,
      sessionDirectory: context.piSessionDirectory,
      result,
      completedAt: dependencies.now(),
    });
    return publicResult(turn);
  } finally {
    try {
      await cleanupGameToolPort(gamePort, () =>
        dependencies.suspend(environment),
      );
    } finally {
      await dependencies.suspend(environment);
    }
  }
}

export async function continueVNextAgentTask(
  request: ContinueVNextAgentTaskRequest,
  overrides: Partial<VNextAgentTaskDependencies> = {},
): Promise<VNextAgentTaskResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const prompt = validatedText(request.prompt, "prompt");
  const store = dependencies.createStore(request.runtimeRoot);
  await store.create(request.taskId);
  const task = await store.readJson(
    request.taskId,
    "agent-task.json",
    (value) => VNextAgentTaskSchema.parse(value),
  );
  const turns = await store.readLedger(
    request.taskId,
    "agent-turns.jsonl",
    (value) => VNextAgentTurnV1Schema.parse(value),
  );
  validateTurnHistory(task, turns);
  await requireOpenPatchHandoff(store, request.taskId);
  const previous = turns.at(-1);
  if (previous === undefined) throw new Error("Task has no persisted Pi turn");
  const environment = await dependencies.resume(request);
  let gamePort: AgentRuntimeToolPort | undefined;
  try {
    const context = dependencies.hostContext(environment);
    const resumeSessionFile = join(
      context.piSessionDirectory,
      previous.sessionFile,
    );
    await requireSessionBasename(resumeSessionFile, context.piSessionDirectory);
    const composition = await composeTurnTools({
      task,
      environment,
      turn: turns.length + 1,
      kind: "continue",
      prompt,
      dependencies,
    });
    gamePort = composition.gamePort;
    const result = await dependencies.runTurn({
      resourceWorkspaceDirectory: context.workspaceDirectory,
      sessionDirectory: context.piSessionDirectory,
      resumeSessionFile,
      ...(request.agentDir === undefined ? {} : { agentDir: request.agentDir }),
      provider: task.provider,
      model: task.model,
      thinkingLevel: task.thinkingLevel,
      prompt,
      tools: composition.tools,
      ...(task.schemaVersion === 1
        ? {}
        : {
            additionalEnvironmentInstructions:
              gameEnvironmentInstructions(task),
          }),
      ...(request.timeoutMs === undefined
        ? {}
        : { timeoutMs: request.timeoutMs }),
    });
    const turn = await persistTurn({
      store,
      taskId: request.taskId,
      turn: turns.length + 1,
      kind: "continue",
      prompt,
      sessionDirectory: context.piSessionDirectory,
      result,
      completedAt: dependencies.now(),
    });
    return publicResult(turn);
  } finally {
    try {
      await cleanupGameToolPort(gamePort, () =>
        dependencies.suspend(environment),
      );
    } finally {
      await dependencies.suspend(environment);
    }
  }
}

export async function showVNextAgentTask(input: {
  readonly taskId: TaskId;
  readonly runtimeRoot: string;
}): Promise<{
  readonly schemaVersion: 1;
  readonly task: VNextAgentTask;
  readonly turns: readonly VNextAgentTurnV1[];
  readonly runtimeResources: VNextRuntimeResourceSummaryV1;
}> {
  const store = new VNextTaskStore(input.runtimeRoot);
  await store.create(input.taskId);
  const identity = await store.readJson(input.taskId, "task.json", (value) =>
    TaskIdentityV1Schema.parse(value),
  );
  if (identity.taskId !== input.taskId) {
    throw new Error("Task identity does not match the requested Task");
  }
  const task = await store.readJson(input.taskId, "agent-task.json", (value) =>
    VNextAgentTaskSchema.parse(value),
  );
  if (task.taskId !== input.taskId) {
    throw new Error(
      "Agent Task configuration does not match the requested Task",
    );
  }
  const turns = await store.readLedger(
    input.taskId,
    "agent-turns.jsonl",
    (value) => VNextAgentTurnV1Schema.parse(value),
  );
  validateTurnHistory(task, turns);
  const runtimeStore = new VNextRuntimeStore(input.runtimeRoot);
  let runtimeResources: VNextRuntimeResourceSummaryV1;
  try {
    runtimeResources = await runtimeStore.summarize(input.taskId);
  } catch (error) {
    if (!(error instanceof ArtifactNotFoundError) || task.schemaVersion !== 1) {
      throw error;
    }
    runtimeResources = Object.freeze({
      schemaVersion: 1,
      taskId: input.taskId,
      kinds: Object.freeze(
        Object.keys(VNEXT_RUNTIME_RESOURCE_DIRECTORIES).map((resourceKind) =>
          Object.freeze({
            resourceKind:
              resourceKind as keyof typeof VNEXT_RUNTIME_RESOURCE_DIRECTORIES,
            count: 0,
            resourceIds: Object.freeze([]),
          }),
        ),
      ),
      executions: Object.freeze([]),
    });
  }
  return { schemaVersion: 1, task, turns, runtimeResources };
}

export async function exportVNextAgentTaskPatch(
  request: ResumeM1TaskEnvironmentRequest & {
    readonly hostCwd: string;
    readonly outputPath: string;
  },
  overrides: Partial<VNextAgentTaskDependencies> = {},
): Promise<PatchExportReceiptV1> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const environment = await dependencies.resume(request);
  let suspended = false;
  try {
    const extracted = await dependencies.extractPatch(environment);
    const receipt = await dependencies.exportPatch(environment, extracted, {
      hostCwd: request.hostCwd,
      outputPath: request.outputPath,
    });
    await dependencies.suspend(environment);
    suspended = true;
    return receipt;
  } finally {
    if (!suspended) await dependencies.suspend(environment);
  }
}

export async function discardVNextAgentTask(
  request: ResumeM1TaskEnvironmentRequest,
  overrides: Partial<VNextAgentTaskDependencies> = {},
) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const environment = await dependencies.resume(request);
  return dependencies.discard(environment);
}
