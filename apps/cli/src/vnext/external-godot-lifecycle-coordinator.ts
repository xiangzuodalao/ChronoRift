import { randomUUID } from "node:crypto";

import {
  LIFECYCLE_GAME_TOOL_NAMES_V1,
  LIFECYCLE_UNSUPPORTED_GAME_CAPABILITIES_V1,
  LifecycleGameStatusOutputV2Schema,
  validateLifecycleGameToolInputV2,
  validateLifecycleGameToolOutputV2,
  type LifecycleGameToolNameV1,
  type LifecycleRuntimeFactsV2,
} from "@chronorift/agent-protocol";
import {
  VNextBuildV1Schema,
  VNextLifecycleExecutionManifestV1Schema,
  VNextLifecycleExecutionRecordV1Schema,
  VNextLifecyclePhaseReceiptV1Schema,
  VNextRawRuntimeEventV1Schema,
  VNextRuntimeV1Schema,
  asAdapterId,
  asEventId,
  asExecutionId,
  asProbeId,
  asRuntimeId,
  asSha256DigestV1,
  lifecycleCleanupProven,
  lifecycleRequiredCleanupProven,
  type ExecutionId,
  type JsonObject,
  type JsonValue,
  type RuntimeId,
  type Sha256DigestV1,
  type TaskId,
  type VNextCaptureCoverageV1,
  type VNextCaptureLossV1,
  type VNextLifecycleCleanupReceiptV1,
  type VNextLifecycleExecutionManifestV1,
  type VNextLifecycleExecutionRecordV1,
  type VNextLifecyclePhaseReceiptV1,
  type VNextRawRuntimeEventV1,
  type VNextRuntimeV1,
  type WorkspaceId,
} from "@chronorift/domain";
import {
  ArtifactNotFoundError,
  contentHash,
  type RuntimeExecutionSealV1,
} from "@chronorift/json-artifacts";
import type {
  VNextLifecycleGameToolPort,
  VNextLifecycleGameToolPortRequestV1,
} from "@chronorift/pi-harness";
import { Check } from "typebox/value";
import { z } from "zod";

import {
  prepareExternalGodotLifecycleBuildV1,
  type PreparedExternalGodotLifecycleBuildV1,
} from "./candidate-godot-build.js";
import type { SandboxCleanupReceiptV1 } from "./contracts.js";
import {
  ExternalGodotLifecycleLaunchFailureV1,
  ExternalGodotLifecycleDiagnosticChunkV1Schema,
  type ExternalGodotLifecycleDiagnosticChunkV1,
  type ExternalGodotLifecycleLaunchFailureReceiptV1,
} from "./external-godot-lifecycle-driver.js";

type RuntimeResourceKind =
  | "build"
  | "runtime"
  | "execution"
  | "capture"
  | "checkpoint"
  | "trace"
  | "branch"
  | "index"
  | "comparison"
  | "tool-call";

export interface ExternalGodotLifecycleCoordinatorStore {
  putResourceOnce<T>(
    kind: RuntimeResourceKind,
    resourceId: string,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<void>;
  readResource<T>(
    kind: RuntimeResourceKind,
    resourceId: string,
    parse: (input: unknown) => T,
  ): Promise<T>;
  appendExecutionEvent<T>(
    executionId: string,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<unknown>;
  readExecutionEvents<T>(
    executionId: string,
    parse: (input: unknown) => T,
  ): Promise<readonly T[]>;
  sealExecution(executionId: string): Promise<RuntimeExecutionSealV1>;
}

export interface ExternalGodotProjectCapabilityForRuntimeV1 {
  readonly declaredSourceUrl: string;
  readonly sourceRevision: string;
  readonly baselineSelectedTreeSha256: Sha256DigestV1;
  readonly descriptorSha256: Sha256DigestV1;
  readonly capabilitySha256: Sha256DigestV1;
}

export interface ManagedExternalGodotLifecycleRuntimeForCoordinatorV1 {
  readonly managedRuntimeId: string;
  readonly addonHash: Sha256DigestV1;
  readonly overlayHash: Sha256DigestV1;
  readonly vanillaSidecarSourceSha256: Sha256DigestV1;
  readonly lifecycleSidecarSourceSha256: Sha256DigestV1;
  readonly protocolProfile: "chronorift-godot-lifecycle-v1";
}

export interface ExternalGodotLifecycleDriverSnapshotV1 {
  readonly facts: LifecycleRuntimeFactsV2;
  readonly phases: readonly VNextLifecyclePhaseReceiptV1[];
  readonly diagnostics: readonly ExternalGodotLifecycleDiagnosticChunkV1[];
  readonly coverage: readonly VNextCaptureCoverageV1[];
  readonly loss: readonly VNextCaptureLossV1[];
}

export interface ExternalGodotLifecycleDriverStopV1 extends ExternalGodotLifecycleDriverSnapshotV1 {
  readonly cleanup: VNextLifecycleCleanupReceiptV1;
}

export interface ExternalGodotLifecycleSessionV1 {
  readonly initial: ExternalGodotLifecycleDriverSnapshotV1;
  status(signal?: AbortSignal): Promise<ExternalGodotLifecycleDriverSnapshotV1>;
  stop(signal?: AbortSignal): Promise<ExternalGodotLifecycleDriverStopV1>;
}

export interface ExternalGodotLifecycleDriverV1 {
  launch(
    request: {
      readonly taskId: TaskId;
      readonly runtimeId: RuntimeId;
      readonly executionId: ExecutionId;
      readonly workspaceDirectory: string;
      readonly prepared: PreparedExternalGodotLifecycleBuildV1;
      readonly managedRuntime: ManagedExternalGodotLifecycleRuntimeForCoordinatorV1;
      readonly token: string;
    },
    signal?: AbortSignal,
  ): Promise<ExternalGodotLifecycleSessionV1>;
}

export interface ExternalGodotLifecycleCoordinatorOptionsV1 {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly workspaceDirectory: string;
  readonly baselineSourceHash: Sha256DigestV1;
  readonly projectCapability: ExternalGodotProjectCapabilityForRuntimeV1;
  readonly managedRuntime: ManagedExternalGodotLifecycleRuntimeForCoordinatorV1;
  readonly driver: ExternalGodotLifecycleDriverV1;
  readonly runtimeStore: ExternalGodotLifecycleCoordinatorStore;
}

export interface ExternalGodotLifecycleCoordinatorDependenciesV1 {
  readonly now?: () => string;
  readonly nextId?: (kind: "runtime" | "execution" | "event") => string;
  readonly nextToken?: () => string;
  readonly prepareBuild?: typeof prepareExternalGodotLifecycleBuildV1;
}

export interface ExternalGodotLifecycleCoordinatorV1 extends VNextLifecycleGameToolPort {
  invoke(
    request: VNextLifecycleGameToolPortRequestV1,
    signal?: AbortSignal,
  ): Promise<CoordinatorToolResponse>;
  reconcileSandboxCleanup(cleanup: SandboxCleanupReceiptV1): Promise<void>;
  close(): Promise<void>;
}

type ToolErrorCode =
  | "unsupported_capability"
  | "invalid_request"
  | "resource_not_found"
  | "resource_task_mismatch"
  | "busy"
  | "conflict"
  | "budget_exhausted"
  | "runtime_crashed"
  | "runtime_unavailable"
  | "operation_failed";

type CoordinatorToolResponse =
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
        readonly code: ToolErrorCode;
        readonly message: string;
        readonly recoverable: boolean;
        readonly details?: JsonValue | undefined;
      };
    };

class ToolFailure extends Error {
  public constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly recoverable: boolean,
    public readonly details?: JsonValue,
  ) {
    super(message);
  }
}

type LifecycleLaunchFailureStage =
  ExternalGodotLifecycleLaunchFailureReceiptV1["stage"] | "session_validation";

type RawLifecycleEventClockV1 = {
  readonly basis:
    "sampled_observation" | "last_sample_before_ingest" | "unavailable";
  readonly processFrame: number;
  readonly physicsTick: number;
  readonly simulationTimeUs: number;
  readonly hostMonotonicUs: number;
};

const json = <T>(value: T): JsonValue => value as JsonValue;

const success = (
  toolCallId: string,
  output: unknown,
): CoordinatorToolResponse => ({
  schemaVersion: 1,
  toolCallId,
  outcome: "success",
  output: json(output),
});

const failure = (
  toolCallId: string,
  code: ToolErrorCode,
  message: string,
  recoverable: boolean,
  details?: JsonValue,
): CoordinatorToolResponse => ({
  schemaVersion: 1,
  toolCallId,
  outcome: "error",
  error: {
    code,
    message: message.slice(0, 4_096),
    recoverable,
    ...(details === undefined ? {} : { details }),
  },
});

const StoredLifecycleToolCallV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    toolCallId: z.string().min(1).max(256),
    toolName: z.string().min(1).max(128),
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }),
    input: z.unknown(),
    response: z.unknown(),
  })
  .strict();

interface RuntimeContext {
  readonly runtimeId: RuntimeId;
  readonly executionId: ExecutionId;
  readonly prepared: PreparedExternalGodotLifecycleBuildV1;
  readonly session: ExternalGodotLifecycleSessionV1 | null;
  readonly launchFailureStage: LifecycleLaunchFailureStage | null;
  manifest: VNextLifecycleExecutionManifestV1;
  runtime: VNextRuntimeV1;
  facts: LifecycleRuntimeFactsV2;
  phases: VNextLifecyclePhaseReceiptV1[];
  events: VNextRawRuntimeEventV1[];
  pendingEvents: VNextRawRuntimeEventV1[];
  coverage: VNextCaptureCoverageV1[];
  loss: VNextCaptureLossV1[];
  diagnosticChunks: Map<string, ExternalGodotLifecycleDiagnosticChunkV1>;
  stopApplication: {
    readonly stopped: ExternalGodotLifecycleDriverStopV1;
    eventsScheduled: boolean;
  } | null;
  reconciliationApplication: {
    readonly phase: VNextLifecyclePhaseReceiptV1;
    readonly cleanup: VNextLifecycleCleanupReceiptV1;
    eventsScheduled: boolean;
  } | null;
  sealed: boolean;
  terminalPersistence: {
    readonly runtime: VNextRuntimeV1;
    readonly record: Extract<
      VNextLifecycleExecutionRecordV1,
      { readonly sealed: true }
    >;
  } | null;
}

const toolCapabilities = Object.freeze([
  { name: "game_capabilities", capability: "game.capabilities.read" },
  { name: "game_launch", capability: "game.runtime.launch" },
  { name: "game_status", capability: "game.runtime.status" },
  { name: "game_stop", capability: "game.runtime.stop" },
] as const);

const cleanupForOutput = (cleanup: VNextLifecycleCleanupReceiptV1) => ({
  processGroupTerminated: cleanup.processGroupTerminated,
  godotExited: cleanup.godotExited,
  sidecarExited: cleanup.sidecarExited,
  cgroupEmpty: cleanup.cgroupEmpty,
  scopeRemoved: cleanup.scopeRemoved,
  scratchRemoved: cleanup.scratchRemoved,
  storageReconciled: cleanup.storageReconciled,
});

const phaseForOutput = (phase: VNextLifecyclePhaseReceiptV1) => ({
  sequence: phase.sequence,
  phase: phase.phase,
  operationState: phase.operationState,
  timingFidelity: phase.timingFidelity,
  processDurationMs: phase.processDurationMs,
  stabilityObservedMs: phase.stabilityObservedMs,
  outcome: phase.outcome,
  hostMonotonicStartUs: phase.hostMonotonicStartUs,
  hostMonotonicEndUs: phase.hostMonotonicEndUs,
  stdoutTruncated: phase.stdout.truncated,
  stderrTruncated: phase.stderr.truncated,
  cleanupProven:
    phase.cleanup !== null && lifecycleCleanupProven(phase.cleanup),
});

const sampledEventClock = (
  facts: LifecycleRuntimeFactsV2,
): RawLifecycleEventClockV1 => ({
  basis: "sampled_observation",
  processFrame: facts.clocks.processFrame,
  physicsTick: facts.clocks.physicsTick,
  simulationTimeUs: facts.clocks.simulationTimeUs,
  hostMonotonicUs: facts.clocks.hostMonotonicUs,
});

const lastSampleEventClock = (
  facts: LifecycleRuntimeFactsV2,
): RawLifecycleEventClockV1 => ({
  basis:
    facts.engine.version === "unavailable"
      ? "unavailable"
      : "last_sample_before_ingest",
  processFrame: facts.clocks.processFrame,
  physicsTick: facts.clocks.physicsTick,
  simulationTimeUs: facts.clocks.simulationTimeUs,
  hostMonotonicUs: facts.clocks.hostMonotonicUs,
});

const supportedCaptureChannel = (
  channel: string,
): channel is "clock" | "log" | "error" | "probe" =>
  channel === "clock" ||
  channel === "log" ||
  channel === "error" ||
  channel === "probe";

const runtimeFactsForOutput = (
  facts: LifecycleRuntimeFactsV2,
  coverage: readonly VNextCaptureCoverageV1[],
  loss: readonly VNextCaptureLossV1[],
): LifecycleRuntimeFactsV2 => ({
  ...facts,
  coverage: coverage
    .filter((entry) => supportedCaptureChannel(entry.channel))
    .map((entry) => ({
      channel: entry.channel as "clock" | "log" | "error" | "probe",
      status:
        entry.status === "full"
          ? "full"
          : entry.status === "unavailable"
            ? "unavailable"
            : "partial",
      emittedRecords: entry.emittedRecords,
      droppedRecords: entry.droppedRecords + entry.overwrittenRecords,
      limitations: [...entry.limitations],
    })),
  loss: loss
    .filter((entry) => supportedCaptureChannel(entry.channel))
    .map((entry) => ({
      channel: entry.channel as "clock" | "log" | "error" | "probe",
      kind:
        entry.kind === "unavailable"
          ? "unavailable"
          : entry.kind === "observer_effect"
            ? "observer_effect"
            : entry.kind === "dropped" || entry.kind === "overwritten"
              ? "dropped"
              : entry.kind === "sampled" || entry.kind === "degraded"
                ? "unavailable"
                : "truncated",
      count: entry.count,
      reason: entry.reason,
    })),
});

const normalizePhases = (
  existingLength: number,
  phases: readonly VNextLifecyclePhaseReceiptV1[],
): VNextLifecyclePhaseReceiptV1[] =>
  phases.map((phase, index) => ({
    ...phase,
    sequence: existingLength + index,
  }));

const preparedBuildIdentity = (
  prepared: PreparedExternalGodotLifecycleBuildV1,
) => {
  const { createdAt, ...build } = prepared.build;
  void createdAt;
  return {
    build,
    configuredMainScene: prepared.configuredMainScene,
    projectHash: prepared.projectHash,
    descriptorHash: prepared.descriptorHash,
    overlayHash: prepared.overlayHash,
    addonHash: prepared.addonHash,
    vanillaSidecarHash: prepared.vanillaSidecarHash,
    lifecycleSidecarHash: prepared.lifecycleSidecarHash,
    fileCount: prepared.fileCount,
    byteLength: prepared.byteLength,
  };
};

const assertSnapshotFacts = (
  context: Pick<RuntimeContext, "runtimeId" | "executionId" | "prepared">,
  snapshot: ExternalGodotLifecycleDriverSnapshotV1,
): void => {
  const facts = snapshot.facts;
  if (
    facts.runtimeId !== context.runtimeId ||
    facts.executionId !== context.executionId ||
    facts.buildId !== context.prepared.build.buildId ||
    facts.configuredScene !== context.prepared.configuredMainScene
  ) {
    throw new ToolFailure(
      "resource_task_mismatch",
      "lifecycle runtime facts do not match the admitted resources",
      false,
    );
  }
  if (
    !Check(LifecycleGameStatusOutputV2Schema, {
      schemaVersion: 2,
      runtime: runtimeFactsForOutput(facts, snapshot.coverage, snapshot.loss),
    })
  ) {
    throw new Error("lifecycle driver returned invalid runtime facts");
  }
  for (const chunk of snapshot.diagnostics) {
    ExternalGodotLifecycleDiagnosticChunkV1Schema.parse(chunk);
  }
};

const launchFailureFacts = (input: {
  readonly taskId: TaskId;
  readonly runtimeId: RuntimeId;
  readonly executionId: ExecutionId;
  readonly prepared: PreparedExternalGodotLifecycleBuildV1;
  readonly phases: readonly VNextLifecyclePhaseReceiptV1[];
  readonly coverage: readonly VNextCaptureCoverageV1[];
  readonly loss: readonly VNextCaptureLossV1[];
  readonly status: "failed" | "cleanup_pending";
  readonly now: string;
}): LifecycleRuntimeFactsV2 => {
  const observation = [...input.phases]
    .reverse()
    .find((phase) => phase.observation !== null)?.observation;
  const startedAt = input.phases[0]?.startedAt ?? input.now;
  const endedAt = input.phases.at(-1)?.endedAt ?? input.now;
  const stdoutTotalBytes = input.phases.reduce(
    (total, phase) => total + phase.stdout.totalBytes,
    0,
  );
  const stdoutRetainedObserved = input.phases.reduce(
    (total, phase) => total + phase.stdout.retainedBytes,
    0,
  );
  const stderrTotalBytes = input.phases.reduce(
    (total, phase) => total + phase.stderr.totalBytes,
    0,
  );
  const stderrRetainedObserved = input.phases.reduce(
    (total, phase) => total + phase.stderr.retainedBytes,
    0,
  );
  const hostMonotonicUs = Math.max(
    0,
    ...input.phases.map((phase) => phase.hostMonotonicEndUs),
  );
  const base: LifecycleRuntimeFactsV2 = {
    schemaVersion: 2,
    taskId: input.taskId,
    runtimeId: input.runtimeId,
    executionId: input.executionId,
    buildId: input.prepared.build.buildId,
    status: input.status,
    engine:
      observation === null || observation === undefined
        ? {
            version: "unavailable",
            build: "unavailable",
            platform: "unavailable",
            renderer: "unavailable",
            audioDriver: "unavailable",
            headless: true,
          }
        : {
            version: observation.engineVersion,
            build: observation.engineBuild,
            platform: observation.platform,
            renderer: observation.renderer,
            audioDriver: observation.audioDriver,
            headless: observation.headless,
          },
    configuredScene:
      observation?.configuredScene ?? input.prepared.configuredMainScene,
    currentScene: observation?.currentScene ?? "unavailable",
    clocks:
      observation === null || observation === undefined
        ? {
            processFrame: 0,
            physicsTick: 0,
            simulationTimeUs: 0,
            hostMonotonicUs,
            renderFrame: null,
            processFrameDelta: 0,
            physicsTickDelta: 0,
          }
        : {
            processFrame: observation.clock.processFrame,
            physicsTick: observation.clock.physicsTick,
            simulationTimeUs: observation.clock.simulationTimeUs,
            hostMonotonicUs: observation.clock.hostMonotonicUs,
            renderFrame: null,
            processFrameDelta: observation.processFrameDelta,
            physicsTickDelta: observation.physicsTickDelta,
          },
    coverage: [],
    loss: [],
    diagnostics: {
      stdoutTotalBytes,
      stdoutRetainedBytes: Math.min(1_048_576, stdoutRetainedObserved),
      stdoutTruncated:
        stdoutRetainedObserved > 1_048_576 ||
        input.phases.some((phase) => phase.stdout.truncated),
      stderrTotalBytes,
      stderrRetainedBytes: Math.min(1_048_576, stderrRetainedObserved),
      stderrTruncated:
        stderrRetainedObserved > 1_048_576 ||
        input.phases.some((phase) => phase.stderr.truncated),
    },
    startedAt,
    endedAt,
  };
  const facts = runtimeFactsForOutput(base, input.coverage, input.loss);
  if (
    !Check(LifecycleGameStatusOutputV2Schema, {
      schemaVersion: 2,
      runtime: facts,
    })
  ) {
    throw new Error("lifecycle launch failure returned invalid runtime facts");
  }
  return facts;
};

class ExternalGodotLifecycleCoordinator implements ExternalGodotLifecycleCoordinatorV1 {
  readonly #contexts = new Map<RuntimeId, RuntimeContext>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #now: () => string;
  readonly #nextId: (kind: "runtime" | "execution" | "event") => string;
  readonly #nextToken: () => string;
  readonly #prepareBuild: typeof prepareExternalGodotLifecycleBuildV1;
  #prepareQueue: Promise<void> = Promise.resolve();
  #latestPrepared: PreparedExternalGodotLifecycleBuildV1 | null = null;
  #phase: "open" | "closing" | "closed" = "open";
  #pendingLaunches = 0;
  #totalLaunches = 0;

  public constructor(
    private readonly options: ExternalGodotLifecycleCoordinatorOptionsV1,
    dependencies: ExternalGodotLifecycleCoordinatorDependenciesV1,
  ) {
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#nextId = dependencies.nextId ?? ((kind) => `${kind}:${randomUUID()}`);
    this.#nextToken =
      dependencies.nextToken ??
      (() => randomUUID().replaceAll("-", "").padEnd(64, "0"));
    this.#prepareBuild =
      dependencies.prepareBuild ?? prepareExternalGodotLifecycleBuildV1;
  }

  public async invoke(
    request: VNextLifecycleGameToolPortRequestV1,
    signal?: AbortSignal,
  ): Promise<CoordinatorToolResponse> {
    const startedAt = this.#now();
    let response: CoordinatorToolResponse;
    try {
      if (this.#phase !== "open") {
        throw new ToolFailure(
          "runtime_unavailable",
          "the lifecycle coordinator is closed",
          true,
        );
      }
      const requestedName = request.toolName as string;
      if (
        !LIFECYCLE_GAME_TOOL_NAMES_V1.includes(
          requestedName as LifecycleGameToolNameV1,
        )
      ) {
        throw new ToolFailure(
          "unsupported_capability",
          `${requestedName} is unavailable in the lifecycle-only profile`,
          true,
          json({ reason: "lifecycle_only_profile" }),
        );
      }
      if (!validateLifecycleGameToolInputV2(request.toolName, request.input)) {
        throw new ToolFailure(
          "invalid_request",
          `invalid input for ${request.toolName}`,
          true,
        );
      }
      const input = request.input as Record<string, unknown>;
      if (input["taskId"] !== this.options.taskId) {
        throw new ToolFailure(
          "resource_task_mismatch",
          "tool input does not belong to this Task",
          true,
        );
      }
      const output = await this.dispatch(request.toolName, input, signal);
      if (!validateLifecycleGameToolOutputV2(request.toolName, output)) {
        throw new Error(`invalid lifecycle output for ${request.toolName}`);
      }
      response = success(request.toolCallId, output);
    } catch (error) {
      response =
        error instanceof ToolFailure
          ? failure(
              request.toolCallId,
              error.code,
              error.message,
              error.recoverable,
              error.details,
            )
          : failure(
              request.toolCallId,
              "operation_failed",
              "lifecycle tool operation failed; Host diagnostics were withheld",
              false,
            );
    }
    await this.options.runtimeStore.putResourceOnce(
      "tool-call",
      request.toolCallId,
      {
        schemaVersion: 1,
        taskId: this.options.taskId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        startedAt,
        endedAt: this.#now(),
        input: request.input,
        response,
      },
      (value) => StoredLifecycleToolCallV1Schema.parse(value),
    );
    return response;
  }

  public async close(): Promise<void> {
    if (this.#phase === "closed") return;
    this.#phase = "closing";
    const results = await Promise.allSettled(
      [...this.#contexts.values()]
        .filter((context) => !context.sealed)
        .map((context) =>
          this.serialize(context.runtimeId, () =>
            context.session === null
              ? this.finalizeLaunchFailureContext(context)
              : this.stopContext(context),
          ),
        ),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected"
        ? [
            result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason)),
          ]
        : [],
    );
    if (failures.length > 0) {
      this.#phase = "open";
      throw new AggregateError(
        failures,
        "one or more lifecycle runtimes could not prove cleanup",
      );
    }
    this.#phase = "closed";
  }

  public async reconcileSandboxCleanup(
    cleanup: SandboxCleanupReceiptV1,
  ): Promise<void> {
    if (
      !cleanup.processGroupTerminated ||
      cleanup.cgroupPopulated ||
      !cleanup.scopeRemoved
    ) {
      throw new Error(
        "Task sandbox cleanup is insufficient to reconcile lifecycle operations",
      );
    }
    if (cleanup.storageReconciled !== true) {
      throw new Error(
        "Task sandbox cleanup omitted a proven storage reconciliation observation",
      );
    }
    const results = await Promise.allSettled(
      [...this.#contexts.values()]
        .filter((context) => !context.sealed)
        .map((context) =>
          this.serialize(context.runtimeId, async () => {
            await this.flushPendingEvents(context);
            if (
              context.terminalPersistence !== null ||
              context.manifest.executionSeal !== null
            ) {
              await this.finalize(context);
              return;
            }
            let application = context.reconciliationApplication;
            if (application === null) {
              const unresolvedBasis = (["managed_", "vanilla_"] as const)
                .map((prefix) => {
                  const operationPhases = context.phases.filter((phase) =>
                    phase.phase.startsWith(prefix),
                  );
                  if (
                    operationPhases.length === 0 ||
                    operationPhases.every(
                      (phase) => phase.operationState === "not_started",
                    )
                  ) {
                    return undefined;
                  }
                  const latestCleanup = [...operationPhases]
                    .reverse()
                    .find((phase) => phase.cleanup !== null)?.cleanup;
                  return latestCleanup !== undefined &&
                    latestCleanup !== null &&
                    lifecycleCleanupProven(latestCleanup)
                    ? undefined
                    : operationPhases.at(-1);
                })
                .find(
                  (phase): phase is VNextLifecyclePhaseReceiptV1 =>
                    phase !== undefined,
                );
              if (unresolvedBasis === undefined) {
                throw new Error(
                  "lifecycle execution has no unresolved physical operation to reconcile",
                );
              }
              const unknownLaunchStart =
                unresolvedBasis.operationState === "unknown";
              const cleanupBasis = unresolvedBasis;
              const reconciledCleanup: VNextLifecycleCleanupReceiptV1 = {
                schemaVersion: 1,
                processGroupTerminated: true,
                godotExited: true,
                sidecarExited: true,
                cgroupEmpty: true,
                scopeRemoved: true,
                scratchRemoved: true,
                storageReconciled: cleanup.storageReconciled === true,
              };
              const phase = VNextLifecyclePhaseReceiptV1Schema.parse({
                ...cleanupBasis,
                sequence: context.phases.length,
                outcome: cleanupBasis.outcome,
                cleanup: reconciledCleanup,
                knownSideEffects: [
                  ...cleanupBasis.knownSideEffects,
                  unknownLaunchStart
                    ? "Task sandbox scope reconciliation proved global process, cgroup, scratch, and resource removal after process admission was previously unknown"
                    : "Task sandbox cleanup retry proved process, cgroup, scratch, and resource removal without a new runtime sample",
                ],
              });
              context.phases.push(phase);
              const terminalStatus =
                context.launchFailureStage !== null
                  ? "failed"
                  : cleanupBasis.outcome === "controlled_stop" ||
                      (cleanupBasis.exitCode === 0 &&
                        cleanupBasis.signal === null)
                    ? "stopped"
                    : "crashed";
              context.facts = {
                ...context.facts,
                status: terminalStatus,
                endedAt: context.facts.endedAt ?? phase.endedAt,
              };
              application = {
                phase,
                cleanup: reconciledCleanup,
                eventsScheduled: false,
              };
              context.reconciliationApplication = application;
            }
            if (!application.eventsScheduled) {
              this.queueEvent(
                context,
                context.facts.status === "stopped" ? "log" : "error",
                context.facts.status === "stopped" ? "log" : "error",
                {
                  schemaVersion: 1,
                  kind: "lifecycle_cleanup_reconciled",
                  phase: phaseForOutput(application.phase),
                },
                lastSampleEventClock(context.facts),
              );
              this.queueEvent(
                context,
                "log",
                "log",
                {
                  schemaVersion: 1,
                  kind: "lifecycle_cleanup",
                  cleanup: cleanupForOutput(application.cleanup),
                },
                lastSampleEventClock(context.facts),
              );
              application.eventsScheduled = true;
            }
            await this.flushPendingEvents(context);
            await this.finalize(context);
          }),
        ),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected"
        ? [
            result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason)),
          ]
        : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "lifecycle cleanup reconciliation failed",
      );
    }
  }

  private dispatch(
    toolName: LifecycleGameToolNameV1,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    switch (toolName) {
      case "game_capabilities":
        return this.capabilities(input);
      case "game_launch":
        return this.launch(input, signal);
      case "game_status":
        return this.withRuntime(input, (context) =>
          this.statusContext(context, signal),
        );
      case "game_stop":
        return this.withKnownRuntime(input, (context) =>
          this.stopContext(context, signal),
        );
    }
  }

  private prepareBuild(): Promise<PreparedExternalGodotLifecycleBuildV1> {
    const prepared = this.#prepareQueue.then(() => this.prepareBuildOnce());
    this.#prepareQueue = prepared.then(
      () => undefined,
      () => undefined,
    );
    return prepared;
  }

  private async prepareBuildOnce(): Promise<PreparedExternalGodotLifecycleBuildV1> {
    const prepared = await this.#prepareBuild({
      taskId: this.options.taskId,
      workspaceId: this.options.workspaceId,
      workspaceDirectory: this.options.workspaceDirectory,
      baselineSourceHash: this.options.baselineSourceHash,
      projectCapability: this.options.projectCapability,
      managedRuntime: this.options.managedRuntime,
      now: this.#now(),
    });
    if (prepared.build.taskId !== this.options.taskId) {
      throw new ToolFailure(
        "resource_task_mismatch",
        "prepared lifecycle build belongs to another Task",
        false,
      );
    }
    const latest = this.#latestPrepared;
    if (latest?.build.buildId === prepared.build.buildId) {
      if (
        contentHash(json(preparedBuildIdentity(latest))) !==
        contentHash(json(preparedBuildIdentity(prepared)))
      ) {
        throw new Error(
          "prepared lifecycle build identity collision changed immutable facts",
        );
      }
      return latest;
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
          "persisted lifecycle build identity collides with different immutable facts",
        );
      }
      this.#latestPrepared = reused;
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
    this.#latestPrepared = prepared;
    return prepared;
  }

  private projectOutput(prepared: PreparedExternalGodotLifecycleBuildV1) {
    return {
      profile: "godot-external-lifecycle-v1" as const,
      declaredSourceUrl: this.options.projectCapability.declaredSourceUrl,
      sourceRevision: this.options.projectCapability.sourceRevision,
      selectedTreeSha256: prepared.build.sourceHash,
      descriptorSha256: this.options.projectCapability.descriptorSha256,
      projectCapabilitySha256: this.options.projectCapability.capabilitySha256,
    };
  }

  private buildOutput(prepared: PreparedExternalGodotLifecycleBuildV1) {
    return {
      schemaVersion: 1 as const,
      workspaceId: prepared.build.workspaceId,
      sourceId: prepared.build.sourceId,
      buildId: prepared.build.buildId,
      sourceHash: prepared.build.sourceHash,
      workspaceDiffHash: prepared.build.workspaceDiffHash,
      buildConfigurationHash: prepared.build.buildConfigurationHash,
      outputHash: prepared.build.outputHash,
    };
  }

  private identitiesOutput(prepared: PreparedExternalGodotLifecycleBuildV1) {
    return {
      descriptorSha256: prepared.descriptorHash,
      sourceSha256: prepared.build.sourceHash,
      buildSha256: asSha256DigestV1(contentHash(json(prepared.build))),
      overlaySha256: prepared.overlayHash,
      addonSha256: prepared.addonHash,
      vanillaSidecarSha256: prepared.vanillaSidecarHash,
      lifecycleSidecarSha256: prepared.lifecycleSidecarHash,
      managedRuntimeId: this.options.managedRuntime.managedRuntimeId,
    };
  }

  private createManifest(
    prepared: PreparedExternalGodotLifecycleBuildV1,
    runtimeId: RuntimeId,
    executionId: ExecutionId,
    startedAt: string,
  ): VNextLifecycleExecutionManifestV1 {
    const adapterId = asAdapterId(
      `adapter:${this.options.managedRuntime.managedRuntimeId.slice(-64)}`,
    );
    const probeId = asProbeId(`probe:${prepared.addonHash}`);
    return VNextLifecycleExecutionManifestV1Schema.parse({
      schemaVersion: 1,
      manifestKind: "lifecycle_execution",
      taskId: this.options.taskId,
      executionId,
      runtimeId,
      workspaceId: this.options.workspaceId,
      sourceId: prepared.build.sourceId,
      buildId: prepared.build.buildId,
      adapterId,
      probeIds: [probeId],
      stateSchemaVersion: "chronorift.lifecycle-shell:v1",
      runtimeProfile: "godot-external-lifecycle-v1",
      protocolProfile: "chronorift-godot-lifecycle-v1",
      launchTarget: "project_main_scene",
      requestedEnvironment: {
        schemaVersion: 1,
        headless: true,
        audioDriver: "Dummy",
        renderingMethod: "gl_compatibility",
        network: "isolated",
        display: "denied",
        gpu: "denied",
      },
      clockDomains: [
        "process_frame",
        "physics_tick",
        "simulation_time",
        "host_monotonic",
      ],
      identities: {
        schemaVersion: 1,
        ...this.identitiesOutput(prepared),
      },
      executionSeal: null,
      startedAt,
    });
  }

  private createRuntime(
    prepared: PreparedExternalGodotLifecycleBuildV1,
    runtimeId: RuntimeId,
    startedAt: string,
    status: "starting" | "running",
  ): VNextRuntimeV1 {
    return VNextRuntimeV1Schema.parse({
      schemaVersion: 1,
      taskId: this.options.taskId,
      runtimeId,
      buildId: prepared.build.buildId,
      sourceId: prepared.build.sourceId,
      adapter: {
        schemaVersion: 1,
        adapterId: asAdapterId(
          `adapter:${this.options.managedRuntime.managedRuntimeId.slice(-64)}`,
        ),
        contentHash: prepared.lifecycleSidecarHash,
        protocolVersion: "chronorift-godot-lifecycle-v1",
      },
      probes: [
        {
          schemaVersion: 1,
          probeId: asProbeId(`probe:${prepared.addonHash}`),
          contentHash: prepared.addonHash,
          channels: ["clock", "log", "error", "probe"],
        },
      ],
      capabilities: [
        "game.capabilities.read",
        "game.runtime.launch",
        "game.runtime.status",
        "game.runtime.stop",
      ],
      startedAt,
      status,
    });
  }

  private async capabilities(input: Record<string, unknown>): Promise<unknown> {
    const prepared = await this.prepareBuild();
    const requestedRuntimeId = input["runtimeId"];
    const runtime =
      typeof requestedRuntimeId === "string"
        ? await this.serialize(requestedRuntimeId, () => {
            const context = this.knownRuntime(requestedRuntimeId);
            return Promise.resolve(
              runtimeFactsForOutput(
                context.facts,
                context.coverage,
                context.loss,
              ),
            );
          })
        : null;
    return {
      schemaVersion: 2,
      taskId: this.options.taskId,
      workspaceId: this.options.workspaceId,
      project: this.projectOutput(prepared),
      build: this.buildOutput(prepared),
      tools: toolCapabilities,
      unsupported: LIFECYCLE_UNSUPPORTED_GAME_CAPABILITIES_V1.map(
        (capability) => ({
          capability,
          reason: "lifecycle_only_profile" as const,
        }),
      ),
      limits: {
        activeRuntimesMaximum: 1,
        launchesPerTurnMaximum: 4,
        readinessProcessFrameDeltaMinimum: 120,
        readinessPhysicsTickDeltaMinimum: 120,
      },
      runtime,
    };
  }

  private async launch(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const admitted =
      [...this.#contexts.values()].filter((context) => !context.sealed).length +
      this.#pendingLaunches;
    if (admitted >= 1) {
      throw new ToolFailure(
        "busy",
        "the lifecycle profile permits one active runtime",
        true,
      );
    }
    if (this.#totalLaunches >= 4) {
      throw new ToolFailure(
        "budget_exhausted",
        "the lifecycle profile reached four launches in this turn",
        true,
      );
    }
    this.#pendingLaunches += 1;
    this.#totalLaunches += 1;
    let unownedSession: ExternalGodotLifecycleSessionV1 | undefined;
    try {
      const prepared = await this.prepareBuild();
      if (input["buildId"] !== prepared.build.buildId) {
        throw new ToolFailure(
          "conflict",
          "requested build is not the current candidate build",
          true,
          json({ currentBuildId: prepared.build.buildId }),
        );
      }
      const runtimeId = asRuntimeId(this.#nextId("runtime"));
      const executionId = asExecutionId(this.#nextId("execution"));
      let session: ExternalGodotLifecycleSessionV1;
      try {
        session = await this.options.driver.launch(
          {
            taskId: this.options.taskId,
            runtimeId,
            executionId,
            workspaceDirectory: this.options.workspaceDirectory,
            prepared,
            managedRuntime: this.options.managedRuntime,
            token: this.#nextToken(),
          },
          signal,
        );
      } catch (error) {
        if (error instanceof ExternalGodotLifecycleLaunchFailureV1) {
          await this.persistLaunchFailure(
            prepared,
            runtimeId,
            executionId,
            error,
          );
        }
        throw error;
      }
      unownedSession = session;
      const initial = session.initial;
      const temporary = { runtimeId, executionId, prepared };
      const phases = normalizePhases(0, initial.phases);
      try {
        assertSnapshotFacts(temporary, initial);
        if (
          initial.facts.status !== "running" ||
          initial.facts.clocks.processFrameDelta < 120 ||
          initial.facts.clocks.physicsTickDelta < 120 ||
          initial.facts.currentScene === "unavailable"
        ) {
          throw new Error(
            "managed lifecycle runtime did not realize the readiness contract",
          );
        }
        if (
          phases.length < 4 ||
          !phases.some(
            (phase) =>
              phase.phase.startsWith("vanilla_") &&
              phase.cleanup !== null &&
              lifecycleCleanupProven(phase.cleanup),
          )
        ) {
          throw new Error(
            "managed launch began without a cleanup-proven vanilla operation",
          );
        }
      } catch {
        unownedSession = undefined;
        await this.persistRejectedSession(
          prepared,
          runtimeId,
          executionId,
          session,
          initial,
          signal,
        );
      }
      const manifest = this.createManifest(
        prepared,
        runtimeId,
        executionId,
        initial.facts.startedAt,
      );
      const runtime = this.createRuntime(
        prepared,
        runtimeId,
        initial.facts.startedAt,
        "running",
      );
      const context: RuntimeContext = {
        runtimeId,
        executionId,
        prepared,
        session,
        launchFailureStage: null,
        manifest,
        runtime,
        facts: runtimeFactsForOutput(
          initial.facts,
          initial.coverage,
          initial.loss,
        ),
        phases,
        events: [],
        pendingEvents: [],
        diagnosticChunks: new Map(),
        stopApplication: null,
        reconciliationApplication: null,
        coverage: [...initial.coverage],
        loss: [...initial.loss],
        sealed: false,
        terminalPersistence: null,
      };
      this.#contexts.set(runtimeId, context);
      unownedSession = undefined;
      for (const phase of phases) {
        this.queueEvent(
          context,
          "log",
          "log",
          {
            schemaVersion: 1,
            kind: "lifecycle_phase",
            occurrenceTimingBasis: "phase_receipt_bounds",
            phase: phaseForOutput(phase),
          },
          lastSampleEventClock(context.facts),
        );
      }
      await this.appendDiagnosticChunks(context, initial.diagnostics, true);
      this.queueEvent(
        context,
        "clock",
        "clock",
        {
          schemaVersion: 1,
          kind: "lifecycle_ready",
          configuredScene: context.facts.configuredScene,
          currentScene: context.facts.currentScene,
          processFrameDelta: context.facts.clocks.processFrameDelta,
          physicsTickDelta: context.facts.clocks.physicsTickDelta,
        },
        sampledEventClock(context.facts),
      );
      await this.flushPendingEvents(context);
      return {
        schemaVersion: 2,
        project: this.projectOutput(prepared),
        build: this.buildOutput(prepared),
        runtime: context.facts,
        identities: this.identitiesOutput(prepared),
        phases: context.phases.map(phaseForOutput),
      };
    } catch (error) {
      if (unownedSession !== undefined) {
        try {
          const stopped = await unownedSession.stop();
          if (!lifecycleCleanupProven(stopped.cleanup)) {
            throw new Error(
              "rejected lifecycle launch could not prove cleanup",
            );
          }
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "lifecycle launch failed and cleanup could not be proven",
          );
        }
      }
      throw error;
    } finally {
      this.#pendingLaunches -= 1;
    }
  }

  private async persistLaunchFailure(
    prepared: PreparedExternalGodotLifecycleBuildV1,
    runtimeId: RuntimeId,
    executionId: ExecutionId,
    failure: ExternalGodotLifecycleLaunchFailureV1,
  ): Promise<never> {
    const receipt = failure.receipt;
    const details = json({
      executionId,
      runtimeId,
      stage: receipt.stage,
    });
    if (
      receipt.taskId !== this.options.taskId ||
      receipt.buildId !== prepared.build.buildId ||
      receipt.runtimeId !== runtimeId ||
      receipt.executionId !== executionId
    ) {
      throw new ToolFailure(
        "resource_task_mismatch",
        "lifecycle launch failure does not match the admitted execution",
        false,
        details,
      );
    }
    const expectedPhase =
      receipt.stage === "vanilla_import"
        ? "vanilla_import"
        : receipt.stage === "vanilla_smoke"
          ? "vanilla_smoke"
          : receipt.stage === "managed_open"
            ? "managed_import"
            : "managed_handshake";
    if (!receipt.phases.some((phase) => phase.phase === expectedPhase)) {
      throw new ToolFailure(
        "operation_failed",
        "lifecycle launch failure omitted its terminal stage receipt",
        false,
        details,
      );
    }
    const operationPrefix = receipt.stage.startsWith("vanilla_")
      ? "vanilla_"
      : "managed_";
    const latestOperationCleanup = [...receipt.phases]
      .reverse()
      .find(
        (phase) =>
          phase.phase.startsWith(operationPrefix) && phase.cleanup !== null,
      )?.cleanup;
    if (
      (receipt.cleanup === null) !== (latestOperationCleanup === undefined) ||
      (receipt.cleanup !== null &&
        latestOperationCleanup !== undefined &&
        contentHash(json(receipt.cleanup)) !==
          contentHash(json(latestOperationCleanup)))
    ) {
      throw new ToolFailure(
        "operation_failed",
        "lifecycle launch failure cleanup does not match its phase ledger",
        false,
        details,
      );
    }

    const phases = normalizePhases(0, receipt.phases);
    const cleanupSatisfied = lifecycleRequiredCleanupProven(phases);
    const startedAt = phases[0]?.startedAt ?? this.#now();
    const facts = launchFailureFacts({
      taskId: this.options.taskId,
      runtimeId,
      executionId,
      prepared,
      phases,
      coverage: receipt.coverage,
      loss: receipt.loss,
      status: cleanupSatisfied ? "failed" : "cleanup_pending",
      now: this.#now(),
    });
    const context: RuntimeContext = {
      runtimeId,
      executionId,
      prepared,
      session: null,
      launchFailureStage: receipt.stage,
      manifest: this.createManifest(
        prepared,
        runtimeId,
        executionId,
        startedAt,
      ),
      runtime: this.createRuntime(prepared, runtimeId, startedAt, "starting"),
      facts,
      phases,
      events: [],
      pendingEvents: [],
      diagnosticChunks: new Map(),
      stopApplication: null,
      reconciliationApplication: null,
      coverage: [...receipt.coverage],
      loss: [...receipt.loss],
      sealed: false,
      terminalPersistence: null,
    };
    this.#contexts.set(runtimeId, context);
    try {
      for (const phase of phases) {
        const isFailure =
          phase.outcome === "failed" || phase.outcome === "timed_out";
        this.queueEvent(
          context,
          isFailure ? "error" : "log",
          isFailure ? "error" : "log",
          {
            schemaVersion: 1,
            kind: "lifecycle_phase",
            occurrenceTimingBasis: "phase_receipt_bounds",
            phase: phaseForOutput(phase),
          },
          lastSampleEventClock(context.facts),
        );
      }
      await this.appendDiagnosticChunks(context, receipt.diagnostics, true);
      if (receipt.cleanup !== null) {
        this.queueEvent(
          context,
          lifecycleCleanupProven(receipt.cleanup) ? "log" : "error",
          lifecycleCleanupProven(receipt.cleanup) ? "log" : "error",
          {
            schemaVersion: 1,
            kind: "lifecycle_cleanup",
            cleanup: cleanupForOutput(receipt.cleanup),
          },
          lastSampleEventClock(context.facts),
        );
      }
      await this.flushPendingEvents(context);
      if (cleanupSatisfied) await this.finalize(context);
    } catch {
      throw new ToolFailure(
        "operation_failed",
        "lifecycle launch failed and its execution persistence is incomplete",
        false,
        details,
      );
    }
    throw new ToolFailure(
      "operation_failed",
      `lifecycle launch failed during ${receipt.stage}`,
      cleanupSatisfied,
      details,
    );
  }

  private async persistRejectedSession(
    prepared: PreparedExternalGodotLifecycleBuildV1,
    runtimeId: RuntimeId,
    executionId: ExecutionId,
    session: ExternalGodotLifecycleSessionV1,
    initial: ExternalGodotLifecycleDriverSnapshotV1,
    signal?: AbortSignal,
  ): Promise<never> {
    const details = json({
      executionId,
      runtimeId,
      stage: "session_validation",
    });
    let stopped: ExternalGodotLifecycleDriverStopV1 | null = null;
    try {
      const candidate = await session.stop(signal);
      assertSnapshotFacts({ runtimeId, executionId, prepared }, candidate);
      stopped = candidate;
    } catch {
      // The Task sandbox remains the cleanup authority when the session stop
      // transport or its returned identity cannot be trusted.
    }
    const initialPhases = normalizePhases(0, initial.phases);
    const stoppedPhases =
      stopped === null
        ? []
        : normalizePhases(initialPhases.length, stopped.phases);
    const phases = [...initialPhases, ...stoppedPhases];
    const coverage = stopped?.coverage ?? initial.coverage;
    const loss = stopped?.loss ?? initial.loss;
    const cleanupSatisfied =
      stopped !== null &&
      lifecycleCleanupProven(stopped.cleanup) &&
      lifecycleRequiredCleanupProven(phases);
    const startedAt = phases[0]?.startedAt ?? initial.facts.startedAt;
    const facts = launchFailureFacts({
      taskId: this.options.taskId,
      runtimeId,
      executionId,
      prepared,
      phases,
      coverage,
      loss,
      status: cleanupSatisfied ? "failed" : "cleanup_pending",
      now: this.#now(),
    });
    const context: RuntimeContext = {
      runtimeId,
      executionId,
      prepared,
      session: null,
      launchFailureStage: "session_validation",
      manifest: this.createManifest(
        prepared,
        runtimeId,
        executionId,
        startedAt,
      ),
      runtime: this.createRuntime(prepared, runtimeId, startedAt, "starting"),
      facts,
      phases,
      events: [],
      pendingEvents: [],
      diagnosticChunks: new Map(),
      stopApplication: null,
      reconciliationApplication: null,
      coverage: [...coverage],
      loss: [...loss],
      sealed: false,
      terminalPersistence: null,
    };
    this.#contexts.set(runtimeId, context);
    try {
      for (const phase of phases) {
        const isFailure =
          phase.outcome === "failed" || phase.outcome === "timed_out";
        this.queueEvent(
          context,
          isFailure ? "error" : "log",
          isFailure ? "error" : "log",
          {
            schemaVersion: 1,
            kind: "lifecycle_phase",
            occurrenceTimingBasis: "phase_receipt_bounds",
            phase: phaseForOutput(phase),
          },
          lastSampleEventClock(context.facts),
        );
      }
      await this.appendDiagnosticChunks(context, initial.diagnostics, true);
      if (stopped !== null) {
        await this.appendDiagnosticChunks(context, stopped.diagnostics, true);
      }
      this.queueEvent(
        context,
        "error",
        "error",
        {
          schemaVersion: 1,
          kind: "lifecycle_session_rejected",
          stage: "session_validation",
        },
        lastSampleEventClock(context.facts),
      );
      if (stopped !== null) {
        this.queueEvent(
          context,
          lifecycleCleanupProven(stopped.cleanup) ? "log" : "error",
          lifecycleCleanupProven(stopped.cleanup) ? "log" : "error",
          {
            schemaVersion: 1,
            kind: "lifecycle_cleanup",
            cleanup: cleanupForOutput(stopped.cleanup),
          },
          lastSampleEventClock(context.facts),
        );
      }
      await this.flushPendingEvents(context);
      if (cleanupSatisfied) await this.finalize(context);
    } catch {
      throw new ToolFailure(
        "operation_failed",
        "rejected lifecycle session persistence is incomplete",
        false,
        details,
      );
    }
    throw new ToolFailure(
      "operation_failed",
      "lifecycle session failed admission validation",
      cleanupSatisfied,
      details,
    );
  }

  private async statusContext(
    context: RuntimeContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (context.session === null) {
      throw new ToolFailure(
        "runtime_unavailable",
        "lifecycle runtime was not admitted because launch failed",
        true,
        json({
          executionId: context.executionId,
          stage: context.launchFailureStage,
        }),
      );
    }
    await this.flushPendingEvents(context);
    const snapshot = await context.session.status(signal);
    assertSnapshotFacts(context, snapshot);
    const newPhases = normalizePhases(context.phases.length, snapshot.phases);
    context.phases.push(...newPhases);
    context.facts = runtimeFactsForOutput(
      snapshot.facts,
      snapshot.coverage,
      snapshot.loss,
    );
    context.coverage = [...snapshot.coverage];
    context.loss = [...snapshot.loss];
    for (const phase of newPhases) {
      this.queueEvent(
        context,
        "log",
        "log",
        {
          schemaVersion: 1,
          kind: "lifecycle_phase",
          occurrenceTimingBasis: "phase_receipt_bounds",
          phase: phaseForOutput(phase),
        },
        lastSampleEventClock(context.facts),
      );
    }
    await this.appendDiagnosticChunks(context, snapshot.diagnostics, true);
    this.queueEvent(
      context,
      "clock",
      "clock",
      {
        schemaVersion: 1,
        kind: "lifecycle_status",
        configuredScene: context.facts.configuredScene,
        currentScene: context.facts.currentScene,
        processFrameDelta: context.facts.clocks.processFrameDelta,
        physicsTickDelta: context.facts.clocks.physicsTickDelta,
      },
      sampledEventClock(context.facts),
    );
    await this.flushPendingEvents(context);
    return { schemaVersion: 2, runtime: context.facts };
  }

  private async stopContext(
    context: RuntimeContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (context.session === null) {
      if (!context.sealed && lifecycleRequiredCleanupProven(context.phases)) {
        await this.finalize(context);
      }
      throw new ToolFailure(
        lifecycleRequiredCleanupProven(context.phases)
          ? "runtime_unavailable"
          : "operation_failed",
        lifecycleRequiredCleanupProven(context.phases)
          ? "lifecycle runtime was not admitted because launch failed"
          : "failed launch cleanup is unproven; execution remains unsealed",
        false,
        json({
          executionId: context.executionId,
          stage: context.launchFailureStage,
        }),
      );
    }
    if (context.sealed) {
      const cleanupPhase = [...context.phases]
        .reverse()
        .find((phase) => phase.cleanup !== null);
      if (cleanupPhase?.cleanup === null || cleanupPhase === undefined) {
        throw new Error("sealed lifecycle context lost its cleanup receipt");
      }
      return {
        schemaVersion: 2,
        runtime: context.facts,
        sealed: true,
        cleanup: cleanupForOutput(cleanupPhase.cleanup),
      };
    }
    if (
      context.terminalPersistence !== null ||
      context.manifest.executionSeal !== null
    ) {
      await this.finalize(context);
      const cleanupPhase = [...context.phases]
        .reverse()
        .find(
          (phase) =>
            phase.cleanup !== null && lifecycleCleanupProven(phase.cleanup),
        );
      if (cleanupPhase?.cleanup === null || cleanupPhase === undefined) {
        throw new Error(
          "terminal lifecycle persistence lost its proven cleanup receipt",
        );
      }
      return {
        schemaVersion: 2,
        runtime: context.facts,
        sealed: true,
        cleanup: cleanupForOutput(cleanupPhase.cleanup),
      };
    }
    await this.flushPendingEvents(context);
    let application = context.stopApplication;
    if (application === null) {
      const stopped = await context.session.stop(signal);
      assertSnapshotFacts(context, stopped);
      const newPhases = normalizePhases(context.phases.length, stopped.phases);
      context.phases.push(...newPhases);
      context.facts = runtimeFactsForOutput(
        stopped.facts,
        stopped.coverage,
        stopped.loss,
      );
      context.coverage = [...stopped.coverage];
      context.loss = [...stopped.loss];
      application = { stopped, eventsScheduled: false };
      context.stopApplication = application;
    }
    const stopped = application.stopped;
    if (!application.eventsScheduled) {
      const stopPhases = context.phases.slice(
        context.phases.length - stopped.phases.length,
      );
      for (const phase of stopPhases) {
        const isFailure =
          phase.outcome === "failed" || phase.outcome === "timed_out";
        this.queueEvent(
          context,
          isFailure ? "error" : "log",
          isFailure ? "error" : "log",
          {
            schemaVersion: 1,
            kind: "lifecycle_phase",
            occurrenceTimingBasis: "phase_receipt_bounds",
            phase: phaseForOutput(phase),
          },
          lastSampleEventClock(context.facts),
        );
      }
      await this.appendDiagnosticChunks(context, stopped.diagnostics, true);
      this.queueEvent(
        context,
        lifecycleCleanupProven(stopped.cleanup) ? "log" : "error",
        lifecycleCleanupProven(stopped.cleanup) ? "log" : "error",
        {
          schemaVersion: 1,
          kind: "lifecycle_cleanup",
          cleanup: cleanupForOutput(stopped.cleanup),
        },
        lastSampleEventClock(context.facts),
      );
      application.eventsScheduled = true;
    }
    await this.flushPendingEvents(context);
    if (!lifecycleCleanupProven(stopped.cleanup)) {
      context.facts = { ...context.facts, status: "cleanup_pending" };
      throw new ToolFailure(
        "operation_failed",
        "runtime cleanup is unproven; execution remains unsealed",
        false,
        json({ cleanup: cleanupForOutput(stopped.cleanup) }),
      );
    }
    if (
      context.facts.status !== "stopped" &&
      context.facts.status !== "crashed" &&
      context.facts.status !== "failed"
    ) {
      throw new Error("cleanup-proven stop returned a nonterminal runtime");
    }
    await this.finalize(context);
    return {
      schemaVersion: 2,
      runtime: context.facts,
      sealed: true,
      cleanup: cleanupForOutput(stopped.cleanup),
    };
  }

  private async finalizeLaunchFailureContext(
    context: RuntimeContext,
  ): Promise<void> {
    if (context.session !== null || context.launchFailureStage === null) {
      throw new Error("expected a failed-launch lifecycle context");
    }
    if (!lifecycleRequiredCleanupProven(context.phases)) {
      throw new ToolFailure(
        "operation_failed",
        "failed launch cleanup is unproven; execution remains unsealed",
        false,
        json({
          executionId: context.executionId,
          stage: context.launchFailureStage,
        }),
      );
    }
    context.facts = {
      ...context.facts,
      status: "failed",
      endedAt: context.facts.endedAt ?? this.#now(),
    };
    await this.finalize(context);
  }

  private async finalize(context: RuntimeContext): Promise<void> {
    if (context.sealed) return;
    await this.flushPendingEvents(context);
    if (context.pendingEvents.length !== 0) {
      throw new Error(
        "lifecycle execution cannot seal with pending raw events",
      );
    }
    if (context.terminalPersistence === null) {
      const endedAt = context.facts.endedAt ?? this.#now();
      const terminalStatus =
        context.facts.status === "crashed"
          ? "crashed"
          : context.facts.status === "failed"
            ? "failed"
            : "stopped";
      context.runtime = VNextRuntimeV1Schema.parse({
        ...context.runtime,
        status: terminalStatus,
        endedAt,
        termination: {
          schemaVersion: 1,
          code:
            terminalStatus === "stopped"
              ? "controlled_stop"
              : "runtime_termination",
          message: null,
        },
      });
      const executionSeal = await this.options.runtimeStore.sealExecution(
        context.executionId,
      );
      context.manifest = VNextLifecycleExecutionManifestV1Schema.parse({
        ...context.manifest,
        executionSeal,
      });
      if (
        executionSeal.taskId !== this.options.taskId ||
        executionSeal.executionId !== context.executionId ||
        executionSeal.count !== context.events.length
      ) {
        throw new Error(
          "lifecycle execution seal does not match its raw event ledger",
        );
      }
      const basis = {
        schemaVersion: 1 as const,
        recordKind: "lifecycle_execution" as const,
        taskId: this.options.taskId,
        executionId: context.executionId,
        runtimeId: context.runtimeId,
        buildId: context.prepared.build.buildId,
        manifest: context.manifest,
        phases: context.phases,
        events: context.events,
        coverage: context.coverage,
        loss: context.loss,
        status: terminalStatus,
        sealed: true as const,
        endedAt,
        termination: {
          schemaVersion: 1 as const,
          code:
            terminalStatus === "stopped"
              ? "controlled_stop"
              : "runtime_termination",
          message: null,
        },
      };
      const record = VNextLifecycleExecutionRecordV1Schema.parse({
        ...basis,
        recordHash: contentHash(json(basis)),
      });
      if (!record.sealed) {
        throw new Error("terminal lifecycle record unexpectedly remained open");
      }
      context.terminalPersistence = { runtime: context.runtime, record };
    }
    const terminal = context.terminalPersistence;
    await this.putResourceIdempotently(
      "runtime",
      context.runtimeId,
      terminal.runtime,
      (value) => VNextRuntimeV1Schema.parse(value),
    );
    await this.putResourceIdempotently(
      "execution",
      context.executionId,
      terminal.record,
      (value) => VNextLifecycleExecutionRecordV1Schema.parse(value),
    );
    context.sealed = true;
  }

  private async putResourceIdempotently<T>(
    kind: RuntimeResourceKind,
    resourceId: string,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<void> {
    try {
      await this.options.runtimeStore.putResourceOnce(
        kind,
        resourceId,
        value,
        parse,
      );
    } catch (writeError) {
      try {
        const existing = await this.options.runtimeStore.readResource(
          kind,
          resourceId,
          parse,
        );
        if (contentHash(json(existing)) === contentHash(json(value))) return;
      } catch {
        // Preserve the authoritative write failure below.
      }
      throw writeError;
    }
  }

  private queueEvent(
    context: RuntimeContext,
    channel: "clock" | "log" | "error" | "probe",
    kind: "clock" | "log" | "error" | "probe",
    payload: JsonObject,
    eventClock: RawLifecycleEventClockV1,
  ): void {
    const event = VNextRawRuntimeEventV1Schema.parse({
      schemaVersion: 1,
      eventId: asEventId(this.#nextId("event")),
      taskId: this.options.taskId,
      executionId: context.executionId,
      runtimeId: context.runtimeId,
      buildId: context.prepared.build.buildId,
      sequence: context.events.length,
      channel,
      kind,
      clock: {
        schemaVersion: 1,
        processFrame: eventClock.processFrame,
        physicsTick: eventClock.physicsTick,
        simulationTimeUs: eventClock.simulationTimeUs,
        hostMonotonicUs: eventClock.hostMonotonicUs,
        renderFrame: null,
      },
      payload: { ...payload, timingBasis: eventClock.basis },
      observedRelations: [],
    });
    context.events.push(event);
    context.pendingEvents.push(event);
  }

  private async flushPendingEvents(context: RuntimeContext): Promise<void> {
    while (context.pendingEvents.length > 0) {
      const pending = context.pendingEvents[0];
      if (pending === undefined) return;
      try {
        await this.options.runtimeStore.appendExecutionEvent(
          context.executionId,
          pending,
          (value) => VNextRawRuntimeEventV1Schema.parse(value),
        );
        context.pendingEvents.shift();
      } catch (appendError) {
        let stored: readonly VNextRawRuntimeEventV1[];
        try {
          stored = await this.options.runtimeStore.readExecutionEvents(
            context.executionId,
            (value) => VNextRawRuntimeEventV1Schema.parse(value),
          );
        } catch (readError) {
          throw new AggregateError(
            [appendError, readError],
            "raw lifecycle event append failed and ledger state could not be read",
          );
        }
        if (stored.length > context.events.length) {
          throw new Error(
            "raw lifecycle ledger contains events not owned by this context",
          );
        }
        for (const [index, storedEvent] of stored.entries()) {
          const intended = context.events[index];
          if (
            intended === undefined ||
            contentHash(json(storedEvent)) !== contentHash(json(intended))
          ) {
            throw new Error(
              "raw lifecycle ledger diverged from the pending event sequence",
            );
          }
        }
        context.pendingEvents = context.events.slice(stored.length);
        if (stored.length <= pending.sequence) throw appendError;
      }
    }
  }

  private async appendDiagnosticChunks(
    context: RuntimeContext,
    chunks: readonly ExternalGodotLifecycleDiagnosticChunkV1[],
    deferFlush = false,
  ): Promise<void> {
    for (const candidate of chunks) {
      const chunk =
        ExternalGodotLifecycleDiagnosticChunkV1Schema.parse(candidate);
      const key = `${chunk.phase}\0${chunk.stream}\0${chunk.offset}`;
      const existing = context.diagnosticChunks.get(key);
      if (existing !== undefined) {
        if (contentHash(json(existing)) !== contentHash(json(chunk))) {
          throw new Error(
            "lifecycle diagnostic chunk identity changed between snapshots",
          );
        }
        continue;
      }
      context.diagnosticChunks.set(key, chunk);
      const operationPhases = context.phases.filter((candidate) =>
        chunk.phase === "import"
          ? candidate.phase === "vanilla_import"
          : chunk.phase === "vanilla"
            ? candidate.phase === "vanilla_smoke"
            : candidate.phase.startsWith("managed_"),
      );
      const hostMonotonicStartUs =
        operationPhases.length === 0
          ? 0
          : Math.min(
              ...operationPhases.map((phase) => phase.hostMonotonicStartUs),
            );
      const hostMonotonicEndUs =
        operationPhases.length === 0
          ? 0
          : Math.max(
              ...operationPhases.map((phase) => phase.hostMonotonicEndUs),
            );
      this.queueEvent(
        context,
        chunk.stream === "stdout" ? "log" : "error",
        chunk.stream === "stdout" ? "log" : "error",
        {
          schemaVersion: 1,
          kind: "process_output",
          phase: chunk.phase,
          stream: chunk.stream,
          offset: chunk.offset,
          byteLength: chunk.byteLength,
          sha256: chunk.sha256,
          bytesBase64: chunk.bytesBase64,
          occurrenceTimingBasis: "operation_envelope",
          phaseHostMonotonicStartUs: hostMonotonicStartUs,
          phaseHostMonotonicEndUs: hostMonotonicEndUs,
        },
        lastSampleEventClock(context.facts),
      );
    }
    if (!deferFlush) await this.flushPendingEvents(context);
  }

  private knownRuntime(runtimeId: string): RuntimeContext {
    const context = this.#contexts.get(asRuntimeId(runtimeId));
    if (context === undefined) {
      throw new ToolFailure(
        "resource_not_found",
        "lifecycle runtime was not found in this coordinator turn",
        true,
      );
    }
    return context;
  }

  private withKnownRuntime<T>(
    input: Record<string, unknown>,
    operation: (context: RuntimeContext) => Promise<T>,
  ): Promise<T> {
    const runtimeId = String(input["runtimeId"]);
    return this.serialize(runtimeId, () =>
      operation(this.knownRuntime(runtimeId)),
    );
  }

  private withRuntime<T>(
    input: Record<string, unknown>,
    operation: (context: RuntimeContext) => Promise<T>,
  ): Promise<T> {
    return this.withKnownRuntime(input, (context) => {
      if (context.sealed) {
        throw new ToolFailure(
          "runtime_unavailable",
          "lifecycle runtime is already terminal",
          true,
        );
      }
      return operation(context);
    });
  }

  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(key, tail);
    void tail.finally(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    });
    return current;
  }
}

export const createExternalGodotLifecycleCoordinator = (
  options: ExternalGodotLifecycleCoordinatorOptionsV1,
  dependencies: ExternalGodotLifecycleCoordinatorDependenciesV1 = {},
): ExternalGodotLifecycleCoordinatorV1 =>
  new ExternalGodotLifecycleCoordinator(options, dependencies);
