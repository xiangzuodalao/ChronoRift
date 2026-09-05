import { INSPECTION_GAME_TOOL_DEFINITIONS_V1 } from "@chronorift/agent-protocol";
import {
  INSPECTION_INPUT_SCHEMAS_V1,
  INSPECTION_OUTPUT_SCHEMAS_V1,
  InspectionToolResponseV1Schema,
  type InspectionToolNameV1,
  type InspectionToolResponseV1,
} from "@chronorift/domain";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  ProjectEnvironmentToolCallBudgetExhaustedErrorV1,
  type ProjectEnvironmentToolCallAdmissionV1,
} from "./project-environment-tool-call-budget.js";

export interface InspectionGameToolPortRequestV1 {
  readonly schemaVersion: 1;
  readonly toolCallId: string;
  readonly toolName: InspectionToolNameV1;
  readonly input: unknown;
}

export interface InspectionGameToolPort {
  invoke(
    request: InspectionGameToolPortRequestV1,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface InspectionGameToolDefinitionsOptionsV1 {
  readonly toolCallAdmission?:
    ProjectEnvironmentToolCallAdmissionV1 | undefined;
}

/** Thin binding: the Host port owns execution and the Agent chooses its workflow. */
export function createInspectionGameToolDefinitions(
  port: InspectionGameToolPort,
  options: InspectionGameToolDefinitionsOptionsV1 = {},
): readonly ToolDefinition[] {
  return Object.freeze(
    INSPECTION_GAME_TOOL_DEFINITIONS_V1.map((metadata) =>
      defineTool({
        ...metadata,
        promptSnippet: metadata.description,
        executionMode: "sequential",
        async execute(toolCallId, input, signal) {
          const normalizedInput =
            INSPECTION_INPUT_SCHEMAS_V1[metadata.name].parse(input);
          if (
            options.toolCallAdmission !== undefined &&
            !options.toolCallAdmission.tryAdmit(metadata.name)
          ) {
            throw new ProjectEnvironmentToolCallBudgetExhaustedErrorV1(
              options.toolCallAdmission.limit,
            );
          }
          const response: InspectionToolResponseV1 =
            InspectionToolResponseV1Schema.parse(
              await port.invoke(
                {
                  schemaVersion: 1,
                  toolCallId,
                  toolName: metadata.name,
                  input: normalizedInput,
                },
                signal,
              ),
            );
          if (response.outcome === "success") {
            INSPECTION_OUTPUT_SCHEMAS_V1[metadata.name].parse(response.output);
            if (
              "executionId" in normalizedInput &&
              response.output.executionId !== normalizedInput.executionId
            ) {
              throw new TypeError(
                "Inspection response belongs to a different execution",
              );
            }
            if (
              metadata.name === "game_query" &&
              "select" in normalizedInput &&
              "select" in response.output &&
              response.output.select !== normalizedInput.select
            ) {
              throw new TypeError(
                "Inspection response did not match its query",
              );
            }
            if (
              metadata.name === "game_watch" &&
              "action" in normalizedInput &&
              "action" in response.output &&
              (response.output.action !== normalizedInput.action ||
                ("watchId" in normalizedInput &&
                  response.output.watchId !== normalizedInput.watchId))
            ) {
              throw new TypeError(
                "Inspection response did not match its watch request",
              );
            }
          }
          return {
            content: [
              { type: "text", text: JSON.stringify(response, null, 2) },
            ],
            details: response,
          };
        },
      }),
    ),
  );
}
