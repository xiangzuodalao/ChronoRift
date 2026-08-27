import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, realpath, stat } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { managedGodotBinary } from "@chronorift/godot-adapter";
import { asSha256DigestV1, type Sha256DigestV1 } from "@chronorift/domain";

const execFileAsync = promisify(execFile);
const EXACT_GODOT_VERSION = "4.7.1" as const;
const EXACT_TOOLCHAIN_KEY = "godot-4.7.1-linux-x86_64-official" as const;
const OFFICIAL_VERSION = /^4\.7\.1\.stable\.official\.[a-f0-9]{7,64}$/u;

export interface SrtRuntimeConfigInput {
  readonly repositoryRoot?: string | undefined;
  readonly stateRoot?: string | undefined;
  readonly godotBin?: string | undefined;
  readonly environment?:
    Readonly<Record<string, string | undefined>> | undefined;
}

export interface SrtRuntimeConfig {
  readonly stateRoot: string;
  readonly nodePath: string;
  readonly godot: {
    readonly receipt: SrtGodotToolchainReceipt;
    readonly binding: SrtGodotToolchainBinding;
  };
}

/** Structurally compatible with the current PE toolchain receipt. */
export interface SrtGodotToolchainReceipt {
  readonly schemaVersion: 1;
  readonly registryKey: typeof EXACT_TOOLCHAIN_KEY;
  readonly requestedVersion: typeof EXACT_GODOT_VERSION;
  readonly realizedVersion: typeof EXACT_GODOT_VERSION;
  readonly realizedVersionOutput: string;
  readonly platform: "linux-x86_64";
  readonly executableSha256: Sha256DigestV1;
  readonly buildFeatures: readonly string[];
  readonly renderer: "gl_compatibility";
}

export interface SrtGodotToolchainBinding {
  readonly executablePath: string;
}

export interface SrtRuntimeConfigDependencies {
  readonly platform: () => NodeJS.Platform;
  readonly architecture: () => string;
  readonly homeDirectory: () => string;
  readonly probeGodotVersion: (path: string, cwd: string) => Promise<string>;
  readonly sha256File: (path: string) => Promise<Sha256DigestV1>;
}

const sha256File = async (path: string): Promise<Sha256DigestV1> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } finally {
    await handle.close();
  }
  return asSha256DigestV1(hash.digest("hex"));
};

const probeGodotVersion = async (
  path: string,
  cwd: string,
): Promise<string> => {
  const { stdout } = await execFileAsync(path, ["--version"], {
    cwd,
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
  });
  return stdout;
};

const DEFAULT_DEPENDENCIES: SrtRuntimeConfigDependencies = {
  platform,
  architecture: arch,
  homeDirectory: homedir,
  probeGodotVersion,
  sha256File,
};

const nonemptyPath = (value: string, label: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty path without NUL bytes`);
  }
  return trimmed;
};

const ensureWritableDirectory = async (path: string): Promise<string> => {
  await mkdir(path, { recursive: true });
  const canonical = await realpath(path);
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) {
    throw new TypeError(`state root is not a directory: ${canonical}`);
  }
  await access(canonical, constants.W_OK);
  return canonical;
};

const canonicalExecutable = async (
  requestedPath: string,
  repositoryRoot: string,
): Promise<string> => {
  const absolute = resolve(
    repositoryRoot,
    nonemptyPath(requestedPath, "godotBin"),
  );
  const canonical = await realpath(absolute);
  const metadata = await stat(canonical);
  if (!metadata.isFile()) {
    throw new TypeError(`Godot binary is not a regular file: ${canonical}`);
  }
  await access(canonical, constants.X_OK);
  return canonical;
};

const selectedStateRoot = (
  input: SrtRuntimeConfigInput,
  environment: Readonly<Record<string, string | undefined>>,
  repositoryRoot: string,
  homeDirectory: string,
): string => {
  if (input.stateRoot !== undefined) {
    return resolve(repositoryRoot, nonemptyPath(input.stateRoot, "stateRoot"));
  }
  if (environment.CHRONORIFT_STATE_ROOT !== undefined) {
    return resolve(
      repositoryRoot,
      nonemptyPath(environment.CHRONORIFT_STATE_ROOT, "CHRONORIFT_STATE_ROOT"),
    );
  }
  if (environment.XDG_STATE_HOME !== undefined) {
    return resolve(
      repositoryRoot,
      nonemptyPath(environment.XDG_STATE_HOME, "XDG_STATE_HOME"),
      "chronorift",
    );
  }
  return resolve(homeDirectory, ".local", "state", "chronorift");
};

export async function resolveSrtRuntimeConfig(
  input: SrtRuntimeConfigInput = {},
  dependencyOverrides: Partial<SrtRuntimeConfigDependencies> = {},
): Promise<SrtRuntimeConfig> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  if (dependencies.platform() !== "linux") {
    throw new Error("ChronoRift SRT runtime supports Linux only");
  }
  if (dependencies.architecture() !== "x64") {
    throw new Error(
      "ChronoRift Godot 4.7.1 runtime supports Linux x86_64 only",
    );
  }

  const repositoryRoot = await realpath(
    resolve(input.repositoryRoot ?? process.cwd()),
  );
  const environment = input.environment ?? process.env;
  const stateRoot = await ensureWritableDirectory(
    selectedStateRoot(
      input,
      environment,
      repositoryRoot,
      dependencies.homeDirectory(),
    ),
  );
  const requestedGodot =
    input.godotBin ??
    environment.GODOT_BIN ??
    managedGodotBinary(repositoryRoot);
  const godotPath = await canonicalExecutable(requestedGodot, repositoryRoot);
  const nodePath = await realpath(process.execPath);
  const [rawVersion, executableSha256] = await Promise.all([
    dependencies.probeGodotVersion(godotPath, repositoryRoot),
    dependencies.sha256File(godotPath),
  ]);
  const realizedVersionOutput = rawVersion.trim();
  if (
    realizedVersionOutput.length > 128 ||
    !OFFICIAL_VERSION.test(realizedVersionOutput)
  ) {
    throw new Error("Godot binary must be an exact official Godot 4.7.1 build");
  }

  return Object.freeze({
    stateRoot,
    nodePath,
    godot: Object.freeze({
      receipt: Object.freeze({
        schemaVersion: 1 as const,
        registryKey: EXACT_TOOLCHAIN_KEY,
        requestedVersion: EXACT_GODOT_VERSION,
        realizedVersion: EXACT_GODOT_VERSION,
        realizedVersionOutput,
        platform: "linux-x86_64" as const,
        executableSha256,
        buildFeatures: Object.freeze(["gdscript", "headless"]),
        renderer: "gl_compatibility" as const,
      }),
      binding: Object.freeze({ executablePath: godotPath }),
    }),
  });
}
