import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  DEFAULT_LIFECYCLE_SIDECAR_TARGETS,
  GODOT_VERSION,
  createLifecycleRuntimeSidecarSource,
  createLifecycleVanillaSmokeSidecarSource,
} from "@chronorift/godot-adapter";

import { M1Error } from "./errors.js";
import {
  createManagedGodotLifecycleRuntimeV1,
  type ManagedGodotLifecycleRuntimeBindingV1,
  type ManagedGodotLifecycleRuntimeCapabilityV1,
} from "./managed-godot-lifecycle-runtime.js";
import type {
  ManagedGodotAddonInspectionEntryV1,
  ManagedGodotAddonInspectionPortV1,
  ManagedGodotRuntimeProcessProbeV1,
} from "./managed-godot-runtime-preflight.js";
import { assertTrustedHostExecutablePath } from "./sandbox-preflight.js";
import {
  inspectSandboxToolchain,
  type SandboxToolchainBindingV1,
  type SandboxToolchainInspectionPort,
} from "./sandbox-toolchain.js";

const MAX_ADDON_FILE_BYTES = 1024 * 1024;

export interface ManagedGodotLifecycleRuntimePreflightDependenciesV1 {
  readonly executableTrust?: ((path: string) => Promise<string>) | undefined;
  readonly toolchainInspection?: SandboxToolchainInspectionPort | undefined;
  readonly addonInspection?: ManagedGodotAddonInspectionPortV1 | undefined;
  readonly processProbe?: ManagedGodotRuntimeProcessProbeV1 | undefined;
}

export interface ManagedGodotLifecycleRuntimePreflightInputV1 {
  readonly nodePath: string;
  readonly godotPath: string;
  readonly fontconfigProbePath?: string | undefined;
  readonly shellPath?: string | undefined;
  readonly xdgUserDirPath?: string | undefined;
  readonly lddPath: string;
  readonly addonRoot: string;
  readonly vanillaSidecarSource: string;
  readonly lifecycleSidecarSource: string;
}

type ResolvedManagedGodotLifecycleRuntimePreflightInputV1 =
  ManagedGodotLifecycleRuntimePreflightInputV1 & {
    readonly fontconfigProbePath: string;
    readonly shellPath: string;
    readonly xdgUserDirPath: string;
  };

export interface ManagedGodotLifecycleRuntimePreflightResultV1 {
  readonly capability: ManagedGodotLifecycleRuntimeCapabilityV1;
  readonly binding: ManagedGodotLifecycleRuntimeBindingV1;
}

export const DEFAULT_MANAGED_GODOT_LIFECYCLE_HOST_DEPENDENCY_PATHS =
  Object.freeze({
    fontconfigProbePath: "/usr/bin/fc-match",
    shellPath: "/usr/bin/busybox",
    xdgUserDirPath: "/usr/bin/xdg-user-dir",
  } as const);

const fail = (message: string, cause?: unknown): M1Error =>
  new M1Error("sandbox_preflight_failed", message, cause);

const normalizedAbsolute = (value: string): boolean =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("\0") &&
  isAbsolute(value) &&
  resolve(value) === value;

const statsIdentity = (stats: BigIntStats): string =>
  [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs,
  ].join(":");

const assertUnchanged = (
  before: BigIntStats,
  after: BigIntStats,
  label: string,
): void => {
  if (statsIdentity(before) !== statsIdentity(after)) {
    throw fail(
      `managed Godot lifecycle addon ${label} changed during inspection`,
    );
  }
};

const nodeLifecycleAddonInspection: ManagedGodotAddonInspectionPortV1 = {
  inspect: async (addonRoot) => {
    const rootBefore = await lstat(addonRoot, { bigint: true });
    if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) {
      throw fail("managed Godot lifecycle addon root is not a directory");
    }
    if ((await realpath(addonRoot)) !== addonRoot) {
      throw fail("managed Godot lifecycle addon root is not canonical");
    }
    const entries: string[] = [];
    const directory = await opendir(addonRoot);
    for await (const entry of directory) entries.push(entry.name);
    entries.sort((left, right) => left.localeCompare(right));
    if (entries.length !== 1 || entries[0] !== "lifecycle_probe.gd") {
      throw fail(
        "managed Godot lifecycle addon must contain only lifecycle_probe.gd",
      );
    }
    const target = join(addonRoot, "lifecycle_probe.gd");
    const before = await lstat(target, { bigint: true });
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(MAX_ADDON_FILE_BYTES) ||
      (await realpath(target)) !== target
    ) {
      throw fail(
        "managed Godot lifecycle probe is not a bounded canonical regular file",
      );
    }
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let bytes: Buffer;
    try {
      const opened = await handle.stat({ bigint: true });
      assertUnchanged(before, opened, "file");
      bytes = await handle.readFile();
      assertUnchanged(opened, await handle.stat({ bigint: true }), "file");
    } finally {
      await handle.close();
    }
    assertUnchanged(before, await lstat(target, { bigint: true }), "file");
    assertUnchanged(
      rootBefore,
      await lstat(addonRoot, { bigint: true }),
      "directory",
    );
    if (
      bytes.byteLength !== Number(before.size) ||
      (await realpath(target)) !== target ||
      (await realpath(addonRoot)) !== addonRoot
    ) {
      throw fail(
        "managed Godot lifecycle addon changed canonical identity during inspection",
      );
    }
    return [
      {
        kind: "file",
        relativePath: "lifecycle_probe.gd",
        canonicalHostPath: target,
        bytes,
      },
    ];
  },
};

const realProcessProbe: ManagedGodotRuntimeProcessProbeV1 = {
  probeVersion: ({ executable }) =>
    new Promise<string>((resolveProbe, rejectProbe) => {
      execFile(
        executable,
        ["--version"],
        {
          encoding: "utf8",
          env: {
            HOME: "/nonexistent",
            LANG: "C",
            LC_ALL: "C",
            PATH: "/usr/bin:/bin",
          },
          maxBuffer: 1024 * 1024,
          shell: false,
          timeout: 10_000,
        },
        (error, stdout) => {
          if (error !== null) {
            rejectProbe(
              fail("managed lifecycle runtime version probe failed", error),
            );
            return;
          }
          resolveProbe(stdout);
        },
      );
    }),
};

const productionVanillaSidecarSource = (): string =>
  createLifecycleVanillaSmokeSidecarSource({
    godotExecutable: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.godotExecutable,
    workspaceRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.workspaceRoot,
    runtimeRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.runtimeRoot,
  });

const productionLifecycleSidecarSource = (): string =>
  createLifecycleRuntimeSidecarSource({
    godotExecutable: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.godotExecutable,
    workspaceRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.workspaceRoot,
    runtimeRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.runtimeRoot,
  });

const normalizedVersion = (raw: string, label: string): string => {
  if (typeof raw !== "string") {
    throw fail(`${label} version probe did not return text`);
  }
  const value = raw.trim();
  if (
    value.length === 0 ||
    value.length > 128 ||
    value.includes("\n") ||
    value.includes("\r") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || codePoint < 0x20 || codePoint > 0x7e;
    })
  ) {
    throw fail(`${label} version probe returned an invalid value`);
  }
  return value;
};

const assertVersions = (
  nodeRaw: string,
  godotRaw: string,
): { readonly godotVersion: string } => {
  const nodeVersion = normalizedVersion(nodeRaw, "Node");
  if (nodeVersion !== "v22.23.1") {
    throw fail(
      `managed lifecycle runtime requires exact Node v22.23.1, received ${nodeVersion}`,
    );
  }
  const godotVersion = normalizedVersion(godotRaw, "Godot");
  if (!/^4\.7\.1\.stable\.official\.[a-f0-9]{7,64}$/u.test(godotVersion)) {
    throw fail(
      `managed lifecycle runtime requires an exact official stable Godot ${GODOT_VERSION} build, received ${godotVersion}`,
    );
  }
  return { godotVersion };
};

const validateAddonSnapshot = (
  addonRoot: string,
  entries: readonly ManagedGodotAddonInspectionEntryV1[],
): readonly { readonly relativePath: string; readonly bytes: Uint8Array }[] => {
  if (entries.length !== 1) {
    throw fail(
      "managed Godot lifecycle addon inspection must return exactly one file",
    );
  }
  const entry = entries[0];
  const expectedPath = join(addonRoot, "lifecycle_probe.gd");
  if (
    entry === undefined ||
    entry.kind !== "file" ||
    entry.relativePath !== "lifecycle_probe.gd" ||
    entry.canonicalHostPath !== expectedPath ||
    !(entry.bytes instanceof Uint8Array) ||
    entry.bytes.byteLength < 1 ||
    entry.bytes.byteLength > MAX_ADDON_FILE_BYTES
  ) {
    throw fail(
      "managed Godot lifecycle addon inspection returned an invalid probe",
    );
  }
  return [
    {
      relativePath: entry.relativePath,
      bytes: Uint8Array.from(entry.bytes),
    },
  ];
};

const addonIdentity = (
  files: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[],
): string => {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
};

const bindingIdentity = (binding: SandboxToolchainBindingV1): string =>
  JSON.stringify({
    toolchainId: binding.toolchainId,
    files: binding.files.map((file) => ({
      target: file.target,
      hostPath: file.hostPath,
    })),
  });

const assertManagedCommandBindings = (
  binding: SandboxToolchainBindingV1,
  input: ResolvedManagedGodotLifecycleRuntimePreflightInputV1,
): void => {
  if (
    binding.files.find(
      (file) =>
        file.target === DEFAULT_LIFECYCLE_SIDECAR_TARGETS.nodeExecutable,
    )?.hostPath !== input.nodePath ||
    binding.files.find(
      (file) =>
        file.target === DEFAULT_LIFECYCLE_SIDECAR_TARGETS.godotExecutable,
    )?.hostPath !== input.godotPath ||
    binding.files.find(
      (file) =>
        file.target === DEFAULT_LIFECYCLE_SIDECAR_TARGETS.shellExecutable,
    )?.hostPath !== input.shellPath ||
    binding.files.find(
      (file) =>
        file.target === DEFAULT_LIFECYCLE_SIDECAR_TARGETS.xdgUserDirExecutable,
    )?.hostPath !== input.xdgUserDirPath
  ) {
    throw fail("managed lifecycle command target resolved unexpectedly");
  }
  if (
    !binding.files.some(
      (file) =>
        basename(file.target) === "libfontconfig.so.1" &&
        file.target.startsWith("/"),
    )
  ) {
    throw fail("managed lifecycle fontconfig closure is incomplete");
  }
};

const assertPreflightInput = (
  input: ResolvedManagedGodotLifecycleRuntimePreflightInputV1,
): void => {
  for (const [label, value] of [
    ["Node", input.nodePath],
    ["Godot", input.godotPath],
    ["fontconfig probe", input.fontconfigProbePath],
    ["shell", input.shellPath],
    ["xdg-user-dir", input.xdgUserDirPath],
    ["ldd", input.lddPath],
    ["addon", input.addonRoot],
  ] as const) {
    if (!normalizedAbsolute(value)) {
      throw fail(
        `managed lifecycle runtime ${label} path must be absolute and normalized`,
      );
    }
  }
  if (
    basename(input.addonRoot) !== "chronorift_lifecycle" ||
    basename(dirname(input.addonRoot)) !== "addons"
  ) {
    throw fail(
      "managed Godot lifecycle addon root must be the chronorift_lifecycle addon directory",
    );
  }
  if (input.vanillaSidecarSource !== productionVanillaSidecarSource()) {
    throw fail("managed lifecycle vanilla sidecar source identity mismatch");
  }
  if (input.lifecycleSidecarSource !== productionLifecycleSidecarSource()) {
    throw fail("managed lifecycle duplex sidecar source identity mismatch");
  }
};

export async function preflightManagedGodotLifecycleRuntimeV1(
  input: ManagedGodotLifecycleRuntimePreflightInputV1,
  dependencies: ManagedGodotLifecycleRuntimePreflightDependenciesV1 = {},
): Promise<ManagedGodotLifecycleRuntimePreflightResultV1> {
  try {
    const resolvedInput: ResolvedManagedGodotLifecycleRuntimePreflightInputV1 =
      {
        ...input,
        fontconfigProbePath:
          input.fontconfigProbePath ??
          DEFAULT_MANAGED_GODOT_LIFECYCLE_HOST_DEPENDENCY_PATHS.fontconfigProbePath,
        shellPath:
          input.shellPath ??
          DEFAULT_MANAGED_GODOT_LIFECYCLE_HOST_DEPENDENCY_PATHS.shellPath,
        xdgUserDirPath:
          input.xdgUserDirPath ??
          DEFAULT_MANAGED_GODOT_LIFECYCLE_HOST_DEPENDENCY_PATHS.xdgUserDirPath,
      };
    assertPreflightInput(resolvedInput);
    const executableTrust =
      dependencies.executableTrust ?? assertTrustedHostExecutablePath;
    const hostPaths = [
      resolvedInput.nodePath,
      resolvedInput.godotPath,
      resolvedInput.fontconfigProbePath,
      resolvedInput.shellPath,
      resolvedInput.xdgUserDirPath,
      resolvedInput.lddPath,
    ] as const;
    const trustedPaths = await Promise.all(
      hostPaths.map((path) => executableTrust(path)),
    );
    if (trustedPaths.some((value, index) => value !== hostPaths[index])) {
      throw fail(
        "managed lifecycle executable path changed canonical identity",
      );
    }

    const inspectToolchain = () =>
      inspectSandboxToolchain({
        lddPath: resolvedInput.lddPath,
        commands: [
          {
            target: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.nodeExecutable,
            hostPath: resolvedInput.nodePath,
          },
          {
            target: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.godotExecutable,
            hostPath: resolvedInput.godotPath,
          },
        ],
        dependencyAnchors: [
          {
            target: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.fontconfigProbeExecutable,
            hostPath: resolvedInput.fontconfigProbePath,
          },
        ],
        runtimeExecutableFiles: [
          {
            target: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.shellExecutable,
            hostPath: resolvedInput.shellPath,
          },
          {
            target: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.xdgUserDirExecutable,
            hostPath: resolvedInput.xdgUserDirPath,
          },
        ],
        ...(dependencies.toolchainInspection === undefined
          ? {}
          : { inspection: dependencies.toolchainInspection }),
      });
    const addonInspection =
      dependencies.addonInspection ?? nodeLifecycleAddonInspection;
    const firstToolchain = await inspectToolchain();
    assertManagedCommandBindings(firstToolchain.binding, resolvedInput);
    const firstAddon = validateAddonSnapshot(
      input.addonRoot,
      await addonInspection.inspect(input.addonRoot),
    );

    const processProbe = dependencies.processProbe ?? realProcessProbe;
    const nodeVersion = await processProbe.probeVersion({
      kind: "node",
      executable: input.nodePath,
      target: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.nodeExecutable,
    });
    const godotVersion = await processProbe.probeVersion({
      kind: "godot",
      executable: input.godotPath,
      target: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.godotExecutable,
    });
    const versions = assertVersions(nodeVersion, godotVersion);

    const retrustedPaths = await Promise.all(
      hostPaths.map((path) => executableTrust(path)),
    );
    if (retrustedPaths.some((value, index) => value !== trustedPaths[index])) {
      throw fail("managed lifecycle executable trust changed during preflight");
    }
    const secondToolchain = await inspectToolchain();
    assertManagedCommandBindings(secondToolchain.binding, resolvedInput);
    const secondAddon = validateAddonSnapshot(
      input.addonRoot,
      await addonInspection.inspect(input.addonRoot),
    );
    if (
      firstToolchain.capability.toolchainId !==
        secondToolchain.capability.toolchainId ||
      bindingIdentity(firstToolchain.binding) !==
        bindingIdentity(secondToolchain.binding)
    ) {
      throw fail(
        "managed lifecycle toolchain identity changed during preflight",
      );
    }
    if (addonIdentity(firstAddon) !== addonIdentity(secondAddon)) {
      throw fail(
        "managed Godot lifecycle addon identity changed during preflight",
      );
    }

    return createManagedGodotLifecycleRuntimeV1({
      doctorVersion: versions.godotVersion,
      nodeTarget: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.nodeExecutable,
      godotTarget: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.godotExecutable,
      toolchain: secondToolchain,
      vanillaSidecarSource: input.vanillaSidecarSource,
      lifecycleSidecarSource: input.lifecycleSidecarSource,
      addonFiles: secondAddon,
    });
  } catch (error) {
    if (error instanceof M1Error) throw error;
    throw fail(
      "managed Godot lifecycle runtime preflight failed closed",
      error,
    );
  }
}
