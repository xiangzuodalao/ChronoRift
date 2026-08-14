import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import {
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";

import { M1Error } from "./errors.js";
import { assertTrustedHostExecutablePath } from "./sandbox-preflight.js";

const execFileAsync = promisify(execFile);
const MAX_CONFIG_BYTES = 64 * 1024;
const EXACT_GODOT_VERSION = "4.7.1" as const;
const EXACT_TOOLCHAIN_KEY = "godot-4.7.1-linux-x86_64-official" as const;

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.includes("\0") && isAbsolute(value) && resolve(value) === value,
    "path must be normalized and absolute",
  );

const GodotToolchainRegistryEntryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    key: z.literal(EXACT_TOOLCHAIN_KEY),
    version: z.literal(EXACT_GODOT_VERSION),
    platform: z.literal("linux-x86_64"),
    channel: z.literal("stable-official"),
    executablePath: AbsolutePathSchema,
    executableSha256: Sha256DigestV1Schema,
    buildFeatures: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u))
      .min(1)
      .max(32),
    renderer: z.literal("gl_compatibility"),
  })
  .strict();

export const ProjectEnvironmentHostConfigV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    configKind: z.literal("chronorift-project-environment-host"),
    taskStorageRoot: AbsolutePathSchema,
    runtimeRoot: AbsolutePathSchema,
    delegatedCgroupRoot: AbsolutePathSchema,
    bwrapPath: AbsolutePathSchema,
    prlimitPath: AbsolutePathSchema,
    busyboxPath: AbsolutePathSchema,
    fontconfigProbePath: AbsolutePathSchema,
    xdgUserDirPath: AbsolutePathSchema,
    nodePath: AbsolutePathSchema,
    bashPath: AbsolutePathSchema,
    rgPath: AbsolutePathSchema,
    findPath: AbsolutePathSchema,
    lsPath: AbsolutePathSchema,
    lddPath: AbsolutePathSchema,
    godotToolchains: z.array(GodotToolchainRegistryEntryV1Schema).length(1),
  })
  .strict();

export type ProjectEnvironmentHostConfigV1 = z.infer<
  typeof ProjectEnvironmentHostConfigV1Schema
>;

export interface ProjectEnvironmentToolchainReceiptV1 {
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

export interface ProjectEnvironmentToolchainBindingV1 {
  readonly executablePath: string;
}

interface ToolchainInspectionDependencies {
  readonly trustExecutable: (path: string) => Promise<string>;
  readonly sha256File: (path: string) => Promise<Sha256DigestV1>;
  readonly probeVersion: (path: string) => Promise<string>;
}

const defaultConfigRoot = (): string =>
  process.env.XDG_CONFIG_HOME === undefined
    ? join(homedir(), ".config")
    : resolve(process.env.XDG_CONFIG_HOME);

export const defaultProjectEnvironmentHostConfigPath = (): string =>
  join(defaultConfigRoot(), "chronorift", "project-environment-host.v1.json");

const sha256File = async (path: string): Promise<Sha256DigestV1> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      start: 0,
    })) {
      hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } finally {
    await handle.close();
  }
  return asSha256DigestV1(hash.digest("hex"));
};

const probeVersion = async (path: string): Promise<string> => {
  const { stdout } = await execFileAsync(path, ["--version"], {
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

const DEFAULT_INSPECTION: ToolchainInspectionDependencies = {
  trustExecutable: assertTrustedHostExecutablePath,
  sha256File,
  probeVersion,
};

export async function readProjectEnvironmentHostConfigV1(
  inputPath = defaultProjectEnvironmentHostConfigPath(),
): Promise<ProjectEnvironmentHostConfigV1> {
  const absolutePath = resolve(inputPath);
  const canonicalPath = await realpath(absolutePath);
  if (canonicalPath !== absolutePath) {
    throw new M1Error(
      "path_denied",
      "Project Environment Host config path must be canonical",
    );
  }
  const [before, parent] = await Promise.all([
    lstat(canonicalPath),
    realpath(dirname(canonicalPath)),
  ]);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size < 1 ||
    before.size > MAX_CONFIG_BYTES ||
    parent !== dirname(canonicalPath)
  ) {
    throw new M1Error(
      "path_denied",
      "Project Environment Host config must be a bounded canonical regular file",
    );
  }
  const handle = await open(
    canonicalPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new M1Error(
        "path_denied",
        "Project Environment Host config identity changed while opening",
      );
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytes.byteLength !== before.size) {
    throw new M1Error(
      "source_configuration_mismatch",
      "Project Environment Host config changed while reading",
    );
  }
  try {
    return ProjectEnvironmentHostConfigV1Schema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown,
    );
  } catch (error) {
    throw new M1Error(
      "source_configuration_mismatch",
      "Project Environment Host config is invalid",
      error,
    );
  }
}

export async function resolveProjectEnvironmentGodotToolchainV1(
  config: ProjectEnvironmentHostConfigV1,
  requestedVersion: string,
  dependencies: Partial<ToolchainInspectionDependencies> = {},
): Promise<{
  readonly receipt: ProjectEnvironmentToolchainReceiptV1;
  readonly binding: ProjectEnvironmentToolchainBindingV1;
}> {
  const parsed = ProjectEnvironmentHostConfigV1Schema.parse(config);
  if (requestedVersion !== EXACT_GODOT_VERSION) {
    throw new M1Error(
      "source_feature_unsupported",
      "PE-A supports only exact Godot 4.7.1",
    );
  }
  const toolchain = parsed.godotToolchains[0];
  if (toolchain === undefined) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "Godot 4.7.1 is not installed in the managed Host registry",
    );
  }
  const inspection = { ...DEFAULT_INSPECTION, ...dependencies };
  const trustedPath = await inspection.trustExecutable(
    toolchain.executablePath,
  );
  if (trustedPath !== toolchain.executablePath) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "Godot registry executable changed canonical identity",
    );
  }
  const [actualSha256, rawVersion] = await Promise.all([
    inspection.sha256File(trustedPath),
    inspection.probeVersion(trustedPath),
  ]);
  if (actualSha256 !== toolchain.executableSha256) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "Godot registry executable content hash changed",
    );
  }
  const realizedVersionOutput = rawVersion.trim();
  if (
    realizedVersionOutput.length > 128 ||
    !/^4\.7\.1\.stable\.official\.[a-f0-9]{7,64}$/u.test(realizedVersionOutput)
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "managed registry entry is not an exact official Godot 4.7.1 build",
    );
  }
  return Object.freeze({
    receipt: Object.freeze({
      schemaVersion: 1 as const,
      registryKey: toolchain.key,
      requestedVersion: EXACT_GODOT_VERSION,
      realizedVersion: EXACT_GODOT_VERSION,
      realizedVersionOutput,
      platform: toolchain.platform,
      executableSha256: actualSha256,
      buildFeatures: Object.freeze([...toolchain.buildFeatures]),
      renderer: toolchain.renderer,
    }),
    binding: Object.freeze({ executablePath: trustedPath }),
  });
}
