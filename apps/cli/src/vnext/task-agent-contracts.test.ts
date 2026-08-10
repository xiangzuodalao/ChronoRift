import { describe, expect, it } from "vitest";

import { asSha256DigestV1 } from "@chronorift/domain";

import {
  createVNextAgentGameCapabilityV1,
  createVNextAgentLifecycleProfileV1,
  VNextAgentLifecycleProfileV1Schema,
  VNextAgentTaskSchema,
} from "./task-agent-contracts.js";

describe("vNext Agent Task profile contracts", () => {
  it("adds a strict four-tool M4 profile without changing M3", () => {
    const managedRuntimeId = `managed-godot-runtime:v1:${"a".repeat(64)}`;
    const profile = createVNextAgentLifecycleProfileV1({
      projectCapabilitySha256: asSha256DigestV1("b".repeat(64)),
      managedRuntimeId,
    });
    expect(profile.toolNames).toEqual([
      "game_capabilities",
      "game_launch",
      "game_status",
      "game_stop",
    ]);
    expect(
      createVNextAgentGameCapabilityV1(managedRuntimeId).toolNames,
    ).toHaveLength(16);
    expect(
      VNextAgentTaskSchema.parse({
        schemaVersion: 3,
        taskId: "task:v1:test",
        goal: "Onboard the external project",
        provider: "fake",
        model: "fake",
        thinkingLevel: "off",
        createdAt: "2026-08-10T00:00:00.000Z",
        profile,
      }).schemaVersion,
    ).toBe(3);
  });

  it("rejects reordered or extended lifecycle catalogs", () => {
    const valid = createVNextAgentLifecycleProfileV1({
      projectCapabilitySha256: asSha256DigestV1("b".repeat(64)),
      managedRuntimeId: `managed-godot-runtime:v1:${"a".repeat(64)}`,
    });
    expect(() =>
      VNextAgentLifecycleProfileV1Schema.parse({
        ...valid,
        toolNames: [...valid.toolNames].reverse(),
      }),
    ).toThrow(/ordered/iu);
  });
});
