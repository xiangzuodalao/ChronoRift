import {
  INSPECTION_INPUT_JSON_SCHEMAS_V1,
  INSPECTION_INPUT_SCHEMAS_V1,
  INSPECTION_OUTPUT_SCHEMAS_V1,
  type InspectionToolNameV1,
} from "@chronorift/domain";
import { Type, type TSchema } from "typebox";

export interface InspectionGameToolMetadataV1 {
  readonly name: InspectionToolNameV1;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
}

export const INSPECTION_GAME_TOOL_DEFINITIONS_V1: readonly InspectionGameToolMetadataV1[] =
  Object.freeze([
    {
      name: "game_launch",
      label: "Launch game inspection",
      description:
        "Import and launch the current candidate's default main scene in an isolated, headless Godot execution. Returns the actual source identity and scene root. One execution may run at a time; candidate edits apply on the next launch.",
      parameters: Type.Unsafe(INSPECTION_INPUT_JSON_SCHEMAS_V1.game_launch),
    },
    {
      name: "game_query",
      label: "Inspect game objects",
      description:
        "Read current children, property descriptions, or named property values from a live execution. The target is a scene-relative path or an execution-local objectRef; omitted target means the main scene. Children and properties support offset/limit pagination (default 100, maximum 200); values takes 1–32 exact property names. Object and resource values preserve identity as objectRef for further queries. Reports actual sampling clocks and per-property failures. Queries are not atomic snapshots; project getters may have side effects. No history, expressions, or method calls are supported.",
      parameters: Type.Unsafe({
        type: "object",
        ...INSPECTION_INPUT_JSON_SCHEMAS_V1.game_query,
      }),
    },
    {
      name: "game_stop",
      label: "Stop game inspection",
      description:
        "Stop the identified execution and retain its actual process results, bounded logs, and source integrity result. Repeated stop returns the saved result.",
      parameters: Type.Unsafe(INSPECTION_INPUT_JSON_SCHEMAS_V1.game_stop),
    },
  ]);

export const validateInspectionGameToolInputV1 = (
  name: InspectionToolNameV1,
  input: unknown,
): boolean => INSPECTION_INPUT_SCHEMAS_V1[name].safeParse(input).success;
export const validateInspectionGameToolOutputV1 = (
  name: InspectionToolNameV1,
  output: unknown,
): boolean => INSPECTION_OUTPUT_SCHEMAS_V1[name].safeParse(output).success;
