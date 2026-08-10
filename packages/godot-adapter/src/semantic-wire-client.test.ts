import { PassThrough } from "node:stream";

import {
  GODOT_SEMANTIC_CAPABILITIES_V1,
  WireFrameDecoder,
  encodeWireFrame,
  makeGodotSemanticWireMessage,
  parseGodotSemanticWireMessage,
  type GodotSemanticFingerprintV1,
} from "@chronorift/godot-protocol";
import { asSha256DigestV1 } from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import { GodotAdapterError } from "./errors.js";
import {
  GodotSemanticWireClient,
  connectGodotSemanticRuntime,
} from "./semantic-wire-client.js";
import type { GodotByteTransport } from "./godot-wire-client.js";

const digest = (character: string): string => character.repeat(64);

const identity = {
  taskId: "task:semantic",
  buildId: "build:semantic",
  runtimeId: "runtime:semantic",
  executionId: "execution:semantic",
  managedRuntimeId: `managed-godot-semantic-runtime:v1:${digest("a")}`,
  candidateSourceHash: digest("b"),
  adapterProfileSha256: digest("c"),
  overlayHash: digest("d"),
  addonHash: digest("e"),
} as const;

const adapterProfile = {
  schemaVersion: 1 as const,
  profileKind: "chronorift-godot-semantic-adapter" as const,
  adapterKind: "timer_spawn_v1" as const,
  projectCapabilitySha256: asSha256DigestV1(digest("f")),
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

const projection = (frame: number) => ({
  schemaVersion: 1 as const,
  stateSchemaVersion: "chronorift.timer-spawn:v1" as const,
  subject: {
    stableId: "semantic:subject" as const,
    incarnation: 1,
    targetScene: adapterProfile.targetScene,
    spawnIntervalSeconds: 1,
    spawnScene: "res://enemy.tscn",
  },
  timer: {
    stableId: "semantic:timer" as const,
    incarnation: 1,
    waitTimeSeconds: 1,
    timeLeftSeconds: 0.5,
    paused: false,
    stopped: false,
    oneShot: false,
    autostart: false,
    processCallback: "idle" as const,
    ignoreTimeScale: false,
    timeoutOrdinal: 0,
  },
  entities: [],
  nextSpawnOrdinal: 0,
  capturedAt: {
    processFrame: frame,
    physicsTick: frame,
    simulationTimeUs: frame * 16_667,
    hostMonotonicUs: null,
    renderFrame: null,
  },
});

const status = (frame: number) => ({
  processFrames: frame,
  physicsFrames: frame,
  processTimeUs: frame * 16_667,
  physicsTimeUs: frame * 16_667,
  configuredMainScene: "uid://main-scene",
  currentScene: "res://main.tscn",
  projection: projection(frame),
});

const fingerprint: GodotSemanticFingerprintV1 = {
  schemaVersion: 1,
  protocolProfile: "chronorift-godot-semantic-v1",
  protocolVersion: 1,
  engine: "godot",
  engineVersion: "4.7.1-stable (official)",
  engineBuildHash: "a13da4feb",
  adapterVersion: "0.5.0",
  platform: "Linux",
  renderer: "gl_compatibility",
  displayServer: "headless",
  audioDriver: "Dummy",
  physicsTicksPerSecond: 60,
  configuredMainScene: "uid://main-scene",
  capabilities: [...GODOT_SEMANTIC_CAPABILITIES_V1],
  identity,
};

const frame = (
  sequence: number,
  kind: Parameters<typeof makeGodotSemanticWireMessage>[0]["kind"],
  payload: Parameters<typeof makeGodotSemanticWireMessage>[0]["payload"],
  requestId?: string,
): Buffer =>
  encodeWireFrame(
    JSON.stringify(
      makeGodotSemanticWireMessage({
        sequence,
        kind,
        payload,
        ...(requestId === undefined ? {} : { requestId }),
      }),
    ),
  );

describe("GodotSemanticWireClient", () => {
  it("negotiates status, checkpoint, restore, and shutdown", async () => {
    const readable = new PassThrough();
    const decoder = new WireFrameDecoder();
    let sequence = 1;
    let closeCount = 0;
    const transport: GodotByteTransport = {
      readable,
      write: async (bytes) => {
        for (const json of decoder.push(bytes)) {
          const message = parseGodotSemanticWireMessage(json);
          if (message.kind === "hello_accept") {
            readable.write(
              frame(sequence++, "ready", status(10), message.requestId),
            );
          } else if (message.kind === "status") {
            readable.write(
              frame(sequence++, "status_result", status(11), message.requestId),
            );
          } else if (message.kind === "checkpoint_create") {
            readable.write(
              frame(
                sequence++,
                "checkpoint_result",
                { barrier: "adapter_process_tail", projection: projection(12) },
                message.requestId,
              ),
            );
          } else if (message.kind === "checkpoint_restore") {
            readable.write(
              frame(
                sequence++,
                "checkpoint_restored",
                {
                  restored: true,
                  projection: message.payload.projection,
                  limitations: ["private state is uncontrolled"],
                },
                message.requestId,
              ),
            );
          } else if (message.kind === "shutdown") {
            readable.write(
              frame(
                sequence++,
                "shutdown_ack",
                { status: status(13) },
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
    const connecting = connectGodotSemanticRuntime(transport, {
      schemaVersion: 1,
      token: digest("9"),
      expectedIdentity: identity,
      expectedEngineVersion: fingerprint.engineVersion,
      expectedPlatform: fingerprint.platform,
      expectedRenderer: fingerprint.renderer,
      expectedDisplayServer: fingerprint.displayServer,
      expectedAudioDriver: fingerprint.audioDriver,
      expectedMainScene: fingerprint.configuredMainScene,
      adapterProfile,
      adapterProfileSha256: asSha256DigestV1(identity.adapterProfileSha256),
    });
    readable.write(frame(0, "hello", { token: digest("9"), fingerprint }));
    const runtime = await connecting;

    await expect(runtime.status()).resolves.toMatchObject({
      sample: { processFrames: 11 },
    });
    const checkpoint = await runtime.checkpoint();
    expect(checkpoint.sample.projection.capturedAt.processFrame).toBe(12);
    await expect(
      runtime.restore(checkpoint.sample.projection),
    ).resolves.toMatchObject({
      limitations: ["private state is uncontrolled"],
    });
    await expect(runtime.shutdown()).resolves.toMatchObject({
      sample: { processFrames: 13 },
    });
    expect(closeCount).toBe(1);
  });

  it("fails closed on a non-contiguous sequence", async () => {
    const readable = new PassThrough();
    let closeCount = 0;
    const client = new GodotSemanticWireClient({
      readable,
      write: async () => undefined,
      close: async () => {
        closeCount += 1;
        readable.end();
      },
    });
    const waiting = client.waitFor(() => true);
    readable.write(frame(1, "hello", { token: digest("9"), fingerprint }));
    await expect(waiting).rejects.toThrow("Expected semantic sequence 0");
    expect(closeCount).toBe(1);
  });

  it("classifies transport errors without exposing their raw message", async () => {
    const readable = new PassThrough();
    const client = new GodotSemanticWireClient({
      readable,
      write: async () => undefined,
      close: async () => undefined,
    });
    const waiting = client.waitFor(() => true);

    readable.destroy(new Error("sensitive transport path: /host/private"));
    const failure: unknown = await waiting.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GodotAdapterError);
    expect(failure).toMatchObject({
      code: "PROCESS_FAILED",
      message: "Godot semantic transport failed",
    });
    expect((failure as Error).message).not.toContain("/host/private");
  });

  it("classifies malformed messages without exposing their raw payload", async () => {
    const readable = new PassThrough();
    const client = new GodotSemanticWireClient({
      readable,
      write: async () => undefined,
      close: async () => undefined,
    });
    const waiting = client.waitFor(() => true);

    readable.write(
      encodeWireFrame(JSON.stringify({ sensitive: "/host/private" })),
    );
    const failure: unknown = await waiting.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GodotAdapterError);
    expect(failure).toMatchObject({
      code: "PROTOCOL_ERROR",
      message: "Godot semantic decode failed",
    });
    expect((failure as Error).message).not.toContain("/host/private");
  });

  it("rejects a fingerprint outside the admitted renderer", async () => {
    const readable = new PassThrough();
    let closeCount = 0;
    const connecting = connectGodotSemanticRuntime(
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
        token: digest("9"),
        expectedIdentity: identity,
        expectedEngineVersion: fingerprint.engineVersion,
        expectedPlatform: fingerprint.platform,
        expectedRenderer: fingerprint.renderer,
        expectedDisplayServer: fingerprint.displayServer,
        expectedAudioDriver: fingerprint.audioDriver,
        expectedMainScene: fingerprint.configuredMainScene,
        adapterProfile,
        adapterProfileSha256: asSha256DigestV1(identity.adapterProfileSha256),
      },
    );
    readable.write(
      frame(0, "hello", {
        token: digest("9"),
        fingerprint: { ...fingerprint, renderer: "mobile" },
      }),
    );
    await expect(connecting).rejects.toThrow(/renderer/iu);
    expect(closeCount).toBe(1);
  });
});
