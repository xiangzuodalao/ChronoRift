import { randomUUID } from "node:crypto";

import {
  SEMANTIC_GAME_TOOL_NAMES_V1,
  SEMANTIC_GAME_TOOL_DEFINITIONS_V1,
  SEMANTIC_UNSUPPORTED_GAME_CAPABILITIES_V1,
  validateSemanticGameToolInputV1,
  validateSemanticGameToolOutputV1,
  type SemanticGameToolNameV1,
} from "@chronorift/agent-protocol";
import {
  VNextBuildV1Schema,
  VNextSemanticBranchResourceV1Schema,
  VNextSemanticCheckpointPayloadV1Schema,
  VNextSemanticCheckpointResourceV1Schema,
  VNextSemanticComparisonResourceV1Schema,
  VNextSemanticExecutionRecordV1Schema,
  VNextSemanticObservationEventV1Schema,
  VNextSemanticRuntimeRecordV1Schema,
  VNextSemanticTraceV1Schema,
  asAdapterId,
  asBranchId,
  asCheckpointId,
  asComparisonId,
  asExecutionId,
  asRuntimeId,
  asSha256DigestV1,
  asTraceId,
  type ExecutionId,
  type GodotSemanticAdapterProfileV1,
  type JsonValue,
  type RuntimeId,
  type Sha256DigestV1,
  type TaskId,
  type VNextSemanticObservationEventV1,
  type VNextSemanticTraceV1,
  type WorkspaceId,
} from "@chronorift/domain";
import {
  GodotAdapterError,
  connectGodotSemanticRuntime,
  type GodotSemanticObservationReceiptV1,
  type GodotSemanticRuntimeClient,
} from "@chronorift/godot-adapter";
import {
  GODOT_SEMANTIC_PROTOCOL_PROFILE_V1,
  GODOT_SEMANTIC_RUNTIME_PROFILE_V1,
} from "@chronorift/godot-protocol";
import { ArtifactNotFoundError, contentHash } from "@chronorift/json-artifacts";
import type {
  VNextGameToolErrorCodeV1,
  VNextSemanticGameToolPortRequestV1,
} from "@chronorift/pi-harness";

import {
  prepareExternalGodotSemanticBuildV1,
  type PreparedExternalGodotSemanticBuildV1,
} from "./candidate-godot-build.js";
import type { TaskGodotProjectCapabilityV1 } from "./contracts.js";
import type {
  GodotSemanticSidecarPortV1,
  SandboxedGodotSemanticSidecarV1,
} from "./godot-semantic-sidecar-port.js";
import type { ManagedGodotSemanticRuntimeCapabilityV1 } from "./managed-godot-semantic-runtime.js";
import type { M1TaskRuntimeArtifactStore } from "./m1-task-environment.js";

const LIMITATIONS = Object.freeze([
  "Only the declared Timer and spawned-entity projection is observed.",
  "Checkpoint restore does not capture scene-private state, signals, callables, RNG, rendering, audio, external state, or all pending engine work.",
  "Checkpoint, fork, trace replay, and compare results are descriptive_only and do not establish an equivalent execution or causality.",
] as const);

const COVERAGE_LIMITATION =
  "Semantic state is sampled at command endpoints; intermediate transitions may be unobserved.";

const coverage = (observationCount: number) => [
  {
    channel: "clock" as const,
    status: "partial" as const,
    emittedRecords: observationCount,
    droppedRecords: 0,
    limitations: [COVERAGE_LIMITATION],
  },
  {
    channel: "state" as const,
    status: "partial" as const,
    emittedRecords: observationCount,
    droppedRecords: 0,
    limitations: [COVERAGE_LIMITATION],
  },
  {
    channel: "entity_lifecycle" as const,
    status: "partial" as const,
    emittedRecords: observationCount,
    droppedRecords: 0,
    limitations: [COVERAGE_LIMITATION],
  },
  {
    channel: "log" as const,
    status: "unavailable" as const,
    emittedRecords: 0,
    droppedRecords: 0,
    limitations: [
      "Project logs are retained by the bounded process receipts, not indexed as semantic rows.",
    ],
  },
  {
    channel: "error" as const,
    status: "unavailable" as const,
    emittedRecords: 0,
    droppedRecords: 0,
    limitations: [
      "Project errors are retained by the bounded process receipts, not indexed as semantic rows.",
    ],
  },
];

const loss = () => [
  {
    channel: "clock/state/entity_lifecycle",
    kind: "observer_effect" as const,
    count: 0,
    reason:
      "Endpoint observation executes adapter serialization and omits intermediate positions.",
  },
  {
    channel: "log/error",
    kind: "unavailable" as const,
    count: 0,
    reason: "This semantic index does not ingest project log/error content.",
  },
];

const provenCleanup = (cleanup: {
  readonly processGroupTerminated: boolean;
  readonly cgroupPopulated: boolean;
  readonly scopeRemoved: boolean;
  readonly storageReconciled?: boolean | undefined;
}): boolean =>
  cleanup.processGroupTerminated &&
  !cleanup.cgroupPopulated &&
  cleanup.scopeRemoved &&
  cleanup.storageReconciled === true;

const SAFE_ADAPTER_FAILURES = new Set([
  "Adapter profile has an unsupported shape",
  "Adapter profile kind or version is unsupported",
  "Adapter target scene is unavailable",
  "Adapter target is not a PackedScene",
  "Adapter target scene could not be instantiated",
  "Adapter target does not expose the Timer/spawn contract",
  "Adapter target has no spawn scene",
  "Adapter target did not create a Timer child",
]);

const managedLaunchFailure = (
  sidecar: SandboxedGodotSemanticSidecarV1,
  error: unknown,
): SemanticToolError => {
  const sidecarError = [...sidecar.diagnostics()]
    .reverse()
    .find((diagnostic) => diagnostic.kind === "sidecar_error");
  if (sidecarError?.kind === "sidecar_error") {
    return new SemanticToolError(
      "runtime_unavailable",
      `Managed semantic launch failed during ${sidecarError.phase} (${sidecarError.code})`,
      true,
    );
  }
  if (error instanceof GodotAdapterError) {
    const remoteAdapterPrefix = "ADAPTER_FAILURE: ";
    const remoteAdapterFailure = error.message.startsWith(remoteAdapterPrefix)
      ? error.message.slice(remoteAdapterPrefix.length)
      : null;
    const safeDetail =
      remoteAdapterFailure !== null &&
      SAFE_ADAPTER_FAILURES.has(remoteAdapterFailure)
        ? `: ${remoteAdapterFailure}`
        : "";
    return new SemanticToolError(
      "runtime_unavailable",
      `Managed semantic handshake failed (${error.code})${safeDetail}`,
      true,
    );
  }
  if (sidecar.diagnosticFacts().status === "failed") {
    return new SemanticToolError(
      "runtime_unavailable",
      "Managed semantic diagnostic channel failed",
      true,
    );
  }
  return new SemanticToolError(
    "runtime_unavailable",
    "Managed semantic handshake failed",
    true,
  );
};

const semanticClock = (receipt: GodotSemanticObservationReceiptV1) => ({
  processFrame: receipt.sample.projection.capturedAt.processFrame,
  physicsTick: receipt.sample.projection.capturedAt.physicsTick,
  simulationTimeUs: receipt.sample.projection.capturedAt.simulationTimeUs,
  hostMonotonicUs: Math.floor(
    (receipt.hostMonotonicStartUs + receipt.hostMonotonicEndUs) / 2,
  ),
  renderFrame: null,
});

const json = (value: unknown): JsonValue => value as JsonValue;

const preparedBuildIdentity = (
  prepared: PreparedExternalGodotSemanticBuildV1,
) => {
  const { createdAt, ...build } = prepared.build;
  void createdAt;
  return {
    build,
    configuredMainScene: prepared.configuredMainScene,
    projectHash: prepared.projectHash,
    descriptorHash: prepared.descriptorHash,
    adapterProfileSha256: prepared.adapterProfileSha256,
    overlayHash: prepared.overlayHash,
    addonHash: prepared.addonHash,
    vanillaSidecarHash: prepared.vanillaSidecarHash,
    semanticSidecarHash: prepared.semanticSidecarHash,
    fileCount: prepared.fileCount,
    byteLength: prepared.byteLength,
  };
};

type SemanticToolResponse =
  | {
      readonly schemaVersion: 1;
      readonly toolCallId: string;
      readonly outcome: "success";
      readonly output: JsonValue;
    }
  | {
      readonly schemaVersion: 1;
      readonly toolCallId: string;
      readonly outcome: "error";
      readonly error: {
        readonly code: VNextGameToolErrorCodeV1;
        readonly message: string;
        readonly recoverable: boolean;
      };
    };

interface ActiveSemanticRuntime {
  readonly runtimeId: RuntimeId;
  readonly executionId: ExecutionId;
  readonly build: PreparedExternalGodotSemanticBuildV1;
  readonly client: SemanticRuntimeClientPort;
  readonly sidecar: SandboxedGodotSemanticSidecarV1;
  readonly events: VNextSemanticObservationEventV1[];
  latest: GodotSemanticObservationReceiptV1;
  state: "running" | "cleanup_pending" | "stopped" | "failed";
  cleanupProven: boolean;
  terminalPersisted: boolean;
  stopPromise:
    | Promise<ReturnType<ExternalGodotSemanticCoordinator["runtimeOutput"]>>
    | undefined;
  terminalPromise:
    | Promise<ReturnType<ExternalGodotSemanticCoordinator["runtimeOutput"]>>
    | undefined;
}

type SemanticRuntimeClientPort = Pick<
  GodotSemanticRuntimeClient,
  "ready" | "status" | "checkpoint" | "restore" | "shutdown"
>;

export interface ExternalGodotSemanticCoordinatorOptions {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly workspaceDirectory: string;
  readonly baselineSourceHash: Sha256DigestV1;
  readonly projectCapability: TaskGodotProjectCapabilityV1;
  readonly managedRuntime: ManagedGodotSemanticRuntimeCapabilityV1;
  readonly adapterProfile: GodotSemanticAdapterProfileV1;
  readonly adapterProfileSha256: Sha256DigestV1;
  readonly sidecarPort: Pick<
    GodotSemanticSidecarPortV1,
    "runVanillaSmoke" | "openManaged"
  >;
  readonly runtimeStore: M1TaskRuntimeArtifactStore;
  readonly connectRuntime?:
    | ((
        transport: Parameters<typeof connectGodotSemanticRuntime>[0],
        request: Parameters<typeof connectGodotSemanticRuntime>[1],
      ) => Promise<SemanticRuntimeClientPort>)
    | undefined;
  readonly now?: (() => string) | undefined;
}

export class ExternalGodotSemanticCoordinator {
  readonly #active = new Map<RuntimeId, ActiveSemanticRuntime>();
  #build: PreparedExternalGodotSemanticBuildV1 | undefined;
  #launchCount = 0;
  #closed = false;

  public constructor(
    private readonly options: ExternalGodotSemanticCoordinatorOptions,
  ) {
    if (
      options.adapterProfile.projectCapabilitySha256 !==
      options.projectCapability.capabilitySha256
    ) {
      throw new TypeError(
        "semantic adapter profile is detached from the project capability",
      );
    }
  }

  public async invoke(
    request: VNextSemanticGameToolPortRequestV1,
    signal?: AbortSignal,
  ): Promise<SemanticToolResponse> {
    if (
      request.schemaVersion !== 1 ||
      !SEMANTIC_GAME_TOOL_NAMES_V1.includes(request.toolName) ||
      !validateSemanticGameToolInputV1(request.toolName, request.input)
    ) {
      return this.failure(
        request.toolCallId,
        "invalid_request",
        "Invalid semantic tool request",
        false,
      );
    }
    const input = request.input as Record<string, unknown>;
    if (input["taskId"] !== this.options.taskId) {
      return this.failure(
        request.toolCallId,
        "resource_task_mismatch",
        "Semantic resource belongs to another Task",
        false,
      );
    }
    try {
      const output = await this.dispatch(request.toolName, input, signal);
      if (!validateSemanticGameToolOutputV1(request.toolName, output)) {
        throw new SemanticToolError(
          "operation_failed",
          "Semantic runtime returned an invalid bounded result",
          false,
        );
      }
      return {
        schemaVersion: 1,
        toolCallId: request.toolCallId,
        outcome: "success",
        output: json(output),
      };
    } catch (error) {
      const code =
        error instanceof SemanticToolError ? error.code : "operation_failed";
      const recoverable =
        error instanceof SemanticToolError && error.recoverable;
      return this.failure(
        request.toolCallId,
        code,
        error instanceof SemanticToolError
          ? error.publicMessage
          : "Semantic runtime operation failed",
        recoverable,
      );
    }
  }

  public async close(): Promise<void> {
    this.#closed = true;
    const failures: unknown[] = [];
    for (const context of [...this.#active.values()]) {
      try {
        await this.stopContext(context);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "semantic runtime cleanup failed");
    }
  }

  public reconcileSandboxCleanup(cleanup: {
    readonly processGroupTerminated: boolean;
    readonly cgroupPopulated: boolean;
    readonly scopeRemoved: boolean;
    readonly storageReconciled?: boolean | undefined;
  }): Promise<void> {
    if (!provenCleanup(cleanup)) {
      throw new Error("semantic sandbox cleanup is not proven");
    }
    const pending: Promise<unknown>[] = [];
    for (const context of this.#active.values()) {
      if (context.state !== "cleanup_pending") continue;
      context.cleanupProven = true;
      context.state = "failed";
      context.stopPromise = undefined;
      pending.push(this.persistTerminal(context));
    }
    return Promise.all(pending).then(() => undefined);
  }

  private async dispatch(
    toolName: SemanticGameToolNameV1,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    switch (toolName) {
      case "game_capabilities":
        return this.capabilities(input["runtimeId"] as string | undefined);
      case "game_launch":
        return this.launch(String(input["buildId"]), signal);
      case "game_status":
        return this.status(String(input["runtimeId"]));
      case "game_stop":
        return this.stop(String(input["runtimeId"]));
      case "game_query":
        return this.query(input);
      case "game_checkpoint_create":
        return this.checkpoint(String(input["runtimeId"]));
      case "game_checkpoint_restore":
        return this.restore(
          String(input["runtimeId"]),
          String(input["checkpointId"]),
        );
      case "game_fork":
        return this.fork(input, signal);
      case "game_trace_create":
        return this.traceCreate(input, signal);
      case "game_trace_replay":
        return this.traceReplay(input, signal);
      case "game_compare":
        return this.compare(input);
    }
  }

  private async prepareBuild(): Promise<PreparedExternalGodotSemanticBuildV1> {
    const prepared = await prepareExternalGodotSemanticBuildV1({
      taskId: this.options.taskId,
      workspaceId: this.options.workspaceId,
      workspaceDirectory: this.options.workspaceDirectory,
      baselineSourceHash: this.options.baselineSourceHash,
      projectCapability: this.options.projectCapability,
      adapterProfileSha256: this.options.adapterProfileSha256,
      managedRuntime: this.options.managedRuntime,
      now: this.options.now?.() ?? new Date().toISOString(),
    });
    if (
      this.#build !== undefined &&
      this.#build.build.buildId === prepared.build.buildId
    ) {
      if (
        contentHash(json(preparedBuildIdentity(this.#build))) !==
        contentHash(json(preparedBuildIdentity(prepared)))
      ) {
        throw new Error(
          "prepared semantic build identity collision changed immutable facts",
        );
      }
      return this.#build;
    }
    try {
      const existing = await this.options.runtimeStore.readResource(
        "build",
        prepared.build.buildId,
        (value) => VNextBuildV1Schema.parse(value),
      );
      const reused = { ...prepared, build: existing };
      if (
        contentHash(json(preparedBuildIdentity(reused))) !==
        contentHash(json(preparedBuildIdentity(prepared)))
      ) {
        throw new Error(
          "persisted semantic build identity collides with different immutable facts",
        );
      }
      this.#build = reused;
      return reused;
    } catch (error) {
      if (!(error instanceof ArtifactNotFoundError)) throw error;
    }
    await this.options.runtimeStore.putResourceOnce(
      "build",
      prepared.build.buildId,
      prepared.build,
      (value) => VNextBuildV1Schema.parse(value),
    );
    this.#build = prepared;
    return prepared;
  }

  private buildOutput(build: PreparedExternalGodotSemanticBuildV1) {
    return {
      schemaVersion: 1,
      workspaceId: build.build.workspaceId,
      sourceId: build.build.sourceId,
      buildId: build.build.buildId,
      sourceHash: build.build.sourceHash,
      workspaceDiffHash: build.build.workspaceDiffHash,
    };
  }

  private async capabilities(runtimeId?: string) {
    const build = await this.prepareBuild();
    const runtime =
      runtimeId === undefined ? null : this.requireRuntime(runtimeId);
    return {
      schemaVersion: 1,
      taskId: this.options.taskId,
      workspaceId: this.options.workspaceId,
      profile: "godot-external-semantic-v1",
      semanticAdapterProfileSha256: this.options.adapterProfileSha256,
      build: this.buildOutput(build),
      tools: SEMANTIC_GAME_TOOL_DEFINITIONS_V1.map(({ name, capability }) => ({
        name,
        capability,
      })),
      unsupported: SEMANTIC_UNSUPPORTED_GAME_CAPABILITIES_V1.map(
        (capability) => ({
          capability,
          reason: "semantic_profile_scope",
        }),
      ),
      limits: {
        activeRuntimesMaximum: 2,
        launchesPerTurnMaximum: 8,
        entityMaximum: 256,
        eventMaximum: 4096,
        checkpointBytesMaximum: 1_048_576,
        traceSamplesMaximum: 32,
        traceTicksMaximum: 600,
        queryRowsMaximum: 200,
      },
      runtime: runtime === null ? null : this.runtimeOutput(runtime),
    };
  }

  private async launch(buildId: string, signal?: AbortSignal) {
    const build = await this.prepareBuild();
    if (build.build.buildId !== buildId) {
      throw new SemanticToolError(
        "resource_not_found",
        "Requested semantic build was not found",
        false,
      );
    }
    const context = await this.launchContext(build, signal);
    return {
      schemaVersion: 1,
      build: this.buildOutput(build),
      runtime: this.runtimeOutput(context),
      qualificationReceiptSha256: asSha256DigestV1(
        contentHash({
          schemaVersion: 1,
          buildId: build.build.buildId,
          candidateSourceHash: build.build.sourceHash,
          adapterProfileSha256: this.options.adapterProfileSha256,
          vanillaQualified: true,
        }),
      ),
    };
  }

  private async launchContext(
    build: PreparedExternalGodotSemanticBuildV1,
    signal?: AbortSignal,
  ): Promise<ActiveSemanticRuntime> {
    if (this.#closed)
      throw new SemanticToolError(
        "runtime_unavailable",
        "Semantic coordinator is closed",
        false,
      );
    if (this.#active.size >= 2)
      throw new SemanticToolError(
        "budget_exhausted",
        "Semantic active-runtime limit reached",
        true,
      );
    if (this.#launchCount >= 8)
      throw new SemanticToolError(
        "budget_exhausted",
        "Semantic launch limit reached",
        false,
      );
    this.#launchCount += 1;
    const suffix = randomUUID().replaceAll("-", "").slice(0, 24);
    const runtimeId = asRuntimeId(`runtime:semantic:${suffix}`);
    const executionId = asExecutionId(`execution:semantic:${suffix}`);
    const common = {
      schemaVersion: 1 as const,
      runtimeProfile: GODOT_SEMANTIC_RUNTIME_PROFILE_V1,
      taskId: this.options.taskId,
      buildId: build.build.buildId,
      runtimeId,
      executionId,
      managedRuntimeId: this.options.managedRuntime.managedRuntimeId,
      candidateSourceHash: build.build.sourceHash,
      diagnosticFrameMaxBytes: 64 * 1024,
      diagnosticTotalMaxBytes: 2 * 1024 * 1024,
      diagnosticMaxCount: 256,
      outputCaptureMaxBytes: 1024 * 1024,
    };
    const vanilla = await this.options.sidecarPort.runVanillaSmoke(
      {
        ...common,
        operation: "vanilla_smoke",
        importTimeoutMs: 120_000,
        vanillaTimeoutMs: 10_000,
        stabilityWindowMs: 2_000,
      },
      signal,
    );
    if (
      vanilla.kind !== "completed" ||
      vanilla.result.diagnosticFacts.status !== "complete" ||
      !vanilla.result.diagnostics.some(
        (entry) => entry.kind === "smoke_complete",
      ) ||
      !provenCleanup(vanilla.result.sandbox.receipt.cleanup)
    ) {
      throw new SemanticToolError(
        "runtime_unavailable",
        "Vanilla qualification failed or cleanup was not proven",
        true,
      );
    }
    const token = asSha256DigestV1(
      contentHash({
        schemaVersion: 1,
        runtimeId,
        executionId,
        nonce: randomUUID(),
      }),
    );
    const opened = await this.options.sidecarPort.openManaged(
      {
        ...common,
        operation: "managed_lifecycle",
        protocolProfile: GODOT_SEMANTIC_PROTOCOL_PROFILE_V1,
        protocolVersion: 1,
        token,
        overlayHash: build.overlayHash,
        addonHash: build.addonHash,
        adapterProfileSha256: this.options.adapterProfileSha256,
        expectedMainScene: build.configuredMainScene,
        importTimeoutMs: 120_000,
        startupTimeoutMs: 30_000,
        executionTimeoutMs: 600_000,
      },
      signal,
    );
    if (opened.kind !== "opened") {
      throw new SemanticToolError(
        "runtime_unavailable",
        "Managed semantic runtime could not start",
        true,
      );
    }
    try {
      const client = await (
        this.options.connectRuntime ?? connectGodotSemanticRuntime
      )(opened.sidecar.transport, {
        schemaVersion: 1,
        token,
        expectedIdentity: {
          taskId: this.options.taskId,
          buildId: build.build.buildId,
          runtimeId,
          executionId,
          managedRuntimeId: this.options.managedRuntime.managedRuntimeId,
          candidateSourceHash: build.build.sourceHash,
          adapterProfileSha256: this.options.adapterProfileSha256,
          overlayHash: build.overlayHash,
          addonHash: build.addonHash,
        },
        expectedEngineVersion: this.options.managedRuntime.engineVersion,
        expectedPlatform: "Linux",
        expectedRenderer: "gl_compatibility",
        expectedDisplayServer: "headless",
        expectedAudioDriver: "Dummy",
        expectedMainScene: build.configuredMainScene,
        adapterProfile: this.options.adapterProfile,
        adapterProfileSha256: this.options.adapterProfileSha256,
      });
      const context: ActiveSemanticRuntime = {
        runtimeId,
        executionId,
        build,
        client,
        sidecar: opened.sidecar,
        events: [],
        latest: client.ready,
        state: "running",
        cleanupProven: false,
        terminalPersisted: false,
        stopPromise: undefined,
        terminalPromise: undefined,
      };
      this.#active.set(runtimeId, context);
      await this.recordObservation(context, "ready", client.ready);
      return context;
    } catch (error) {
      await opened.sidecar.terminate().catch(() => undefined);
      await opened.sidecar.completion.catch(() => undefined);
      throw managedLaunchFailure(opened.sidecar, error);
    }
  }

  private runtimeOutput(context: ActiveSemanticRuntime) {
    return {
      schemaVersion: 1,
      taskId: this.options.taskId,
      runtimeId: context.runtimeId,
      executionId: context.executionId,
      buildId: context.build.build.buildId,
      status: context.state === "running" ? "running" : context.state,
      targetScene: this.options.adapterProfile.targetScene,
      adapterId: asAdapterId(`adapter:${this.options.adapterProfileSha256}`),
      adapterProfileSha256: this.options.adapterProfileSha256,
      clocks: semanticClock(context.latest),
      coverage: coverage(context.events.length),
      loss: loss(),
    };
  }

  private async status(runtimeId: string) {
    const context = this.requireRuntime(runtimeId);
    if (context.state !== "running") {
      return { schemaVersion: 1, runtime: this.runtimeOutput(context) };
    }
    const observed = await context.client.status();
    await this.recordObservation(context, "status", observed);
    return { schemaVersion: 1, runtime: this.runtimeOutput(context) };
  }

  private async stop(runtimeId: string) {
    const context = this.requireRuntime(runtimeId);
    await this.stopContext(context);
    return {
      schemaVersion: 1,
      runtime: this.runtimeOutput(context),
      sealed: true,
      cleanupProven: true,
    };
  }

  private async stopContext(
    context: ActiveSemanticRuntime,
  ): Promise<ReturnType<ExternalGodotSemanticCoordinator["runtimeOutput"]>> {
    if (context.terminalPersisted) return this.runtimeOutput(context);
    if (
      (context.state === "stopped" || context.state === "failed") &&
      context.cleanupProven
    ) {
      return this.persistTerminal(context);
    }
    if (context.state === "cleanup_pending") {
      throw new Error("semantic runtime cleanup is not proven");
    }
    if (context.stopPromise !== undefined) return context.stopPromise;
    const stopping = (async () => {
      let shutdown: GodotSemanticObservationReceiptV1 | undefined;
      try {
        shutdown = await context.client.shutdown();
        await this.recordObservation(context, "shutdown", shutdown);
      } catch {
        context.state = "cleanup_pending";
        await context.sidecar.terminate().catch(() => undefined);
      }
      const completion = await context.sidecar.completion;
      if (
        completion.kind !== "executed" ||
        !provenCleanup(completion.receipt.cleanup)
      ) {
        context.state = "cleanup_pending";
        throw new Error("semantic runtime cleanup is not proven");
      }
      context.cleanupProven = true;
      context.state = shutdown === undefined ? "failed" : "stopped";
      return this.persistTerminal(context);
    })();
    context.stopPromise = stopping;
    try {
      return await stopping;
    } catch (error) {
      context.stopPromise = undefined;
      throw error;
    }
  }

  private persistTerminal(
    context: ActiveSemanticRuntime,
  ): Promise<ReturnType<ExternalGodotSemanticCoordinator["runtimeOutput"]>> {
    if (!context.cleanupProven) {
      return Promise.reject(
        new Error("semantic runtime cleanup is not proven"),
      );
    }
    if (context.terminalPersisted) {
      return Promise.resolve(this.runtimeOutput(context));
    }
    if (context.terminalPromise !== undefined) return context.terminalPromise;
    const persistence = (async () => {
      const seal = await this.options.runtimeStore.sealExecution(
        context.executionId,
      );
      const finalProjection = context.latest.sample.projection;
      const runtimeRecord = VNextSemanticRuntimeRecordV1Schema.parse({
        schemaVersion: 1,
        runtimeKind: "godot_external_semantic",
        taskId: this.options.taskId,
        runtimeId: context.runtimeId,
        executionId: context.executionId,
        buildId: context.build.build.buildId,
        adapterId: asAdapterId(`adapter:${this.options.adapterProfileSha256}`),
        adapterProfileSha256: this.options.adapterProfileSha256,
        status: context.state,
        finalProjectionSha256: asSha256DigestV1(contentHash(finalProjection)),
        finalProjection,
        coverage: coverage(context.events.length),
        loss: loss(),
        cleanupProven: true,
      });
      const executionRecord = VNextSemanticExecutionRecordV1Schema.parse({
        schemaVersion: 1,
        executionKind: "godot_external_semantic",
        taskId: this.options.taskId,
        executionId: context.executionId,
        runtimeId: context.runtimeId,
        workspaceId: this.options.workspaceId,
        sourceId: context.build.build.sourceId,
        buildId: context.build.build.buildId,
        adapterId: runtimeRecord.adapterId,
        adapterProfileSha256: this.options.adapterProfileSha256,
        targetScene: this.options.adapterProfile.targetScene,
        stateSchemaVersion: "chronorift.timer-spawn:v1",
        fidelity: "descriptive_only",
        equivalentForkEligible: false,
        eventCount: context.events.length,
        coverage: runtimeRecord.coverage,
        loss: runtimeRecord.loss,
        executionSeal: seal,
      });
      await this.putResourceIdempotently(
        "runtime",
        context.runtimeId,
        runtimeRecord,
        (value) => VNextSemanticRuntimeRecordV1Schema.parse(value),
      );
      await this.putResourceIdempotently(
        "execution",
        context.executionId,
        executionRecord,
        (value) => VNextSemanticExecutionRecordV1Schema.parse(value),
      );
      context.terminalPersisted = true;
      this.#active.delete(context.runtimeId);
      return this.runtimeOutput(context);
    })();
    context.terminalPromise = persistence;
    return persistence.catch((error: unknown) => {
      context.terminalPromise = undefined;
      throw error;
    });
  }

  private async putResourceIdempotently<T>(
    kind: "runtime" | "execution",
    resourceId: string,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<void> {
    try {
      const existing = await this.options.runtimeStore.readResource(
        kind,
        resourceId,
        parse,
      );
      if (contentHash(json(existing)) !== contentHash(json(value))) {
        throw new Error("semantic terminal resource identity collision");
      }
      return;
    } catch (error) {
      if (!(error instanceof ArtifactNotFoundError)) throw error;
    }
    await this.options.runtimeStore.putResourceOnce(
      kind,
      resourceId,
      value,
      parse,
    );
  }

  private async recordObservation(
    context: ActiveSemanticRuntime,
    source: VNextSemanticObservationEventV1["source"],
    receipt: GodotSemanticObservationReceiptV1,
  ): Promise<void> {
    if (context.events.length >= 4096) {
      throw new SemanticToolError(
        "budget_exhausted",
        "Semantic event limit reached",
        false,
      );
    }
    const projection = receipt.sample.projection;
    const event = VNextSemanticObservationEventV1Schema.parse({
      schemaVersion: 1,
      eventKind: "semantic_observation",
      taskId: this.options.taskId,
      executionId: context.executionId,
      runtimeId: context.runtimeId,
      buildId: context.build.build.buildId,
      sequence: context.events.length,
      source,
      hostMonotonicStartUs: receipt.hostMonotonicStartUs,
      hostMonotonicEndUs: receipt.hostMonotonicEndUs,
      projectionSha256: asSha256DigestV1(contentHash(projection)),
      projection,
    });
    await this.options.runtimeStore.appendExecutionEvent(
      context.executionId,
      event,
      (value) => VNextSemanticObservationEventV1Schema.parse(value),
    );
    context.events.push(event);
    context.latest = receipt;
  }

  private async checkpoint(runtimeId: string) {
    const context = this.requireRunning(runtimeId);
    const observed = await context.client.checkpoint();
    await this.recordObservation(context, "checkpoint", observed);
    const checkpointId = asCheckpointId(
      `checkpoint:semantic:${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    );
    const projection = observed.sample.projection;
    const payload = VNextSemanticCheckpointPayloadV1Schema.parse({
      schemaVersion: 1,
      taskId: this.options.taskId,
      checkpointId,
      executionId: context.executionId,
      runtimeId: context.runtimeId,
      buildId: context.build.build.buildId,
      adapterId: asAdapterId(`adapter:${this.options.adapterProfileSha256}`),
      adapterProfileSha256: this.options.adapterProfileSha256,
      semanticBarrier: "adapter_process_tail",
      projection,
      projectionSha256: asSha256DigestV1(contentHash(projection)),
      capturedDomains: [
        "subject.configuration",
        "spawned_entities",
        "timer.configuration",
        "timer.runtime",
      ],
      uncontrolledDomains: [
        "scene_private_state",
        "signals_and_callables",
        "rng",
        "rendering",
        "audio",
        "external_state",
        "pending_engine_work",
      ],
      restoreDependencyOrder: [
        "subject.configuration",
        "spawned_entities",
        "timer.configuration",
        "timer.runtime",
      ],
      fidelity: "descriptive_only",
      equivalentForkEligible: false,
    });
    const resource = VNextSemanticCheckpointResourceV1Schema.parse({
      schemaVersion: 1,
      resourceKind: "semantic_checkpoint",
      checkpointId,
      payload,
    });
    const bytes = Buffer.byteLength(JSON.stringify(resource), "utf8");
    if (bytes > 1_048_576)
      throw new SemanticToolError(
        "budget_exhausted",
        "Semantic checkpoint exceeds its byte limit",
        false,
      );
    await this.options.runtimeStore.putResourceOnce(
      "checkpoint",
      checkpointId,
      resource,
      (value) => VNextSemanticCheckpointResourceV1Schema.parse(value),
    );
    return {
      schemaVersion: 1,
      checkpoint: {
        schemaVersion: 1,
        checkpointId,
        taskId: this.options.taskId,
        executionId: context.executionId,
        runtimeId: context.runtimeId,
        buildId: context.build.build.buildId,
        adapterId: payload.adapterId,
        stateSchemaVersion: "chronorift.timer-spawn:v1",
        semanticBarrier: "adapter_process_tail",
        capturedAt: semanticClock(observed),
        payloadSha256: asSha256DigestV1(contentHash(resource)),
        payloadBytes: bytes,
        capturedDomains: payload.capturedDomains,
        uncontrolledDomains: payload.uncontrolledDomains,
        fidelity: "descriptive_only",
        equivalentForkEligible: false,
      },
    };
  }

  private async readCheckpoint(checkpointId: string) {
    try {
      const resource = await this.options.runtimeStore.readResource(
        "checkpoint",
        checkpointId,
        (value) => VNextSemanticCheckpointResourceV1Schema.parse(value),
      );
      if (resource.payload.taskId !== this.options.taskId)
        throw new Error("task mismatch");
      return resource;
    } catch {
      throw new SemanticToolError(
        "resource_not_found",
        "Semantic checkpoint was not found",
        false,
      );
    }
  }

  private async restore(runtimeId: string, checkpointId: string) {
    const context = this.requireRunning(runtimeId);
    const resource = await this.readCheckpoint(checkpointId);
    if (
      resource.payload.buildId !== context.build.build.buildId ||
      resource.payload.adapterProfileSha256 !==
        this.options.adapterProfileSha256
    ) {
      throw new SemanticToolError(
        "checkpoint_incompatible",
        "Semantic checkpoint build or adapter is incompatible",
        false,
      );
    }
    const before = context.latest.sample.projection;
    const restored = await context.client.restore(resource.payload.projection);
    await this.recordObservation(context, "restore", restored);
    return {
      schemaVersion: 1,
      checkpointId: resource.checkpointId,
      runtimeId: context.runtimeId,
      status: "partially_restored",
      projectionHashBefore: asSha256DigestV1(contentHash(before)),
      projectionHashAfter: asSha256DigestV1(
        contentHash(restored.sample.projection),
      ),
      equivalence: "registered_state_restored_but_equivalence_unestablished",
      fidelity: "descriptive_only",
      equivalentForkEligible: false,
      limitations: [...new Set([...LIMITATIONS, ...restored.limitations])],
    };
  }

  private async query(input: Record<string, unknown>) {
    const source = input["source"] as {
      kind: "runtime" | "execution";
      runtimeId?: string;
      executionId?: string;
    };
    const events =
      source.kind === "runtime"
        ? [...this.requireRuntime(String(source.runtimeId)).events]
        : await this.readExecutionEvents(String(source.executionId));
    const cursor = input["cursor"] === undefined ? 0 : Number(input["cursor"]);
    const limit = Number(input["limit"]);
    const selected = events.slice(cursor, cursor + limit);
    const view = String(input["view"]);
    const rows: unknown[] = [];
    let consumedEvents = 0;
    for (const event of selected) {
      const available = limit - rows.length;
      rows.push(...this.rowsForEvent(event, view).slice(0, available));
      consumedEvents += 1;
      if (rows.length >= limit) break;
    }
    const next =
      cursor + consumedEvents < events.length
        ? String(cursor + consumedEvents)
        : null;
    return {
      schemaVersion: 1,
      indexId: `index:semantic:${source.kind}:${source.runtimeId ?? source.executionId}`,
      executionId: events[0]?.executionId ?? (source.executionId as string),
      rows,
      coverage: coverage(events.length),
      loss: loss(),
      incomplete: true,
      nextCursor: next,
    };
  }

  private rowsForEvent(
    event: VNextSemanticObservationEventV1,
    view: string,
  ): unknown[] {
    const clock = {
      ...event.projection.capturedAt,
      hostMonotonicUs: Math.floor(
        (event.hostMonotonicStartUs + event.hostMonotonicEndUs) / 2,
      ),
    };
    if (view === "entities") {
      return event.projection.entities.map((entity) => ({
        sequence: event.sequence,
        clock,
        kind: "entity_lifecycle",
        entity: {
          stableId: entity.stableId,
          incarnation: entity.incarnation,
          role: "spawned_entity",
          scene: entity.scene,
          spawnOrdinal: entity.spawnOrdinal,
        },
        statePath: null,
        value: json(entity),
      }));
    }
    if (view === "clocks") {
      return [
        {
          sequence: event.sequence,
          clock,
          kind: "clock",
          entity: null,
          statePath: null,
          value: json(clock),
        },
      ];
    }
    if (view === "coverage") return [];
    return [
      {
        sequence: event.sequence,
        clock,
        kind: view === "events" ? "event" : "state",
        entity: null,
        statePath: view === "state" ? "projection" : null,
        value: json(event.projection),
      },
    ];
  }

  private async readExecutionEvents(
    executionId: string,
  ): Promise<readonly VNextSemanticObservationEventV1[]> {
    try {
      const events = await this.options.runtimeStore.readExecutionEvents(
        executionId,
        (value) => VNextSemanticObservationEventV1Schema.parse(value),
      );
      if (events.some((event) => event.taskId !== this.options.taskId))
        throw new Error("task mismatch");
      return events;
    } catch {
      throw new SemanticToolError(
        "resource_not_found",
        "Semantic execution was not found",
        false,
      );
    }
  }

  private async traceCreate(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const context = this.requireRunning(String(input["runtimeId"]));
    const domain = input["clockDomain"] as "process_frame" | "physics_tick";
    const offsets = [...(input["sampleOffsets"] as number[])].sort(
      (a, b) => a - b,
    );
    const originReceipt = await context.client.status();
    await this.recordObservation(context, "trace", originReceipt);
    const origin = semanticClock(originReceipt);
    const start =
      domain === "process_frame" ? origin.processFrame : origin.physicsTick;
    const samples = [];
    for (const [sequence, requestedOffset] of offsets.entries()) {
      let observed = originReceipt;
      for (;;) {
        if (signal?.aborted)
          throw new SemanticToolError(
            "operation_failed",
            "Semantic trace was aborted",
            true,
          );
        observed = await context.client.status();
        const position =
          domain === "process_frame"
            ? observed.sample.projection.capturedAt.processFrame
            : observed.sample.projection.capturedAt.physicsTick;
        if (position >= start + requestedOffset) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await this.recordObservation(context, "trace", observed);
      const realized =
        (domain === "process_frame"
          ? observed.sample.projection.capturedAt.processFrame
          : observed.sample.projection.capturedAt.physicsTick) - start;
      samples.push({
        schemaVersion: 1,
        sequence,
        requestedOffset,
        realizedOffset: realized,
        quantized: realized !== requestedOffset,
        clock: {
          ...observed.sample.projection.capturedAt,
          hostMonotonicUs: semanticClock(observed).hostMonotonicUs,
        },
        projectionSha256: asSha256DigestV1(
          contentHash(observed.sample.projection),
        ),
        projection: observed.sample.projection,
      });
    }
    const traceId = asTraceId(
      `trace:semantic:${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    );
    const trace = VNextSemanticTraceV1Schema.parse({
      schemaVersion: 1,
      traceKind: "semantic_observation_trace",
      taskId: this.options.taskId,
      traceId,
      sourceExecutionId: context.executionId,
      sourceRuntimeId: context.runtimeId,
      sourceBuildId: context.build.build.buildId,
      adapterId: asAdapterId(`adapter:${this.options.adapterProfileSha256}`),
      adapterProfileSha256: this.options.adapterProfileSha256,
      clockDomain: domain,
      origin: {
        ...originReceipt.sample.projection.capturedAt,
        hostMonotonicUs: origin.hostMonotonicUs,
      },
      samples,
    });
    await this.options.runtimeStore.putResourceOnce(
      "trace",
      traceId,
      trace,
      (value) => VNextSemanticTraceV1Schema.parse(value),
    );
    return { schemaVersion: 1, trace: this.traceOutput(trace) };
  }

  private traceOutput(trace: VNextSemanticTraceV1) {
    return {
      schemaVersion: 1,
      traceId: trace.traceId,
      taskId: trace.taskId,
      sourceExecutionId: trace.sourceExecutionId,
      sourceRuntimeId: trace.sourceRuntimeId,
      sourceBuildId: trace.sourceBuildId,
      adapterId: trace.adapterId,
      clockDomain: trace.clockDomain,
      origin: trace.origin,
      samples: trace.samples.map((sample) => ({
        sequence: sample.sequence,
        requestedOffset: sample.requestedOffset,
        realizedOffset: sample.realizedOffset,
        quantized: sample.quantized,
        clock: sample.clock,
        projectionSha256: sample.projectionSha256,
        projection: sample.projection,
      })),
    };
  }

  private async readTrace(traceId: string): Promise<VNextSemanticTraceV1> {
    try {
      const trace = await this.options.runtimeStore.readResource(
        "trace",
        traceId,
        (value) => VNextSemanticTraceV1Schema.parse(value),
      );
      if (
        trace.taskId !== this.options.taskId ||
        trace.adapterProfileSha256 !== this.options.adapterProfileSha256
      )
        throw new Error("mismatch");
      return trace;
    } catch {
      throw new SemanticToolError(
        "trace_unavailable",
        "Semantic trace was not found",
        false,
      );
    }
  }

  private async traceReplay(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const context = this.requireRunning(String(input["runtimeId"]));
    const trace = await this.readTrace(String(input["traceId"]));
    const maxTicks = Number(input["maxTicks"]);
    const originReceipt = await context.client.status();
    const originPosition =
      trace.clockDomain === "process_frame"
        ? originReceipt.sample.projection.capturedAt.processFrame
        : originReceipt.sample.projection.capturedAt.physicsTick;
    const realizedSamples = [];
    let firstDivergence: {
      sequence: number;
      subject: string;
      expected: JsonValue;
      observed: JsonValue;
    } | null = null;
    for (const expected of trace.samples) {
      if (expected.requestedOffset > maxTicks) break;
      let observed = originReceipt;
      for (;;) {
        if (signal?.aborted)
          throw new SemanticToolError(
            "operation_failed",
            "Semantic replay was aborted",
            true,
          );
        observed = await context.client.status();
        const position =
          trace.clockDomain === "process_frame"
            ? observed.sample.projection.capturedAt.processFrame
            : observed.sample.projection.capturedAt.physicsTick;
        if (position >= originPosition + expected.requestedOffset) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await this.recordObservation(context, "trace", observed);
      const position =
        (trace.clockDomain === "process_frame"
          ? observed.sample.projection.capturedAt.processFrame
          : observed.sample.projection.capturedAt.physicsTick) - originPosition;
      const projectionSha256 = asSha256DigestV1(
        contentHash(observed.sample.projection),
      );
      realizedSamples.push({
        ...expected,
        realizedOffset: position,
        quantized: position !== expected.requestedOffset,
        projectionSha256,
        projection: observed.sample.projection,
        clock: {
          ...observed.sample.projection.capturedAt,
          hostMonotonicUs: semanticClock(observed).hostMonotonicUs,
        },
      });
      if (
        firstDivergence === null &&
        projectionSha256 !== expected.projectionSha256
      ) {
        firstDivergence = {
          sequence: expected.sequence,
          subject: "timer_spawn_projection",
          expected: json(expected.projection),
          observed: json(observed.sample.projection),
        };
      }
    }
    return {
      schemaVersion: 1,
      trace: this.traceOutput(trace),
      targetExecutionId: context.executionId,
      mode:
        trace.sourceBuildId === context.build.build.buildId
          ? "same_build_projection_replay"
          : "descriptive_only",
      status:
        realizedSamples.length === trace.samples.length
          ? "completed"
          : "stopped",
      firstDivergence,
      limitations: [...LIMITATIONS],
    };
  }

  private async fork(input: Record<string, unknown>, signal?: AbortSignal) {
    const source = input["source"] as {
      kind: string;
      workspaceId?: string;
      buildId?: string;
      executionId?: string;
      checkpointId?: string;
    };
    const build = await this.prepareBuild();
    if (
      input["targetBuildId"] !== undefined &&
      input["targetBuildId"] !== build.build.buildId
    ) {
      throw new SemanticToolError(
        "resource_not_found",
        "Fork target build was not found",
        false,
      );
    }
    let checkpointId = input["checkpointId"] as string | undefined;
    if (source.kind === "checkpoint") checkpointId = source.checkpointId;
    let sourceExecutionId: string | null =
      source.kind === "execution" ? String(source.executionId) : null;
    if (
      source.kind === "workspace" &&
      source.workspaceId !== this.options.workspaceId
    )
      throw new SemanticToolError(
        "resource_not_found",
        "Fork workspace was not found",
        false,
      );
    if (source.kind === "build" && source.buildId !== build.build.buildId)
      throw new SemanticToolError(
        "resource_not_found",
        "Fork build was not found",
        false,
      );
    if (sourceExecutionId !== null)
      await this.readExecutionEvents(sourceExecutionId);
    const child = await this.launchContext(build, signal);
    let mode: "fresh" | "checkpoint_projection_restore" | "fresh_trace_replay" =
      "fresh";
    if (checkpointId !== undefined) {
      await this.restore(child.runtimeId, checkpointId);
      mode = "checkpoint_projection_restore";
      const checkpoint = await this.readCheckpoint(checkpointId);
      sourceExecutionId ??= checkpoint.payload.executionId;
    }
    const traceId = input["traceId"] as string | undefined;
    if (traceId !== undefined) {
      await this.traceReplay(
        { runtimeId: child.runtimeId, traceId, maxTicks: 600 },
        signal,
      );
      mode = "fresh_trace_replay";
    }
    const branchId = asBranchId(
      `branch:semantic:${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    );
    const resource = VNextSemanticBranchResourceV1Schema.parse({
      schemaVersion: 1,
      resourceKind: "semantic_branch",
      taskId: this.options.taskId,
      branchId,
      sourceExecutionId,
      childExecutionId: child.executionId,
      childRuntimeId: child.runtimeId,
      targetBuildId: build.build.buildId,
      checkpointId: checkpointId ?? null,
      traceId: traceId ?? null,
      mode,
      fidelity: "descriptive_only",
      limitations: [...LIMITATIONS],
    });
    await this.options.runtimeStore.putResourceOnce(
      "branch",
      branchId,
      resource,
      (value) => VNextSemanticBranchResourceV1Schema.parse(value),
    );
    return {
      schemaVersion: 1,
      branchId,
      childRuntimeId: child.runtimeId,
      childExecutionId: child.executionId,
      mode,
      fidelity: "descriptive_only",
      checkpointId: checkpointId ?? null,
      traceId: traceId ?? null,
      limitations: [...LIMITATIONS],
    };
  }

  private async compare(input: Record<string, unknown>) {
    const baselineExecutionId = String(input["baselineExecutionId"]);
    const candidateExecutionId = String(input["candidateExecutionId"]);
    const maximum = Number(input["maxDifferences"]);
    const [baseline, candidate] = await Promise.all([
      this.readExecutionEvents(baselineExecutionId),
      this.readExecutionEvents(candidateExecutionId),
    ]);
    const differences: JsonValue[] = [];
    let firstDivergenceSequence: number | null = null;
    const count = Math.min(baseline.length, candidate.length);
    for (
      let sequence = 0;
      sequence < count && differences.length < maximum;
      sequence += 1
    ) {
      const left = baseline[sequence]!;
      const right = candidate[sequence]!;
      if (left.projectionSha256 === right.projectionSha256) continue;
      firstDivergenceSequence ??= sequence;
      differences.push(
        json({
          category: "state",
          subject: "timer_spawn_projection",
          baseline: left.projection,
          candidate: right.projection,
          clock: {
            ...right.projection.capturedAt,
            hostMonotonicUs: Math.floor(
              (right.hostMonotonicStartUs + right.hostMonotonicEndUs) / 2,
            ),
          },
        }),
      );
    }
    if (baseline.length !== candidate.length && differences.length < maximum) {
      firstDivergenceSequence ??= count;
      differences.push(
        json({
          category: "event",
          subject: "observation_count",
          baseline: baseline.length,
          candidate: candidate.length,
          clock: null,
        }),
      );
    }
    const comparisonId = asComparisonId(
      `comparison:semantic:${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    );
    const confounders = [
      ...(baseline[0]?.buildId === candidate[0]?.buildId
        ? []
        : ["build_identity_changed"]),
      "endpoint_sampling",
      "uncontrolled_project_state",
    ];
    const resource = VNextSemanticComparisonResourceV1Schema.parse({
      schemaVersion: 1,
      resourceKind: "semantic_comparison",
      taskId: this.options.taskId,
      comparisonId,
      baselineExecutionId,
      candidateExecutionId,
      mode: confounders.includes("build_identity_changed")
        ? "confounded"
        : "descriptive_only",
      alignment:
        count === 0
          ? "unavailable"
          : baseline.length === candidate.length
            ? "aligned"
            : "partial",
      differences,
      firstDivergenceSequence,
      confounders,
      limitations: [...LIMITATIONS],
    });
    await this.options.runtimeStore.putResourceOnce(
      "comparison",
      comparisonId,
      resource,
      (value) => VNextSemanticComparisonResourceV1Schema.parse(value),
    );
    return {
      schemaVersion: 1,
      comparisonId: resource.comparisonId,
      baselineExecutionId: resource.baselineExecutionId,
      candidateExecutionId: resource.candidateExecutionId,
      mode: resource.mode,
      alignment: resource.alignment,
      differences,
      firstDivergenceSequence: resource.firstDivergenceSequence,
      confounders: resource.confounders,
      limitations: resource.limitations,
    };
  }

  private requireRuntime(runtimeId: string): ActiveSemanticRuntime {
    const context = this.#active.get(runtimeId as RuntimeId);
    if (context === undefined)
      throw new SemanticToolError(
        "resource_not_found",
        "Semantic runtime was not found",
        false,
      );
    return context;
  }

  private requireRunning(runtimeId: string): ActiveSemanticRuntime {
    const context = this.requireRuntime(runtimeId);
    if (context.state !== "running")
      throw new SemanticToolError(
        "runtime_unavailable",
        "Semantic runtime is not running",
        false,
      );
    return context;
  }

  private failure(
    toolCallId: string,
    code: VNextGameToolErrorCodeV1,
    message: string,
    recoverable: boolean,
  ): SemanticToolResponse {
    return {
      schemaVersion: 1,
      toolCallId,
      outcome: "error",
      error: { code, message, recoverable },
    };
  }
}

class SemanticToolError extends Error {
  public constructor(
    public readonly code:
      | "invalid_request"
      | "resource_not_found"
      | "resource_task_mismatch"
      | "budget_exhausted"
      | "runtime_unavailable"
      | "checkpoint_incompatible"
      | "trace_unavailable"
      | "operation_failed",
    public readonly publicMessage: string,
    public readonly recoverable: boolean,
  ) {
    super(publicMessage);
  }
}

export const createExternalGodotSemanticCoordinator = (
  options: ExternalGodotSemanticCoordinatorOptions,
): ExternalGodotSemanticCoordinator =>
  new ExternalGodotSemanticCoordinator(options);
