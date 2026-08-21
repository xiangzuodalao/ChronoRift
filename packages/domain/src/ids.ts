import { z } from "zod";

declare const idBrand: unique symbol;
export type Id<Kind extends string> = string & {
  readonly [idBrand]: Kind;
};

export type RunId = Id<"RunId">;
export type BranchId = Id<"BranchId">;
export type CheckpointId = Id<"CheckpointId">;
export type InputTraceId = Id<"InputTraceId">;
export type EventId = Id<"EventId">;
export type InvariantId = Id<"InvariantId">;
export type ContractId = Id<"ContractId">;
export type ExecutionId = Id<"ExecutionId">;
export type TaskId = Id<"TaskId">;
export type PatchId = Id<"PatchId">;
export type CapsuleId = Id<"CapsuleId">;
export type ComparisonId = Id<"ComparisonId">;
export type ProposalId = Id<"ProposalId">;
export type VerdictId = Id<"VerdictId">;
export type FixtureId = Id<"FixtureId">;
export type InterventionId = Id<"InterventionId">;
export type EvidenceAccessReceiptId = Id<"EvidenceAccessReceiptId">;
export type InvestigationId = Id<"InvestigationId">;
export type ClaimPolicyId = Id<"ClaimPolicyId">;
export type ExperimentReservationId = Id<"ExperimentReservationId">;
/** vNext task-scoped runtime resource identities. They are opaque IDs, not paths. */
export type WorkspaceId = Id<"WorkspaceId">;
export type SourceId = Id<"SourceId">;
export type BuildId = Id<"BuildId">;
export type RuntimeId = Id<"RuntimeId">;
export type AdapterId = Id<"AdapterId">;
export type ProbeId = Id<"ProbeId">;
export type CaptureWindowId = Id<"CaptureWindowId">;
export type TraceId = Id<"TraceId">;
export type RuntimeStateIndexId = Id<"RuntimeStateIndexId">;
export type RestoreReceiptId = Id<"RestoreReceiptId">;

const idSchema = <T extends string>(): z.ZodType<Id<T>> =>
  z.string().min(1) as unknown as z.ZodType<Id<T>>;

const opaqueResourceIdSchema = <T extends string>(): z.ZodType<Id<T>> =>
  z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u)
    .refine((value) => !value.includes(".."), {
      message:
        "Resource IDs are opaque identities and cannot contain path traversal",
    }) as unknown as z.ZodType<Id<T>>;

export const RunIdSchema = idSchema<"RunId">();
export const BranchIdSchema = idSchema<"BranchId">();
export const CheckpointIdSchema = idSchema<"CheckpointId">();
export const InputTraceIdSchema = idSchema<"InputTraceId">();
export const EventIdSchema = idSchema<"EventId">();
export const InvariantIdSchema = idSchema<"InvariantId">();
export const ContractIdSchema = idSchema<"ContractId">();
export const ExecutionIdSchema = idSchema<"ExecutionId">();
export const TaskIdSchema = idSchema<"TaskId">();
export const PatchIdSchema = idSchema<"PatchId">();
export const CapsuleIdSchema = idSchema<"CapsuleId">();
export const ComparisonIdSchema = idSchema<"ComparisonId">();
export const ProposalIdSchema = idSchema<"ProposalId">();
export const VerdictIdSchema = idSchema<"VerdictId">();
export const FixtureIdSchema = idSchema<"FixtureId">();
export const InterventionIdSchema = idSchema<"InterventionId">();
export const EvidenceAccessReceiptIdSchema =
  idSchema<"EvidenceAccessReceiptId">();
export const InvestigationIdSchema = idSchema<"InvestigationId">();
export const ClaimPolicyIdSchema = idSchema<"ClaimPolicyId">();
export const ExperimentReservationIdSchema =
  idSchema<"ExperimentReservationId">();
export const WorkspaceIdSchema = opaqueResourceIdSchema<"WorkspaceId">();
export const SourceIdSchema = opaqueResourceIdSchema<"SourceId">();
export const BuildIdSchema = opaqueResourceIdSchema<"BuildId">();
export const RuntimeIdSchema = opaqueResourceIdSchema<"RuntimeId">();
export const AdapterIdSchema = opaqueResourceIdSchema<"AdapterId">();
export const ProbeIdSchema = opaqueResourceIdSchema<"ProbeId">();
export const CaptureWindowIdSchema =
  opaqueResourceIdSchema<"CaptureWindowId">();
export const TraceIdSchema = opaqueResourceIdSchema<"TraceId">();
export const RuntimeStateIndexIdSchema =
  opaqueResourceIdSchema<"RuntimeStateIndexId">();
export const RestoreReceiptIdSchema =
  opaqueResourceIdSchema<"RestoreReceiptId">();

export const asRunId = (value: string): RunId => RunIdSchema.parse(value);
export const asBranchId = (value: string): BranchId =>
  BranchIdSchema.parse(value);
export const asCheckpointId = (value: string): CheckpointId =>
  CheckpointIdSchema.parse(value);
export const asInputTraceId = (value: string): InputTraceId =>
  InputTraceIdSchema.parse(value);
export const asEventId = (value: string): EventId => EventIdSchema.parse(value);
export const asInvariantId = (value: string): InvariantId =>
  InvariantIdSchema.parse(value);
export const asContractId = (value: string): ContractId =>
  ContractIdSchema.parse(value);
export const asExecutionId = (value: string): ExecutionId =>
  ExecutionIdSchema.parse(value);
export const asTaskId = (value: string): TaskId => TaskIdSchema.parse(value);
export const asPatchId = (value: string): PatchId => PatchIdSchema.parse(value);
export const asCapsuleId = (value: string): CapsuleId =>
  CapsuleIdSchema.parse(value);
export const asComparisonId = (value: string): ComparisonId =>
  ComparisonIdSchema.parse(value);
export const asProposalId = (value: string): ProposalId =>
  ProposalIdSchema.parse(value);
export const asVerdictId = (value: string): VerdictId =>
  VerdictIdSchema.parse(value);
export const asFixtureId = (value: string): FixtureId =>
  FixtureIdSchema.parse(value);
export const asInterventionId = (value: string): InterventionId =>
  InterventionIdSchema.parse(value);
export const asEvidenceAccessReceiptId = (
  value: string,
): EvidenceAccessReceiptId => EvidenceAccessReceiptIdSchema.parse(value);
export const asInvestigationId = (value: string): InvestigationId =>
  InvestigationIdSchema.parse(value);
export const asClaimPolicyId = (value: string): ClaimPolicyId =>
  ClaimPolicyIdSchema.parse(value);
export const asExperimentReservationId = (
  value: string,
): ExperimentReservationId => ExperimentReservationIdSchema.parse(value);
export const asWorkspaceId = (value: string): WorkspaceId =>
  WorkspaceIdSchema.parse(value);
export const asSourceId = (value: string): SourceId =>
  SourceIdSchema.parse(value);
export const asBuildId = (value: string): BuildId => BuildIdSchema.parse(value);
export const asRuntimeId = (value: string): RuntimeId =>
  RuntimeIdSchema.parse(value);
export const asAdapterId = (value: string): AdapterId =>
  AdapterIdSchema.parse(value);
export const asProbeId = (value: string): ProbeId => ProbeIdSchema.parse(value);
export const asCaptureWindowId = (value: string): CaptureWindowId =>
  CaptureWindowIdSchema.parse(value);
export const asTraceId = (value: string): TraceId => TraceIdSchema.parse(value);
export const asRuntimeStateIndexId = (value: string): RuntimeStateIndexId =>
  RuntimeStateIndexIdSchema.parse(value);
export const asRestoreReceiptId = (value: string): RestoreReceiptId =>
  RestoreReceiptIdSchema.parse(value);
