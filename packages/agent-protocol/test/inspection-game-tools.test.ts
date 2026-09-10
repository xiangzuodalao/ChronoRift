import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  INSPECTION_GAME_TOOL_DEFINITIONS_V1,
  validateInspectionGameToolInputV1,
} from "../src/index.js";

describe("inspection tool metadata", () => {
  it("advertises launch, current inspection, bounded watch, and stop", () => {
    expect(INSPECTION_GAME_TOOL_DEFINITIONS_V1.map(({ name }) => name)).toEqual(
      ["game_launch", "game_query", "game_watch", "game_stop"],
    );
  });

  it.each([
    { schemaVersion: 1, executionId: "run:one", select: "children" },
    {
      schemaVersion: 1,
      executionId: "run:one",
      select: "properties",
      offset: 2,
      limit: 200,
    },
    {
      schemaVersion: 1,
      executionId: "run:one",
      select: "values",
      names: ["shape"],
    },
    {
      schemaVersion: 1,
      executionId: "run:one",
      select: "values",
      names: ["shape"],
      limit: 5,
    },
    {
      schemaVersion: 1,
      executionId: "run:one",
      select: "children",
      limit: 201,
    },
    {
      schemaVersion: 1,
      executionId: "run:one",
      select: "children",
      target: { path: "../host" },
    },
    {
      schemaVersion: 1,
      executionId: "run:one",
      select: "children",
      target: { path: ".", objectRef: "run:one:object:1" },
    },
    { schemaVersion: 2, executionId: "run:one", select: "children" },
  ])("generated Pi schema agrees with canonical validation for %j", (input) => {
    const query = INSPECTION_GAME_TOOL_DEFINITIONS_V1.find(
      ({ name }) => name === "game_query",
    );
    if (query === undefined) throw new Error("Query metadata missing");
    expect(Check(query.parameters, input)).toBe(
      validateInspectionGameToolInputV1("game_query", input),
    );
  });
});

it.each([
  {
    schemaVersion: 1,
    executionId: "run:one",
    action: "start",
    targets: [{ target: { path: "." }, names: ["value"] }],
    sampleCount: 2,
  },
  {
    schemaVersion: 1,
    executionId: "run:one",
    action: "start",
    targets: [{ target: { path: "." }, names: ["value", "value"] }],
    sampleCount: 2,
  },
  {
    schemaVersion: 1,
    executionId: "run:one",
    action: "read",
    watchId: "watch:one",
  },
  {
    schemaVersion: 1,
    executionId: "run:one",
    action: "read",
    watchId: "watch:one",
    byteBudget: 255,
  },
  {
    schemaVersion: 1,
    executionId: "run:one",
    action: "stop",
    watchId: "watch:one",
  },
])("watch Pi schema matches canonical input validation %j", (input) => {
  const metadata = INSPECTION_GAME_TOOL_DEFINITIONS_V1.find(
    ({ name }) => name === "game_watch",
  )!;
  expect(Check(metadata.parameters, input)).toBe(
    validateInspectionGameToolInputV1("game_watch", input),
  );
});
