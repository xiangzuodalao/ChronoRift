import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ProjectAdapterManifestV2Schema,
  ProjectAdapterPayloadSchemaDocumentV2Schema,
  type GodotProjectEnvironmentObservationRecordV2,
} from "@chronorift/godot-protocol";

import {
  ProjectAdapterObservationExecutionValidatorV2,
  recognizeProjectAdapterDynamicTracesV2,
} from "./project-adapter-observation-v2.js";
import type { LoadedProjectAdapterPackageV2 } from "./project-adapter-package-v2.js";

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
] as const;
const schema = (schemaId: string, root: unknown) =>
  ProjectAdapterPayloadSchemaDocumentV2Schema.parse({
    schemaVersion: 2,
    dialect: "chronorift://schemas/project-adapter-payload/v2",
    schemaId,
    root,
  });
const schemas = [
  schema("launch", {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  }),
  schema("entity.enemy", {
    type: "object",
    properties: { name: { type: "string", minLength: 1, maxLength: 32 } },
    required: ["name"],
    additionalProperties: false,
  }),
  schema("state.enemy", {
    type: "object",
    properties: {
      hp: { type: "integer", minimum: 0, maximum: 10 },
      target: { $ref: "chronorift://intrinsic/entity-ref/v2" },
    },
    required: ["hp", "target"],
    additionalProperties: false,
  }),
  schema("event.changed", {
    type: "object",
    properties: { phase: { type: "string", enum: ["signal"] } },
    required: ["phase"],
    additionalProperties: false,
  }),
] as const;
const manifest = ProjectAdapterManifestV2Schema.parse({
  schemaVersion: 2,
  manifestKind: "chronorift-project-adapter",
  adapterId: "adapter.dynamic",
  adapterVersion: "1.0.0",
  sdk: { id: "chronorift-project-adapter-sdk", version: 2 },
  engine: { id: "godot", versionRequirement: "4.7.x", language: "gdscript" },
  entryScript: "src/project_adapter.gd",
  schemas: schemas.map((value, index) => ({
    schemaVersion: 2,
    schemaId: value.schemaId,
    path: `schemas/${index}.json`,
    sha256: String(index).repeat(64),
  })),
  launchTargets: [
    {
      schemaVersion: 2,
      targetId: "main",
      scene: "res://main.tscn",
      default: true,
      parametersSchemaId: "launch",
      renderer: "headless",
      requiredModules: [...modules],
    },
  ],
  modules: {
    schemaVersion: 1,
    modules: modules.map((module) => ({
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
    minimumEntityLifecycleRecords: 3,
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
});
const loaded: LoadedProjectAdapterPackageV2 = {
  schemaVersion: 2,
  candidateSha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
  manifest,
  schemas,
  files: [],
  totalBytes: 1,
};
const executionId = "execution.v2.test";
const ref = (incarnation: number) => ({
  schemaVersion: 2 as const,
  executionId,
  entityId: "enemy.alpha",
  incarnation,
});
const clock = (sequence: number) => ({
  processFrame: sequence,
  physicsTick: sequence,
  simulationTimeUs: sequence * 1_000,
  renderFrame: null,
});
const record = (
  recordSequence: number,
  kind: string,
  payload: unknown,
): GodotProjectEnvironmentObservationRecordV2 =>
  ({
    schemaVersion: 2,
    executionId,
    recordSequence,
    clock: clock(recordSequence),
    kind,
    payload,
  }) as GodotProjectEnvironmentObservationRecordV2;
const entityRefValue = (incarnation: number) => ({
  $type: "entity_ref",
  ...ref(incarnation),
});
const trace = (): GodotProjectEnvironmentObservationRecordV2[] => [
  record(0, "entity_lifecycle", {
    phase: "appeared",
    entity: ref(1),
    entityTypeId: "enemy",
    identityScope: "spawn_lineage",
    projection: { name: "alpha" },
  }),
  record(1, "state_sample", {
    stateDomainId: "enemy",
    subjectEntity: ref(1),
    value: { hp: 10, target: entityRefValue(1) },
    semanticCoverage: "declared",
  }),
  record(2, "adapter_event", {
    eventTypeId: "changed",
    sourceEntity: ref(1),
    value: { phase: "signal" },
  }),
  record(3, "state_sample", {
    stateDomainId: "enemy",
    subjectEntity: ref(1),
    value: { hp: 9, target: entityRefValue(1) },
    semanticCoverage: "declared",
  }),
  record(4, "entity_lifecycle", {
    phase: "disappeared",
    entity: ref(1),
    entityTypeId: "enemy",
    identityScope: "spawn_lineage",
    projection: null,
  }),
  record(5, "entity_lifecycle", {
    phase: "appeared",
    entity: ref(2),
    entityTypeId: "enemy",
    identityScope: "spawn_lineage",
    projection: { name: "alpha" },
  }),
  record(6, "state_sample", {
    stateDomainId: "enemy",
    subjectEntity: ref(2),
    value: { hp: 10, target: entityRefValue(2) },
    semanticCoverage: "declared",
  }),
  record(7, "adapter_event", {
    eventTypeId: "changed",
    sourceEntity: ref(2),
    value: { phase: "signal" },
  }),
  record(8, "state_sample", {
    stateDomainId: "enemy",
    subjectEntity: ref(2),
    value: { hp: 8, target: entityRefValue(2) },
    semanticCoverage: "declared",
  }),
];

describe("ProjectAdapterObservationExecutionValidatorV2", () => {
  it("validates and recognizes the complete dynamic trace", () => {
    const validator = new ProjectAdapterObservationExecutionValidatorV2(
      loaded,
      executionId,
    );
    const records = trace().map((value) => validator.validate(value));
    expect(recognizeProjectAdapterDynamicTracesV2(loaded, records)).toEqual([
      expect.objectContaining({
        traceId: "enemy-reuse",
        entityId: "enemy.alpha",
        firstIncarnation: 1,
        lastIncarnation: 2,
      }),
    ]);
    expect(
      createHash("sha256").update(JSON.stringify(records)).digest("hex"),
    ).toHaveLength(64);
  });

  it.each([
    [
      "duplicate active",
      (records: GodotProjectEnvironmentObservationRecordV2[]) => {
        records[1] = record(1, "entity_lifecycle", {
          phase: "appeared",
          entity: ref(1),
          entityTypeId: "enemy",
          identityScope: "spawn_lineage",
          projection: { name: "alpha" },
        });
      },
    ],
    [
      "skipped incarnation",
      (records: GodotProjectEnvironmentObservationRecordV2[]) => {
        records[5] = record(5, "entity_lifecycle", {
          phase: "appeared",
          entity: ref(3),
          entityTypeId: "enemy",
          identityScope: "spawn_lineage",
          projection: { name: "alpha" },
        });
      },
    ],
    [
      "stale state",
      (records: GodotProjectEnvironmentObservationRecordV2[]) => {
        records[6] = record(6, "state_sample", {
          stateDomainId: "enemy",
          subjectEntity: ref(1),
          value: { hp: 10, target: entityRefValue(1) },
          semanticCoverage: "declared",
        });
      },
    ],
    [
      "state before appeared",
      (records: GodotProjectEnvironmentObservationRecordV2[]) => {
        records[0] = record(0, "state_sample", {
          stateDomainId: "enemy",
          subjectEntity: ref(1),
          value: { hp: 10, target: entityRefValue(1) },
          semanticCoverage: "declared",
        });
      },
    ],
    [
      "event after disappeared",
      (records: GodotProjectEnvironmentObservationRecordV2[]) => {
        records[5] = record(5, "adapter_event", {
          eventTypeId: "changed",
          sourceEntity: ref(1),
          value: { phase: "signal" },
        });
      },
    ],
    [
      "unknown update",
      (records: GodotProjectEnvironmentObservationRecordV2[]) => {
        records[0] = record(0, "entity_lifecycle", {
          phase: "updated",
          entity: ref(1),
          entityTypeId: "enemy",
          identityScope: "spawn_lineage",
          projection: { name: "alpha" },
        });
      },
    ],
    [
      "unknown destroy",
      (records: GodotProjectEnvironmentObservationRecordV2[]) => {
        records[0] = record(0, "entity_lifecycle", {
          phase: "disappeared",
          entity: ref(1),
          entityTypeId: "enemy",
          identityScope: "spawn_lineage",
          projection: null,
        });
      },
    ],
    [
      "clock rollback",
      (records: GodotProjectEnvironmentObservationRecordV2[]) => {
        records[2] = {
          ...records[2]!,
          clock: { ...records[2]!.clock, processFrame: 0 },
        };
      },
    ],
    [
      "cross execution",
      (records: GodotProjectEnvironmentObservationRecordV2[]) => {
        records[2] = { ...records[2]!, executionId: "execution.v2.other" };
      },
    ],
    [
      "sequence gap",
      (records: GodotProjectEnvironmentObservationRecordV2[]) => {
        records[2] = { ...records[2]!, recordSequence: 3 };
      },
    ],
  ])("rejects and poisons %s", (_name, mutate) => {
    const records = trace();
    mutate(records);
    const validator = new ProjectAdapterObservationExecutionValidatorV2(
      loaded,
      executionId,
    );
    expect(() =>
      records.forEach((value) => validator.validate(value)),
    ).toThrow();
    expect(validator.poisoned).toBe(true);
    expect(() => validator.validate(trace()[0])).toThrow();
  });

  it("rejects a stale nested entity-ref/v2", () => {
    const records = trace();
    records[6] = record(6, "state_sample", {
      stateDomainId: "enemy",
      subjectEntity: ref(2),
      value: { hp: 10, target: entityRefValue(1) },
      semanticCoverage: "declared",
    });
    const validator = new ProjectAdapterObservationExecutionValidatorV2(
      loaded,
      executionId,
    );
    expect(() => records.forEach((value) => validator.validate(value))).toThrow(
      /stale/u,
    );
  });

  it("rejects project/entity scope mismatch and undeclared declarations", () => {
    const cases = [
      record(0, "state_sample", {
        stateDomainId: "enemy",
        subjectEntity: null,
        value: { hp: 10, target: entityRefValue(1) },
        semanticCoverage: "declared",
      }),
      record(0, "adapter_event", {
        eventTypeId: "changed",
        sourceEntity: null,
        value: { phase: "signal" },
      }),
      record(0, "entity_lifecycle", {
        phase: "appeared",
        entity: ref(1),
        entityTypeId: "undeclared",
        identityScope: "spawn_lineage",
        projection: { name: "alpha" },
      }),
    ];
    for (const value of cases) {
      const validator = new ProjectAdapterObservationExecutionValidatorV2(
        loaded,
        executionId,
      );
      expect(() => validator.validate(value)).toThrow();
      expect(validator.poisoned).toBe(true);
    }
  });

  it("rejects payload schema mismatch", () => {
    const records = trace();
    records[1] = record(1, "state_sample", {
      stateDomainId: "enemy",
      subjectEntity: ref(1),
      value: { hp: 99, target: entityRefValue(1) },
      semanticCoverage: "declared",
    });
    const validator = new ProjectAdapterObservationExecutionValidatorV2(
      loaded,
      executionId,
    );
    expect(() =>
      records.forEach((value) => validator.validate(value)),
    ).toThrow();
  });
});
