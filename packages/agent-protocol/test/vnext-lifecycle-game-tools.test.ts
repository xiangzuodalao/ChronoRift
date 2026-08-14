import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  GAME_TOOL_DEFINITIONS_V1,
  LIFECYCLE_GAME_TOOL_DEFINITIONS_V1,
  LIFECYCLE_GAME_TOOL_NAMES_V1,
  LIFECYCLE_UNSUPPORTED_GAME_CAPABILITIES_V1,
  LifecycleGameCapabilitiesInputV2Schema,
  LifecycleGameLaunchInputV2Schema,
} from "../src/index.js";

describe("lifecycle-only game tool catalog", () => {
  it("exposes exactly the four lifecycle tools without changing M3", () => {
    expect(
      LIFECYCLE_GAME_TOOL_DEFINITIONS_V1.map((definition) => definition.name),
    ).toEqual(LIFECYCLE_GAME_TOOL_NAMES_V1);
    expect(LIFECYCLE_GAME_TOOL_NAMES_V1).toEqual([
      "game_capabilities",
      "game_launch",
      "game_status",
      "game_stop",
    ]);
    expect(GAME_TOOL_DEFINITIONS_V1).toHaveLength(16);
    expect(LIFECYCLE_UNSUPPORTED_GAME_CAPABILITIES_V1).toHaveLength(12);
  });

  it("requires schema version 2 and gives launch no control surface", () => {
    expect(
      Check(LifecycleGameCapabilitiesInputV2Schema, {
        schemaVersion: 2,
        taskId: "task:v1:test",
      }),
    ).toBe(true);
    expect(
      Check(LifecycleGameCapabilitiesInputV2Schema, {
        schemaVersion: 1,
        taskId: "task:v1:test",
      }),
    ).toBe(false);
    expect(
      Check(LifecycleGameLaunchInputV2Schema, {
        schemaVersion: 2,
        taskId: "task:v1:test",
        buildId: "build:v1:test",
        controls: { fixedFps: 60 },
      }),
    ).toBe(false);
  });
});
