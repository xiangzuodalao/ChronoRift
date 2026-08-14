import { describe, expect, it } from "vitest";

import {
  GODOT_LIFECYCLE_CAPABILITIES_V1,
  GODOT_LIFECYCLE_PROTOCOL_PROFILE_V1,
  GodotLifecycleWireProtocolError,
  makeGodotLifecycleWireMessage,
  parseGodotLifecycleWireMessage,
} from "./lifecycle-messages.js";
import { makeGodotWireMessage } from "./messages.js";

const hash = (character: string): string => character.repeat(64);

const status = (processFrames: number, physicsFrames: number) => ({
  processFrames,
  physicsFrames,
  processTimeUs: processFrames * 16_667,
  physicsTimeUs: physicsFrames * 16_667,
  configuredMainScene: "uid://main-scene",
  currentScene: "res://main.tscn",
});

describe("Godot lifecycle protocol v1", () => {
  it("round-trips a strict ready message with independently hashed payload", () => {
    const message = makeGodotLifecycleWireMessage({
      sequence: 2,
      requestId: "request:ready",
      kind: "ready",
      payload: {
        baseline: status(10, 20),
        observed: status(130, 140),
      },
    });

    expect(message.protocolProfile).toBe(GODOT_LIFECYCLE_PROTOCOL_PROFILE_V1);
    expect(parseGodotLifecycleWireMessage(JSON.stringify(message))).toEqual(
      message,
    );
  });

  it("requires a current scene and 120 process frames and physics ticks", () => {
    expect(() =>
      makeGodotLifecycleWireMessage({
        sequence: 2,
        requestId: "request:ready",
        kind: "ready",
        payload: {
          baseline: status(10, 20),
          observed: status(129, 140),
        },
      }),
    ).toThrow(/120 observed process frames/u);

    expect(() =>
      makeGodotLifecycleWireMessage({
        sequence: 2,
        requestId: "request:ready",
        kind: "ready",
        payload: {
          baseline: status(10, 20),
          observed: { ...status(130, 139), currentScene: null },
        },
      }),
    ).toThrow();
  });

  it("rejects payload tampering, unknown fields, and a different profile", () => {
    const message = makeGodotLifecycleWireMessage({
      sequence: 3,
      requestId: "request:status",
      kind: "status_result",
      payload: status(150, 160),
    });

    expect(() =>
      parseGodotLifecycleWireMessage(
        JSON.stringify({
          ...message,
          payload: { ...message.payload, processFrames: 151 },
        }),
      ),
    ).toThrow(GodotLifecycleWireProtocolError);
    expect(() =>
      parseGodotLifecycleWireMessage(
        JSON.stringify({ ...message, unexpected: true }),
      ),
    ).toThrow();
    expect(() =>
      parseGodotLifecycleWireMessage(
        JSON.stringify({ ...message, protocolProfile: "godot-v2" }),
      ),
    ).toThrow();
  });

  it("does not accept M3 Protocol v2 messages in the lifecycle parser", () => {
    const v2 = makeGodotWireMessage({
      protocolVersion: 2,
      sequence: 0,
      requestId: "request:step",
      kind: "step",
      payload: { tick: 0, simTimeUs: 0, deltaUs: 1, inputs: [] },
    });

    expect(() => parseGodotLifecycleWireMessage(JSON.stringify(v2))).toThrow();
  });

  it("freezes the exact lifecycle capability order", () => {
    expect(GODOT_LIFECYCLE_CAPABILITIES_V1).toEqual([
      "lifecycle.status",
      "lifecycle.shutdown",
      "clock.process_frame",
      "clock.physics_tick",
      "scene.identity",
    ]);
    expect(hash("a")).toHaveLength(64);
  });
});
