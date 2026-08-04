import { z } from "zod";

export type JsonPrimitive = boolean | number | string | null;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export const JsonPrimitiveSchema: z.ZodType<JsonPrimitive> = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    JsonPrimitiveSchema,
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  JsonValueSchema,
);
