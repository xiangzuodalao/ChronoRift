import { describe, expect, it } from "vitest";

import { TemporalInvariantSchema, asInvariantId } from "../src/index.js";

describe("domain runtime schemas", () => {
  it("rejects unknown invariant fields and ambiguous negative tick windows", () => {
    const invariant = {
      schemaVersion: 1,
      invariantId: asInvariantId("door-opens"),
      description: "door opens",
      severity: "error",
      trigger: { kind: "signal", source: "/switch", name: "activated" },
      expectation: {
        kind: "property_equals",
        path: "/door/open",
        value: true,
      },
      withinTicks: 2,
      inclusive: true,
    } as const;

    expect(TemporalInvariantSchema.parse(invariant)).toEqual(invariant);
    expect(() =>
      TemporalInvariantSchema.parse({ ...invariant, withinTicks: -1 }),
    ).toThrow();
    expect(() =>
      TemporalInvariantSchema.parse({ ...invariant, executableRule: "code" }),
    ).toThrow();
  });
});
