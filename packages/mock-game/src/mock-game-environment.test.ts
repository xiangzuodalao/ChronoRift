import type {
  EnvironmentEventDraft,
  EnvironmentSnapshot,
} from "@chronorift/domain";
import type {
  FrameCommand,
  FrameObservation,
  GameEnvironmentPort,
} from "@chronorift/gamebranch";
import { describe, expect, it } from "vitest";

import {
  BASELINE_DELTA_US,
  CANDIDATE_DELTA_US,
  DOOR_OPEN_PATH,
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

const eventKey = (event: EnvironmentEventDraft): string => {
  switch (event.kind) {
    case "property_changed":
      return `${event.kind}:${event.path}`;
    case "signal":
      return `${event.kind}:${event.name}`;
    case "log":
      return `${event.kind}:${event.message}`;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

const createRestoredEnvironment = async (): Promise<GameEnvironmentPort> => {
  const scenario = buildMockSwitchDoorScenario();
  const environment = await new MockGameEnvironmentFactory().create(
    scenario.environment,
  );
  await environment.restore(scenario.initialCheckpointContent.snapshot);
  return environment;
};

const runTwoFrames = async (
  deltaUs: number,
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
      inputs: tick === 0 ? [interactionInput] : [],
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

  it("emits the causal switch, signal, schedule, and check sequence", async () => {
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
      "log:Door open timer scheduled",
      "log:Door open timer checked",
    ]);

    const [property, signal, schedule, check] = observation.events;
    expect(property?.causedByLocalId).toBe(interactionInput.localId);
    expect(signal?.causedByLocalId).toBe(property?.localId);
    expect(schedule?.causedByLocalId).toBe(signal?.localId);
    expect(check?.causedByLocalId).toBe(schedule?.localId);
    expect(observation.state.values).toEqual({
      [SWITCH_ACTIVE_PATH]: true,
      [DOOR_OPEN_PATH]: false,
    });

    await environment.dispose();
  });

  it("keeps the door closed when 16,667 us frames skip the deadline", async () => {
    const result = await runTwoFrames(BASELINE_DELTA_US);

    expect(result.observations[0]?.state.values[DOOR_OPEN_PATH]).toBe(false);
    expect(result.observations[1]?.state.values[DOOR_OPEN_PATH]).toBe(false);
    expect(result.snapshot.state.values).toEqual({
      [SWITCH_ACTIVE_PATH]: true,
      [DOOR_OPEN_PATH]: false,
    });
    expect(result.snapshot.runtimeState).toEqual({
      nowUs: 33_334,
      nextTick: 2,
    });
    expect(result.snapshot.pendingEffects).toEqual({
      doorTimer: {
        openAtUs: 32_000,
        scheduledTick: 0,
        causedByLocalId: "mock:0:door.schedule",
      },
    });
  });

  it("opens the door when 16,000 us frames hit the deadline", async () => {
    const result = await runTwoFrames(CANDIDATE_DELTA_US);

    expect(result.observations[0]?.state.values[DOOR_OPEN_PATH]).toBe(false);
    expect(result.observations[1]?.state.values[DOOR_OPEN_PATH]).toBe(true);
    expect(result.observations[1]?.events.map(eventKey)).toEqual([
      "log:Door open timer checked",
      `property_changed:${DOOR_OPEN_PATH}`,
    ]);
    expect(result.snapshot.runtimeState).toEqual({
      nowUs: 32_000,
      nextTick: 2,
    });
    expect(result.snapshot.pendingEffects).toEqual({ doorTimer: null });
  });

  it("restores time, state, pending timer, and RNG deterministically", async () => {
    const original = await createRestoredEnvironment();
    await original.step({
      tick: 0,
      simTimeUs: 0,
      deltaUs: BASELINE_DELTA_US,
      inputs: [interactionInput],
    });
    const checkpoint = await original.snapshot();

    expect(checkpoint).toMatchObject({
      state: {
        values: {
          [SWITCH_ACTIVE_PATH]: true,
          [DOOR_OPEN_PATH]: false,
        },
      },
      runtimeState: { nowUs: 16_667, nextTick: 1 },
      pendingEffects: {
        doorTimer: {
          openAtUs: 32_000,
          scheduledTick: 0,
          causedByLocalId: "mock:0:door.schedule",
        },
      },
      rngState: { state: 3_388_403_996 },
    });

    const nextCommand: FrameCommand = {
      tick: 1,
      simTimeUs: 16_667,
      deltaUs: BASELINE_DELTA_US,
      inputs: [],
    };
    const expectedObservation = await original.step(nextCommand);
    const expectedSnapshot = await original.snapshot();

    const restored = await new MockGameEnvironmentFactory().create(
      MOCK_GAME_ENVIRONMENT_REF,
    );
    await restored.restore(checkpoint);
    const actualObservation = await restored.step(nextCommand);
    const actualSnapshot = await restored.snapshot();

    expect(actualObservation).toEqual(expectedObservation);
    expect(actualSnapshot).toEqual(expectedSnapshot);

    await original.dispose();
    await restored.dispose();
  });
});
