import { describe, expect, it } from "vitest";

import {
  InspectionLaunchInputV1Schema,
  InspectionQueryInputV1Schema,
  InspectionQueryOutputV1Schema,
  InspectionQueryResultV1Schema,
  InspectionRunRecordV1Schema,
  InspectionValueV1Schema,
} from "../src/index.js";

const query = { schemaVersion: 1, executionId: "run:one", select: "children" };
const root = {
  objectRef: "run:one:object:1",
  className: "Node2D",
  name: "World",
  path: ".",
  childCount: 2,
};

describe("runtime inspection inputs", () => {
  it("defaults the scene target and only the implemented list pagination", () => {
    expect(InspectionQueryInputV1Schema.parse(query)).toEqual({
      ...query,
      target: { path: "." },
      offset: 0,
      limit: 100,
    });
    expect(
      InspectionQueryInputV1Schema.parse({
        ...query,
        select: "values",
        names: ["shape"],
      }),
    ).toEqual({
      ...query,
      select: "values",
      target: { path: "." },
      names: ["shape"],
    });
  });

  it.each([
    { ...query, limit: 201 },
    { ...query, limit: 0 },
    { ...query, offset: -1 },
    { ...query, cursor: "old-query" },
    { ...query, names: ["shape"] },
    { ...query, select: "values", names: ["shape"], offset: 0 },
    { ...query, select: "values", names: [] },
    { ...query, select: "values", names: ["shape\u0000size"] },
    {
      ...query,
      select: "values",
      names: Array.from({ length: 33 }, () => "shape"),
    },
    { ...query, select: "values" },
    { ...query, schemaVersion: 2 },
  ])("rejects unsupported query shape %j", (input) => {
    expect(InspectionQueryInputV1Schema.safeParse(input).success).toBe(false);
  });

  it.each([
    "/root/World",
    "../World",
    "World/../Sibling",
    "World:shape",
    "res://world.tscn",
    "World\\Child",
    "World//Child",
    "World/",
    "World\u0000Child",
  ])("rejects path escape or subname %s", (path) => {
    expect(
      InspectionQueryInputV1Schema.safeParse({ ...query, target: { path } })
        .success,
    ).toBe(false);
  });

  it("accepts scene-relative paths and execution references without mixing targets", () => {
    for (const target of [
      { path: "Platforms/Platform/CollisionShape2D" },
      { path: "Platforms/节点�" },
      { objectRef: "run:one:object:3" },
    ]) {
      expect(
        InspectionQueryInputV1Schema.safeParse({ ...query, target }).success,
      ).toBe(true);
    }
    expect(
      InspectionQueryInputV1Schema.safeParse({
        ...query,
        target: { path: ".", objectRef: "run:one:object:1" },
      }).success,
    ).toBe(false);
    expect(
      InspectionLaunchInputV1Schema.safeParse({
        schemaVersion: 1,
        adapterRevisionId: "old",
      }).success,
    ).toBe(false);
  });

  it("accepts literal Unicode property names without confusing U+FFFD with NUL", () => {
    expect(
      InspectionQueryInputV1Schema.safeParse({
        ...query,
        select: "values",
        names: ["属性�"],
      }).success,
    ).toBe(true);
  });
});

describe("runtime inspection values and outputs", () => {
  it("retains precise references, vector components and 64-bit integers", () => {
    const values = [
      null,
      true,
      3.5,
      "hello",
      [1, { useful: true }],
      { $type: "vector2", x: 1, y: -2 },
      { $type: "vector3", x: 1, y: 2, z: 3 },
      { $type: "color", r: 1, g: 0.5, b: 0, a: 1 },
      { $type: "int64", value: "9223372036854775807" },
      {
        $type: "object",
        objectRef: "run:one:object:4",
        className: "RectangleShape2D",
        resourcePath: "",
      },
      { $type: "unsupported", type: "Callable" },
      { $type: "truncated", reason: "depth limit" },
    ];
    for (const value of values)
      expect(InspectionValueV1Schema.parse(value)).toEqual(value);
  });

  it.each([
    Number.MAX_SAFE_INTEGER + 1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    { $type: "vector2", x: 1, y: 2, z: 3 },
    { $type: "int64", value: "9223372036854775808" },
    { $type: "int64", value: "-9223372036854775809" },
    { $type: "int64", value: "01" },
    { $type: "unknown" },
    { $type: "object", objectRef: "/host/path", className: "Resource" },
    "x".repeat(16_385),
    Array.from({ length: 257 }, () => 0),
    new Date(),
  ])("rejects malformed, imprecise, or over-budget value %j", (value) => {
    expect(InspectionValueV1Schema.safeParse(value).success).toBe(false);
  });

  it("rejects cycles and excessive depth before recursive parsing can overflow", () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(InspectionValueV1Schema.safeParse(cycle).success).toBe(false);
    let deep: unknown = 0;
    for (let i = 0; i < 34; i++) deep = [deep];
    expect(InspectionValueV1Schema.safeParse(deep).success).toBe(false);
    expect(
      InspectionValueV1Schema.safeParse(
        Array.from({ length: 256 }, () => Array.from({ length: 32 }, () => 0)),
      ).success,
    ).toBe(false);
  });

  it("separates runtime clocks from Host receipt time and keeps per-property failures", () => {
    const output = {
      schemaVersion: 1,
      executionId: "run:one",
      select: "values",
      sample: { processFrame: 12, physicsTick: 8 },
      target: root,
      values: [
        {
          name: "velocity",
          status: "success",
          value: { $type: "vector2", x: 1, y: 2 },
        },
        { name: "gone", status: "missing", message: "Property does not exist" },
      ],
    };
    expect(InspectionQueryResultV1Schema.parse(output)).toEqual(output);
    expect(InspectionQueryOutputV1Schema.safeParse(output).success).toBe(false);
    expect(
      InspectionQueryOutputV1Schema.parse({
        ...output,
        hostReceivedAt: "2026-09-05T01:02:03.000Z",
      }),
    ).toMatchObject(output);
    expect(
      InspectionQueryResultV1Schema.safeParse({
        ...output,
        hostReceivedAt: "2026-09-05T01:02:03.000Z",
      }).success,
    ).toBe(false);
  });

  it("allows truthful early failures and rejects invented source integrity", () => {
    const record = {
      schemaVersion: 1,
      executionId: "run:one",
      sourceSha256: null,
      observedSourceSha256: null,
      sourceUnchanged: null,
      mainScene: null,
      engineVersion: null,
      startedAt: "2026-09-05T01:02:03.000Z",
      endedAt: "2026-09-05T01:02:03.000Z",
      status: "failed",
      exitCode: null,
      signal: null,
      import: null,
      run: null,
      stderr: "",
      stderrTruncated: false,
      error: { code: "launch_failed", message: "Stage initialization failed" },
    };
    expect(InspectionRunRecordV1Schema.parse(record)).toEqual(record);
    expect(
      InspectionRunRecordV1Schema.safeParse({
        ...record,
        sourceUnchanged: true,
      }).success,
    ).toBe(false);
    expect(
      InspectionRunRecordV1Schema.safeParse({
        ...record,
        sourceSha256: "a".repeat(64),
        observedSourceSha256: "b".repeat(64),
        sourceUnchanged: true,
      }).success,
    ).toBe(false);
  });
});
