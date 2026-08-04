import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { asProposalId } from "@chronorift/domain";
import {
  V03_FIXTURE_IDS,
  observedCheckpointValidationMatchesSnapshot,
} from "@chronorift/godot-adapter";
import { runDeterministicV03PiDiagnosis } from "@chronorift/pi-harness";
import { beforeAll, describe, expect, it } from "vitest";

import { ChronoRiftV03AgentGameApi } from "./v03-agent-game-api.js";
import { createV03Run } from "./v03-runtime.js";
import { createV03NeutralSourceAccess } from "./v03-source-view.js";

const cwd = resolve(import.meta.dirname, "../../..");

beforeAll(() => {
  process.env.GODOT_BIN ??= resolve(
    cwd,
    ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
  );
});

describe("ChronoRift v0.3 real Godot diagnostic matrix", () => {
  it.each(V03_FIXTURE_IDS)(
    "confirms the %s mechanism through real Pi tools and a single-variable intervention",
    async (fixture) => {
      const artifactRoot = await mkdtemp(
        join(tmpdir(), `chronorift-v03-${fixture}-`),
      );
      const context = await createV03Run({ cwd, artifactRoot, fixture });
      const certificate =
        context.preparedFixture.initialCheckpointContent.certificate;
      if (certificate === undefined) {
        throw new Error("v0.3 fixture lacks its observed certificate");
      }
      expect(
        observedCheckpointValidationMatchesSnapshot(
          context.preparedFixture.initialCheckpointContent.snapshot,
          certificate,
        ),
      ).toBe(true);
      const firstValidation = certificate.restoreValidation[0];
      expect(firstValidation).toBeDefined();
      expect(
        observedCheckpointValidationMatchesSnapshot(
          context.preparedFixture.initialCheckpointContent.snapshot,
          {
            ...certificate,
            restoreValidation: [
              {
                ...firstValidation!,
                stateHash: "0".repeat(64),
              },
            ],
          },
        ),
      ).toBe(false);
      expect(context.baselineExecution.fixtureId).toMatch(
        /^godot-runtime-case-0[1-4]$/u,
      );
      expect(context.baselineExecution.fixtureId).not.toBe(fixture);
      const game = new ChronoRiftV03AgentGameApi(context);
      const source = await createV03NeutralSourceAccess(context);
      const oracleSource = await source.read({
        path: "case/main.gd",
      });
      expect(oracleSource.content).toContain(
        `func ${context.preparedFixture.oracle.sourceSymbol}`,
      );
      const result = await runDeterministicV03PiDiagnosis({
        cwd,
        runDir: context.runDirectory,
        arm: "chronorift-full",
        initialCapsuleId: context.evidenceCapsule.capsuleId,
        baselineExecutionId: context.baselineExecution.executionId,
        game,
        source,
        failureBrief: context.failureBrief,
      });
      const verdict = await context.gameBranch.concludeV3(
        result.proposal,
        result.accessReceipts,
      );

      expect(context.baselineExecution.evaluation.status).toBe("fail");
      expect(context.baselineExecution.controlReceipt.accepted).toBe(true);
      expect(context.baselineExecution.observationHealth).toMatchObject({
        droppedEvents: 0,
        truncatedEvents: 0,
        backpressure: false,
      });
      expect(context.baselineExecution.stepReceipts).toHaveLength(
        context.baselineBranch.controls.maxTicks + 1,
      );
      expect(
        context.baselineExecution.stepReceipts.every(
          (receipt) =>
            receipt.runtime?.idleFramesExecuted === 1 &&
            receipt.runtime.actualIdleDeltasUs.length === 1 &&
            receipt.runtime.actualIdleDeltasUs[0] === receipt.realizedDeltaUs,
        ),
      ).toBe(true);
      if (fixture === "frame-input-window") {
        expect(
          context.baselineExecution.finalState.values[
            "player.process_callbacks"
          ],
        ).toBe(context.baselineExecution.stepReceipts.length);
      }
      expect(result.proposal.mechanismCode).toBe(
        context.preparedFixture.oracle.mechanismCode,
      );
      expect(result.proposal.confidence).toBe(0);
      expect(result.proposal.replayExecutionId).toBeDefined();
      expect(result.proposal.comparisonIds).toHaveLength(1);
      expect(verdict.status).toBe("confirmed");
      expect(game.gameExecutions).toBe(3);

      const unsupported = await context.gameBranch.concludeV3(
        {
          ...result.proposal,
          proposalId: asProposalId(
            `${result.proposal.proposalId}:confidence-only`,
          ),
          replayExecutionId: undefined,
          comparisonIds: [],
          confidence: 1,
        },
        result.accessReceipts,
      );
      expect(unsupported.status).toBe("inconclusive");
      expect(unsupported.blockers).toContain(
        "A matching failing strict replay is required",
      );
    },
  );

  it("lets the generic arm earn confirmation from raw replay and intervention evidence", async () => {
    const artifactRoot = await mkdtemp(
      join(tmpdir(), "chronorift-v03-generic-"),
    );
    const context = await createV03Run({
      cwd,
      artifactRoot,
      fixture: "signal-ordering",
    });
    const game = new ChronoRiftV03AgentGameApi(context);
    const source = await createV03NeutralSourceAccess(context);
    const result = await runDeterministicV03PiDiagnosis({
      cwd,
      runDir: context.runDirectory,
      arm: "generic",
      initialCapsuleId: context.evidenceCapsule.capsuleId,
      baselineExecutionId: context.baselineExecution.executionId,
      game,
      source,
      failureBrief: context.failureBrief,
    });
    const verdict = await context.gameBranch.concludeV3(
      result.proposal,
      result.accessReceipts,
    );
    const session = await readFile(result.piSession.sessionFile, "utf8");

    expect(result.proposal.mechanismCode).toBe(
      "signal_before_receiver_connection",
    );
    expect(result.proposal.comparisonIds).toEqual([]);
    expect(verdict.status).toBe("confirmed");
    expect(game.gameExecutions).toBe(3);
    expect(session).not.toContain('"toolName":"bash"');
    expect(session).not.toContain('"toolName":"game_compare_executions_v2"');
    expect(session).toContain('"toolName":"game_get_raw_baseline"');
    expect(session).toContain('"toolName":"game_replay_raw_baseline"');
    expect(session).toContain('"toolName":"game_run_experiment_v2"');
    expect(session).not.toContain('"toolName":"game_get_evidence_capsule_v2"');
  });

  it("keeps the evidence-only arm inconclusive and unable to intervene", async () => {
    const artifactRoot = await mkdtemp(
      join(tmpdir(), "chronorift-v03-evidence-only-"),
    );
    const context = await createV03Run({
      cwd,
      artifactRoot,
      fixture: "signal-ordering",
    });
    const game = new ChronoRiftV03AgentGameApi(context);
    const source = await createV03NeutralSourceAccess(context);
    const result = await runDeterministicV03PiDiagnosis({
      cwd,
      runDir: context.runDirectory,
      arm: "evidence-only",
      initialCapsuleId: context.evidenceCapsule.capsuleId,
      baselineExecutionId: context.baselineExecution.executionId,
      game,
      source,
      failureBrief: context.failureBrief,
    });
    const verdict = await context.gameBranch.concludeV3(
      result.proposal,
      result.accessReceipts,
    );
    const session = await readFile(result.piSession.sessionFile, "utf8");

    expect(result.proposal.mechanismCode).toBe(
      "signal_before_receiver_connection",
    );
    expect(verdict.status).toBe("inconclusive");
    expect(game.gameExecutions).toBe(2);
    expect(session).not.toContain('"toolName":"bash"');
    expect(session).not.toContain('"toolName":"game_compare_executions_v2"');
    expect(session).toContain('"toolName":"game_get_evidence_capsule_v2"');
    expect(session).toContain('"toolName":"game_replay_execution_v2"');
    expect(session).not.toContain('"toolName":"game_run_experiment_v2"');
  });
});
