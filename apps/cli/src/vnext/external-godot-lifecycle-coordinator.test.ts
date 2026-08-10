import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  VNextBuildV1Schema,
  VNextCaptureCoverageV1Schema,
  VNextCaptureLossV1Schema,
  asBuildId,
  asExecutionId,
  asRuntimeId,
  asSha256DigestV1,
  asSourceId,
  asTaskId,
  asWorkspaceId,
  type VNextLifecycleCleanupReceiptV1,
  type VNextLifecyclePhaseReceiptV1,
} from "@chronorift/domain";
import { ArtifactNotFoundError } from "@chronorift/json-artifacts";
import type { RuntimeExecutionSealV1 } from "@chronorift/json-artifacts";

import {
  createExternalGodotLifecycleCoordinator,
  type ExternalGodotLifecycleCoordinatorStore,
  type ExternalGodotLifecycleDriverV1,
  type ExternalGodotLifecycleSessionV1,
} from "./external-godot-lifecycle-coordinator.js";
import {
  ExternalGodotLifecycleLaunchFailureV1,
  type ExternalGodotLifecycleDiagnosticChunkV1,
  type ExternalGodotLifecycleLaunchFailureReceiptV1,
} from "./external-godot-lifecycle-driver.js";
import type { PreparedExternalGodotLifecycleBuildV1 } from "./candidate-godot-build.js";

const timestamp = "2026-08-10T00:00:00.000Z";
const digest = (value: string) => asSha256DigestV1(value.repeat(64));
const cleanup: VNextLifecycleCleanupReceiptV1 = {
  schemaVersion: 1,
  processGroupTerminated: true,
  godotExited: true,
  sidecarExited: true,
  cgroupEmpty: true,
  scopeRemoved: true,
  scratchRemoved: true,
  storageReconciled: true,
};
const stream = {
  schemaVersion: 1 as const,
  totalBytes: 0,
  totalSha256: digest("0"),
  retainedBytes: 0,
  retainedSha256: digest("0"),
  truncated: false,
  droppedBytes: 0,
};

const phase = (
  sequence: number,
  name: VNextLifecyclePhaseReceiptV1["phase"],
  operationCleanup: VNextLifecycleCleanupReceiptV1 | null,
): VNextLifecyclePhaseReceiptV1 => ({
  schemaVersion: 1,
  sequence,
  phase: name,
  operationId: `operation:${name}`,
  operationState: "started",
  timingFidelity: "operation_bounds",
  processDurationMs: null,
  stabilityObservedMs: null,
  outcome:
    name.endsWith("smoke") || name.endsWith("stop")
      ? "controlled_stop"
      : "succeeded",
  startedAt: timestamp,
  endedAt: timestamp,
  hostMonotonicStartUs: sequence,
  hostMonotonicEndUs: sequence + 1,
  exitCode: name.includes("import") ? 0 : null,
  signal: null,
  stdout: stream,
  stderr: stream,
  observation: null,
  cleanup: operationCleanup,
  knownSideEffects: ["isolated scratch only"],
});

const prepared: PreparedExternalGodotLifecycleBuildV1 = {
  build: VNextBuildV1Schema.parse({
    schemaVersion: 1,
    taskId: asTaskId("task:external"),
    workspaceId: asWorkspaceId("workspace:external"),
    sourceId: asSourceId(`source:${"1".repeat(64)}`),
    buildId: asBuildId(`build:${"2".repeat(64)}`),
    sourceHash: digest("1"),
    workspaceDiffHash: digest("2"),
    buildConfigurationHash: digest("3"),
    outputHash: digest("4"),
    createdAt: timestamp,
  }),
  configuredMainScene: "uid://external-main-scene",
  projectHash: digest("4"),
  descriptorHash: digest("5"),
  overlayHash: digest("6"),
  addonHash: digest("7"),
  vanillaSidecarHash: digest("8"),
  lifecycleSidecarHash: digest("9"),
  fileCount: 2,
  byteLength: 32,
};

class MemoryStore implements ExternalGodotLifecycleCoordinatorStore {
  public readonly resources = new Map<string, unknown>();
  public readonly events = new Map<string, unknown[]>();
  public readonly seals: string[] = [];
  public failNextPutKind: string | undefined;
  public failNextSeal = false;
  public failAppend:
    | {
        readonly sequence: number;
        readonly mode: "before_write" | "after_write";
      }
    | undefined;

  public putResourceOnce<T>(
    kind: string,
    resourceId: string,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<void> {
    if (this.failNextPutKind === kind) {
      this.failNextPutKind = undefined;
      return Promise.reject(new Error(`injected ${kind} persistence failure`));
    }
    const key = `${kind}:${resourceId}`;
    if (this.resources.has(key)) {
      return Promise.reject(new Error(`duplicate resource ${key}`));
    }
    this.resources.set(key, parse(structuredClone(value)));
    return Promise.resolve();
  }

  public readResource<T>(
    kind: string,
    resourceId: string,
    parse: (input: unknown) => T,
  ): Promise<T> {
    const key = `${kind}:${resourceId}`;
    if (!this.resources.has(key)) {
      return Promise.reject(new ArtifactNotFoundError(key));
    }
    return Promise.resolve(parse(structuredClone(this.resources.get(key))));
  }

  public appendExecutionEvent<T>(
    executionId: string,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<unknown> {
    const parsed = parse(structuredClone(value));
    const sequence = (parsed as { readonly sequence?: unknown }).sequence;
    const failure = this.failAppend;
    if (
      failure !== undefined &&
      sequence === failure.sequence &&
      failure.mode === "before_write"
    ) {
      this.failAppend = undefined;
      return Promise.reject(new Error("injected append before write"));
    }
    const events = this.events.get(executionId) ?? [];
    events.push(parsed);
    this.events.set(executionId, events);
    if (
      failure !== undefined &&
      sequence === failure.sequence &&
      failure.mode === "after_write"
    ) {
      this.failAppend = undefined;
      return Promise.reject(new Error("injected append after write"));
    }
    return Promise.resolve({});
  }

  public readExecutionEvents<T>(
    executionId: string,
    parse: (input: unknown) => T,
  ): Promise<readonly T[]> {
    return Promise.resolve(
      (this.events.get(executionId) ?? []).map((event) =>
        parse(structuredClone(event)),
      ),
    );
  }

  public sealExecution(executionId: string): Promise<RuntimeExecutionSealV1> {
    if (this.failNextSeal) {
      this.failNextSeal = false;
      return Promise.reject(new Error("injected execution seal failure"));
    }
    this.seals.push(executionId);
    const count = this.events.get(executionId)?.length ?? 0;
    return Promise.resolve({
      schemaVersion: 1,
      taskId: asTaskId("task:external"),
      executionId,
      count,
      headHash: count === 0 ? null : "a".repeat(64),
      byteLength: count,
      contentHash: "b".repeat(64),
    });
  }
}

const facts = (input: {
  runtimeId: string;
  executionId: string;
  status?: "running" | "stopped" | "cleanup_pending";
}) => ({
  schemaVersion: 2 as const,
  taskId: "task:external",
  runtimeId: input.runtimeId,
  executionId: input.executionId,
  buildId: prepared.build.buildId,
  status: input.status ?? "running",
  engine: {
    version: "4.7.1",
    build: "official",
    platform: "Linux",
    renderer: "gl_compatibility",
    audioDriver: "Dummy",
    headless: true,
  },
  // Godot may preserve a uid:// launch identity while the instantiated
  // PackedScene reports its canonical res:// path. Both are observable facts
  // and must not be conflated by lifecycle readiness.
  configuredScene: "uid://external-main-scene",
  currentScene: "res://main.tscn",
  clocks: {
    processFrame: 130,
    physicsTick: 125,
    simulationTimeUs: 2_000_000,
    hostMonotonicUs: 3_000_000,
    renderFrame: null,
    processFrameDelta: 120,
    physicsTickDelta: 120,
  },
  coverage: [],
  loss: [],
  diagnostics: {
    stdoutTotalBytes: 0,
    stdoutRetainedBytes: 0,
    stdoutTruncated: false,
    stderrTotalBytes: 0,
    stderrRetainedBytes: 0,
    stderrTruncated: false,
  },
  startedAt: timestamp,
  endedAt: input.status === "stopped" ? timestamp : null,
});

const createDriver = (
  stopCleanup: VNextLifecycleCleanupReceiptV1 = cleanup,
  stopDiagnostics: readonly ExternalGodotLifecycleDiagnosticChunkV1[] = [],
): ExternalGodotLifecycleDriverV1 => ({
  launch(request): Promise<ExternalGodotLifecycleSessionV1> {
    const stdoutChunks = stopDiagnostics.filter(
      (chunk) => chunk.stream === "stdout",
    );
    const retainedStdout = Buffer.concat(
      stdoutChunks.map((chunk) => Buffer.from(chunk.bytesBase64, "base64")),
    );
    const retainedStdoutSha256 = asSha256DigestV1(
      createHash("sha256").update(retainedStdout).digest("hex"),
    );
    const stopPhase = {
      ...phase(0, "managed_stop", stopCleanup),
      stdout: {
        ...stream,
        totalBytes: retainedStdout.byteLength,
        totalSha256: retainedStdoutSha256,
        retainedBytes: retainedStdout.byteLength,
        retainedSha256: retainedStdoutSha256,
      },
    };
    const stopCoverage =
      stdoutChunks.length === 0
        ? []
        : [
            VNextCaptureCoverageV1Schema.parse({
              schemaVersion: 1,
              channel: "log",
              status: "full",
              availableRange: {
                schemaVersion: 1,
                from: {
                  schemaVersion: 1,
                  processFrame: 130,
                  physicsTick: 125,
                  simulationTimeUs: 2_000_000,
                  hostMonotonicUs: 3_000_000,
                  renderFrame: null,
                },
                through: {
                  schemaVersion: 1,
                  processFrame: 130,
                  physicsTick: 125,
                  simulationTimeUs: 2_000_000,
                  hostMonotonicUs: 3_000_000,
                  renderFrame: null,
                },
              },
              requestedSampleEvery: 1,
              realizedSampleEvery: 1,
              emittedRecords: stdoutChunks.length,
              droppedRecords: 0,
              overwrittenRecords: 0,
              observerEffectUs: 0,
              limitations: ["test retained diagnostic chunks"],
            }),
          ];
    const initial = {
      facts: facts({
        runtimeId: request.runtimeId,
        executionId: request.executionId,
      }),
      phases: [
        phase(0, "vanilla_import", null),
        phase(1, "vanilla_smoke", cleanup),
        phase(2, "managed_import", null),
        phase(3, "managed_handshake", null),
      ],
      diagnostics: [],
      coverage: [],
      loss: [],
    };
    return Promise.resolve({
      initial,
      status: () =>
        Promise.resolve({
          facts: initial.facts,
          phases: [phase(0, "managed_status", null)],
          diagnostics: [],
          coverage: [],
          loss: [],
        }),
      stop: () =>
        Promise.resolve({
          facts: {
            ...facts({
              runtimeId: request.runtimeId,
              executionId: request.executionId,
              status:
                stopCleanup.cgroupEmpty && stopCleanup.scratchRemoved
                  ? "stopped"
                  : "cleanup_pending",
            }),
            diagnostics: {
              stdoutTotalBytes: retainedStdout.byteLength,
              stdoutRetainedBytes: retainedStdout.byteLength,
              stdoutTruncated: false,
              stderrTotalBytes: 0,
              stderrRetainedBytes: 0,
              stderrTruncated: false,
            },
          },
          phases: [stopPhase],
          diagnostics: stopDiagnostics,
          coverage: stopCoverage,
          loss: [],
          cleanup: stopCleanup,
        }),
    });
  },
});

const launchFailurePhases = (
  stage: ExternalGodotLifecycleLaunchFailureReceiptV1["stage"],
  operationCleanup: VNextLifecycleCleanupReceiptV1 | null,
): VNextLifecyclePhaseReceiptV1[] => {
  switch (stage) {
    case "vanilla_import":
      return [
        {
          ...phase(0, "vanilla_import", operationCleanup),
          outcome: "failed",
          exitCode: 1,
        },
      ];
    case "vanilla_smoke":
      return [
        phase(0, "vanilla_import", null),
        {
          ...phase(1, "vanilla_smoke", operationCleanup),
          outcome: "failed",
          exitCode: 1,
        },
      ];
    case "managed_open":
      return [
        phase(0, "vanilla_import", null),
        phase(1, "vanilla_smoke", cleanup),
        {
          ...phase(2, "managed_import", operationCleanup),
          operationState: operationCleanup === null ? "not_started" : "started",
          outcome: "failed",
          exitCode: operationCleanup === null ? null : 1,
        },
      ];
    case "managed_handshake":
      return [
        phase(0, "vanilla_import", null),
        phase(1, "vanilla_smoke", cleanup),
        phase(2, "managed_import", null),
        {
          ...phase(3, "managed_handshake", operationCleanup),
          outcome: "failed",
          exitCode: 1,
        },
      ];
  }
};

const createLaunchFailureDriver = (
  stage: ExternalGodotLifecycleLaunchFailureReceiptV1["stage"],
  operationCleanup: VNextLifecycleCleanupReceiptV1 | null,
  identityOverrides: Partial<
    Pick<
      ExternalGodotLifecycleLaunchFailureReceiptV1,
      "taskId" | "buildId" | "runtimeId" | "executionId"
    >
  > = {},
): ExternalGodotLifecycleDriverV1 => ({
  launch(request): Promise<ExternalGodotLifecycleSessionV1> {
    throw new ExternalGodotLifecycleLaunchFailureV1({
      schemaVersion: 1,
      stage,
      taskId: identityOverrides.taskId ?? request.taskId,
      buildId: identityOverrides.buildId ?? request.prepared.build.buildId,
      runtimeId: identityOverrides.runtimeId ?? request.runtimeId,
      executionId: identityOverrides.executionId ?? request.executionId,
      message: "physical launch failed at /host/private/project",
      phases: launchFailurePhases(stage, operationCleanup),
      diagnostics: [],
      coverage: [],
      loss: [],
      cleanup: operationCleanup,
    });
  },
});

const createUnknownLaunchFailureDriver = (
  stage: "vanilla_import" | "managed_open",
): ExternalGodotLifecycleDriverV1 => ({
  launch(request): Promise<ExternalGodotLifecycleSessionV1> {
    const phases = launchFailurePhases(stage, null);
    const terminal = phases.at(-1);
    if (terminal === undefined) throw new Error("missing failure phase");
    phases[phases.length - 1] = {
      ...terminal,
      operationState: "unknown",
      cleanup: null,
    };
    throw new ExternalGodotLifecycleLaunchFailureV1({
      schemaVersion: 1,
      stage,
      taskId: request.taskId,
      buildId: request.prepared.build.buildId,
      runtimeId: request.runtimeId,
      executionId: request.executionId,
      message: "sidecar port rejected before process admission was observed",
      phases,
      diagnostics: [],
      coverage: [],
      loss: [],
      cleanup: null,
    });
  },
});

let toolCallSequence = 0;
const invoke = async (
  coordinator: ReturnType<typeof createExternalGodotLifecycleCoordinator>,
  toolName: "game_capabilities" | "game_launch" | "game_status" | "game_stop",
  input: Record<string, unknown>,
) =>
  coordinator.invoke({
    schemaVersion: 1,
    toolCallId: `call-${toolName}-${toolCallSequence++}`,
    toolName,
    input,
  });

const createCoordinator = (
  store: MemoryStore,
  driver: ExternalGodotLifecycleDriverV1,
  overrides: {
    readonly now?: string;
    readonly prepared?: PreparedExternalGodotLifecycleBuildV1;
  } = {},
) => {
  let eventSequence = 0;
  return createExternalGodotLifecycleCoordinator(
    {
      taskId: asTaskId("task:external"),
      workspaceId: asWorkspaceId("workspace:external"),
      workspaceDirectory: "/unused-by-fake",
      baselineSourceHash: digest("a"),
      projectCapability: {
        declaredSourceUrl: "https://example.test/external-project",
        sourceRevision: "b".repeat(40),
        baselineSelectedTreeSha256: digest("a"),
        descriptorSha256: digest("5"),
        capabilitySha256: digest("c"),
      },
      managedRuntime: {
        managedRuntimeId: `managed-godot-runtime:v1:${"d".repeat(64)}`,
        addonHash: digest("7"),
        overlayHash: digest("6"),
        vanillaSidecarSourceSha256: digest("8"),
        lifecycleSidecarSourceSha256: digest("9"),
        protocolProfile: "chronorift-godot-lifecycle-v1",
      },
      driver,
      runtimeStore: store,
    },
    {
      now: () => overrides.now ?? timestamp,
      nextId: (kind) =>
        kind === "runtime"
          ? asRuntimeId("runtime:external")
          : kind === "execution"
            ? asExecutionId("execution:external")
            : `event:${eventSequence++}`,
      nextToken: () => "e".repeat(64),
      prepareBuild: () => Promise.resolve(overrides.prepared ?? prepared),
    },
  );
};

describe("external Godot lifecycle coordinator", () => {
  it("withholds Host paths from generic tool failures and stored tool-call DTOs", async () => {
    const store = new MemoryStore();
    const coordinator = createCoordinator(store, {
      launch() {
        throw new Error("ENOENT /host/private/workspace/project.godot");
      },
    });
    await invoke(coordinator, "game_capabilities", {
      schemaVersion: 2,
      taskId: "task:external",
    });
    const response = await invoke(coordinator, "game_launch", {
      schemaVersion: 2,
      taskId: "task:external",
      buildId: prepared.build.buildId,
    });
    expect(response).toMatchObject({
      outcome: "error",
      error: {
        code: "operation_failed",
        message:
          "lifecycle tool operation failed; Host diagnostics were withheld",
      },
    });
    expect(JSON.stringify(response)).not.toContain("/host/private");
    expect(
      JSON.stringify(
        [...store.resources.entries()].filter(([key]) =>
          key.startsWith("tool-call:"),
        ),
      ),
    ).not.toContain("/host/private");
    await coordinator.close();
  });

  for (const [stage, operationCleanup] of [
    ["vanilla_import", cleanup],
    ["vanilla_smoke", cleanup],
    ["managed_open", null],
    ["managed_handshake", cleanup],
  ] as const) {
    it(`persists and seals a cleanup-satisfied ${stage} launch failure`, async () => {
      const store = new MemoryStore();
      const coordinator = createCoordinator(
        store,
        createLaunchFailureDriver(stage, operationCleanup),
      );
      await invoke(coordinator, "game_capabilities", {
        schemaVersion: 2,
        taskId: "task:external",
      });
      const launched = await invoke(coordinator, "game_launch", {
        schemaVersion: 2,
        taskId: "task:external",
        buildId: prepared.build.buildId,
      });
      expect(launched).toMatchObject({
        outcome: "error",
        error: {
          code: "operation_failed",
          recoverable: true,
          details: {
            executionId: "execution:external",
            runtimeId: "runtime:external",
            stage,
          },
        },
      });
      expect(JSON.stringify(launched)).not.toContain("/host/private");
      expect(store.seals).toEqual(["execution:external"]);
      const record = store.resources.get("execution:execution:external") as {
        status?: string;
        phases?: VNextLifecyclePhaseReceiptV1[];
        events?: unknown[];
        manifest?: {
          taskId?: string;
          runtimeId?: string;
          executionId?: string;
          buildId?: string;
        };
      };
      expect(record).toMatchObject({
        status: "failed",
        manifest: {
          taskId: "task:external",
          runtimeId: "runtime:external",
          executionId: "execution:external",
          buildId: prepared.build.buildId,
        },
      });
      expect(record.phases?.map((entry) => entry.phase)).toEqual(
        launchFailurePhases(stage, operationCleanup).map(
          (entry) => entry.phase,
        ),
      );
      expect(record.events).toHaveLength(
        (record.phases?.length ?? 0) + (operationCleanup === null ? 0 : 1),
      );
      await coordinator.close();
    });
  }

  it("persists retained chunks and explicit truncation loss for a failed launch", async () => {
    const store = new MemoryStore();
    const bytes = Buffer.from("abc");
    const retainedSha256 = asSha256DigestV1(
      createHash("sha256").update(bytes).digest("hex"),
    );
    const failurePhase = {
      ...launchFailurePhases("vanilla_import", cleanup)[0]!,
      stdout: {
        ...stream,
        totalBytes: 10,
        totalSha256: asSha256DigestV1(
          createHash("sha256").update("full-output").digest("hex"),
        ),
        retainedBytes: bytes.byteLength,
        retainedSha256,
        truncated: true,
        droppedBytes: 7,
      },
    };
    const range = {
      schemaVersion: 1 as const,
      from: {
        schemaVersion: 1 as const,
        processFrame: 0,
        physicsTick: 0,
        simulationTimeUs: 0,
        hostMonotonicUs: failurePhase.hostMonotonicStartUs,
        renderFrame: null,
      },
      through: {
        schemaVersion: 1 as const,
        processFrame: 0,
        physicsTick: 0,
        simulationTimeUs: 0,
        hostMonotonicUs: failurePhase.hostMonotonicEndUs,
        renderFrame: null,
      },
    };
    const driver: ExternalGodotLifecycleDriverV1 = {
      launch(request) {
        throw new ExternalGodotLifecycleLaunchFailureV1({
          schemaVersion: 1,
          stage: "vanilla_import",
          taskId: request.taskId,
          buildId: request.prepared.build.buildId,
          runtimeId: request.runtimeId,
          executionId: request.executionId,
          message: "vanilla import failed",
          phases: [failurePhase],
          diagnostics: [
            {
              schemaVersion: 1,
              phase: "import",
              stream: "stdout",
              offset: 0,
              byteLength: bytes.byteLength,
              sha256: retainedSha256,
              bytesBase64: bytes.toString("base64"),
            },
          ],
          coverage: [
            VNextCaptureCoverageV1Schema.parse({
              schemaVersion: 1,
              channel: "log",
              status: "partial",
              availableRange: range,
              requestedSampleEvery: 1,
              realizedSampleEvery: 1,
              emittedRecords: 1,
              droppedRecords: 1,
              overwrittenRecords: 0,
              observerEffectUs: 0,
              limitations: ["seven stdout bytes exceeded retention"],
            }),
          ],
          loss: [
            VNextCaptureLossV1Schema.parse({
              schemaVersion: 1,
              sequence: 0,
              channel: "log",
              kind: "dropped",
              count: 7,
              firstClock: range.from,
              lastClock: range.through,
              reason: "stdout retention byte bound was reached",
            }),
          ],
          cleanup,
        });
      },
    };
    const coordinator = createCoordinator(store, driver);
    await invoke(coordinator, "game_capabilities", {
      schemaVersion: 2,
      taskId: "task:external",
    });
    await invoke(coordinator, "game_launch", {
      schemaVersion: 2,
      taskId: "task:external",
      buildId: prepared.build.buildId,
    });
    const record = store.resources.get("execution:execution:external") as {
      events?: Array<{ payload?: { kind?: string; bytesBase64?: string } }>;
      phases?: VNextLifecyclePhaseReceiptV1[];
      coverage?: Array<{ channel?: string; emittedRecords?: number }>;
      loss?: Array<{ channel?: string; count?: number }>;
    };
    const output = record.events?.find(
      (entry) => entry.payload?.kind === "process_output",
    );
    const persisted = Buffer.from(output?.payload?.bytesBase64 ?? "", "base64");
    expect(persisted).toEqual(bytes);
    expect(createHash("sha256").update(persisted).digest("hex")).toBe(
      record.phases?.[0]?.stdout.retainedSha256,
    );
    expect(record.coverage).toEqual([
      expect.objectContaining({ channel: "log", emittedRecords: 1 }),
    ]);
    expect(record.loss).toEqual([
      expect.objectContaining({ channel: "log", count: 7 }),
    ]);
    await coordinator.close();
  });

  it("retains an unproven failed launch until sandbox cleanup reconciliation", async () => {
    const store = new MemoryStore();
    const incompleteCleanup = {
      ...cleanup,
      processGroupTerminated: false,
      godotExited: false,
      sidecarExited: false,
      cgroupEmpty: false,
      scopeRemoved: false,
      scratchRemoved: false,
    };
    const coordinator = createCoordinator(
      store,
      createLaunchFailureDriver("managed_handshake", incompleteCleanup),
    );
    await invoke(coordinator, "game_capabilities", {
      schemaVersion: 2,
      taskId: "task:external",
    });
    await expect(
      invoke(coordinator, "game_launch", {
        schemaVersion: 2,
        taskId: "task:external",
        buildId: prepared.build.buildId,
      }),
    ).resolves.toMatchObject({
      outcome: "error",
      error: {
        details: {
          executionId: "execution:external",
          stage: "managed_handshake",
        },
      },
    });
    expect(store.seals).toEqual([]);
    await expect(coordinator.close()).rejects.toThrow(/cleanup/iu);

    await expect(
      coordinator.reconcileSandboxCleanup({
        processGroupTerminated: true,
        cgroupPopulated: false,
        termSent: true,
        killSent: false,
        scopeRemoved: true,
      }),
    ).rejects.toThrow(/storage/iu);
    expect(store.seals).toEqual([]);
    await expect(
      coordinator.reconcileSandboxCleanup({
        processGroupTerminated: true,
        cgroupPopulated: false,
        termSent: true,
        killSent: false,
        scopeRemoved: true,
        storageReconciled: false,
      }),
    ).rejects.toThrow(/storage/iu);
    expect(store.seals).toEqual([]);
    await coordinator.reconcileSandboxCleanup({
      processGroupTerminated: true,
      cgroupPopulated: false,
      termSent: true,
      killSent: false,
      scopeRemoved: true,
      storageReconciled: true,
    });
    expect(store.seals).toEqual(["execution:external"]);
    expect(store.resources.get("execution:execution:external")).toMatchObject({
      status: "failed",
      phases: [
        {},
        {},
        {},
        { cleanup: { cgroupEmpty: false } },
        { cleanup: { cgroupEmpty: true, storageReconciled: true } },
      ],
    });
    await expect(coordinator.close()).resolves.toBeUndefined();
  });

  for (const stage of ["vanilla_import", "managed_open"] as const) {
    it(`reconciles a global sandbox cleanup onto the ${stage} unknown operation`, async () => {
      const store = new MemoryStore();
      const coordinator = createCoordinator(
        store,
        createUnknownLaunchFailureDriver(stage),
      );
      await invoke(coordinator, "game_capabilities", {
        schemaVersion: 2,
        taskId: "task:external",
      });
      await expect(
        invoke(coordinator, "game_launch", {
          schemaVersion: 2,
          taskId: "task:external",
          buildId: prepared.build.buildId,
        }),
      ).resolves.toMatchObject({ outcome: "error" });
      expect(store.seals).toEqual([]);
      await coordinator.reconcileSandboxCleanup({
        processGroupTerminated: true,
        cgroupPopulated: false,
        termSent: true,
        killSent: false,
        scopeRemoved: true,
        storageReconciled: true,
      });
      const record = store.resources.get("execution:execution:external") as {
        phases?: VNextLifecyclePhaseReceiptV1[];
      };
      expect(record.phases?.at(-1)).toMatchObject({
        phase: stage === "managed_open" ? "managed_import" : "vanilla_import",
        operationState: "unknown",
        cleanup: {
          processGroupTerminated: true,
          cgroupEmpty: true,
          scopeRemoved: true,
          storageReconciled: true,
        },
      });
      expect(store.seals).toEqual(["execution:external"]);
      await coordinator.close();
    });
  }

  it("reconciles global sandbox cleanup after an admitted session stop rejects", async () => {
    const store = new MemoryStore();
    const base = createDriver();
    const driver: ExternalGodotLifecycleDriverV1 = {
      async launch(request, signal) {
        const session = await base.launch(request, signal);
        return {
          ...session,
          stop() {
            throw new Error("session stop transport rejected");
          },
        };
      },
    };
    const coordinator = createCoordinator(store, driver);
    await invoke(coordinator, "game_capabilities", {
      schemaVersion: 2,
      taskId: "task:external",
    });
    await invoke(coordinator, "game_launch", {
      schemaVersion: 2,
      taskId: "task:external",
      buildId: prepared.build.buildId,
    });
    await expect(
      invoke(coordinator, "game_stop", {
        schemaVersion: 2,
        taskId: "task:external",
        runtimeId: "runtime:external",
      }),
    ).resolves.toMatchObject({ outcome: "error" });
    expect(store.seals).toEqual([]);
    await coordinator.reconcileSandboxCleanup({
      processGroupTerminated: true,
      cgroupPopulated: false,
      termSent: true,
      killSent: false,
      scopeRemoved: true,
      storageReconciled: true,
    });
    const record = store.resources.get("execution:execution:external") as {
      status?: string;
      phases?: VNextLifecyclePhaseReceiptV1[];
    };
    expect(record.status).toBe("crashed");
    expect(record.phases?.at(-1)).toMatchObject({
      phase: "managed_handshake",
      cleanup: { cgroupEmpty: true, storageReconciled: true },
    });
    await coordinator.close();
  });

  it("preserves a failed process outcome when cleanup is later reconciled", async () => {
    const incompleteCleanup = {
      ...cleanup,
      processGroupTerminated: false,
      godotExited: true,
      sidecarExited: true,
      cgroupEmpty: false,
      scopeRemoved: false,
      scratchRemoved: false,
      storageReconciled: false,
    };
    const store = new MemoryStore();
    const base = createDriver(incompleteCleanup);
    const driver: ExternalGodotLifecycleDriverV1 = {
      async launch(request, signal) {
        const session = await base.launch(request, signal);
        return {
          ...session,
          async stop(stopSignal) {
            const stopped = await session.stop(stopSignal);
            return {
              ...stopped,
              phases: stopped.phases.map((receipt) => ({
                ...receipt,
                outcome: "failed" as const,
                exitCode: 1,
              })),
            };
          },
        };
      },
    };
    const coordinator = createCoordinator(store, driver);
    await invoke(coordinator, "game_capabilities", {
      schemaVersion: 2,
      taskId: "task:external",
    });
    await invoke(coordinator, "game_launch", {
      schemaVersion: 2,
      taskId: "task:external",
      buildId: prepared.build.buildId,
    });
    await invoke(coordinator, "game_stop", {
      schemaVersion: 2,
      taskId: "task:external",
      runtimeId: "runtime:external",
    });

    await coordinator.reconcileSandboxCleanup({
      processGroupTerminated: true,
      cgroupPopulated: false,
      termSent: true,
      killSent: false,
      scopeRemoved: true,
      storageReconciled: true,
    });
    const record = store.resources.get("execution:execution:external") as {
      status?: string;
      phases?: VNextLifecyclePhaseReceiptV1[];
    };
    expect(record.status).toBe("crashed");
    const beforeReconciliation = record.phases?.at(-2);
    const afterReconciliation = record.phases?.at(-1);
    expect(beforeReconciliation).toMatchObject({
      phase: "managed_stop",
      outcome: "failed",
      exitCode: 1,
      hostMonotonicStartUs: 0,
      hostMonotonicEndUs: 1,
    });
    expect(beforeReconciliation?.cleanup?.cgroupEmpty).toBe(false);
    expect(afterReconciliation).toMatchObject({
      phase: "managed_stop",
      outcome: "failed",
      exitCode: 1,
      hostMonotonicStartUs: 0,
      hostMonotonicEndUs: 1,
    });
    expect(afterReconciliation?.cleanup?.cgroupEmpty).toBe(true);
    await coordinator.close();
  });

  for (const [identity, value] of [
    ["taskId", "task:other"],
    ["buildId", "build:other"],
    ["runtimeId", "runtime:other"],
    ["executionId", "execution:other"],
  ] as const) {
    it(`rejects a launch-failure ${identity} mismatch`, async () => {
      const store = new MemoryStore();
      const coordinator = createCoordinator(
        store,
        createLaunchFailureDriver("vanilla_import", cleanup, {
          [identity]: value,
        }),
      );
      await invoke(coordinator, "game_capabilities", {
        schemaVersion: 2,
        taskId: "task:external",
      });
      await expect(
        invoke(coordinator, "game_launch", {
          schemaVersion: 2,
          taskId: "task:external",
          buildId: prepared.build.buildId,
        }),
      ).resolves.toMatchObject({
        outcome: "error",
        error: {
          code: "resource_task_mismatch",
          details: {
            executionId: "execution:external",
            stage: "vanilla_import",
          },
        },
      });
      expect(store.seals).toEqual([]);
      await coordinator.close();
    });
  }

  it("runs the exact four-tool lifecycle and seals only after cleanup", async () => {
    const store = new MemoryStore();
    const coordinator = createCoordinator(store, createDriver());
    const capabilities = await invoke(coordinator, "game_capabilities", {
      schemaVersion: 2,
      taskId: "task:external",
    });
    expect(capabilities).toMatchObject({ outcome: "success" });
    if (capabilities.outcome !== "success") throw new Error("capabilities");
    const buildId = (capabilities.output as { build: { buildId: string } })
      .build.buildId;

    const launched = await invoke(coordinator, "game_launch", {
      schemaVersion: 2,
      taskId: "task:external",
      buildId,
    });
    if (launched.outcome === "error") {
      throw new Error(JSON.stringify(launched.error));
    }
    expect(launched).toMatchObject({
      outcome: "success",
      output: {
        runtime: {
          status: "running",
          clocks: { processFrameDelta: 120, physicsTickDelta: 120 },
        },
      },
    });
    await expect(
      invoke(coordinator, "game_status", {
        schemaVersion: 2,
        taskId: "task:external",
        runtimeId: "runtime:external",
      }),
    ).resolves.toMatchObject({ outcome: "success" });
    await expect(
      invoke(coordinator, "game_stop", {
        schemaVersion: 2,
        taskId: "task:external",
        runtimeId: "runtime:external",
      }),
    ).resolves.toMatchObject({
      outcome: "success",
      output: { sealed: true, cleanup: { cgroupEmpty: true } },
    });
    expect(store.seals).toEqual(["execution:external"]);
    expect(
      [...store.resources.keys()].some((key) => key.startsWith("execution:")),
    ).toBe(true);
    await coordinator.close();
  });

  it("marks retrospective raw events with a non-occurrence sampled clock", async () => {
    const bytes = Buffer.from("managed output");
    const chunk: ExternalGodotLifecycleDiagnosticChunkV1 = {
      schemaVersion: 1,
      phase: "managed",
      stream: "stdout",
      offset: 0,
      byteLength: bytes.byteLength,
      sha256: asSha256DigestV1(
        createHash("sha256").update(bytes).digest("hex"),
      ),
      bytesBase64: bytes.toString("base64"),
    };
    const store = new MemoryStore();
    const coordinator = createCoordinator(
      store,
      createDriver(cleanup, [chunk]),
    );
    await invoke(coordinator, "game_capabilities", {
      schemaVersion: 2,
      taskId: "task:external",
    });
    await invoke(coordinator, "game_launch", {
      schemaVersion: 2,
      taskId: "task:external",
      buildId: prepared.build.buildId,
    });
    await invoke(coordinator, "game_stop", {
      schemaVersion: 2,
      taskId: "task:external",
      runtimeId: "runtime:external",
    });

    const events = store.events.get("execution:external") as Array<{
      clock: {
        processFrame: number;
        physicsTick: number;
        simulationTimeUs: number;
        hostMonotonicUs: number;
      };
      payload: {
        kind?: string;
        timingBasis?: string;
        occurrenceTimingBasis?: string;
        phase?: { phase?: string } | string;
        phaseHostMonotonicStartUs?: number;
        phaseHostMonotonicEndUs?: number;
      };
    }>;
    const ready = events.find(
      (entry) => entry.payload.kind === "lifecycle_ready",
    );
    expect(ready?.payload.timingBasis).toBe("sampled_observation");
    expect(ready?.clock).toMatchObject({
      processFrame: 130,
      physicsTick: 125,
      simulationTimeUs: 2_000_000,
    });
    const vanillaImport = events.find(
      (entry) =>
        entry.payload.kind === "lifecycle_phase" &&
        typeof entry.payload.phase === "object" &&
        entry.payload.phase.phase === "vanilla_import",
    );
    expect(vanillaImport?.payload).toMatchObject({
      timingBasis: "last_sample_before_ingest",
      occurrenceTimingBasis: "phase_receipt_bounds",
    });
    expect(vanillaImport?.clock).toEqual(ready?.clock);
    const processOutput = events.find(
      (entry) => entry.payload.kind === "process_output",
    );
    expect(processOutput?.payload).toMatchObject({
      timingBasis: "last_sample_before_ingest",
      occurrenceTimingBasis: "operation_envelope",
      phase: "managed",
      phaseHostMonotonicStartUs: 0,
      phaseHostMonotonicEndUs: 4,
    });
    expect(processOutput?.clock).toEqual(ready?.clock);
    await coordinator.close();
  });

  it("leaves the execution unsealed when cleanup is not proven", async () => {
    const store = new MemoryStore();
    const coordinator = createCoordinator(
      store,
      createDriver({ ...cleanup, cgroupEmpty: false }),
    );
    await invoke(coordinator, "game_capabilities", {
      schemaVersion: 2,
      taskId: "task:external",
    });
    const launched = await invoke(coordinator, "game_launch", {
      schemaVersion: 2,
      taskId: "task:external",
      buildId: prepared.build.buildId,
    });
    if (launched.outcome === "error") {
      throw new Error(JSON.stringify(launched.error));
    }
    const stopped = await invoke(coordinator, "game_stop", {
      schemaVersion: 2,
      taskId: "task:external",
      runtimeId: "runtime:external",
    });
    expect(stopped).toMatchObject({
      outcome: "error",
      error: { code: "operation_failed" },
    });
    expect(store.seals).toEqual([]);
    await expect(coordinator.close()).rejects.toThrow(/cleanup/iu);
  });

  it("preserves a failed cleanup attempt and seals after Task sandbox reconciliation", async () => {
    const store = new MemoryStore();
    const coordinator = createCoordinator(
      store,
      createDriver({ ...cleanup, cgroupEmpty: false, scratchRemoved: false }),
    );
    await invoke(coordinator, "game_capabilities", {
      schemaVersion: 2,
      taskId: "task:external",
    });
    const launched = await invoke(coordinator, "game_launch", {
      schemaVersion: 2,
      taskId: "task:external",
      buildId: prepared.build.buildId,
    });
    if (launched.outcome === "error") {
      throw new Error(JSON.stringify(launched.error));
    }
    await expect(
      invoke(coordinator, "game_stop", {
        schemaVersion: 2,
        taskId: "task:external",
        runtimeId: "runtime:external",
      }),
    ).resolves.toMatchObject({
      outcome: "error",
      error: { code: "operation_failed" },
    });

    await coordinator.reconcileSandboxCleanup({
      processGroupTerminated: true,
      cgroupPopulated: false,
      termSent: true,
      killSent: false,
      scopeRemoved: true,
      storageReconciled: true,
    });
    await expect(coordinator.close()).resolves.toBeUndefined();
    expect(store.seals).toEqual(["execution:external"]);
    const record = store.resources.get("execution:execution:external") as {
      phases?: Array<{ cleanup?: VNextLifecycleCleanupReceiptV1 | null }>;
    };
    expect(record.phases?.at(-1)?.cleanup).toMatchObject({
      cgroupEmpty: true,
      scratchRemoved: true,
      storageReconciled: true,
    });
    expect(
      record.phases?.some((entry) => entry.cleanup?.cgroupEmpty === false),
    ).toBe(true);
  });

  it("stops a returned session when readiness validation rejects it", async () => {
    let stopCalls = 0;
    const store = new MemoryStore();
    const base = createDriver();
    const driver: ExternalGodotLifecycleDriverV1 = {
      async launch(request, signal) {
        const session = await base.launch(request, signal);
        return {
          ...session,
          initial: {
            ...session.initial,
            facts: {
              ...session.initial.facts,
              clocks: {
                ...session.initial.facts.clocks,
                processFrameDelta: 119,
              },
            },
          },
          stop: async (stopSignal) => {
            stopCalls += 1;
            return session.stop(stopSignal);
          },
        };
      },
    };
    const coordinator = createCoordinator(store, driver);
    await invoke(coordinator, "game_capabilities", {
      schemaVersion: 2,
      taskId: "task:external",
    });
    await expect(
      invoke(coordinator, "game_launch", {
        schemaVersion: 2,
        taskId: "task:external",
        buildId: prepared.build.buildId,
      }),
    ).resolves.toMatchObject({
      outcome: "error",
      error: {
        code: "operation_failed",
        details: {
          executionId: "execution:external",
          runtimeId: "runtime:external",
          stage: "session_validation",
        },
      },
    });
    expect(stopCalls).toBe(1);
    expect(store.seals).toEqual(["execution:external"]);
    const record = store.resources.get("execution:execution:external") as {
      status?: string;
      phases?: VNextLifecyclePhaseReceiptV1[];
      events?: Array<{
        payload?: { kind?: string; phase?: { phase?: string } };
      }>;
    };
    expect(record.status).toBe("failed");
    expect(record.phases?.map((entry) => entry.phase)).toEqual([
      "vanilla_import",
      "vanilla_smoke",
      "managed_import",
      "managed_handshake",
      "managed_stop",
    ]);
    expect(
      record.events
        ?.filter((entry) => entry.payload?.kind === "lifecycle_phase")
        .map((entry) => entry.payload?.phase?.phase),
    ).toEqual([
      "vanilla_import",
      "vanilla_smoke",
      "managed_import",
      "managed_handshake",
      "managed_stop",
    ]);
    await coordinator.close();
  });

  it("keeps a rejected session unsealed until its unproven stop cleanup is reconciled", async () => {
    const store = new MemoryStore();
    const incompleteCleanup = {
      ...cleanup,
      processGroupTerminated: false,
      godotExited: false,
      sidecarExited: false,
      cgroupEmpty: false,
      scopeRemoved: false,
      scratchRemoved: false,
      storageReconciled: false,
    };
    const base = createDriver(incompleteCleanup);
    const driver: ExternalGodotLifecycleDriverV1 = {
      async launch(request, signal) {
        const session = await base.launch(request, signal);
        return {
          ...session,
          initial: {
            ...session.initial,
            facts: {
              ...session.initial.facts,
              clocks: {
                ...session.initial.facts.clocks,
                physicsTickDelta: 119,
              },
            },
          },
        };
      },
    };
    const coordinator = createCoordinator(store, driver);
    await invoke(coordinator, "game_capabilities", {
      schemaVersion: 2,
      taskId: "task:external",
    });
    await expect(
      invoke(coordinator, "game_launch", {
        schemaVersion: 2,
        taskId: "task:external",
        buildId: prepared.build.buildId,
      }),
    ).resolves.toMatchObject({
      outcome: "error",
      error: {
        code: "operation_failed",
        recoverable: false,
        details: { stage: "session_validation" },
      },
    });
    expect(store.seals).toEqual([]);
    await expect(coordinator.close()).rejects.toThrow(/cleanup/iu);

    await coordinator.reconcileSandboxCleanup({
      processGroupTerminated: true,
      cgroupPopulated: false,
      termSent: true,
      killSent: false,
      scopeRemoved: true,
      storageReconciled: true,
    });
    expect(store.seals).toEqual(["execution:external"]);
    expect(store.resources.get("execution:execution:external")).toMatchObject({
      status: "failed",
      phases: [
        {},
        {},
        {},
        {},
        { phase: "managed_stop", cleanup: { cgroupEmpty: false } },
        { phase: "managed_stop", cleanup: { cgroupEmpty: true } },
      ],
    });
    await coordinator.close();
  });

  it("persists a returned session that omits a required launch phase", async () => {
    let stopCalls = 0;
    const store = new MemoryStore();
    const base = createDriver();
    const driver: ExternalGodotLifecycleDriverV1 = {
      async launch(request, signal) {
        const session = await base.launch(request, signal);
        return {
          ...session,
          initial: {
            ...session.initial,
            phases: session.initial.phases.slice(0, 3),
          },
          async stop(stopSignal) {
            stopCalls += 1;
            return session.stop(stopSignal);
          },
        };
      },
    };
    const coordinator = createCoordinator(store, driver);
    await invoke(coordinator, "game_capabilities", {
      schemaVersion: 2,
      taskId: "task:external",
    });
    await expect(
      invoke(coordinator, "game_launch", {
        schemaVersion: 2,
        taskId: "task:external",
        buildId: prepared.build.buildId,
      }),
    ).resolves.toMatchObject({
      outcome: "error",
      error: { details: { stage: "session_validation" } },
    });
    expect(stopCalls).toBe(1);
    expect(store.seals).toEqual(["execution:external"]);
    const record = store.resources.get("execution:execution:external") as {
      status?: string;
      phases?: VNextLifecyclePhaseReceiptV1[];
    };
    expect(record.status).toBe("failed");
    expect(record.phases?.map((entry) => entry.phase)).toEqual([
      "vanilla_import",
      "vanilla_smoke",
      "managed_import",
      "managed_stop",
    ]);
    await coordinator.close();
  });

  it("reuses an unchanged content-addressed build across coordinator turns", async () => {
    const store = new MemoryStore();
    const first = createCoordinator(store, createDriver());
    await expect(
      invoke(first, "game_capabilities", {
        schemaVersion: 2,
        taskId: "task:external",
      }),
    ).resolves.toMatchObject({ outcome: "success" });
    await first.close();

    const laterTimestamp = "2026-08-10T00:01:00.000Z";
    const second = createCoordinator(store, createDriver(), {
      now: laterTimestamp,
      prepared: {
        ...prepared,
        build: { ...prepared.build, createdAt: laterTimestamp },
      },
    });
    await expect(
      invoke(second, "game_capabilities", {
        schemaVersion: 2,
        taskId: "task:external",
      }),
    ).resolves.toMatchObject({ outcome: "success" });
    expect(
      store.resources.get(`build:${prepared.build.buildId}`),
    ).toMatchObject({ createdAt: timestamp });
    await second.close();
  });

  for (const failureKind of ["runtime", "execution"] as const) {
    it(`retries terminal ${failureKind} persistence without appending to the sealed ledger`, async () => {
      const store = new MemoryStore();
      const coordinator = createCoordinator(store, createDriver());
      await invoke(coordinator, "game_capabilities", {
        schemaVersion: 2,
        taskId: "task:external",
      });
      const launched = await invoke(coordinator, "game_launch", {
        schemaVersion: 2,
        taskId: "task:external",
        buildId: prepared.build.buildId,
      });
      if (launched.outcome === "error") {
        throw new Error(JSON.stringify(launched.error));
      }
      store.failNextPutKind = failureKind;
      await expect(
        invoke(coordinator, "game_stop", {
          schemaVersion: 2,
          taskId: "task:external",
          runtimeId: "runtime:external",
        }),
      ).resolves.toMatchObject({ outcome: "error" });
      const eventCountAfterSeal =
        store.events.get("execution:external")?.length;
      await expect(coordinator.close()).resolves.toBeUndefined();
      expect(store.events.get("execution:external")?.length).toBe(
        eventCountAfterSeal,
      );
      expect(store.seals).toEqual(["execution:external"]);
      expect(store.resources.has("runtime:runtime:external")).toBe(true);
      expect(store.resources.has("execution:execution:external")).toBe(true);
    });
  }

  it("retries a transient raw-ledger seal failure before terminal persistence", async () => {
    const store = new MemoryStore();
    const coordinator = createCoordinator(store, createDriver());
    await invoke(coordinator, "game_capabilities", {
      schemaVersion: 2,
      taskId: "task:external",
    });
    const launched = await invoke(coordinator, "game_launch", {
      schemaVersion: 2,
      taskId: "task:external",
      buildId: prepared.build.buildId,
    });
    if (launched.outcome === "error") {
      throw new Error(JSON.stringify(launched.error));
    }
    store.failNextSeal = true;
    await expect(
      invoke(coordinator, "game_stop", {
        schemaVersion: 2,
        taskId: "task:external",
        runtimeId: "runtime:external",
      }),
    ).resolves.toMatchObject({ outcome: "error" });
    await expect(coordinator.close()).resolves.toBeUndefined();
    expect(store.seals).toEqual(["execution:external"]);
  });

  for (const mode of ["before_write", "after_write"] as const) {
    for (const stopEventOffset of [0, 1, 2] as const) {
      it(`applies one stop receipt when ${mode} fails at stop event ${stopEventOffset}`, async () => {
        const store = new MemoryStore();
        const bytes = Buffer.from("terminal-output");
        const chunk: ExternalGodotLifecycleDiagnosticChunkV1 = {
          schemaVersion: 1,
          phase: "managed",
          stream: "stdout",
          offset: 0,
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytesBase64: bytes.toString("base64"),
        };
        const coordinator = createCoordinator(
          store,
          createDriver(cleanup, [chunk]),
        );
        await invoke(coordinator, "game_capabilities", {
          schemaVersion: 2,
          taskId: "task:external",
        });
        await invoke(coordinator, "game_launch", {
          schemaVersion: 2,
          taskId: "task:external",
          buildId: prepared.build.buildId,
        });
        const launchEventCount =
          store.events.get("execution:external")?.length ?? 0;
        store.failAppend = {
          sequence: launchEventCount + stopEventOffset,
          mode,
        };
        const stopped = await invoke(coordinator, "game_stop", {
          schemaVersion: 2,
          taskId: "task:external",
          runtimeId: "runtime:external",
        });
        expect(stopped.outcome).toBe(
          mode === "before_write" ? "error" : "success",
        );
        await expect(coordinator.close()).resolves.toBeUndefined();

        const record = store.resources.get("execution:execution:external") as {
          phases?: VNextLifecyclePhaseReceiptV1[];
          events?: Array<{
            payload?: {
              kind?: string;
              phase?: { phase?: string };
              bytesBase64?: string;
            };
          }>;
          coverage?: Array<{ channel?: string; emittedRecords?: number }>;
        };
        expect(
          record.phases?.filter((entry) => entry.phase === "managed_stop"),
        ).toHaveLength(1);
        expect(
          record.events?.filter(
            (entry) =>
              entry.payload?.kind === "lifecycle_phase" &&
              entry.payload.phase?.phase === "managed_stop",
          ),
        ).toHaveLength(1);
        expect(
          record.events?.filter(
            (entry) => entry.payload?.kind === "process_output",
          ),
        ).toHaveLength(1);
        const retained = Buffer.concat(
          (record.events ?? [])
            .filter((entry) => entry.payload?.kind === "process_output")
            .map((entry) =>
              Buffer.from(entry.payload?.bytesBase64 ?? "", "base64"),
            ),
        );
        const managedStop = record.phases?.find(
          (entry) => entry.phase === "managed_stop",
        );
        expect(retained.byteLength).toBe(managedStop?.stdout.retainedBytes);
        expect(createHash("sha256").update(retained).digest("hex")).toBe(
          managedStop?.stdout.retainedSha256,
        );
        expect(
          record.coverage?.find((entry) => entry.channel === "log"),
        ).toMatchObject({ emittedRecords: 1 });
        expect(
          record.events?.filter(
            (entry) => entry.payload?.kind === "lifecycle_cleanup",
          ),
        ).toHaveLength(1);
      });
    }
  }
});
