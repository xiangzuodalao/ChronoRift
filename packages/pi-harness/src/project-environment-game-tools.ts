import {
  PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1,
  ProjectEnvironmentCanonicalAdapterValueV1Schema,
  ProjectEnvironmentGameQueryInputV1Schema,
  validateProjectEnvironmentGameToolInputV1,
  validateProjectEnvironmentGameToolOutputV1,
  type ProjectEnvironmentGameToolNameV1,
} from "@chronorift/agent-protocol";
import {
  CanonicalAdapterValueV1Schema,
  ProjectCapabilitySetV1Schema,
  type ProjectCapabilityModuleNameV1,
  type ProjectCapabilitySetV1,
  type ProjectCapabilityStateV1,
} from "@chronorift/domain";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import type { ProjectEnvironmentToolCallAdmissionV1 } from "./project-environment-tool-call-budget.js";

const strictObject = { additionalProperties: false } as const;

export const PROJECT_ENVIRONMENT_GAME_TOOL_ERROR_CODES_V1 = [
  "unsupported_capability",
  "invalid_request",
  "resource_not_found",
  "resource_task_mismatch",
  "permission_denied",
  "busy",
  "conflict",
  "budget_exhausted",
  "adapter_incompatible",
  "runtime_crashed",
  "runtime_unavailable",
  "history_window_unavailable",
  "checkpoint_incompatible",
  "restore_gap",
  "trace_unavailable",
  "comparison_confounded",
  "operation_failed",
] as const;
export type ProjectEnvironmentGameToolErrorCodeV1 =
  (typeof PROJECT_ENVIRONMENT_GAME_TOOL_ERROR_CODES_V1)[number];

const toolCallIdSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
});
const errorCodeSchema = Type.Union(
  PROJECT_ENVIRONMENT_GAME_TOOL_ERROR_CODES_V1.map((code) =>
    Type.Literal(code),
  ),
);

export const ProjectEnvironmentGameToolErrorV1Schema = Type.Object(
  {
    code: errorCodeSchema,
    message: Type.String({ minLength: 1, maxLength: 4_096 }),
    recoverable: Type.Boolean(),
    details: Type.Optional(ProjectEnvironmentCanonicalAdapterValueV1Schema),
  },
  strictObject,
);
export type ProjectEnvironmentGameToolErrorV1 = Static<
  typeof ProjectEnvironmentGameToolErrorV1Schema
>;

export const ProjectEnvironmentGameToolSuccessEnvelopeV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    toolCallId: toolCallIdSchema,
    outcome: Type.Literal("success"),
    output: ProjectEnvironmentCanonicalAdapterValueV1Schema,
  },
  strictObject,
);
export type ProjectEnvironmentGameToolSuccessEnvelopeV1 = Static<
  typeof ProjectEnvironmentGameToolSuccessEnvelopeV1Schema
>;

export const ProjectEnvironmentGameToolErrorEnvelopeV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    toolCallId: toolCallIdSchema,
    outcome: Type.Literal("error"),
    error: ProjectEnvironmentGameToolErrorV1Schema,
  },
  strictObject,
);
export type ProjectEnvironmentGameToolErrorEnvelopeV1 = Static<
  typeof ProjectEnvironmentGameToolErrorEnvelopeV1Schema
>;

export const ProjectEnvironmentGameToolResponseV1Schema = Type.Union([
  ProjectEnvironmentGameToolSuccessEnvelopeV1Schema,
  ProjectEnvironmentGameToolErrorEnvelopeV1Schema,
]);
export type ProjectEnvironmentGameToolResponseV1 = Static<
  typeof ProjectEnvironmentGameToolResponseV1Schema
>;

export interface ProjectEnvironmentGameToolPortRequestV1 {
  readonly schemaVersion: 1;
  readonly toolCallId: string;
  readonly toolName: ProjectEnvironmentGameToolNameV1;
  readonly input: unknown;
}

export interface ProjectEnvironmentGameToolPort {
  invoke(
    request: ProjectEnvironmentGameToolPortRequestV1,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export type ProjectEnvironmentGameQueryInputProfileV1 =
  "canonical-v1" | "pe-a-v1-narrow";

export interface ProjectEnvironmentGameToolDefinitionsOptionsV1 {
  readonly toolCallAdmission?:
    ProjectEnvironmentToolCallAdmissionV1 | undefined;
  /**
   * Restricts the Pi-visible tool surface. Names are validated and duplicate
   * entries collapse; definitions retain the canonical catalog order.
   */
  readonly includedToolNames?:
    readonly ProjectEnvironmentGameToolNameV1[] | undefined;
  /**
   * Selects the Pi-visible game_query input surface. The canonical profile is
   * the default. PE-A V1 callers that do not implement filters or cursors may
   * explicitly expose the narrower query contract instead.
   */
  readonly queryInputProfile?:
    ProjectEnvironmentGameQueryInputProfileV1 | undefined;
}

const responseContent = (value: ProjectEnvironmentGameToolResponseV1) => [
  { type: "text" as const, text: JSON.stringify(value, null, 2) },
];

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const validateResponse = (
  toolName: ProjectEnvironmentGameToolNameV1,
  toolCallId: string,
  value: unknown,
): ProjectEnvironmentGameToolResponseV1 => {
  const record = asRecord(value);
  if (record === null || record.toolCallId !== toolCallId) {
    throw new TypeError(
      `Response toolCallId for ${toolName} did not match the Pi toolCallId`,
    );
  }
  if (record.outcome === "success") {
    if (!validateProjectEnvironmentGameToolOutputV1(toolName, record.output)) {
      throw new TypeError(
        `Invalid Project Environment success output for ${toolName}`,
      );
    }
  } else if (record.outcome === "error") {
    const error = asRecord(record.error);
    if (
      error !== null &&
      error.details !== undefined &&
      !CanonicalAdapterValueV1Schema.safeParse(error.details).success
    ) {
      throw new TypeError(
        `Invalid Project Environment error details for ${toolName}`,
      );
    }
  }
  if (!Check(ProjectEnvironmentGameToolResponseV1Schema, value)) {
    throw new TypeError(`Invalid Project Environment response for ${toolName}`);
  }
  return value;
};

const blocksInvocation = (state: ProjectCapabilityStateV1): boolean =>
  state.status !== "implemented" && state.status !== "degraded";

const PROJECT_ENVIRONMENT_GAME_TOOL_PROMPT_GUIDELINE =
  "Use game tools to test source-derived hypotheses against runtime observations when conclusions depend on realized geometry, physics, timing, entity or resource identity, runtime state, or history.";

const ProjectEnvironmentGameQueryPeAV1NarrowInputSchema = Type.Object(
  {
    schemaVersion:
      ProjectEnvironmentGameQueryInputV1Schema.properties.schemaVersion,
    taskId: ProjectEnvironmentGameQueryInputV1Schema.properties.taskId,
    executionId:
      ProjectEnvironmentGameQueryInputV1Schema.properties.executionId,
    select: ProjectEnvironmentGameQueryInputV1Schema.properties.select,
    limit: ProjectEnvironmentGameQueryInputV1Schema.properties.limit,
  },
  strictObject,
);

const selectToolParameters = (
  toolName: ProjectEnvironmentGameToolNameV1,
  canonicalParameters: (typeof PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1)[number]["parameters"],
  queryInputProfile: ProjectEnvironmentGameQueryInputProfileV1,
) =>
  toolName === "game_query" && queryInputProfile === "pe-a-v1-narrow"
    ? ProjectEnvironmentGameQueryPeAV1NarrowInputSchema
    : canonicalParameters;

const validateQueryInputProfile = (
  value: unknown,
): ProjectEnvironmentGameQueryInputProfileV1 => {
  const profile = value ?? "canonical-v1";
  if (profile !== "canonical-v1" && profile !== "pe-a-v1-narrow") {
    throw new TypeError("Unknown game_query input profile");
  }
  return profile;
};

const selectToolDefinitions = (includedToolNames: unknown) => {
  if (includedToolNames === undefined) {
    return PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1;
  }
  if (!Array.isArray(includedToolNames)) {
    throw new TypeError("includedToolNames must be an array");
  }
  if (includedToolNames.length === 0) {
    throw new TypeError("includedToolNames must not be empty");
  }
  const knownNames = new Set<string>(
    PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.map(({ name }) => name),
  );
  const includedNames = new Set<ProjectEnvironmentGameToolNameV1>();
  for (const name of includedToolNames) {
    if (typeof name !== "string" || !knownNames.has(name)) {
      throw new TypeError(
        `Unknown Project Environment game tool: ${String(name)}`,
      );
    }
    includedNames.add(name as ProjectEnvironmentGameToolNameV1);
  }
  return PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.filter(({ name }) =>
    includedNames.has(name),
  );
};

export const projectEnvironmentUnsupportedCapabilityResponseV1 = (
  toolCallId: string,
  module: ProjectCapabilityModuleNameV1,
  state: ProjectCapabilityStateV1,
): ProjectEnvironmentGameToolErrorEnvelopeV1 => {
  if (!Check(toolCallIdSchema, toolCallId)) {
    throw new TypeError("Invalid Pi toolCallId for unsupported capability");
  }
  if (state.module !== module || !blocksInvocation(state)) {
    throw new TypeError(
      "Unsupported capability response requires the matching unavailable module",
    );
  }
  const response = {
    schemaVersion: 1,
    toolCallId,
    outcome: "error",
    error: {
      code: "unsupported_capability",
      message: `${module} is ${state.status} for this Project Environment binding`,
      recoverable: state.status !== "unsupported",
      details: {
        schemaVersion: 1,
        module,
        status: state.status,
        limitations: state.limitations,
      },
    },
  } as const;
  if (!Check(ProjectEnvironmentGameToolErrorEnvelopeV1Schema, response)) {
    throw new TypeError("Failed to construct unsupported capability response");
  }
  return response;
};

const projectEnvironmentBudgetExhaustedResponseV1 = (
  toolCallId: string,
  limit: number,
): ProjectEnvironmentGameToolErrorEnvelopeV1 => {
  const response = {
    schemaVersion: 1,
    toolCallId,
    outcome: "error",
    error: {
      code: "budget_exhausted",
      message: `Project Environment turn tool-call budget exhausted after ${limit} admitted call(s)`,
      recoverable: false,
    },
  } as const;
  if (!Check(ProjectEnvironmentGameToolErrorEnvelopeV1Schema, response)) {
    throw new TypeError("Failed to construct budget-exhausted response");
  }
  return response;
};

/**
 * Bind all 16 PE-A tools by default. A caller may select a strict subset for a
 * narrower Agent surface. Optional module absence produces a structured tool
 * result at execution time.
 */
export function createProjectEnvironmentGameToolDefinitions(
  port: ProjectEnvironmentGameToolPort,
  untrustedCapabilitySet: ProjectCapabilitySetV1,
  options: ProjectEnvironmentGameToolDefinitionsOptionsV1 = {},
): readonly ToolDefinition[] {
  const capabilitySet = ProjectCapabilitySetV1Schema.parse(
    untrustedCapabilitySet,
  );
  const moduleStates = new Map(
    capabilitySet.modules.map((state) => [state.module, state]),
  );
  const queryInputProfile = validateQueryInputProfile(
    options.queryInputProfile,
  );
  const definitions = selectToolDefinitions(options.includedToolNames);
  return Object.freeze(
    definitions.map((metadata) => {
      const parameters = selectToolParameters(
        metadata.name,
        metadata.parameters,
        queryInputProfile,
      );
      return defineTool({
        name: metadata.name,
        label: metadata.label,
        description: metadata.description,
        promptSnippet: metadata.description,
        promptGuidelines: [PROJECT_ENVIRONMENT_GAME_TOOL_PROMPT_GUIDELINE],
        parameters,
        async execute(toolCallId, input, signal) {
          if (!Check(toolCallIdSchema, toolCallId)) {
            throw new TypeError(`Invalid Pi toolCallId for ${metadata.name}`);
          }
          const admission = options.toolCallAdmission;
          if (admission !== undefined && !admission.tryAdmit(metadata.name)) {
            const response = projectEnvironmentBudgetExhaustedResponseV1(
              toolCallId,
              admission.limit,
            );
            return { content: responseContent(response), details: response };
          }
          if (
            !Check(parameters, input) ||
            !validateProjectEnvironmentGameToolInputV1(metadata.name, input)
          ) {
            throw new TypeError(`Invalid input for ${metadata.name}`);
          }
          if (metadata.availabilityModule !== null) {
            const module = moduleStates.get(metadata.availabilityModule);
            if (module === undefined) {
              throw new TypeError(
                `Capability set omitted ${metadata.availabilityModule}`,
              );
            }
            if (blocksInvocation(module)) {
              const response =
                projectEnvironmentUnsupportedCapabilityResponseV1(
                  toolCallId,
                  metadata.availabilityModule,
                  module,
                );
              return { content: responseContent(response), details: response };
            }
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
            content: responseContent(validated),
            details: validated,
          };
        },
      });
    }),
  );
}
