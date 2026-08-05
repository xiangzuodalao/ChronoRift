import {
  PiHarnessError,
  PiProviderFailureError,
  assertPiModelCapabilities,
  runV03PiDiagnosis,
  type V03PiProgressSnapshotV3,
} from "@chronorift/pi-harness";

import { ChronoRiftV03AgentGameApi } from "./v03-agent-game-api.js";
import {
  CanaryCellError,
  type BenchmarkV3CanaryCellRunnerPort,
  type CanaryFailureCode,
  type CanaryFailureKind,
  type CanaryImplementationReceiptV2,
  type CanaryProgressSummaryV2,
  type CanaryProviderFailureV2,
  type CanaryScoredCellResultV1,
  type LunaCanarySpecV1,
  type RunCanaryCellInput,
} from "./v03-canary.js";
import { createV03Run } from "./v03-runtime.js";
import { createV03NeutralSourceAccess } from "./v03-source-view.js";

const expectedMechanism = (
  fixture: RunCanaryCellInput["fixture"],
): "signal_before_receiver_connection" | "discrete_physics_tunneling" =>
  fixture === "signal-ordering"
    ? "signal_before_receiver_connection"
    : "discrete_physics_tunneling";

function providerFailureInChain(
  error: unknown,
): PiProviderFailureError | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof PiProviderFailureError) return current;
    current = current.cause;
  }
  return undefined;
}

export function classifyCanaryLiveFailure(error: unknown): CanaryFailureCode {
  return classifyCanaryLiveFailureDetails(error, emptyProgress()).code;
}

export interface ClassifiedCanaryLiveFailure {
  readonly kind: CanaryFailureKind;
  readonly code: CanaryFailureCode;
  readonly providerFailure: CanaryProviderFailureV2 | null;
}

const hasDiagnosticProgress = (progress: CanaryProgressSummaryV2): boolean =>
  progress.model.outputObserved ||
  progress.tools.started > 0 ||
  progress.game.diagnosticExecutions > 0 ||
  progress.proposalSubmitted;

export function classifyCanaryLiveFailureDetails(
  error: unknown,
  progress: CanaryProgressSummaryV2,
): ClassifiedCanaryLiveFailure {
  const providerFailure = providerFailureInChain(error);
  if (providerFailure !== undefined) {
    return {
      kind:
        providerFailure.retryClass === "permanent"
          ? "invalid"
          : "infrastructure",
      code: providerFailure.code,
      providerFailure: {
        phase: providerFailure.phase,
        code: providerFailure.code,
        httpStatus: providerFailure.httpStatus,
        retryClass: providerFailure.retryClass,
      },
    };
  }
  if (!(error instanceof PiHarnessError)) {
    return {
      kind: "invalid",
      code: "unknown_failure",
      providerFailure: null,
    };
  }
  switch (error.code) {
    case "INVALID_TOOL_FLOW":
    case "INVALID_ARGUMENT":
    case "SOURCE_NOT_FOUND":
    case "SOURCE_NOT_TEXT":
    case "SOURCE_OUT_OF_BOUNDS":
      return {
        kind: "diagnostic",
        code: "invalid_tool_flow",
        providerFailure: null,
      };
    case "INVALID_DIAGNOSIS":
      return {
        kind: "diagnostic",
        code: "invalid_proposal",
        providerFailure: null,
      };
    case "AGENT_TIMEOUT":
      return hasDiagnosticProgress(progress)
        ? {
            kind: "diagnostic",
            code: "progress_timeout",
            providerFailure: null,
          }
        : {
            kind: "infrastructure",
            code: "timeout",
            providerFailure: null,
          };
    case "PROPOSAL_MISSING":
      return {
        kind: "diagnostic",
        code: "proposal_missing",
        providerFailure: null,
      };
    case "AGENT_BUDGET_EXHAUSTED":
      return {
        kind: "diagnostic",
        code: "budget_exhausted",
        providerFailure: null,
      };
    case "MODEL_NOT_FOUND":
    case "MODEL_UNAVAILABLE":
    case "MODEL_CONFIGURATION":
    case "AUTH_FAILED":
      return {
        kind: "invalid",
        code: "model_configuration",
        providerFailure: null,
      };
    case "AGENT_FAILED":
      return {
        kind: "invalid",
        code: "agent_failed",
        providerFailure: null,
      };
    case "INVALID_GAME_RESULT":
      return {
        kind: "invalid",
        code: "harness_failure",
        providerFailure: null,
      };
  }
}

const emptyProgress = (): CanaryProgressSummaryV2 => ({
  sequence: 0,
  fixtureValidated: false,
  model: {
    requestStarted: false,
    outputObserved: false,
    turnCompleted: false,
  },
  tools: {
    started: 0,
    completed: 0,
    failed: 0,
    semanticRevision: 0,
    consecutiveNonProgressToolResults: 0,
  },
  game: { baselineExecutions: 0, diagnosticExecutions: 0 },
  proposalSubmitted: false,
});

const progressSummary = (
  snapshot: V03PiProgressSnapshotV3,
): CanaryProgressSummaryV2 => ({
  sequence: snapshot.sequence,
  fixtureValidated: snapshot.fixtureStage === "fixture_validated",
  model: {
    requestStarted: snapshot.model.requestStarted,
    outputObserved: snapshot.model.outputObserved,
    turnCompleted: snapshot.model.turnCompleted,
  },
  tools: {
    started: snapshot.tools.started,
    completed: snapshot.tools.completed,
    failed: snapshot.tools.failed,
    semanticRevision: snapshot.tools.semanticRevision,
    consecutiveNonProgressToolResults:
      snapshot.tools.consecutiveNonProgressToolResults,
  },
  game: {
    baselineExecutions: snapshot.game.baselineExecutions,
    diagnosticExecutions: snapshot.game.diagnosticExecutions,
  },
  proposalSubmitted: snapshot.proposalSubmitted,
});

const IMPLEMENTATION_ROOTS = [
  "apps/cli/src",
  "packages/domain/src",
  "packages/gamebranch/src",
  "packages/godot-adapter/src",
  "packages/godot-protocol/src",
  "packages/json-artifacts/src",
  "packages/mock-game/src",
  "packages/pi-harness/src",
  "godot/addons/chronorift",
  "fixtures",
] as const;

const IMPLEMENTATION_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  "apps/cli/package.json",
  "apps/cli/tsconfig.json",
  "packages/domain/package.json",
  "packages/domain/tsconfig.json",
  "packages/gamebranch/package.json",
  "packages/gamebranch/tsconfig.json",
  "packages/godot-adapter/package.json",
  "packages/godot-adapter/tsconfig.json",
  "packages/godot-protocol/package.json",
  "packages/godot-protocol/tsconfig.json",
  "packages/json-artifacts/package.json",
  "packages/json-artifacts/tsconfig.json",
  "packages/mock-game/package.json",
  "packages/mock-game/tsconfig.json",
  "packages/pi-harness/package.json",
  "packages/pi-harness/tsconfig.json",
] as const;

const execGit = (cwd: string, args: readonly string[]): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        reject(
          new Error("Could not resolve canary Git provenance", {
            cause: error,
          }),
        );
        return;
      }
      resolvePromise(stdout);
    });
  });

const isRuntimeSource = (path: string): boolean =>
  !path.endsWith(".test.ts") &&
  !path.endsWith(".live.test.ts") &&
  !path.includes(`${sep}dist${sep}`) &&
  !path.endsWith(".tsbuildinfo");

async function collectImplementationFiles(
  cwd: string,
  input: string,
): Promise<readonly string[]> {
  const root = resolve(cwd);
  const path = resolve(root, input);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Canary implementation path escapes the workspace");
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error("Canary implementation source cannot be a symlink");
  }
  if (metadata.isFile()) return isRuntimeSource(path) ? [path] : [];
  if (!metadata.isDirectory()) return [];
  const output: string[] = [];
  for (const entry of (await readdir(path)).sort()) {
    output.push(...(await collectImplementationFiles(root, join(rel, entry))));
  }
  return output;
}

export async function createCanaryImplementationReceipt(
  cwd: string,
): Promise<CanaryImplementationReceiptV2> {
  const root = resolve(cwd);
  const files = (
    await Promise.all(
      [...IMPLEMENTATION_ROOTS, ...IMPLEMENTATION_FILES].map((path) =>
        collectImplementationFiles(root, path),
      ),
    )
  )
    .flat()
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    throw new Error("Canary implementation receipt has no source files");
  }
  const hash = createHash("sha256");
  for (const path of files) {
    const name = relative(root, path).split(sep).join("/");
    const content = await readFile(path);
    hash.update(`${Buffer.byteLength(name, "utf8")}:`);
    hash.update(name, "utf8");
    hash.update(`${content.byteLength}:`);
    hash.update(content);
  }
  const gitCommit = (await execGit(root, ["rev-parse", "HEAD"])).trim();
  const status = await execGit(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...IMPLEMENTATION_ROOTS,
    ...IMPLEMENTATION_FILES,
  ]);
  return {
    gitCommit,
    sourceHash: hash.digest("hex"),
    sourceFileCount: files.length,
    sourceWorktreeDirty: status.trim().length > 0,
  };
}

export interface CreateLiveLunaCanaryRunnerOptions {
  readonly cwd: string;
  readonly artifactRoot: string;
  readonly godotBin?: string | undefined;
}

/**
 * Temporary v0.3 adapter for the CLI canary seam. The planned Benchmark V3
 * adapter can replace this class without changing spec, ledger, or readiness.
 */
export class LiveLunaCanaryRunner implements BenchmarkV3CanaryCellRunnerPort {
  public constructor(
    private readonly options: CreateLiveLunaCanaryRunnerOptions,
  ) {}

  public implementationReceipt(): Promise<CanaryImplementationReceiptV2> {
    return createCanaryImplementationReceipt(this.options.cwd);
  }

  public async preflight(spec: LunaCanarySpecV1) {
    const model = await assertPiModelCapabilities({
      provider: spec.model.provider,
      model: spec.model.model,
      contextWindow: spec.model.contextWindow,
      maxTokens: spec.model.maxTokens,
      thinkingLevel: spec.model.thinkingLevel,
      mappedThinkingValue: spec.model.mappedThinkingValue,
    });
    return {
      provider: model.provider,
      model: model.model,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      mappedThinkingValue:
        model.thinkingLevelMap[spec.model.thinkingLevel] ?? null,
    };
  }

  public async runCell(
    input: RunCanaryCellInput,
  ): Promise<CanaryScoredCellResultV1> {
    const started = Date.now();
    let game: ChronoRiftV03AgentGameApi | undefined;
    let sessionPersisted = false;
    let proposalPresent = false;
    let lastProgress = emptyProgress();
    let lastTokens = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    };
    let maxToolErrors = 0;
    let maxConsecutiveNonProgressToolResults = 0;
    const observedMetrics = () => ({
      gameExecutions: game?.gameExecutions ?? 0,
      toolCalls: lastProgress.tools.started,
      toolErrors: maxToolErrors,
      maxConsecutiveNonProgressToolResults,
      wallTimeMs: Math.max(0, Date.now() - started),
      tokens: lastTokens,
    });
    try {
      const context = await createV03Run({
        cwd: this.options.cwd,
        fixture: input.fixture,
        artifactRoot: this.options.artifactRoot,
        ...(this.options.godotBin === undefined
          ? {}
          : { godotBin: this.options.godotBin }),
      });
      game = new ChronoRiftV03AgentGameApi(context);
      lastProgress = {
        ...lastProgress,
        fixtureValidated: true,
        game: {
          baselineExecutions: game.baselineExecutions,
          diagnosticExecutions: game.diagnosticExecutions,
        },
      };
      const source = await createV03NeutralSourceAccess(context);
      const diagnosis = await runV03PiDiagnosis({
        cwd: this.options.cwd,
        runDir: context.runDirectory,
        arm: input.arm,
        initialCapsuleId: context.evidenceCapsule.capsuleId,
        baselineExecutionId: context.baselineExecution.executionId,
        failureBrief: context.failureBrief,
        game,
        source,
        provider: input.spec.model.provider,
        model: input.spec.model.model,
        thinkingLevel: input.spec.model.thinkingLevel,
        timeoutMs: input.spec.budgets.timeoutMs,
        sdkRetry: false,
        onProgressV3: (snapshot) => {
          lastProgress = progressSummary(snapshot);
          lastTokens = snapshot.model.tokens;
          maxToolErrors = Math.max(maxToolErrors, snapshot.tools.failed);
          maxConsecutiveNonProgressToolResults = Math.max(
            maxConsecutiveNonProgressToolResults,
            snapshot.tools.consecutiveNonProgressToolResults,
          );
          return Promise.resolve();
        },
      });
      sessionPersisted = true;
      proposalPresent = true;
      lastProgress = {
        ...lastProgress,
        model: { ...lastProgress.model, turnCompleted: true },
        proposalSubmitted: true,
      };
      if (
        diagnosis.piSession.modelMetadata.contextWindow !==
          input.spec.model.contextWindow ||
        diagnosis.piSession.modelMetadata.maxTokens !==
          input.spec.model.maxTokens ||
        diagnosis.piSession.modelMetadata.mappedThinkingValue !==
          input.spec.model.mappedThinkingValue
      ) {
        throw new CanaryCellError("model_configuration", {
          kind: "invalid",
          sessionPersisted,
          proposalPresent,
          progress: lastProgress,
          metrics: {
            ...observedMetrics(),
            toolCalls: diagnosis.piSession.stats.toolCalls,
            tokens: diagnosis.piSession.stats.tokens,
          },
        });
      }
      const verdict = await context.gameBranch.concludeV3(
        diagnosis.proposal,
        diagnosis.accessReceipts,
      );
      const receipts = diagnosis.accessReceipts;
      const receiptCount = (...kinds: readonly string[]): number =>
        receipts.filter((receipt) => kinds.includes(receipt.accessKind)).length;
      let matchingReplay = false;
      if (diagnosis.proposal.replayExecutionId !== undefined) {
        const replay = await context.repository.getExecution(
          diagnosis.proposal.replayExecutionId,
        );
        matchingReplay =
          replay.timelineDigest === context.baselineExecution.timelineDigest;
      }
      return {
        sessionPersisted: true,
        verdict: verdict.status,
        mechanismCorrect:
          diagnosis.proposal.mechanismCode === expectedMechanism(input.fixture),
        flow: {
          evidenceReceiptCount: receiptCount(
            "failure_brief",
            "raw_execution",
            "capsule",
          ),
          rawExecutionReceiptCount: receiptCount("raw_execution"),
          capsuleReceiptCount: receiptCount("capsule"),
          sourceReceiptCount: receiptCount("source_read", "source_search"),
          replayReceiptCount: receiptCount("replay"),
          experimentReceiptCount: receiptCount("experiment"),
          comparisonReceiptCount: receiptCount("comparison"),
          matchingReplay,
          interventionCount: diagnosis.proposal.candidateExecutionIds.length,
          comparisonCount: diagnosis.proposal.comparisonIds.length,
        },
        progress: {
          ...lastProgress,
          model: { ...lastProgress.model, turnCompleted: true },
          proposalSubmitted: true,
        },
        metrics: {
          gameExecutions: game.gameExecutions,
          toolCalls: diagnosis.piSession.stats.toolCalls,
          toolErrors: maxToolErrors,
          maxConsecutiveNonProgressToolResults,
          wallTimeMs: diagnosis.wallTimeMs,
          tokens: diagnosis.piSession.stats.tokens,
        },
      };
    } catch (error) {
      if (error instanceof CanaryCellError) throw error;
      const classified = classifyCanaryLiveFailureDetails(error, lastProgress);
      throw new CanaryCellError(classified.code, {
        kind: classified.kind,
        providerFailure: classified.providerFailure,
        sessionPersisted,
        proposalPresent: proposalPresent || lastProgress.proposalSubmitted,
        progress: lastProgress,
        metrics: observedMetrics(),
      });
    }
  }
}
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
