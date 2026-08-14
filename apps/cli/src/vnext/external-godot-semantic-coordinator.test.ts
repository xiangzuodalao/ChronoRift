import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  validateSemanticGameToolOutputV1,
  type SemanticGameToolNameV1,
} from "@chronorift/agent-protocol";
import {
  GodotSemanticAdapterProfileV1Schema,
  asSha256DigestV1,
  asTaskId,
  asWorkspaceId,
  type JsonValue,
} from "@chronorift/domain";
import { GodotAdapterError } from "@chronorift/godot-adapter";
import { ArtifactNotFoundError, contentHash } from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it } from "vitest";

import type { TaskGodotProjectCapabilityV1 } from "./contracts.js";
import {
  createExternalGodotSemanticCoordinator,
  type ExternalGodotSemanticCoordinatorOptions,
} from "./external-godot-semantic-coordinator.js";
import type { ManagedGodotSemanticRuntimeCapabilityV1 } from "./managed-godot-semantic-runtime.js";
import type { M1TaskRuntimeArtifactStore } from "./m1-task-environment.js";

const hash = (value: string) =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const cleanup = {
  schemaVersion: 1 as const,
  processGroupTerminated: true,
  cgroupPopulated: false,
  scopeRemoved: true,
};

const boundedStorageObservation = {
  realizedMechanisms: { aggregateStorage: "tmpfs" },
  resourceUsage: { aggregateStorage: { bytes: 0, inodes: 0 } },
};

const createStore = (
  failAfterPut?: (kind: string) => boolean,
): M1TaskRuntimeArtifactStore => {
  const resources = new Map<string, unknown>();
  const events = new Map<string, unknown[]>();
  return {
    putResourceOnce: (_kind, resourceId, value, parse) => {
      const key = `${_kind}:${resourceId}`;
      if (resources.has(key)) throw new Error("duplicate resource");
      const parsed = parse(value);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        !("taskId" in parsed) ||
        parsed.taskId !== "task:semantic"
      ) {
        throw new Error("runtime record belongs to a different Task");
      }
      resources.set(key, parsed);
      if (failAfterPut?.(_kind) === true) {
        return Promise.reject(new Error("injected post-write failure"));
      }
      return Promise.resolve();
    },
    readResource: (_kind, resourceId, parse) => {
      const value = resources.get(`${_kind}:${resourceId}`);
      if (value === undefined)
        return Promise.reject(
          new ArtifactNotFoundError(`${_kind}/${resourceId}.json`),
        );
      return Promise.resolve(parse(value));
    },
    appendExecutionEvent: (executionId, value, parse) => {
      const ledger = events.get(executionId) ?? [];
      const parsed = parse(value);
      ledger.push(parsed);
      events.set(executionId, ledger);
      return Promise.resolve({
        schemaVersion: 1,
        taskId: asTaskId("task:semantic"),
        executionId,
        sequence: ledger.length - 1,
        previousHash: null,
        payload: parsed as JsonValue,
        payloadHash: hash(`payload:${ledger.length}`),
        recordHash: hash(`record:${ledger.length}`),
      });
    },
    readExecutionEvents: (executionId, parse) =>
      Promise.resolve((events.get(executionId) ?? []).map(parse)),
    readExecutionSeal: (executionId) => {
      const count = events.get(executionId)?.length ?? 0;
      return Promise.resolve({
        schemaVersion: 1,
        taskId: asTaskId("task:semantic"),
        executionId,
        count,
        headHash: count === 0 ? null : hash(`record:${count}`),
        byteLength: count,
        contentHash: hash(`seal:${executionId}:${count}`),
      });
    },
    sealExecution(executionId) {
      return this.readExecutionSeal(executionId);
    },
    summarize: () =>
      Promise.resolve({
        schemaVersion: 1,
        taskId: asTaskId("task:semantic"),
        kinds: [],
        executions: [],
      }),
  };
};

const projection = (frame: number, entities = Math.floor(frame / 3)) => ({
  schemaVersion: 1 as const,
  stateSchemaVersion: "chronorift.timer-spawn:v1" as const,
  subject: {
    stableId: "semantic:subject" as const,
    incarnation: 1,
    targetScene: "res://components/spawner/enemy_spawner_broken.tscn",
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
    timeoutOrdinal: entities,
  },
  entities: Array.from({ length: entities }, (_, ordinal) => ({
    stableId: `semantic:spawn:${ordinal}`,
    incarnation: 1,
    spawnOrdinal: ordinal,
    scene: "res://enemy.tscn",
    parentStableId: "semantic:harness" as const,
    transform: {
      position: { x: 0, y: 0 },
      rotation: 0,
      scale: { x: 1, y: 1 },
    },
    visible: true,
    processMode: 0,
    velocity: null,
  })),
  nextSpawnOrdinal: entities,
  capturedAt: {
    processFrame: frame,
    physicsTick: frame,
    simulationTimeUs: frame * 16_667,
    hostMonotonicUs: null,
    renderFrame: null,
  },
});

describe("external Godot semantic coordinator", () => {
  it("runs all eleven bounded semantic tools with descriptive lineage", async () => {
    const workspaceDirectory = await mkdtemp(
      join(tmpdir(), "chronorift-semantic-coordinator-"),
    );
    temporaryDirectories.push(workspaceDirectory);
    await writeFile(
      join(workspaceDirectory, "project.godot"),
      '[application]\nrun/main_scene="res://main.tscn"\n',
    );

    const projectCapabilitySha256 = hash("project-capability");
    const adapterProfile = GodotSemanticAdapterProfileV1Schema.parse({
      schemaVersion: 1,
      profileKind: "chronorift-godot-semantic-adapter",
      adapterKind: "timer_spawn_v1",
      projectCapabilitySha256,
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
    });
    const adapterProfileSha256 = asSha256DigestV1(
      contentHash(adapterProfile as unknown as JsonValue),
    );
    let nextFrame = 1;
    let failExecutionPut = false;
    let statusFailureAfter: number | undefined;
    const clients: Array<{ frame: number }> = [];
    const options: ExternalGodotSemanticCoordinatorOptions = {
      taskId: asTaskId("task:semantic"),
      workspaceId: asWorkspaceId("workspace:semantic"),
      workspaceDirectory,
      baselineSourceHash: hash("baseline"),
      projectCapability: {
        capabilitySha256: projectCapabilitySha256,
        descriptorSha256: hash("descriptor"),
      } as TaskGodotProjectCapabilityV1,
      managedRuntime: {
        managedRuntimeId: `managed-godot-semantic-runtime:v1:${hash("runtime")}`,
        addonHash: hash("addon"),
        overlayHash: hash("overlay"),
        vanillaSidecarSourceSha256: hash("vanilla"),
        semanticSidecarSourceSha256: hash("semantic-sidecar"),
        protocolProfile: "chronorift-godot-semantic-v1",
        engineVersion: "4.7.1-stable (official)",
      } as ManagedGodotSemanticRuntimeCapabilityV1,
      adapterProfile,
      adapterProfileSha256,
      now: () => "2026-08-11T00:00:00.000Z",
      runtimeStore: createStore((kind) => {
        if (kind !== "execution" || !failExecutionPut) return false;
        failExecutionPut = false;
        return true;
      }),
      sidecarPort: {
        runVanillaSmoke: () =>
          Promise.resolve({
            kind: "completed" as const,
            result: {
              sandbox: {
                kind: "executed" as const,
                receipt: { cleanup, ...boundedStorageObservation },
              },
              diagnostics: [{ kind: "smoke_complete" as const }],
              diagnosticFacts: { status: "complete" as const },
            },
          }) as never,
        openManaged: () =>
          Promise.resolve({
            kind: "opened" as const,
            sidecar: {
              transport: {
                readable: new PassThrough(),
                write: () => Promise.resolve(),
                close: () => Promise.resolve(),
              },
              completion: Promise.resolve({
                kind: "executed" as const,
                receipt: { cleanup, ...boundedStorageObservation },
              }),
              diagnostics: () => [],
              diagnosticFacts: () => ({ status: "complete" as const }),
              terminate: () => Promise.resolve(),
            },
          }) as never,
      },
      connectRuntime: async () => {
        const state = { frame: nextFrame };
        nextFrame += 10;
        clients.push(state);
        const observe = () => {
          state.frame += 1;
          const observedProjection = projection(state.frame);
          return {
            sample: {
              processFrames: state.frame,
              physicsFrames: state.frame,
              processTimeUs: state.frame * 16_667,
              physicsTimeUs: state.frame * 16_667,
              configuredMainScene: "res://main.tscn",
              currentScene: "res://main.tscn",
              projection: observedProjection,
            },
            hostMonotonicStartUs: state.frame * 1_000,
            hostMonotonicEndUs: state.frame * 1_000 + 10,
          };
        };
        const ready = observe();
        return {
          ready,
          status: () => {
            if (statusFailureAfter !== undefined) {
              if (statusFailureAfter === 0) {
                statusFailureAfter = undefined;
                return Promise.reject(
                  new GodotAdapterError(
                    "PROCESS_FAILED",
                    "sensitive /host/path must not escape",
                  ),
                );
              }
              statusFailureAfter -= 1;
            }
            return Promise.resolve(observe());
          },
          checkpoint: () => Promise.resolve(observe()),
          restore: (captured) => {
            state.frame += 1;
            return Promise.resolve({
              ...observe(),
              sample: { ...observe().sample, projection: captured },
              limitations: ["test projection restore"],
            });
          },
          shutdown: () => Promise.resolve(observe()),
        };
      },
    };
    const coordinator = createExternalGodotSemanticCoordinator(options);
    let call = 0;
    const invoke = async (
      toolName: SemanticGameToolNameV1,
      input: Record<string, unknown>,
    ) => {
      call += 1;
      const response = await coordinator.invoke({
        schemaVersion: 1,
        toolCallId: `call:${call}`,
        toolName,
        input: { schemaVersion: 1, taskId: options.taskId, ...input },
      });
      expect(response.outcome).toBe("success");
      if (response.outcome !== "success")
        throw new Error(response.error.message);
      expect(
        validateSemanticGameToolOutputV1(toolName, response.output),
        `${toolName}: ${JSON.stringify(response.output)}`,
      ).toBe(true);
      return response.output as Record<string, unknown>;
    };

    const capabilities = await invoke("game_capabilities", {});
    const build = capabilities["build"] as { buildId: string };
    const launched = await invoke("game_launch", { buildId: build.buildId });
    const baselineRuntime = launched["runtime"] as {
      runtimeId: string;
      executionId: string;
    };
    await invoke("game_status", { runtimeId: baselineRuntime.runtimeId });
    const checkpointOutput = await invoke("game_checkpoint_create", {
      runtimeId: baselineRuntime.runtimeId,
      barrier: "adapter_process_tail",
    });
    const checkpoint = checkpointOutput["checkpoint"] as {
      checkpointId: string;
    };
    const traceOutput = await invoke("game_trace_create", {
      runtimeId: baselineRuntime.runtimeId,
      clockDomain: "process_frame",
      sampleOffsets: [1, 2],
    });
    const trace = traceOutput["trace"] as { traceId: string };
    failExecutionPut = true;
    const interruptedStop = await coordinator.invoke({
      schemaVersion: 1,
      toolCallId: "call:interrupted-stop",
      toolName: "game_stop",
      input: {
        schemaVersion: 1,
        taskId: options.taskId,
        runtimeId: baselineRuntime.runtimeId,
      },
    });
    expect(interruptedStop.outcome).toBe("error");
    await invoke("game_stop", { runtimeId: baselineRuntime.runtimeId });
    const queried = await invoke("game_query", {
      source: {
        kind: "execution",
        executionId: baselineRuntime.executionId,
      },
      view: "entities",
      cursor: "2",
      limit: 1,
    });
    expect(queried["rows"]).toHaveLength(1);
    expect(queried["nextCursor"]).toBe("3");
    const forked = await invoke("game_fork", {
      source: { kind: "checkpoint", checkpointId: checkpoint.checkpointId },
      checkpointId: checkpoint.checkpointId,
    });
    const childRuntimeId = String(forked["childRuntimeId"]);
    const childExecutionId = String(forked["childExecutionId"]);
    await invoke("game_checkpoint_restore", {
      runtimeId: childRuntimeId,
      checkpointId: checkpoint.checkpointId,
    });
    statusFailureAfter = 0;
    const originFailure = await coordinator.invoke({
      schemaVersion: 1,
      toolCallId: "call:replay-origin-failure",
      toolName: "game_trace_replay",
      input: {
        schemaVersion: 1,
        taskId: options.taskId,
        runtimeId: childRuntimeId,
        traceId: trace.traceId,
        maxTicks: 10,
      },
    });
    expect(originFailure).toMatchObject({
      outcome: "error",
      error: {
        code: "operation_failed",
        message:
          "Semantic trace replay failed during origin_observation (PROCESS_FAILED)",
        recoverable: false,
      },
    });
    expect(JSON.stringify(originFailure)).not.toContain("/host/path");
    statusFailureAfter = 1;
    const sampleFailure = await coordinator.invoke({
      schemaVersion: 1,
      toolCallId: "call:replay-sample-failure",
      toolName: "game_trace_replay",
      input: {
        schemaVersion: 1,
        taskId: options.taskId,
        runtimeId: childRuntimeId,
        traceId: trace.traceId,
        maxTicks: 10,
      },
    });
    expect(sampleFailure).toMatchObject({
      outcome: "error",
      error: {
        code: "operation_failed",
        message:
          "Semantic trace replay failed during sample_observation (PROCESS_FAILED)",
        recoverable: false,
      },
    });
    await invoke("game_trace_replay", {
      runtimeId: childRuntimeId,
      traceId: trace.traceId,
      maxTicks: 10,
    });
    await invoke("game_stop", { runtimeId: childRuntimeId });
    const compared = await invoke("game_compare", {
      baselineExecutionId: baselineRuntime.executionId,
      candidateExecutionId: childExecutionId,
      maxDifferences: 20,
    });
    expect(compared["mode"]).toBe("descriptive_only");
    expect(clients).toHaveLength(2);
    await coordinator.close();

    const resumed = createExternalGodotSemanticCoordinator({
      ...options,
      now: () => "2026-08-12T00:00:00.000Z",
    });
    const resumedCapabilities = await resumed.invoke({
      schemaVersion: 1,
      toolCallId: "call:resumed",
      toolName: "game_capabilities",
      input: { schemaVersion: 1, taskId: options.taskId },
    });
    expect(resumedCapabilities.outcome).toBe("success");
    if (resumedCapabilities.outcome !== "success") {
      throw new Error(resumedCapabilities.error.message);
    }
    expect(
      (resumedCapabilities.output as Record<string, unknown>)["build"],
    ).toEqual(build);
    await resumed.close();
  });
});
