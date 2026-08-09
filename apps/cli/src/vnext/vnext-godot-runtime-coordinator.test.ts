import {
  GAME_TOOL_NAMES_V1,
  validateGameToolOutputV1,
  type GameToolNameV1,
} from "@chronorift/agent-protocol";
import {
  CheckpointCertificateV1Schema,
  RuntimeFingerprintV1Schema,
  VNextBuildV1Schema,
  VNextExecutionRecordV1Schema,
  VNextRawRuntimeEventV1Schema,
  asEventId,
  asSha256DigestV1,
  asTaskId,
  asWorkspaceId,
  type CheckpointCertificateV1,
  type EnvironmentSnapshot,
  type RuntimeFingerprintV1,
  type VNextBuildV1,
  type VNextExecutionRecordV1,
  type VNextRawRuntimeEventV1,
} from "@chronorift/domain";
import type {
  VNextGodotConnectRequestV1,
  VNextGodotRestoreRequestV1,
  VNextGodotRuntimeClient,
  VNextGodotStepRequestV1,
  VNextGodotStepResultV1,
} from "@chronorift/godot-adapter";
import { GodotAdapterError } from "@chronorift/godot-adapter";
import type { RuntimeSidecarDiagnosticV1 } from "@chronorift/godot-protocol";
import {
  contentHash,
  type RuntimeExecutionSealV1,
} from "@chronorift/json-artifacts";
import type {
  VNextGameToolPortRequestV1,
  VNextGameToolResponseV1,
} from "@chronorift/pi-harness";
import { describe, expect, it } from "vitest";

import type { PreparedCandidateGodotBuildV1 } from "./candidate-godot-build.js";
import type {
  OpenSandboxedGodotSidecarResultV1,
  SandboxedGodotSidecarV1,
} from "./godot-sidecar-port.js";
import type { ManagedGodotRuntimeCapabilityV1 } from "./managed-godot-runtime.js";
import type { SandboxExecutionResultV1 } from "./sandbox-broker.js";
import {
  createVNextGodotRuntimeCoordinator,
  type VNextGodotRuntimeCoordinatorStore,
} from "./vnext-godot-runtime-coordinator.js";

const taskId = asTaskId("task:m3");
const workspaceId = asWorkspaceId("workspace:m3");
const now = "2026-08-07T00:00:00.000Z";
const hash = (value: string) =>
  asSha256DigestV1(value.padEnd(64, value[0] ?? "a").slice(0, 64));

const build: VNextBuildV1 = VNextBuildV1Schema.parse({
  schemaVersion: 1,
  taskId,
  workspaceId,
  sourceId: "source:m3",
  buildId: "build:m3",
  sourceHash: hash("a"),
  workspaceDiffHash: hash("b"),
  buildConfigurationHash: hash("c"),
  outputHash: hash("d"),
  createdAt: now,
});

const prepared: PreparedCandidateGodotBuildV1 = {
  build,
  fixtureHash: hash("e"),
  projectHash: hash("f"),
  addonHash: hash("1"),
  fileCount: 3,
  byteLength: 1024,
};

const nextBuild = VNextBuildV1Schema.parse({
  ...build,
  buildId: "build:m3-next",
  sourceHash: hash("9"),
  workspaceDiffHash: hash("0"),
  outputHash: hash("a"),
});
const nextPrepared: PreparedCandidateGodotBuildV1 = {
  ...prepared,
  build: nextBuild,
  fixtureHash: hash("b"),
  projectHash: hash("c"),
};

const managedRuntime = {
  schemaVersion: 1,
  managedRuntimeId: "managed-godot-runtime:test",
  engine: "godot",
  engineVersion: "4.7.1",
  adapterVersion: "0.4.0",
  protocolVersion: 2,
  nodeTarget: "/opt/node",
  godotTarget: "/opt/godot",
  toolchain: {},
  sidecarSourceSha256: hash("2"),
  addonHash: prepared.addonHash,
  addonFiles: [],
} as unknown as ManagedGodotRuntimeCapabilityV1;

const fixtureCapability = {
  schemaVersion: 1,
  fixtureId: "frame-input-window",
  trustedManifestSha256: hash("3"),
  baselineSelectedTreeSha256: hash("4"),
  startupScene: "res://frame_input_window.tscn",
  protocolVersion: 2,
  runtimeProfile: "chronorift-godot-protocol-v2",
  inputActions: ["attempt_jump"],
  controls: {
    fixedFps: { default: 120, allowed: [60, 120] },
    physicsTicksPerSecond: { default: 60, allowed: [60, 120] },
    maxTicks: { default: 10, minimum: 1, maximum: 600 },
  },
  ignoredCachePaths: [".godot"],
  capabilitySha256: hash("5"),
} as const;

class MemoryRuntimeStore implements VNextGodotRuntimeCoordinatorStore {
  public readonly resources = new Map<string, unknown>();
  public readonly events = new Map<string, unknown[]>();
  public readonly seals = new Map<string, RuntimeExecutionSealV1>();
  public failExecutionResourceWrites = 0;
  public failBranchResourceWrites = 0;
  public failAppendWrites = 0;

  public putResourceOnce<T>(
    kind: Parameters<VNextGodotRuntimeCoordinatorStore["putResourceOnce"]>[0],
    resourceId: string,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<void> {
    if (kind === "execution" && this.failExecutionResourceWrites > 0) {
      this.failExecutionResourceWrites -= 1;
      return Promise.reject(new Error("injected execution resource failure"));
    }
    if (kind === "branch" && this.failBranchResourceWrites > 0) {
      this.failBranchResourceWrites -= 1;
      return Promise.reject(new Error("injected branch resource failure"));
    }
    const key = `${kind}:${resourceId}`;
    const parsed = structuredClone(parse(value));
    const previous = this.resources.get(key);
    if (
      previous !== undefined &&
      JSON.stringify(previous) !== JSON.stringify(parsed)
    ) {
      return Promise.reject(new Error(`resource conflict: ${key}`));
    }
    this.resources.set(key, parsed);
    return Promise.resolve();
  }

  public readResource<T>(
    kind: Parameters<VNextGodotRuntimeCoordinatorStore["readResource"]>[0],
    resourceId: string,
    parse: (input: unknown) => T,
  ): Promise<T> {
    const value = this.resources.get(`${kind}:${resourceId}`);
    if (value === undefined) return Promise.reject(new Error("not found"));
    return Promise.resolve(parse(structuredClone(value)));
  }

  public appendExecutionEvent<T>(
    executionId: string,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<unknown> {
    if (this.failAppendWrites > 0) {
      this.failAppendWrites -= 1;
      return Promise.reject(new Error("injected execution append failure"));
    }
    if (this.seals.has(executionId)) {
      return Promise.reject(new Error("sealed"));
    }
    const records = this.events.get(executionId) ?? [];
    const parsed = parse(value);
    records.push(structuredClone(parsed));
    this.events.set(executionId, records);
    return Promise.resolve({ sequence: records.length - 1 });
  }

  public readExecutionEvents<T>(
    executionId: string,
    parse: (input: unknown) => T,
  ): Promise<readonly T[]> {
    return Promise.resolve(
      (this.events.get(executionId) ?? []).map((value) =>
        parse(structuredClone(value)),
      ),
    );
  }

  public readExecutionSeal(
    executionId: string,
  ): Promise<RuntimeExecutionSealV1> {
    const seal = this.seals.get(executionId);
    return seal === undefined
      ? Promise.reject(new Error("not found"))
      : Promise.resolve(structuredClone(seal));
  }

  public sealExecution(executionId: string): Promise<RuntimeExecutionSealV1> {
    const existing = this.seals.get(executionId);
    if (existing !== undefined) return Promise.resolve(existing);
    const events = this.events.get(executionId) ?? [];
    const seal: RuntimeExecutionSealV1 = {
      schemaVersion: 1,
      taskId,
      executionId,
      count: events.length,
      headHash:
        events.length === 0 ? null : contentHash(events.at(-1) as never),
      byteLength: Buffer.byteLength(JSON.stringify(events), "utf8"),
      contentHash: contentHash(events as never),
    };
    this.seals.set(executionId, seal);
    return Promise.resolve(seal);
  }
}

const fingerprint: RuntimeFingerprintV1 = RuntimeFingerprintV1Schema.parse({
  schemaVersion: 1,
  engine: "godot",
  engineVersion: "4.7.1.stable.official",
  adapterVersion: "0.4.0",
  protocolVersion: 2,
  platform: "Linux",
  renderer: "gl_compatibility",
  physicsTicksPerSecond: 60,
  fixedFps: 120,
  projectHash: prepared.projectHash,
  addonHash: prepared.addonHash,
  capabilities: [
    "observe.property_sampling",
    "control.input_event_action",
    "clock.process_frame",
    "clock.physics_tick",
    "checkpoint.fixture_semantic",
  ],
});

const certificate = (
  stateHash: string,
  restoreRecipeHash: string,
): CheckpointCertificateV1 =>
  CheckpointCertificateV1Schema.parse({
    schemaVersion: 1,
    level: "fixture_semantic_l2",
    captureConsistencyModel: "frame_end_barrier",
    adapterSemanticBarrier: "chronorift.frame_end_deferred",
    environmentFingerprint: fingerprint,
    coveredStateDomains: [
      "registered.state_providers",
      "logical_clock",
      "input_schedule",
      "participant.case-02-state",
    ],
    missingStateDomains: ["godot.physics_internal"],
    externalDependencies: [],
    rngDomains: [],
    pendingAsyncOperations: ["untracked_deferred_calls"],
    restoreRecipeHash,
    restoreValidation: [
      {
        participantId: "case-02-state",
        status: "pass",
        stateHash,
        message: "participant matches",
      },
    ],
    portability: "same_build_only",
    limitations: ["fixture-owned fields only"],
  });

class FakeGodotClient {
  public readonly fingerprint: RuntimeFingerprintV1;
  public processFrame = 0;
  public physicsTick = 0;
  public simTimeUs = 0;
  public hostMonotonicUs = 0;
  public windowOpen = true;
  public jumping = false;
  public shutdownCalls = 0;
  public activeSteps = 0;
  public maxActiveSteps = 0;
  public failStep = false;
  public stepError: Error | null = null;
  public regressReceipt = false;
  public inconsistentStepReceipt = false;
  public omitAppliedInputs = false;
  public inconsistentInputApplications = false;
  public observationDropped = 0;
  public observationTruncated = 0;
  public observationBackpressure = false;
  public observationEmittedOverride: number | null = null;
  public failRestoreValidation = false;
  public omitParticipantRestoreValidation = false;
  public restoreCalls = 0;
  public eventsForStep:
    | ((request: VNextGodotStepRequestV1) => VNextGodotStepResultV1["events"])
    | null = null;
  private physicsRemainder = 0;

  public constructor(
    private readonly fixedFps = 120,
    private readonly physicsTicksPerSecond = 60,
  ) {
    this.fingerprint = RuntimeFingerprintV1Schema.parse({
      ...fingerprint,
      fixedFps,
      physicsTicksPerSecond,
    });
  }

  public async step(request: VNextGodotStepRequestV1) {
    if (this.stepError !== null) throw this.stepError;
    if (this.failStep) throw new Error("injected Godot step failure");
    this.activeSteps += 1;
    this.maxActiveSteps = Math.max(this.maxActiveSteps, this.activeSteps);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const appliedInputs = this.omitAppliedInputs ? [] : request.inputs;
    if (appliedInputs.some((input) => input.action === "attempt_jump")) {
      this.jumping = this.windowOpen;
    }
    this.processFrame += 1;
    this.physicsRemainder += this.physicsTicksPerSecond;
    const physicsTicksExecuted = Math.floor(
      this.physicsRemainder / this.fixedFps,
    );
    this.physicsRemainder %= this.fixedFps;
    this.physicsTick += physicsTicksExecuted;
    this.simTimeUs += request.deltaUs;
    const hostMonotonicStartUs = this.regressReceipt
      ? Math.max(0, this.hostMonotonicUs - 1)
      : Math.max(
          this.hostMonotonicUs,
          Number(process.hrtime.bigint() / 1_000n),
        );
    this.hostMonotonicUs = hostMonotonicStartUs + 1;
    this.activeSteps -= 1;
    const events =
      this.eventsForStep?.(request) ??
      ([
        {
          localId: `state:${this.processFrame}`,
          kind: "property_changed" as const,
          path: "player.window_open",
          before: this.windowOpen,
          after: this.windowOpen,
        },
      ] satisfies VNextGodotStepResultV1["events"]);
    return {
      events,
      state: {
        values: {
          "player.window_open": this.windowOpen,
          "player.jumping": this.jumping,
        },
      },
      receipt: {
        requestedTick: this.inconsistentStepReceipt
          ? request.tick + 1
          : request.tick,
        realizedTick: request.tick,
        requestedDeltaUs: request.deltaUs,
        realizedDeltaUs: request.deltaUs,
        appliedInputOrders: appliedInputs.map((input) => input.order),
        runtime: {
          schemaVersion: 1 as const,
          phase: "process_frame_start" as const,
          idleFramesExecuted: 1,
          physicsTicksExecuted,
          actualIdleDeltasUs: [request.deltaUs],
          actualPhysicsDeltasUs: Array.from(
            { length: physicsTicksExecuted },
            () => Math.round(1_000_000 / this.physicsTicksPerSecond),
          ),
          engineProcessFrame: this.processFrame,
          enginePhysicsFrame: this.physicsTick,
          hostMonotonicStartUs,
          hostMonotonicEndUs: this.hostMonotonicUs,
          inputApplications: (this.inconsistentInputApplications
            ? []
            : appliedInputs
          ).map((input) => ({
            order: input.order,
            eventsInjected: 2 as const,
            pressed: true as const,
            released: true as const,
          })),
          observationHealth: {
            schemaVersion: 1 as const,
            emittedEvents: this.observationEmittedOverride ?? events.length,
            droppedEvents: this.observationDropped,
            truncatedEvents: this.observationTruncated,
            bufferedBytes: 64,
            backpressure: this.observationBackpressure,
            probeOverheadUs: 10,
          },
        },
      },
    };
  }

  public snapshot(): Promise<{
    snapshot: EnvironmentSnapshot;
    certificate: CheckpointCertificateV1;
  }> {
    const participant = {
      started: true,
      jumping: this.jumping,
      windowOpen: this.windowOpen,
      leftFrame: 1,
      processCallbacks: this.processFrame,
    };
    const snapshot: EnvironmentSnapshot = {
      state: {
        values: {
          "player.window_open": this.windowOpen,
          "player.jumping": this.jumping,
        },
      },
      runtimeState: {
        nowUs: this.simTimeUs,
        nextTick: this.processFrame,
        participants: { "case-02-state": participant },
      },
      rngState: {},
      pendingEffects: { deferredCallsDrained: false, participants: {} },
    };
    return Promise.resolve({
      snapshot,
      certificate: certificate(
        contentHash(participant),
        contentHash(snapshot as never),
      ),
    });
  }

  public restore(request: VNextGodotRestoreRequestV1) {
    this.restoreCalls += 1;
    const runtime = request.snapshot.runtimeState as {
      participants: { "case-02-state": { windowOpen: boolean } };
    };
    this.windowOpen = runtime.participants["case-02-state"].windowOpen;
    this.jumping = Boolean(request.snapshot.state.values["player.jumping"]);
    this.processFrame = request.nextTick;
    this.simTimeUs = request.simTimeUs;
    const state = structuredClone(request.snapshot.state);
    const participant = runtime.participants["case-02-state"];
    return Promise.resolve({
      restored: true as const,
      nextTick: request.nextTick,
      simTimeUs: request.simTimeUs,
      state,
      runtimeValidation: {
        schemaVersion: 1 as const,
        level: "fixture_semantic_l2" as const,
        semanticStateHash: contentHash(state as never),
        validations: this.omitParticipantRestoreValidation
          ? []
          : [
              {
                participantId: "case-02-state",
                status: this.failRestoreValidation
                  ? ("fail" as const)
                  : ("pass" as const),
                stateHash: contentHash(participant as never),
                message: "participant matches restored state",
              },
            ],
      },
    });
  }

  public shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    return Promise.resolve();
  }
}

interface SidecarSession {
  readonly sidecar: SandboxedGodotSidecarV1;
  resolve(result: SandboxExecutionResultV1): void;
  terminated: boolean;
}

class FakeSidecarPort {
  public readonly launches: unknown[] = [];
  public readonly sessions: SidecarSession[] = [];
  public cleanupProven = true;
  public autoCompleteOnTerminate = true;
  public diagnostics: readonly RuntimeSidecarDiagnosticV1[] = [];
  public diagnosticFailure: {
    readonly code: "diagnostic_protocol_failure" | "diagnostic_limit_exceeded";
    readonly message: string;
  } | null = null;

  public open(input: unknown): Promise<OpenSandboxedGodotSidecarResultV1> {
    this.launches.push(structuredClone(input));
    let resolve!: (result: SandboxExecutionResultV1) => void;
    const completion = new Promise<SandboxExecutionResultV1>((accept) => {
      resolve = accept;
    });
    const session: SidecarSession = {
      sidecar: undefined as never,
      resolve,
      terminated: false,
    };
    const sidecar: SandboxedGodotSidecarV1 = {
      transport: {
        readable: new (class {
          public on(): this {
            return this;
          }
        })() as never,
        write: () => Promise.resolve(),
        close: () => Promise.resolve(),
      },
      completion,
      diagnostics: () => this.diagnostics,
      diagnosticFacts: () => ({
        schemaVersion: 1,
        status: "complete",
        records: this.diagnostics,
        frameCount: this.diagnostics.length,
        encodedByteLength: JSON.stringify(this.diagnostics).length,
        limits: {
          frameMaxBytes: 256 * 1024,
          totalMaxBytes: 2 * 1024 * 1024,
          maxCount: 128,
        },
        failure: this.diagnosticFailure,
      }),
      terminate: () => {
        session.terminated = true;
        if (this.autoCompleteOnTerminate) {
          resolve(executed("succeeded", this.cleanupProven));
        }
        return Promise.resolve();
      },
    };
    Object.assign(session, { sidecar });
    this.sessions.push(session);
    return Promise.resolve({ kind: "opened", sidecar });
  }
}

const executed = (
  status: "succeeded" | "failed",
  cleanupProven = true,
): SandboxExecutionResultV1 =>
  ({
    kind: "executed",
    receipt: {
      status,
      exitCode: status === "succeeded" ? 0 : 1,
      signal: null,
      cleanup: {
        processGroupTerminated: cleanupProven,
        cgroupPopulated: !cleanupProven,
        termSent: true,
        killSent: false,
        scopeRemoved: cleanupProven,
      },
    },
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
  }) as SandboxExecutionResultV1;

const successOutput = (response: VNextGameToolResponseV1) => {
  expect(response, JSON.stringify(response, null, 2)).toMatchObject({
    outcome: "success",
  });
  if (response.outcome !== "success") throw new Error(response.error.message);
  return response.output as Record<string, unknown>;
};

const objectValue = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object value");
  }
  return value as Record<string, unknown>;
};

const call = async (
  coordinator: ReturnType<typeof createVNextGodotRuntimeCoordinator>,
  toolName: GameToolNameV1,
  input: Record<string, unknown>,
) =>
  coordinator.invoke({
    schemaVersion: 1,
    toolCallId: `call_${toolName}_${Math.random().toString(16).slice(2)}`,
    toolName,
    input: { schemaVersion: 1, taskId, ...input },
  } satisfies VNextGameToolPortRequestV1) as Promise<VNextGameToolResponseV1>;

const setup = (
  options: {
    readonly store?: MemoryRuntimeStore;
    readonly idPrefix?: string;
    readonly cleanupProven?: boolean;
    readonly preparedBuild?: PreparedCandidateGodotBuildV1;
    readonly connectFailure?: Error;
    readonly diagnostics?: readonly RuntimeSidecarDiagnosticV1[];
    readonly diagnosticFailure?:
      | {
          readonly code:
            "diagnostic_protocol_failure" | "diagnostic_limit_exceeded";
          readonly message: string;
        }
      | undefined;
    readonly autoCompleteOnTerminate?: boolean;
    readonly prepareBuild?: () => Promise<PreparedCandidateGodotBuildV1>;
    readonly failRestoreValidation?: boolean;
    readonly omitParticipantRestoreValidation?: boolean;
    readonly gracefulSidecarExitMs?: number;
  } = {},
) => {
  const store = options.store ?? new MemoryRuntimeStore();
  const sidecars = new FakeSidecarPort();
  sidecars.cleanupProven = options.cleanupProven ?? true;
  sidecars.diagnostics = options.diagnostics ?? [];
  sidecars.diagnosticFailure = options.diagnosticFailure ?? null;
  sidecars.autoCompleteOnTerminate = options.autoCompleteOnTerminate ?? true;
  const clients: FakeGodotClient[] = [];
  let id = 0;
  const idPrefix = options.idPrefix ?? "test";
  const coordinator = createVNextGodotRuntimeCoordinator(
    {
      taskId,
      workspaceId,
      workspaceDirectory: "/workspace-fixture",
      baselineSourceHash: hash("7"),
      fixtureCapability,
      managedRuntime,
      sidecarPort: sidecars,
      runtimeStore: store,
    },
    {
      now: () => now,
      nextId: (kind) => `${kind}:${idPrefix}-${id++}`,
      nextToken: () => "8".repeat(64),
      gracefulSidecarExitMs: options.gracefulSidecarExitMs ?? 0,
      prepareBuild:
        options.prepareBuild ??
        (() => Promise.resolve(options.preparedBuild ?? prepared)),
      connectRuntime: (
        _transport: unknown,
        request: VNextGodotConnectRequestV1,
      ) => {
        if (options.connectFailure !== undefined) {
          return Promise.reject(options.connectFailure);
        }
        const client = new FakeGodotClient(
          request.expectedFingerprint.fixedFps,
          request.expectedFingerprint.physicsTicksPerSecond,
        );
        client.failRestoreValidation = options.failRestoreValidation ?? false;
        client.omitParticipantRestoreValidation =
          options.omitParticipantRestoreValidation ?? false;
        clients.push(client);
        return Promise.resolve(client as unknown as VNextGodotRuntimeClient);
      },
    },
  );
  return { coordinator, store, sidecars, clients };
};

describe("task-scoped vNext Godot runtime coordinator", () => {
  it("reuses an immutable build timestamp while still observing changed workspace identity", async () => {
    const laterPrepared: PreparedCandidateGodotBuildV1 = {
      ...prepared,
      build: VNextBuildV1Schema.parse({
        ...prepared.build,
        createdAt: "2026-08-07T00:00:01.000Z",
      }),
    };
    let stableCalls = 0;
    const stable = setup({
      idPrefix: "stable-build",
      prepareBuild: () => {
        stableCalls += 1;
        return Promise.resolve(stableCalls === 1 ? prepared : laterPrepared);
      },
    });
    const capabilities = successOutput(
      await call(stable.coordinator, GAME_TOOL_NAMES_V1.capabilities, {}),
    );
    const launched = successOutput(
      await call(stable.coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    expect(stableCalls).toBe(2);
    expect((capabilities.build as { createdAt: string }).createdAt).toBe(now);
    expect((launched.build as { buildId: string }).buildId).toBe(build.buildId);
    await stable.coordinator.close();

    let changedCalls = 0;
    const changed = setup({
      idPrefix: "changed-build",
      prepareBuild: () => {
        changedCalls += 1;
        return Promise.resolve(changedCalls === 1 ? prepared : nextPrepared);
      },
    });
    await call(changed.coordinator, GAME_TOOL_NAMES_V1.capabilities, {});
    const changedLaunch = successOutput(
      await call(changed.coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: nextBuild.buildId,
      }),
    );
    expect(changedCalls).toBe(2);
    expect((changedLaunch.build as { buildId: string }).buildId).toBe(
      nextBuild.buildId,
    );
    await changed.coordinator.close();
  });

  it("executes all atomic resources without a global tool flow", async () => {
    const { coordinator, store, sidecars, clients } = setup();
    const capabilities = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.capabilities, {}),
    );
    expect(capabilities.build).toMatchObject({ buildId: build.buildId });

    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
        controls: {
          fixedFps: 120,
          physicsTicksPerSecond: 60,
          maxTicks: 20,
        },
      }),
    );
    const runtimeId = launched.runtimeId as string;
    const executionId = launched.executionId as string;

    await call(coordinator, GAME_TOOL_NAMES_V1.captureConfigure, {
      runtimeId,
      historySeconds: 10,
      maxTicks: 600,
      channels: ["input", "clocks", "state", "runtime_error"],
      stateSampleEveryTicks: 1,
      triggers: [],
    });
    const queuedInput = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.input, {
        runtimeId,
        action: "attempt_jump",
        requested: {
          clock: "process_frame",
          requestedTick: 0,
          requestedPhase: "process_frame_start",
        },
      }),
    );
    const controls = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.setControls, {
        runtimeId,
        controls: { maxTicks: 30 },
      }),
    );
    const stepped = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.step, {
        runtimeId,
        clock: "process_frame",
        count: 1,
      }),
    );
    expect(stepped.state).toMatchObject({
      values: { "player.jumping": true },
    });

    const pinned = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.capturePin, {
        runtimeId,
        beforeTicks: 1,
        afterTicks: 0,
      }),
    );
    expect(pinned.window).toMatchObject({ status: "available" });

    const checkpoint = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.checkpointCreate, {
        runtimeId,
        barrier: "process_frame_end",
      }),
    );
    const checkpointId = (checkpoint.manifest as { checkpointId: string })
      .checkpointId;
    expect(checkpoint.participantStates).toMatchObject({
      "case-02-state": { windowOpen: true },
    });
    clients[0]!.windowOpen = false;
    const restored = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.checkpointRestore, {
        runtimeId,
        checkpointId,
      }),
    );
    expect(restored.state).toMatchObject({
      values: { "player.window_open": true },
    });
    expect(clients[0]!.windowOpen).toBe(true);

    const trace = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.traceCreate, {
        events: [
          {
            action: "attempt_jump",
            requested: {
              clock: "physics_tick",
              requestedTick: 2,
              requestedPhase: "physics_tick_end",
            },
          },
        ],
      }),
    );
    const traceId = (trace.trace as { traceId: string }).traceId;
    const replayed = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.traceReplay, {
        runtimeId,
        traceId,
        maxTicks: 10,
      }),
    );
    expect(replayed.receipt).toMatchObject({ status: "completed" });
    const replayApplication = (
      replayed.receipt as {
        applications: Array<{
          realized: { phase: string; quantized: boolean };
        }>;
      }
    ).applications[0]!;
    expect(replayApplication.realized).toMatchObject({
      phase: "process_frame_start",
      quantized: true,
    });

    const query = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId,
        select: "state",
        filters: { statePaths: ["player.window_open"] },
        limit: 100,
      }),
    );
    expect(query.result).toMatchObject({ executionId });
    expect(
      (
        query.result as {
          rows: Array<{ statePath: string | null; value: unknown }>;
        }
      ).rows.some(
        (row) => row.statePath === "player.window_open" && row.value === true,
      ),
    ).toBe(true);
    const coverageQuery = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId,
        select: "coverage",
        limit: 100,
      }),
    );
    expect((coverageQuery.result as { rows: unknown[] }).rows).toEqual([]);
    const unknownEventQuery = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId,
        select: "events",
        filters: { eventTypes: ["unknown_event_type"] },
        limit: 100,
      }),
    );
    expect((unknownEventQuery.result as { rows: unknown[] }).rows).toEqual([]);

    const forked = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.fork, {
        source: { kind: "checkpoint", checkpointId },
        changes: {
          controls: { fixedFps: 120, physicsTicksPerSecond: 60 },
          traceId,
        },
      }),
    );
    const forkExecutionId = forked.executionId as string;
    const forkRuntimeId = forked.runtimeId as string;
    expect(forked.branch).toMatchObject({
      childExecutionId: forkExecutionId,
    });
    expect(clients[1]!.windowOpen).toBe(true);

    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.compare, {
        baselineExecutionId: executionId,
        candidateExecutionId: forkExecutionId,
        maxDifferences: 100,
      }),
    ).toMatchObject({
      outcome: "error",
      error: { code: "conflict", recoverable: true },
    });

    const status = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.status, { runtimeId }),
    );
    expect(status.runtime).toMatchObject({ status: "running" });
    await Promise.all([
      call(coordinator, GAME_TOOL_NAMES_V1.step, {
        runtimeId,
        clock: "process_frame",
        count: 1,
      }),
      call(coordinator, GAME_TOOL_NAMES_V1.step, {
        runtimeId,
        clock: "process_frame",
        count: 1,
      }),
    ]);
    expect(clients[0]!.maxActiveSteps).toBe(1);

    await call(coordinator, GAME_TOOL_NAMES_V1.stop, { runtimeId });
    await call(coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: forkRuntimeId,
    });
    const compared = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.compare, {
        baselineExecutionId: executionId,
        candidateExecutionId: forkExecutionId,
        maxDifferences: 100,
      }),
    );
    expect(compared.comparison).toMatchObject({
      left: { executionId },
      right: { executionId: forkExecutionId },
    });
    const invalidQuery = structuredClone(query);
    (invalidQuery.result as { rows: Array<{ kind: string }> }).rows[0]!.kind =
      "invented_kind";
    expect(validateGameToolOutputV1("game_query", invalidQuery)).toBe(false);
    const invalidQueryRequest = structuredClone(query);
    (
      invalidQueryRequest.result as {
        query: { eventKinds: string[] };
      }
    ).query.eventKinds.push("invented_event_kind");
    expect(validateGameToolOutputV1("game_query", invalidQueryRequest)).toBe(
      false,
    );
    const invalidPinned = structuredClone(pinned);
    (invalidPinned.events as Array<{ kind: string }>)[0]!.kind =
      "invented_raw_kind";
    expect(validateGameToolOutputV1("game_capture_pin", invalidPinned)).toBe(
      false,
    );
    const invalidInput = structuredClone(queuedInput);
    invalidInput.realized = {
      schemaVersion: 1,
      processFrame: 0,
      physicsTick: 0,
      simulationTimeUs: 0,
      hostMonotonicUs: 1,
      renderFrame: null,
      phase: "invented_phase",
      quantized: false,
      mismatchReason: null,
    };
    expect(validateGameToolOutputV1("game_input", invalidInput)).toBe(false);
    const invalidStep = structuredClone(stepped);
    (
      invalidStep.receipts as Array<{ realized: { phase: string } }>
    )[0]!.realized.phase = "invented_phase";
    expect(validateGameToolOutputV1("game_step", invalidStep)).toBe(false);
    const invalidControls = structuredClone(controls);
    (invalidControls.mismatches as unknown[]).push({
      schemaVersion: 1,
      control: "invented_control",
      requested: 1,
      realized: 1,
      reason: "invalid test control",
    });
    expect(validateGameToolOutputV1("game_set_controls", invalidControls)).toBe(
      false,
    );
    const invalidRestore = structuredClone(restored);
    (
      invalidRestore.receipt as { domains: Array<{ status: string }> }
    ).domains[0]!.status = "invented_status";
    expect(
      validateGameToolOutputV1("game_checkpoint_restore", invalidRestore),
    ).toBe(false);
    const invalidFork = structuredClone(forked);
    (
      invalidFork.branch as {
        requestedChanges: Array<{ dimension: string }>;
      }
    ).requestedChanges[0]!.dimension = "invented_dimension";
    expect(validateGameToolOutputV1("game_fork", invalidFork)).toBe(false);
    const invalidCompare = structuredClone(compared);
    (invalidCompare.comparison as { confounders: unknown[] }).confounders = [
      {
        schemaVersion: 1,
        category: "invented_category",
        description: "invalid test category",
        left: null,
        right: null,
      },
    ];
    expect(validateGameToolOutputV1("game_compare", invalidCompare)).toBe(
      false,
    );
    expect(store.seals.has(executionId)).toBe(true);
    expect(store.events.get(executionId)?.length).toBeGreaterThan(0);
    expect(sidecars.sessions[0]?.terminated).toBe(true);
    expect(
      [...store.resources.keys()].filter((key) => key.startsWith("tool-call:"))
        .length,
    ).toBeGreaterThanOrEqual(16);

    await coordinator.close();
    expect(sidecars.sessions.every((session) => session.terminated)).toBe(true);
  });

  it("returns recoverable ownership, history, control, and crash failures", async () => {
    const { coordinator, store, sidecars } = setup();
    const wrongTask = await coordinator.invoke({
      schemaVersion: 1,
      toolCallId: "call_wrong_task",
      toolName: "game_capabilities",
      input: { schemaVersion: 1, taskId: "task:other" },
    });
    expect(wrongTask).toMatchObject({
      outcome: "error",
      error: { code: "resource_task_mismatch", recoverable: true },
    });

    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    const runtimeId = launched.runtimeId as string;
    const executionId = launched.executionId as string;
    const unavailablePin = await call(
      coordinator,
      GAME_TOOL_NAMES_V1.capturePin,
      {
        runtimeId,
        beforeTicks: 2,
        afterTicks: 0,
      },
    );
    expect(unavailablePin).toMatchObject({
      outcome: "error",
      error: { code: "history_window_unavailable", recoverable: true },
    });
    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.setControls, {
        runtimeId,
        controls: { fixedFps: 60 },
      }),
    ).toMatchObject({
      outcome: "error",
      error: { code: "unsupported_capability", recoverable: true },
    });

    sidecars.sessions[0]!.resolve(executed("failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.step, {
        runtimeId,
        clock: "process_frame",
        count: 1,
      }),
    ).toMatchObject({
      outcome: "error",
      error: { code: "runtime_crashed", recoverable: true },
    });
    expect(store.seals.has(executionId)).toBe(true);
    const unavailableWindowId = (
      unavailablePin as {
        error: { details: { window: { captureWindowId: string } } };
      }
    ).error.details.window.captureWindowId;
    expect(
      (
        store.resources.get(`execution:${executionId}`) as {
          manifest: { launchParameters: { captureWindowIds: string[] } };
        }
      ).manifest.launchParameters.captureWindowIds,
    ).toContain(unavailableWindowId);
    await coordinator.close();
  });

  it("advances the requested clock and reports actual cross-clock deltas", async () => {
    const first = setup();
    const launched120 = successOutput(
      await call(first.coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
        controls: {
          fixedFps: 120,
          physicsTicksPerSecond: 60,
          maxTicks: 10,
        },
      }),
    );
    const slowPhysics = successOutput(
      await call(first.coordinator, GAME_TOOL_NAMES_V1.step, {
        runtimeId: launched120.runtimeId,
        clock: "physics_tick",
        count: 1,
      }),
    );
    expect(slowPhysics.realized).toEqual({
      processFrames: 2,
      physicsTicks: 1,
      requestedClockProgress: 1,
      overshoot: 0,
    });
    await first.coordinator.close();

    const second = setup();
    const launched60 = successOutput(
      await call(second.coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
        controls: {
          fixedFps: 60,
          physicsTicksPerSecond: 120,
          maxTicks: 10,
        },
      }),
    );
    const fastPhysics = successOutput(
      await call(second.coordinator, GAME_TOOL_NAMES_V1.step, {
        runtimeId: launched60.runtimeId,
        clock: "physics_tick",
        count: 1,
      }),
    );
    expect(fastPhysics.realized).toEqual({
      processFrames: 1,
      physicsTicks: 2,
      requestedClockProgress: 2,
      overshoot: 1,
    });
    await second.coordinator.close();
  });

  it("reopens checkpoint and sealed execution resources across coordinator turns", async () => {
    const store = new MemoryRuntimeStore();
    const first = setup({ store, idPrefix: "turn-one" });
    const baseline = successOutput(
      await call(first.coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    await call(first.coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: baseline.runtimeId,
      clock: "process_frame",
      count: 1,
    });
    const scheduledAtCheckpoint = successOutput(
      await call(first.coordinator, GAME_TOOL_NAMES_V1.input, {
        runtimeId: baseline.runtimeId,
        action: "attempt_jump",
        requested: {
          clock: "process_frame",
          requestedTick: 5,
          requestedPhase: "process_frame_start",
        },
      }),
    );
    const checkpoint = successOutput(
      await call(first.coordinator, GAME_TOOL_NAMES_V1.checkpointCreate, {
        runtimeId: baseline.runtimeId,
        barrier: "process_frame_end",
      }),
    );
    const checkpointId = (checkpoint.manifest as { checkpointId: string })
      .checkpointId;
    const domains = (
      checkpoint.manifest as {
        domains: Array<{
          domain: string;
          classification: string;
          stateHash?: string;
        }>;
      }
    ).domains;
    const capturedHashes = domains
      .filter((domain) => domain.classification === "captured")
      .map((domain) => domain.stateHash);
    expect(new Set(capturedHashes).size).toBeGreaterThan(1);
    await call(first.coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: baseline.runtimeId,
    });

    const candidate = successOutput(
      await call(first.coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    await call(first.coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: candidate.runtimeId,
      clock: "process_frame",
      count: 2,
    });
    await call(first.coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: candidate.runtimeId,
    });
    await first.coordinator.close();

    const reopened = setup({ store, idPrefix: "turn-two" });
    const target = successOutput(
      await call(reopened.coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    const scheduleMutation = successOutput(
      await call(reopened.coordinator, GAME_TOOL_NAMES_V1.input, {
        runtimeId: target.runtimeId,
        action: "attempt_jump",
        requested: {
          clock: "process_frame",
          requestedTick: 6,
          requestedPhase: "process_frame_start",
        },
      }),
    );
    const restored = successOutput(
      await call(reopened.coordinator, GAME_TOOL_NAMES_V1.checkpointRestore, {
        runtimeId: target.runtimeId,
        checkpointId,
      }),
    );
    expect(restored).toMatchObject({
      state: { values: { "player.window_open": true } },
    });
    expect(
      (
        restored.receipt as {
          validations: Array<{ name: string; status: string }>;
        }
      ).validations.some(
        (validation) =>
          validation.name === "runtime.semantic_state" &&
          validation.status === "pass",
      ),
    ).toBe(true);
    const scheduleReceipt = (
      restored.receipt as {
        domains: Array<{
          domain: string;
          status: string;
          beforeHash: string | null;
          afterHash: string | null;
        }>;
      }
    ).domains.find((domain) => domain.domain === "input_schedule")!;
    expect(scheduleReceipt).toMatchObject({ status: "restored" });
    expect(scheduleReceipt.afterHash).toBe(
      domains.find((domain) => domain.domain === "input_schedule")?.stateHash,
    );
    expect(scheduleReceipt.beforeHash).not.toBe(scheduleReceipt.afterHash);
    const postRestoreStep = successOutput(
      await call(reopened.coordinator, GAME_TOOL_NAMES_V1.step, {
        runtimeId: target.runtimeId,
        clock: "process_frame",
        count: 1,
      }),
    );
    const restoredRequestIds = (
      postRestoreStep.pendingInputs as Array<{ requestId: string }>
    ).map((pending) => pending.requestId);
    expect(restoredRequestIds).toContain(scheduledAtCheckpoint.requestId);
    expect(restoredRequestIds).not.toContain(scheduleMutation.requestId);

    const historical = successOutput(
      await call(reopened.coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId: baseline.executionId,
        select: "state",
        filters: { statePaths: ["player.window_open"] },
        limit: 20,
      }),
    );
    expect(historical.result).toMatchObject({
      executionId: baseline.executionId,
    });
    const compared = successOutput(
      await call(reopened.coordinator, GAME_TOOL_NAMES_V1.compare, {
        baselineExecutionId: baseline.executionId,
        candidateExecutionId: candidate.executionId,
        maxDifferences: 20,
      }),
    );
    const comparedLeft = (
      compared.comparison as {
        left: {
          executionId: string;
          executionRecordHash: string;
          rawRecordHash: string;
        };
      }
    ).left;
    expect(comparedLeft.executionId).toBe(baseline.executionId);
    expect(comparedLeft.executionRecordHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(comparedLeft.rawRecordHash).toMatch(/^[a-f0-9]{64}$/u);

    const forked = successOutput(
      await call(reopened.coordinator, GAME_TOOL_NAMES_V1.fork, {
        source: { kind: "execution", executionId: baseline.executionId },
        changes: { controls: { maxTicks: 20 } },
      }),
    );
    expect(forked).toMatchObject({
      state: { values: { "player.window_open": true } },
      restore: { receipt: { checkpointId } },
    });
    const indexId = (historical.result as { indexId: string }).indexId;
    store.resources.set(`index:${indexId}`, {
      schemaVersion: 1,
      taskId,
      indexId,
      corrupt: true,
    });
    expect(
      await call(reopened.coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId: baseline.executionId,
        indexId,
        select: "events",
        limit: 20,
      }),
    ).toMatchObject({
      outcome: "error",
      error: { code: "operation_failed", recoverable: false },
    });
    await call(reopened.coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: target.runtimeId,
    });
    await call(reopened.coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: forked.runtimeId,
    });
    await reopened.coordinator.close();
  });

  it("rejects stored checkpoint lineage/hash corruption before runtime restore", async () => {
    const { coordinator, store, clients } = setup({
      idPrefix: "checkpoint-lineage-corrupt",
    });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    const checkpoint = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.checkpointCreate, {
        runtimeId: launched.runtimeId,
        barrier: "process_frame_end",
      }),
    );
    const checkpointId = (checkpoint.manifest as { checkpointId: string })
      .checkpointId;
    const key = `checkpoint:${checkpointId}`;
    const original = structuredClone(store.resources.get(key)) as {
      snapshot: { state: { values: Record<string, unknown> } };
      certificate: { restoreRecipeHash: string };
      manifest: {
        domains: Array<{
          domain: string;
          classification: string;
          stateHash?: string;
        }>;
      };
    };
    const mutations: Array<(value: typeof original) => void> = [
      (value) => {
        value.snapshot.state.values["player.window_open"] = false;
      },
      (value) => {
        value.certificate.restoreRecipeHash = hash("9");
      },
      (value) => {
        const participant = value.manifest.domains.find(
          (domain) => domain.domain === "participant.case-02-state",
        );
        if (participant === undefined) throw new Error("participant missing");
        participant.stateHash = hash("8");
      },
    ];

    for (const mutate of mutations) {
      const corrupted = structuredClone(original);
      mutate(corrupted);
      store.resources.set(key, corrupted);
      expect(
        await call(coordinator, GAME_TOOL_NAMES_V1.checkpointRestore, {
          runtimeId: launched.runtimeId,
          checkpointId,
        }),
      ).toMatchObject({
        outcome: "error",
        error: { code: "operation_failed", recoverable: false },
      });
      expect(clients[0]?.restoreCalls).toBe(0);
    }
    store.resources.set(key, original);
    await coordinator.close();
  });

  it("does not report a captured participant restored without post-restore observation", async () => {
    const { coordinator } = setup({
      idPrefix: "checkpoint-observation-gap",
      omitParticipantRestoreValidation: true,
    });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    const checkpoint = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.checkpointCreate, {
        runtimeId: launched.runtimeId,
        barrier: "process_frame_end",
      }),
    );
    const checkpointId = (checkpoint.manifest as { checkpointId: string })
      .checkpointId;

    const restored = await call(
      coordinator,
      GAME_TOOL_NAMES_V1.checkpointRestore,
      { runtimeId: launched.runtimeId, checkpointId },
    );
    expect(restored).toMatchObject({
      outcome: "error",
      error: {
        code: "restore_gap",
        recoverable: true,
      },
    });
    const participant =
      restored.outcome === "error"
        ? (
            restored.error.details as {
              receipt: { domains: Array<{ domain: string; status: string }> };
            }
          ).receipt.domains.find(
            (domain) => domain.domain === "participant.case-02-state",
          )
        : undefined;
    expect(participant?.status).not.toBe("restored");
    await coordinator.close();
  });

  it("persists rejected or partial branch lineage before cleaning a failed fork", async () => {
    const { coordinator, store } = setup({ idPrefix: "failed-fork" });
    const source = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    const checkpoint = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.checkpointCreate, {
        runtimeId: source.runtimeId,
        barrier: "process_frame_end",
      }),
    );
    const checkpointId = (checkpoint.manifest as { checkpointId: string })
      .checkpointId;
    const trace = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.traceCreate, {
        source: { kind: "runtime", runtimeId: source.runtimeId },
        events: [
          {
            action: "attempt_jump",
            requested: {
              clock: "process_frame",
              requestedTick: 10,
              requestedPhase: "process_frame_start",
            },
          },
        ],
      }),
    );
    const traceId = (trace.trace as { traceId: string }).traceId;
    const failedFork = await call(coordinator, GAME_TOOL_NAMES_V1.fork, {
      source: { kind: "checkpoint", checkpointId },
      changes: { traceId, controls: { maxTicks: 1 } },
    });
    expect(failedFork).toMatchObject({
      outcome: "error",
      error: {
        code: "budget_exhausted",
        recoverable: true,
        details: {
          receipt: {
            status: "failed",
            applications: [],
            firstDivergence: { status: "unavailable" },
          },
        },
      },
    });
    if (failedFork.outcome !== "error") {
      throw new Error("expected failed fork response");
    }
    const failedForkDetails = objectValue(failedFork.error.details);
    expect(typeof failedForkDetails["branchId"]).toBe("string");
    expect(typeof failedForkDetails["childRuntimeId"]).toBe("string");
    expect(typeof failedForkDetails["childExecutionId"]).toBe("string");

    const branches = [...store.resources.entries()].filter(([key]) =>
      key.startsWith("branch:"),
    );
    expect(branches).toHaveLength(1);
    const failedBranch = branches[0]![1] as {
      childExecutionId: string;
      realizedChanges: Array<{ dimension: string; status: string }>;
    };
    expect(failedBranch.realizedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: "input",
          status: "rejected",
          realized: null,
        }),
      ]),
    );
    expect(
      store.resources.has(`execution:${failedBranch.childExecutionId}`),
    ).toBe(true);
    expect(store.seals.has(failedBranch.childExecutionId)).toBe(true);
    expect(
      (store.events.get(failedBranch.childExecutionId) ?? []).some(
        (event) =>
          (event as { payload?: { traceReplayReceipt?: { status?: string } } })
            .payload?.traceReplayReceipt?.status === "failed",
      ),
    ).toBe(true);

    await call(coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: source.runtimeId,
    });
    await coordinator.close();
  });

  it("forks a sealed execution onto a changed build with a fresh descriptive trace replay", async () => {
    const store = new MemoryRuntimeStore();
    const original = setup({ store, idPrefix: "cross-build-source" });
    const source = successOutput(
      await call(original.coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    await call(original.coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: source.runtimeId,
      clock: "process_frame",
      count: 1,
    });
    await original.coordinator.close();

    const changed = setup({
      store,
      idPrefix: "cross-build-target",
      preparedBuild: nextPrepared,
    });
    expect(
      await call(changed.coordinator, GAME_TOOL_NAMES_V1.fork, {
        source: { kind: "execution", executionId: source.executionId },
        changes: { buildId: nextBuild.buildId },
      }),
    ).toMatchObject({
      outcome: "error",
      error: { code: "invalid_request", recoverable: true },
    });
    const trace = successOutput(
      await call(changed.coordinator, GAME_TOOL_NAMES_V1.traceCreate, {
        source: { kind: "execution", executionId: source.executionId },
        events: [
          {
            action: "attempt_jump",
            requested: {
              clock: "process_frame",
              requestedTick: 0,
              requestedPhase: "process_frame_start",
            },
          },
        ],
      }),
    );
    const traceId = (trace.trace as { traceId: string }).traceId;
    const forked = successOutput(
      await call(changed.coordinator, GAME_TOOL_NAMES_V1.fork, {
        source: { kind: "execution", executionId: source.executionId },
        changes: { buildId: nextBuild.buildId, traceId },
      }),
    );
    expect(forked).toMatchObject({
      restore: null,
      branch: {
        parent: {
          kind: "execution",
          executionId: source.executionId,
          buildId: build.buildId,
        },
        childBuildId: nextBuild.buildId,
      },
      replay: { receipt: { mode: "descriptive_only", status: "completed" } },
    });
    await call(changed.coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: forked.runtimeId,
    });
    const childRecord = store.resources.get(
      `execution:${String(forked.executionId)}`,
    ) as {
      manifest: {
        startCheckpointId: string | null;
        launchParameters: {
          freshStart: {
            sourceExecutionId: string;
            skippedCheckpointId: string | null;
            reason: string;
          };
        };
      };
    };
    expect(childRecord.manifest.startCheckpointId).toBeNull();
    expect(childRecord.manifest.launchParameters.freshStart).toMatchObject({
      sourceExecutionId: source.executionId,
      skippedCheckpointId: null,
    });
    await changed.coordinator.close();
  });

  it("starts fresh for an explicit cross-build checkpoint fork and requires a trace", async () => {
    const store = new MemoryRuntimeStore();
    const original = setup({ store, idPrefix: "checkpoint-build-source" });
    const source = successOutput(
      await call(original.coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    const checkpoint = successOutput(
      await call(original.coordinator, GAME_TOOL_NAMES_V1.checkpointCreate, {
        runtimeId: source.runtimeId,
        barrier: "process_frame_end",
      }),
    );
    const checkpointId = (checkpoint.manifest as { checkpointId: string })
      .checkpointId;
    const trace = successOutput(
      await call(original.coordinator, GAME_TOOL_NAMES_V1.traceCreate, {
        source: { kind: "runtime", runtimeId: source.runtimeId },
        events: [
          {
            action: "attempt_jump",
            requested: {
              clock: "process_frame",
              requestedTick: 0,
              requestedPhase: "process_frame_start",
            },
          },
        ],
      }),
    );
    const traceId = (trace.trace as { traceId: string }).traceId;
    await original.coordinator.close();

    const changed = setup({
      store,
      idPrefix: "checkpoint-build-target",
      preparedBuild: nextPrepared,
    });
    expect(
      await call(changed.coordinator, GAME_TOOL_NAMES_V1.fork, {
        source: { kind: "checkpoint", checkpointId },
        changes: { buildId: nextBuild.buildId },
      }),
    ).toMatchObject({
      outcome: "error",
      error: { code: "invalid_request", recoverable: true },
    });
    const forked = successOutput(
      await call(changed.coordinator, GAME_TOOL_NAMES_V1.fork, {
        source: { kind: "checkpoint", checkpointId },
        changes: { buildId: nextBuild.buildId, traceId },
      }),
    );
    expect(forked).toMatchObject({
      restore: null,
      branch: {
        parent: {
          kind: "checkpoint",
          checkpointId,
          buildId: build.buildId,
        },
        childBuildId: nextBuild.buildId,
      },
      replay: { receipt: { mode: "descriptive_only", status: "completed" } },
    });
    await call(changed.coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: forked.runtimeId,
    });
    const childRecord = store.resources.get(
      `execution:${String(forked.executionId)}`,
    ) as {
      manifest: {
        startCheckpointId: string | null;
        launchParameters: {
          freshStart: {
            sourceExecutionId: string;
            skippedCheckpointId: string | null;
          };
        };
      };
    };
    expect(childRecord.manifest.startCheckpointId).toBeNull();
    expect(childRecord.manifest.launchParameters.freshStart).toMatchObject({
      sourceExecutionId: source.executionId,
      skippedCheckpointId: checkpointId,
    });
    await changed.coordinator.close();
  });

  it("keeps a same-build checkpoint fork usable with explicit descriptive restore gaps", async () => {
    const { coordinator } = setup({
      idPrefix: "partial-restore-fork",
      failRestoreValidation: true,
    });
    const source = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    const checkpoint = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.checkpointCreate, {
        runtimeId: source.runtimeId,
        barrier: "process_frame_end",
      }),
    );
    const checkpointId = (checkpoint.manifest as { checkpointId: string })
      .checkpointId;
    const forked = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.fork, {
        source: { kind: "checkpoint", checkpointId },
        changes: { controls: { maxTicks: 20 } },
      }),
    );
    expect(forked).toMatchObject({
      branch: {
        parent: { kind: "checkpoint", checkpointId },
      },
      restore: {
        receipt: {
          status: "partially_restored",
          equivalentForkEligible: false,
          fidelity: "descriptive_only",
        },
      },
    });
    await call(coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: source.runtimeId,
    });
    await call(coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: forked.runtimeId,
    });
    await coordinator.close();
  });

  it("rejects restore when checkpoint and runtime probe identities differ", async () => {
    const { coordinator, store } = setup({ idPrefix: "probe-mismatch" });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    const checkpoint = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.checkpointCreate, {
        runtimeId: launched.runtimeId,
        barrier: "process_frame_end",
      }),
    );
    const checkpointId = (checkpoint.manifest as { checkpointId: string })
      .checkpointId;
    const stored = structuredClone(
      store.resources.get(`checkpoint:${checkpointId}`),
    ) as { manifest: { probeIds: string[] } };
    stored.manifest.probeIds = ["probe:foreign"];
    store.resources.set(`checkpoint:${checkpointId}`, stored);

    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.checkpointRestore, {
        runtimeId: launched.runtimeId,
        checkpointId,
      }),
    ).toMatchObject({
      outcome: "error",
      error: {
        code: "checkpoint_incompatible",
        recoverable: true,
        details: {
          checkpointProbeIds: ["probe:foreign"],
        },
      },
    });
    await coordinator.close();
  });

  it("seals the child when successful branch lineage persistence fails", async () => {
    const store = new MemoryRuntimeStore();
    store.failBranchResourceWrites = 1;
    const { coordinator, sidecars } = setup({
      store,
      idPrefix: "branch-write-failure",
    });
    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.fork, {
        source: { kind: "workspace", workspaceId },
        changes: { controls: { maxTicks: 10 } },
      }),
    ).toMatchObject({
      outcome: "error",
      error: { code: "operation_failed", recoverable: false },
    });
    expect(
      [...store.resources.keys()].filter((key) => key.startsWith("branch:")),
    ).toHaveLength(0);
    const childExecutionIds = [...store.resources.keys()]
      .filter((key) => key.startsWith("execution:"))
      .map((key) => key.slice("execution:".length));
    expect(childExecutionIds).toHaveLength(1);
    expect(store.seals.has(childExecutionIds[0]!)).toBe(true);
    expect(sidecars.sessions).toHaveLength(1);
    expect(sidecars.sessions[0]?.terminated).toBe(true);
    await coordinator.close();
  });

  it("rejects reopened historical reads with a missing or mismatched physical seal", async () => {
    const store = new MemoryRuntimeStore();
    const first = setup({ store, idPrefix: "seal-source" });
    const launched = successOutput(
      await call(first.coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    await call(first.coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: launched.runtimeId,
      clock: "process_frame",
      count: 1,
    });
    await call(first.coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: launched.runtimeId,
    });
    await first.coordinator.close();
    const executionId = launched.executionId as string;
    const originalSeal = store.seals.get(executionId)!;
    store.seals.delete(executionId);

    const reopened = setup({ store, idPrefix: "seal-reader" });
    expect(
      await call(reopened.coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId,
        select: "events",
        limit: 20,
      }),
    ).toMatchObject({ outcome: "error", error: { code: "operation_failed" } });
    store.seals.set(executionId, {
      ...originalSeal,
      count: originalSeal.count + 1,
    });
    expect(
      await call(reopened.coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId,
        select: "events",
        limit: 20,
      }),
    ).toMatchObject({ outcome: "error", error: { code: "operation_failed" } });
    await reopened.coordinator.close();
  });

  it("observes a graceful sidecar exit before requesting sandbox cancellation", async () => {
    const { coordinator, sidecars } = setup({
      idPrefix: "graceful-sidecar-exit",
      gracefulSidecarExitMs: 50,
    });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    sidecars.sessions[0]!.resolve(executed("succeeded"));

    const stopped = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.stop, {
        runtimeId: launched.runtimeId,
      }),
    );
    expect(stopped).toMatchObject({
      runtime: { status: "stopped" },
      sealed: true,
    });
    expect(sidecars.sessions[0]!.terminated).toBe(false);
    await coordinator.close();
  });

  it("keeps an execution unsealed when sidecar cleanup is not proven", async () => {
    const { coordinator, store } = setup({
      idPrefix: "cleanup-gap",
      cleanupProven: false,
    });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.stop, {
        runtimeId: launched.runtimeId,
      }),
    ).toMatchObject({
      outcome: "error",
      error: { code: "operation_failed", recoverable: false },
    });
    expect(store.seals.has(launched.executionId as string)).toBe(false);
    await expect(coordinator.close()).rejects.toBeInstanceOf(AggregateError);
  });

  it.each(["step_error", "invalid_receipt", "invalid_step_receipt"] as const)(
    "does not seal %s before sidecar cleanup is proven",
    async (failureMode) => {
      const { coordinator, store, sidecars, clients } = setup({
        idPrefix: failureMode,
      });
      const launched = successOutput(
        await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
          buildId: build.buildId,
        }),
      );
      if (failureMode === "invalid_receipt") {
        await call(coordinator, GAME_TOOL_NAMES_V1.step, {
          runtimeId: launched.runtimeId,
          clock: "process_frame",
          count: 1,
        });
        clients[0]!.regressReceipt = true;
      } else if (failureMode === "invalid_step_receipt") {
        clients[0]!.inconsistentStepReceipt = true;
      } else {
        clients[0]!.failStep = true;
      }
      expect(
        await call(coordinator, GAME_TOOL_NAMES_V1.step, {
          runtimeId: launched.runtimeId,
          clock: "process_frame",
          count: 1,
        }),
      ).toMatchObject({
        outcome: "error",
        error: { code: "runtime_unavailable", recoverable: true },
      });
      expect(store.seals.has(String(launched.executionId))).toBe(false);
      expect(sidecars.sessions[0]?.terminated).toBe(false);

      await expect(coordinator.close()).resolves.toBeUndefined();
      expect(store.seals.has(String(launched.executionId))).toBe(true);
      expect(sidecars.sessions[0]?.terminated).toBe(true);
    },
  );

  it("realizes only receipt-confirmed input orders and persists observation loss", async () => {
    const { coordinator, store, clients } = setup({
      idPrefix: "input-receipt-truth",
    });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    const queued = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.input, {
        runtimeId: launched.runtimeId,
        action: "attempt_jump",
        requested: {
          clock: "process_frame",
          requestedTick: 0,
          requestedPhase: "process_frame_start",
        },
      }),
    );
    clients[0]!.omitAppliedInputs = true;
    clients[0]!.observationDropped = 2;
    clients[0]!.observationTruncated = 1;
    clients[0]!.observationBackpressure = true;
    const stepped = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.step, {
        runtimeId: launched.runtimeId,
        clock: "process_frame",
        count: 1,
      }),
    );
    expect(stepped.receipts).toEqual([]);
    expect(stepped.pendingInputs).toEqual([
      expect.objectContaining({ requestId: queued.requestId }),
    ]);
    const loss = stepped.loss as Array<{
      kind: string;
      count: number;
      reason: string;
    }>;
    expect(
      loss.some((entry) => entry.kind === "dropped" && entry.count === 2),
    ).toBe(true);
    expect(
      loss.find((entry) => entry.kind === "dropped" && entry.count === 2),
    ).toMatchObject({
      firstClock: { processFrame: 0 },
      lastClock: { processFrame: 1 },
    });
    expect(
      loss.some((entry) => entry.kind === "degraded" && entry.count === 1),
    ).toBe(true);
    expect(loss.some((entry) => /backpressure/iu.test(entry.reason))).toBe(
      true,
    );
    expect(
      (stepped.coverage as Array<{ channel: string; status: string }>).every(
        (coverage) =>
          !["probe", "log", "error", "entity_lifecycle"].includes(
            coverage.channel,
          ) || coverage.status !== "full",
      ),
    ).toBe(true);
    expect(
      (store.events.get(String(launched.executionId)) ?? []).some(
        (event) => (event as { kind?: string }).kind === "capture_loss",
      ),
    ).toBe(true);

    clients[0]!.omitAppliedInputs = false;
    clients[0]!.observationDropped = 0;
    clients[0]!.observationTruncated = 0;
    clients[0]!.observationBackpressure = false;
    const applied = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.step, {
        runtimeId: launched.runtimeId,
        clock: "process_frame",
        count: 1,
      }),
    );
    expect(applied.receipts).toEqual([
      expect.objectContaining({ requestId: queued.requestId }),
    ]);
    await coordinator.close();
  });

  it("rejects a 601st pending input without mutating the bounded queue", async () => {
    const { coordinator } = setup({ idPrefix: "pending-input-bound" });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    for (let index = 0; index < 600; index += 1) {
      successOutput(
        await call(coordinator, GAME_TOOL_NAMES_V1.input, {
          runtimeId: launched.runtimeId,
          action: "attempt_jump",
          requested: {
            clock: "process_frame",
            requestedTick: 600,
            requestedPhase: "process_frame_start",
          },
        }),
      );
    }

    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.input, {
        runtimeId: launched.runtimeId,
        action: "attempt_jump",
        requested: {
          clock: "process_frame",
          requestedTick: 600,
          requestedPhase: "process_frame_start",
        },
      }),
    ).toMatchObject({
      outcome: "error",
      error: {
        code: "budget_exhausted",
        recoverable: true,
        details: { pendingInputs: 600, maximumPendingInputs: 600 },
      },
    });
    const stepped = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.step, {
        runtimeId: launched.runtimeId,
        clock: "process_frame",
        count: 1,
      }),
    );
    expect(stepped.pendingInputs).toHaveLength(600);
    await coordinator.close();
  });

  it("rejects an observation receipt whose emitted count disagrees with the event batch", async () => {
    const { coordinator, store, clients, sidecars } = setup({
      idPrefix: "observation-count-mismatch",
    });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    clients[0]!.observationEmittedOverride = 99;

    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.step, {
        runtimeId: launched.runtimeId,
        clock: "process_frame",
        count: 1,
      }),
    ).toMatchObject({
      outcome: "error",
      error: { code: "runtime_unavailable", recoverable: true },
    });
    expect(store.seals.has(String(launched.executionId))).toBe(false);
    expect(sidecars.sessions[0]?.terminated).toBe(false);

    await expect(coordinator.close()).resolves.toBeUndefined();
    expect(store.seals.has(String(launched.executionId))).toBe(true);
    expect(sidecars.sessions[0]?.terminated).toBe(true);
  });

  it("fails the runtime before retaining an oversized capture record", async () => {
    const { coordinator, clients, store } = setup({
      idPrefix: "capture-record-bound",
    });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    clients[0]!.eventsForStep = () => [
      {
        localId: "oversized-property",
        kind: "property_changed",
        path: "player.untrusted_text",
        before: null,
        after: "x".repeat(1024 * 1024 + 1),
      },
    ];

    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.step, {
        runtimeId: launched.runtimeId,
        clock: "process_frame",
        count: 1,
      }),
    ).toMatchObject({
      outcome: "error",
      error: {
        code: "budget_exhausted",
        recoverable: true,
        details: { captureCode: "capture_capacity_exhausted" },
      },
    });
    expect(store.seals.has(String(launched.executionId))).toBe(false);
    const stopped = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.stop, {
        runtimeId: launched.runtimeId,
      }),
    );
    expect(stopped).toMatchObject({
      runtime: { status: "failed" },
      sealed: true,
    });
    await coordinator.close();
  });

  it("normalizes managed semantic telemetry and preserves observed relations", async () => {
    const { coordinator, store, clients } = setup({
      idPrefix: "semantic-telemetry",
    });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    const queued = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.input, {
        runtimeId: launched.runtimeId,
        action: "attempt_jump",
        requested: {
          clock: "process_frame",
          requestedTick: 0,
          requestedPhase: "process_frame_start",
        },
      }),
    );
    clients[0]!.eventsForStep = (request) => [
      {
        kind: "property_changed",
        localId: "property:window",
        causedByLocalId: request.inputs[0]!.localId,
        path: "player.window_open",
        before: false,
        after: true,
      },
      {
        kind: "signal",
        localId: "signal:left-ledger",
        causedByLocalId: "property:window",
        source: "player",
        name: "player.left_ledge",
        arguments: [],
      },
      {
        kind: "signal_delivery",
        localId: "delivery:left-ledger",
        causedByLocalId: "signal:left-ledger",
        source: "player",
        name: "player.left_ledge",
        receiver: "player",
        delivered: true,
      },
      {
        kind: "log",
        localId: "lifecycle:enemy",
        causedByLocalId: "property:window",
        level: "info",
        source: "ChronoProbe",
        message: "entity lifecycle",
        fields: {
          chronoriftEvent: "entity_lifecycle",
          action: "spawned",
          stableId: "enemy",
          incarnation: 2,
        },
      },
      {
        kind: "log",
        localId: "pending:damage",
        causedByLocalId: "lifecycle:enemy",
        level: "info",
        source: "ChronoProbe",
        message: "pending effect",
        fields: {
          chronoriftEvent: "pending_effect",
          action: "scheduled",
          effectId: "damage:1",
          targetStableId: "enemy",
          targetIncarnation: 2,
          dueTick: 1,
        },
      },
      {
        kind: "log",
        localId: "spatial:enemy",
        causedByLocalId: "pending:damage",
        level: "debug",
        source: "ChronoProbe",
        message: "spatial sample",
        fields: {
          chronoriftEvent: "spatial_sample",
          stableId: "enemy",
          incarnation: 2,
          x: 12.5,
          y: -3,
        },
      },
      {
        kind: "log",
        localId: "lifecycle:malformed",
        level: "info",
        source: "ChronoProbe",
        message: "entity lifecycle",
        fields: {
          chronoriftEvent: "entity_lifecycle",
          action: "spawned",
          stableId: "enemy",
          incarnation: 0,
        },
      },
    ];

    await call(coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: launched.runtimeId,
      clock: "process_frame",
      count: 1,
    });
    const raw = (store.events.get(String(launched.executionId)) ??
      []) as Array<{
      eventId: string;
      kind: string;
      channel: string;
      payload: Record<string, unknown>;
      observedRelations: Array<{ kind: string; targetEventId: string }>;
    }>;
    const inputRealized = raw.find(
      (event) => event.payload.eventType === "input_realized",
    );
    const property = raw.find(
      (event) => event.payload.localId === "property:window",
    );
    const signal = raw.find(
      (event) => event.payload.localId === "signal:left-ledger",
    );
    const delivery = raw.find(
      (event) => event.payload.localId === "delivery:left-ledger",
    );
    const lifecycle = raw.find(
      (event) => event.payload.localId === "lifecycle:enemy",
    );
    const pending = raw.find(
      (event) => event.payload.localId === "pending:damage",
    );
    const spatial = raw.find(
      (event) => event.payload.localId === "spatial:enemy",
    );
    expect(inputRealized).toBeDefined();
    expect(property).toMatchObject({
      kind: "state",
      channel: "probe",
      payload: {
        eventType: "property_changed",
        statePath: "player.window_open",
        entity: { stableId: "player", incarnation: 1 },
      },
      observedRelations: [
        { kind: "scheduled_by", targetEventId: inputRealized?.eventId },
      ],
    });
    expect(signal?.observedRelations).toEqual([
      {
        schemaVersion: 1,
        kind: "scheduled_by",
        targetEventId: property?.eventId,
      },
    ]);
    expect(delivery).toMatchObject({
      kind: "signal",
      payload: { eventType: "signal_delivery", delivered: true },
      observedRelations: [{ kind: "delivery", targetEventId: signal?.eventId }],
    });
    expect(lifecycle).toMatchObject({
      kind: "entity_lifecycle",
      channel: "entity_lifecycle",
      payload: {
        lifecycle: "spawned",
        entity: {
          stableId: "enemy",
          incarnation: 2,
          sceneId: fixtureCapability.startupScene,
          parentStableId: null,
          ownerStableId: null,
        },
      },
    });
    expect(pending).toMatchObject({
      kind: "probe",
      payload: {
        eventType: "pending_effect",
        entity: { stableId: "enemy", incarnation: 2 },
        effectId: "damage:1",
      },
    });
    expect(spatial).toMatchObject({
      kind: "probe",
      payload: {
        eventType: "spatial_sample",
        entity: { stableId: "enemy", incarnation: 2 },
        position: [12.5, -3],
      },
    });
    expect(raw.filter((event) => event.kind === "relation")).toHaveLength(6);
    expect(
      raw.some(
        (event) =>
          event.kind === "error" &&
          event.payload.code === "malformed_managed_telemetry",
      ),
    ).toBe(true);
    expect(
      raw.some(
        (event) =>
          event.kind === "capture_loss" && event.channel === "entity_lifecycle",
      ),
    ).toBe(true);
    expect(
      raw.some(
        (event) =>
          event.payload.localId === "lifecycle:malformed" &&
          event.kind === "entity_lifecycle",
      ),
    ).toBe(false);

    const queried = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId: launched.executionId,
        select: "entities",
        filters: { eventTypes: ["lifecycle"] },
        limit: 20,
      }),
    );
    expect(queried.result).toMatchObject({
      rows: [
        {
          kind: "lifecycle",
          entity: { stableId: "enemy", incarnation: 2 },
          value: "spawned",
        },
      ],
      incomplete: true,
    });
    expect(queued.requestId).toBeTypeOf("string");
    await coordinator.close();
  });

  it("rejects inconsistent applied-input receipts without blaming candidate source", async () => {
    const { coordinator, store, clients } = setup({
      idPrefix: "invalid-input-application",
    });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    await call(coordinator, GAME_TOOL_NAMES_V1.input, {
      runtimeId: launched.runtimeId,
      action: "attempt_jump",
      requested: {
        clock: "process_frame",
        requestedTick: 0,
        requestedPhase: "process_frame_start",
      },
    });
    clients[0]!.inconsistentInputApplications = true;
    const invalidReceipt = await call(coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: launched.runtimeId,
      clock: "process_frame",
      count: 1,
    });
    expect(invalidReceipt).toMatchObject({
      outcome: "error",
      error: { code: "runtime_unavailable" },
    });
    expect(invalidReceipt).not.toHaveProperty("error.details.attribution");
    expect(store.seals.has(String(launched.executionId))).toBe(false);
    await coordinator.close();
  });

  it("clears a transient background monitor failure after retry cleanup seals the runtime", async () => {
    const { coordinator, store, sidecars } = setup({
      idPrefix: "background-retry",
    });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    store.failAppendWrites = 1;
    sidecars.sessions[0]!.resolve(executed("failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(coordinator.close()).resolves.toBeUndefined();
    expect(store.seals.has(String(launched.executionId))).toBe(true);
  });

  it("awaits and bounds failed launch admissions without attributing transport failures", async () => {
    const delayed = setup({
      idPrefix: "connect-cleanup",
      connectFailure: new Error("injected Host transport failure"),
      autoCompleteOnTerminate: false,
    });
    let settled = false;
    const responsePromise = call(
      delayed.coordinator,
      GAME_TOOL_NAMES_V1.launch,
      { buildId: build.buildId },
    ).then((response) => {
      settled = true;
      return response;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(delayed.sidecars.sessions[0]?.terminated).toBe(true);
    expect(settled).toBe(false);
    delayed.sidecars.sessions[0]!.resolve(executed("failed"));
    const response = await responsePromise;
    expect(response).toMatchObject({
      outcome: "error",
      error: { code: "operation_failed", recoverable: false },
    });
    expect(response).not.toHaveProperty("error.details.attribution");
    await delayed.coordinator.close();

    const bounded = setup({
      idPrefix: "failed-admission-budget",
      connectFailure: new Error("injected Host transport failure"),
    });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(
        await call(bounded.coordinator, GAME_TOOL_NAMES_V1.launch, {
          buildId: build.buildId,
        }),
      ).toMatchObject({
        outcome: "error",
        error: { code: "operation_failed" },
      });
    }
    expect(
      await call(bounded.coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    ).toMatchObject({
      outcome: "error",
      error: { code: "budget_exhausted", recoverable: true },
    });
    expect(bounded.sidecars.sessions).toHaveLength(8);
    await bounded.coordinator.close();
  });

  it("attributes a staged candidate early exit but not an unproven cleanup", async () => {
    const diagnostics: readonly RuntimeSidecarDiagnosticV1[] = [
      {
        schemaVersion: 1,
        kind: "stage_ready",
        fixtureHash: prepared.fixtureHash,
        projectHash: prepared.projectHash,
        addonHash: prepared.addonHash,
      },
      { schemaVersion: 1, kind: "godot_started", pid: 42 },
      {
        schemaVersion: 1,
        kind: "godot_stderr",
        bytesBase64: Buffer.from(
          "SCRIPT ERROR: Parse Error: candidate script is invalid",
        ).toString("base64"),
        truncated: false,
      },
      {
        schemaVersion: 1,
        kind: "candidate_process_failure",
        candidateSourceHash: build.sourceHash,
        phase: "before_runtime_connection",
        reason: "nonzero_exit",
        exitCode: 1,
      },
      { schemaVersion: 1, kind: "godot_exit", exitCode: 1, signal: null },
    ];
    const attributed = setup({
      idPrefix: "candidate-early-exit",
      diagnostics,
      connectFailure: new GodotAdapterError(
        "PROCESS_FAILED",
        "Godot exited before hello",
      ),
    });
    expect(
      await call(attributed.coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    ).toMatchObject({
      outcome: "error",
      error: {
        code: "operation_failed",
        recoverable: false,
        details: {
          schemaVersion: 1,
          attribution: "candidate_source",
          stage: "launch",
          sourceHash: build.sourceHash,
        },
      },
    });
    await attributed.coordinator.close();

    const unproven = setup({
      idPrefix: "candidate-unproven-cleanup",
      diagnostics,
      cleanupProven: false,
      connectFailure: new GodotAdapterError(
        "PROCESS_FAILED",
        "Godot exited before hello",
      ),
    });
    const unprovenResponse = await call(
      unproven.coordinator,
      GAME_TOOL_NAMES_V1.launch,
      { buildId: build.buildId },
    );
    expect(unprovenResponse).toMatchObject({
      outcome: "error",
      error: { code: "operation_failed", recoverable: false },
    });
    expect(unprovenResponse).not.toHaveProperty("error.details.attribution");
    await expect(unproven.coordinator.close()).rejects.toBeInstanceOf(
      AggregateError,
    );

    const spoofed = setup({
      idPrefix: "candidate-stderr-spoof",
      diagnostics: diagnostics.filter(
        (record) => record.kind !== "candidate_process_failure",
      ),
      connectFailure: new GodotAdapterError(
        "PROCESS_FAILED",
        "Godot exited before hello",
      ),
    });
    const spoofedResponse = await call(
      spoofed.coordinator,
      GAME_TOOL_NAMES_V1.launch,
      { buildId: build.buildId },
    );
    expect(spoofedResponse).toMatchObject({ outcome: "error" });
    expect(spoofedResponse).not.toHaveProperty("error.details.attribution");
    await spoofed.coordinator.close();
  });

  it.each([
    new GodotAdapterError("COMMAND_TIMEOUT", "Host command timed out"),
    new GodotAdapterError(
      "CAPABILITY_UNSUPPORTED",
      "required capability was not negotiated",
    ),
    new GodotAdapterError("PROTOCOL_ERROR", "AUTH_FAILED: token mismatch"),
    new GodotAdapterError(
      "PROTOCOL_ERROR",
      "PROTOCOL_MISMATCH: fingerprint mismatch",
    ),
  ])("does not attribute launch infrastructure failure %s", async (error) => {
    const infrastructure = setup({
      idPrefix: `launch-infra-${error.code}`,
      diagnostics: [
        {
          schemaVersion: 1,
          kind: "stage_ready",
          fixtureHash: prepared.fixtureHash,
          projectHash: prepared.projectHash,
          addonHash: prepared.addonHash,
        },
        { schemaVersion: 1, kind: "godot_started", pid: 42 },
      ],
      connectFailure: error,
    });
    const response = await call(
      infrastructure.coordinator,
      GAME_TOOL_NAMES_V1.launch,
      { buildId: build.buildId },
    );
    expect(response).toMatchObject({ outcome: "error" });
    expect(response).not.toHaveProperty("error.details.attribution");
    await infrastructure.coordinator.close();
  });

  it("attributes only explicit candidate diagnostics during step and then seals on stop", async () => {
    const candidateDiagnostics: readonly RuntimeSidecarDiagnosticV1[] = [
      {
        schemaVersion: 1,
        kind: "stage_ready",
        fixtureHash: prepared.fixtureHash,
        projectHash: prepared.projectHash,
        addonHash: prepared.addonHash,
      },
      { schemaVersion: 1, kind: "godot_started", pid: 42 },
      {
        schemaVersion: 1,
        kind: "godot_stderr",
        bytesBase64: Buffer.from(
          "SCRIPT ERROR: Parse Error: candidate runtime script failed",
        ).toString("base64"),
        truncated: false,
      },
      {
        schemaVersion: 1,
        kind: "candidate_process_failure",
        candidateSourceHash: build.sourceHash,
        phase: "runtime_connected",
        reason: "nonzero_exit",
        exitCode: 1,
      },
      { schemaVersion: 1, kind: "godot_exit", exitCode: 1, signal: null },
    ];
    const sourceBound = setup({
      idPrefix: "candidate-step",
      diagnostics: candidateDiagnostics,
    });
    const launched = successOutput(
      await call(sourceBound.coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    sourceBound.clients[0]!.stepError = new GodotAdapterError(
      "PROCESS_FAILED",
      "Godot exited during step",
    );
    const candidateFailure = await call(
      sourceBound.coordinator,
      GAME_TOOL_NAMES_V1.step,
      {
        runtimeId: launched.runtimeId,
        clock: "process_frame",
        count: 1,
      },
    );
    expect(candidateFailure).toMatchObject({
      outcome: "error",
      error: {
        code: "runtime_unavailable",
        details: {
          schemaVersion: 1,
          attribution: "candidate_source",
          stage: "step",
          sourceHash: build.sourceHash,
        },
      },
    });
    expect(sourceBound.store.seals.has(String(launched.executionId))).toBe(
      false,
    );
    const stopped = successOutput(
      await call(sourceBound.coordinator, GAME_TOOL_NAMES_V1.stop, {
        runtimeId: launched.runtimeId,
      }),
    );
    expect(stopped).toMatchObject({
      runtime: { status: "failed" },
      sealed: true,
    });
    expect(sourceBound.store.seals.has(String(launched.executionId))).toBe(
      true,
    );
    const status = successOutput(
      await call(sourceBound.coordinator, GAME_TOOL_NAMES_V1.status, {
        runtimeId: launched.runtimeId,
      }),
    );
    expect(status.runtime).toMatchObject({ status: "failed" });
    const capabilities = successOutput(
      await call(sourceBound.coordinator, GAME_TOOL_NAMES_V1.capabilities, {
        runtimeId: launched.runtimeId,
      }),
    );
    expect(capabilities.runtime).toMatchObject({
      runtime: { status: "failed" },
    });
    await sourceBound.coordinator.close();

    const bareRuntimeFailure = setup({ idPrefix: "bare-runtime-failure" });
    const bareLaunch = successOutput(
      await call(bareRuntimeFailure.coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    bareRuntimeFailure.clients[0]!.stepError = new GodotAdapterError(
      "PROTOCOL_ERROR",
      "RUNTIME_FAILURE: managed stepping invariant failed",
    );
    const bareFailure = await call(
      bareRuntimeFailure.coordinator,
      GAME_TOOL_NAMES_V1.step,
      {
        runtimeId: bareLaunch.runtimeId,
        clock: "process_frame",
        count: 1,
      },
    );
    expect(bareFailure).toMatchObject({ outcome: "error" });
    expect(bareFailure).not.toHaveProperty("error.details.attribution");
    await call(bareRuntimeFailure.coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: bareLaunch.runtimeId,
    });
    await bareRuntimeFailure.coordinator.close();
  });

  it("retries the same terminal payload after post-seal persistence failures", async () => {
    const { coordinator, store } = setup({ idPrefix: "terminal-retry" });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    store.failExecutionResourceWrites = 2;
    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.stop, {
        runtimeId: launched.runtimeId,
      }),
    ).toMatchObject({ outcome: "error", error: { code: "operation_failed" } });
    expect(store.seals.has(launched.executionId as string)).toBe(true);
    expect(store.resources.has(`runtime:${String(launched.runtimeId)}`)).toBe(
      true,
    );
    expect(
      store.resources.has(`execution:${String(launched.executionId)}`),
    ).toBe(false);

    await expect(coordinator.close()).rejects.toBeInstanceOf(AggregateError);
    await expect(coordinator.close()).resolves.toBeUndefined();
    expect(
      store.resources.has(`execution:${String(launched.executionId)}`),
    ).toBe(true);
  });

  it("rejects unimplemented capture triggers and checkpoint barriers explicitly", async () => {
    const { coordinator, sidecars } = setup({
      idPrefix: "unsupported-controls",
    });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.captureConfigure, {
        runtimeId: launched.runtimeId,
        historySeconds: 10,
        maxTicks: 600,
        channels: ["state"],
        stateSampleEveryTicks: 1,
        triggers: [{ kind: "runtime_event", event: "runtime_exit" }],
      }),
    ).toMatchObject({
      outcome: "error",
      error: { code: "unsupported_capability", recoverable: true },
    });
    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.checkpointCreate, {
        runtimeId: launched.runtimeId,
        barrier: "physics_tick_end",
      }),
    ).toMatchObject({
      outcome: "error",
      error: { code: "unsupported_capability", recoverable: true },
    });
    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.fork, {
        source: { kind: "workspace", workspaceId },
        changes: {
          capture: {
            historySeconds: 10,
            maxTicks: 600,
            channels: ["state"],
            stateSampleEveryTicks: 1,
            triggers: [{ kind: "runtime_event", event: "engine_error" }],
          },
        },
      }),
    ).toMatchObject({
      outcome: "error",
      error: { code: "unsupported_capability", recoverable: true },
    });
    expect(sidecars.sessions).toHaveLength(1);
    await coordinator.close();
  });

  it("pins process-frame and physics-tick windows without treating ticks as microseconds", async () => {
    const { coordinator } = setup({ idPrefix: "pin-domains" });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
        controls: {
          fixedFps: 120,
          physicsTicksPerSecond: 60,
          maxTicks: 20,
        },
      }),
    );
    await call(coordinator, GAME_TOOL_NAMES_V1.captureConfigure, {
      runtimeId: launched.runtimeId,
      historySeconds: 10,
      maxTicks: 600,
      channels: ["clocks", "state"],
      stateSampleEveryTicks: 1,
      triggers: [],
    });
    await call(coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: launched.runtimeId,
      clock: "process_frame",
      count: 4,
    });

    for (const anchor of [
      {
        clock: "process_frame",
        requestedTick: 3,
        requestedPhase: "process_frame_start",
      },
      {
        clock: "physics_tick",
        requestedTick: 1,
        requestedPhase: "physics_tick_start",
      },
    ] as const) {
      const pinned = successOutput(
        await call(coordinator, GAME_TOOL_NAMES_V1.capturePin, {
          runtimeId: launched.runtimeId,
          anchor,
          beforeTicks: 1,
          afterTicks: 1,
        }),
      );
      const events = pinned.events as Array<{
        clock: { hostMonotonicUs: number };
      }>;
      const window = pinned.window as {
        requestedRange: {
          from: { hostMonotonicUs: number };
          through: { hostMonotonicUs: number };
        };
      };
      expect(events.length).toBeGreaterThan(0);
      expect(window.requestedRange.from.hostMonotonicUs).toBe(
        Math.min(...events.map((event) => event.clock.hostMonotonicUs)),
      );
      expect(window.requestedRange.through.hostMonotonicUs).toBe(
        Math.max(...events.map((event) => event.clock.hostMonotonicUs)),
      );
    }
    successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.stop, {
        runtimeId: launched.runtimeId,
      }),
    );
    await coordinator.close();
  });

  it("includes null-clock global diagnostic loss in pinned windows", async () => {
    const { coordinator } = setup({
      idPrefix: "pin-global-loss",
      diagnosticFailure: {
        code: "diagnostic_protocol_failure",
        message: "injected diagnostic framing failure",
      },
    });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    await call(coordinator, GAME_TOOL_NAMES_V1.captureConfigure, {
      runtimeId: launched.runtimeId,
      historySeconds: 10,
      maxTicks: 600,
      channels: ["runtime_error"],
      stateSampleEveryTicks: 1,
      triggers: [],
    });
    await call(coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: launched.runtimeId,
      clock: "process_frame",
      count: 1,
    });

    const pinned = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.capturePin, {
        runtimeId: launched.runtimeId,
        beforeTicks: 0,
        afterTicks: 0,
      }),
    );
    expect(pinned.window).toMatchObject({ status: "partial" });
    expect(
      (
        pinned.window as {
          loss: Array<{
            kind: string;
            firstClock: unknown;
            lastClock: unknown;
          }>;
        }
      ).loss,
    ).toContainEqual(
      expect.objectContaining({
        kind: "unavailable",
        firstClock: null,
        lastClock: null,
      }),
    );
    await coordinator.close();
  });

  it("pins a valid bounding clock envelope across a restore discontinuity", async () => {
    const { coordinator } = setup({ idPrefix: "pin-after-restore" });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
        controls: {
          fixedFps: 120,
          physicsTicksPerSecond: 60,
          maxTicks: 20,
        },
      }),
    );
    await call(coordinator, GAME_TOOL_NAMES_V1.captureConfigure, {
      runtimeId: launched.runtimeId,
      historySeconds: 10,
      maxTicks: 600,
      channels: ["clocks", "state", "checkpoint"],
      stateSampleEveryTicks: 1,
      triggers: [],
    });
    await call(coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: launched.runtimeId,
      clock: "process_frame",
      count: 4,
    });
    const checkpoint = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.checkpointCreate, {
        runtimeId: launched.runtimeId,
        barrier: "process_frame_end",
      }),
    );
    await call(coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: launched.runtimeId,
      clock: "process_frame",
      count: 3,
    });
    await call(coordinator, GAME_TOOL_NAMES_V1.checkpointRestore, {
      runtimeId: launched.runtimeId,
      checkpointId: (checkpoint.manifest as { checkpointId: string })
        .checkpointId,
    });
    await call(coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: launched.runtimeId,
      clock: "process_frame",
      count: 1,
    });
    const pinned = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.capturePin, {
        runtimeId: launched.runtimeId,
        anchor: {
          clock: "process_frame",
          requestedTick: 5,
          requestedPhase: "process_frame_start",
        },
        beforeTicks: 2,
        afterTicks: 2,
      }),
    );
    const window = pinned.window as {
      status: string;
      requestedRange: {
        from: Record<string, number | null>;
        through: Record<string, number | null>;
      };
      realizedRange: {
        from: Record<string, number | null>;
        through: Record<string, number | null>;
      } | null;
      loss: Array<{ reason: string }>;
      coverage: Array<{ status: string }>;
    };
    expect(window.status).toBe("partial");
    expect(
      window.loss.some((loss) => /clock domains/iu.test(loss.reason)),
    ).toBe(true);
    expect(
      window.coverage.every((coverage) => coverage.status !== "full"),
    ).toBe(true);
    const range = (
      pinned.window as {
        requestedRange: {
          from: Record<string, number | null>;
          through: Record<string, number | null>;
        };
      }
    ).requestedRange;
    for (const domain of [
      "processFrame",
      "physicsTick",
      "simulationTimeUs",
      "hostMonotonicUs",
    ] as const) {
      expect(range.from[domain]).toBeLessThanOrEqual(
        range.through[domain] as number,
      );
      expect(window.realizedRange?.from[domain]).toBeLessThanOrEqual(
        window.realizedRange?.through[domain] as number,
      );
    }
    await coordinator.close();
  });

  it("paginates queries, preserves the cursor, and filters exact raw event subtypes", async () => {
    const { coordinator, store } = setup({ idPrefix: "query-subtypes" });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    await call(coordinator, GAME_TOOL_NAMES_V1.input, {
      runtimeId: launched.runtimeId,
      action: "attempt_jump",
      requested: {
        clock: "process_frame",
        requestedTick: 0,
        requestedPhase: "process_frame_start",
      },
    });
    await call(coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: launched.runtimeId,
      clock: "process_frame",
      count: 1,
    });
    await call(coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: launched.runtimeId,
    });

    const first = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId: launched.executionId,
        select: "events",
        limit: 1,
      }),
    ).result as {
      indexId: string;
      rows: Array<{ value: { eventType?: string } }>;
      incomplete: boolean;
      nextCursor: string | null;
      query: { cursor: string | null };
    };
    expect(first.nextCursor).toBe("1");
    expect(first.incomplete).toBe(true);
    expect(first.query.cursor).toBeNull();
    const storedIndex = structuredClone(
      store.resources.get(`index:${first.indexId}`),
    ) as Record<string, unknown>;
    expect(storedIndex).not.toHaveProperty("query");
    expect(storedIndex).not.toHaveProperty("rows");

    const second = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId: launched.executionId,
        indexId: first.indexId,
        select: "events",
        cursor: first.nextCursor,
        limit: 1,
      }),
    ).result as typeof first;
    expect(second.query.cursor).toBe("1");
    expect(store.resources.get(`index:${first.indexId}`)).toEqual(storedIndex);

    const requested = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId: launched.executionId,
        select: "events",
        filters: { eventTypes: ["input.requested"] },
        limit: 20,
      }),
    ).result as typeof first;
    expect(requested.rows).toHaveLength(1);
    expect(requested.rows[0]?.value.eventType).toBe("input_requested");

    const realized = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId: launched.executionId,
        select: "events",
        filters: { eventTypes: ["input.realized"] },
        limit: 20,
      }),
    ).result as typeof first;
    expect(realized.rows).toHaveLength(1);
    expect(realized.rows[0]?.value.eventType).toBe("input_realized");

    const changed = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId: launched.executionId,
        select: "state",
        filters: { eventTypes: ["state.changed"] },
        limit: 20,
      }),
    ).result as { rows: Array<{ statePath: string | null }> };
    expect(changed.rows).toEqual([
      expect.objectContaining({ statePath: "player.window_open" }),
    ]);
    await coordinator.close();
  });

  it("rejects a stored index whose payload identity differs from its resource ID", async () => {
    const { coordinator, store } = setup({ idPrefix: "index-identity" });
    const launched = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    await call(coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: launched.runtimeId,
      clock: "process_frame",
      count: 1,
    });
    await call(coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: launched.runtimeId,
    });
    const initial = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId: launched.executionId,
        select: "events",
        limit: 20,
      }),
    ).result as { indexId: string };
    const stored = store.resources.get(`index:${initial.indexId}`) as Record<
      string,
      unknown
    >;
    store.resources.set(`index:${initial.indexId}`, {
      ...stored,
      indexId: "runtime-state-index:forged-payload-id",
    });

    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId: launched.executionId,
        indexId: initial.indexId,
        select: "events",
        limit: 20,
      }),
    ).toMatchObject({
      outcome: "error",
      error: { code: "resource_task_mismatch", recoverable: true },
    });
    store.resources.set(`index:${initial.indexId}`, {
      ...stored,
      rawRecordHash: hash("6"),
    });
    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.query, {
        executionId: launched.executionId,
        indexId: initial.indexId,
        select: "events",
        limit: 20,
      }),
    ).toMatchObject({
      outcome: "error",
      error: { code: "resource_task_mismatch", recoverable: true },
    });
    await coordinator.close();
  });

  it("returns a structured error instead of silently truncating observable differences", async () => {
    const { coordinator, clients } = setup({ idPrefix: "compare-bound" });
    const baseline = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    await call(coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: baseline.runtimeId,
      clock: "process_frame",
      count: 1,
    });
    await call(coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: baseline.runtimeId,
    });
    const candidate = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    clients[1]!.windowOpen = false;
    clients[1]!.jumping = true;
    await call(coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: candidate.runtimeId,
      clock: "process_frame",
      count: 1,
    });
    await call(coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: candidate.runtimeId,
    });

    const boundedCompare = await call(coordinator, GAME_TOOL_NAMES_V1.compare, {
      baselineExecutionId: baseline.executionId,
      candidateExecutionId: candidate.executionId,
      maxDifferences: 1,
    });
    expect(boundedCompare).toMatchObject({
      outcome: "error",
      error: {
        code: "budget_exhausted",
        recoverable: true,
        details: {
          requestedMaximum: 1,
        },
      },
    });
    if (boundedCompare.outcome !== "error") {
      throw new Error("expected bounded comparison failure");
    }
    expect(
      typeof objectValue(boundedCompare.error.details)["observedDifferences"],
    ).toBe("number");
    await coordinator.close();
  });

  it("rejects comparison sources beyond the full-read hard bound", async () => {
    const { coordinator, store } = setup({ idPrefix: "compare-source-bound" });
    const baseline = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    await call(coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: baseline.runtimeId,
      clock: "process_frame",
      count: 1,
    });
    await call(coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: baseline.runtimeId,
    });
    const candidate = successOutput(
      await call(coordinator, GAME_TOOL_NAMES_V1.launch, {
        buildId: build.buildId,
      }),
    );
    await call(coordinator, GAME_TOOL_NAMES_V1.step, {
      runtimeId: candidate.runtimeId,
      clock: "process_frame",
      count: 1,
    });
    await call(coordinator, GAME_TOOL_NAMES_V1.stop, {
      runtimeId: candidate.runtimeId,
    });

    const executionId = String(baseline.executionId);
    const stored = structuredClone(
      store.resources.get(`execution:${executionId}`),
    ) as Extract<VNextExecutionRecordV1, { readonly sealed: true }>;
    const seed = (store.events.get(executionId) ?? [])[0] as
      VNextRawRuntimeEventV1 | undefined;
    expect(seed).toBeDefined();
    const expanded: VNextRawRuntimeEventV1[] = Array.from(
      { length: 10_001 },
      (_, sequence) =>
        VNextRawRuntimeEventV1Schema.parse({
          ...seed!,
          eventId: asEventId(`event:compare-source-bound:${sequence}`),
          sequence,
          observedRelations: [],
        }),
    );
    const seal: RuntimeExecutionSealV1 = {
      schemaVersion: 1,
      taskId,
      executionId,
      count: expanded.length,
      headHash: contentHash(expanded.at(-1) as never),
      byteLength: Buffer.byteLength(JSON.stringify(expanded), "utf8"),
      contentHash: contentHash(expanded as never),
    };
    const basis = {
      ...stored,
      manifest: {
        ...stored.manifest,
        launchParameters: {
          ...stored.manifest.launchParameters,
          executionSeal: seal,
        },
      },
      events: expanded,
    };
    const { recordHash: ignoredRecordHash, ...withoutRecordHash } = basis;
    void ignoredRecordHash;
    const inflated = VNextExecutionRecordV1Schema.parse({
      ...withoutRecordHash,
      recordHash: contentHash(withoutRecordHash as never),
    });
    store.events.set(executionId, expanded);
    store.seals.set(executionId, seal);
    store.resources.set(`execution:${executionId}`, inflated);

    expect(
      await call(coordinator, GAME_TOOL_NAMES_V1.compare, {
        baselineExecutionId: baseline.executionId,
        candidateExecutionId: candidate.executionId,
        maxDifferences: 200,
      }),
    ).toMatchObject({
      outcome: "error",
      error: {
        code: "budget_exhausted",
        recoverable: true,
        details: {
          maximumSourceEvents: 10_000,
          baselineEvents: 10_001,
        },
      },
    });
    await coordinator.close();
  });
});
