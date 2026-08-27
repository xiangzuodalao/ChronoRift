import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  JsonValueSchema,
  asProjectEnvironmentTaskId,
  asSha256DigestV1,
  type JsonValue,
} from "@chronorift/domain";
import { loadProjectAdapterPackageV2 } from "@chronorift/godot-adapter";
import { contentHash } from "@chronorift/json-artifacts";
import {
  createProjectEnvironmentGameToolDefinitions,
  createProjectEnvironmentToolCallAdmissionV1,
  createVNextCodingToolDefinitions,
  runVNextPiTurnWithSdk,
  type PiThinkingLevel,
  type ProjectEnvironmentGameToolPort,
  type ProjectEnvironmentGameToolPortRequestV1,
} from "@chronorift/pi-harness";

import { prepareProjectEnvironmentDebugBuildV1 } from "./candidate-godot-build.js";
import { NodeHostGitPort } from "./host-git.js";
import { preflightManagedGodotProjectEnvironmentRuntimeV2 } from "./managed-godot-project-environment-runtime-v2-preflight.js";
import { SandboxPiCodingToolPort } from "./pi-coding-tool-port.js";
import { extractTaskPatch } from "./patch-handoff.js";
import {
  createProjectEnvironmentGodotRunToolV2,
  type PlatformAliasGodotRunCallV1,
} from "./platform-alias-godot-run-tool.js";
import { ProjectEnvironmentGameRuntimeV2 } from "./project-environment-game-runtime-v2.js";
import { GodotProjectEnvironmentSidecarPortV2 } from "./project-environment-sidecar-port-v2.js";
import {
  preflightCleanProjectEnvironmentV1,
  type VerifiedProjectEnvironmentSourceV1,
} from "./source-preflight.js";
import { createProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";
import { materializePrivateTaskWorkspace } from "./workspace-materializer.js";
import { SrtGodotRunner } from "./srt-godot-runner.js";
import { resolveSrtRuntimeConfig } from "./srt-runtime-config.js";
import { SrtSandboxController } from "./srt-sandbox-controller.js";

export const MOB_ORIENTATION_SOURCE_COMMIT =
  "711822a319c4333a8740522f3c71e97783199fb0" as const;
export const MOB_ORIENTATION_SOURCE_TREE =
  "e80cfdab1b1c2b917bd1fe65d5aeaec5cf292539" as const;
export const MOB_ORIENTATION_PROJECT_PREFIX = "3d/squash_the_creeps" as const;
export const MOB_ORIENTATION_UPSTREAM_FIX_COMMIT =
  "57daa67c23ffdfaf0eae8e933b8eec397441275e" as const;
export const MOB_ORIENTATION_PROMPT =
  "Some newly spawned mobs are unexpectedly tilted, which can lead to inconsistent collision and movement behavior. Investigate the project, make the smallest appropriate fix, and validate the candidate. Preserve the intended randomized horizontal spawn direction and speed." as const;
export const MOB_ORIENTATION_PROVIDER = "openai-codex" as const;
export const MOB_ORIENTATION_MODEL = "gpt-5.6-luna" as const;
export const MOB_ORIENTATION_THINKING = "max" as const;
export const MOB_ORIENTATION_TIMEOUT_MS = 600_000 as const;
export const MOB_ORIENTATION_TOOL_CALL_BUDGET = 128 as const;
export const MOB_ORIENTATION_ADAPTER_PACKAGE_SHA256 =
  "a2293a0d9feef73f8dcc167a59e895367a2ecf6e7546f4486a3ccfe30a041689" as const;

export type MobOrientationAblationArmV1 = "coding-only" | "chronorift-v2";

export const MOB_ORIENTATION_SHARED_TOOL_NAMES = Object.freeze([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "godot_run",
] as const);
export const MOB_ORIENTATION_GAME_TOOL_NAMES = Object.freeze([
  "game_capabilities",
  "game_launch",
  "game_stop",
  "game_query",
] as const);

const ADAPTER_DIRECTORY = fileURLToPath(
  new URL(
    "../../../../testdata/vnext/external-project/squash-the-creeps-mob-orientation-adapter/",
    import.meta.url,
  ),
);

export interface MobOrientationAblationRequestV1 {
  readonly arm: MobOrientationAblationArmV1;
  readonly projectPath: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly stateRoot?: string | undefined;
  readonly godotBin?: string | undefined;
  readonly agentDir?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
};

const inspectSource = async (
  projectPath: string,
  taskStorageRoot: string,
): Promise<VerifiedProjectEnvironmentSourceV1> => {
  const source = await preflightCleanProjectEnvironmentV1({
    projectPath,
    projectRoot: MOB_ORIENTATION_PROJECT_PREFIX,
    sourceRepositoryExclusionRoots: [taskStorageRoot],
  });
  if (
    source.sourceKind !== "project-environment-v1-clean-git" ||
    source.sourceClosure === undefined ||
    source.projectPrefix !== MOB_ORIENTATION_PROJECT_PREFIX
  )
    throw new Error(
      `Mob orientation requires project path ${MOB_ORIENTATION_PROJECT_PREFIX} inside a clean upstream checkout`,
    );
  if (source.headCommit !== MOB_ORIENTATION_SOURCE_COMMIT)
    throw new Error(
      `Mob orientation requires exact commit ${MOB_ORIENTATION_SOURCE_COMMIT}; observed ${source.headCommit}`,
    );
  const tree = await new NodeHostGitPort().resolveHeadTree(
    source.repositoryRoot,
  );
  if (tree.toLowerCase() !== MOB_ORIENTATION_SOURCE_TREE)
    throw new Error(
      `Mob orientation requires exact repository tree ${MOB_ORIENTATION_SOURCE_TREE}; observed ${tree}`,
    );
  if (await exists(resolve(source.projectRoot, ".chronorift")))
    throw new Error(
      "Mob orientation source project must not contain .chronorift/",
    );
  return source;
};

const sourceStillExact = async (
  source: VerifiedProjectEnvironmentSourceV1,
): Promise<boolean> => {
  const git = new NodeHostGitPort();
  const [status, commit, tree, managed] = await Promise.all([
    git.statusPorcelain(source.repositoryRoot),
    git.resolveHeadCommit(source.repositoryRoot),
    git.resolveHeadTree(source.repositoryRoot),
    exists(resolve(source.projectRoot, ".chronorift")),
  ]);
  return (
    status.byteLength === 0 &&
    commit === MOB_ORIENTATION_SOURCE_COMMIT &&
    tree.toLowerCase() === MOB_ORIENTATION_SOURCE_TREE &&
    !managed
  );
};

const successfulOutput = (response: unknown): JsonValue => {
  if (
    response === null ||
    typeof response !== "object" ||
    (response as { outcome?: unknown }).outcome !== "success"
  )
    throw new Error(`game operation failed: ${JSON.stringify(response)}`);
  return JsonValueSchema.parse(
    (response as { readonly output: unknown }).output,
  );
};

const outputString = (value: JsonValue, key: string): string => {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    typeof value[key] !== "string"
  )
    throw new Error(`game output is missing ${key}`);
  return value[key];
};

const observe = async (
  runtime: ProjectEnvironmentGameToolPort,
  taskId: string,
  launchTargetId: string,
) => {
  const invoke = async (toolName: string, input: JsonValue) =>
    successfulOutput(
      await runtime.invoke({
        schemaVersion: 1,
        toolCallId: `mob-host-${toolName}-${randomUUID()}`,
        toolName: toolName as never,
        input,
      }),
    );
  const capabilities = await invoke("game_capabilities", {
    schemaVersion: 1,
    taskId,
  });
  const buildId = outputString(capabilities, "buildId");
  const launch = await invoke("game_launch", {
    schemaVersion: 1,
    taskId,
    buildId,
    launchTargetId,
    parameters: {},
  });
  const runtimeId = outputString(launch, "runtimeId");
  const executionId = outputString(launch, "executionId");
  let entities: JsonValue | null = null;
  let state: JsonValue | null = null;
  let failure: unknown;
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      entities = await invoke("game_query", {
        schemaVersion: 1,
        taskId,
        executionId,
        select: "entities",
        limit: 200,
      });
      state = await invoke("game_query", {
        schemaVersion: 1,
        taskId,
        executionId,
        select: "state",
        limit: 200,
      });
      if (JSON.stringify(state).includes("mob_spawn_orientation")) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (!JSON.stringify(state).includes("mob_spawn_orientation"))
      throw new Error(
        "Mob orientation state did not appear in the bounded window",
      );
  } catch (error) {
    failure = error;
  }
  let stop: JsonValue;
  try {
    stop = await invoke("game_stop", {
      schemaVersion: 1,
      taskId,
      runtimeId,
    });
  } catch (stopError) {
    const stopMessage =
      stopError instanceof Error
        ? stopError.message
        : JSON.stringify(stopError);
    const failureMessage =
      failure instanceof Error ? failure.message : JSON.stringify(failure);
    throw new Error(
      failure === undefined
        ? stopMessage
        : `${failureMessage}; stop failed: ${stopMessage}`,
    );
  }
  if (failure !== undefined)
    throw failure instanceof Error
      ? failure
      : new Error(JSON.stringify(failure));
  return Object.freeze({
    schemaVersion: 1 as const,
    buildId,
    runtimeId,
    executionId,
    capabilities,
    launch,
    entities,
    state,
    stop,
  });
};

const recordGameCalls = (
  runtime: ProjectEnvironmentGameToolPort,
  calls: { request: JsonValue; response: JsonValue }[],
): ProjectEnvironmentGameToolPort => ({
  invoke: async (
    request: ProjectEnvironmentGameToolPortRequestV1,
    signal?: AbortSignal,
  ) => {
    const response = await runtime.invoke(request, signal);
    calls.push({
      request: JsonValueSchema.parse(request),
      response: JsonValueSchema.parse(response),
    });
    return response;
  },
});

const extractCandidatePatch = async (input: {
  readonly taskId: string;
  readonly workspaceDirectory: string;
  readonly hostBaselineGitDirectory: string;
  readonly hostBaselineCommit: string;
  readonly baselineSourceHash: ReturnType<typeof asSha256DigestV1>;
  readonly hostOperationTemporaryDirectory: string;
}) => {
  const extracted = await extractTaskPatch({
    ...input,
    taskId: asProjectEnvironmentTaskId(input.taskId),
    sourceKind: "project-environment-v1",
    ignoredCachePaths: [".chronorift", ".godot"],
  });
  const bytes = Buffer.from(extracted.patchBytes);
  return Object.freeze({
    schemaVersion: 1 as const,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    unifiedDiff: bytes.toString("utf8"),
  });
};

const evaluateCandidateInSandbox = async (input: {
  readonly workspaceDirectory: string;
  readonly taskId: string;
  readonly sidecar: GodotProjectEnvironmentSidecarPortV2;
  readonly managedRuntimeId: string;
  readonly prepareBuild: () => ReturnType<
    typeof prepareProjectEnvironmentDebugBuildV1
  >;
}) => {
  const scenePath = resolve(
    input.workspaceDirectory,
    "_chronorift_mob_evaluator.tscn",
  );
  const scriptPath = resolve(
    input.workspaceDirectory,
    "_chronorift_mob_evaluator.gd",
  );
  const results: {
    attempt: number;
    accepted: boolean;
    sandboxStatus: string;
    exitCode: number | null;
    signal: string | null;
    observation: JsonValue | null;
  }[] = [];
  try {
    await writeFile(
      scenePath,
      `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://_chronorift_mob_evaluator.gd" id="1"]\n\n[node name="Evaluator" type="Node"]\nscript = ExtResource("1")\n`,
      { flag: "wx" },
    );
    await writeFile(
      scriptPath,
      `extends Node

const MOB_SCRIPT := preload("res://Mob.gd")

func _ready() -> void:
\tvar observations: Array = []
\tvar all_accepted := true
\tfor seed_value in [7301, 7402, 7503]:
\t\tseed(seed_value)
\t\tvar mob := MOB_SCRIPT.new() as CharacterBody3D
\t\tvar animation := AnimationPlayer.new()
\t\tanimation.name = "AnimationPlayer"
\t\tmob.add_child(animation)
\t\tadd_child(mob)
\t\tmob.initialize(Vector3(10.0, 0.0, 10.0), Vector3(-2.0, 6.0, -4.0))
\t\tvar up_alignment := mob.global_basis.y.normalized().dot(Vector3.UP)
\t\tvar horizontal_speed := Vector2(mob.velocity.x, mob.velocity.z).length()
\t\tvar accepted := up_alignment >= 0.999999 and absf(mob.velocity.y) <= 0.000001 and horizontal_speed >= float(mob.min_speed) - 0.000001 and horizontal_speed <= float(mob.max_speed) + 0.000001
\t\tall_accepted = all_accepted and accepted
\t\tobservations.append({"seed": seed_value, "upAlignment": up_alignment, "velocityY": mob.velocity.y, "horizontalSpeed": horizontal_speed, "accepted": accepted})
\t\tmob.queue_free()
\tprint("CHRONORIFT_MOB_EVAL=" + JSON.stringify({"accepted": all_accepted, "observations": observations}))
\tawait get_tree().create_timer(2.1).timeout
\tget_tree().quit(0 if all_accepted else 1)
`,
      { flag: "wx" },
    );
    const prepared = await input.prepareBuild();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const nonce = randomUUID();
      const run = await input.sidecar.runVanilla({
        schemaVersion: 2,
        runtimeProfile: "chronorift-managed-godot-project-environment-v2",
        taskId: input.taskId,
        buildId: prepared.build.buildId,
        runtimeId: `runtime:mob-evaluator:${nonce}`,
        executionId: `execution:mob-evaluator:${nonce}`,
        managedRuntimeId: input.managedRuntimeId,
        candidateSourceHash: prepared.build.candidateSourceHash,
        diagnosticFrameMaxBytes: 64 * 1024,
        diagnosticTotalMaxBytes: 1024 * 1024,
        diagnosticMaxCount: 256,
        outputCaptureMaxBytes: 64 * 1024,
        operation: "vanilla_smoke",
        launchScene: "res://_chronorift_mob_evaluator.tscn",
        importTimeoutMs: 120_000,
        vanillaTimeoutMs: 10_000,
        stabilityWindowMs: 2_000,
      });
      if (run.kind !== "completed") {
        results.push({
          attempt,
          accepted: false,
          sandboxStatus: "denied",
          exitCode: null,
          signal: null,
          observation: null,
        });
        continue;
      }
      const stdout = Buffer.concat(
        run.result.diagnostics.flatMap((record) =>
          record.kind === "process_output" && record.stream === "stdout"
            ? [Buffer.from(record.bytesBase64, "base64")]
            : [],
        ),
      ).toString("utf8");
      const line = stdout
        .split(/\r?\n/u)
        .find((value) => value.startsWith("CHRONORIFT_MOB_EVAL="));
      const observation =
        line === undefined
          ? null
          : JsonValueSchema.parse(
              JSON.parse(line.slice("CHRONORIFT_MOB_EVAL=".length)),
            );
      const accepted =
        run.result.sandbox.process.process.status === "exited" &&
        run.result.sandbox.process.process.exitCode === 0 &&
        run.result.sandbox.process.sourceUnchanged &&
        observation !== null &&
        !Array.isArray(observation) &&
        typeof observation === "object" &&
        observation["accepted"] === true;
      results.push({
        attempt,
        accepted,
        sandboxStatus: run.result.sandbox.process.process.status,
        exitCode: run.result.sandbox.process.process.exitCode,
        signal: run.result.sandbox.process.process.signal,
        observation,
      });
    }
  } finally {
    await Promise.all([
      rm(scenePath, { force: true }),
      rm(scriptPath, { force: true }),
    ]);
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    evaluatorAccepted:
      results.length === 3 && results.every((result) => result.accepted),
    results: Object.freeze(results),
  });
};

export async function runMobOrientationAblationV1(
  request: MobOrientationAblationRequestV1,
) {
  if (request.arm !== "coding-only" && request.arm !== "chronorift-v2")
    throw new Error("arm must be coding-only or chronorift-v2");
  if (request.provider !== MOB_ORIENTATION_PROVIDER)
    throw new Error(`provider is frozen to ${MOB_ORIENTATION_PROVIDER}`);
  if (request.model !== MOB_ORIENTATION_MODEL)
    throw new Error(`model is frozen to ${MOB_ORIENTATION_MODEL}`);
  if (request.thinkingLevel !== MOB_ORIENTATION_THINKING)
    throw new Error(`thinking is frozen to ${MOB_ORIENTATION_THINKING}`);
  const timeoutMs = request.timeoutMs ?? MOB_ORIENTATION_TIMEOUT_MS;
  if (timeoutMs !== MOB_ORIENTATION_TIMEOUT_MS)
    throw new Error(`timeout is frozen to ${MOB_ORIENTATION_TIMEOUT_MS}`);

  const runtimeConfig = await resolveSrtRuntimeConfig({
    ...(request.stateRoot === undefined
      ? {}
      : { stateRoot: request.stateRoot }),
    ...(request.godotBin === undefined ? {} : { godotBin: request.godotBin }),
  });
  const runtimeRoot = runtimeConfig.stateRoot;
  const source = await inspectSource(resolve(request.projectPath), runtimeRoot);
  if (source.requestedGodotVersion !== "4.7.1")
    throw new Error("Mob orientation requires Godot 4.7.1");
  const godot = runtimeConfig.godot;
  const adapter = await loadProjectAdapterPackageV2(ADAPTER_DIRECTORY, {
    requireSingleLaunchTarget: true,
    expectedMainScene: source.mainScene,
    requireEmptyLaunchParameters: true,
  });
  if (adapter.candidateSha256 !== MOB_ORIENTATION_ADAPTER_PACKAGE_SHA256)
    throw new Error(
      `Mob orientation Adapter bytes drifted from frozen package ${MOB_ORIENTATION_ADAPTER_PACKAGE_SHA256}`,
    );
  const adapterFiles = await Promise.all(
    adapter.files.map(async (file) => ({
      relativePath: file.path,
      bytes: await readFile(resolve(ADAPTER_DIRECTORY, file.path)),
    })),
  );
  const managed = preflightManagedGodotProjectEnvironmentRuntimeV2({
    godotReceipt: godot.receipt,
    adapterFiles,
  });
  const taskId = asProjectEnvironmentTaskId(randomUUID());
  const layout = await createProjectEnvironmentTaskDirectoryLayout({
    runtimeRoot,
    sourceRepositoryRoot: source.repositoryRoot,
    taskId,
  });
  const materialized = await materializePrivateTaskWorkspace({
    taskId,
    source,
    layout,
  });
  const payloadSchemaDigest = asSha256DigestV1(
    contentHash({
      schemaVersion: 1,
      schemas: adapter.manifest.schemas.map((schema) => ({
        schemaId: schema.schemaId,
        sha256: schema.sha256,
      })),
    }),
  );
  const policyProfileDigest = asSha256DigestV1(
    contentHash({
      schemaVersion: 1,
      runtime: "@anthropic-ai/sandbox-runtime@0.0.74",
      network: "denied",
      codingWorkspace: "read-write",
      godotProject: "read-only-host-stage",
    }),
  );
  const prepareBuild = () =>
    prepareProjectEnvironmentDebugBuildV1({
      workspaceDirectory: materialized.workspaceDirectory,
      expectedMainScene: materialized.mainScene,
      adapterManifestDigest: asSha256DigestV1(adapter.manifestSha256),
      adapterPackageDigest: asSha256DigestV1(adapter.candidateSha256),
      payloadSchemaDigest,
      sdkDigest: managed.sdkDigest,
      bridgeDigest: managed.bridgeDigest,
      toolchainArtifactDigest: godot.receipt.executableSha256,
      policyProfileDigest,
    });
  const initial = await prepareBuild();
  const codingHome = join(layout.sandboxTemporaryDirectory, "coding-home");
  const codingTemp = join(layout.sandboxTemporaryDirectory, "coding-tmp");
  await Promise.all([
    mkdir(codingHome, { mode: 0o700 }),
    mkdir(codingTemp, { mode: 0o700 }),
  ]);
  const controller = new SrtSandboxController();
  const runner = new SrtGodotRunner({
    controller,
    candidateWorkspace: materialized.workspaceDirectory,
    validationRoot: join(
      layout.hostOperationTemporaryDirectory,
      "godot-validation",
    ),
  });
  const sidecar = new GodotProjectEnvironmentSidecarPortV2({
    runner,
    nodePath: runtimeConfig.nodePath,
    godotPath: godot.binding.executablePath,
    managedRuntime: managed,
  });
  const environmentRevisionId = `environment.mob.${source.selectedTreeSha256.slice(0, 32)}`;
  const adapterRevisionId = `adapter.mob.${adapter.manifestSha256.slice(0, 32)}`;
  const makeRuntime = () =>
    new ProjectEnvironmentGameRuntimeV2({
      taskId,
      environmentRevisionId,
      adapterRevisionId,
      adapterPackage: adapter,
      validatedLaunchTargetIds: ["main"],
      compatibleLaunchTargetId: "main",
      capabilitySet: adapter.manifest.modules,
      managedRuntime: managed.capability,
      sidecar,
      adapterManifestSha256: adapter.manifestSha256,
      sdkSha256: managed.sdkDigest,
      bridgeSha256: managed.bridgeDigest,
      toolchainSha256: godot.receipt.executableSha256,
      engineVersion: managed.capability.engineVersion,
      resolveBuild: async () => {
        const prepared = await prepareBuild();
        return {
          ...prepared.build,
        };
      },
      persistPinnedCapture: () => Promise.resolve(),
      persistRuntimeObservation: () => Promise.resolve(),
    });
  let runtime: ProjectEnvironmentGameRuntimeV2 | null = makeRuntime();
  let baselineObservation: Awaited<ReturnType<typeof observe>>;
  let candidateObservation: Awaited<ReturnType<typeof observe>> | null = null;
  let candidateObservationError: string | null = null;
  let evaluator: Awaited<ReturnType<typeof evaluateCandidateInSandbox>> | null =
    null;
  let evaluatorError: string | null = null;
  let agent: unknown = null;
  let agentError: string | null = null;
  const gameToolCalls: { request: JsonValue; response: JsonValue }[] = [];
  const godotRunCalls: PlatformAliasGodotRunCallV1[] = [];
  const toolCallAdmission = createProjectEnvironmentToolCallAdmissionV1(
    MOB_ORIENTATION_TOOL_CALL_BUDGET,
  );
  try {
    baselineObservation = await observe(runtime, taskId, "main");
    const codingTools = createVNextCodingToolDefinitions(
      new SandboxPiCodingToolPort(controller, {
        workspacePath: materialized.workspaceDirectory,
        homePath: codingHome,
        tempPath: codingTemp,
        artifactsPath: layout.sandboxArtifactScratchDirectory,
      }),
      { toolCallAdmission },
    );
    const godotRun = createProjectEnvironmentGodotRunToolV2({
      sidecar,
      managedRuntime: managed.capability,
      taskId,
      prepareBuild,
      onCall: (call) => {
        godotRunCalls.push(call);
      },
      toolCallAdmission,
    });
    const gameTools = createProjectEnvironmentGameToolDefinitions(
      recordGameCalls(runtime, gameToolCalls),
      adapter.manifest.modules,
      {
        includedToolNames: MOB_ORIENTATION_GAME_TOOL_NAMES,
        queryInputProfile: "pe-a-v1-narrow",
        toolCallAdmission,
      },
    );
    const sharedTools = [...codingTools, godotRun];
    const selectedGameTools = request.arm === "chronorift-v2" ? gameTools : [];
    if (
      JSON.stringify(sharedTools.map((tool) => tool.name)) !==
        JSON.stringify(MOB_ORIENTATION_SHARED_TOOL_NAMES) ||
      JSON.stringify(selectedGameTools.map((tool) => tool.name)) !==
        JSON.stringify(
          request.arm === "chronorift-v2"
            ? MOB_ORIENTATION_GAME_TOOL_NAMES
            : [],
        )
    )
      throw new Error("Mob orientation matched tool surface drifted");
    try {
      agent = await runVNextPiTurnWithSdk({
        resourceWorkspaceDirectory: materialized.workspaceDirectory,
        sessionDirectory: layout.piSessionDirectory,
        newSessionId: randomUUID(),
        ...(request.agentDir === undefined
          ? {}
          : { agentDir: request.agentDir }),
        provider: request.provider,
        model: request.model,
        thinkingLevel: request.thinkingLevel,
        prompt: MOB_ORIENTATION_PROMPT,
        tools: [...sharedTools, ...selectedGameTools],
        timeoutMs,
        providerRequestTimeoutMs: 60_000,
        agentRetryMaxRetries: 1,
        transport: "sse",
        environmentProfile: "coding",
        additionalEnvironmentInstructions: [
          "Task context:",
          `- taskId: ${taskId}`,
          ...(request.arm === "chronorift-v2"
            ? [
                "- A prevalidated Project Environment V2 is available through the game_* tools.",
                "- Runtime records are observations, not verdicts; choose your own investigation and validation order.",
              ]
            : []),
        ].join("\n"),
      });
    } catch (error) {
      agentError = error instanceof Error ? error.message : String(error);
    }
    await runtime.close();
    runtime = makeRuntime();
    try {
      candidateObservation = await observe(runtime, taskId, "main");
    } catch (error) {
      candidateObservationError =
        error instanceof Error ? error.message : String(error);
    }
    try {
      evaluator = await evaluateCandidateInSandbox({
        workspaceDirectory: materialized.workspaceDirectory,
        taskId,
        sidecar,
        managedRuntimeId: managed.capability.managedRuntimeId,
        prepareBuild,
      });
    } catch (error) {
      evaluatorError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    await runtime?.close().catch(() => undefined);
    await controller.close();
  }
  const patch = await extractCandidatePatch({
    taskId,
    workspaceDirectory: materialized.workspaceDirectory,
    hostBaselineGitDirectory: materialized.hostBaselineGitDirectory,
    hostBaselineCommit: materialized.hostBaselineCommit,
    baselineSourceHash: source.selectedTreeSha256,
    hostOperationTemporaryDirectory: layout.hostOperationTemporaryDirectory,
  });
  const checkoutCleanAfter = await sourceStillExact(source);
  const result = {
    schemaVersion: 1,
    caseId: "godot-demo-mob-orientation",
    arm: request.arm,
    configuration: {
      provider: request.provider,
      model: request.model,
      thinkingLevel: request.thinkingLevel,
      timeoutMs,
      toolCallBudget: MOB_ORIENTATION_TOOL_CALL_BUDGET,
      prompt: MOB_ORIENTATION_PROMPT,
      sourceCommit: MOB_ORIENTATION_SOURCE_COMMIT,
      sourceTree: MOB_ORIENTATION_SOURCE_TREE,
      projectPrefix: MOB_ORIENTATION_PROJECT_PREFIX,
      adapterSha256: adapter.candidateSha256,
      sharedToolNames: MOB_ORIENTATION_SHARED_TOOL_NAMES,
      chronoriftToolNames:
        request.arm === "chronorift-v2" ? MOB_ORIENTATION_GAME_TOOL_NAMES : [],
    },
    taskId,
    source: {
      selectedTreeSha256: source.selectedTreeSha256,
      checkoutCleanAfter,
    },
    initialBuildId: initial.build.buildId,
    baselineObservation,
    candidateObservation,
    candidateObservationError,
    candidatePatch: patch,
    agent,
    agentError,
    gameToolCalls,
    godotRunCalls,
    toolCallBudget: {
      limit: toolCallAdmission.limit,
      admitted: toolCallAdmission.admitted,
      rejected: toolCallAdmission.rejected,
      exhausted: toolCallAdmission.exhausted,
    },
    evaluator,
    evaluatorError,
    sandboxRuntime: "anthropic-srt",
    runIntegrity: checkoutCleanAfter ? "valid" : "invalid",
    workspaceDirectory: materialized.workspaceDirectory,
    taskDirectory: layout.taskRootDirectory,
  } as const;
  return result;
}
