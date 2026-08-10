import { describe, expect, it } from "vitest";

import {
  GODOT_SEMANTIC_CAPABILITIES_V1,
  GodotSemanticWireMessageSchema,
  makeGodotSemanticWireMessage,
  parseGodotSemanticWireMessage,
} from "./semantic-messages.js";

const hash = "a".repeat(64);
const profile = {
  schemaVersion: 1 as const,
  profileKind: "chronorift-godot-semantic-adapter" as const,
  adapterKind: "timer_spawn_v1" as const,
  projectCapabilitySha256: hash,
  targetScene: "res://components/spawner/enemy_spawner_broken.tscn",
  spawnIntervalSeconds: 1,
  checkpointBarrier: "adapter_process_tail" as const,
  limits: {
    activeRuntimesMaximum: 2 as const,
    launchesPerTurnMaximum: 8 as const,
    entityMaximum: 256 as const,
    eventMaximum: 4096 as const,
    rawSemanticBytesMaximum: 2_097_152 as const,
    checkpointBytesMaximum: 1_048_576 as const,
    traceSamplesMaximum: 32 as const,
    traceTicksMaximum: 600 as const,
    queryRowsMaximum: 200 as const,
  },
};

describe("Godot semantic wire protocol", () => {
  it("round-trips the frozen adapter acceptance message", () => {
    const message = makeGodotSemanticWireMessage({
      sequence: 0,
      requestId: "accept:1",
      kind: "hello_accept",
      payload: {
        requiredCapabilities: [...GODOT_SEMANTIC_CAPABILITIES_V1],
        adapterProfile: profile,
        adapterProfileSha256: hash,
      },
    });
    expect(parseGodotSemanticWireMessage(JSON.stringify(message))).toEqual(
      message,
    );
  });

  it("rejects lifecycle profile messages and unknown fields", () => {
    const message = makeGodotSemanticWireMessage({
      sequence: 0,
      requestId: "status:1",
      kind: "status",
      payload: {},
    });
    expect(() =>
      GodotSemanticWireMessageSchema.parse({
        ...message,
        protocolProfile: "chronorift-godot-lifecycle-v1",
      }),
    ).toThrow();
    expect(() =>
      GodotSemanticWireMessageSchema.parse({ ...message, unexpected: true }),
    ).toThrow();
  });

  it("rejects a corrupted payload hash", () => {
    const message = makeGodotSemanticWireMessage({
      sequence: 0,
      requestId: "status:1",
      kind: "status",
      payload: {},
    });
    expect(() =>
      parseGodotSemanticWireMessage(
        JSON.stringify({ ...message, payloadHash: "b".repeat(64) }),
      ),
    ).toThrow(/payload hash/u);
  });
});
