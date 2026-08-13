import { createHash } from "node:crypto";

import type {
  AdapterId,
  ProjectCapabilityModuleNameV1,
} from "@chronorift/domain";
import {
  ProjectAdapterManifestV2Schema,
  ProjectAdapterPayloadSchemaDocumentV2Schema,
  ProjectAdapterResourceReferenceV1Schema,
} from "@chronorift/godot-protocol";

export interface ProjectAdapterReferenceTemplateFileV2 {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}
export const PROJECT_ADAPTER_REFERENCE_PLACEHOLDER_SEMANTICS_V2 = Object.freeze(
  {
    entityTypeId: "dynamic-placeholder",
    stateDomainId: "dynamic-placeholder-state",
    eventTypeId: "dynamic-placeholder-event",
  },
);
const jsonBytes = (value: unknown) =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
const schema = (
  path: `schemas/${string}.json`,
  schemaId: string,
  root: unknown,
) => {
  const document = ProjectAdapterPayloadSchemaDocumentV2Schema.parse({
    schemaVersion: 2,
    dialect: "chronorift://schemas/project-adapter-payload/v2",
    schemaId,
    root,
  });
  const bytes = jsonBytes(document);
  return Object.freeze({
    path,
    schemaId,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
};
const moduleState = (
  module: ProjectCapabilityModuleNameV1,
  implemented: boolean,
) => ({
  schemaVersion: 1 as const,
  module,
  status: implemented ? ("implemented" as const) : ("unsupported" as const),
  protocolVersion: implemented ? "project-adapter-module:v2" : null,
  limitations: implemented
    ? []
    : ["The V2 reference does not implement this optional module."],
});

const ENTRY = `extends ChronoRiftProjectAdapterV2

# Structural starting point only. Replace placeholder matching and identifiers
# with project-specific semantics discovered from the source. This scaffold is
# intentionally rejected until every dynamic-placeholder declaration is gone.
var _context: ChronoRiftObservationContextV2

var _references := {}

func start(context: ChronoRiftObservationContextV2, current_scene: Node) -> Error:
\t_context = context
\tcurrent_scene.get_tree().node_added.connect(_node_added)
\t_walk(current_scene)
\treturn OK

func stop() -> void:
\tpass

func _walk(node: Node) -> void:
\t_consider(node)
\tfor child in node.get_children():
\t\t_walk(child)

func _node_added(node: Node) -> void:
\t# Deferral lets a newly added node finish its own initialization first.
\tcall_deferred("_consider", node)

func _consider(node: Node) -> void:
\t# Replace this no-op with a source-derived semantic predicate. Then call:
\t# var ref = _context.register_entity(stable_id, entity_type_id,
\t#     "spawn_lineage", node, projection)
\t# _context.emit_state(state_domain_id, ref, state_value)
\t# Connect only a Signal explicitly declared by the project and emit it with:
\t# _context.emit_event(event_type_id, ref, event_value)
\t# _context.emit_state(state_domain_id, ref, changed_state_value)
\t# Node tree exit automatically emits disappeared; the same stable_id is then
\t# assigned exactly the next incarnation by the managed context.
\tif not is_instance_valid(node):
\t\treturn
`;

export const createProjectAdapterReferenceTemplateFilesV2 = (input: {
  readonly adapterId: AdapterId;
  readonly mainScene: string;
}): readonly ProjectAdapterReferenceTemplateFileV2[] => {
  const launch = schema("schemas/launch.params.json", "launch.params", {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  });
  const entity = schema(
    "schemas/entity.dynamic-placeholder.json",
    "entity.dynamic-placeholder",
    {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    },
  );
  const state = schema(
    "schemas/state.dynamic-placeholder.json",
    "state.dynamic-placeholder",
    {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    },
  );
  const event = schema(
    "schemas/event.dynamic-placeholder.json",
    "event.dynamic-placeholder",
    {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    },
  );
  const schemas = [launch, entity, state, event];
  const required = new Set([
    "lifecycle",
    "clock",
    "runtime_error",
    "entity_projection",
    "state_projection",
    "event_projection",
    "capture",
  ]);
  const moduleNames: ProjectCapabilityModuleNameV1[] = [
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
  ];
  const manifest = ProjectAdapterManifestV2Schema.parse({
    schemaVersion: 2,
    manifestKind: "chronorift-project-adapter",
    adapterId: input.adapterId,
    adapterVersion: "2.0.0",
    sdk: { id: "chronorift-project-adapter-sdk", version: 2 },
    engine: { id: "godot", versionRequirement: "4.7.x", language: "gdscript" },
    entryScript: "src/project_adapter.gd",
    schemas: schemas.map((value) => ({
      schemaVersion: 2,
      schemaId: value.schemaId,
      path: value.path,
      sha256: value.sha256,
    })),
    launchTargets: [
      {
        schemaVersion: 2,
        targetId: "main",
        scene: ProjectAdapterResourceReferenceV1Schema.parse(input.mainScene),
        default: true,
        parametersSchemaId: "launch.params",
        renderer: "headless",
        requiredModules: [...required],
      },
    ],
    modules: {
      schemaVersion: 1,
      modules: moduleNames.map((name) => moduleState(name, required.has(name))),
    },
    entityTypes: [
      {
        schemaVersion: 2,
        entityTypeId: "dynamic-placeholder",
        schemaId: "entity.dynamic-placeholder",
        identityStrategy: "spawn_lineage",
      },
    ],
    stateDomains: [
      {
        schemaVersion: 2,
        stateDomainId: "dynamic-placeholder-state",
        schemaId: "state.dynamic-placeholder",
        checkpointDisposition: "uncontrolled",
        subject: {
          schemaVersion: 2,
          kind: "entity",
          allowedEntityTypeIds: ["dynamic-placeholder"],
        },
      },
    ],
    eventTypes: [
      {
        schemaVersion: 2,
        eventTypeId: "dynamic-placeholder-event",
        schemaId: "event.dynamic-placeholder",
        source: {
          schemaVersion: 2,
          kind: "entity",
          allowedEntityTypeIds: ["dynamic-placeholder"],
        },
      },
    ],
    smoke: {
      schemaVersion: 2,
      targetId: "main",
      timeoutMs: 30_000,
      minimumStateSamples: 4,
      minimumEntityLifecycleRecords: 3,
      requiredStateDomainIds: ["dynamic-placeholder-state"],
      requiredCustomEventTypeIds: ["dynamic-placeholder-event"],
      requiredDynamicTraces: [
        {
          schemaVersion: 2,
          traceId: "dynamic-placeholder-trace",
          entityTypeId: "dynamic-placeholder",
          stateDomainId: "dynamic-placeholder-state",
          eventTypeId: "dynamic-placeholder-event",
          minimumIncarnations: 2,
        },
      ],
    },
  });
  const files: ProjectAdapterReferenceTemplateFileV2[] = [
    {
      relativePath: "templates/minimal/manifest.json",
      bytes: jsonBytes(manifest),
    },
    {
      relativePath: "templates/minimal/src/project_adapter.gd",
      bytes: Buffer.from(ENTRY, "utf8"),
    },
    ...schemas.map((value) => ({
      relativePath: `templates/minimal/${value.path}`,
      bytes: value.bytes,
    })),
    {
      relativePath: "templates/minimal/README.md",
      bytes: Buffer.from(
        "# V2 editable starting point\n\nThis scaffold is already materialized in the candidate. Replace all placeholder semantics, explicitly connect understood project Signals, and update exact schema hashes. The Host rejects every remaining placeholder.\n",
        "utf8",
      ),
    },
  ];
  return Object.freeze(files.map((file) => Object.freeze(file)));
};
