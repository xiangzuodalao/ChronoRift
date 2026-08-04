import {
  asEvaluationId,
  asEvidenceId,
  type BranchId,
  type CheckpointId,
  type ClosedObservationWindow,
  type EvidenceBundle,
  type FrameRecord,
  type InvariantEvaluation,
  type RunId,
  type StateDiffEntry,
  type StateSnapshot,
  type StateValueObservation,
  type TelemetryEvent,
  type TemporalInvariant,
} from "@chronorift/domain";

import { jsonEqual } from "./canonical.js";

export interface EvidenceCompilationInput {
  readonly runId: RunId;
  readonly branchId: BranchId;
  readonly checkpointId: CheckpointId;
  readonly baselineState: StateSnapshot;
  readonly frames: readonly FrameRecord[];
  readonly events: readonly TelemetryEvent[];
}

export interface EvidenceCompilationResult {
  readonly evaluations: readonly InvariantEvaluation[];
  readonly evidence: readonly EvidenceBundle[];
}

const hasOwn = (
  values: Readonly<Record<string, unknown>>,
  path: string,
): boolean => Object.prototype.hasOwnProperty.call(values, path);

const observe = (state: StateSnapshot, path: string): StateValueObservation =>
  hasOwn(state.values, path)
    ? { present: true, value: state.values[path] ?? null }
    : { present: false };

const observationsEqual = (
  left: StateValueObservation,
  right: StateValueObservation,
): boolean => {
  if (left.present !== right.present) return false;
  if (!left.present) return true;
  return jsonEqual(left.value ?? null, right.value ?? null);
};

const stateSatisfies = (
  frame: FrameRecord,
  invariant: TemporalInvariant,
): boolean => {
  const observed = observe(frame.state, invariant.expectation.path);
  return (
    observed.present &&
    jsonEqual(observed.value ?? null, invariant.expectation.value)
  );
};

const matchesTrigger = (
  event: TelemetryEvent,
  invariant: TemporalInvariant,
): boolean =>
  event.kind === "signal" &&
  event.source === invariant.trigger.source &&
  event.name === invariant.trigger.name;

const causalAncestors = (
  trigger: TelemetryEvent,
  eventsById: ReadonlyMap<string, TelemetryEvent>,
): TelemetryEvent[] => {
  const ancestors: TelemetryEvent[] = [];
  const visited = new Set<string>();
  let current: TelemetryEvent | undefined = trigger;
  while (current !== undefined && !visited.has(current.eventId)) {
    visited.add(current.eventId);
    ancestors.push(current);
    current =
      current.causedByEventId === undefined
        ? undefined
        : eventsById.get(current.causedByEventId);
  }
  return ancestors.reverse();
};

const compileDiff = (
  invariant: TemporalInvariant,
  baseline: StateSnapshot,
  deadlineState: StateSnapshot,
  chain: readonly TelemetryEvent[],
): StateDiffEntry[] => {
  const changedPaths = chain.flatMap((event) =>
    event.kind === "property_changed" ? [event.path] : [],
  );
  const paths = new Set([...changedPaths, invariant.expectation.path]);

  return [...paths].sort().map((path) => {
    const propertyEvents = chain.filter(
      (event) => event.kind === "property_changed" && event.path === path,
    );
    const first = propertyEvents[0];
    const before =
      first?.kind === "property_changed"
        ? { present: true as const, value: first.before }
        : observe(baseline, path);
    const after = observe(deadlineState, path);
    return {
      path,
      status: !after.present
        ? "missing"
        : observationsEqual(before, after)
          ? "unchanged"
          : "changed",
      before,
      after,
      changedAtEventIds: propertyEvents.map((event) => event.eventId),
    };
  });
};

export class EvidenceCompiler {
  public constructor(
    private readonly invariants: readonly TemporalInvariant[],
  ) {}

  public compile(input: EvidenceCompilationInput): EvidenceCompilationResult {
    const evaluations: InvariantEvaluation[] = [];
    const evidence: EvidenceBundle[] = [];
    const eventsById = new Map(
      input.events.map((event) => [event.eventId, event] as const),
    );

    for (const invariant of this.invariants) {
      const triggers = input.events.filter((event) =>
        matchesTrigger(event, invariant),
      );

      for (const trigger of triggers) {
        const deadlineTick = trigger.tick + invariant.withinTicks;
        const framesInWindow = input.frames.filter(
          (frame) => frame.tick >= trigger.tick && frame.tick <= deadlineTick,
        );
        const satisfied = framesInWindow.find((frame) =>
          stateSatisfies(frame, invariant),
        );
        const deadlineFrame = input.frames.find(
          (frame) => frame.tick === deadlineTick,
        );
        const lastObservedFrame = framesInWindow.at(-1);
        const status =
          satisfied !== undefined
            ? "pass"
            : deadlineFrame !== undefined
              ? "fail"
              : "incomplete";
        const evaluationId = asEvaluationId(
          `evaluation:${input.branchId}:${invariant.invariantId}:${trigger.seq}`,
        );
        const observedFrame = satisfied ?? deadlineFrame ?? lastObservedFrame;
        const observed =
          observedFrame === undefined
            ? observe(input.baselineState, invariant.expectation.path)
            : observe(observedFrame.state, invariant.expectation.path);

        if (status !== "fail" || deadlineFrame === undefined) {
          evaluations.push({
            schemaVersion: 1,
            evaluationId,
            branchId: input.branchId,
            invariantId: invariant.invariantId,
            triggerEventId: trigger.eventId,
            triggerTick: trigger.tick,
            deadlineTick,
            status,
            observed,
            ...(satisfied === undefined
              ? {}
              : { satisfiedTick: satisfied.tick }),
          });
          continue;
        }

        const evidenceId = asEvidenceId(
          `evidence:${input.branchId}:${invariant.invariantId}:${trigger.seq}`,
        );
        const ancestors = causalAncestors(trigger, eventsById);
        const ancestorIds = new Set(ancestors.map((event) => event.eventId));
        const eventChain = input.events.filter(
          (event) =>
            ancestorIds.has(event.eventId) ||
            (event.seq > trigger.seq && event.tick <= deadlineTick),
        );
        const windowEvents = input.events.filter(
          (event) => event.tick <= deadlineTick,
        );
        const firstEvent = eventChain[0] ?? trigger;
        const lastEvent = windowEvents.at(-1) ?? trigger;
        const observedWindow: ClosedObservationWindow = {
          fromTick: trigger.tick,
          toTick: deadlineTick,
          fromSeq: firstEvent.seq,
          toSeq: lastEvent.seq,
          closed: true,
        };
        const bundle: EvidenceBundle = {
          schemaVersion: 1,
          evidenceId,
          runId: input.runId,
          branchId: input.branchId,
          checkpointId: input.checkpointId,
          invariantId: invariant.invariantId,
          severity: invariant.severity,
          triggerEventId: trigger.eventId,
          deadlineTick,
          observedWindow,
          eventChain,
          stateDiff: compileDiff(
            invariant,
            input.baselineState,
            deadlineFrame.state,
            eventChain,
          ),
          expected: invariant.expectation,
          actual: observed,
          violationSummary: `${invariant.description}; expected ${invariant.expectation.path} within ${invariant.withinTicks} ticks`,
          sourceEventIds: eventChain.map((event) => event.eventId),
        };
        evidence.push(bundle);
        evaluations.push({
          schemaVersion: 1,
          evaluationId,
          branchId: input.branchId,
          invariantId: invariant.invariantId,
          triggerEventId: trigger.eventId,
          triggerTick: trigger.tick,
          deadlineTick,
          status,
          observed,
          evidenceId,
        });
      }
    }

    return { evaluations, evidence };
  }
}
