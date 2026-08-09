import { isAbsolute, posix } from "node:path";

export const DEFAULT_RUNTIME_SIDECAR_TARGETS = Object.freeze({
  nodeExecutable: "/opt/chronorift/bin/node",
  godotExecutable: "/opt/chronorift/bin/godot",
  fontconfigProbeExecutable: "/opt/chronorift/bin/fc-match",
  shellExecutable: "/bin/sh",
  xdgUserDirExecutable: "/usr/bin/xdg-user-dir",
  fontconfigFile: "/opt/chronorift/etc/fontconfig/fonts.conf",
  godotPath: "/usr/bin:/bin",
  workspaceRoot: "/workspace",
  runtimeRoot: "/run/chronorift",
  managedAddonParent: "/run/chronorift/project/addons",
  managedAddonRoot: "/run/chronorift/project/addons/chronorift",
} as const);

export const MANAGED_FONTCONFIG_SOURCE =
  '<fontconfig><cachedir prefix="xdg">fontconfig</cachedir></fontconfig>\n';

export interface RuntimeSidecarSourceOptions {
  readonly godotExecutable: string;
  readonly workspaceRoot: string;
  readonly runtimeRoot: string;
  readonly godotArgsPrefix?: readonly string[] | undefined;
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

/**
 * Returns a dependency-free CommonJS sidecar program. The launch token and
 * candidate data are deliberately absent: they arrive in the first framed
 * stdin message after the sandbox has been authorized.
 */
export const createRuntimeSidecarSource = (
  options: RuntimeSidecarSourceOptions,
): string => {
  assertAbsoluteNormalized("godotExecutable", options.godotExecutable);
  assertAbsoluteNormalized("workspaceRoot", options.workspaceRoot);
  assertAbsoluteNormalized("runtimeRoot", options.runtimeRoot);
  const argsPrefix = [...(options.godotArgsPrefix ?? [])];
  if (
    argsPrefix.length > 16 ||
    argsPrefix.some(
      (argument) =>
        argument.includes("\0") || Buffer.byteLength(argument, "utf8") > 4096,
    )
  ) {
    throw new TypeError("godotArgsPrefix exceeds its trusted Host bound");
  }

  return String.raw`"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const childProcess = require("node:child_process");

const GODOT_EXECUTABLE = ${JSON.stringify(options.godotExecutable)};
const GODOT_ARGS_PREFIX = Object.freeze(${JSON.stringify(argsPrefix)});
const WORKSPACE_ROOT = ${JSON.stringify(options.workspaceRoot)};
const RUNTIME_ROOT = ${JSON.stringify(options.runtimeRoot)};
const PROJECT_ROOT = path.join(RUNTIME_ROOT, "project");
const ADDON_ROOT = path.join(PROJECT_ROOT, "addons", "chronorift");
const PROC_SELF_FD = "/proc/self/fd";
const MAX_LAUNCH_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_FILES = 4096;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const DEFAULT_DIAGNOSTIC_FRAME_MAX_BYTES = 64 * 1024;
const DEFAULT_DIAGNOSTIC_TOTAL_MAX_BYTES = 1024 * 1024;
const DEFAULT_DIAGNOSTIC_MAX_COUNT = 128;
const TERMINAL_DIAGNOSTIC_RESERVE_BYTES = 512;
const HASH = /^[a-f0-9]{64}$/u;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
let child;
let server;
let peer;
let executionTimer;
let startupTimer;
let terminating = false;
let diagnosticFrameMaxBytes = DEFAULT_DIAGNOSTIC_FRAME_MAX_BYTES;
let diagnosticTotalMaxBytes = DEFAULT_DIAGNOSTIC_TOTAL_MAX_BYTES;
let diagnosticMaxCount = DEFAULT_DIAGNOSTIC_MAX_COUNT;
let diagnosticEncodedBytes = 0;
let diagnosticCount = 0;

const failMessage = (error) => {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\r\n\0]/gu, " ").slice(0, 256) || "sidecar failure";
};

const diagnostic = (record, terminal = false) => {
  try {
    const body = Buffer.from(JSON.stringify({ schemaVersion: 1, ...record }), "utf8");
    const encodedBytes = body.byteLength + 4;
    if (body.byteLength < 1 || body.byteLength > diagnosticFrameMaxBytes ||
        diagnosticCount + 1 + (terminal ? 0 : 1) > diagnosticMaxCount ||
        diagnosticEncodedBytes + encodedBytes + (terminal ? 0 : TERMINAL_DIAGNOSTIC_RESERVE_BYTES) > diagnosticTotalMaxBytes) return false;
    const frame = Buffer.allocUnsafe(encodedBytes);
    frame.writeUInt32BE(body.byteLength, 0);
    body.copy(frame, 4);
    diagnosticCount += 1;
    diagnosticEncodedBytes += encodedBytes;
    process.stderr.write(frame);
    return true;
  } catch {
    // Diagnostics never replace mandatory process cleanup.
    return false;
  }
};

const fail = async (code, error, skipDiagnostic = false) => {
  if (terminating) return;
  terminating = true;
  if (!skipDiagnostic) diagnostic({ kind: "sidecar_error", code, message: failMessage(error) }, true);
  clearTimeout(startupTimer);
  clearTimeout(executionTimer);
  try { peer?.destroy(); } catch {}
  try { server?.close(); } catch {}
  try { child?.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { child?.kill("SIGKILL"); } catch {} }, 500).unref();
  process.exitCode = 1;
};

const emitDiagnostic = (record) => {
  if (diagnostic(record)) return true;
  void fail(
    "DIAGNOSTIC_LIMIT_EXCEEDED",
    new Error("runtime sidecar exceeded its diagnostic frame, count, or byte bound"),
    false,
  );
  return false;
};

const exactKeys = (value, keys) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const parseLaunch = (json) => {
  let value;
  try { value = JSON.parse(json); } catch { throw new Error("launch prelude is not JSON"); }
  const keys = [
    "schemaVersion", "taskId", "buildId", "runtimeId", "executionId",
    "candidateSourceHash", "fixtureHash", "projectHash", "addonHash",
    "protocolVersion", "token", "fixedFps", "physicsTicksPerSecond",
    "fixtureControls", "startupTimeoutMs", "executionTimeoutMs",
    "diagnosticFrameMaxBytes", "diagnosticTotalMaxBytes", "diagnosticMaxCount"
  ];
  if (!exactKeys(value, keys) || value.schemaVersion !== 1 || value.protocolVersion !== 2) {
    throw new Error("launch prelude has an unsupported shape or version");
  }
  for (const key of ["taskId", "buildId", "runtimeId", "executionId"]) {
    if (typeof value[key] !== "string" || !RESOURCE_ID.test(value[key]) || value[key].includes("..")) throw new Error("launch resource identity is invalid");
  }
  for (const key of ["candidateSourceHash", "fixtureHash", "projectHash", "addonHash"]) {
    if (typeof value[key] !== "string" || !HASH.test(value[key])) throw new Error("launch content identity is invalid");
  }
  if (typeof value.token !== "string" || !HASH.test(value.token)) throw new Error("launch token is invalid");
  if (![60, 120].includes(value.fixedFps) || ![60, 120].includes(value.physicsTicksPerSecond)) throw new Error("launch controls are unsupported");
  if (value.fixtureControls === null || typeof value.fixtureControls !== "object" || Array.isArray(value.fixtureControls)) throw new Error("fixture controls are invalid");
  if (Buffer.byteLength(JSON.stringify(value.fixtureControls), "utf8") > 64 * 1024) throw new Error("fixture controls exceed their bound");
  for (const [key, primitive] of Object.entries(value.fixtureControls)) {
    if (!key || key.length > 128 || (primitive !== null && !["string", "number", "boolean"].includes(typeof primitive)) || (typeof primitive === "number" && !Number.isFinite(primitive))) throw new Error("fixture control is not a JSON primitive");
  }
  if (!Number.isInteger(value.startupTimeoutMs) || value.startupTimeoutMs < 1000 || value.startupTimeoutMs > 60000 ||
      !Number.isInteger(value.executionTimeoutMs) || value.executionTimeoutMs < 1000 || value.executionTimeoutMs > 600000 ||
      !Number.isInteger(value.diagnosticFrameMaxBytes) || value.diagnosticFrameMaxBytes < 1024 || value.diagnosticFrameMaxBytes > 1024 * 1024 ||
      !Number.isInteger(value.diagnosticTotalMaxBytes) || value.diagnosticTotalMaxBytes < 4096 || value.diagnosticTotalMaxBytes > 16 * 1024 * 1024 ||
      value.diagnosticTotalMaxBytes < value.diagnosticFrameMaxBytes + 4 ||
      !Number.isInteger(value.diagnosticMaxCount) || value.diagnosticMaxCount < 1 || value.diagnosticMaxCount > 4096) throw new Error("sidecar time or diagnostic bounds are invalid");
  return value;
};

const readPrelude = () => new Promise((resolve, reject) => {
  let buffered = Buffer.alloc(0);
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
  const cleanup = () => {
    process.stdin.off("data", onData);
    process.stdin.off("error", onError);
    process.stdin.off("end", onEnd);
  };
  process.stdin.on("data", onData);
  process.stdin.on("error", onError);
  process.stdin.on("end", onEnd);
  process.stdin.resume();
});

const contained = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
};

const assertDirectory = async (target) => {
  const stat = await fsp.lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("source root is not a real directory");
  const real = await fsp.realpath(target);
  if (real !== target) throw new Error("source root is not canonical");
};

const fdPath = (handle, name) => name === undefined ? PROC_SELF_FD + "/" + handle.fd : PROC_SELF_FD + "/" + handle.fd + "/" + name;

const sameSnapshotIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino &&
  left.mode === right.mode && left.nlink === right.nlink &&
  left.size === right.size && left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const pinnedStat = (handle) => handle.stat({ bigint: true });

const openPinnedRoot = async (target) => {
  const inspected = await fsp.lstat(target, { bigint: true });
  if (inspected.isSymbolicLink() || !inspected.isDirectory()) throw new Error("candidate workspace is not a real directory");
  let handle;
  try {
    handle = await fsp.open(
      target,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    throw new Error("candidate workspace changed before snapshot", { cause: error });
  }
  try {
    const stat = await pinnedStat(handle);
    if (!stat.isDirectory() || !sameSnapshotIdentity(inspected, stat) ||
        await fsp.realpath(target) !== target ||
        await fsp.realpath(fdPath(handle)) !== target) {
      throw new Error("candidate workspace changed before snapshot");
    }
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const openPinnedEntry = async (parent, name, relativePath) => {
  const source = fdPath(parent, name);
  const inspected = await fsp.lstat(source, { bigint: true });
  if (inspected.isSymbolicLink()) throw new Error("candidate source contains a symlink: " + relativePath);
  let handle;
  try {
    handle = await fsp.open(
      source,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    throw new Error("candidate source changed or contains a symlink: " + relativePath, { cause: error });
  }
  try {
    const stat = await pinnedStat(handle);
    if (!sameSnapshotIdentity(inspected, stat)) throw new Error("candidate source changed during snapshot: " + relativePath);
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const copyCandidate = async () => {
  await assertDirectory(RUNTIME_ROOT);
  await assertDirectory(PROJECT_ROOT);
  await assertDirectory(path.join(PROJECT_ROOT, "addons"));
  await assertDirectory(ADDON_ROOT);
  const projectEntries = (await fsp.readdir(PROJECT_ROOT)).sort();
  const addonParentEntries = (await fsp.readdir(path.join(PROJECT_ROOT, "addons"))).sort();
  if (!exactKeys(Object.fromEntries(projectEntries.map((entry) => [entry, true])), ["addons"]) ||
      !exactKeys(Object.fromEntries(addonParentEntries.map((entry) => [entry, true])), ["chronorift"])) {
    throw new Error("runtime project root was not initialized with only the managed addon mount");
  }
  let fileCount = 0;
  let byteCount = 0;
  const selectedFiles = [];
  const visit = async (directory, target, prefix, atRoot, rootDevice) => {
    if (!contained(PROJECT_ROOT, target)) throw new Error("candidate target path escaped its root");
    const directoryBefore = await pinnedStat(directory);
    if (!directoryBefore.isDirectory() || directoryBefore.dev !== rootDevice) throw new Error("candidate source crossed a filesystem boundary");
    const names = (await fsp.readdir(fdPath(directory))).sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
    for (const name of names) {
      if (atRoot && (name === ".git" || name === ".godot")) continue;
      const relativePath = prefix === "" ? name : prefix + "/" + name;
      if (relativePath === "addons" || relativePath.startsWith("addons/")) {
        const collision = new Error("candidate already contains the managed read-only addons mount");
        collision.code = "MANAGED_RUNTIME_COLLISION";
        throw collision;
      }
      const targetPath = path.join(target, name);
      const pinned = await openPinnedEntry(directory, name, relativePath);
      try {
        if (pinned.stat.dev !== rootDevice) throw new Error("candidate source crossed a filesystem boundary: " + relativePath);
        if (pinned.stat.isDirectory()) {
          await fsp.mkdir(targetPath, { mode: 0o700 });
          await visit(pinned.handle, targetPath, relativePath, false, rootDevice);
        } else if (pinned.stat.isFile()) {
          fileCount += 1;
          byteCount += Number(pinned.stat.size);
          if (fileCount > MAX_SOURCE_FILES || byteCount > MAX_SOURCE_BYTES) throw new Error("candidate source exceeds its staging bound");
          const bytes = await pinned.handle.readFile();
          const after = await pinnedStat(pinned.handle);
          if (!sameSnapshotIdentity(pinned.stat, after) || bytes.byteLength !== Number(pinned.stat.size)) throw new Error("candidate source changed during snapshot: " + relativePath);
          await fsp.writeFile(targetPath, bytes, { flag: "wx", mode: 0o600 });
          await fsp.chmod(targetPath, 0o600);
          selectedFiles.push({
            relativePath,
            mode: (pinned.stat.mode & 0o111n) === 0n ? "100644" : "100755",
            bytes
          });
        } else {
          throw new Error("candidate source contains an unsupported file type: " + relativePath);
        }
      } finally {
        await pinned.handle.close();
      }
    }
    const directoryAfter = await pinnedStat(directory);
    if (!sameSnapshotIdentity(directoryBefore, directoryAfter)) throw new Error("candidate directory changed during snapshot");
  };
  const root = await openPinnedRoot(WORKSPACE_ROOT);
  try {
    await visit(root.handle, PROJECT_ROOT, "", true, root.stat.dev);
    const finalRoot = await fsp.lstat(WORKSPACE_ROOT, { bigint: true });
    if (finalRoot.isSymbolicLink() || !sameSnapshotIdentity(root.stat, finalRoot) ||
        await fsp.realpath(fdPath(root.handle)) !== WORKSPACE_ROOT) {
      throw new Error("candidate workspace changed during snapshot");
    }
  } finally {
    await root.handle.close();
  }
  selectedFiles.sort((a, b) => Buffer.compare(Buffer.from(a.relativePath, "utf8"), Buffer.from(b.relativePath, "utf8")));
  const hash = crypto.createHash("sha256").update("chronorift-selected-tree-v1\0");
  for (const file of selectedFiles) {
    const pathBytes = Buffer.from(file.relativePath, "utf8");
    hash.update(String(pathBytes.byteLength) + ":");
    hash.update(pathBytes);
    hash.update("\0" + file.mode + "\0" + String(file.bytes.byteLength) + ":");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
};

const collectFiles = async (root, skip) => {
  const files = [];
  const visit = async (directory) => {
    const entries = (await fsp.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target).split(path.sep).join("/");
      if (skip(relative, entry)) continue;
      const stat = await fsp.lstat(target);
      if (stat.isSymbolicLink()) throw new Error("staged tree contains a symlink");
      if (stat.isDirectory()) await visit(target);
      else if (stat.isFile()) files.push(target);
      else throw new Error("staged tree contains an unsupported file type");
    }
  };
  await visit(root);
  return files.sort();
};

const hashFiles = async (root, files) => {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(await fsp.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const verifyBuild = async (launch) => {
  const projectFiles = await collectFiles(PROJECT_ROOT, (relative) => relative === ".godot" || relative.startsWith(".godot/") || relative === "addons/chronorift" || relative.startsWith("addons/chronorift/"));
  const addonFiles = await collectFiles(ADDON_ROOT, () => false);
  const fixtureHash = await hashFiles(PROJECT_ROOT, projectFiles);
  const addonHash = await hashFiles(ADDON_ROOT, addonFiles);
  const projectHash = crypto.createHash("sha256").update(fixtureHash + "\0" + addonHash).digest("hex");
  if (fixtureHash !== launch.fixtureHash || addonHash !== launch.addonHash || projectHash !== launch.projectHash) {
    const mismatch = new Error("staged candidate or managed addon identity mismatch");
    mismatch.code = "BUILD_IDENTITY_MISMATCH";
    throw mismatch;
  }
  if (!emitDiagnostic({ kind: "stage_ready", fixtureHash, projectHash, addonHash })) {
    throw new Error("runtime sidecar diagnostic bound was exhausted during staging");
  }
};

const emitChildOutput = (kind, launch, chunk) => {
  const maxRawBytes = Math.max(1, Math.floor((launch.diagnosticFrameMaxBytes - 256) * 3 / 4));
  const bounded = chunk.byteLength > maxRawBytes ? chunk.subarray(0, maxRawBytes) : chunk;
  emitDiagnostic({ kind, bytesBase64: bounded.toString("base64"), truncated: bounded.byteLength !== chunk.byteLength });
};

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    const address = server.address();
    if (address === null || typeof address === "string") reject(new Error("loopback server has no port"));
    else resolve(address.port);
  });
});

const startRuntime = async (launch, remainder) => {
  server = net.createServer();
  let connected = false;
  const connection = new Promise((resolve, reject) => {
    server.on("connection", (socket) => {
      if (connected) { socket.destroy(); return; }
      connected = true;
      resolve(socket);
    });
    server.once("error", reject);
  });
  const port = await listen(server);
  startupTimer = setTimeout(() => void fail("GODOT_CONNECTION_TIMEOUT", new Error("Godot did not connect before the startup deadline")), launch.startupTimeoutMs);
  executionTimer = setTimeout(() => void fail("GODOT_PROTOCOL_IO_FAILED", new Error("Godot runtime exceeded the execution deadline")), launch.executionTimeoutMs);
  const processRoot = path.join(RUNTIME_ROOT, "process");
  await fsp.mkdir(processRoot, { mode: 0o700 });
  child = childProcess.spawn(GODOT_EXECUTABLE, [
    ...GODOT_ARGS_PREFIX,
    "--headless", "--path", PROJECT_ROOT, "--fixed-fps", String(launch.fixedFps),
    "--rendering-method", "gl_compatibility", "--audio-driver", "Dummy"
  ], {
    cwd: PROJECT_ROOT,
    env: {
      HOME: path.join(processRoot, "home"), PATH: ${JSON.stringify(DEFAULT_RUNTIME_SIDECAR_TARGETS.godotPath)}, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", FONTCONFIG_FILE: ${JSON.stringify(DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigFile)},
      XDG_DATA_HOME: path.join(processRoot, "data"), XDG_CONFIG_HOME: path.join(processRoot, "config"), XDG_CACHE_HOME: path.join(processRoot, "cache"),
      CHRONORIFT_HOST: "127.0.0.1", CHRONORIFT_PORT: String(port), CHRONORIFT_TOKEN: launch.token,
      CHRONORIFT_FIXED_FPS: String(launch.fixedFps), CHRONORIFT_PHYSICS_TPS: String(launch.physicsTicksPerSecond),
      CHRONORIFT_PROTOCOL_VERSION: "2", CHRONORIFT_ADAPTER_VERSION: "0.4.0",
      CHRONORIFT_FIXTURE_CONTROLS: JSON.stringify(launch.fixtureControls), CHRONORIFT_PROJECT_HASH: launch.projectHash, CHRONORIFT_ADDON_HASH: launch.addonHash
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.once("error", (error) => void fail("GODOT_START_FAILED", error));
  child.stdout.on("data", (chunk) => emitChildOutput("godot_stdout", launch, chunk));
  child.stderr.on("data", (chunk) => emitChildOutput("godot_stderr", launch, chunk));
  emitDiagnostic({ kind: "godot_started", pid: child.pid });
  child.once("exit", (exitCode, signal) => {
    clearTimeout(startupTimer); clearTimeout(executionTimer);
    if (!terminating && signal === null && exitCode !== null && exitCode !== 0) {
      emitDiagnostic({
        kind: "candidate_process_failure",
        candidateSourceHash: launch.candidateSourceHash,
        phase: connected ? "runtime_connected" : "before_runtime_connection",
        reason: "nonzero_exit",
        exitCode
      });
    }
    emitDiagnostic({ kind: "godot_exit", exitCode, signal });
    try { peer?.destroy(); } catch {}
    try { server?.close(); } catch {}
    if (!terminating) process.exitCode = exitCode === 0 ? 0 : 1;
  });
  peer = await connection;
  clearTimeout(startupTimer);
  server.close();
  if (remainder.byteLength > 0) peer.write(remainder);
  process.stdin.on("data", (chunk) => {
    if (!peer.write(chunk)) process.stdin.pause();
  });
  peer.on("drain", () => process.stdin.resume());
  process.stdin.on("end", () => peer.end());
  process.stdin.on("error", (error) => void fail("GODOT_PROTOCOL_IO_FAILED", error));
  peer.on("data", (chunk) => {
    if (!process.stdout.write(chunk)) peer.pause();
  });
  process.stdout.on("drain", () => peer.resume());
  peer.on("error", (error) => void fail("GODOT_PROTOCOL_IO_FAILED", error));
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
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

(async () => {
  try {
    const { launch, remainder } = await readPrelude();
    diagnosticFrameMaxBytes = launch.diagnosticFrameMaxBytes;
    diagnosticTotalMaxBytes = launch.diagnosticTotalMaxBytes;
    diagnosticMaxCount = launch.diagnosticMaxCount;
    const candidateSourceHash = await copyCandidate();
    if (candidateSourceHash !== launch.candidateSourceHash) {
      const mismatch = new Error("staged candidate source identity mismatch");
      mismatch.code = "BUILD_IDENTITY_MISMATCH";
      throw mismatch;
    }
    await verifyBuild(launch);
    await startRuntime(launch, remainder);
  } catch (error) {
    const code = ["MANAGED_RUNTIME_COLLISION", "BUILD_IDENTITY_MISMATCH"].includes(error?.code) ? error.code : "INVALID_LAUNCH";
    await fail(code, error);
  }
})();
`;
};
