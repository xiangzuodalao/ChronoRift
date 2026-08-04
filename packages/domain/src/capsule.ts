import { z } from "zod";

import {
  BranchIdSchema,
  CapsuleIdSchema,
  CheckpointIdSchema,
  ComparisonIdSchema,
  ContractIdSchema,
  EventIdSchema,
  ExecutionIdSchema,
  RunIdSchema,
  type BranchId,
  type CapsuleId,
  type CheckpointId,
  type ComparisonId,
  type ContractId,
  type EventId,
  type ExecutionId,
  type RunId,
} from "./ids.js";
import {
  ClosedObservationWindowSchema,
  StateDiffEntrySchema,
  type ClosedObservationWindow,
  type StateDiffEntry,
} from "./evidence.js";
import {
  DelayInputInterventionSchema,
  ExecutionTelemetryEventSchema,
  type DelayInputIntervention,
  type ExecutionTelemetryEvent,
} from "./execution.js";
import {
  PropertyEqualsPredicateSchema,
  StateValueObservationSchema,
  type PropertyEqualsPredicate,
  type StateValueObservation,
} from "./invariant.js";

export interface EvidenceCapsuleIntegrity {
  readonly executionSealed: boolean;
  readonly eventLossDetected: boolean;
  readonly timelineDigest: string;
}

export const EvidenceCapsuleIntegritySchema: z.ZodType<EvidenceCapsuleIntegrity> =
  z
    .object({
      executionSealed: z.boolean(),
      eventLossDetected: z.boolean(),
      timelineDigest: z.string().min(1),
    })
    .strict();

/** A compact, factual view of one failed baseline execution. */
export interface EvidenceCapsule {
  readonly schemaVersion: 1;
  readonly capsuleId: CapsuleId;
  readonly runId: RunId;
  readonly contractId: ContractId;
  readonly branchId: BranchId;
  readonly checkpointId: CheckpointId;
  readonly baselineExecutionId: ExecutionId;
  readonly observedWindow: ClosedObservationWindow;
  readonly triggerEventId: EventId;
  readonly signalDeliveryEventId?: EventId | undefined;
  readonly receiverConnectedEventId?: EventId | undefined;
  readonly eventChain: readonly ExecutionTelemetryEvent[];
  readonly stateDiff: readonly StateDiffEntry[];
  readonly expected: PropertyEqualsPredicate;
  readonly actual: StateValueObservation;
  readonly violationSummary: string;
  readonly sourceEventIds: readonly EventId[];
  readonly integrity: EvidenceCapsuleIntegrity;
  readonly knownLimitations: readonly string[];
  readonly nextMinimalExperiments: readonly string[];
}

export const EvidenceCapsuleSchema: z.ZodType<EvidenceCapsule> = z
  .object({
    schemaVersion: z.literal(1),
    capsuleId: CapsuleIdSchema,
    runId: RunIdSchema,
    contractId: ContractIdSchema,
    branchId: BranchIdSchema,
    checkpointId: CheckpointIdSchema,
    baselineExecutionId: ExecutionIdSchema,
    observedWindow: ClosedObservationWindowSchema,
    triggerEventId: EventIdSchema,
    signalDeliveryEventId: EventIdSchema.optional(),
    receiverConnectedEventId: EventIdSchema.optional(),
    eventChain: z.array(ExecutionTelemetryEventSchema),
    stateDiff: z.array(StateDiffEntrySchema),
    expected: PropertyEqualsPredicateSchema,
    actual: StateValueObservationSchema,
    violationSummary: z.string().min(1),
    sourceEventIds: z.array(EventIdSchema).nonempty(),
    integrity: EvidenceCapsuleIntegritySchema,
    knownLimitations: z.array(z.string().min(1)),
    nextMinimalExperiments: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.observedWindow.fromTick > value.observedWindow.toTick ||
      value.observedWindow.fromSeq > value.observedWindow.toSeq
    ) {
      context.addIssue({
        code: "custom",
        message: "Observation window bounds are reversed",
        path: ["observedWindow"],
      });
    }

    const eventsById = new Map(
      value.eventChain.map((event) => [event.eventId, event]),
    );
    const earlierEventIds = new Set<string>();
    let previousSeq = -1;
    for (const [index, event] of value.eventChain.entries()) {
      if (earlierEventIds.has(event.eventId)) {
        context.addIssue({
          code: "custom",
          message: "Capsule event IDs must be unique",
          path: ["eventChain", index, "eventId"],
        });
      }
      if (event.seq <= previousSeq) {
        context.addIssue({
          code: "custom",
          message: "Capsule events must preserve increasing execution order",
          path: ["eventChain", index, "seq"],
        });
      }
      if (
        event.causedByEventId !== undefined &&
        !earlierEventIds.has(event.causedByEventId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Capsule causal references must resolve to an earlier event",
          path: ["eventChain", index, "causedByEventId"],
        });
      }
      if (
        event.executionId !== value.baselineExecutionId ||
        event.runId !== value.runId ||
        event.branchId !== value.branchId
      ) {
        context.addIssue({
          code: "custom",
          message: "Capsule event provenance does not match its baseline",
          path: ["eventChain", index],
        });
      }
      if (
        event.tick < value.observedWindow.fromTick ||
        event.tick > value.observedWindow.toTick ||
        event.seq < value.observedWindow.fromSeq ||
        event.seq > value.observedWindow.toSeq
      ) {
        context.addIssue({
          code: "custom",
          message: "Capsule event is outside the closed observation window",
          path: ["eventChain", index],
        });
      }
      earlierEventIds.add(event.eventId);
      previousSeq = event.seq;
    }

    const trigger = eventsById.get(value.triggerEventId);
    if (trigger?.kind !== "signal") {
      context.addIssue({
        code: "custom",
        message: "triggerEventId must resolve to a signal in the capsule",
        path: ["triggerEventId"],
      });
    }
    if (value.signalDeliveryEventId !== undefined) {
      const delivery = eventsById.get(value.signalDeliveryEventId);
      if (delivery?.kind !== "signal_delivery") {
        context.addIssue({
          code: "custom",
          message: "signalDeliveryEventId must resolve to signal_delivery",
          path: ["signalDeliveryEventId"],
        });
      } else if (
        trigger?.kind !== "signal" ||
        delivery.causedByEventId !== trigger.eventId ||
        delivery.source !== trigger.source ||
        delivery.name !== trigger.name ||
        delivery.delivered ||
        delivery.failureReason !== "receiver_not_connected"
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Delivery evidence must be the trigger's failed receiver_not_connected delivery",
          path: ["signalDeliveryEventId"],
        });
      }
    }
    if (value.receiverConnectedEventId !== undefined) {
      const receiverConnected = eventsById.get(value.receiverConnectedEventId);
      const delivery =
        value.signalDeliveryEventId === undefined
          ? undefined
          : eventsById.get(value.signalDeliveryEventId);
      if (
        receiverConnected?.kind !== "property_changed" ||
        receiverConnected.after !== true ||
        (delivery !== undefined && receiverConnected.seq <= delivery.seq)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Receiver connection evidence must become true after failed delivery",
          path: ["receiverConnectedEventId"],
        });
      }
    }
    const sourceEventIds = new Set<string>();
    for (const [index, sourceEventId] of value.sourceEventIds.entries()) {
      if (sourceEventIds.has(sourceEventId)) {
        context.addIssue({
          code: "custom",
          message: "Capsule source event IDs must be unique",
          path: ["sourceEventIds", index],
        });
      }
      if (!eventsById.has(sourceEventId)) {
        context.addIssue({
          code: "custom",
          message: "Capsule source event reference does not resolve",
          path: ["sourceEventIds", index],
        });
      }
      sourceEventIds.add(sourceEventId);
    }
    for (const requiredId of [
      value.triggerEventId,
      value.signalDeliveryEventId,
      value.receiverConnectedEventId,
    ]) {
      if (requiredId !== undefined && !sourceEventIds.has(requiredId)) {
        context.addIssue({
          code: "custom",
          message: "Capsule sourceEventIds omit a named evidence event",
          path: ["sourceEventIds"],
        });
      }
    }
    for (const [diffIndex, diff] of value.stateDiff.entries()) {
      for (const [eventIndex, eventId] of diff.changedAtEventIds.entries()) {
        if (!eventsById.has(eventId)) {
          context.addIssue({
            code: "custom",
            message: "State-diff event reference does not resolve",
            path: ["stateDiff", diffIndex, "changedAtEventIds", eventIndex],
          });
        }
      }
    }
  });

export type ComparisonOutcome = "pass" | "fail" | "incomplete";

export interface ExecutionComparison {
  readonly schemaVersion: 1;
  readonly comparisonId: ComparisonId;
  readonly runId: RunId;
  readonly contractId: ContractId;
  readonly commonCheckpointId: CheckpointId;
  readonly baselineBranchId: BranchId;
  readonly candidateBranchId: BranchId;
  readonly baselineExecutionId: ExecutionId;
  readonly candidateExecutionId: ExecutionId;
  readonly intervention: DelayInputIntervention;
  readonly baselineOutcome: ComparisonOutcome;
  readonly candidateOutcome: ComparisonOutcome;
  readonly comparable: boolean;
  readonly blockers: readonly string[];
  readonly digestsEqual: boolean;
  readonly firstDivergenceTick: number | null;
}

export const ExecutionComparisonSchema: z.ZodType<ExecutionComparison> = z
  .object({
    schemaVersion: z.literal(1),
    comparisonId: ComparisonIdSchema,
    runId: RunIdSchema,
    contractId: ContractIdSchema,
    commonCheckpointId: CheckpointIdSchema,
    baselineBranchId: BranchIdSchema,
    candidateBranchId: BranchIdSchema,
    baselineExecutionId: ExecutionIdSchema,
    candidateExecutionId: ExecutionIdSchema,
    intervention: DelayInputInterventionSchema,
    baselineOutcome: z.enum(["pass", "fail", "incomplete"]),
    candidateOutcome: z.enum(["pass", "fail", "incomplete"]),
    comparable: z.boolean(),
    blockers: z.array(z.string().min(1)),
    digestsEqual: z.boolean(),
    firstDivergenceTick: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.baselineExecutionId === value.candidateExecutionId) {
      context.addIssue({
        code: "custom",
        message: "Comparison executions must be distinct",
        path: ["candidateExecutionId"],
      });
    }
    if (value.baselineBranchId === value.candidateBranchId) {
      context.addIssue({
        code: "custom",
        message: "Comparison branches must be distinct",
        path: ["candidateBranchId"],
      });
    }
    if (value.comparable && value.blockers.length > 0) {
      context.addIssue({
        code: "custom",
        message: "A comparable execution pair cannot have blockers",
        path: ["blockers"],
      });
    }
    if (!value.comparable && value.blockers.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A non-comparable execution pair requires a blocker",
        path: ["blockers"],
      });
    }
  });
