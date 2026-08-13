import { createHash } from "node:crypto";

import {
  type AdapterId,
  type ProjectCapabilityModuleNameV1,
} from "@chronorift/domain";
import {
  ProjectAdapterManifestV1Schema,
  ProjectAdapterPayloadSchemaDocumentV1Schema,
  ProjectAdapterResourceReferenceV1Schema,
} from "@chronorift/godot-protocol";

export interface ProjectAdapterReferenceTemplateFileV1 {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

/**
 * Reserved semantic identifiers used only by the structural reference
 * package. A publishable adapter must add a project-specific entity type and
 * state domain instead of presenting this placeholder projection as authored
 * project semantics.
 */
export const PROJECT_ADAPTER_REFERENCE_PLACEHOLDER_SEMANTICS_V1 = Object.freeze(
  {
    entityTypeId: "scene-root",
    entitySchemaId: "entity.scene-root",
    stateDomainId: "project",
    stateSchemaId: "state.project",
  },
);

const jsonBytes = (value: unknown): Uint8Array =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

const schemaFile = (
  path: `schemas/${string}.json`,
  raw: unknown,
): {
  readonly path: `schemas/${string}.json`;
  readonly schemaId: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
} => {
  const schema = ProjectAdapterPayloadSchemaDocumentV1Schema.parse(raw);
  const bytes = jsonBytes(schema);
  return Object.freeze({
    path,
    schemaId: schema.schemaId,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  });
};

const moduleState = (
  module: ProjectCapabilityModuleNameV1,
  status: "implemented" | "unsupported",
) =>
  Object.freeze({
    schemaVersion: 1 as const,
    module,
    status,
    protocolVersion:
      status === "implemented" ? "project-adapter-module:v1" : null,
    limitations:
      status === "implemented"
        ? []
        : ["The reference template does not implement this optional module."],
  });

const ENTRY_TEMPLATE_V1 = `extends ChronoRiftProjectAdapterV1

# This is a structural starting point. Replace the generic project projection
# with the project concepts you discovered before finalizing the candidate.
class EntityProjection extends ChronoRiftEntityProjectionV1:
\tfunc sample(current_scene: Node) -> Array:
\t\treturn [{
\t\t\t"entityId": "scene.root",
\t\t\t"entityTypeId": "scene-root",
\t\t\t"incarnation": 1,
\t\t\t"identityScope": "execution_local",
\t\t\t"projection": {"name": str(current_scene.name)},
\t\t}]


class StateProjection extends ChronoRiftStateProjectionV1:
\tfunc sample(current_scene: Node) -> Array:
\t\treturn [{
\t\t\t"stateDomainId": "project",
\t\t\t"value": {"scene_name": str(current_scene.name)},
\t\t\t"semanticCoverage": "declared",
\t\t}]


class EventProjection extends ChronoRiftEventProjectionV1:
\tfunc drain(_current_scene: Node) -> Array:
\t\treturn []


func create_modules() -> Dictionary:
\treturn {
\t\t"entity_projection": EntityProjection.new(),
\t\t"state_projection": StateProjection.new(),
\t\t"event_projection": EventProjection.new(),
\t}
`;

export const createProjectAdapterReferenceTemplateFilesV1 = (input: {
  readonly adapterId: AdapterId;
  readonly mainScene: string;
}): readonly ProjectAdapterReferenceTemplateFileV1[] => {
  const mainScene = ProjectAdapterResourceReferenceV1Schema.parse(
    input.mainScene,
  );
  const launchSchema = schemaFile("schemas/launch.params.json", {
    schemaVersion: 1,
    dialect: "chronorift://schemas/project-adapter-payload/v1",
    schemaId: "launch.params",
    root: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  });
  const entitySchema = schemaFile("schemas/entity.scene-root.json", {
    schemaVersion: 1,
    dialect: "chronorift://schemas/project-adapter-payload/v1",
    schemaId: "entity.scene-root",
    root: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 256 },
      },
      required: ["name"],
      additionalProperties: false,
    },
  });
  const stateSchema = schemaFile("schemas/state.project.json", {
    schemaVersion: 1,
    dialect: "chronorift://schemas/project-adapter-payload/v1",
    schemaId: "state.project",
    root: {
      type: "object",
      properties: {
        scene_name: { type: "string", minLength: 1, maxLength: 256 },
      },
      required: ["scene_name"],
      additionalProperties: false,
    },
  });
  const schemas = [launchSchema, entitySchema, stateSchema] as const;
  const manifest = ProjectAdapterManifestV1Schema.parse({
    schemaVersion: 1,
    manifestKind: "chronorift-project-adapter",
    adapterId: input.adapterId,
    adapterVersion: "1.0.0",
    sdk: { id: "chronorift-project-adapter-sdk", version: 1 },
    engine: {
      id: "godot",
      versionRequirement: "4.7.x",
      language: "gdscript",
    },
    entryScript: "src/project_adapter.gd",
    schemas: schemas.map((schema) => ({
      schemaVersion: 1,
      schemaId: schema.schemaId,
      path: schema.path,
      sha256: schema.sha256,
    })),
    launchTargets: [
      {
        schemaVersion: 1,
        targetId: "main",
        scene: mainScene,
        default: true,
        parametersSchemaId: "launch.params",
        renderer: "headless",
        requiredModules: [
          "lifecycle",
          "clock",
          "runtime_error",
          "entity_projection",
          "state_projection",
          "event_projection",
          "capture",
        ],
      },
    ],
    modules: {
      schemaVersion: 1,
      modules: [
        moduleState("lifecycle", "implemented"),
        moduleState("clock", "implemented"),
        moduleState("runtime_error", "implemented"),
        moduleState("entity_projection", "implemented"),
        moduleState("state_projection", "implemented"),
        moduleState("event_projection", "implemented"),
        moduleState("capture", "implemented"),
        moduleState("input_control", "unsupported"),
        moduleState("snapshot", "unsupported"),
        moduleState("restore", "unsupported"),
        moduleState("render_capture", "unsupported"),
        moduleState("alignment", "unsupported"),
      ],
    },
    entityTypes: [
      {
        schemaVersion: 1,
        entityTypeId: "scene-root",
        schemaId: "entity.scene-root",
        identityStrategy: "execution_local",
      },
    ],
    stateDomains: [
      {
        schemaVersion: 1,
        stateDomainId: "project",
        schemaId: "state.project",
        checkpointDisposition: "uncontrolled",
      },
    ],
    eventTypes: [],
    smoke: {
      schemaVersion: 1,
      targetId: "main",
      timeoutMs: 30_000,
      minimumStateSamples: 1,
      minimumEntityLifecycleRecords: 1,
      requiredStateDomainIds: ["project"],
      requiredCustomEventTypeIds: [],
    },
  });

  return Object.freeze([
    Object.freeze({
      relativePath: "templates/minimal/manifest.json",
      bytes: jsonBytes(manifest),
    }),
    Object.freeze({
      relativePath: "templates/minimal/src/project_adapter.gd",
      bytes: Buffer.from(ENTRY_TEMPLATE_V1, "utf8"),
    }),
    ...schemas.map((schema) =>
      Object.freeze({
        relativePath: `templates/minimal/${schema.path}`,
        bytes: schema.bytes,
      }),
    ),
    Object.freeze({
      relativePath: "templates/minimal/README.md",
      bytes: Buffer.from(
        "# ProjectAdapter starting point\n\nCopy this package into the candidate directory, replace its generic projection with project-specific entities, state, events, and honest optional capabilities, then recompute the SHA-256 of every changed schema in manifest.json.\n",
        "utf8",
      ),
    }),
  ]);
};
