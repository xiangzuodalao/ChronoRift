import { describe, expect, it } from "vitest";

import {
  GodotProjectEnvironmentObservationBatchV2Schema,
  GodotProjectEnvironmentObservationRecordV2Schema,
  PROJECT_ADAPTER_CAPABILITY_MODULES_V2,
  ProjectAdapterEntityRefV2Schema,
  ProjectAdapterManifestV2Schema,
  validateProjectAdapterPayloadV2,
} from "./index.js";

const entity = {
  schemaVersion: 2,
  executionId: "execution.v2.test",
  entityId: "enemy.alpha",
  incarnation: 1,
} as const;

const record = (recordSequence = 0) => ({
  schemaVersion: 2,
  executionId: entity.executionId,
  recordSequence,
  clock: {
    processFrame: recordSequence,
    physicsTick: recordSequence,
    simulationTimeUs: recordSequence * 1_000,
    renderFrame: null,
  },
  kind: "entity_lifecycle",
  payload: {
    phase: "appeared",
    entity,
    entityTypeId: "enemy",
    identityScope: "spawn_lineage",
    projection: { hp: 3 },
  },
});

describe("Project Environment V2 contracts", () => {
  it("binds entity references to an execution and incarnation", () => {
    expect(ProjectAdapterEntityRefV2Schema.parse(entity)).toEqual(entity);
    expect(() =>
      ProjectAdapterEntityRefV2Schema.parse({ ...entity, executionId: "../x" }),
    ).toThrow();
    expect(() =>
      GodotProjectEnvironmentObservationRecordV2Schema.parse({
        ...record(),
        executionId: "execution.v2.other",
      }),
    ).not.toThrow();
  });

  it("rejects batch execution mixing and sequence gaps", () => {
    expect(() =>
      GodotProjectEnvironmentObservationBatchV2Schema.parse({
        schemaVersion: 2,
        executionId: entity.executionId,
        batchId: "batch.v2.0",
        firstRecordSequence: 0,
        lastRecordSequence: 1,
        records: [
          record(0),
          { ...record(1), executionId: "execution.v2.other" },
        ],
        coverage: {
          status: "complete",
          firstAvailableRecordSequence: 0,
          lastAvailableRecordSequence: 1,
          droppedRecordCount: 0,
          overwriteCount: 0,
          semanticCoverage: "declared",
        },
      }),
    ).toThrow(/execution or sequence/u);
  });

  it("requires declared entity-scoped dynamic traces", () => {
    const manifest = {
      schemaVersion: 2,
      manifestKind: "chronorift-project-adapter",
      adapterId: "adapter.dynamic",
      adapterVersion: "1.0.0",
      sdk: { id: "chronorift-project-adapter-sdk", version: 2 },
      engine: {
        id: "godot",
        versionRequirement: "4.7.x",
        language: "gdscript",
      },
      entryScript: "src/project_adapter.gd",
      schemas: [
        {
          schemaVersion: 2,
          schemaId: "launch",
          path: "schemas/launch.json",
          sha256: "a".repeat(64),
        },
        {
          schemaVersion: 2,
          schemaId: "entity.enemy",
          path: "schemas/entity.json",
          sha256: "b".repeat(64),
        },
        {
          schemaVersion: 2,
          schemaId: "state.enemy",
          path: "schemas/state.json",
          sha256: "c".repeat(64),
        },
        {
          schemaVersion: 2,
          schemaId: "event.changed",
          path: "schemas/event.json",
          sha256: "d".repeat(64),
        },
      ],
      launchTargets: [
        {
          schemaVersion: 2,
          targetId: "main",
          scene: "res://main.tscn",
          default: true,
          parametersSchemaId: "launch",
          renderer: "headless",
          requiredModules: [],
        },
      ],
      modules: {
        schemaVersion: 1,
        modules: PROJECT_ADAPTER_CAPABILITY_MODULES_V2.map((module) => ({
          schemaVersion: 1,
          module,
          status: "implemented",
          protocolVersion: "project-adapter-module:v2",
          limitations: [],
        })),
      },
      entityTypes: [
        {
          schemaVersion: 2,
          entityTypeId: "enemy",
          schemaId: "entity.enemy",
          identityStrategy: "spawn_lineage",
        },
      ],
      stateDomains: [
        {
          schemaVersion: 2,
          stateDomainId: "enemy",
          schemaId: "state.enemy",
          checkpointDisposition: "uncontrolled",
          subject: {
            schemaVersion: 2,
            kind: "entity",
            allowedEntityTypeIds: ["enemy"],
          },
        },
      ],
      eventTypes: [
        {
          schemaVersion: 2,
          eventTypeId: "changed",
          schemaId: "event.changed",
          source: {
            schemaVersion: 2,
            kind: "entity",
            allowedEntityTypeIds: ["enemy"],
          },
        },
      ],
      smoke: {
        schemaVersion: 2,
        targetId: "main",
        timeoutMs: 30_000,
        minimumStateSamples: 4,
        minimumEntityLifecycleRecords: 4,
        requiredStateDomainIds: ["enemy"],
        requiredCustomEventTypeIds: ["changed"],
        requiredDynamicTraces: [
          {
            schemaVersion: 2,
            traceId: "enemy-reuse",
            entityTypeId: "enemy",
            stateDomainId: "enemy",
            eventTypeId: "changed",
            minimumIncarnations: 2,
          },
        ],
      },
    };
    expect(ProjectAdapterManifestV2Schema.parse(manifest).schemaVersion).toBe(
      2,
    );
    expect(() =>
      ProjectAdapterManifestV2Schema.parse({
        ...manifest,
        stateDomains: [
          {
            ...manifest.stateDomains[0],
            subject: { schemaVersion: 2, kind: "project" },
          },
        ],
      }),
    ).toThrow(/dynamic trace/u);
  });

  it("validates the execution-bound entity-ref/v2 intrinsic", () => {
    const schema = {
      schemaVersion: 2,
      dialect: "chronorift://schemas/project-adapter-payload/v2",
      schemaId: "payload.ref",
      root: { $ref: "chronorift://intrinsic/entity-ref/v2" },
    };
    expect(
      validateProjectAdapterPayloadV2(schema, {
        $type: "entity_ref",
        ...entity,
      }),
    ).toMatchObject({ entityId: entity.entityId });
    expect(() =>
      validateProjectAdapterPayloadV2(schema, {
        $type: "entity_ref",
        entityId: entity.entityId,
      }),
    ).toThrow();
  });
});
