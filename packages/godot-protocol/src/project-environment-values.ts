import {
  CanonicalAdapterValueV1Schema,
  ProjectEntityIdSchema,
  ProjectResourceIdSchema,
  type CanonicalAdapterValueV1,
} from "@chronorift/domain";
import { z } from "zod";

export const PROJECT_ADAPTER_SCHEMA_DIALECT_V1 =
  "chronorift://schemas/project-adapter-payload/v1" as const;

export const PROJECT_ADAPTER_VALUE_LIMITS_V1 = Object.freeze({
  maxDepth: 16,
  maxNodes: 4_096,
  maxStringBytes: 16 * 1_024,
  maxArrayItems: 512,
  maxObjectProperties: 256,
  maxEncodedBytes: 1_024 * 1_024,
});

export interface ProjectAdapterValueLimitsV1 {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxStringBytes: number;
  readonly maxArrayItems: number;
  readonly maxObjectProperties: number;
  readonly maxEncodedBytes: number;
}

export const ProjectAdapterStableIdV1Schema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.:-]*$/u)
  .refine((value) => !value.includes(".."), {
    message: "stable IDs cannot contain traversal",
  });

export const ProjectAdapterResourceReferenceV1Schema = z
  .string()
  .min(7)
  .max(1_024)
  .regex(/^res:\/\/[A-Za-z0-9_./@+ -]+$/u)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value
        .slice("res://".length)
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === "..",
        ),
    "resource references must be normalized project-relative res:// paths",
  );

const normalizeLimits = (
  requested: Partial<ProjectAdapterValueLimitsV1>,
): ProjectAdapterValueLimitsV1 => {
  const realized = { ...PROJECT_ADAPTER_VALUE_LIMITS_V1, ...requested };
  for (const [name, value] of Object.entries(realized)) {
    const hardMaximum =
      PROJECT_ADAPTER_VALUE_LIMITS_V1[
        name as keyof ProjectAdapterValueLimitsV1
      ];
    if (!Number.isInteger(value) || value < 1 || value > hardMaximum) {
      throw new TypeError(
        `Project adapter value limit ${name} must be an integer in 1..${hardMaximum}`,
      );
    }
  }
  return realized;
};

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const isPlainRecord = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

export class ProjectAdapterValueValidationError extends Error {
  public override readonly name = "ProjectAdapterValueValidationError";

  public constructor(
    message: string,
    public readonly path: string,
  ) {
    super(`${path}: ${message}`);
  }
}

const valueFailure = (path: string, message: string): never => {
  throw new ProjectAdapterValueValidationError(message, path);
};

/**
 * Copies unknown input into the bounded, canonical JSON value model used by
 * ProjectAdapter payloads. Objects with prototypes, sparse arrays, negative
 * zero, unsafe integers, cycles, and values outside the fixed hard bounds are
 * rejected before they can enter a wire or persisted DTO.
 */
export const parseProjectAdapterValueV1 = (
  input: unknown,
  requestedLimits: Partial<ProjectAdapterValueLimitsV1> = {},
): CanonicalAdapterValueV1 => {
  const limits = normalizeLimits(requestedLimits);
  const active = new WeakSet<object>();
  let nodes = 0;

  const visit = (
    value: unknown,
    path: string,
    depth: number,
  ): CanonicalAdapterValueV1 => {
    nodes += 1;
    if (nodes > limits.maxNodes)
      valueFailure(path, "value node budget exceeded");
    if (depth > limits.maxDepth) valueFailure(path, "value depth exceeded");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (utf8Bytes(value) > limits.maxStringBytes) {
        valueFailure(path, "string byte budget exceeded");
      }
      if (value.includes("\0"))
        valueFailure(path, "strings cannot contain NUL");
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) valueFailure(path, "numbers must be finite");
      if (Object.is(value, -0))
        valueFailure(path, "negative zero is not canonical");
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        valueFailure(path, "integers must be within the safe integer range");
      }
      return value;
    }
    if (typeof value !== "object") {
      return valueFailure(
        path,
        "value is not representable in the adapter value model",
      );
    }
    if (active.has(value))
      valueFailure(path, "cyclic values are not supported");
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > limits.maxArrayItems) {
          valueFailure(path, "array item budget exceeded");
        }
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.hasOwn(value, index)) {
            valueFailure(
              `${path}[${index}]`,
              "sparse arrays are not canonical",
            );
          }
        }
        return value.map((item, index) =>
          visit(item, `${path}[${index}]`, depth + 1),
        );
      }
      if (!isPlainRecord(value)) {
        return valueFailure(path, "objects must be plain string-key records");
      }
      const entries = Object.entries(value);
      if (entries.length > limits.maxObjectProperties) {
        valueFailure(path, "object property budget exceeded");
      }
      const result: Record<string, CanonicalAdapterValueV1> = {};
      for (const [key, child] of entries.sort(([left], [right]) =>
        left.localeCompare(right, "en-US"),
      )) {
        if (
          key.length === 0 ||
          utf8Bytes(key) > 128 ||
          key.includes("\0") ||
          key === "__proto__" ||
          key === "prototype" ||
          key === "constructor"
        ) {
          valueFailure(
            path,
            `object key ${JSON.stringify(key)} is not allowed`,
          );
        }
        result[key] = visit(child, `${path}.${key}`, depth + 1);
      }
      return result;
    } finally {
      active.delete(value);
    }
  };

  const parsed = visit(input, "$", 0);
  if (utf8Bytes(JSON.stringify(parsed)) > limits.maxEncodedBytes) {
    valueFailure("$", "encoded value byte budget exceeded");
  }
  return CanonicalAdapterValueV1Schema.parse(parsed);
};

export const canonicalProjectAdapterValueV1 = (input: unknown): string => {
  const value = parseProjectAdapterValueV1(input);
  const encode = (item: CanonicalAdapterValueV1): string => {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    const record = item as Readonly<Record<string, CanonicalAdapterValueV1>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(record[key] ?? null)}`)
      .join(",")}}`;
  };
  return encode(value);
};

export const ProjectAdapterValueV1Schema: z.ZodType<CanonicalAdapterValueV1> = z
  .unknown()
  .transform((value, context) => {
    try {
      return parseProjectAdapterValueV1(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "invalid adapter value",
      });
      return z.NEVER;
    }
  });

export const PROJECT_ADAPTER_INTRINSIC_REFERENCES_V1 = Object.freeze([
  "chronorift://intrinsic/vector2/v1",
  "chronorift://intrinsic/vector3/v1",
  "chronorift://intrinsic/vector4/v1",
  "chronorift://intrinsic/quaternion/v1",
  "chronorift://intrinsic/color/v1",
  "chronorift://intrinsic/rect2/v1",
  "chronorift://intrinsic/basis/v1",
  "chronorift://intrinsic/transform2d/v1",
  "chronorift://intrinsic/transform3d/v1",
  "chronorift://intrinsic/entity-ref/v1",
  "chronorift://intrinsic/resource-ref/v1",
] as const);

export type ProjectAdapterIntrinsicReferenceV1 =
  (typeof PROJECT_ADAPTER_INTRINSIC_REFERENCES_V1)[number];

interface NullSchemaNodeV1 {
  readonly type: "null";
  readonly const?: null | undefined;
}
interface BooleanSchemaNodeV1 {
  readonly type: "boolean";
  readonly const?: boolean | undefined;
  readonly enum?: readonly boolean[] | undefined;
}
interface NumberSchemaNodeV1 {
  readonly type: "integer" | "number";
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
  readonly const?: number | undefined;
  readonly enum?: readonly number[] | undefined;
}
interface StringSchemaNodeV1 {
  readonly type: "string";
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly const?: string | undefined;
  readonly enum?: readonly string[] | undefined;
}
interface ArraySchemaNodeV1 {
  readonly type: "array";
  readonly items: ProjectAdapterPayloadSchemaNodeV1;
  readonly minItems?: number | undefined;
  readonly maxItems: number;
}
interface ObjectSchemaNodeV1 {
  readonly type: "object";
  readonly properties: Readonly<
    Record<string, ProjectAdapterPayloadSchemaNodeV1>
  >;
  readonly required: readonly string[];
  readonly additionalProperties: false;
  readonly minProperties?: number | undefined;
  readonly maxProperties?: number | undefined;
}
interface ReferenceSchemaNodeV1 {
  readonly $ref: ProjectAdapterIntrinsicReferenceV1;
}

export type ProjectAdapterPayloadSchemaNodeV1 =
  | NullSchemaNodeV1
  | BooleanSchemaNodeV1
  | NumberSchemaNodeV1
  | StringSchemaNodeV1
  | ArraySchemaNodeV1
  | ObjectSchemaNodeV1
  | ReferenceSchemaNodeV1;

const finiteCanonicalNumber = z
  .number()
  .finite()
  .refine((value) => !Object.is(value, -0), "negative zero is not canonical");
const bound = z.number().int().nonnegative().max(512);
const ProjectAdapterPayloadSchemaNodeInternalV1Schema: z.ZodType<ProjectAdapterPayloadSchemaNodeV1> =
  z.lazy(() =>
    z.union([
      z
        .object({ type: z.literal("null"), const: z.null().optional() })
        .strict(),
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
          items: ProjectAdapterPayloadSchemaNodeInternalV1Schema,
          minItems: bound.optional(),
          maxItems: bound,
        })
        .strict(),
      z
        .object({
          type: z.literal("object"),
          properties: z.record(
            ProjectAdapterStableIdV1Schema,
            ProjectAdapterPayloadSchemaNodeInternalV1Schema,
          ),
          required: z.array(ProjectAdapterStableIdV1Schema).max(256),
          additionalProperties: z.literal(false),
          minProperties: z.number().int().nonnegative().max(256).optional(),
          maxProperties: z.number().int().nonnegative().max(256).optional(),
        })
        .strict(),
      z
        .object({
          $ref: z.enum(PROJECT_ADAPTER_INTRINSIC_REFERENCES_V1),
        })
        .strict(),
    ]),
  );

export const ProjectAdapterPayloadSchemaNodeV1Schema =
  ProjectAdapterPayloadSchemaNodeInternalV1Schema.superRefine(
    (node, context) => {
      if (
        "type" in node &&
        (node.type === "integer" || node.type === "number")
      ) {
        if (
          node.minimum !== undefined &&
          node.maximum !== undefined &&
          node.minimum > node.maximum
        ) {
          context.addIssue({
            code: "custom",
            message: "minimum exceeds maximum",
          });
        }
      }
      if ("type" in node && node.type === "string") {
        if (
          node.minLength !== undefined &&
          node.maxLength !== undefined &&
          node.minLength > node.maxLength
        ) {
          context.addIssue({
            code: "custom",
            message: "minLength exceeds maxLength",
          });
        }
      }
      if ("type" in node && node.type === "array") {
        if (node.minItems !== undefined && node.minItems > node.maxItems) {
          context.addIssue({
            code: "custom",
            message: "minItems exceeds maxItems",
          });
        }
      }
      if ("type" in node && node.type === "object") {
        const keys = Object.keys(node.properties);
        if (keys.length > 256) {
          context.addIssue({
            code: "custom",
            message: "too many schema properties",
          });
        }
        if (new Set(node.required).size !== node.required.length) {
          context.addIssue({
            code: "custom",
            message: "required fields must be unique",
          });
        }
        for (const required of node.required) {
          if (!Object.hasOwn(node.properties, required)) {
            context.addIssue({
              code: "custom",
              path: ["required"],
              message: `required field ${required} is not declared`,
            });
          }
        }
      }
      if (
        "const" in node &&
        "enum" in node &&
        node.const !== undefined &&
        node.enum !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "const and enum cannot both be present",
        });
      }
    },
  );

export const ProjectAdapterPayloadSchemaDocumentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    dialect: z.literal(PROJECT_ADAPTER_SCHEMA_DIALECT_V1),
    schemaId: ProjectAdapterStableIdV1Schema,
    root: ProjectAdapterPayloadSchemaNodeV1Schema,
  })
  .strict();
export type ProjectAdapterPayloadSchemaDocumentV1 = z.infer<
  typeof ProjectAdapterPayloadSchemaDocumentV1Schema
>;

const assertUniqueScalars = (
  values: readonly (boolean | number | string)[] | undefined,
): void => {
  if (values !== undefined && new Set(values).size !== values.length) {
    throw new TypeError("adapter payload schema enum values must be unique");
  }
};

const assertSchemaNodeSemantics = (
  node: ProjectAdapterPayloadSchemaNodeV1,
): void => {
  if ("$ref" in node || node.type === "null") return;
  if (node.type === "boolean") {
    assertUniqueScalars(node.enum);
    if (node.const !== undefined && node.enum !== undefined) {
      throw new TypeError(
        "adapter payload schema cannot combine const and enum",
      );
    }
    return;
  }
  if (node.type === "integer" || node.type === "number") {
    if (
      node.minimum !== undefined &&
      node.maximum !== undefined &&
      node.minimum > node.maximum
    ) {
      throw new TypeError("adapter payload schema minimum exceeds maximum");
    }
    assertUniqueScalars(node.enum);
    if (node.const !== undefined && node.enum !== undefined) {
      throw new TypeError(
        "adapter payload schema cannot combine const and enum",
      );
    }
    return;
  }
  if (node.type === "string") {
    if (
      node.minLength !== undefined &&
      node.maxLength !== undefined &&
      node.minLength > node.maxLength
    ) {
      throw new TypeError("adapter payload schema minLength exceeds maxLength");
    }
    assertUniqueScalars(node.enum);
    if (node.const !== undefined && node.enum !== undefined) {
      throw new TypeError(
        "adapter payload schema cannot combine const and enum",
      );
    }
    return;
  }
  if (node.type === "array") {
    if (node.minItems !== undefined && node.minItems > node.maxItems) {
      throw new TypeError("adapter payload schema minItems exceeds maxItems");
    }
    assertSchemaNodeSemantics(node.items);
    return;
  }
  if (node.type !== "object") {
    throw new TypeError("adapter payload schema node type is unsupported");
  }
  const propertyNames = Object.keys(node.properties);
  if (propertyNames.length > 256) {
    throw new TypeError(
      "adapter payload schema has too many object properties",
    );
  }
  if (new Set(node.required).size !== node.required.length) {
    throw new TypeError(
      "adapter payload schema required fields must be unique",
    );
  }
  for (const required of node.required) {
    if (!Object.hasOwn(node.properties, required)) {
      throw new TypeError(
        `adapter payload schema required field is not declared: ${required}`,
      );
    }
  }
  if (
    node.minProperties !== undefined &&
    node.maxProperties !== undefined &&
    node.minProperties > node.maxProperties
  ) {
    throw new TypeError(
      "adapter payload schema minProperties exceeds maxProperties",
    );
  }
  for (const child of Object.values(node.properties)) {
    assertSchemaNodeSemantics(child);
  }
};

const assertSchemaBounds = (input: unknown): void => {
  const stack: { readonly value: unknown; readonly depth: number }[] = [
    { value: input, depth: 0 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > 4_096)
      throw new TypeError("adapter payload schema node budget exceeded");
    if (current.depth > 16)
      throw new TypeError("adapter payload schema depth exceeded");
    if (current.value === null || typeof current.value !== "object") continue;
    if (!Array.isArray(current.value) && !isPlainRecord(current.value)) {
      throw new TypeError("adapter payload schema must contain plain records");
    }
    for (const value of Object.values(current.value)) {
      stack.push({ value, depth: current.depth + 1 });
    }
  }
  if (utf8Bytes(JSON.stringify(input)) > 256 * 1_024) {
    throw new TypeError("adapter payload schema byte budget exceeded");
  }
};

export const parseProjectAdapterPayloadSchemaV1 = (
  input: unknown,
): ProjectAdapterPayloadSchemaDocumentV1 => {
  assertSchemaBounds(input);
  const schema = ProjectAdapterPayloadSchemaDocumentV1Schema.parse(input);
  assertSchemaNodeSemantics(schema.root);
  return schema;
};

const exactRecord = (
  value: CanonicalAdapterValueV1,
  keys: readonly string[],
): value is Record<string, CanonicalAdapterValueV1> =>
  value !== null &&
  !Array.isArray(value) &&
  typeof value === "object" &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const requireFiniteNumber = (
  value: CanonicalAdapterValueV1,
  path: string,
): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Object.is(value, -0)
  ) {
    return valueFailure(path, "expected a canonical finite number");
  }
  return value;
};

const validateVector = (
  value: CanonicalAdapterValueV1,
  tag: string,
  length: number,
  path: string,
): void => {
  const keys = ["$type", "values"];
  if (!exactRecord(value, keys))
    return valueFailure(path, `expected intrinsic ${tag}`);
  const record = value as Readonly<Record<string, CanonicalAdapterValueV1>>;
  if (
    record.$type !== tag ||
    !Array.isArray(record.values) ||
    record.values.length !== length
  ) {
    return valueFailure(path, `expected intrinsic ${tag}`);
  }
  const components = record.values as readonly CanonicalAdapterValueV1[];
  for (const [index, component] of components.entries()) {
    requireFiniteNumber(component, `${path}.values[${index}]`);
  }
};

const validateIntrinsic = (
  reference: ProjectAdapterIntrinsicReferenceV1,
  value: CanonicalAdapterValueV1,
  path: string,
): void => {
  const name = reference.split("/").at(-2);
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
  if (length !== undefined)
    return validateVector(value, name ?? "", length, path);
  if (name === "entity-ref") {
    if (!exactRecord(value, ["$type", "entityId"]))
      return valueFailure(path, "expected intrinsic entity_ref");
    if (value.$type !== "entity_ref")
      return valueFailure(path, "expected intrinsic entity_ref");
    ProjectEntityIdSchema.parse(value.entityId);
    return;
  }
  if (name === "resource-ref") {
    if (!exactRecord(value, ["$type", "resourceId"]))
      return valueFailure(path, "expected intrinsic resource_ref");
    if (value.$type !== "resource_ref")
      return valueFailure(path, "expected intrinsic resource_ref");
    ProjectResourceIdSchema.parse(value.resourceId);
    return;
  }
  return valueFailure(path, `expected intrinsic ${name ?? "unknown"}`);
};

const validateNode = (
  node: ProjectAdapterPayloadSchemaNodeV1,
  value: CanonicalAdapterValueV1,
  path: string,
): void => {
  if ("$ref" in node) return validateIntrinsic(node.$ref, value, path);
  if (node.type === "null") {
    if (value !== null) return valueFailure(path, "expected null");
    return;
  }
  if (node.type === "boolean") {
    if (typeof value !== "boolean")
      return valueFailure(path, "expected boolean");
  } else if (node.type === "integer" || node.type === "number") {
    const number = requireFiniteNumber(value, path);
    if (node.type === "integer" && !Number.isSafeInteger(number))
      valueFailure(path, "expected safe integer");
    if (node.minimum !== undefined && number < node.minimum)
      valueFailure(path, "number is below minimum");
    if (node.maximum !== undefined && number > node.maximum)
      valueFailure(path, "number exceeds maximum");
  } else if (node.type === "string") {
    if (typeof value !== "string") return valueFailure(path, "expected string");
    if (node.minLength !== undefined && [...value].length < node.minLength)
      valueFailure(path, "string is shorter than minLength");
    if (node.maxLength !== undefined && [...value].length > node.maxLength)
      valueFailure(path, "string exceeds maxLength");
  } else if (node.type === "array") {
    if (!Array.isArray(value)) return valueFailure(path, "expected array");
    const array = value as readonly CanonicalAdapterValueV1[];
    if (node.minItems !== undefined && array.length < node.minItems)
      valueFailure(path, "array is shorter than minItems");
    if (array.length > node.maxItems)
      valueFailure(path, "array exceeds maxItems");
    array.forEach((child, index) =>
      validateNode(node.items, child, `${path}[${index}]`),
    );
    return;
  } else if (node.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return valueFailure(path, "expected object");
    const record = value as Readonly<Record<string, CanonicalAdapterValueV1>>;
    const keys = Object.keys(record);
    if (node.minProperties !== undefined && keys.length < node.minProperties)
      valueFailure(path, "object has fewer than minProperties");
    if (node.maxProperties !== undefined && keys.length > node.maxProperties)
      valueFailure(path, "object exceeds maxProperties");
    for (const required of node.required)
      if (!Object.hasOwn(record, required))
        valueFailure(path, `missing required field ${required}`);
    for (const key of keys) {
      const childSchema = node.properties[key];
      if (childSchema === undefined)
        return valueFailure(
          `${path}.${key}`,
          "additional property is not allowed",
        );
      validateNode(childSchema, record[key] ?? null, `${path}.${key}`);
    }
    return;
  }
  if ("const" in node && node.const !== undefined && value !== node.const)
    valueFailure(path, "value does not match const");
  if (
    "enum" in node &&
    node.enum !== undefined &&
    !node.enum.includes(value as never)
  )
    valueFailure(path, "value is not in enum");
};

export const validateProjectAdapterPayloadV1 = (
  schemaInput: unknown,
  payloadInput: unknown,
): CanonicalAdapterValueV1 => {
  const schema = parseProjectAdapterPayloadSchemaV1(schemaInput);
  const value = parseProjectAdapterValueV1(payloadInput);
  validateNode(schema.root, value, "$payload");
  return value;
};
