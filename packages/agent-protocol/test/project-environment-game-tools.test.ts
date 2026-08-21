import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1,
  PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1,
  PROJECT_ENVIRONMENT_GAME_TOOL_OUTPUT_SCHEMAS_V1,
  ProjectEnvironmentGameCapabilitiesOutputV1Schema,
  validateProjectEnvironmentGameToolInputV1,
  validateProjectEnvironmentGameToolOutputV1,
} from "../src/index.js";

const taskId = "task:pe-a";
const runtimeId = "runtime:pe-a";
const executionId = "execution:pe-a";
const buildId = "build:pe-a";
const checkpointId = "checkpoint:pe-a";
const traceId = "trace:pe-a";
const point = {
  clockDomain: "process_frame",
  position: 10,
  phase: "process_frame_end",
} as const;

const validInputs = new Map<string, unknown>([
  ["game_capabilities", { schemaVersion: 1, taskId }],
  [
    "game_launch",
    {
      schemaVersion: 1,
      taskId,
      buildId,
      launchTargetId: "main",
      parameters: { difficulty: "normal" },
    },
  ],
  ["game_status", { schemaVersion: 1, taskId, runtimeId }],
  ["game_stop", { schemaVersion: 1, taskId, runtimeId }],
  [
    "game_capture_configure",
    {
      schemaVersion: 1,
      taskId,
      runtimeId,
      profile: {
        channels: ["clock", "state.world"],
        retention: { clockDomain: "physics_tick", before: 30, after: 10 },
        sampling: [{ channelId: "state.world", every: 2 }],
        triggers: [
          {
            triggerId: "error-retention",
            kind: "runtime_error",
            referenceId: "runtime.script_error",
          },
        ],
      },
    },
  ],
  [
    "game_capture_pin",
    {
      schemaVersion: 1,
      taskId,
      runtimeId,
      anchor: { kind: "clock", point },
      before: 10,
      after: 5,
    },
  ],
  [
    "game_query",
    {
      schemaVersion: 1,
      taskId,
      executionId,
      select: "state",
      filters: {
        entityIds: ["entity:player"],
        domainIds: ["world"],
        range: { clockDomain: "process_frame", from: 0, through: 10 },
      },
      limit: 100,
    },
  ],
  [
    "game_input",
    {
      schemaVersion: 1,
      taskId,
      runtimeId,
      controlId: "player.move",
      parameters: { direction: { $type: "vector2", values: [1, 0] } },
      targetEntityId: "entity:player",
      requested: point,
    },
  ],
  [
    "game_step",
    {
      schemaVersion: 1,
      taskId,
      runtimeId,
      requested: { clockDomain: "physics_tick", count: 3 },
      barrierId: "physics_tick_end",
    },
  ],
  [
    "game_set_controls",
    {
      schemaVersion: 1,
      taskId,
      runtimeId,
      controls: [{ controlId: "simulation.speed", value: 0.5 }],
    },
  ],
  [
    "game_checkpoint_create",
    {
      schemaVersion: 1,
      taskId,
      runtimeId,
      barrierId: "process_frame_end",
      domainIds: ["world"],
    },
  ],
  [
    "game_checkpoint_restore",
    { schemaVersion: 1, taskId, runtimeId, checkpointId },
  ],
  [
    "game_fork",
    {
      schemaVersion: 1,
      taskId,
      source: { kind: "checkpoint", checkpointId },
      changes: {
        buildId,
        controls: [{ controlId: "simulation.speed", value: 1 }],
      },
    },
  ],
  [
    "game_trace_create",
    {
      schemaVersion: 1,
      taskId,
      source: { kind: "runtime", runtimeId },
      controls: [
        {
          controlId: "player.move",
          parameters: { direction: { $type: "vector2", values: [0, 1] } },
          requested: point,
        },
      ],
    },
  ],
  [
    "game_trace_replay",
    {
      schemaVersion: 1,
      taskId,
      runtimeId,
      traceId,
      maximumProgress: 600,
      clockDomain: "process_frame",
    },
  ],
  [
    "game_compare",
    {
      schemaVersion: 1,
      taskId,
      baselineExecutionId: executionId,
      candidateExecutionId: "execution:candidate",
      maxDifferences: 100,
    },
  ],
]);

const modules = [
  "lifecycle",
  "clock",
  "runtime_error",
  "entity_projection",
  "state_projection",
  "event_projection",
  "capture",
  "input_control",
  "snapshot",
  "restore",
  "render_capture",
  "alignment",
].map((module) => ({
  schemaVersion: 1,
  module,
  status: "implemented",
  protocolVersion: "chronorift.module:v1",
  limitations: [],
}));

describe("Project Environment game-tool catalog", () => {
  it("exposes the exact PE-A capture profile in Agent-facing metadata", () => {
    const capture = PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.find(
      (definition) => definition.name === "game_capture_configure",
    );
    expect(capture?.description).toContain(
      'retention {clockDomain:"process_frame",before:0,after:0}',
    );
    const parameters = capture?.parameters as unknown as {
      readonly properties?: {
        readonly profile?: { readonly description?: unknown };
      };
    };
    expect(parameters.properties?.profile?.description).toContain(
      "sampling=[]",
    );
  });

  it("publishes the fixed 16 names as an independent generic profile", () => {
    expect(PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1).toHaveLength(16);
    expect(
      PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.map((entry) => entry.name),
    ).toEqual(Object.values(PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1));
    expect(
      new Set(
        PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.map((entry) => entry.name),
      ).size,
    ).toBe(16);
  });

  it("accepts one project-neutral request and rejects unknown keys for every tool", () => {
    for (const definition of PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1) {
      const input = validInputs.get(definition.name);
      expect(
        validateProjectEnvironmentGameToolInputV1(definition.name, input),
        definition.name,
      ).toBe(true);
      expect(
        validateProjectEnvironmentGameToolInputV1(definition.name, {
          ...(input as Record<string, unknown>),
          unexpected: true,
        }),
        definition.name,
      ).toBe(false);
    }
  });

  it("uses stable declared controls instead of fixture actions", () => {
    expect(
      validateProjectEnvironmentGameToolInputV1("game_input", {
        schemaVersion: 1,
        taskId,
        runtimeId,
        controlId: "vehicle.steer",
        parameters: { strength: 0.75 },
        requested: point,
      }),
    ).toBe(true);
    expect(
      validateProjectEnvironmentGameToolInputV1("game_input", {
        schemaVersion: 1,
        taskId,
        runtimeId,
        action: "fixture_action",
        requested: point,
      }),
    ).toBe(false);
  });

  it("applies the domain canonical-value checks after TypeBox metadata", () => {
    const input = validInputs.get("game_set_controls") as Record<
      string,
      unknown
    >;
    expect(
      validateProjectEnvironmentGameToolInputV1("game_set_controls", {
        ...input,
        controls: [{ controlId: "simulation.speed", value: -0 }],
      }),
    ).toBe(false);
  });

  it("keeps the recursive tool schema aligned with the domain depth and cycle limits", () => {
    let nested: unknown = "leaf";
    for (let index = 0; index < 16; index += 1) nested = { child: nested };
    expect(
      validateProjectEnvironmentGameToolInputV1("game_set_controls", {
        schemaVersion: 1,
        taskId,
        runtimeId,
        controls: [{ controlId: "adapter.setting", value: nested }],
      }),
    ).toBe(true);

    const cyclic: { child?: unknown } = {};
    cyclic.child = cyclic;
    expect(
      validateProjectEnvironmentGameToolInputV1("game_set_controls", {
        schemaVersion: 1,
        taskId,
        runtimeId,
        controls: [{ controlId: "adapter.setting", value: cyclic }],
      }),
    ).toBe(false);
  });

  it("maps optional feature tools to capability modules without filtering them", () => {
    const modulesByTool = new Map(
      PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.map((definition) => [
        definition.name,
        definition.availabilityModule,
      ]),
    );
    expect(modulesByTool.get("game_input")).toBe("input_control");
    expect(modulesByTool.get("game_checkpoint_create")).toBe("snapshot");
    expect(modulesByTool.get("game_checkpoint_restore")).toBe("restore");
    expect(
      PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.find(
        (definition) => definition.name === "game_compare",
      ),
    ).toMatchObject({ availabilityModule: null, advisoryModule: "alignment" });
  });

  it("contains no migrated project identity or mandatory workflow", () => {
    const catalog = JSON.stringify(
      PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1,
    );
    expect(catalog).not.toMatch(/attempt_jump|timer|spawn/iu);
    expect(catalog).not.toMatch(
      /call first|only after|exactly once|must .* before|diagnos|caus|verdict|proposal|claim/iu,
    );
  });
});

describe("Project Environment game-tool outputs", () => {
  it("exports one strict schema for every fixed tool", () => {
    expect(
      Object.keys(PROJECT_ENVIRONMENT_GAME_TOOL_OUTPUT_SCHEMAS_V1).sort(),
    ).toEqual(Object.values(PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1).sort());
    for (const schema of Object.values(
      PROJECT_ENVIRONMENT_GAME_TOOL_OUTPUT_SCHEMAS_V1,
    )) {
      expect(schema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });

  it("strictly represents all module and tool availability facts", () => {
    const output = {
      schemaVersion: 1,
      taskId,
      environmentRevisionId: "environment-revision:pe-a",
      adapterRevisionId: "adapter-revision:pe-a",
      buildId,
      runtimeId: null,
      modules,
      tools: PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.map((definition) => ({
        schemaVersion: 1,
        toolName: definition.name,
        module: definition.availabilityModule,
        status: "available",
        limitations: [],
      })),
      limitations: [],
    };
    expect(
      Check(ProjectEnvironmentGameCapabilitiesOutputV1Schema, output),
    ).toBe(true);
    expect(
      Check(ProjectEnvironmentGameCapabilitiesOutputV1Schema, {
        ...output,
        tools: output.tools.slice(0, 4),
      }),
    ).toBe(true);
    expect(
      Check(ProjectEnvironmentGameCapabilitiesOutputV1Schema, {
        ...output,
        tools: [],
      }),
    ).toBe(false);
    expect(
      validateProjectEnvironmentGameToolOutputV1("game_capabilities", {
        ...output,
        tools: [
          output.tools[0],
          {
            ...output.tools[0],
            status: "unsupported_capability",
            limitations: ["not exposed"],
          },
        ],
      }),
    ).toBe(false);
    expect(
      Check(ProjectEnvironmentGameCapabilitiesOutputV1Schema, {
        ...output,
        unexpected: true,
      }),
    ).toBe(false);
  });

  it("rejects non-canonical projected query values", () => {
    const query = {
      schemaVersion: 1,
      taskId,
      executionId,
      rows: [
        {
          schemaVersion: 1,
          rowId: "row:1",
          kind: "state",
          clock: null,
          value: { speed: 1 },
        },
      ],
      nextCursor: null,
      coverage: [],
      loss: [],
      limitations: [],
    };
    expect(
      validateProjectEnvironmentGameToolOutputV1("game_query", query),
    ).toBe(true);
    expect(
      validateProjectEnvironmentGameToolOutputV1("game_query", {
        ...query,
        rows: [{ ...query.rows[0], value: -0 }],
      }),
    ).toBe(false);
  });
});
