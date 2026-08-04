import {
  FailureBriefV1Schema,
  asCapsuleId,
  asContractId,
  asExecutionId,
  asFixtureId,
  asRunId,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import { PiHarnessError } from "../src/errors.js";
import { V03ToolFlow } from "../src/internal/v03-runner.js";
import { createVirtualSourceAccess } from "../src/source-access.js";
import type { V03AgentGameApi } from "../src/v03-types.js";

const unavailableGame = {} as V03AgentGameApi;

describe("V03 diagnostic tool flow", () => {
  it("latches a source-budget violation so a later valid submit cannot score", async () => {
    const failureBrief = FailureBriefV1Schema.parse({
      schemaVersion: 1,
      runId: asRunId("run:tool-flow"),
      fixtureId: asFixtureId("fixture:tool-flow"),
      contractId: asContractId("contract:tool-flow"),
      capsuleId: asCapsuleId("capsule:tool-flow"),
      baselineExecutionId: asExecutionId("execution:tool-flow"),
      trigger: { kind: "signal", source: "subject", name: "triggered" },
      triggerEventId: "event:tool-flow",
      triggerTick: 0,
      expectation: {
        kind: "property_equals",
        path: "subject.result",
        value: true,
      },
      deadlineTick: 1,
      actual: { present: true, value: false },
      violationSummary: "The frozen expectation was not met",
    });
    const flow = new V03ToolFlow({
      cwd: "/virtual",
      runDir: "/virtual/run",
      arm: "generic",
      initialCapsuleId: failureBrief.capsuleId,
      baselineExecutionId: failureBrief.baselineExecutionId,
      failureBrief,
      game: unavailableGame,
      source: createVirtualSourceAccess({
        files: [
          {
            path: "case/main.gd",
            content: Array.from(
              { length: 8 },
              (_, index) => `line_${index + 1}`,
            ).join("\n"),
          },
        ],
      }),
    });

    for (let offset = 1; offset <= 4; offset += 1) {
      await expect(
        flow.runTool(() =>
          flow.sourceRead({ path: "case/main.gd", offset, limit: 1 }),
        ),
      ).resolves.toBeDefined();
    }
    await expect(
      flow.runTool(() =>
        flow.sourceRead({ path: "case/main.gd", offset: 5, limit: 1 }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_TOOL_FLOW",
      message: "Source tool budget exhausted",
    });

    await expect(
      flow.runTool(() =>
        flow.submit({
          schemaVersion: 3,
          proposalId: "proposal:tool-flow",
          runId: failureBrief.runId,
          fixtureId: failureBrief.fixtureId,
          capsuleId: failureBrief.capsuleId,
          baselineExecutionId: failureBrief.baselineExecutionId,
          candidateExecutionIds: [],
          comparisonIds: [],
          accessReceiptIds: [],
          mechanismCode: "unknown",
          summary: "Insufficient grounded evidence",
          evidenceEventIds: [],
          blockers: ["source budget exhausted"],
          nextExperiment: null,
          confidence: 0,
        }),
      ),
    ).rejects.toBeInstanceOf(PiHarnessError);
    expect(flow.getProposal()).toBeUndefined();
  });
});
