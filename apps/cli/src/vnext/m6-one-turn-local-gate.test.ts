import { asSha256DigestV1 } from "@chronorift/domain";
import { describe, expect, it, vi } from "vitest";

import type { ExternalHiddenFixWorkflowInputV1 } from "./external-hidden-fix-workflow.js";
import { createM6OneTurnLocalGateAgentPortV1 } from "./m6-one-turn-local-gate.js";
import type {
  M6OneTurnAgentPortV1,
  M6OneTurnAgentRequestV1,
  M6OneTurnAgentResultV1,
} from "./m6-one-turn-agent.js";

const hash = (character: string) => asSha256DigestV1(character.repeat(64));

const assignmentId = "m6-assignment:0123456789abcdef01234567";
const patch = {
  schemaVersion: 1 as const,
  artifactId: `m6-artifact:${"c".repeat(64)}`,
  rawSha256: hash("c"),
  byteLength: 42,
};
const patchIdentity = {
  schemaVersion: 1 as const,
  baselineSelectedTreeSha256: hash("a"),
  candidateSelectedTreeSha256: hash("b"),
  patchSha256: hash("c"),
  byteLength: 42,
};
const workflowInput = {
  schemaVersion: 1,
  assignmentId,
  agentTurnCount: 1,
  agentLoopStatus: "completed",
  baselineSelectedTreeSha256: hash("a"),
  patchIdentity,
  patchObservedAt: "2026-08-14T00:00:05.000Z",
  patchAdmissible: true,
  patchRoundTripVerified: true,
  sourceObservations: [],
  executions: [],
  taskCleanupProven: true,
} as unknown as ExternalHiddenFixWorkflowInputV1;

const request = { assignmentId } as M6OneTurnAgentRequestV1;
const attemptBinding = {
  schemaVersion: 1 as const,
  assignmentId,
  agentProjectionContentSha256: hash("1"),
  publicTaskSpecSha256: hash("2"),
  taskId: "task:m6-one-turn-adapter",
  provider: "test-provider",
  model: "test-model",
  thinkingLevel: "max" as const,
  agentBudgetSha256: hash("3"),
  workspaceBaselineSelectedTreeSha256: hash("a"),
  taskBlindAdapterSha256: hash("4"),
  admittedToolSetSha256: hash("5"),
  sandboxRealizationSha256: hash("6"),
};

const createFixture = (status: M6OneTurnAgentResultV1["status"]) => {
  const cleanupTask = vi.fn(async () => ({
    proven: true,
    receiptSha256: hash("f"),
  }));
  const productPort = { cleanupTask } as unknown as M6OneTurnAgentPortV1;
  const result = {
    status,
    agentLoopStatus: status === "agent_failed" ? "timed_out" : "completed",
    taskCleanupProven: true,
    taskCleanupReceiptSha256: hash("f"),
    ...(status === "workflow_ready"
      ? { patch, patchIdentity, workflowInput }
      : {}),
  } as unknown as M6OneTurnAgentResultV1;
  const runOneTurn = vi.fn(
    async (_request: M6OneTurnAgentRequestV1, port: M6OneTurnAgentPortV1) => {
      await port.cleanupTask();
      return result;
    },
  );
  const adapter = createM6OneTurnLocalGateAgentPortV1(
    { request, port: productPort, attemptBinding },
    { runOneTurn },
  );
  return { adapter, cleanupTask, runOneTurn };
};

describe("M6 one-turn local Gate adapter", () => {
  it("maps one frozen candidate and returns the already-recorded cleanup", async () => {
    const fixture = createFixture("workflow_ready");
    await expect(fixture.adapter.runOnce()).resolves.toEqual({
      status: "completed",
    });
    const candidate = await fixture.adapter.freezeCandidate();
    expect(candidate).toMatchObject({
      kind: "candidate",
      patch,
      patchIdentity,
    });
    if (candidate.kind !== "candidate") throw new Error("missing candidate");
    await expect(
      fixture.adapter.collectPublicWorkflowInput(candidate),
    ).resolves.toBe(workflowInput);
    await expect(fixture.adapter.cleanup()).resolves.toEqual({
      proven: true,
      receiptSha256: hash("f"),
    });
    expect(fixture.runOneTurn).toHaveBeenCalledTimes(1);
    expect(fixture.cleanupTask).toHaveBeenCalledTimes(1);
  });

  it("never relaunches an Agent after its single failed attempt", async () => {
    const fixture = createFixture("agent_failed");
    await expect(fixture.adapter.runOnce()).resolves.toEqual({
      status: "timed_out",
    });
    await expect(fixture.adapter.runOnce()).rejects.toThrow(
      "may start only once",
    );
    expect(fixture.runOneTurn).toHaveBeenCalledTimes(1);
    expect(fixture.cleanupTask).toHaveBeenCalledTimes(1);
  });

  it("maps an unchanged workspace to the single no-candidate outcome", async () => {
    const fixture = createFixture("no_candidate");
    await fixture.adapter.runOnce();
    await expect(fixture.adapter.freezeCandidate()).resolves.toEqual({
      kind: "no_candidate",
      reason: "no_patch",
    });
  });
});
