import { z } from "zod";

import { InputTraceIdSchema, type InputTraceId } from "./ids.js";
import { JsonValueSchema, type JsonValue } from "./json.js";
import { ScheduledInputSchema, type ScheduledInput } from "./telemetry.js";
import { PositiveMicrosecondsSchema, type Microseconds } from "./time.js";

export interface InputTrace {
  readonly schemaVersion: 1;
  readonly inputTraceId: InputTraceId;
  readonly scheduleBasis: "relative_tick";
  readonly inputs: readonly ScheduledInput[];
}

export const InputTraceSchema: z.ZodType<InputTrace> = z
  .object({
    schemaVersion: z.literal(1),
    inputTraceId: InputTraceIdSchema,
    scheduleBasis: z.literal("relative_tick"),
    inputs: z.array(ScheduledInputSchema),
  })
  .strict();

export interface BranchControls {
  readonly deltaUs: Microseconds;
  /** Largest relative tick to execute, inclusive; zero executes one frame. */
  readonly maxTicks: number;
  readonly variables: Readonly<Record<string, JsonValue>>;
}

export const BranchControlsSchema: z.ZodType<BranchControls> = z
  .object({
    deltaUs: PositiveMicrosecondsSchema,
    maxTicks: z.number().int().nonnegative(),
    variables: z.record(z.string(), JsonValueSchema),
  })
  .strict();
