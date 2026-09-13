import { z } from "zod";

import type {
  PiProxyToolDescriptor,
  PiProxyToolResult,
  PiCollaborationMessage,
  PiSessionForkContext,
  PiThinkingLevel,
  VNextPiTurnResult,
} from "@chronorift/pi-harness";

export const AGENT_IPC_VERSION = 2;
export const AGENT_IPC_MAX_BYTES = 16 * 1024 * 1024;
export const AGENT_MESSAGE_MAX_LENGTH = 64 * 1024;
export const AGENT_IPC_MAX_PENDING = 16;

export interface AgentWorkerConfiguration {
  readonly agentId?: string;
  readonly taskName?: string;
  readonly parentAgentId?: string;
  readonly forkContext?: PiSessionForkContext;
  readonly resumeSessionFile?: string;
  readonly resourceWorkspaceDirectory: string;
  readonly sessionDirectory: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly tools: readonly PiProxyToolDescriptor[];
  readonly agentDir?: string;
  readonly providerRequestTimeoutMs?: number;
  readonly agentRetryMaxRetries?: number;
  readonly transport?: "sse" | "websocket" | "auto";
  readonly environmentProfile?: "game" | "coding";
  readonly additionalEnvironmentInstructions?: string;
}

const boundedText = z.string().max(AGENT_MESSAGE_MAX_LENGTH);
const id = z.string().min(1).max(128);
const turnId = z.number().int().positive();
const agentPath = z
  .string()
  .max(4096)
  .regex(/^\/root(?:\/[a-z0-9_]+)*$/u);
const collaborationEnvelope = z
  .object({
    id,
    kind: z.enum(["message", "task", "completion"]),
    from: agentPath,
    to: agentPath,
    text: boundedText,
    createdAt: z.string().datetime(),
  })
  .strict();
const forkContext = z
  .object({
    schemaVersion: z.literal(1),
    parentSessionId: id,
    forkTurns: z.string().max(32),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant", "context"]),
            text: z.string(),
            turnStart: z.boolean(),
          })
          .strict(),
      )
      .max(100_000),
  })
  .strict();
const toolResult = z
  .object({
    content: z
      .array(
        z.union([
          z.object({ type: z.literal("text"), text: z.string() }).strict(),
          z
            .object({
              type: z.literal("image"),
              data: z.string(),
              mimeType: z.string(),
            })
            .strict(),
        ]),
      )
      .max(256),
    details: z.unknown().optional(),
    isError: z.boolean().optional(),
  })
  .strict();
const configuration = z
  .object({
    agentId: z.string().uuid().optional(),
    taskName: agentPath.optional(),
    parentAgentId: z.string().min(1).max(128).optional(),
    forkContext: forkContext.optional(),
    resumeSessionFile: z.string().min(1).optional(),
    resourceWorkspaceDirectory: z.string().min(1),
    sessionDirectory: z.string().min(1),
    provider: id,
    model: id,
    thinkingLevel: z.enum([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
    tools: z
      .array(
        z
          .object({
            name: id,
            label: z.string().optional(),
            description: z.string(),
            parameters: z.record(z.string(), z.unknown()),
            promptSnippet: z.string().optional(),
            promptGuidelines: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(256),
    agentDir: z.string().optional(),
    providerRequestTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .optional(),
    agentRetryMaxRetries: z.number().int().min(0).max(10).optional(),
    transport: z.enum(["sse", "websocket", "auto"]).optional(),
    environmentProfile: z.enum(["game", "coding"]).optional(),
    additionalEnvironmentInstructions: z.string().optional(),
  })
  .strict();
const base = { version: z.literal(AGENT_IPC_VERSION) };
const hostMessage = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("initialize"), configuration }).strict(),
  z
    .object({ ...base, type: z.literal("prompt"), turnId, text: boundedText })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("collaboration"),
      requestId: id,
      envelope: collaborationEnvelope,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("export_context"),
      requestId: id,
      forkTurns: z.string().max(32),
    })
    .strict(),
  z.object({ ...base, type: z.literal("interrupt"), turnId }).strict(),
  z.object({ ...base, type: z.literal("close") }).strict(),
  z
    .object({
      ...base,
      type: z.literal("tool_result"),
      turnId,
      requestId: id,
      result: toolResult,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("tool_update"),
      turnId,
      requestId: id,
      result: toolResult,
    })
    .strict(),
]);
const workerMessage = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("ready") }).strict(),
  z
    .object({
      ...base,
      type: z.literal("collaboration_consumed"),
      ids: z.array(id).max(4096),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("collaboration_accepted"),
      requestId: id,
      acceptedInCurrentTurn: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("context_exported"),
      requestId: id,
      context: forkContext,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("phase"),
      phase: z.enum(["current", "next", "idle"]),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("tool_request"),
      turnId,
      requestId: id,
      name: id,
      arguments: z.unknown(),
    })
    .strict(),
  z
    .object({ ...base, type: z.literal("tool_cancel"), turnId, requestId: id })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("completed"),
      turnId,
      result: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({ ...base, type: z.literal("failed"), turnId, error: boundedText })
    .strict(),
  z.object({ ...base, type: z.literal("fatal"), error: boundedText }).strict(),
]);

export type AgentHostMessage =
  | {
      readonly version: 2;
      readonly type: "initialize";
      readonly configuration: AgentWorkerConfiguration;
    }
  | {
      readonly version: 2;
      readonly type: "prompt";
      readonly turnId: number;
      readonly text: string;
    }
  | {
      readonly version: 2;
      readonly type: "collaboration";
      readonly requestId: string;
      readonly envelope: PiCollaborationMessage;
    }
  | {
      readonly version: 2;
      readonly type: "export_context";
      readonly requestId: string;
      readonly forkTurns: string;
    }
  | { readonly version: 2; readonly type: "interrupt"; readonly turnId: number }
  | { readonly version: 2; readonly type: "close" }
  | {
      readonly version: 2;
      readonly type: "tool_result" | "tool_update";
      readonly turnId: number;
      readonly requestId: string;
      readonly result: PiProxyToolResult;
    };

export type AgentWorkerMessage =
  | { readonly version: 2; readonly type: "ready" }
  | {
      readonly version: 2;
      readonly type: "collaboration_consumed";
      readonly ids: readonly string[];
    }
  | {
      readonly version: 2;
      readonly type: "collaboration_accepted";
      readonly requestId: string;
      readonly acceptedInCurrentTurn: boolean;
    }
  | {
      readonly version: 2;
      readonly type: "context_exported";
      readonly requestId: string;
      readonly context: PiSessionForkContext;
    }
  | {
      readonly version: 2;
      readonly type: "phase";
      readonly phase: "current" | "next" | "idle";
    }
  | {
      readonly version: 2;
      readonly type: "tool_request";
      readonly turnId: number;
      readonly requestId: string;
      readonly name: string;
      readonly arguments: unknown;
    }
  | {
      readonly version: 2;
      readonly type: "tool_cancel";
      readonly turnId: number;
      readonly requestId: string;
    }
  | {
      readonly version: 2;
      readonly type: "completed";
      readonly turnId: number;
      readonly result: VNextPiTurnResult;
    }
  | {
      readonly version: 2;
      readonly type: "failed";
      readonly turnId: number;
      readonly error: string;
    }
  | { readonly version: 2; readonly type: "fatal"; readonly error: string };

export function assertAgentIpcSize(message: unknown): void {
  const serialized = JSON.stringify(message);
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized) > AGENT_IPC_MAX_BYTES
  ) {
    throw new Error("Agent IPC message exceeds the size limit");
  }
}

export function parseAgentHostMessage(message: unknown): AgentHostMessage {
  assertAgentIpcSize(message);
  return hostMessage.parse(message) as AgentHostMessage;
}

export function parseAgentWorkerMessage(message: unknown): AgentWorkerMessage {
  assertAgentIpcSize(message);
  const parsed = workerMessage.parse(message);
  if (parsed.type === "completed") {
    // Completion data is evidence, never authority. Still reject malformed fields
    // used by the Host before allowing a worker to finish its current turn.
    z.object({
      schemaVersion: z.literal(1),
      status: z.enum(["completed", "provider_failed", "aborted", "timed_out"]),
      assistantText: z.string(),
      errorMessage: z.string().nullable(),
      sessionId: z.string(),
      sessionFile: z.string(),
      stats: z
        .object({
          tokens: z
            .object({
              input: z.number().finite().nonnegative(),
              output: z.number().finite().nonnegative(),
              cacheRead: z.number().finite().nonnegative(),
              cacheWrite: z.number().finite().nonnegative(),
              total: z.number().finite().nonnegative(),
            })
            .passthrough(),
          cost: z.number().finite().nonnegative(),
        })
        .passthrough(),
    })
      .passthrough()
      .parse(parsed.result);
  }
  return parsed as unknown as AgentWorkerMessage;
}

export function agentToolError(message: string): PiProxyToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: { error: message },
    isError: true,
  };
}
