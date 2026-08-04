import { describe, expect, it } from "vitest";

import {
  BenchmarkPublicCapsuleEvidenceV2Schema,
  BenchmarkPublicCausalEventV2Schema,
} from "../src/index.js";

const hash = "a".repeat(64);
const input = {
  eventId: "event:input",
  role: "trigger" as const,
  seq: 0,
  tick: 0,
  simTimeUs: 0,
  causedByEventId: null,
  contentHash: hash,
  kind: "input" as const,
  action: "fire_projectile",
  target: "projectile",
  requestedTick: 0,
  realizedTick: 0,
};
const spatial = {
  eventId: "event:spatial",
  role: "spatial_sample" as const,
  seq: 1,
  tick: 1,
  simTimeUs: 33_333,
  causedByEventId: input.eventId,
  contentHash: hash,
  kind: "spatial_sample" as const,
  entity: { stableId: "projectile", incarnation: 1 },
  position: [120, 0] as const,
};

const capsule = {
  capsuleId: "capsule:test",
  contentHash: hash,
  timelineDigest: hash,
  eventChainHash: hash,
  evidenceLinks: [
    { role: "trigger" as const, eventId: input.eventId },
    { role: "spatial_sample" as const, eventId: spatial.eventId },
  ],
  causalEvents: [input, spatial],
  omittedRuntimeLogCount: 1,
  expected: {
    kind: "property_equals" as const,
    path: "target.hit",
    value: true,
  },
  actual: { present: true as const, value: false },
  eventLossDetected: false,
  limitationsHash: hash,
};

describe("Benchmark public causal evidence", () => {
  it("retains auditable spatial identity and causal links", () => {
    const parsed = BenchmarkPublicCapsuleEvidenceV2Schema.parse(capsule);
    expect(parsed.causalEvents[1]).toMatchObject({
      causedByEventId: input.eventId,
      entity: { stableId: "projectile", incarnation: 1 },
      position: [120, 0],
    });
  });

  it("rejects dangling or role-mismatched public references", () => {
    expect(() =>
      BenchmarkPublicCapsuleEvidenceV2Schema.parse({
        ...capsule,
        causalEvents: [input, { ...spatial, causedByEventId: "event:missing" }],
      }),
    ).toThrow("resolve to earlier events");
    expect(() =>
      BenchmarkPublicCapsuleEvidenceV2Schema.parse({
        ...capsule,
        evidenceLinks: [
          { role: "delivery", eventId: input.eventId },
          capsule.evidenceLinks[1],
        ],
      }),
    ).toThrow("same role");
  });

  it("has no public log variant and rejects arbitrary property strings", () => {
    expect(() =>
      BenchmarkPublicCausalEventV2Schema.parse({
        ...input,
        kind: "log",
        message: "SOURCE_TEXT_CANARY",
      }),
    ).toThrow();
    expect(() =>
      BenchmarkPublicCausalEventV2Schema.parse({
        ...input,
        kind: "property_changed",
        path: "target.label",
        before: "SOURCE_TEXT_CANARY",
        after: "changed",
        entity: null,
      }),
    ).toThrow();
  });
});
