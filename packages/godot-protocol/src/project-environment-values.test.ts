import { describe, expect, it } from "vitest";

import {
  PROJECT_ADAPTER_SCHEMA_DIALECT_V1,
  canonicalProjectAdapterValueV1,
  parseProjectAdapterPayloadSchemaV1,
  parseProjectAdapterValueV1,
  validateProjectAdapterPayloadV1,
} from "./project-environment-values.js";

const document = {
  schemaVersion: 1 as const,
  dialect: PROJECT_ADAPTER_SCHEMA_DIALECT_V1,
  schemaId: "state.player",
  root: {
    type: "object" as const,
    properties: {
      hp: { type: "integer" as const, minimum: 0, maximum: 100 },
      position: { $ref: "chronorift://intrinsic/vector2/v1" as const },
    },
    required: ["hp", "position"],
    additionalProperties: false as const,
  },
};

describe("Project Environment canonical adapter values", () => {
  it("copies and deterministically orders bounded values", () => {
    const input = { z: [true, 2.5], a: { value: "ok" } };
    expect(parseProjectAdapterValueV1(input)).not.toBe(input);
    expect(canonicalProjectAdapterValueV1(input)).toBe(
      '{"a":{"value":"ok"},"z":[true,2.5]}',
    );
  });

  it("rejects non-canonical numbers, cycles, sparse arrays, and prototypes", () => {
    expect(() => parseProjectAdapterValueV1(-0)).toThrow(/negative zero/u);
    expect(() => parseProjectAdapterValueV1(Number.NaN)).toThrow(/finite/u);
    expect(() => parseProjectAdapterValueV1(1.25e-100)).not.toThrow();
    expect(() =>
      parseProjectAdapterValueV1(Number.MAX_SAFE_INTEGER + 1),
    ).toThrow(/safe integer/u);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => parseProjectAdapterValueV1(cycle)).toThrow(/cyclic/u);
    const sparse = new Array<unknown>(2);
    sparse[1] = true;
    expect(() => parseProjectAdapterValueV1(sparse)).toThrow(/sparse/u);
    expect(() => parseProjectAdapterValueV1(new Date())).toThrow(/plain/u);
  });

  it("enforces hard caller limits without permitting bounds to be widened", () => {
    expect(() =>
      parseProjectAdapterValueV1([1, 2], { maxArrayItems: 1 }),
    ).toThrow(/array item/u);
    expect(() =>
      parseProjectAdapterValueV1([], { maxArrayItems: 513 }),
    ).toThrow(/limit maxArrayItems/u);
  });
});

describe("Project Environment payload schema subset", () => {
  it("validates strict objects and tagged Godot values", () => {
    expect(
      validateProjectAdapterPayloadV1(document, {
        hp: 75,
        position: { $type: "vector2", values: [1.5, 2] },
      }),
    ).toEqual({
      hp: 75,
      position: { $type: "vector2", values: [1.5, 2] },
    });
    expect(() =>
      validateProjectAdapterPayloadV1(document, {
        hp: 101,
        position: { $type: "vector2", values: [1, 2] },
      }),
    ).toThrow(/maximum/u);
    expect(() =>
      validateProjectAdapterPayloadV1(document, {
        hp: 75,
        position: { $type: "vector2", values: [1, 2] },
        secret: true,
      }),
    ).toThrow(/additional property/u);
  });

  it("rejects unknown schema keywords and invalid nested declarations", () => {
    expect(() =>
      parseProjectAdapterPayloadSchemaV1({
        ...document,
        root: { ...document.root, patternProperties: {} },
      }),
    ).toThrow();
    expect(() =>
      parseProjectAdapterPayloadSchemaV1({
        ...document,
        root: {
          type: "array",
          minItems: 2,
          maxItems: 1,
          items: { type: "null" },
        },
      }),
    ).toThrow(/minItems/u);
  });
});
