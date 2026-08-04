import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { asProposalId } from "@chronorift/domain";
import { V03_FIXTURE_IDS } from "@chronorift/godot-adapter";
import {
  createRestrictedSourceAccess,
  runDeterministicV03PiDiagnosis,
} from "@chronorift/pi-harness";
import { beforeAll, describe, expect, it } from "vitest";

import { ChronoRiftV03AgentGameApi } from "./v03-agent-game-api.js";
import { createV03Run } from "./v03-runtime.js";

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
      expect(context.baselineExecution.fixtureId).toMatch(
        /^godot-runtime-case-0[1-4]$/u,
      );
      expect(context.baselineExecution.fixtureId).not.toBe(fixture);
      const game = new ChronoRiftV03AgentGameApi(context);
      const source = await createRestrictedSourceAccess({
        root: context.preparedFixture.sourceDirectory,
      });
      const oracleSource = await source.read({
        path: context.preparedFixture.oracle.sourcePath,
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
      });
      const verdict = await context.gameBranch.conclude(result.proposal);

      expect(context.baselineExecution.evaluation.status).toBe("fail");
      expect(context.baselineExecution.controlReceipt.accepted).toBe(true);
      expect(context.baselineExecution.observationHealth).toMatchObject({
        droppedEvents: 0,
        truncatedEvents: 0,
        backpressure: false,
      });
      expect(result.proposal.mechanismCode).toBe(
        context.preparedFixture.oracle.mechanismCode,
      );
      expect(result.proposal.confidence).toBe(0);
      expect(result.proposal.replayExecutionId).toBeDefined();
      expect(result.proposal.comparisonIds).toHaveLength(1);
      expect(verdict.status).toBe("confirmed");
      expect(game.gameExecutions).toBe(3);

      const unsupported = await context.gameBranch.conclude({
        ...result.proposal,
        proposalId: asProposalId(
          `${result.proposal.proposalId}:confidence-only`,
        ),
        replayExecutionId: undefined,
        comparisonIds: [],
        confidence: 1,
      });
      expect(unsupported.status).toBe("inconclusive");
      expect(unsupported.blockers).toContain(
        "A matching failing strict replay is required",
      );
    },
  );

  it.each(["generic", "evidence-only"] as const)(
    "keeps the %s arm inconclusive and restricted",
    async (arm) => {
      const artifactRoot = await mkdtemp(
        join(tmpdir(), `chronorift-v03-${arm}-`),
      );
      const context = await createV03Run({
        cwd,
        artifactRoot,
        fixture: "signal-ordering",
      });
      const game = new ChronoRiftV03AgentGameApi(context);
      const source = await createRestrictedSourceAccess({
        root: context.preparedFixture.sourceDirectory,
      });
      const result = await runDeterministicV03PiDiagnosis({
        cwd,
        runDir: context.runDirectory,
        arm,
        initialCapsuleId: context.evidenceCapsule.capsuleId,
        baselineExecutionId: context.baselineExecution.executionId,
        game,
        source,
      });
      const verdict = await context.gameBranch.conclude(result.proposal);
      const session = await readFile(result.piSession.sessionFile, "utf8");

      expect(result.proposal.mechanismCode).toBe(
        "signal_before_receiver_connection",
      );
      expect(verdict.status).toBe("inconclusive");
      expect(game.gameExecutions).toBe(2);
      expect(session).not.toContain('"toolName":"bash"');
      expect(session).not.toContain('"toolName":"game_compare_executions_v2"');
      if (arm === "generic") {
        expect(session).toContain('"toolName":"game_get_raw_baseline"');
        expect(session).toContain('"toolName":"game_run_experiment_v2"');
        expect(session).not.toContain(
          '"toolName":"game_get_evidence_capsule_v2"',
        );
      } else {
        expect(session).toContain('"toolName":"game_get_evidence_capsule_v2"');
        expect(session).toContain('"toolName":"game_replay_execution_v2"');
        expect(session).not.toContain('"toolName":"game_run_experiment_v2"');
      }
    },
  );
});
