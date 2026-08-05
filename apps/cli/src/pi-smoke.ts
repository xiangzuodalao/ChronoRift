import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runPiDiagnosis,
  type PiDiagnosisRunResult,
} from "@chronorift/pi-harness";

import {
  persistV01PiDiagnosis,
  type PersistedV01Diagnosis,
} from "./diagnosis.js";
import { ChronoRiftV01AgentGameApi } from "./v01-agent-game-api.js";
import { createV01MockRun } from "./v01-runtime.js";

export interface PiSmokeSummary {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: string;
  readonly sessionPersisted: true;
  readonly verdict: "confirmed";
  readonly toolCalls: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly total: number;
  };
  readonly cost: number;
}

export function createPiSmokeSummary(
  result: PiDiagnosisRunResult,
  persisted: PersistedV01Diagnosis,
  sessionPersisted: boolean,
): PiSmokeSummary {
  const { stats } = result.piSession;
  if (!sessionPersisted) {
    throw new Error("Pi smoke did not persist its Session");
  }
  if (stats.tokens.total <= 0) {
    throw new Error("Pi smoke completed without non-zero model tokens");
  }
  if (stats.toolCalls <= 0) {
    throw new Error("Pi smoke completed without an Agent tool call");
  }
  if (persisted.verdict.status !== "confirmed") {
    throw new Error(
      `Pi smoke Harness verdict is ${persisted.verdict.status}, expected confirmed`,
    );
  }
  return {
    schemaVersion: 1,
    ok: true,
    provider: result.piSession.provider,
    model: result.piSession.model,
    thinkingLevel: result.piSession.thinkingLevel,
    sessionPersisted: true,
    verdict: "confirmed",
    toolCalls: stats.toolCalls,
    tokens: { ...stats.tokens },
    cost: stats.cost,
  };
}

export interface RunPiSmokeOptions {
  readonly cwd: string;
  readonly provider: string;
  readonly model: string;
}

export async function runPiSmoke(
  options: RunPiSmokeOptions,
): Promise<PiSmokeSummary> {
  const artifactRoot = await mkdtemp(join(tmpdir(), "chronorift-pi-smoke-"));
  try {
    const context = await createV01MockRun({
      cwd: options.cwd,
      artifactRoot,
    });
    const game = new ChronoRiftV01AgentGameApi(
      context.runId,
      context.repository,
      context.gameBranch,
    );
    const result = await runPiDiagnosis({
      cwd: options.cwd,
      runDir: context.runDirectory,
      provider: options.provider,
      model: options.model,
      thinkingLevel: "medium",
      initialCapsuleId: context.evidenceCapsule.capsuleId,
      game,
    });
    const persisted = await persistV01PiDiagnosis(context, result.proposal);
    const sessionPersisted = (
      await stat(result.piSession.sessionFile)
    ).isFile();
    return createPiSmokeSummary(result, persisted, sessionPersisted);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
}
