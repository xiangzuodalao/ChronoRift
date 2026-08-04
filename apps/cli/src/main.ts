#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { asBranchId } from "@chronorift/domain";
import { JsonArtifactRepository } from "@chronorift/json-artifacts";
import {
  listAvailablePiModels,
  persistPiApiKey,
  runPiDiagnosis,
} from "@chronorift/pi-harness";

import { ChronoRiftAgentGameApi } from "./agent-game-api.js";
import { persistPiDiagnosis } from "./diagnosis.js";
import { createBranchRunner, createMockRun } from "./runtime.js";

interface Arguments {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string>;
}

function parseArguments(argv: readonly string[]): Arguments {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--") continue;
    if (token === undefined || !token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${String(token)}`);
    }
    const equals = token.indexOf("=");
    if (equals > 2) {
      flags.set(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${token}`);
    }
    flags.set(token.slice(2), value);
    index += 1;
  }
  return { command, flags };
}

function flag(
  args: Arguments,
  name: string,
  environmentName?: string,
): string | undefined {
  return (
    args.flags.get(name) ??
    (environmentName === undefined ? undefined : process.env[environmentName])
  );
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

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runDemo(cwd: string, artifactRoot?: string): Promise<void> {
  const context = await createMockRun({
    cwd,
    ...(artifactRoot === undefined ? {} : { artifactRoot }),
  });
  const replay = await context.runner.replayStrict(
    context.baselineBranch.branchId,
  );
  const candidateBranch = await context.runner.createFork({
    parentBranchId: context.baselineBranch.branchId,
    controls: {
      deltaUs: context.scenario.controls.candidate.deltaUs,
    },
    replayMode: "experiment",
  });
  const candidateRun = await context.runner.run(candidateBranch.branchId);
  const comparison = await context.runner.compare(
    context.baselineBranch.branchId,
    candidateBranch.branchId,
  );

  printJson({
    runId: context.runId,
    runDirectory: context.repository.resolveRunDirectory(context.runId),
    baseline: {
      branchId: context.baselineBranch.branchId,
      outcome: context.baselineRun.evaluations[0]?.status,
      evidenceId: context.initialEvidence.evidenceId,
      signalRecorded: context.baselineRun.events.some(
        (event) => event.kind === "signal" && event.name === "switch.activated",
      ),
      switchChanged: context.baselineRun.events.some(
        (event) =>
          event.kind === "property_changed" && event.path === "switch.active",
      ),
      doorOpen: context.baselineRun.frames.at(-1)?.state.values["door.open"],
    },
    strictReplay: replay,
    experiment: {
      branchId: candidateBranch.branchId,
      deltaUs: candidateBranch.controls.deltaUs,
      outcome: candidateRun.evaluations[0]?.status,
      doorOpen: candidateRun.frames.at(-1)?.state.values["door.open"],
    },
    comparison,
    evidence: context.initialEvidence,
  });
}

async function runDiagnosisCommand(
  args: Arguments,
  cwd: string,
): Promise<void> {
  const provider = requiredFlag(args, "provider", "CHRONORIFT_PI_PROVIDER");
  const model = requiredFlag(args, "model", "CHRONORIFT_PI_MODEL");
  const artifactRoot = flag(args, "artifacts", "CHRONORIFT_ARTIFACT_ROOT");
  const context = await createMockRun({
    cwd,
    ...(artifactRoot === undefined ? {} : { artifactRoot }),
    model: { piSessionId: null, provider, model },
  });
  const game = new ChronoRiftAgentGameApi(
    context.runId,
    context.baselineBranch.branchId,
    context.repository,
    context.runner,
  );
  const result = await runPiDiagnosis({
    cwd,
    sourceRoot: resolve(cwd, "packages/mock-game/src"),
    runDir: context.repository.resolveRunDirectory(context.runId),
    provider,
    model,
    initialEvidenceId: context.initialEvidence.evidenceId,
    game,
    additionalInstructions:
      "The baseline uses deltaUs=16667. Test exactly one timing variable by forking the evidence checkpoint with frameRate=62.5 (equivalent to deltaUs=16000). Read mock-game-environment.ts and cite only returned artifact IDs.",
  });
  const report = await persistPiDiagnosis(
    context,
    result.report,
    result.piSession,
  );
  printJson({
    runId: context.runId,
    runDirectory: context.repository.resolveRunDirectory(context.runId),
    piSession: result.piSession,
    report,
  });
}

async function replayCommand(args: Arguments, cwd: string): Promise<void> {
  const branchId = asBranchId(requiredFlag(args, "branch"));
  const artifactRoot = resolve(
    cwd,
    flag(args, "artifacts", "CHRONORIFT_ARTIFACT_ROOT") ?? ".chronorift",
  );
  const repository = new JsonArtifactRepository(artifactRoot);
  const result = await createBranchRunner(repository).replayStrict(branchId);
  printJson(result);
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
  process.stdout.write(`ChronoRift\n\n`);
  process.stdout.write(`  pnpm demo [--artifacts PATH]\n`);
  process.stdout.write(
    `  pnpm diagnose -- --provider PROVIDER --model MODEL [--artifacts PATH]\n`,
  );
  process.stdout.write(`  pnpm models [-- --provider PROVIDER]\n`);
  process.stdout.write(`  pnpm auth:volcengine\n`);
  process.stdout.write(
    `  pnpm replay -- --branch BRANCH_ID [--artifacts PATH]\n`,
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(argv);
  const cwd = process.cwd();
  switch (args.command) {
    case "demo":
      await runDemo(cwd, flag(args, "artifacts", "CHRONORIFT_ARTIFACT_ROOT"));
      return;
    case "diagnose":
      await runDiagnosisCommand(args, cwd);
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
