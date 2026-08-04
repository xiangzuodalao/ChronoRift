import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runDeterministicPiDiagnosis } from "@chronorift/pi-harness";

import { persistV01PiDiagnosis } from "./diagnosis.js";
import { ChronoRiftV01AgentGameApi } from "./v01-agent-game-api.js";
import { createV01MockRun } from "./v01-runtime.js";

describe("ChronoRift v0.1 composition", () => {
  it("runs the full real Pi/faux-model experiment and Gate offline", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "chronorift-v01-e2e-"));
    const context = await createV01MockRun({
      cwd: process.cwd(),
      artifactRoot,
    });
    const game = new ChronoRiftV01AgentGameApi(
      context.runId,
      context.repository,
      context.gameBranch,
    );

    const result = await runDeterministicPiDiagnosis({
      cwd: process.cwd(),
      runDir: context.runDirectory,
      initialCapsuleId: context.evidenceCapsule.capsuleId,
      game,
    });
    const diagnosis = await persistV01PiDiagnosis(context, result.proposal);

    expect(context.baselineExecution).toMatchObject({
      status: "completed",
      evaluation: { status: "fail" },
    });
    const replayId = result.proposal.replayExecutionId;
    const candidateId = result.proposal.candidateExecutionId;
    const comparisonId = result.proposal.comparisonId;
    expect(replayId).toBeDefined();
    expect(candidateId).toBeDefined();
    expect(comparisonId).toBeDefined();
    if (
      replayId === undefined ||
      candidateId === undefined ||
      comparisonId === undefined
    ) {
      throw new Error(
        "Deterministic Pi omitted required experiment references",
      );
    }
    await expect(
      context.repository.getExecutionLog(replayId),
    ).resolves.toMatchObject({
      status: "completed",
      evaluation: { status: "fail" },
    });
    await expect(
      context.repository.getExecutionLog(candidateId),
    ).resolves.toMatchObject({
      status: "completed",
      evaluation: { status: "pass" },
    });
    await expect(
      context.repository.getExecutionComparison(comparisonId),
    ).resolves.toMatchObject({
      comparable: true,
      baselineOutcome: "fail",
      candidateOutcome: "pass",
      intervention: { kind: "delay_input", deltaTicks: 1 },
    });
    expect(diagnosis.verdict.status).toBe("confirmed");
    expect(result.proposal.confidence).toBe(0);

    const sessionText = await readFile(result.piSession.sessionFile, "utf8");
    expect(sessionText).toContain("game_get_evidence_capsule");
    expect(sessionText).toContain("submit_diagnosis_proposal");
    expect(sessionText).not.toContain('"toolName":"bash"');
  }, 15_000);
});
