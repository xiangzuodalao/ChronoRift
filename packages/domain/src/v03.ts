import { z } from "zod";

import {
  BenchmarkRunIdSchema,
  BranchIdSchema,
  CapsuleIdSchema,
  CheckpointIdSchema,
  ComparisonIdSchema,
  ContractIdSchema,
  EventIdSchema,
  ExecutionIdSchema,
  FixtureIdSchema,
  InputTraceIdSchema,
  InterventionIdSchema,
  ProposalIdSchema,
  RunIdSchema,
  VerdictIdSchema,
  type BenchmarkRunId,
  type BranchId,
  type CapsuleId,
  type CheckpointId,
  type ComparisonId,
  type ContractId,
  type EventId,
  type ExecutionId,
  type FixtureId,
  type InputTraceId,
  type InterventionId,
  type ProposalId,
  type RunId,
  type VerdictId,
} from "./ids.js";
import {
  PropertyEqualsPredicateSchema,
  SignalPredicateSchema,
  StateValueObservationSchema,
  type PropertyEqualsPredicate,
  type SignalPredicate,
  type StateValueObservation,
} from "./invariant.js";
import {
  JsonObjectSchema,
  JsonPrimitiveSchema,
  JsonValueSchema,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
} from "./json.js";
import {
  ObservationHealthV1Schema,
  RuntimeFingerprintV1Schema,
  type ObservationHealthV1,
  type RuntimeFingerprintV1,
} from "./runtime.js";
import { StateSnapshotSchema, type StateSnapshot } from "./telemetry.js";
import { MicrosecondsSchema, TickSchema } from "./time.js";
import { BranchControlsSchema, type BranchControls } from "./timeline.js";

export interface EntityRefV1 {
  readonly stableId: string;
  readonly incarnation: number;
}

export const EntityRefV1Schema: z.ZodType<EntityRefV1> = z
  .object({
    stableId: z.string().min(1),
    incarnation: z.number().int().positive(),
  })
  .strict();

export interface FrozenContractV2 {
  readonly schemaVersion: 2;
  readonly contractId: ContractId;
  readonly fixtureId: FixtureId;
  readonly authority: {
    readonly status: "frozen";
    readonly approvedBy: string;
  };
  readonly rule: {
    readonly trigger: SignalPredicate;
    readonly expectation: PropertyEqualsPredicate;
    readonly withinTicks: number;
    readonly inclusive: true;
  };
}

export const FrozenContractV2Schema: z.ZodType<FrozenContractV2> = z
  .object({
    schemaVersion: z.literal(2),
    contractId: ContractIdSchema,
    fixtureId: FixtureIdSchema,
    authority: z
      .object({
        status: z.literal("frozen"),
        approvedBy: z.string().min(1),
      })
      .strict(),
    rule: z
      .object({
        trigger: SignalPredicateSchema,
        expectation: PropertyEqualsPredicateSchema,
        withinTicks: z.number().int().positive(),
        inclusive: z.literal(true),
      })
      .strict(),
  })
  .strict();

const scheduledInputBase = {
  order: z.number().int().nonnegative(),
  action: z.string().min(1),
  target: z.string().min(1).optional(),
  payload: JsonObjectSchema,
};

export type ScheduledInputV2 =
  | {
      readonly scheduleBasis: "relative_tick";
      readonly relativeTick: number;
      readonly order: number;
      readonly action: string;
      readonly target?: string | undefined;
      readonly payload: JsonObject;
    }
  | {
      readonly scheduleBasis: "relative_sim_time_us";
      readonly relativeTimeUs: number;
      readonly order: number;
      readonly action: string;
      readonly target?: string | undefined;
      readonly payload: JsonObject;
    };

export const ScheduledInputV2Schema: z.ZodType<ScheduledInputV2> =
  z.discriminatedUnion("scheduleBasis", [
    z
      .object({
        ...scheduledInputBase,
        scheduleBasis: z.literal("relative_tick"),
        relativeTick: TickSchema,
      })
      .strict(),
    z
      .object({
        ...scheduledInputBase,
        scheduleBasis: z.literal("relative_sim_time_us"),
        relativeTimeUs: MicrosecondsSchema,
      })
      .strict(),
  ]);

export interface InputTraceV2 {
  readonly schemaVersion: 2;
  readonly inputTraceId: InputTraceId;
  readonly inputs: readonly ScheduledInputV2[];
}

export const InputTraceV2Schema: z.ZodType<InputTraceV2> = z
  .object({
    schemaVersion: z.literal(2),
    inputTraceId: InputTraceIdSchema,
    inputs: z.array(ScheduledInputV2Schema),
  })
  .strict()
  .superRefine((trace, context) => {
    const orders = new Set<number>();
    for (const [index, input] of trace.inputs.entries()) {
      if (orders.has(input.order)) {
        context.addIssue({
          code: "custom",
          message: "Input order values must be unique",
          path: ["inputs", index, "order"],
        });
      }
      orders.add(input.order);
    }
  });

export type InterventionSpecV2 =
  | {
      readonly kind: "shift_input";
      readonly inputOrder: number;
      readonly deltaTicks: number;
    }
  | {
      readonly kind: "set_runtime_control";
      readonly name: "fixed_fps" | "physics_ticks_per_second";
      readonly value: number;
    }
  | {
      readonly kind: "set_fixture_control";
      readonly name: string;
      readonly value: JsonPrimitive;
    };

export const InterventionSpecV2Schema: z.ZodType<InterventionSpecV2> =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("shift_input"),
        inputOrder: z.number().int().nonnegative(),
        deltaTicks: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("set_runtime_control"),
        name: z.enum(["fixed_fps", "physics_ticks_per_second"]),
        value: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("set_fixture_control"),
        name: z.string().min(1),
        value: JsonPrimitiveSchema,
      })
      .strict(),
  ]);

export interface ExperimentCandidateV1 {
  readonly schemaVersion: 1;
  readonly interventionId: InterventionId;
  readonly label: string;
  readonly intervention: InterventionSpecV2;
}

export const ExperimentCandidateV1Schema: z.ZodType<ExperimentCandidateV1> = z
  .object({
    schemaVersion: z.literal(1),
    interventionId: InterventionIdSchema,
    label: z.string().min(1),
    intervention: InterventionSpecV2Schema,
  })
  .strict();

export interface RealizedControlReceiptV1 {
  readonly schemaVersion: 1;
  readonly requested: Readonly<Record<string, JsonPrimitive>>;
  readonly realized: Readonly<Record<string, JsonPrimitive>>;
  readonly accepted: boolean;
  readonly mismatches: readonly string[];
}

export const RealizedControlReceiptV1Schema: z.ZodType<RealizedControlReceiptV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      requested: z.record(z.string(), JsonPrimitiveSchema),
      realized: z.record(z.string(), JsonPrimitiveSchema),
      accepted: z.boolean(),
      mismatches: z.array(z.string().min(1)),
    })
    .strict()
    .superRefine((receipt, context) => {
      if (receipt.accepted === receipt.mismatches.length > 0) {
        context.addIssue({
          code: "custom",
          message: "accepted and mismatches contradict each other",
          path: ["accepted"],
        });
      }
    });

interface V03EventBase {
  readonly schemaVersion: 2;
  readonly eventId: EventId;
  readonly executionId: ExecutionId;
  readonly runId: RunId;
  readonly branchId: BranchId;
  readonly seq: number;
  readonly tick: number;
  readonly simTimeUs: number;
  readonly causedByEventId?: EventId | undefined;
}

export type V03TelemetryEvent =
  | (V03EventBase & {
      readonly kind: "input";
      readonly order: number;
      readonly action: string;
      readonly target?: string | undefined;
      readonly payload: JsonObject;
      readonly requestedTick: number;
      readonly realizedTick: number;
    })
  | (V03EventBase & {
      readonly kind: "signal";
      readonly source: string;
      readonly name: string;
      readonly arguments: readonly JsonValue[];
      readonly sourceEntity?: EntityRefV1 | undefined;
    })
  | (V03EventBase & {
      readonly kind: "signal_delivery";
      readonly causedByEventId: EventId;
      readonly source: string;
      readonly name: string;
      readonly receiver: string;
      readonly delivered: boolean;
      readonly failureReason?:
        "receiver_not_connected" | "receiver_rejected" | "unknown" | undefined;
      readonly sourceEntity?: EntityRefV1 | undefined;
      readonly receiverEntity?: EntityRefV1 | undefined;
    })
  | (V03EventBase & {
      readonly kind: "property_changed";
      readonly path: string;
      readonly before: JsonValue;
      readonly after: JsonValue;
      readonly entity?: EntityRefV1 | undefined;
    })
  | (V03EventBase & {
      readonly kind: "entity_lifecycle";
      readonly action: "spawned" | "despawned";
      readonly entity: EntityRefV1;
    })
  | (V03EventBase & {
      readonly kind: "spatial_sample";
      readonly entity: EntityRefV1;
      readonly position: readonly [number, number];
    })
  | (V03EventBase & {
      readonly kind: "log";
      readonly level: "debug" | "info" | "warn" | "error";
      readonly source: string;
      readonly message: string;
      readonly fields: JsonObject;
    });

const v03EventBase = {
  schemaVersion: z.literal(2),
  eventId: EventIdSchema,
  executionId: ExecutionIdSchema,
  runId: RunIdSchema,
  branchId: BranchIdSchema,
  seq: z.number().int().nonnegative(),
  tick: TickSchema,
  simTimeUs: MicrosecondsSchema,
  causedByEventId: EventIdSchema.optional(),
};

export const V03TelemetryEventSchema: z.ZodType<V03TelemetryEvent> =
  z.discriminatedUnion("kind", [
    z
      .object({
        ...v03EventBase,
        kind: z.literal("input"),
        order: z.number().int().nonnegative(),
        action: z.string().min(1),
        target: z.string().min(1).optional(),
        payload: JsonObjectSchema,
        requestedTick: TickSchema,
        realizedTick: TickSchema,
      })
      .strict(),
    z
      .object({
        ...v03EventBase,
        kind: z.literal("signal"),
        source: z.string().min(1),
        name: z.string().min(1),
        arguments: z.array(JsonValueSchema),
        sourceEntity: EntityRefV1Schema.optional(),
      })
      .strict(),
    z
      .object({
        ...v03EventBase,
        kind: z.literal("signal_delivery"),
        causedByEventId: EventIdSchema,
        source: z.string().min(1),
        name: z.string().min(1),
        receiver: z.string().min(1),
        delivered: z.boolean(),
        failureReason: z
          .enum(["receiver_not_connected", "receiver_rejected", "unknown"])
          .optional(),
        sourceEntity: EntityRefV1Schema.optional(),
        receiverEntity: EntityRefV1Schema.optional(),
      })
      .strict(),
    z
      .object({
        ...v03EventBase,
        kind: z.literal("property_changed"),
        path: z.string().min(1),
        before: JsonValueSchema,
        after: JsonValueSchema,
        entity: EntityRefV1Schema.optional(),
      })
      .strict(),
    z
      .object({
        ...v03EventBase,
        kind: z.literal("entity_lifecycle"),
        action: z.enum(["spawned", "despawned"]),
        entity: EntityRefV1Schema,
      })
      .strict(),
    z
      .object({
        ...v03EventBase,
        kind: z.literal("spatial_sample"),
        entity: EntityRefV1Schema,
        position: z.tuple([z.number().finite(), z.number().finite()]),
      })
      .strict(),
    z
      .object({
        ...v03EventBase,
        kind: z.literal("log"),
        level: z.enum(["debug", "info", "warn", "error"]),
        source: z.string().min(1),
        message: z.string(),
        fields: JsonObjectSchema,
      })
      .strict(),
  ]);

export interface ContractEvaluationV2 {
  readonly status: "pass" | "fail" | "incomplete";
  readonly triggerEventId: EventId;
  readonly triggerTick: number;
  readonly deadlineTick: number;
  readonly observed: StateValueObservation;
  readonly satisfiedTick?: number | undefined;
}

export const ContractEvaluationV2Schema: z.ZodType<ContractEvaluationV2> = z
  .object({
    status: z.enum(["pass", "fail", "incomplete"]),
    triggerEventId: EventIdSchema,
    triggerTick: TickSchema,
    deadlineTick: TickSchema,
    observed: StateValueObservationSchema,
    satisfiedTick: TickSchema.optional(),
  })
  .strict();

interface V03BranchSpecBase {
  readonly schemaVersion: 2;
  readonly branchId: BranchId;
  readonly runId: RunId;
  readonly fixtureId: FixtureId;
  readonly contractId: ContractId;
  readonly startCheckpointId: CheckpointId;
  readonly inputTraceId: InputTraceId;
  readonly controls: BranchControls;
  readonly createdAt: string;
}

export type V03BranchSpec =
  | (V03BranchSpecBase & { readonly branchKind: "baseline" })
  | (V03BranchSpecBase & {
      readonly branchKind: "intervention";
      readonly parentBranchId: BranchId;
      readonly interventionId: InterventionId;
      readonly intervention: InterventionSpecV2;
    });

const v03BranchBase = {
  schemaVersion: z.literal(2),
  branchId: BranchIdSchema,
  runId: RunIdSchema,
  fixtureId: FixtureIdSchema,
  contractId: ContractIdSchema,
  startCheckpointId: CheckpointIdSchema,
  inputTraceId: InputTraceIdSchema,
  controls: BranchControlsSchema,
  createdAt: z.string().datetime(),
};

export const V03BranchSpecSchema: z.ZodType<V03BranchSpec> =
  z.discriminatedUnion("branchKind", [
    z.object({ ...v03BranchBase, branchKind: z.literal("baseline") }).strict(),
    z
      .object({
        ...v03BranchBase,
        branchKind: z.literal("intervention"),
        parentBranchId: BranchIdSchema,
        interventionId: InterventionIdSchema,
        intervention: InterventionSpecV2Schema,
      })
      .strict(),
  ]);

export interface V03ExecutionLog {
  readonly schemaVersion: 2;
  readonly executionId: ExecutionId;
  readonly runId: RunId;
  readonly fixtureId: FixtureId;
  readonly branchId: BranchId;
  readonly contractId: ContractId;
  readonly startCheckpointId: CheckpointId;
  readonly inputTraceId: InputTraceId;
  readonly status: "completed";
  readonly evaluation: ContractEvaluationV2;
  readonly controlReceipt: RealizedControlReceiptV1;
  readonly observationHealth: ObservationHealthV1;
  readonly events: readonly V03TelemetryEvent[];
  readonly finalState: StateSnapshot;
  readonly timelineDigest: string;
  readonly sealed: true;
  readonly runtimeFingerprint?: RuntimeFingerprintV1 | undefined;
}

export const V03ExecutionLogSchema: z.ZodType<V03ExecutionLog> = z
  .object({
    schemaVersion: z.literal(2),
    executionId: ExecutionIdSchema,
    runId: RunIdSchema,
    fixtureId: FixtureIdSchema,
    branchId: BranchIdSchema,
    contractId: ContractIdSchema,
    startCheckpointId: CheckpointIdSchema,
    inputTraceId: InputTraceIdSchema,
    status: z.literal("completed"),
    evaluation: ContractEvaluationV2Schema,
    controlReceipt: RealizedControlReceiptV1Schema,
    observationHealth: ObservationHealthV1Schema,
    events: z.array(V03TelemetryEventSchema),
    finalState: StateSnapshotSchema,
    timelineDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    sealed: z.literal(true),
    runtimeFingerprint: RuntimeFingerprintV1Schema.optional(),
  })
  .strict()
  .superRefine((execution, context) => {
    const ids = new Set<string>();
    for (const [index, event] of execution.events.entries()) {
      if (
        event.executionId !== execution.executionId ||
        event.runId !== execution.runId ||
        event.branchId !== execution.branchId ||
        event.seq !== index
      ) {
        context.addIssue({
          code: "custom",
          message: "Event provenance or sequence does not match execution",
          path: ["events", index],
        });
      }
      if (ids.has(event.eventId)) {
        context.addIssue({
          code: "custom",
          message: "Event IDs must be unique",
          path: ["events", index, "eventId"],
        });
      }
      if (
        event.causedByEventId !== undefined &&
        !ids.has(event.causedByEventId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Causal references must resolve to earlier events",
          path: ["events", index, "causedByEventId"],
        });
      }
      ids.add(event.eventId);
    }
  });

export interface EvidenceLinkV2 {
  readonly role:
    | "trigger"
    | "delivery"
    | "state_transition"
    | "lifecycle"
    | "spatial_sample"
    | "runtime_log";
  readonly eventId: EventId;
}

export const EvidenceLinkV2Schema: z.ZodType<EvidenceLinkV2> = z
  .object({
    role: z.enum([
      "trigger",
      "delivery",
      "state_transition",
      "lifecycle",
      "spatial_sample",
      "runtime_log",
    ]),
    eventId: EventIdSchema,
  })
  .strict();

export interface EvidenceCapsuleV2 {
  readonly schemaVersion: 2;
  readonly capsuleId: CapsuleId;
  readonly runId: RunId;
  readonly fixtureId: FixtureId;
  readonly contractId: ContractId;
  readonly baselineExecutionId: ExecutionId;
  readonly checkpointId: CheckpointId;
  readonly eventChain: readonly V03TelemetryEvent[];
  readonly evidenceLinks: readonly EvidenceLinkV2[];
  readonly expected: PropertyEqualsPredicate;
  readonly actual: StateValueObservation;
  readonly violationSummary: string;
  readonly timelineDigest: string;
  readonly eventLossDetected: boolean;
  readonly knownLimitations: readonly string[];
}

export const EvidenceCapsuleV2Schema: z.ZodType<EvidenceCapsuleV2> = z
  .object({
    schemaVersion: z.literal(2),
    capsuleId: CapsuleIdSchema,
    runId: RunIdSchema,
    fixtureId: FixtureIdSchema,
    contractId: ContractIdSchema,
    baselineExecutionId: ExecutionIdSchema,
    checkpointId: CheckpointIdSchema,
    eventChain: z.array(V03TelemetryEventSchema),
    evidenceLinks: z.array(EvidenceLinkV2Schema).nonempty(),
    expected: PropertyEqualsPredicateSchema,
    actual: StateValueObservationSchema,
    violationSummary: z.string().min(1),
    timelineDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    eventLossDetected: z.boolean(),
    knownLimitations: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((capsule, context) => {
    const ids = new Set(capsule.eventChain.map((event) => event.eventId));
    for (const [index, link] of capsule.evidenceLinks.entries()) {
      if (!ids.has(link.eventId)) {
        context.addIssue({
          code: "custom",
          message: "Evidence link does not resolve inside the capsule",
          path: ["evidenceLinks", index, "eventId"],
        });
      }
    }
  });

export interface V03ExecutionComparison {
  readonly schemaVersion: 2;
  readonly comparisonId: ComparisonId;
  readonly runId: RunId;
  readonly fixtureId: FixtureId;
  readonly contractId: ContractId;
  readonly baselineExecutionId: ExecutionId;
  readonly candidateExecutionId: ExecutionId;
  readonly interventionId: InterventionId;
  readonly intervention: InterventionSpecV2;
  readonly baselineOutcome: "pass" | "fail" | "incomplete";
  readonly candidateOutcome: "pass" | "fail" | "incomplete";
  readonly comparable: boolean;
  readonly blockers: readonly string[];
  readonly firstDivergenceTick: number | null;
}

export const V03ExecutionComparisonSchema: z.ZodType<V03ExecutionComparison> = z
  .object({
    schemaVersion: z.literal(2),
    comparisonId: ComparisonIdSchema,
    runId: RunIdSchema,
    fixtureId: FixtureIdSchema,
    contractId: ContractIdSchema,
    baselineExecutionId: ExecutionIdSchema,
    candidateExecutionId: ExecutionIdSchema,
    interventionId: InterventionIdSchema,
    intervention: InterventionSpecV2Schema,
    baselineOutcome: z.enum(["pass", "fail", "incomplete"]),
    candidateOutcome: z.enum(["pass", "fail", "incomplete"]),
    comparable: z.boolean(),
    blockers: z.array(z.string().min(1)),
    firstDivergenceTick: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((comparison, context) => {
    if (comparison.comparable === comparison.blockers.length > 0) {
      context.addIssue({
        code: "custom",
        message: "comparable and blockers contradict each other",
        path: ["comparable"],
      });
    }
  });

export const MechanismCodeV2Schema = z.enum([
  "signal_before_receiver_connection",
  "frame_count_used_for_time_window",
  "discrete_physics_tunneling",
  "stale_effect_crossed_entity_incarnation",
  "unknown",
]);
export type MechanismCodeV2 = z.infer<typeof MechanismCodeV2Schema>;

export interface DiagnosisProposalV2 {
  readonly schemaVersion: 2;
  readonly proposalId: ProposalId;
  readonly runId: RunId;
  readonly fixtureId: FixtureId;
  readonly capsuleId: CapsuleId;
  readonly baselineExecutionId: ExecutionId;
  readonly replayExecutionId?: ExecutionId | undefined;
  readonly comparisonIds: readonly ComparisonId[];
  readonly mechanismCode: MechanismCodeV2;
  readonly summary: string;
  readonly evidenceEventIds: readonly EventId[];
  readonly suspectedSource?:
    { readonly path: string; readonly symbol?: string | undefined } | undefined;
  readonly blockers: readonly string[];
  readonly nextExperiment: string | null;
  readonly confidence: number;
}

export const DiagnosisProposalV2Schema: z.ZodType<DiagnosisProposalV2> = z
  .object({
    schemaVersion: z.literal(2),
    proposalId: ProposalIdSchema,
    runId: RunIdSchema,
    fixtureId: FixtureIdSchema,
    capsuleId: CapsuleIdSchema,
    baselineExecutionId: ExecutionIdSchema,
    replayExecutionId: ExecutionIdSchema.optional(),
    comparisonIds: z.array(ComparisonIdSchema),
    mechanismCode: MechanismCodeV2Schema,
    summary: z.string().min(1),
    evidenceEventIds: z.array(EventIdSchema),
    suspectedSource: z
      .object({
        path: z.string().min(1),
        symbol: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    blockers: z.array(z.string().min(1)),
    nextExperiment: z.string().min(1).nullable(),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();

export interface DiagnosisVerdictV2 {
  readonly schemaVersion: 2;
  readonly verdictId: VerdictId;
  readonly proposalId: ProposalId;
  readonly runId: RunId;
  readonly fixtureId: FixtureId;
  readonly status: "confirmed" | "inconclusive";
  readonly mechanismCode: MechanismCodeV2;
  readonly summary: string;
  readonly blockers: readonly string[];
}

export const DiagnosisVerdictV2Schema: z.ZodType<DiagnosisVerdictV2> = z
  .object({
    schemaVersion: z.literal(2),
    verdictId: VerdictIdSchema,
    proposalId: ProposalIdSchema,
    runId: RunIdSchema,
    fixtureId: FixtureIdSchema,
    status: z.enum(["confirmed", "inconclusive"]),
    mechanismCode: MechanismCodeV2Schema,
    summary: z.string().min(1),
    blockers: z.array(z.string().min(1)),
  })
  .strict();

export const BenchmarkArmV1Schema = z.enum([
  "generic",
  "evidence-only",
  "chronorift-full",
]);
export type BenchmarkArmV1 = z.infer<typeof BenchmarkArmV1Schema>;

export interface BenchmarkCellResultV1 {
  readonly schemaVersion: 1;
  readonly benchmarkRunId: BenchmarkRunId;
  readonly suiteHash: string;
  readonly fixtureId: FixtureId;
  readonly arm: BenchmarkArmV1;
  readonly repetition: number;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: string;
  readonly expectedMechanism: Exclude<MechanismCodeV2, "unknown">;
  readonly proposedMechanism: MechanismCodeV2;
  readonly mechanismCorrect: boolean;
  readonly verdict: "confirmed" | "inconclusive";
  readonly incorrectConfirmation: boolean;
  readonly sourceLocationCorrect: boolean | null;
  readonly gameExecutions: number;
  readonly toolCalls: number;
  readonly wallTimeMs: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly total: number;
  };
  readonly rawManifestHash: string;
}

export const BenchmarkCellResultV1Schema: z.ZodType<BenchmarkCellResultV1> = z
  .object({
    schemaVersion: z.literal(1),
    benchmarkRunId: BenchmarkRunIdSchema,
    suiteHash: z.string().regex(/^[a-f0-9]{64}$/u),
    fixtureId: FixtureIdSchema,
    arm: BenchmarkArmV1Schema,
    repetition: z.number().int().positive(),
    provider: z.string().min(1),
    model: z.string().min(1),
    thinkingLevel: z.string().min(1),
    expectedMechanism: MechanismCodeV2Schema.exclude(["unknown"]),
    proposedMechanism: MechanismCodeV2Schema,
    mechanismCorrect: z.boolean(),
    verdict: z.enum(["confirmed", "inconclusive"]),
    incorrectConfirmation: z.boolean(),
    sourceLocationCorrect: z.boolean().nullable(),
    gameExecutions: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    wallTimeMs: z.number().int().nonnegative(),
    tokens: z
      .object({
        input: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    rawManifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .superRefine((cell, context) => {
    const correct = cell.expectedMechanism === cell.proposedMechanism;
    if (cell.mechanismCorrect !== correct) {
      context.addIssue({
        code: "custom",
        message: "mechanismCorrect contradicts the mechanism fields",
        path: ["mechanismCorrect"],
      });
    }
    if (
      cell.incorrectConfirmation !== (cell.verdict === "confirmed" && !correct)
    ) {
      context.addIssue({
        code: "custom",
        message: "incorrectConfirmation contradicts verdict and mechanism",
        path: ["incorrectConfirmation"],
      });
    }
  });

export interface BenchmarkReportV1 {
  readonly schemaVersion: 1;
  readonly benchmarkRunId: BenchmarkRunId;
  readonly suiteHash: string;
  readonly seed: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: string;
  readonly repetitions: number;
  readonly cells: readonly BenchmarkCellResultV1[];
  readonly advantage: {
    readonly fullAccuracy: number;
    readonly genericAccuracy: number;
    readonly delta: number;
    readonly incorrectConfirmations: number;
    readonly thresholdMet: boolean;
  };
}

export const BenchmarkReportV1Schema: z.ZodType<BenchmarkReportV1> = z
  .object({
    schemaVersion: z.literal(1),
    benchmarkRunId: BenchmarkRunIdSchema,
    suiteHash: z.string().regex(/^[a-f0-9]{64}$/u),
    seed: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    thinkingLevel: z.string().min(1),
    repetitions: z.number().int().positive(),
    cells: z.array(BenchmarkCellResultV1Schema),
    advantage: z
      .object({
        fullAccuracy: z.number().finite().min(0).max(1),
        genericAccuracy: z.number().finite().min(0).max(1),
        delta: z.number().finite().min(-1).max(1),
        incorrectConfirmations: z.number().int().nonnegative(),
        thresholdMet: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((report, context) => {
    for (const [index, cell] of report.cells.entries()) {
      if (
        cell.benchmarkRunId !== report.benchmarkRunId ||
        cell.suiteHash !== report.suiteHash ||
        cell.provider !== report.provider ||
        cell.model !== report.model ||
        cell.thinkingLevel !== report.thinkingLevel ||
        cell.repetition > report.repetitions
      ) {
        context.addIssue({
          code: "custom",
          message: "Cell provenance does not match its benchmark report",
          path: ["cells", index],
        });
      }
    }
  });
