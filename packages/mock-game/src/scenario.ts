import {
  asInputTraceId,
  asInvariantId,
  type BranchControls,
  type CheckpointContent,
  type EnvironmentRef,
  type FrozenContract,
  type InputTrace,
  type TemporalInvariant,
} from "@chronorift/domain";
import { digestJson } from "@chronorift/gamebranch";

import {
  BASELINE_DELTA_US,
  CANDIDATE_DELTA_US,
  DOOR_OPEN_PATH,
  INTERACT_SWITCH_ACTION,
  SCENARIO_MAX_TICKS,
  SWITCH_ACTIVATED_SIGNAL,
  SWITCH_TARGET,
} from "./constants.js";
import {
  createInitialMockSnapshot,
  MOCK_GAME_ENVIRONMENT_REF,
} from "./mock-game-environment.js";

export interface MockSwitchDoorScenario {
  readonly environment: EnvironmentRef;
  readonly initialCheckpointContent: CheckpointContent;
  readonly trace: InputTrace;
  readonly controls: {
    readonly baseline: BranchControls;
    readonly candidate: BranchControls;
  };
  readonly invariant: TemporalInvariant;
}

export interface V01SwitchDoorFixture {
  readonly environment: EnvironmentRef;
  readonly contractInput: Omit<FrozenContract, "contractId">;
  readonly initialCheckpointContent: CheckpointContent;
  readonly inputTrace: InputTrace;
  readonly controls: BranchControls;
}

/** The complete, serializable fixture required by the v0.1 vertical slice. */
export const buildV01SwitchDoorFixture = (): V01SwitchDoorFixture => {
  const scenario = buildMockSwitchDoorScenario();
  return {
    environment: scenario.environment,
    contractInput: {
      schemaVersion: 1,
      fixture: "switch-door",
      authority: {
        status: "frozen",
        approvedBy: "chronorift.fixture.switch-door.v0.1",
      },
      rule: {
        trigger: scenario.invariant.trigger,
        expectation: scenario.invariant.expectation,
        withinTicks: 1,
        inclusive: true,
      },
    },
    initialCheckpointContent: scenario.initialCheckpointContent,
    inputTrace: scenario.trace,
    controls: scenario.controls.baseline,
  };
};

/** A fresh serializable scenario DTO; callers may safely persist its values. */
export const buildMockSwitchDoorScenario = (): MockSwitchDoorScenario => {
  const environment: EnvironmentRef = { ...MOCK_GAME_ENVIRONMENT_REF };
  const traceContent = {
    schemaVersion: 1 as const,
    scheduleBasis: "relative_tick" as const,
    inputs: [
      {
        relativeTick: 0,
        order: 0,
        action: INTERACT_SWITCH_ACTION,
        target: SWITCH_TARGET,
        payload: {},
      },
    ],
  };
  const trace: InputTrace = {
    ...traceContent,
    inputTraceId: asInputTraceId(`trace:${digestJson(traceContent)}`),
  };

  return {
    environment,
    initialCheckpointContent: {
      schemaVersion: 1,
      environment,
      nextTick: 0,
      simTimeUs: 0,
      snapshot: createInitialMockSnapshot(),
    },
    trace,
    controls: {
      baseline: {
        deltaUs: BASELINE_DELTA_US,
        maxTicks: SCENARIO_MAX_TICKS,
        variables: {},
      },
      candidate: {
        deltaUs: CANDIDATE_DELTA_US,
        maxTicks: SCENARIO_MAX_TICKS,
        variables: {},
      },
    },
    invariant: {
      schemaVersion: 1,
      invariantId: asInvariantId("invariant:door-opens-after-switch"),
      description: "Door opens within one tick after switch activation",
      severity: "error",
      trigger: {
        kind: "signal",
        source: SWITCH_TARGET,
        name: SWITCH_ACTIVATED_SIGNAL,
      },
      expectation: {
        kind: "property_equals",
        path: DOOR_OPEN_PATH,
        value: true,
      },
      withinTicks: 1,
      inclusive: true,
    },
  };
};
