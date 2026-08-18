import type {
  ExternalHiddenFixAssignmentStoreV1,
  ExternalHiddenFixTerminalRecordV1,
} from "./external-hidden-fix.js";
import {
  BwrapExternalHiddenFixEvaluatorProcessV1,
  LocalExternalHiddenFixFreshCopyRunnerV1,
  type ExternalHiddenFixEvaluatorRuntimeMountV1,
  type LocalExternalHiddenFixPatchStoreV1,
} from "./external-hidden-fix-evaluator.js";
import { runExternalHiddenFixLocalGateV1 } from "./external-hidden-fix-local-gate.js";
import { createM6OneTurnLocalGateAgentPortV1 } from "./m6-one-turn-local-gate.js";
import {
  createM6AgentAttemptBindingFromPreparedTaskV1,
  createM6OneTurnRequestFromPreparedTaskV1,
  createM6ProjectEnvironmentOneTurnAgentPortV1,
  type PreparedM6ProjectEnvironmentOneTurnTaskV1,
} from "./m6-project-environment-one-turn.js";

export interface M6ExternalHiddenFixLocalEvaluatorV1 {
  readonly bwrapPath: string;
  readonly nodePath: string;
  readonly temporaryRoot: string;
  readonly runtimeMounts?:
    readonly ExternalHiddenFixEvaluatorRuntimeMountV1[] | undefined;
  readonly gitBinary?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Formal local M6 composition. The Agent attempt binding is persisted by the
 * Gate before Pi starts. The hidden oracle is always launched through the
 * allowlisted bwrap process; this entry point cannot substitute the low-level,
 * same-UID Node evaluator.
 *
 * Task preparation and evaluator admission happen before the formal attempt.
 * Once the local Gate writes the attempt claim, the assignment store permits
 * exactly one Agent attempt and one terminal result, and no evaluator path can
 * relaunch the Agent.
 */
export async function runM6ExternalHiddenFixLocalGateV1(input: {
  readonly task: PreparedM6ProjectEnvironmentOneTurnTaskV1;
  readonly store: ExternalHiddenFixAssignmentStoreV1;
  readonly patchStore: LocalExternalHiddenFixPatchStoreV1;
  readonly evaluator: M6ExternalHiddenFixLocalEvaluatorV1;
  readonly now?: (() => string) | undefined;
}): Promise<ExternalHiddenFixTerminalRecordV1> {
  const assignmentId = input.task.assignment.assignment.assignmentId;
  const agentTaskRoots = [input.task.layout.taskRootDirectory];
  let agent: ReturnType<typeof createM6OneTurnLocalGateAgentPortV1>;
  let freshCopyRunner: LocalExternalHiddenFixFreshCopyRunnerV1;
  try {
    if (input.task.patchStore !== input.patchStore) {
      throw new Error(
        "M6 formal Gate evaluator must read the same protected patch store used by the Agent handoff",
      );
    }
    const evaluatorProcess =
      await BwrapExternalHiddenFixEvaluatorProcessV1.open({
        bwrapPath: input.evaluator.bwrapPath,
        nodePath: input.evaluator.nodePath,
        forbiddenRoots: [
          ...agentTaskRoots,
          input.task.assignment.pristineSource.repositoryRoot,
          input.task.assignment.mutatedSource.repositoryRoot,
          input.task.assignment.baseline.workspaceDirectory,
          input.task.assignment.protectedBaselineRoot,
        ],
        ...(input.evaluator.runtimeMounts === undefined
          ? {}
          : { runtimeMounts: input.evaluator.runtimeMounts }),
        ...(input.evaluator.timeoutMs === undefined
          ? {}
          : { timeoutMs: input.evaluator.timeoutMs }),
      });
    freshCopyRunner = await LocalExternalHiddenFixFreshCopyRunnerV1.open({
      temporaryRoot: input.evaluator.temporaryRoot,
      exposedRoots: agentTaskRoots,
      patchStore: input.patchStore,
      evaluator: evaluatorProcess,
      ...(input.evaluator.gitBinary === undefined
        ? {}
        : { gitBinary: input.evaluator.gitBinary }),
    });

    const request = createM6OneTurnRequestFromPreparedTaskV1(input.task);
    agent = createM6OneTurnLocalGateAgentPortV1({
      request,
      port: createM6ProjectEnvironmentOneTurnAgentPortV1(input.task),
      attemptBinding: createM6AgentAttemptBindingFromPreparedTaskV1(input.task),
    });
  } catch (error) {
    let cleanup: Awaited<ReturnType<typeof input.task.broker.cleanup>>;
    try {
      cleanup = await input.task.broker.cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "M6 formal Gate admission and Task cleanup both failed",
      );
    }
    if (
      !cleanup.processGroupTerminated ||
      cleanup.cgroupPopulated ||
      !cleanup.scopeRemoved ||
      cleanup.storageReconciled !== true
    ) {
      throw new AggregateError(
        [error, new Error("M6 formal Gate admission cleanup was incomplete")],
        "M6 formal Gate admission failed without cleanup proof",
      );
    }
    throw error;
  }
  return runExternalHiddenFixLocalGateV1({
    assignmentId,
    store: input.store,
    agent,
    evaluator: freshCopyRunner,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}
