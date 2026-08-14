import { describe, expect, it } from "vitest";

import {
  PROJECT_ADAPTER_CAPABILITY_MODULES_V1,
  PROJECT_ADAPTER_REQUIRED_MODULES_V1,
} from "./project-environment-manifest.js";
import {
  GODOT_PROJECT_ENVIRONMENT_PROTOCOL_PROFILE_V1,
  GodotProjectEnvironmentObservationRecordV1Schema,
  GodotProjectEnvironmentWireMessageV1Schema,
  makeGodotProjectEnvironmentWireMessageV1,
  parseGodotProjectEnvironmentWireMessageV1,
} from "./project-environment-messages.js";

const modules = {
  schemaVersion: 1 as const,
  modules: PROJECT_ADAPTER_CAPABILITY_MODULES_V1.map((module) => ({
    schemaVersion: 1 as const,
    module,
    status: PROJECT_ADAPTER_REQUIRED_MODULES_V1.includes(
      module as (typeof PROJECT_ADAPTER_REQUIRED_MODULES_V1)[number],
    )
      ? ("implemented" as const)
      : ("unsupported" as const),
    protocolVersion: PROJECT_ADAPTER_REQUIRED_MODULES_V1.includes(
      module as (typeof PROJECT_ADAPTER_REQUIRED_MODULES_V1)[number],
    )
      ? "project-adapter-module:v1"
      : null,
    limitations: PROJECT_ADAPTER_REQUIRED_MODULES_V1.includes(
      module as (typeof PROJECT_ADAPTER_REQUIRED_MODULES_V1)[number],
    )
      ? []
      : ["not exposed"],
  })),
};
const digest = (value: string): string => value.repeat(64);
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
};
const fingerprint = {
  schemaVersion: 1 as const,
  protocolProfile: GODOT_PROJECT_ENVIRONMENT_PROTOCOL_PROFILE_V1,
  protocolVersion: 1 as const,
  engine: "godot" as const,
  engineVersion: "4.7.1-stable (official)",
  engineBuildHash: "build471",
  platform: "Linux",
  renderer: "headless" as const,
  displayServer: "headless" as const,
  audioDriver: "Dummy",
  physicsTicksPerSecond: 60,
  configuredMainScene: "res://main.tscn",
  modules,
  identity,
};
const clock = {
  processFrame: 10,
  physicsTick: 10,
  simulationTimeUs: 166_670,
  renderFrame: null,
};

describe("Godot Project Environment wire protocol V1", () => {
  it("round-trips its independent handshake namespace", () => {
    const message = makeGodotProjectEnvironmentWireMessageV1({
      sequence: 0,
      kind: "hello",
      payload: { token: digest("f"), fingerprint },
    });
    expect(
      parseGodotProjectEnvironmentWireMessageV1(JSON.stringify(message)),
    ).toEqual(message);
    expect(message.protocolProfile).toBe(
      "chronorift-godot-project-environment-v1",
    );
  });

  it("rejects foreign profiles, unknown fields, and payload corruption", () => {
    const message = makeGodotProjectEnvironmentWireMessageV1({
      sequence: 0,
      requestId: "request:1",
      kind: "status",
      payload: {},
    });
    expect(() =>
      GodotProjectEnvironmentWireMessageV1Schema.parse({
        ...message,
        protocolProfile: "chronorift-godot-semantic-v1",
      }),
    ).toThrow();
    expect(() =>
      GodotProjectEnvironmentWireMessageV1Schema.parse({
        ...message,
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      parseGodotProjectEnvironmentWireMessageV1(
        JSON.stringify({ ...message, payloadHash: digest("9") }),
      ),
    ).toThrow(/payload hash/u);
    expect(() =>
      GodotProjectEnvironmentWireMessageV1Schema.parse({
        ...makeGodotProjectEnvironmentWireMessageV1({
          sequence: 0,
          kind: "hello",
          payload: { token: digest("f"), fingerprint },
        }),
        payload: {
          token: digest("f"),
          fingerprint: {
            ...fingerprint,
            identity: { ...identity, instrumentationMode: "vanilla" },
          },
        },
      }),
    ).toThrow();
  });

  it("freezes request and realized-result shapes for optional control and state modules", () => {
    const cases = [
      {
        kind: "input" as const,
        payload: {
          controlId: "move.left",
          parameters: { strength: 1 },
          phase: "physics",
          duration: { clock: "physics_tick", count: 1 },
        },
      },
      {
        kind: "input_applied" as const,
        payload: {
          controlId: "move.left",
          requestedPhase: "physics",
          realizedPhase: "physics",
          requestedDuration: { clock: "physics_tick", count: 1 },
          realizedDuration: { clock: "physics_tick", count: 1 },
          startClock: clock,
          endClock: { ...clock, physicsTick: 11 },
          knownSideEffects: [],
        },
      },
      {
        kind: "controls_set" as const,
        payload: {
          controls: [
            {
              controlId: "move.left",
              parameters: { strength: 1 },
              active: true,
            },
          ],
          requestedBarrier: "physics_tick_end",
        },
      },
      {
        kind: "controls_set_result" as const,
        payload: {
          realizedControls: [
            {
              controlId: "move.left",
              active: true,
              realizedParameters: { strength: 1 },
            },
          ],
          requestedBarrier: "physics_tick_end",
          realizedBarrier: "physics_tick_end",
          clock,
          quantizationDelayUs: 0,
        },
      },
      {
        kind: "step" as const,
        payload: { clock: "physics_tick", count: 1 },
      },
      {
        kind: "stepped" as const,
        payload: {
          requestedClock: "physics_tick",
          requestedCount: 1,
          realizedCount: 1,
          startClock: clock,
          endClock: { ...clock, physicsTick: 11 },
          quantizationDelayUs: 0,
        },
      },
      {
        kind: "snapshot_create" as const,
        payload: { requestedBarrier: "physics_tick_end" },
      },
      {
        kind: "snapshot_result" as const,
        payload: {
          snapshotId: "snapshot:1",
          requestedBarrier: "physics_tick_end",
          realizedBarrier: "physics_tick_end",
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
      },
      {
        kind: "snapshot_restore" as const,
        payload: {
          snapshotId: "snapshot:1",
          requestedBarrier: "physics_tick_end",
        },
      },
      {
        kind: "snapshot_restored" as const,
        payload: {
          snapshotId: "snapshot:1",
          requestedBarrier: "physics_tick_end",
          realizedBarrier: "physics_tick_end",
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
      },
    ];
    for (const [sequence, item] of cases.entries()) {
      const message = makeGodotProjectEnvironmentWireMessageV1({
        sequence,
        requestId: `request:${sequence}`,
        kind: item.kind,
        payload: item.payload,
      });
      expect(
        parseGodotProjectEnvironmentWireMessageV1(JSON.stringify(message)),
      ).toEqual(message);
    }
  });

  it("requires canonical observation values and exact loss ranges", () => {
    expect(() =>
      GodotProjectEnvironmentObservationRecordV1Schema.parse({
        schemaVersion: 1,
        recordSequence: 0,
        clock: {
          processFrame: 0,
          physicsTick: 0,
          simulationTimeUs: 0,
          renderFrame: null,
        },
        kind: "state_sample",
        payload: {
          stateDomainId: "world",
          value: -0,
          semanticCoverage: "declared",
        },
      }),
    ).toThrow(/negative zero/u);
    expect(() =>
      GodotProjectEnvironmentObservationRecordV1Schema.parse({
        schemaVersion: 1,
        recordSequence: 0,
        clock: {
          processFrame: 0,
          physicsTick: 0,
          simulationTimeUs: 0,
          renderFrame: null,
        },
        kind: "capture_loss",
        payload: {
          channel: "state",
          firstDroppedRecordSequence: 3,
          lastDroppedRecordSequence: 5,
          droppedRecordCount: 2,
          reason: "buffer_overwrite",
        },
      }),
    ).toThrow(/count/u);
  });

  it("rejects duplicate snapshot and restore domain identities", () => {
    const snapshotDomain = {
      schemaVersion: 1 as const,
      stateDomainId: "world",
      disposition: "captured" as const,
      schemaId: "state.world",
      value: { counter: 7 },
      limitations: [],
    };
    expect(() =>
      makeGodotProjectEnvironmentWireMessageV1({
        sequence: 0,
        requestId: "request:snapshot-duplicate",
        kind: "snapshot_result",
        payload: {
          snapshotId: "snapshot:1",
          requestedBarrier: "process_frame_end",
          realizedBarrier: "process_frame_end",
          clock,
          quantizationDelayUs: 0,
          domains: [snapshotDomain, snapshotDomain],
        },
      }),
    ).toThrow(/domain IDs must be unique/u);

    const restoreDomain = {
      schemaVersion: 1 as const,
      stateDomainId: "world",
      status: "written" as const,
      reportedValue: { counter: 7 },
      knownSideEffects: [],
      limitations: [],
    };
    expect(() =>
      makeGodotProjectEnvironmentWireMessageV1({
        sequence: 0,
        requestId: "request:restore-duplicate",
        kind: "snapshot_restored",
        payload: {
          snapshotId: "snapshot:1",
          requestedBarrier: "process_frame_end",
          realizedBarrier: "process_frame_end",
          clock,
          quantizationDelayUs: 0,
          domains: [restoreDomain, restoreDomain],
        },
      }),
    ).toThrow(/domain IDs must be unique/u);
  });
});
