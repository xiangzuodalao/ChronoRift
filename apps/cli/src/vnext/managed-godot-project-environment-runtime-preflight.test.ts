import { describe, expect, it } from "vitest";

import { asSha256DigestV1 } from "@chronorift/domain";

import { preflightManagedGodotProjectEnvironmentRuntimeV1 } from "./managed-godot-project-environment-runtime-preflight.js";
import { ProjectEnvironmentHostConfigV1Schema } from "./project-environment-host-config.js";

const hostConfig = ProjectEnvironmentHostConfigV1Schema.parse({
  schemaVersion: 1,
  configKind: "chronorift-project-environment-host",
  taskStorageRoot: "/host/tasks",
  runtimeRoot: "/host/tasks/runtime",
  delegatedCgroupRoot: "/sys/fs/cgroup/chronorift",
  bwrapPath: "/host/bwrap",
  prlimitPath: "/host/prlimit",
  busyboxPath: "/host/busybox",
  fontconfigProbePath: "/host/fc-match",
  xdgUserDirPath: "/host/xdg-user-dir",
  nodePath: "/host/node",
  bashPath: "/host/bash",
  rgPath: "/host/rg",
  findPath: "/host/find",
  lsPath: "/host/ls",
  lddPath: "/host/ldd",
  godotToolchains: [
    {
      schemaVersion: 1,
      key: "godot-4.7.1-linux-x86_64-official",
      version: "4.7.1",
      platform: "linux-x86_64",
      channel: "stable-official",
      executablePath: "/host/godot",
      executableSha256: "a".repeat(64),
      buildFeatures: ["official", "stable"],
      renderer: "gl_compatibility",
    },
  ],
});

const godot = {
  receipt: {
    schemaVersion: 1 as const,
    registryKey: "godot-4.7.1-linux-x86_64-official" as const,
    requestedVersion: "4.7.1" as const,
    realizedVersion: "4.7.1" as const,
    realizedVersionOutput: "4.7.1.stable.official.abcdef0",
    platform: "linux-x86_64" as const,
    executableSha256: asSha256DigestV1("a".repeat(64)),
    buildFeatures: ["official", "stable"],
    renderer: "gl_compatibility" as const,
  },
  binding: { executablePath: "/host/godot" },
};

const inspection = {
  inspectCommand: async (command: {
    readonly target: string;
    readonly hostPath: string;
  }) => ({
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
  inspectExecutableFile: async (file: {
    readonly target: string;
    readonly hostPath: string;
  }) => ({
    target: file.target,
    canonicalHostPath: file.hostPath,
    bytes: Buffer.from(file.target),
  }),
};

const adapterFiles = [
  { relativePath: "manifest.json", bytes: Buffer.from("{}\n") },
  {
    relativePath: "src/adapter.gd",
    bytes: Buffer.from("extends ChronoRiftProjectAdapterV1\n"),
  },
];

describe("managed Godot Project Environment runtime preflight", () => {
  it("freezes the exact runtime, sidecars, bridge and SDK identities", async () => {
    const result = await preflightManagedGodotProjectEnvironmentRuntimeV1({
      hostConfig,
      godot,
      adapterFiles,
      toolchainInspection: inspection,
      probeNodeVersion: async () => "v22.23.1\n",
    });

    expect(result.capability).toMatchObject({
      engineVersion: "4.7.1-stable (official)",
      protocolProfile: "chronorift-godot-project-environment-v1",
    });
    expect(result.binding.managedRuntimeId).toBe(
      result.capability.managedRuntimeId,
    );
    expect(result.vanillaSidecarSource).not.toBe(
      result.projectEnvironmentSidecarSource,
    );
    expect(result.sdkDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.bridgeDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.sdkDigest).not.toBe(result.bridgeDigest);
  });

  it("fails closed instead of silently using another Node runtime", async () => {
    await expect(
      preflightManagedGodotProjectEnvironmentRuntimeV1({
        hostConfig,
        godot,
        adapterFiles,
        toolchainInspection: inspection,
        probeNodeVersion: async () => "v26.5.0\n",
      }),
    ).rejects.toThrow(/exact Node v22\.23\.1/u);
  });
});
