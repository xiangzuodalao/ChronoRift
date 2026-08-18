import { asSha256DigestV1 } from "@chronorift/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createExternalHiddenFixFreshCopyAcceptanceReceiptV1,
  createExternalHiddenFixFreshEvaluationPlanV1,
  createExternalHiddenFixWorkflowEvidenceReceiptV1,
  type ExternalHiddenFixEvaluationRequestV1,
  type ExternalHiddenFixFreshCopyAcceptanceReceiptV1,
  type ExternalHiddenFixFreshRunReceiptV1,
} from "./external-hidden-fix.js";
import {
  runExternalHiddenFixGateV1,
  type ExternalHiddenFixGatePortV1,
} from "./external-hidden-fix-gate.js";

const hash = (character: string) => asSha256DigestV1(character.repeat(64));
const assignmentId = "m6-assignment:0123456789abcdef01234567";

const workflow = (candidateRerunSatisfied = true) =>
  createExternalHiddenFixWorkflowEvidenceReceiptV1({
    assignmentId,
    patchIdentity,
    checks: {
      single_agent_turn: { satisfied: true, evidenceSha256: hash("1") },
      baseline_execution_before_host_observed_source_change: {
        satisfied: true,
        evidenceSha256: hash("2"),
      },
      candidate_patch_frozen: { satisfied: true, evidenceSha256: hash("3") },
      patch_round_trip_verified: {
        satisfied: true,
        evidenceSha256: hash("4"),
      },
      candidate_rerun_observed: {
        satisfied: candidateRerunSatisfied,
        evidenceSha256: hash("5"),
      },
      execution_lineage_valid: {
        satisfied: true,
        evidenceSha256: hash("6"),
      },
      cleanup_proven: { satisfied: true, evidenceSha256: hash("7") },
    },
    infrastructureFailureCode: null,
  });

const patch = {
  schemaVersion: 1 as const,
  artifactId: `m6-artifact:${hash("a")}`,
  rawSha256: hash("b"),
  byteLength: 100,
};
const patchIdentity = {
  schemaVersion: 1 as const,
  baselineSelectedTreeSha256: hash("c"),
  candidateSelectedTreeSha256: hash("d"),
  patchSha256: patch.rawSha256,
  byteLength: patch.byteLength,
};

const acceptedRuns = (
  rejectedOrdinal?: number,
): readonly ExternalHiddenFixFreshRunReceiptV1[] => {
  return createExternalHiddenFixFreshEvaluationPlanV1(assignmentId).map(
    (entry) => ({
      schemaVersion: 1 as const,
      assignmentId,
      freshCopyId: entry.freshCopyId,
      ordinal: entry.ordinal,
      scenarioClass: entry.scenarioClass,
      repetition: entry.repetition,
      baselineSelectedTreeSha256: patchIdentity.baselineSelectedTreeSha256,
      candidateSelectedTreeSha256: patchIdentity.candidateSelectedTreeSha256,
      patchSha256: patchIdentity.patchSha256,
      freshWorkspaceCreated: true as const,
      freshImportCacheCreated: true as const,
      freshProcessStarted: true as const,
      outcome:
        entry.ordinal === rejectedOrdinal
          ? ("failed" as const)
          : ("passed" as const),
      observationSha256: hash(String(entry.ordinal % 10)),
      cleanupProven: true,
    }),
  );
};

const port = (): ExternalHiddenFixGatePortV1 => {
  let evaluatorRequestHash = hash("f");
  return {
    recordStartedOnce: vi.fn(async () => undefined),
    runAgentOnce: vi.fn(async () => ({ status: "completed" as const })),
    freezeCandidate: vi.fn(async () => ({
      kind: "candidate" as const,
      patch,
      patchIdentity,
      expectedCandidateSelectedTreeSha256:
        patchIdentity.candidateSelectedTreeSha256,
    })),
    checkPublicWorkflow: vi.fn(async () => workflow()),
    persistWorkflowReceiptOnce: vi.fn(async () => undefined),
    runFreshCopyEvaluatorOnce: vi.fn(
      async (request: ExternalHiddenFixEvaluationRequestV1) => {
        evaluatorRequestHash = request.requestContentSha256;
        return createExternalHiddenFixFreshCopyAcceptanceReceiptV1({
          assignmentId,
          requestContentSha256: request.requestContentSha256,
          baselineSelectedTreeSha256: patchIdentity.baselineSelectedTreeSha256,
          expectedCandidateSelectedTreeSha256:
            patchIdentity.candidateSelectedTreeSha256,
          patchSha256: patchIdentity.patchSha256,
          evaluatorImplementationSha256: hash("e"),
          evaluatorBundleSha256: hash("f"),
          completedRuns: acceptedRuns(),
          infrastructureFailureCode: null,
          cleanupProven: true,
        });
      },
    ),
    confirmEvaluatorReceiptPersisted: vi.fn(
      async (receipt: ExternalHiddenFixFreshCopyAcceptanceReceiptV1) => {
        expect(receipt.requestContentSha256).toBe(evaluatorRequestHash);
      },
    ),
    cleanup: vi.fn(async () => ({
      proven: true,
      receiptSha256: hash("9"),
    })),
    persistTerminalOnce: vi.fn(async () => undefined),
    now: () => "2026-08-14T00:00:10.000Z",
  };
};

describe("M6 one-shot Gate", () => {
  it("runs one Agent and passes only the narrow request to one evaluator", async () => {
    const harness = port();
    const terminal = await runExternalHiddenFixGateV1({
      assignmentId,
      port: harness,
    });
    expect(terminal.outcome).toBe("accepted");
    expect(harness.runAgentOnce).toHaveBeenCalledOnce();
    expect(harness.runFreshCopyEvaluatorOnce).toHaveBeenCalledOnce();
    const request = vi.mocked(harness.runFreshCopyEvaluatorOnce).mock
      .calls[0]?.[0];
    expect(Object.keys(request ?? {}).sort()).toEqual([
      "assignmentId",
      "expectedCandidateSelectedTreeSha256",
      "patch",
      "requestContentSha256",
      "requestKind",
      "schemaVersion",
    ]);
  });

  it("retains Agent failure and never invokes candidate or evaluator", async () => {
    const harness = port();
    vi.mocked(harness.runAgentOnce).mockResolvedValue({
      status: "provider_failure",
    });
    const terminal = await runExternalHiddenFixGateV1({
      assignmentId,
      port: harness,
    });
    expect(terminal).toMatchObject({
      outcome: "agent_failed",
      agentFailureCode: "provider_failure",
    });
    expect(harness.freezeCandidate).not.toHaveBeenCalled();
    expect(harness.runFreshCopyEvaluatorOnce).not.toHaveBeenCalled();
  });

  it("cleanup failure overrides while retaining the primary outcome", async () => {
    const harness = port();
    vi.mocked(harness.cleanup).mockResolvedValue({
      proven: false,
      receiptSha256: hash("8"),
    });
    const terminal = await runExternalHiddenFixGateV1({
      assignmentId,
      port: harness,
    });
    expect(terminal).toMatchObject({
      outcome: "cleanup_failed",
      primaryOutcome: "accepted",
    });
  });

  it("treats unproven evaluator cleanup as the terminal cleanup failure", async () => {
    const harness = port();
    vi.mocked(harness.runFreshCopyEvaluatorOnce).mockImplementation(
      async (request) =>
        createExternalHiddenFixFreshCopyAcceptanceReceiptV1({
          assignmentId,
          requestContentSha256: request.requestContentSha256,
          baselineSelectedTreeSha256: patchIdentity.baselineSelectedTreeSha256,
          expectedCandidateSelectedTreeSha256:
            patchIdentity.candidateSelectedTreeSha256,
          patchSha256: patchIdentity.patchSha256,
          evaluatorImplementationSha256: hash("e"),
          evaluatorBundleSha256: hash("f"),
          completedRuns: [],
          infrastructureFailureCode: "cleanup_failed",
          cleanupProven: false,
        }),
    );
    vi.mocked(harness.confirmEvaluatorReceiptPersisted).mockResolvedValue();

    const terminal = await runExternalHiddenFixGateV1({
      assignmentId,
      port: harness,
    });

    expect(terminal).toMatchObject({
      outcome: "cleanup_failed",
      primaryOutcome: "infrastructure_failed",
    });
  });

  it("retains a no-candidate denominator result and never runs the evaluator", async () => {
    const harness = port();
    vi.mocked(harness.freezeCandidate).mockResolvedValue({
      kind: "no_candidate",
      reason: "no_patch",
    });

    const terminal = await runExternalHiddenFixGateV1({
      assignmentId,
      port: harness,
    });

    expect(terminal).toMatchObject({
      outcome: "no_candidate",
      noCandidateReason: "no_patch",
    });
    expect(harness.runAgentOnce).toHaveBeenCalledOnce();
    expect(harness.runFreshCopyEvaluatorOnce).not.toHaveBeenCalled();
  });

  it("does not let hidden evaluation replace a public workflow rejection", async () => {
    const harness = port();
    vi.mocked(harness.checkPublicWorkflow).mockResolvedValue(workflow(false));

    const terminal = await runExternalHiddenFixGateV1({
      assignmentId,
      port: harness,
    });

    expect(terminal.outcome).toBe("workflow_rejected");
    expect(harness.runFreshCopyEvaluatorOnce).not.toHaveBeenCalled();
  });

  it("preserves a completed hidden evaluator rejection", async () => {
    const harness = port();
    vi.mocked(harness.runFreshCopyEvaluatorOnce).mockImplementation(
      async (request) =>
        createExternalHiddenFixFreshCopyAcceptanceReceiptV1({
          assignmentId,
          requestContentSha256: request.requestContentSha256,
          baselineSelectedTreeSha256: patchIdentity.baselineSelectedTreeSha256,
          expectedCandidateSelectedTreeSha256:
            patchIdentity.candidateSelectedTreeSha256,
          patchSha256: patchIdentity.patchSha256,
          evaluatorImplementationSha256: hash("e"),
          evaluatorBundleSha256: hash("f"),
          completedRuns: acceptedRuns(4),
          infrastructureFailureCode: null,
          cleanupProven: true,
        }),
    );
    vi.mocked(harness.confirmEvaluatorReceiptPersisted).mockResolvedValue();

    const terminal = await runExternalHiddenFixGateV1({
      assignmentId,
      port: harness,
    });

    expect(terminal.outcome).toBe("evaluator_rejected");
    expect(harness.runAgentOnce).toHaveBeenCalledOnce();
    expect(harness.runFreshCopyEvaluatorOnce).toHaveBeenCalledOnce();
  });

  it("keeps the Agent failure reason when final cleanup also fails", async () => {
    const harness = port();
    vi.mocked(harness.runAgentOnce).mockResolvedValue({ status: "timed_out" });
    vi.mocked(harness.cleanup).mockResolvedValue({
      proven: false,
      receiptSha256: hash("8"),
    });

    const terminal = await runExternalHiddenFixGateV1({
      assignmentId,
      port: harness,
    });

    expect(terminal).toMatchObject({
      outcome: "cleanup_failed",
      primaryOutcome: "agent_failed",
      agentFailureCode: "timed_out",
    });
    expect(harness.runAgentOnce).toHaveBeenCalledOnce();
  });
});
