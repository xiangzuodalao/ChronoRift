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
import { V03SessionGuard } from "../src/internal/v03-session-guard.js";
import { createVirtualSourceAccess } from "../src/source-access.js";
import type { V03AgentGameApi } from "../src/v03-types.js";

const unavailableGame = {} as V03AgentGameApi;

describe("V03 diagnostic tool flow", () => {
  it("treats an empty source search as a successful non-progress result", async () => {
    const failureBrief = FailureBriefV1Schema.parse({
      schemaVersion: 1,
      runId: asRunId("run:non-progress-search"),
      fixtureId: asFixtureId("fixture:non-progress-search"),
      contractId: asContractId("contract:non-progress-search"),
      capsuleId: asCapsuleId("capsule:non-progress-search"),
      baselineExecutionId: asExecutionId("execution:non-progress-search"),
      trigger: { kind: "signal", source: "subject", name: "triggered" },
      triggerEventId: "event:non-progress-search",
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
      arm: "evidence-only",
      initialCapsuleId: failureBrief.capsuleId,
      baselineExecutionId: failureBrief.baselineExecutionId,
      failureBrief,
      game: unavailableGame,
      source: createVirtualSourceAccess({
        files: [{ path: "case/main.gd", content: "extends Node\n" }],
      }),
    });
    let aborts = 0;
    const guard = new V03SessionGuard({
      semanticRevision: () => flow.getSemanticRevision(),
      terminalToolViolation: () => flow.getTerminalToolViolation(),
      requestAbort: () => {
        aborts += 1;
      },
    });

    guard.onToolExecutionStart("source_search_v1");
    const result = await flow.runTool(() =>
      flow.sourceSearch({ query: "definitely_absent" }),
    );
    guard.onToolExecutionEnd("source_search_v1", false);

    expect(result).toMatchObject({ data: { matches: [] } });
    expect(flow.getSemanticRevision()).toBe(0);
    expect(guard.terminalError).toMatchObject({
      code: "AGENT_BUDGET_EXHAUSTED",
      details: { budget: "semantic_progress", limit: 0, observed: 1 },
    });
    expect(aborts).toBe(1);
  });

  it("resolves session-scoped receipt handles to canonical receipt IDs", async () => {
    const failureBrief = FailureBriefV1Schema.parse({
      schemaVersion: 1,
      runId: asRunId("run:receipt-handles"),
      fixtureId: asFixtureId("fixture:receipt-handles"),
      contractId: asContractId("contract:receipt-handles"),
      capsuleId: asCapsuleId("capsule:receipt-handles"),
      baselineExecutionId: asExecutionId("execution:receipt-handles"),
      trigger: { kind: "signal", source: "subject", name: "triggered" },
      triggerEventId: "event:receipt-handles",
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
      arm: "evidence-only",
      initialCapsuleId: failureBrief.capsuleId,
      baselineExecutionId: failureBrief.baselineExecutionId,
      failureBrief,
      game: unavailableGame,
      source: createVirtualSourceAccess({
        files: [{ path: "case/main.gd", content: "extends Node\n" }],
      }),
    });
    const sourceResult = await flow.sourceRead({
      path: "case/main.gd",
      offset: 1,
      limit: 1,
    });
    expect(sourceResult.accessHandle).toBe("@r1");

    const proposal = flow.submit({
      schemaVersion: 3,
      proposalId: "proposal:receipt-handles",
      runId: failureBrief.runId,
      fixtureId: failureBrief.fixtureId,
      capsuleId: failureBrief.capsuleId,
      baselineExecutionId: failureBrief.baselineExecutionId,
      candidateExecutionIds: [],
      comparisonIds: [],
      accessReceiptIds: ["@r0", sourceResult.accessHandle],
      mechanismCode: "unknown",
      summary: "Insufficient grounded evidence",
      evidenceEventIds: [],
      blockers: ["No experiment is available"],
      nextExperiment: null,
      confidence: 0,
    });
    expect(proposal.accessReceiptIds).toEqual(
      flow.getReceipts().map((receipt) => receipt.receiptId),
    );
    expect(proposal.accessReceiptIds).not.toContain("@r0");
  });

  it("accepts only event IDs exposed to the scoped investigation", () => {
    const failureBrief = FailureBriefV1Schema.parse({
      schemaVersion: 1,
      runId: asRunId("run:event-grounding"),
      fixtureId: asFixtureId("fixture:event-grounding"),
      contractId: asContractId("contract:event-grounding"),
      capsuleId: asCapsuleId("capsule:event-grounding"),
      baselineExecutionId: asExecutionId("execution:event-grounding"),
      trigger: { kind: "signal", source: "subject", name: "triggered" },
      triggerEventId: "event:event-grounding:trigger",
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
    const createFlow = (): V03ToolFlow =>
      new V03ToolFlow({
        cwd: "/virtual",
        runDir: "/virtual/run",
        arm: "evidence-only",
        initialCapsuleId: failureBrief.capsuleId,
        baselineExecutionId: failureBrief.baselineExecutionId,
        failureBrief,
        game: unavailableGame,
        source: createVirtualSourceAccess({
          files: [{ path: "case/main.gd", content: "extends Node\n" }],
        }),
      });
    const proposal = (eventId: string) => ({
      schemaVersion: 3,
      proposalId: "proposal:event-grounding",
      runId: failureBrief.runId,
      fixtureId: failureBrief.fixtureId,
      capsuleId: failureBrief.capsuleId,
      baselineExecutionId: failureBrief.baselineExecutionId,
      candidateExecutionIds: [],
      comparisonIds: [],
      accessReceiptIds: ["@r0"],
      mechanismCode: "unknown",
      summary: "Insufficient grounded evidence",
      evidenceEventIds: [eventId],
      blockers: ["No experiment is available"],
      nextExperiment: null,
      confidence: 0,
    });

    expect(
      createFlow().submit(proposal(failureBrief.triggerEventId)),
    ).toMatchObject({ evidenceEventIds: [failureBrief.triggerEventId] });
    const ungrounded = createFlow();
    expect(() =>
      ungrounded.submit(proposal("event:event-grounding:unseen")),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_DIAGNOSIS",
        message: "Proposal evidence event IDs are ungrounded",
      }),
    );
    expect(ungrounded.getProposal()).toBeUndefined();
  });

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
    expect(flow.getSemanticRevision()).toBe(0);

    for (let offset = 1; offset <= 4; offset += 1) {
      await expect(
        flow.runTool(() =>
          flow.sourceRead({ path: "case/main.gd", offset, limit: 1 }),
        ),
      ).resolves.toBeDefined();
    }
    expect(flow.getSemanticRevision()).toBe(4);
    await expect(
      flow.runTool(() =>
        flow.sourceRead({ path: "case/main.gd", offset: 5, limit: 1 }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_TOOL_FLOW",
      message: "Source tool budget exhausted",
    });
    expect(flow.getSemanticRevision()).toBe(4);

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
