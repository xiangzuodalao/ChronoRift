import { z } from "zod";

/** Trusted Host configuration, never part of a model tool's input schema. */
export const ProjectExecutionLimitsSchema = z
  .object({
    sharedToolCallLimit: z.number().int().min(1).max(2048).default(256),
    workerTurnTimeoutMs: z
      .number()
      .int()
      .min(1)
      .max(3_600_000)
      .default(600_000),
    workerTurnToolCallLimit: z.number().int().min(1).max(512).default(64),
  })
  .strict();

export type ProjectExecutionLimits = z.input<
  typeof ProjectExecutionLimitsSchema
>;
