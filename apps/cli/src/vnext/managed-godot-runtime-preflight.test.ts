import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_RUNTIME_SIDECAR_TARGETS,
  MANAGED_FONTCONFIG_SOURCE,
  createRuntimeSidecarSource,
} from "@chronorift/godot-adapter";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MANAGED_GODOT_HOST_DEPENDENCY_PATHS,
  preflightManagedGodotRuntimeV1,
  type ManagedGodotAddonInspectionPortV1,
  type ManagedGodotRuntimeProcessProbeV1,
  type ManagedGodotRuntimePreflightDependenciesV1,
} from "./managed-godot-runtime-preflight.js";
import {
  assertManagedGodotRuntimeBinding,
  type ManagedGodotRuntimeBindingV1,
} from "./managed-godot-runtime.js";
import type { SandboxToolchainInspectionPort } from "./sandbox-toolchain.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const productionSidecarSource = createRuntimeSidecarSource({
  godotExecutable: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
  workspaceRoot: DEFAULT_RUNTIME_SIDECAR_TARGETS.workspaceRoot,
  runtimeRoot: DEFAULT_RUNTIME_SIDECAR_TARGETS.runtimeRoot,
});

const hostPaths = Object.freeze({
  nodePath: "/opt/chronorift-host/node",
  godotPath: "/opt/chronorift-host/godot",
  fontconfigProbePath: "/opt/chronorift-host/fc-match",
  shellPath: "/opt/chronorift-host/dash",
  xdgUserDirPath: "/opt/chronorift-host/xdg-user-dir",
  lddPath: "/opt/chronorift-host/ldd",
});

const dependenciesFor = (target: string) => [
  {
    target: "/lib64/ld-linux-x86-64.so.2",
    canonicalHostPath: "/usr/lib/ld-linux-x86-64.so.2",
    bytes: Buffer.from("shared-loader"),
  },
  ...(target === DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigProbeExecutable
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

const stableProcessProbe = (
  calls: { kind: "node" | "godot"; executable: string; target: string }[] = [],
): ManagedGodotRuntimeProcessProbeV1 => ({
  probeVersion: async (request) => {
    calls.push(request);
    return request.kind === "node"
      ? "v22.23.1\n"
      : "4.7.1.stable.official.a13da4feb\n";
  },
});

const trustedDependencies = (
  overrides: Partial<ManagedGodotRuntimePreflightDependenciesV1> = {},
): ManagedGodotRuntimePreflightDependenciesV1 => ({
  executableTrust: async (path) => path,
  toolchainInspection: stableToolchainInspection(),
  processProbe: stableProcessProbe(),
  ...overrides,
});

const inputFor = (addonRoot: string) => ({
  ...hostPaths,
  addonRoot,
  sidecarSource: productionSidecarSource,
});

const makeAddonRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-managed-runtime-"));
  roots.push(root);
  const addonRoot = join(root, "godot", "addons", "chronorift");
  await mkdir(join(addonRoot, "nested"), { recursive: true });
  await Promise.all([
    writeFile(join(addonRoot, "plugin.cfg"), "[plugin]\n"),
    writeFile(join(addonRoot, "chrono_probe.gd"), "extends Node\n"),
    writeFile(join(addonRoot, "nested", "capture.gd"), "extends RefCounted\n"),
  ]);
  return addonRoot;
};

const fixedAddonInspection = (
  addonRoot: string,
  bytes = "extends Node\n",
): ManagedGodotAddonInspectionPortV1 => ({
  inspect: async () => [
    {
      kind: "file",
      relativePath: "chrono_probe.gd",
      canonicalHostPath: join(addonRoot, "chrono_probe.gd"),
      bytes: Buffer.from(bytes),
    },
  ],
});

describe("managed Godot runtime preflight", () => {
  it("uses only the frozen standard Host dependency defaults when overrides are omitted", async () => {
    const addonRoot = "/repo/godot/addons/chronorift";
    const trustedPaths: string[] = [];
    const {
      fontconfigProbePath: _fontconfig,
      shellPath: _shell,
      xdgUserDirPath: _xdg,
      ...input
    } = inputFor(addonRoot);
    await preflightManagedGodotRuntimeV1(input, {
      ...trustedDependencies({
        addonInspection: fixedAddonInspection(addonRoot),
      }),
      executableTrust: async (path) => {
        trustedPaths.push(path);
        return path;
      },
    });

    expect(trustedPaths).toEqual(
      expect.arrayContaining(
        Object.values(DEFAULT_MANAGED_GODOT_HOST_DEPENDENCY_PATHS),
      ),
    );
    void _fontconfig;
    void _shell;
    void _xdg;
  });

  it("freezes trusted commands, production sidecar, and a symlink-free addon tree", async () => {
    const addonRoot = await makeAddonRoot();
    const probeCalls: {
      kind: "node" | "godot";
      executable: string;
      target: string;
    }[] = [];
    const frozen = await preflightManagedGodotRuntimeV1(
      inputFor(addonRoot),
      trustedDependencies({ processProbe: stableProcessProbe(probeCalls) }),
    );

    expect(frozen.capability.nodeTarget).toBe(
      DEFAULT_RUNTIME_SIDECAR_TARGETS.nodeExecutable,
    );
    expect(frozen.capability.godotTarget).toBe(
      DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
    );
    expect(
      frozen.capability.toolchain.files
        .filter((file) => file.command)
        .map((file) => file.target),
    ).toEqual([
      DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
      DEFAULT_RUNTIME_SIDECAR_TARGETS.nodeExecutable,
    ]);
    expect(frozen.capability.toolchain.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "/lib/x86_64-linux-gnu/libfontconfig.so.1",
          command: false,
        }),
        expect.objectContaining({
          target: DEFAULT_RUNTIME_SIDECAR_TARGETS.shellExecutable,
          command: false,
        }),
        expect.objectContaining({
          target: DEFAULT_RUNTIME_SIDECAR_TARGETS.xdgUserDirExecutable,
          command: false,
        }),
      ]),
    );
    expect(
      frozen.capability.toolchain.files.map((file) => file.target),
    ).not.toContain(DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigProbeExecutable);
    expect(JSON.stringify(frozen.capability)).not.toContain(
      "/opt/chronorift-host",
    );
    expect(frozen.capability.addonTarget).toBe(
      DEFAULT_RUNTIME_SIDECAR_TARGETS.managedAddonRoot,
    );
    expect(frozen.capability.addonParentTarget).toBe(
      DEFAULT_RUNTIME_SIDECAR_TARGETS.managedAddonParent,
    );
    expect(frozen.capability.fontconfigTarget).toBe(
      DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigFile,
    );
    expect(Buffer.from(frozen.binding.fontconfigBytes).toString("utf8")).toBe(
      MANAGED_FONTCONFIG_SOURCE,
    );
    expect(frozen.capability.doctorVersion).toBe(
      "4.7.1.stable.official.a13da4feb",
    );
    expect(frozen.capability.engineVersion).toBe("4.7.1-stable (official)");
    expect(
      frozen.capability.addonFiles.map((file) => file.relativePath),
    ).toEqual(["chrono_probe.gd", "nested/capture.gd", "plugin.cfg"]);
    expect(probeCalls).toEqual([
      {
        kind: "node",
        executable: hostPaths.nodePath,
        target: DEFAULT_RUNTIME_SIDECAR_TARGETS.nodeExecutable,
      },
      {
        kind: "godot",
        executable: hostPaths.godotPath,
        target: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
      },
    ]);
    expect(() =>
      assertManagedGodotRuntimeBinding(frozen.capability, frozen.binding),
    ).not.toThrow();

    const originalBytes = Buffer.from(
      frozen.binding.addonFiles.find(
        (file) => file.relativePath === "chrono_probe.gd",
      )!.bytes,
    );
    await writeFile(join(addonRoot, "chrono_probe.gd"), "changed later\n");
    expect(
      Buffer.from(
        frozen.binding.addonFiles.find(
          (file) => file.relativePath === "chrono_probe.gd",
        )!.bytes,
      ),
    ).toEqual(originalBytes);
  });

  it("fails closed before probing mutable or untrusted real executable paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-untrusted-runtime-"));
    roots.push(root);
    const addonRoot = join(root, "godot", "addons", "chronorift");
    const binRoot = join(root, "bin");
    await Promise.all([
      mkdir(addonRoot, { recursive: true }),
      mkdir(binRoot, { recursive: true }),
    ]);
    await writeFile(join(addonRoot, "probe.gd"), "extends Node\n");
    const paths = {
      nodePath: join(binRoot, "node"),
      godotPath: join(binRoot, "godot"),
      fontconfigProbePath: join(binRoot, "fc-match"),
      shellPath: join(binRoot, "dash"),
      xdgUserDirPath: join(binRoot, "xdg-user-dir"),
      lddPath: join(binRoot, "ldd"),
    };
    await Promise.all(
      Object.values(paths).map(async (path) => {
        await writeFile(path, "untrusted");
        await chmod(path, 0o755);
      }),
    );
    let processProbeCalls = 0;

    const attempt = preflightManagedGodotRuntimeV1(
      { ...paths, addonRoot, sidecarSource: productionSidecarSource },
      {
        toolchainInspection: stableToolchainInspection(),
        processProbe: {
          probeVersion: async () => {
            processProbeCalls += 1;
            return "unexpected";
          },
        },
      },
    );

    await expect(attempt).rejects.toMatchObject({
      code: "sandbox_preflight_failed",
    });
    expect(processProbeCalls).toBe(0);
  });

  it("rejects addon duplicate targets, path escapes, and reported symlinks", async () => {
    const addonRoot = "/repo/godot/addons/chronorift";
    const validFile = {
      kind: "file" as const,
      relativePath: "probe.gd",
      canonicalHostPath: join(addonRoot, "probe.gd"),
      bytes: Buffer.from("probe"),
    };
    const invalidInspections: readonly ManagedGodotAddonInspectionPortV1[] = [
      { inspect: async () => [validFile, { ...validFile }] },
      {
        inspect: async () => [
          {
            ...validFile,
            relativePath: "../outside.gd",
            canonicalHostPath: "/repo/godot/addons/outside.gd",
          },
        ],
      },
      {
        inspect: async () => [
          {
            kind: "symbolic-link",
            relativePath: "probe.gd",
            canonicalHostPath: join(addonRoot, "probe.gd"),
          },
        ],
      },
    ];

    for (const addonInspection of invalidInspections) {
      await expect(
        preflightManagedGodotRuntimeV1(
          inputFor(addonRoot),
          trustedDependencies({ addonInspection }),
        ),
      ).rejects.toMatchObject({ code: "sandbox_preflight_failed" });
    }
  });

  it("rejects a real symlink anywhere below the addon root", async () => {
    const addonRoot = await makeAddonRoot();
    const outside = join(addonRoot, "..", "outside.gd");
    await writeFile(outside, "outside\n");
    await symlink(outside, join(addonRoot, "linked.gd"));

    await expect(
      preflightManagedGodotRuntimeV1(
        inputFor(addonRoot),
        trustedDependencies(),
      ),
    ).rejects.toThrow(/symbolic link/u);
  });

  it("requires Godot 4.7.1, exact Node 22.23.1, and the fixed managed Host bindings", async () => {
    const addonRoot = "/repo/godot/addons/chronorift";
    const addonInspection = fixedAddonInspection(addonRoot);
    for (const [kind, version, message] of [
      ["node", "v23.1.0", /exact Node v22\.23\.1/u],
      ["node", "v22.22.0", /exact Node v22\.23\.1/u],
      ["node", "v22.23.1-rc.1", /exact Node v22\.23\.1/u],
      ["godot", "4.6.1.stable.official", /Godot 4\.7\.1/u],
      [
        "godot",
        "4.7.1.stable.custom.a13da4feb",
        /official stable Godot 4\.7\.1/u,
      ],
    ] as const) {
      await expect(
        preflightManagedGodotRuntimeV1(
          inputFor(addonRoot),
          trustedDependencies({
            addonInspection,
            processProbe: {
              probeVersion: async (request) =>
                request.kind === kind
                  ? version
                  : request.kind === "node"
                    ? "v22.23.1"
                    : "4.7.1.stable.official.a13da4feb",
            },
          }),
        ),
      ).rejects.toThrow(message);
    }

    const swappedInspection: SandboxToolchainInspectionPort = {
      inspectCommand: async (command) => ({
        target: command.target,
        canonicalHostPath:
          command.target === DEFAULT_RUNTIME_SIDECAR_TARGETS.nodeExecutable
            ? "/opt/other/node"
            : command.hostPath,
        bytes: Buffer.from(command.target),
        dependencies: dependenciesFor(command.target),
      }),
      inspectExecutableFile: (file) =>
        stableToolchainInspection().inspectExecutableFile(file),
    };
    await expect(
      preflightManagedGodotRuntimeV1(
        inputFor(addonRoot),
        trustedDependencies({
          addonInspection,
          toolchainInspection: swappedInspection,
        }),
      ),
    ).rejects.toThrow(/managed Node target/u);
  });

  it("fails closed when the fontconfig inspection anchor does not expose libfontconfig", async () => {
    const addonRoot = "/repo/godot/addons/chronorift";
    const stable = stableToolchainInspection();
    await expect(
      preflightManagedGodotRuntimeV1(
        inputFor(addonRoot),
        trustedDependencies({
          addonInspection: fixedAddonInspection(addonRoot),
          toolchainInspection: {
            inspectCommand: async (command) => ({
              ...(await stable.inspectCommand(command)),
              dependencies: dependenciesFor(command.target).filter(
                (dependency) =>
                  !dependency.target.endsWith("/libfontconfig.so.1"),
              ),
            }),
            inspectExecutableFile: (file) => stable.inspectExecutableFile(file),
          },
        }),
      ),
    ).rejects.toThrow(/fontconfig dependency closure is incomplete/u);
  });

  it("rejects toolchain, addon, or production-sidecar identity drift", async () => {
    const addonRoot = "/repo/godot/addons/chronorift";
    const commandInspections = new Map<string, number>();
    const driftingToolchain: SandboxToolchainInspectionPort = {
      inspectCommand: async (command) => {
        const inspection = commandInspections.get(command.target) ?? 0;
        commandInspections.set(command.target, inspection + 1);
        return {
          target: command.target,
          canonicalHostPath: command.hostPath,
          bytes: Buffer.from(`${command.target}:${inspection}`),
          dependencies: dependenciesFor(command.target),
        };
      },
      inspectExecutableFile: (file) =>
        stableToolchainInspection().inspectExecutableFile(file),
    };
    await expect(
      preflightManagedGodotRuntimeV1(
        inputFor(addonRoot),
        trustedDependencies({
          addonInspection: fixedAddonInspection(addonRoot),
          toolchainInspection: driftingToolchain,
        }),
      ),
    ).rejects.toThrow(/toolchain identity changed/u);

    let addonInspections = 0;
    await expect(
      preflightManagedGodotRuntimeV1(
        inputFor(addonRoot),
        trustedDependencies({
          addonInspection: {
            inspect: async () => {
              addonInspections += 1;
              return fixedAddonInspection(
                addonRoot,
                addonInspections === 1 ? "first" : "second",
              ).inspect(addonRoot);
            },
          },
        }),
      ),
    ).rejects.toThrow(/addon identity changed/u);

    await expect(
      preflightManagedGodotRuntimeV1(
        {
          ...inputFor(addonRoot),
          sidecarSource: `${productionSidecarSource}\n`,
        },
        trustedDependencies({
          addonInspection: fixedAddonInspection(addonRoot),
        }),
      ),
    ).rejects.toThrow(/production sidecar source/u);
  });

  it("returns owned addon bytes rather than retaining inspection buffers", async () => {
    const addonRoot = "/repo/godot/addons/chronorift";
    const mutable = Buffer.from("original");
    const addonInspection: ManagedGodotAddonInspectionPortV1 = {
      inspect: async () => [
        {
          kind: "file",
          relativePath: "probe.gd",
          canonicalHostPath: join(addonRoot, "probe.gd"),
          bytes: mutable,
        },
      ],
    };
    const frozen = await preflightManagedGodotRuntimeV1(
      inputFor(addonRoot),
      trustedDependencies({ addonInspection }),
    );
    mutable.fill(0);

    expect(Buffer.from(frozen.binding.addonFiles[0]!.bytes).toString()).toBe(
      "original",
    );
    expect(frozen.binding).toSatisfy(
      (binding: ManagedGodotRuntimeBindingV1) =>
        binding.managedRuntimeId === frozen.capability.managedRuntimeId,
    );
  });
});
