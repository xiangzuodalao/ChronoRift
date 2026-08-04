#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  asExecutionId,
  type DiagnosisProposal,
  type DiagnosisProposalV2,
  type DiagnosisVerdictV2,
  type V03ExecutionLog,
} from "@chronorift/domain";
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
  createRestrictedSourceAccess,
  runDeterministicPiDiagnosis,
  runDeterministicV03PiDiagnosis,
  runPiDiagnosis,
  runV03PiDiagnosis,
  type PiDiagnosisRunResult,
} from "@chronorift/pi-harness";

import { persistV01PiDiagnosis } from "./diagnosis.js";
import { ChronoRiftV01AgentGameApi } from "./v01-agent-game-api.js";
import { ChronoRiftV03AgentGameApi } from "./v03-agent-game-api.js";
import {
  runV03Benchmark,
  verifySanitizedV03BenchmarkReport,
  writeSanitizedV03BenchmarkReport,
} from "./v03-benchmark.js";
import {
  createV01GameBranchServiceForEnvironment,
  createV01MockRun,
  type V01MockRunContext,
} from "./v01-runtime.js";
import { createV03Run, type V03RunContext } from "./v03-runtime.js";

interface Arguments {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string | true>;
}

const booleanFlags = new Set(["json"]);

function parseArguments(argv: readonly string[]): Arguments {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--") continue;
    if (token === undefined || !token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${String(token)}`);
    }
    const equals = token.indexOf("=");
    if (equals > 2) {
      const name = token.slice(2, equals);
      if (booleanFlags.has(name)) {
        throw new Error(`Boolean flag --${name} does not accept a value`);
      }
      flags.set(name, token.slice(equals + 1));
      continue;
    }
    const name = token.slice(2);
    if (booleanFlags.has(name)) {
      flags.set(name, true);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${token}`);
    }
    flags.set(name, value);
    index += 1;
  }
  return { command, flags };
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
    initialCapsuleId: context.evidenceCapsule.capsuleId,
    game,
  });
  const output = await diagnosisOutput(context, result);
  if (hasFlag(args, "json")) printJson(output);
  else printHumanDiagnosis(output);
}

async function v03DiagnosisOutput(
  context: V03RunContext,
  result: Awaited<ReturnType<typeof runDeterministicV03PiDiagnosis>>,
): Promise<Readonly<Record<string, unknown>>> {
  const verdict = await context.gameBranch.conclude(result.proposal);
  return {
    schemaVersion: 2,
    fixture: context.preparedFixture.fixtureName,
    runId: context.runId,
    artifactRoot: context.artifactRoot,
    runDirectory: context.runDirectory,
    contract: context.contract,
    baselineBranch: context.baselineBranch,
    baselineExecution: context.baselineExecution,
    evidenceCapsule: context.evidenceCapsule,
    proposal: result.proposal,
    verdict,
    piSession: result.piSession,
  };
}

function printHumanV03Diagnosis(
  output: Readonly<Record<string, unknown>>,
): void {
  const proposal = output["proposal"] as DiagnosisProposalV2;
  const verdict = output["verdict"] as DiagnosisVerdictV2;
  const baseline = output["baselineExecution"] as V03ExecutionLog;
  const session = output["piSession"] as {
    readonly provider: string;
    readonly model: string;
    readonly sessionFile: string;
  };
  process.stdout.write(`ChronoRift v0.3 — ${verdict.status}\n`);
  process.stdout.write(`${verdict.summary}\n\n`);
  process.stdout.write(`Fixture:           ${String(output["fixture"])}\n`);
  process.stdout.write(
    `Baseline:          ${baseline.executionId} (${baseline.evaluation.status})\n`,
  );
  process.stdout.write(`Mechanism:         ${proposal.mechanismCode}\n`);
  process.stdout.write(
    `Agent confidence:  ${proposal.confidence} (advisory; ignored by the Gate)\n`,
  );
  process.stdout.write(
    `Pi model:          ${session.provider}/${session.model}\n`,
  );
  process.stdout.write(`Pi session:        ${session.sessionFile}\n`);
  process.stdout.write(
    `Artifacts:         ${String(output["runDirectory"])}\n`,
  );
  if (verdict.blockers.length > 0) {
    process.stdout.write(`Blockers:          ${verdict.blockers.join("; ")}\n`);
  }
}

async function runV03DiagnosisCommand(
  args: Arguments,
  cwd: string,
  mode: "deterministic" | "live",
): Promise<void> {
  const fixture = asV03FixtureName(flag(args, "fixture") ?? "signal-ordering");
  const artifactRoot = flag(args, "artifacts", "CHRONORIFT_ARTIFACT_ROOT");
  const godotBin = flag(args, "godot-bin", "GODOT_BIN");
  const context = await createV03Run({
    cwd,
    fixture,
    ...(artifactRoot === undefined ? {} : { artifactRoot }),
    ...(godotBin === undefined ? {} : { godotBin }),
  });
  const game = new ChronoRiftV03AgentGameApi(context);
  const source = await createRestrictedSourceAccess({
    root: context.preparedFixture.sourceDirectory,
  });
  const common = {
    cwd,
    runDir: context.runDirectory,
    arm: "chronorift-full" as const,
    initialCapsuleId: context.evidenceCapsule.capsuleId,
    baselineExecutionId: context.baselineExecution.executionId,
    game,
    source,
  };
  const result =
    mode === "deterministic"
      ? await runDeterministicV03PiDiagnosis(common)
      : await runV03PiDiagnosis({
          ...common,
          provider: requiredFlag(args, "provider", "CHRONORIFT_PI_PROVIDER"),
          model: requiredFlag(args, "model", "CHRONORIFT_PI_MODEL"),
        });
  const output = await v03DiagnosisOutput(context, result);
  if (hasFlag(args, "json")) printJson(output);
  else printHumanV03Diagnosis(output);
}

async function runBenchmarkCommand(
  args: Arguments,
  cwd: string,
  mode: "deterministic" | "live",
): Promise<void> {
  const report = await runV03Benchmark({
    cwd,
    mode,
    repetitions: positiveIntegerFlag(
      args,
      "repetitions",
      mode === "live" ? 3 : 1,
    ),
    seed: flag(args, "seed") ?? "chronorift-v0.3",
    ...(mode === "live"
      ? {
          provider: requiredFlag(args, "provider", "CHRONORIFT_PI_PROVIDER"),
          model: requiredFlag(args, "model", "CHRONORIFT_PI_MODEL"),
        }
      : {}),
    ...(flag(args, "artifacts", "CHRONORIFT_ARTIFACT_ROOT") === undefined
      ? {}
      : { artifactRoot: flag(args, "artifacts", "CHRONORIFT_ARTIFACT_ROOT") }),
    ...(flag(args, "godot-bin", "GODOT_BIN") === undefined
      ? {}
      : { godotBin: flag(args, "godot-bin", "GODOT_BIN") }),
  });
  const output =
    flag(args, "report") ??
    (mode === "live" ? "docs/benchmarks/v0.3-live.json" : undefined);
  if (output !== undefined) {
    await writeSanitizedV03BenchmarkReport(resolve(cwd, output), report);
  }
  printJson({
    ...report,
    ...(output === undefined ? {} : { reportPath: output }),
  });
}

async function verifyBenchmarkCommand(
  args: Arguments,
  cwd: string,
): Promise<void> {
  const path = resolve(
    cwd,
    flag(args, "report") ?? "docs/benchmarks/v0.3-live.json",
  );
  const report = await verifySanitizedV03BenchmarkReport(path);
  printJson({ verified: true, reportPath: path, advantage: report.advantage });
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

function printHelp(): void {
  process.stdout.write(`ChronoRift v0.3\n\n`);
  process.stdout.write(
    `  pnpm demo [--environment mock|godot] [--godot-bin PATH] [--artifacts PATH] [--json]\n`,
  );
  process.stdout.write(
    `  pnpm diagnose -- --provider PROVIDER --model MODEL [--environment mock|godot] [--godot-bin PATH] [--artifacts PATH] [--json]\n`,
  );
  process.stdout.write(`  pnpm models [-- --provider PROVIDER]\n`);
  process.stdout.write(`  pnpm auth:volcengine\n`);
  process.stdout.write(`  pnpm godot:install\n`);
  process.stdout.write(`  pnpm godot:doctor [-- --godot-bin PATH]\n`);
  process.stdout.write(
    `  pnpm replay -- --execution EXECUTION_ID [--godot-bin PATH] [--artifacts PATH]\n`,
  );
  process.stdout.write(`  pnpm fixtures\n`);
  process.stdout.write(
    `  pnpm demo:v03 -- --fixture FIXTURE [--godot-bin PATH] [--json]\n`,
  );
  process.stdout.write(
    `  pnpm diagnose:v03 -- --fixture FIXTURE --provider PROVIDER --model MODEL [--json]\n`,
  );
  process.stdout.write(
    `  pnpm benchmark [-- --repetitions N --seed SEED --report PATH]\n`,
  );
  process.stdout.write(
    `  pnpm benchmark:live -- --provider PROVIDER --model MODEL [--repetitions 3 --report PATH]\n`,
  );
  process.stdout.write(`  pnpm benchmark:verify [-- --report PATH]\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(argv);
  const cwd = process.cwd();
  switch (args.command) {
    case "demo":
      await runDemo(args, cwd);
      return;
    case "diagnose":
      await runDiagnosisCommand(args, cwd);
      return;
    case "demo-v03":
      await runV03DiagnosisCommand(args, cwd, "deterministic");
      return;
    case "diagnose-v03":
      await runV03DiagnosisCommand(args, cwd, "live");
      return;
    case "fixtures":
      printJson({ schemaVersion: 1, fixtures: V03_FIXTURE_IDS });
      return;
    case "benchmark":
      await runBenchmarkCommand(args, cwd, "deterministic");
      return;
    case "benchmark-live":
      await runBenchmarkCommand(args, cwd, "live");
      return;
    case "benchmark-verify":
      await verifyBenchmarkCommand(args, cwd);
      return;
    case "models":
      await modelsCommand(args);
      return;
    case "auth-volcengine":
      await persistVolcengineAuthCommand();
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
