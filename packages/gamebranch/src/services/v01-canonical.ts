import type {
  ExecutionLog,
  ExecutionTelemetryEvent,
  JsonValue,
  StepReceipt,
} from "@chronorift/domain";

import { canonicalStringify, digestJson } from "./canonical.js";

const normalizedEvent = (
  event: ExecutionTelemetryEvent,
  seqByEventId: ReadonlyMap<string, number>,
): JsonValue => {
  const common = {
    seq: event.seq,
    tick: event.tick,
    simTimeUs: event.simTimeUs,
    causedBySeq:
      event.causedByEventId === undefined
        ? null
        : (seqByEventId.get(event.causedByEventId) ?? null),
    kind: event.kind,
  };

  switch (event.kind) {
    case "input":
      return {
        ...common,
        order: event.order,
        action: event.action,
        target: event.target ?? null,
        payload: event.payload,
        requestedTick: event.requestedTick,
        realizedTick: event.realizedTick,
      };
    case "signal":
      return {
        ...common,
        source: event.source,
        name: event.name,
        arguments: [...event.arguments],
      };
    case "signal_delivery":
      return {
        ...common,
        source: event.source,
        name: event.name,
        receiver: event.receiver,
        delivered: event.delivered,
        failureReason: event.failureReason ?? null,
      };
    case "property_changed":
      return {
        ...common,
        path: event.path,
        before: event.before,
        after: event.after,
      };
    case "log":
      return {
        ...common,
        level: event.level,
        source: event.source,
        message: event.message,
        fields: event.fields,
      };
  }
};

const normalizedReceipt = (receipt: StepReceipt): JsonValue => ({
  requestedTick: receipt.requestedTick,
  realizedTick: receipt.realizedTick,
  requestedDeltaUs: receipt.requestedDeltaUs,
  realizedDeltaUs: receipt.realizedDeltaUs,
  appliedInputOrders: [...receipt.appliedInputOrders],
});

export const computeExecutionTimelineDigest = (
  stepReceipts: readonly StepReceipt[],
  events: readonly ExecutionTelemetryEvent[],
): string => {
  const seqByEventId = new Map(
    events.map((event) => [event.eventId, event.seq] as const),
  );
  return digestJson({
    stepReceipts: stepReceipts.map(normalizedReceipt),
    events: events.map((event) => normalizedEvent(event, seqByEventId)),
  });
};

const observationAtTick = (
  execution: ExecutionLog,
  tick: number,
): JsonValue => {
  const seqByEventId = new Map(
    execution.events.map((event) => [event.eventId, event.seq] as const),
  );
  const receipt = execution.stepReceipts.find(
    (candidate) => candidate.realizedTick === tick,
  );
  return {
    receipt: receipt === undefined ? null : normalizedReceipt(receipt),
    events: execution.events
      .filter((event) => event.tick === tick)
      .map((event) => normalizedEvent(event, seqByEventId)),
  };
};

export const firstExecutionDivergenceTick = (
  baseline: ExecutionLog,
  candidate: ExecutionLog,
): number | null => {
  const ticks = new Set([
    ...baseline.stepReceipts.map((receipt) => receipt.realizedTick),
    ...candidate.stepReceipts.map((receipt) => receipt.realizedTick),
    ...baseline.events.map((event) => event.tick),
    ...candidate.events.map((event) => event.tick),
  ]);
  for (const tick of [...ticks].sort((left, right) => left - right)) {
    if (
      canonicalStringify(observationAtTick(baseline, tick)) !==
      canonicalStringify(observationAtTick(candidate, tick))
    ) {
      return tick;
    }
  }
  return null;
};
