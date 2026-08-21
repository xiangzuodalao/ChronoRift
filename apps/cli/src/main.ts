#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  asExecutionId,
  asTaskId,
  type DiagnosisProposal,
} from "@chronorift/domain";
import {
  DEFAULT_LIFECYCLE_SIDECAR_TARGETS,
  DEFAULT_SEMANTIC_SIDECAR_TARGETS,
  DEFAULT_RUNTIME_SIDECAR_TARGETS,
  V03_FIXTURE_IDS,
  asV03FixtureName,
  createLifecycleRuntimeSidecarSource,
  createLifecycleVanillaSmokeSidecarSource,
  createSemanticRuntimeSidecarSource,
  createSemanticVanillaSmokeSidecarSource,
  createRuntimeSidecarSource,
  doctorGodot,
  installGodot,
  prepareGodotSwitchDoorFixture,
} from "@chronorift/godot-adapter";
import {
  ArtifactNotFoundError,
  V01JsonArtifactRepository,
  VNextTaskStore,
} from "@chronorift/json-artifacts";
import {
  listAvailablePiModels,
  persistPiApiKey,
  runDeterministicPiDiagnosis,
  runPiDiagnosis,
  type PiThinkingLevel,
  type PiDiagnosisRunResult,
} from "@chronorift/pi-harness";

import { persistV01PiDiagnosis } from "./diagnosis.js";
import {
  DEFAULT_PI_MODEL,
  DEFAULT_PI_PROVIDER,
  DEFAULT_PI_THINKING_LEVEL,
} from "./pi-defaults.js";
import { runPiSmoke } from "./pi-smoke.js";
import { ChronoRiftV01AgentGameApi } from "./v01-agent-game-api.js";
import {
  createV01GameBranchServiceForEnvironment,
  createV01MockRun,
  type V01MockRunContext,
} from "./v01-runtime.js";
import { runV04Diagnosis, type V04DiagnosisOutput } from "./v04-diagnosis.js";
import {
  continueVNextAgentTask,
  discardVNextAgentTask,
  exportVNextAgentTaskPatch,
  showVNextAgentTask,
  startVNextAgentTask,
} from "./vnext/task-agent.js";
import { SandboxPolicySchema } from "./vnext/contracts.js";
import { readGodotProjectDescriptorSnapshotV1 } from "./vnext/godot-project-descriptor.js";
import { ManagedGodotLifecycleRuntimeCapabilityV1Schema } from "./vnext/managed-godot-lifecycle-runtime.js";
import { ManagedGodotSemanticRuntimeCapabilityV1Schema } from "./vnext/managed-godot-semantic-runtime.js";
import { readGodotSemanticAdapterProfileSnapshotV1 } from "./vnext/semantic-adapter-profile.js";
import { createSandboxTaskRuntimeRoot } from "./vnext/sandbox-preflight.js";
import {
  PlatformAliasAblationArmV1Schema,
  PlatformAliasDemoFailureV1Schema,
  runPlatformAliasAblationV1,
} from "./vnext/platform-alias-demo.js";
import { runProjectEnvironmentPreviewV1 } from "./vnext/project-environment-preview.js";

interface Arguments {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string | true | readonly string[]>;
  readonly positionals: readonly string[];
}

const booleanFlags = new Set(["json"]);
const repeatableFlags = new Set(["include-untracked"]);

function parseArguments(argv: readonly string[]): Arguments {
  const [rootCommand = "help", ...rootRest] = argv;
  const taskSubcommand = rootCommand === "task" ? rootRest[0] : undefined;
  const projectSubcommand = rootCommand === "project" ? rootRest[0] : undefined;
  const command =
    rootCommand === "task" && taskSubcommand !== undefined
      ? `task-${taskSubcommand}`
      : rootCommand === "project" && projectSubcommand !== undefined
        ? `project-${projectSubcommand}`
        : rootCommand;
  const rest =
    rootCommand === "task" || rootCommand === "project"
      ? rootRest.slice(1)
      : rootRest;
  const flags = new Map<string, string | true | readonly string[]>();
  const positionals: string[] = [];
  const putFlag = (name: string, value: string | true): void => {
    const existing = flags.get(name);
    if (repeatableFlags.has(name)) {
      if (value === true) {
        throw new Error(`Repeatable flag --${name} requires a value`);
      }
      const existingValues =
        existing !== undefined && typeof existing === "object" ? existing : [];
      flags.set(name, Object.freeze([...existingValues, value]));
      return;
    }
    if (
      existing !== undefined &&
      (command === "project-preview" ||
        command === "demo-platform-alias-ablation")
    ) {
      throw new Error(`Duplicate --${name}`);
    }
    flags.set(name, value);
  };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--") continue;
    if (token === undefined || !token.startsWith("--")) {
      positionals.push(String(token));
      continue;
    }
    const equals = token.indexOf("=");
    if (equals > 2) {
      const name = token.slice(2, equals);
      if (booleanFlags.has(name)) {
        throw new Error(`Boolean flag --${name} does not accept a value`);
      }
      putFlag(name, token.slice(equals + 1));
      continue;
    }
    const name = token.slice(2);
    if (booleanFlags.has(name)) {
      putFlag(name, true);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${token}`);
    }
    putFlag(name, value);
    index += 1;
  }
  if (positionals.length > 0 && command !== "project-preview") {
    throw new Error(`Unexpected argument: ${positionals[0]}`);
  }
  if (positionals.length > 1) {
    throw new Error("Project Environment preview accepts at most one goal");
  }
  return { command, flags, positionals: Object.freeze(positionals) };
}

function flag(
  args: Arguments,
  name: string,
  environmentName?: string,
): string | undefined {
  const value = args.flags.get(name);
  return (
    (typeof value === "string" ? value : undefined) ??
    (environmentName === undefined ? undefined : process.env[environmentName])
  );
}

function hasFlag(args: Arguments, name: string): boolean {
  return args.flags.get(name) === true;
}

function repeatableFlag(args: Arguments, name: string): readonly string[] {
  const value = args.flags.get(name);
  return value !== undefined && typeof value === "object" ? value : [];
}

function assertOnlyFlags(args: Arguments, allowed: readonly string[]): void {
  const permitted = new Set(allowed);
  for (const name of args.flags.keys()) {
    if (!permitted.has(name)) {
      throw new Error(`Unsupported --${name} for ${args.command}`);
    }
  }
}

function requiredFlag(
  args: Arguments,
  name: string,
  environmentName?: string,
): string {
  const value = flag(args, name, environmentName);
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing --${name}${environmentName === undefined ? "" : ` or ${environmentName}`}`,
    );
  }
  return value;
}

function environmentKind(args: Arguments): "mock" | "godot" {
  const value = flag(args, "environment") ?? "mock";
  if (value !== "mock" && value !== "godot") {
    throw new Error(
      `Unsupported --environment ${value}; expected mock or godot`,
    );
  }
  return value;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function positiveIntegerFlag(
  args: Arguments,
  name: string,
  fallback: number,
): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function thinkingLevelFlag(
  args: Arguments,
  fallback: PiThinkingLevel,
): PiThinkingLevel {
  const value = flag(args, "thinking") ?? fallback;
  if (
    value !== "off" &&
    value !== "minimal" &&
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "xhigh" &&
    value !== "max"
  ) {
    throw new Error(`Unsupported --thinking ${value}`);
  }
  return value;
}

async function diagnosisOutput(
  context: V01MockRunContext,
  result: PiDiagnosisRunResult,
): Promise<Readonly<Record<string, unknown>>> {
  const persisted = await persistV01PiDiagnosis(context, result.proposal);
  const proposal = persisted.proposal;
  const replay = await optionalExecution(context, proposal.replayExecutionId);
  const candidate = await optionalExecution(
    context,
    proposal.candidateExecutionId,
  );
  const comparison =
    proposal.comparisonId === undefined
      ? null
      : await context.repository.getExecutionComparison(proposal.comparisonId);

  return {
    schemaVersion: 1,
    environment: context.environmentKind,
    runId: context.runId,
    artifactRoot: context.artifactRoot,
    runDirectory: context.runDirectory,
    contract: context.contract,
    baselineBranch: context.baselineBranch,
    originalBaseline: context.baselineExecution,
    evidenceCapsule: context.evidenceCapsule,
    baselineReplay: replay,
    interventionExecution: candidate,
    comparison,
    proposal,
    verdict: persisted.verdict,
    piSession: result.piSession,
  };
}

function optionalExecution(
  context: V01MockRunContext,
  executionId: DiagnosisProposal["replayExecutionId"],
) {
  return executionId === undefined
    ? Promise.resolve(null)
    : context.repository.getExecutionLog(executionId);
}

function printHumanDiagnosis(output: Readonly<Record<string, unknown>>): void {
  const proposal = output["proposal"] as DiagnosisProposal;
  const verdict = output["verdict"] as {
    readonly status: string;
    readonly summary: string;
  };
  const original = output["originalBaseline"] as {
    readonly executionId: string;
    readonly status: string;
    readonly evaluation?: { readonly status: string };
  };
  const replay = output["baselineReplay"] as {
    readonly executionId: string;
    readonly evaluation?: { readonly status: string };
  } | null;
  const candidate = output["interventionExecution"] as {
    readonly executionId: string;
    readonly evaluation?: { readonly status: string };
  } | null;
  const session = output["piSession"] as {
    readonly provider: string;
    readonly model: string;
    readonly sessionFile: string;
  };

  process.stdout.write(
    `ChronoRift ${String(output["environment"]) === "godot" ? "v0.2" : "v0.1"} — ${verdict.status}\n`,
  );
  process.stdout.write(`${verdict.summary}\n\n`);
  process.stdout.write(
    `Original baseline: ${original.executionId} (${original.evaluation?.status ?? original.status})\n`,
  );
  process.stdout.write(
    `Strict replay:     ${replay?.executionId ?? "not run"} (${replay?.evaluation?.status ?? "n/a"})\n`,
  );
  process.stdout.write(
    `Intervention:      ${candidate?.executionId ?? "not run"} (${candidate?.evaluation?.status ?? "n/a"})\n`,
  );
  process.stdout.write(
    `Agent confidence:  ${proposal.confidence} (advisory; ignored by the Gate)\n`,
  );
  process.stdout.write(
    `Pi model:          ${session.provider}/${session.model}\n`,
  );
  process.stdout.write(`Pi session:        ${session.sessionFile}\n`);
  process.stdout.write(
    `Artifacts:         ${String(output["artifactRoot"])}/v0.1\n`,
  );
}

async function runDemo(args: Arguments, cwd: string): Promise<void> {
  const artifactRoot = flag(args, "artifacts", "CHRONORIFT_ARTIFACT_ROOT");
  const context = await createV01MockRun({
    cwd,
    environment: environmentKind(args),
    ...(flag(args, "godot-bin", "GODOT_BIN") === undefined
      ? {}
      : { godotBin: flag(args, "godot-bin", "GODOT_BIN") }),
    ...(artifactRoot === undefined ? {} : { artifactRoot }),
  });
  const game = new ChronoRiftV01AgentGameApi(
    context.runId,
    context.repository,
    context.gameBranch,
  );
  const result = await runDeterministicPiDiagnosis({
    cwd,
    runDir: context.runDirectory,
    initialCapsuleId: context.evidenceCapsule.capsuleId,
    game,
  });
  const output = await diagnosisOutput(context, result);
  if (hasFlag(args, "json")) printJson(output);
  else printHumanDiagnosis(output);
}

async function runDiagnosisCommand(
  args: Arguments,
  cwd: string,
): Promise<void> {
  const provider = requiredFlag(args, "provider", "CHRONORIFT_PI_PROVIDER");
  const model = requiredFlag(args, "model", "CHRONORIFT_PI_MODEL");
  const artifactRoot = flag(args, "artifacts", "CHRONORIFT_ARTIFACT_ROOT");
  const context = await createV01MockRun({
    cwd,
    environment: environmentKind(args),
    ...(flag(args, "godot-bin", "GODOT_BIN") === undefined
      ? {}
      : { godotBin: flag(args, "godot-bin", "GODOT_BIN") }),
    ...(artifactRoot === undefined ? {} : { artifactRoot }),
  });
  const game = new ChronoRiftV01AgentGameApi(
    context.runId,
    context.repository,
    context.gameBranch,
  );
  const result = await runPiDiagnosis({
    cwd,
    runDir: context.runDirectory,
    provider,
    model,
    thinkingLevel: thinkingLevelFlag(args, DEFAULT_PI_THINKING_LEVEL),
    initialCapsuleId: context.evidenceCapsule.capsuleId,
    game,
  });
  const output = await diagnosisOutput(context, result);
  if (hasFlag(args, "json")) printJson(output);
  else printHumanDiagnosis(output);
}

function printHumanV04Diagnosis(output: V04DiagnosisOutput): void {
  process.stdout.write(
    [
      `ChronoRift v0.4 ${output.fixture}`,
      `run: ${output.runId}`,
      `investigation: ${output.investigationId}`,
      `baseline: ${output.baseline.outcome} (${output.baseline.executionId})`,
      `verdict: ${output.verdict.status} / ${output.verdict.claimLevel}`,
      `mechanism: ${output.verdict.mechanismId ?? "unresolved"}`,
      `artifacts: ${output.runDirectory}`,
    ].join("\n") + "\n",
  );
  if (output.verdict.blockers.length > 0) {
    process.stdout.write(
      `blockers:\n${output.verdict.blockers.map((item) => `- ${item}`).join("\n")}\n`,
    );
  }
}

async function runV04DiagnosisCommand(
  args: Arguments,
  cwd: string,
  mode: "scripted" | "live",
): Promise<void> {
  assertOnlyFlags(args, [
    "fixture",
    "artifacts",
    "godot-bin",
    "provider",
    "model",
    "thinking",
    "timeout-ms",
    "json",
  ]);
  const artifactRoot = flag(args, "artifacts", "CHRONORIFT_ARTIFACT_ROOT");
  const godotBin = flag(args, "godot-bin", "GODOT_BIN");
  const output = await runV04Diagnosis({
    cwd,
    fixture: asV03FixtureName(flag(args, "fixture") ?? "signal-ordering"),
    mode,
    ...(artifactRoot === undefined ? {} : { artifactRoot }),
    ...(godotBin === undefined ? {} : { godotBin }),
    ...(mode === "live"
      ? {
          provider: requiredFlag(args, "provider", "CHRONORIFT_PI_PROVIDER"),
          model: requiredFlag(args, "model", "CHRONORIFT_PI_MODEL"),
          thinkingLevel: thinkingLevelFlag(args, DEFAULT_PI_THINKING_LEVEL),
          timeoutMs: positiveIntegerFlag(args, "timeout-ms", 600_000),
        }
      : {}),
  });
  if (hasFlag(args, "json")) printJson(output);
  else printHumanV04Diagnosis(output);
}

async function piSmokeCommand(args: Arguments, cwd: string): Promise<void> {
  assertOnlyFlags(args, []);
  printJson(
    await runPiSmoke({
      cwd,
      provider: DEFAULT_PI_PROVIDER,
      model: DEFAULT_PI_MODEL,
      thinkingLevel: DEFAULT_PI_THINKING_LEVEL,
    }),
  );
}

async function replayCommand(args: Arguments, cwd: string): Promise<void> {
  const executionId = asExecutionId(requiredFlag(args, "execution"));
  const artifactRoot = resolve(
    cwd,
    flag(args, "artifacts", "CHRONORIFT_ARTIFACT_ROOT") ?? ".chronorift",
  );
  const repository = new V01JsonArtifactRepository(artifactRoot);
  const sourceExecution = await repository.getExecutionLog(executionId);
  const sourceCheckpoint = await repository.getCheckpoint(
    sourceExecution.startCheckpointId,
  );
  const gameBranch = await createV01GameBranchServiceForEnvironment(
    repository,
    {
      cwd,
      artifactRoot,
      environmentAdapter: sourceCheckpoint.content.environment.adapter,
      ...(flag(args, "godot-bin", "GODOT_BIN") === undefined
        ? {}
        : { godotBin: flag(args, "godot-bin", "GODOT_BIN") }),
    },
  );
  printJson(await gameBranch.replayExecution({ executionId }));
}

async function godotDoctorCommand(args: Arguments, cwd: string): Promise<void> {
  const godotBin = flag(args, "godot-bin", "GODOT_BIN");
  const artifactRoot = resolve(
    cwd,
    flag(args, "artifacts", "CHRONORIFT_ARTIFACT_ROOT") ?? ".chronorift",
  );
  const fixture = await prepareGodotSwitchDoorFixture({
    cwd,
    artifactRoot,
    ...(godotBin === undefined ? {} : { godotBin }),
  });
  printJson({
    ...(await doctorGodot({
      cwd,
      ...(godotBin === undefined ? {} : { godotBin }),
    })),
    projectDirectory: fixture.projectDirectory,
    projectHash: fixture.projectHash,
    addonHash: fixture.addonHash,
    protocolVersion: 1,
    capabilities: fixture.environment.runtimeFingerprint?.capabilities ?? [],
  });
}

async function godotInstallCommand(cwd: string): Promise<void> {
  printJson(await installGodot({ cwd }));
}

async function modelsCommand(args: Arguments): Promise<void> {
  const provider = flag(args, "provider", "CHRONORIFT_PI_PROVIDER");
  const models = await listAvailablePiModels(
    provider === undefined ? {} : { provider },
  );
  printJson(models);
}

async function persistVolcengineAuthCommand(): Promise<void> {
  const apiKey = process.env.ARK_CODING_PLAN_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "ARK_CODING_PLAN_API_KEY is not set in this shell. Refusing to accept credentials through command-line arguments.",
    );
  }
  printJson(
    await persistPiApiKey({
      provider: "volcengine-coding-plan",
      apiKey,
    }),
  );
}

const taskSandboxFlagNames = [
  "runtime-root",
  "task-storage-root",
  "cgroup-root",
  "bwrap-bin",
  "prlimit-bin",
  "busybox-bin",
  "ldd-bin",
  "bash-bin",
  "rg-bin",
  "find-bin",
  "ls-bin",
  "node-bin",
  "godot-bin",
  "addon-root",
  "lifecycle-addon-root",
  "semantic-addon-root",
] as const;

async function existingCanonicalPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

async function taskRuntimeRoot(
  args: Arguments,
  create: boolean,
  taskStorageRoot?: string,
): Promise<string> {
  const configured =
    flag(args, "runtime-root", "CHRONORIFT_RUNTIME_ROOT") ??
    (taskStorageRoot === undefined
      ? join(
          process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
          "chronorift",
        )
      : join(taskStorageRoot, "runtime"));
  if (create) {
    if (taskStorageRoot === undefined) {
      throw new Error(
        "game Task runtime root creation requires bounded Task storage",
      );
    }
    return createSandboxTaskRuntimeRoot(taskStorageRoot, configured);
  }
  return existingCanonicalPath(configured);
}

const assertRuntimeRootWithinTaskStorage = (
  runtimeRoot: string,
  taskStorageRoot: string,
): void => {
  const difference = relative(taskStorageRoot, runtimeRoot);
  if (
    difference === "" ||
    difference === ".." ||
    difference.startsWith("../") ||
    isAbsolute(difference)
  ) {
    throw new Error(
      "--runtime-root must be a strict child of --task-storage-root for game Tasks",
    );
  }
};

async function taskSandboxRequest(
  args: Arguments,
  taskId: ReturnType<typeof asTaskId>,
  createRuntimeRoot: boolean,
  externalProfileOnCreate: "fixture" | "lifecycle" | "semantic" = "fixture",
) {
  const configuredTaskStorageRoot = flag(
    args,
    "task-storage-root",
    "CHRONORIFT_TASK_STORAGE_ROOT",
  );
  const taskStorageRoot =
    configuredTaskStorageRoot === undefined
      ? undefined
      : resolve(configuredTaskStorageRoot);
  if (createRuntimeRoot && taskStorageRoot === undefined) {
    requiredFlag(args, "task-storage-root", "CHRONORIFT_TASK_STORAGE_ROOT");
  }
  const runtimeRoot = await taskRuntimeRoot(
    args,
    createRuntimeRoot,
    taskStorageRoot,
  );
  const managedGodotEnabled =
    createRuntimeRoot ||
    (
      await new VNextTaskStore(runtimeRoot).readJson(
        taskId,
        "sandbox-policy.json",
        (value) => SandboxPolicySchema.parse(value),
      )
    ).schemaVersion === 2;
  const lifecycleProfile = createRuntimeRoot
    ? externalProfileOnCreate === "lifecycle"
    : await new VNextTaskStore(runtimeRoot)
        .readJson(taskId, "managed-lifecycle-runtime.json", (value) =>
          ManagedGodotLifecycleRuntimeCapabilityV1Schema.parse(value),
        )
        .then(() => true)
        .catch((error: unknown) => {
          if (error instanceof ArtifactNotFoundError) return false;
          throw error;
        });
  const semanticProfile = createRuntimeRoot
    ? externalProfileOnCreate === "semantic"
    : await new VNextTaskStore(runtimeRoot)
        .readJson(taskId, "managed-semantic-runtime.json", (value) =>
          ManagedGodotSemanticRuntimeCapabilityV1Schema.parse(value),
        )
        .then(() => true)
        .catch((error: unknown) => {
          if (error instanceof ArtifactNotFoundError) return false;
          throw error;
        });
  if (managedGodotEnabled && taskStorageRoot === undefined) {
    requiredFlag(args, "task-storage-root", "CHRONORIFT_TASK_STORAGE_ROOT");
  }
  if (managedGodotEnabled && taskStorageRoot !== undefined) {
    assertRuntimeRootWithinTaskStorage(runtimeRoot, taskStorageRoot);
  }
  const delegatedCgroupRoot = requiredFlag(
    args,
    "cgroup-root",
    "CHRONORIFT_CGROUP_ROOT",
  );
  const [
    bwrapPath,
    prlimitPath,
    busyboxPath,
    lddPath,
    bashPath,
    rgPath,
    findPath,
    lsPath,
  ] = await Promise.all([
    existingCanonicalPath(flag(args, "bwrap-bin") ?? "/usr/bin/bwrap"),
    existingCanonicalPath(flag(args, "prlimit-bin") ?? "/usr/bin/prlimit"),
    existingCanonicalPath(flag(args, "busybox-bin") ?? "/usr/bin/busybox"),
    existingCanonicalPath(flag(args, "ldd-bin") ?? "/usr/bin/ldd"),
    existingCanonicalPath(flag(args, "bash-bin") ?? "/usr/bin/bash"),
    existingCanonicalPath(flag(args, "rg-bin") ?? "/usr/bin/rg"),
    existingCanonicalPath(flag(args, "find-bin") ?? "/usr/bin/find"),
    existingCanonicalPath(flag(args, "ls-bin") ?? "/usr/bin/ls"),
  ]);
  const managedGodotRuntime =
    managedGodotEnabled && !lifecycleProfile && !semanticProfile
      ? await (async () => {
          const [nodePath, godotPath, addonRoot] = await Promise.all([
            existingCanonicalPath(
              requiredFlag(args, "node-bin", "CHRONORIFT_NODE_BIN"),
            ),
            existingCanonicalPath(requiredFlag(args, "godot-bin", "GODOT_BIN")),
            existingCanonicalPath(
              requiredFlag(args, "addon-root", "CHRONORIFT_GODOT_ADDON_ROOT"),
            ),
          ]);
          return {
            nodePath,
            godotPath,
            shellPath: busyboxPath,
            lddPath,
            addonRoot,
            sidecarSource: createRuntimeSidecarSource({
              godotExecutable: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
              workspaceRoot: DEFAULT_RUNTIME_SIDECAR_TARGETS.workspaceRoot,
              runtimeRoot: DEFAULT_RUNTIME_SIDECAR_TARGETS.runtimeRoot,
            }),
          } as const;
        })()
      : undefined;
  const managedGodotLifecycleRuntime = lifecycleProfile
    ? await (async () => {
        const [nodePath, godotPath, addonRoot] = await Promise.all([
          existingCanonicalPath(
            requiredFlag(args, "node-bin", "CHRONORIFT_NODE_BIN"),
          ),
          existingCanonicalPath(requiredFlag(args, "godot-bin", "GODOT_BIN")),
          existingCanonicalPath(
            requiredFlag(
              args,
              "lifecycle-addon-root",
              "CHRONORIFT_GODOT_LIFECYCLE_ADDON_ROOT",
            ),
          ),
        ]);
        return {
          nodePath,
          godotPath,
          shellPath: busyboxPath,
          lddPath,
          addonRoot,
          vanillaSidecarSource: createLifecycleVanillaSmokeSidecarSource({
            godotExecutable: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.godotExecutable,
            workspaceRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.workspaceRoot,
            runtimeRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.runtimeRoot,
          }),
          lifecycleSidecarSource: createLifecycleRuntimeSidecarSource({
            godotExecutable: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.godotExecutable,
            workspaceRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.workspaceRoot,
            runtimeRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.runtimeRoot,
          }),
        } as const;
      })()
    : undefined;
  const managedGodotSemanticRuntime = semanticProfile
    ? await (async () => {
        const [nodePath, godotPath, addonRoot] = await Promise.all([
          existingCanonicalPath(
            requiredFlag(args, "node-bin", "CHRONORIFT_NODE_BIN"),
          ),
          existingCanonicalPath(requiredFlag(args, "godot-bin", "GODOT_BIN")),
          existingCanonicalPath(
            requiredFlag(
              args,
              "semantic-addon-root",
              "CHRONORIFT_GODOT_SEMANTIC_ADDON_ROOT",
            ),
          ),
        ]);
        return {
          nodePath,
          godotPath,
          shellPath: busyboxPath,
          lddPath,
          addonRoot,
          vanillaSidecarSource: createSemanticVanillaSmokeSidecarSource({
            godotExecutable: DEFAULT_SEMANTIC_SIDECAR_TARGETS.godotExecutable,
            workspaceRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.workspaceRoot,
            runtimeRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.runtimeRoot,
          }),
          semanticSidecarSource: createSemanticRuntimeSidecarSource({
            godotExecutable: DEFAULT_SEMANTIC_SIDECAR_TARGETS.godotExecutable,
            workspaceRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.workspaceRoot,
            runtimeRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.runtimeRoot,
          }),
        } as const;
      })()
    : undefined;
  return {
    taskId,
    runtimeRoot,
    sandboxHost: {
      delegatedCgroupRoot: await existingCanonicalPath(delegatedCgroupRoot),
      bwrapPath,
      prlimitPath,
      busyboxPath,
      ...(managedGodotEnabled && taskStorageRoot !== undefined
        ? { taskStorageRoot }
        : {}),
    },
    sandboxToolchain: {
      lddPath,
      commands: [
        { target: "/bin/bash", hostPath: bashPath },
        { target: "/usr/bin/rg", hostPath: rgPath },
        { target: "/usr/bin/find", hostPath: findPath },
        { target: "/usr/bin/ls", hostPath: lsPath },
      ],
    },
    ...(managedGodotRuntime === undefined ? {} : { managedGodotRuntime }),
    ...(managedGodotLifecycleRuntime === undefined
      ? {}
      : { managedGodotLifecycleRuntime }),
    ...(managedGodotSemanticRuntime === undefined
      ? {}
      : { managedGodotSemanticRuntime }),
  } as const;
}

async function taskStartCommand(args: Arguments, cwd: string): Promise<void> {
  assertOnlyFlags(args, [
    "project",
    "goal",
    "task-id",
    "trusted-fixture",
    "project-descriptor",
    "semantic-adapter-profile",
    "provider",
    "model",
    "thinking",
    "timeout-ms",
    "agent-dir",
    "json",
    ...taskSandboxFlagNames,
  ]);
  const taskId = asTaskId(flag(args, "task-id") ?? `task:${randomUUID()}`);
  const descriptorPath = flag(args, "project-descriptor");
  if (
    descriptorPath !== undefined &&
    flag(args, "trusted-fixture") !== undefined
  ) {
    throw new Error(
      "--project-descriptor and --trusted-fixture are mutually exclusive",
    );
  }
  const externalProjectDescriptor =
    descriptorPath === undefined
      ? undefined
      : await readGodotProjectDescriptorSnapshotV1(descriptorPath);
  const semanticAdapterPath = flag(args, "semantic-adapter-profile");
  if (
    semanticAdapterPath !== undefined &&
    externalProjectDescriptor === undefined
  ) {
    throw new Error("--semantic-adapter-profile requires --project-descriptor");
  }
  const semanticAdapterProfile =
    semanticAdapterPath === undefined
      ? undefined
      : await readGodotSemanticAdapterProfileSnapshotV1(semanticAdapterPath);
  const runtime = await taskSandboxRequest(
    args,
    taskId,
    true,
    externalProjectDescriptor === undefined
      ? "fixture"
      : semanticAdapterProfile === undefined
        ? "lifecycle"
        : "semantic",
  );
  const timeoutMs =
    flag(args, "timeout-ms") === undefined
      ? undefined
      : positiveIntegerFlag(args, "timeout-ms", 600_000);
  printJson(
    await startVNextAgentTask({
      ...runtime,
      projectPath: resolve(flag(args, "project") ?? cwd),
      ...(externalProjectDescriptor === undefined
        ? {
            trustedFixtureRoot: resolve(
              flag(args, "trusted-fixture") ??
                join(cwd, "fixtures", "godot-frame-input-window"),
            ),
          }
        : {
            externalProjectDescriptor,
            ...(semanticAdapterProfile === undefined
              ? {}
              : { semanticAdapterProfile }),
          }),
      goal: requiredFlag(args, "goal"),
      provider:
        flag(args, "provider", "CHRONORIFT_PI_PROVIDER") ?? DEFAULT_PI_PROVIDER,
      model: flag(args, "model", "CHRONORIFT_PI_MODEL") ?? DEFAULT_PI_MODEL,
      thinkingLevel: thinkingLevelFlag(args, DEFAULT_PI_THINKING_LEVEL),
      enableGameTools: true,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(flag(args, "agent-dir") === undefined
        ? {}
        : { agentDir: resolve(flag(args, "agent-dir")!) }),
    }),
  );
}

async function taskContinueCommand(args: Arguments): Promise<void> {
  assertOnlyFlags(args, [
    "task-id",
    "prompt",
    "timeout-ms",
    "agent-dir",
    "json",
    ...taskSandboxFlagNames,
  ]);
  const taskId = asTaskId(requiredFlag(args, "task-id"));
  const runtime = await taskSandboxRequest(args, taskId, false);
  const timeoutMs =
    flag(args, "timeout-ms") === undefined
      ? undefined
      : positiveIntegerFlag(args, "timeout-ms", 600_000);
  printJson(
    await continueVNextAgentTask({
      ...runtime,
      prompt: requiredFlag(args, "prompt"),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(flag(args, "agent-dir") === undefined
        ? {}
        : { agentDir: resolve(flag(args, "agent-dir")!) }),
    }),
  );
}

async function taskShowCommand(args: Arguments): Promise<void> {
  assertOnlyFlags(args, ["task-id", "runtime-root", "json"]);
  printJson(
    await showVNextAgentTask({
      taskId: asTaskId(requiredFlag(args, "task-id")),
      runtimeRoot: await taskRuntimeRoot(args, false),
    }),
  );
}

async function taskExportCommand(args: Arguments, cwd: string): Promise<void> {
  assertOnlyFlags(args, ["task-id", "output", "json", ...taskSandboxFlagNames]);
  const taskId = asTaskId(requiredFlag(args, "task-id"));
  printJson(
    await exportVNextAgentTaskPatch({
      ...(await taskSandboxRequest(args, taskId, false)),
      hostCwd: cwd,
      outputPath: requiredFlag(args, "output"),
    }),
  );
}

async function taskDiscardCommand(args: Arguments): Promise<void> {
  assertOnlyFlags(args, ["task-id", "json", ...taskSandboxFlagNames]);
  const taskId = asTaskId(requiredFlag(args, "task-id"));
  printJson(
    await discardVNextAgentTask(await taskSandboxRequest(args, taskId, false)),
  );
}

async function projectPreviewCommand(
  args: Arguments,
  cwd: string,
): Promise<void> {
  assertOnlyFlags(args, [
    "provider",
    "model",
    "thinking",
    "host-config",
    "timeout-ms",
    "agent-dir",
    "project-root",
    "include-untracked",
    "launch-target",
    "json",
  ]);
  let result: Awaited<ReturnType<typeof runProjectEnvironmentPreviewV1>>;
  try {
    result = await runProjectEnvironmentPreviewV1({
      projectPath: cwd,
      provider: requiredFlag(args, "provider", "CHRONORIFT_PI_PROVIDER"),
      model: requiredFlag(args, "model", "CHRONORIFT_PI_MODEL"),
      thinkingLevel: thinkingLevelFlag(args, DEFAULT_PI_THINKING_LEVEL),
      goal: args.positionals[0] ?? null,
      ...(flag(args, "project-root") === undefined
        ? {}
        : { projectRoot: flag(args, "project-root")! }),
      includeUntrackedPaths: repeatableFlag(args, "include-untracked"),
      ...(flag(args, "launch-target") === undefined
        ? {}
        : { launchTargetId: flag(args, "launch-target")! }),
      interactive:
        !hasFlag(args, "json") &&
        process.stdin.isTTY === true &&
        process.stdout.isTTY === true,
      ...(flag(args, "host-config") === undefined
        ? {}
        : { hostConfigPath: resolve(flag(args, "host-config")!) }),
      ...(flag(args, "agent-dir") === undefined
        ? {}
        : { agentDir: resolve(flag(args, "agent-dir")!) }),
      ...(flag(args, "timeout-ms") === undefined
        ? {}
        : { timeoutMs: positiveIntegerFlag(args, "timeout-ms", 1_800_000) }),
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const rawCode =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { readonly code?: unknown }).code
        : null;
    const failureCode =
      typeof rawCode === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(rawCode)
        ? rawCode
        : "project_preview_failed";
    const failureMessage =
      rawMessage
        .replace(/[\r\n\0]/gu, " ")
        .trim()
        .slice(0, 4_096) || "Project Environment Preview failed";
    const failure = {
      schemaVersion: 1 as const,
      status: "failed" as const,
      goalDelivered: false as const,
      failureCode,
      failureMessage,
    };
    if (hasFlag(args, "json")) {
      printJson(failure);
    } else {
      process.stderr.write(
        `ChronoRift Project Environment Preview — failed\nfailure: ${failure.failureCode}: ${failure.failureMessage}\n`,
      );
    }
    process.exitCode = 1;
    return;
  }
  const unsuccessful =
    result.status !== "ready" ||
    !result.goalDelivered ||
    result.failureCode !== null;
  if (hasFlag(args, "json")) {
    printJson(result);
    if (unsuccessful) process.exitCode = 1;
    return;
  }
  process.stdout.write(
    [
      `ChronoRift Project Environment Preview — ${result.status}`,
      `project environment: ${result.environmentId}`,
      `source closure: ${result.sourceId}`,
      `selected project root: ${result.projectRoot.length === 0 ? "." : result.projectRoot}`,
      `launch target: ${result.launchTargetId ?? "not resolved"}`,
      `validated launch targets: ${result.validatedLaunchTargetIds.length === 0 ? "none" : result.validatedLaunchTargetIds.join(", ")}`,
      `revision: ${result.environmentRevisionId ?? "not published"}`,
      `adapter: ${result.adapterRevisionId ?? "not published"}`,
      `environment setup: ${result.reused ? "reused current revision" : "initialized and published"}`,
      `compatible build: ${result.buildId ?? "unavailable"}`,
      `candidate source: ${result.candidateSourceChanged ? "changed" : "unchanged"}`,
      `runtime observation: ${result.runtimeObservationReceiptId ?? "not recorded"}`,
      `Pi: ${result.provider}/${result.model} (${result.thinkingLevel})`,
      `session: ${result.sessionFile ?? "not persisted"}`,
      `queued goal: ${result.goalDelivered ? "delivered" : "not delivered"}`,
      ...(result.failureMessage === null
        ? []
        : [`failure: ${result.failureCode}: ${result.failureMessage}`]),
      `task records: ${result.taskDirectory}`,
      ...result.limitations.map((limitation) => `limitation: ${limitation}`),
    ].join("\n") + "\n",
  );
  if (unsuccessful) process.exitCode = 1;
}

async function platformAliasAblationCommand(args: Arguments) {
  assertOnlyFlags(args, [
    "arm",
    "project",
    "provider",
    "model",
    "thinking",
    "host-config",
    "timeout-ms",
    "agent-dir",
    "json",
  ]);
  let run: Awaited<ReturnType<typeof runPlatformAliasAblationV1>>;
  try {
    run = await runPlatformAliasAblationV1({
      arm: PlatformAliasAblationArmV1Schema.parse(requiredFlag(args, "arm")),
      projectPath: resolve(requiredFlag(args, "project")),
      provider: requiredFlag(args, "provider"),
      model: requiredFlag(args, "model"),
      thinkingLevel: thinkingLevelFlag(args, "max"),
      ...(flag(args, "host-config") === undefined
        ? {}
        : { hostConfigPath: resolve(flag(args, "host-config")!) }),
      ...(flag(args, "agent-dir") === undefined
        ? {}
        : { agentDir: resolve(flag(args, "agent-dir")!) }),
      ...(flag(args, "timeout-ms") === undefined
        ? {}
        : { timeoutMs: positiveIntegerFlag(args, "timeout-ms", 600_000) }),
    });
  } catch (error) {
    const failure = PlatformAliasDemoFailureV1Schema.parse({
      schemaVersion: 1 as const,
      commandStatus: "failed" as const,
      errorMessage:
        (error instanceof Error ? error.message : String(error))
          .replace(/[\r\n\0]/gu, " ")
          .trim()
          .slice(0, 4_096) || "GN-1 ablation arm failed",
    });
    if (hasFlag(args, "json")) {
      printJson(failure);
    } else {
      process.stderr.write(
        `ChronoRift GN-1 platform alias ablation — failed\n${failure.errorMessage}\n`,
      );
    }
    process.exitCode = 1;
    return;
  }
  const result = run.result;
  const unsuccessful =
    result.commandStatus !== "completed" || result.agent.status !== "completed";
  if (hasFlag(args, "json")) {
    printJson(run);
  } else {
    process.stdout.write(
      [
        `ChronoRift GN-1 platform alias ablation — ${run.arm} — ${result.commandStatus}`,
        `source: ${result.source.commit} (tree ${result.source.tree})`,
        `task: ${result.taskId}`,
        `session: ${result.agent.sessionFile ?? "not persisted"}`,
        `Pi: ${result.agent.provider}/${result.agent.model} (${result.agent.requestedThinkingLevel}) — ${result.agent.status}`,
        `active tools: ${result.agent.activeTools.join(", ")}`,
        `raw Godot calls: ${run.rawGodotToolCalls.length}`,
        `ChronoRift game calls: ${result.agent.gameToolCalls.length}`,
        "",
        "candidate diff:",
        result.candidatePatch.unifiedDiff || "(empty)",
        "candidate platform state observation:",
        result.candidateObservation === null
          ? `(unavailable: ${result.candidateObservationError ?? "unknown error"})`
          : JSON.stringify(result.candidateObservation.state, null, 2),
        "candidate runtime errors:",
        run.candidateRuntimeErrors === null
          ? `(unavailable: ${run.candidateRuntimeErrorsError ?? "unknown error"})`
          : JSON.stringify(run.candidateRuntimeErrors, null, 2),
        "",
        `assistant text:\n${result.agent.assistantText}`,
        ...result.limitations.map((limitation) => `limitation: ${limitation}`),
      ].join("\n") + "\n",
    );
  }
  if (unsuccessful) process.exitCode = 1;
}

function printHelp(): void {
  process.stdout.write(`ChronoRift v0.4.0\n\n`);
  process.stdout.write(
    `  pnpm demo:platform-alias-ablation -- --arm coding-only|chronorift --project PATH --provider openai-codex --model gpt-5.6-luna [--thinking max --timeout-ms 600000 --host-config PATH --json]\n`,
  );
  process.stdout.write(
    `  Runs one fresh GN-1 ablation arm. Pair the two arm outputs with the independent evaluator; one arm is not a comparative result.\n\n`,
  );
  process.stdout.write(
    `  pnpm project preview -- [GOAL] --provider PROVIDER --model MODEL [--project-root RELATIVE_PATH] [--include-untracked RELATIVE_FILE]... [--launch-target TARGET_ID] [--thinking LEVEL --host-config PATH]\n`,
  );
  process.stdout.write(
    `  Project Environment Preview freezes tracked working-tree bytes plus explicitly repeated untracked files for one selected Godot 4.7.1 GDScript project. It remains separate from the default entry point.\n\n`,
  );
  process.stdout.write(
    `  pnpm task start --goal TEXT [--project PATH --provider PROVIDER --model MODEL --thinking LEVEL]\n`,
  );
  process.stdout.write(
    `  pnpm task continue --task-id ID --prompt TEXT\n  pnpm task show --task-id ID\n  pnpm task export --task-id ID --output FILE\n  pnpm task discard --task-id ID\n`,
  );
  process.stdout.write(
    `  New game Tasks require --task-storage-root PATH, --node-bin PATH, and --godot-bin PATH. M3 uses --addon-root. External lifecycle Tasks use --project-descriptor and --lifecycle-addon-root. E2 semantic Tasks additionally use --semantic-adapter-profile and --semantic-addon-root (or CHRONORIFT_GODOT_SEMANTIC_ADDON_ROOT). Continuations, exports, and discards revalidate persisted bytes without rereading either Host profile file.\n  --runtime-root must be a strict child of the bounded Task storage root (default: TASK_STORAGE_ROOT/runtime). Task execution also requires --cgroup-root PATH (or CHRONORIFT_CGROUP_ROOT).\n\n`,
  );
  process.stdout.write(
    `  pnpm demo [--environment mock|godot] [--godot-bin PATH] [--artifacts PATH] [--json]\n`,
  );
  process.stdout.write(
    `  pnpm diagnose -- --provider PROVIDER --model MODEL [--thinking LEVEL] [--environment mock|godot] [--godot-bin PATH] [--artifacts PATH] [--json]\n`,
  );
  process.stdout.write(`  pnpm models [-- --provider PROVIDER]\n`);
  process.stdout.write(`  pnpm pi [PI_ARGS]\n`);
  process.stdout.write(`  pnpm pi:smoke\n`);
  process.stdout.write(`  pnpm godot:install\n`);
  process.stdout.write(`  pnpm godot:doctor [-- --godot-bin PATH]\n`);
  process.stdout.write(
    `  pnpm replay -- --execution EXECUTION_ID [--godot-bin PATH] [--artifacts PATH]\n`,
  );
  process.stdout.write(`  pnpm fixtures\n`);
  process.stdout.write(
    `  pnpm demo:v04 -- --fixture FIXTURE [--godot-bin PATH] [--json]\n`,
  );
  process.stdout.write(
    `  pnpm diagnose:v04 -- --fixture FIXTURE --provider PROVIDER --model MODEL [--thinking LEVEL] [--timeout-ms MS] [--json]\n`,
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(argv);
  const cwd = process.cwd();
  switch (args.command) {
    case "demo-platform-alias-ablation":
      await platformAliasAblationCommand(args);
      return;
    case "project-preview":
      await projectPreviewCommand(args, cwd);
      return;
    case "task-start":
      await taskStartCommand(args, cwd);
      return;
    case "task-continue":
      await taskContinueCommand(args);
      return;
    case "task-show":
      await taskShowCommand(args);
      return;
    case "task-export":
      await taskExportCommand(args, cwd);
      return;
    case "task-discard":
      await taskDiscardCommand(args);
      return;
    case "demo":
      await runDemo(args, cwd);
      return;
    case "diagnose":
      await runDiagnosisCommand(args, cwd);
      return;
    case "demo-v04":
      await runV04DiagnosisCommand(args, cwd, "scripted");
      return;
    case "diagnose-v04":
      await runV04DiagnosisCommand(args, cwd, "live");
      return;
    case "fixtures":
      printJson({ schemaVersion: 1, fixtures: V03_FIXTURE_IDS });
      return;
    case "models":
      await modelsCommand(args);
      return;
    case "auth-volcengine":
      await persistVolcengineAuthCommand();
      return;
    case "pi-smoke":
      await piSmokeCommand(args, cwd);
      return;
    case "replay":
      await replayCommand(args, cwd);
      return;
    case "godot-doctor":
      await godotDoctorCommand(args, cwd);
      return;
    case "godot-install":
      await godotInstallCommand(cwd);
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntryPoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ChronoRift: ${message}\n`);
    process.exitCode = 1;
  });
}
