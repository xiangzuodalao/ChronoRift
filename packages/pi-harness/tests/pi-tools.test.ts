import { describe, expect, it } from "vitest";

import type { AgentGameApi, RestrictedSourceAccess } from "../src/types.js";
import { createPiTools, PI_TOOL_NAMES } from "../src/internal/pi-tools.js";
import { HarnessToolFlow } from "../src/internal/tool-flow.js";

const source: RestrictedSourceAccess = {
  root: "/fixture",
  async read() {
    return {
      path: "door.ts",
      content: "elapsedUs === thresholdUs",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
    };
  },
  async search(request) {
    return {
      query: request.query,
      matches: [],
      scannedFiles: 0,
      truncated: false,
    };
  },
};

function gameApi(): AgentGameApi {
  return {
    async getEvidence(evidenceId) {
      return {
        schemaVersion: 1,
        evidenceId,
        summary: "failure",
        checkpointId: "checkpoint",
        branchId: "baseline",
        eventIds: [],
        details: {},
      };
    },
    async forkTimeline(request) {
      return {
        schemaVersion: 1,
        branchId: "candidate",
        checkpointId: request.checkpointId,
        controls: request.controls,
      };
    },
    async replayTimeline({ branchId }) {
      return {
        schemaVersion: 1,
        branchId,
        outcome: branchId === "baseline" ? "fail" : "pass",
        evidenceIds: [`replay-${branchId}`],
        finalCheckpointId: `final-${branchId}`,
        summary: "replayed",
        details: {},
      };
    },
    async compareTimelines({ baselineBranchId, candidateBranchId }) {
      return {
        schemaVersion: 1,
        baselineBranchId,
        candidateBranchId,
        baselineOutcome: "fail",
        candidateOutcome: "pass",
        evidenceIds: ["comparison"],
        firstDivergenceTick: 1,
        summary: "different",
        details: {},
      };
    },
  };
}

describe("Pi custom tools", () => {
  it("registers only the expected tools and serializes every execution", () => {
    const tools = createPiTools(new HarnessToolFlow(gameApi()), source);

    expect(tools.map((tool) => tool.name)).toEqual(PI_TOOL_NAMES);
    expect(tools.every((tool) => tool.executionMode === "sequential")).toBe(
      true,
    );
    expect(tools.map((tool) => tool.name)).not.toContain("bash");
    expect(tools.map((tool) => tool.name)).not.toContain("write");
    expect(tools.map((tool) => tool.name)).not.toContain("edit");
  });

  it("returns terminate only after a valid canonical submission", async () => {
    const flow = new HarnessToolFlow(gameApi());
    await flow.getEvidence("evidence");
    await flow.replayTimeline({ branchId: "baseline" });
    await flow.forkTimeline({ checkpointId: "checkpoint", controls: {} });
    await flow.replayTimeline({ branchId: "candidate" });
    await flow.compareTimelines({
      baselineBranchId: "baseline",
      candidateBranchId: "candidate",
    });
    const submit = createPiTools(flow, source).find(
      (tool) => tool.name === "submit_diagnosis",
    );
    if (!submit) throw new Error("submit tool missing");

    const result = await submit.execute(
      "call-submit",
      {
        schemaVersion: 1,
        conclusion: "exact equality is frame-rate dependent",
        confidence: 0.9,
        evidenceIds: ["evidence", "comparison"],
        experiments: [
          {
            branchId: "candidate",
            outcome: "pass",
            evidenceIds: ["replay-candidate"],
            observation: "candidate passed",
          },
        ],
        comparisons: [
          {
            baselineBranchId: "baseline",
            candidateBranchId: "candidate",
            finding: "outcome changed",
          },
        ],
        suggestedFix: "use a greater-than-or-equal threshold",
      },
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.terminate).toBe(true);
    expect(flow.getSubmittedReport()?.confidence).toBe(0.9);
  });
});
