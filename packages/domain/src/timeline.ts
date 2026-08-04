import { z } from "zod";

import {
  BranchIdSchema,
  CheckpointIdSchema,
  EvaluationIdSchema,
  EvidenceIdSchema,
  InputTraceIdSchema,
  RunIdSchema,
  type BranchId,
  type CheckpointId,
  type EvaluationId,
  type EvidenceId,
  type InputTraceId,
  type RunId,
} from "./ids.js";
import { JsonValueSchema, type JsonValue } from "./json.js";
import {
  FrameRecordSchema,
  ScheduledInputSchema,
  TelemetryEventSchema,
  type FrameRecord,
  type ScheduledInput,
  type TelemetryEvent,
} from "./telemetry.js";
import { PositiveMicrosecondsSchema, type Microseconds } from "./time.js";

export interface InputTrace {
  readonly schemaVersion: 1;
  readonly inputTraceId: InputTraceId;
  readonly scheduleBasis: "relative_tick";
  readonly inputs: readonly ScheduledInput[];
}

export const InputTraceSchema: z.ZodType<InputTrace> = z
  .object({
    schemaVersion: z.literal(1),
    inputTraceId: InputTraceIdSchema,
    scheduleBasis: z.literal("relative_tick"),
    inputs: z.array(ScheduledInputSchema),
  })
  .strict();

export interface BranchControls {
  readonly deltaUs: Microseconds;
  /** Largest relative tick to execute, inclusive; zero executes one frame. */
  readonly maxTicks: number;
  readonly variables: Readonly<Record<string, JsonValue>>;
}

export const BranchControlsSchema: z.ZodType<BranchControls> = z
  .object({
    deltaUs: PositiveMicrosecondsSchema,
    maxTicks: z.number().int().nonnegative(),
    variables: z.record(z.string(), JsonValueSchema),
  })
  .strict();

export type BranchStatus = "created" | "running" | "completed" | "failed";
export type ReplayMode = "none" | "strict" | "experiment";

export interface BranchRecord {
  readonly schemaVersion: 1;
  readonly branchId: BranchId;
  readonly runId: RunId;
  readonly parentBranchId?: BranchId | undefined;
  readonly forkCheckpointId: CheckpointId;
  readonly inputTraceId: InputTraceId;
  readonly controls: BranchControls;
  readonly replayMode: ReplayMode;
  readonly replayOfBranchId?: BranchId | undefined;
  readonly status: BranchStatus;
  readonly createdAt: string;
}

export const BranchRecordSchema: z.ZodType<BranchRecord> = z
  .object({
    schemaVersion: z.literal(1),
    branchId: BranchIdSchema,
    runId: RunIdSchema,
    parentBranchId: BranchIdSchema.optional(),
    forkCheckpointId: CheckpointIdSchema,
    inputTraceId: InputTraceIdSchema,
    controls: BranchControlsSchema,
    replayMode: z.enum(["none", "strict", "experiment"]),
    replayOfBranchId: BranchIdSchema.optional(),
    status: z.enum(["created", "running", "completed", "failed"]),
    createdAt: z.string().datetime(),
  })
  .strict();

export interface InvariantResultRef {
  readonly evaluationId: EvaluationId;
  readonly invariantId: string;
  readonly status: "pass" | "fail" | "incomplete";
  readonly evidenceId?: EvidenceId | undefined;
}

export const InvariantResultRefSchema: z.ZodType<InvariantResultRef> = z
  .object({
    evaluationId: EvaluationIdSchema,
    invariantId: z.string().min(1),
    status: z.enum(["pass", "fail", "incomplete"]),
    evidenceId: EvidenceIdSchema.optional(),
  })
  .strict();

export interface BranchRun {
  readonly schemaVersion: 1;
  readonly branchId: BranchId;
  readonly frames: readonly FrameRecord[];
  readonly events: readonly TelemetryEvent[];
  readonly evaluations: readonly InvariantResultRef[];
  readonly evidenceIds: readonly EvidenceId[];
  readonly timelineDigest: string;
  readonly finalCheckpointId: CheckpointId;
}

export const BranchRunSchema: z.ZodType<BranchRun> = z
  .object({
    schemaVersion: z.literal(1),
    branchId: BranchIdSchema,
    frames: z.array(FrameRecordSchema),
    events: z.array(TelemetryEventSchema),
    evaluations: z.array(InvariantResultRefSchema),
    evidenceIds: z.array(EvidenceIdSchema),
    timelineDigest: z.string().min(1),
    finalCheckpointId: CheckpointIdSchema,
  })
  .strict();

export interface ControlDifference {
  readonly name: string;
  readonly before: JsonValue;
  readonly after: JsonValue;
}

export interface BranchComparison {
  readonly schemaVersion: 1;
  readonly baselineBranchId: BranchId;
  readonly candidateBranchId: BranchId;
  readonly changedControls: readonly ControlDifference[];
  readonly baselineOutcome: "pass" | "fail" | "incomplete" | "mixed";
  readonly candidateOutcome: "pass" | "fail" | "incomplete" | "mixed";
  readonly digestsEqual: boolean;
  readonly firstDivergenceTick: number | null;
}

export const BranchComparisonSchema: z.ZodType<BranchComparison> = z
  .object({
    schemaVersion: z.literal(1),
    baselineBranchId: BranchIdSchema,
    candidateBranchId: BranchIdSchema,
    changedControls: z.array(
      z
        .object({
          name: z.string().min(1),
          before: JsonValueSchema,
          after: JsonValueSchema,
        })
        .strict(),
    ),
    baselineOutcome: z.enum(["pass", "fail", "incomplete", "mixed"]),
    candidateOutcome: z.enum(["pass", "fail", "incomplete", "mixed"]),
    digestsEqual: z.boolean(),
    firstDivergenceTick: z.number().int().nonnegative().nullable(),
  })
  .strict();
