import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { validateProjectAdapterPayloadV2 } from "@chronorift/godot-protocol";

import { loadProjectAdapterPackageV2 } from "./project-adapter-package-v2.js";

describe("the Squash the Creeps Mob orientation adapter package", () => {
  it("loads through the public V2 package boundary as a state-only adapter", async () => {
    const loaded = await loadProjectAdapterPackageV2(
      join(
        process.cwd(),
        "testdata/vnext/external-project/squash-the-creeps-mob-orientation-adapter",
      ),
      {
        requireSingleLaunchTarget: true,
        expectedMainScene: "res://Main.tscn",
        requireEmptyLaunchParameters: true,
      },
    );

    expect(loaded.manifest).toMatchObject({
      schemaVersion: 2,
      adapterId: "godot_demo.squash_mob_orientation",
      eventTypes: [],
      entityTypes: [
        { entityTypeId: "mob", identityStrategy: "execution_local" },
      ],
      stateDomains: [{ stateDomainId: "mob_spawn_orientation" }],
      smoke: {
        minimumStateSamples: 1,
        minimumEntityLifecycleRecords: 1,
        requiredCustomEventTypeIds: [],
        requiredDynamicTraces: [],
      },
    });
    const stateSchema = loaded.schemas.find(
      (schema) => schema.schemaId === "state.mob_spawn_orientation",
    );
    expect(stateSchema).toBeDefined();
    expect(
      validateProjectAdapterPayloadV2(stateSchema!, {
        node_path: "Mob",
        mob_y: 0,
        player_y: 6,
        height_delta: 6,
        up_alignment: 0.91,
        velocity_y: 0,
        horizontal_speed: 14,
      }),
    ).toMatchObject({ up_alignment: 0.91, horizontal_speed: 14 });
  });
});
