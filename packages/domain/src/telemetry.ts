import { z } from "zod";

import {
  BranchIdSchema,
  EventIdSchema,
  RunIdSchema,
  type BranchId,
  type EventId,
  type RunId,
} from "./ids.js";
import {
  JsonObjectSchema,
  JsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import {
  MicrosecondsSchema,
  PositiveMicrosecondsSchema,
  TickSchema,
  type Microseconds,
  type Tick,
} from "./time.js";

export interface StateSnapshot {
  readonly values: Readonly<Record<string, JsonValue>>;
}

export const StateSnapshotSchema: z.ZodType<StateSnapshot> = z
  .object({ values: z.record(z.string(), JsonValueSchema) })
  .strict();

export interface ScheduledInput {
  readonly relativeTick: Tick;
  readonly order: number;
  readonly action: string;
  readonly target?: string | undefined;
  readonly payload: JsonObject;
}

export const ScheduledInputSchema: z.ZodType<ScheduledInput> = z
  .object({
    relativeTick: TickSchema,
    order: z.number().int().nonnegative(),
    action: z.string().min(1),
    target: z.string().min(1).optional(),
    payload: JsonObjectSchema,
  })
  .strict();

interface EnvironmentEventDraftBase {
  readonly localId: string;
  readonly causedByLocalId?: string | undefined;
}

export interface SignalEventDraft extends EnvironmentEventDraftBase {
  readonly kind: "signal";
  readonly source: string;
  readonly name: string;
  readonly arguments: readonly JsonValue[];
}

export interface PropertyChangedEventDraft extends EnvironmentEventDraftBase {
  readonly kind: "property_changed";
  readonly path: string;
  readonly before: JsonValue;
  readonly after: JsonValue;
}

export interface LogEventDraft extends EnvironmentEventDraftBase {
  readonly kind: "log";
  readonly level: "debug" | "info" | "warn" | "error";
  readonly source: string;
  readonly message: string;
  readonly fields: JsonObject;
}

export type EnvironmentEventDraft =
  SignalEventDraft | PropertyChangedEventDraft | LogEventDraft;

const draftBase = {
  localId: z.string().min(1),
  causedByLocalId: z.string().min(1).optional(),
};

export const EnvironmentEventDraftSchema: z.ZodType<EnvironmentEventDraft> =
  z.discriminatedUnion("kind", [
    z
      .object({
        ...draftBase,
        kind: z.literal("signal"),
        source: z.string().min(1),
        name: z.string().min(1),
        arguments: z.array(JsonValueSchema),
      })
      .strict(),
    z
      .object({
        ...draftBase,
        kind: z.literal("property_changed"),
        path: z.string().min(1),
        before: JsonValueSchema,
        after: JsonValueSchema,
      })
      .strict(),
    z
      .object({
        ...draftBase,
        kind: z.literal("log"),
        level: z.enum(["debug", "info", "warn", "error"]),
        source: z.string().min(1),
        message: z.string(),
        fields: JsonObjectSchema,
      })
      .strict(),
  ]);

interface TelemetryBase {
  readonly schemaVersion: 1;
  readonly eventId: EventId;
  readonly runId: RunId;
  readonly branchId: BranchId;
  readonly seq: number;
  readonly tick: Tick;
  readonly simTimeUs: Microseconds;
  readonly causedByEventId?: EventId | undefined;
}

export interface InputTelemetryEvent extends TelemetryBase {
  readonly kind: "input";
  readonly action: string;
  readonly target?: string | undefined;
  readonly payload: JsonObject;
}

export interface SignalTelemetryEvent extends TelemetryBase {
  readonly kind: "signal";
  readonly source: string;
  readonly name: string;
  readonly arguments: readonly JsonValue[];
}

export interface PropertyChangedTelemetryEvent extends TelemetryBase {
  readonly kind: "property_changed";
  readonly path: string;
  readonly before: JsonValue;
  readonly after: JsonValue;
}

export interface LogTelemetryEvent extends TelemetryBase {
  readonly kind: "log";
  readonly level: "debug" | "info" | "warn" | "error";
  readonly source: string;
  readonly message: string;
  readonly fields: JsonObject;
}

export type TelemetryEvent =
  | InputTelemetryEvent
  | SignalTelemetryEvent
  | PropertyChangedTelemetryEvent
  | LogTelemetryEvent;

const telemetryBase = {
  schemaVersion: z.literal(1),
  eventId: EventIdSchema,
  runId: RunIdSchema,
  branchId: BranchIdSchema,
  seq: z.number().int().nonnegative(),
  tick: TickSchema,
  simTimeUs: MicrosecondsSchema,
  causedByEventId: EventIdSchema.optional(),
};

export const TelemetryEventSchema: z.ZodType<TelemetryEvent> =
  z.discriminatedUnion("kind", [
    z
      .object({
        ...telemetryBase,
        kind: z.literal("input"),
        action: z.string().min(1),
        target: z.string().min(1).optional(),
        payload: JsonObjectSchema,
      })
      .strict(),
    z
      .object({
        ...telemetryBase,
        kind: z.literal("signal"),
        source: z.string().min(1),
        name: z.string().min(1),
        arguments: z.array(JsonValueSchema),
      })
      .strict(),
    z
      .object({
        ...telemetryBase,
        kind: z.literal("property_changed"),
        path: z.string().min(1),
        before: JsonValueSchema,
        after: JsonValueSchema,
      })
      .strict(),
    z
      .object({
        ...telemetryBase,
        kind: z.literal("log"),
        level: z.enum(["debug", "info", "warn", "error"]),
        source: z.string().min(1),
        message: z.string(),
        fields: JsonObjectSchema,
      })
      .strict(),
  ]);

export interface FrameRecord {
  readonly tick: Tick;
  readonly simTimeUs: Microseconds;
  readonly deltaUs: Microseconds;
  readonly state: StateSnapshot;
  readonly eventIds: readonly EventId[];
}

export const FrameRecordSchema: z.ZodType<FrameRecord> = z
  .object({
    tick: TickSchema,
    simTimeUs: MicrosecondsSchema,
    deltaUs: PositiveMicrosecondsSchema,
    state: StateSnapshotSchema,
    eventIds: z.array(EventIdSchema),
  })
  .strict();
