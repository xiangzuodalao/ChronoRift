import { z } from "zod";

import { Sha256DigestV1Schema, type Sha256DigestV1 } from "@chronorift/domain";

import {
  ExternalHiddenFixFreshCopyAcceptanceReceiptV1Schema,
  ExternalHiddenFixPatchIdentityV1Schema,
  ExternalHiddenFixPatchReferenceV1Schema,
  ExternalHiddenFixWorkflowEvidenceReceiptV1Schema,
  createExternalHiddenFixEvaluationRequestV1,
  createExternalHiddenFixTerminalRecordV1,
  type ExternalHiddenFixEvaluationRequestV1,
  type ExternalHiddenFixFreshCopyAcceptanceReceiptV1,
  type ExternalHiddenFixTerminalOutcomeV1,
  type ExternalHiddenFixTerminalRecordV1,
  type ExternalHiddenFixWorkflowEvidenceReceiptV1,
} from "./external-hidden-fix.js";

const agentResultSchema = z
  .object({
    status: z.enum(["completed", "provider_failure", "timed_out", "aborted"]),
  })
  .strict();

const candidateResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("candidate"),
      patch: ExternalHiddenFixPatchReferenceV1Schema,
      patchIdentity: ExternalHiddenFixPatchIdentityV1Schema,
      expectedCandidateSelectedTreeSha256:
        ExternalHiddenFixPatchIdentityV1Schema.shape
          .candidateSelectedTreeSha256,
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.expectedCandidateSelectedTreeSha256 !==
        value.patchIdentity.candidateSelectedTreeSha256
      ) {
        context.addIssue({
          code: "custom",
          path: ["expectedCandidateSelectedTreeSha256"],
          message: "candidate expectation must match the frozen patch identity",
        });
      }
      if (
        value.patch.rawSha256 !== value.patchIdentity.patchSha256 ||
        value.patch.byteLength !== value.patchIdentity.byteLength
      ) {
        context.addIssue({
          code: "custom",
          path: ["patch"],
          message: "candidate patch bytes must match the frozen patch identity",
        });
      }
    }),
  z
    .object({
      kind: z.literal("no_candidate"),
      reason: z.enum(["no_patch", "empty_patch", "inadmissible_patch"]),
    })
    .strict(),
]);

export type ExternalHiddenFixAgentResultV1 = z.infer<typeof agentResultSchema>;
export type ExternalHiddenFixCandidateResultV1 = z.infer<
  typeof candidateResultSchema
>;

export interface ExternalHiddenFixGateCleanupV1 {
  readonly proven: boolean;
  readonly receiptSha256: Sha256DigestV1 | null;
}

const cleanupSchema = z
  .object({
    proven: z.boolean(),
    receiptSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.proven && value.receiptSha256 === null) {
      context.addIssue({
        code: "custom",
        path: ["receiptSha256"],
        message: "proven M6 cleanup requires a durable cleanup receipt",
      });
    }
  });

export interface ExternalHiddenFixGatePortV1 {
  /** Create-once start persistence. It must reject an already-started assignment. */
  readonly recordStartedOnce: (assignmentId: string) => Promise<void>;
  /** Called exactly once and never from recovery or cleanup. */
  readonly runAgentOnce: () => Promise<ExternalHiddenFixAgentResultV1>;
  readonly freezeCandidate: () => Promise<ExternalHiddenFixCandidateResultV1>;
  readonly checkPublicWorkflow: (
    candidate: Extract<
      ExternalHiddenFixCandidateResultV1,
      { readonly kind: "candidate" }
    >,
  ) => Promise<ExternalHiddenFixWorkflowEvidenceReceiptV1>;
  readonly persistWorkflowReceiptOnce: (
    receipt: ExternalHiddenFixWorkflowEvidenceReceiptV1,
  ) => Promise<void>;
  /** Receives no Agent Task/runtime/workflow inputs. */
  readonly runFreshCopyEvaluatorOnce: (
    request: ExternalHiddenFixEvaluationRequestV1,
  ) => Promise<ExternalHiddenFixFreshCopyAcceptanceReceiptV1>;
  /** The evaluator owns durable retention; this hook verifies that exact receipt. */
  readonly confirmEvaluatorReceiptPersisted: (
    receipt: ExternalHiddenFixFreshCopyAcceptanceReceiptV1,
  ) => Promise<void>;
  readonly cleanup: () => Promise<ExternalHiddenFixGateCleanupV1>;
  readonly persistTerminalOnce: (
    terminal: ExternalHiddenFixTerminalRecordV1,
  ) => Promise<void>;
  readonly now?: () => string;
}

const agentFailureCode = (
  status: Exclude<ExternalHiddenFixAgentResultV1["status"], "completed">,
): "provider_failure" | "timed_out" | "aborted" => status;

/**
 * One registered assignment, one Agent attempt, one candidate, and no retry.
 * The evaluator request is reconstructed here so no workflow object or
 * caller-supplied baseline can cross the acceptance boundary.
 */
export async function runExternalHiddenFixGateV1(input: {
  readonly assignmentId: string;
  readonly port: ExternalHiddenFixGatePortV1;
}): Promise<ExternalHiddenFixTerminalRecordV1> {
  const now = input.port.now ?? (() => new Date().toISOString());
  await input.port.recordStartedOnce(input.assignmentId);

  let primaryOutcome: Exclude<
    ExternalHiddenFixTerminalOutcomeV1,
    "cleanup_failed"
  > = "infrastructure_failed";
  let agentFailure: "provider_failure" | "timed_out" | "aborted" | null = null;
  let noCandidateReason:
    "no_patch" | "empty_patch" | "inadmissible_patch" | null = null;
  let patchSha256: string | null = null;
  let workflowReceiptSha256: string | null = null;
  let evaluatorReceiptSha256: string | null = null;
  let evaluatorCleanupProven = true;
  let cleanup: ExternalHiddenFixGateCleanupV1 = {
    proven: false,
    receiptSha256: null,
  };

  try {
    const agent = agentResultSchema.parse(await input.port.runAgentOnce());
    if (agent.status !== "completed") {
      primaryOutcome = "agent_failed";
      agentFailure = agentFailureCode(agent.status);
    } else {
      const candidate = candidateResultSchema.parse(
        await input.port.freezeCandidate(),
      );
      if (candidate.kind === "no_candidate") {
        primaryOutcome = "no_candidate";
        noCandidateReason = candidate.reason;
      } else {
        patchSha256 = candidate.patch.rawSha256;
        const workflow = ExternalHiddenFixWorkflowEvidenceReceiptV1Schema.parse(
          await input.port.checkPublicWorkflow(candidate),
        );
        if (workflow.assignmentId !== input.assignmentId) {
          throw new Error("M6 workflow receipt crossed its assignment");
        }
        await input.port.persistWorkflowReceiptOnce(workflow);
        workflowReceiptSha256 = workflow.receiptContentSha256;
        if (workflow.outcome === "rejected") {
          primaryOutcome = "workflow_rejected";
        } else if (workflow.outcome === "infrastructure_failed") {
          primaryOutcome = "infrastructure_failed";
        } else {
          const evaluationRequest = createExternalHiddenFixEvaluationRequestV1({
            assignmentId: input.assignmentId,
            patch: candidate.patch,
            expectedCandidateSelectedTreeSha256:
              candidate.expectedCandidateSelectedTreeSha256,
          });
          const acceptance =
            ExternalHiddenFixFreshCopyAcceptanceReceiptV1Schema.parse(
              await input.port.runFreshCopyEvaluatorOnce(evaluationRequest),
            );
          if (
            acceptance.assignmentId !== input.assignmentId ||
            acceptance.requestContentSha256 !==
              evaluationRequest.requestContentSha256
          ) {
            throw new Error("M6 evaluator receipt crossed its request");
          }
          await input.port.confirmEvaluatorReceiptPersisted(acceptance);
          evaluatorReceiptSha256 = acceptance.receiptContentSha256;
          evaluatorCleanupProven = acceptance.cleanupProven;
          primaryOutcome =
            acceptance.outcome === "accepted"
              ? "accepted"
              : acceptance.outcome === "rejected"
                ? "evaluator_rejected"
                : "infrastructure_failed";
        }
      }
    }
  } catch {
    primaryOutcome = "infrastructure_failed";
  } finally {
    try {
      cleanup = cleanupSchema.parse(await input.port.cleanup());
    } catch {
      cleanup = { proven: false, receiptSha256: null };
    }
  }

  const outcome: ExternalHiddenFixTerminalOutcomeV1 =
    cleanup.proven && evaluatorCleanupProven
      ? primaryOutcome
      : "cleanup_failed";
  const terminal = createExternalHiddenFixTerminalRecordV1({
    assignmentId: input.assignmentId,
    outcome,
    agentFailureCode: agentFailure,
    noCandidateReason,
    primaryOutcome: outcome === "cleanup_failed" ? primaryOutcome : null,
    patchSha256,
    workflowReceiptSha256,
    evaluatorReceiptSha256,
    cleanupReceiptSha256: cleanup.receiptSha256,
    completedAt: now(),
  });
  await input.port.persistTerminalOnce(terminal);
  return terminal;
}
