import { describe, expect, it } from "vitest";

import {
  PROJECT_ADAPTER_CAPABILITY_MODULES_V1,
  PROJECT_ADAPTER_MANIFEST_KIND_V1,
  PROJECT_ADAPTER_REQUIRED_MODULES_V1,
  PROJECT_ADAPTER_SDK_ID_V1,
  ProjectAdapterManifestV1Schema,
} from "./project-environment-manifest.js";

const modules = {
  schemaVersion: 1 as const,
  modules: PROJECT_ADAPTER_CAPABILITY_MODULES_V1.map((module) => ({
    schemaVersion: 1 as const,
    module,
    status: PROJECT_ADAPTER_REQUIRED_MODULES_V1.includes(
      module as (typeof PROJECT_ADAPTER_REQUIRED_MODULES_V1)[number],
    )
      ? ("implemented" as const)
      : ("unsupported" as const),
    protocolVersion: PROJECT_ADAPTER_REQUIRED_MODULES_V1.includes(
      module as (typeof PROJECT_ADAPTER_REQUIRED_MODULES_V1)[number],
    )
      ? "project-adapter-module:v1"
      : null,
    limitations: PROJECT_ADAPTER_REQUIRED_MODULES_V1.includes(
      module as (typeof PROJECT_ADAPTER_REQUIRED_MODULES_V1)[number],
    )
      ? []
      : ["not exposed by this project"],
  })),
};

const manifest = {
  schemaVersion: 1 as const,
  manifestKind: PROJECT_ADAPTER_MANIFEST_KIND_V1,
  adapterId: "project.adapter",
  adapterVersion: "1.0.0",
  sdk: { id: PROJECT_ADAPTER_SDK_ID_V1, version: 1 as const },
  engine: {
    id: "godot" as const,
    versionRequirement: "4.7.x" as const,
    language: "gdscript" as const,
  },
  entryScript: "src/project_adapter.gd",
  schemas: [
    {
      schemaVersion: 1 as const,
      schemaId: "launch.params",
      path: "schemas/launch.json",
      sha256: "a".repeat(64),
    },
    {
      schemaVersion: 1 as const,
      schemaId: "entity.player",
      path: "schemas/entity.json",
      sha256: "b".repeat(64),
    },
    {
      schemaVersion: 1 as const,
      schemaId: "state.world",
      path: "schemas/state.json",
      sha256: "c".repeat(64),
    },
  ],
  launchTargets: [
    {
      schemaVersion: 1 as const,
      targetId: "main",
      scene: "res://main.tscn",
      default: true,
      parametersSchemaId: "launch.params",
      renderer: "headless" as const,
      requiredModules: [...PROJECT_ADAPTER_REQUIRED_MODULES_V1],
    },
  ],
  modules,
  entityTypes: [
    {
      schemaVersion: 1 as const,
      entityTypeId: "player",
      schemaId: "entity.player",
      identityStrategy: "authored" as const,
    },
  ],
  stateDomains: [
    {
      schemaVersion: 1 as const,
      stateDomainId: "world",
      schemaId: "state.world",
      checkpointDisposition: "uncontrolled" as const,
    },
  ],
  eventTypes: [],
  smoke: {
    schemaVersion: 1 as const,
    targetId: "main",
    timeoutMs: 30_000,
    minimumStateSamples: 1,
    minimumEntityLifecycleRecords: 1,
    requiredStateDomainIds: ["world"],
    requiredCustomEventTypeIds: [],
  },
};

describe("ProjectAdapter manifest V1", () => {
  it("accepts a generic single-target PE-A candidate without making it fixture-specific", () => {
    expect(ProjectAdapterManifestV1Schema.parse(manifest)).toMatchObject({
      adapterId: "project.adapter",
      launchTargets: [{ scene: "res://main.tscn" }],
    });
  });

  it("keeps multi-target manifests valid while requiring exactly one default", () => {
    const second = {
      ...manifest.launchTargets[0],
      targetId: "secondary",
      scene: "res://secondary.tscn",
      default: false,
    };
    expect(() =>
      ProjectAdapterManifestV1Schema.parse({
        ...manifest,
        launchTargets: [...manifest.launchTargets, second],
      }),
    ).not.toThrow();
    expect(() =>
      ProjectAdapterManifestV1Schema.parse({
        ...manifest,
        launchTargets: [
          manifest.launchTargets[0],
          { ...second, default: true },
        ],
      }),
    ).toThrow(/exactly one default/u);
  });

  it("rejects undeclared schema identities, unsafe paths, and missing module state", () => {
    expect(() =>
      ProjectAdapterManifestV1Schema.parse({
        ...manifest,
        stateDomains: [{ ...manifest.stateDomains[0], schemaId: "missing" }],
      }),
    ).toThrow(/not declared/u);
    expect(() =>
      ProjectAdapterManifestV1Schema.parse({
        ...manifest,
        entryScript: "../adapter.gd",
      }),
    ).toThrow();
    const missingCapture = {
      ...modules,
      modules: modules.modules.filter((module) => module.module !== "capture"),
    };
    expect(() =>
      ProjectAdapterManifestV1Schema.parse({
        ...manifest,
        modules: missingCapture,
      }),
    ).toThrow();
  });
});
