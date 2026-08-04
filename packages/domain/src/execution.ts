import { z } from "zod";

import {
  BranchIdSchema,
  CheckpointIdSchema,
  ContractIdSchema,
  EventIdSchema,
  ExecutionIdSchema,
  InputTraceIdSchema,
  RunIdSchema,
  type BranchId,
  type CheckpointId,
  type ContractId,
  type EventId,
  type ExecutionId,
  type InputTraceId,
  type RunId,
} from "./ids.js";
import {
  StateValueObservationSchema,
  type StateValueObservation,
} from "./invariant.js";
import {
  JsonObjectSchema,
  JsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import {
  EnvironmentEventDraftSchema,
  type EnvironmentEventDraft,
} from "./telemetry.js";
import { BranchControlsSchema, type BranchControls } from "./timeline.js";
import {
  MicrosecondsSchema,
  PositiveMicrosecondsSchema,
  TickSchema,
  type Microseconds,
  type Tick,
} from "./time.js";

export interface SignalDeliveryEventDraft {
  readonly kind: "signal_delivery";
  readonly localId: string;
  readonly causedByLocalId: string;
  readonly source: string;
  readonly name: string;
  readonly receiver: string;
  readonly delivered: boolean;
  readonly failureReason?:
    "receiver_not_connected" | "receiver_rejected" | "unknown" | undefined;
}

export const SignalDeliveryEventDraftSchema: z.ZodType<SignalDeliveryEventDraft> =
  z
    .object({
      kind: z.literal("signal_delivery"),
      localId: z.string().min(1),
      causedByLocalId: z.string().min(1),
      source: z.string().min(1),
      name: z.string().min(1),
      receiver: z.string().min(1),
      delivered: z.boolean(),
      failureReason: z
        .enum(["receiver_not_connected", "receiver_rejected", "unknown"])
        .optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.delivered && value.failureReason !== undefined) {
        context.addIssue({
          code: "custom",
          message: "A successful delivery cannot have a failureReason",
          path: ["failureReason"],
        });
      }
      if (!value.delivered && value.failureReason === undefined) {
        context.addIssue({
          code: "custom",
          message: "A failed delivery requires a failureReason",
          path: ["failureReason"],
        });
      }
    });

/** v0.1 adapter draft. The legacy EnvironmentEventDraft remains unchanged. */
export type V01EnvironmentEventDraft =
  EnvironmentEventDraft | SignalDeliveryEventDraft;

export const V01EnvironmentEventDraftSchema: z.ZodType<V01EnvironmentEventDraft> =
  z.union([EnvironmentEventDraftSchema, SignalDeliveryEventDraftSchema]);

export interface DelayInputIntervention {
  readonly kind: "delay_input";
  readonly deltaTicks: 1;
}

export const DelayInputInterventionSchema: z.ZodType<DelayInputIntervention> = z
  .object({
    kind: z.literal("delay_input"),
    deltaTicks: z.literal(1),
  })
  .strict();

interface BranchSpecBase {
  readonly schemaVersion: 1;
  readonly branchId: BranchId;
  readonly runId: RunId;
  readonly contractId: ContractId;
  readonly startCheckpointId: CheckpointId;
  readonly inputTraceId: InputTraceId;
  readonly controls: BranchControls;
  readonly createdAt: string;
}

export interface BaselineBranchSpec extends BranchSpecBase {
  readonly branchKind: "baseline";
}

export interface InterventionBranchSpec extends BranchSpecBase {
  readonly branchKind: "intervention";
  readonly parentBranchId: BranchId;
  readonly intervention: DelayInputIntervention;
}

export type BranchSpec = BaselineBranchSpec | InterventionBranchSpec;

const branchSpecBase = {
  schemaVersion: z.literal(1),
  branchId: BranchIdSchema,
  runId: RunIdSchema,
  contractId: ContractIdSchema,
  startCheckpointId: CheckpointIdSchema,
  inputTraceId: InputTraceIdSchema,
  controls: BranchControlsSchema,
  createdAt: z.string().datetime(),
};

export const BranchSpecSchema: z.ZodType<BranchSpec> = z
  .discriminatedUnion("branchKind", [
    z
      .object({
        ...branchSpecBase,
        branchKind: z.literal("baseline"),
      })
      .strict(),
    z
      .object({
        ...branchSpecBase,
        branchKind: z.literal("intervention"),
        parentBranchId: BranchIdSchema,
        intervention: DelayInputInterventionSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.branchKind === "intervention" &&
      value.parentBranchId === value.branchId
    ) {
      context.addIssue({
        code: "custom",
        message: "An intervention branch cannot be its own parent",
        path: ["parentBranchId"],
      });
    }
  });

interface ExecutionTelemetryBase {
  readonly schemaVersion: 1;
  readonly eventId: EventId;
  readonly executionId: ExecutionId;
  readonly runId: RunId;
  readonly branchId: BranchId;
  readonly seq: number;
  readonly tick: Tick;
  readonly simTimeUs: Microseconds;
  readonly causedByEventId?: EventId | undefined;
}

export interface ExecutionInputTelemetryEvent extends ExecutionTelemetryBase {
  readonly kind: "input";
  readonly order: number;
  readonly action: string;
  readonly target?: string | undefined;
  readonly payload: JsonObject;
  readonly requestedTick: Tick;
  readonly realizedTick: Tick;
}

export interface ExecutionSignalTelemetryEvent extends ExecutionTelemetryBase {
  readonly kind: "signal";
  readonly source: string;
  readonly name: string;
  readonly arguments: readonly JsonValue[];
}

export interface ExecutionSignalDeliveryTelemetryEvent extends ExecutionTelemetryBase {
  readonly kind: "signal_delivery";
  readonly causedByEventId: EventId;
  readonly source: string;
  readonly name: string;
  readonly receiver: string;
  readonly delivered: boolean;
  readonly failureReason?:
    "receiver_not_connected" | "receiver_rejected" | "unknown" | undefined;
}

export interface ExecutionPropertyChangedTelemetryEvent extends ExecutionTelemetryBase {
  readonly kind: "property_changed";
  readonly path: string;
  readonly before: JsonValue;
  readonly after: JsonValue;
}

export interface ExecutionLogTelemetryEvent extends ExecutionTelemetryBase {
  readonly kind: "log";
  readonly level: "debug" | "info" | "warn" | "error";
  readonly source: string;
  readonly message: string;
  readonly fields: JsonObject;
}

export type ExecutionTelemetryEvent =
  | ExecutionInputTelemetryEvent
  | ExecutionSignalTelemetryEvent
  | ExecutionSignalDeliveryTelemetryEvent
  | ExecutionPropertyChangedTelemetryEvent
  | ExecutionLogTelemetryEvent;

const executionTelemetryBase = {
  schemaVersion: z.literal(1),
  eventId: EventIdSchema,
  executionId: ExecutionIdSchema,
  runId: RunIdSchema,
  branchId: BranchIdSchema,
  seq: z.number().int().nonnegative(),
  tick: TickSchema,
  simTimeUs: MicrosecondsSchema,
  causedByEventId: EventIdSchema.optional(),
};

const signalDeliveryTelemetrySchema: z.ZodType<ExecutionSignalDeliveryTelemetryEvent> =
  z
    .object({
      ...executionTelemetryBase,
      kind: z.literal("signal_delivery"),
      causedByEventId: EventIdSchema,
      source: z.string().min(1),
      name: z.string().min(1),
      receiver: z.string().min(1),
      delivered: z.boolean(),
      failureReason: z
        .enum(["receiver_not_connected", "receiver_rejected", "unknown"])
        .optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.delivered && value.failureReason !== undefined) {
        context.addIssue({
          code: "custom",
          message: "A successful delivery cannot have a failureReason",
          path: ["failureReason"],
        });
      }
      if (!value.delivered && value.failureReason === undefined) {
        context.addIssue({
          code: "custom",
          message: "A failed delivery requires a failureReason",
          path: ["failureReason"],
        });
      }
    });

export const ExecutionTelemetryEventSchema: z.ZodType<ExecutionTelemetryEvent> =
  z.union([
    z
      .object({
        ...executionTelemetryBase,
        kind: z.literal("input"),
        order: z.number().int().nonnegative(),
        action: z.string().min(1),
        target: z.string().min(1).optional(),
        payload: JsonObjectSchema,
        requestedTick: TickSchema,
        realizedTick: TickSchema,
      })
      .strict(),
    z
      .object({
        ...executionTelemetryBase,
        kind: z.literal("signal"),
        source: z.string().min(1),
        name: z.string().min(1),
        arguments: z.array(JsonValueSchema),
      })
      .strict(),
    signalDeliveryTelemetrySchema,
    z
      .object({
        ...executionTelemetryBase,
        kind: z.literal("property_changed"),
        path: z.string().min(1),
        before: JsonValueSchema,
        after: JsonValueSchema,
      })
      .strict(),
    z
      .object({
        ...executionTelemetryBase,
        kind: z.literal("log"),
        level: z.enum(["debug", "info", "warn", "error"]),
        source: z.string().min(1),
        message: z.string(),
        fields: JsonObjectSchema,
      })
      .strict(),
  ]);

export interface RestoreReceipt {
  readonly requestedCheckpointId: CheckpointId;
  readonly restoredCheckpointId: CheckpointId;
  readonly restored: true;
  readonly nextTick: Tick;
  readonly simTimeUs: Microseconds;
  readonly stateDigest: string;
}

export const RestoreReceiptSchema: z.ZodType<RestoreReceipt> = z
  .object({
    requestedCheckpointId: CheckpointIdSchema,
    restoredCheckpointId: CheckpointIdSchema,
    restored: z.literal(true),
    nextTick: TickSchema,
    simTimeUs: MicrosecondsSchema,
    stateDigest: z.string().min(1),
  })
  .strict();

export interface StepReceipt {
  readonly requestedTick: Tick;
  readonly realizedTick: Tick;
  readonly requestedDeltaUs: Microseconds;
  readonly realizedDeltaUs: Microseconds;
  readonly appliedInputOrders: readonly number[];
}

export const StepReceiptSchema: z.ZodType<StepReceipt> = z
  .object({
    requestedTick: TickSchema,
    realizedTick: TickSchema,
    requestedDeltaUs: PositiveMicrosecondsSchema,
    realizedDeltaUs: PositiveMicrosecondsSchema,
    appliedInputOrders: z.array(z.number().int().nonnegative()),
  })
  .strict();

export interface ContractEvaluation {
  readonly status: "pass" | "fail" | "incomplete";
  readonly triggerEventId: EventId;
  readonly triggerTick: Tick;
  readonly deadlineTick: Tick;
  readonly observed: StateValueObservation;
  readonly satisfiedTick?: Tick | undefined;
}

export const ContractEvaluationSchema: z.ZodType<ContractEvaluation> = z
  .object({
    status: z.enum(["pass", "fail", "incomplete"]),
    triggerEventId: EventIdSchema,
    triggerTick: TickSchema,
    deadlineTick: TickSchema,
    observed: StateValueObservationSchema,
    satisfiedTick: TickSchema.optional(),
  })
  .strict();

interface ExecutionLogBase {
  readonly schemaVersion: 1;
  readonly executionId: ExecutionId;
  readonly runId: RunId;
  readonly branchId: BranchId;
  readonly contractId: ContractId;
  readonly startCheckpointId: CheckpointId;
  readonly inputTraceId: InputTraceId;
  readonly restoreReceipt: RestoreReceipt;
  readonly stepReceipts: readonly StepReceipt[];
  readonly events: readonly ExecutionTelemetryEvent[];
  readonly timelineDigest: string;
  readonly sealed: true;
}

export interface CompletedExecutionLog extends ExecutionLogBase {
  readonly status: "completed";
  readonly evaluation: ContractEvaluation;
  readonly finalCheckpointId: CheckpointId;
}

export interface FailedExecutionLog extends ExecutionLogBase {
  readonly status: "failed";
  readonly failure: {
    readonly code: string;
    readonly message: string;
  };
}

export type ExecutionLog = CompletedExecutionLog | FailedExecutionLog;

const executionLogBase = {
  schemaVersion: z.literal(1),
  executionId: ExecutionIdSchema,
  runId: RunIdSchema,
  branchId: BranchIdSchema,
  contractId: ContractIdSchema,
  startCheckpointId: CheckpointIdSchema,
  inputTraceId: InputTraceIdSchema,
  restoreReceipt: RestoreReceiptSchema,
  stepReceipts: z.array(StepReceiptSchema),
  events: z.array(ExecutionTelemetryEventSchema),
  timelineDigest: z.string().min(1),
  sealed: z.literal(true),
};

export const ExecutionLogSchema: z.ZodType<ExecutionLog> = z
  .discriminatedUnion("status", [
    z
      .object({
        ...executionLogBase,
        status: z.literal("completed"),
        evaluation: ContractEvaluationSchema,
        finalCheckpointId: CheckpointIdSchema,
      })
      .strict(),
    z
      .object({
        ...executionLogBase,
        status: z.literal("failed"),
        failure: z
          .object({
            code: z.string().min(1),
            message: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.restoreReceipt.requestedCheckpointId !== value.startCheckpointId
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Restore receipt does not match the requested start checkpoint",
        path: ["restoreReceipt", "requestedCheckpointId"],
      });
    }
    if (value.restoreReceipt.restoredCheckpointId !== value.startCheckpointId) {
      context.addIssue({
        code: "custom",
        message: "Restore receipt realized a different checkpoint",
        path: ["restoreReceipt", "restoredCheckpointId"],
      });
    }

    const seenEventIds = new Set<string>();
    for (const [index, event] of value.events.entries()) {
      if (
        event.executionId !== value.executionId ||
        event.runId !== value.runId ||
        event.branchId !== value.branchId
      ) {
        context.addIssue({
          code: "custom",
          message: "Event provenance does not match its execution log",
          path: ["events", index],
        });
      }
      if (event.seq !== index) {
        context.addIssue({
          code: "custom",
          message: "Execution event sequence must be contiguous from zero",
          path: ["events", index, "seq"],
        });
      }
      if (seenEventIds.has(event.eventId)) {
        context.addIssue({
          code: "custom",
          message: "Execution event IDs must be unique",
          path: ["events", index, "eventId"],
        });
      }
      if (
        event.causedByEventId !== undefined &&
        !seenEventIds.has(event.causedByEventId)
      ) {
        context.addIssue({
          code: "custom",
          message: "causedByEventId must reference an earlier event",
          path: ["events", index, "causedByEventId"],
        });
      }
      seenEventIds.add(event.eventId);
    }

    if (value.status === "completed") {
      const trigger = value.events.find(
        (event) => event.eventId === value.evaluation.triggerEventId,
      );
      if (trigger?.kind !== "signal") {
        context.addIssue({
          code: "custom",
          message: "Contract evaluation trigger must resolve to a Signal",
          path: ["evaluation", "triggerEventId"],
        });
      } else if (
        trigger.tick !== value.evaluation.triggerTick ||
        value.evaluation.deadlineTick !== trigger.tick + 1
      ) {
        context.addIssue({
          code: "custom",
          message: "Contract evaluation ticks do not match the v0.1 window",
          path: ["evaluation", "deadlineTick"],
        });
      }
      if (
        value.evaluation.status === "pass" &&
        (value.evaluation.satisfiedTick === undefined ||
          value.evaluation.satisfiedTick < value.evaluation.triggerTick ||
          value.evaluation.satisfiedTick > value.evaluation.deadlineTick)
      ) {
        context.addIssue({
          code: "custom",
          message: "A passing evaluation requires an in-window satisfiedTick",
          path: ["evaluation", "satisfiedTick"],
        });
      }
      if (
        value.evaluation.status !== "pass" &&
        value.evaluation.satisfiedTick !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "Only a passing evaluation may have a satisfiedTick",
          path: ["evaluation", "satisfiedTick"],
        });
      }
    }
  });
