import { asSha256DigestV1 } from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import {
  ExternalHiddenFixWorkflowAuditV1Schema,
  ExternalHiddenFixWorkflowInputV1Schema,
  checkExternalHiddenFixWorkflowV1,
  createExternalHiddenFixWorkflowAuditV1,
} from "./external-hidden-fix-workflow.js";

const hash = (character: string) => asSha256DigestV1(character.repeat(64));

const fixture = () => ({
  schemaVersion: 1 as const,
  assignmentId: "m6-assignment:0123456789abcdef01234567",
  agentTurnCount: 1,
  agentLoopStatus: "completed" as const,
  baselineSelectedTreeSha256: hash("a"),
  patchIdentity: {
    schemaVersion: 1 as const,
    baselineSelectedTreeSha256: hash("a"),
    candidateSelectedTreeSha256: hash("b"),
    patchSha256: hash("c"),
    byteLength: 42,
  },
  patchObservedAt: "2026-08-14T00:00:05.000Z",
  patchAdmissible: true,
  patchRoundTripVerified: true,
  sourceObservations: [
    {
      schemaVersion: 1 as const,
      boundary: "initial_materialization" as const,
      sourceSha256: hash("a"),
      buildId: null,
      observedAt: "2026-08-14T00:00:00.000Z",
    },
    {
      schemaVersion: 1 as const,
      boundary: "game_build_freeze" as const,
      sourceSha256: hash("a"),
      buildId: "build.baseline",
      observedAt: "2026-08-14T00:00:01.000Z",
    },
    {
      schemaVersion: 1 as const,
      boundary: "game_build_freeze" as const,
      sourceSha256: hash("b"),
      buildId: "build.candidate",
      observedAt: "2026-08-14T00:00:03.000Z",
    },
    {
      schemaVersion: 1 as const,
      boundary: "patch_freeze" as const,
      sourceSha256: hash("b"),
      buildId: null,
      observedAt: "2026-08-14T00:00:05.000Z",
    },
  ],
  executions: [
    {
      schemaVersion: 1 as const,
      executionId: "execution.baseline",
      buildId: "build.baseline",
      sourceSha256: hash("a"),
      startedAt: "2026-08-14T00:00:01.100Z",
      endedAt: "2026-08-14T00:00:02.000Z",
      sealed: true,
      coverageComplete: true,
      cleanupProven: true,
      publicSymptomObserved: true,
      publicObservationSha256: hash("d"),
    },
    {
      schemaVersion: 1 as const,
      executionId: "execution.candidate",
      buildId: "build.candidate",
      sourceSha256: hash("b"),
      startedAt: "2026-08-14T00:00:03.100Z",
      endedAt: "2026-08-14T00:00:04.000Z",
      sealed: true,
      coverageComplete: true,
      cleanupProven: true,
      publicSymptomObserved: false,
      publicObservationSha256: hash("e"),
    },
  ],
  taskCleanupProven: true,
});

describe("M6 public workflow checker", () => {
  it("accepts a baseline execution completed before the first Host-observed changed source", () => {
    const receipt = checkExternalHiddenFixWorkflowV1(fixture());
    expect(receipt.outcome).toBe("verified");
    expect(receipt.checks.every((check) => check.satisfied)).toBe(true);
  });

  it("rejects a baseline that completes after the Host first observes changed source", () => {
    const input = fixture();
    const baselineExecution = input.executions[0];
    if (baselineExecution === undefined)
      throw new Error("missing baseline fixture");
    input.executions[0] = {
      ...baselineExecution,
      endedAt: "2026-08-14T00:00:03.500Z",
    };
    const receipt = checkExternalHiddenFixWorkflowV1(input);
    expect(receipt.outcome).toBe("rejected");
    expect(
      receipt.checks.find(
        (check) =>
          check.check ===
          "baseline_execution_before_host_observed_source_change",
      )?.satisfied,
    ).toBe(false);
  });

  it("rejects an extra hidden-evaluator field before checking records", () => {
    expect(() =>
      ExternalHiddenFixWorkflowInputV1Schema.parse({
        ...fixture(),
        evaluatorReceipt: { outcome: "accepted" },
      }),
    ).toThrow();
  });

  it("requires the candidate rerun to use the exact frozen candidate source", () => {
    const input = fixture();
    const candidateExecution = input.executions[1];
    if (candidateExecution === undefined)
      throw new Error("missing candidate fixture");
    input.executions[1] = {
      ...candidateExecution,
      sourceSha256: hash("f"),
    };
    const receipt = checkExternalHiddenFixWorkflowV1(input);
    expect(receipt.outcome).toBe("rejected");
    expect(
      receipt.checks.find((check) => check.check === "candidate_rerun_observed")
        ?.satisfied,
    ).toBe(false);
  });

  it("requires the candidate rerun to finish before the patch is frozen", () => {
    const input = fixture();
    const candidateExecution = input.executions[1];
    if (candidateExecution === undefined)
      throw new Error("missing candidate fixture");
    input.executions[1] = {
      ...candidateExecution,
      endedAt: "2026-08-14T00:00:06.000Z",
    };
    const receipt = checkExternalHiddenFixWorkflowV1(input);
    expect(receipt.outcome).toBe("rejected");
    expect(
      receipt.checks.find((check) => check.check === "candidate_rerun_observed")
        ?.satisfied,
    ).toBe(false);
  });

  it("retains the public facts needed to diagnose rejected workflow checks", () => {
    const input = fixture();
    const baselineExecution = input.executions[0];
    if (baselineExecution === undefined)
      throw new Error("missing baseline fixture");
    input.executions = [
      {
        ...baselineExecution,
        coverageComplete: false,
      },
    ];
    const receipt = checkExternalHiddenFixWorkflowV1(input);
    const audit = createExternalHiddenFixWorkflowAuditV1({
      workflowInput: input,
      workflowReceipt: receipt,
    });
    const reparsed = ExternalHiddenFixWorkflowAuditV1Schema.parse(audit);

    expect(receipt.outcome).toBe("rejected");
    expect(
      receipt.checks.find((entry) => entry.check === "candidate_rerun_observed")
        ?.satisfied,
    ).toBe(false);
    expect(reparsed.workflowInput.executions).toEqual(input.executions);
    expect(reparsed.workflowInput.executions[0]).toMatchObject({
      coverageComplete: false,
      cleanupProven: true,
    });
    expect(checkExternalHiddenFixWorkflowV1(reparsed.workflowInput)).toEqual(
      receipt,
    );
    expect(reparsed.workflowReceiptContentSha256).toBe(
      receipt.receiptContentSha256,
    );
  });
});
