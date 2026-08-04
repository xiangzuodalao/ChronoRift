import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

export const GODOT_VERSION = "4.7.1";
export const GODOT_RELEASE = "4.7.1-stable";
export const GODOT_LINUX_X86_64_SHA256 =
  "c7ff14fd28472c8d4f193043de30278dcf7e5241a1dcf7566b02e27addaa33ba";
export const GODOT_LINUX_X86_64_SHA512 =
  "4ccdab7a48eeccbe8819a2fc1f6262f8d72065d98601bcb3743fcbd7ebd39f373758a788ee3293a05ec5b2c48538266c437404312e372225cd2df273945a2de9";

const releaseFile = `Godot_v${GODOT_RELEASE}_linux.x86_64.zip`;
const releaseUrl = `https://github.com/godotengine/godot-builds/releases/download/${GODOT_RELEASE}/${releaseFile}`;

export class GodotInstallError extends Error {
  public override readonly name = "GodotInstallError";
}

export const managedGodotBinary = (cwd: string): string =>
  resolve(
    cwd,
    ".tools",
    "godot",
    GODOT_VERSION,
    `Godot_v${GODOT_RELEASE}_linux.x86_64`,
  );

export const resolveGodotBinary = (options: {
  readonly cwd: string;
  readonly godotBin?: string | undefined;
}): string => {
  const candidate =
    options.godotBin ??
    process.env.GODOT_BIN?.trim() ??
    managedGodotBinary(options.cwd);
  if (!candidate) throw new GodotInstallError("Godot binary path is empty");
  return resolve(candidate);
};

const normalizedVersion = (raw: string): string =>
  raw.trim().split("\n")[0] ?? "";

export interface GodotDoctorReport {
  readonly ok: true;
  readonly binary: string;
  readonly version: string;
  readonly requiredVersion: typeof GODOT_VERSION;
  readonly platform: string;
  readonly architecture: string;
}

export const doctorGodot = async (options: {
  readonly cwd: string;
  readonly godotBin?: string | undefined;
}): Promise<GodotDoctorReport> => {
  const binary = resolveGodotBinary(options);
  try {
    await access(binary, constants.X_OK);
  } catch (error) {
    throw new GodotInstallError(
      `Godot ${GODOT_VERSION} binary is not executable at ${binary}. Run corepack pnpm godot:install or pass --godot-bin.`,
      { cause: error },
    );
  }
  const { stdout } = await execFileAsync(binary, ["--version"], {
    cwd: options.cwd,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const version = normalizedVersion(stdout);
  if (!version.startsWith(`${GODOT_VERSION}.`)) {
    throw new GodotInstallError(
      `ChronoRift v0.3 requires Godot ${GODOT_VERSION}, received ${version || "unknown"}`,
    );
  }
  return {
    ok: true,
    binary,
    version,
    requiredVersion: GODOT_VERSION,
    platform: platform(),
    architecture: arch(),
  };
};

const digest = (algorithm: "sha256" | "sha512", value: Uint8Array): string =>
  createHash(algorithm).update(value).digest("hex");

export const installGodot = async (options: {
  readonly cwd: string;
}): Promise<GodotDoctorReport> => {
  if (platform() !== "linux" || arch() !== "x64") {
    throw new GodotInstallError(
      "The v0.3 managed installer currently supports Linux x86_64 only; use GODOT_BIN on other platforms.",
    );
  }
  const binary = managedGodotBinary(options.cwd);
  try {
    return await doctorGodot({ cwd: options.cwd, godotBin: binary });
  } catch {
    // Continue with an explicit, checksum-verified install.
  }
  const versionRoot = dirname(binary);
  const downloads = resolve(options.cwd, ".tools", "downloads");
  await mkdir(versionRoot, { recursive: true });
  await mkdir(downloads, { recursive: true });
  const archive = resolve(downloads, releaseFile);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(archive);
  } catch {
    await execFileAsync(
      "curl",
      [
        "--fail",
        "--location",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--output",
        `${archive}.partial`,
        releaseUrl,
      ],
      { cwd: options.cwd, timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    bytes = await readFile(`${archive}.partial`);
    await rename(`${archive}.partial`, archive);
  }
  if (
    digest("sha256", bytes) !== GODOT_LINUX_X86_64_SHA256 ||
    digest("sha512", bytes) !== GODOT_LINUX_X86_64_SHA512
  ) {
    throw new GodotInstallError("Downloaded Godot archive checksum mismatch");
  }
  await execFileAsync("unzip", ["-n", archive, "-d", versionRoot], {
    cwd: options.cwd,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  await chmod(binary, 0o755);
  return doctorGodot({ cwd: options.cwd, godotBin: binary });
};
