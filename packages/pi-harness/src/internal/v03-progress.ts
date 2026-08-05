import { PiHarnessError } from "../errors.js";
import type {
  V03PiProgressSnapshot,
  V03PiProgressSnapshotV3,
} from "../v03-types.js";

const monotonicNumbers = (
  snapshot: V03PiProgressSnapshotV3,
): readonly number[] => [
  snapshot.sequence,
  snapshot.wallTimeMs,
  snapshot.model.tokens.input,
  snapshot.model.tokens.output,
  snapshot.model.tokens.cacheRead,
  snapshot.model.tokens.cacheWrite,
  snapshot.model.tokens.total,
  snapshot.tools.started,
  snapshot.tools.completed,
  snapshot.tools.failed,
  snapshot.tools.semanticRevision,
  snapshot.game.baselineExecutions,
  snapshot.game.diagnosticExecutions,
];

const monotonicBooleans = (
  snapshot: V03PiProgressSnapshotV3,
): readonly boolean[] => [
  snapshot.model.requestStarted,
  snapshot.model.outputObserved,
  snapshot.model.turnCompleted,
  snapshot.proposalSubmitted,
];

export const assertV03ProgressMonotonic = (
  previous: V03PiProgressSnapshotV3 | undefined,
  next: V03PiProgressSnapshotV3,
): void => {
  if (previous === undefined) return;
  const previousNumbers = monotonicNumbers(previous);
  const nextNumbers = monotonicNumbers(next);
  if (
    nextNumbers.some(
      (value, index) => value < (previousNumbers[index] ?? value),
    ) ||
    monotonicBooleans(next).some(
      (value, index) => (monotonicBooleans(previous)[index] ?? false) && !value,
    )
  ) {
    throw new PiHarnessError(
      "AGENT_FAILED",
      "Pi v0.3 progress snapshot regressed",
    );
  }
};

export const legacyV03ProgressSnapshot = (
  snapshot: V03PiProgressSnapshotV3,
): V03PiProgressSnapshot => ({
  progressObserved:
    snapshot.model.outputObserved ||
    snapshot.tools.started > 0 ||
    snapshot.game.diagnosticExecutions > 0 ||
    snapshot.proposalSubmitted,
  toolCalls: snapshot.tools.started,
  tokens: snapshot.model.tokens,
  wallTimeMs: snapshot.wallTimeMs,
});
