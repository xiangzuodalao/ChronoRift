import {
  InspectionObjectV1Schema,
  InspectionLaunchOutputV1Schema,
  InspectionProcessResultV1Schema,
  InspectionQueryInputV1Schema,
  InspectionQueryResultV1Schema,
} from "@chronorift/domain";
import { z } from "zod";

export const GODOT_INSPECTION_PROTOCOL_V1 = "chronorift-godot-inspection-v1";
const Text = z.string().max(4096);
const Id = z.string().min(1).max(256);
export const GodotInspectionReadyV1Schema = z
  .object({
    executionId: InspectionLaunchOutputV1Schema.shape.executionId,
    engineVersion: InspectionLaunchOutputV1Schema.shape.engineVersion,
    scene: InspectionLaunchOutputV1Schema.shape.mainScene,
    root: InspectionObjectV1Schema,
  })
  .strict();
export const GodotInspectionProcessV1Schema = InspectionProcessResultV1Schema;
export const GodotInspectionTerminatedV1Schema = z
  .object({
    import: GodotInspectionProcessV1Schema.nullable(),
    run: GodotInspectionProcessV1Schema.nullable(),
  })
  .strict();
const base = {
  schemaVersion: z.literal(1),
  profile: z.literal(GODOT_INSPECTION_PROTOCOL_V1),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
export const GodotInspectionMessageV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("ready"),
      payload: GodotInspectionReadyV1Schema,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("query"),
      requestId: Id,
      payload: InspectionQueryInputV1Schema,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("query_result"),
      requestId: Id,
      payload: InspectionQueryResultV1Schema,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("stop"),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("terminated"),
      payload: GodotInspectionTerminatedV1Schema,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("error"),
      requestId: Id.optional(),
      payload: z.object({ code: Id, message: Text }).strict(),
    })
    .strict(),
]);
export type GodotInspectionMessageV1 = z.infer<
  typeof GodotInspectionMessageV1Schema
>;
export type GodotInspectionReadyV1 = z.infer<
  typeof GodotInspectionReadyV1Schema
>;
export type GodotInspectionProcessV1 = z.infer<
  typeof GodotInspectionProcessV1Schema
>;
export type GodotInspectionTerminatedV1 = z.infer<
  typeof GodotInspectionTerminatedV1Schema
>;

export const parseGodotInspectionMessageV1 = (
  json: string,
): GodotInspectionMessageV1 =>
  GodotInspectionMessageV1Schema.parse(JSON.parse(json));
