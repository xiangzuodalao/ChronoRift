import type { TSchema } from "typebox";
import { Check } from "typebox/value";

import {
  GameCapabilitiesInputV1Schema,
  GameCaptureConfigureInputV1Schema,
  GameCapturePinInputV1Schema,
  GameCheckpointCreateInputV1Schema,
  GameCheckpointRestoreInputV1Schema,
  GameCompareInputV1Schema,
  GameForkInputV1Schema,
  GameInputInputV1Schema,
  GameLaunchInputV1Schema,
  GameQueryInputV1Schema,
  GameSetControlsInputV1Schema,
  GameStatusInputV1Schema,
  GameStepInputV1Schema,
  GameStopInputV1Schema,
  GameTraceCreateInputV1Schema,
  GameTraceReplayInputV1Schema,
} from "./vnext-game-tool-inputs.js";

export const GAME_TOOL_NAMES_V1 = {
  capabilities: "game_capabilities",
  launch: "game_launch",
  status: "game_status",
  stop: "game_stop",
  captureConfigure: "game_capture_configure",
  capturePin: "game_capture_pin",
  query: "game_query",
  input: "game_input",
  step: "game_step",
  setControls: "game_set_controls",
  checkpointCreate: "game_checkpoint_create",
  checkpointRestore: "game_checkpoint_restore",
  fork: "game_fork",
  traceCreate: "game_trace_create",
  traceReplay: "game_trace_replay",
  compare: "game_compare",
} as const;

export type GameToolNameV1 =
  (typeof GAME_TOOL_NAMES_V1)[keyof typeof GAME_TOOL_NAMES_V1];

export const GAME_TOOL_CAPABILITIES_V1 = [
  "game.capabilities.read",
  "game.runtime.launch",
  "game.runtime.status",
  "game.runtime.stop",
  "game.capture.configure",
  "game.capture.pin",
  "game.state.query",
  "game.control.input",
  "game.control.step",
  "game.control.configure",
  "game.checkpoint.create",
  "game.checkpoint.restore",
  "game.branch.fork",
  "game.trace.create",
  "game.trace.replay",
  "game.execution.compare",
] as const;

export type GameToolCapabilityV1 = (typeof GAME_TOOL_CAPABILITIES_V1)[number];

/** SDK-neutral metadata consumed by a concrete Agent tool binding. */
export interface GameToolMetadataV1 {
  readonly name: GameToolNameV1;
  readonly label: string;
  readonly description: string;
  readonly capability: GameToolCapabilityV1;
  readonly parameters: TSchema;
}

export const GAME_TOOL_DEFINITIONS_V1: readonly GameToolMetadataV1[] =
  Object.freeze([
    {
      name: GAME_TOOL_NAMES_V1.capabilities,
      label: "Game capabilities",
      description:
        "Reports task and negotiated runtime support, limits, expected operation cost, and unsupported features.",
      capability: "game.capabilities.read",
      parameters: GameCapabilitiesInputV1Schema,
    },
    {
      name: GAME_TOOL_NAMES_V1.launch,
      label: "Launch game runtime",
      description:
        "Launches a task-owned Godot runtime for a build and reports realized controls; startup, sandbox, and capability failures are structured results.",
      capability: "game.runtime.launch",
      parameters: GameLaunchInputV1Schema,
    },
    {
      name: GAME_TOOL_NAMES_V1.status,
      label: "Read game runtime status",
      description:
        "Reads lifecycle, execution, resource-cost, and observation status for a task-owned runtime.",
      capability: "game.runtime.status",
      parameters: GameStatusInputV1Schema,
    },
    {
      name: GAME_TOOL_NAMES_V1.stop,
      label: "Stop game runtime",
      description:
        "Stops a task-owned runtime, seals its execution records, and reports cleanup or process failures.",
      capability: "game.runtime.stop",
      parameters: GameStopInputV1Schema,
    },
    {
      name: GAME_TOOL_NAMES_V1.captureConfigure,
      label: "Configure game capture",
      description:
        "Requests bounded rolling capture channels, sampling, and retention triggers; realized coverage, overhead, degradation, and loss are reported.",
      capability: "game.capture.configure",
      parameters: GameCaptureConfigureInputV1Schema,
    },
    {
      name: GAME_TOOL_NAMES_V1.capturePin,
      label: "Pin game capture",
      description:
        "Pins a bounded runtime history window and reports retained coverage, overwritten history, storage cost, and availability failures.",
      capability: "game.capture.pin",
      parameters: GameCapturePinInputV1Schema,
    },
    {
      name: GAME_TOOL_NAMES_V1.query,
      label: "Query game runtime state",
      description:
        "Reads a bounded projection of execution records or the rebuildable state index with coverage, loss, ambiguity, and query cost.",
      capability: "game.state.query",
      parameters: GameQueryInputV1Schema,
    },
    {
      name: GAME_TOOL_NAMES_V1.input,
      label: "Inject game input",
      description:
        "Requests a fixture-supported input action at a tick and phase and reports its realized clock position, side effects, and injection failures.",
      capability: "game.control.input",
      parameters: GameInputInputV1Schema,
    },
    {
      name: GAME_TOOL_NAMES_V1.step,
      label: "Step game runtime",
      description:
        "Requests bounded runtime progress in one clock domain and reports realized frames, ticks, timing, observation cost, and engine limitations.",
      capability: "game.control.step",
      parameters: GameStepInputV1Schema,
    },
    {
      name: GAME_TOOL_NAMES_V1.setControls,
      label: "Set game runtime controls",
      description:
        "Requests supported frame, physics, and execution limits and reports realized values, quantization, side effects, and rejected settings.",
      capability: "game.control.configure",
      parameters: GameSetControlsInputV1Schema,
    },
    {
      name: GAME_TOOL_NAMES_V1.checkpointCreate,
      label: "Create game checkpoint",
      description:
        "Captures supported state at a semantic barrier and reports fidelity, covered and missing domains, storage cost, and capture failures.",
      capability: "game.checkpoint.create",
      parameters: GameCheckpointCreateInputV1Schema,
    },
    {
      name: GAME_TOOL_NAMES_V1.checkpointRestore,
      label: "Restore game checkpoint",
      description:
        "Restores compatible declared checkpoint state and reports validation, rejected domains, fidelity limits, and the realized runtime state.",
      capability: "game.checkpoint.restore",
      parameters: GameCheckpointRestoreInputV1Schema,
    },
    {
      name: GAME_TOOL_NAMES_V1.fork,
      label: "Fork game execution",
      description:
        "Creates a task-owned branch from an authorized resource and records requested and realized changes, lineage, cost, and compatibility failures.",
      capability: "game.branch.fork",
      parameters: GameForkInputV1Schema,
    },
    {
      name: GAME_TOOL_NAMES_V1.traceCreate,
      label: "Create game trace",
      description:
        "Creates a bounded input trace with requested tick and phase positions and reports validation, normalization, and storage cost.",
      capability: "game.trace.create",
      parameters: GameTraceCreateInputV1Schema,
    },
    {
      name: GAME_TOOL_NAMES_V1.traceReplay,
      label: "Replay game trace",
      description:
        "Replays a bounded trace in a task-owned runtime and reports realized timing, coverage, loss, divergence, cost, and runtime failures.",
      capability: "game.trace.replay",
      parameters: GameTraceReplayInputV1Schema,
    },
    {
      name: GAME_TOOL_NAMES_V1.compare,
      label: "Compare game executions",
      description:
        "Describes bounded observable differences between two task executions with alignment ambiguity, coverage gaps, confounders, and query cost.",
      capability: "game.execution.compare",
      parameters: GameCompareInputV1Schema,
    },
  ]);

/** Strict SDK-neutral validation for direct Host-side port implementations. */
export const validateGameToolInputV1 = (
  toolName: GameToolNameV1,
  input: unknown,
): boolean => {
  const definition = GAME_TOOL_DEFINITIONS_V1.find(
    (candidate) => candidate.name === toolName,
  );
  return definition !== undefined && Check(definition.parameters, input);
};
