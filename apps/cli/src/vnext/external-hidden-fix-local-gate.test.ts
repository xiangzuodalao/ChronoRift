import { asSha256DigestV1 } from "@chronorift/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createExternalHiddenFixFreshEvaluationPlanV1,
  type ExternalHiddenFixAssignmentStoreV1,
  type ExternalHiddenFixFreshCopyRunInputV1,
  type ExternalHiddenFixFreshCopyRunnerV1,
  type ExternalHiddenFixFreshRunReceiptV1,
} from "./external-hidden-fix.js";
import { runExternalHiddenFixLocalGateV1 } from "./external-hidden-fix-local-gate.js";

const digest = (character: string) => asSha256DigestV1(character.repeat(64));
const assignmentId = "m6-assignment:0123456789abcdef01234567";

describe("M6 stored local Gate composition", () => {
  it("claims one attempt, retains evaluator output, and never relaunches the Agent", async () => {
    const patch = {
      schemaVersion: 1 as const,
      artifactId: `m6-artifact:${digest("a")}`,
      rawSha256: digest("b"),
      byteLength: 32,
    };
    const baseline = digest("c");
    const candidate = digest("d");
    let storedEvaluator: unknown;
    const beginAttemptOnce = vi.fn(async () => undefined);
    const putWorkflowAuditOnce = vi
      .fn<(input: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);
    const putWorkflowReceiptOnce = vi.fn(async () => undefined);
    const putTerminalOnce = vi.fn(async () => undefined);
    const store = {
      beginAttemptOnce,
      putWorkflowAuditOnce,
      putWorkflowReceiptOnce,
      claimEvaluatorRequestOnce: vi.fn(async () => ({
        assignmentId,
        mutatedBaselineSelectedTreeSha256: baseline,
        evaluatorImplementationSha256: digest("e"),
        evaluatorBundleSha256: digest("f"),
        baselineRoot: "/protected/baseline",
        evaluatorImplementationPath: "/protected/evaluator.mjs",
        evaluatorBundlePath: "/protected/evaluator.json",
      })),
      putEvaluatorReceiptOnce: vi.fn(async (receipt) => {
        storedEvaluator = receipt;
      }),
      readEvaluatorReceipt: vi.fn(async () => storedEvaluator),
      putTerminalOnce,
    } as unknown as ExternalHiddenFixAssignmentStoreV1;
    const agent = {
      assignmentId,
      attemptBinding: {
        schemaVersion: 1 as const,
        assignmentId,
        agentProjectionContentSha256: digest("1"),
        publicTaskSpecSha256: digest("2"),
        taskId: "task:m6-local-gate",
        provider: "test-provider",
        model: "test-model",
        thinkingLevel: "max" as const,
        agentBudgetSha256: digest("3"),
        workspaceBaselineSelectedTreeSha256: baseline,
        taskBlindAdapterSha256: digest("4"),
        admittedToolSetSha256: digest("5"),
        sandboxRealizationSha256: digest("6"),
      },
      runOnce: vi.fn(async () => ({ status: "completed" as const })),
      freezeCandidate: vi.fn(async () => ({
        kind: "candidate" as const,
        patch,
        patchIdentity: {
          schemaVersion: 1 as const,
          baselineSelectedTreeSha256: baseline,
          candidateSelectedTreeSha256: candidate,
          patchSha256: patch.rawSha256,
          byteLength: patch.byteLength,
        },
        expectedCandidateSelectedTreeSha256: candidate,
      })),
      collectPublicWorkflowInput: vi.fn(async () => ({
        schemaVersion: 1 as const,
        assignmentId,
        agentTurnCount: 1,
        agentLoopStatus: "completed" as const,
        baselineSelectedTreeSha256: baseline,
        patchIdentity: {
          schemaVersion: 1 as const,
          baselineSelectedTreeSha256: baseline,
          candidateSelectedTreeSha256: candidate,
          patchSha256: patch.rawSha256,
          byteLength: patch.byteLength,
        },
        patchObservedAt: "2026-08-14T00:00:05.000Z",
        patchAdmissible: true,
        patchRoundTripVerified: true,
        sourceObservations: [
          {
            schemaVersion: 1 as const,
            boundary: "initial_materialization" as const,
            sourceSha256: baseline,
            buildId: null,
            observedAt: "2026-08-14T00:00:00.000Z",
          },
          {
            schemaVersion: 1 as const,
            boundary: "game_build_freeze" as const,
            sourceSha256: baseline,
            buildId: "build:baseline",
            observedAt: "2026-08-14T00:00:01.000Z",
          },
          {
            schemaVersion: 1 as const,
            boundary: "game_build_freeze" as const,
            sourceSha256: candidate,
            buildId: "build:candidate",
            observedAt: "2026-08-14T00:00:03.000Z",
          },
          {
            schemaVersion: 1 as const,
            boundary: "patch_freeze" as const,
            sourceSha256: candidate,
            buildId: null,
            observedAt: "2026-08-14T00:00:05.000Z",
          },
        ],
        executions: [
          {
            schemaVersion: 1 as const,
            executionId: "execution:baseline",
            buildId: "build:baseline",
            sourceSha256: baseline,
            startedAt: "2026-08-14T00:00:01.100Z",
            endedAt: "2026-08-14T00:00:02.000Z",
            sealed: true,
            coverageComplete: true,
            cleanupProven: true,
            publicSymptomObserved: true,
            publicObservationSha256: digest("1"),
          },
          {
            schemaVersion: 1 as const,
            executionId: "execution:candidate",
            buildId: "build:candidate",
            sourceSha256: candidate,
            startedAt: "2026-08-14T00:00:03.100Z",
            endedAt: "2026-08-14T00:00:04.000Z",
            sealed: true,
            coverageComplete: true,
            cleanupProven: true,
            publicSymptomObserved: false,
            publicObservationSha256: digest("2"),
          },
        ],
        taskCleanupProven: true,
      })),
      cleanup: vi.fn(async () => ({
        proven: true,
        receiptSha256: digest("9"),
      })),
    };
    const runFreshCopy = vi.fn(
      async (run: ExternalHiddenFixFreshCopyRunInputV1) => {
        const receipt: ExternalHiddenFixFreshRunReceiptV1 = {
          schemaVersion: 1,
          assignmentId,
          freshCopyId: run.plan.freshCopyId,
          ordinal: run.plan.ordinal,
          scenarioClass: run.plan.scenarioClass,
          repetition: run.plan.repetition,
          baselineSelectedTreeSha256: baseline,
          candidateSelectedTreeSha256: candidate,
          patchSha256: patch.rawSha256,
          freshWorkspaceCreated: true,
          freshImportCacheCreated: true,
          freshProcessStarted: true,
          outcome: "passed",
          observationSha256: digest(String(run.plan.ordinal % 10)),
          cleanupProven: true,
        };
        return receipt;
      },
    );
    const evaluator: ExternalHiddenFixFreshCopyRunnerV1 = {
      runFreshCopy,
    };

    const terminal = await runExternalHiddenFixLocalGateV1({
      assignmentId,
      store,
      agent,
      evaluator,
      now: () => "2026-08-14T00:00:00.000Z",
    });

    expect(terminal.outcome).toBe("accepted");
    expect(agent.runOnce).toHaveBeenCalledOnce();
    expect(runFreshCopy).toHaveBeenCalledTimes(9);
    expect(beginAttemptOnce).toHaveBeenCalledOnce();
    expect(putWorkflowAuditOnce).toHaveBeenCalledOnce();
    expect(putTerminalOnce).toHaveBeenCalledOnce();
    expect(
      createExternalHiddenFixFreshEvaluationPlanV1(assignmentId),
    ).toHaveLength(9);

    const initialWorkflowCall =
      agent.collectPublicWorkflowInput.mock.results[0];
    if (initialWorkflowCall?.type !== "return") {
      throw new Error("missing public workflow input call");
    }
    const publicWorkflowInput = await initialWorkflowCall.value;
    const rejectedAssignmentId = "m6-assignment:0123456789abcdef01234568";
    const rejectedAgent = {
      ...agent,
      assignmentId: rejectedAssignmentId,
      attemptBinding: {
        ...agent.attemptBinding,
        assignmentId: rejectedAssignmentId,
      },
      runOnce: vi.fn(async () => ({ status: "completed" as const })),
      freezeCandidate: vi.fn(async () => ({
        kind: "candidate" as const,
        patch,
        patchIdentity: {
          schemaVersion: 1 as const,
          baselineSelectedTreeSha256: baseline,
          candidateSelectedTreeSha256: candidate,
          patchSha256: patch.rawSha256,
          byteLength: patch.byteLength,
        },
        expectedCandidateSelectedTreeSha256: candidate,
      })),
      collectPublicWorkflowInput: vi.fn(async () => ({
        ...publicWorkflowInput,
        assignmentId: rejectedAssignmentId,
        executions: publicWorkflowInput.executions.slice(0, 1),
      })),
      cleanup: vi.fn(async () => ({
        proven: true,
        receiptSha256: digest("8"),
      })),
    };
    beginAttemptOnce.mockClear();
    putWorkflowAuditOnce.mockClear();
    putWorkflowReceiptOnce.mockClear();
    putTerminalOnce.mockClear();
    runFreshCopy.mockClear();

    const rejectedTerminal = await runExternalHiddenFixLocalGateV1({
      assignmentId: rejectedAssignmentId,
      store,
      agent: rejectedAgent,
      evaluator,
      now: () => "2026-08-14T00:00:10.000Z",
    });

    expect(rejectedTerminal.outcome).toBe("workflow_rejected");
    expect(rejectedAgent.runOnce).toHaveBeenCalledOnce();
    expect(putWorkflowAuditOnce).toHaveBeenCalledOnce();
    expect(putWorkflowReceiptOnce).toHaveBeenCalledOnce();
    expect(putTerminalOnce).toHaveBeenCalledOnce();
    expect(runFreshCopy).not.toHaveBeenCalled();
    expect(putWorkflowAuditOnce.mock.calls[0]?.[0]).toMatchObject({
      assignmentId: rejectedAssignmentId,
      audit: {
        recordKind: "external-hidden-fix-workflow-audit",
        workflowInput: { executions: [publicWorkflowInput.executions[0]] },
      },
    });
  });
});
