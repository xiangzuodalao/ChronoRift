import type { ProjectCapabilityModuleNameV1 } from "@chronorift/domain";
import type { TSchema } from "typebox";

import {
  PROJECT_ENVIRONMENT_GAME_INPUT_SCHEMAS_V1,
  validateProjectEnvironmentGameInputShapeV1,
} from "./project-environment-game-tool-inputs.js";

export const PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1 = {
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

export type ProjectEnvironmentGameToolNameV1 =
  (typeof PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1)[keyof typeof PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1];

export const PROJECT_ENVIRONMENT_GAME_TOOL_CAPABILITIES_V1 = [
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
export type ProjectEnvironmentGameToolCapabilityV1 =
  (typeof PROJECT_ENVIRONMENT_GAME_TOOL_CAPABILITIES_V1)[number];

export interface ProjectEnvironmentGameToolMetadataV1 {
  readonly name: ProjectEnvironmentGameToolNameV1;
  readonly label: string;
  readonly description: string;
  readonly capability: ProjectEnvironmentGameToolCapabilityV1;
  /** Module whose unavailable status prevents invocation, or null for Host-level tools. */
  readonly availabilityModule: ProjectCapabilityModuleNameV1 | null;
  /** Informational module that does not prevent a descriptive result. */
  readonly advisoryModule: ProjectCapabilityModuleNameV1 | null;
  readonly parameters: TSchema;
}

const definition = (
  name: ProjectEnvironmentGameToolNameV1,
  label: string,
  description: string,
  capability: ProjectEnvironmentGameToolCapabilityV1,
  availabilityModule: ProjectCapabilityModuleNameV1 | null,
  advisoryModule: ProjectCapabilityModuleNameV1 | null = null,
): ProjectEnvironmentGameToolMetadataV1 => ({
  name,
  label,
  description,
  capability,
  availabilityModule,
  advisoryModule,
  parameters: PROJECT_ENVIRONMENT_GAME_INPUT_SCHEMAS_V1[name],
});

/** Independent PE-A catalog. It intentionally does not widen frozen fixture profiles. */
export const PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1: readonly ProjectEnvironmentGameToolMetadataV1[] =
  Object.freeze([
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.capabilities,
      "Project game capabilities",
      "Reports the exact environment, adapter, runtime, module, tool, coverage, and limitation facts for this Task binding.",
      "game.capabilities.read",
      null,
    ),
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.launch,
      "Launch project runtime",
      "Launches an adapter-declared target for an exact candidate Build and reports requested and realized launch facts.",
      "game.runtime.launch",
      "lifecycle",
    ),
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.status,
      "Read project runtime status",
      "Reads lifecycle, clocks, negotiated modules, capture coverage, loss, and limitations for a task-owned runtime.",
      "game.runtime.status",
      "lifecycle",
    ),
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.stop,
      "Stop project runtime",
      "Stops a task-owned runtime, seals its execution records, and reports actual cleanup facts.",
      "game.runtime.stop",
      "lifecycle",
    ),
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.captureConfigure,
      "Configure project capture",
      'Configures bounded capture and returns realized coverage and loss. PE-A accepts channels ["entity","state","event","runtime_error"], retention {clockDomain:"process_frame",before:0,after:0}, sampling:[], and triggers:[]; then use game_capture_pin to retain one current batch.',
      "game.capture.configure",
      "capture",
    ),
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.capturePin,
      "Pin project capture",
      "Pins a bounded history window around an event, clock position, or current position and reports retained and unavailable history.",
      "game.capture.pin",
      "capture",
    ),
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.query,
      "Query project observations",
      "Queries bounded entity, state, event, clock, coverage, or runtime-error observations without interpreting why they occurred.",
      "game.state.query",
      "entity_projection",
    ),
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.input,
      "Apply project control",
      "Requests an adapter-declared control at a requested clock position and reports realized timing, quantization, and side effects.",
      "game.control.input",
      "input_control",
    ),
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.step,
      "Step project runtime",
      "Requests bounded progress in a supported clock domain and reports the realized clocks, quantization, coverage, and loss.",
      "game.control.step",
      "clock",
    ),
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.setControls,
      "Set project runtime controls",
      "Requests adapter-declared runtime control values and reports each realized value, mismatch, rejection, and known side effect.",
      "game.control.configure",
      "input_control",
    ),
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.checkpointCreate,
      "Create project checkpoint",
      "Captures declared state domains at a standard or adapter-declared barrier and reports fidelity and missing state.",
      "game.checkpoint.create",
      "snapshot",
    ),
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.checkpointRestore,
      "Restore project checkpoint",
      "Writes back compatible declared state and reports per-domain writes, failures, read-back mismatches, and side effects.",
      "game.checkpoint.restore",
      "restore",
    ),
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.fork,
      "Fork project execution",
      "Creates a task-owned branch from an authorized Build, workspace, execution, or checkpoint and records requested and realized changes.",
      "game.branch.fork",
      "snapshot",
    ),
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.traceCreate,
      "Create project control trace",
      "Creates a bounded trace from adapter-declared controls and requested clock positions with normalized resource identities.",
      "game.trace.create",
      "input_control",
    ),
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.traceReplay,
      "Replay project control trace",
      "Replays a task-owned control trace and reports realized timing, coverage, loss, incompatibility, and first observed divergence.",
      "game.trace.replay",
      "input_control",
    ),
    definition(
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.compare,
      "Compare project executions",
      "Describes bounded observable differences, alignment gaps, coverage changes, and confounders without deciding why they occurred or whether a change is correct.",
      "game.execution.compare",
      null,
      "alignment",
    ),
  ]);

export const validateProjectEnvironmentGameToolInputV1 = (
  toolName: ProjectEnvironmentGameToolNameV1,
  input: unknown,
): boolean => validateProjectEnvironmentGameInputShapeV1(toolName, input);
