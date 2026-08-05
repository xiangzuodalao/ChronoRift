import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { runPiDiagnosis } from "@chronorift/pi-harness";

import { persistV01PiDiagnosis } from "./diagnosis.js";
import { ChronoRiftV01AgentGameApi } from "./v01-agent-game-api.js";
import { createV01MockRun } from "./v01-runtime.js";

const DEFAULT_PI_PROVIDER = "volcengine-coding-plan";
const DEFAULT_PI_MODEL = "glm-5.2";

function environmentOrDefault(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

let artifactRoot: string | undefined;

afterEach(async () => {
  if (artifactRoot !== undefined) {
    await rm(artifactRoot, { recursive: true, force: true });
    artifactRoot = undefined;
  }
});

test("real Pi proposes a reference-valid switch-door diagnosis", async () => {
  const provider = environmentOrDefault(
    "CHRONORIFT_PI_PROVIDER",
    DEFAULT_PI_PROVIDER,
  );
  const model = environmentOrDefault("CHRONORIFT_PI_MODEL", DEFAULT_PI_MODEL);
  const cwd = process.cwd();
  artifactRoot = await mkdtemp(join(tmpdir(), "chronorift-live-"));
  const context = await createV01MockRun({ cwd, artifactRoot });
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
    thinkingLevel: "medium",
    initialCapsuleId: context.evidenceCapsule.capsuleId,
    game,
  });
  const diagnosis = await persistV01PiDiagnosis(context, result.proposal);

  expect(result.proposal.capsuleId).toBe(context.evidenceCapsule.capsuleId);
  expect(result.proposal.baselineExecutionId).toBe(
    context.baselineExecution.executionId,
  );
  expect(result.proposal.replayExecutionId).toBeDefined();
  expect(result.proposal.candidateExecutionId).toBeDefined();
  expect(result.proposal.comparisonId).toBeDefined();
  expect(diagnosis.verdict.status).toBe("confirmed");
  expect(result.piSession.provider).toBe(provider);
  expect(result.piSession.model).toBe(model);
  expect(result.piSession.stats.tokens.total).toBeGreaterThan(0);
  expect(result.piSession.stats.toolCalls).toBeGreaterThan(0);
  expect((await stat(result.piSession.sessionFile)).isFile()).toBe(true);
});
