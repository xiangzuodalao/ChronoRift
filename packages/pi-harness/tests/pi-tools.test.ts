import { describe, expect, it } from "vitest";

import { createPiTools, PI_TOOL_NAMES } from "../src/internal/pi-tools.js";
import { HarnessToolFlow } from "../src/internal/tool-flow.js";
import { FIXTURE_CAPSULE_ID, createV01AgentFixtureApi } from "./v01-fixture.js";

describe("Pi custom tools", () => {
  it("registers only the five v0.1 tools", () => {
    const fixture = createV01AgentFixtureApi();
    const tools = createPiTools(
      new HarnessToolFlow(fixture.api, FIXTURE_CAPSULE_ID),
    );

    expect(tools.map((tool) => tool.name)).toEqual(PI_TOOL_NAMES);
    expect(tools.every((tool) => tool.executionMode === "sequential")).toBe(
      true,
    );
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["bash", "read", "source_read", "write", "edit"]),
    );
  });

  it("terminates only after a schema-valid grounded proposal", async () => {
    const fixture = createV01AgentFixtureApi();
    const flow = new HarnessToolFlow(fixture.api, FIXTURE_CAPSULE_ID);
    const capsule = await flow.getEvidenceCapsule(FIXTURE_CAPSULE_ID);
    const replay = await flow.replayExecution({
      executionId: capsule.baselineExecutionId,
    });
    const intervention = await flow.runIntervention({
      baselineExecutionId: capsule.baselineExecutionId,
      deltaTicks: 1,
    });
    const comparison = await flow.compareExecutions({
      baselineExecutionId: replay.execution.executionId,
      candidateExecutionId: intervention.execution.executionId,
    });
    const submit = createPiTools(flow).find(
      (tool) => tool.name === "submit_diagnosis_proposal",
    );
    if (!submit) throw new Error("submit tool missing");

    const result = await submit.execute(
      "chronorift-call-submit",
      {
        schemaVersion: 1,
        proposalId: "proposal-tool-test",
        runId: capsule.runId,
        capsuleId: capsule.capsuleId,
        baselineExecutionId: capsule.baselineExecutionId,
        replayExecutionId: replay.execution.executionId,
        candidateExecutionId: intervention.execution.executionId,
        comparisonId: comparison.comparisonId,
        claim: {
          kind: "mechanism",
          summary: "Signal precedes receiver connection.",
          mechanism: "Missed Signals are not replayed.",
          category: "signal_ordering",
          mechanismCode: "signal_before_receiver_connection",
          assertion: {
            signal: {
              kind: "signal",
              source: "switch",
              name: "switch.activated",
            },
            receiver: "door",
            failedDeliveryReason: "receiver_not_connected",
            expectedEffect: {
              kind: "property_equals",
              path: "door.open",
              value: true,
            },
            intervention: { kind: "delay_input", deltaTicks: 1 },
          },
        },
        observedFacts: [
          {
            statement: "The isolated comparison changed fail to pass.",
            references: [
              {
                artifactKind: "comparison",
                comparisonId: comparison.comparisonId,
              },
            ],
          },
        ],
        hypotheses: ["Initialization order controls Signal delivery."],
        unknowns: [],
        attemptedActions: ["replay", "intervention", "compare"],
        blockers: [],
        nextExperiment: null,
        confidence: 0,
      },
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.terminate).toBe(true);
    expect(flow.getSubmittedProposal()?.confidence).toBe(0);
  });
});
