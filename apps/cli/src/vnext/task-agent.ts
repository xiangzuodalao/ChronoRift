import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { TaskIdentityV1Schema, type TaskId } from "@chronorift/domain";
import { VNextTaskStore } from "@chronorift/json-artifacts";
import {
  createVNextCodingToolDefinitions,
  runVNextPiTurnWithSdk,
  type PiThinkingLevel,
  type VNextPiTurnResult,
} from "@chronorift/pi-harness";

import {
  discardM1Task,
  executeAndRecordM1Command,
  exportM1Patch,
  extractAndPersistM1Patch,
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
import type { PatchExportReceiptV1 } from "./contracts.js";
import {
  VNextAgentTaskV1Schema,
  VNextAgentTurnV1Schema,
  type VNextAgentTaskV1,
  type VNextAgentTurnV1,
} from "./task-agent-contracts.js";

export interface StartVNextAgentTaskRequest extends PrepareM1TaskEnvironmentRequest {
  readonly goal: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly timeoutMs?: number | undefined;
  readonly agentDir?: string | undefined;
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
    slot: "task.json" | "agent-task.json",
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
  readonly execute: typeof executeAndRecordM1Command;
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
  execute: (environment, request, options) =>
    executeAndRecordM1Command(environment, request, options),
  runTurn: (request) => runVNextPiTurnWithSdk(request),
};

const validatedText = (value: string, name: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${name} must not be empty`);
  return value;
};

const executionBroker = (
  environment: M1TaskEnvironment,
  dependencies: VNextAgentTaskDependencies,
): TaskSandboxBrokerV1 => ({
  execute: (request, options?: SandboxExecutionOptionsV1) =>
    dependencies.execute(environment, request, options),
  cleanup: () => dependencies.suspend(environment),
});

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
  task: VNextAgentTaskV1,
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
  const environment = await dependencies.prepare(request);
  let suspended = false;
  try {
    const context = dependencies.hostContext(environment);
    const store = dependencies.createStore(request.runtimeRoot);
    await store.create(request.taskId);
    const task = VNextAgentTaskV1Schema.parse({
      schemaVersion: 1,
      taskId: request.taskId,
      goal,
      provider: request.provider,
      model: request.model,
      thinkingLevel: request.thinkingLevel,
      createdAt: dependencies.now(),
    });
    await store.putJsonOnce(request.taskId, "agent-task.json", task, (value) =>
      VNextAgentTaskV1Schema.parse(value),
    );
    const port = new SandboxPiCodingToolPort(
      executionBroker(environment, dependencies),
    );
    const result = await dependencies.runTurn({
      resourceWorkspaceDirectory: context.workspaceDirectory,
      sessionDirectory: context.piSessionDirectory,
      ...(request.agentDir === undefined ? {} : { agentDir: request.agentDir }),
      provider: request.provider,
      model: request.model,
      thinkingLevel: request.thinkingLevel,
      prompt: goal,
      tools: createVNextCodingToolDefinitions(port),
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
    await dependencies.suspend(environment);
    suspended = true;
    return publicResult(turn);
  } finally {
    if (!suspended) await dependencies.suspend(environment);
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
    (value) => VNextAgentTaskV1Schema.parse(value),
  );
  const turns = await store.readLedger(
    request.taskId,
    "agent-turns.jsonl",
    (value) => VNextAgentTurnV1Schema.parse(value),
  );
  validateTurnHistory(task, turns);
  const previous = turns.at(-1);
  if (previous === undefined) throw new Error("Task has no persisted Pi turn");
  const environment = await dependencies.resume(request);
  let suspended = false;
  try {
    const context = dependencies.hostContext(environment);
    const resumeSessionFile = join(
      context.piSessionDirectory,
      previous.sessionFile,
    );
    await requireSessionBasename(resumeSessionFile, context.piSessionDirectory);
    const port = new SandboxPiCodingToolPort(
      executionBroker(environment, dependencies),
    );
    const result = await dependencies.runTurn({
      resourceWorkspaceDirectory: context.workspaceDirectory,
      sessionDirectory: context.piSessionDirectory,
      resumeSessionFile,
      ...(request.agentDir === undefined ? {} : { agentDir: request.agentDir }),
      provider: task.provider,
      model: task.model,
      thinkingLevel: task.thinkingLevel,
      prompt,
      tools: createVNextCodingToolDefinitions(port),
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
    await dependencies.suspend(environment);
    suspended = true;
    return publicResult(turn);
  } finally {
    if (!suspended) await dependencies.suspend(environment);
  }
}

export async function showVNextAgentTask(input: {
  readonly taskId: TaskId;
  readonly runtimeRoot: string;
}): Promise<{
  readonly schemaVersion: 1;
  readonly task: VNextAgentTaskV1;
  readonly turns: readonly VNextAgentTurnV1[];
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
    VNextAgentTaskV1Schema.parse(value),
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
  return { schemaVersion: 1, task, turns };
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
