import { z } from "zod";

import { TaskIdSchema, type TaskId } from "@chronorift/domain";
import type { PiThinkingLevel } from "@chronorift/pi-harness";

const IsoTimestampSchema = z.string().datetime({ offset: true });
const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export interface VNextAgentTaskV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly goal: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly createdAt: string;
}

export const VNextAgentTaskV1Schema: z.ZodType<VNextAgentTaskV1> = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    goal: z
      .string()
      .min(1)
      .max(1024 * 1024),
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    thinkingLevel: ThinkingLevelSchema,
    createdAt: IsoTimestampSchema,
  })
  .strict();

export interface VNextAgentTurnV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly turn: number;
  readonly kind: "start" | "continue";
  readonly prompt: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly status: "completed" | "provider_failed" | "aborted" | "timed_out";
  readonly provider: string;
  readonly model: string;
  readonly requestedThinkingLevel: PiThinkingLevel;
  readonly realizedThinkingLevel: PiThinkingLevel;
  readonly activeTools: readonly string[];
  readonly assistantText: string;
  readonly errorMessage: string | null;
  readonly eventsObserved: number;
  readonly stats: {
    readonly userMessages: number;
    readonly assistantMessages: number;
    readonly toolCalls: number;
    readonly toolResults: number;
    readonly totalMessages: number;
    readonly tokens: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly total: number;
    };
    readonly cost: number;
  };
  readonly completedAt: string;
}

const NonnegativeIntegerSchema = z.number().int().nonnegative();
export const VNextAgentTurnV1Schema: z.ZodType<VNextAgentTurnV1> = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    turn: z.number().int().positive(),
    kind: z.enum(["start", "continue"]),
    prompt: z
      .string()
      .min(1)
      .max(1024 * 1024),
    sessionId: z.string().min(1).max(256),
    sessionFile: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          !value.includes("/") &&
          !value.includes("\\") &&
          value !== "." &&
          value !== "..",
        "sessionFile must be a basename",
      ),
    status: z.enum(["completed", "provider_failed", "aborted", "timed_out"]),
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    requestedThinkingLevel: ThinkingLevelSchema,
    realizedThinkingLevel: ThinkingLevelSchema,
    activeTools: z.array(z.string().min(1).max(128)).min(1).max(64),
    assistantText: z.string().max(16 * 1024 * 1024),
    errorMessage: z
      .string()
      .max(1024 * 1024)
      .nullable(),
    eventsObserved: NonnegativeIntegerSchema,
    stats: z
      .object({
        userMessages: NonnegativeIntegerSchema,
        assistantMessages: NonnegativeIntegerSchema,
        toolCalls: NonnegativeIntegerSchema,
        toolResults: NonnegativeIntegerSchema,
        totalMessages: NonnegativeIntegerSchema,
        tokens: z
          .object({
            input: NonnegativeIntegerSchema,
            output: NonnegativeIntegerSchema,
            cacheRead: NonnegativeIntegerSchema,
            cacheWrite: NonnegativeIntegerSchema,
            total: NonnegativeIntegerSchema,
          })
          .strict(),
        cost: z.number().nonnegative(),
      })
      .strict(),
    completedAt: IsoTimestampSchema,
  })
  .strict();
