import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonArtifactRepository } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import { ChronoRiftAgentGameApi } from "./agent-game-api.js";
import { createMockRun } from "./runtime.js";

describe("ChronoRift composition", () => {
  it("persists evidence and exposes branch/replay/compare through the Agent port", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "chronorift-e2e-"));
    const context = await createMockRun({ cwd });
    const game = new ChronoRiftAgentGameApi(
      context.runId,
      context.baselineBranch.branchId,
      context.repository,
      context.runner,
    );

    const evidence = await game.getEvidence(context.initialEvidence.evidenceId);
    expect(evidence?.details["stateDiff"]).toBeDefined();
    const baseline = await game.replayTimeline({
      branchId: context.baselineBranch.branchId,
    });
    expect(baseline.outcome).toBe("fail");
    await expect(
      game.forkTimeline({
        checkpointId: context.initialEvidence.checkpointId,
        controls: {},
      }),
    ).rejects.toThrow("exactly one control");

    const candidate = await game.forkTimeline({
      checkpointId: context.initialEvidence.checkpointId,
      controls: { frameRate: 62.5 },
    });
    const candidateReplay = await game.replayTimeline({
      branchId: candidate.branchId,
    });
    expect(candidateReplay.outcome).toBe("pass");

    const comparison = await game.compareTimelines({
      baselineBranchId: baseline.branchId,
      candidateBranchId: candidate.branchId,
    });
    expect(comparison.baselineOutcome).toBe("fail");
    expect(comparison.candidateOutcome).toBe("pass");
    expect(comparison.details["changedControls"]).toEqual([
      { name: "deltaUs", before: 16_667, after: 16_000 },
    ]);

    const reopened = new JsonArtifactRepository(context.artifactRoot);
    await expect(reopened.getManifest(context.runId)).resolves.toMatchObject({
      runId: context.runId,
    });
  });
});
