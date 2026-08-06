import {
  asBranchId,
  asCapsuleId,
  asCheckpointId,
  asComparisonId,
  asContractId,
  asEventId,
  asExecutionId,
  asFixtureId,
  asInputTraceId,
  asInterventionId,
  asRunId,
  type EvidenceCapsuleV2,
  type ExecutionId,
  type InterventionSpecV2,
  type JsonObject,
  type JsonValue,
  type V03ExecutionComparison,
  type V03ExecutionLog,
  type V03TelemetryEvent,
} from "@chronorift/domain";
import type { ClaimEvidenceContext } from "@chronorift/gamebranch";
import { describe, expect, it } from "vitest";

import {
  GODOT_CLAIM_ASSERTION_SCHEMA_IDS,
  GODOT_CLAIM_MECHANISM_IDS,
  V04_GODOT_CLAIM_ASSERTIONS,
  createGodotClaimEvidencePolicyRegistry,
  v04GodotClaimForFixture,
} from "./claim-evidence-policies.js";

const runId = asRunId("run:policy-test");
const fixtureId = asFixtureId("fixture:policy-test");
const contractId = asContractId("contract:policy-test");
const checkpointId = asCheckpointId("checkpoint:policy-test");
const traceId = asInputTraceId("trace:policy-test");
const baselineId = asExecutionId("execution:policy-baseline");

const eventBase = (executionId: ExecutionId, seq: number, tick = seq) => ({
  schemaVersion: 2 as const,
  eventId: asEventId(`event:${executionId}:${seq}`),
  executionId,
  runId,
  branchId: asBranchId(`branch:${executionId}`),
  seq,
  tick,
  simTimeUs: tick * 1_000,
});

const execution = (
  executionId: ExecutionId,
  events: readonly V03TelemetryEvent[],
  finalValues: Readonly<Record<string, JsonValue>> = {},
  frames = Math.max(events.length, 1),
): V03ExecutionLog =>
  ({
    schemaVersion: 2,
    executionId,
    runId,
    fixtureId,
    branchId: asBranchId(`branch:${executionId}`),
    contractId,
    startCheckpointId: checkpointId,
    inputTraceId: traceId,
    status: "completed",
    evaluation: { status: "pass" },
    restoreReceipt: {},
    stepReceipts: Array.from({ length: frames }, (_, tick) => ({
      requestedTick: tick,
      realizedTick: tick,
      requestedDeltaUs: 1_000,
      realizedDeltaUs: 1_000,
      appliedInputOrders: [],
      runtime: { idleFramesExecuted: 1 },
    })),
    controlReceipt: {},
    observationHealth: {},
    events,
    finalState: { values: finalValues },
    timelineDigest: "0".repeat(64),
    sealed: true,
  }) as unknown as V03ExecutionLog;

const comparison = (
  candidateExecutionId: ExecutionId,
  intervention: InterventionSpecV2,
): V03ExecutionComparison =>
  ({
    schemaVersion: 2,
    comparisonId: asComparisonId(`comparison:${candidateExecutionId}`),
    runId,
    fixtureId,
    contractId,
    baselineExecutionId: baselineId,
    candidateExecutionId,
    interventionId: asInterventionId(`intervention:${candidateExecutionId}`),
    intervention,
    baselineOutcome: "fail",
    candidateOutcome: "pass",
    comparable: true,
    blockers: [],
    firstDivergenceTick: 0,
  }) as V03ExecutionComparison;

const capsule = (
  events: readonly V03TelemetryEvent[],
  expectedPath: string,
  expectedValue: JsonValue,
  actualValue: JsonValue,
): EvidenceCapsuleV2 =>
  ({
    schemaVersion: 2,
    capsuleId: asCapsuleId("capsule:policy-test"),
    runId,
    fixtureId,
    contractId,
    baselineExecutionId: baselineId,
    checkpointId,
    eventChain: events,
    evidenceLinks: [],
    expected: {
      kind: "property_equals",
      path: expectedPath,
      value: expectedValue,
    },
    actual: { present: true, value: actualValue },
    violationSummary: "fixture contract failed",
    timelineDigest: "0".repeat(64),
    eventLossDetected: false,
    knownLimitations: [],
  }) as EvidenceCapsuleV2;

const context = (
  baselineEvents: readonly V03TelemetryEvent[],
  candidateEvents: readonly V03TelemetryEvent[],
  expectedPath: string,
  expectedValue: JsonValue,
  actualValue: JsonValue,
  intervention: InterventionSpecV2,
  finalValues: Readonly<Record<string, JsonValue>> = {},
  frames?: number,
): ClaimEvidenceContext => {
  const candidateId = candidateEvents[0]?.executionId;
  if (candidateId === undefined) throw new Error("candidate is required");
  const baseline = execution(baselineId, baselineEvents, finalValues, frames);
  const candidate = execution(
    candidateId,
    candidateEvents,
    finalValues,
    frames,
  );
  return {
    capsule: capsule(baselineEvents, expectedPath, expectedValue, actualValue),
    baselineExecution: baseline,
    comparisons: [comparison(candidateId, intervention)],
    candidateExecutions: [candidate],
    citedEventIds: [...baselineEvents, ...candidateEvents].map(
      (event) => event.eventId,
    ),
  };
};

const evaluate = (
  mechanismId: string,
  schemaId: string,
  payload: JsonObject,
  evidence: ClaimEvidenceContext,
) =>
  createGodotClaimEvidencePolicyRegistry().evaluate({
    mechanismId,
    assertion: { schemaId, payload },
    context: evidence,
  });

describe("parameterized Godot claim evidence policies", () => {
  it("maps Fixture names only at the demo/test composition boundary", () => {
    const claim = v04GodotClaimForFixture("entity-reuse");

    expect(claim).toMatchObject({
      kind: "mechanism",
      mechanismId: GODOT_CLAIM_MECHANISM_IDS.entityReuse,
      assertion: {
        schemaId: GODOT_CLAIM_ASSERTION_SCHEMA_IDS.entityReuse,
      },
    });
  });

  it("publishes all policy assertion shapes without selecting a Fixture answer", () => {
    const registry = createGodotClaimEvidencePolicyRegistry();
    const descriptors = registry.agentDescriptors();
    const byMechanism = new Map(
      descriptors.map((descriptor) => [descriptor.mechanismId, descriptor]),
    );

    expect(descriptors).toHaveLength(4);
    expect(
      descriptors.map(
        ({ policyId, policyVersion, mechanismId, assertionSchemaId }) => ({
          policyId,
          policyVersion,
          mechanismId,
          assertionSchemaId,
        }),
      ),
    ).toEqual(registry.descriptors());

    const ordering = byMechanism.get(GODOT_CLAIM_MECHANISM_IDS.signalOrdering);
    expect(ordering).toBeDefined();
    expect(ordering!.assertionSchemaId).toBe(
      GODOT_CLAIM_ASSERTION_SCHEMA_IDS.signalOrdering,
    );
    expect(ordering!.evidenceRequirements).toHaveLength(6);
    expect(ordering!.assertionFields.map((field) => field.name)).toEqual(
      Object.keys(V04_GODOT_CLAIM_ASSERTIONS.signalOrdering.payload),
    );
    expect(
      ordering!.assertionFields.find(
        (field) => field.name === "minimumDeltaTicks",
      ),
    ).toMatchObject({ type: "integer", required: true, minimum: 1 });

    const frameWindow = byMechanism.get(GODOT_CLAIM_MECHANISM_IDS.frameWindow);
    expect(frameWindow).toBeDefined();
    expect(frameWindow!.evidenceRequirements).toHaveLength(7);
    expect(frameWindow!.assertionFields.map((field) => field.name)).toEqual(
      Object.keys(V04_GODOT_CLAIM_ASSERTIONS.frameWindow.payload),
    );
    expect(
      frameWindow!.assertionFields.find(
        (field) => field.name === "runtimeControlName",
      ),
    ).toMatchObject({
      type: "string",
      allowedValues: ["fixed_fps", "physics_ticks_per_second"],
    });

    const tunneling = byMechanism.get(
      GODOT_CLAIM_MECHANISM_IDS.physicsTunneling,
    );
    expect(tunneling).toBeDefined();
    expect(tunneling!.evidenceRequirements).toHaveLength(6);
    expect(tunneling!.assertionFields.map((field) => field.name)).toEqual(
      Object.keys(V04_GODOT_CLAIM_ASSERTIONS.physicsTunneling.payload),
    );
    expect(
      tunneling!.assertionFields.find((field) => field.name === "positionAxis"),
    ).toMatchObject({
      type: "integer",
      minimum: 0,
      allowedValues: [0, 1],
    });

    const entityReuse = byMechanism.get(GODOT_CLAIM_MECHANISM_IDS.entityReuse);
    expect(entityReuse).toBeDefined();
    expect(entityReuse!.evidenceRequirements).toHaveLength(8);
    expect(entityReuse!.assertionFields.map((field) => field.name)).toEqual(
      Object.keys(V04_GODOT_CLAIM_ASSERTIONS.entityReuse.payload),
    );
    expect(
      entityReuse!.assertionFields.find(
        (field) => field.name === "discardReason",
      ),
    ).toMatchObject({
      type: "string",
      allowedValues: ["owner_destroyed", "target_missing", "stale_incarnation"],
    });

    const published = JSON.stringify(descriptors);
    expect(published).not.toContain("switch.activated");
    expect(published).not.toContain("door.open");
    expect(published).not.toContain("pooling_enabled");
    expect(
      descriptors.every(
        (descriptor) =>
          descriptor.evidenceRequirements.length > 0 &&
          new Set(descriptor.evidenceRequirements).size ===
            descriptor.evidenceRequirements.length &&
          Object.isFrozen(descriptor.evidenceRequirements),
      ),
    ).toBe(true);
  });

  it("supports ordering evidence using assertion-provided signal and paths", () => {
    const candidateId = asExecutionId("execution:signal-candidate");
    const trigger = {
      ...eventBase(baselineId, 0),
      kind: "signal" as const,
      source: "lever_custom",
      name: "lever.engaged_custom",
      arguments: [],
    };
    const failed = {
      ...eventBase(baselineId, 1),
      causedByEventId: trigger.eventId,
      kind: "signal_delivery" as const,
      source: "lever_custom",
      name: "lever.engaged_custom",
      receiver: "gate_custom",
      delivered: false,
      failureReason: "receiver_not_connected" as const,
    };
    const connected = {
      ...eventBase(baselineId, 2),
      kind: "property_changed" as const,
      path: "gate_custom.ready",
      before: false,
      after: true,
    };
    const candidateTrigger = {
      ...eventBase(candidateId, 0),
      kind: "signal" as const,
      source: "lever_custom",
      name: "lever.engaged_custom",
      arguments: [],
    };
    const delivered = {
      ...eventBase(candidateId, 1),
      causedByEventId: candidateTrigger.eventId,
      kind: "signal_delivery" as const,
      source: "lever_custom",
      name: "lever.engaged_custom",
      receiver: "gate_custom",
      delivered: true,
    };
    const opened = {
      ...eventBase(candidateId, 2),
      causedByEventId: delivered.eventId,
      kind: "property_changed" as const,
      path: "gate_custom.unlocked",
      before: false,
      after: true,
    };

    const decision = evaluate(
      GODOT_CLAIM_MECHANISM_IDS.signalOrdering,
      GODOT_CLAIM_ASSERTION_SCHEMA_IDS.signalOrdering,
      {
        signalSource: "lever_custom",
        signalName: "lever.engaged_custom",
        receiver: "gate_custom",
        receiverConnectedPath: "gate_custom.ready",
        expectedPath: "gate_custom.unlocked",
        expectedValue: true,
        inputOrder: 4,
        minimumDeltaTicks: 2,
      },
      context(
        [trigger, failed, connected],
        [candidateTrigger, delivered, opened],
        "gate_custom.unlocked",
        true,
        false,
        { kind: "shift_input", inputOrder: 4, deltaTicks: 2 },
      ),
    );

    expect(decision).toEqual({ supported: true, blockers: [] });
  });

  it("supports frame-window evidence using assertion-provided clocks and paths", () => {
    const candidateId = asExecutionId("execution:frame-candidate-custom");
    const opened = {
      ...eventBase(baselineId, 0),
      kind: "property_changed" as const,
      path: "avatar.custom_window",
      before: false,
      after: true,
    };
    const signal = {
      ...eventBase(baselineId, 1),
      causedByEventId: opened.eventId,
      kind: "signal" as const,
      source: "avatar_custom",
      name: "avatar_custom.left_surface",
      arguments: [],
    };
    const closed = {
      ...eventBase(baselineId, 2),
      kind: "property_changed" as const,
      path: "avatar.custom_window",
      before: true,
      after: false,
    };
    const rejected = {
      ...eventBase(baselineId, 3),
      kind: "input" as const,
      order: 3,
      action: "custom_jump",
      payload: {},
      requestedTick: 3,
      realizedTick: 3,
    };
    const candidateOpened = {
      ...eventBase(candidateId, 0),
      kind: "property_changed" as const,
      path: "avatar.custom_window",
      before: false,
      after: true,
    };
    const accepted = {
      ...eventBase(candidateId, 1),
      kind: "input" as const,
      order: 3,
      action: "custom_jump",
      payload: {},
      requestedTick: 1,
      realizedTick: 1,
    };
    const jumped = {
      ...eventBase(candidateId, 2),
      causedByEventId: accepted.eventId,
      kind: "property_changed" as const,
      path: "avatar.airborne_custom",
      before: false,
      after: true,
    };

    const decision = evaluate(
      GODOT_CLAIM_MECHANISM_IDS.frameWindow,
      GODOT_CLAIM_ASSERTION_SCHEMA_IDS.frameWindow,
      {
        signalSource: "avatar_custom",
        signalName: "avatar_custom.left_surface",
        windowPath: "avatar.custom_window",
        windowOpenValue: true,
        windowClosedValue: false,
        processCallbacksPath: "avatar.custom_callbacks",
        inputAction: "custom_jump",
        expectedPath: "avatar.airborne_custom",
        expectedValue: true,
        baselineActualValue: false,
        runtimeControlName: "fixed_fps",
      },
      context(
        [opened, signal, closed, rejected],
        [candidateOpened, accepted, jumped],
        "avatar.airborne_custom",
        true,
        false,
        { kind: "set_runtime_control", name: "fixed_fps", value: 72 },
        { "avatar.custom_callbacks": 4 },
        4,
      ),
    );

    expect(decision.supported).toBe(true);
  });

  it("supports crossing evidence using assertion-provided entity, axis, and control", () => {
    const candidateId = asExecutionId("execution:physics-candidate-custom");
    const signal = {
      ...eventBase(baselineId, 0),
      kind: "signal" as const,
      source: "orb_source",
      name: "orb_source.launched_custom",
      arguments: [],
    };
    const movement = {
      ...eventBase(baselineId, 1),
      causedByEventId: signal.eventId,
      kind: "property_changed" as const,
      path: "orb.custom_y",
      before: 0,
      after: 20,
    };
    const sample = {
      ...eventBase(baselineId, 2),
      causedByEventId: movement.eventId,
      kind: "spatial_sample" as const,
      entity: { stableId: "orb-stable-custom", incarnation: 1 },
      position: [5, 20] as const,
    };
    const candidateSignal = {
      ...eventBase(candidateId, 0),
      kind: "signal" as const,
      source: "orb_source",
      name: "orb_source.launched_custom",
      arguments: [],
    };
    const hitSample = {
      ...eventBase(candidateId, 1),
      causedByEventId: candidateSignal.eventId,
      kind: "spatial_sample" as const,
      entity: { stableId: "orb-stable-custom", incarnation: 1 },
      position: [5, 10] as const,
    };
    const hit = {
      ...eventBase(candidateId, 2),
      causedByEventId: hitSample.eventId,
      kind: "property_changed" as const,
      path: "boss.custom_hit",
      before: false,
      after: true,
    };

    const decision = evaluate(
      GODOT_CLAIM_MECHANISM_IDS.physicsTunneling,
      GODOT_CLAIM_ASSERTION_SCHEMA_IDS.physicsTunneling,
      {
        signalSource: "orb_source",
        signalName: "orb_source.launched_custom",
        movingEntityStableId: "orb-stable-custom",
        movementPath: "orb.custom_y",
        positionAxis: 1,
        expectedPath: "boss.custom_hit",
        expectedValue: true,
        runtimeControlName: "physics_ticks_per_second",
      },
      context(
        [signal, movement, sample],
        [candidateSignal, hitSample, hit],
        "boss.custom_hit",
        true,
        false,
        {
          kind: "set_runtime_control",
          name: "physics_ticks_per_second",
          value: 144,
        },
      ),
    );

    expect(decision.supported).toBe(true);
  });

  it("supports stale-effect evidence using assertion-provided identity and control", () => {
    const candidateId = asExecutionId("execution:entity-candidate-custom");
    const scheduled = {
      ...eventBase(baselineId, 0),
      kind: "pending_effect" as const,
      action: "scheduled" as const,
      effectId: "custom-effect",
      target: { stableId: "npc-slot-custom", incarnation: 1 },
      dueTick: 1,
    };
    const despawned = {
      ...eventBase(baselineId, 1),
      causedByEventId: scheduled.eventId,
      kind: "entity_lifecycle" as const,
      action: "despawned" as const,
      entity: { stableId: "npc-slot-custom", incarnation: 1 },
    };
    const spawned = {
      ...eventBase(baselineId, 2),
      causedByEventId: despawned.eventId,
      kind: "entity_lifecycle" as const,
      action: "spawned" as const,
      entity: { stableId: "npc-slot-custom", incarnation: 2 },
    };
    const applied = {
      ...eventBase(baselineId, 3),
      causedByEventId: spawned.eventId,
      kind: "pending_effect" as const,
      action: "applied" as const,
      effectId: "custom-effect",
      target: { stableId: "npc-slot-custom", incarnation: 1 },
      resolvedTarget: { stableId: "npc-slot-custom", incarnation: 2 },
      dueTick: 1,
    };
    const mutated = {
      ...eventBase(baselineId, 4),
      causedByEventId: applied.eventId,
      kind: "property_changed" as const,
      path: "npc.custom_hp",
      before: 50,
      after: 40,
    };
    const signal = {
      ...eventBase(baselineId, 5),
      causedByEventId: mutated.eventId,
      kind: "signal" as const,
      source: "npc_source",
      name: "npc_source.respawned_custom",
      arguments: [],
    };
    const discarded = {
      ...eventBase(candidateId, 0),
      kind: "pending_effect" as const,
      action: "discarded" as const,
      effectId: "custom-effect",
      target: { stableId: "npc-slot-custom", incarnation: 1 },
      dueTick: 1,
      reason: "owner_destroyed" as const,
    };
    const candidateSignal = {
      ...eventBase(candidateId, 1),
      causedByEventId: discarded.eventId,
      kind: "signal" as const,
      source: "npc_source",
      name: "npc_source.respawned_custom",
      arguments: [],
    };

    const decision = evaluate(
      GODOT_CLAIM_MECHANISM_IDS.entityReuse,
      GODOT_CLAIM_ASSERTION_SCHEMA_IDS.entityReuse,
      {
        respawnSignalSource: "npc_source",
        respawnSignalName: "npc_source.respawned_custom",
        entityStableId: "npc-slot-custom",
        mutationPath: "npc.custom_hp",
        expectedValue: 50,
        fixtureControlName: "reuse_custom_slots",
        fixtureControlValue: false,
        discardReason: "owner_destroyed",
      },
      context(
        [scheduled, despawned, spawned, applied, mutated, signal],
        [discarded, candidateSignal],
        "npc.custom_hp",
        50,
        40,
        {
          kind: "set_fixture_control",
          name: "reuse_custom_slots",
          value: false,
        },
      ),
    );

    expect(decision.supported).toBe(true);
  });

  it("fails closed when a required event was not cited", () => {
    const candidateId = asExecutionId("execution:citation-candidate");
    const trigger = {
      ...eventBase(baselineId, 0),
      kind: "signal" as const,
      source: "switch",
      name: "switch.activated",
      arguments: [],
    };
    const failed = {
      ...eventBase(baselineId, 1),
      causedByEventId: trigger.eventId,
      kind: "signal_delivery" as const,
      source: "switch",
      name: "switch.activated",
      receiver: "door",
      delivered: false,
      failureReason: "receiver_not_connected" as const,
    };
    const connected = {
      ...eventBase(baselineId, 2),
      kind: "property_changed" as const,
      path: "door.connected",
      before: false,
      after: true,
    };
    const candidateTrigger = {
      ...eventBase(candidateId, 0),
      kind: "signal" as const,
      source: "switch",
      name: "switch.activated",
      arguments: [],
    };
    const delivered = {
      ...eventBase(candidateId, 1),
      causedByEventId: candidateTrigger.eventId,
      kind: "signal_delivery" as const,
      source: "switch",
      name: "switch.activated",
      receiver: "door",
      delivered: true,
    };
    const changed = {
      ...eventBase(candidateId, 2),
      causedByEventId: delivered.eventId,
      kind: "property_changed" as const,
      path: "door.open",
      before: false,
      after: true,
    };
    const evidence = context(
      [trigger, failed, connected],
      [candidateTrigger, delivered, changed],
      "door.open",
      true,
      false,
      { kind: "shift_input", inputOrder: 0, deltaTicks: 1 },
    );
    const decision = evaluate(
      GODOT_CLAIM_MECHANISM_IDS.signalOrdering,
      GODOT_CLAIM_ASSERTION_SCHEMA_IDS.signalOrdering,
      {
        signalSource: "switch",
        signalName: "switch.activated",
        receiver: "door",
        receiverConnectedPath: "door.connected",
        expectedPath: "door.open",
        expectedValue: true,
        inputOrder: 0,
        minimumDeltaTicks: 1,
      },
      { ...evidence, citedEventIds: evidence.citedEventIds.slice(1) },
    );

    expect(decision.supported).toBe(false);
    expect(decision.blockers).not.toHaveLength(0);
  });
});
