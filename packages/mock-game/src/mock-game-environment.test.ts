import type {
  EnvironmentSnapshot,
  V01EnvironmentEventDraft,
} from "@chronorift/domain";
import type {
  FrameCommand,
  FrameObservation,
  GameEnvironmentPort,
} from "@chronorift/gamebranch";
import { describe, expect, it } from "vitest";

import {
  BASELINE_DELTA_US,
  DOOR_OPEN_PATH,
  DOOR_RECEIVER_CONNECTED_PATH,
  INTERACT_SWITCH_ACTION,
  SWITCH_ACTIVE_PATH,
  SWITCH_TARGET,
} from "./constants.js";
import {
  MockGameEnvironmentFactory,
  MOCK_GAME_ENVIRONMENT_REF,
} from "./mock-game-environment.js";
import { buildMockSwitchDoorScenario } from "./scenario.js";

const interactionInput = {
  localId: "input:interact-switch",
  order: 0,
  action: INTERACT_SWITCH_ACTION,
  target: SWITCH_TARGET,
  payload: {},
} as const;

const eventKey = (event: V01EnvironmentEventDraft): string => {
  switch (event.kind) {
    case "property_changed":
      return `${event.kind}:${event.path}`;
    case "signal":
      return `${event.kind}:${event.name}`;
    case "signal_delivery":
      return `${event.kind}:${event.delivered ? "delivered" : (event.failureReason ?? "failed")}`;
    case "log":
      return `${event.kind}:${event.message}`;
  }
};

const createRestoredEnvironment = async (): Promise<GameEnvironmentPort> => {
  const scenario = buildMockSwitchDoorScenario();
  const environment = await new MockGameEnvironmentFactory().create(
    scenario.environment,
  );
  const receipt = await environment.restore(
    scenario.initialCheckpointContent.snapshot,
  );
  expect(receipt).toMatchObject({
    restored: true,
    nextTick: 0,
    simTimeUs: 0,
    state: {
      values: {
        [SWITCH_ACTIVE_PATH]: false,
        [DOOR_OPEN_PATH]: false,
        [DOOR_RECEIVER_CONNECTED_PATH]: false,
      },
    },
  });
  return environment;
};

const runTwoFrames = async (
  deltaUs: number,
  inputTick: 0 | 1,
): Promise<{
  readonly observations: readonly FrameObservation[];
  readonly snapshot: EnvironmentSnapshot;
}> => {
  const environment = await createRestoredEnvironment();
  const observations: FrameObservation[] = [];
  let simTimeUs = 0;

  for (let tick = 0; tick < 2; tick += 1) {
    const observation = await environment.step({
      tick,
      simTimeUs,
      deltaUs,
      inputs: tick === inputTick ? [interactionInput] : [],
    });
    observations.push(observation);
    simTimeUs += deltaUs;
  }

  const snapshot = await environment.snapshot();
  await environment.dispose();
  return { observations, snapshot };
};

describe("MockGameEnvironment", () => {
  it("uses a stable content-addressed input trace", () => {
    const first = buildMockSwitchDoorScenario().trace.inputTraceId;
    const second = buildMockSwitchDoorScenario().trace.inputTraceId;
    expect(first).toBe(second);
    expect(first).toMatch(/^trace:sha256:[a-f0-9]{64}$/u);
  });

  it("emits but cannot deliver the tick-0 signal before receiver initialization", async () => {
    const environment = await createRestoredEnvironment();

    const observation = await environment.step({
      tick: 0,
      simTimeUs: 0,
      deltaUs: BASELINE_DELTA_US,
      inputs: [interactionInput],
    });

    expect(observation.events.map(eventKey)).toEqual([
      `property_changed:${SWITCH_ACTIVE_PATH}`,
      "signal:switch.activated",
      "signal_delivery:receiver_not_connected",
      `property_changed:${DOOR_RECEIVER_CONNECTED_PATH}`,
    ]);
    const [property, signal, delivery, connection] = observation.events;
    expect(property?.causedByLocalId).toBe(interactionInput.localId);
    expect(signal?.causedByLocalId).toBe(property?.localId);
    expect(delivery?.causedByLocalId).toBe(signal?.localId);
    expect(connection?.causedByLocalId).toBeUndefined();
    expect(observation.state.values).toEqual({
      [SWITCH_ACTIVE_PATH]: true,
      [DOOR_OPEN_PATH]: false,
      [DOOR_RECEIVER_CONNECTED_PATH]: true,
    });
    expect(observation.receipt).toEqual({
      requestedTick: 0,
      realizedTick: 0,
      requestedDeltaUs: BASELINE_DELTA_US,
      realizedDeltaUs: BASELINE_DELTA_US,
      appliedInputOrders: [0],
    });

    await environment.dispose();
  });

  it("does not replay the missed signal after the receiver connects", async () => {
    const result = await runTwoFrames(BASELINE_DELTA_US, 0);

    expect(result.observations[1]?.events).toEqual([]);
    expect(result.snapshot.state.values[DOOR_OPEN_PATH]).toBe(false);
    expect(result.snapshot.pendingEffects).toEqual({
      receiverInitializationPending: false,
    });
  });

  it("opens the door when only the interaction is delayed by one tick", async () => {
    const result = await runTwoFrames(BASELINE_DELTA_US, 1);

    expect(result.observations[0]?.events.map(eventKey)).toEqual([
      `property_changed:${DOOR_RECEIVER_CONNECTED_PATH}`,
    ]);
    expect(result.observations[1]?.events.map(eventKey)).toEqual([
      `property_changed:${SWITCH_ACTIVE_PATH}`,
      "signal:switch.activated",
      "signal_delivery:delivered",
      `property_changed:${DOOR_OPEN_PATH}`,
    ]);
    expect(result.snapshot.state.values).toEqual({
      [SWITCH_ACTIVE_PATH]: true,
      [DOOR_OPEN_PATH]: true,
      [DOOR_RECEIVER_CONNECTED_PATH]: true,
    });
  });

  it("is insensitive to frame delta for the same tick-0 input", async () => {
    const baseline = await runTwoFrames(BASELINE_DELTA_US, 0);
    const alternate = await runTwoFrames(16_000, 0);

    expect(baseline.snapshot.state.values[DOOR_OPEN_PATH]).toBe(false);
    expect(alternate.snapshot.state.values[DOOR_OPEN_PATH]).toBe(false);
    expect(
      baseline.observations.flatMap((observation) =>
        observation.events.map(eventKey),
      ),
    ).toEqual(
      alternate.observations.flatMap((observation) =>
        observation.events.map(eventKey),
      ),
    );
  });

  it("restores connection state, pending initialization, time, and RNG", async () => {
    const original = await createRestoredEnvironment();
    await original.step({
      tick: 0,
      simTimeUs: 0,
      deltaUs: BASELINE_DELTA_US,
      inputs: [],
    });
    const checkpoint = await original.snapshot();

    expect(checkpoint).toMatchObject({
      state: {
        values: {
          [SWITCH_ACTIVE_PATH]: false,
          [DOOR_OPEN_PATH]: false,
          [DOOR_RECEIVER_CONNECTED_PATH]: true,
        },
      },
      runtimeState: { nowUs: 16_667, nextTick: 1 },
      pendingEffects: { receiverInitializationPending: false },
      rngState: { state: 3_388_403_996 },
    });

    const nextCommand: FrameCommand = {
      tick: 1,
      simTimeUs: 16_667,
      deltaUs: BASELINE_DELTA_US,
      inputs: [interactionInput],
    };
    const expectedObservation = await original.step(nextCommand);
    const expectedSnapshot = await original.snapshot();

    const restored = await new MockGameEnvironmentFactory().create(
      MOCK_GAME_ENVIRONMENT_REF,
    );
    const restoreReceipt = await restored.restore(checkpoint);
    const actualObservation = await restored.step(nextCommand);
    const actualSnapshot = await restored.snapshot();

    expect(restoreReceipt).toMatchObject({
      restored: true,
      nextTick: 1,
      simTimeUs: 16_667,
    });
    expect(actualObservation).toEqual(expectedObservation);
    expect(actualSnapshot).toEqual(expectedSnapshot);

    await original.dispose();
    await restored.dispose();
  });
});
