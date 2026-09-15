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
  AgentWorkspaceGate,
} from "./agent-execution-scope.js";
import {
  AgentSupervisor,
  createAgentSupervisorTools,
  type AgentResource,
  type AgentSpawnPolicy,
} from "./agent-supervisor.js";
import type { SrtSandboxController } from "./srt-sandbox-controller.js";
import type { ProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";
import {
  ProjectExecutionLimitsSchema,
  type ProjectExecutionLimits,
} from "./project-execution-limits.js";

const name = z.string().trim().min(1).max(256);
export const ProjectMultiAgentOptionsSchema = z
  .object({
    maxAgents: z.number().int().min(1).max(4).default(3),
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
  readonly executionLimits?: ProjectExecutionLimits | undefined;
  /** Host-only experiment constraints; never populated from model tool input. */
  readonly spawnPolicy?: AgentSpawnPolicy;
  readonly workerFactory?: ConstructorParameters<
    typeof AgentSupervisor
  >[0]["workerFactory"];
}

export async function createProjectMultiAgentEnvironment(
  options: ProjectMultiAgentEnvironmentOptions,
) {
  const configuration = ProjectMultiAgentOptionsSchema.parse(
    options.configuration,
  );
  const executionLimits = ProjectExecutionLimitsSchema.parse(
    options.executionLimits ?? {},
  );
  const budget = new AgentExecutionBudget(executionLimits.sharedToolCallLimit);
  const candidateGate = new AgentWorkspaceGate();
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
    candidateGate,
  });
  await rootScope.initialize();
  const scopes = new Map<string, AgentExecutionScope>();
  const createResource = async (agentId: string): Promise<AgentResource> => {
    z.uuid().parse(agentId);
    const resourceDirectory = join(
      options.layout.hostOperationTemporaryDirectory,
      "agents",
      agentId,
    );
    const recordsDirectory = join(
      options.layout.taskRecordDirectory,
      "agents",
      agentId,
    );
    const binding = {
      workspaceDirectory: options.layout.workspaceDirectory,
      resourceDirectory,
      recordsDirectory,
      hostOperationTemporaryDirectory: join(resourceDirectory, "host-tmp"),
    };
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
      candidateGate,
    });
    scopes.set(agentId, scope);
    await scope.initialize();
    const sessionDirectory = join(binding.recordsDirectory, "pi-sessions");
    await mkdir(sessionDirectory, { mode: 0o700 });
    const tools = new Map(scope.tools().map((tool) => [tool.name, tool]));
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
        additionalEnvironmentInstructions: `${options.instructions}\nYou share the private candidate workspace with Root and the other agents. Completed edits are immediately visible to all agents; coordinate overlapping changes and preserve other agents’ work. Your Godot executions and temporary files remain independent. Runtime observations describe the captured source of that execution, not later workspace edits. Report actual observations and uncertainty.`,
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
        // Stop only this actor's executions. Other actors may continue editing
        // the shared candidate, so no per-worker patch or candidate is claimed.
        let cleanupError: string | null = null;
        try {
          await scope.cancel();
        } catch (error) {
          cleanupError = String(
            error instanceof Error ? error.message : error,
          ).slice(0, 4096);
        }
        const records = scope.records();
        const executions = records.slice(recordCursor);
        recordCursor = records.length;
        await writeFile(
          join(binding.recordsDirectory, `result-${turnId}.json`),
          JSON.stringify(
            {
              schemaVersion: 2,
              workspaceMode: "shared",
              completion,
              cleanupError,
              executions,
            },
            null,
            2,
          ) + "\n",
          { flag: "wx", mode: 0o600 },
        );
        if (cleanupError !== null) throw new Error(cleanupError);
        return { executions: executions.map((record) => record.executionId) };
      },
      cancel: () => scope.cancel(),
      close: () => scope.close(),
    };
  };
  const supervisor = new AgentSupervisor({
    createResource,
    maxAgents: configuration.maxAgents,
    turnTimeoutMs: executionLimits.workerTurnTimeoutMs,
    turnToolCallLimit: executionLimits.workerTurnToolCallLimit,
    cancelRoot: () => rootScope.cancel(),
    ...(options.spawnPolicy === undefined
      ? {}
      : { spawnPolicy: options.spawnPolicy }),
    ...(options.workerFactory === undefined
      ? {}
      : { workerFactory: options.workerFactory }),
  });
  const tools = [
    ...rootScope.tools(),
    ...createAgentSupervisorTools(supervisor),
  ];
  const recordPath = join(options.layout.taskRecordDirectory, "agents.v2.json");
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
      const agents = supervisor
        .listAllAgents()
        .filter((agent) => agent.path !== "/root");
      const results = supervisor.results;
      const workerUsage = agents.map(({ agentId }) => {
        const turns = results.filter((result) => result.agentId === agentId);
        const latest = turns.findLast(
          (result) => result.piResult !== undefined,
        );
        const lastTurn = turns.at(-1);
        return {
          agentId,
          throughTurnId: latest?.turnId ?? null,
          sessionStats: latest?.piResult?.stats ?? null,
          usageOwnership: latest?.piResult?.usageOwnership ?? null,
          incomplete:
            lastTurn?.status !== "completed" ||
            lastTurn?.piResult?.status !== "completed",
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
            schemaVersion: 2,
            workspaceMode: "shared",
            spawnPolicy: supervisor.effectiveSpawnPolicy,
            agents,
            messages: supervisor.messages,
            turns: results.map(({ piResult, ...result }) => ({
              ...result,
              sessionStatsAtTurnEnd: piResult?.stats ?? null,
              usageOwnership: piResult?.usageOwnership ?? null,
              modelRequests: piResult?.modelRequests ?? null,
            })),
            rootStats: rootResult?.stats ?? null,
            rootUsageOwnership: rootResult?.usageOwnership ?? null,
            rootModelRequests: rootResult?.modelRequests ?? null,
            workerUsage,
            reportedUsage: {
              tokens: stats.reduce(
                (total, value) => total + value.tokens.total,
                0,
              ),
              cost: stats.reduce((total, value) => total + value.cost, 0),
              incomplete:
                rootResult?.status !== "completed" ||
                workerUsage.some((worker) => worker.incomplete),
            },
            sharedToolCalls: budget.used,
            sharedToolCallLimit: budget.limit,
            ...(options.executionLimits === undefined
              ? {}
              : { executionLimits }),
            limitations: [
              "Session statistics are cumulative; reportedUsage counts each session's latest available snapshot once. Interrupted provider work may be unreported.",
              "Token usage is reported, not a hard token or cost cap.",
              "All agents edit one shared candidate; completed turns do not identify an agent-owned patch or acceptance verdict.",
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
        sharedToolCallLimit: budget.limit,
      };
    },
  };
}

export type ProjectMultiAgentEnvironment = Awaited<
  ReturnType<typeof createProjectMultiAgentEnvironment>
>;
