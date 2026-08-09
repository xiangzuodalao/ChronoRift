import { randomUUID } from "node:crypto";

import {
  GAME_TOOL_DEFINITIONS_V1,
  GAME_TOOL_NAMES_V1,
  validateGameToolInputV1,
  validateGameToolOutputV1,
  type GameCaptureChannelV1,
  type GameCaptureProfileV1,
  type GameForkInputV1,
  type GameRequestedPointV1,
  type GameRuntimeControlsV1,
  type GameToolNameV1,
} from "@chronorift/agent-protocol";
import {
  CheckpointCertificateV1Schema,
  EnvironmentSnapshotSchema,
  JsonValueSchema,
  RuntimeFingerprintV1Schema,
  StateSnapshotSchema,
  VNextBranchLineageV1Schema,
  VNextBuildV1Schema,
  VNextCaptureWindowV1Schema,
  VNextCheckpointManifestV1Schema,
  VNextComparisonV1Schema,
  VNextCaptureLossV1Schema,
  VNextClockPositionV1Schema,
  VNextExecutionManifestV1Schema,
  VNextExecutionRecordV1Schema,
  VNextRawRuntimeEventV1Schema,
  VNextRestoreReceiptV1Schema,
  VNextRuntimeStateQueryResultV1Schema,
  VNextRuntimeStateQueryV1Schema,
  VNextRuntimeTraceV1Schema,
  VNextRuntimeV1Schema,
  asAdapterId,
  asBranchId,
  asCaptureWindowId,
  asCheckpointId,
  asComparisonId,
  asEventId,
  asExecutionId,
  asProbeId,
  asRestoreReceiptId,
  asRuntimeId,
  asRuntimeStateIndexId,
  asSha256DigestV1,
  asTraceId,
  type AdapterId,
  type BranchId,
  type CaptureWindowId,
  type CheckpointId,
  type EnvironmentSnapshot,
  type EventId,
  type ExecutionId,
  type JsonObject,
  type JsonValue,
  type ProbeId,
  type RuntimeFingerprintV1,
  type RuntimeId,
  type RuntimeStateIndexId,
  type Sha256DigestV1,
  type StateSnapshot,
  type TaskId,
  type TraceId,
  type VNextBranchLineageV1,
  type VNextCaptureChannelV1,
  type VNextCaptureCoverageV1,
  type VNextCaptureLossV1,
  type VNextCapturePolicyV1,
  type VNextClockPositionV1,
  type VNextExecutionManifestV1,
  type VNextExecutionRecordV1,
  type VNextObservedRelationV1,
  type VNextRawRuntimeEventV1,
  type VNextRuntimeStateQueryResultV1,
  type VNextRuntimeStateQueryV1,
  type VNextRuntimePhaseV1,
  type VNextRuntimeTraceV1,
  type VNextRuntimeV1,
  type V01EnvironmentEventDraft,
  type WorkspaceId,
} from "@chronorift/domain";
import {
  VNextCheckpointRestoreService,
  VNextCaptureCapacityError,
  VNextDescriptiveComparisonService,
  VNextRollingCapture,
  VNextRuntimeStateIndex,
  VNextTraceReplayService,
} from "@chronorift/gamebranch";
import {
  GodotAdapterError,
  connectVNextGodotRuntime,
  type GodotByteTransport,
  type VNextGodotConnectRequestV1,
  type VNextGodotRuntimeClient,
  type VNextGodotStepResultV1,
} from "@chronorift/godot-adapter";
import {
  ArtifactNotFoundError,
  contentHash,
  type RuntimeExecutionSealV1,
} from "@chronorift/json-artifacts";
import {
  RuntimeSidecarLaunchV1Schema,
  type RuntimeSidecarLaunchV1,
} from "@chronorift/godot-protocol";
import {
  type VNextGameToolPort,
  type VNextGameToolPortRequestV1,
} from "@chronorift/pi-harness";
import { z } from "zod";

import {
  prepareCandidateGodotBuildV1,
  type PreparedCandidateGodotBuildV1,
} from "./candidate-godot-build.js";
import type {
  GodotSidecarPortV1,
  SandboxedGodotSidecarV1,
} from "./godot-sidecar-port.js";
import type { TaskFixtureCapabilityV1 } from "./contracts.js";
import type { ManagedGodotRuntimeCapabilityV1 } from "./managed-godot-runtime.js";
import type { SandboxExecutionResultV1 } from "./sandbox-broker.js";

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

export interface VNextGodotRuntimeCoordinatorStore {
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
  readExecutionSeal(executionId: string): Promise<RuntimeExecutionSealV1>;
  sealExecution(executionId: string): Promise<RuntimeExecutionSealV1>;
}

export interface VNextGodotRuntimeCoordinatorOptions {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly workspaceDirectory: string;
  readonly baselineSourceHash: Sha256DigestV1;
  readonly fixtureCapability: TaskFixtureCapabilityV1;
  readonly managedRuntime: ManagedGodotRuntimeCapabilityV1;
  readonly sidecarPort: Pick<GodotSidecarPortV1, "open">;
  readonly runtimeStore: VNextGodotRuntimeCoordinatorStore;
}

type ResourceKindPrefix =
  | "runtime"
  | "execution"
  | "capture-window"
  | "checkpoint"
  | "trace"
  | "branch"
  | "comparison"
  | "runtime-state-index"
  | "restore-receipt"
  | "event";

export interface VNextGodotRuntimeCoordinatorDependencies {
  readonly now?: () => string;
  readonly nextId?: (kind: ResourceKindPrefix) => string;
  readonly nextToken?: () => string;
  readonly prepareBuild?: typeof prepareCandidateGodotBuildV1;
  readonly connectRuntime?: (
    transport: GodotByteTransport,
    request: VNextGodotConnectRequestV1,
  ) => Promise<VNextGodotRuntimeClient>;
  readonly gracefulSidecarExitMs?: number;
}

export interface VNextGodotRuntimeCoordinator extends VNextGameToolPort {
  close(): Promise<void>;
}

const StoredRequestedPointV1Schema = z.discriminatedUnion("clock", [
  z
    .object({
      clock: z.literal("process_frame"),
      requestedTick: z.number().int().nonnegative(),
      requestedPhase: z.enum(["process_frame_start", "process_frame_end"]),
    })
    .strict(),
  z
    .object({
      clock: z.literal("physics_tick"),
      requestedTick: z.number().int().nonnegative(),
      requestedPhase: z.enum(["physics_tick_start", "physics_tick_end"]),
    })
    .strict(),
]);

const StoredInputScheduleV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    nextInputOrder: z.number().int().nonnegative(),
    pendingInputs: z
      .array(
        z
          .object({
            schemaVersion: z.literal(1),
            requestId: z
              .string()
              .min(1)
              .max(256)
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u)
              .refine((value) => !value.includes("..")),
            action: z.literal("attempt_jump"),
            targetEntityId: z.string().min(1).max(128).nullable(),
            requested: StoredRequestedPointV1Schema,
            order: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(600),
  })
  .strict();
type StoredInputScheduleV1 = z.infer<typeof StoredInputScheduleV1Schema>;

const StoredCheckpointV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    manifest: VNextCheckpointManifestV1Schema,
    snapshot: EnvironmentSnapshotSchema,
    certificate: CheckpointCertificateV1Schema,
    nextTick: z.number().int().nonnegative(),
    simTimeUs: z.number().int().nonnegative(),
    inputSchedule: StoredInputScheduleV1Schema,
  })
  .strict();
type StoredCheckpointV1 = z.infer<typeof StoredCheckpointV1Schema>;

const runtimeStateQueryResultShape = VNextRuntimeStateQueryResultV1Schema.shape;
const StoredRuntimeStateIndexV1Schema = z
  .object({
    schemaVersion: runtimeStateQueryResultShape.schemaVersion,
    taskId: runtimeStateQueryResultShape.taskId,
    indexId: runtimeStateQueryResultShape.indexId,
    executionId: runtimeStateQueryResultShape.executionId,
    runtimeId: runtimeStateQueryResultShape.runtimeId,
    sourceId: runtimeStateQueryResultShape.sourceId,
    buildId: runtimeStateQueryResultShape.buildId,
    adapterId: runtimeStateQueryResultShape.adapterId,
    probeIds: runtimeStateQueryResultShape.probeIds,
    captureWindowIds: runtimeStateQueryResultShape.captureWindowIds,
    rawRecordHash: runtimeStateQueryResultShape.rawRecordHash,
  })
  .strict();
type StoredRuntimeStateIndexV1 = z.infer<
  typeof StoredRuntimeStateIndexV1Schema
>;

const StoredToolCallV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    toolCallId: z.string().min(1).max(256),
    toolName: z.string().min(1),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    input: JsonValueSchema,
    response: JsonValueSchema,
  })
  .strict();

const StoredExecutionSealV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    executionId: z.string().min(1),
    count: z.number().int().nonnegative(),
    headHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    byteLength: z.number().int().nonnegative(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const CandidateLaunchFailureProofV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    attribution: z.literal("candidate_source"),
    stage: z.enum(["launch", "step"]),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const managedTelemetryIdSchema = z.string().min(1).max(256);
const ManagedEntityLifecycleFieldsV1Schema = z
  .object({
    chronoriftEvent: z.literal("entity_lifecycle"),
    action: z.enum(["spawned", "despawned"]),
    stableId: managedTelemetryIdSchema,
    incarnation: z.number().int().positive(),
  })
  .strict();
const ManagedPendingEffectFieldsV1Schema = z
  .object({
    chronoriftEvent: z.literal("pending_effect"),
    action: z.enum(["scheduled", "restored", "applied", "discarded"]),
    effectId: managedTelemetryIdSchema,
    targetStableId: managedTelemetryIdSchema,
    targetIncarnation: z.number().int().positive(),
    dueTick: z.number().int().nonnegative(),
    resolvedStableId: managedTelemetryIdSchema.optional(),
    resolvedIncarnation: z.number().int().positive().optional(),
    reason: z
      .enum(["owner_destroyed", "target_missing", "stale_incarnation"])
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.resolvedStableId === undefined) !==
      (value.resolvedIncarnation === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["resolvedStableId"],
        message: "resolved pending-effect identity must be complete",
        input: value,
      });
    }
  });
const ManagedSpatialSampleFieldsV1Schema = z
  .object({
    chronoriftEvent: z.literal("spatial_sample"),
    stableId: managedTelemetryIdSchema,
    incarnation: z.number().int().positive(),
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();

const RuntimeRestoreValidationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    level: z.string().min(1),
    semanticStateHash: z.string().regex(/^[a-f0-9]{64}$/u),
    validations: z.array(
      z
        .object({
          participantId: z.string().min(1),
          status: z.enum(["pass", "fail"]),
          stateHash: z.string().regex(/^[a-f0-9]{64}$/u),
          message: z.string().min(1).optional(),
        })
        .strict(),
    ),
  })
  .strict();

interface PendingInput {
  readonly requestId: string;
  readonly action: "attempt_jump";
  readonly targetEntityId?: string | undefined;
  readonly requested: GameRequestedPointV1;
  readonly order: number;
}

interface InputRealizationReceipt {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly requested: GameRequestedPointV1;
  readonly realized: VNextClockPositionV1 & {
    readonly phase: VNextRuntimePhaseV1;
    readonly quantized: boolean;
    readonly mismatchReason: string | null;
  };
  readonly knownSideEffects: readonly string[];
}

interface RuntimeContext {
  readonly runtimeId: RuntimeId;
  readonly executionId: ExecutionId;
  readonly prepared: PreparedCandidateGodotBuildV1;
  readonly adapterId: AdapterId;
  readonly probeIds: readonly ProbeId[];
  readonly client: VNextGodotRuntimeClient;
  readonly sidecar: SandboxedGodotSidecarV1;
  readonly startedAt: string;
  runtime: VNextRuntimeV1;
  manifest: VNextExecutionManifestV1;
  capture: VNextRollingCapture;
  capturePolicy: VNextCapturePolicyV1;
  captureProfileInput: GameCaptureProfileV1 | null;
  readonly events: VNextRawRuntimeEventV1[];
  readonly persistedEventIds: Set<string>;
  readonly eventIdsByLocalId: Map<string, EventId>;
  readonly entityIncarnations: Map<string, number>;
  readonly captureWindowIds: CaptureWindowId[];
  readonly pendingInputs: PendingInput[];
  readonly inputReceipts: InputRealizationReceipt[];
  readonly observerEffectUsByChannel: Map<VNextCaptureChannelV1, number>;
  readonly coverageStarts: Map<
    VNextCaptureChannelV1,
    { readonly eventSequence: number; readonly clock: VNextClockPositionV1 }
  >;
  readonly externalLoss: VNextCaptureLossV1[];
  recordedDiagnosticCount: number;
  diagnosticFailureRecorded: boolean;
  nextInputOrder: number;
  stepsUsed: number;
  maxTicks: number;
  fixedFps: 60 | 120;
  physicsTicksPerSecond: 60 | 120;
  clock: VNextClockPositionV1;
  state: StateSnapshot;
  status: "running" | "stopping" | "stopped" | "crashed" | "failed";
  sealed: boolean;
  finalCheckpointId: CheckpointId | null;
  pendingTermination: {
    readonly status: "crashed" | "failed";
    readonly code: string;
    readonly message: string | null;
  } | null;
  failureAttribution: JsonValue | null;
  terminalPersistence: {
    readonly runtime: VNextRuntimeV1;
    readonly record: Extract<VNextExecutionRecordV1, { readonly sealed: true }>;
  } | null;
}

const storedInputSchedule = (
  context: Pick<RuntimeContext, "nextInputOrder" | "pendingInputs">,
): StoredInputScheduleV1 =>
  StoredInputScheduleV1Schema.parse({
    schemaVersion: 1,
    nextInputOrder: context.nextInputOrder,
    pendingInputs: context.pendingInputs.map((pending) => ({
      schemaVersion: 1,
      requestId: pending.requestId,
      action: pending.action,
      targetEntityId: pending.targetEntityId ?? null,
      requested: pending.requested,
      order: pending.order,
    })),
  });

interface ExecutionSource {
  readonly record: VNextExecutionRecordV1;
  readonly events: readonly VNextRawRuntimeEventV1[];
  readonly captureWindowIds: readonly CaptureWindowId[];
}

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

const json = <T>(value: T): JsonValue => value as JsonValue;

type ToolErrorCode =
  | "unsupported_capability"
  | "invalid_request"
  | "resource_not_found"
  | "resource_task_mismatch"
  | "permission_denied"
  | "busy"
  | "conflict"
  | "budget_exhausted"
  | "runtime_crashed"
  | "runtime_unavailable"
  | "history_window_unavailable"
  | "pre_failure_checkpoint_unavailable"
  | "checkpoint_incompatible"
  | "restore_gap"
  | "trace_unavailable"
  | "comparison_confounded"
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

const success = (
  toolCallId: string,
  output: JsonValue,
): CoordinatorToolResponse => ({
  schemaVersion: 1,
  toolCallId,
  outcome: "success",
  output,
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
    message,
    recoverable,
    ...(details === undefined ? {} : { details }),
  },
});

const clockAt = (
  processFrame: number,
  physicsTick: number,
  simulationTimeUs: number,
  hostMonotonicUs: number,
): VNextClockPositionV1 => ({
  schemaVersion: 1,
  processFrame,
  physicsTick,
  simulationTimeUs,
  hostMonotonicUs,
  renderFrame: null,
});

const mapCaptureChannel = (
  channel: GameCaptureChannelV1,
): VNextCaptureChannelV1 => {
  if (channel === "clocks") return "clock";
  if (channel === "runtime_error") return "error";
  if (channel === "state") return "state_summary";
  return channel;
};

const protectedChannels: readonly VNextCaptureChannelV1[] = [
  "input",
  "clock",
  "entity_lifecycle",
  "probe",
  "error",
  "checkpoint",
  "restore",
  "log",
];
const MAX_PENDING_INPUTS = 600;
const MAX_COMPARISON_SOURCE_EVENTS = 10_000;

const capturePolicy = (
  profile?: GameCaptureProfileV1,
): VNextCapturePolicyV1 => {
  const selected = new Set<VNextCaptureChannelV1>(protectedChannels);
  for (const channel of profile?.channels ?? ["state", "probe", "log"]) {
    selected.add(mapCaptureChannel(channel));
  }
  return {
    schemaVersion: 1,
    requestedRetentionUs: (profile?.historySeconds ?? 10) * 1_000_000,
    requestedRetentionTicks: profile?.maxTicks ?? 600,
    memoryBudgetBytes: 256 * 1024 * 1024,
    diskBudgetBytes: 1024 * 1024 * 1024,
    maxAverageOverheadRatio: 0.05,
    maxMainThreadBlockUs: 2_000,
    channels: [...selected].map((channel) => ({
      schemaVersion: 1,
      channel,
      priority: protectedChannels.includes(channel) ? "protected" : "normal",
      sampleEvery:
        channel === "state_summary" ? (profile?.stateSampleEveryTicks ?? 1) : 1,
    })),
  };
};

const controlValues = (fixedFps: number, physicsTicksPerSecond: number) => ({
  schemaVersion: 1 as const,
  fixedFps,
  physicsTicksPerSecond,
  timeScale: 1,
  paused: false,
  headless: true,
});

const runtimeControlReceipt = (
  fixedFps: number,
  physicsTicksPerSecond: number,
) => ({
  schemaVersion: 1 as const,
  requested: controlValues(fixedFps, physicsTicksPerSecond),
  realized: controlValues(fixedFps, physicsTicksPerSecond),
  mismatches: [],
  knownSideEffects: ["headless runtime uses the managed Godot process"],
});

const rawHash = (events: readonly VNextRawRuntimeEventV1[]) =>
  asSha256DigestV1(contentHash(json(events)));

const eventTypeAliases: Readonly<Record<string, string>> = Object.freeze({
  "input.requested": "input_requested",
  "input.realized": "input_realized",
  "input.delivery_attempt": "input_delivery_attempt",
  "state.changed": "property_changed",
  "signal.emitted": "signal_emitted",
  "signal.delivery": "signal_delivery",
  lifecycle: "entity_lifecycle",
});

const rawEventSubtype = (event: VNextRawRuntimeEventV1): string => {
  const subtype = event.payload["eventType"];
  return typeof subtype === "string" ? subtype : `${event.kind}.unspecified`;
};

const matchesRequestedEventType = (
  event: VNextRawRuntimeEventV1,
  requested: readonly string[],
): boolean =>
  requested.length === 0 ||
  requested.some(
    (eventType) =>
      (eventTypeAliases[eventType] ?? eventType) === rawEventSubtype(event),
  );

const runtimeStateRowKind = (
  event: VNextRawRuntimeEventV1,
): VNextRuntimeStateQueryV1["eventKinds"][number] => {
  switch (event.kind) {
    case "input":
      return "input";
    case "state":
      return "state";
    case "entity_lifecycle":
      return "lifecycle";
    case "relation":
      return "relation";
    case "log":
      return "log";
    case "error":
    case "crash":
    case "capture_loss":
      return "error";
    case "rng":
      return "rng";
    case "clock":
      return "clock";
    case "checkpoint":
      return "checkpoint";
    case "signal":
    case "probe":
    case "restore":
    case "control":
      return "event";
  }
};

const preparedBuildIdentity = (prepared: PreparedCandidateGodotBuildV1) => {
  const { createdAt, ...build } = prepared.build;
  void createdAt;
  return {
    build,
    fixtureHash: prepared.fixtureHash,
    projectHash: prepared.projectHash,
    addonHash: prepared.addonHash,
    fileCount: prepared.fileCount,
    byteLength: prepared.byteLength,
  };
};

const frameRate = (value: number): 60 | 120 => {
  if (value !== 60 && value !== 120) {
    throw new ToolFailure(
      "unsupported_capability",
      "managed frame and physics rates are limited to 60 or 120",
      true,
    );
  }
  return value;
};

const asObject = (input: unknown): Record<string, unknown> =>
  input as Record<string, unknown>;

const jsonObjectValue = (value: JsonValue): Record<string, JsonValue> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;

const checkpointDomainValue = (
  snapshot: EnvironmentSnapshot,
  domain: string,
  inputSchedule: StoredInputScheduleV1,
):
  | { readonly found: true; readonly value: JsonValue }
  | { readonly found: false } => {
  if (domain === "registered.state_providers") {
    return { found: true, value: json(snapshot.state) };
  }
  const runtimeState = jsonObjectValue(snapshot.runtimeState);
  if (domain === "logical_clock") {
    const nowUs = runtimeState?.["nowUs"];
    const nextTick = runtimeState?.["nextTick"];
    return nowUs === undefined || nextTick === undefined
      ? { found: false }
      : { found: true, value: json({ nowUs, nextTick }) };
  }
  if (domain === "input_schedule") {
    return { found: true, value: json(inputSchedule) };
  }
  if (domain === "pending_effects") {
    return { found: true, value: snapshot.pendingEffects };
  }
  if (domain.startsWith("participant.")) {
    const participantId = domain.slice("participant.".length);
    const participants = jsonObjectValue(
      runtimeState?.["participants"] ?? null,
    );
    const participant = participants?.[participantId];
    return participant === undefined
      ? { found: false }
      : { found: true, value: participant };
  }
  if (domain.startsWith("rng.")) {
    const rng = jsonObjectValue(snapshot.rngState);
    const value = rng?.[domain.slice("rng.".length)];
    return value === undefined ? { found: false } : { found: true, value };
  }
  return { found: false };
};

const isNotFound = (error: unknown): boolean =>
  error instanceof ArtifactNotFoundError ||
  (error instanceof Error && error.message === "not found");

const requestPointDue = (
  requested: GameRequestedPointV1,
  clock: VNextClockPositionV1,
): boolean =>
  requested.clock === "process_frame"
    ? clock.processFrame >= requested.requestedTick
    : clock.physicsTick >= requested.requestedTick;

const currentCoverage = (
  context: RuntimeContext,
): readonly VNextCaptureCoverageV1[] => {
  const loss = runtimeLoss(context);
  return context.capturePolicy.channels.map((requested) => {
    const coverageStart = context.coverageStarts.get(requested.channel) ?? {
      eventSequence: 0,
      clock: clockAt(0, 0, 0, 0),
    };
    const channelLoss = loss.filter(
      (entry) => entry.channel === requested.channel,
    );
    const channelEvents = context.events.filter(
      (event) =>
        event.sequence >= coverageStart.eventSequence &&
        event.channel === requested.channel &&
        event.kind !== "capture_loss",
    );
    const coverageClocks = [
      coverageStart.clock,
      ...channelEvents.map((event) => event.clock),
      context.clock,
    ];
    const clockDoesNotRegress = coverageClocks.every((clock, index) => {
      const previous = coverageClocks[index - 1];
      return (
        previous === undefined ||
        (clock.processFrame >= previous.processFrame &&
          clock.physicsTick >= previous.physicsTick &&
          clock.simulationTimeUs >= previous.simulationTimeUs &&
          clock.hostMonotonicUs >= previous.hostMonotonicUs &&
          (previous.renderFrame === null ||
            clock.renderFrame === null ||
            clock.renderFrame >= previous.renderFrame))
      );
    });
    const samplingDegraded = channelLoss.some(
      (entry) => entry.kind === "degraded",
    );
    const unavailableReason =
      channelEvents.length === 0 && channelLoss.length > 0
        ? "no retained records establish coverage for this channel"
        : samplingDegraded
          ? "the rolling capture receipt does not expose the final realized sampling interval"
          : null;
    const clockRangeLimitation = clockDoesNotRegress
      ? null
      : "coverage is a per-domain bounding envelope across a runtime clock discontinuity";
    const observedClocks = coverageClocks;
    const renderFrames = observedClocks.flatMap((clock) =>
      clock.renderFrame === null ? [] : [clock.renderFrame],
    );
    const availableRange =
      unavailableReason === null
        ? {
            schemaVersion: 1 as const,
            from: {
              ...clockAt(
                Math.min(...observedClocks.map((clock) => clock.processFrame)),
                Math.min(...observedClocks.map((clock) => clock.physicsTick)),
                Math.min(
                  ...observedClocks.map((clock) => clock.simulationTimeUs),
                ),
                Math.min(
                  ...observedClocks.map((clock) => clock.hostMonotonicUs),
                ),
              ),
              renderFrame:
                renderFrames.length === observedClocks.length
                  ? Math.min(...renderFrames)
                  : null,
            },
            through: {
              ...clockAt(
                Math.max(...observedClocks.map((clock) => clock.processFrame)),
                Math.max(...observedClocks.map((clock) => clock.physicsTick)),
                Math.max(
                  ...observedClocks.map((clock) => clock.simulationTimeUs),
                ),
                Math.max(
                  ...observedClocks.map((clock) => clock.hostMonotonicUs),
                ),
              ),
              renderFrame:
                renderFrames.length === observedClocks.length
                  ? Math.max(...renderFrames)
                  : null,
            },
          }
        : null;
    const droppedRecords = channelLoss
      .filter((entry) => entry.kind === "dropped")
      .reduce((total, entry) => total + entry.count, 0);
    const overwrittenRecords = channelLoss
      .filter((entry) => entry.kind === "overwritten")
      .reduce((total, entry) => total + entry.count, 0);
    const coverage = {
      schemaVersion: 1,
      channel: requested.channel,
      status:
        unavailableReason !== null
          ? "unavailable"
          : channelLoss.length === 0
            ? "full"
            : channelLoss.every(
                  (entry) =>
                    entry.kind === "sampled" ||
                    entry.kind === "observer_effect",
                )
              ? "sampled"
              : "partial",
      availableRange,
      requestedSampleEvery: requested.sampleEvery,
      realizedSampleEvery:
        unavailableReason === null ? requested.sampleEvery : null,
      emittedRecords: channelEvents.length,
      droppedRecords,
      overwrittenRecords,
      observerEffectUs:
        context.observerEffectUsByChannel.get(requested.channel) ?? 0,
      limitations: [
        ...channelLoss.map((entry) => entry.reason),
        ...(clockRangeLimitation === null ? [] : [clockRangeLimitation]),
        ...(unavailableReason === null ? [] : [unavailableReason]),
      ],
    } satisfies VNextCaptureCoverageV1;
    return coverage;
  });
};

const runtimeLoss = (context: RuntimeContext): readonly VNextCaptureLossV1[] =>
  [...context.capture.loss(), ...context.externalLoss].map((entry, sequence) =>
    VNextCaptureLossV1Schema.parse({ ...entry, sequence }),
  );

const runtimeOutput = (context: RuntimeContext) => ({
  runtime: context.runtime,
  runtimeId: context.runtimeId,
  executionId: context.executionId,
  state: context.state,
  clocks: context.clock,
  controls: {
    fixedFps: context.fixedFps,
    physicsTicksPerSecond: context.physicsTicksPerSecond,
    maxTicks: context.maxTicks,
    stepsUsed: context.stepsUsed,
  },
  coverage: currentCoverage(context),
  loss: runtimeLoss(context),
});

class GodotRuntimeCoordinator implements VNextGodotRuntimeCoordinator {
  readonly #contexts = new Map<RuntimeId, RuntimeContext>();
  readonly #executionContexts = new Map<ExecutionId, RuntimeContext>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #backgroundFailures = new Map<RuntimeId, Error>();
  readonly #earlyCleanupFailures: Error[] = [];
  readonly #now: () => string;
  readonly #nextId: (kind: ResourceKindPrefix) => string;
  readonly #nextToken: () => string;
  readonly #prepareBuild: typeof prepareCandidateGodotBuildV1;
  readonly #connectRuntime: (
    transport: GodotByteTransport,
    request: VNextGodotConnectRequestV1,
  ) => Promise<VNextGodotRuntimeClient>;
  readonly #gracefulSidecarExitMs: number;
  #phase: "open" | "closing" | "closed" = "open";
  #closeAttempt: Promise<void> | null = null;
  #totalLaunches = 0;
  #pendingLaunches = 0;
  #latestPrepared: PreparedCandidateGodotBuildV1 | null = null;
  #prepareQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly options: VNextGodotRuntimeCoordinatorOptions,
    dependencies: VNextGodotRuntimeCoordinatorDependencies,
  ) {
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#nextId = dependencies.nextId ?? ((kind) => `${kind}:${randomUUID()}`);
    this.#nextToken =
      dependencies.nextToken ??
      (() => randomUUID().replaceAll("-", "").padEnd(64, "0"));
    this.#prepareBuild =
      dependencies.prepareBuild ?? prepareCandidateGodotBuildV1;
    this.#connectRuntime =
      dependencies.connectRuntime ?? connectVNextGodotRuntime;
    this.#gracefulSidecarExitMs = dependencies.gracefulSidecarExitMs ?? 1_000;
    if (
      !Number.isInteger(this.#gracefulSidecarExitMs) ||
      this.#gracefulSidecarExitMs < 0 ||
      this.#gracefulSidecarExitMs > 5_000
    ) {
      throw new TypeError(
        "gracefulSidecarExitMs must be an integer between 0 and 5000",
      );
    }
  }

  public async invoke(
    request: VNextGameToolPortRequestV1,
    signal?: AbortSignal,
  ): Promise<CoordinatorToolResponse> {
    const startedAt = this.#now();
    let response: CoordinatorToolResponse;
    try {
      if (this.#phase !== "open") {
        throw new ToolFailure(
          "runtime_unavailable",
          "the task runtime coordinator is closed",
          true,
        );
      }
      if (!validateGameToolInputV1(request.toolName, request.input)) {
        throw new ToolFailure(
          "invalid_request",
          `invalid input for ${request.toolName}`,
          true,
        );
      }
      if (asObject(request.input)["taskId"] !== this.options.taskId) {
        throw new ToolFailure(
          "resource_task_mismatch",
          "tool input does not belong to this task",
          true,
        );
      }
      const output = await this.dispatch(
        request.toolName,
        asObject(request.input),
        signal,
      );
      if (!validateGameToolOutputV1(request.toolName, output)) {
        throw new Error(`invalid success output for ${request.toolName}`);
      }
      response = success(request.toolCallId, json(output));
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
              error instanceof Error
                ? error.message.slice(0, 4_096)
                : "game tool operation failed",
              false,
            );
    }
    await this.persistToolCall(request, startedAt, response);
    return response;
  }

  public async close(): Promise<void> {
    if (this.#phase === "closed") return;
    if (this.#closeAttempt !== null) return this.#closeAttempt;
    this.#phase = "closing";
    const attempt = this.closeUnsealedContexts();
    this.#closeAttempt = attempt;
    try {
      await attempt;
      this.#phase = "closed";
    } catch (error) {
      this.#phase = "open";
      throw error;
    } finally {
      this.#closeAttempt = null;
    }
  }

  private async closeUnsealedContexts(): Promise<void> {
    const running = [...this.#contexts.values()].filter(
      (context) => !context.sealed,
    );
    const cleanup = await Promise.allSettled(
      running.map((context) =>
        this.serialize(context.runtimeId, () =>
          this.stopContext(context, "turn_cleanup", null),
        ),
      ),
    );
    for (const [runtimeId] of this.#backgroundFailures) {
      if (this.#contexts.get(runtimeId)?.sealed === true) {
        this.#backgroundFailures.delete(runtimeId);
      }
    }
    const failures = [
      ...this.#earlyCleanupFailures,
      ...this.#backgroundFailures.values(),
      ...cleanup.flatMap((result) =>
        result.status === "rejected"
          ? [
              result.reason instanceof Error
                ? result.reason
                : new Error(String(result.reason)),
            ]
          : [],
      ),
    ];
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "one or more Godot runtime cleanup operations failed",
      );
    }
  }

  private async dispatch(
    toolName: GameToolNameV1,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    switch (toolName) {
      case GAME_TOOL_NAMES_V1.capabilities:
        return this.capabilities(input);
      case GAME_TOOL_NAMES_V1.launch:
        return this.launch(input, signal);
      case GAME_TOOL_NAMES_V1.status:
        return this.withKnownRuntime(input, (context) =>
          runtimeOutput(context),
        );
      case GAME_TOOL_NAMES_V1.stop:
        return this.withKnownRuntime(input, (context) =>
          this.stopContext(context, "requested_stop", null),
        );
      case GAME_TOOL_NAMES_V1.captureConfigure:
        return this.withRuntime(input, (context) =>
          this.configureCapture(context, input),
        );
      case GAME_TOOL_NAMES_V1.capturePin:
        return this.withRuntime(input, (context) =>
          this.pinCapture(context, input),
        );
      case GAME_TOOL_NAMES_V1.query:
        return this.query(input);
      case GAME_TOOL_NAMES_V1.input:
        return this.withRuntime(input, (context) =>
          this.queueInput(context, input),
        );
      case GAME_TOOL_NAMES_V1.step:
        return this.withRuntime(input, (context) => this.step(context, input));
      case GAME_TOOL_NAMES_V1.setControls:
        return this.withRuntime(input, (context) =>
          this.setControls(context, input),
        );
      case GAME_TOOL_NAMES_V1.checkpointCreate:
        return this.withRuntime(input, (context) =>
          this.createCheckpoint(context, input),
        );
      case GAME_TOOL_NAMES_V1.checkpointRestore:
        return this.withRuntime(input, (context) =>
          this.restoreCheckpoint(context, input),
        );
      case GAME_TOOL_NAMES_V1.fork:
        return this.fork(input, signal);
      case GAME_TOOL_NAMES_V1.traceCreate:
        return this.createTrace(input);
      case GAME_TOOL_NAMES_V1.traceReplay:
        return this.withRuntime(input, (context) =>
          this.replayTrace(
            context,
            String(input["traceId"]),
            Number(input["maxTicks"]),
          ),
        );
      case GAME_TOOL_NAMES_V1.compare:
        return this.compare(input);
    }
  }

  private async persistToolCall(
    request: VNextGameToolPortRequestV1,
    startedAt: string,
    response: CoordinatorToolResponse,
  ): Promise<void> {
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
        input: json(request.input),
        response: json(response),
      },
      (value) => StoredToolCallV1Schema.parse(value),
    );
  }

  private prepareBuild(): Promise<PreparedCandidateGodotBuildV1> {
    const prepared = this.#prepareQueue.then(() => this.prepareBuildOnce());
    this.#prepareQueue = prepared.then(
      () => undefined,
      () => undefined,
    );
    return prepared;
  }

  private async prepareBuildOnce(): Promise<PreparedCandidateGodotBuildV1> {
    const prepared = await this.#prepareBuild({
      taskId: this.options.taskId,
      workspaceId: this.options.workspaceId,
      workspaceDirectory: this.options.workspaceDirectory,
      baselineSourceHash: this.options.baselineSourceHash,
      fixtureCapability: this.options.fixtureCapability,
      managedRuntime: this.options.managedRuntime,
      now: this.#now(),
    });
    if (prepared.build.taskId !== this.options.taskId) {
      throw new ToolFailure(
        "resource_task_mismatch",
        "prepared build does not belong to this task",
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
          "prepared build identity collision changed immutable build facts",
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
          "persisted build identity collides with different immutable facts",
        );
      }
      this.#latestPrepared = reused;
      return reused;
    } catch (error) {
      if (!isNotFound(error)) throw error;
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

  private async capabilities(input: Record<string, unknown>): Promise<unknown> {
    const prepared = await this.prepareBuild();
    const runtimeId = input["runtimeId"];
    let runtime: ReturnType<typeof runtimeOutput> | null = null;
    if (typeof runtimeId === "string") {
      runtime = await this.serialize(runtimeId, () =>
        runtimeOutput(this.knownRuntime(runtimeId)),
      );
    }
    return {
      schemaVersion: 1,
      taskId: this.options.taskId,
      workspaceId: this.options.workspaceId,
      build: prepared.build,
      fixture: {
        fixtureId: this.options.fixtureCapability.fixtureId,
        inputActions: [...this.options.fixtureCapability.inputActions],
        frameRates: [60, 120],
        physicsRates: [60, 120],
        maxTicks: 600,
      },
      tools: GAME_TOOL_DEFINITIONS_V1.map((tool) => ({
        name: tool.name,
        capability: tool.capability,
      })),
      costs: {
        rollingHistorySecondsMaximum: 10,
        queryRowMaximum: 200,
        traceEventMaximum: 128,
      },
      unsupported: [
        "live fixed FPS/TPS changes require a new runtime",
        "engine-internal checkpoint state is not captured",
        "one coordinator turn admits at most two concurrent and eight total runtimes",
      ],
      runtime,
    };
  }

  private candidateLaunchFailureProof(
    sidecar: SandboxedGodotSidecarV1,
    prepared: PreparedCandidateGodotBuildV1,
    _error: unknown,
    stage: "launch" | "step" = "launch",
  ): JsonValue | null {
    const records = sidecar.diagnosticFacts().records;
    const staged = records.some(
      (record) =>
        record.kind === "stage_ready" &&
        record.fixtureHash === prepared.fixtureHash &&
        record.projectHash === prepared.projectHash &&
        record.addonHash === prepared.addonHash,
    );
    const started = records.some((record) => record.kind === "godot_started");
    if (!staged || !started) return null;
    const sourceBoundProcessFailure = records.some(
      (record) =>
        record.kind === "candidate_process_failure" &&
        record.candidateSourceHash === prepared.build.sourceHash &&
        record.reason === "nonzero_exit" &&
        record.exitCode > 0,
    );
    if (!sourceBoundProcessFailure) return null;
    return this.candidateSourceProof(prepared, stage);
  }

  private candidateSourceProof(
    prepared: PreparedCandidateGodotBuildV1,
    stage: "launch" | "step",
  ): JsonValue {
    return json(
      CandidateLaunchFailureProofV1Schema.parse({
        schemaVersion: 1,
        attribution: "candidate_source",
        stage,
        sourceHash: prepared.build.sourceHash,
      }),
    );
  }

  private candidateStepFailureProof(
    context: RuntimeContext,
    error: unknown,
  ): JsonValue | null {
    return this.candidateLaunchFailureProof(
      context.sidecar,
      context.prepared,
      error,
      "step",
    );
  }

  private async cleanupEarlySidecar(
    sidecar: SandboxedGodotSidecarV1,
  ): Promise<SandboxExecutionResultV1> {
    const failures: Error[] = [];
    try {
      await sidecar.terminate();
    } catch (error) {
      failures.push(
        error instanceof Error
          ? error
          : new Error("early sidecar termination failed"),
      );
    }
    let completion: SandboxExecutionResultV1 | undefined;
    try {
      completion = await sidecar.completion;
    } catch (error) {
      failures.push(
        error instanceof Error
          ? error
          : new Error("early sidecar completion receipt failed"),
      );
    }
    if (completion === undefined || !this.completionProvesCleanup(completion)) {
      failures.push(
        new Error("early sidecar completion did not prove sandbox cleanup"),
      );
    }
    if (failures.length > 0) {
      const failure = new AggregateError(
        failures,
        "early Godot sidecar cleanup failed or remained unproven",
      );
      this.#earlyCleanupFailures.push(failure);
      throw failure;
    }
    if (completion === undefined) {
      throw new Error("early sidecar completion receipt is unavailable");
    }
    return completion;
  }

  private async launch(
    input: Record<string, unknown>,
    signal?: AbortSignal,
    lineage?: {
      readonly branchId: BranchId | null;
      readonly checkpointId: CheckpointId | null;
      readonly traceId: TraceId | null;
      readonly capture?: GameCaptureProfileV1 | undefined;
      readonly freshStart?:
        | {
            readonly sourceExecutionId: ExecutionId;
            readonly skippedCheckpointId: CheckpointId | null;
            readonly reason: string;
          }
        | undefined;
    },
  ): Promise<ReturnType<typeof runtimeOutput> & { readonly build: unknown }> {
    const admitted =
      [...this.#contexts.values()].filter((context) => !context.sealed).length +
      this.#pendingLaunches;
    if (admitted >= 2) {
      throw new ToolFailure(
        "busy",
        "the task already has the maximum of two admitted Godot runtimes",
        true,
        json({ activeRuntimeLimit: 2, admittedRuntimes: admitted }),
      );
    }
    if (this.#totalLaunches >= 8) {
      throw new ToolFailure(
        "budget_exhausted",
        "the task reached the per-turn total Godot runtime limit",
        true,
        json({ totalRuntimeLimit: 8, launchedRuntimes: this.#totalLaunches }),
      );
    }
    this.#pendingLaunches += 1;
    this.#totalLaunches += 1;
    try {
      const prepared = await this.prepareBuild();
      if (input["buildId"] !== prepared.build.buildId) {
        throw new ToolFailure(
          "resource_not_found",
          "requested build is not the current candidate build",
          true,
          json({
            requestedBuildId: input["buildId"],
            currentBuildId: prepared.build.buildId,
          }),
        );
      }
      const requestedControls =
        (input["controls"] as GameRuntimeControlsV1 | undefined) ?? {};
      const fixedFps = frameRate(
        requestedControls.fixedFps ??
          this.options.fixtureCapability.controls.fixedFps.default,
      );
      const physicsTicksPerSecond = frameRate(
        requestedControls.physicsTicksPerSecond ??
          this.options.fixtureCapability.controls.physicsTicksPerSecond.default,
      );
      const maxTicks =
        requestedControls.maxTicks ??
        this.options.fixtureCapability.controls.maxTicks.default;
      const runtimeId = asRuntimeId(this.#nextId("runtime"));
      const executionId = asExecutionId(this.#nextId("execution"));
      const adapterId = asAdapterId(`adapter:${prepared.addonHash}`);
      const probeIds = [
        asProbeId(`probe:${this.options.fixtureCapability.capabilitySha256}`),
      ];
      const token = this.#nextToken();
      const launch = RuntimeSidecarLaunchV1Schema.parse({
        schemaVersion: 1,
        taskId: this.options.taskId,
        buildId: prepared.build.buildId,
        runtimeId,
        executionId,
        candidateSourceHash: prepared.build.sourceHash,
        fixtureHash: prepared.fixtureHash,
        projectHash: prepared.projectHash,
        addonHash: prepared.addonHash,
        protocolVersion: 2,
        token,
        fixedFps,
        physicsTicksPerSecond,
        fixtureControls: {},
        startupTimeoutMs: 30_000,
        executionTimeoutMs: 600_000,
        diagnosticFrameMaxBytes: 256 * 1024,
        diagnosticTotalMaxBytes: 2 * 1024 * 1024,
        diagnosticMaxCount: 128,
      } satisfies RuntimeSidecarLaunchV1);
      const opened = await this.options.sidecarPort.open(launch, signal);
      if (opened.kind !== "opened") {
        if (
          opened.kind === "executed" &&
          !this.completionProvesCleanup(opened)
        ) {
          const cleanupFailure = new Error(
            "failed sidecar admission did not prove sandbox cleanup",
          );
          this.#earlyCleanupFailures.push(cleanupFailure);
          throw cleanupFailure;
        }
        throw new ToolFailure(
          opened.kind === "denied" ? "permission_denied" : "operation_failed",
          "Godot runtime sidecar did not open",
          opened.kind === "denied",
          json({ kind: opened.kind }),
        );
      }
      let client: VNextGodotRuntimeClient;
      try {
        const expectedFingerprint = RuntimeFingerprintV1Schema.parse({
          schemaVersion: 1,
          engine: "godot",
          engineVersion: this.options.managedRuntime.engineVersion,
          adapterVersion: this.options.managedRuntime.adapterVersion,
          protocolVersion: 2,
          platform: "Linux",
          renderer: "gl_compatibility",
          physicsTicksPerSecond,
          fixedFps,
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
        client = await this.#connectRuntime(opened.sidecar.transport, {
          schemaVersion: 1,
          token,
          expectedFingerprint,
          requiredCapabilities: expectedFingerprint.capabilities,
          probePlan: {
            schemaVersion: 1,
            signals: [{ source: "player", name: "player.left_ledge" }],
            properties: [
              "player.jumping",
              "player.window_open",
              "player.process_callbacks",
            ],
          },
          handshakeTimeoutMs: 30_000,
        });
      } catch (error) {
        await this.cleanupEarlySidecar(opened.sidecar);
        const attribution = this.candidateLaunchFailureProof(
          opened.sidecar,
          prepared,
          error,
        );
        if (attribution !== null) {
          throw new ToolFailure(
            "operation_failed",
            "candidate Godot source failed during launch",
            false,
            attribution,
          );
        }
        throw error;
      }
      const startedAt = this.#now();
      const policy = capturePolicy(lineage?.capture);
      const runtime = VNextRuntimeV1Schema.parse({
        schemaVersion: 1,
        taskId: this.options.taskId,
        runtimeId,
        buildId: prepared.build.buildId,
        sourceId: prepared.build.sourceId,
        adapter: {
          schemaVersion: 1,
          adapterId,
          contentHash: prepared.addonHash,
          protocolVersion: "2",
        },
        probes: probeIds.map((probeId) => ({
          schemaVersion: 1,
          probeId,
          contentHash: this.options.fixtureCapability.capabilitySha256,
          channels: ["state_summary", "probe"],
        })),
        capabilities: [...client.fingerprint.capabilities],
        startedAt,
        status: "running",
      });
      const manifest = VNextExecutionManifestV1Schema.parse({
        schemaVersion: 1,
        taskId: this.options.taskId,
        executionId,
        runtimeId,
        workspaceId: this.options.workspaceId,
        sourceId: prepared.build.sourceId,
        buildId: prepared.build.buildId,
        adapterId,
        stateSchemaVersion: "frame-input-window:v1",
        probeIds,
        traceId: lineage?.traceId ?? null,
        startCheckpointId: lineage?.checkpointId ?? null,
        branchId: lineage?.branchId ?? null,
        launchTarget: this.options.fixtureCapability.startupScene,
        launchParameters: {
          schemaVersion: 1,
          fixedFps,
          physicsTicksPerSecond,
          maxTicks,
          ...(lineage?.freshStart === undefined
            ? {}
            : {
                freshStart: {
                  schemaVersion: 1,
                  sourceExecutionId: lineage.freshStart.sourceExecutionId,
                  skippedCheckpointId:
                    lineage.freshStart.skippedCheckpointId ?? null,
                  reason: lineage.freshStart.reason,
                },
              }),
        },
        controls: runtimeControlReceipt(fixedFps, physicsTicksPerSecond),
        clockDomains: [
          "process_frame",
          "physics_tick",
          "simulation_time",
          "host_monotonic",
        ],
        capturePolicy: policy,
        startedAt,
      });
      const context = {} as RuntimeContext;
      Object.assign(context, {
        runtimeId,
        executionId,
        prepared,
        adapterId,
        probeIds,
        client,
        sidecar: opened.sidecar,
        startedAt,
        runtime,
        manifest,
        capturePolicy: policy,
        captureProfileInput: lineage?.capture ?? null,
        events: [],
        persistedEventIds: new Set<string>(),
        eventIdsByLocalId: new Map<string, EventId>(),
        entityIncarnations: new Map<string, number>(),
        captureWindowIds: [],
        pendingInputs: [],
        inputReceipts: [],
        observerEffectUsByChannel: new Map<VNextCaptureChannelV1, number>(),
        coverageStarts: new Map(
          policy.channels.map((requested) => [
            requested.channel,
            { eventSequence: 0, clock: clockAt(0, 0, 0, 0) },
          ]),
        ),
        externalLoss: [],
        recordedDiagnosticCount: 0,
        diagnosticFailureRecorded: false,
        nextInputOrder: 0,
        stepsUsed: 0,
        maxTicks,
        fixedFps,
        physicsTicksPerSecond,
        clock: clockAt(0, 0, 0, 0),
        state: { values: {} },
        status: "running",
        sealed: false,
        finalCheckpointId: lineage?.checkpointId ?? null,
        pendingTermination: null,
        failureAttribution: null,
        terminalPersistence: null,
      });
      context.capture = this.newCapture(context, policy);
      this.#contexts.set(runtimeId, context);
      this.#executionContexts.set(executionId, context);
      const completionMonitor = opened.sidecar.completion.then(
        async (result) => {
          if (context.status !== "running") return;
          return this.serialize(runtimeId, async () => {
            if (context.status !== "running") return;
            await this.appendSidecarDiagnostics(context);
            await this.appendSidecarCompletion(context, result);
            if (!this.completionProvesCleanup(result)) {
              context.status = "failed";
              throw new Error(
                "Godot sidecar completed without a proven sandbox cleanup receipt",
              );
            }
            context.failureAttribution = this.candidateLaunchFailureProof(
              context.sidecar,
              context.prepared,
              new GodotAdapterError(
                "PROCESS_FAILED",
                "Godot exited while the runtime was active",
              ),
              "step",
            );
            await this.appendRaw(context, {
              channel: "error",
              kind: "crash",
              clock: context.clock,
              payload: {
                schemaVersion: 1,
                exitKind: result.kind,
                status:
                  result.kind === "executed" ? result.receipt.status : "denied",
                attribution: context.failureAttribution,
              },
              observerEffectUs: 0,
            });
            await this.finalize(
              context,
              "crashed",
              "sidecar_exit",
              "Godot sidecar exited while the runtime was active",
            );
          });
        },
      );
      void completionMonitor.catch((error: unknown) => {
        this.#backgroundFailures.set(
          runtimeId,
          error instanceof Error
            ? error
            : new Error("sidecar completion monitoring failed"),
        );
      });
      return {
        ...runtimeOutput(context),
        build: {
          buildId: prepared.build.buildId,
          sourceId: prepared.build.sourceId,
          sourceHash: prepared.build.sourceHash,
        },
      };
    } finally {
      this.#pendingLaunches -= 1;
    }
  }

  private newCapture(
    context: Pick<
      RuntimeContext,
      "runtimeId" | "executionId" | "prepared" | "adapterId" | "probeIds"
    >,
    policy: VNextCapturePolicyV1,
  ): VNextRollingCapture {
    return new VNextRollingCapture({
      taskId: this.options.taskId,
      executionId: context.executionId,
      runtimeId: context.runtimeId,
      sourceId: context.prepared.build.sourceId,
      buildId: context.prepared.build.buildId,
      adapterId: context.adapterId,
      probeIds: context.probeIds,
      policy,
      eventIds: {
        nextEventId: () => asEventId(this.#nextId("event")),
      },
    });
  }

  private async serialize<T>(
    key: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(
      () => gate,
      () => gate,
    );
    this.#queues.set(key, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#queues.get(key) === queued) this.#queues.delete(key);
    }
  }

  private withRuntime<T>(
    input: Record<string, unknown>,
    operation: (context: RuntimeContext) => Promise<T> | T,
  ): Promise<T> {
    const runtimeId = String(input["runtimeId"]);
    return this.serialize(runtimeId, () =>
      operation(this.requireRuntime(runtimeId)),
    );
  }

  private withKnownRuntime<T>(
    input: Record<string, unknown>,
    operation: (context: RuntimeContext) => Promise<T> | T,
  ): Promise<T> {
    const runtimeId = String(input["runtimeId"]);
    return this.serialize(runtimeId, () =>
      operation(this.knownRuntime(runtimeId)),
    );
  }

  private knownRuntime(runtimeId: string): RuntimeContext {
    const context = this.#contexts.get(asRuntimeId(runtimeId));
    if (context === undefined) {
      throw new ToolFailure(
        "resource_not_found",
        "runtime resource was not found in this task",
        true,
        json({ runtimeId }),
      );
    }
    if (context.runtime.taskId !== this.options.taskId) {
      throw new ToolFailure(
        "resource_task_mismatch",
        "runtime does not belong to this task",
        true,
      );
    }
    return context;
  }

  private requireRuntime(runtimeId: string): RuntimeContext {
    const context = this.knownRuntime(runtimeId);
    if (context.status === "crashed") {
      throw new ToolFailure(
        "runtime_crashed",
        "runtime has crashed; launch or fork another runtime",
        true,
        context.failureAttribution ??
          json({ runtimeId, executionId: context.executionId }),
      );
    }
    if (context.status !== "running") {
      throw new ToolFailure(
        "runtime_unavailable",
        "runtime is not active",
        true,
        context.failureAttribution ??
          json({ runtimeId, status: context.status }),
      );
    }
    return context;
  }

  private async appendRaw(
    context: RuntimeContext,
    input: {
      readonly channel: VNextCaptureChannelV1;
      readonly kind: VNextRawRuntimeEventV1["kind"];
      readonly clock: VNextClockPositionV1;
      readonly payload: JsonObject;
      readonly observerEffectUs: number;
      readonly observedRelations?:
        readonly VNextObservedRelationV1[] | undefined;
    },
  ): Promise<VNextRawRuntimeEventV1 | null> {
    if (
      !context.capturePolicy.channels.some(
        (requested) => requested.channel === input.channel,
      )
    ) {
      return null;
    }
    context.observerEffectUsByChannel.set(
      input.channel,
      (context.observerEffectUsByChannel.get(input.channel) ?? 0) +
        input.observerEffectUs,
    );
    let materialized: VNextRawRuntimeEventV1 | null;
    try {
      materialized = context.capture.append({
        channel: input.channel,
        kind: input.kind,
        clock: input.clock,
        payload: input.payload,
        observedRelations: input.observedRelations ?? [],
        recordedBytes: Buffer.byteLength(JSON.stringify(input.payload), "utf8"),
        observerEffectUs: input.observerEffectUs,
        mainThreadBlockUs: 0,
        overheadRatio: 0,
      });
    } catch (error) {
      if (!(error instanceof VNextCaptureCapacityError)) throw error;
      context.status = "failed";
      context.pendingTermination = {
        status: "failed",
        code: error.code,
        message: error.message,
      };
      context.failureAttribution = null;
      throw new ToolFailure(
        "budget_exhausted",
        "runtime capture reached a bounded Host capacity",
        true,
        json({
          runtimeId: context.runtimeId,
          executionId: context.executionId,
          captureCode: error.code,
          message: error.message,
        }),
      );
    }
    const candidates = [
      ...context.capture.records(),
      ...(materialized === null ? [] : [materialized]),
    ].sort((left, right) => left.sequence - right.sequence);
    for (const event of candidates) {
      if (context.persistedEventIds.has(event.eventId)) continue;
      await this.options.runtimeStore.appendExecutionEvent(
        context.executionId,
        event,
        (value) => VNextRawRuntimeEventV1Schema.parse(value),
      );
      context.persistedEventIds.add(event.eventId);
      context.events.push(event);
      context.events.sort((left, right) => left.sequence - right.sequence);
    }
    return materialized;
  }

  private configureCapture(
    context: RuntimeContext,
    input: Record<string, unknown>,
  ): unknown {
    if (context.events.length > 0) {
      throw new ToolFailure(
        "conflict",
        "capture profile cannot be replaced after raw records exist",
        true,
      );
    }
    const triggers = input["triggers"] as readonly unknown[];
    if (triggers.length > 0) {
      throw new ToolFailure(
        "unsupported_capability",
        "automatic capture triggers are not implemented by this managed runtime",
        true,
        json({ requestedTriggers: triggers, realizedTriggers: [] }),
      );
    }
    const profile: GameCaptureProfileV1 = {
      historySeconds: Number(input["historySeconds"]),
      maxTicks: Number(input["maxTicks"]),
      channels: input["channels"] as GameCaptureProfileV1["channels"],
      stateSampleEveryTicks: Number(input["stateSampleEveryTicks"]),
      triggers: [],
    };
    const policy = capturePolicy(profile);
    context.capturePolicy = policy;
    context.captureProfileInput = profile;
    context.capture = this.newCapture(context, policy);
    context.externalLoss.length = 0;
    context.observerEffectUsByChannel.clear();
    context.coverageStarts.clear();
    for (const requested of policy.channels) {
      context.coverageStarts.set(requested.channel, {
        eventSequence: context.events.length,
        clock: context.clock,
      });
    }
    context.manifest = VNextExecutionManifestV1Schema.parse({
      ...context.manifest,
      capturePolicy: policy,
      launchParameters: {
        ...context.manifest.launchParameters,
        captureTriggers: profile.triggers,
      },
    });
    return {
      runtimeId: context.runtimeId,
      requested: profile,
      realized: policy,
      coverage: currentCoverage(context),
      loss: runtimeLoss(context),
    };
  }

  private async pinCapture(
    context: RuntimeContext,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    await this.appendSidecarDiagnostics(context);
    const anchor = input["anchor"] as GameRequestedPointV1 | undefined;
    const baseTick =
      anchor?.requestedTick ??
      (anchor?.clock === "physics_tick"
        ? context.clock.physicsTick
        : context.clock.processFrame);
    const before = Number(input["beforeTicks"]);
    const after = Number(input["afterTicks"]);
    const fromTick = Math.max(0, baseTick - before);
    const throughTick = baseTick + after;
    const clockDomain = anchor?.clock ?? "process_frame";
    const candidates = context.capture
      .records()
      .filter((event) => event.kind !== "capture_loss")
      .filter((event) => {
        const tick =
          clockDomain === "physics_tick"
            ? event.clock.physicsTick
            : event.clock.processFrame;
        return tick >= fromTick && tick <= throughTick;
      });
    const observedClocks = candidates.map((event) => event.clock);
    const renderFrames = observedClocks.flatMap((clock) =>
      clock.renderFrame === null ? [] : [clock.renderFrame],
    );
    const fromBase =
      observedClocks.length === 0
        ? context.clock
        : {
            ...clockAt(
              Math.min(...observedClocks.map((clock) => clock.processFrame)),
              Math.min(...observedClocks.map((clock) => clock.physicsTick)),
              Math.min(
                ...observedClocks.map((clock) => clock.simulationTimeUs),
              ),
              Math.min(...observedClocks.map((clock) => clock.hostMonotonicUs)),
            ),
            renderFrame:
              renderFrames.length === observedClocks.length
                ? Math.min(...renderFrames)
                : null,
          };
    const throughBase =
      observedClocks.length === 0
        ? context.clock
        : {
            ...clockAt(
              Math.max(...observedClocks.map((clock) => clock.processFrame)),
              Math.max(...observedClocks.map((clock) => clock.physicsTick)),
              Math.max(
                ...observedClocks.map((clock) => clock.simulationTimeUs),
              ),
              Math.max(...observedClocks.map((clock) => clock.hostMonotonicUs)),
            ),
            renderFrame:
              renderFrames.length === observedClocks.length
                ? Math.max(...renderFrames)
                : null,
          };
    const from = {
      ...fromBase,
      ...(clockDomain === "physics_tick"
        ? { physicsTick: fromTick }
        : { processFrame: fromTick }),
    };
    const through = {
      ...throughBase,
      ...(clockDomain === "physics_tick"
        ? { physicsTick: throughTick }
        : { processFrame: throughTick }),
    };
    const captureWindowId = asCaptureWindowId(this.#nextId("capture-window"));
    const result = context.capture.pin({
      captureWindowId,
      requestedRange: { schemaVersion: 1, from, through },
      frozenBy: "manual_pin",
      pinnedAt: this.#now(),
    });
    const relevantExternalLoss = context.externalLoss.filter((loss) => {
      const at = loss.firstClock;
      if (at === null) return true;
      const tick =
        clockDomain === "physics_tick" ? at.physicsTick : at.processFrame;
      return tick >= fromTick && tick <= throughTick;
    });
    const mergedLoss = [...result.window.loss, ...relevantExternalLoss].map(
      (loss, sequence) => VNextCaptureLossV1Schema.parse({ ...loss, sequence }),
    );
    const window =
      relevantExternalLoss.length === 0
        ? result.window
        : VNextCaptureWindowV1Schema.parse({
            ...result.window,
            status:
              result.window.status === "unavailable"
                ? "unavailable"
                : "partial",
            loss: mergedLoss,
            coverage: result.window.coverage.map((coverage) => {
              const channelLoss = relevantExternalLoss.filter(
                (loss) => loss.channel === coverage.channel,
              );
              return channelLoss.length === 0
                ? coverage
                : {
                    ...coverage,
                    status:
                      coverage.status === "unavailable"
                        ? "unavailable"
                        : "partial",
                    limitations: [
                      ...new Set([
                        ...coverage.limitations,
                        ...channelLoss.map((loss) => loss.reason),
                      ]),
                    ],
                  };
            }),
          });
    await this.options.runtimeStore.putResourceOnce(
      "capture",
      captureWindowId,
      window,
      (value) => VNextCaptureWindowV1Schema.parse(value),
    );
    await this.persistCaptureRecords(context);
    context.captureWindowIds.push(captureWindowId);
    context.manifest = VNextExecutionManifestV1Schema.parse({
      ...context.manifest,
      launchParameters: {
        ...context.manifest.launchParameters,
        captureWindowIds: [...context.captureWindowIds],
      },
    });
    if (result.code === "history_window_unavailable") {
      throw new ToolFailure(
        "history_window_unavailable",
        "requested capture history is unavailable",
        true,
        json({ window }),
      );
    }
    return { window, events: result.events };
  }

  private async persistCaptureRecords(context: RuntimeContext): Promise<void> {
    for (const event of [...context.capture.records()].sort(
      (left, right) => left.sequence - right.sequence,
    )) {
      if (context.persistedEventIds.has(event.eventId)) continue;
      await this.options.runtimeStore.appendExecutionEvent(
        context.executionId,
        event,
        (value) => VNextRawRuntimeEventV1Schema.parse(value),
      );
      context.persistedEventIds.add(event.eventId);
      context.events.push(event);
      context.events.sort((left, right) => left.sequence - right.sequence);
    }
  }

  private async queueInput(
    context: RuntimeContext,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (context.pendingInputs.length >= MAX_PENDING_INPUTS) {
      throw new ToolFailure(
        "budget_exhausted",
        `runtime input queue is limited to ${MAX_PENDING_INPUTS} pending requests`,
        true,
        json({
          runtimeId: context.runtimeId,
          pendingInputs: context.pendingInputs.length,
          maximumPendingInputs: MAX_PENDING_INPUTS,
        }),
      );
    }
    const requestId = `input-request:${randomUUID()}`;
    const pending: PendingInput = {
      requestId,
      action: "attempt_jump",
      ...(typeof input["targetEntityId"] === "string"
        ? { targetEntityId: input["targetEntityId"] }
        : {}),
      requested: input["requested"] as GameRequestedPointV1,
      order: context.nextInputOrder++,
    };
    context.pendingInputs.push(pending);
    await this.appendRaw(context, {
      channel: "input",
      kind: "input",
      clock: context.clock,
      payload: json({
        schemaVersion: 1,
        eventType: "input_requested",
        requestId,
        action: pending.action,
        targetEntityId: pending.targetEntityId ?? null,
        requested: pending.requested,
        order: pending.order,
      }) as JsonObject,
      observerEffectUs: 0,
    });
    return {
      runtimeId: context.runtimeId,
      requestId,
      action: pending.action,
      requested: pending.requested,
      queued: true,
      realized: null,
    };
  }

  private async step(
    context: RuntimeContext,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const count = Number(input["count"]);
    const requestedClock = String(input["clock"]);
    const startedClock = context.clock;
    const stepReceipts: JsonValue[] = [];
    const realizedInputs: InputRealizationReceipt[] = [];
    const progressed = (): number =>
      requestedClock === "physics_tick"
        ? context.clock.physicsTick - startedClock.physicsTick
        : context.clock.processFrame - startedClock.processFrame;
    while (progressed() < count) {
      if (context.stepsUsed + 1 > context.maxTicks) {
        throw new ToolFailure(
          "budget_exhausted",
          "step request could not reach its clock target within maxTicks",
          true,
          json({
            maxTicks: context.maxTicks,
            stepsUsed: context.stepsUsed,
            requested: { clock: requestedClock, count },
            realized: {
              processFrames:
                context.clock.processFrame - startedClock.processFrame,
              physicsTicks:
                context.clock.physicsTick - startedClock.physicsTick,
            },
          }),
        );
      }
      const before = context.clock;
      const due = context.pendingInputs.filter((pending) =>
        requestPointDue(pending.requested, before),
      );
      const deltaUs = Math.round(1_000_000 / context.fixedFps);
      let result: VNextGodotStepResultV1;
      try {
        result = await context.client.step({
          tick: context.stepsUsed,
          simTimeUs: before.simulationTimeUs,
          deltaUs,
          inputs: due.map((pending) => ({
            localId: pending.requestId,
            order: pending.order,
            action: pending.action,
            ...(pending.targetEntityId === undefined
              ? {}
              : { target: pending.targetEntityId }),
            payload: {},
          })),
        });
      } catch (error) {
        const attribution = this.candidateStepFailureProof(context, error);
        await this.markRuntimeFailure(
          context,
          "runtime_step_failed",
          error instanceof Error ? error.message : "runtime step failed",
          attribution,
        );
        throw new ToolFailure(
          "runtime_unavailable",
          "Godot runtime step failed",
          true,
          attribution ?? undefined,
        );
      }
      const runtimeReceipt = result.receipt.runtime;
      if (
        runtimeReceipt.observationHealth.emittedEvents !== result.events.length
      ) {
        await this.markRuntimeFailure(
          context,
          "invalid_observation_receipt",
          "Godot observation health emittedEvents does not match the delivered event batch",
        );
        throw new ToolFailure(
          "runtime_unavailable",
          "Godot returned an inconsistent observation health receipt",
          true,
        );
      }
      if (
        runtimeReceipt.hostMonotonicStartUs < before.hostMonotonicUs ||
        runtimeReceipt.hostMonotonicEndUs < runtimeReceipt.hostMonotonicStartUs
      ) {
        await this.markRuntimeFailure(
          context,
          "invalid_runtime_receipt",
          "Godot runtime receipt contains a regressed Host monotonic clock",
        );
        throw new ToolFailure(
          "runtime_unavailable",
          "Godot runtime returned a regressed Host monotonic clock",
          true,
        );
      }
      const actualIdleDeltaUs = runtimeReceipt.actualIdleDeltasUs.reduce(
        (total, value) => total + value,
        0,
      );
      if (
        result.receipt.requestedTick !== context.stepsUsed ||
        result.receipt.realizedTick !== context.stepsUsed ||
        result.receipt.requestedDeltaUs !== deltaUs ||
        result.receipt.realizedDeltaUs !== actualIdleDeltaUs
      ) {
        await this.markRuntimeFailure(
          context,
          "invalid_runtime_receipt",
          "Godot runtime receipt does not match the issued step or realized idle deltas",
        );
        throw new ToolFailure(
          "runtime_unavailable",
          "Godot runtime returned an inconsistent step receipt",
          true,
        );
      }
      const dueOrders = new Set(due.map((pending) => pending.order));
      const dueOrderPositions = new Map(
        due.map((pending, index) => [pending.order, index]),
      );
      const appliedOrders = result.receipt.appliedInputOrders;
      const applicationOrders = runtimeReceipt.inputApplications.map(
        (application) => application.order,
      );
      const appliedSet = new Set(appliedOrders);
      const applicationSet = new Set(applicationOrders);
      const invalidApplicationReceipt =
        appliedSet.size !== appliedOrders.length ||
        applicationSet.size !== applicationOrders.length ||
        appliedOrders.some((order) => !dueOrders.has(order)) ||
        applicationOrders.some((order) => !dueOrders.has(order)) ||
        appliedSet.size !== applicationSet.size ||
        appliedOrders.some(
          (order, index) => applicationOrders[index] !== order,
        ) ||
        appliedOrders.some(
          (order, index) =>
            index > 0 &&
            (dueOrderPositions.get(order) ?? -1) <=
              (dueOrderPositions.get(appliedOrders[index - 1]!) ?? -1),
        );
      if (invalidApplicationReceipt) {
        await this.markRuntimeFailure(
          context,
          "invalid_input_application_receipt",
          "Godot input application orders did not match the step receipt",
        );
        throw new ToolFailure(
          "runtime_unavailable",
          "Godot returned an inconsistent input application receipt",
          true,
        );
      }
      const realizedClock = clockAt(
        before.processFrame,
        before.physicsTick,
        before.simulationTimeUs,
        runtimeReceipt.hostMonotonicStartUs,
      );
      for (const pending of due.filter((candidate) =>
        appliedSet.has(candidate.order),
      )) {
        const requestedPosition = pending.requested.requestedTick;
        const realizedPosition =
          pending.requested.clock === "process_frame"
            ? realizedClock.processFrame
            : realizedClock.physicsTick;
        const realizedPhase = runtimeReceipt.phase;
        const quantized =
          requestedPosition !== realizedPosition ||
          pending.requested.requestedPhase !== realizedPhase;
        const receipt: InputRealizationReceipt = {
          schemaVersion: 1,
          requestId: pending.requestId,
          requested: pending.requested,
          realized: {
            ...realizedClock,
            phase: realizedPhase,
            quantized,
            mismatchReason: quantized
              ? "Godot input injection is realized at process_frame_start"
              : null,
          },
          knownSideEffects: [
            "InputEventAction press and release were injected",
          ],
        };
        realizedInputs.push(receipt);
        context.inputReceipts.push(receipt);
        const realizedEvent = await this.appendRaw(context, {
          channel: "input",
          kind: "input",
          clock: realizedClock,
          payload: json({
            schemaVersion: 1,
            eventType: "input_realized",
            requestId: pending.requestId,
            action: pending.action,
            requested: pending.requested,
            realized: receipt.realized,
          }) as JsonObject,
          observerEffectUs: runtimeReceipt.observationHealth.probeOverheadUs,
        });
        if (realizedEvent !== null) {
          context.eventIdsByLocalId.set(
            pending.requestId,
            realizedEvent.eventId,
          );
        }
      }
      for (const pending of due.filter(
        (candidate) => !appliedSet.has(candidate.order),
      )) {
        await this.appendRaw(context, {
          channel: "input",
          kind: "input",
          clock: realizedClock,
          payload: json({
            schemaVersion: 1,
            eventType: "input_delivery_attempt",
            requestId: pending.requestId,
            action: pending.action,
            requested: pending.requested,
            realized: null,
            mismatchReason:
              "runtime did not report this due input order as applied",
          }) as JsonObject,
          observerEffectUs: runtimeReceipt.observationHealth.probeOverheadUs,
        });
      }
      for (const pending of due.filter((candidate) =>
        appliedSet.has(candidate.order),
      )) {
        const pendingIndex = context.pendingInputs.indexOf(pending);
        if (pendingIndex >= 0) context.pendingInputs.splice(pendingIndex, 1);
      }
      context.stepsUsed += 1;
      context.clock = clockAt(
        before.processFrame + runtimeReceipt.idleFramesExecuted,
        before.physicsTick + runtimeReceipt.physicsTicksExecuted,
        before.simulationTimeUs + result.receipt.realizedDeltaUs,
        runtimeReceipt.hostMonotonicEndUs,
      );
      context.state = StateSnapshotSchema.parse(result.state);
      await this.recordObservationHealth(
        context,
        runtimeReceipt.observationHealth,
        before,
        context.clock,
      );
      await this.appendRaw(context, {
        channel: "clock",
        kind: "clock",
        clock: context.clock,
        payload: json({
          schemaVersion: 1,
          requestedTick: result.receipt.requestedTick,
          realizedTick: result.receipt.realizedTick,
          requestedDeltaUs: result.receipt.requestedDeltaUs,
          realizedDeltaUs: result.receipt.realizedDeltaUs,
          idleFramesExecuted: runtimeReceipt.idleFramesExecuted,
          physicsTicksExecuted: runtimeReceipt.physicsTicksExecuted,
        }) as JsonObject,
        observerEffectUs: runtimeReceipt.observationHealth.probeOverheadUs,
      });
      await this.captureStepEvents(context, result);
      for (const [statePath, value] of Object.entries(result.state.values)) {
        await this.appendRaw(context, {
          channel: "state_summary",
          kind: "state",
          clock: context.clock,
          payload: json({
            schemaVersion: 1,
            entity: {
              stableId: "player",
              incarnation: 1,
              sceneId: "fixture.main",
              parentStableId: null,
              ownerStableId: null,
            },
            statePath,
            value,
          }) as JsonObject,
          observerEffectUs: runtimeReceipt.observationHealth.probeOverheadUs,
        });
      }
      stepReceipts.push(json(result.receipt));
    }
    return {
      runtimeId: context.runtimeId,
      executionId: context.executionId,
      requested: { clock: requestedClock, count },
      realized: {
        processFrames: context.clock.processFrame - startedClock.processFrame,
        physicsTicks: context.clock.physicsTick - startedClock.physicsTick,
        requestedClockProgress: progressed(),
        overshoot: Math.max(0, progressed() - count),
      },
      state: context.state,
      clocks: context.clock,
      receipts: realizedInputs,
      stepReceipts,
      pendingInputs: context.pendingInputs.map((pending) => ({
        requestId: pending.requestId,
        requested: pending.requested,
      })),
      coverage: currentCoverage(context),
      loss: runtimeLoss(context),
    };
  }

  private async markRuntimeFailure(
    context: RuntimeContext,
    code: string,
    message: string,
    attribution: JsonValue | null = null,
  ): Promise<void> {
    context.status = "failed";
    context.pendingTermination = {
      status: "failed",
      code,
      message,
    };
    context.failureAttribution = attribution;
    await this.appendRaw(context, {
      channel: "error",
      kind: "error",
      clock: context.clock,
      payload: json({
        schemaVersion: 1,
        code,
        message,
        attribution,
      }) as JsonObject,
      observerEffectUs: 0,
    });
  }

  private async recordObservationHealth(
    context: RuntimeContext,
    health: VNextGodotStepResultV1["receipt"]["runtime"]["observationHealth"],
    firstClock: VNextClockPositionV1,
    lastClock: VNextClockPositionV1,
  ): Promise<void> {
    const observations = [
      ...(health.droppedEvents > 0
        ? [
            {
              kind: "dropped" as const,
              count: health.droppedEvents,
              reason: "Godot observation health reported dropped events",
            },
          ]
        : []),
      ...(health.truncatedEvents > 0
        ? [
            {
              kind: "degraded" as const,
              count: health.truncatedEvents,
              reason: "Godot observation health reported truncated events",
            },
          ]
        : []),
      ...(health.backpressure
        ? [
            {
              kind: "degraded" as const,
              count: 0,
              reason: "Godot observation health reported backpressure",
            },
          ]
        : []),
    ];
    const affectedChannels = context.capturePolicy.channels
      .map((channel) => channel.channel)
      .filter(
        (channel) =>
          channel === "probe" ||
          channel === "log" ||
          channel === "error" ||
          channel === "entity_lifecycle",
      );
    for (const observation of observations) {
      for (const channel of affectedChannels) {
        const loss = VNextCaptureLossV1Schema.parse({
          schemaVersion: 1,
          sequence: context.externalLoss.length,
          channel,
          kind: observation.kind,
          count: observation.count,
          firstClock,
          lastClock,
          reason: observation.reason,
        });
        context.externalLoss.push(loss);
        await this.appendRaw(context, {
          channel,
          kind: "capture_loss",
          clock: context.clock,
          payload: json({
            schemaVersion: 1,
            channel,
            kind: observation.kind,
            count: observation.count,
            reason: observation.reason,
          }) as JsonObject,
          observerEffectUs: 0,
        });
      }
    }
  }

  private async recordClockDiscontinuity(
    context: RuntimeContext,
    beforeClock: VNextClockPositionV1,
    domains: readonly string[],
  ): Promise<void> {
    if (domains.length === 0) return;
    const reason = `restore reset runtime clock domains: ${domains.join(", ")}`;
    for (const requested of context.capturePolicy.channels) {
      context.externalLoss.push(
        VNextCaptureLossV1Schema.parse({
          schemaVersion: 1,
          sequence: context.externalLoss.length,
          channel: requested.channel,
          kind: "degraded",
          count: 0,
          firstClock: context.clock,
          lastClock: context.clock,
          reason,
        }),
      );
    }
    await this.appendRaw(context, {
      channel: "error",
      kind: "capture_loss",
      clock: context.clock,
      payload: json({
        schemaVersion: 1,
        kind: "clock_discontinuity",
        domains,
        beforeClock,
        afterClock: context.clock,
        reason,
      }) as JsonObject,
      observerEffectUs: 0,
    });
  }

  private async captureStepEvents(
    context: RuntimeContext,
    result: VNextGodotStepResultV1,
  ): Promise<void> {
    for (const event of result.events) {
      await this.captureStepEvent(context, event, result);
    }
  }

  private normalizedEntity(
    context: RuntimeContext,
    stableId: string,
    incarnation?: number,
  ): JsonObject {
    const realizedIncarnation =
      incarnation ?? context.entityIncarnations.get(stableId) ?? 1;
    context.entityIncarnations.set(stableId, realizedIncarnation);
    return json({
      stableId,
      incarnation: realizedIncarnation,
      sceneId: this.options.fixtureCapability.startupScene,
      parentStableId: null,
      ownerStableId: null,
    }) as JsonObject;
  }

  private async recordSemanticCaptureLoss(
    context: RuntimeContext,
    channel: VNextCaptureChannelV1,
    kind: "dropped" | "degraded",
    reason: string,
  ): Promise<void> {
    const loss = VNextCaptureLossV1Schema.parse({
      schemaVersion: 1,
      sequence: context.externalLoss.length,
      channel,
      kind,
      count: 1,
      firstClock: context.clock,
      lastClock: context.clock,
      reason,
    });
    context.externalLoss.push(loss);
    await this.appendRaw(context, {
      channel,
      kind: "capture_loss",
      clock: context.clock,
      payload: json({
        schemaVersion: 1,
        channel,
        kind,
        count: 1,
        reason,
      }) as JsonObject,
      observerEffectUs: 0,
    });
  }

  private async recordMalformedManagedTelemetry(
    context: RuntimeContext,
    event: Extract<V01EnvironmentEventDraft, { readonly kind: "log" }>,
    channel: VNextCaptureChannelV1,
    tag: string,
  ): Promise<void> {
    const reason = `managed ChronoProbe ${tag.slice(0, 96)} telemetry was malformed`;
    await this.appendRaw(context, {
      channel: "error",
      kind: "error",
      clock: context.clock,
      payload: json({
        schemaVersion: 1,
        code: "malformed_managed_telemetry",
        source: "ChronoProbe",
        tag: tag.slice(0, 96),
        localId: event.localId.slice(0, 256),
        reason,
      }) as JsonObject,
      observerEffectUs: 0,
    });
    await this.recordSemanticCaptureLoss(context, channel, "dropped", reason);
  }

  private async observedRelationsFor(
    context: RuntimeContext,
    event: V01EnvironmentEventDraft,
    channel: VNextCaptureChannelV1,
    relationKind: VNextObservedRelationV1["kind"],
  ): Promise<readonly VNextObservedRelationV1[]> {
    if (event.causedByLocalId === undefined) return [];
    const targetEventId = context.eventIdsByLocalId.get(event.causedByLocalId);
    if (targetEventId === undefined) {
      await this.recordSemanticCaptureLoss(
        context,
        channel,
        "degraded",
        `runtime correlation ${event.causedByLocalId.slice(0, 256)} could not be resolved to a retained raw event`,
      );
      return [];
    }
    return [
      {
        schemaVersion: 1,
        kind: relationKind,
        targetEventId,
      },
    ];
  }

  private async appendNormalizedStepEvent(
    context: RuntimeContext,
    event: V01EnvironmentEventDraft,
    input: {
      readonly channel: VNextCaptureChannelV1;
      readonly kind: VNextRawRuntimeEventV1["kind"];
      readonly payload: JsonObject;
      readonly observerEffectUs: number;
      readonly relationKind?: VNextObservedRelationV1["kind"] | undefined;
    },
  ): Promise<void> {
    const observedRelations = await this.observedRelationsFor(
      context,
      event,
      input.channel,
      input.relationKind ?? "scheduled_by",
    );
    const materialized = await this.appendRaw(context, {
      channel: input.channel,
      kind: input.kind,
      clock: context.clock,
      payload: input.payload,
      observerEffectUs: input.observerEffectUs,
      observedRelations,
    });
    if (materialized === null) return;
    const previousEventId = context.eventIdsByLocalId.get(event.localId);
    if (previousEventId === undefined) {
      context.eventIdsByLocalId.set(event.localId, materialized.eventId);
    } else {
      await this.appendRaw(context, {
        channel: "error",
        kind: "error",
        clock: context.clock,
        payload: json({
          schemaVersion: 1,
          code: "duplicate_runtime_local_id",
          localId: event.localId.slice(0, 256),
          firstEventId: previousEventId,
          duplicateEventId: materialized.eventId,
        }) as JsonObject,
        observerEffectUs: 0,
      });
      await this.recordSemanticCaptureLoss(
        context,
        input.channel,
        "degraded",
        `runtime local ID ${event.localId.slice(0, 256)} was not unique`,
      );
    }
    for (const relation of observedRelations) {
      await this.appendRaw(context, {
        channel: "probe",
        kind: "relation",
        clock: context.clock,
        payload: json({
          schemaVersion: 1,
          relation: relation.kind,
          sourceEventId: materialized.eventId,
          targetEventId: relation.targetEventId,
          sourceLocalId: event.localId.slice(0, 256),
          targetLocalId: event.causedByLocalId?.slice(0, 256) ?? null,
        }) as JsonObject,
        observerEffectUs: 0,
        observedRelations: [relation],
      });
    }
  }

  private async captureStepEvent(
    context: RuntimeContext,
    event: V01EnvironmentEventDraft,
    result: VNextGodotStepResultV1,
  ): Promise<void> {
    const observerEffectUs =
      result.receipt.runtime.observationHealth.probeOverheadUs;
    if (event.kind === "property_changed") {
      const stableId = event.path.split(".", 1)[0] ?? "";
      if (!managedTelemetryIdSchema.safeParse(stableId).success) {
        await this.recordSemanticCaptureLoss(
          context,
          "probe",
          "dropped",
          "managed property transition did not identify a stable entity",
        );
        return;
      }
      await this.appendNormalizedStepEvent(context, event, {
        channel: "probe",
        kind: "state",
        payload: json({
          schemaVersion: 1,
          eventType: "property_changed",
          localId: event.localId,
          entity: this.normalizedEntity(context, stableId),
          statePath: event.path,
          before: event.before,
          after: event.after,
          value: event.after,
        }) as JsonObject,
        observerEffectUs,
      });
      return;
    }
    if (event.kind === "signal") {
      const entity = managedTelemetryIdSchema.safeParse(event.source).success
        ? this.normalizedEntity(context, event.source)
        : null;
      await this.appendNormalizedStepEvent(context, event, {
        channel: "probe",
        kind: "signal",
        payload: json({
          schemaVersion: 1,
          eventType: "signal_emitted",
          localId: event.localId,
          source: event.source,
          name: event.name,
          arguments: event.arguments,
          entity,
        }) as JsonObject,
        observerEffectUs,
      });
      return;
    }
    if (event.kind === "signal_delivery") {
      const entity = managedTelemetryIdSchema.safeParse(event.source).success
        ? this.normalizedEntity(context, event.source)
        : null;
      await this.appendNormalizedStepEvent(context, event, {
        channel: "probe",
        kind: "signal",
        payload: json({
          schemaVersion: 1,
          eventType: "signal_delivery",
          localId: event.localId,
          source: event.source,
          name: event.name,
          receiver: event.receiver,
          delivered: event.delivered,
          failureReason: event.failureReason ?? null,
          entity,
        }) as JsonObject,
        observerEffectUs,
        relationKind: "delivery",
      });
      return;
    }

    const managedTag = event.fields["chronoriftEvent"];
    if (
      event.source === "ChronoProbe" &&
      Object.prototype.hasOwnProperty.call(event.fields, "chronoriftEvent") &&
      typeof managedTag !== "string"
    ) {
      await this.recordMalformedManagedTelemetry(
        context,
        event,
        "probe",
        "invalid_tag",
      );
      return;
    }
    if (event.source === "ChronoProbe" && typeof managedTag === "string") {
      if (managedTag === "entity_lifecycle") {
        const parsed = ManagedEntityLifecycleFieldsV1Schema.safeParse(
          event.fields,
        );
        if (!parsed.success || event.message !== "entity lifecycle") {
          await this.recordMalformedManagedTelemetry(
            context,
            event,
            "entity_lifecycle",
            managedTag,
          );
          return;
        }
        context.entityIncarnations.set(
          parsed.data.stableId,
          parsed.data.incarnation,
        );
        await this.appendNormalizedStepEvent(context, event, {
          channel: "entity_lifecycle",
          kind: "entity_lifecycle",
          payload: json({
            schemaVersion: 1,
            eventType: "entity_lifecycle",
            localId: event.localId,
            entity: this.normalizedEntity(
              context,
              parsed.data.stableId,
              parsed.data.incarnation,
            ),
            lifecycle: parsed.data.action,
          }) as JsonObject,
          observerEffectUs,
          relationKind:
            parsed.data.action === "spawned" ? "spawned_by" : "scheduled_by",
        });
        return;
      }
      if (managedTag === "pending_effect") {
        const parsed = ManagedPendingEffectFieldsV1Schema.safeParse(
          event.fields,
        );
        if (!parsed.success || event.message !== "pending effect") {
          await this.recordMalformedManagedTelemetry(
            context,
            event,
            "probe",
            managedTag,
          );
          return;
        }
        const resolvedTarget =
          parsed.data.resolvedStableId === undefined ||
          parsed.data.resolvedIncarnation === undefined
            ? null
            : this.normalizedEntity(
                context,
                parsed.data.resolvedStableId,
                parsed.data.resolvedIncarnation,
              );
        await this.appendNormalizedStepEvent(context, event, {
          channel: "probe",
          kind: "probe",
          payload: json({
            schemaVersion: 1,
            eventType: "pending_effect",
            localId: event.localId,
            action: parsed.data.action,
            effectId: parsed.data.effectId,
            entity: this.normalizedEntity(
              context,
              parsed.data.targetStableId,
              parsed.data.targetIncarnation,
            ),
            dueTick: parsed.data.dueTick,
            resolvedTarget,
            reason: parsed.data.reason ?? null,
          }) as JsonObject,
          observerEffectUs,
        });
        return;
      }
      if (managedTag === "spatial_sample") {
        const parsed = ManagedSpatialSampleFieldsV1Schema.safeParse(
          event.fields,
        );
        if (!parsed.success || event.message !== "spatial sample") {
          await this.recordMalformedManagedTelemetry(
            context,
            event,
            "probe",
            managedTag,
          );
          return;
        }
        await this.appendNormalizedStepEvent(context, event, {
          channel: "probe",
          kind: "probe",
          payload: json({
            schemaVersion: 1,
            eventType: "spatial_sample",
            localId: event.localId,
            entity: this.normalizedEntity(
              context,
              parsed.data.stableId,
              parsed.data.incarnation,
            ),
            position: [parsed.data.x, parsed.data.y],
          }) as JsonObject,
          observerEffectUs,
        });
        return;
      }
      await this.recordMalformedManagedTelemetry(
        context,
        event,
        "probe",
        managedTag,
      );
      return;
    }

    await this.appendNormalizedStepEvent(context, event, {
      channel: event.level === "error" ? "error" : "log",
      kind: event.level === "error" ? "error" : "log",
      payload: json({
        schemaVersion: 1,
        eventType: "log",
        localId: event.localId,
        level: event.level,
        source: event.source,
        message: event.message.slice(0, 4_096),
        fields: event.fields,
      }) as JsonObject,
      observerEffectUs,
    });
  }

  private setControls(
    context: RuntimeContext,
    input: Record<string, unknown>,
  ): unknown {
    const controls = input["controls"] as GameRuntimeControlsV1;
    if (
      (controls.fixedFps !== undefined &&
        controls.fixedFps !== context.fixedFps) ||
      (controls.physicsTicksPerSecond !== undefined &&
        controls.physicsTicksPerSecond !== context.physicsTicksPerSecond)
    ) {
      throw new ToolFailure(
        "unsupported_capability",
        "fixed FPS and physics TPS are launch-time controls",
        true,
        json({
          requested: controls,
          realized: {
            fixedFps: context.fixedFps,
            physicsTicksPerSecond: context.physicsTicksPerSecond,
          },
        }),
      );
    }
    if (controls.maxTicks !== undefined) context.maxTicks = controls.maxTicks;
    return {
      runtimeId: context.runtimeId,
      requested: controls,
      realized: {
        fixedFps: context.fixedFps,
        physicsTicksPerSecond: context.physicsTicksPerSecond,
        maxTicks: context.maxTicks,
      },
      mismatches: [],
      knownSideEffects: [],
    };
  }

  private async createCheckpoint(
    context: RuntimeContext,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (input["barrier"] !== "process_frame_end") {
      throw new ToolFailure(
        "unsupported_capability",
        "the managed fixture checkpoint adapter only realizes process_frame_end",
        true,
        json({
          requestedBarrier: input["barrier"],
          supportedBarrier: "process_frame_end",
        }),
      );
    }
    const adapterIds = input["adapterIds"] as readonly string[] | undefined;
    if (
      adapterIds !== undefined &&
      adapterIds.some((adapterId) => adapterId !== context.adapterId)
    ) {
      throw new ToolFailure(
        "unsupported_capability",
        "checkpoint requested an adapter that is not attached to the runtime",
        true,
      );
    }
    const captured = await context.client.snapshot();
    if (
      captured.certificate.adapterSemanticBarrier !==
      "chronorift.frame_end_deferred"
    ) {
      throw new ToolFailure(
        "unsupported_capability",
        "the runtime did not attest the requested process-frame snapshot barrier",
        true,
        json({
          requestedBarrier: input["barrier"],
          realizedBarrier: captured.certificate.adapterSemanticBarrier,
        }),
      );
    }
    const checkpointId = asCheckpointId(this.#nextId("checkpoint"));
    const inputSchedule = storedInputSchedule(context);
    const covered: Array<{
      readonly schemaVersion: 1;
      readonly domain: string;
      readonly classification: "captured";
      readonly serializationRule: string;
      readonly canonicalizationRule: string;
      readonly stateHash: Sha256DigestV1;
      readonly tolerance: null;
      readonly restoreOrder: number;
    }> = [];
    const uncoveredDeclared: Array<{
      readonly schemaVersion: 1;
      readonly domain: string;
      readonly classification: "unsupported";
      readonly reason: string;
    }> = [];
    for (const domain of captured.certificate.coveredStateDomains) {
      const extracted = checkpointDomainValue(
        captured.snapshot,
        domain,
        inputSchedule,
      );
      if (!extracted.found) {
        uncoveredDeclared.push({
          schemaVersion: 1,
          domain,
          classification: "unsupported",
          reason:
            "the certificate declares this domain but the strict snapshot has no extractable domain value",
        });
        continue;
      }
      covered.push({
        schemaVersion: 1 as const,
        domain,
        classification: "captured" as const,
        serializationRule: "managed Godot fixture snapshot v1",
        canonicalizationRule: "canonical JSON value ordering",
        stateHash: asSha256DigestV1(contentHash(extracted.value)),
        tolerance: null,
        restoreOrder: covered.length,
      });
    }
    const declaredDomains = new Set(captured.certificate.coveredStateDomains);
    const unsupported = captured.certificate.missingStateDomains
      .filter((domain) => !declaredDomains.has(domain))
      .map((domain) => ({
        schemaVersion: 1 as const,
        domain,
        classification: "unsupported" as const,
        reason: "the managed fixture snapshot does not capture this domain",
      }));
    const fidelityLimited =
      unsupported.length > 0 ||
      uncoveredDeclared.length > 0 ||
      captured.certificate.pendingAsyncOperations.length > 0 ||
      captured.certificate.externalDependencies.length > 0 ||
      captured.certificate.rngDomains.length > 0;
    const manifest = VNextCheckpointManifestV1Schema.parse({
      schemaVersion: 1,
      taskId: this.options.taskId,
      checkpointId,
      executionId: context.executionId,
      runtimeId: context.runtimeId,
      workspaceId: this.options.workspaceId,
      sourceId: context.prepared.build.sourceId,
      buildId: context.prepared.build.buildId,
      adapterId: context.adapterId,
      stateSchemaVersion: context.manifest.stateSchemaVersion,
      probeIds: context.probeIds,
      captureWindowId: context.captureWindowIds.at(-1) ?? null,
      capturedAt: context.clock,
      consistencyModel: captured.certificate.captureConsistencyModel,
      semanticBarrier: captured.certificate.adapterSemanticBarrier,
      domains: [...covered, ...uncoveredDeclared, ...unsupported],
      restoreDependencyOrder: covered.map((domain) => domain.domain),
      inFlightState: [...captured.certificate.pendingAsyncOperations],
      limitations: [
        ...captured.certificate.limitations,
        ...captured.certificate.pendingAsyncOperations.map(
          (operation) => `pending operation is not controlled: ${operation}`,
        ),
        ...captured.certificate.externalDependencies.map(
          (dependency) => `external dependency is not restored: ${dependency}`,
        ),
        ...captured.certificate.rngDomains.map(
          (domain) => `RNG domain is not restored: ${domain}`,
        ),
      ],
      portability: "same_build_only",
      fidelity: fidelityLimited ? "descriptive_only" : "equivalent_candidate",
    });
    const stored: StoredCheckpointV1 = {
      schemaVersion: 1,
      taskId: this.options.taskId,
      manifest,
      snapshot: captured.snapshot,
      certificate: captured.certificate,
      nextTick: context.stepsUsed,
      simTimeUs: context.clock.simulationTimeUs,
      inputSchedule,
    };
    this.validateStoredCheckpoint(
      stored,
      checkpointId,
      context.client.fingerprint,
    );
    await this.options.runtimeStore.putResourceOnce(
      "checkpoint",
      checkpointId,
      stored,
      (value) => StoredCheckpointV1Schema.parse(value),
    );
    context.finalCheckpointId = checkpointId;
    context.manifest = VNextExecutionManifestV1Schema.parse({
      ...context.manifest,
      launchParameters: {
        ...context.manifest.launchParameters,
        finalCheckpointId: checkpointId,
      },
    });
    await this.appendRaw(context, {
      channel: "checkpoint",
      kind: "checkpoint",
      clock: context.clock,
      payload: json({
        schemaVersion: 1,
        checkpointId,
        requestedBarrier: input["barrier"],
        realizedBarrier: captured.certificate.adapterSemanticBarrier,
        consistencyModel: captured.certificate.captureConsistencyModel,
        fidelity: manifest.fidelity,
      }) as JsonObject,
      observerEffectUs: 0,
    });
    const runtimeState = captured.snapshot.runtimeState;
    const participants =
      runtimeState !== null &&
      typeof runtimeState === "object" &&
      !Array.isArray(runtimeState)
        ? runtimeState["participants"]
        : undefined;
    return {
      manifest,
      state: captured.snapshot.state,
      participantStates:
        participants !== null &&
        typeof participants === "object" &&
        !Array.isArray(participants)
          ? participants
          : {},
      certificate: {
        level: captured.certificate.level,
        coveredStateDomains: captured.certificate.coveredStateDomains,
        missingStateDomains: captured.certificate.missingStateDomains,
      },
    };
  }

  private validateStoredCheckpoint(
    stored: StoredCheckpointV1,
    checkpointId: CheckpointId,
    expectedFingerprint?: RuntimeFingerprintV1,
  ): void {
    const fail = (message: string): never => {
      throw new Error(`stored checkpoint lineage mismatch: ${message}`);
    };
    if (
      stored.taskId !== this.options.taskId ||
      stored.manifest.taskId !== this.options.taskId
    ) {
      fail("task ownership");
    }
    if (stored.manifest.checkpointId !== checkpointId) {
      fail("resource identity");
    }
    if (
      stored.certificate.restoreRecipeHash !==
      contentHash(json(stored.snapshot))
    ) {
      fail("certificate restore recipe hash does not match snapshot");
    }
    const fingerprint = stored.certificate.environmentFingerprint;
    if (stored.manifest.adapterId !== `adapter:${fingerprint.addonHash}`) {
      fail("certificate adapter fingerprint does not match manifest adapter");
    }
    if (
      expectedFingerprint !== undefined &&
      contentHash(json(fingerprint)) !== contentHash(json(expectedFingerprint))
    ) {
      fail("certificate environment fingerprint does not match runtime");
    }

    const runtimeState = jsonObjectValue(stored.snapshot.runtimeState);
    if (
      runtimeState?.["nextTick"] !== stored.nextTick ||
      runtimeState["nowUs"] !== stored.simTimeUs ||
      stored.manifest.capturedAt.processFrame !== stored.nextTick ||
      stored.manifest.capturedAt.simulationTimeUs !== stored.simTimeUs
    ) {
      fail("snapshot clock state does not match stored checkpoint clocks");
    }

    const certificateDomains = new Set([
      ...stored.certificate.coveredStateDomains,
      ...stored.certificate.missingStateDomains,
    ]);
    if (
      certificateDomains.size !==
      stored.certificate.coveredStateDomains.length +
        stored.certificate.missingStateDomains.length
    ) {
      fail("certificate state domains are duplicated or contradictory");
    }
    const manifestDomains = new Map(
      stored.manifest.domains.map((domain) => [domain.domain, domain]),
    );
    for (const domain of certificateDomains) {
      if (!manifestDomains.has(domain)) {
        fail(`certificate domain is absent from manifest: ${domain}`);
      }
    }
    for (const domain of stored.manifest.domains) {
      if (!certificateDomains.has(domain.domain)) {
        fail(`manifest domain is absent from certificate: ${domain.domain}`);
      }
      if (domain.classification !== "captured") continue;
      if (!stored.certificate.coveredStateDomains.includes(domain.domain)) {
        fail(`captured domain is not certificate-covered: ${domain.domain}`);
      }
      const extracted = checkpointDomainValue(
        stored.snapshot,
        domain.domain,
        stored.inputSchedule,
      );
      if (extracted.found) {
        if (contentHash(extracted.value) !== domain.stateHash) {
          fail(
            `captured domain hash does not match stored value: ${domain.domain}`,
          );
        }
      } else {
        fail(`captured domain has no stored value: ${domain.domain}`);
      }
    }

    const participantIds = new Set<string>();
    for (const validation of stored.certificate.restoreValidation) {
      if (participantIds.has(validation.participantId)) {
        fail(`duplicate participant validation: ${validation.participantId}`);
      }
      participantIds.add(validation.participantId);
      if (validation.status !== "pass") {
        fail(
          `checkpoint participant validation did not pass: ${validation.participantId}`,
        );
      }
      const domainName = `participant.${validation.participantId}`;
      const domain = manifestDomains.get(domainName);
      const extracted = checkpointDomainValue(
        stored.snapshot,
        domainName,
        stored.inputSchedule,
      );
      if (
        domain?.classification !== "captured" ||
        !extracted.found ||
        contentHash(extracted.value) !== validation.stateHash ||
        domain.stateHash !== validation.stateHash
      ) {
        fail(
          `participant validation is not bound to captured state: ${domainName}`,
        );
      }
    }
  }

  private async readCheckpoint(
    checkpointId: string,
  ): Promise<StoredCheckpointV1> {
    let stored: StoredCheckpointV1;
    try {
      stored = await this.options.runtimeStore.readResource(
        "checkpoint",
        checkpointId,
        (value) => StoredCheckpointV1Schema.parse(value),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
      throw new ToolFailure(
        "resource_not_found",
        "checkpoint resource was not found",
        true,
        json({ checkpointId }),
      );
    }
    if (
      stored.taskId !== this.options.taskId ||
      stored.manifest.taskId !== this.options.taskId
    ) {
      throw new ToolFailure(
        "resource_task_mismatch",
        "checkpoint does not belong to this task",
        true,
      );
    }
    this.validateStoredCheckpoint(stored, asCheckpointId(checkpointId));
    return stored;
  }

  private async restoreCheckpoint(
    context: RuntimeContext,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const checkpointId = String(input["checkpointId"]);
    const stored = await this.readCheckpoint(checkpointId);
    this.validateStoredCheckpoint(
      stored,
      asCheckpointId(checkpointId),
      context.client.fingerprint,
    );
    const restoreReceiptId = asRestoreReceiptId(
      this.#nextId("restore-receipt"),
    );
    const request = {
      taskId: this.options.taskId,
      restoreReceiptId,
      targetRuntimeId: context.runtimeId,
      targetExecutionId: context.executionId,
      currentBuildId: context.prepared.build.buildId,
      currentAdapterId: context.adapterId,
      currentStateSchemaVersion: context.manifest.stateSchemaVersion,
    };
    const checkpointProbeIds = [...stored.manifest.probeIds].sort();
    const currentProbeIds = [...context.probeIds].sort();
    if (
      checkpointProbeIds.length !== currentProbeIds.length ||
      checkpointProbeIds.some(
        (probeId, index) => probeId !== currentProbeIds[index],
      )
    ) {
      throw new ToolFailure(
        "checkpoint_incompatible",
        "checkpoint probes do not exactly match the target runtime",
        true,
        json({ checkpointProbeIds, currentProbeIds }),
      );
    }
    if (
      stored.manifest.buildId !== context.prepared.build.buildId ||
      stored.manifest.adapterId !== context.adapterId ||
      stored.manifest.stateSchemaVersion !== context.manifest.stateSchemaVersion
    ) {
      const receipt = new VNextCheckpointRestoreService({
        restoreCapturedDomain: () => {
          throw new Error("incompatible checkpoint cannot be written");
        },
        resetDomain: () => {
          throw new Error("incompatible checkpoint cannot be reset");
        },
        validateRestore: () => [],
      }).restore(stored.manifest, request);
      throw new ToolFailure(
        "checkpoint_incompatible",
        "checkpoint is incompatible with the target runtime",
        true,
        json({ receipt }),
      );
    }
    const beforeClock = context.clock;
    const beforeState = context.state;
    const beforeStepsUsed = context.stepsUsed;
    const beforeInputSchedule = storedInputSchedule(context);
    const realized = await context.client.restore({
      snapshot: stored.snapshot,
      certificate: stored.certificate,
      nextTick: stored.nextTick,
      simTimeUs: stored.simTimeUs,
    });
    context.state = StateSnapshotSchema.parse(realized.state);
    context.stepsUsed = realized.nextTick;
    context.pendingInputs.splice(
      0,
      context.pendingInputs.length,
      ...stored.inputSchedule.pendingInputs.map((pending) => ({
        requestId: pending.requestId,
        action: pending.action,
        ...(pending.targetEntityId === null
          ? {}
          : { targetEntityId: pending.targetEntityId }),
        requested: pending.requested,
        order: pending.order,
      })),
    );
    context.nextInputOrder = stored.inputSchedule.nextInputOrder;
    const afterInputSchedule = storedInputSchedule(context);
    const runtimeValidation = RuntimeRestoreValidationV1Schema.safeParse(
      realized.runtimeValidation,
    );
    const postRestoreHash = asSha256DigestV1(contentHash(json(context.state)));
    const expectedSemanticHash = asSha256DigestV1(
      contentHash(json(stored.snapshot.state)),
    );
    context.clock = clockAt(
      realized.nextTick,
      stored.manifest.capturedAt.physicsTick,
      realized.simTimeUs,
      Math.max(
        beforeClock.hostMonotonicUs,
        Number(process.hrtime.bigint() / 1_000n),
      ),
    );
    const discontinuousClockDomains = [
      ...(context.clock.processFrame < beforeClock.processFrame
        ? ["process_frame"]
        : []),
      ...(context.clock.physicsTick < beforeClock.physicsTick
        ? ["physics_tick"]
        : []),
      ...(context.clock.simulationTimeUs < beforeClock.simulationTimeUs
        ? ["simulation_time"]
        : []),
    ];
    const actualByParticipant = new Map(
      runtimeValidation.success
        ? runtimeValidation.data.validations.map((validation) => [
            validation.participantId,
            validation,
          ])
        : [],
    );
    const beforeDomainHash = (domain: string): Sha256DigestV1 | null => {
      if (domain === "registered.state_providers") {
        return asSha256DigestV1(contentHash(json(beforeState)));
      }
      if (domain === "logical_clock") {
        return asSha256DigestV1(
          contentHash(
            json({
              nowUs: beforeClock.simulationTimeUs,
              nextTick: beforeStepsUsed,
            }),
          ),
        );
      }
      if (domain === "input_schedule") {
        return asSha256DigestV1(contentHash(json(beforeInputSchedule)));
      }
      return null;
    };
    const afterDomainHash = (domain: string): Sha256DigestV1 | null => {
      if (domain === "registered.state_providers") return postRestoreHash;
      if (domain === "logical_clock") {
        return asSha256DigestV1(
          contentHash(
            json({ nowUs: realized.simTimeUs, nextTick: realized.nextTick }),
          ),
        );
      }
      if (domain === "input_schedule") {
        return asSha256DigestV1(contentHash(json(afterInputSchedule)));
      }
      if (domain.startsWith("participant.")) {
        const participant = actualByParticipant.get(
          domain.slice("participant.".length),
        );
        if (participant !== undefined) {
          return asSha256DigestV1(participant.stateHash);
        }
      }
      return null;
    };
    const receipt = new VNextCheckpointRestoreService({
      restoreCapturedDomain: (domain) => {
        const beforeHash = beforeDomainHash(domain.domain);
        const afterHash = afterDomainHash(domain.domain);
        if (afterHash === null) {
          return {
            status: "rejected",
            beforeHash,
            afterHash: null,
            message:
              "runtime returned no post-restore observation for this captured domain",
          };
        }
        if (afterHash !== domain.stateHash) {
          return {
            status: "rejected",
            beforeHash,
            afterHash: null,
            message:
              "post-restore observation does not match the captured domain hash",
          };
        }
        return {
          status: "restored",
          beforeHash,
          afterHash,
          message:
            domain.domain === "input_schedule"
              ? "Host-managed pending input schedule and order cursor were restored"
              : null,
        };
      },
      resetDomain: () => ({
        status: "reset",
        beforeHash: null,
        afterHash: postRestoreHash,
        message: null,
      }),
      validateRestore: () => {
        const semanticValidation = runtimeValidation.success
          ? {
              schemaVersion: 1 as const,
              name: "runtime.semantic_state",
              status:
                runtimeValidation.data.level === stored.certificate.level &&
                runtimeValidation.data.semanticStateHash === postRestoreHash &&
                postRestoreHash === expectedSemanticHash
                  ? ("pass" as const)
                  : ("fail" as const),
              expectedHash: expectedSemanticHash,
              actualHash: asSha256DigestV1(
                runtimeValidation.data.semanticStateHash,
              ),
              message: null,
            }
          : {
              schemaVersion: 1 as const,
              name: "runtime.semantic_state",
              status: "unavailable" as const,
              expectedHash: expectedSemanticHash,
              actualHash: null,
              message:
                "runtime did not return a strict restore validation receipt",
            };
        return [
          semanticValidation,
          ...stored.certificate.restoreValidation.map((expected) => {
            const actual = actualByParticipant.get(expected.participantId);
            if (actual === undefined) {
              return {
                schemaVersion: 1 as const,
                name: `participant.${expected.participantId}`,
                status: "unavailable" as const,
                expectedHash: asSha256DigestV1(expected.stateHash),
                actualHash: null,
                message: runtimeValidation.success
                  ? "runtime did not return this participant validation"
                  : "runtime did not return a strict restore validation receipt",
              };
            }
            const matches =
              actual.status === "pass" &&
              actual.stateHash === expected.stateHash;
            return {
              schemaVersion: 1 as const,
              name: `participant.${expected.participantId}`,
              status: matches ? ("pass" as const) : ("fail" as const),
              expectedHash: asSha256DigestV1(expected.stateHash),
              actualHash: asSha256DigestV1(actual.stateHash),
              message: actual.message ?? null,
            };
          }),
        ];
      },
    }).restore(stored.manifest, request);
    const validatedReceipt = VNextRestoreReceiptV1Schema.parse(receipt);
    await this.recordClockDiscontinuity(
      context,
      beforeClock,
      discontinuousClockDomains,
    );
    await this.appendRaw(context, {
      channel: "restore",
      kind: "restore",
      clock: context.clock,
      payload: json({
        schemaVersion: 1,
        checkpointId,
        restoreReceiptId,
        status: validatedReceipt.status,
        beforeClock,
        afterClock: context.clock,
        clockSources: {
          processFrame: "adapter restore nextTick receipt",
          physicsTick: "checkpoint declared capturedAt position",
          simulationTimeUs: "adapter restore simTimeUs receipt",
          hostMonotonicUs: "Host observation after restore",
          renderFrame: "unavailable",
        },
        discontinuousClockDomains,
        clockLimitations:
          discontinuousClockDomains.length === 0
            ? []
            : [
                "restore established a new runtime clock position; cross-boundary coverage is a bounding envelope",
              ],
      }) as JsonObject,
      observerEffectUs: 0,
    });
    if (validatedReceipt.status === "partially_restored") {
      throw new ToolFailure(
        "restore_gap",
        "checkpoint restore completed with explicit uncovered state",
        true,
        json({
          receipt: validatedReceipt,
          state: context.state,
          clocks: context.clock,
        }),
      );
    }
    return {
      receipt: validatedReceipt,
      state: context.state,
      clocks: context.clock,
    };
  }

  private async createTrace(input: Record<string, unknown>): Promise<unknown> {
    const prepared = await this.prepareBuild();
    const activeContexts = [...this.#contexts.values()].filter(
      (context) => context.status === "running",
    );
    const requestedSource = input["source"] as
      | { readonly kind: "runtime"; readonly runtimeId: string }
      | { readonly kind: "execution"; readonly executionId: string }
      | undefined;
    if (requestedSource === undefined && activeContexts.length > 1) {
      throw new ToolFailure(
        "conflict",
        "trace source is ambiguous while multiple runtimes are active",
        true,
        json({
          runtimeIds: activeContexts.map((context) => context.runtimeId),
        }),
      );
    }
    let sourceContext: RuntimeContext | undefined;
    let historicalSource: ExecutionSource | undefined;
    if (requestedSource?.kind === "runtime") {
      sourceContext = this.#contexts.get(
        asRuntimeId(requestedSource.runtimeId),
      );
      if (sourceContext === undefined) {
        throw new ToolFailure(
          "resource_not_found",
          "trace source runtime was not found",
          true,
        );
      }
    } else if (requestedSource?.kind === "execution") {
      historicalSource = await this.loadExecution(requestedSource.executionId);
    } else {
      sourceContext = activeContexts[0];
    }
    const traceId = asTraceId(this.#nextId("trace"));
    const requested = input["events"] as readonly {
      readonly action: "attempt_jump";
      readonly targetEntityId?: string;
      readonly requested: GameRequestedPointV1;
    }[];
    const events = requested.flatMap((event, index) => {
      const pairId = `input-pair:${index}`;
      const target = {
        schemaVersion: 1 as const,
        clockDomain: event.requested.clock,
        position: event.requested.requestedTick,
        phase: event.requested.requestedPhase,
      };
      return [
        {
          schemaVersion: 1 as const,
          sequence: index * 2,
          kind: "input_press" as const,
          name: event.action,
          value: event.targetEntityId ?? null,
          inputPairId: pairId,
          requested: target,
          realized: null,
        },
        {
          schemaVersion: 1 as const,
          sequence: index * 2 + 1,
          kind: "input_release" as const,
          name: event.action,
          value: event.targetEntityId ?? null,
          inputPairId: pairId,
          requested: target,
          realized: null,
        },
      ];
    });
    const trace = VNextRuntimeTraceV1Schema.parse({
      schemaVersion: 1,
      taskId: this.options.taskId,
      traceId,
      sourceExecutionId:
        sourceContext?.executionId ??
        historicalSource?.record.executionId ??
        null,
      sourceRuntimeId:
        sourceContext?.runtimeId ?? historicalSource?.record.runtimeId ?? null,
      sourceId:
        sourceContext?.prepared.build.sourceId ??
        historicalSource?.record.manifest.sourceId ??
        prepared.build.sourceId,
      sourceBuildId:
        sourceContext?.prepared.build.buildId ??
        historicalSource?.record.buildId ??
        prepared.build.buildId,
      sourceAdapterId:
        sourceContext?.adapterId ??
        historicalSource?.record.manifest.adapterId ??
        null,
      sourceProbeIds:
        sourceContext?.probeIds ??
        historicalSource?.record.manifest.probeIds ??
        [],
      sourceCaptureWindowId:
        sourceContext?.captureWindowIds.at(-1) ??
        historicalSource?.captureWindowIds.at(-1) ??
        null,
      createdAt: this.#now(),
      events,
    });
    await this.options.runtimeStore.putResourceOnce(
      "trace",
      traceId,
      trace,
      (value) => VNextRuntimeTraceV1Schema.parse(value),
    );
    return { trace };
  }

  private async readTrace(traceId: string): Promise<VNextRuntimeTraceV1> {
    try {
      const trace = await this.options.runtimeStore.readResource(
        "trace",
        traceId,
        (value) => VNextRuntimeTraceV1Schema.parse(value),
      );
      if (trace.taskId !== this.options.taskId) {
        throw new ToolFailure(
          "resource_task_mismatch",
          "trace does not belong to this task",
          true,
        );
      }
      if (trace.traceId !== asTraceId(traceId)) {
        throw new Error(
          "trace payload identity does not match its resource ID",
        );
      }
      return trace;
    } catch (error) {
      if (error instanceof ToolFailure) throw error;
      if (!isNotFound(error)) throw error;
      throw new ToolFailure(
        "trace_unavailable",
        "trace resource was not found",
        true,
        json({ traceId }),
      );
    }
  }

  private async replayTrace(
    context: RuntimeContext,
    traceId: string,
    maxTicks: number,
  ): Promise<unknown> {
    const trace = await this.readTrace(traceId);
    const applications: Array<{
      readonly realized: {
        readonly schemaVersion: 1;
        readonly clock: VNextClockPositionV1;
        readonly phase: VNextRuntimePhaseV1;
        readonly quantized: boolean;
        readonly mismatchReason: string | null;
      };
      readonly observed: {
        readonly subject: string;
        readonly value: JsonValue;
      };
      readonly knownSideEffects: readonly string[];
    }> = [];
    const pairApplications = new Map<string, (typeof applications)[number]>();
    let replaySteps = 0;
    let replayFailure: unknown;
    for (const event of trace.events) {
      try {
        if (event.kind === "input_press") {
          while (
            (event.requested.clockDomain === "process_frame"
              ? context.clock.processFrame
              : context.clock.physicsTick) < event.requested.position
          ) {
            if (replaySteps >= maxTicks) {
              throw new ToolFailure(
                "budget_exhausted",
                "trace replay exceeded maxTicks before its requested position",
                true,
              );
            }
            await this.step(context, {
              clock:
                event.requested.clockDomain === "physics_tick"
                  ? "physics_tick"
                  : "process_frame",
              count: 1,
            });
            replaySteps += 1;
          }
          if (replaySteps >= maxTicks) {
            throw new ToolFailure(
              "budget_exhausted",
              "trace replay exceeded maxTicks",
              true,
            );
          }
          const requestId = `trace-input:${trace.traceId}:${event.sequence}`;
          const replayRequested: GameRequestedPointV1 =
            event.requested.clockDomain === "physics_tick"
              ? {
                  clock: "physics_tick",
                  requestedTick: event.requested.position,
                  requestedPhase:
                    event.requested.phase === "physics_tick_end"
                      ? "physics_tick_end"
                      : "physics_tick_start",
                }
              : {
                  clock: "process_frame",
                  requestedTick: event.requested.position,
                  requestedPhase:
                    event.requested.phase === "process_frame_end"
                      ? "process_frame_end"
                      : "process_frame_start",
                };
          context.pendingInputs.push({
            requestId,
            action: "attempt_jump",
            ...(typeof event.value === "string"
              ? { targetEntityId: event.value }
              : {}),
            requested: replayRequested,
            order: context.nextInputOrder++,
          });
          await this.step(context, {
            clock:
              event.requested.clockDomain === "physics_tick"
                ? "physics_tick"
                : "process_frame",
            count: 1,
          });
          replaySteps += 1;
          const receipt = context.inputReceipts.find(
            (candidate) => candidate.requestId === requestId,
          );
          if (receipt === undefined) {
            throw new Error(
              "trace input did not produce a realization receipt",
            );
          }
          const application = {
            realized: {
              schemaVersion: 1 as const,
              clock: {
                schemaVersion: 1 as const,
                processFrame: receipt.realized.processFrame,
                physicsTick: receipt.realized.physicsTick,
                simulationTimeUs: receipt.realized.simulationTimeUs,
                hostMonotonicUs: receipt.realized.hostMonotonicUs,
                renderFrame: receipt.realized.renderFrame,
              },
              phase: receipt.realized.phase,
              quantized: receipt.realized.quantized,
              mismatchReason: receipt.realized.mismatchReason,
            },
            observed: {
              subject: "player.jumping",
              value: context.state.values["player.jumping"] ?? null,
            },
            knownSideEffects: receipt.knownSideEffects,
          };
          applications.push(application);
          if (event.inputPairId !== null) {
            pairApplications.set(event.inputPairId, application);
          }
        } else {
          const paired =
            event.inputPairId === null
              ? undefined
              : pairApplications.get(event.inputPairId);
          if (paired === undefined) {
            throw new Error(
              "trace release has no realized managed input pulse",
            );
          }
          applications.push({
            ...paired,
            knownSideEffects: [
              ...paired.knownSideEffects,
              "release was realized by the same managed input pulse",
            ],
          });
        }
      } catch (error) {
        replayFailure = error;
        break;
      }
    }
    let sequence = 0;
    const service = new VNextTraceReplayService({
      apply: () => {
        const application = applications[sequence++];
        if (application === undefined) {
          throw replayFailure instanceof Error
            ? replayFailure
            : new Error("runtime replay stopped before this application");
        }
        return application;
      },
    });
    let sourceEvents: readonly VNextRawRuntimeEventV1[] = [];
    if (trace.sourceExecutionId !== null) {
      sourceEvents = (await this.loadExecution(trace.sourceExecutionId)).events;
    }
    const expected = trace.events.flatMap((event) => {
      if (event.kind !== "input_press") return [];
      const candidates = sourceEvents.filter(
        (sourceEvent) =>
          sourceEvent.kind === "state" &&
          sourceEvent.payload["statePath"] === "player.jumping" &&
          (event.requested.clockDomain === "physics_tick"
            ? sourceEvent.clock.physicsTick >= event.requested.position
            : sourceEvent.clock.processFrame >= event.requested.position),
      );
      const observed = candidates[0];
      return observed === undefined
        ? []
        : [
            {
              traceSequence: event.sequence,
              subject: "player.jumping",
              value: observed.payload["value"] ?? null,
            },
          ];
    });
    const result = service.replay(trace, {
      taskId: this.options.taskId,
      targetExecutionId: context.executionId,
      targetBuildId: context.prepared.build.buildId,
      fidelityBoundary:
        "managed Godot input pulse and captured state projection",
      expected,
    });
    await this.appendRaw(context, {
      channel: result.receipt.status === "failed" ? "error" : "log",
      kind: result.receipt.status === "failed" ? "error" : "control",
      clock: context.clock,
      payload: json({
        schemaVersion: 1,
        traceId: trace.traceId,
        traceReplayReceipt: result.receipt,
      }) as JsonObject,
      observerEffectUs: 0,
    });
    if (result.receipt.status === "failed") {
      throw new ToolFailure(
        replayFailure instanceof ToolFailure
          ? replayFailure.code
          : "runtime_unavailable",
        replayFailure instanceof Error
          ? replayFailure.message
          : "runtime trace replay failed",
        replayFailure instanceof ToolFailure ? replayFailure.recoverable : true,
        json({ trace: result.trace, receipt: result.receipt }),
      );
    }
    return result;
  }

  private async fork(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const forkInput = input as unknown as GameForkInputV1;
    if (
      forkInput.changes.capture !== undefined &&
      forkInput.changes.capture.triggers.length > 0
    ) {
      throw new ToolFailure(
        "unsupported_capability",
        "fork capture triggers are not implemented by this managed runtime",
        true,
        json({
          requestedTriggers: forkInput.changes.capture.triggers,
          realizedTriggers: [],
        }),
      );
    }
    const prepared = await this.prepareBuild();
    let parent: VNextBranchLineageV1["parent"];
    let checkpoint: StoredCheckpointV1 | null = null;
    let freshStart:
      | {
          readonly sourceExecutionId: ExecutionId;
          readonly skippedCheckpointId: CheckpointId | null;
          readonly reason: string;
        }
      | undefined;
    switch (forkInput.source.kind) {
      case "workspace":
        if (forkInput.source.workspaceId !== this.options.workspaceId) {
          throw new ToolFailure(
            "resource_not_found",
            "fork workspace was not found in this task",
            true,
          );
        }
        parent = {
          schemaVersion: 1,
          kind: "workspace",
          workspaceId: this.options.workspaceId,
        };
        break;
      case "build":
        if (forkInput.source.buildId !== prepared.build.buildId) {
          throw new ToolFailure(
            "resource_not_found",
            "fork build was not found in this task",
            true,
          );
        }
        parent = {
          schemaVersion: 1,
          kind: "build",
          buildId: prepared.build.buildId,
        };
        break;
      case "execution": {
        const source = await this.loadExecution(forkInput.source.executionId);
        parent = {
          schemaVersion: 1,
          kind: "execution",
          executionId: source.record.executionId,
          buildId: source.record.buildId,
        };
        const finalCheckpointId =
          source.record.manifest.launchParameters["finalCheckpointId"] ??
          source.record.manifest.startCheckpointId;
        const crossBuild =
          forkInput.changes.buildId !== undefined &&
          forkInput.changes.buildId !== source.record.buildId;
        if (crossBuild) {
          if (forkInput.changes.traceId === undefined) {
            throw new ToolFailure(
              "invalid_request",
              "cross-build execution fork requires an explicit trace for fresh-runtime replay",
              true,
            );
          }
          freshStart = {
            sourceExecutionId: source.record.executionId,
            skippedCheckpointId:
              typeof finalCheckpointId === "string"
                ? asCheckpointId(finalCheckpointId)
                : null,
            reason:
              "source checkpoint was not restored across builds; the child started fresh and replayed the requested trace descriptively",
          };
        } else {
          if (typeof finalCheckpointId !== "string") {
            throw new ToolFailure(
              "pre_failure_checkpoint_unavailable",
              "same-build execution fork requires a task-owned checkpoint of the source state",
              true,
            );
          }
          checkpoint = await this.readCheckpoint(finalCheckpointId);
          if (checkpoint.manifest.executionId !== source.record.executionId) {
            throw new Error(
              "execution fork checkpoint does not belong to the source execution",
            );
          }
        }
        break;
      }
      case "checkpoint": {
        checkpoint = await this.readCheckpoint(forkInput.source.checkpointId);
        parent = {
          schemaVersion: 1,
          kind: "checkpoint",
          checkpointId: checkpoint.manifest.checkpointId,
          buildId: checkpoint.manifest.buildId,
        };
        if (
          forkInput.changes.buildId !== undefined &&
          forkInput.changes.buildId !== checkpoint.manifest.buildId
        ) {
          if (forkInput.changes.traceId === undefined) {
            throw new ToolFailure(
              "invalid_request",
              "cross-build checkpoint fork requires an explicit trace for fresh-runtime replay",
              true,
            );
          }
          freshStart = {
            sourceExecutionId: checkpoint.manifest.executionId,
            skippedCheckpointId: checkpoint.manifest.checkpointId,
            reason:
              "the checkpoint was not restored across builds; the child started fresh and replayed the requested trace descriptively",
          };
          checkpoint = null;
        }
        break;
      }
    }
    const requestedBuildId =
      forkInput.changes.buildId ??
      checkpoint?.manifest.buildId ??
      prepared.build.buildId;
    if (requestedBuildId !== prepared.build.buildId) {
      throw new ToolFailure(
        "checkpoint_incompatible",
        "fork target build is not the current candidate build",
        true,
      );
    }
    const branchId = asBranchId(this.#nextId("branch"));
    const traceId =
      forkInput.changes.traceId === undefined
        ? null
        : asTraceId(forkInput.changes.traceId);
    if (traceId !== null) await this.readTrace(traceId);
    const launched = await this.launch(
      {
        buildId: prepared.build.buildId,
        ...(forkInput.changes.controls === undefined
          ? {}
          : { controls: forkInput.changes.controls }),
      },
      signal,
      {
        branchId: null,
        checkpointId: checkpoint?.manifest.checkpointId ?? null,
        traceId,
        capture: forkInput.changes.capture,
        freshStart,
      },
    );
    const context = this.#contexts.get(asRuntimeId(launched.runtimeId));
    if (context === undefined)
      throw new Error("fork runtime was not registered");
    let restoreReceipt: unknown = null;
    let replayReceipt: unknown = null;
    try {
      if (checkpoint !== null) {
        try {
          restoreReceipt = await this.restoreCheckpoint(context, {
            checkpointId: checkpoint.manifest.checkpointId,
          });
        } catch (error) {
          if (!(error instanceof ToolFailure) || error.code !== "restore_gap") {
            throw error;
          }
          const details =
            error.details === undefined ? null : jsonObjectValue(error.details);
          if (details === null) throw error;
          restoreReceipt = {
            receipt: VNextRestoreReceiptV1Schema.parse(details["receipt"]),
            state: StateSnapshotSchema.parse(details["state"]),
            clocks: VNextClockPositionV1Schema.parse(details["clocks"]),
          };
        }
      }
      if (traceId !== null) {
        replayReceipt = await this.replayTrace(
          context,
          traceId,
          forkInput.changes.controls?.maxTicks ?? 600,
        );
      }
    } catch (operationError) {
      const operationDetails =
        operationError instanceof ToolFailure &&
        operationError.details !== undefined
          ? jsonObjectValue(operationError.details)
          : null;
      const failedReplayReceipt =
        operationDetails === null
          ? null
          : jsonObjectValue(operationDetails["receipt"] ?? null);
      const replayApplications =
        failedReplayReceipt !== null &&
        Array.isArray(failedReplayReceipt["applications"])
          ? failedReplayReceipt["applications"].length
          : 0;
      const failureEntries: Array<{
        readonly dimension: VNextBranchLineageV1["requestedChanges"][number]["dimension"];
        readonly requested: JsonValue;
        readonly realized: JsonValue;
        readonly status: "applied" | "partially_applied" | "rejected";
        readonly sideEffects: readonly string[];
      }> = [
        ...(forkInput.changes.buildId === undefined
          ? []
          : [
              {
                dimension: "code" as const,
                requested: json(forkInput.changes.buildId),
                realized: json(prepared.build.buildId),
                status: "applied" as const,
                sideEffects: ["the child runtime used this build"],
              },
            ]),
        ...(traceId === null
          ? []
          : [
              {
                dimension: "input" as const,
                requested: json(traceId),
                realized: replayApplications > 0 ? json(traceId) : null,
                status:
                  replayApplications > 0
                    ? ("partially_applied" as const)
                    : ("rejected" as const),
                sideEffects:
                  replayApplications > 0
                    ? [
                        `${replayApplications} trace applications were realized before replay failed`,
                      ]
                    : ([] as readonly string[]),
              },
            ]),
        ...(forkInput.changes.seed === undefined
          ? []
          : [
              {
                dimension: "seed" as const,
                requested: json(forkInput.changes.seed),
                realized: null,
                status: "rejected" as const,
                sideEffects: [] as readonly string[],
              },
            ]),
        ...(forkInput.changes.controls === undefined
          ? []
          : [
              {
                dimension: "runtime_control" as const,
                requested: json(forkInput.changes.controls),
                realized: json({
                  fixedFps: context.fixedFps,
                  physicsTicksPerSecond: context.physicsTicksPerSecond,
                  maxTicks: context.maxTicks,
                }),
                status: "applied" as const,
                sideEffects: ["controls were applied to the child runtime"],
              },
            ]),
        ...(forkInput.changes.capture === undefined
          ? []
          : [
              {
                dimension: "capture_profile" as const,
                requested: json(forkInput.changes.capture),
                realized: json(context.capturePolicy),
                status: "applied" as const,
                sideEffects: ["capture cost applied to the child execution"],
              },
            ]),
        ...(forkInput.changes.adapterIds === undefined
          ? []
          : [
              {
                dimension: "adapter" as const,
                requested: json(forkInput.changes.adapterIds),
                realized: json([context.adapterId]),
                status:
                  forkInput.changes.adapterIds.length === 1 &&
                  forkInput.changes.adapterIds[0] === context.adapterId
                    ? ("applied" as const)
                    : ("rejected" as const),
                sideEffects: [] as readonly string[],
              },
            ]),
        ...(forkInput.changes.probeIds === undefined
          ? []
          : [
              {
                dimension: "probe" as const,
                requested: json(forkInput.changes.probeIds),
                realized: json(context.probeIds),
                status:
                  JSON.stringify([...forkInput.changes.probeIds].sort()) ===
                  JSON.stringify([...context.probeIds].sort())
                    ? ("applied" as const)
                    : ("rejected" as const),
                sideEffects: [] as readonly string[],
              },
            ]),
      ];
      const failedBranch = VNextBranchLineageV1Schema.parse({
        schemaVersion: 1,
        taskId: this.options.taskId,
        branchId,
        parent,
        childWorkspaceId: this.options.workspaceId,
        childSourceId: prepared.build.sourceId,
        childBuildId: prepared.build.buildId,
        childAdapterId: context.adapterId,
        childProbeIds: context.probeIds,
        childCaptureWindowId: null,
        childTraceId: traceId,
        childExecutionId: context.executionId,
        requestedChanges: failureEntries.map((entry) => ({
          schemaVersion: 1,
          dimension: entry.dimension,
          requested: entry.requested,
        })),
        realizedChanges: failureEntries.map((entry) => ({
          schemaVersion: 1,
          dimension: entry.dimension,
          requested: entry.requested,
          realized: entry.realized,
          status: entry.status,
          knownSideEffects: [...entry.sideEffects],
        })),
        createdAt: this.#now(),
      });
      const cleanupErrors: Error[] = [];
      try {
        await this.options.runtimeStore.putResourceOnce(
          "branch",
          branchId,
          failedBranch,
          (value) => VNextBranchLineageV1Schema.parse(value),
        );
        context.manifest = VNextExecutionManifestV1Schema.parse({
          ...context.manifest,
          branchId,
          startCheckpointId: checkpoint?.manifest.checkpointId ?? null,
          traceId,
        });
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error
            ? error
            : new Error("failed to persist partial branch lineage"),
        );
      }
      try {
        await this.stopContext(
          context,
          "fork_failed",
          operationError instanceof Error ? operationError.message : null,
        );
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error
            ? error
            : new Error("fork child cleanup failed"),
        );
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [
            operationError instanceof Error
              ? operationError
              : new Error("fork operation failed"),
            ...cleanupErrors,
          ],
          "fork failed and cleanup or lineage persistence also failed",
        );
      }
      const lineageDetails = json({
        ...(operationDetails ?? {}),
        branchId,
        childRuntimeId: context.runtimeId,
        childExecutionId: context.executionId,
      });
      if (operationError instanceof ToolFailure) {
        throw new ToolFailure(
          operationError.code,
          operationError.message,
          operationError.recoverable,
          lineageDetails,
        );
      }
      throw new ToolFailure(
        "operation_failed",
        operationError instanceof Error
          ? operationError.message
          : "fork operation failed",
        false,
        lineageDetails,
      );
    }
    const changeEntries: Array<{
      readonly dimension: VNextBranchLineageV1["requestedChanges"][number]["dimension"];
      readonly requested: JsonValue;
      readonly realized: JsonValue;
      readonly status: "applied" | "partially_applied" | "rejected";
      readonly sideEffects: readonly string[];
    }> = [];
    if (forkInput.changes.buildId !== undefined) {
      changeEntries.push({
        dimension: "code",
        requested: forkInput.changes.buildId,
        realized: prepared.build.buildId,
        status: "applied",
        sideEffects:
          freshStart === undefined
            ? ["a new managed runtime was launched"]
            : ["a new managed runtime was launched", freshStart.reason],
      });
    }
    if (traceId !== null) {
      changeEntries.push({
        dimension: "input",
        requested: traceId,
        realized: traceId,
        status: "applied",
        sideEffects: ["the trace was replayed in the child execution"],
      });
    }
    if (forkInput.changes.seed !== undefined) {
      changeEntries.push({
        dimension: "seed",
        requested: forkInput.changes.seed,
        realized: null,
        status: "rejected",
        sideEffects: [],
      });
    }
    if (forkInput.changes.controls !== undefined) {
      changeEntries.push({
        dimension: "runtime_control",
        requested: json(forkInput.changes.controls),
        realized: json({
          fixedFps: context.fixedFps,
          physicsTicksPerSecond: context.physicsTicksPerSecond,
          maxTicks: context.maxTicks,
        }),
        status: "applied",
        sideEffects: ["controls apply to the child runtime only"],
      });
    }
    if (forkInput.changes.capture !== undefined) {
      changeEntries.push({
        dimension: "capture_profile",
        requested: json(forkInput.changes.capture),
        realized: json(context.capturePolicy),
        status: "applied",
        sideEffects: ["capture cost applies to the child execution"],
      });
    }
    if (forkInput.changes.adapterIds !== undefined) {
      const applied =
        forkInput.changes.adapterIds.length === 1 &&
        forkInput.changes.adapterIds[0] === context.adapterId;
      changeEntries.push({
        dimension: "adapter",
        requested: json(forkInput.changes.adapterIds),
        realized: json([context.adapterId]),
        status: applied ? "applied" : "rejected",
        sideEffects: [],
      });
    }
    if (forkInput.changes.probeIds !== undefined) {
      const applied =
        JSON.stringify([...forkInput.changes.probeIds].sort()) ===
        JSON.stringify([...context.probeIds].sort());
      changeEntries.push({
        dimension: "probe",
        requested: json(forkInput.changes.probeIds),
        realized: json(context.probeIds),
        status: applied ? "applied" : "rejected",
        sideEffects: [],
      });
    }
    const branch = VNextBranchLineageV1Schema.parse({
      schemaVersion: 1,
      taskId: this.options.taskId,
      branchId,
      parent,
      childWorkspaceId: this.options.workspaceId,
      childSourceId: prepared.build.sourceId,
      childBuildId: prepared.build.buildId,
      childAdapterId: context.adapterId,
      childProbeIds: context.probeIds,
      childCaptureWindowId: null,
      childTraceId: traceId,
      childExecutionId: context.executionId,
      requestedChanges: changeEntries.map((entry) => ({
        schemaVersion: 1,
        dimension: entry.dimension,
        requested: entry.requested,
      })),
      realizedChanges: changeEntries.map((entry) => ({
        schemaVersion: 1,
        dimension: entry.dimension,
        requested: entry.requested,
        realized: entry.realized,
        status: entry.status,
        knownSideEffects: [...entry.sideEffects],
      })),
      createdAt: this.#now(),
    });
    try {
      await this.options.runtimeStore.putResourceOnce(
        "branch",
        branchId,
        branch,
        (value) => VNextBranchLineageV1Schema.parse(value),
      );
    } catch (branchPersistenceError) {
      try {
        await this.stopContext(
          context,
          "fork_failed",
          branchPersistenceError instanceof Error
            ? branchPersistenceError.message
            : "branch lineage persistence failed",
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [
            branchPersistenceError instanceof Error
              ? branchPersistenceError
              : new Error("branch lineage persistence failed"),
            cleanupError instanceof Error
              ? cleanupError
              : new Error("fork child cleanup failed"),
          ],
          "branch lineage persistence and fork child cleanup failed",
        );
      }
      throw branchPersistenceError;
    }
    context.manifest = VNextExecutionManifestV1Schema.parse({
      ...context.manifest,
      branchId,
      startCheckpointId: checkpoint?.manifest.checkpointId ?? null,
      traceId,
    });
    return {
      branch,
      runtimeId: context.runtimeId,
      executionId: context.executionId,
      restore: restoreReceipt,
      replay: replayReceipt,
      state: context.state,
      clocks: context.clock,
    };
  }

  private runningRecord(context: RuntimeContext): VNextExecutionRecordV1 {
    return VNextExecutionRecordV1Schema.parse({
      schemaVersion: 1,
      taskId: this.options.taskId,
      executionId: context.executionId,
      runtimeId: context.runtimeId,
      buildId: context.prepared.build.buildId,
      manifest: context.manifest,
      captureProfile: context.capture.profile(),
      events: context.events,
      coverage: currentCoverage(context),
      loss: runtimeLoss(context),
      status: "running",
      sealed: false,
    });
  }

  private async loadExecution(
    executionIdInput: string,
  ): Promise<ExecutionSource> {
    const executionId = asExecutionId(executionIdInput);
    const active = this.#executionContexts.get(executionId);
    if (active !== undefined && !active.sealed) {
      return {
        record: this.runningRecord(active),
        events: [...active.events],
        captureWindowIds: [...active.captureWindowIds],
      };
    }
    let record: VNextExecutionRecordV1;
    try {
      record = await this.options.runtimeStore.readResource(
        "execution",
        executionId,
        (value) => VNextExecutionRecordV1Schema.parse(value),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
      throw new ToolFailure(
        "resource_not_found",
        "execution resource was not found",
        true,
        json({ executionId }),
      );
    }
    if (record.taskId !== this.options.taskId) {
      throw new ToolFailure(
        "resource_task_mismatch",
        "execution does not belong to this task",
        true,
      );
    }
    if (record.executionId !== executionId) {
      throw new Error(
        "execution payload identity does not match its resource ID",
      );
    }
    if (!record.sealed) {
      throw new ToolFailure(
        "conflict",
        "historical execution ledger is not sealed",
        true,
      );
    }
    const events = await this.options.runtimeStore.readExecutionEvents(
      executionId,
      (value) => VNextRawRuntimeEventV1Schema.parse(value),
    );
    const physicalSeal =
      await this.options.runtimeStore.readExecutionSeal(executionId);
    const recordedSeal = StoredExecutionSealV1Schema.parse(
      record.manifest.launchParameters["executionSeal"],
    );
    if (
      physicalSeal.taskId !== this.options.taskId ||
      physicalSeal.executionId !== executionId ||
      physicalSeal.count !== events.length ||
      JSON.stringify(physicalSeal) !== JSON.stringify(recordedSeal)
    ) {
      throw new Error(
        "sealed execution record does not match its physical ledger seal",
      );
    }
    if (contentHash(json(events)) !== contentHash(json(record.events))) {
      throw new Error(
        "sealed execution resource does not match its raw ledger",
      );
    }
    const { recordHash, ...recordBasis } = record;
    void recordHash;
    if (record.recordHash !== contentHash(json(recordBasis))) {
      throw new Error("sealed execution recordHash does not match its content");
    }
    const storedWindowIds =
      record.manifest.launchParameters["captureWindowIds"];
    const captureWindowIds = Array.isArray(storedWindowIds)
      ? storedWindowIds.map((value) => {
          if (typeof value !== "string") {
            throw new Error(
              "execution captureWindowIds contains a non-string ID",
            );
          }
          return asCaptureWindowId(value);
        })
      : [];
    return { record, events, captureWindowIds };
  }

  private buildQueryResult(
    source: ExecutionSource,
    input: {
      readonly indexId: RuntimeStateIndexId;
      readonly select: string;
      readonly filters?: Record<string, unknown> | undefined;
      readonly limit: number;
      readonly cursor?: string | undefined;
    },
  ): VNextRuntimeStateQueryResultV1 {
    const filters = input.filters ?? {};
    const selectedKinds: VNextRuntimeStateQueryV1["eventKinds"][number][] =
      input.select === "state"
        ? ["state"]
        : input.select === "clocks"
          ? ["clock"]
          : input.select === "entities"
            ? ["state", "lifecycle"]
            : [];
    const eventTypes = (filters["eventTypes"] ?? []) as readonly string[];
    const records = source.events.filter((event) =>
      matchesRequestedEventType(event, eventTypes),
    );
    const filteredKinds: VNextRuntimeStateQueryV1["eventKinds"][number][] = [
      ...new Set(records.map(runtimeStateRowKind)),
    ];
    const eventKinds = [
      ...new Set(
        selectedKinds.length === 0
          ? filteredKinds
          : filteredKinds.length === 0
            ? selectedKinds
            : selectedKinds.filter((kind) => filteredKinds.includes(kind)),
      ),
    ];
    const noMatchingKinds =
      (eventTypes.length > 0 && records.length === 0) ||
      (selectedKinds.length > 0 &&
        filteredKinds.length > 0 &&
        eventKinds.length === 0);
    const tickRange = filters["tickRange"] as
      | {
          readonly clock: "process_frame" | "physics_tick";
          readonly fromTick: number;
          readonly toTick: number;
        }
      | undefined;
    const firstClock = source.events[0]?.clock ?? clockAt(0, 0, 0, 0);
    const lastClock = source.events.at(-1)?.clock ?? firstClock;
    const queryClockRange =
      tickRange === undefined
        ? null
        : {
            schemaVersion: 1 as const,
            from: {
              ...firstClock,
              ...(tickRange.clock === "process_frame"
                ? { processFrame: tickRange.fromTick }
                : { physicsTick: tickRange.fromTick }),
            },
            through: {
              ...lastClock,
              ...(tickRange.clock === "process_frame"
                ? { processFrame: tickRange.toTick }
                : { physicsTick: tickRange.toTick }),
            },
          };
    if (tickRange !== undefined && tickRange.fromTick > tickRange.toTick) {
      throw new ToolFailure(
        "invalid_request",
        "query tick range must not run backwards",
        true,
      );
    }
    const query = VNextRuntimeStateQueryV1Schema.parse({
      schemaVersion: 1,
      taskId: this.options.taskId,
      executionId: source.record.executionId,
      entityIds: filters["entityIds"] ?? [],
      eventKinds,
      statePaths: filters["statePaths"] ?? [],
      clockRange: queryClockRange,
      limit: input.limit,
      cursor: input.cursor ?? null,
    });
    const index = VNextRuntimeStateIndex.rebuild({
      taskId: this.options.taskId,
      indexId: input.indexId,
      executionId: source.record.executionId,
      runtimeId: source.record.runtimeId,
      sourceId: source.record.manifest.sourceId,
      buildId: source.record.buildId,
      adapterId: source.record.manifest.adapterId,
      probeIds: source.record.manifest.probeIds,
      captureWindowIds: [...source.captureWindowIds],
      rawRecordHash: rawHash(source.events),
      records,
      coverage: source.record.coverage,
      loss: source.record.loss,
    });
    const result = index.query(query);
    return input.select === "coverage" || noMatchingKinds
      ? VNextRuntimeStateQueryResultV1Schema.parse({ ...result, rows: [] })
      : result;
  }

  private async query(input: Record<string, unknown>): Promise<unknown> {
    const executionId = String(input["executionId"]);
    const requestedIndexId = input["indexId"];
    const source = await this.loadExecution(executionId);
    if (typeof requestedIndexId === "string") {
      try {
        const existing = await this.options.runtimeStore.readResource(
          "index",
          requestedIndexId,
          (value) => StoredRuntimeStateIndexV1Schema.parse(value),
        );
        const sourceProbeIds = [...source.record.manifest.probeIds].sort();
        const sourceCaptureWindowIds = [...source.captureWindowIds].sort();
        if (
          existing.indexId !== requestedIndexId ||
          existing.taskId !== this.options.taskId ||
          existing.executionId !== executionId ||
          existing.runtimeId !== source.record.runtimeId ||
          existing.sourceId !== source.record.manifest.sourceId ||
          existing.buildId !== source.record.buildId ||
          existing.adapterId !== source.record.manifest.adapterId ||
          existing.rawRecordHash !== rawHash(source.events) ||
          JSON.stringify([...existing.probeIds].sort()) !==
            JSON.stringify(sourceProbeIds) ||
          JSON.stringify([...existing.captureWindowIds].sort()) !==
            JSON.stringify(sourceCaptureWindowIds)
        ) {
          throw new ToolFailure(
            "resource_task_mismatch",
            "Runtime State Index identity does not match the query",
            true,
          );
        }
        const result = this.buildQueryResult(source, {
          indexId: asRuntimeStateIndexId(requestedIndexId),
          select: String(input["select"]),
          filters: input["filters"] as Record<string, unknown> | undefined,
          limit: Number(input["limit"]),
          ...(typeof input["cursor"] === "string"
            ? { cursor: input["cursor"] }
            : {}),
        });
        return { result };
      } catch (error) {
        if (error instanceof ToolFailure) throw error;
        if (!isNotFound(error)) throw error;
        throw new ToolFailure(
          "resource_not_found",
          "Runtime State Index resource was not found",
          true,
        );
      }
    }
    const indexId = asRuntimeStateIndexId(this.#nextId("runtime-state-index"));
    const result = this.buildQueryResult(source, {
      indexId,
      select: String(input["select"]),
      filters: input["filters"] as Record<string, unknown> | undefined,
      limit: Number(input["limit"]),
      ...(typeof input["cursor"] === "string"
        ? { cursor: input["cursor"] }
        : {}),
    });
    const storedIndex: StoredRuntimeStateIndexV1 =
      StoredRuntimeStateIndexV1Schema.parse({
        schemaVersion: 1,
        taskId: result.taskId,
        indexId: result.indexId,
        executionId: result.executionId,
        runtimeId: result.runtimeId,
        sourceId: result.sourceId,
        buildId: result.buildId,
        adapterId: result.adapterId,
        probeIds: result.probeIds,
        captureWindowIds: result.captureWindowIds,
        rawRecordHash: result.rawRecordHash,
      });
    await this.options.runtimeStore.putResourceOnce(
      "index",
      indexId,
      storedIndex,
      (value) => StoredRuntimeStateIndexV1Schema.parse(value),
    );
    return { result };
  }

  private async compare(input: Record<string, unknown>): Promise<unknown> {
    const leftSource = await this.loadExecution(
      String(input["baselineExecutionId"]),
    );
    const rightSource = await this.loadExecution(
      String(input["candidateExecutionId"]),
    );
    if (!leftSource.record.sealed || !rightSource.record.sealed) {
      throw new ToolFailure(
        "conflict",
        "comparison requires two sealed immutable executions",
        true,
      );
    }
    if (
      leftSource.events.length > MAX_COMPARISON_SOURCE_EVENTS ||
      rightSource.events.length > MAX_COMPARISON_SOURCE_EVENTS
    ) {
      throw new ToolFailure(
        "budget_exhausted",
        `comparison source records are limited to ${MAX_COMPARISON_SOURCE_EVENTS} events per execution`,
        true,
        json({
          maximumSourceEvents: MAX_COMPARISON_SOURCE_EVENTS,
          baselineEvents: leftSource.events.length,
          candidateEvents: rightSource.events.length,
        }),
      );
    }
    const left = this.buildQueryResult(leftSource, {
      indexId: asRuntimeStateIndexId(this.#nextId("runtime-state-index")),
      select: "events",
      limit: MAX_COMPARISON_SOURCE_EVENTS,
    });
    const right = this.buildQueryResult(rightSource, {
      indexId: asRuntimeStateIndexId(this.#nextId("runtime-state-index")),
      select: "events",
      limit: MAX_COMPARISON_SOURCE_EVENTS,
    });
    if (left.nextCursor !== null || right.nextCursor !== null) {
      throw new ToolFailure(
        "budget_exhausted",
        "comparison projection exceeded its bounded source read",
        true,
        json({
          maximumSourceEvents: MAX_COMPARISON_SOURCE_EVENTS,
          baselineNextCursor: left.nextCursor,
          candidateNextCursor: right.nextCursor,
        }),
      );
    }
    const ref = (source: ExecutionSource) => ({
      schemaVersion: 1 as const,
      executionId: source.record.executionId,
      runtimeId: source.record.runtimeId,
      sourceId: source.record.manifest.sourceId,
      buildId: source.record.buildId,
      adapterId: source.record.manifest.adapterId,
      probeIds: source.record.manifest.probeIds,
      traceId: source.record.manifest.traceId,
      checkpointId: source.record.manifest.startCheckpointId,
      captureWindowIds: [...source.captureWindowIds],
      executionRecordHash:
        "recordHash" in source.record
          ? source.record.recordHash
          : (() => {
              throw new Error("comparison source execution is not sealed");
            })(),
      rawRecordHash: rawHash(source.events),
      captureCoverageHash: asSha256DigestV1(
        contentHash(json(source.record.coverage)),
      ),
      checkpointFidelity:
        source.record.manifest.startCheckpointId === null
          ? ("not_applicable" as const)
          : ("descriptive_only" as const),
    });
    const comparisonId = asComparisonId(this.#nextId("comparison"));
    const compared = new VNextDescriptiveComparisonService().compare({
      taskId: this.options.taskId,
      comparisonId,
      leftRef: ref(leftSource),
      rightRef: ref(rightSource),
      leftControls: leftSource.record.manifest.controls,
      rightControls: rightSource.record.manifest.controls,
      left,
      right,
      createdAt: this.#now(),
    });
    const maximumDifferences = Number(input["maxDifferences"]);
    if (compared.differences.length > maximumDifferences) {
      throw new ToolFailure(
        "budget_exhausted",
        "comparison found more observable differences than the requested output bound",
        true,
        json({
          comparisonId,
          requestedMaximum: maximumDifferences,
          observedDifferences: compared.differences.length,
        }),
      );
    }
    const comparison = VNextComparisonV1Schema.parse(compared);
    await this.options.runtimeStore.putResourceOnce(
      "comparison",
      comparisonId,
      comparison,
      (value) => VNextComparisonV1Schema.parse(value),
    );
    return { comparison };
  }

  private completionProvesCleanup(result: SandboxExecutionResultV1): boolean {
    return (
      result.kind === "executed" &&
      result.receipt.cleanup.processGroupTerminated &&
      !result.receipt.cleanup.cgroupPopulated &&
      result.receipt.cleanup.scopeRemoved
    );
  }

  private async appendSidecarCompletion(
    context: RuntimeContext,
    result: SandboxExecutionResultV1,
  ): Promise<void> {
    const executed = result.kind === "executed" ? result.receipt : null;
    await this.appendRaw(context, {
      channel:
        executed !== null &&
        executed.status === "succeeded" &&
        this.completionProvesCleanup(result)
          ? "log"
          : "error",
      kind:
        executed !== null &&
        executed.status === "succeeded" &&
        this.completionProvesCleanup(result)
          ? "log"
          : "error",
      clock: context.clock,
      payload: json({
        schemaVersion: 1,
        kind: result.kind,
        status: executed?.status ?? "denied",
        exitCode: executed?.exitCode ?? null,
        signal: executed?.signal ?? null,
        cleanup:
          executed === null
            ? null
            : {
                processGroupTerminated: executed.cleanup.processGroupTerminated,
                cgroupPopulated: executed.cleanup.cgroupPopulated,
                scopeRemoved: executed.cleanup.scopeRemoved,
              },
      }) as JsonObject,
      observerEffectUs: 0,
    });
  }

  private async appendSidecarDiagnostics(
    context: RuntimeContext,
  ): Promise<void> {
    const facts = context.sidecar.diagnosticFacts();
    if (facts.failure !== null && !context.diagnosticFailureRecorded) {
      await this.appendRaw(context, {
        channel: "error",
        kind: "error",
        clock: context.clock,
        payload: json({ schemaVersion: 1, ...facts.failure }) as JsonObject,
        observerEffectUs: 0,
      });
      const loss = VNextCaptureLossV1Schema.parse({
        schemaVersion: 1,
        sequence: context.externalLoss.length,
        channel: "error",
        kind: "unavailable",
        count: 0,
        firstClock: null,
        lastClock: null,
        reason:
          "sidecar diagnostic framing failed; later diagnostic history is unavailable",
      });
      context.externalLoss.push(loss);
      await this.appendRaw(context, {
        channel: "error",
        kind: "capture_loss",
        clock: context.clock,
        payload: json({
          schemaVersion: 1,
          channel: loss.channel,
          kind: loss.kind,
          count: loss.count,
          reason: loss.reason,
        }) as JsonObject,
        observerEffectUs: 0,
      });
      context.diagnosticFailureRecorded = true;
    }
    for (
      let index = context.recordedDiagnosticCount;
      index < facts.records.length;
      index += 1
    ) {
      const diagnostic = facts.records[index]!;
      const streamDiagnostic =
        diagnostic.kind === "godot_stdout" ||
        diagnostic.kind === "godot_stderr";
      const coordinatorTruncated =
        streamDiagnostic && diagnostic.bytesBase64.length > 60_000;
      const isError =
        diagnostic.kind === "godot_stderr" ||
        diagnostic.kind === "sidecar_error" ||
        (diagnostic.kind === "godot_exit" &&
          (diagnostic.exitCode !== 0 || diagnostic.signal !== null));
      await this.appendRaw(context, {
        channel: isError ? "error" : "log",
        kind: isError ? "error" : "log",
        clock: context.clock,
        payload: json(
          streamDiagnostic
            ? {
                ...diagnostic,
                bytesBase64: diagnostic.bytesBase64.slice(0, 60_000),
                coordinatorTruncated,
                sourceEncodedByteLength: diagnostic.bytesBase64.length,
              }
            : diagnostic,
        ) as JsonObject,
        observerEffectUs: 0,
      });
      if (streamDiagnostic && (diagnostic.truncated || coordinatorTruncated)) {
        const loss = VNextCaptureLossV1Schema.parse({
          schemaVersion: 1,
          sequence: context.externalLoss.length,
          channel: isError ? "error" : "log",
          kind: "dropped",
          count: 1,
          firstClock: context.clock,
          lastClock: context.clock,
          reason:
            "sidecar diagnostic bytes were truncated by a bounded capture layer",
        });
        context.externalLoss.push(loss);
        await this.appendRaw(context, {
          channel: isError ? "error" : "log",
          kind: "capture_loss",
          clock: context.clock,
          payload: json({
            schemaVersion: 1,
            channel: loss.channel,
            kind: loss.kind,
            count: loss.count,
            reason: loss.reason,
          }) as JsonObject,
          observerEffectUs: 0,
        });
      }
      context.recordedDiagnosticCount = index + 1;
    }
  }

  private async stopContext(
    context: RuntimeContext,
    code: string,
    message: string | null,
  ): Promise<unknown> {
    if (context.sealed) return { ...runtimeOutput(context), sealed: true };
    if (context.terminalPersistence !== null) {
      await this.finalize(
        context,
        context.status === "stopped" ? "stopped" : "failed",
        code,
        message,
      );
      return { ...runtimeOutput(context), sealed: true };
    }
    context.status = "stopping";
    const cleanupErrors: Error[] = [];
    let shutdownSucceeded = false;
    try {
      await context.client.shutdown();
      shutdownSucceeded = true;
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error : new Error("Godot shutdown failed"),
      );
    }
    let completion = shutdownSucceeded
      ? await this.waitForGracefulSidecarExit(context.sidecar)
      : undefined;
    if (completion === undefined) {
      try {
        await context.sidecar.terminate();
      } catch (error) {
        try {
          await this.appendSidecarDiagnostics(context);
        } catch (diagnosticError) {
          cleanupErrors.push(
            diagnosticError instanceof Error
              ? diagnosticError
              : new Error("sidecar diagnostic receipt failed"),
          );
        }
        cleanupErrors.push(
          error instanceof Error
            ? error
            : new Error("sidecar termination failed"),
        );
      }
    }
    try {
      completion ??= await context.sidecar.completion;
      await this.appendSidecarDiagnostics(context);
      await this.appendSidecarCompletion(context, completion);
    } catch (error) {
      try {
        await this.appendSidecarDiagnostics(context);
      } catch (diagnosticError) {
        cleanupErrors.push(
          diagnosticError instanceof Error
            ? diagnosticError
            : new Error("sidecar diagnostic receipt failed"),
        );
      }
      cleanupErrors.push(
        error instanceof Error
          ? error
          : new Error("sidecar completion receipt failed"),
      );
    }
    if (completion === undefined || !this.completionProvesCleanup(completion)) {
      cleanupErrors.push(
        new Error(
          "sandbox cleanup was not proven by the sidecar completion receipt",
        ),
      );
      context.status = "failed";
      throw new ToolFailure(
        "operation_failed",
        "runtime cleanup is unproven; execution remains unsealed",
        false,
        json({ errors: cleanupErrors.map((error) => error.message) }),
      );
    }
    const pendingTermination = context.pendingTermination;
    const cleanupMessage =
      cleanupErrors.length === 0
        ? null
        : cleanupErrors.map((error) => error.message).join("; ");
    await this.finalize(
      context,
      cleanupErrors.length > 0
        ? "failed"
        : (pendingTermination?.status ?? "stopped"),
      cleanupErrors.length > 0
        ? "cleanup_failed"
        : (pendingTermination?.code ?? code),
      cleanupErrors.length === 0
        ? (pendingTermination?.message ?? message)
        : [pendingTermination?.message, cleanupMessage]
            .filter(
              (entry): entry is string => entry !== null && entry !== undefined,
            )
            .join("; "),
    );
    if (cleanupErrors.length > 0) {
      throw new ToolFailure(
        "operation_failed",
        "runtime cleanup failed; the execution was sealed as failed",
        false,
        json({ errors: cleanupErrors.map((error) => error.message) }),
      );
    }
    return { ...runtimeOutput(context), sealed: true };
  }

  private async waitForGracefulSidecarExit(
    sidecar: SandboxedGodotSidecarV1,
  ): Promise<SandboxExecutionResultV1 | undefined> {
    if (this.#gracefulSidecarExitMs === 0) return undefined;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve(undefined),
        this.#gracefulSidecarExitMs,
      );
      void sidecar.completion.then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        () => {
          clearTimeout(timer);
          resolve(undefined);
        },
      );
    });
  }

  private async finalize(
    context: RuntimeContext,
    status: "stopped" | "crashed" | "failed",
    code: string,
    message: string | null,
  ): Promise<void> {
    if (context.sealed) return;
    if (context.terminalPersistence === null) {
      context.status = status;
      const endedAt = this.#now();
      context.runtime = VNextRuntimeV1Schema.parse({
        ...context.runtime,
        status,
        endedAt,
        termination: { schemaVersion: 1, code, message },
      });
      await this.persistCaptureRecords(context);
      const executionSeal = await this.options.runtimeStore.sealExecution(
        context.executionId,
      );
      context.manifest = VNextExecutionManifestV1Schema.parse({
        ...context.manifest,
        launchParameters: {
          ...context.manifest.launchParameters,
          executionSeal,
        },
      });
      const basis = {
        schemaVersion: 1 as const,
        taskId: this.options.taskId,
        executionId: context.executionId,
        runtimeId: context.runtimeId,
        buildId: context.prepared.build.buildId,
        manifest: context.manifest,
        captureProfile: context.capture.profile(),
        events: context.events,
        coverage: currentCoverage(context),
        loss: runtimeLoss(context),
        status,
        sealed: true as const,
        endedAt,
        termination: { schemaVersion: 1 as const, code, message },
      };
      const record = VNextExecutionRecordV1Schema.parse({
        ...basis,
        recordHash: contentHash(json(basis)),
      });
      if (!record.sealed) {
        throw new Error("terminal execution record unexpectedly remained open");
      }
      context.terminalPersistence = { runtime: context.runtime, record };
    }
    const terminal = context.terminalPersistence;
    await this.options.runtimeStore.putResourceOnce(
      "runtime",
      context.runtimeId,
      terminal.runtime,
      (value) => VNextRuntimeV1Schema.parse(value),
    );
    await this.options.runtimeStore.putResourceOnce(
      "execution",
      context.executionId,
      terminal.record,
      (value) => VNextExecutionRecordV1Schema.parse(value),
    );
    context.sealed = true;
    this.#backgroundFailures.delete(context.runtimeId);
  }
}

export const createVNextGodotRuntimeCoordinator = (
  options: VNextGodotRuntimeCoordinatorOptions,
  dependencies: VNextGodotRuntimeCoordinatorDependencies = {},
): VNextGodotRuntimeCoordinator =>
  new GodotRuntimeCoordinator(options, dependencies);
