import { z } from "zod";

import {
  BranchIdSchema,
  CheckpointIdSchema,
  EventIdSchema,
  EvidenceIdSchema,
  InvariantIdSchema,
  RunIdSchema,
  type BranchId,
  type CheckpointId,
  type EventId,
  type EvidenceId,
  type InvariantId,
  type RunId,
} from "./ids.js";
import {
  PropertyEqualsPredicateSchema,
  StateValueObservationSchema,
  type PropertyEqualsPredicate,
  type StateValueObservation,
} from "./invariant.js";
import { TelemetryEventSchema, type TelemetryEvent } from "./telemetry.js";
import { TickSchema, type Tick } from "./time.js";

export interface StateDiffEntry {
  readonly path: string;
  readonly status: "changed" | "unchanged" | "missing";
  readonly before: StateValueObservation;
  readonly after: StateValueObservation;
  readonly changedAtEventIds: readonly EventId[];
}

export const StateDiffEntrySchema: z.ZodType<StateDiffEntry> = z
  .object({
    path: z.string().min(1),
    status: z.enum(["changed", "unchanged", "missing"]),
    before: StateValueObservationSchema,
    after: StateValueObservationSchema,
    changedAtEventIds: z.array(EventIdSchema),
  })
  .strict();

export interface ClosedObservationWindow {
  readonly fromTick: Tick;
  readonly toTick: Tick;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly closed: true;
}

export const ClosedObservationWindowSchema: z.ZodType<ClosedObservationWindow> =
  z
    .object({
      fromTick: TickSchema,
      toTick: TickSchema,
      fromSeq: z.number().int().nonnegative(),
      toSeq: z.number().int().nonnegative(),
      closed: z.literal(true),
    })
    .strict();

export interface EvidenceBundle {
  readonly schemaVersion: 1;
  readonly evidenceId: EvidenceId;
  readonly runId: RunId;
  readonly branchId: BranchId;
  readonly checkpointId: CheckpointId;
  readonly invariantId: InvariantId;
  readonly severity: "info" | "warning" | "error" | "critical";
  readonly triggerEventId: EventId;
  readonly deadlineTick: Tick;
  readonly observedWindow: ClosedObservationWindow;
  readonly eventChain: readonly TelemetryEvent[];
  readonly stateDiff: readonly StateDiffEntry[];
  readonly expected: PropertyEqualsPredicate;
  readonly actual: StateValueObservation;
  readonly violationSummary: string;
  readonly sourceEventIds: readonly EventId[];
}

export const EvidenceBundleSchema: z.ZodType<EvidenceBundle> = z
  .object({
    schemaVersion: z.literal(1),
    evidenceId: EvidenceIdSchema,
    runId: RunIdSchema,
    branchId: BranchIdSchema,
    checkpointId: CheckpointIdSchema,
    invariantId: InvariantIdSchema,
    severity: z.enum(["info", "warning", "error", "critical"]),
    triggerEventId: EventIdSchema,
    deadlineTick: TickSchema,
    observedWindow: ClosedObservationWindowSchema,
    eventChain: z.array(TelemetryEventSchema),
    stateDiff: z.array(StateDiffEntrySchema),
    expected: PropertyEqualsPredicateSchema,
    actual: StateValueObservationSchema,
    violationSummary: z.string().min(1),
    sourceEventIds: z.array(EventIdSchema),
  })
  .strict();
