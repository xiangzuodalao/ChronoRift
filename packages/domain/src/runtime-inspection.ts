import { z } from "zod";

import { Sha256DigestV1Schema } from "./hash.js";
import type { JsonValue } from "./json.js";

const token = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const name = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const text = z.string().max(2_048);
const nodePath = z
  .string()
  .min(1)
  .max(2_048)
  .regex(
    /^(?:\.|[^/.:\\\u0000-\u001f\u007f][^/:\\\u0000-\u001f\u007f]*(?:\/[^/.:\\\u0000-\u001f\u007f][^/:\\\u0000-\u001f\u007f]*)*)$/u,
  );

export const InspectionTargetV1Schema = z.union([
  z.object({ path: nodePath }).strict(),
  z.object({ objectRef: token }).strict(),
]);

export const InspectionLaunchInputV1Schema = z
  .object({ schemaVersion: z.literal(1) })
  .strict();
export type InspectionLaunchInputV1 = z.infer<
  typeof InspectionLaunchInputV1Schema
>;

const queryBase = {
  schemaVersion: z.literal(1),
  executionId: token,
  target: InspectionTargetV1Schema.default({ path: "." }),
};
const pagination = {
  offset: counter.default(0),
  limit: z.number().int().min(1).max(200).default(100),
};
export const InspectionQueryInputV1Schema = z.discriminatedUnion("select", [
  z
    .object({ ...queryBase, select: z.literal("children"), ...pagination })
    .strict(),
  z
    .object({ ...queryBase, select: z.literal("properties"), ...pagination })
    .strict(),
  z
    .object({
      ...queryBase,
      select: z.literal("values"),
      names: z.array(name).min(1).max(32),
    })
    .strict(),
]);
export type InspectionQueryInputV1 = z.infer<
  typeof InspectionQueryInputV1Schema
>;

export const InspectionStopInputV1Schema = z
  .object({ schemaVersion: z.literal(1), executionId: token })
  .strict();
export type InspectionStopInputV1 = z.infer<typeof InspectionStopInputV1Schema>;

export const INSPECTION_INPUT_SCHEMAS_V1 = {
  game_launch: InspectionLaunchInputV1Schema,
  game_query: InspectionQueryInputV1Schema,
  game_stop: InspectionStopInputV1Schema,
} as const;
export type InspectionToolNameV1 = keyof typeof INSPECTION_INPUT_SCHEMAS_V1;

// Pi's TypeBox metadata is derived from these same schemas. The input form keeps
// defaults optional in the advertised schema while parse applies them once.
export const INSPECTION_INPUT_JSON_SCHEMAS_V1 = {
  game_launch: z.toJSONSchema(InspectionLaunchInputV1Schema, { io: "input" }),
  game_query: z.toJSONSchema(InspectionQueryInputV1Schema, { io: "input" }),
  game_stop: z.toJSONSchema(InspectionStopInputV1Schema, { io: "input" }),
} as const;

export const InspectionObjectV1Schema = z
  .object({
    objectRef: token,
    className: name,
    name: name.optional(),
    path: text.optional(),
    scriptPath: text.optional(),
    resourcePath: text.optional(),
    childCount: counter.optional(),
  })
  .strict();
export type InspectionObjectV1 = z.infer<typeof InspectionObjectV1Schema>;

export const INSPECTION_VALUE_LIMITS_V1 = Object.freeze({
  maximumDepth: 32,
  maximumNodes: 4_096,
  maximumContainerEntries: 256,
  maximumStringLength: 16_384,
  maximumKeyLength: 256,
});

const finite = z.number().finite();
const taggedValue = z.discriminatedUnion("$type", [
  z.object({ $type: z.literal("vector2"), x: finite, y: finite }).strict(),
  z
    .object({ $type: z.literal("vector3"), x: finite, y: finite, z: finite })
    .strict(),
  z
    .object({
      $type: z.literal("color"),
      r: finite,
      g: finite,
      b: finite,
      a: finite,
    })
    .strict(),
  z
    .object({
      $type: z.literal("int64"),
      value: z
        .string()
        .regex(/^(?:0|-?[1-9][0-9]*)$/u)
        .refine((value) => {
          if (value.length > 20) return false;
          const integer = BigInt(value);
          return integer >= -(1n << 63n) && integer < 1n << 63n;
        }, "integer must fit signed 64 bits"),
    })
    .strict(),
  z
    .object({
      $type: z.literal("object"),
      objectRef: token,
      className: name,
      resourcePath: text.optional(),
    })
    .strict(),
  z.object({ $type: z.literal("unsupported"), type: name }).strict(),
  z.object({ $type: z.literal("truncated"), reason: name }).strict(),
]);

/** Bounded JSON values with explicit runtime type and reference tags. */
export type InspectionValueV1 = JsonValue;
export const InspectionValueV1Schema: z.ZodType<InspectionValueV1> = z
  .unknown()
  .superRefine((input, context) => {
    let nodes = 0;
    const ancestors = new Set<object>();
    const limits = INSPECTION_VALUE_LIMITS_V1;
    const fail = (message: string): false => {
      context.addIssue({ code: "custom", message });
      return false;
    };
    const visit = (value: unknown, depth: number): boolean => {
      if (++nodes > limits.maximumNodes || depth > limits.maximumDepth)
        return fail("Inspection value exceeds its depth or node budget");
      if (value === null || typeof value === "boolean") return true;
      if (typeof value === "string")
        return (
          value.length <= limits.maximumStringLength ||
          fail("Inspection string exceeds its bound")
        );
      if (typeof value === "number")
        return (
          (Number.isFinite(value) &&
            (!Number.isInteger(value) || Number.isSafeInteger(value))) ||
          fail("Inspection numbers must be finite and safe when integral")
        );
      if (typeof value !== "object")
        return fail("Inspection value must be JSON data");
      if (ancestors.has(value))
        return fail("Inspection values cannot contain cycles");
      ancestors.add(value);
      if (Array.isArray(value)) {
        if (value.length > limits.maximumContainerEntries)
          return fail("Inspection array exceeds its bound");
        for (const child of value) if (!visit(child, depth + 1)) return false;
      } else {
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null)
          return fail("Inspection maps must be plain objects");
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record);
        if (keys.length > limits.maximumContainerEntries)
          return fail("Inspection map exceeds its bound");
        if (
          Object.hasOwn(record, "$type") &&
          !taggedValue.safeParse(record).success
        )
          return fail("Invalid inspection value tag or payload");
        for (const key of keys) {
          if (key.length === 0 || key.length > limits.maximumKeyLength)
            return fail("Inspection map key exceeds its bound");
          if (!visit(record[key], depth + 1)) return false;
        }
      }
      ancestors.delete(value);
      return true;
    };
    visit(input, 0);
  }) as z.ZodType<InspectionValueV1>;

export const InspectionSampleV1Schema = z
  .object({ processFrame: counter, physicsTick: counter })
  .strict();
export const InspectionPropertyV1Schema = z
  .object({ name, type: name })
  .strict();
export const InspectionPropertyValueV1Schema = z.union([
  z
    .object({
      name,
      status: z.literal("success"),
      value: InspectionValueV1Schema,
    })
    .strict(),
  z
    .object({
      name,
      status: z.enum(["missing", "invalid_object", "unsupported", "truncated"]),
      message: z.string().min(1).max(2_048),
    })
    .strict(),
]);

const queryResultBase = {
  schemaVersion: z.literal(1),
  executionId: token,
  sample: InspectionSampleV1Schema,
  target: InspectionObjectV1Schema,
};
const childrenResult = z
  .object({
    ...queryResultBase,
    select: z.literal("children"),
    items: z.array(InspectionObjectV1Schema).max(200),
    offset: counter,
    total: counter,
  })
  .strict();
const propertiesResult = z
  .object({
    ...queryResultBase,
    select: z.literal("properties"),
    items: z.array(InspectionPropertyV1Schema).max(200),
    offset: counter,
    total: counter,
  })
  .strict();
const valuesResult = z
  .object({
    ...queryResultBase,
    select: z.literal("values"),
    values: z.array(InspectionPropertyValueV1Schema).max(32),
  })
  .strict();

export const InspectionQueryResultV1Schema = z.discriminatedUnion("select", [
  childrenResult,
  propertiesResult,
  valuesResult,
]);
export type InspectionQueryResultV1 = z.infer<
  typeof InspectionQueryResultV1Schema
>;
const received = { hostReceivedAt: z.iso.datetime() };
export const InspectionQueryOutputV1Schema = z.discriminatedUnion("select", [
  childrenResult.extend(received),
  propertiesResult.extend(received),
  valuesResult.extend(received),
]);
export type InspectionQueryOutputV1 = z.infer<
  typeof InspectionQueryOutputV1Schema
>;

export const InspectionLaunchOutputV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    executionId: token,
    sourceSha256: Sha256DigestV1Schema,
    mainScene: z.string().min(1).max(2_048),
    engineVersion: z.string().min(1).max(256),
    root: InspectionObjectV1Schema,
  })
  .strict();
export type InspectionLaunchOutputV1 = z.infer<
  typeof InspectionLaunchOutputV1Schema
>;

export const INSPECTION_ERROR_CODES_V1 = [
  "invalid_request",
  "execution_not_found",
  "execution_mismatch",
  "execution_exited",
  "object_not_found",
  "busy",
  "runtime_unavailable",
  "runtime_closed",
  "query_timeout",
  "launch_failed",
  "operation_failed",
  "protocol_error",
  "source_changed",
  "cancelled",
  "budget_exhausted",
] as const;
export const InspectionErrorV1Schema = z
  .object({
    code: z.enum(INSPECTION_ERROR_CODES_V1),
    message: z.string().min(1).max(4_096),
  })
  .strict();
export type InspectionErrorV1 = z.infer<typeof InspectionErrorV1Schema>;

const processResult = z
  .object({
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).max(64).nullable(),
  })
  .strict();
export const InspectionProcessResultV1Schema = processResult.extend({
  timedOut: z.boolean(),
  stdout: z.string().max(128 * 1_024),
  stderr: z.string().max(128 * 1_024),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
});
export type InspectionProcessResultV1 = z.infer<
  typeof InspectionProcessResultV1Schema
>;
export const InspectionRunRecordV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    executionId: token,
    sourceSha256: Sha256DigestV1Schema.nullable(),
    observedSourceSha256: Sha256DigestV1Schema.nullable(),
    sourceUnchanged: z.boolean().nullable(),
    mainScene: z.string().min(1).max(2_048).nullable(),
    engineVersion: z.string().min(1).max(256).nullable(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    status: z.enum(["exited", "timed_out", "cancelled", "failed"]),
    ...processResult.shape,
    import: InspectionProcessResultV1Schema.nullable(),
    run: InspectionProcessResultV1Schema.nullable(),
    stderr: z.string().max(128 * 1_024),
    stderrTruncated: z.boolean(),
    error: InspectionErrorV1Schema.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.sourceUnchanged === null ||
      (value.observedSourceSha256 !== null &&
        value.sourceUnchanged ===
          (value.sourceSha256 === value.observedSourceSha256)),
    {
      path: ["sourceUnchanged"],
      message: "Source integrity must reflect the observed source hash",
    },
  );
export type InspectionRunRecordV1 = z.infer<typeof InspectionRunRecordV1Schema>;

export const InspectionStopOutputV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    executionId: token,
    recordPath: z.string().min(1).max(4_096),
    record: InspectionRunRecordV1Schema,
  })
  .strict()
  .refine((value) => value.executionId === value.record.executionId, {
    path: ["executionId"],
    message: "Stop output must identify its run record",
  });
export type InspectionStopOutputV1 = z.infer<
  typeof InspectionStopOutputV1Schema
>;

export const INSPECTION_OUTPUT_SCHEMAS_V1 = {
  game_launch: InspectionLaunchOutputV1Schema,
  game_query: InspectionQueryOutputV1Schema,
  game_stop: InspectionStopOutputV1Schema,
} as const;
export const InspectionToolErrorV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    outcome: z.literal("error"),
    error: InspectionErrorV1Schema,
  })
  .strict();
export const InspectionToolResponseV1Schema = z.union([
  z
    .object({
      schemaVersion: z.literal(1),
      outcome: z.literal("success"),
      output: z.union([
        InspectionLaunchOutputV1Schema,
        InspectionQueryOutputV1Schema,
        InspectionStopOutputV1Schema,
      ]),
    })
    .strict(),
  InspectionToolErrorV1Schema,
]);
export type InspectionToolResponseV1 = z.infer<
  typeof InspectionToolResponseV1Schema
>;
