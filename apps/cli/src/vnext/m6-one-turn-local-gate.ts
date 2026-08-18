import { canonicalJson } from "@chronorift/json-artifacts";

import type { ExternalHiddenFixAgentAttemptBindingV1 } from "./external-hidden-fix.js";

import type {
  ExternalHiddenFixAgentResultV1,
  ExternalHiddenFixCandidateResultV1,
} from "./external-hidden-fix-gate.js";
import type { ExternalHiddenFixLocalGateAgentPortV1 } from "./external-hidden-fix-local-gate.js";
import {
  runM6OneTurnAgentV1,
  type M6OneTurnAgentPortV1,
  type M6OneTurnAgentRequestV1,
  type M6OneTurnAgentResultV1,
} from "./m6-one-turn-agent.js";

type RunOneTurnV1 = typeof runM6OneTurnAgentV1;

/**
 * Adapts the exact M6 one-turn orchestration to the create-once local Gate.
 * The underlying runner already performs Task cleanup exactly once. The Gate
 * cleanup hook only returns that frozen result; it never starts another Agent
 * turn or invokes cleanup a second time.
 */
export function createM6OneTurnLocalGateAgentPortV1(
  input: {
    readonly request: M6OneTurnAgentRequestV1;
    readonly port: M6OneTurnAgentPortV1;
    readonly attemptBinding: ExternalHiddenFixAgentAttemptBindingV1;
  },
  dependencies: { readonly runOneTurn?: RunOneTurnV1 } = {},
): ExternalHiddenFixLocalGateAgentPortV1 {
  const runOneTurn = dependencies.runOneTurn ?? runM6OneTurnAgentV1;
  if (input.attemptBinding.assignmentId !== input.request.assignmentId) {
    throw new Error("M6 one-turn request crossed its Agent attempt binding");
  }
  let runStarted = false;
  let result: M6OneTurnAgentResultV1 | undefined;
  let cleanup:
    | {
        readonly proven: boolean;
        readonly receiptSha256: Awaited<
          ReturnType<M6OneTurnAgentPortV1["cleanupTask"]>
        >["receiptSha256"];
      }
    | undefined;

  const wrappedPort: M6OneTurnAgentPortV1 = {
    ...input.port,
    cleanupTask: async () => {
      if (cleanup !== undefined) {
        throw new Error("M6 Task cleanup was requested more than once");
      }
      cleanup = await input.port.cleanupTask();
      return cleanup;
    },
  };

  const requireResult = (): M6OneTurnAgentResultV1 => {
    if (result === undefined) {
      throw new Error("M6 Gate requested candidate data before its Agent turn");
    }
    return result;
  };

  return Object.freeze({
    assignmentId: input.request.assignmentId,
    attemptBinding: input.attemptBinding,
    runOnce: async (): Promise<ExternalHiddenFixAgentResultV1> => {
      if (runStarted) {
        throw new Error("M6 Agent turn may start only once");
      }
      runStarted = true;
      result = await runOneTurn(input.request, wrappedPort);
      if (result.status !== "agent_failed") return { status: "completed" };
      if (result.agentLoopStatus === "completed") {
        throw new Error("M6 agent_failed result reported a completed loop");
      }
      return { status: result.agentLoopStatus };
    },

    freezeCandidate: (): Promise<ExternalHiddenFixCandidateResultV1> =>
      Promise.resolve().then(() => {
        const observed = requireResult();
        if (observed.status === "agent_failed") {
          throw new Error("M6 Agent failure cannot freeze a candidate");
        }
        if (observed.status === "no_candidate") {
          return { kind: "no_candidate", reason: "no_patch" };
        }
        return {
          kind: "candidate",
          patch: observed.patch,
          patchIdentity: observed.patchIdentity,
          expectedCandidateSelectedTreeSha256:
            observed.patchIdentity.candidateSelectedTreeSha256,
        };
      }),

    collectPublicWorkflowInput: (
      candidate: Extract<
        ExternalHiddenFixCandidateResultV1,
        { readonly kind: "candidate" }
      >,
    ) =>
      Promise.resolve().then(() => {
        const observed = requireResult();
        if (
          observed.status !== "workflow_ready" ||
          canonicalJson(candidate.patch) !== canonicalJson(observed.patch) ||
          canonicalJson(candidate.patchIdentity) !==
            canonicalJson(observed.patchIdentity)
        ) {
          throw new Error("M6 Gate candidate crossed its one-turn result");
        }
        return observed.workflowInput;
      }),

    cleanup: () =>
      Promise.resolve({
        proven: cleanup?.proven ?? false,
        receiptSha256: cleanup?.receiptSha256 ?? null,
      }),
  });
}
