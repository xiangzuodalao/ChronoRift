import {
  GAME_TOOL_OUTPUT_SCHEMAS_V1,
  GAME_TOOL_DEFINITIONS_V1,
  GameBoundedJsonValueV1Schema,
  LIFECYCLE_GAME_TOOL_DEFINITIONS_V1,
  LIFECYCLE_GAME_TOOL_OUTPUT_SCHEMAS_V2,
  type LifecycleGameToolNameV1,
  type GameToolNameV1,
} from "@chronorift/agent-protocol";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const strictObject = { additionalProperties: false } as const;

export const VNEXT_GAME_TOOL_ERROR_CODES_V1 = [
  "unsupported_capability",
  "invalid_request",
  "resource_not_found",
  "resource_task_mismatch",
  "permission_denied",
  "busy",
  "conflict",
  "budget_exhausted",
  "runtime_crashed",
  "runtime_unavailable",
  "history_window_unavailable",
  "pre_failure_checkpoint_unavailable",
  "checkpoint_incompatible",
  "restore_gap",
  "trace_unavailable",
  "comparison_confounded",
  "operation_failed",
] as const;

export type VNextGameToolErrorCodeV1 =
  (typeof VNEXT_GAME_TOOL_ERROR_CODES_V1)[number];

const VNextGameToolCallIdV1Schema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
});

const VNextGameToolErrorCodeV1Schema = Type.Union(
  VNEXT_GAME_TOOL_ERROR_CODES_V1.map((code) => Type.Literal(code)),
);

export const VNextGameToolErrorV1Schema = Type.Object(
  {
    code: VNextGameToolErrorCodeV1Schema,
    message: Type.String({ minLength: 1, maxLength: 4096 }),
    recoverable: Type.Boolean(),
    details: Type.Optional(GameBoundedJsonValueV1Schema),
  },
  strictObject,
);
export type VNextGameToolErrorV1 = Static<typeof VNextGameToolErrorV1Schema>;

export const VNextGameToolSuccessEnvelopeV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    toolCallId: VNextGameToolCallIdV1Schema,
    outcome: Type.Literal("success"),
    output: GameBoundedJsonValueV1Schema,
  },
  strictObject,
);
export type VNextGameToolSuccessEnvelopeV1 = Static<
  typeof VNextGameToolSuccessEnvelopeV1Schema
>;

export const VNextGameToolErrorEnvelopeV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    toolCallId: VNextGameToolCallIdV1Schema,
    outcome: Type.Literal("error"),
    error: VNextGameToolErrorV1Schema,
  },
  strictObject,
);
export type VNextGameToolErrorEnvelopeV1 = Static<
  typeof VNextGameToolErrorEnvelopeV1Schema
>;

export const VNextGameToolResponseV1Schema = Type.Union([
  VNextGameToolSuccessEnvelopeV1Schema,
  VNextGameToolErrorEnvelopeV1Schema,
]);
export type VNextGameToolResponseV1 = Static<
  typeof VNextGameToolResponseV1Schema
>;

export interface VNextGameToolPortRequestV1 {
  readonly schemaVersion: 1;
  readonly toolCallId: string;
  readonly toolName: GameToolNameV1;
  readonly input: unknown;
}

export interface VNextGameToolPort {
  invoke(
    request: VNextGameToolPortRequestV1,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface VNextLifecycleGameToolPortRequestV1 {
  readonly schemaVersion: 1;
  readonly toolCallId: string;
  readonly toolName: LifecycleGameToolNameV1;
  readonly input: unknown;
}

export interface VNextLifecycleGameToolPort {
  invoke(
    request: VNextLifecycleGameToolPortRequestV1,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

interface JsonBudget {
  nodes: number;
  characters: number;
}

const isBoundedJsonValue = (
  value: unknown,
  depth = 0,
  budget: JsonBudget = { nodes: 0, characters: 0 },
): boolean => {
  budget.nodes += 1;
  if (depth > 32 || budget.nodes > 100_000) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    budget.characters += value.length;
    return value.length <= 1_048_576 && budget.characters <= 4_194_304;
  }
  if (Array.isArray(value)) {
    return (
      value.length <= 2_000 &&
      value.every((entry) => isBoundedJsonValue(entry, depth + 1, budget))
    );
  }
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const entries = Object.entries(value);
  if (entries.length > 512) return false;
  return entries.every(([key, entry]) => {
    budget.characters += key.length;
    return (
      key.length >= 1 &&
      key.length <= 256 &&
      budget.characters <= 4_194_304 &&
      isBoundedJsonValue(entry, depth + 1, budget)
    );
  });
};

const jsonContent = (value: VNextGameToolResponseV1) => [
  { type: "text" as const, text: JSON.stringify(value, null, 2) },
];

const validateResponse = (
  toolName: GameToolNameV1,
  toolCallId: string,
  value: unknown,
): VNextGameToolResponseV1 => {
  if (!Check(VNextGameToolResponseV1Schema, value)) {
    throw new TypeError(`Invalid response envelope for ${toolName}`);
  }
  if (value.toolCallId !== toolCallId) {
    throw new TypeError(
      `Response toolCallId for ${toolName} did not match the Pi toolCallId`,
    );
  }
  if (value.outcome === "success") {
    if (!isBoundedJsonValue(value.output)) {
      throw new TypeError(`Invalid JSON output for ${toolName}`);
    }
    if (!Check(GAME_TOOL_OUTPUT_SCHEMAS_V1[toolName], value.output)) {
      throw new TypeError(`Invalid success output for ${toolName}`);
    }
  } else if (
    value.error.details !== undefined &&
    !isBoundedJsonValue(value.error.details)
  ) {
    throw new TypeError(`Invalid JSON error details for ${toolName}`);
  }
  return value;
};

const validateLifecycleResponse = (
  toolName: LifecycleGameToolNameV1,
  toolCallId: string,
  value: unknown,
): VNextGameToolResponseV1 => {
  if (!Check(VNextGameToolResponseV1Schema, value)) {
    throw new TypeError(`Invalid response envelope for ${toolName}`);
  }
  if (value.toolCallId !== toolCallId) {
    throw new TypeError(
      `Response toolCallId for ${toolName} did not match the Pi toolCallId`,
    );
  }
  if (value.outcome === "success") {
    if (!isBoundedJsonValue(value.output)) {
      throw new TypeError(`Invalid JSON output for ${toolName}`);
    }
    if (!Check(LIFECYCLE_GAME_TOOL_OUTPUT_SCHEMAS_V2[toolName], value.output)) {
      throw new TypeError(`Invalid lifecycle success output for ${toolName}`);
    }
  } else if (
    value.error.details !== undefined &&
    !isBoundedJsonValue(value.error.details)
  ) {
    throw new TypeError(`Invalid JSON error details for ${toolName}`);
  }
  return value;
};

/** Bind the SDK-neutral game-tool catalog to one task-scoped runtime port. */
export function createVNextGameToolDefinitions(
  port: VNextGameToolPort,
): readonly ToolDefinition[] {
  return Object.freeze(
    GAME_TOOL_DEFINITIONS_V1.map((metadata) =>
      defineTool({
        name: metadata.name,
        label: metadata.label,
        description: metadata.description,
        parameters: metadata.parameters,
        async execute(toolCallId, input, signal) {
          if (!Check(VNextGameToolCallIdV1Schema, toolCallId)) {
            throw new TypeError(`Invalid Pi toolCallId for ${metadata.name}`);
          }
          if (!Check(metadata.parameters, input)) {
            throw new TypeError(`Invalid input for ${metadata.name}`);
          }
          const response = await port.invoke(
            {
              schemaVersion: 1,
              toolCallId,
              toolName: metadata.name,
              input,
            },
            signal,
          );
          const validated = validateResponse(
            metadata.name,
            toolCallId,
            response,
          );
          return {
            content: jsonContent(validated),
            details: validated,
          };
        },
      }),
    ),
  );
}

/** Bind the additive lifecycle-only catalog without filtering the M3 catalog. */
export function createVNextLifecycleGameToolDefinitions(
  port: VNextLifecycleGameToolPort,
): readonly ToolDefinition[] {
  return Object.freeze(
    LIFECYCLE_GAME_TOOL_DEFINITIONS_V1.map((metadata) =>
      defineTool({
        name: metadata.name,
        label: metadata.label,
        description: metadata.description,
        parameters: metadata.parameters,
        async execute(toolCallId, input, signal) {
          if (!Check(VNextGameToolCallIdV1Schema, toolCallId)) {
            throw new TypeError(`Invalid Pi toolCallId for ${metadata.name}`);
          }
          if (!Check(metadata.parameters, input)) {
            throw new TypeError(`Invalid input for ${metadata.name}`);
          }
          const response = await port.invoke(
            {
              schemaVersion: 1,
              toolCallId,
              toolName: metadata.name,
              input,
            },
            signal,
          );
          const validated = validateLifecycleResponse(
            metadata.name,
            toolCallId,
            response,
          );
          return {
            content: jsonContent(validated),
            details: validated,
          };
        },
      }),
    ),
  );
}
