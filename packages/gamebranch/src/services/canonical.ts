import { createHash } from "node:crypto";

import type {
  BranchRun,
  FrameRecord,
  JsonValue,
  TelemetryEvent,
} from "@chronorift/domain";

export const canonicalStringify = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const fields = Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalStringify(value[key] as JsonValue)}`,
    );
  return `{${fields.join(",")}}`;
};

export const digestJson = (value: JsonValue): string =>
  `sha256:${createHash("sha256").update(canonicalStringify(value)).digest("hex")}`;

export const jsonEqual = (left: JsonValue, right: JsonValue): boolean =>
  canonicalStringify(left) === canonicalStringify(right);

const normalizeEvent = (
  event: TelemetryEvent,
  eventSeqById: ReadonlyMap<string, number>,
): JsonValue => {
  const common = {
    seq: event.seq,
    tick: event.tick,
    simTimeUs: event.simTimeUs,
    causedBySeq:
      event.causedByEventId === undefined
        ? null
        : (eventSeqById.get(event.causedByEventId) ?? null),
    kind: event.kind,
  };

  switch (event.kind) {
    case "input":
      return {
        ...common,
        action: event.action,
        target: event.target ?? null,
        payload: event.payload,
      };
    case "signal":
      return {
        ...common,
        source: event.source,
        name: event.name,
        arguments: [...event.arguments],
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

export const computeTimelineDigest = (
  frames: readonly FrameRecord[],
  events: readonly TelemetryEvent[],
): string => {
  const eventSeqById = new Map(
    events.map((event) => [event.eventId, event.seq]),
  );
  const normalized: JsonValue = {
    frames: frames.map((frame) => ({
      tick: frame.tick,
      simTimeUs: frame.simTimeUs,
      deltaUs: frame.deltaUs,
      state: frame.state.values,
      eventSeqs: frame.eventIds.map((id) => eventSeqById.get(id) ?? -1),
    })),
    events: events.map((event) => normalizeEvent(event, eventSeqById)),
  };
  return digestJson(normalized);
};

const observationalFrame = (run: BranchRun, frame: FrameRecord): JsonValue => {
  const eventsById = new Map(run.events.map((event) => [event.eventId, event]));
  return {
    state: frame.state.values,
    events: frame.eventIds.map((eventId) => {
      const event = eventsById.get(eventId);
      if (event === undefined) return null;
      switch (event.kind) {
        case "input":
          return {
            kind: event.kind,
            action: event.action,
            target: event.target ?? null,
            payload: event.payload,
          };
        case "signal":
          return {
            kind: event.kind,
            source: event.source,
            name: event.name,
            arguments: [...event.arguments],
          };
        case "property_changed":
          return {
            kind: event.kind,
            path: event.path,
            before: event.before,
            after: event.after,
          };
        case "log":
          return {
            kind: event.kind,
            level: event.level,
            source: event.source,
            message: event.message,
            fields: event.fields,
          };
      }
    }),
  };
};

/** Finds gameplay divergence; configured clock differences alone do not count. */
export const firstObservationalDivergenceTick = (
  baseline: BranchRun,
  candidate: BranchRun,
): number | null => {
  const length = Math.max(baseline.frames.length, candidate.frames.length);
  for (let index = 0; index < length; index += 1) {
    const left = baseline.frames[index];
    const right = candidate.frames[index];
    if (left === undefined || right === undefined) {
      return left?.tick ?? right?.tick ?? null;
    }
    if (
      canonicalStringify(observationalFrame(baseline, left)) !==
      canonicalStringify(observationalFrame(candidate, right))
    ) {
      return left.tick;
    }
  }
  return null;
};
