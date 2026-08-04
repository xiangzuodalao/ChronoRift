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
export type EvidenceId = Id<"EvidenceId">;
export type EvaluationId = Id<"EvaluationId">;
export type ReportId = Id<"ReportId">;
export type InvariantId = Id<"InvariantId">;

const idSchema = <T extends string>(): z.ZodType<Id<T>> =>
  z.string().min(1) as unknown as z.ZodType<Id<T>>;

export const RunIdSchema = idSchema<"RunId">();
export const BranchIdSchema = idSchema<"BranchId">();
export const CheckpointIdSchema = idSchema<"CheckpointId">();
export const InputTraceIdSchema = idSchema<"InputTraceId">();
export const EventIdSchema = idSchema<"EventId">();
export const EvidenceIdSchema = idSchema<"EvidenceId">();
export const EvaluationIdSchema = idSchema<"EvaluationId">();
export const ReportIdSchema = idSchema<"ReportId">();
export const InvariantIdSchema = idSchema<"InvariantId">();

export const asRunId = (value: string): RunId => RunIdSchema.parse(value);
export const asBranchId = (value: string): BranchId =>
  BranchIdSchema.parse(value);
export const asCheckpointId = (value: string): CheckpointId =>
  CheckpointIdSchema.parse(value);
export const asInputTraceId = (value: string): InputTraceId =>
  InputTraceIdSchema.parse(value);
export const asEventId = (value: string): EventId => EventIdSchema.parse(value);
export const asEvidenceId = (value: string): EvidenceId =>
  EvidenceIdSchema.parse(value);
export const asEvaluationId = (value: string): EvaluationId =>
  EvaluationIdSchema.parse(value);
export const asReportId = (value: string): ReportId =>
  ReportIdSchema.parse(value);
export const asInvariantId = (value: string): InvariantId =>
  InvariantIdSchema.parse(value);
