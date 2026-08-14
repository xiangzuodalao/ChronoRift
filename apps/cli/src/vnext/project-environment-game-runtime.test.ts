import { describe, expect, it } from "vitest";

import {
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectCapabilitySetV1Schema,
  type JsonValue,
  type ProjectEnvironmentPinnedCaptureV1,
  type ProjectEnvironmentRuntimeObservationReceiptV1,
} from "@chronorift/domain";
import {
  validateProjectEnvironmentGameToolOutputV1,
  type ProjectEnvironmentGameToolNameV1,
} from "@chronorift/agent-protocol";
import type {
  GodotProjectEnvironmentRuntimeClientV1,
  LoadedProjectAdapterPackageV1,
} from "@chronorift/godot-adapter";

import { ProjectEnvironmentGameRuntimeV1 } from "./project-environment-game-runtime.js";
import type { ManagedGodotProjectEnvironmentRuntimeCapabilityV1 } from "./managed-godot-project-environment-runtime.js";
import type {
  GodotProjectEnvironmentSidecarPortV1,
  SandboxedGodotProjectEnvironmentSidecarV1,
} from "./project-environment-sidecar-port.js";

const sha = (digit: string) => digit.repeat(64);
const taskId = "task.v1.test";
const buildId = "build.v1.test";

const wireCoverage = {
  status: "complete" as const,
  firstAvailableRecordSequence: 0,
  lastAvailableRecordSequence: 2,
  droppedRecordCount: 0,
  overwriteCount: 0,
  semanticCoverage: "declared" as const,
};
const wireClock = {
  processFrame: 10,
  physicsTick: 5,
  simulationTimeUs: 166_667,
  renderFrame: null,
};
const wireStatus = {
  running: true,
  configuredMainScene: "res://main.tscn",
  currentScene: "res://main.tscn",
  clock: wireClock,
  nextObservationRecordSequence: 3,
  coverage: wireCoverage,
};

const observation = (kind: string, payload: unknown, recordSequence = 0) => ({
  schemaVersion: 1,
  recordSequence,
  clock: wireClock,
  kind,
  payload,
});

const observationBatch = {
  batchId: "batch:0",
  firstRecordSequence: 0,
  lastRecordSequence: 1,
  records: [
    observation("entity_lifecycle", {
      phase: "appeared",
      entityId: "entity.test",
      entityTypeId: "actor",
      incarnation: 1,
      identityScope: "execution_local",
      projection: { health: 3 },
    }),
    observation(
      "state_sample",
      {
        stateDomainId: "world",
        value: { health: 3 },
        semanticCoverage: "declared",
      },
      1,
    ),
  ],
  coverage: {
    ...wireCoverage,
    lastAvailableRecordSequence: 1,
  },
};

const realizedCaptureChannels = [
  "entity",
  "state",
  "event",
  "runtime_error",
  "clock",
  "capture_loss",
] as const;

const capabilitySet = ProjectCapabilitySetV1Schema.parse({
  schemaVersion: 1,
  modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => ({
    schemaVersion: 1,
    module,
    status: "implemented",
    protocolVersion: "project-environment-v1",
    limitations: [],
  })),
});

const fakeClient = {
  fingerprint: {
    renderer: "headless",
  },
  ready: wireStatus,
  status: () => Promise.resolve(wireStatus),
  configureCapture: (request: {
    readonly channels: readonly string[];
    readonly rollingRecordLimit: number;
  }) =>
    Promise.resolve({
      channels: realizedCaptureChannels,
      realizedRollingRecordLimit: request.rollingRecordLimit,
    }),
  nextObservationBatch: () => Promise.resolve(observationBatch),
  acknowledgeObservationBatch: () => Promise.resolve(),
  query: (request: { readonly queryKind: string }) =>
    Promise.resolve({
      rows:
        request.queryKind === "state"
          ? [
              observation("state_sample", {
                stateDomainId: "world",
                value: { health: 3 },
                semanticCoverage: "declared",
              }),
            ]
          : [
              observation("entity_lifecycle", {
                phase: "appeared",
                entityId: "entity.test",
                entityTypeId: "actor",
                incarnation: 1,
                identityScope: "execution_local",
                projection: { health: 3 },
              }),
            ],
      truncated: false,
      coverage: wireCoverage,
    }),
} as unknown as GodotProjectEnvironmentRuntimeClientV1;

const pending = new Promise<never>(() => undefined);
const fakeManagedSidecar = {
  transport: {},
  completion: pending,
  diagnostics: () => [],
  terminate: () => Promise.resolve(),
} as unknown as SandboxedGodotProjectEnvironmentSidecarV1;

const fakeSidecar = {
  openManaged: () =>
    Promise.resolve({ kind: "opened" as const, sidecar: fakeManagedSidecar }),
} as unknown as GodotProjectEnvironmentSidecarPortV1;

const adapterPackage = {
  manifest: {
    launchTargets: [
      {
        schemaVersion: 1,
        targetId: "default",
        scene: "res://main.tscn",
        default: true,
        parametersSchemaId: "launch.parameters",
        renderer: "headless",
        requiredModules: [],
      },
    ],
    schemas: [
      {
        schemaVersion: 1,
        schemaId: "entity.actor",
        path: "schemas/entity.actor.json",
        sha256: sha("8"),
      },
      {
        schemaVersion: 1,
        schemaId: "state.world",
        path: "schemas/state.world.json",
        sha256: sha("9"),
      },
    ],
    entityTypes: [
      {
        schemaVersion: 1,
        entityTypeId: "actor",
        schemaId: "entity.actor",
        identityStrategy: "execution_local",
      },
    ],
    stateDomains: [
      {
        schemaVersion: 1,
        stateDomainId: "world",
        schemaId: "state.world",
        checkpointDisposition: "uncontrolled",
      },
    ],
    eventTypes: [],
  },
  schemas: [
    {
      schemaVersion: 1,
      dialect: "chronorift://schemas/project-adapter-payload/v1",
      schemaId: "entity.actor",
      root: {
        type: "object",
        properties: { health: { type: "integer" } },
        required: ["health"],
        additionalProperties: false,
      },
    },
    {
      schemaVersion: 1,
      dialect: "chronorift://schemas/project-adapter-payload/v1",
      schemaId: "state.world",
      root: {
        type: "object",
        properties: { health: { type: "integer" } },
        required: ["health"],
        additionalProperties: false,
      },
    },
  ],
} as unknown as LoadedProjectAdapterPackageV1;

const makeRuntime = (
  client: GodotProjectEnvironmentRuntimeClientV1 = fakeClient,
  sidecar: GodotProjectEnvironmentSidecarPortV1 = fakeSidecar,
  resolveCompatibleBuild?: () => Promise<{
    readonly schemaVersion: 1;
    readonly buildId: string;
    readonly sourceClosureId: string;
    readonly candidateSourceHash: string;
    readonly expectedMainScene: string;
  }>,
  persistRuntimeObservation?: (
    receipt: ProjectEnvironmentRuntimeObservationReceiptV1,
  ) => Promise<void>,
  persistPinnedCapture:
    | null
    | ((
        capture: ProjectEnvironmentPinnedCaptureV1,
        records: readonly JsonValue[],
      ) => Promise<void>) = () => Promise.resolve(),
  connect:
    (() => Promise<GodotProjectEnvironmentRuntimeClientV1>) | null = null,
) =>
  new ProjectEnvironmentGameRuntimeV1({
    sidecar,
    managedRuntime: {
      managedRuntimeId: "managed-runtime.v1.test",
      overlayHash: sha("1"),
      addonHash: sha("2"),
    } as ManagedGodotProjectEnvironmentRuntimeCapabilityV1,
    adapterPackage,
    capabilitySet,
    taskId,
    sourceClosureId: "source.v1.test",
    environmentRevisionId: "environment-revision.v1.test",
    adapterRevisionId: "adapter-revision.v1.test",
    buildId,
    candidateSourceHash: sha("3"),
    expectedMainScene: "res://main.tscn",
    adapterManifestSha256: sha("4"),
    sdkSha256: sha("5"),
    bridgeSha256: sha("6"),
    toolchainSha256: sha("7"),
    engineVersion: "4.7.1",
    ...(resolveCompatibleBuild === undefined ? {} : { resolveCompatibleBuild }),
    ...(persistRuntimeObservation === undefined
      ? {}
      : { persistRuntimeObservation }),
    ...(persistPinnedCapture === null ? {} : { persistPinnedCapture }),
    connect: connect ?? (() => Promise.resolve(client)),
  });

const invoke = async (
  runtime: ProjectEnvironmentGameRuntimeV1,
  toolName: ProjectEnvironmentGameToolNameV1,
  input: unknown,
) => {
  const result = (await runtime.invoke({
    schemaVersion: 1,
    toolCallId: `tool-call.${toolName}`,
    toolName,
    input,
  })) as {
    readonly outcome: "success" | "error";
    readonly output?: unknown;
    readonly error?: { readonly code: string };
  };
  if (result.outcome === "success") {
    expect(
      validateProjectEnvironmentGameToolOutputV1(toolName, result.output),
    ).toBe(true);
  }
  return result;
};

const completingRuntime = (input?: {
  readonly cleanup?: {
    readonly processGroupTerminated?: boolean;
    readonly cgroupPopulated?: boolean;
    readonly scopeRemoved?: boolean;
    readonly storageReconciled?: boolean;
  };
  readonly client?: Partial<GodotProjectEnvironmentRuntimeClientV1>;
  readonly persistPinnedCapture?:
    | null
    | ((
        capture: ProjectEnvironmentPinnedCaptureV1,
        records: readonly JsonValue[],
      ) => Promise<void>);
}) => {
  let finish!: (value: unknown) => void;
  const completion = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const client = {
    ...fakeClient,
    ...input?.client,
    shutdown: () => {
      finish({
        kind: "executed",
        receipt: {
          status: "succeeded",
          cleanup: {
            processGroupTerminated:
              input?.cleanup?.processGroupTerminated ?? true,
            cgroupPopulated: input?.cleanup?.cgroupPopulated ?? false,
            termSent: false,
            killSent: false,
            scopeRemoved: input?.cleanup?.scopeRemoved ?? true,
            storageReconciled: input?.cleanup?.storageReconciled ?? true,
          },
        },
      });
      return Promise.resolve({ status: { ...wireStatus, running: false } });
    },
  } as unknown as GodotProjectEnvironmentRuntimeClientV1;
  const sidecar = {
    openManaged: () =>
      Promise.resolve({
        kind: "opened" as const,
        sidecar: {
          ...fakeManagedSidecar,
          completion,
        } as SandboxedGodotProjectEnvironmentSidecarV1,
      }),
  } as unknown as GodotProjectEnvironmentSidecarPortV1;
  const persisted: ProjectEnvironmentRuntimeObservationReceiptV1[] = [];
  const runtime = makeRuntime(
    client,
    sidecar,
    undefined,
    (receipt) => {
      persisted.push(receipt);
      return Promise.resolve();
    },
    input?.persistPinnedCapture,
  );
  return { runtime, persisted };
};

const launchForObservation = async (
  runtime: ProjectEnvironmentGameRuntimeV1,
) => {
  const launched = await invoke(runtime, "game_launch", {
    schemaVersion: 1,
    taskId,
    buildId,
    launchTargetId: "default",
    parameters: {},
  });
  expect(launched.outcome).toBe("success");
  return launched.output as {
    readonly runtimeId: string;
    readonly executionId: string;
  };
};

const configureAndPinObservationCapture = async (
  runtime: ProjectEnvironmentGameRuntimeV1,
  runtimeId: string,
) => {
  const configured = await invoke(runtime, "game_capture_configure", {
    schemaVersion: 1,
    taskId,
    runtimeId,
    profile: {
      channels: ["entity", "state"],
      retention: { clockDomain: "process_frame", before: 0, after: 0 },
      sampling: [],
      triggers: [],
    },
  });
  expect(configured.outcome).toBe("success");
  return invoke(runtime, "game_capture_pin", {
    schemaVersion: 1,
    taskId,
    runtimeId,
    anchor: { kind: "now" },
    before: 0,
    after: 0,
  });
};

const queryObservation = (
  runtime: ProjectEnvironmentGameRuntimeV1,
  executionId: string,
  select: "entities" | "state",
) =>
  invoke(runtime, "game_query", {
    schemaVersion: 1,
    taskId,
    executionId,
    select,
    limit: 10,
  });

describe("ProjectEnvironmentGameRuntimeV1", () => {
  it("serializes concurrent launches so one execution cannot overwrite another", async () => {
    const { runtime } = completingRuntime();
    const launchInput = {
      schemaVersion: 1 as const,
      taskId,
      buildId,
      launchTargetId: "default",
      parameters: {},
    };

    const results = await Promise.all([
      invoke(runtime, "game_launch", launchInput),
      invoke(runtime, "game_launch", launchInput),
    ]);

    const launched = results.filter((result) => result.outcome === "success");
    const rejected = results.filter((result) => result.outcome === "error");
    expect(launched).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      outcome: "error",
      error: { code: "busy" },
    });

    const active = launched[0]?.output as { readonly runtimeId: string };
    await expect(
      invoke(runtime, "game_stop", {
        schemaVersion: 1,
        taskId,
        runtimeId: active.runtimeId,
      }),
    ).resolves.toMatchObject({ outcome: "success" });
  });

  it("terminates, awaits, and records an opened sidecar when the bridge handshake fails", async () => {
    let terminateCalls = 0;
    let finish!: (value: unknown) => void;
    const completion = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const sidecar = {
      openManaged: () =>
        Promise.resolve({
          kind: "opened" as const,
          sidecar: {
            ...fakeManagedSidecar,
            completion,
            terminate: () => {
              terminateCalls += 1;
              finish({
                kind: "executed",
                receipt: {
                  status: "cancelled",
                  cleanup: {
                    processGroupTerminated: true,
                    cgroupPopulated: false,
                    termSent: true,
                    killSent: false,
                    scopeRemoved: true,
                    storageReconciled: true,
                  },
                },
              });
              return Promise.resolve();
            },
          } as SandboxedGodotProjectEnvironmentSidecarV1,
        }),
    } as unknown as GodotProjectEnvironmentSidecarPortV1;
    const persisted: ProjectEnvironmentRuntimeObservationReceiptV1[] = [];
    const runtime = makeRuntime(
      fakeClient,
      sidecar,
      undefined,
      (receipt) => {
        persisted.push(receipt);
        return Promise.resolve();
      },
      undefined,
      () => Promise.reject(new Error("handshake identity mismatch")),
    );

    await expect(
      invoke(runtime, "game_launch", {
        schemaVersion: 1,
        taskId,
        buildId,
        launchTargetId: "default",
        parameters: {},
      }),
    ).resolves.toMatchObject({
      outcome: "error",
      error: { code: "operation_failed" },
    });
    expect(terminateCalls).toBe(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      taskId,
      buildId,
      bridgeHandshakeCount: 0,
      captureCount: 0,
      captureWindowIds: [],
      outcome: "incomplete",
      cleanup: {
        processTreeTerminated: true,
        isolationGroupEmpty: true,
        scopeRemoved: true,
        storageReconciled: true,
      },
    });
    expect(persisted[0]?.failures.join(" ")).toContain(
      "handshake identity mismatch",
    );
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("reports every tool and rejects resources from another Task", async () => {
    const runtime = makeRuntime();
    const capabilities = await invoke(runtime, "game_capabilities", {
      schemaVersion: 1,
      taskId,
    });
    expect(capabilities.outcome).toBe("success");
    expect(
      (capabilities.output as { readonly tools: readonly unknown[] }).tools,
    ).toHaveLength(16);

    const mismatch = await invoke(runtime, "game_capabilities", {
      schemaVersion: 1,
      taskId: "task.v1.someone-else",
    });
    expect(mismatch).toMatchObject({
      outcome: "error",
      error: { code: "resource_task_mismatch" },
    });
  });

  it("launches the exact bound Build and exposes strict status/capture/query output", async () => {
    const runtime = makeRuntime();
    const launched = await invoke(runtime, "game_launch", {
      schemaVersion: 1,
      taskId,
      buildId,
      launchTargetId: "default",
      parameters: {},
    });
    expect(launched.outcome).toBe("success");
    const active = launched.output as {
      readonly runtimeId: string;
      readonly executionId: string;
    };

    await invoke(runtime, "game_status", {
      schemaVersion: 1,
      taskId,
      runtimeId: active.runtimeId,
    });
    const unsupportedRetention = await invoke(
      runtime,
      "game_capture_configure",
      {
        schemaVersion: 1,
        taskId,
        runtimeId: active.runtimeId,
        profile: {
          channels: ["entity", "state"],
          retention: { clockDomain: "process_frame", before: 10, after: 10 },
          sampling: [],
          triggers: [],
        },
      },
    );
    expect(unsupportedRetention).toMatchObject({
      outcome: "error",
      error: { code: "unsupported_capability" },
    });
    const configured = await invoke(runtime, "game_capture_configure", {
      schemaVersion: 1,
      taskId,
      runtimeId: active.runtimeId,
      profile: {
        channels: ["entity", "state"],
        retention: { clockDomain: "process_frame", before: 0, after: 0 },
        sampling: [],
        triggers: [],
      },
    });
    expect(configured).toMatchObject({
      outcome: "success",
      output: {
        status: "degraded",
        realized: { channels: realizedCaptureChannels },
      },
    });
    const queried = await invoke(runtime, "game_query", {
      schemaVersion: 1,
      taskId,
      executionId: active.executionId,
      select: "entities",
      limit: 10,
    });
    expect(queried).toMatchObject({
      outcome: "success",
      output: { rows: [{ kind: "entity" }] },
    });
    await expect(
      invoke(runtime, "game_capture_pin", {
        schemaVersion: 1,
        taskId,
        runtimeId: active.runtimeId,
        anchor: { kind: "now" },
        before: 0,
        after: 0,
      }),
    ).resolves.toMatchObject({ outcome: "success" });
  });

  it("rejects every unimplemented query filter, range, and cursor before querying the bridge", async () => {
    let queryCalls = 0;
    const client = {
      ...fakeClient,
      query: () => {
        queryCalls += 1;
        return Promise.resolve({
          rows: [],
          truncated: false,
          coverage: wireCoverage,
        });
      },
    } as unknown as GodotProjectEnvironmentRuntimeClientV1;
    const runtime = makeRuntime(client);
    const active = await launchForObservation(runtime);
    const unsupportedInputs = [
      { filters: { entityIds: ["entity.test"] } },
      { filters: { typeIds: ["actor"] } },
      { filters: { domainIds: ["world"] } },
      {
        filters: {
          range: { clockDomain: "process_frame", from: 0, through: 10 },
        },
      },
      { cursor: "cursor:next" },
    ];
    for (const extra of unsupportedInputs) {
      const result = await invoke(runtime, "game_query", {
        schemaVersion: 1,
        taskId,
        executionId: active.executionId,
        select: "entities",
        limit: 10,
        ...extra,
      });
      expect(result).toMatchObject({
        outcome: "error",
        error: { code: "unsupported_capability" },
      });
    }
    expect(queryCalls).toBe(0);
  });

  it("rejects capture retention, sampling, triggers, and expanded pin windows that PE-A cannot realize", async () => {
    let configureCalls = 0;
    let batchCalls = 0;
    const client = {
      ...fakeClient,
      configureCapture: () => {
        configureCalls += 1;
        return Promise.resolve({
          channels: realizedCaptureChannels,
          realizedRollingRecordLimit: 4_096,
        });
      },
      nextObservationBatch: () => {
        batchCalls += 1;
        return Promise.resolve(observationBatch);
      },
    } as unknown as GodotProjectEnvironmentRuntimeClientV1;
    const runtime = makeRuntime(client);
    const active = await launchForObservation(runtime);
    const profiles = [
      {
        channels: ["state"],
        retention: { clockDomain: "physics_tick", before: 0, after: 0 },
        sampling: [],
        triggers: [],
      },
      {
        channels: ["state"],
        retention: { clockDomain: "process_frame", before: 1, after: 0 },
        sampling: [],
        triggers: [],
      },
      {
        channels: ["state"],
        retention: { clockDomain: "process_frame", before: 0, after: 0 },
        sampling: [{ channelId: "state", every: 2 }],
        triggers: [],
      },
      {
        channels: ["state"],
        retention: { clockDomain: "process_frame", before: 0, after: 0 },
        sampling: [],
        triggers: [
          {
            triggerId: "runtime.failure",
            kind: "runtime_error",
            referenceId: "runtime.error",
          },
        ],
      },
    ];
    for (const profile of profiles) {
      const result = await invoke(runtime, "game_capture_configure", {
        schemaVersion: 1,
        taskId,
        runtimeId: active.runtimeId,
        profile,
      });
      expect(result).toMatchObject({
        outcome: "error",
        error: { code: "unsupported_capability" },
      });
    }
    expect(configureCalls).toBe(0);

    for (const window of [
      { before: 1, after: 0 },
      { before: 0, after: 1 },
    ]) {
      const result = await invoke(runtime, "game_capture_pin", {
        schemaVersion: 1,
        taskId,
        runtimeId: active.runtimeId,
        anchor: { kind: "now" },
        ...window,
      });
      expect(result).toMatchObject({
        outcome: "error",
        error: { code: "history_window_unavailable" },
      });
    }
    for (const anchor of [
      { kind: "event", eventId: "event.test" },
      {
        kind: "clock",
        point: {
          clockDomain: "process_frame",
          position: 10,
          phase: "process_frame_end",
        },
      },
    ]) {
      const result = await invoke(runtime, "game_capture_pin", {
        schemaVersion: 1,
        taskId,
        runtimeId: active.runtimeId,
        anchor,
        before: 0,
        after: 0,
      });
      expect(result).toMatchObject({
        outcome: "error",
        error: { code: "history_window_unavailable" },
      });
    }
    expect(batchCalls).toBe(0);
  });

  it("persists the exact raw batch before acknowledging and reporting a pinned capture", async () => {
    const order: string[] = [];
    const captures: {
      readonly capture: ProjectEnvironmentPinnedCaptureV1;
      readonly records: readonly JsonValue[];
    }[] = [];
    const client = {
      ...fakeClient,
      acknowledgeObservationBatch: () => {
        order.push("acknowledged");
        return Promise.resolve();
      },
    } as unknown as GodotProjectEnvironmentRuntimeClientV1;
    const runtime = makeRuntime(
      client,
      fakeSidecar,
      undefined,
      undefined,
      (capture, records) => {
        order.push("persisted");
        captures.push({ capture, records });
        return Promise.resolve();
      },
    );
    const active = await launchForObservation(runtime);
    const pinned = await invoke(runtime, "game_capture_pin", {
      schemaVersion: 1,
      taskId,
      runtimeId: active.runtimeId,
      anchor: { kind: "now" },
      before: 0,
      after: 0,
    });

    expect(pinned).toMatchObject({
      outcome: "success",
      output: {
        anchor: { quantized: true },
      },
    });
    expect(
      (pinned.output as { readonly captureWindowId: string }).captureWindowId,
    ).toMatch(/^capture-window\.v1\.[0-9a-f-]{36}$/u);
    expect(order).toEqual(["persisted", "acknowledged"]);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.capture).toMatchObject({
      taskId,
      runtimeId: active.runtimeId,
      executionId: active.executionId,
      buildId,
      recordCount: observationBatch.records.length,
    });
    expect(captures[0]?.records).toEqual(observationBatch.records);
  });

  it("rejects duplicate appeared lifecycle records across authoritative capture batches", async () => {
    let batchIndex = 0;
    let persisted = 0;
    let acknowledged = 0;
    const appeared = (recordSequence: number) =>
      observation(
        "entity_lifecycle",
        {
          phase: "appeared",
          entityId: "entity.test",
          entityTypeId: "actor",
          incarnation: 1,
          identityScope: "execution_local",
          projection: { health: 3 },
        },
        recordSequence,
      );
    const batches = [
      {
        batchId: "batch:lifecycle:0",
        firstRecordSequence: 0,
        lastRecordSequence: 0,
        records: [appeared(0)],
        coverage: {
          ...wireCoverage,
          firstAvailableRecordSequence: 0,
          lastAvailableRecordSequence: 0,
        },
      },
      {
        batchId: "batch:lifecycle:1",
        firstRecordSequence: 1,
        lastRecordSequence: 1,
        records: [appeared(1)],
        coverage: {
          ...wireCoverage,
          firstAvailableRecordSequence: 1,
          lastAvailableRecordSequence: 1,
        },
      },
    ];
    const client = {
      ...fakeClient,
      nextObservationBatch: () => Promise.resolve(batches[batchIndex++]!),
      acknowledgeObservationBatch: () => {
        acknowledged += 1;
        return Promise.resolve();
      },
    } as unknown as GodotProjectEnvironmentRuntimeClientV1;
    const runtime = makeRuntime(
      client,
      fakeSidecar,
      undefined,
      undefined,
      () => {
        persisted += 1;
        return Promise.resolve();
      },
    );
    const active = await launchForObservation(runtime);

    await expect(
      configureAndPinObservationCapture(runtime, active.runtimeId),
    ).resolves.toMatchObject({ outcome: "success" });
    await expect(
      configureAndPinObservationCapture(runtime, active.runtimeId),
    ).resolves.toMatchObject({
      outcome: "error",
      error: { code: "operation_failed" },
    });
    expect(persisted).toBe(1);
    expect(acknowledged).toBe(1);
  });

  it("rejects disappeared lifecycle for an unknown entity before persistence", async () => {
    let persisted = 0;
    let acknowledged = 0;
    const client = {
      ...fakeClient,
      nextObservationBatch: () =>
        Promise.resolve({
          batchId: "batch:lifecycle:unknown",
          firstRecordSequence: 0,
          lastRecordSequence: 0,
          records: [
            observation("entity_lifecycle", {
              phase: "disappeared",
              entityId: "entity.test",
              entityTypeId: "actor",
              incarnation: 1,
              identityScope: "execution_local",
              projection: null,
            }),
          ],
          coverage: {
            ...wireCoverage,
            firstAvailableRecordSequence: 0,
            lastAvailableRecordSequence: 0,
          },
        }),
      acknowledgeObservationBatch: () => {
        acknowledged += 1;
        return Promise.resolve();
      },
    } as unknown as GodotProjectEnvironmentRuntimeClientV1;
    const runtime = makeRuntime(
      client,
      fakeSidecar,
      undefined,
      undefined,
      () => {
        persisted += 1;
        return Promise.resolve();
      },
    );
    const active = await launchForObservation(runtime);

    await expect(
      configureAndPinObservationCapture(runtime, active.runtimeId),
    ).resolves.toMatchObject({
      outcome: "error",
      error: { code: "operation_failed" },
    });
    expect(persisted).toBe(0);
    expect(acknowledged).toBe(0);
  });

  it("accepts disappearance followed by a greater incarnation in a later batch", async () => {
    let batchIndex = 0;
    const lifecycle = (
      recordSequence: number,
      phase: "appeared" | "disappeared",
      incarnation: number,
    ) =>
      observation(
        "entity_lifecycle",
        {
          phase,
          entityId: "entity.test",
          entityTypeId: "actor",
          incarnation,
          identityScope: "execution_local",
          projection: phase === "appeared" ? { health: 3 } : null,
        },
        recordSequence,
      );
    const batches = [
      {
        batchId: "batch:lifecycle:destroy",
        firstRecordSequence: 0,
        lastRecordSequence: 1,
        records: [lifecycle(0, "appeared", 1), lifecycle(1, "disappeared", 1)],
        coverage: {
          ...wireCoverage,
          firstAvailableRecordSequence: 0,
          lastAvailableRecordSequence: 1,
        },
      },
      {
        batchId: "batch:lifecycle:reappear",
        firstRecordSequence: 2,
        lastRecordSequence: 2,
        records: [lifecycle(2, "appeared", 2)],
        coverage: {
          ...wireCoverage,
          firstAvailableRecordSequence: 2,
          lastAvailableRecordSequence: 2,
        },
      },
    ];
    const client = {
      ...fakeClient,
      nextObservationBatch: () => Promise.resolve(batches[batchIndex++]!),
    } as unknown as GodotProjectEnvironmentRuntimeClientV1;
    const runtime = makeRuntime(client);
    const active = await launchForObservation(runtime);

    await expect(
      configureAndPinObservationCapture(runtime, active.runtimeId),
    ).resolves.toMatchObject({ outcome: "success" });
    await expect(
      configureAndPinObservationCapture(runtime, active.runtimeId),
    ).resolves.toMatchObject({ outcome: "success" });
  });

  it("fails pinning without durable persistence and does not consume or acknowledge a batch", async () => {
    let batchCalls = 0;
    let acknowledgements = 0;
    const client = {
      ...fakeClient,
      nextObservationBatch: () => {
        batchCalls += 1;
        return Promise.resolve(observationBatch);
      },
      acknowledgeObservationBatch: () => {
        acknowledgements += 1;
        return Promise.resolve();
      },
    } as unknown as GodotProjectEnvironmentRuntimeClientV1;
    const runtime = makeRuntime(
      client,
      fakeSidecar,
      undefined,
      undefined,
      null,
    );
    const capabilities = await invoke(runtime, "game_capabilities", {
      schemaVersion: 1,
      taskId,
    });
    expect(capabilities).toMatchObject({ outcome: "success" });
    const tools = (
      capabilities.output as {
        readonly tools: readonly {
          readonly toolName: string;
          readonly status: string;
        }[];
      }
    ).tools;
    expect(
      tools.find((tool) => tool.toolName === "game_capture_pin"),
    ).toMatchObject({ status: "unsupported_capability" });
    const active = await launchForObservation(runtime);
    const pinned = await invoke(runtime, "game_capture_pin", {
      schemaVersion: 1,
      taskId,
      runtimeId: active.runtimeId,
      anchor: { kind: "now" },
      before: 0,
      after: 0,
    });
    expect(pinned).toMatchObject({
      outcome: "error",
      error: { code: "unsupported_capability" },
    });
    expect(batchCalls).toBe(0);
    expect(acknowledgements).toBe(0);
  });

  it("does not acknowledge or count a batch when durable capture persistence fails", async () => {
    let acknowledgements = 0;
    const { runtime, persisted } = completingRuntime({
      client: {
        acknowledgeObservationBatch: () => {
          acknowledgements += 1;
          return Promise.resolve();
        },
      },
      persistPinnedCapture: () =>
        Promise.reject(new Error("capture storage unavailable")),
    });
    const active = await launchForObservation(runtime);
    const pinned = await invoke(runtime, "game_capture_pin", {
      schemaVersion: 1,
      taskId,
      runtimeId: active.runtimeId,
      anchor: { kind: "now" },
      before: 0,
      after: 0,
    });
    expect(pinned).toMatchObject({
      outcome: "error",
      error: { code: "operation_failed" },
    });
    expect(acknowledgements).toBe(0);
    await queryObservation(runtime, active.executionId, "entities");
    await queryObservation(runtime, active.executionId, "state");
    await invoke(runtime, "game_stop", {
      schemaVersion: 1,
      taskId,
      runtimeId: active.runtimeId,
    });
    expect(persisted[0]).toMatchObject({
      captureCount: 0,
      outcome: "incomplete",
    });
  });

  it("keeps execution-lifetime loss after later bridge counters reset without double-counting capture_loss", async () => {
    const lossyCoverage = {
      ...wireCoverage,
      status: "partial" as const,
      droppedRecordCount: 3,
      overwriteCount: 2,
    };
    const resetCoverage = {
      ...wireCoverage,
      firstAvailableRecordSequence: 0,
      lastAvailableRecordSequence: 0,
      droppedRecordCount: 0,
      overwriteCount: 0,
    };
    const lossBatch = {
      batchId: "batch:loss",
      firstRecordSequence: 0,
      lastRecordSequence: 0,
      records: [
        {
          schemaVersion: 1 as const,
          recordSequence: 0,
          clock: wireClock,
          kind: "capture_loss" as const,
          payload: {
            channel: "adapter",
            firstDroppedRecordSequence: 7,
            lastDroppedRecordSequence: 9,
            droppedRecordCount: 3,
            reason: "backpressure" as const,
          },
        },
      ],
      coverage: resetCoverage,
    };
    const { runtime, persisted } = completingRuntime({
      client: {
        ready: { ...wireStatus, coverage: lossyCoverage },
        status: () =>
          Promise.resolve({ ...wireStatus, coverage: resetCoverage }),
        nextObservationBatch: () => Promise.resolve(lossBatch),
      },
    });
    const active = await launchForObservation(runtime);
    const pinned = await invoke(runtime, "game_capture_pin", {
      schemaVersion: 1,
      taskId,
      runtimeId: active.runtimeId,
      anchor: { kind: "now" },
      before: 0,
      after: 0,
    });
    expect(pinned).toMatchObject({
      outcome: "success",
      output: {
        coverage: [{ droppedRecords: 3, overwrittenRecords: 2 }],
        loss: [
          { kind: "dropped", count: 3 },
          { kind: "overwritten", count: 2 },
        ],
      },
    });
    await queryObservation(runtime, active.executionId, "entities");
    await queryObservation(runtime, active.executionId, "state");
    const stopped = await invoke(runtime, "game_stop", {
      schemaVersion: 1,
      taskId,
      runtimeId: active.runtimeId,
    });
    expect(stopped).toMatchObject({
      outcome: "success",
      output: {
        coverage: [{ droppedRecords: 3, overwrittenRecords: 2 }],
      },
    });
    expect(persisted[0]).toMatchObject({
      outcome: "incomplete",
      loss: [
        { kind: "dropped", count: 3 },
        { kind: "overwritten", count: 2 },
      ],
    });
  });

  it("keeps the worst semantic and transport coverage observed for the execution", async () => {
    let statusCalls = 0;
    const degraded = {
      ...wireCoverage,
      status: "partial" as const,
      semanticCoverage: "partial" as const,
    };
    const client = {
      ...fakeClient,
      status: () => {
        statusCalls += 1;
        return Promise.resolve({
          ...wireStatus,
          coverage: statusCalls === 1 ? degraded : wireCoverage,
        });
      },
    } as unknown as GodotProjectEnvironmentRuntimeClientV1;
    const runtime = makeRuntime(client);
    const active = await launchForObservation(runtime);
    await invoke(runtime, "game_status", {
      schemaVersion: 1,
      taskId,
      runtimeId: active.runtimeId,
    });
    const later = await invoke(runtime, "game_status", {
      schemaVersion: 1,
      taskId,
      runtimeId: active.runtimeId,
    });
    expect(later).toMatchObject({
      outcome: "success",
      output: {
        coverage: [
          {
            status: "incomplete",
            limitations: [
              "The bridge reported partial transport coverage.",
              "The Adapter declares partial semantic coverage.",
            ],
          },
        ],
      },
    });
  });

  it("refreshes an edited workspace to an exact compatible Build and rejects the stale Build", async () => {
    const editedBuildId = "build.v1.edited";
    const openedBuilds: string[] = [];
    const sidecar = {
      openManaged: (request: { readonly buildId: string }) => {
        openedBuilds.push(request.buildId);
        return Promise.resolve({
          kind: "opened" as const,
          sidecar: fakeManagedSidecar,
        });
      },
    } as unknown as GodotProjectEnvironmentSidecarPortV1;
    const runtime = makeRuntime(fakeClient, sidecar, () =>
      Promise.resolve({
        schemaVersion: 1,
        buildId: editedBuildId,
        sourceClosureId: "source.v1.test",
        candidateSourceHash: sha("8"),
        expectedMainScene: "res://main.tscn",
      }),
    );

    const capabilities = await invoke(runtime, "game_capabilities", {
      schemaVersion: 1,
      taskId,
    });
    expect(capabilities).toMatchObject({
      outcome: "success",
      output: { buildId: editedBuildId },
    });

    const stale = await invoke(runtime, "game_launch", {
      schemaVersion: 1,
      taskId,
      buildId,
      launchTargetId: "default",
      parameters: {},
    });
    expect(stale).toMatchObject({
      outcome: "error",
      error: { code: "resource_not_found" },
    });
    expect(openedBuilds).toEqual([]);

    const launched = await invoke(runtime, "game_launch", {
      schemaVersion: 1,
      taskId,
      buildId: editedBuildId,
      launchTargetId: "default",
      parameters: {},
    });
    expect(launched).toMatchObject({
      outcome: "success",
      output: { buildId: editedBuildId },
    });
    expect(openedBuilds).toEqual([editedBuildId]);
  });

  it("keeps later Host orchestration tools registered but explicitly unsupported", async () => {
    const runtime = makeRuntime();
    const result = await invoke(runtime, "game_compare", {
      schemaVersion: 1,
      taskId,
      baselineExecutionId: "execution.v1.left",
      candidateExecutionId: "execution.v1.right",
      maxDifferences: 10,
    });
    expect(result).toMatchObject({
      outcome: "error",
      error: { code: "unsupported_capability" },
    });
  });

  it("persists a successful final-candidate runtime observation after stop", async () => {
    const { runtime, persisted } = completingRuntime();
    const active = await launchForObservation(runtime);
    await configureAndPinObservationCapture(runtime, active.runtimeId);
    await queryObservation(runtime, active.executionId, "entities");
    await queryObservation(runtime, active.executionId, "state");

    await invoke(runtime, "game_stop", {
      schemaVersion: 1,
      taskId,
      runtimeId: active.runtimeId,
    });

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      taskId,
      runtimeId: active.runtimeId,
      executionId: active.executionId,
      buildId,
      launchTargetId: "default",
      instrumentationMode: "instrumented",
      status: "stopped",
      bridgeHandshakeCount: 1,
      queryObservations: {
        entityQueryCount: 1,
        entityRows: 1,
        stateQueryCount: 1,
        stateRows: 1,
      },
      captureCount: 1,
      outcome: "succeeded",
      failures: [],
      cleanup: {
        processTreeTerminated: true,
        isolationGroupEmpty: true,
        scopeRemoved: true,
        storageReconciled: true,
      },
    });
  });

  it("does not count capture configuration as a durable pinned capture", async () => {
    const { runtime, persisted } = completingRuntime();
    const active = await launchForObservation(runtime);
    await invoke(runtime, "game_capture_configure", {
      schemaVersion: 1,
      taskId,
      runtimeId: active.runtimeId,
      profile: {
        channels: ["entity", "state"],
        retention: { clockDomain: "process_frame", before: 0, after: 0 },
        sampling: [],
        triggers: [],
      },
    });
    await queryObservation(runtime, active.executionId, "entities");
    await queryObservation(runtime, active.executionId, "state");
    await invoke(runtime, "game_stop", {
      schemaVersion: 1,
      taskId,
      runtimeId: active.runtimeId,
    });

    expect(persisted[0]).toMatchObject({
      captureCount: 0,
      outcome: "incomplete",
      failures: ["No pinned observation batch was captured."],
    });
  });

  it.each([
    ["capture", false, true, true],
    ["queries", true, false, true],
    ["cleanup", true, true, false],
  ])(
    "persists an incomplete receipt when %s evidence is missing",
    async (_label, withCapture, withQueries, cleanupComplete) => {
      const { runtime, persisted } = completingRuntime(
        cleanupComplete ? undefined : { cleanup: { storageReconciled: false } },
      );
      const active = await launchForObservation(runtime);
      if (withCapture) {
        await configureAndPinObservationCapture(runtime, active.runtimeId);
      }
      if (withQueries) {
        await queryObservation(runtime, active.executionId, "entities");
        await queryObservation(runtime, active.executionId, "state");
      }
      await invoke(runtime, "game_stop", {
        schemaVersion: 1,
        taskId,
        runtimeId: active.runtimeId,
      });

      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ outcome: "incomplete" });
      expect(persisted[0]?.failures.length).toBeGreaterThan(0);
    },
  );

  it("shuts down the bridge and reports the actual sandbox cleanup receipt", async () => {
    let finish!: (value: unknown) => void;
    const completion = new Promise((resolve) => {
      finish = resolve;
    });
    const client = {
      ...fakeClient,
      shutdown: () => {
        finish({
          kind: "executed",
          receipt: {
            status: "succeeded",
            cleanup: {
              processGroupTerminated: true,
              cgroupPopulated: false,
              termSent: false,
              killSent: false,
              scopeRemoved: true,
              storageReconciled: true,
            },
          },
        });
        return Promise.resolve({
          status: { ...wireStatus, running: false },
        });
      },
    } as unknown as GodotProjectEnvironmentRuntimeClientV1;
    const sidecar = {
      openManaged: () =>
        Promise.resolve({
          kind: "opened" as const,
          sidecar: {
            ...fakeManagedSidecar,
            completion,
          } as SandboxedGodotProjectEnvironmentSidecarV1,
        }),
    } as unknown as GodotProjectEnvironmentSidecarPortV1;
    const runtime = makeRuntime(client, sidecar);
    const launched = await invoke(runtime, "game_launch", {
      schemaVersion: 1,
      taskId,
      buildId,
      launchTargetId: "default",
      parameters: {},
    });
    const runtimeId = (launched.output as { readonly runtimeId: string })
      .runtimeId;
    const stopped = await invoke(runtime, "game_stop", {
      schemaVersion: 1,
      taskId,
      runtimeId,
    });
    expect(stopped).toMatchObject({
      outcome: "success",
      output: {
        status: "stopped",
        cleanup: {
          processTreeTerminated: true,
          runtimeExited: true,
          bridgeExited: true,
          isolationGroupEmpty: true,
          scopeRemoved: true,
          scratchRemoved: true,
          storageReconciled: true,
        },
      },
    });
  });
});
