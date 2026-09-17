import { GodotMcpEnvironment } from "./godot-mcp-environment.js";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  asProjectEnvironmentTaskId,
  taskNamespaceDigestV1,
} from "@chronorift/domain";
import {
  createInspectionGameToolDefinitions,
  createProjectEnvironmentToolCallAdmissionV1,
  createVNextCodingToolDefinitions,
  runProjectEnvironmentInteractivePiSessionV1,
  runVNextPiTurnWithSdk,
  resolvePiHostAgentDirectory,
  type PiThinkingLevel,
  type VNextPiTurnResult,
} from "@chronorift/pi-harness";

import {
  createProjectMultiAgentEnvironment,
  ProjectMultiAgentOptionsSchema,
  type ProjectMultiAgentEnvironment,
  type ProjectMultiAgentOptions,
} from "./project-multi-agent.js";

import { SandboxPiCodingToolPort } from "./pi-coding-tool-port.js";
import { ExecutionTelemetry } from "./execution-telemetry.js";
import { GodotInspectionRuntime } from "./godot-inspection-runtime.js";
import { prepareGodotInspectionCandidate } from "./godot-inspection-source.js";
import { extractTaskPatch } from "./patch-handoff.js";
import { SrtGodotRunner } from "./srt-godot-runner.js";
import { resolveSrtRuntimeConfig } from "./srt-runtime-config.js";
import { SrtSandboxController } from "./srt-sandbox-controller.js";
import {
  preflightCleanProjectEnvironmentV1,
  type VerifiedProjectEnvironmentSourceV1,
} from "./source-preflight.js";
import { createProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";
import { materializePrivateTaskWorkspace } from "./workspace-materializer.js";
import {
  ProjectExecutionLimitsSchema,
  type ProjectExecutionLimits,
} from "./project-execution-limits.js";

type PreviewTaskLayoutV1 = Awaited<
  ReturnType<typeof createProjectEnvironmentTaskDirectoryLayout>
>;

const previewTaskLayoutChildrenV1 = (
  layout: PreviewTaskLayoutV1,
): readonly (readonly [name: string, path: string])[] =>
  Object.freeze([
    ["records", layout.taskRecordDirectory],
    ["runtime-records", layout.runtimeRecordDirectory],
    ["workspace", layout.workspaceDirectory],
    ["tmp", layout.sandboxTemporaryDirectory],
    ["sandbox-artifacts", layout.sandboxArtifactScratchDirectory],
    ["pi-sessions", layout.piSessionDirectory],
    ["host-baseline.git", layout.hostBaselineGitDirectory],
    ["host-tmp", layout.hostOperationTemporaryDirectory],
    ["project-environment-records", layout.projectEnvironmentRecordDirectory],
  ]);

const sameFileIdentity = (
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean => left.dev === right.dev && left.ino === right.ino;

const assertPrivateOwnedDirectory = async (
  path: string,
  label: string,
): Promise<Stats> => {
  const statistics = await lstat(path);
  const effectiveUserId = process.geteuid?.();
  if (
    effectiveUserId === undefined ||
    statistics.isSymbolicLink() ||
    !statistics.isDirectory() ||
    statistics.uid !== effectiveUserId ||
    (statistics.mode & 0o7777) !== 0o700
  ) {
    throw new Error(`${label} is no longer a private owned directory`);
  }
  return statistics;
};

const assertExactPreviewTaskChildren = async (
  taskRootDirectory: string,
  expectedChildren: readonly (readonly [name: string, path: string])[],
): Promise<ReadonlyMap<string, Stats>> => {
  const expectedNames = expectedChildren.map(([name]) => name).sort();
  const actualNames = (await readdir(taskRootDirectory, { encoding: "buffer" }))
    .map((entry) => entry.toString("utf8"))
    .sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      "Project Environment Task root contains an unowned top-level entry",
    );
  }

  const identities = new Map<string, Stats>();
  for (const [name, path] of expectedChildren) {
    if (dirname(path) !== taskRootDirectory || basename(path) !== name) {
      throw new Error(
        "Project Environment Task layout child escaped its owned root",
      );
    }
    identities.set(
      name,
      await assertPrivateOwnedDirectory(
        path,
        `Task lifecycle directory ${name}`,
      ),
    );
  }
  return identities;
};

/**
 * Materialization is the last point before Preview exposes this fresh random
 * Task namespace to Pi. A failed materialization therefore
 * rolls back only the exact private layout created by this invocation. The
 * root is atomically moved under a new private quarantine before recursive
 * removal, and any unknown top-level entry makes cleanup fail closed.
 */
const rollbackUncommittedPreviewTaskLayoutV1 = async (input: {
  readonly taskId: ReturnType<typeof asProjectEnvironmentTaskId>;
  readonly layout: PreviewTaskLayoutV1;
}): Promise<void> => {
  const taskRootDirectory = input.layout.taskRootDirectory;
  const expectedTaskName = taskNamespaceDigestV1(input.taskId);
  if (
    !isAbsolute(taskRootDirectory) ||
    resolve(taskRootDirectory) !== taskRootDirectory ||
    basename(taskRootDirectory) !== expectedTaskName
  ) {
    throw new Error(
      "Project Environment Task rollback refused a mismatched Task namespace",
    );
  }
  const tasksDirectory = dirname(taskRootDirectory);
  if ((await realpath(tasksDirectory)) !== tasksDirectory) {
    throw new Error(
      "Project Environment Task rollback requires a canonical Task parent",
    );
  }
  await assertPrivateOwnedDirectory(
    tasksDirectory,
    "Project Environment Tasks directory",
  );

  const rootIdentity = await assertPrivateOwnedDirectory(
    taskRootDirectory,
    "Project Environment Task root",
  );
  const expectedChildren = previewTaskLayoutChildrenV1(input.layout);
  const childIdentities = await assertExactPreviewTaskChildren(
    taskRootDirectory,
    expectedChildren,
  );

  const quarantineDirectory = await mkdtemp(
    join(tasksDirectory, ".preview-rollback-"),
  );
  let taskRootWasMoved = false;
  let retainedDirectories: string[] = [taskRootDirectory, quarantineDirectory];
  try {
    await chmod(quarantineDirectory, 0o700);
    await assertPrivateOwnedDirectory(
      quarantineDirectory,
      "Project Environment Task rollback quarantine",
    );
    const quarantinedTaskRoot = join(quarantineDirectory, expectedTaskName);
    await rename(taskRootDirectory, quarantinedTaskRoot);
    taskRootWasMoved = true;
    retainedDirectories = [quarantinedTaskRoot];

    const movedRootIdentity = await assertPrivateOwnedDirectory(
      quarantinedTaskRoot,
      "Quarantined Project Environment Task root",
    );
    if (!sameFileIdentity(rootIdentity, movedRootIdentity)) {
      throw new Error(
        "Project Environment Task root identity changed during rollback",
      );
    }
    const movedChildren = expectedChildren.map(
      ([name]) => [name, join(quarantinedTaskRoot, name)] as const,
    );
    const movedChildIdentities = await assertExactPreviewTaskChildren(
      quarantinedTaskRoot,
      movedChildren,
    );
    for (const [name, identity] of childIdentities) {
      const movedIdentity = movedChildIdentities.get(name);
      if (
        movedIdentity === undefined ||
        !sameFileIdentity(identity, movedIdentity)
      ) {
        throw new Error(
          `Task lifecycle directory ${name} changed identity during rollback`,
        );
      }
    }

    await rm(quarantinedTaskRoot, { recursive: true, force: false });
    retainedDirectories = [quarantineDirectory];
    await rmdir(quarantineDirectory);
    retainedDirectories = [];
  } catch (error) {
    let rollbackError = error;
    if (!taskRootWasMoved) {
      try {
        await rmdir(quarantineDirectory);
        retainedDirectories = [taskRootDirectory];
      } catch (quarantineError) {
        rollbackError = new AggregateError(
          [error, quarantineError],
          "Project Environment Task rollback also failed to remove its empty quarantine",
        );
      }
    }
    throw Object.assign(
      new Error(
        `Project Environment Task rollback retained state at ${retainedDirectories.join(", ")}`,
        { cause: rollbackError },
      ),
      { retainedTaskDirectories: Object.freeze([...retainedDirectories]) },
    );
  }
};

const materializePreviewTaskWorkspaceV1 = async (input: {
  readonly taskId: ReturnType<typeof asProjectEnvironmentTaskId>;
  readonly source: VerifiedProjectEnvironmentSourceV1;
  readonly layout: PreviewTaskLayoutV1;
}) => {
  try {
    const materialized = await materializePrivateTaskWorkspace(input);
    if (materialized.receipt.schemaVersion !== 2) {
      throw new Error(
        "Project Environment Preview requires a V2 source materialization receipt",
      );
    }
    return materialized;
  } catch (materializationError) {
    try {
      await rollbackUncommittedPreviewTaskLayoutV1({
        taskId: input.taskId,
        layout: input.layout,
      });
    } catch (rollbackError) {
      const retainedTaskDirectories =
        rollbackError instanceof Error &&
        "retainedTaskDirectories" in rollbackError &&
        Array.isArray(rollbackError.retainedTaskDirectories) &&
        rollbackError.retainedTaskDirectories.every(
          (path: unknown): path is string => typeof path === "string",
        )
          ? rollbackError.retainedTaskDirectories
          : [input.layout.taskRootDirectory];
      throw Object.assign(
        new AggregateError(
          [materializationError, rollbackError],
          `Project Environment materialization failed and Task rollback was not completed; retained Task state: ${retainedTaskDirectories.join(", ")}`,
        ),
        {
          code: "artifact_write_failed" as const,
          retainedTaskDirectories: Object.freeze([...retainedTaskDirectories]),
        },
      );
    }
    throw materializationError;
  }
};

export interface ProjectEnvironmentPreviewRequestV2 {
  readonly projectPath: string;
  readonly gameBackend?: "godot-ai" | "inspection" | "none" | undefined;
  readonly projectRoot?: string | undefined;
  readonly includeUntrackedPaths?: readonly string[] | undefined;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly goal: string | null;
  readonly stateRoot?: string | undefined;
  readonly godotBin?: string | undefined;
  readonly agentDir?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly interactive?: boolean | undefined;
  readonly multiAgent?: ProjectMultiAgentOptions | undefined;
  /** Optional trusted Host budget; model tools cannot raise it. */
  readonly executionLimits?: ProjectExecutionLimits | undefined;
}

const pathText = z.string().min(1).max(8192);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const ProjectEnvironmentPreviewStartupFailureV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    status: z.literal("failed"),
    goalDelivered: z.literal(false),
    failureCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    failureMessage: z.string().min(1).max(4096),
  })
  .strict();
export const ProjectEnvironmentPreviewResultV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    status: z.enum(["completed", "failed", "cancelled", "timed_out"]),
    taskId: z.string().uuid(),
    sessionId: z.string().uuid(),
    sessionFile: pathText.nullable(),
    projectRoot: z.string().max(8192),
    sourceSha256: digest,
    candidateSourceChanged: z.boolean(),
    candidatePatch: z
      .object({
        path: pathText,
        sha256: digest,
        byteLength: z.number().int().nonnegative(),
        roundTripVerified: z.literal(true),
      })
      .strict()
      .nullable(),
    executions: z.array(pathText).max(256),
    goalDelivered: z.boolean(),
    failureCode: z.string().min(1).max(128).nullable(),
    failureMessage: z.string().max(4096).nullable(),
    taskDirectory: pathText,
    workspaceDirectory: pathText,
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    thinkingLevel: z.enum([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
    limitations: z.array(z.string().max(4096)).max(32),
  })
  .strict();
export type ProjectEnvironmentPreviewResultV2 = z.infer<
  typeof ProjectEnvironmentPreviewResultV2Schema
>;

export const ProjectEnvironmentPreviewResultV3Schema =
  ProjectEnvironmentPreviewResultV2Schema.extend({
    schemaVersion: z.literal(3),
    agents: z
      .object({
        recordPath: pathText,
        count: z.number().int().nonnegative(),
        maxAgents: z.number().int().min(1).max(4),
        sharedToolCalls: z.number().int().min(0).max(256),
        sharedToolCallLimit: z.literal(256),
      })
      .strict()
      .nullable(),
  }).strict();
export type ProjectEnvironmentPreviewResultV3 = z.infer<
  typeof ProjectEnvironmentPreviewResultV3Schema
>;

/** Shared candidate collaboration; V3 remains available for historical records. */
export const ProjectEnvironmentPreviewResultV4Schema =
  ProjectEnvironmentPreviewResultV3Schema.extend({
    schemaVersion: z.literal(4),
    workspaceMode: z.literal("shared"),
    candidateSourceChanged: z.boolean().nullable(),
  }).strict();
export type ProjectEnvironmentPreviewResultV4 = z.infer<
  typeof ProjectEnvironmentPreviewResultV4Schema
>;

/** Explicit Host budgets; V2/V4 retain their original fixed limits. */
export const ProjectEnvironmentPreviewResultV5Schema =
  ProjectEnvironmentPreviewResultV2Schema.extend({
    schemaVersion: z.literal(5),
    workspaceMode: z.enum(["single", "shared"]),
    candidateSourceChanged: z.boolean().nullable(),
    executions: z.array(pathText).max(2048),
    executionLimits: ProjectExecutionLimitsSchema,
    agents: z
      .object({
        recordPath: pathText,
        count: z.number().int().nonnegative(),
        maxAgents: z.number().int().min(1).max(4),
        sharedToolCalls: z.number().int().min(0).max(2048),
        sharedToolCallLimit: z.number().int().min(1).max(2048),
      })
      .strict()
      .nullable(),
  })
    .strict()
    .superRefine((value, context) => {
      if (
        value.agents !== null &&
        (value.workspaceMode !== "shared" ||
          value.agents.sharedToolCallLimit !==
            value.executionLimits.sharedToolCallLimit ||
          value.agents.sharedToolCalls > value.agents.sharedToolCallLimit)
      )
        context.addIssue({
          code: "custom",
          path: ["agents"],
          message: "Agent budget record must match the Host execution limits",
        });
    });
export type ProjectEnvironmentPreviewResultV5 = z.infer<
  typeof ProjectEnvironmentPreviewResultV5Schema
>;

export const ProjectEnvironmentPreviewResultV6Schema =
  ProjectEnvironmentPreviewResultV2Schema.extend({
    schemaVersion: z.literal(6),
    gameBackend: z.enum(["godot-ai", "none"]),
    workspaceMode: z.enum(["shared-editor", "coding"]),
    candidateSourceChanged: z.boolean().nullable(),
    executions: z.array(pathText).max(2048),
    executionLimits: ProjectExecutionLimitsSchema,
    agents: ProjectEnvironmentPreviewResultV5Schema.shape.agents,
  })
    .strict()
    .superRefine((value, context) => {
      if (
        value.workspaceMode !==
        (value.gameBackend === "godot-ai" ? "shared-editor" : "coding")
      )
        context.addIssue({
          code: "custom",
          path: ["workspaceMode"],
          message: "Workspace mode must match the game backend",
        });
      if (
        value.agents !== null &&
        (value.agents.sharedToolCallLimit !==
          value.executionLimits.sharedToolCallLimit ||
          value.agents.sharedToolCalls > value.agents.sharedToolCallLimit)
      )
        context.addIssue({
          code: "custom",
          path: ["agents"],
          message: "Agent budget must match Host limits",
        });
    });
export type ProjectEnvironmentPreviewResultV6 = z.infer<
  typeof ProjectEnvironmentPreviewResultV6Schema
>;

export type ProjectEnvironmentPreviewResult =
  | ProjectEnvironmentPreviewResultV2
  | ProjectEnvironmentPreviewResultV4
  | ProjectEnvironmentPreviewResultV5
  | ProjectEnvironmentPreviewResultV6;

export interface ProjectEnvironmentPreviewDependenciesV2 {
  readonly runPiTurn: typeof runVNextPiTurnWithSdk;
  readonly runInteractive?: typeof runProjectEnvironmentInteractivePiSessionV1;
  readonly createMultiAgentEnvironment?: typeof createProjectMultiAgentEnvironment;
}
const defaultDependencies: ProjectEnvironmentPreviewDependenciesV2 = {
  runPiTurn: runVNextPiTurnWithSdk,
  runInteractive: runProjectEnvironmentInteractivePiSessionV1,
};

const inspectionInstructions = [
  "Godot inspection:",
  "- game_launch imports and starts the current candidate's default main scene in a separate, read-only stage.",
  "- One execution can run at a time. Editing candidate files does not change a running execution; stop it before launching a new one.",
  "- game_query inspects current children, property descriptions, or explicitly named property values. Object references belong only to their execution.",
  "- Object and Resource references preserve identity; equal field values do not imply the same object.",
  "- Queries may invoke project property getters and do not provide atomic snapshots or past history.",
  "- Runtime observations and process completion do not decide whether a fix is correct.",
].join("\n");

const failure = (error: unknown): { code: string; message: string } => {
  const rawCode = error instanceof Error && "code" in error ? error.code : null;
  return {
    code:
      typeof rawCode === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(rawCode)
        ? rawCode
        : "project_preview_failed",
    message:
      (error instanceof Error ? error.message : String(error))
        .replace(/[\r\n\0]+/gu, " ")
        .slice(0, 4096) || "Preview failed",
  };
};

/** Fresh source preparation and ordinary Pi work; no project publication state. */
export async function runProjectEnvironmentPreviewV2(
  request: ProjectEnvironmentPreviewRequestV2,
  dependencies: ProjectEnvironmentPreviewDependenciesV2 = defaultDependencies,
): Promise<ProjectEnvironmentPreviewResult> {
  const gameBackend = z
    .enum(["godot-ai", "inspection", "none"])
    .parse(request.gameBackend ?? "godot-ai");
  // Capture Host auth location before the adapter scopes its private metadata cache.
  const agentDir =
    gameBackend === "godot-ai"
      ? resolvePiHostAgentDirectory(request.agentDir)
      : request.agentDir;
  const executionLimits = ProjectExecutionLimitsSchema.parse(
    request.executionLimits ?? {},
  );
  const multiAgent =
    request.multiAgent === undefined
      ? undefined
      : ProjectMultiAgentOptionsSchema.parse(request.multiAgent);
  if (request.goal === null && request.interactive !== true)
    throw Object.assign(
      new Error("A goal is required outside an interactive TTY"),
      { code: "goal_required" },
    );
  if (request.goal !== null && request.goal.trim().length === 0)
    throw Object.assign(new Error("The goal must not be empty"), {
      code: "goal_required",
    });
  const runtimeConfig = await resolveSrtRuntimeConfig({
    godotVersionPolicy:
      gameBackend === "godot-ai" ? "exact-4.7.1" : "inspection-verified",
    ...(request.stateRoot === undefined
      ? {}
      : { stateRoot: request.stateRoot }),
    ...(request.godotBin === undefined ? {} : { godotBin: request.godotBin }),
  });
  const source = await preflightCleanProjectEnvironmentV1({
    godotVersion: runtimeConfig.godot.receipt.realizedVersion,
    projectPath: request.projectPath,
    ...(request.projectRoot === undefined
      ? {}
      : { projectRoot: request.projectRoot }),
    ...(request.includeUntrackedPaths === undefined
      ? {}
      : { includeUntrackedPaths: request.includeUntrackedPaths }),
    sourceRepositoryExclusionRoots: [runtimeConfig.stateRoot],
  });
  const taskId = asProjectEnvironmentTaskId(randomUUID());
  const sessionId = randomUUID();
  const layout = await createProjectEnvironmentTaskDirectoryLayout({
    runtimeRoot: runtimeConfig.stateRoot,
    sourceRepositoryRoot: source.repositoryRoot,
    taskId,
  });
  const materialized = await materializePreviewTaskWorkspaceV1({
    taskId,
    source,
    layout,
  });
  const codingHome = join(layout.sandboxTemporaryDirectory, "coding-home");
  const codingTemp = join(layout.sandboxTemporaryDirectory, "coding-tmp");
  await Promise.all(
    [codingHome, codingTemp].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  const controller = new SrtSandboxController(
    multiAgent === undefined
      ? {}
      : {
          protectedReadPaths: [resolvePiHostAgentDirectory(agentDir)],
        },
  );
  const runtime = new GodotInspectionRuntime({
    runner: new SrtGodotRunner({
      controller,
      candidateWorkspace: layout.workspaceDirectory,
      validationRoot: join(
        layout.hostOperationTemporaryDirectory,
        "godot-validation",
      ),
    }),
    candidateWorkspace: layout.workspaceDirectory,
    artifactsDirectory: layout.runtimeRecordDirectory,
    nodePath: runtimeConfig.nodePath,
    godotPath: runtimeConfig.godot.binding.executablePath,
  });
  const admission = createProjectEnvironmentToolCallAdmissionV1(
    executionLimits.sharedToolCallLimit,
  );
  const mcp =
    gameBackend === "godot-ai"
      ? await GodotMcpEnvironment.create({
          controller,
          workspace: layout.workspaceDirectory,
          godot: runtimeConfig.godot.binding.executablePath,
          recordsDirectory: layout.runtimeRecordDirectory,
          isolationReadRoots: [layout.taskRootDirectory],
          admit: (name) => {
            if (collaboration !== undefined) {
              collaboration.admitMcp(name);
              return;
            }
            if (!admission.tryAdmit(name))
              throw new Error("Shared tool budget exhausted");
          },
        })
      : undefined;
  const instructions =
    gameBackend === "inspection"
      ? inspectionInstructions
      : gameBackend === "none"
        ? "Coding-only environment: no managed game tools are registered."
        : [
            "Godot AI MCP is available through mcp search. Discover and use the upstream tools for editor authoring and game interaction.",
            "Only Root controls the editor. All agents share this private writable project; preserve other agents' edits.",
            "Scene edits can remain in editor memory until scene_save. File reads see saved bytes.",
            "Before any bash/edit/write, the Host stops the game, saves open scenes and closes the editor. The next MCP call reopens it from disk; use project_run to start a new game.",
            "Worker writes also close the editor. Old running state is invalid after a write. Input sequences use process frames, not deterministic physics replay.",
            "Use editor_screenshot with source=game for actual gameplay images. Runtime results and test completion are observations, not proof that a bug is fixed.",
          ].join("\n");
  const telemetry = new ExecutionTelemetry();
  let tools = [
    ...createVNextCodingToolDefinitions(
      new SandboxPiCodingToolPort(controller, {
        workspacePath: layout.workspaceDirectory,
        homePath: codingHome,
        tempPath: codingTemp,
        artifactsPath: layout.sandboxArtifactScratchDirectory,
      }),
      { toolCallAdmission: admission },
    ),
    ...(gameBackend === "inspection"
      ? createInspectionGameToolDefinitions(runtime, {
          toolCallAdmission: admission,
        })
      : []),
  ].map((tool) => ({
    ...tool,
    execute: (...args: Parameters<typeof tool.execute>) =>
      telemetry.measure(tool.name, args[0], () =>
        mcp === undefined
          ? tool.execute(...args)
          : mcp.runCoding(tool.name, () => tool.execute(...args), args[2]),
      ),
  }));
  let collaboration: ProjectMultiAgentEnvironment | undefined;
  let rootPiResult: VNextPiTurnResult | undefined;
  let status: ProjectEnvironmentPreviewResultV2["status"] = "completed";
  let sessionFile: string | null = null;
  let goalDelivered = false;
  let failureCode: string | null = null;
  let failureMessage: string | null = null;
  let candidatePatch: ProjectEnvironmentPreviewResultV2["candidatePatch"] =
    null;
  const limitations =
    gameBackend === "inspection"
      ? [
          "Inspection reads current runtime values; no custom probes, history, pause, or replay.",
          "Property getters are project code; observations are neither atomic snapshots nor fix verdicts.",
        ]
      : gameBackend === "none"
        ? ["No managed runtime observations are available in coding-only mode."]
        : [
            "The editor and game use a mutable project. Runtime state is not an immutable source snapshot; input sequences are not deterministic physics replay.",
          ];
  const recordFailure = (error: unknown): void => {
    const detail = failure(error);
    status = "failed";
    if (failureCode === null) {
      failureCode = detail.code;
      failureMessage = detail.message;
    } else limitations.push(detail.message);
  };
  // Pi's official TUI exits the process after session_shutdown. Finalize from
  // that awaited Host hook as well as the normal headless path, exactly once.
  let finalization: Promise<ProjectEnvironmentPreviewResult> | undefined;
  const finalize = (): Promise<ProjectEnvironmentPreviewResult> => {
    finalization ??= (async () => {
      let writersStopped = true;
      try {
        await collaboration?.close();
      } catch (error) {
        writersStopped = false;
        recordFailure(error);
      }
      try {
        await mcp?.close();
      } catch (error) {
        recordFailure(error);
      }
      try {
        await runtime.close();
      } catch (error) {
        writersStopped = false;
        recordFailure(error);
      }
      try {
        await controller.close();
      } catch (error) {
        writersStopped = false;
        recordFailure(error);
      }
      try {
        if (!writersStopped)
          throw new Error(
            "Candidate cannot be frozen: writer cleanup was not confirmed",
          );
        await mcp?.removeManagedFiles();
        const extracted = await extractTaskPatch({
          taskId,
          sourceKind: "project-environment-v1",
          workspaceDirectory: layout.workspaceDirectory,
          hostBaselineGitDirectory: layout.hostBaselineGitDirectory,
          hostBaselineCommit: materialized.hostBaselineCommit,
          baselineSourceHash: source.selectedTreeSha256,
          ignoredCachePaths: [".chronorift", ".godot"],
          hostOperationTemporaryDirectory:
            layout.hostOperationTemporaryDirectory,
        });
        const path = join(layout.taskRecordDirectory, "candidate.patch");
        await writeFile(path, extracted.patchBytes, {
          flag: "wx",
          mode: 0o600,
        });
        candidatePatch = {
          path,
          sha256: createHash("sha256")
            .update(extracted.patchBytes)
            .digest("hex"),
          byteLength: extracted.patchBytes.byteLength,
          roundTripVerified: true,
        };
      } catch (error) {
        recordFailure(error);
      }
      let agents: ProjectEnvironmentPreviewResultV5["agents"] = null;
      if (collaboration === undefined) {
        try {
          await telemetry.save(
            join(layout.taskRecordDirectory, "performance.v1.json"),
          );
        } catch (error) {
          recordFailure(error);
        }
      }
      if (collaboration !== undefined) {
        try {
          agents = await collaboration.writeSummary(rootPiResult);
        } catch (error) {
          recordFailure(error);
        }
      }
      const rawResult = {
        schemaVersion:
          gameBackend !== "inspection"
            ? 6
            : request.executionLimits !== undefined
              ? 5
              : multiAgent === undefined
                ? 2
                : 4,
        status,
        taskId,
        sessionId,
        sessionFile,
        projectRoot: source.projectPrefix,
        sourceSha256: source.selectedTreeSha256,
        candidateSourceChanged:
          (multiAgent !== undefined || gameBackend !== "inspection") &&
          candidatePatch === null
            ? null
            : candidatePatch !== null && candidatePatch.byteLength > 0,
        candidatePatch,
        executions:
          mcp?.recordPaths() ??
          collaboration?.rootRecordPaths() ??
          runtime.recordPaths(),
        goalDelivered,
        failureCode,
        failureMessage,
        taskDirectory: layout.taskRootDirectory,
        workspaceDirectory: layout.workspaceDirectory,
        provider: request.provider,
        model: request.model,
        thinkingLevel: request.thinkingLevel,
        limitations,
        ...(multiAgent === undefined
          ? {}
          : { agents, workspaceMode: "shared" }),
        ...(request.executionLimits === undefined
          ? {}
          : {
              agents,
              executionLimits,
              workspaceMode: multiAgent === undefined ? "single" : "shared",
            }),
      };
      const result =
        gameBackend !== "inspection"
          ? ProjectEnvironmentPreviewResultV6Schema.parse({
              ...rawResult,
              gameBackend,
              workspaceMode:
                gameBackend === "godot-ai" ? "shared-editor" : "coding",
              agents,
              executionLimits,
            })
          : request.executionLimits !== undefined
            ? ProjectEnvironmentPreviewResultV5Schema.parse(rawResult)
            : multiAgent === undefined
              ? ProjectEnvironmentPreviewResultV2Schema.parse(rawResult)
              : ProjectEnvironmentPreviewResultV4Schema.parse(rawResult);
      await writeFile(
        join(
          layout.taskRecordDirectory,
          `preview.v${result.schemaVersion}.json`,
        ),
        JSON.stringify(result, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      return result;
    })();
    return finalization;
  };
  try {
    if (gameBackend === "inspection")
      await prepareGodotInspectionCandidate(layout.workspaceDirectory);
    await mcp?.prepare();
    if (multiAgent !== undefined) {
      collaboration = await (
        dependencies.createMultiAgentEnvironment ??
        createProjectMultiAgentEnvironment
      )({
        taskId,
        layout,
        controller,
        nodePath: runtimeConfig.nodePath,
        godotPath: runtimeConfig.godot.binding.executablePath,
        provider: request.provider,
        model: request.model,
        thinkingLevel: request.thinkingLevel,
        agentDir,
        instructions,
        gameTools: gameBackend === "inspection",
        ...(mcp === undefined ? {} : { codingEnvironment: mcp }),
        configuration: multiAgent,
        ...(request.executionLimits === undefined ? {} : { executionLimits }),
      });
      tools = [...collaboration.tools];
    }
    if (request.goal !== null) {
      const result = await dependencies.runPiTurn({
        resourceWorkspaceDirectory: layout.workspaceDirectory,
        sessionDirectory: layout.piSessionDirectory,
        newSessionId: sessionId,
        provider: request.provider,
        model: request.model,
        thinkingLevel: request.thinkingLevel,
        prompt: request.goal,
        tools,
        timeoutMs: request.timeoutMs ?? 1_800_000,
        environmentProfile: "coding",
        additionalEnvironmentInstructions: instructions,
        ...(mcp === undefined ? {} : { mcpEnvironment: mcp }),
        ...(collaboration === undefined
          ? {}
          : { collaboration: collaboration.supervisor }),
        ...(agentDir === undefined ? {} : { agentDir }),
      });
      rootPiResult = result;
      if (result.sessionId !== sessionId)
        throw new Error("Pi returned a different Session identity");
      sessionFile = result.sessionFile;
      goalDelivered = true;
      if (result.status !== "completed") {
        status =
          result.status === "aborted"
            ? "cancelled"
            : result.status === "timed_out"
              ? "timed_out"
              : "failed";
        failureCode = result.status;
        failureMessage = result.errorMessage;
      }
    }
    if (request.interactive === true && status === "completed") {
      sessionFile = await (
        dependencies.runInteractive ??
        runProjectEnvironmentInteractivePiSessionV1
      )({
        resourceWorkspaceDirectory: layout.workspaceDirectory,
        sessionDirectory: layout.piSessionDirectory,
        ...(sessionFile === null ? {} : { sessionFile }),
        expectedSessionId: sessionId,
        onShutdown: async (result) => {
          rootPiResult = result;
          if (result.sessionId !== sessionId)
            throw new Error("Pi returned a different Session identity");
          sessionFile = result.sessionFile;
          goalDelivered = true;
          if (result.status !== "completed") {
            status =
              result.status === "aborted"
                ? "cancelled"
                : result.status === "timed_out"
                  ? "timed_out"
                  : "failed";
            failureCode = result.status;
            failureMessage = result.errorMessage;
          }
          await finalize();
        },
        provider: request.provider,
        model: request.model,
        thinkingLevel: request.thinkingLevel,
        tools,
        additionalEnvironmentInstructions: instructions,
        ...(mcp === undefined ? {} : { mcpEnvironment: mcp }),
        ...(collaboration === undefined
          ? {}
          : { collaboration: collaboration.supervisor }),
        ...(agentDir === undefined ? {} : { agentDir }),
      });
      goalDelivered = true;
    }
  } catch (error) {
    recordFailure(error);
  } finally {
    await finalize();
  }
  return await finalize();
}
