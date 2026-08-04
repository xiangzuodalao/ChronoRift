import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, test } from "vitest";

import { runPiDiagnosis } from "@chronorift/pi-harness";

import { ChronoRiftAgentGameApi } from "./agent-game-api.js";
import { persistPiDiagnosis } from "./diagnosis.js";
import { createMockRun } from "./runtime.js";

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

test("real Pi diagnoses the persisted Mock Game timing bug", async () => {
  const provider = environmentOrDefault(
    "CHRONORIFT_PI_PROVIDER",
    DEFAULT_PI_PROVIDER,
  );
  const model = environmentOrDefault("CHRONORIFT_PI_MODEL", DEFAULT_PI_MODEL);
  const cwd = process.cwd();
  artifactRoot = await mkdtemp(join(tmpdir(), "chronorift-live-"));
  const context = await createMockRun({
    cwd,
    artifactRoot,
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
    thinkingLevel: "medium",
    initialEvidenceId: context.initialEvidence.evidenceId,
    game,
    additionalInstructions:
      "The baseline uses deltaUs=16667. Fork exactly one timing control with frameRate=62.5 (deltaUs=16000), replay it, compare it with the baseline, inspect mock-game-environment.ts, and submit only returned IDs.",
  });
  const report = await persistPiDiagnosis(
    context,
    result.report,
    result.piSession,
  );

  expect(report.evidenceIds).toContain(context.initialEvidence.evidenceId);
  expect(report.branchComparisons.length).toBeGreaterThan(0);
  expect(report.branchComparisons[0]?.changedControls).toContainEqual({
    name: "deltaUs",
    before: 16_667,
    after: 16_000,
  });
  expect(result.piSession.provider).toBe(provider);
  expect(result.piSession.model).toBe(model);
  expect((await stat(result.piSession.sessionFile)).isFile()).toBe(true);

  const manifest = await context.repository.getManifest(context.runId);
  expect(manifest.model).toEqual({
    piSessionId: result.piSession.sessionId,
    provider,
    model,
  });
  expect(manifest.diagnosisReportId).toBe(report.reportId);
});
