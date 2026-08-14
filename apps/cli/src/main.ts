#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  asExecutionId,
  asTaskId,
  type DiagnosisProposal,
  type DiagnosisProposalV3,
  type DiagnosisVerdictV2,
  type V03ExecutionLog,
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
  V03BenchmarkJsonArtifactRepository,
  V03BenchmarkJsonArtifactRepositoryV3,
  VNextTaskStore,
} from "@chronorift/json-artifacts";
import {
  listAvailablePiModels,
  persistPiApiKey,
  runDeterministicPiDiagnosis,
  runDeterministicV03PiDiagnosis,
  runPiDiagnosis,
  runV03PiDiagnosis,
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
import { ChronoRiftV03AgentGameApi } from "./v03-agent-game-api.js";
import {
  runV03Benchmark,
  writeSanitizedV03BenchmarkReport,
} from "./v03-benchmark.js";
import {
  publishFormalBenchmark,
  verifyFormalBenchmarkReport,
} from "./v03-formal-publication.js";
import {
  publishFormalBenchmarkV3,
  verifyFormalBenchmarkReportV3,
} from "./v03-formal-publication-v3.js";
import {
  runFormalBenchmark,
  runFormalBenchmarkV3,
} from "./v03-formal-runtime.js";
import {
  buildFormalBenchmarkSuiteSpecV3,
  buildFormalBenchmarkSuiteSpecV2,
  parseFormalBenchmarkSuiteSpecV3,
  parseFormalBenchmarkSuiteSpecV2,
} from "./v03-formal-suite.js";
import {
  createV01GameBranchServiceForEnvironment,
  createV01MockRun,
  type V01MockRunContext,
} from "./v01-runtime.js";
import { createV03Run, type V03RunContext } from "./v03-runtime.js";
import { createV03NeutralSourceAccess } from "./v03-source-view.js";
import { runV04Diagnosis, type V04DiagnosisOutput } from "./v04-diagnosis.js";
import {
  assertCanaryC1Prerequisite,
  buildLunaCanarySpec,
  executeCanaryStage,
  parseCanaryStageReport,
  publishCanaryReport,
  readCanaryReport,
  readCanarySpec,
  type CanaryStage,
} from "./v03-canary.js";
import {
  LiveLunaCanaryRunner,
  createCanaryImplementationReceipt,
} from "./v03-canary-live.js";
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
import { runProjectEnvironmentPreviewV1 } from "./vnext/project-environment-preview.js";

interface Arguments {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string | true>;
  readonly positionals: readonly string[];
}

const booleanFlags = new Set(["json"]);

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
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
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

async function v03DiagnosisOutput(
  context: V03RunContext,
  result: Awaited<ReturnType<typeof runDeterministicV03PiDiagnosis>>,
): Promise<Readonly<Record<string, unknown>>> {
  const verdict = await context.gameBranch.concludeV3(
    result.proposal,
    result.accessReceipts,
  );
  return {
    schemaVersion: 3,
    fixture: context.preparedFixture.fixtureName,
    runId: context.runId,
    artifactRoot: context.artifactRoot,
    runDirectory: context.runDirectory,
    contract: context.contract,
    baselineBranch: context.baselineBranch,
    baselineExecution: context.baselineExecution,
    evidenceCapsule: context.evidenceCapsule,
    proposal: result.proposal,
    accessReceipts: result.accessReceipts,
    verdict,
    piSession: result.piSession,
  };
}

function printHumanV03Diagnosis(
  output: Readonly<Record<string, unknown>>,
): void {
  const proposal = output["proposal"] as DiagnosisProposalV3;
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
  const source = await createV03NeutralSourceAccess(context);
  const common = {
    cwd,
    runDir: context.runDirectory,
    arm: "chronorift-full" as const,
    initialCapsuleId: context.evidenceCapsule.capsuleId,
    baselineExecutionId: context.baselineExecution.executionId,
    game,
    source,
    failureBrief: context.failureBrief,
  };
  const result =
    mode === "deterministic"
      ? await runDeterministicV03PiDiagnosis(common)
      : await runV03PiDiagnosis({
          ...common,
          provider: requiredFlag(args, "provider", "CHRONORIFT_PI_PROVIDER"),
          model: requiredFlag(args, "model", "CHRONORIFT_PI_MODEL"),
          thinkingLevel: thinkingLevelFlag(args, DEFAULT_PI_THINKING_LEVEL),
        });
  const output = await v03DiagnosisOutput(context, result);
  if (hasFlag(args, "json")) printJson(output);
  else printHumanV03Diagnosis(output);
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
          thinkingLevel: thinkingLevelFlag(args, "low"),
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

const canaryArtifactRoot = (cwd: string): string => resolve(cwd, ".chronorift");

function canaryStageFlag(args: Arguments): CanaryStage {
  const stage = requiredFlag(args, "stage");
  if (stage !== "c0" && stage !== "c1") {
    throw new Error("--stage must be c0 or c1");
  }
  return stage;
}

async function buildCanarySpecCommand(
  args: Arguments,
  cwd: string,
): Promise<void> {
  assertOnlyFlags(args, ["id"]);
  printJson(
    buildLunaCanarySpec(
      flag(args, "id"),
      await createCanaryImplementationReceipt(cwd),
    ),
  );
}

async function runCanaryCommand(args: Arguments, cwd: string): Promise<void> {
  assertOnlyFlags(args, ["spec", "stage", "c0-report", "godot-bin"]);
  const stage = canaryStageFlag(args);
  const spec = await readCanarySpec(resolve(cwd, requiredFlag(args, "spec")));
  const prerequisitePath = flag(args, "c0-report");
  if (stage === "c1" && prerequisitePath === undefined) {
    throw new Error("--c0-report is required for C1");
  }
  if (stage === "c0" && prerequisitePath !== undefined) {
    throw new Error("--c0-report is only valid for C1");
  }
  const prerequisiteReport =
    prerequisitePath === undefined
      ? undefined
      : await readCanaryReport(resolve(cwd, prerequisitePath));
  const artifactRoot = canaryArtifactRoot(cwd);
  const report = await executeCanaryStage({
    cwd,
    artifactRoot,
    spec,
    stage,
    ...(prerequisiteReport === undefined ? {} : { prerequisiteReport }),
    runner: new LiveLunaCanaryRunner({
      cwd,
      artifactRoot,
      ...(flag(args, "godot-bin", "GODOT_BIN") === undefined
        ? {}
        : { godotBin: flag(args, "godot-bin", "GODOT_BIN") }),
    }),
  });
  printJson({
    canaryId: report.spec.canaryId,
    stage: report.stage,
    reportHash: report.reportHash,
    readiness: report.readiness,
  });
  if (report.readiness.status !== "ready") process.exitCode = 2;
}

async function publishCanaryCommand(
  args: Arguments,
  cwd: string,
): Promise<void> {
  assertOnlyFlags(args, ["spec", "stage", "output"]);
  const spec = await readCanarySpec(resolve(cwd, requiredFlag(args, "spec")));
  const stage = canaryStageFlag(args);
  const output =
    flag(args, "output") ??
    `.chronorift/v0.3/canary-publications/${encodeURIComponent(spec.canaryId)}/${stage}.report.json`;
  printJson({
    canaryId: spec.canaryId,
    stage,
    reportPath: await publishCanaryReport({
      cwd,
      artifactRoot: canaryArtifactRoot(cwd),
      canaryId: spec.canaryId,
      stage,
      outputPath: output,
    }),
  });
}

async function verifyCanaryCommand(
  args: Arguments,
  cwd: string,
): Promise<void> {
  assertOnlyFlags(args, ["report", "c0-report"]);
  const report = parseCanaryStageReport(
    await readCanaryReport(resolve(cwd, requiredFlag(args, "report"))),
  );
  const prerequisitePath = flag(args, "c0-report");
  if (report.stage === "c1" && prerequisitePath === undefined) {
    throw new Error("--c0-report is required to verify C1 linkage");
  }
  if (report.stage === "c0" && prerequisitePath !== undefined) {
    throw new Error("--c0-report is only valid when verifying C1");
  }
  let prerequisiteEligibility: "not_eligible" | "legacy_only" | "hardened" =
    report.readiness.status !== "ready"
      ? "not_eligible"
      : report.implementationReceipt === undefined
        ? "legacy_only"
        : "hardened";
  if (prerequisitePath !== undefined) {
    const prerequisite = await readCanaryReport(resolve(cwd, prerequisitePath));
    assertCanaryC1Prerequisite(
      report.spec,
      prerequisite,
      report.prerequisiteReportHash ?? undefined,
    );
    if (report.implementationReceipt === undefined) {
      if (report.readiness.status === "ready") {
        prerequisiteEligibility = "legacy_only";
      }
    } else {
      assertCanaryC1Prerequisite(
        report.spec,
        prerequisite,
        report.prerequisiteReportHash ?? undefined,
        report.implementationReceipt,
      );
      if (report.readiness.status === "ready") {
        prerequisiteEligibility = "hardened";
      }
    }
  }
  printJson({
    canaryId: report.spec.canaryId,
    stage: report.stage,
    reportHash: report.reportHash,
    readiness: report.readiness,
    prerequisiteEligibility,
  });
  if (report.readiness.status !== "ready") process.exitCode = 2;
}

const formalSpecPath = (args: Arguments, cwd: string): string =>
  resolve(
    cwd,
    flag(args, "spec") ?? "docs/benchmarks/v0.3/benchmark-spec.v2.json",
  );

const formalArtifactRoot = (cwd: string): string => resolve(cwd, ".chronorift");

function formalSchemaVersion(input: unknown, label: string): 2 | 3 {
  if (input === null || Array.isArray(input) || typeof input !== "object") {
    throw new Error(`${label} is not an object`);
  }
  const version = (input as Readonly<Record<string, unknown>>)["schemaVersion"];
  if (version !== 2 && version !== 3) {
    throw new Error(`${label} has an unsupported schemaVersion`);
  }
  return version;
}

async function readFormalJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
}

async function runFormalBenchmarkCommand(
  args: Arguments,
  cwd: string,
): Promise<void> {
  assertOnlyFlags(args, ["spec", "resume", "godot-bin"]);
  const specPath = formalSpecPath(args, cwd);
  const version = formalSchemaVersion(
    await readFormalJson(specPath),
    "Formal benchmark specification",
  );
  const commonOptions = {
    cwd,
    specPath,
    artifactRoot: formalArtifactRoot(cwd),
    ...(flag(args, "godot-bin", "GODOT_BIN") === undefined
      ? {}
      : { godotBin: flag(args, "godot-bin", "GODOT_BIN") }),
    ...(flag(args, "resume") === undefined
      ? {}
      : { resumeExecutionId: flag(args, "resume") }),
    onExecutionSelected: (executionId: string) => {
      process.stderr.write(
        `${JSON.stringify({ executionId, status: "execution_identified" })}\n`,
      );
    },
  };
  const result =
    version === 3
      ? await runFormalBenchmarkV3(commonOptions)
      : await runFormalBenchmark(commonOptions);
  printJson({
    executionId: result.report.executionId,
    status: result.report.status,
    recoverable: result.recoverable,
    reportHash: result.report.reportHash,
  });
  if (result.recoverable || result.report.status === "incomplete") {
    process.exitCode = 2;
  } else if (result.report.status === "invalid") {
    process.exitCode = 1;
  }
}

async function buildFormalSpecCommand(
  args: Arguments,
  cwd: string,
): Promise<void> {
  assertOnlyFlags(args, ["artifacts", "campaign", "godot-bin"]);
  const campaign = flag(args, "campaign");
  if (
    campaign !== undefined &&
    campaign !== "v0.3.1" &&
    campaign !== "v0.3.1-r2" &&
    campaign !== "v0.3.2-luna" &&
    campaign !== "v0.3.2-luna-r1" &&
    campaign !== "v0.3.2-luna-r2" &&
    campaign !== "v0.3.2-luna-r3" &&
    campaign !== "v0.3.2-luna-r4"
  ) {
    throw new Error(`Unsupported benchmark campaign: ${campaign}`);
  }
  const commonOptions = {
    cwd,
    artifactRoot: resolve(
      cwd,
      flag(args, "artifacts") ?? ".chronorift/formal-spec-build",
    ),
    ...(flag(args, "godot-bin", "GODOT_BIN") === undefined
      ? {}
      : { godotBin: flag(args, "godot-bin", "GODOT_BIN") }),
  };
  printJson(
    campaign === "v0.3.2-luna" ||
      campaign === "v0.3.2-luna-r1" ||
      campaign === "v0.3.2-luna-r2" ||
      campaign === "v0.3.2-luna-r3" ||
      campaign === "v0.3.2-luna-r4"
      ? await buildFormalBenchmarkSuiteSpecV3({
          ...commonOptions,
          campaign,
        })
      : await buildFormalBenchmarkSuiteSpecV2({
          ...commonOptions,
          ...(campaign === undefined ? {} : { campaign }),
        }),
  );
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

async function formalBenchmarkStatusCommand(
  args: Arguments,
  cwd: string,
): Promise<void> {
  assertOnlyFlags(args, ["spec"]);
  const specInput = await readFormalJson(formalSpecPath(args, cwd));
  const version = formalSchemaVersion(
    specInput,
    "Formal benchmark specification",
  );
  const suite =
    version === 3
      ? parseFormalBenchmarkSuiteSpecV3(specInput)
      : parseFormalBenchmarkSuiteSpecV2(specInput);
  const v3Repository =
    version === 3
      ? new V03BenchmarkJsonArtifactRepositoryV3(formalArtifactRoot(cwd))
      : null;
  const v2Repository =
    version === 2
      ? new V03BenchmarkJsonArtifactRepository(formalArtifactRoot(cwd))
      : null;
  const selection =
    version === 3
      ? await v3Repository?.getExecutionSelectionV3(suite.definitionId)
      : await v2Repository?.getExecutionSelection(suite.definitionId);
  if (selection === null) {
    printJson({
      definitionId: suite.definitionId,
      selected: false,
      executionId: null,
    });
    return;
  }
  if (selection === undefined) {
    throw new Error("Formal benchmark repository dispatch failed");
  }
  const [started, completed] =
    version === 3
      ? await Promise.all([
          v3Repository?.getExecutionStartedV3(
            suite.definitionId,
            selection.executionId,
          ),
          v3Repository?.getCompletedV3(
            suite.definitionId,
            selection.executionId,
          ),
        ])
      : await Promise.all([
          v2Repository?.getExecutionStarted(
            suite.definitionId,
            selection.executionId,
          ),
          v2Repository?.getCompleted(suite.definitionId, selection.executionId),
        ]);
  printJson({
    definitionId: suite.definitionId,
    selected: true,
    executionId: selection.executionId,
    selectionHash: selection.selectionHash,
    started: started !== null && started !== undefined,
    status: completed?.status ?? (started === null ? "selected" : "running"),
    reportHash: completed?.reportHash ?? null,
  });
}

async function publishFormalBenchmarkCommand(
  args: Arguments,
  cwd: string,
): Promise<void> {
  assertOnlyFlags(args, ["spec", "execution", "output"]);
  const specPath = formalSpecPath(args, cwd);
  const version = formalSchemaVersion(
    await readFormalJson(specPath),
    "Formal benchmark specification",
  );
  const options = {
    cwd,
    artifactRoot: formalArtifactRoot(cwd),
    specPath,
    executionId: requiredFlag(args, "execution"),
    outputDirectory: resolve(cwd, requiredFlag(args, "output")),
  };
  const files =
    version === 3
      ? await publishFormalBenchmarkV3(options)
      : await publishFormalBenchmark(options);
  printJson({ published: true, files });
}

async function verifyFormalBenchmarkCommand(
  args: Arguments,
  cwd: string,
): Promise<void> {
  assertOnlyFlags(args, ["spec", "report"]);
  const path = resolve(cwd, requiredFlag(args, "report"));
  const specPath = formalSpecPath(args, cwd);
  const specVersion = formalSchemaVersion(
    await readFormalJson(specPath),
    "Formal benchmark specification",
  );
  const options = {
    reportPath: path,
    specPath,
  };
  const verification =
    specVersion === 3
      ? await verifyFormalBenchmarkReportV3(options)
      : await verifyFormalBenchmarkReport(options);
  printJson({
    verified: verification.valid,
    reportPath: path,
    gate: verification.gate,
    issues: verification.issues,
  });
  if (!verification.valid) process.exitCode = 1;
}

async function gateFormalBenchmarkCommand(
  args: Arguments,
  cwd: string,
): Promise<void> {
  assertOnlyFlags(args, ["spec", "report"]);
  const path = resolve(cwd, requiredFlag(args, "report"));
  const specPath = formalSpecPath(args, cwd);
  const specVersion = formalSchemaVersion(
    await readFormalJson(specPath),
    "Formal benchmark specification",
  );
  const options = {
    reportPath: path,
    specPath,
  };
  const verification =
    specVersion === 3
      ? await verifyFormalBenchmarkReportV3(options)
      : await verifyFormalBenchmarkReport(options);
  printJson({
    verified: verification.valid,
    reportPath: path,
    gate: verification.gate,
    issues: verification.issues,
  });
  process.exitCode = verification.valid
    ? verification.gate.status === "pass"
      ? 0
      : 2
    : 1;
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
    const failureMessage =
      rawMessage
        .replace(/[\r\n\0]/gu, " ")
        .trim()
        .slice(0, 4_096) || "Project Environment Preview failed";
    const failure = {
      schemaVersion: 1 as const,
      status: "failed" as const,
      goalDelivered: false as const,
      failureCode: "project_preview_failed" as const,
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

function printHelp(): void {
  process.stdout.write(`ChronoRift v0.4.0\n\n`);
  process.stdout.write(
    `  pnpm project preview -- [GOAL] --provider PROVIDER --model MODEL [--thinking LEVEL --host-config PATH]\n`,
  );
  process.stdout.write(
    `  Project Environment Preview requires a clean repository-root Godot 4.7.1 GDScript project and an explicit Host registry config. It remains separate from the default entry point.\n\n`,
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
    `  pnpm demo:v03 -- --fixture FIXTURE [--godot-bin PATH] [--json]\n`,
  );
  process.stdout.write(
    `  pnpm diagnose:v03 -- --fixture FIXTURE --provider PROVIDER --model MODEL [--thinking LEVEL] [--json]\n`,
  );
  process.stdout.write(
    `  pnpm demo:v04 -- --fixture FIXTURE [--godot-bin PATH] [--json]\n`,
  );
  process.stdout.write(
    `  pnpm diagnose:v04 -- --fixture FIXTURE --provider PROVIDER --model MODEL [--thinking LEVEL] [--timeout-ms MS] [--json]\n`,
  );
  process.stdout.write(
    `  pnpm benchmark [-- --repetitions N --seed SEED --report PATH]\n`,
  );
  process.stdout.write(
    `  pnpm benchmark:explore -- --provider PROVIDER --model MODEL [--thinking LEVEL --repetitions 3 --report PATH]\n`,
  );
  process.stdout.write(`  pnpm benchmark:canary:spec [-- --id CANARY_ID]\n`);
  process.stdout.write(
    `  pnpm benchmark:canary -- --spec PATH --stage c0|c1 [--c0-report PATH] [--godot-bin PATH]\n`,
  );
  process.stdout.write(
    `  pnpm benchmark:canary:publish -- --spec PATH --stage c0|c1 [--output PATH]\n`,
  );
  process.stdout.write(
    `  pnpm benchmark:canary:verify -- --report PATH [--c0-report PATH]\n`,
  );
  process.stdout.write(
    `  pnpm benchmark:formal -- --spec PATH [--resume EXECUTION_ID]\n`,
  );
  process.stdout.write(
    `  pnpm benchmark:spec [-- --campaign v0.3.1|v0.3.1-r2|v0.3.2-luna|v0.3.2-luna-r1|v0.3.2-luna-r2|v0.3.2-luna-r3|v0.3.2-luna-r4 --godot-bin PATH]\n`,
  );
  process.stdout.write(`  pnpm benchmark:status [-- --spec PATH]\n`);
  process.stdout.write(
    `  pnpm benchmark:publish -- --spec PATH --execution EXECUTION_ID --output DIR\n`,
  );
  process.stdout.write(
    `  pnpm benchmark:verify -- --spec PATH --report PATH\n`,
  );
  process.stdout.write(`  pnpm benchmark:gate -- --spec PATH --report PATH\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(argv);
  const cwd = process.cwd();
  switch (args.command) {
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
    case "demo-v03":
      await runV03DiagnosisCommand(args, cwd, "deterministic");
      return;
    case "diagnose-v03":
      await runV03DiagnosisCommand(args, cwd, "live");
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
    case "benchmark":
      await runBenchmarkCommand(args, cwd, "deterministic");
      return;
    case "benchmark-live":
    case "benchmark-explore":
      await runBenchmarkCommand(args, cwd, "live");
      return;
    case "benchmark-canary-spec":
      await buildCanarySpecCommand(args, cwd);
      return;
    case "benchmark-canary":
      await runCanaryCommand(args, cwd);
      return;
    case "benchmark-canary-publish":
      await publishCanaryCommand(args, cwd);
      return;
    case "benchmark-canary-verify":
      await verifyCanaryCommand(args, cwd);
      return;
    case "benchmark-formal":
      await runFormalBenchmarkCommand(args, cwd);
      return;
    case "benchmark-spec":
      await buildFormalSpecCommand(args, cwd);
      return;
    case "benchmark-status":
      await formalBenchmarkStatusCommand(args, cwd);
      return;
    case "benchmark-publish":
      await publishFormalBenchmarkCommand(args, cwd);
      return;
    case "benchmark-verify":
      await verifyFormalBenchmarkCommand(args, cwd);
      return;
    case "benchmark-gate":
      await gateFormalBenchmarkCommand(args, cwd);
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
