import { z } from "zod";

import { EventIdSchema, type EventId } from "./ids.js";
import {
  StateValueObservationSchema,
  type StateValueObservation,
} from "./invariant.js";
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
