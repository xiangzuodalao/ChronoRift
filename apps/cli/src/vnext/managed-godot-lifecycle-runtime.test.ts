import { join } from "node:path";

import {
  DEFAULT_LIFECYCLE_SIDECAR_TARGETS,
  GODOT_LIFECYCLE_OVERRIDE_SOURCE,
  createLifecycleRuntimeSidecarSource,
  createLifecycleVanillaSmokeSidecarSource,
} from "@chronorift/godot-adapter";
import { describe, expect, it } from "vitest";

import {
  preflightManagedGodotLifecycleRuntimeV1,
  type ManagedGodotLifecycleRuntimePreflightDependenciesV1,
} from "./managed-godot-lifecycle-runtime-preflight.js";
import {
  assertManagedGodotLifecycleRuntimeBinding,
  type ManagedGodotLifecycleRuntimeBindingV1,
} from "./managed-godot-lifecycle-runtime.js";
import type {
  ManagedGodotAddonInspectionPortV1,
  ManagedGodotRuntimeProcessProbeV1,
} from "./managed-godot-runtime-preflight.js";
import type { SandboxToolchainInspectionPort } from "./sandbox-toolchain.js";

const hostPaths = Object.freeze({
  nodePath: "/opt/chronorift-host/node",
  godotPath: "/opt/chronorift-host/godot",
  fontconfigProbePath: "/opt/chronorift-host/fc-match",
  shellPath: "/opt/chronorift-host/busybox",
  xdgUserDirPath: "/opt/chronorift-host/xdg-user-dir",
  lddPath: "/opt/chronorift-host/ldd",
  addonRoot: "/repo/godot/addons/chronorift_lifecycle",
});

const productionSources = Object.freeze({
  vanillaSidecarSource: createLifecycleVanillaSmokeSidecarSource({
    godotExecutable: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.godotExecutable,
    workspaceRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.workspaceRoot,
    runtimeRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.runtimeRoot,
  }),
  lifecycleSidecarSource: createLifecycleRuntimeSidecarSource({
    godotExecutable: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.godotExecutable,
    workspaceRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.workspaceRoot,
    runtimeRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.runtimeRoot,
  }),
});

const dependenciesFor = (target: string) => [
  {
    target: "/lib64/ld-linux-x86-64.so.2",
    canonicalHostPath: "/usr/lib/ld-linux-x86-64.so.2",
    bytes: Buffer.from("shared-loader"),
  },
  ...(target === DEFAULT_LIFECYCLE_SIDECAR_TARGETS.fontconfigProbeExecutable
    ? [
        {
          target: "/lib/x86_64-linux-gnu/libfontconfig.so.1",
          canonicalHostPath: "/usr/lib/libfontconfig.so.1.12.0",
          bytes: Buffer.from("fontconfig-library"),
        },
      ]
    : []),
];

const stableToolchainInspection = (): SandboxToolchainInspectionPort => ({
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

const stableAddonInspection = (
  bytes = Buffer.from("extends Node\n"),
): ManagedGodotAddonInspectionPortV1 => ({
  inspect: async () => [
    {
      kind: "file",
      relativePath: "lifecycle_probe.gd",
      canonicalHostPath: join(hostPaths.addonRoot, "lifecycle_probe.gd"),
      bytes,
    },
  ],
});

const stableProcessProbe = (
  godotVersion = "4.7.1.stable.official.a13da4feb",
): ManagedGodotRuntimeProcessProbeV1 => ({
  probeVersion: async ({ kind }) =>
    kind === "node" ? "v22.23.1\n" : `${godotVersion}\n`,
});

const dependencies = (
  overrides: Partial<ManagedGodotLifecycleRuntimePreflightDependenciesV1> = {},
): ManagedGodotLifecycleRuntimePreflightDependenciesV1 => ({
  executableTrust: async (path) => path,
  toolchainInspection: stableToolchainInspection(),
  addonInspection: stableAddonInspection(),
  processProbe: stableProcessProbe(),
  ...overrides,
});

const preflight = (
  overrides: Partial<ManagedGodotLifecycleRuntimePreflightDependenciesV1> = {},
) =>
  preflightManagedGodotLifecycleRuntimeV1(
    { ...hostPaths, ...productionSources },
    dependencies(overrides),
  );

describe("managed Godot lifecycle runtime", () => {
  it("freezes exact sidecar, overlay, addon, toolchain, and version identities", async () => {
    const frozen = await preflight();

    expect(frozen.capability).toMatchObject({
      runtimeProfile: "chronorift-managed-godot-lifecycle-v1",
      protocolProfile: "chronorift-godot-lifecycle-v1",
      doctorVersion: "4.7.1.stable.official.a13da4feb",
      engineVersion: "4.7.1-stable (official)",
      overlayTarget: "/run/chronorift/overlay/project/override.cfg",
      addonTarget:
        "/run/chronorift/overlay/project/addons/chronorift_lifecycle",
      addonFiles: [{ relativePath: "lifecycle_probe.gd" }],
    });
    expect(Buffer.from(frozen.binding.overlayBytes).toString("utf8")).toBe(
      GODOT_LIFECYCLE_OVERRIDE_SOURCE,
    );
    expect(frozen.capability.vanillaSidecarSourceSha256).not.toBe(
      frozen.capability.lifecycleSidecarSourceSha256,
    );
    expect(JSON.stringify(frozen.capability)).not.toContain(
      "/opt/chronorift-host",
    );
  });

  it("rejects drift in a bound addon or overlay byte", async () => {
    const frozen = await preflight();
    const addonDrift: ManagedGodotLifecycleRuntimeBindingV1 = {
      ...frozen.binding,
      addonFiles: [
        {
          relativePath: "lifecycle_probe.gd",
          bytes: Buffer.from("extends Node2D\n"),
        },
      ],
    };
    expect(() =>
      assertManagedGodotLifecycleRuntimeBinding(frozen.capability, addonDrift),
    ).toThrow(/addon binding content mismatch/iu);

    const overlayDrift: ManagedGodotLifecycleRuntimeBindingV1 = {
      ...frozen.binding,
      overlayBytes: Buffer.from(frozen.binding.overlayBytes).fill(0, 0, 1),
    };
    expect(() =>
      assertManagedGodotLifecycleRuntimeBinding(
        frozen.capability,
        overlayDrift,
      ),
    ).toThrow(/binding identity mismatch/iu);
  });

  it("fails closed on unsupported Godot versions", async () => {
    await expect(
      preflight({
        processProbe: stableProcessProbe("4.7.2.stable.official.bad"),
      }),
    ).rejects.toThrow(/requires an exact official stable Godot/iu);
  });

  it("detects toolchain and addon identity changes across double inspection", async () => {
    let commandCalls = 0;
    const driftingToolchain: SandboxToolchainInspectionPort = {
      inspectCommand: async (command) => {
        const inspection = Math.floor(commandCalls / 2);
        commandCalls += 1;
        return {
          target: command.target,
          canonicalHostPath: command.hostPath,
          bytes: Buffer.from(`command:${command.target}:${inspection}`),
          dependencies: dependenciesFor(command.target),
        };
      },
      inspectExecutableFile: async (file) => ({
        target: file.target,
        canonicalHostPath: file.hostPath,
        bytes: Buffer.from(`runtime-file:${file.target}`),
      }),
    };
    await expect(
      preflight({ toolchainInspection: driftingToolchain }),
    ).rejects.toThrow(/toolchain identity changed/iu);

    let addonCalls = 0;
    const driftingAddon: ManagedGodotAddonInspectionPortV1 = {
      inspect: async () => {
        addonCalls += 1;
        return stableAddonInspection(
          Buffer.from(addonCalls === 1 ? "extends Node\n" : "extends Node2D\n"),
        ).inspect(hostPaths.addonRoot);
      },
    };
    await expect(preflight({ addonInspection: driftingAddon })).rejects.toThrow(
      /addon identity changed/iu,
    );
  });
});
