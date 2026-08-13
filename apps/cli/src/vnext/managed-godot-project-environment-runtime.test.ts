import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1,
  PROJECT_ADAPTER_SDK_FILES_V1,
  PROJECT_ENVIRONMENT_BRIDGE_FILES_V1,
} from "@chronorift/godot-adapter";

import {
  assertManagedGodotProjectEnvironmentRuntimeBinding,
  createManagedGodotProjectEnvironmentRuntimeV1,
} from "./managed-godot-project-environment-runtime.js";
import { inspectSandboxToolchain } from "./sandbox-toolchain.js";

const runtime = async () => {
  const toolchain = await inspectSandboxToolchain({
    lddPath: "/host/ldd",
    commands: [
      { target: "/opt/node/bin/node", hostPath: "/host/node" },
      { target: "/opt/godot/godot", hostPath: "/host/godot" },
    ],
    runtimeExecutableFiles: [
      { target: "/bin/sh", hostPath: "/host/busybox" },
      { target: "/usr/bin/xdg-user-dir", hostPath: "/host/xdg-user-dir" },
    ],
    inspection: {
      inspectCommand: async (command) => ({
        target: command.target,
        canonicalHostPath: command.hostPath,
        bytes: Buffer.from(command.target),
        dependencies: [
          {
            target: "/lib64/ld-linux-x86-64.so.2",
            canonicalHostPath: "/host/loader",
            bytes: Buffer.from("loader"),
          },
        ],
      }),
      inspectExecutableFile: async (file) => ({
        target: file.target,
        canonicalHostPath: file.hostPath,
        bytes: Buffer.from(file.target),
      }),
    },
  });
  return createManagedGodotProjectEnvironmentRuntimeV1({
    doctorVersion: "4.7.1.stable.official.a13da4feb",
    nodeTarget: "/opt/node/bin/node",
    godotTarget: "/opt/godot/godot",
    toolchain,
    vanillaSidecarSource: "vanilla-sidecar",
    projectEnvironmentSidecarSource: "project-environment-sidecar",
    adapterFiles: [
      { relativePath: "manifest.json", bytes: Buffer.from("{}\n") },
      {
        relativePath: "src/adapter.gd",
        bytes: Buffer.from("extends ChronoRiftProjectAdapterV1\n"),
      },
    ],
  });
};

describe("managed Godot Project Environment runtime", () => {
  it("freezes bridge, SDK, adapter, overlay and toolchain as distinct roles", async () => {
    const value = await runtime();
    expect(value.capability).toMatchObject({
      runtimeProfile: "chronorift-managed-godot-project-environment-v1",
      engineVersion: "4.7.1-stable (official)",
      addonTarget:
        DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAddonRoot,
      adapterTarget:
        DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAdapterRoot,
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
  });

  it("fails closed when Task-owned adapter bytes drift", async () => {
    const value = await runtime();
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
