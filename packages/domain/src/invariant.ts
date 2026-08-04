import { z } from "zod";

import {
  BranchIdSchema,
  EvaluationIdSchema,
  EventIdSchema,
  EvidenceIdSchema,
  InvariantIdSchema,
  type BranchId,
  type EvaluationId,
  type EventId,
  type EvidenceId,
  type InvariantId,
} from "./ids.js";
import { JsonValueSchema, type JsonValue } from "./json.js";
import { TickSchema, type Tick } from "./time.js";

export interface SignalPredicate {
  readonly kind: "signal";
  readonly source: string;
  readonly name: string;
}

export const SignalPredicateSchema: z.ZodType<SignalPredicate> = z
  .object({
    kind: z.literal("signal"),
    source: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export interface PropertyEqualsPredicate {
  readonly kind: "property_equals";
  readonly path: string;
  readonly value: JsonValue;
}

export const PropertyEqualsPredicateSchema: z.ZodType<PropertyEqualsPredicate> =
  z
    .object({
      kind: z.literal("property_equals"),
      path: z.string().min(1),
      value: JsonValueSchema,
    })
    .strict();

export interface TemporalInvariant {
  readonly schemaVersion: 1;
  readonly invariantId: InvariantId;
  readonly description: string;
  readonly severity: "info" | "warning" | "error" | "critical";
  readonly trigger: SignalPredicate;
  readonly expectation: PropertyEqualsPredicate;
  /** Additional ticks allowed after the trigger; the deadline is inclusive. */
  readonly withinTicks: number;
  readonly inclusive: true;
}

export const TemporalInvariantSchema: z.ZodType<TemporalInvariant> = z
  .object({
    schemaVersion: z.literal(1),
    invariantId: InvariantIdSchema,
    description: z.string().min(1),
    severity: z.enum(["info", "warning", "error", "critical"]),
    trigger: SignalPredicateSchema,
    expectation: PropertyEqualsPredicateSchema,
    withinTicks: z.number().int().nonnegative(),
    inclusive: z.literal(true),
  })
  .strict();

export interface StateValueObservation {
  readonly present: boolean;
  readonly value?: JsonValue | undefined;
}

export const StateValueObservationSchema: z.ZodType<StateValueObservation> = z
  .object({
    present: z.boolean(),
    value: JsonValueSchema.optional(),
  })
  .strict();

export interface InvariantEvaluation {
  readonly schemaVersion: 1;
  readonly evaluationId: EvaluationId;
  readonly branchId: BranchId;
  readonly invariantId: InvariantId;
  readonly triggerEventId: EventId;
  readonly triggerTick: Tick;
  readonly deadlineTick: Tick;
  readonly status: "pass" | "fail" | "incomplete";
  readonly observed: StateValueObservation;
  readonly satisfiedTick?: Tick | undefined;
  readonly evidenceId?: EvidenceId | undefined;
}

export const InvariantEvaluationSchema: z.ZodType<InvariantEvaluation> = z
  .object({
    schemaVersion: z.literal(1),
    evaluationId: EvaluationIdSchema,
    branchId: BranchIdSchema,
    invariantId: InvariantIdSchema,
    triggerEventId: EventIdSchema,
    triggerTick: TickSchema,
    deadlineTick: TickSchema,
    status: z.enum(["pass", "fail", "incomplete"]),
    observed: StateValueObservationSchema,
    satisfiedTick: TickSchema.optional(),
    evidenceId: EvidenceIdSchema.optional(),
  })
  .strict();
