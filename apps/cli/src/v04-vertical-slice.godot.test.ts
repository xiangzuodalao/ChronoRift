import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { INVESTIGATION_TOOL_NAMES_V1 } from "@chronorift/agent-protocol";
import {
  V03_FIXTURE_IDS,
  v04GodotClaimForFixture,
} from "@chronorift/godot-adapter";
import { beforeAll, describe, expect, it } from "vitest";

import { runV04Diagnosis } from "./v04-diagnosis.js";

const cwd = resolve(import.meta.dirname, "../../..");

beforeAll(() => {
  process.env.GODOT_BIN ??= resolve(
    cwd,
    ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
  );
});

describe("ChronoRift v0.4 real Godot vertical slice", () => {
  it.each(V03_FIXTURE_IDS)(
    "confirms %s through opaque Pi tools and the independent Gate",
    async (fixture) => {
      const artifactRoot = await mkdtemp(
        join(tmpdir(), `chronorift-v04-${fixture}-`),
      );
      const result = await runV04Diagnosis({
        cwd,
        artifactRoot,
        fixture,
        mode: "scripted",
        apiOptions: {
          nowIso: () => "2026-08-06T00:00:00.000Z",
          nextProposalId: () => `proposal:v04:godot-test:${fixture}`,
        },
      });

      expect(result.baseline.outcome).toBe("fail");
      expect(result.proposal.confidence).toBe(0);
      expect(result.proposal.claim).toEqual(v04GodotClaimForFixture(fixture));
      expect(result.proposal.replayExecutionId).toBeDefined();
      expect(result.proposal.candidateExecutionIds).toHaveLength(1);
      expect(result.proposal.comparisonIds).toHaveLength(1);
      expect(result.verdict).toMatchObject({
        status: "confirmed",
        claimLevel: "mechanism_supported",
        mechanismId: v04GodotClaimForFixture(fixture).mechanismId,
        blockers: [],
        nextExperiment: null,
      });
      expect(result.toolCalls).toHaveLength(8);
      expect(
        result.toolCalls.every((call) => call.status === "succeeded"),
      ).toBe(true);
      expect(result.piSession.activeTools).toEqual([
        INVESTIGATION_TOOL_NAMES_V1.getCapsule,
        INVESTIGATION_TOOL_NAMES_V1.replayExecution,
        INVESTIGATION_TOOL_NAMES_V1.listInterventions,
        INVESTIGATION_TOOL_NAMES_V1.runIntervention,
        INVESTIGATION_TOOL_NAMES_V1.compareExecutions,
        INVESTIGATION_TOOL_NAMES_V1.readSource,
        INVESTIGATION_TOOL_NAMES_V1.searchSource,
        INVESTIGATION_TOOL_NAMES_V1.submitProposal,
      ]);
      expect(result.piSession.activeTools).not.toContain("bash");
      expect(result.runDirectory).toContain("/v0.4/runs/");
    },
  );
});
