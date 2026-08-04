import { describe, expect, it } from "vitest";

import type {
  AgentGameApi,
  AgentTimelineBranch,
  DiagnosisReport,
  ForkTimelineRequest,
} from "../src/types.js";
import { HarnessToolFlow } from "../src/internal/tool-flow.js";

function createGameApi(): AgentGameApi {
  const branches = new Map<string, AgentTimelineBranch>();
  branches.set("branch-baseline", {
    schemaVersion: 1,
    branchId: "branch-baseline",
    checkpointId: "checkpoint-switch",
    controls: { deltaUs: 16_667 },
  });
  let nextBranch = 1;

  return {
    async getEvidence(evidenceId) {
      if (evidenceId !== "evidence-door") return null;
      return {
        schemaVersion: 1,
        evidenceId,
        summary: "Switch signal fired but the door remained closed.",
        checkpointId: "checkpoint-switch",
        branchId: "branch-baseline",
        eventIds: ["event-switch", "event-door-state"],
        details: { expectedDoorOpen: true, actualDoorOpen: false },
      };
    },
    async forkTimeline(request: ForkTimelineRequest) {
      const branch = {
        schemaVersion: 1 as const,
        branchId: `branch-candidate-${nextBranch++}`,
        checkpointId: request.checkpointId,
        controls: request.controls,
      };
      branches.set(branch.branchId, branch);
      return branch;
    },
    async replayTimeline({ branchId }) {
      const branch = branches.get(branchId);
      if (!branch) throw new Error("missing branch");
      const outcome = branchId === "branch-baseline" ? "fail" : "pass";
      return {
        schemaVersion: 1,
        branchId,
        outcome,
        evidenceIds: [`evidence-replay-${branchId}`],
        finalCheckpointId: `checkpoint-final-${branchId}`,
        summary: outcome === "pass" ? "Door opened." : "Door stayed closed.",
        details: { doorOpen: outcome === "pass" },
      };
    },
    async compareTimelines({ baselineBranchId, candidateBranchId }) {
      return {
        schemaVersion: 1,
        baselineBranchId,
        candidateBranchId,
        baselineOutcome: "fail",
        candidateOutcome: "pass",
        evidenceIds: ["evidence-comparison"],
        firstDivergenceTick: 5,
        summary: "The candidate crosses the deadline on a frame boundary.",
        details: { changedControl: "deltaUs" },
      };
    },
  };
}

async function prepareValidFlow(): Promise<{
  flow: HarnessToolFlow;
  report: DiagnosisReport;
}> {
  const flow = new HarnessToolFlow(createGameApi());
  await flow.getEvidence("evidence-door");
  await flow.replayTimeline({ branchId: "branch-baseline" });
  const candidate = await flow.forkTimeline({
    checkpointId: "checkpoint-switch",
    controls: { deltaUs: 20_000 },
    label: "50fps",
  });
  await flow.replayTimeline({ branchId: candidate.branchId });
  await flow.compareTimelines({
    baselineBranchId: "branch-baseline",
    candidateBranchId: candidate.branchId,
  });
  return {
    flow,
    report: {
      schemaVersion: 1,
      conclusion: "The door checks exact elapsed-time equality.",
      confidence: 0.94,
      evidenceIds: ["evidence-door", "evidence-comparison"],
      experiments: [
        {
          branchId: candidate.branchId,
          outcome: "pass",
          evidenceIds: [`evidence-replay-${candidate.branchId}`],
          observation:
            "A frame interval that divides the deadline opens the door.",
        },
      ],
      comparisons: [
        {
          baselineBranchId: "branch-baseline",
          candidateBranchId: candidate.branchId,
          finding: "Only the changed frame interval alters the result.",
        },
      ],
      suggestedFix: "Use elapsedUs >= thresholdUs instead of exact equality.",
    },
  };
}

describe("HarnessToolFlow", () => {
  it("enforces evidence-derived checkpoint and branch references", async () => {
    const flow = new HarnessToolFlow(createGameApi());

    await expect(
      flow.forkTimeline({ checkpointId: "invented", controls: {} }),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_FLOW" });
    await expect(
      flow.replayTimeline({ branchId: "invented" }),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_FLOW" });

    await flow.getEvidence("evidence-door");
    const candidate = await flow.forkTimeline({
      checkpointId: "checkpoint-switch",
      controls: { deltaUs: 20_000 },
    });
    await expect(
      flow.compareTimelines({
        baselineBranchId: "branch-baseline",
        candidateBranchId: candidate.branchId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_FLOW" });
  });

  it("accepts a structurally and semantically grounded diagnosis", async () => {
    const { flow, report } = await prepareValidFlow();

    expect(flow.submitDiagnosis(report)).toEqual(report);
    expect(flow.getSubmittedReport()).toEqual(report);
    await expect(flow.getEvidence("evidence-door")).rejects.toMatchObject({
      code: "INVALID_TOOL_FLOW",
    });
  });

  it("rejects invented evidence and mismatched replay outcomes", async () => {
    const { flow, report } = await prepareValidFlow();

    expect(() =>
      flow.submitDiagnosis({
        ...report,
        evidenceIds: ["evidence-invented"],
      }),
    ).toThrowError(/no tool returned/);

    expect(() =>
      flow.submitDiagnosis({
        ...report,
        experiments: report.experiments.map((experiment) => ({
          ...experiment,
          outcome: "fail" as const,
        })),
      }),
    ).toThrowError(/replay returned pass/);

    expect(() =>
      flow.submitDiagnosis({
        ...report,
        experiments: report.experiments.map((experiment) => ({
          ...experiment,
          evidenceIds: ["evidence-replay-branch-baseline"],
        })),
      }),
    ).toThrowError(/was not returned by replay branch-candidate/);

    expect(flow.getSubmittedReport()).toBeUndefined();
  });

  it("rejects extra report fields and submission before experiments", async () => {
    const flow = new HarnessToolFlow(createGameApi());
    await flow.getEvidence("evidence-door");

    expect(() =>
      flow.submitDiagnosis({
        schemaVersion: 1,
        conclusion: "invented",
        confidence: 1,
        evidenceIds: ["evidence-door"],
        experiments: [],
        comparisons: [],
        suggestedFix: "invented",
        unvalidated: true,
      }),
    ).toThrowError(/unexpected properties/);
  });
});
