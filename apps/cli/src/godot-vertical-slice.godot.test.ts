import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runDeterministicPiDiagnosis } from "@chronorift/pi-harness";
import { beforeAll, describe, expect, it } from "vitest";

import { persistV01PiDiagnosis } from "./diagnosis.js";
import { ChronoRiftV01AgentGameApi } from "./v01-agent-game-api.js";
import { createV01MockRun } from "./v01-runtime.js";

const cwd = resolve(import.meta.dirname, "../../..");

beforeAll(() => {
  process.env.GODOT_BIN ??= resolve(
    cwd,
    ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
  );
});

describe("Godot 4.7.1 switch-door vertical slice", () => {
  it("characterizes a fresh-scene L0 baseline", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "chronorift-godot-l0-"));
    const context = await createV01MockRun({
      cwd,
      artifactRoot,
      environment: "godot",
      checkpointLevel: "l0_restart",
    });
    expect(context.baselineExecution.status).toBe("completed");
    if (context.baselineExecution.status !== "completed") return;
    expect(context.baselineExecution.evaluation.status).toBe("fail");
    expect(
      context.baselineExecution.restoreReceipt.runtimeValidation?.level,
    ).toBe("l0_restart");
    expect(context.baselineExecution.events.map((event) => event.kind)).toEqual(
      [
        "input",
        "property_changed",
        "signal",
        "signal_delivery",
        "property_changed",
      ],
    );
  });

  it("runs L2 replay, intervention, evidence, Pi tools, and Gate", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "chronorift-godot-l2-"));
    const context = await createV01MockRun({
      cwd,
      artifactRoot,
      environment: "godot",
      checkpointLevel: "fixture_semantic_l2",
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
    const persisted = await persistV01PiDiagnosis(context, result.proposal);
    expect(result.proposal.confidence).toBe(0);
    expect(persisted.verdict.status).toBe("confirmed");
    expect(result.proposal.replayExecutionId).toBeDefined();
    expect(result.proposal.candidateExecutionId).toBeDefined();
    const replay = await context.repository.getExecutionLog(
      result.proposal.replayExecutionId!,
    );
    const candidate = await context.repository.getExecutionLog(
      result.proposal.candidateExecutionId!,
    );
    expect(replay.timelineDigest).toBe(
      context.baselineExecution.timelineDigest,
    );
    expect(replay.status === "completed" && replay.evaluation.status).toBe(
      "fail",
    );
    expect(
      candidate.status === "completed" && candidate.evaluation.status,
    ).toBe("pass");
    expect(
      candidate.events.some(
        (event) => event.kind === "signal_delivery" && event.delivered,
      ),
    ).toBe(true);
    expect(
      candidate.events.some(
        (event) =>
          event.kind === "property_changed" && event.path === "door.open",
      ),
    ).toBe(true);
    expect(
      context.baselineExecution.stepReceipts.every(
        (receipt) =>
          receipt.runtime?.observationHealth.droppedEvents === 0 &&
          receipt.runtime.observationHealth.truncatedEvents === 0,
      ),
    ).toBe(true);
  });
});
