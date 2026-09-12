import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  describePiTools,
  type PiThinkingLevel,
  type VNextPiTurnResult,
} from "@chronorift/pi-harness";
import { z } from "zod";
import { Check } from "typebox/value";
import type { TaskId } from "@chronorift/domain";

import {
  AgentExecutionBudget,
  AgentExecutionScope,
} from "./agent-execution-scope.js";
import {
  AgentSupervisor,
  createAgentSupervisorTools,
  type AgentResource,
  type AgentTurnCompletion,
} from "./agent-supervisor.js";
import { AgentWorkspaceManager } from "./agent-workspace.js";
import type { SrtSandboxController } from "./srt-sandbox-controller.js";
import type { ProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";

const name = z.string().trim().min(1).max(256);
export const ProjectMultiAgentOptionsSchema = z
  .object({
    maxAgents: z.number().int().min(1).max(4).default(2),
    workerProvider: name.optional(),
    workerModel: name.optional(),
    workerThinking: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.workerProvider !== undefined && value.workerModel === undefined) {
      context.addIssue({
        code: "custom",
        path: ["workerModel"],
        message: "workerProvider requires workerModel",
      });
    }
  });
export type ProjectMultiAgentOptions = z.input<
  typeof ProjectMultiAgentOptionsSchema
>;

export interface ProjectMultiAgentEnvironmentOptions {
  readonly taskId: TaskId;
  readonly layout: ProjectEnvironmentTaskDirectoryLayout;
  readonly controller: SrtSandboxController;
  readonly nodePath: string;
  readonly godotPath: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly agentDir?: string | undefined;
  readonly instructions: string;
  readonly configuration: ProjectMultiAgentOptions;
  readonly workerFactory?: ConstructorParameters<
    typeof AgentSupervisor
  >[0]["workerFactory"];
}

const jsonPage = (value: unknown, offset = 0, limit = 16_384) => {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 65_536
  ) {
    throw new TypeError("Invalid result page");
  }
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  const end = Math.min(bytes.length, offset + limit);
  return {
    text: bytes.subarray(offset, end).toString("utf8"),
    offset,
    nextOffset: end,
    totalBytes: bytes.length,
    truncated: end < bytes.length,
  };
};

export async function createProjectMultiAgentEnvironment(
  options: ProjectMultiAgentEnvironmentOptions,
) {
  const configuration = ProjectMultiAgentOptionsSchema.parse(
    options.configuration,
  );
  const budget = new AgentExecutionBudget();
  const manager = new AgentWorkspaceManager({
    rootWorkspaceDirectory: options.layout.workspaceDirectory,
    resourceRootDirectory: join(
      options.layout.hostOperationTemporaryDirectory,
      "agents",
    ),
    recordsDirectory: join(options.layout.taskRecordDirectory, "agents"),
    taskId: options.taskId,
  });
  const rootScope = new AgentExecutionScope({
    controller: options.controller,
    taskRootDirectory: options.layout.taskRootDirectory,
    workspaceDirectory: options.layout.workspaceDirectory,
    temporaryDirectory: join(options.layout.sandboxTemporaryDirectory, "root"),
    artifactsDirectory: options.layout.sandboxArtifactScratchDirectory,
    recordsDirectory: options.layout.runtimeRecordDirectory,
    validationDirectory: join(
      options.layout.hostOperationTemporaryDirectory,
      "godot-validation",
    ),
    nodePath: options.nodePath,
    godotPath: options.godotPath,
    budget,
    assertUsable: () => {
      if (manager.poisoned)
        throw new Error(
          "Root workspace is unavailable after a failed patch rollback",
        );
    },
  });
  await rootScope.initialize();
  const scopes = new Map<string, AgentExecutionScope>();
  const createResource = async (agentId: string): Promise<AgentResource> => {
    const binding = await rootScope.gate.run(() => manager.create(agentId));
    const scope = new AgentExecutionScope({
      controller: options.controller,
      taskRootDirectory: options.layout.taskRootDirectory,
      workspaceDirectory: binding.workspaceDirectory,
      temporaryDirectory: join(binding.resourceDirectory, "tmp"),
      artifactsDirectory: join(binding.resourceDirectory, "sandbox-artifacts"),
      recordsDirectory: join(binding.recordsDirectory, "runtime"),
      validationDirectory: join(
        binding.hostOperationTemporaryDirectory,
        "godot-validation",
      ),
      nodePath: options.nodePath,
      godotPath: options.godotPath,
      budget,
    });
    scopes.set(agentId, scope);
    await scope.initialize();
    const sessionDirectory = join(binding.recordsDirectory, "pi-sessions");
    await mkdir(sessionDirectory, { mode: 0o700 });
    const tools = new Map(scope.tools().map((tool) => [tool.name, tool]));
    const completed = new Map<
      number,
      {
        completion: AgentTurnCompletion;
        patch: unknown;
        captureError: string | null;
        executions: ReturnType<AgentExecutionScope["records"]>;
      }
    >();
    let recordCursor = 0;
    return {
      workerConfiguration: {
        resourceWorkspaceDirectory: binding.workspaceDirectory,
        sessionDirectory,
        provider: configuration.workerProvider ?? options.provider,
        model: configuration.workerModel ?? options.model,
        thinkingLevel: configuration.workerThinking ?? options.thinkingLevel,
        tools: describePiTools(scope.tools()),
        ...(options.agentDir === undefined
          ? {}
          : { agentDir: options.agentDir }),
        environmentProfile: "coding",
        additionalEnvironmentInstructions: `${options.instructions}\nYou are a delegated agent with your own candidate workspace and Godot executions. Your result does not change the Root candidate. Report observed results and remaining uncertainty.`,
      },
      invokeTool: async (request, signal, onUpdate) => {
        const tool = tools.get(request.name);
        if (tool === undefined)
          throw new Error("Worker requested an unavailable tool");
        if (!Check(tool.parameters, request.arguments))
          throw new TypeError(
            "Worker tool arguments do not match the Host schema",
          );
        return tool.execute(
          request.requestId,
          request.arguments,
          signal,
          onUpdate,
          {} as never,
        );
      },
      finishTurn: async (turnId, completion) => {
        let patch: unknown = null;
        let captureError: string | null = null;
        try {
          await scope.cancel();
          patch = await scope.gate.run(() =>
            manager.finishTurn(agentId, turnId),
          );
        } catch (error) {
          captureError = String(
            error instanceof Error ? error.message : error,
          ).slice(0, 4096);
        }
        const records = scope.records();
        const executions = records.slice(recordCursor);
        recordCursor = records.length;
        // A rejected source snapshot must not hide actual runtime evidence.
        const value = { completion, patch, captureError, executions };
        completed.set(turnId, value);
        await writeFile(
          join(binding.recordsDirectory, `result-${turnId}.json`),
          JSON.stringify({ schemaVersion: 1, ...value }, null, 2) + "\n",
          { flag: "wx", mode: 0o600 },
        );
        if (captureError !== null) throw new Error(captureError);
        return {
          patch,
          executions: executions.map((record) => record.executionId),
        };
      },
      readResult: async (turnId, section, offset, limit) => {
        if (section === "diff")
          return manager.readPatch(agentId, turnId, offset, limit);
        const result = completed.get(turnId);
        if (result === undefined)
          throw new Error("No recorded result for this agent turn");
        return jsonPage(
          section === "summary"
            ? {
                ...result.completion,
                piResult: undefined,
                patch: result.patch,
                captureError: result.captureError,
              }
            : result.executions,
          offset,
          limit,
        );
      },
      apply: (turnId) =>
        rootScope.gate.run(() => manager.applyTurn(agentId, turnId)),
      cancel: () => scope.cancel(),
      close: () => scope.close(),
    };
  };
  const supervisor = new AgentSupervisor({
    createResource,
    maxAgents: configuration.maxAgents,
    cancelRoot: () => rootScope.cancel(),
    ...(options.workerFactory === undefined
      ? {}
      : { workerFactory: options.workerFactory }),
  });
  const tools = [
    ...rootScope.tools(),
    ...createAgentSupervisorTools(supervisor),
  ];
  const recordPath = join(options.layout.taskRecordDirectory, "agents.v1.json");
  return {
    tools,
    supervisor,
    rootRecordPaths: () => rootScope.recordPaths(),
    async close() {
      const cleanup = await Promise.allSettled([
        supervisor.close(),
        rootScope.close(),
      ]);
      // A failed startup may have allocated resources before registering its worker.
      const remaining = await Promise.allSettled(
        [...scopes.values()].map((scope) => scope.close()),
      );
      const errors = [...cleanup, ...remaining].filter(
        (result) => result.status === "rejected",
      );
      if (errors.length > 0)
        throw new AggregateError(
          errors.map((result) => result.reason as unknown),
          "Agent resource cleanup failed",
        );
    },
    async writeSummary(rootResult?: VNextPiTurnResult) {
      const agents = supervisor.listAgents();
      const results = supervisor.results;
      const workerUsage = agents.map(({ agentId }) => {
        const turns = results.filter((result) => result.agentId === agentId);
        const latest = turns.findLast(
          (result) => result.piResult !== undefined,
        );
        return {
          agentId,
          throughTurnId: latest?.turnId ?? null,
          sessionStats: latest?.piResult?.stats ?? null,
          incomplete: turns.at(-1)?.piResult === undefined,
        };
      });
      const stats = [
        rootResult?.stats,
        ...workerUsage.map((worker) => worker.sessionStats),
      ].filter((value) => value != null);
      await writeFile(
        recordPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            agents,
            turns: results.map(({ piResult, ...result }) => ({
              ...result,
              sessionStatsAtTurnEnd: piResult?.stats ?? null,
            })),
            rootStats: rootResult?.stats ?? null,
            workerUsage,
            reportedUsage: {
              tokens: stats.reduce(
                (total, value) => total + value.tokens.total,
                0,
              ),
              cost: stats.reduce((total, value) => total + value.cost, 0),
              incomplete:
                rootResult === undefined ||
                workerUsage.some((worker) => worker.incomplete),
            },
            sharedToolCalls: budget.used,
            sharedToolCallLimit: budget.limit,
            limitations: [
              "Session statistics are cumulative; reportedUsage counts each session's latest available snapshot once. Interrupted provider work may be unreported.",
              "Token usage is reported, not a hard token or cost cap.",
              "Agent completion and patch application are not acceptance verdicts.",
            ],
          },
          null,
          2,
        ) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      return {
        recordPath,
        count: agents.length,
        maxAgents: configuration.maxAgents,
        sharedToolCalls: budget.used,
        sharedToolCallLimit: 256 as const,
      };
    },
  };
}

export type ProjectMultiAgentEnvironment = Awaited<
  ReturnType<typeof createProjectMultiAgentEnvironment>
>;
