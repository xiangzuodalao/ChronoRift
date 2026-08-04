import { describe, expect, it } from "vitest";

import { HarnessToolFlow } from "../src/internal/tool-flow.js";
import { FIXTURE_CAPSULE_ID, createV01AgentFixtureApi } from "./v01-fixture.js";

async function prepareMechanismFlow() {
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
  return { flow, capsule, replay, intervention, comparison };
}

describe("HarnessToolFlow", () => {
  it("enforces capsule-derived IDs and the v0.1 tool order", async () => {
    const fixture = createV01AgentFixtureApi();
    const flow = new HarnessToolFlow(fixture.api, FIXTURE_CAPSULE_ID);

    await expect(
      flow.replayExecution({ executionId: "invented" }),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_FLOW" });
    await expect(
      flow.getEvidenceCapsule("capsule-out-of-scope"),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_FLOW" });

    const capsule = await flow.getEvidenceCapsule(FIXTURE_CAPSULE_ID);
    await expect(
      flow.runIntervention({
        baselineExecutionId: capsule.baselineExecutionId,
        deltaTicks: 1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_FLOW" });
  });

  it("accepts a grounded mechanism proposal without using confidence as a verdict", async () => {
    const { flow, capsule, replay, intervention, comparison } =
      await prepareMechanismFlow();
    const proposal = {
      schemaVersion: 1,
      proposalId: "proposal-test",
      runId: capsule.runId,
      capsuleId: capsule.capsuleId,
      baselineExecutionId: capsule.baselineExecutionId,
      replayExecutionId: replay.execution.executionId,
      candidateExecutionId: intervention.execution.executionId,
      comparisonId: comparison.comparisonId,
      claim: {
        kind: "mechanism",
        summary: "Signal emitted before receiver connection.",
        mechanism: "The missed Signal is not replayed.",
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
          statement: "The comparison changed from fail to pass.",
          references: [
            {
              artifactKind: "comparison",
              comparisonId: comparison.comparisonId,
            },
          ],
        },
      ],
      hypotheses: ["Receiver initialization ordering controls delivery."],
      unknowns: [],
      attemptedActions: ["replay", "intervention", "compare"],
      blockers: [],
      nextExperiment: null,
      confidence: 0,
    } as const;

    expect(flow.submitDiagnosisProposal(proposal)).toEqual(proposal);
    expect(flow.getSubmittedProposal()?.confidence).toBe(0);
    await expect(
      flow.getEvidenceCapsule(FIXTURE_CAPSULE_ID),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_FLOW" });
  });

  it("rejects fabricated artifact references and extra proposal fields", async () => {
    const { flow, capsule, replay, intervention, comparison } =
      await prepareMechanismFlow();
    const common = {
      schemaVersion: 1,
      proposalId: "proposal-test",
      runId: capsule.runId,
      capsuleId: capsule.capsuleId,
      baselineExecutionId: capsule.baselineExecutionId,
      replayExecutionId: replay.execution.executionId,
      candidateExecutionId: intervention.execution.executionId,
      comparisonId: comparison.comparisonId,
      claim: {
        kind: "mechanism",
        summary: "Signal ordering",
        mechanism: "Signal precedes receiver",
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
      hypotheses: [],
      unknowns: [],
      attemptedActions: ["compared"],
      blockers: [],
      nextExperiment: null,
      confidence: 1,
    } as const;

    expect(() =>
      flow.submitDiagnosisProposal({
        ...common,
        observedFacts: [
          {
            statement: "Invented",
            references: [
              { artifactKind: "execution", executionId: "invented" },
            ],
          },
        ],
      }),
    ).toThrowError(/no tool returned/);
    expect(() =>
      flow.submitDiagnosisProposal({
        ...common,
        observedFacts: [],
        status: "confirmed",
      }),
    ).toThrowError(/Unrecognized key|unrecognized key|status/);
    expect(flow.getSubmittedProposal()).toBeUndefined();
  });

  it("allows evidence-backed abstention before an unavailable experiment", async () => {
    const fixture = createV01AgentFixtureApi();
    const flow = new HarnessToolFlow(fixture.api, FIXTURE_CAPSULE_ID);
    const capsule = await flow.getEvidenceCapsule(FIXTURE_CAPSULE_ID);

    const proposal = flow.submitDiagnosisProposal({
      schemaVersion: 1,
      proposalId: "proposal-abstain",
      runId: capsule.runId,
      capsuleId: capsule.capsuleId,
      baselineExecutionId: capsule.baselineExecutionId,
      claim: { kind: "unknown", summary: "Replay is unavailable." },
      observedFacts: [
        {
          statement: "The baseline violates the frozen Contract.",
          references: [
            { artifactKind: "capsule", capsuleId: capsule.capsuleId },
          ],
        },
      ],
      hypotheses: [],
      unknowns: ["Whether a matching replay can be produced."],
      attemptedActions: ["Read the capsule"],
      blockers: ["Replay capability unavailable"],
      nextExperiment: "Restore the baseline checkpoint and replay once.",
      confidence: 1,
    });

    expect(proposal.claim.kind).toBe("unknown");
    expect(proposal.confidence).toBe(1);
  });

  it("limits replay, intervention, and comparison to one call each", async () => {
    const { flow, capsule } = await prepareMechanismFlow();

    await expect(
      flow.replayExecution({ executionId: capsule.baselineExecutionId }),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_FLOW" });
    await expect(
      flow.runIntervention({
        baselineExecutionId: capsule.baselineExecutionId,
        deltaTicks: 1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_FLOW" });
  });

  it("fails closed on a contradictory replay receipt", async () => {
    const fixture = createV01AgentFixtureApi();
    const corruptApi = {
      ...fixture.api,
      async replayExecution(
        request: Parameters<typeof fixture.api.replayExecution>[0],
      ) {
        const result = await fixture.api.replayExecution(request);
        return { ...result, replayDigest: "forged-digest" };
      },
    };
    const flow = new HarnessToolFlow(corruptApi, FIXTURE_CAPSULE_ID);
    const capsule = await flow.getEvidenceCapsule(FIXTURE_CAPSULE_ID);

    await expect(
      flow.replayExecution({ executionId: capsule.baselineExecutionId }),
    ).rejects.toMatchObject({ code: "INVALID_GAME_RESULT" });
  });
});
