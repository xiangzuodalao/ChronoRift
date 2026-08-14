import { PassThrough } from "node:stream";

import {
  GODOT_LIFECYCLE_CAPABILITIES_V1,
  WireFrameDecoder,
  encodeWireFrame,
  makeGodotLifecycleWireMessage,
  makeGodotWireMessage,
  parseGodotLifecycleWireMessage,
  type GodotLifecycleFingerprintV1,
} from "@chronorift/godot-protocol";
import { describe, expect, it } from "vitest";

import {
  GodotLifecycleWireClient,
  connectGodotLifecycleRuntime,
} from "./lifecycle-wire-client.js";
import type { GodotByteTransport } from "./godot-wire-client.js";

const digest = (character: string): string => character.repeat(64);

const identity = {
  taskId: "task:lifecycle",
  buildId: "build:lifecycle",
  runtimeId: "runtime:lifecycle",
  executionId: "execution:lifecycle",
  managedRuntimeId: `managed-godot-runtime:v1:${digest("a")}`,
  candidateSourceHash: digest("b"),
  overlayHash: digest("c"),
  addonHash: digest("d"),
} as const;

const fingerprint: GodotLifecycleFingerprintV1 = {
  schemaVersion: 1,
  protocolProfile: "chronorift-godot-lifecycle-v1",
  protocolVersion: 1,
  engine: "godot",
  engineVersion: "4.7.1-stable (official)",
  engineBuildHash: "a13da4feb",
  adapterVersion: "0.4.0",
  platform: "Linux",
  renderer: "gl_compatibility",
  displayServer: "headless",
  audioDriver: "Dummy",
  physicsTicksPerSecond: 60,
  configuredMainScene: "uid://main-scene",
  capabilities: [...GODOT_LIFECYCLE_CAPABILITIES_V1],
  identity,
};

const status = (processFrames: number, physicsFrames: number) => ({
  processFrames,
  physicsFrames,
  processTimeUs: processFrames * 16_667,
  physicsTimeUs: physicsFrames * 16_667,
  configuredMainScene: "uid://main-scene",
  currentScene: "res://main.tscn",
});

const runtimeFrame = (
  sequence: number,
  kind: "hello" | "ready" | "status_result" | "shutdown_ack",
  payload: Parameters<typeof makeGodotLifecycleWireMessage>[0]["payload"],
  requestId?: string,
): Buffer =>
  encodeWireFrame(
    JSON.stringify(
      makeGodotLifecycleWireMessage({
        sequence,
        kind,
        payload,
        ...(requestId === undefined ? {} : { requestId }),
      }),
    ),
  );

describe("GodotLifecycleWireClient", () => {
  it("performs the lifecycle handshake, status, and shutdown only", async () => {
    const readable = new PassThrough();
    const hostDecoder = new WireFrameDecoder();
    let runtimeSequence = 1;
    let closeCount = 0;
    const transport: GodotByteTransport = {
      readable,
      write: async (bytes) => {
        for (const json of hostDecoder.push(bytes)) {
          const message = parseGodotLifecycleWireMessage(json);
          if (message.kind === "hello_accept") {
            readable.write(
              runtimeFrame(
                runtimeSequence++,
                "ready",
                {
                  baseline: status(10, 20),
                  observed: status(130, 140),
                },
                message.requestId,
              ),
            );
          } else if (message.kind === "status") {
            readable.write(
              runtimeFrame(
                runtimeSequence++,
                "status_result",
                status(150, 160),
                message.requestId,
              ),
            );
          } else if (message.kind === "shutdown") {
            readable.write(
              runtimeFrame(
                runtimeSequence++,
                "shutdown_ack",
                { status: status(151, 161) },
                message.requestId,
              ),
            );
          }
        }
      },
      close: async () => {
        closeCount += 1;
        readable.end();
      },
    };

    const connected = connectGodotLifecycleRuntime(transport, {
      schemaVersion: 1,
      token: digest("e"),
      expectedIdentity: identity,
      expectedEngineVersion: fingerprint.engineVersion,
      expectedPlatform: fingerprint.platform,
      expectedRenderer: fingerprint.renderer,
      expectedDisplayServer: fingerprint.displayServer,
      expectedAudioDriver: fingerprint.audioDriver,
      expectedMainScene: fingerprint.configuredMainScene,
    });
    readable.write(
      runtimeFrame(0, "hello", { token: digest("e"), fingerprint }),
    );
    const runtime = await connected;

    expect(runtime.ready.observed.processFrames).toBe(130);
    await expect(runtime.status()).resolves.toMatchObject({
      sample: { processFrames: 150, physicsFrames: 160 },
    });
    await expect(runtime.shutdown()).resolves.toMatchObject({
      sample: { processFrames: 151, physicsFrames: 161 },
    });
    expect(closeCount).toBe(1);
  });

  it("fails closed on a non-contiguous lifecycle sequence", async () => {
    const readable = new PassThrough();
    let closeCount = 0;
    const client = new GodotLifecycleWireClient({
      readable,
      write: async () => undefined,
      close: async () => {
        closeCount += 1;
        readable.end();
      },
    });
    const waiting = client.waitFor(() => true);
    readable.write(
      runtimeFrame(1, "hello", { token: digest("e"), fingerprint }),
    );

    await expect(waiting).rejects.toThrow(
      "Expected lifecycle runtime sequence 0",
    );
    expect(closeCount).toBe(1);
  });

  it("rejects a runtime outside the admitted platform and renderer", async () => {
    const readable = new PassThrough();
    let closeCount = 0;
    const connecting = connectGodotLifecycleRuntime(
      {
        readable,
        write: async () => undefined,
        close: async () => {
          closeCount += 1;
          readable.end();
        },
      },
      {
        schemaVersion: 1,
        token: digest("e"),
        expectedIdentity: identity,
        expectedEngineVersion: fingerprint.engineVersion,
        expectedPlatform: fingerprint.platform,
        expectedRenderer: fingerprint.renderer,
        expectedDisplayServer: fingerprint.displayServer,
        expectedAudioDriver: fingerprint.audioDriver,
        expectedMainScene: fingerprint.configuredMainScene,
      },
    );
    readable.write(
      runtimeFrame(0, "hello", {
        token: digest("e"),
        fingerprint: { ...fingerprint, renderer: "mobile" },
      }),
    );

    await expect(connecting).rejects.toThrow(/renderer/iu);
    expect(closeCount).toBe(1);
  });

  it("does not decode an M3 Protocol v2 frame", async () => {
    const readable = new PassThrough();
    const client = new GodotLifecycleWireClient({
      readable,
      write: async () => undefined,
      close: async () => {
        readable.end();
      },
    });
    const waiting = client.waitFor(() => true);
    const v2 = makeGodotWireMessage({
      protocolVersion: 2,
      sequence: 0,
      requestId: "request:step",
      kind: "step",
      payload: { tick: 0, simTimeUs: 0, deltaUs: 1, inputs: [] },
    });
    readable.write(encodeWireFrame(JSON.stringify(v2)));

    await expect(waiting).rejects.toThrow();
  });
});
