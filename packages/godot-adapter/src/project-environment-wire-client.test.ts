import { PassThrough } from "node:stream";

import {
  GODOT_PROJECT_ENVIRONMENT_PROTOCOL_PROFILE_V1,
  PROJECT_ADAPTER_CAPABILITY_MODULES_V1,
  PROJECT_ADAPTER_REQUIRED_MODULES_V1,
  WireFrameDecoder,
  encodeWireFrame,
  makeGodotProjectEnvironmentWireMessageV1,
  parseGodotProjectEnvironmentWireMessageV1,
  type GodotProjectEnvironmentFingerprintV1,
} from "@chronorift/godot-protocol";
import { describe, expect, it } from "vitest";

import { GodotAdapterError } from "./errors.js";
import type { GodotByteTransport } from "./godot-wire-client.js";
import {
  GodotProjectEnvironmentWireClientV1,
  connectGodotProjectEnvironmentRuntimeV1,
} from "./project-environment-wire-client.js";

const digest = (character: string): string => character.repeat(64);
const modules = {
  schemaVersion: 1 as const,
  modules: PROJECT_ADAPTER_CAPABILITY_MODULES_V1.map((module) => {
    const required = PROJECT_ADAPTER_REQUIRED_MODULES_V1.includes(
      module as (typeof PROJECT_ADAPTER_REQUIRED_MODULES_V1)[number],
    );
    return {
      schemaVersion: 1 as const,
      module,
      status: required ? ("implemented" as const) : ("unsupported" as const),
      protocolVersion: required ? "project-adapter-module:v1" : null,
      limitations: required ? [] : ["not exposed"],
    };
  }),
};
const identity = {
  taskId: "task:1",
  sourceClosureId: "source:1",
  environmentRevisionId: "environment:1",
  adapterRevisionId: "adapter:1",
  buildId: "build:1",
  runtimeId: "runtime:1",
  executionId: "execution:1",
  instrumentationMode: "instrumented" as const,
  candidateSourceHash: digest("a"),
  adapterManifestSha256: digest("b"),
  sdkSha256: digest("c"),
  bridgeSha256: digest("d"),
  toolchainSha256: digest("e"),
} as const;
const fingerprint: GodotProjectEnvironmentFingerprintV1 = {
  schemaVersion: 1,
  protocolProfile: GODOT_PROJECT_ENVIRONMENT_PROTOCOL_PROFILE_V1,
  protocolVersion: 1,
  engine: "godot",
  engineVersion: "4.7.1-stable (official)",
  engineBuildHash: "build471",
  platform: "Linux",
  renderer: "headless",
  displayServer: "headless",
  audioDriver: "Dummy",
  physicsTicksPerSecond: 60,
  configuredMainScene: "res://main.tscn",
  modules,
  identity,
};
const coverage = {
  status: "complete" as const,
  firstAvailableRecordSequence: 0,
  lastAvailableRecordSequence: 0,
  droppedRecordCount: 0,
  overwriteCount: 0,
  semanticCoverage: "declared" as const,
};
const clock = {
  processFrame: 10,
  physicsTick: 10,
  simulationTimeUs: 166_670,
  renderFrame: null,
};
const status = {
  running: true,
  configuredMainScene: "res://main.tscn",
  currentScene: "res://main.tscn",
  clock,
  // The bridge may have produced retained records before hello_accept. The
  // client must begin at firstAvailableRecordSequence, not skip to this tail.
  nextObservationRecordSequence: 1,
  coverage,
};
const frame = (
  sequence: number,
  kind: Parameters<typeof makeGodotProjectEnvironmentWireMessageV1>[0]["kind"],
  payload: Parameters<
    typeof makeGodotProjectEnvironmentWireMessageV1
  >[0]["payload"],
  requestId?: string,
): Buffer =>
  encodeWireFrame(
    JSON.stringify(
      makeGodotProjectEnvironmentWireMessageV1({
        sequence,
        kind,
        payload,
        ...(requestId === undefined ? {} : { requestId }),
      }),
    ),
  );

describe("Godot Project Environment wire client V1", () => {
  it("negotiates identity, consumes and acknowledges pushed observations", async () => {
    const readable = new PassThrough();
    const decoder = new WireFrameDecoder();
    let incomingSequence = 1;
    let acknowledged = false;
    let acknowledgedWindowBatches: number | undefined;
    let closeCount = 0;
    const transport: GodotByteTransport = {
      readable,
      write: async (bytes) => {
        for (const json of decoder.push(bytes)) {
          const message = parseGodotProjectEnvironmentWireMessageV1(json);
          if (message.kind === "hello_accept") {
            readable.write(
              frame(incomingSequence++, "ready", status, message.requestId),
            );
            readable.write(
              frame(incomingSequence++, "observation_batch", {
                batchId: "batch:1",
                firstRecordSequence: 0,
                lastRecordSequence: 0,
                records: [
                  {
                    schemaVersion: 1,
                    recordSequence: 0,
                    clock,
                    kind: "state_sample",
                    payload: {
                      stateDomainId: "world",
                      value: { running: true },
                      semanticCoverage: "declared",
                    },
                  },
                ],
                coverage,
              }),
            );
          } else if (message.kind === "observation_ack") {
            acknowledged = message.payload.batchId === "batch:1";
            acknowledgedWindowBatches = message.payload.nextWindowBatches;
          } else if (message.kind === "status") {
            readable.write(
              frame(
                incomingSequence++,
                "status_result",
                { ...status, nextObservationRecordSequence: 1 },
                message.requestId,
              ),
            );
          } else if (message.kind === "input") {
            readable.write(
              frame(
                incomingSequence++,
                "input_applied",
                {
                  controlId: message.payload.controlId,
                  requestedPhase: message.payload.phase,
                  realizedPhase: message.payload.phase,
                  requestedDuration: message.payload.duration,
                  realizedDuration: message.payload.duration,
                  startClock: clock,
                  endClock: { ...clock, physicsTick: 11 },
                  knownSideEffects: [],
                },
                message.requestId,
              ),
            );
          } else if (message.kind === "controls_set") {
            readable.write(
              frame(
                incomingSequence++,
                "controls_set_result",
                {
                  realizedControls: message.payload.controls.map((control) => ({
                    controlId: control.controlId,
                    active: control.active,
                    realizedParameters: control.parameters,
                  })),
                  requestedBarrier: message.payload.requestedBarrier,
                  realizedBarrier: message.payload.requestedBarrier,
                  clock,
                  quantizationDelayUs: 0,
                },
                message.requestId,
              ),
            );
          } else if (message.kind === "step") {
            readable.write(
              frame(
                incomingSequence++,
                "stepped",
                {
                  requestedClock: message.payload.clock,
                  requestedCount: message.payload.count,
                  realizedCount: message.payload.count,
                  startClock: clock,
                  endClock: { ...clock, physicsTick: 11 },
                  quantizationDelayUs: 0,
                },
                message.requestId,
              ),
            );
          } else if (message.kind === "snapshot_create") {
            readable.write(
              frame(
                incomingSequence++,
                "snapshot_result",
                {
                  snapshotId: "snapshot:1",
                  requestedBarrier: message.payload.requestedBarrier,
                  realizedBarrier: message.payload.requestedBarrier,
                  clock,
                  quantizationDelayUs: 0,
                  domains: [
                    {
                      schemaVersion: 1,
                      stateDomainId: "world",
                      disposition: "captured",
                      schemaId: "state.world",
                      value: { running: true },
                      limitations: [],
                    },
                  ],
                },
                message.requestId,
              ),
            );
          } else if (message.kind === "snapshot_restore") {
            readable.write(
              frame(
                incomingSequence++,
                "snapshot_restored",
                {
                  snapshotId: message.payload.snapshotId,
                  requestedBarrier: message.payload.requestedBarrier,
                  realizedBarrier: message.payload.requestedBarrier,
                  clock,
                  quantizationDelayUs: 0,
                  domains: [
                    {
                      schemaVersion: 1,
                      stateDomainId: "world",
                      status: "written",
                      reportedValue: { running: true },
                      knownSideEffects: [],
                      limitations: [],
                    },
                  ],
                },
                message.requestId,
              ),
            );
          } else if (message.kind === "shutdown") {
            readable.write(
              frame(
                incomingSequence++,
                "shutdown_ack",
                {
                  status: {
                    ...status,
                    running: false,
                    nextObservationRecordSequence: 1,
                  },
                },
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
    const connecting = connectGodotProjectEnvironmentRuntimeV1(transport, {
      schemaVersion: 1,
      token: digest("f"),
      expectedIdentity: identity,
      expectedEngineVersion: fingerprint.engineVersion,
      expectedPlatform: "Linux",
      expectedMainScene: "res://main.tscn",
      expectedAdapterManifestSha256: identity.adapterManifestSha256,
      requiredModules: PROJECT_ADAPTER_REQUIRED_MODULES_V1,
    });
    readable.write(frame(0, "hello", { token: digest("f"), fingerprint }));
    const runtime = await connecting;
    const batch = await runtime.nextObservationBatch();
    expect(batch.records[0]).toMatchObject({ kind: "state_sample" });
    await runtime.acknowledgeObservationBatch(batch);
    expect(acknowledged).toBe(true);
    expect(acknowledgedWindowBatches).toBe(1);
    await expect(runtime.status()).resolves.toMatchObject({
      nextObservationRecordSequence: 1,
    });
    await expect(
      runtime.input({
        controlId: "move.left",
        parameters: { strength: 1 },
        phase: "physics",
        duration: { clock: "physics_tick", count: 1 },
      }),
    ).resolves.toMatchObject({ controlId: "move.left" });
    await expect(
      runtime.setControls({
        controls: [
          { controlId: "move.left", parameters: { strength: 1 }, active: true },
        ],
        requestedBarrier: "physics_tick_end",
      }),
    ).resolves.toMatchObject({
      realizedControls: [{ controlId: "move.left", active: true }],
    });
    await expect(
      runtime.step({ clock: "physics_tick", count: 1 }),
    ).resolves.toMatchObject({ realizedCount: 1 });
    const snapshot = await runtime.snapshot({
      requestedBarrier: "physics_tick_end",
    });
    expect(snapshot).toMatchObject({ snapshotId: "snapshot:1" });
    await expect(
      runtime.restore({
        snapshotId: snapshot.snapshotId,
        requestedBarrier: "physics_tick_end",
      }),
    ).resolves.toMatchObject({
      domains: [{ stateDomainId: "world", status: "written" }],
    });
    await expect(runtime.shutdown()).resolves.toMatchObject({
      status: { running: false },
    });
    expect(closeCount).toBe(1);
  });

  it("fails closed on wire and observation sequence discontinuity", async () => {
    const readable = new PassThrough();
    const client = new GodotProjectEnvironmentWireClientV1({
      readable,
      write: async () => undefined,
      close: async () => {
        readable.end();
      },
    });
    const waiting = client.waitFor(() => true);
    readable.write(frame(1, "hello", { token: digest("f"), fingerprint }));
    await expect(waiting).rejects.toThrow(
      /Expected Project Environment sequence 0/u,
    );
  });

  it.each([
    ["partial semantic coverage", { semanticCoverage: "partial" as const }],
    ["unknown semantic coverage", { semanticCoverage: "unknown" as const }],
    [
      "lossy transport coverage",
      {
        status: "partial" as const,
        droppedRecordCount: 1,
      },
    ],
  ])("rejects instrumented Ready with %s", async (_label, coveragePatch) => {
    const readable = new PassThrough();
    const decoder = new WireFrameDecoder();
    let incomingSequence = 1;
    const transport: GodotByteTransport = {
      readable,
      write: async (bytes) => {
        for (const json of decoder.push(bytes)) {
          const message = parseGodotProjectEnvironmentWireMessageV1(json);
          if (message.kind === "hello_accept") {
            readable.write(
              frame(
                incomingSequence++,
                "ready",
                {
                  ...status,
                  coverage: { ...coverage, ...coveragePatch },
                },
                message.requestId,
              ),
            );
          }
        }
      },
      close: async () => {
        readable.end();
      },
    };
    const connecting = connectGodotProjectEnvironmentRuntimeV1(transport, {
      schemaVersion: 1,
      token: digest("f"),
      expectedIdentity: identity,
      expectedEngineVersion: fingerprint.engineVersion,
      expectedPlatform: "Linux",
      expectedMainScene: "res://main.tscn",
      expectedAdapterManifestSha256: identity.adapterManifestSha256,
      requiredModules: PROJECT_ADAPTER_REQUIRED_MODULES_V1,
    });
    readable.write(frame(0, "hello", { token: digest("f"), fingerprint }));

    await expect(connecting).rejects.toThrow(/invalid readiness sample/u);
  });

  it("sanitizes transport errors", async () => {
    const readable = new PassThrough();
    const client = new GodotProjectEnvironmentWireClientV1({
      readable,
      write: async () => undefined,
      close: async () => undefined,
    });
    const waiting = client.waitFor(() => true);
    readable.destroy(new Error("secret host path /private/project"));
    const failure = await waiting.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GodotAdapterError);
    expect(failure).toMatchObject({
      code: "PROCESS_FAILED",
      message: "Project Environment transport failed",
    });
    expect((failure as Error).message).not.toContain("/private/project");
  });
});
