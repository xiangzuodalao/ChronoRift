import { z } from "zod";

import {
  PROJECT_ADAPTER_INTRINSIC_REFERENCES_V1,
  ProjectAdapterStableIdV1Schema,
} from "./project-environment-values.js";

export type ProjectAdapterValueV2 =
  | null
  | boolean
  | number
  | string
  | readonly ProjectAdapterValueV2[]
  | { readonly [key: string]: ProjectAdapterValueV2 };

const isPlainRecord = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

export const parseProjectAdapterValueV2 = (
  input: unknown,
): ProjectAdapterValueV2 => {
  const active = new WeakSet<object>();
  let nodes = 0;
  const visit = (
    value: unknown,
    path: string,
    depth: number,
  ): ProjectAdapterValueV2 => {
    nodes += 1;
    if (nodes > 4_096)
      throw new TypeError(`${path}: value node budget exceeded`);
    if (depth > 16) throw new TypeError(`${path}: value depth exceeded`);
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string"
    )
      return value;
    if (typeof value === "number") {
      if (
        !Number.isFinite(value) ||
        Object.is(value, -0) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))
      ) {
        throw new TypeError(`${path}: number is not canonical`);
      }
      return value;
    }
    if (
      typeof value !== "object" ||
      (!isPlainRecord(value) && !Array.isArray(value))
    ) {
      throw new TypeError(`${path}: value is not canonical JSON`);
    }
    if (active.has(value)) throw new TypeError(`${path}: cyclic value`);
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 512)
          throw new TypeError(`${path}: array item budget exceeded`);
        return value.map((child, index) =>
          visit(child, `${path}[${index}]`, depth + 1),
        );
      }
      const entries = Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right, "en-US"),
      );
      if (entries.length > 256)
        throw new TypeError(`${path}: object property budget exceeded`);
      return Object.fromEntries(
        entries.map(([key, child]) => {
          if (
            !/^[A-Za-z_$][A-Za-z0-9_$.-]{0,127}$/u.test(key) ||
            ["__proto__", "prototype", "constructor"].includes(key)
          ) {
            throw new TypeError(`${path}: object key is not allowed`);
          }
          return [key, visit(child, `${path}.${key}`, depth + 1)];
        }),
      );
    } finally {
      active.delete(value);
    }
  };
  const parsed = visit(input, "$", 0);
  if (
    new TextEncoder().encode(JSON.stringify(parsed)).byteLength >
    1_024 * 1_024
  ) {
    throw new TypeError("$: encoded value byte budget exceeded");
  }
  return parsed;
};

export const ProjectAdapterValueV2Schema: z.ZodType<ProjectAdapterValueV2> = z
  .unknown()
  .transform((value, context) => {
    try {
      return parseProjectAdapterValueV2(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "invalid V2 adapter value",
      });
      return z.NEVER;
    }
  });

export const PROJECT_ADAPTER_SCHEMA_DIALECT_V2 =
  "chronorift://schemas/project-adapter-payload/v2" as const;
export const PROJECT_ADAPTER_ENTITY_REFERENCE_V2 =
  "chronorift://intrinsic/entity-ref/v2" as const;

const opaqueId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !value.includes(".."), "resource IDs cannot traverse");

export const ProjectAdapterEntityRefV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    executionId: opaqueId,
    entityId: opaqueId,
    incarnation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type ProjectAdapterEntityRefV2 = z.infer<
  typeof ProjectAdapterEntityRefV2Schema
>;

export const PROJECT_ADAPTER_INTRINSIC_REFERENCES_V2 = Object.freeze([
  ...PROJECT_ADAPTER_INTRINSIC_REFERENCES_V1.filter(
    (reference) => reference !== "chronorift://intrinsic/entity-ref/v1",
  ),
  PROJECT_ADAPTER_ENTITY_REFERENCE_V2,
] as const);

export type ProjectAdapterIntrinsicReferenceV2 =
  (typeof PROJECT_ADAPTER_INTRINSIC_REFERENCES_V2)[number];

interface NullSchemaNodeV2 {
  readonly type: "null";
  readonly const?: null | undefined;
}
interface BooleanSchemaNodeV2 {
  readonly type: "boolean";
  readonly const?: boolean | undefined;
  readonly enum?: readonly boolean[] | undefined;
}
interface NumberSchemaNodeV2 {
  readonly type: "integer" | "number";
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
  readonly const?: number | undefined;
  readonly enum?: readonly number[] | undefined;
}
interface StringSchemaNodeV2 {
  readonly type: "string";
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly const?: string | undefined;
  readonly enum?: readonly string[] | undefined;
}
interface ArraySchemaNodeV2 {
  readonly type: "array";
  readonly items: ProjectAdapterPayloadSchemaNodeV2;
  readonly minItems?: number | undefined;
  readonly maxItems: number;
}
interface ObjectSchemaNodeV2 {
  readonly type: "object";
  readonly properties: Readonly<
    Record<string, ProjectAdapterPayloadSchemaNodeV2>
  >;
  readonly required: readonly string[];
  readonly additionalProperties: false;
  readonly minProperties?: number | undefined;
  readonly maxProperties?: number | undefined;
}
interface ReferenceSchemaNodeV2 {
  readonly $ref: ProjectAdapterIntrinsicReferenceV2;
}

export type ProjectAdapterPayloadSchemaNodeV2 =
  | NullSchemaNodeV2
  | BooleanSchemaNodeV2
  | NumberSchemaNodeV2
  | StringSchemaNodeV2
  | ArraySchemaNodeV2
  | ObjectSchemaNodeV2
  | ReferenceSchemaNodeV2;

const finiteCanonicalNumber = z
  .number()
  .finite()
  .refine((value) => !Object.is(value, -0), "negative zero is not canonical");
const bound = z.number().int().nonnegative().max(512);

const nodeSchema: z.ZodType<ProjectAdapterPayloadSchemaNodeV2> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("null"), const: z.null().optional() }).strict(),
    z
      .object({
        type: z.literal("boolean"),
        const: z.boolean().optional(),
        enum: z.array(z.boolean()).min(1).max(2).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("integer"),
        minimum: z.number().int().safe().optional(),
        maximum: z.number().int().safe().optional(),
        const: z.number().int().safe().optional(),
        enum: z.array(z.number().int().safe()).min(1).max(128).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("number"),
        minimum: finiteCanonicalNumber.optional(),
        maximum: finiteCanonicalNumber.optional(),
        const: finiteCanonicalNumber.optional(),
        enum: z.array(finiteCanonicalNumber).min(1).max(128).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("string"),
        minLength: z.number().int().nonnegative().max(16_384).optional(),
        maxLength: z.number().int().nonnegative().max(16_384).optional(),
        const: z.string().max(16_384).optional(),
        enum: z.array(z.string().max(16_384)).min(1).max(128).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("array"),
        items: nodeSchema,
        minItems: bound.optional(),
        maxItems: bound,
      })
      .strict(),
    z
      .object({
        type: z.literal("object"),
        properties: z.record(ProjectAdapterStableIdV1Schema, nodeSchema),
        required: z.array(ProjectAdapterStableIdV1Schema).max(256),
        additionalProperties: z.literal(false),
        minProperties: z.number().int().nonnegative().max(256).optional(),
        maxProperties: z.number().int().nonnegative().max(256).optional(),
      })
      .strict(),
    z
      .object({ $ref: z.enum(PROJECT_ADAPTER_INTRINSIC_REFERENCES_V2) })
      .strict(),
  ]),
);

export const ProjectAdapterPayloadSchemaNodeV2Schema = nodeSchema;

export const ProjectAdapterPayloadSchemaDocumentV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    dialect: z.literal(PROJECT_ADAPTER_SCHEMA_DIALECT_V2),
    schemaId: ProjectAdapterStableIdV1Schema,
    root: ProjectAdapterPayloadSchemaNodeV2Schema,
  })
  .strict();
export type ProjectAdapterPayloadSchemaDocumentV2 = z.infer<
  typeof ProjectAdapterPayloadSchemaDocumentV2Schema
>;

const fail = (path: string, message: string): never => {
  throw new TypeError(`${path}: ${message}`);
};

const validateIntrinsic = (
  reference: ProjectAdapterIntrinsicReferenceV2,
  value: ProjectAdapterValueV2,
  path: string,
): void => {
  if (reference === PROJECT_ADAPTER_ENTITY_REFERENCE_V2) {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      return fail(path, "expected intrinsic entity-ref/v2");
    }
    const record = value as Readonly<Record<string, ProjectAdapterValueV2>>;
    const keys = Object.keys(record).sort();
    if (
      JSON.stringify(keys) !==
        JSON.stringify(
          [
            "$type",
            "entityId",
            "executionId",
            "incarnation",
            "schemaVersion",
          ].sort(),
        ) ||
      record.$type !== "entity_ref"
    ) {
      return fail(path, "expected intrinsic entity-ref/v2");
    }
    ProjectAdapterEntityRefV2Schema.parse({
      schemaVersion: record.schemaVersion,
      executionId: record.executionId,
      entityId: record.entityId,
      incarnation: record.incarnation,
    });
    return;
  }
  // V2 preserves the non-entity V1 intrinsic representations.
  const name = reference.split("/").at(-2);
  if (name === "resource-ref") {
    const record = value as Readonly<Record<string, ProjectAdapterValueV2>>;
    if (
      value === null ||
      Array.isArray(value) ||
      typeof value !== "object" ||
      record.$type !== "resource_ref" ||
      typeof record.resourceId !== "string"
    ) {
      return fail(path, "expected intrinsic resource_ref");
    }
    return;
  }
  const lengths: Readonly<Record<string, number>> = {
    vector2: 2,
    vector3: 3,
    vector4: 4,
    quaternion: 4,
    color: 4,
    rect2: 4,
    basis: 9,
    transform2d: 6,
    transform3d: 12,
  };
  const length = lengths[name ?? ""];
  const record = value as Readonly<Record<string, ProjectAdapterValueV2>>;
  if (
    length === undefined ||
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    record.$type !== name ||
    !Array.isArray(record.values) ||
    record.values.length !== length ||
    record.values.some(
      (entry) => typeof entry !== "number" || !Number.isFinite(entry),
    )
  ) {
    return fail(path, `expected intrinsic ${name ?? "unknown"}`);
  }
};

const validateNode = (
  node: ProjectAdapterPayloadSchemaNodeV2,
  value: ProjectAdapterValueV2,
  path: string,
): void => {
  if ("$ref" in node) return validateIntrinsic(node.$ref, value, path);
  if (node.type === "null") {
    if (value !== null) fail(path, "expected null");
    return;
  }
  if (node.type === "boolean") {
    if (typeof value !== "boolean") fail(path, "expected boolean");
  } else if (node.type === "integer" || node.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      return fail(path, "expected number");
    if (node.type === "integer" && !Number.isSafeInteger(value))
      fail(path, "expected safe integer");
    if (node.minimum !== undefined && value < node.minimum)
      fail(path, "number is below minimum");
    if (node.maximum !== undefined && value > node.maximum)
      fail(path, "number exceeds maximum");
  } else if (node.type === "string") {
    if (typeof value !== "string") return fail(path, "expected string");
    if (node.minLength !== undefined && [...value].length < node.minLength)
      fail(path, "string is shorter than minLength");
    if (node.maxLength !== undefined && [...value].length > node.maxLength)
      fail(path, "string exceeds maxLength");
  } else if (node.type === "array") {
    if (!Array.isArray(value)) return fail(path, "expected array");
    if (node.minItems !== undefined && value.length < node.minItems)
      fail(path, "array is shorter than minItems");
    if (value.length > node.maxItems) fail(path, "array exceeds maxItems");
    value.forEach((child, index) =>
      validateNode(
        node.items,
        child as ProjectAdapterValueV2,
        `${path}[${index}]`,
      ),
    );
    return;
  } else if (node.type === "object") {
    if (value === null || Array.isArray(value) || typeof value !== "object")
      return fail(path, "expected object");
    const record = value as Readonly<Record<string, ProjectAdapterValueV2>>;
    for (const required of node.required) {
      if (!Object.hasOwn(record, required))
        fail(path, `missing required field ${required}`);
    }
    for (const [key, child] of Object.entries(record)) {
      const childSchema = node.properties[key];
      if (childSchema === undefined)
        return fail(`${path}.${key}`, "additional property is not allowed");
      validateNode(childSchema, child, `${path}.${key}`);
    }
    return;
  } else {
    return fail(path, "unsupported payload schema node");
  }
  if ("const" in node && node.const !== undefined && value !== node.const)
    fail(path, "value does not match const");
  if (
    "enum" in node &&
    node.enum !== undefined &&
    !node.enum.includes(value as never)
  )
    fail(path, "value is not in enum");
};

export const parseProjectAdapterPayloadSchemaV2 = (
  input: unknown,
): ProjectAdapterPayloadSchemaDocumentV2 =>
  ProjectAdapterPayloadSchemaDocumentV2Schema.parse(input);

export const validateProjectAdapterPayloadV2 = (
  schemaInput: unknown,
  payloadInput: unknown,
): ProjectAdapterValueV2 => {
  const schema = parseProjectAdapterPayloadSchemaV2(schemaInput);
  const value = parseProjectAdapterValueV2(payloadInput);
  validateNode(schema.root, value, "$payload");
  return value;
};
