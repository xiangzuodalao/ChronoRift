import { describe, expect, it } from "vitest";

import {
  PROJECT_ADAPTER_SDK_FILES_V1,
  PROJECT_ENVIRONMENT_BRIDGE_FILES_V1,
} from "@chronorift/godot-adapter";

import {
  assertManagedGodotProjectEnvironmentRuntimeBinding,
  createManagedGodotProjectEnvironmentRuntimeV1,
} from "./managed-godot-project-environment-runtime.js";

const adapterFiles = [
  { relativePath: "manifest.json", bytes: Buffer.from("{}\n") },
  {
    relativePath: "src/adapter.gd",
    bytes: Buffer.from("extends ChronoRiftProjectAdapterV1\n"),
  },
];

const runtime = () =>
  createManagedGodotProjectEnvironmentRuntimeV1({
    doctorVersion: "4.7.1.stable.official.a13da4feb",
    adapterFiles,
  });

describe("managed Godot Project Environment runtime", () => {
  it("keeps only stable runtime and content identities", () => {
    const value = runtime();
    expect(value.capability).toMatchObject({
      runtimeProfile: "chronorift-managed-godot-project-environment-v1",
      engineVersion: "4.7.1-stable (official)",
      protocolProfile: "chronorift-godot-project-environment-v1",
      adapterFiles: [
        { relativePath: "manifest.json" },
        { relativePath: "src/adapter.gd" },
      ],
    });
    expect(value.capability.addonFiles).toHaveLength(
      PROJECT_ENVIRONMENT_BRIDGE_FILES_V1.length +
        PROJECT_ADAPTER_SDK_FILES_V1.length,
    );
    expect(value.capability.addonHash).not.toBe(value.capability.adapterHash);
    expect(Object.keys(value.capability).sort()).toEqual(
      [
        "schemaVersion",
        "runtimeProfile",
        "engine",
        "doctorVersion",
        "engineVersion",
        "protocolProfile",
        "protocolVersion",
        "managedRuntimeId",
        "overlayHash",
        "addonHash",
        "addonFiles",
        "adapterHash",
        "adapterFiles",
      ].sort(),
    );
    expect(Object.keys(value.binding).sort()).toEqual(
      ["managedRuntimeId", "addonFiles", "adapterFiles", "overlayBytes"].sort(),
    );
  });

  it("fails closed when Task-owned adapter bytes drift", () => {
    const value = runtime();
    expect(() =>
      assertManagedGodotProjectEnvironmentRuntimeBinding(value.capability, {
        ...value.binding,
        adapterFiles: [
          ...value.binding.adapterFiles.slice(0, -1),
          {
            relativePath: "src/adapter.gd",
            bytes: Buffer.from("extends Node\n"),
          },
        ],
      }),
    ).toThrow(/binding mismatch|identity mismatch/u);
  });
});
