import { describe, expect, it, vi } from "vitest";

import {
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectCapabilitySetV1Schema,
  type ProjectEnvironmentRuntimeObservationReceiptV2,
} from "@chronorift/domain";
import type { ProjectEnvironmentGameToolNameV1 } from "@chronorift/agent-protocol";
import type {
  GodotByteTransport,
  GodotProjectEnvironmentConnectRequestV2,
  GodotProjectEnvironmentRuntimeClientV2,
  LoadedProjectAdapterPackageV2,
} from "@chronorift/godot-adapter";
import type { GodotProjectEnvironmentObservationBatchV2 } from "@chronorift/godot-protocol";

import { ProjectEnvironmentGameRuntimeV2 } from "./project-environment-game-runtime-v2.js";
import type { ManagedGodotProjectEnvironmentRuntimeCapabilityV2 } from "./managed-godot-project-environment-runtime-v2.js";
import type {
  GodotProjectEnvironmentSidecarPortV2,
  SandboxedGodotProjectEnvironmentSidecarV2,
} from "./project-environment-sidecar-port-v2.js";

const taskId = "task.v2.state-only";
const build = {
  schemaVersion: 1 as const,
  buildId: "build.v2.state-only",
  sourceClosureId: "source.v2.state-only",
  candidateSourceHash: "1".repeat(64),
  expectedMainScene: "res://main.tscn",
};
const launchTarget = {
  schemaVersion: 2 as const,
  targetId: "main",
  scene: "res://main.tscn",
  default: true,
  parametersSchemaId: "launch.params",
  renderer: "headless" as const,
  requiredModules: [],
};
const adapterPackage = {
  manifest: {
    launchTargets: [launchTarget],
    smoke: {
      minimumStateSamples: 1,
      minimumEntityLifecycleRecords: 1,
      requiredStateDomainIds: ["mob_spawn_orientation"],
      requiredCustomEventTypeIds: [],
      requiredDynamicTraces: [],
    },
    entityTypes: [
      {
        schemaVersion: 2,
        entityTypeId: "mob",
        schemaId: "entity.mob",
        identityStrategy: "execution_local",
      },
    ],
    stateDomains: [
      {
        schemaVersion: 2,
        stateDomainId: "mob_spawn_orientation",
        schemaId: "state.mob_spawn_orientation",
        checkpointDisposition: "uncontrolled",
        subject: {
          schemaVersion: 2,
          kind: "entity",
          allowedEntityTypeIds: ["mob"],
        },
      },
    ],
    eventTypes: [],
  },
  launchTargetSelection: {
    defaultTarget: launchTarget,
    selectedTarget: launchTarget,
    targetsToValidate: [launchTarget],
  },
  schemas: [
    {
      schemaVersion: 2,
      dialect: "chronorift://schemas/project-adapter-payload/v2",
      schemaId: "entity.mob",
      root: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    {
      schemaVersion: 2,
      dialect: "chronorift://schemas/project-adapter-payload/v2",
      schemaId: "state.mob_spawn_orientation",
      root: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  ],
} as unknown as LoadedProjectAdapterPackageV2;
const capabilitySet = ProjectCapabilitySetV1Schema.parse({
  schemaVersion: 1,
  modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => ({
    schemaVersion: 1,
    module,
    status: "implemented",
    protocolVersion: "project-adapter-module:v2",
    limitations: [],
  })),
});

const entityBatch = (
  executionId: string,
): GodotProjectEnvironmentObservationBatchV2 => ({
  schemaVersion: 2,
  executionId,
  batchId: "batch.v2.state-only.0",
  firstRecordSequence: 0,
  lastRecordSequence: 1,
  records: [
    {
      schemaVersion: 2,
      executionId,
      recordSequence: 0,
      clock: {
        processFrame: 1,
        physicsTick: 1,
        simulationTimeUs: 1,
        renderFrame: null,
      },
      kind: "entity_lifecycle",
      payload: {
        phase: "appeared",
        entity: {
          schemaVersion: 2,
          executionId,
          entityId: "mob:1",
          incarnation: 1,
        },
        entityTypeId: "mob",
        identityScope: "execution_local",
        projection: {},
      },
    },
    {
      schemaVersion: 2,
      executionId,
      recordSequence: 1,
      clock: {
        processFrame: 1,
        physicsTick: 1,
        simulationTimeUs: 1,
        renderFrame: null,
      },
      kind: "state_sample",
      payload: {
        stateDomainId: "mob_spawn_orientation",
        subjectEntity: {
          schemaVersion: 2,
          executionId,
          entityId: "mob:1",
          incarnation: 1,
        },
        value: {},
        semanticCoverage: "declared",
      },
    },
  ],
  coverage: {
    status: "complete",
    firstAvailableRecordSequence: 0,
    lastAvailableRecordSequence: 1,
    droppedRecordCount: 0,
    overwriteCount: 0,
    semanticCoverage: "declared",
  },
});

const fixture = () => {
  let completeSidecar!: (value: unknown) => void;
  const completion = new Promise<unknown>((resolve) => {
    completeSidecar = resolve;
  });
  let pendingPollReject: ((error: Error) => void) | undefined;
  const persisted: ProjectEnvironmentRuntimeObservationReceiptV2[] = [];
  const connect = vi.fn(
    async (
      _transport: GodotByteTransport,
      options: GodotProjectEnvironmentConnectRequestV2,
    ) => {
      const executionId = options.expectedIdentity.executionId;
      let delivered = false;
      return {
        fingerprint: { renderer: "headless" },
        ready: {
          running: true,
          configuredMainScene: build.expectedMainScene,
          currentScene: build.expectedMainScene,
          clock: {
            processFrame: 0,
            physicsTick: 0,
            simulationTimeUs: 0,
            renderFrame: null,
          },
          nextObservationRecordSequence: 0,
          coverage: {
            status: "complete",
            firstAvailableRecordSequence: null,
            lastAvailableRecordSequence: null,
            droppedRecordCount: 0,
            overwriteCount: 0,
            semanticCoverage: "declared",
          },
        },
        nextObservationBatch: () => {
          if (!delivered) {
            delivered = true;
            return Promise.resolve(entityBatch(executionId));
          }
          return new Promise<never>((_resolve, reject) => {
            pendingPollReject = reject;
          });
        },
        acknowledgeObservationBatch: async () => undefined,
        shutdown: async () => {
          completeSidecar({
            kind: "executed",
            receipt: {
              status: "succeeded",
              cleanup: {
                processGroupTerminated: true,
                cgroupPopulated: false,
                scopeRemoved: true,
                storageReconciled: true,
              },
            },
          });
        },
      } as unknown as GodotProjectEnvironmentRuntimeClientV2;
    },
  );
  const sidecar = {
    openManaged: async () => ({
      kind: "opened" as const,
      sidecar: {
        transport: {},
        completion,
        diagnostics: () => [],
        terminate: async () => undefined,
      } as unknown as SandboxedGodotProjectEnvironmentSidecarV2,
    }),
  } as unknown as GodotProjectEnvironmentSidecarPortV2;
  const target = new ProjectEnvironmentGameRuntimeV2({
    taskId,
    environmentRevisionId: "environment-revision.v2.state-only",
    adapterRevisionId: "adapter-revision.v2.state-only",
    adapterPackage,
    validatedLaunchTargetIds: ["main"],
    compatibleLaunchTargetId: "main",
    capabilitySet,
    managedRuntime: {
      managedRuntimeId: `managed-godot-project-environment:v2:${"2".repeat(64)}`,
      overlayHash: "3".repeat(64),
      addonHash: "4".repeat(64),
    } as ManagedGodotProjectEnvironmentRuntimeCapabilityV2,
    sidecar,
    adapterManifestSha256: "5".repeat(64),
    sdkSha256: "6".repeat(64),
    bridgeSha256: "7".repeat(64),
    toolchainSha256: "8".repeat(64),
    engineVersion: "4.7.1-stable (official)",
    resolveBuild: async () => build,
    persistPinnedCapture: async () => undefined,
    persistRuntimeObservation: async (receipt) => {
      persisted.push(receipt);
    },
    connect,
  });
  const releasePoll = async () => {
    while (pendingPollReject === undefined) await Promise.resolve();
    const reject = pendingPollReject;
    pendingPollReject = undefined;
    reject(
      Object.assign(new Error("no observations in this poll"), {
        code: "COMMAND_TIMEOUT",
      }),
    );
  };
  const waitForPendingPoll = async () => {
    while (pendingPollReject === undefined) await Promise.resolve();
  };
  return { target, persisted, releasePoll, waitForPendingPoll };
};

const invoke = (
  target: ProjectEnvironmentGameRuntimeV2,
  toolName: ProjectEnvironmentGameToolNameV1,
  input: Record<string, unknown>,
) =>
  target.invoke({
    schemaVersion: 1,
    toolCallId: `tool-call.${toolName}`,
    toolName,
    input,
  }) as Promise<{
    readonly outcome: "success" | "error";
    readonly output?: Record<string, unknown>;
    readonly error?: { readonly code: string; readonly message: string };
  }>;

const launch = async (target: ProjectEnvironmentGameRuntimeV2) => {
  const result = await invoke(target, "game_launch", {
    schemaVersion: 1,
    taskId,
    buildId: build.buildId,
    launchTargetId: "main",
    parameters: {},
  });
  expect(result.outcome).toBe("success");
  return result.output as {
    readonly runtimeId: string;
    readonly executionId: string;
  };
};

describe("ProjectEnvironmentGameRuntimeV2 state-only execution", () => {
  it("serves a declared projection without requiring a dynamic trace", async () => {
    const { target, releasePoll, waitForPendingPoll } = fixture();
    const identifiers = await launch(target);
    await waitForPendingPoll();
    const entities = await invoke(target, "game_query", {
      schemaVersion: 1,
      taskId,
      executionId: identifiers.executionId,
      select: "entities",
      limit: 10,
    });
    const state = await invoke(target, "game_query", {
      schemaVersion: 1,
      taskId,
      executionId: identifiers.executionId,
      select: "state",
      limit: 10,
    });

    const closing = target.close();
    await releasePoll();
    await closing.catch(() => undefined);

    expect(entities).toMatchObject({
      outcome: "success",
      output: { rows: [{ kind: "entity" }] },
    });
    expect(state).toMatchObject({
      outcome: "success",
      output: { rows: [{ kind: "state" }] },
    });
  });

  it("lets the caller stop without a mandatory evidence-gathering sequence", async () => {
    const { target, persisted, releasePoll, waitForPendingPoll } = fixture();
    const identifiers = await launch(target);
    await waitForPendingPoll();
    const stopping = invoke(target, "game_stop", {
      schemaVersion: 1,
      taskId,
      runtimeId: identifiers.runtimeId,
    });
    await Promise.resolve();
    await releasePoll();
    const result = await stopping;
    if (result.outcome === "error") {
      const closing = target.close();
      await releasePoll();
      await closing.catch(() => undefined);
    } else {
      await target.close();
    }

    expect(result).toMatchObject({
      outcome: "success",
      output: {
        status: "stopped",
        limitations: [
          expect.stringContaining(
            "PE-B characterization evidence is incomplete",
          ),
        ],
      },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      outcome: "incomplete",
      queryObservations: {
        entityQueryCount: 0,
        stateQueryCount: 0,
      },
      eventQueryCount: 0,
      captureCount: 0,
      dynamicTraces: [],
      failures: [
        expect.stringContaining("PE-B characterization evidence is incomplete"),
      ],
    });
    expect(persisted[0]?.failures.join(" ")).not.toMatch(
      /event|dynamic trace/u,
    );
  });
});
