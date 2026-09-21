#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { asExecutionId, type DiagnosisProposal } from "@chronorift/domain";
import {
  V03_FIXTURE_IDS,
  asV03FixtureName,
  doctorGodot,
  installGodot,
  prepareGodotSwitchDoorFixture,
} from "@chronorift/godot-adapter";
import { V01JsonArtifactRepository } from "@chronorift/json-artifacts";
import {
  listAvailablePiModels,
  persistPiApiKey,
  runDeterministicPiDiagnosis,
  runPiDiagnosis,
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
  PlatformAliasAblationArmV1Schema,
  PlatformAliasDemoFailureV1Schema,
  runPlatformAliasAblationV1,
} from "./vnext/platform-alias-demo.js";
import { runMobOrientationAblationV1 } from "./vnext/mob-orientation-ablation.js";
import {
  assertOnlyFlags,
  flag,
  hasFlag,
  parseArguments,
  positiveIntegerFlag,
  printJson,
  requiredFlag,
  thinkingLevelFlag,
  type Arguments,
} from "./cli-arguments.js";
import { projectPreviewCommand } from "./project-preview-command.js";

function environmentKind(args: Arguments): "mock" | "godot" {
  const value = flag(args, "environment") ?? "mock";
  if (value !== "mock" && value !== "godot") {
    throw new Error(
      `Unsupported --environment ${value}; expected mock or godot`,
    );
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

async function platformAliasAblationCommand(args: Arguments) {
  assertOnlyFlags(args, [
    "arm",
    "project",
    "provider",
    "model",
    "thinking",
    "state-root",
    "godot-bin",
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
      ...(flag(args, "state-root") === undefined
        ? {}
        : { stateRoot: resolve(flag(args, "state-root")!) }),
      ...(flag(args, "godot-bin", "GODOT_BIN") === undefined
        ? {}
        : { godotBin: resolve(flag(args, "godot-bin", "GODOT_BIN")!) }),
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

async function mobOrientationAblationCommand(args: Arguments) {
  assertOnlyFlags(args, [
    "arm",
    "project",
    "provider",
    "model",
    "thinking",
    "state-root",
    "godot-bin",
    "timeout-ms",
    "agent-dir",
    "json",
  ]);
  try {
    const arm = requiredFlag(args, "arm");
    if (arm !== "coding-only" && arm !== "chronorift-v2")
      throw new Error("--arm must be coding-only or chronorift-v2");
    const run = await runMobOrientationAblationV1({
      arm,
      projectPath: resolve(requiredFlag(args, "project")),
      provider: requiredFlag(args, "provider"),
      model: requiredFlag(args, "model"),
      thinkingLevel: thinkingLevelFlag(args, "max"),
      ...(flag(args, "state-root") === undefined
        ? {}
        : { stateRoot: resolve(flag(args, "state-root")!) }),
      ...(flag(args, "godot-bin", "GODOT_BIN") === undefined
        ? {}
        : { godotBin: resolve(flag(args, "godot-bin", "GODOT_BIN")!) }),
      ...(flag(args, "agent-dir") === undefined
        ? {}
        : { agentDir: resolve(flag(args, "agent-dir")!) }),
      ...(flag(args, "timeout-ms") === undefined
        ? {}
        : { timeoutMs: positiveIntegerFlag(args, "timeout-ms", 600_000) }),
    });
    if (hasFlag(args, "json")) printJson(run);
    else
      process.stdout.write(
        [
          `ChronoRift Mob orientation ablation — ${run.arm} — ${run.runIntegrity}`,
          `task: ${run.taskId}`,
          `candidate diff:\n${run.candidatePatch.unifiedDiff || "(empty)"}`,
          `candidate runtime observation:\n${JSON.stringify(run.candidateObservation?.state ?? run.candidateObservationError, null, 2)}`,
          `independent evaluator: ${run.evaluator?.evaluatorAccepted === true ? "accepted 3/3" : `not accepted (${run.evaluatorError ?? "candidate failed"})`}`,
        ].join("\n") + "\n",
      );
    if (run.runIntegrity !== "valid") process.exitCode = 1;
  } catch (error) {
    const failure = {
      schemaVersion: 1,
      commandStatus: "failed",
      errorMessage:
        (error instanceof Error ? error.message : String(error))
          .replace(/[\r\n\0]/gu, " ")
          .trim()
          .slice(0, 4096) || "Mob orientation ablation arm failed",
    } as const;
    if (hasFlag(args, "json")) printJson(failure);
    else
      process.stderr.write(
        `ChronoRift Mob orientation ablation — failed\n${failure.errorMessage}\n`,
      );
    process.exitCode = 1;
  }
}

function printHelp(): void {
  process.stdout.write(`ChronoRift v0.4.0\n\n`);
  process.stdout.write(
    `  pnpm demo:platform-alias-ablation -- --arm coding-only|chronorift --project PATH --provider openai-codex --model gpt-5.6-luna [--thinking max --timeout-ms 600000 --state-root PATH --godot-bin PATH --json]\n`,
  );
  process.stdout.write(
    `  Runs one fresh GN-1 ablation arm. Pair the two arm outputs with the independent evaluator; one arm is not a comparative result.\n\n`,
  );
  process.stdout.write(
    `  pnpm demo:mob-orientation-ablation -- --arm coding-only|chronorift-v2 --project PATH --provider openai-codex --model gpt-5.6-luna [--thinking max --timeout-ms 600000 --state-root PATH --godot-bin PATH --json]\n`,
  );
  process.stdout.write(
    `  Runs one fresh Godot demo Mob-orientation arm through the fixed ProjectAdapter V2 slice. One arm is not a comparative result.\n\n`,
  );
  process.stdout.write(
    `  pnpm project preview -- [GOAL] --provider PROVIDER --model MODEL [--project-root RELATIVE_PATH] [--include-untracked RELATIVE_FILE]... [--thinking LEVEL --state-root PATH --godot-bin PATH] [--multi-agent --max-agents 3 --worker-model MODEL --worker-provider PROVIDER --worker-thinking LEVEL]\n`,
  );
  process.stdout.write(
    `  Project Environment Preview freezes tracked working-tree bytes plus explicitly repeated untracked files for one selected Godot 4.7.1 GDScript project. It remains separate from the default entry point.\n\n`,
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
    case "demo-mob-orientation-ablation":
      await mobOrientationAblationCommand(args);
      return;
    case "project-preview":
      await projectPreviewCommand(args, cwd);
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
