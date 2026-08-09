import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { RuntimeFingerprintV1 } from "@chronorift/domain";
import {
  WireFrameDecoder,
  encodeWireFrame,
  makeGodotWireMessage,
  parseGodotWireMessage,
  type GodotWireMessage,
} from "@chronorift/godot-protocol";

import type { GodotByteTransport } from "./godot-wire-client.js";
import { connectVNextGodotRuntime } from "./vnext-runtime.js";

const fingerprint: RuntimeFingerprintV1 = {
  schemaVersion: 1,
  engine: "godot",
  engineVersion: "4.7.1.stable.official",
  adapterVersion: "0.4.0",
  protocolVersion: 2,
  platform: "Linux",
  renderer: "gl_compatibility",
  physicsTicksPerSecond: 60,
  fixedFps: 120,
  projectHash: "a".repeat(64),
  addonHash: "b".repeat(64),
  capabilities: ["observe.property_sampling", "control.input_event_action"],
};

interface RuntimeHarness {
  readonly transport: GodotByteTransport;
  readonly hostMessages: GodotWireMessage[];
  emit(
    kind: GodotWireMessage["kind"],
    payload: unknown,
    requestId?: string,
  ): void;
  onHostMessage(listener: (message: GodotWireMessage) => void): void;
}

const createHarness = (): RuntimeHarness => {
  const readable = new PassThrough();
  const decoder = new WireFrameDecoder();
  const hostMessages: GodotWireMessage[] = [];
  const listeners: Array<(message: GodotWireMessage) => void> = [];
  let runtimeSequence = 0;
  return {
    hostMessages,
    transport: {
      readable,
      write: async (bytes) => {
        for (const json of decoder.push(bytes)) {
          const message = parseGodotWireMessage(json);
          hostMessages.push(message);
          for (const listener of listeners) listener(message);
        }
      },
      close: async () => {
        readable.end();
      },
    },
    emit(kind, payload, requestId) {
      readable.write(
        encodeWireFrame(
          JSON.stringify(
            makeGodotWireMessage({
              sequence: runtimeSequence,
              protocolVersion: 2,
              kind,
              ...(requestId === undefined ? {} : { requestId }),
              payload: payload as never,
            }),
          ),
        ),
      );
      runtimeSequence += 1;
    },
    onHostMessage(listener) {
      listeners.push(listener);
    },
  };
};

const connect = async (harness: RuntimeHarness) => {
  harness.onHostMessage((message) => {
    if (message.kind === "configure") {
      harness.emit("configured", { accepted: true }, message.requestId);
    }
  });
  const pending = connectVNextGodotRuntime(harness.transport, {
    schemaVersion: 1,
    token: "c".repeat(64),
    expectedFingerprint: fingerprint,
    requiredCapabilities: [
      "observe.property_sampling",
      "control.input_event_action",
    ],
    probePlan: {
      schemaVersion: 1,
      signals: [],
      properties: ["player.jumping", "player.window_open"],
    },
    handshakeTimeoutMs: 1_000,
  });
  harness.emit("hello", {
    token: "c".repeat(64),
    fingerprint,
  });
  return pending;
};

describe("vNext Godot runtime client", () => {
  it("authenticates, verifies the full fingerprint/capabilities, and configures probes", async () => {
    const harness = createHarness();
    const runtime = await connect(harness);
    expect(runtime.fingerprint).toEqual(fingerprint);
    expect(harness.hostMessages.map(({ kind }) => kind)).toEqual([
      "hello_accept",
      "configure",
    ]);
    expect(harness.hostMessages[1]).toMatchObject({
      kind: "configure",
      payload: {
        probePlan: {
          properties: ["player.jumping", "player.window_open"],
        },
      },
    });
  });

  it("returns strict realized step receipts using Host monotonic timestamps", async () => {
    const harness = createHarness();
    const runtime = await connect(harness);
    harness.onHostMessage((message) => {
      if (message.kind !== "step") return;
      harness.emit(
        "stepped",
        {
          events: [],
          state: { values: { "player.jumping": true } },
          receipt: {
            requestedTick: 0,
            realizedTick: 0,
            requestedDeltaUs: 8_333,
            realizedDeltaUs: 8_333,
            appliedInputOrders: [0],
            runtime: {
              schemaVersion: 1,
              phase: "process_frame_start",
              idleFramesExecuted: 1,
              physicsTicksExecuted: 0,
              actualIdleDeltasUs: [8_333],
              actualPhysicsDeltasUs: [],
              engineProcessFrame: 1,
              enginePhysicsFrame: 0,
              hostMonotonicStartUs: 0,
              hostMonotonicEndUs: 0,
              inputApplications: [
                {
                  order: 0,
                  eventsInjected: 2,
                  pressed: true,
                  released: true,
                },
              ],
              observationHealth: {
                schemaVersion: 1,
                emittedEvents: 0,
                droppedEvents: 0,
                truncatedEvents: 0,
                bufferedBytes: 0,
                backpressure: false,
                probeOverheadUs: 0,
              },
            },
          },
        },
        message.requestId,
      );
    });

    const result = await runtime.step({
      tick: 0,
      simTimeUs: 0,
      deltaUs: 8_333,
      inputs: [
        {
          localId: "input:0",
          order: 0,
          action: "attempt_jump",
          payload: {},
        },
      ],
    });
    expect(result.state.values["player.jumping"]).toBe(true);
    expect(result.receipt.runtime.hostMonotonicEndUs).toBeGreaterThanOrEqual(
      result.receipt.runtime.hostMonotonicStartUs,
    );
  });

  it("fails closed on a mismatched runtime fingerprint", async () => {
    const harness = createHarness();
    const pending = connectVNextGodotRuntime(harness.transport, {
      schemaVersion: 1,
      token: "c".repeat(64),
      expectedFingerprint: fingerprint,
      requiredCapabilities: [],
      probePlan: { schemaVersion: 1, signals: [], properties: [] },
      handshakeTimeoutMs: 1_000,
    });
    harness.emit("hello", {
      token: "c".repeat(64),
      fingerprint: { ...fingerprint, projectHash: "d".repeat(64) },
    });
    await expect(pending).rejects.toThrow("fingerprint mismatch");
  });
});
