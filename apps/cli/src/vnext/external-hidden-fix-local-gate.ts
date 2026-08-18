import { canonicalJson } from "@chronorift/json-artifacts";

import {
  createExternalHiddenFixWorkflowEvidenceReceiptV1,
  runExternalHiddenFixEvaluatorOnceV1,
  type ExternalHiddenFixAssignmentStoreV1,
  type ExternalHiddenFixFreshCopyRunnerV1,
  type ExternalHiddenFixAgentAttemptBindingV1,
  type ExternalHiddenFixWorkflowCheckV1,
} from "./external-hidden-fix.js";
import {
  ExternalHiddenFixWorkflowAuditV1Schema,
  checkExternalHiddenFixWorkflowV1,
  createExternalHiddenFixWorkflowAuditV1,
  type ExternalHiddenFixWorkflowInputV1,
} from "./external-hidden-fix-workflow.js";
import {
  runExternalHiddenFixGateV1,
  type ExternalHiddenFixAgentResultV1,
  type ExternalHiddenFixCandidateResultV1,
  type ExternalHiddenFixGateCleanupV1,
} from "./external-hidden-fix-gate.js";

const EMPTY_WORKFLOW_CHECKS = Object.freeze(
  Object.fromEntries(
    [
      "single_agent_turn",
      "baseline_execution_before_host_observed_source_change",
      "candidate_patch_frozen",
      "patch_round_trip_verified",
      "candidate_rerun_observed",
      "execution_lineage_valid",
      "cleanup_proven",
    ].map((check) => [
      check,
      Object.freeze({ satisfied: false, evidenceSha256: null }),
    ]),
  ),
) as Readonly<
  Record<
    ExternalHiddenFixWorkflowCheckV1,
    { readonly satisfied: boolean; readonly evidenceSha256: null }
  >
>;

export interface ExternalHiddenFixLocalGateAgentPortV1 {
  readonly assignmentId: string;
  readonly attemptBinding: ExternalHiddenFixAgentAttemptBindingV1;
  /** Starts the only Agent attempt for this assignment. */
  readonly runOnce: () => Promise<ExternalHiddenFixAgentResultV1>;
  /** Freezes the sole candidate after the Agent loop terminates. */
  readonly freezeCandidate: () => Promise<ExternalHiddenFixCandidateResultV1>;
  /** Reads only public Task/runtime records and Host boundary observations. */
  readonly collectPublicWorkflowInput: (
    candidate: Extract<
      ExternalHiddenFixCandidateResultV1,
      { readonly kind: "candidate" }
    >,
  ) => Promise<ExternalHiddenFixWorkflowInputV1>;
  readonly cleanup: () => Promise<ExternalHiddenFixGateCleanupV1>;
}

/**
 * Concrete local composition around the create-once assignment store. The
 * hidden evaluator persists its own receipt before returning; the product
 * Agent Task never receives that receipt, the assignment baseline path, or
 * evaluator inputs.
 */
export async function runExternalHiddenFixLocalGateV1(input: {
  readonly assignmentId: string;
  readonly store: ExternalHiddenFixAssignmentStoreV1;
  readonly agent: ExternalHiddenFixLocalGateAgentPortV1;
  readonly evaluator: ExternalHiddenFixFreshCopyRunnerV1;
  readonly now?: () => string;
}) {
  if (
    input.agent.assignmentId !== input.assignmentId ||
    input.agent.attemptBinding.assignmentId !== input.assignmentId
  ) {
    throw new Error("M6 local Gate Agent port crossed its assignment");
  }
  const now = input.now ?? (() => new Date().toISOString());
  return runExternalHiddenFixGateV1({
    assignmentId: input.assignmentId,
    port: {
      recordStartedOnce: async () => {
        await input.store.beginAttemptOnce({
          binding: input.agent.attemptBinding,
          startedAt: now(),
        });
      },
      runAgentOnce: input.agent.runOnce,
      freezeCandidate: input.agent.freezeCandidate,
      checkPublicWorkflow: async (candidate) => {
        try {
          const workflowInput =
            await input.agent.collectPublicWorkflowInput(candidate);
          if (workflowInput.assignmentId !== input.assignmentId) {
            throw new Error("M6 public workflow input crossed its assignment");
          }
          const workflowReceipt =
            checkExternalHiddenFixWorkflowV1(workflowInput);
          const workflowAudit = createExternalHiddenFixWorkflowAuditV1({
            workflowInput,
            workflowReceipt,
          });
          await input.store.putWorkflowAuditOnce({
            assignmentId: input.assignmentId,
            audit: workflowAudit,
            parse: (value) =>
              ExternalHiddenFixWorkflowAuditV1Schema.parse(value),
          });
          return workflowReceipt;
        } catch {
          return createExternalHiddenFixWorkflowEvidenceReceiptV1({
            assignmentId: input.assignmentId,
            patchIdentity: candidate.patchIdentity,
            checks: EMPTY_WORKFLOW_CHECKS,
            infrastructureFailureCode: "task_records_unavailable",
          });
        }
      },
      persistWorkflowReceiptOnce: (receipt) =>
        input.store.putWorkflowReceiptOnce(receipt, (value) =>
          ExternalHiddenFixWorkflowAuditV1Schema.parse(value),
        ),
      runFreshCopyEvaluatorOnce: (request) =>
        runExternalHiddenFixEvaluatorOnceV1({
          store: input.store,
          request,
          runner: input.evaluator,
        }),
      confirmEvaluatorReceiptPersisted: async (receipt) => {
        const stored = await input.store.readEvaluatorReceipt(
          receipt.assignmentId,
        );
        if (canonicalJson(stored) !== canonicalJson(receipt)) {
          throw new Error(
            "M6 evaluator returned a receipt different from its durable result",
          );
        }
      },
      cleanup: input.agent.cleanup,
      persistTerminalOnce: (terminal) => input.store.putTerminalOnce(terminal),
      now,
    },
  });
}
