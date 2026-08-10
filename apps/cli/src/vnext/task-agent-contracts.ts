import { z } from "zod";

import {
  GAME_TOOL_NAMES_V1,
  LIFECYCLE_GAME_TOOL_NAMES_V1,
  type LifecycleGameToolNameV1,
  type GameToolNameV1,
} from "@chronorift/agent-protocol";
import {
  Sha256DigestV1Schema,
  TaskIdSchema,
  type Sha256DigestV1,
  type TaskId,
} from "@chronorift/domain";
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

const AGENT_TASK_GAME_TOOL_NAMES_V1 = Object.freeze(
  Object.values(GAME_TOOL_NAMES_V1),
);

export interface VNextAgentGameCapabilityV1 {
  readonly schemaVersion: 1;
  readonly capabilityKind: "chronorift-m3-game-tools";
  readonly toolCatalogVersion: 1;
  readonly fixtureId: "frame-input-window";
  readonly managedRuntimeId: string;
  readonly toolNames: readonly GameToolNameV1[];
}

const freezeGameCapability = (
  capability: VNextAgentGameCapabilityV1,
): VNextAgentGameCapabilityV1 =>
  Object.freeze({
    ...capability,
    toolNames: Object.freeze([...capability.toolNames]),
  });

export const VNextAgentGameCapabilityV1Schema: z.ZodType<VNextAgentGameCapabilityV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      capabilityKind: z.literal("chronorift-m3-game-tools"),
      toolCatalogVersion: z.literal(1),
      fixtureId: z.literal("frame-input-window"),
      managedRuntimeId: z
        .string()
        .regex(/^managed-godot-runtime:v1:[a-f0-9]{64}$/u),
      toolNames: z
        .array(z.enum(GAME_TOOL_NAMES_V1))
        .length(AGENT_TASK_GAME_TOOL_NAMES_V1.length),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.toolNames.some(
          (toolName, index) =>
            toolName !== AGENT_TASK_GAME_TOOL_NAMES_V1[index],
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["toolNames"],
          message:
            "game tool catalog must match the complete ordered V1 catalog",
        });
      }
    })
    .transform(freezeGameCapability);

export const createVNextAgentGameCapabilityV1 = (
  managedRuntimeId: string,
): VNextAgentGameCapabilityV1 =>
  VNextAgentGameCapabilityV1Schema.parse({
    schemaVersion: 1,
    capabilityKind: "chronorift-m3-game-tools",
    toolCatalogVersion: 1,
    fixtureId: "frame-input-window",
    managedRuntimeId,
    toolNames: AGENT_TASK_GAME_TOOL_NAMES_V1,
  });

export interface VNextAgentLifecycleProfileV1 {
  readonly schemaVersion: 1;
  readonly kind: "godot-external-lifecycle-v1";
  readonly projectCapabilitySha256: Sha256DigestV1;
  readonly managedRuntimeId: string;
  readonly toolCatalogVersion: 1;
  readonly toolNames: readonly LifecycleGameToolNameV1[];
}

const freezeLifecycleProfile = (
  profile: VNextAgentLifecycleProfileV1,
): VNextAgentLifecycleProfileV1 =>
  Object.freeze({
    ...profile,
    toolNames: Object.freeze([...profile.toolNames]),
  });

export const VNextAgentLifecycleProfileV1Schema: z.ZodType<VNextAgentLifecycleProfileV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("godot-external-lifecycle-v1"),
      projectCapabilitySha256: Sha256DigestV1Schema,
      managedRuntimeId: z
        .string()
        .regex(/^managed-godot-runtime:v1:[a-f0-9]{64}$/u),
      toolCatalogVersion: z.literal(1),
      toolNames: z
        .array(z.enum(LIFECYCLE_GAME_TOOL_NAMES_V1))
        .length(LIFECYCLE_GAME_TOOL_NAMES_V1.length),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.toolNames.some(
          (toolName, index) => toolName !== LIFECYCLE_GAME_TOOL_NAMES_V1[index],
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["toolNames"],
          message:
            "lifecycle tool catalog must match the complete ordered four-tool catalog",
        });
      }
    })
    .transform(freezeLifecycleProfile);

export const createVNextAgentLifecycleProfileV1 = (input: {
  readonly projectCapabilitySha256: Sha256DigestV1;
  readonly managedRuntimeId: string;
}): VNextAgentLifecycleProfileV1 =>
  VNextAgentLifecycleProfileV1Schema.parse({
    schemaVersion: 1,
    kind: "godot-external-lifecycle-v1",
    projectCapabilitySha256: input.projectCapabilitySha256,
    managedRuntimeId: input.managedRuntimeId,
    toolCatalogVersion: 1,
    toolNames: LIFECYCLE_GAME_TOOL_NAMES_V1,
  });

interface VNextAgentTaskFields {
  readonly taskId: TaskId;
  readonly goal: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly createdAt: string;
}

export interface VNextAgentTaskV1 extends VNextAgentTaskFields {
  readonly schemaVersion: 1;
}

export interface VNextAgentTaskV2 extends VNextAgentTaskFields {
  readonly schemaVersion: 2;
  readonly gameCapability: VNextAgentGameCapabilityV1;
}

export interface VNextAgentTaskV3 extends VNextAgentTaskFields {
  readonly schemaVersion: 3;
  readonly profile: VNextAgentLifecycleProfileV1;
}

export type VNextAgentTask =
  VNextAgentTaskV1 | VNextAgentTaskV2 | VNextAgentTaskV3;

const agentTaskFields = {
  taskId: TaskIdSchema,
  goal: z
    .string()
    .min(1)
    .max(1024 * 1024),
  provider: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  thinkingLevel: ThinkingLevelSchema,
  createdAt: IsoTimestampSchema,
} as const;

export const VNextAgentTaskV1Schema: z.ZodType<VNextAgentTaskV1> = z
  .object({
    schemaVersion: z.literal(1),
    ...agentTaskFields,
  })
  .strict();

export const VNextAgentTaskV2Schema: z.ZodType<VNextAgentTaskV2> = z
  .object({
    schemaVersion: z.literal(2),
    ...agentTaskFields,
    gameCapability: VNextAgentGameCapabilityV1Schema,
  })
  .strict();

export const VNextAgentTaskV3Schema: z.ZodType<VNextAgentTaskV3> = z
  .object({
    schemaVersion: z.literal(3),
    ...agentTaskFields,
    profile: VNextAgentLifecycleProfileV1Schema,
  })
  .strict();

export const VNextAgentTaskSchema: z.ZodType<VNextAgentTask> = z.union([
  VNextAgentTaskV1Schema,
  VNextAgentTaskV2Schema,
  VNextAgentTaskV3Schema,
]);

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
