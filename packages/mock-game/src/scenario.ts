import {
  asInputTraceId,
  asInvariantId,
  type BranchControls,
  type CheckpointContent,
  type EnvironmentRef,
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
      description: "Door opens within two ticks after switch activation",
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
      withinTicks: 2,
      inclusive: true,
    },
  };
};
