import { join } from "node:path";

import {
  DEFAULT_SEMANTIC_SIDECAR_TARGETS,
  GODOT_SEMANTIC_OVERRIDE_SOURCE,
  createSemanticRuntimeSidecarSource,
  createSemanticVanillaSmokeSidecarSource,
} from "@chronorift/godot-adapter";
import { describe, expect, it } from "vitest";

import {
  preflightManagedGodotSemanticRuntimeV1,
  type ManagedGodotSemanticRuntimePreflightDependenciesV1,
} from "./managed-godot-semantic-runtime-preflight.js";
import {
  assertManagedGodotSemanticRuntimeBinding,
  type ManagedGodotSemanticRuntimeBindingV1,
} from "./managed-godot-semantic-runtime.js";
import type {
  ManagedGodotAddonInspectionPortV1,
  ManagedGodotRuntimeProcessProbeV1,
} from "./managed-godot-runtime-preflight.js";
import type { SandboxToolchainInspectionPort } from "./sandbox-toolchain.js";

const host = Object.freeze({
  nodePath: "/opt/chronorift-host/node",
  godotPath: "/opt/chronorift-host/godot",
  fontconfigProbePath: "/opt/chronorift-host/fc-match",
  shellPath: "/opt/chronorift-host/busybox",
  xdgUserDirPath: "/opt/chronorift-host/xdg-user-dir",
  lddPath: "/opt/chronorift-host/ldd",
  addonRoot: "/repo/godot/addons/chronorift_semantic",
});

const sources = Object.freeze({
  vanillaSidecarSource: createSemanticVanillaSmokeSidecarSource({
    godotExecutable: DEFAULT_SEMANTIC_SIDECAR_TARGETS.godotExecutable,
    workspaceRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.workspaceRoot,
    runtimeRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.runtimeRoot,
  }),
  semanticSidecarSource: createSemanticRuntimeSidecarSource({
    godotExecutable: DEFAULT_SEMANTIC_SIDECAR_TARGETS.godotExecutable,
    workspaceRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.workspaceRoot,
    runtimeRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.runtimeRoot,
  }),
});

const dependenciesFor = (target: string) => [
  {
    target: "/lib64/ld-linux-x86-64.so.2",
    canonicalHostPath: "/usr/lib/ld-linux-x86-64.so.2",
    bytes: Buffer.from("shared-loader"),
  },
  ...(target === DEFAULT_SEMANTIC_SIDECAR_TARGETS.fontconfigProbeExecutable
    ? [
        {
          target: "/lib/x86_64-linux-gnu/libfontconfig.so.1",
          canonicalHostPath: "/usr/lib/libfontconfig.so.1.12.0",
          bytes: Buffer.from("fontconfig-library"),
        },
      ]
    : []),
];

const toolchain = (): SandboxToolchainInspectionPort => ({
  inspectCommand: async (command) => ({
    target: command.target,
    canonicalHostPath: command.hostPath,
    bytes: Buffer.from(`command:${command.target}`),
    dependencies: dependenciesFor(command.target),
  }),
  inspectExecutableFile: async (file) => ({
    target: file.target,
    canonicalHostPath: file.hostPath,
    bytes: Buffer.from(`runtime-file:${file.target}`),
  }),
});

const addon = (
  bytes = Buffer.from("extends Node\n"),
): ManagedGodotAddonInspectionPortV1 => ({
  inspect: async () => [
    {
      kind: "file",
      relativePath: "semantic_probe.gd",
      canonicalHostPath: join(host.addonRoot, "semantic_probe.gd"),
      bytes,
    },
  ],
});

const processProbe = (
  godotVersion = "4.7.1.stable.official.a13da4feb",
): ManagedGodotRuntimeProcessProbeV1 => ({
  probeVersion: async ({ kind }) =>
    kind === "node" ? "v22.23.1\n" : `${godotVersion}\n`,
});

const dependencies = (
  overrides: Partial<ManagedGodotSemanticRuntimePreflightDependenciesV1> = {},
): ManagedGodotSemanticRuntimePreflightDependenciesV1 => ({
  executableTrust: async (path) => path,
  toolchainInspection: toolchain(),
  addonInspection: addon(),
  processProbe: processProbe(),
  ...overrides,
});

const preflight = (
  overrides: Partial<ManagedGodotSemanticRuntimePreflightDependenciesV1> = {},
) =>
  preflightManagedGodotSemanticRuntimeV1(
    { ...host, ...sources },
    dependencies(overrides),
  );

describe("managed Godot semantic runtime", () => {
  it("freezes separate wire, overlay, addon, toolchain, and version identities", async () => {
    const frozen = await preflight();
    expect(frozen.capability).toMatchObject({
      runtimeProfile: "chronorift-managed-godot-semantic-v1",
      protocolProfile: "chronorift-godot-semantic-v1",
      adapterVersion: "0.5.0",
      addonTarget: "/run/chronorift/overlay/project/addons/chronorift_semantic",
      addonFiles: [{ relativePath: "semantic_probe.gd" }],
    });
    expect(Buffer.from(frozen.binding.overlayBytes).toString("utf8")).toBe(
      GODOT_SEMANTIC_OVERRIDE_SOURCE,
    );
    expect(frozen.capability.vanillaSidecarSourceSha256).not.toBe(
      frozen.capability.semanticSidecarSourceSha256,
    );
    expect(JSON.stringify(frozen.capability)).not.toContain(
      "/opt/chronorift-host",
    );
  });

  it("rejects binding drift and an unsupported Godot build", async () => {
    const frozen = await preflight();
    const drifted: ManagedGodotSemanticRuntimeBindingV1 = {
      ...frozen.binding,
      addonFiles: [
        {
          relativePath: "semantic_probe.gd",
          bytes: Buffer.from("extends Node2D\n"),
        },
      ],
    };
    expect(() =>
      assertManagedGodotSemanticRuntimeBinding(frozen.capability, drifted),
    ).toThrow(/addon binding content mismatch/iu);
    await expect(
      preflight({ processProbe: processProbe("4.7.2.stable.official.bad") }),
    ).rejects.toThrow(/requires an exact official stable Godot/iu);
  });

  it("detects addon identity changes across double inspection", async () => {
    let calls = 0;
    const driftingAddon: ManagedGodotAddonInspectionPortV1 = {
      inspect: async () => {
        calls += 1;
        return addon(
          Buffer.from(calls === 1 ? "extends Node\n" : "extends Node2D\n"),
        ).inspect(host.addonRoot);
      },
    };
    await expect(preflight({ addonInspection: driftingAddon })).rejects.toThrow(
      /addon identity changed/iu,
    );
  });
});
