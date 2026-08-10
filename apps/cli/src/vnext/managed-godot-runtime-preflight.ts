import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  DEFAULT_RUNTIME_SIDECAR_TARGETS,
  GODOT_VERSION,
  createRuntimeSidecarSource,
} from "@chronorift/godot-adapter";

import { M1Error } from "./errors.js";
import {
  createManagedGodotRuntimeV1,
  type ManagedGodotRuntimeBindingV1,
  type ManagedGodotRuntimeCapabilityV1,
} from "./managed-godot-runtime.js";
import { assertTrustedHostExecutablePath } from "./sandbox-preflight.js";
import {
  inspectSandboxToolchain,
  type SandboxToolchainBindingV1,
  type SandboxToolchainInspectionPort,
} from "./sandbox-toolchain.js";

const MAX_ADDON_FILES = 32;
const MAX_ADDON_ENTRIES = 128;
const MAX_ADDON_DEPTH = 16;
const MAX_ADDON_FILE_BYTES = 1024 * 1024;
const MAX_ADDON_PATH_BYTES = 256;

export type ManagedGodotAddonInspectionEntryV1 =
  | {
      readonly kind: "file";
      readonly relativePath: string;
      readonly canonicalHostPath: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "directory" | "symbolic-link" | "other";
      readonly relativePath: string;
      readonly canonicalHostPath: string;
    };

export interface ManagedGodotAddonInspectionPortV1 {
  inspect(
    addonRoot: string,
  ): Promise<readonly ManagedGodotAddonInspectionEntryV1[]>;
}

export interface ManagedGodotRuntimeProcessProbeV1 {
  probeVersion(input: {
    readonly kind: "node" | "godot";
    readonly executable: string;
    readonly target: string;
  }): Promise<string>;
}

export interface ManagedGodotRuntimePreflightDependenciesV1 {
  readonly executableTrust?: ((path: string) => Promise<string>) | undefined;
  readonly toolchainInspection?: SandboxToolchainInspectionPort | undefined;
  readonly addonInspection?: ManagedGodotAddonInspectionPortV1 | undefined;
  readonly processProbe?: ManagedGodotRuntimeProcessProbeV1 | undefined;
}

export interface ManagedGodotRuntimePreflightInputV1 {
  readonly nodePath: string;
  readonly godotPath: string;
  readonly fontconfigProbePath?: string | undefined;
  readonly shellPath?: string | undefined;
  readonly xdgUserDirPath?: string | undefined;
  readonly lddPath: string;
  readonly addonRoot: string;
  readonly sidecarSource: string;
}

export const DEFAULT_MANAGED_GODOT_HOST_DEPENDENCY_PATHS = Object.freeze({
  fontconfigProbePath: "/usr/bin/fc-match",
  shellPath: "/usr/bin/busybox",
  xdgUserDirPath: "/usr/bin/xdg-user-dir",
} as const);

type ResolvedManagedGodotRuntimePreflightInputV1 =
  ManagedGodotRuntimePreflightInputV1 & {
    readonly fontconfigProbePath: string;
    readonly shellPath: string;
    readonly xdgUserDirPath: string;
  };

export interface ManagedGodotRuntimePreflightResultV1 {
  readonly capability: ManagedGodotRuntimeCapabilityV1;
  readonly binding: ManagedGodotRuntimeBindingV1;
}

const fail = (message: string, cause?: unknown): M1Error =>
  new M1Error("sandbox_preflight_failed", message, cause);

const contained = (root: string, candidate: string): boolean => {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
};

const normalizedAbsolute = (value: string): boolean =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("\0") &&
  isAbsolute(value) &&
  resolve(value) === value;

const normalizedAddonPath = (value: string): boolean =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= MAX_ADDON_PATH_BYTES &&
  value.normalize("NFC") === value &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

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
    throw fail(`managed Godot addon ${label} changed during inspection`);
  }
};

const nodeAddonInspection: ManagedGodotAddonInspectionPortV1 = {
  inspect: async (addonRoot) => {
    const files: ManagedGodotAddonInspectionEntryV1[] = [];
    let entryCount = 0;

    const visit = async (
      directoryPath: string,
      relativeSegments: readonly string[],
      depth: number,
    ): Promise<void> => {
      if (depth > MAX_ADDON_DEPTH) {
        throw fail("managed Godot addon exceeds its directory depth bound");
      }
      if (!contained(addonRoot, directoryPath)) {
        throw fail("managed Godot addon path escaped its root");
      }
      const before = await lstat(directoryPath, { bigint: true });
      if (before.isSymbolicLink()) {
        throw fail("managed Godot addon contains a symbolic link");
      }
      if (!before.isDirectory()) {
        throw fail("managed Godot addon root entry is not a directory");
      }
      if ((await realpath(directoryPath)) !== directoryPath) {
        throw fail("managed Godot addon directory is not canonical");
      }

      const entries: { readonly name: string }[] = [];
      const directory = await opendir(directoryPath);
      for await (const entry of directory) {
        entryCount += 1;
        if (entryCount > MAX_ADDON_ENTRIES) {
          throw fail("managed Godot addon exceeds its entry bound");
        }
        entries.push({ name: entry.name });
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (
          entry.name.length === 0 ||
          entry.name === "." ||
          entry.name === ".." ||
          entry.name.includes("/") ||
          entry.name.includes("\\") ||
          entry.name.includes("\0") ||
          entry.name.normalize("NFC") !== entry.name
        ) {
          throw fail("managed Godot addon contains an invalid entry name");
        }
        const segments = [...relativeSegments, entry.name];
        const relativePath = segments.join("/");
        if (!normalizedAddonPath(relativePath)) {
          throw fail("managed Godot addon path is not normalized");
        }
        const candidate = join(addonRoot, ...segments);
        if (!contained(addonRoot, candidate)) {
          throw fail("managed Godot addon path escaped its root");
        }
        const beforeEntry = await lstat(candidate, { bigint: true });
        if (beforeEntry.isSymbolicLink()) {
          throw fail("managed Godot addon contains a symbolic link");
        }
        if ((await realpath(candidate)) !== candidate) {
          throw fail("managed Godot addon entry is not canonical");
        }
        if (beforeEntry.isDirectory()) {
          await visit(candidate, segments, depth + 1);
          assertUnchanged(
            beforeEntry,
            await lstat(candidate, { bigint: true }),
            "directory",
          );
          continue;
        }
        if (!beforeEntry.isFile()) {
          throw fail("managed Godot addon contains an unsupported entry");
        }
        if (
          beforeEntry.size < 1n ||
          beforeEntry.size > BigInt(MAX_ADDON_FILE_BYTES)
        ) {
          throw fail("managed Godot addon file has an invalid size");
        }
        const handle = await open(
          candidate,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        let bytes: Buffer;
        try {
          const opened = await handle.stat({ bigint: true });
          assertUnchanged(beforeEntry, opened, "file");
          if (!opened.isFile()) {
            throw fail("managed Godot addon entry is not a regular file");
          }
          bytes = await handle.readFile();
          assertUnchanged(opened, await handle.stat({ bigint: true }), "file");
        } finally {
          await handle.close();
        }
        const afterEntry = await lstat(candidate, { bigint: true });
        assertUnchanged(beforeEntry, afterEntry, "file");
        if ((await realpath(candidate)) !== candidate) {
          throw fail("managed Godot addon entry changed canonical identity");
        }
        if (bytes.byteLength !== Number(beforeEntry.size)) {
          throw fail(
            "managed Godot addon file changed length during inspection",
          );
        }
        files.push({
          kind: "file",
          relativePath,
          canonicalHostPath: candidate,
          bytes,
        });
        if (files.length > MAX_ADDON_FILES) {
          throw fail("managed Godot addon exceeds its file bound");
        }
      }

      assertUnchanged(
        before,
        await lstat(directoryPath, { bigint: true }),
        "directory",
      );
      if ((await realpath(directoryPath)) !== directoryPath) {
        throw fail("managed Godot addon directory changed canonical identity");
      }
    };

    await visit(addonRoot, [], 0);
    return files;
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
            rejectProbe(fail("managed runtime version probe failed", error));
            return;
          }
          resolveProbe(stdout);
        },
      );
    }),
};

const productionSidecarSource = (): string =>
  createRuntimeSidecarSource({
    godotExecutable: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
    workspaceRoot: DEFAULT_RUNTIME_SIDECAR_TARGETS.workspaceRoot,
    runtimeRoot: DEFAULT_RUNTIME_SIDECAR_TARGETS.runtimeRoot,
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
      `managed runtime requires exact Node v22.23.1, received ${nodeVersion}`,
    );
  }
  const godotVersion = normalizedVersion(godotRaw, "Godot");
  if (!/^4\.7\.1\.stable\.official\.[a-f0-9]{7,64}$/u.test(godotVersion)) {
    throw fail(
      `managed runtime requires an exact official stable Godot ${GODOT_VERSION} build, received ${godotVersion}`,
    );
  }
  return { godotVersion };
};

const validateAddonSnapshot = (
  addonRoot: string,
  rawEntries: readonly ManagedGodotAddonInspectionEntryV1[],
): readonly { readonly relativePath: string; readonly bytes: Uint8Array }[] => {
  if (rawEntries.length < 1 || rawEntries.length > MAX_ADDON_FILES) {
    throw fail("managed Godot addon must contain between 1 and 32 files");
  }
  const relativePaths = new Set<string>();
  const canonicalTargets = new Set<string>();
  const files = rawEntries.map((entry) => {
    if (!normalizedAddonPath(entry.relativePath)) {
      throw fail(
        "managed Godot addon path is not normalized or escaped its root",
      );
    }
    const expectedPath = join(addonRoot, ...entry.relativePath.split("/"));
    if (
      !contained(addonRoot, expectedPath) ||
      entry.canonicalHostPath !== expectedPath
    ) {
      throw fail(
        "managed Godot addon path escaped or changed its canonical root",
      );
    }
    if (
      relativePaths.has(entry.relativePath) ||
      canonicalTargets.has(expectedPath)
    ) {
      throw fail("managed Godot addon paths collide after normalization");
    }
    relativePaths.add(entry.relativePath);
    canonicalTargets.add(expectedPath);
    if (entry.kind === "symbolic-link") {
      throw fail("managed Godot addon contains a symbolic link");
    }
    if (entry.kind !== "file") {
      throw fail("managed Godot addon inspection returned a non-file entry");
    }
    if (
      !(entry.bytes instanceof Uint8Array) ||
      entry.bytes.byteLength < 1 ||
      entry.bytes.byteLength > MAX_ADDON_FILE_BYTES
    ) {
      throw fail("managed Godot addon file has invalid bytes");
    }
    return {
      relativePath: entry.relativePath,
      bytes: Uint8Array.from(entry.bytes),
    };
  });
  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  return files;
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
  input: ResolvedManagedGodotRuntimePreflightInputV1,
): void => {
  const nodeBinding = binding.files.find(
    (file) => file.target === DEFAULT_RUNTIME_SIDECAR_TARGETS.nodeExecutable,
  );
  const godotBinding = binding.files.find(
    (file) => file.target === DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
  );
  if (nodeBinding?.hostPath !== input.nodePath) {
    throw fail("managed Node target resolved to an unexpected Host path");
  }
  if (godotBinding?.hostPath !== input.godotPath) {
    throw fail("managed Godot target resolved to an unexpected Host path");
  }
  for (const [label, target, hostPath] of [
    ["shell", DEFAULT_RUNTIME_SIDECAR_TARGETS.shellExecutable, input.shellPath],
    [
      "xdg-user-dir",
      DEFAULT_RUNTIME_SIDECAR_TARGETS.xdgUserDirExecutable,
      input.xdgUserDirPath,
    ],
  ] as const) {
    if (
      binding.files.find((file) => file.target === target)?.hostPath !==
      hostPath
    ) {
      throw fail(`managed ${label} target resolved to an unexpected Host path`);
    }
  }
  if (
    !binding.files.some(
      (file) =>
        basename(file.target) === "libfontconfig.so.1" &&
        file.target.startsWith("/"),
    )
  ) {
    throw fail("managed fontconfig dependency closure is incomplete");
  }
};

const assertPreflightInput = (
  input: ResolvedManagedGodotRuntimePreflightInputV1,
): void => {
  for (const [label, path] of [
    ["Node", input.nodePath],
    ["Godot", input.godotPath],
    ["fontconfig probe", input.fontconfigProbePath],
    ["shell", input.shellPath],
    ["xdg-user-dir", input.xdgUserDirPath],
    ["ldd", input.lddPath],
    ["addon", input.addonRoot],
  ] as const) {
    if (!normalizedAbsolute(path)) {
      throw fail(
        `managed runtime ${label} path must be absolute and normalized`,
      );
    }
  }
  if (
    basename(input.addonRoot) !== "chronorift" ||
    basename(dirname(input.addonRoot)) !== "addons"
  ) {
    throw fail(
      "managed Godot addon root must be the chronorift addon directory",
    );
  }
  if (input.sidecarSource !== productionSidecarSource()) {
    throw fail("managed runtime production sidecar source identity mismatch");
  }
};

export async function preflightManagedGodotRuntimeV1(
  input: ManagedGodotRuntimePreflightInputV1,
  dependencies: ManagedGodotRuntimePreflightDependenciesV1 = {},
): Promise<ManagedGodotRuntimePreflightResultV1> {
  try {
    const resolvedInput: ResolvedManagedGodotRuntimePreflightInputV1 = {
      ...input,
      fontconfigProbePath:
        input.fontconfigProbePath ??
        DEFAULT_MANAGED_GODOT_HOST_DEPENDENCY_PATHS.fontconfigProbePath,
      shellPath:
        input.shellPath ??
        DEFAULT_MANAGED_GODOT_HOST_DEPENDENCY_PATHS.shellPath,
      xdgUserDirPath:
        input.xdgUserDirPath ??
        DEFAULT_MANAGED_GODOT_HOST_DEPENDENCY_PATHS.xdgUserDirPath,
    };
    assertPreflightInput(resolvedInput);
    const executableTrust =
      dependencies.executableTrust ?? assertTrustedHostExecutablePath;
    const trustedPaths = await Promise.all([
      executableTrust(resolvedInput.nodePath),
      executableTrust(resolvedInput.godotPath),
      executableTrust(resolvedInput.fontconfigProbePath),
      executableTrust(resolvedInput.shellPath),
      executableTrust(resolvedInput.xdgUserDirPath),
      executableTrust(resolvedInput.lddPath),
    ]);
    if (
      trustedPaths[0] !== resolvedInput.nodePath ||
      trustedPaths[1] !== resolvedInput.godotPath ||
      trustedPaths[2] !== resolvedInput.fontconfigProbePath ||
      trustedPaths[3] !== resolvedInput.shellPath ||
      trustedPaths[4] !== resolvedInput.xdgUserDirPath ||
      trustedPaths[5] !== resolvedInput.lddPath
    ) {
      throw fail("managed runtime executable path changed canonical identity");
    }

    const inspectToolchain = () =>
      inspectSandboxToolchain({
        lddPath: resolvedInput.lddPath,
        commands: [
          {
            target: DEFAULT_RUNTIME_SIDECAR_TARGETS.nodeExecutable,
            hostPath: resolvedInput.nodePath,
          },
          {
            target: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
            hostPath: resolvedInput.godotPath,
          },
        ],
        dependencyAnchors: [
          {
            target: DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigProbeExecutable,
            hostPath: resolvedInput.fontconfigProbePath,
          },
        ],
        runtimeExecutableFiles: [
          {
            target: DEFAULT_RUNTIME_SIDECAR_TARGETS.shellExecutable,
            hostPath: resolvedInput.shellPath,
          },
          {
            target: DEFAULT_RUNTIME_SIDECAR_TARGETS.xdgUserDirExecutable,
            hostPath: resolvedInput.xdgUserDirPath,
          },
        ],
        ...(dependencies.toolchainInspection === undefined
          ? {}
          : { inspection: dependencies.toolchainInspection }),
      });
    const addonInspection = dependencies.addonInspection ?? nodeAddonInspection;
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
      target: DEFAULT_RUNTIME_SIDECAR_TARGETS.nodeExecutable,
    });
    const godotVersion = await processProbe.probeVersion({
      kind: "godot",
      executable: input.godotPath,
      target: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
    });
    const versions = assertVersions(nodeVersion, godotVersion);

    const retrustedPaths = await Promise.all([
      executableTrust(resolvedInput.nodePath),
      executableTrust(resolvedInput.godotPath),
      executableTrust(resolvedInput.fontconfigProbePath),
      executableTrust(resolvedInput.shellPath),
      executableTrust(resolvedInput.xdgUserDirPath),
      executableTrust(resolvedInput.lddPath),
    ]);
    if (
      retrustedPaths[0] !== trustedPaths[0] ||
      retrustedPaths[1] !== trustedPaths[1] ||
      retrustedPaths[2] !== trustedPaths[2] ||
      retrustedPaths[3] !== trustedPaths[3] ||
      retrustedPaths[4] !== trustedPaths[4] ||
      retrustedPaths[5] !== trustedPaths[5]
    ) {
      throw fail("managed runtime executable trust changed during preflight");
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
      throw fail("managed runtime toolchain identity changed during preflight");
    }
    if (addonIdentity(firstAddon) !== addonIdentity(secondAddon)) {
      throw fail("managed Godot addon identity changed during preflight");
    }

    return createManagedGodotRuntimeV1({
      doctorVersion: versions.godotVersion,
      nodeTarget: DEFAULT_RUNTIME_SIDECAR_TARGETS.nodeExecutable,
      godotTarget: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
      toolchain: secondToolchain,
      sidecarSource: input.sidecarSource,
      addonFiles: secondAddon,
    });
  } catch (error) {
    if (error instanceof M1Error) throw error;
    throw fail("managed Godot runtime preflight failed closed", error);
  }
}
