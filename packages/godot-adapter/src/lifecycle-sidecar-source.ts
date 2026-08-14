import { isAbsolute, posix } from "node:path";

import { GODOT_LIFECYCLE_RUNTIME_PROFILE_V1 } from "@chronorift/godot-protocol";

import {
  EXTERNAL_GODOT_MAX_BYTES_V1,
  EXTERNAL_GODOT_MAX_FILES_V1,
  EXTERNAL_GODOT_UNSUPPORTED_SUFFIXES_V1,
} from "./external-source-policy.js";

import {
  DEFAULT_RUNTIME_SIDECAR_TARGETS,
  MANAGED_FONTCONFIG_SOURCE,
} from "./runtime-sidecar-source.js";

export const GODOT_LIFECYCLE_OVERRIDE_SOURCE =
  '[autoload]\n\nChronoRiftLifecycle="*res://addons/chronorift_lifecycle/lifecycle_probe.gd"\n';
export const GODOT_SEMANTIC_OVERRIDE_SOURCE =
  '[autoload]\n\nChronoRiftSemantic="*res://addons/chronorift_semantic/semantic_probe.gd"\n';

export const DEFAULT_LIFECYCLE_SIDECAR_TARGETS = Object.freeze({
  nodeExecutable: DEFAULT_RUNTIME_SIDECAR_TARGETS.nodeExecutable,
  godotExecutable: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
  fontconfigProbeExecutable:
    DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigProbeExecutable,
  shellExecutable: DEFAULT_RUNTIME_SIDECAR_TARGETS.shellExecutable,
  xdgUserDirExecutable: DEFAULT_RUNTIME_SIDECAR_TARGETS.xdgUserDirExecutable,
  fontconfigFile: DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigFile,
  godotPath: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotPath,
  workspaceRoot: "/workspace",
  runtimeRoot: "/run/chronorift",
  vanillaProjectRoot: "/run/chronorift/vanilla/project",
  overlayProjectRoot: "/run/chronorift/overlay/project",
  managedAddonParent: "/run/chronorift/overlay/project/addons",
  managedAddonRoot:
    "/run/chronorift/overlay/project/addons/chronorift_lifecycle",
  managedOverrideFile: "/run/chronorift/overlay/project/override.cfg",
} as const);

export const DEFAULT_SEMANTIC_SIDECAR_TARGETS = Object.freeze({
  ...DEFAULT_LIFECYCLE_SIDECAR_TARGETS,
  managedAddonRoot:
    "/run/chronorift/overlay/project/addons/chronorift_semantic",
} as const);

export { MANAGED_FONTCONFIG_SOURCE as LIFECYCLE_MANAGED_FONTCONFIG_SOURCE };

export interface LifecycleSidecarSourceOptions {
  readonly godotExecutable: string;
  readonly workspaceRoot: string;
  readonly runtimeRoot: string;
  readonly godotArgsPrefix?: readonly string[] | undefined;
  readonly managedProfile?:
    | {
        readonly runtimeProfile: "chronorift-managed-godot-semantic-v1";
        readonly protocolProfile: "chronorift-godot-semantic-v1";
        readonly addonDirectory: "chronorift_semantic";
        readonly reservedAutoload: "ChronoRiftSemantic";
        readonly adapterProfileHash: true;
        readonly projectEnvironment?: false | undefined;
        readonly launchSchemaVersion?: 1 | undefined;
      }
    | {
        readonly runtimeProfile: "chronorift-managed-godot-project-environment-v1";
        readonly protocolProfile: "chronorift-godot-project-environment-v1";
        readonly addonDirectory: "chronorift_project_environment";
        readonly reservedAutoload: "ChronoRiftProjectEnvironment";
        readonly adapterProfileHash: false;
        readonly projectEnvironment: true;
        readonly launchSchemaVersion?: 1 | undefined;
      }
    | {
        readonly runtimeProfile: "chronorift-managed-godot-project-environment-v2";
        readonly protocolProfile: "chronorift-godot-project-environment-v2";
        readonly addonDirectory: "chronorift_project_environment";
        readonly reservedAutoload: "ChronoRiftProjectEnvironment";
        readonly adapterProfileHash: false;
        readonly projectEnvironment: true;
        readonly launchSchemaVersion: 2;
      }
    | undefined;
}

const assertAbsoluteNormalized = (label: string, value: string): void => {
  if (
    !isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.includes("\0")
  ) {
    throw new TypeError(`${label} must be a normalized absolute path`);
  }
};

const createLifecycleSidecarSource = (
  operation: "vanilla_smoke" | "managed_lifecycle",
  options: LifecycleSidecarSourceOptions,
): string => {
  assertAbsoluteNormalized("godotExecutable", options.godotExecutable);
  assertAbsoluteNormalized("workspaceRoot", options.workspaceRoot);
  assertAbsoluteNormalized("runtimeRoot", options.runtimeRoot);
  const argsPrefix = [...(options.godotArgsPrefix ?? [])];
  const managedProfile = options.managedProfile ?? {
    runtimeProfile: GODOT_LIFECYCLE_RUNTIME_PROFILE_V1,
    protocolProfile: "chronorift-godot-lifecycle-v1" as const,
    addonDirectory: "chronorift_lifecycle" as const,
    reservedAutoload: "ChronoRiftLifecycle" as const,
    adapterProfileHash: false as const,
    projectEnvironment: false as const,
    launchSchemaVersion: 1 as const,
  };
  if (
    argsPrefix.length > 16 ||
    argsPrefix.some(
      (argument) =>
        argument.includes("\0") || Buffer.byteLength(argument, "utf8") > 4_096,
    )
  ) {
    throw new TypeError("godotArgsPrefix exceeds its trusted Host bound");
  }

  return String.raw`"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const OPERATION = ${JSON.stringify(operation)};
const RUNTIME_PROFILE = ${JSON.stringify(managedProfile.runtimeProfile)};
const PROTOCOL_PROFILE = ${JSON.stringify(managedProfile.protocolProfile)};
const ADDON_DIRECTORY = ${JSON.stringify(managedProfile.addonDirectory)};
const RESERVED_AUTOLOAD = ${JSON.stringify(managedProfile.reservedAutoload)};
const REQUIRES_ADAPTER_PROFILE_HASH = ${JSON.stringify(managedProfile.adapterProfileHash)};
const PROJECT_ENVIRONMENT = ${JSON.stringify(managedProfile.projectEnvironment === true)};
const LAUNCH_SCHEMA_VERSION = ${JSON.stringify(managedProfile.launchSchemaVersion ?? 1)};
const SUPPORTS_LAUNCH_SCENE = PROJECT_ENVIRONMENT && LAUNCH_SCHEMA_VERSION === 2;
const MANAGED_RUNTIME_ID = ${
    managedProfile.projectEnvironment === true
      ? managedProfile.runtimeProfile ===
        "chronorift-managed-godot-project-environment-v2"
        ? "/^managed-godot-project-environment:v2:[a-f0-9]{64}$/u"
        : "/^managed-godot-project-environment:v1:[a-f0-9]{64}$/u"
      : managedProfile.adapterProfileHash
        ? "/^managed-godot-semantic-runtime:v1:[a-f0-9]{64}$/u"
        : "/^managed-godot-runtime:v1:[a-f0-9]{64}$/u"
  };
const GODOT_EXECUTABLE = ${JSON.stringify(options.godotExecutable)};
const GODOT_ARGS_PREFIX = Object.freeze(${JSON.stringify(argsPrefix)});
const WORKSPACE_ROOT = ${JSON.stringify(options.workspaceRoot)};
const RUNTIME_ROOT = ${JSON.stringify(options.runtimeRoot)};
const PROJECT_ROOT = path.join(RUNTIME_ROOT, OPERATION === "vanilla_smoke" ? "vanilla/project" : "overlay/project");
const ADDON_ROOT = path.join(PROJECT_ROOT, "addons", ADDON_DIRECTORY);
const OVERRIDE_FILE = path.join(PROJECT_ROOT, "override.cfg");
const PROC_SELF_FD = "/proc/self/fd";
const MAX_LAUNCH_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_FILES = ${String(EXTERNAL_GODOT_MAX_FILES_V1)};
const MAX_SOURCE_BYTES = ${String(EXTERNAL_GODOT_MAX_BYTES_V1)};
const UNSUPPORTED_SOURCE_SUFFIXES = Object.freeze(${JSON.stringify(EXTERNAL_GODOT_UNSUPPORTED_SUFFIXES_V1)});
const TERMINAL_DIAGNOSTIC_RESERVE_BYTES = 8 * 1024;
const TERMINAL_DIAGNOSTIC_RESERVE_COUNT = 8;
const HASH = /^[a-f0-9]{64}$/u;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
let child;
let server;
let peer;
let startupTimer;
let executionTimer;
let terminating = false;
let executionTimedOut = false;
let diagnosticFrameMaxBytes = 64 * 1024;
let diagnosticTotalMaxBytes = 1024 * 1024;
let diagnosticMaxCount = 128;
let diagnosticEncodedBytes = 0;
let diagnosticCount = 0;
let stagedCandidateManifest = [];

const failMessage = (error) => {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\r\n\0]/gu, " ").slice(0, 1024) || "sidecar failure";
};

const diagnostic = (record, terminal = false) => {
  try {
    const body = Buffer.from(JSON.stringify({ schemaVersion: 1, ...record }), "utf8");
    const encodedBytes = body.byteLength + 4;
    const reserveBytes = terminal ? 0 : TERMINAL_DIAGNOSTIC_RESERVE_BYTES;
    const reserveCount = terminal ? 0 : TERMINAL_DIAGNOSTIC_RESERVE_COUNT;
    if (body.byteLength < 1 || body.byteLength > diagnosticFrameMaxBytes ||
        diagnosticCount + 1 + reserveCount > diagnosticMaxCount ||
        diagnosticEncodedBytes + encodedBytes + reserveBytes > diagnosticTotalMaxBytes) return false;
    const frame = Buffer.allocUnsafe(encodedBytes);
    frame.writeUInt32BE(body.byteLength, 0);
    body.copy(frame, 4);
    diagnosticCount += 1;
    diagnosticEncodedBytes += encodedBytes;
    process.stderr.write(frame);
    return true;
  } catch {
    return false;
  }
};

const fail = (phase, code, error) => {
  if (terminating) return;
  terminating = true;
  clearTimeout(startupTimer);
  clearTimeout(executionTimer);
  diagnostic({ kind: "sidecar_error", phase, code, message: failMessage(error) }, true);
  try { peer?.destroy(); } catch {}
  try { server?.close(); } catch {}
  try { child?.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { child?.kill("SIGKILL"); } catch {} }, 500).unref();
  process.exitCode = 1;
};

const exactKeys = (value, keys) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const assertResourceId = (value) =>
  typeof value === "string" && RESOURCE_ID.test(value) && !value.includes("..");

const assertResourceReference = (value) => {
  if (typeof value !== "string" || value.length < 7 || value.length > 1024 ||
      !/^res:\/\/[A-Za-z0-9_./@+ -]+$/u.test(value) || value.includes("\\") || value.includes("\0")) return false;
  return !value.slice("res://".length).split("/").some((segment) => segment === "" || segment === "." || segment === "..");
};

const assertDiagnosticBounds = (value) =>
  Number.isInteger(value.diagnosticFrameMaxBytes) && value.diagnosticFrameMaxBytes >= 1024 && value.diagnosticFrameMaxBytes <= 1024 * 1024 &&
  Number.isInteger(value.diagnosticTotalMaxBytes) && value.diagnosticTotalMaxBytes >= 16 * 1024 && value.diagnosticTotalMaxBytes <= 16 * 1024 * 1024 &&
  value.diagnosticTotalMaxBytes >= value.diagnosticFrameMaxBytes + 4 &&
  Number.isInteger(value.diagnosticMaxCount) && value.diagnosticMaxCount >= 16 && value.diagnosticMaxCount <= 4096 &&
  Number.isInteger(value.outputCaptureMaxBytes) && value.outputCaptureMaxBytes >= 1024 && value.outputCaptureMaxBytes <= 1024 * 1024;

const parseLaunch = (json) => {
  let value;
  try { value = JSON.parse(json); } catch { throw new Error("launch prelude is not JSON"); }
  const common = [
    "schemaVersion", "runtimeProfile", "operation", "taskId", "buildId", "runtimeId", "executionId",
    "managedRuntimeId", "candidateSourceHash", "diagnosticFrameMaxBytes", "diagnosticTotalMaxBytes",
    "diagnosticMaxCount", "outputCaptureMaxBytes"
  ];
  const projectEnvironmentKeys = PROJECT_ENVIRONMENT
    ? ["instrumentationMode", "sourceClosureId", "environmentRevisionId", "adapterRevisionId", "adapterManifestSha256", "sdkSha256", "bridgeSha256", "toolchainSha256"]
    : [];
  const operationKeys = OPERATION === "vanilla_smoke"
    ? ["importTimeoutMs", "vanillaTimeoutMs", "stabilityWindowMs"]
    : ["protocolProfile", "protocolVersion", "token", "overlayHash", "addonHash", "expectedMainScene", "importTimeoutMs", "startupTimeoutMs", "executionTimeoutMs", ...projectEnvironmentKeys, ...(REQUIRES_ADAPTER_PROFILE_HASH ? ["adapterProfileSha256"] : [])];
  const launchSceneKeys = SUPPORTS_LAUNCH_SCENE && value.launchScene !== undefined ? ["launchScene"] : [];
  if (!exactKeys(value, [...common, ...operationKeys, ...launchSceneKeys]) || value.schemaVersion !== LAUNCH_SCHEMA_VERSION ||
      value.runtimeProfile !== RUNTIME_PROFILE || value.operation !== OPERATION) {
    throw new Error("launch prelude has an unsupported lifecycle shape or profile");
  }
  for (const key of ["taskId", "buildId", "runtimeId", "executionId"]) {
    if (!assertResourceId(value[key])) throw new Error("launch resource identity is invalid");
  }
  if (typeof value.managedRuntimeId !== "string" || !MANAGED_RUNTIME_ID.test(value.managedRuntimeId) ||
      typeof value.candidateSourceHash !== "string" || !HASH.test(value.candidateSourceHash) || !assertDiagnosticBounds(value)) {
    throw new Error("launch identity or diagnostic bounds are invalid");
  }
  if (OPERATION === "vanilla_smoke") {
    if (!Number.isInteger(value.importTimeoutMs) || value.importTimeoutMs < 1000 || value.importTimeoutMs > 120000 ||
        !Number.isInteger(value.vanillaTimeoutMs) || value.vanillaTimeoutMs < 2000 || value.vanillaTimeoutMs > 60000 ||
        value.stabilityWindowMs !== 2000 || value.vanillaTimeoutMs <= value.stabilityWindowMs ||
        (value.launchScene !== undefined && !assertResourceReference(value.launchScene))) {
      throw new Error("vanilla smoke time bounds are invalid");
    }
  } else if (value.protocolProfile !== PROTOCOL_PROFILE || value.protocolVersion !== LAUNCH_SCHEMA_VERSION ||
      typeof value.token !== "string" || !HASH.test(value.token) ||
      typeof value.overlayHash !== "string" || !HASH.test(value.overlayHash) ||
      typeof value.addonHash !== "string" || !HASH.test(value.addonHash) ||
      (REQUIRES_ADAPTER_PROFILE_HASH && (typeof value.adapterProfileSha256 !== "string" || !HASH.test(value.adapterProfileSha256))) ||
      typeof value.expectedMainScene !== "string" || value.expectedMainScene.length < 1 || value.expectedMainScene.length > 1024 ||
      !["res://", "uid://"].some((prefix) => value.expectedMainScene.startsWith(prefix)) ||
      (value.launchScene !== undefined && !assertResourceReference(value.launchScene)) ||
      !Number.isInteger(value.importTimeoutMs) || value.importTimeoutMs < 1000 || value.importTimeoutMs > 120000 ||
      !Number.isInteger(value.startupTimeoutMs) || value.startupTimeoutMs < 1000 || value.startupTimeoutMs > 60000 ||
      !Number.isInteger(value.executionTimeoutMs) || value.executionTimeoutMs < 1000 || value.executionTimeoutMs > 600000) {
    throw new Error("managed lifecycle launch fields are invalid");
  }
  if (PROJECT_ENVIRONMENT && OPERATION !== "vanilla_smoke" &&
      (!["bridge_only", "instrumented"].includes(value.instrumentationMode) ||
       typeof value.sourceClosureId !== "string" || !assertResourceId(value.sourceClosureId) ||
       typeof value.environmentRevisionId !== "string" || !assertResourceId(value.environmentRevisionId) ||
       typeof value.adapterRevisionId !== "string" || !assertResourceId(value.adapterRevisionId) ||
       ![value.adapterManifestSha256, value.sdkSha256, value.bridgeSha256, value.toolchainSha256].every((entry) => typeof entry === "string" && HASH.test(entry)))) {
    throw new Error("Project Environment launch identity is invalid");
  }
  return value;
};

const readPrelude = () => new Promise((resolve, reject) => {
  let buffered = Buffer.alloc(0);
  const cleanup = () => {
    process.stdin.off("data", onData);
    process.stdin.off("error", onError);
    process.stdin.off("end", onEnd);
  };
  const onError = (error) => { cleanup(); reject(error); };
  const onEnd = () => { cleanup(); reject(new Error("stdin ended before launch prelude")); };
  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.byteLength < 4) return;
    const length = buffered.readUInt32BE(0);
    if (length < 1 || length > MAX_LAUNCH_BYTES) { cleanup(); reject(new Error("launch prelude frame length is invalid")); return; }
    if (buffered.byteLength < length + 4) return;
    process.stdin.pause();
    cleanup();
    try {
      resolve({ launch: parseLaunch(buffered.subarray(4, length + 4).toString("utf8")), remainder: buffered.subarray(length + 4) });
    } catch (error) { reject(error); }
  };
  process.stdin.on("data", onData);
  process.stdin.on("error", onError);
  process.stdin.on("end", onEnd);
  process.stdin.resume();
});

const contained = (root, candidate) => {
  const difference = path.relative(root, candidate);
  return difference === "" || (difference !== ".." && !difference.startsWith(".." + path.sep) && !path.isAbsolute(difference));
};

const assertDirectory = async (target) => {
  const stat = await fsp.lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fsp.realpath(target) !== target) {
    throw new Error("lifecycle source root is not a canonical directory");
  }
};

const fdPath = (handle, name) => name === undefined ? PROC_SELF_FD + "/" + handle.fd : PROC_SELF_FD + "/" + handle.fd + "/" + name;
const sameSnapshotIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink &&
  left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
const pinnedStat = (handle) => handle.stat({ bigint: true });

const openPinnedRoot = async (target) => {
  const inspected = await fsp.lstat(target, { bigint: true });
  if (inspected.isSymbolicLink() || !inspected.isDirectory()) throw new Error("candidate workspace is not a real directory");
  const handle = await fsp.open(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await pinnedStat(handle);
    if (!stat.isDirectory() || !sameSnapshotIdentity(inspected, stat) || await fsp.realpath(target) !== target || await fsp.realpath(fdPath(handle)) !== target) {
      throw new Error("candidate workspace changed before snapshot");
    }
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
};

const openPinnedEntry = async (parent, name, relativePath) => {
  const source = fdPath(parent, name);
  const inspected = await fsp.lstat(source, { bigint: true });
  if (inspected.isSymbolicLink()) throw new Error("candidate source contains a symlink: " + relativePath);
  const handle = await fsp.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await pinnedStat(handle);
    if (!sameSnapshotIdentity(inspected, stat)) throw new Error("candidate source changed during snapshot: " + relativePath);
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
};

const prepareProjectRoot = async () => {
  await assertDirectory(RUNTIME_ROOT);
  if (OPERATION === "vanilla_smoke") {
    try {
      await fsp.lstat(path.join(RUNTIME_ROOT, "overlay"));
      const collision = new Error("vanilla lifecycle operation can see the managed overlay");
      collision.code = "MANAGED_RUNTIME_COLLISION";
      throw collision;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const phaseRoot = path.dirname(PROJECT_ROOT);
    await fsp.mkdir(phaseRoot, { mode: 0o700 });
    await fsp.mkdir(PROJECT_ROOT, { mode: 0o700 });
    return;
  }
  await assertDirectory(PROJECT_ROOT);
  await assertDirectory(path.join(PROJECT_ROOT, "addons"));
  await assertDirectory(ADDON_ROOT);
  const overrideStat = await fsp.lstat(OVERRIDE_FILE);
  if (overrideStat.isSymbolicLink() || !overrideStat.isFile()) throw new Error("managed lifecycle override is not a regular file");
  const projectEntries = (await fsp.readdir(PROJECT_ROOT)).sort();
  const addonEntries = (await fsp.readdir(path.join(PROJECT_ROOT, "addons"))).sort();
  const expectedProjectEntries = PROJECT_ENVIRONMENT ? [".chronorift", "addons", "override.cfg"] : ["addons", "override.cfg"];
  if (JSON.stringify(projectEntries) !== JSON.stringify(expectedProjectEntries) ||
      JSON.stringify(addonEntries) !== JSON.stringify([ADDON_DIRECTORY])) {
    const collision = new Error("managed lifecycle project root contains an unexpected entry: root=" + JSON.stringify(projectEntries) + "; addons=" + JSON.stringify(addonEntries));
    collision.code = "MANAGED_RUNTIME_COLLISION";
    throw collision;
  }
};

const copyCandidate = async () => {
  await prepareProjectRoot();
  let fileCount = 0;
  let byteLength = 0;
  const selectedFiles = [];
  const visit = async (directory, target, prefix, atRoot, rootDevice) => {
    if (!contained(PROJECT_ROOT, target)) throw new Error("candidate target escaped the lifecycle project root");
    const directoryBefore = await pinnedStat(directory);
    if (!directoryBefore.isDirectory() || directoryBefore.dev !== rootDevice) throw new Error("candidate source crossed a filesystem boundary");
    const names = (await fsp.readdir(fdPath(directory))).sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    for (const name of names) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0") || name.normalize("NFC") !== name) {
        throw new Error("candidate source contains an invalid entry name");
      }
      if (atRoot && (name === ".git" || name === ".godot" || (PROJECT_ENVIRONMENT && name === ".chronorift"))) continue;
      const relativePath = prefix === "" ? name : prefix + "/" + name;
      const normalizedPath = relativePath.toLocaleLowerCase("en-US");
      const reservedProjectEnvironmentAddon = "addons/" + ADDON_DIRECTORY.toLocaleLowerCase("en-US");
      if ((!PROJECT_ENVIRONMENT && (normalizedPath === ".chronorift" || normalizedPath.startsWith(".chronorift/"))) ||
          (!PROJECT_ENVIRONMENT && (normalizedPath === "addons" || normalizedPath.startsWith("addons/"))) ||
          (PROJECT_ENVIRONMENT && (normalizedPath === reservedProjectEnvironmentAddon || normalizedPath.startsWith(reservedProjectEnvironmentAddon + "/"))) ||
          normalizedPath === "override.cfg") {
        const collision = new Error("candidate source collides with the managed lifecycle overlay");
        collision.code = "MANAGED_RUNTIME_COLLISION";
        throw collision;
      }
      if (UNSUPPORTED_SOURCE_SUFFIXES.some((suffix) => normalizedPath.endsWith(suffix))) {
        const unsupported = new Error("candidate source contains a native or non-GDScript path");
        unsupported.code = "UNSUPPORTED_SOURCE_FEATURE";
        throw unsupported;
      }
      const targetPath = path.join(target, name);
      const pinned = await openPinnedEntry(directory, name, relativePath);
      try {
        if (pinned.stat.dev !== rootDevice) throw new Error("candidate source crossed a filesystem boundary: " + relativePath);
        if (pinned.stat.isDirectory()) {
          if (!(PROJECT_ENVIRONMENT && OPERATION === "managed_lifecycle" && relativePath === "addons")) {
            await fsp.mkdir(targetPath, { mode: 0o700 });
          }
          await visit(pinned.handle, targetPath, relativePath, false, rootDevice);
        } else if (pinned.stat.isFile()) {
          fileCount += 1;
          byteLength += Number(pinned.stat.size);
          if (fileCount > MAX_SOURCE_FILES || byteLength > MAX_SOURCE_BYTES) throw new Error("candidate source exceeds its staging bound");
          const bytes = await pinned.handle.readFile();
          const after = await pinnedStat(pinned.handle);
          if (!sameSnapshotIdentity(pinned.stat, after) || bytes.byteLength !== Number(pinned.stat.size)) throw new Error("candidate source changed during snapshot: " + relativePath);
          const autoloadPattern = new RegExp("^\\\\s*" + RESERVED_AUTOLOAD + "\\\\s*=", "mu");
          if (relativePath === "project.godot" && autoloadPattern.test(bytes.toString("utf8"))) {
            const collision = new Error("candidate project defines the reserved managed autoload");
            collision.code = "MANAGED_RUNTIME_COLLISION";
            throw collision;
          }
          const selectedMode = (pinned.stat.mode & 0o111n) === 0n ? "100644" : "100755";
          const stagedMode = selectedMode === "100755" ? 0o700 : 0o600;
          await fsp.writeFile(targetPath, bytes, { flag: "wx", mode: stagedMode });
          await fsp.chmod(targetPath, stagedMode);
          selectedFiles.push({ relativePath, mode: selectedMode, bytes });
        } else {
          throw new Error("candidate source contains an unsupported file type: " + relativePath);
        }
      } finally { await pinned.handle.close(); }
    }
    if (!sameSnapshotIdentity(directoryBefore, await pinnedStat(directory))) throw new Error("candidate directory changed during snapshot");
  };
  const root = await openPinnedRoot(WORKSPACE_ROOT);
  try {
    await visit(root.handle, PROJECT_ROOT, "", true, root.stat.dev);
    const finalRoot = await fsp.lstat(WORKSPACE_ROOT, { bigint: true });
    if (finalRoot.isSymbolicLink() || !sameSnapshotIdentity(root.stat, finalRoot) || await fsp.realpath(fdPath(root.handle)) !== WORKSPACE_ROOT) {
      throw new Error("candidate workspace changed during snapshot");
    }
  } finally { await root.handle.close(); }
  selectedFiles.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath, "utf8"), Buffer.from(right.relativePath, "utf8")));
  const hash = crypto.createHash("sha256").update("chronorift-selected-tree-v1\0");
  for (const file of selectedFiles) {
    const pathBytes = Buffer.from(file.relativePath, "utf8");
    hash.update(String(pathBytes.byteLength) + ":"); hash.update(pathBytes);
    hash.update("\0" + file.mode + "\0" + String(file.bytes.byteLength) + ":"); hash.update(file.bytes); hash.update("\0");
  }
  stagedCandidateManifest = selectedFiles.map((file) => ({
    relativePath: file.relativePath,
    mode: file.mode,
    byteLength: file.bytes.byteLength,
    sha256: crypto.createHash("sha256").update(file.bytes).digest("hex"),
  }));
  return { candidateSourceHash: hash.digest("hex"), fileCount, byteLength };
};

const verifyStagedCandidate = async (expectedStage) => {
  const actual = [];
  const visit = async (directory, prefix, atRoot) => {
    const before = await fsp.lstat(directory, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error("staged candidate directory is no longer a regular directory");
    }
    const names = (await fsp.readdir(directory)).sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    for (const name of names) {
      if (atRoot && name === ".godot") {
        const cachePath = path.join(directory, name);
        const cache = await fsp.lstat(cachePath);
        if (cache.isSymbolicLink() || !cache.isDirectory()) {
          throw new Error("Godot import cache is not a regular directory");
        }
        continue;
      }
      if (OPERATION === "managed_lifecycle" && atRoot && (name === "override.cfg" || (!PROJECT_ENVIRONMENT && name === "addons") || (PROJECT_ENVIRONMENT && name === ".chronorift"))) continue;
      const relativePath = prefix === "" ? name : prefix + "/" + name;
      if (PROJECT_ENVIRONMENT && OPERATION === "managed_lifecycle" && prefix === "addons" && name === ADDON_DIRECTORY) continue;
      const target = path.join(directory, name);
      const inspected = await fsp.lstat(target, { bigint: true });
      if (inspected.isSymbolicLink()) throw new Error("staged candidate contains a symlink after execution: " + relativePath);
      if (inspected.isDirectory()) {
        await visit(target, relativePath, false);
        continue;
      }
      if (!inspected.isFile()) throw new Error("staged candidate contains an unsupported entry after execution: " + relativePath);
      const handle = await fsp.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const pinned = await pinnedStat(handle);
        if (!sameSnapshotIdentity(inspected, pinned)) throw new Error("staged candidate changed during verification: " + relativePath);
        const bytes = await handle.readFile();
        const after = await pinnedStat(handle);
        if (!sameSnapshotIdentity(pinned, after) || bytes.byteLength !== Number(pinned.size)) {
          throw new Error("staged candidate changed during verification: " + relativePath);
        }
        actual.push({
          relativePath,
          mode: (pinned.mode & 0o111n) === 0n ? "100644" : "100755",
          byteLength: bytes.byteLength,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
          bytes,
        });
      } finally { await handle.close(); }
    }
    const after = await fsp.lstat(directory, { bigint: true });
    if (!sameSnapshotIdentity(before, after)) throw new Error("staged candidate directory changed during verification");
  };
  await visit(PROJECT_ROOT, "", true);
  actual.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath, "utf8"), Buffer.from(right.relativePath, "utf8")));
  const actualManifest = actual.map(({ bytes, ...entry }) => entry);
  if (JSON.stringify(actualManifest) !== JSON.stringify(stagedCandidateManifest)) {
    const expectedByPath = new Map(stagedCandidateManifest.map((entry) => [entry.relativePath, entry]));
    const actualByPath = new Map(actualManifest.map((entry) => [entry.relativePath, entry]));
    const changedPaths = [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])]
      .filter((relativePath) => JSON.stringify(expectedByPath.get(relativePath)) !== JSON.stringify(actualByPath.get(relativePath)))
      .sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    const mismatch = new Error("Godot execution changed the staged candidate source tree: " + JSON.stringify(changedPaths.slice(0, 8)));
    mismatch.code = "BUILD_IDENTITY_MISMATCH";
    throw mismatch;
  }
  const hash = crypto.createHash("sha256").update("chronorift-selected-tree-v1\0");
  let byteLength = 0;
  for (const file of actual) {
    const pathBytes = Buffer.from(file.relativePath, "utf8");
    hash.update(String(pathBytes.byteLength) + ":"); hash.update(pathBytes);
    hash.update("\0" + file.mode + "\0" + String(file.bytes.byteLength) + ":"); hash.update(file.bytes); hash.update("\0");
    byteLength += file.bytes.byteLength;
  }
  if (hash.digest("hex") !== expectedStage.candidateSourceHash || actual.length !== expectedStage.fileCount || byteLength !== expectedStage.byteLength) {
    const mismatch = new Error("verified staged candidate identity no longer matches admission");
    mismatch.code = "BUILD_IDENTITY_MISMATCH";
    throw mismatch;
  }
};

const collectFiles = async (root) => {
  const files = [];
  const visit = async (directory) => {
    const entries = (await fsp.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const stat = await fsp.lstat(target);
      if (stat.isSymbolicLink()) throw new Error("managed lifecycle tree contains a symlink");
      if (stat.isDirectory()) await visit(target);
      else if (stat.isFile()) files.push(target);
      else throw new Error("managed lifecycle tree contains an unsupported entry");
    }
  };
  await visit(root);
  return files.sort((left, right) => path.relative(root, left).localeCompare(path.relative(root, right)));
};

const hashTree = async (root) => {
  const hash = crypto.createHash("sha256");
  for (const file of await collectFiles(root)) {
    hash.update(path.relative(root, file).split(path.sep).join("/")); hash.update("\0");
    hash.update(await fsp.readFile(file)); hash.update("\0");
  }
  return hash.digest("hex");
};

const configuredMainScene = async () => {
  const source = await fsp.readFile(path.join(PROJECT_ROOT, "project.godot"), "utf8");
  const match = /^run\/main_scene\s*=\s*"([^"\r\n]+)"\s*$/mu.exec(source);
  return match === null ? "" : match[1];
};

const createCapture = (phase, stream, launch) => {
  const hash = crypto.createHash("sha256");
  let totalBytes = 0;
  let retainedBytes = 0;
  let accepting = true;
  let pending = Buffer.alloc(0);
  const maxRaw = Math.max(1, Math.floor((launch.diagnosticFrameMaxBytes - 512) * 3 / 4));
  const flush = (includePartial) => {
    while (accepting && (pending.byteLength >= maxRaw || (includePartial && pending.byteLength > 0))) {
      const length = Math.min(maxRaw, pending.byteLength);
      const retained = pending.subarray(0, length);
      if (!diagnostic({ kind: "process_output", phase, stream, offset: retainedBytes, bytesBase64: retained.toString("base64") })) {
        accepting = false;
        pending = Buffer.alloc(0);
        return;
      }
      retainedBytes += retained.byteLength;
      pending = pending.subarray(length);
    }
  };
  return {
    push(chunk) {
      const bytes = Buffer.from(chunk);
      hash.update(bytes);
      totalBytes += bytes.byteLength;
      const remaining = launch.outputCaptureMaxBytes - retainedBytes - pending.byteLength;
      if (!accepting || remaining <= 0) return;
      const retained = bytes.subarray(0, Math.min(bytes.byteLength, remaining));
      pending = pending.byteLength === 0 ? Buffer.from(retained) : Buffer.concat([pending, retained]);
      flush(false);
    },
    receipt() {
      flush(true);
      return { totalBytes, sha256: hash.digest("hex"), retainedBytes, truncated: retainedBytes < totalBytes };
    }
  };
};

const processEnvironment = (processRoot, extra = {}) => ({
  HOME: path.join(processRoot, "home"),
  PATH: ${JSON.stringify(DEFAULT_LIFECYCLE_SIDECAR_TARGETS.godotPath)},
  LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
  FONTCONFIG_FILE: ${JSON.stringify(DEFAULT_LIFECYCLE_SIDECAR_TARGETS.fontconfigFile)},
  XDG_DATA_HOME: path.join(processRoot, "data"), XDG_CONFIG_HOME: path.join(processRoot, "config"), XDG_CACHE_HOME: path.join(processRoot, "cache"),
  DISPLAY: "", WAYLAND_DISPLAY: "", PULSE_SERVER: "", SDL_AUDIODRIVER: "dummy",
  ...extra
});

const processIdentities = async () => {
  if (os.hostname() !== "chronorift") return [];
  const identities = [];
  for (const name of await fsp.readdir("/proc")) {
    if (!/^[1-9][0-9]*$/u.test(name)) continue;
    try {
      const stat = await fsp.readFile(path.join("/proc", name, "stat"), "utf8");
      const close = stat.lastIndexOf(")");
      const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/u);
      if (fields.length > 19) identities.push(name + ":" + fields[19]);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error;
    }
  }
  return identities.sort();
};

const assertPhaseProcessQuiescence = async (baseline) => {
  if (baseline.length === 0) return;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const after = await processIdentities();
  const admitted = new Set(baseline);
  const unexpected = after.filter((identity) => !admitted.has(identity));
  if (unexpected.length > 0) {
    const residual = new Error("Godot phase left an unexpected process in the isolated PID namespace");
    residual.code = "PHASE_PROCESS_REMAINED";
    throw residual;
  }
};

const ensureProcessRoot = async (name) => {
  const root = path.join(RUNTIME_ROOT, "process-" + name);
  await fsp.mkdir(root, { mode: 0o700 });
  await Promise.all(["home", "data", "config", "cache"].map((entry) => fsp.mkdir(path.join(root, entry), { mode: 0o700 })));
  return root;
};

const runBoundedProcess = async (phase, launch, args, timeoutMs, stabilityWindowMs = undefined) => {
  const processRoot = await ensureProcessRoot(phase);
  const processBaseline = await processIdentities();
  const stdout = createCapture(phase, "stdout", launch);
  const stderr = createCapture(phase, "stderr", launch);
  const started = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let stable = stabilityWindowMs === undefined;
    let stopRequested = false;
    let killTimer;
    const spawned = childProcess.spawn(GODOT_EXECUTABLE, [...GODOT_ARGS_PREFIX, ...args], {
      cwd: PROJECT_ROOT, env: processEnvironment(processRoot), stdio: ["ignore", "pipe", "pipe"]
    });
    child = spawned;
    spawned.once("error", reject);
    spawned.stdout.on("data", (chunk) => stdout.push(chunk));
    spawned.stderr.on("data", (chunk) => stderr.push(chunk));
    diagnostic({ kind: "phase_started", phase, pid: spawned.pid });
    const timeout = setTimeout(() => {
      timedOut = true; stopRequested = true;
      try { spawned.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => { try { spawned.kill("SIGKILL"); } catch {} }, 500);
    }, timeoutMs);
    const stabilityTimer = stabilityWindowMs === undefined ? undefined : setTimeout(() => {
      stable = true; stopRequested = true;
      try { spawned.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => { try { spawned.kill("SIGKILL"); } catch {} }, 500);
    }, stabilityWindowMs);
    spawned.once("close", async (exitCode, signal) => {
      clearTimeout(timeout); clearTimeout(stabilityTimer); clearTimeout(killTimer);
      child = undefined;
      const durationMs = Number((process.hrtime.bigint() - started) / 1000000n);
      const receipt = { exitCode, signal, timedOut, durationMs, stdout: stdout.receipt(), stderr: stderr.receipt() };
      try {
        await assertPhaseProcessQuiescence(processBaseline);
        resolve({
          receipt,
          stable,
          stopRequested
        });
      } catch (error) {
        error.phase = phase; error.processReceipt = receipt;
        reject(error);
      }
    });
  });
};

const runVanillaSmoke = async (launch, stage, remainder) => {
  if (remainder.byteLength !== 0) throw new Error("vanilla smoke does not accept protocol bytes");
  diagnostic({ kind: "stage_ready", ...stage });
  let importRun;
  try {
    importRun = await runBoundedProcess("import", launch, ["--headless", "--path", PROJECT_ROOT, "--import"], launch.importTimeoutMs);
  } catch (error) {
    if (error?.processReceipt) {
      error.smokeStage = stage; error.importReceipt = error.processReceipt; error.vanillaReceipt = null;
    }
    throw error;
  }
  if (importRun.receipt.timedOut || importRun.receipt.signal !== null || importRun.receipt.exitCode !== 0) {
    const failure = new Error("Godot import did not exit successfully");
    failure.phase = "import"; failure.code = "GODOT_IMPORT_FAILED";
    failure.smokeStage = stage; failure.importReceipt = importRun.receipt; failure.vanillaReceipt = null;
    throw failure;
  }
  try {
    await verifyStagedCandidate(stage);
    diagnostic({ kind: "source_verified", phase: "import", candidateSourceHash: stage.candidateSourceHash, fileCount: stage.fileCount, byteLength: stage.byteLength }, true);
  } catch (error) {
    error.phase = "import"; error.smokeStage = stage; error.importReceipt = importRun.receipt; error.vanillaReceipt = null;
    throw error;
  }
  let vanillaRun;
  try {
    vanillaRun = await runBoundedProcess("vanilla", launch, ["--headless", "--path", PROJECT_ROOT, "--rendering-method", "gl_compatibility", "--audio-driver", "Dummy", ...(launch.launchScene === undefined ? [] : [launch.launchScene])], launch.vanillaTimeoutMs, launch.stabilityWindowMs);
  } catch (error) {
    if (error?.processReceipt) {
      error.smokeStage = stage; error.importReceipt = importRun.receipt; error.vanillaReceipt = error.processReceipt;
    }
    throw error;
  }
  if (!vanillaRun.stable || vanillaRun.receipt.timedOut) {
    const failure = new Error("vanilla main scene did not remain alive for the stability window");
    failure.phase = "vanilla"; failure.code = "VANILLA_EXITED_EARLY";
    failure.smokeStage = stage; failure.importReceipt = importRun.receipt; failure.vanillaReceipt = vanillaRun.receipt;
    throw failure;
  }
  try {
    await verifyStagedCandidate(stage);
    diagnostic({ kind: "source_verified", phase: "vanilla", candidateSourceHash: stage.candidateSourceHash, fileCount: stage.fileCount, byteLength: stage.byteLength }, true);
  } catch (error) {
    error.phase = "vanilla"; error.smokeStage = stage; error.importReceipt = importRun.receipt; error.vanillaReceipt = vanillaRun.receipt;
    throw error;
  }
  diagnostic({
    kind: "smoke_complete", ...stage, stabilityObservedMs: Math.max(launch.stabilityWindowMs, vanillaRun.receipt.durationMs),
    import: importRun.receipt, vanilla: vanillaRun.receipt
  }, true);
  process.exitCode = 0;
};

const listen = (socketServer) => new Promise((resolve, reject) => {
  socketServer.once("error", reject);
  socketServer.listen(0, "127.0.0.1", () => {
    socketServer.off("error", reject);
    const address = socketServer.address();
    if (address === null || typeof address === "string") reject(new Error("loopback server has no port"));
    else resolve(address.port);
  });
});

const startManagedRuntime = async (launch, stage, remainder) => {
  const addonHash = await hashTree(ADDON_ROOT);
  const overlayHash = crypto.createHash("sha256").update(await fsp.readFile(OVERRIDE_FILE)).digest("hex");
  if (addonHash !== launch.addonHash || overlayHash !== launch.overlayHash || await configuredMainScene() !== launch.expectedMainScene) {
    const mismatch = new Error("managed overlay, addon, or main-scene identity mismatch"); mismatch.code = "BUILD_IDENTITY_MISMATCH"; throw mismatch;
  }
  diagnostic({ kind: "stage_ready", ...stage, overlayHash, addonHash });
  let importRun;
  try {
    importRun = await runBoundedProcess(
      "managed_import",
      launch,
      ["--headless", "--path", PROJECT_ROOT, "--import"],
      launch.importTimeoutMs
    );
  } catch (error) {
    if (error?.processReceipt) {
      diagnostic({ kind: "managed_import_result", outcome: "failed", receipt: error.processReceipt }, true);
    }
    error.phase = "managed_import";
    throw error;
  }
  const importSucceeded = !importRun.receipt.timedOut && importRun.receipt.signal === null && importRun.receipt.exitCode === 0;
  diagnostic({
    kind: "managed_import_result",
    outcome: importSucceeded ? "succeeded" : "failed",
    receipt: importRun.receipt
  }, true);
  if (!importSucceeded) {
    const failure = new Error("managed Godot import did not exit successfully");
    failure.phase = "managed_import";
    failure.code = "GODOT_IMPORT_FAILED";
    failure.processReceipt = importRun.receipt;
    throw failure;
  }
  try {
    await verifyStagedCandidate(stage);
    diagnostic({
      kind: "source_verified",
      phase: "managed_import",
      candidateSourceHash: stage.candidateSourceHash,
      fileCount: stage.fileCount,
      byteLength: stage.byteLength
    }, true);
  } catch (error) {
    error.phase = "managed_import";
    throw error;
  }
  server = net.createServer();
  let connected = false;
  const connection = new Promise((resolve, reject) => {
    server.on("connection", (socket) => {
      if (connected) { socket.destroy(); return; }
      connected = true; resolve(socket);
    });
    server.once("error", reject);
  });
  const port = await listen(server);
  const processRoot = await ensureProcessRoot("managed");
  const processBaseline = await processIdentities();
  const stdout = createCapture("managed", "stdout", launch);
  const stderr = createCapture("managed", "stderr", launch);
  startupTimer = setTimeout(() => fail("protocol", "GODOT_CONNECTION_TIMEOUT", new Error("Godot did not connect before the startup deadline")), launch.startupTimeoutMs);
  executionTimer = setTimeout(() => {
    executionTimedOut = true;
    fail("managed", "EXECUTION_TIMEOUT", new Error("Godot exceeded the lifecycle execution deadline"));
  }, launch.executionTimeoutMs);
  child = childProcess.spawn(GODOT_EXECUTABLE, [
    ...GODOT_ARGS_PREFIX, "--headless", "--path", PROJECT_ROOT,
    "--rendering-method", "gl_compatibility", "--audio-driver", "Dummy",
    ...(launch.launchScene === undefined ? [] : [launch.launchScene])
  ], {
    cwd: PROJECT_ROOT,
    env: processEnvironment(processRoot, {
      CHRONORIFT_HOST: "127.0.0.1", CHRONORIFT_PORT: String(port), CHRONORIFT_TOKEN: launch.token,
      CHRONORIFT_TASK_ID: launch.taskId, CHRONORIFT_BUILD_ID: launch.buildId,
      CHRONORIFT_RUNTIME_ID: launch.runtimeId, CHRONORIFT_EXECUTION_ID: launch.executionId,
      CHRONORIFT_MANAGED_RUNTIME_ID: launch.managedRuntimeId,
      CHRONORIFT_CANDIDATE_SOURCE_HASH: launch.candidateSourceHash,
      CHRONORIFT_OVERLAY_HASH: launch.overlayHash, CHRONORIFT_ADDON_HASH: launch.addonHash,
      ...(PROJECT_ENVIRONMENT ? {
        CHRONORIFT_INSTRUMENTATION_MODE: launch.instrumentationMode,
        CHRONORIFT_EXPECTED_MAIN_SCENE: launch.expectedMainScene,
        CHRONORIFT_SOURCE_CLOSURE_ID: launch.sourceClosureId,
        CHRONORIFT_ENVIRONMENT_REVISION_ID: launch.environmentRevisionId,
        CHRONORIFT_ADAPTER_REVISION_ID: launch.adapterRevisionId,
        CHRONORIFT_ADAPTER_MANIFEST_HASH: launch.adapterManifestSha256,
        CHRONORIFT_SDK_HASH: launch.sdkSha256,
        CHRONORIFT_BRIDGE_HASH: launch.bridgeSha256,
        CHRONORIFT_TOOLCHAIN_HASH: launch.toolchainSha256,
      } : {}),
      ...(REQUIRES_ADAPTER_PROFILE_HASH ? { CHRONORIFT_ADAPTER_PROFILE_HASH: launch.adapterProfileSha256 } : {})
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.once("error", (error) => fail("managed", "GODOT_START_FAILED", error));
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  diagnostic({ kind: "godot_started", pid: child.pid });
  child.once("close", async (exitCode, signal) => {
    clearTimeout(startupTimer); clearTimeout(executionTimer);
    diagnostic({ kind: "stream_summary", stream: "stdout", receipt: stdout.receipt() }, true);
    diagnostic({ kind: "stream_summary", stream: "stderr", receipt: stderr.receipt() }, true);
    diagnostic({ kind: "godot_exit", exitCode, signal, timedOut: executionTimedOut }, true);
    try { peer?.destroy(); } catch {}
    try { server?.close(); } catch {}
    process.stdin.pause();
    if (!terminating) {
      try {
        await assertPhaseProcessQuiescence(processBaseline);
        await verifyStagedCandidate(stage);
        diagnostic({ kind: "source_verified", phase: "managed", candidateSourceHash: stage.candidateSourceHash, fileCount: stage.fileCount, byteLength: stage.byteLength }, true);
        process.exitCode = signal === null && exitCode === 0 ? 0 : 1;
      } catch (error) {
        fail("managed", error?.code ?? "BUILD_IDENTITY_MISMATCH", error);
      }
    }
  });
  peer = await connection;
  clearTimeout(startupTimer);
  server.close();
  if (remainder.byteLength > 0) peer.write(remainder);
  process.stdin.on("data", (chunk) => { if (!peer.write(chunk)) process.stdin.pause(); });
  peer.on("drain", () => process.stdin.resume());
  process.stdin.on("end", () => peer.end());
  process.stdin.on("error", (error) => fail("protocol", "GODOT_PROTOCOL_IO_FAILED", error));
  peer.on("data", (chunk) => { if (!process.stdout.write(chunk)) peer.pause(); });
  process.stdout.on("drain", () => peer.resume());
  peer.on("error", (error) => fail("protocol", "GODOT_PROTOCOL_IO_FAILED", error));
  peer.on("end", () => process.stdout.end());
  process.stdin.resume();
};

const shutdown = () => {
  if (terminating) return;
  terminating = true;
  clearTimeout(startupTimer); clearTimeout(executionTimer);
  try { peer?.end(); } catch {}
  try { server?.close(); } catch {}
  try { child?.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { child?.kill("SIGKILL"); } catch {} }, 500).unref();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

(async () => {
  try {
    const { launch, remainder } = await readPrelude();
    diagnosticFrameMaxBytes = launch.diagnosticFrameMaxBytes;
    diagnosticTotalMaxBytes = launch.diagnosticTotalMaxBytes;
    diagnosticMaxCount = launch.diagnosticMaxCount;
    const stage = await copyCandidate();
    if (stage.candidateSourceHash !== launch.candidateSourceHash) {
      const mismatch = new Error("staged candidate source identity mismatch"); mismatch.code = "BUILD_IDENTITY_MISMATCH"; throw mismatch;
    }
    if (OPERATION === "vanilla_smoke") await runVanillaSmoke(launch, stage, remainder);
    else await startManagedRuntime(launch, stage, remainder);
  } catch (error) {
    const code = ["MANAGED_RUNTIME_COLLISION", "UNSUPPORTED_SOURCE_FEATURE", "BUILD_IDENTITY_MISMATCH", "PHASE_PROCESS_REMAINED", "GODOT_IMPORT_FAILED", "VANILLA_EXITED_EARLY"].includes(error?.code) ? error.code : "INVALID_LAUNCH";
    const phase = typeof error?.phase === "string" ? error.phase : (code === "INVALID_LAUNCH" ? "launch" : "stage");
    if (error?.smokeStage && error?.importReceipt) {
      diagnostic({
        kind: "smoke_failed", ...error.smokeStage, failedPhase: phase,
        import: error.importReceipt, vanilla: error.vanillaReceipt ?? null
      }, true);
    }
    fail(phase, code, error);
  }
})();
`;
};

export const createLifecycleVanillaSmokeSidecarSource = (
  options: LifecycleSidecarSourceOptions,
): string => createLifecycleSidecarSource("vanilla_smoke", options);

export const createLifecycleRuntimeSidecarSource = (
  options: LifecycleSidecarSourceOptions,
): string => createLifecycleSidecarSource("managed_lifecycle", options);

export const createSemanticRuntimeSidecarSource = (
  options: Omit<LifecycleSidecarSourceOptions, "managedProfile">,
): string =>
  createLifecycleSidecarSource("managed_lifecycle", {
    ...options,
    managedProfile: {
      runtimeProfile: "chronorift-managed-godot-semantic-v1",
      protocolProfile: "chronorift-godot-semantic-v1",
      addonDirectory: "chronorift_semantic",
      reservedAutoload: "ChronoRiftSemantic",
      adapterProfileHash: true,
    },
  });

export const createSemanticVanillaSmokeSidecarSource = (
  options: Omit<LifecycleSidecarSourceOptions, "managedProfile">,
): string =>
  createLifecycleSidecarSource("vanilla_smoke", {
    ...options,
    managedProfile: {
      runtimeProfile: "chronorift-managed-godot-semantic-v1",
      protocolProfile: "chronorift-godot-semantic-v1",
      addonDirectory: "chronorift_semantic",
      reservedAutoload: "ChronoRiftSemantic",
      adapterProfileHash: true,
    },
  });

const PROJECT_ENVIRONMENT_MANAGED_PROFILE = Object.freeze({
  runtimeProfile: "chronorift-managed-godot-project-environment-v1" as const,
  protocolProfile: "chronorift-godot-project-environment-v1" as const,
  addonDirectory: "chronorift_project_environment" as const,
  reservedAutoload: "ChronoRiftProjectEnvironment" as const,
  adapterProfileHash: false as const,
  projectEnvironment: true as const,
});

export const createProjectEnvironmentRuntimeSidecarSource = (
  options: Omit<LifecycleSidecarSourceOptions, "managedProfile">,
): string =>
  createLifecycleSidecarSource("managed_lifecycle", {
    ...options,
    managedProfile: PROJECT_ENVIRONMENT_MANAGED_PROFILE,
  });

export const createProjectEnvironmentVanillaSmokeSidecarSource = (
  options: Omit<LifecycleSidecarSourceOptions, "managedProfile">,
): string =>
  createLifecycleSidecarSource("vanilla_smoke", {
    ...options,
    managedProfile: PROJECT_ENVIRONMENT_MANAGED_PROFILE,
  });

const PROJECT_ENVIRONMENT_MANAGED_PROFILE_V2 = Object.freeze({
  runtimeProfile: "chronorift-managed-godot-project-environment-v2" as const,
  protocolProfile: "chronorift-godot-project-environment-v2" as const,
  addonDirectory: "chronorift_project_environment" as const,
  reservedAutoload: "ChronoRiftProjectEnvironment" as const,
  adapterProfileHash: false as const,
  projectEnvironment: true as const,
  launchSchemaVersion: 2 as const,
});

export const createProjectEnvironmentRuntimeSidecarSourceV2 = (
  options: Omit<LifecycleSidecarSourceOptions, "managedProfile">,
): string =>
  createLifecycleSidecarSource("managed_lifecycle", {
    ...options,
    managedProfile: PROJECT_ENVIRONMENT_MANAGED_PROFILE_V2,
  });

export const createProjectEnvironmentVanillaSmokeSidecarSourceV2 = (
  options: Omit<LifecycleSidecarSourceOptions, "managedProfile">,
): string =>
  createLifecycleSidecarSource("vanilla_smoke", {
    ...options,
    managedProfile: PROJECT_ENVIRONMENT_MANAGED_PROFILE_V2,
  });
