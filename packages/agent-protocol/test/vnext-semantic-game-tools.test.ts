import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  GAME_TOOL_DEFINITIONS_V1,
  LIFECYCLE_GAME_TOOL_DEFINITIONS_V1,
  SEMANTIC_GAME_TOOL_DEFINITIONS_V1,
  SEMANTIC_GAME_TOOL_NAMES_V1,
  SEMANTIC_UNSUPPORTED_GAME_CAPABILITIES_V1,
  SemanticGameCheckpointCreateInputV1Schema,
  SemanticGameForkInputV1Schema,
  SemanticGameTraceCreateInputV1Schema,
} from "../src/index.js";

describe("external semantic game tool catalog", () => {
  it("exposes exactly eleven tools without widening M3 or M4", () => {
    expect(
      SEMANTIC_GAME_TOOL_DEFINITIONS_V1.map((definition) => definition.name),
    ).toEqual(SEMANTIC_GAME_TOOL_NAMES_V1);
    expect(SEMANTIC_GAME_TOOL_NAMES_V1).toEqual([
      "game_capabilities",
      "game_launch",
      "game_status",
      "game_stop",
      "game_query",
      "game_checkpoint_create",
      "game_checkpoint_restore",
      "game_fork",
      "game_trace_create",
      "game_trace_replay",
      "game_compare",
    ]);
    expect(SEMANTIC_UNSUPPORTED_GAME_CAPABILITIES_V1).toEqual([
      "game.capture.configure",
      "game.capture.pin",
      "game.control.input",
      "game.control.step",
      "game.control.configure",
    ]);
    expect(GAME_TOOL_DEFINITIONS_V1).toHaveLength(16);
    expect(LIFECYCLE_GAME_TOOL_DEFINITIONS_V1).toHaveLength(4);
  });

  it("only admits the realized adapter-tail checkpoint barrier", () => {
    expect(
      Check(SemanticGameCheckpointCreateInputV1Schema, {
        schemaVersion: 1,
        taskId: "task:v1:test",
        runtimeId: "runtime:v1:test",
        barrier: "adapter_process_tail",
      }),
    ).toBe(true);
    expect(
      Check(SemanticGameCheckpointCreateInputV1Schema, {
        schemaVersion: 1,
        taskId: "task:v1:test",
        runtimeId: "runtime:v1:test",
        barrier: "process_frame_end",
      }),
    ).toBe(false);
  });

  it("bounds relative observation traces and rejects unknown controls", () => {
    expect(
      Check(SemanticGameTraceCreateInputV1Schema, {
        schemaVersion: 1,
        taskId: "task:v1:test",
        runtimeId: "runtime:v1:test",
        clockDomain: "physics_tick",
        sampleOffsets: [15, 75, 135],
      }),
    ).toBe(true);
    expect(
      Check(SemanticGameTraceCreateInputV1Schema, {
        schemaVersion: 1,
        taskId: "task:v1:test",
        runtimeId: "runtime:v1:test",
        clockDomain: "physics_tick",
        sampleOffsets: [601],
      }),
    ).toBe(false);
    expect(
      Check(SemanticGameForkInputV1Schema, {
        schemaVersion: 1,
        taskId: "task:v1:test",
        source: { kind: "checkpoint", checkpointId: "checkpoint:v1:test" },
        controls: { fixedFps: 60 },
      }),
    ).toBe(false);
  });
});
