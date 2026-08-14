import { describe, expect, it } from "vitest";

import {
  GodotSemanticAdapterProfileV1Schema,
  VNextSemanticCheckpointPayloadV1Schema,
  VNextSemanticCheckpointResourceV1Schema,
  VNextSemanticTraceV1Schema,
  VNextTimerSpawnProjectionV1Schema,
} from "../src/index.js";

const digest = "a".repeat(64);
const clock = {
  processFrame: 120,
  physicsTick: 60,
  simulationTimeUs: 1_000_000,
  hostMonotonicUs: 2_000_000,
  renderFrame: null,
};
const projection = {
  schemaVersion: 1 as const,
  stateSchemaVersion: "chronorift.timer-spawn:v1" as const,
  subject: {
    stableId: "semantic:subject" as const,
    incarnation: 1,
    targetScene: "res://components/spawner/enemy_spawner_broken.tscn",
    spawnIntervalSeconds: 1,
    spawnScene: "res://components/enemy/storyvore_enemy.tscn",
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
    timeoutOrdinal: 1,
  },
  entities: [
    {
      stableId: "semantic:spawn:0",
      incarnation: 1,
      spawnOrdinal: 0,
      scene: "res://components/enemy/storyvore_enemy.tscn",
      parentStableId: "semantic:harness" as const,
      transform: {
        position: { x: 0, y: 0 },
        rotation: 0,
        scale: { x: 1, y: 1 },
      },
      visible: true,
      processMode: 0,
      velocity: { x: -100, y: 0 },
    },
  ],
  nextSpawnOrdinal: 1,
  capturedAt: clock,
};

const checkpointPayload = {
  schemaVersion: 1 as const,
  taskId: "task:v1:test",
  checkpointId: "checkpoint:v1:test",
  executionId: "execution:v1:test",
  runtimeId: "runtime:v1:test",
  buildId: "build:v1:test",
  adapterId: "adapter:v1:test",
  adapterProfileSha256: digest,
  semanticBarrier: "adapter_process_tail" as const,
  projection,
  projectionSha256: digest,
  capturedDomains: [
    "subject.configuration",
    "spawned_entities",
    "timer.configuration",
    "timer.runtime",
  ],
  uncontrolledDomains: ["physics_server"],
  restoreDependencyOrder: [
    "subject.configuration",
    "spawned_entities",
    "timer.configuration",
    "timer.runtime",
  ] as const,
  fidelity: "descriptive_only" as const,
  equivalentForkEligible: false as const,
};

describe("external Timer/spawn semantic contracts", () => {
  it("accepts the bounded data-only adapter profile and rejects traversal", () => {
    expect(
      GodotSemanticAdapterProfileV1Schema.parse({
        schemaVersion: 1,
        profileKind: "chronorift-godot-semantic-adapter",
        adapterKind: "timer_spawn_v1",
        projectCapabilitySha256: digest,
        targetScene: "res://components/spawner/enemy_spawner_broken.tscn",
        spawnIntervalSeconds: 1,
        checkpointBarrier: "adapter_process_tail",
        limits: {
          activeRuntimesMaximum: 2,
          launchesPerTurnMaximum: 8,
          entityMaximum: 256,
          eventMaximum: 4096,
          rawSemanticBytesMaximum: 2_097_152,
          checkpointBytesMaximum: 1_048_576,
          traceSamplesMaximum: 32,
          traceTicksMaximum: 600,
          queryRowsMaximum: 200,
        },
      }).targetScene,
    ).toContain("enemy_spawner_broken.tscn");
    expect(() =>
      GodotSemanticAdapterProfileV1Schema.parse({
        schemaVersion: 1,
        profileKind: "chronorift-godot-semantic-adapter",
        adapterKind: "timer_spawn_v1",
        projectCapabilitySha256: digest,
        targetScene: "res://../private.tscn",
        spawnIntervalSeconds: 1,
        checkpointBarrier: "adapter_process_tail",
        limits: {
          activeRuntimesMaximum: 2,
          launchesPerTurnMaximum: 8,
          entityMaximum: 256,
          eventMaximum: 4096,
          rawSemanticBytesMaximum: 2_097_152,
          checkpointBytesMaximum: 1_048_576,
          traceSamplesMaximum: 32,
          traceTicksMaximum: 600,
          queryRowsMaximum: 200,
        },
      }),
    ).toThrow();
  });

  it("requires unique spawn ordinals below nextSpawnOrdinal", () => {
    expect(VNextTimerSpawnProjectionV1Schema.parse(projection)).toBeDefined();
    expect(() =>
      VNextTimerSpawnProjectionV1Schema.parse({
        ...projection,
        nextSpawnOrdinal: 0,
      }),
    ).toThrow("nextSpawnOrdinal");
  });

  it("keeps checkpoint fidelity descriptive with explicit uncontrolled state", () => {
    expect(
      VNextSemanticCheckpointPayloadV1Schema.parse(checkpointPayload).fidelity,
    ).toBe("descriptive_only");
  });

  it("binds a checkpoint resource to its Task and checkpoint payload", () => {
    const resource = {
      schemaVersion: 1 as const,
      resourceKind: "semantic_checkpoint" as const,
      taskId: checkpointPayload.taskId,
      checkpointId: checkpointPayload.checkpointId,
      payload: checkpointPayload,
    };
    expect(VNextSemanticCheckpointResourceV1Schema.parse(resource)).toEqual(
      resource,
    );
    expect(() =>
      VNextSemanticCheckpointResourceV1Schema.parse({
        ...resource,
        taskId: "task:v1:other",
      }),
    ).toThrow("detached");
    expect(() =>
      VNextSemanticCheckpointResourceV1Schema.parse({
        ...resource,
        checkpointId: "checkpoint:v1:other",
      }),
    ).toThrow("detached");
  });

  it("requires contiguous, strictly increasing trace samples", () => {
    const sample = {
      schemaVersion: 1 as const,
      sequence: 0,
      requestedOffset: 15,
      realizedOffset: 15,
      quantized: false,
      clock,
      projectionSha256: digest,
      projection,
    };
    expect(
      VNextSemanticTraceV1Schema.parse({
        schemaVersion: 1,
        traceKind: "semantic_observation_trace",
        taskId: "task:v1:test",
        traceId: "trace:v1:test",
        sourceExecutionId: "execution:v1:test",
        sourceRuntimeId: "runtime:v1:test",
        sourceBuildId: "build:v1:test",
        adapterId: "adapter:v1:test",
        adapterProfileSha256: digest,
        clockDomain: "physics_tick",
        origin: clock,
        samples: [sample],
      }).samples,
    ).toHaveLength(1);
    expect(() =>
      VNextSemanticTraceV1Schema.parse({
        schemaVersion: 1,
        traceKind: "semantic_observation_trace",
        taskId: "task:v1:test",
        traceId: "trace:v1:test",
        sourceExecutionId: "execution:v1:test",
        sourceRuntimeId: "runtime:v1:test",
        sourceBuildId: "build:v1:test",
        adapterId: "adapter:v1:test",
        adapterProfileSha256: digest,
        clockDomain: "physics_tick",
        origin: clock,
        samples: [sample, { ...sample, sequence: 2 }],
      }),
    ).toThrow("contiguous");
  });
});
