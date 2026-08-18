import { createHash } from "node:crypto";

import {
  asAdapterConformanceReceiptId,
  asProjectAdapterRevisionId,
  asSha256DigestV1,
  asSourceId,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import {
  M7FrozenPatrolClassifierOutputV1Schema,
  M7HiddenMutationRegistrationV1Schema,
  M7PatrolEntityStateV1Schema,
  M7PatrolPreflightRunReceiptV1Schema,
  M7PatrolStateTimelineV1Schema,
  M7SensorFreezeRecordV1Schema,
  M7_MODDABLE_PLATFORMER_REPOSITORY_V1,
  M7_MODDABLE_PLATFORMER_REVISION_V1,
  M7_PATROL_SCENARIO_PLAN_SHA256_V1,
  M7_PATROL_SCENARIO_PLAN_V1,
  classifyM7PatrolTimelineV1,
  createM7PatrolPreflightResultV1,
  createM7SensorAgentProjectionV1,
  createM7SensorFreezeStoreV1,
  type M7PatrolEntityStateV1,
  type M7PatrolPreflightRunReceiptV1,
  type M7PatrolScenarioV1,
  type M7SensorMaterialBytesV1,
} from "./m7-patrol-sensor.js";

const sha = (value: string) =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const materials = (): M7SensorMaterialBytesV1 => ({
  adapterPackageBytes: "generic patrol adapter package v1\n",
  observationSchemaBytes:
    "entity_id name start_direction direction fall_off_edge speed position_x position_y velocity_x velocity_y grounded\n",
  classifierImplementationBytes:
    "classify generic patrol sequences: grounded to falling; direction reversal without falling\n",
  pristineConformanceReceiptBytes: "pristine conformance receipt v1\n",
});

const freezeInput = (sensorMaterials = materials()) => ({
  schemaVersion: 1 as const,
  pristineSubject: {
    repository: M7_MODDABLE_PLATFORMER_REPOSITORY_V1,
    revision: M7_MODDABLE_PLATFORMER_REVISION_V1,
    sourceId: asSourceId("source:moddable-platformer:pristine"),
    subjectProjectSha256: sha("subject"),
    selectedTreeSha256: sha("pristine tree"),
  },
  adapterRevisionId: asProjectAdapterRevisionId("adapter:generic-patrol:v1"),
  pristineConformanceReceiptId: asAdapterConformanceReceiptId(
    "adapter-conformance:generic-patrol:v1",
  ),
  materials: sensorMaterials,
  frozenAt: "2026-08-15T00:00:00.000Z",
});

const hiddenMutation = `diff --git a/components/enemy/storyvore_enemy.tscn b/components/enemy/storyvore_enemy.tscn
index 22f8039..1bd8aeb 100644
--- a/components/enemy/storyvore_enemy.tscn
+++ b/components/enemy/storyvore_enemy.tscn
@@ -77,12 +77,12 @@ frame_progress = 0.106469
 [node name="LeftRay" type="RayCast2D" parent="." unique_id=662956966]
 unique_name_in_owner = true
 position = Vector2(-37, -3)
-collision_mask = 5
+collision_mask = 1
 
 [node name="RightRay" type="RayCast2D" parent="." unique_id=1046947928]
 unique_name_in_owner = true
 position = Vector2(37, -3)
-collision_mask = 5
+collision_mask = 1
 
 [node name="CollisionShape2D" type="CollisionShape2D" parent="." unique_id=345687420]
`;

const registerInput = (sensorMaterials = materials()) => ({
  schemaVersion: 1 as const,
  mutationBytes: hiddenMutation,
  mutatedSourceId: asSourceId("source:moddable-platformer:mutant"),
  mutatedSelectedTreeSha256: sha("mutant tree"),
  sensorMaterials,
  registeredAt: "2026-08-15T00:01:00.000Z",
});

const state = (
  input: Partial<M7PatrolEntityStateV1> = {},
): M7PatrolEntityStateV1 => ({
  entity_id: "enemy:storyvore:1",
  name: "StoryvoreEnemy",
  start_direction: 0,
  direction: -1,
  fall_off_edge: false,
  speed: 120,
  position_x: 0,
  position_y: 100,
  velocity_x: -120,
  velocity_y: 0,
  grounded: true,
  ...input,
});

describe("M7 generic patrol sensor", () => {
  it("strictly validates the exact pre-mutation classifier output shape", () => {
    const frozenOutput = {
      schemaVersion: 1 as const,
      stateDomainId: "patrol.motion" as const,
      classification: "fell_without_reversing" as const,
      declaredSampleCount: 12,
      entityCount: 1,
      fallWitnessCount: 1,
      reversalWitnessCount: 0,
      witnesses: [
        {
          entityId: "main.enemies.enemy",
          name: "Enemy",
          outcome: "fell_without_reversing" as const,
          fromFrame: 10,
          toFrame: 20,
          startDirection: -1 as const,
          endDirection: -1 as const,
          startY: 100,
          endY: 112,
        },
      ],
    };
    expect(M7FrozenPatrolClassifierOutputV1Schema.parse(frozenOutput)).toEqual(
      frozenOutput,
    );
    expect(
      M7FrozenPatrolClassifierOutputV1Schema.safeParse({
        ...frozenOutput,
        fallWitnessCount: 0,
      }).success,
    ).toBe(false);
    expect(
      M7FrozenPatrolClassifierOutputV1Schema.safeParse({
        ...frozenOutput,
        leftRayColliding: false,
      }).success,
    ).toBe(false);
  });

  it("accepts only the frozen generic state vocabulary", () => {
    expect(M7PatrolEntityStateV1Schema.parse(state())).toEqual(state());
    expect(
      M7PatrolEntityStateV1Schema.safeParse({
        ...state(),
        left_ray_colliding: false,
      }).success,
    ).toBe(false);
    expect(
      M7PatrolEntityStateV1Schema.safeParse({
        ...state(),
        start_direction: -1,
      }).success,
    ).toBe(false);
    expect(
      M7PatrolEntityStateV1Schema.safeParse({
        ...state(),
        direction: 0,
      }).success,
    ).toBe(false);
    const { position_x, position_y, velocity_x, velocity_y, ...withoutFlat } =
      state();
    expect(
      M7PatrolEntityStateV1Schema.safeParse({
        ...withoutFlat,
        position: { x: position_x, y: position_y },
        velocity: { x: velocity_x, y: velocity_y },
      }).success,
    ).toBe(false);
    expect(
      M7PatrolStateTimelineV1Schema.safeParse({
        schemaVersion: 1,
        execution_id: "execution:one",
        frames: [
          { sample_ordinal: 1, entities: [state()] },
          {
            sample_ordinal: 1,
            entities: [state({ position_x: 1 })],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("recognizes observable falling and reversal sequences without a verdict", () => {
    const classification = classifyM7PatrolTimelineV1({
      schemaVersion: 1,
      execution_id: "execution:generic-patrol",
      frames: [
        {
          sample_ordinal: 10,
          entities: [
            state(),
            state({
              entity_id: "enemy:storyvore:2",
              start_direction: 1,
              direction: 1,
              position_x: 200,
              velocity_x: 120,
            }),
            state({
              entity_id: "enemy:storyvore:3",
              fall_off_edge: true,
            }),
          ],
        },
        {
          sample_ordinal: 20,
          entities: [
            state({
              position_x: -100,
              position_y: 130,
              velocity_x: -120,
              velocity_y: 30,
              grounded: false,
            }),
            state({
              entity_id: "enemy:storyvore:2",
              start_direction: 1,
              direction: -1,
              position_x: 190,
              velocity_x: -120,
            }),
            state({
              entity_id: "enemy:storyvore:3",
              fall_off_edge: true,
              position_x: -100,
              position_y: 130,
              velocity_x: -120,
              velocity_y: 30,
              grounded: false,
            }),
          ],
        },
      ],
    });

    expect(classification.witnesses).toEqual([
      expect.objectContaining({
        entity_id: "enemy:storyvore:1",
        kind: "no_reversal_before_grounded_to_falling",
      }),
      expect.objectContaining({
        entity_id: "enemy:storyvore:2",
        kind: "reversal_without_falling",
      }),
    ]);
    expect(JSON.stringify(classification)).not.toMatch(
      /accepted|diagnosis|root.?cause|correct|verified/iu,
    );
  });
});

describe("M7 sensor freeze and hidden mutation ordering", () => {
  it("rejects mutation-before-freeze and makes both records create-once", () => {
    const store = createM7SensorFreezeStoreV1();
    expect(() => store.registerMutation(registerInput())).toThrow(
      /frozen before mutation/iu,
    );

    const freeze = store.createFreeze(freezeInput());
    expect(Object.isFrozen(freeze)).toBe(true);
    expect(Object.isFrozen(freeze.sensor)).toBe(true);
    expect(() => store.createFreeze(freezeInput())).toThrow(/create-once/iu);

    const registration = store.registerMutation(registerInput());
    expect(registration.sensorFreezeId).toBe(freeze.sensorFreezeId);
    expect(registration.mutatedSourceId).not.toBe(
      freeze.pristineSubject.sourceId,
    );
    expect(() => store.registerMutation(registerInput())).toThrow(
      /create-once/iu,
    );
    expect(M7HiddenMutationRegistrationV1Schema.parse(registration)).toEqual(
      registration,
    );

    const serialized = JSON.stringify(registration);
    expect(serialized).not.toMatch(
      /storyvore|left.?ray|right.?ray|ray.?cast|collision.?mask|\.tscn/iu,
    );
  });

  it("rechecks all frozen bytes and the exact mutation at registration", () => {
    const store = createM7SensorFreezeStoreV1();
    store.createFreeze(freezeInput());
    expect(() =>
      store.registerMutation({
        ...registerInput(),
        sensorMaterials: {
          ...materials(),
          classifierImplementationBytes: "changed generic classifier\n",
        },
      }),
    ).toThrow(/material changed/iu);

    const secondStore = createM7SensorFreezeStoreV1();
    secondStore.createFreeze(freezeInput());
    expect(() =>
      secondStore.registerMutation({
        ...registerInput(),
        mutationBytes: hiddenMutation.replace(
          "+collision_mask = 1",
          "+collision_mask = 2",
        ),
      }),
    ).toThrow(/pre-registered mutation/iu);
  });

  it("rejects Bug-specific public sensor bytes and detects record tampering", () => {
    const store = createM7SensorFreezeStoreV1();
    expect(() =>
      store.createFreeze(
        freezeInput({
          ...materials(),
          observationSchemaBytes: "name left_ray_colliding\n",
        }),
      ),
    ).toThrow(/implementation-specific vocabulary/iu);

    const freeze = createM7SensorFreezeStoreV1().createFreeze(freezeInput());
    const tampered = JSON.parse(JSON.stringify(freeze)) as Record<
      string,
      unknown
    >;
    const subject = tampered.pristineSubject as Record<string, unknown>;
    subject.selectedTreeSha256 = sha("tampered tree");
    expect(M7SensorFreezeRecordV1Schema.safeParse(tampered).success).toBe(
      false,
    );
  });

  it("projects only frozen generic sensor identity to an Agent", () => {
    const freeze = createM7SensorFreezeStoreV1().createFreeze(freezeInput());
    const projection = createM7SensorAgentProjectionV1(freeze);
    const serialized = JSON.stringify(projection);
    expect(serialized).toContain("generic-patrol");
    expect(serialized).not.toMatch(
      /storyvore|left.?ray|right.?ray|ray.?cast|collision.?mask|source.?path|node.?path|\bfix\b/iu,
    );
    expect(serialized).not.toContain(M7_MODDABLE_PLATFORMER_REVISION_V1);
  });
});

const runReceipt = (
  subject: "pristine" | "mutant",
  scenario: M7PatrolScenarioV1,
): M7PatrolPreflightRunReceiptV1 => ({
  schemaVersion: 1,
  subject,
  scenarioId: scenario.scenarioId,
  observation:
    subject === "pristine" || scenario.scenarioClass === "regression_control"
      ? "expected_motion_observed"
      : "expected_motion_not_observed",
  freshWorkspaceCreated: true,
  freshImportCacheCreated: true,
  freshProcessStarted: true,
  agentLaunchCount: 0,
  observationSha256: sha(`${subject}\0${scenario.scenarioId}`),
  cleanupProven: true,
});

describe("M7 patrol 3x3 preflight plan", () => {
  it("freezes exactly three public, hidden, and regression scenarios", () => {
    expect(M7_PATROL_SCENARIO_PLAN_V1).toHaveLength(9);
    expect(M7_PATROL_SCENARIO_PLAN_SHA256_V1).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      M7_PATROL_SCENARIO_PLAN_V1.map((entry) => entry.scenarioClass),
    ).toEqual([
      "public_reproduction",
      "public_reproduction",
      "public_reproduction",
      "hidden_variant",
      "hidden_variant",
      "hidden_variant",
      "regression_control",
      "regression_control",
      "regression_control",
    ]);
    expect(
      M7_PATROL_SCENARIO_PLAN_V1.slice(0, 3).every(
        (entry) =>
          entry.startDirection === "left" &&
          entry.platformProfile === "standard" &&
          !entry.fallOffEdge,
      ),
    ).toBe(true);
    expect(
      M7_PATROL_SCENARIO_PLAN_V1.slice(3, 6).every(
        (entry) => entry.startDirection === "right" && !entry.fallOffEdge,
      ),
    ).toBe(true);
    expect(
      M7_PATROL_SCENARIO_PLAN_V1.slice(6).every(
        (entry) =>
          entry.fallOffEdge &&
          entry.expectedMotion === "leaves_support_and_descends",
      ),
    ).toBe(true);
  });

  it("passes only pristine 9/9, mutant public+hidden 0/6, regression 3/3", () => {
    const runs = (["pristine", "mutant"] as const).flatMap((subject) =>
      M7_PATROL_SCENARIO_PLAN_V1.map((scenario) =>
        runReceipt(subject, scenario),
      ),
    );
    const result = createM7PatrolPreflightResultV1({
      sensorFreezeId: `m7-sensor-freeze:${"a".repeat(24)}`,
      mutationRegistrationId: `m7-mutation:${"b".repeat(24)}`,
      runs,
      completedAt: "2026-08-15T01:00:00.000Z",
    });
    expect(result.outcome).toBe("passed");
    expect(result.summary).toEqual({
      plannedRunCount: 18,
      receivedRunCount: 18,
      pristineExpectedMotionObserved: 9,
      mutantPublicExpectedMotionObserved: 0,
      mutantHiddenExpectedMotionObserved: 0,
      mutantRegressionExpectedMotionObserved: 3,
      infrastructureFailures: 0,
      realizationFailures: 0,
      cleanupFailures: 0,
    });

    const failed = createM7PatrolPreflightResultV1({
      sensorFreezeId: result.sensorFreezeId,
      mutationRegistrationId: result.mutationRegistrationId,
      runs: runs.map((run, index) =>
        index === 9
          ? { ...run, observation: "expected_motion_observed" as const }
          : run,
      ),
      completedAt: "2026-08-15T01:01:00.000Z",
    });
    expect(failed.outcome).toBe("preflight_failed");
    expect(failed.summary.mutantPublicExpectedMotionObserved).toBe(1);
  });

  it("rejects duplicate runs and incomplete runs become a retained failure", () => {
    const first = runReceipt("pristine", M7_PATROL_SCENARIO_PLAN_V1[0]!);
    expect(() =>
      createM7PatrolPreflightResultV1({
        sensorFreezeId: `m7-sensor-freeze:${"a".repeat(24)}`,
        mutationRegistrationId: `m7-mutation:${"b".repeat(24)}`,
        runs: [first, first],
        completedAt: "2026-08-15T01:00:00.000Z",
      }),
    ).toThrow(/repeats/iu);

    const incomplete = createM7PatrolPreflightResultV1({
      sensorFreezeId: `m7-sensor-freeze:${"a".repeat(24)}`,
      mutationRegistrationId: `m7-mutation:${"b".repeat(24)}`,
      runs: [M7PatrolPreflightRunReceiptV1Schema.parse(first)],
      completedAt: "2026-08-15T01:00:00.000Z",
    });
    expect(incomplete.outcome).toBe("preflight_failed");
    expect(incomplete.summary.receivedRunCount).toBe(1);
  });
});
