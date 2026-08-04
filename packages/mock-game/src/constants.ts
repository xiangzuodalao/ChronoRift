export const MOCK_GAME_ADAPTER = "chronorift.mock-game";
export const MOCK_GAME_ADAPTER_VERSION = "1.0.0";
export const MOCK_GAME_SCENE = "switch-door-signal-ordering";

export const INTERACT_SWITCH_ACTION = "interact_switch";
export const SWITCH_TARGET = "switch";
export const SWITCH_ACTIVE_PATH = "switch.active";
export const SWITCH_ACTIVATED_SIGNAL = "switch.activated";
export const DOOR_OPEN_PATH = "door.open";
export const DOOR_RECEIVER_CONNECTED_PATH = "door.receiver_connected";
export const DOOR_SIGNAL_RECEIVER = "door";

export const BASELINE_DELTA_US = 16_667;
/** Kept equal to baseline: the v0.1 intervention changes only input tick. */
export const CANDIDATE_DELTA_US = BASELINE_DELTA_US;
export const SCENARIO_MAX_TICKS = 1;

export const INITIAL_RNG_STATE = 0x1a2b3c4d;
