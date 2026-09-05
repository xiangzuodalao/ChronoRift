import { isAbsolute, normalize } from "node:path";

export interface GodotInspectionSidecarOptions {
  readonly godotExecutable: string;
  readonly projectRoot: string;
  readonly executionId: string;
  readonly importTimeoutMs?: number;
  readonly executionTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  /** Host has already imported and admitted this immutable run snapshot. */
  readonly skipImport?: boolean;
}

/** The source runs inside the existing SRT boundary against a Host-owned stage. */
export const createGodotInspectionSidecarSource = (
  options: GodotInspectionSidecarOptions,
): string => {
  if (
    options.skipImport !== undefined &&
    typeof options.skipImport !== "boolean"
  )
    throw new TypeError("skipImport must be a boolean");
  for (const path of [options.godotExecutable, options.projectRoot]) {
    if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0"))
      throw new TypeError(
        "Inspection sidecar paths must be normalized and absolute",
      );
  }
  if (!/^[A-Za-z0-9._:-]{1,192}$/u.test(options.executionId))
    throw new TypeError("Invalid inspection executionId");
  const settings = {
    ...options,
    importTimeoutMs: options.importTimeoutMs ?? 120_000,
    executionTimeoutMs: options.executionTimeoutMs ?? 600_000,
    startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
  };
  for (const timeout of [
    settings.importTimeoutMs,
    settings.executionTimeoutMs,
    settings.startupTimeoutMs,
  ]) {
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600_000)
      throw new TypeError("Invalid inspection timeout");
  }
  return String.raw`"use strict";
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { randomBytes } = require("node:crypto");
const options = ${JSON.stringify(settings)};
const PROFILE = "chronorift-godot-inspection-v1";
const MAX_FRAME = 1024 * 1024;
// JSON control-character escaping is bounded to 6x: terminal output stays <1 MiB.
const MAX_LOG = 32 * 1024;
let outgoing = 0, incoming = 0, engineIncoming = 0, engineOutgoing = 0;
const watchReads = new Map();
let child, server, peer, phase, startupTimer, phaseTimer, killTimer, finishTimer;
let stopping = false, finished = false, authenticated = false;
let importResult = null, runResult = null;
const token = randomBytes(32).toString("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true });
function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length < 1 || body.length > MAX_FRAME) throw new Error("Inspection frame exceeded byte budget");
  const bytes = Buffer.allocUnsafe(body.length + 4);
  bytes.writeUInt32BE(body.length, 0);
  body.copy(bytes, 4);
  return bytes;
}
function emit(kind, payload, requestId) {
  const message = { schemaVersion: 1, profile: PROFILE, sequence: outgoing++, kind, payload };
  if (requestId !== undefined) message.requestId = requestId;
  if (!process.stdout.write(frame(message))) peer?.pause();
}
process.stdout.on("drain", () => peer?.resume());
process.stdout.on("error", () => stop());
function decoder(consume) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    if (finished) return;
    try {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 2 * MAX_FRAME + 8) throw new Error("Inspection input buffer exceeded byte budget");
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length < 1 || length > MAX_FRAME) throw new Error("Invalid inspection frame length");
        if (buffer.length < length + 4) break;
        const value = JSON.parse(utf8.decode(buffer.subarray(4, length + 4)));
        buffer = buffer.subarray(length + 4);
        consume(value);
      }
    } catch (error) { fail(error); }
  };
}
function fail(error) {
  if (finished || stopping) return;
  emit("error", { code: "INSPECTION_PROCESS_ERROR", message: String(error instanceof Error ? error.message : error).slice(0, 2048) });
  process.exitCode = 1;
  stop();
}
function finish(force = false) {
  if (finished) return;
  // Child exit can precede the final TCP data event. Drain the readable stream
  // before termination; a broken peer still has a bounded cleanup deadline.
  if (!force && phase === "run" && peer !== undefined && !peer.readableEnded && !peer.destroyed) {
    if (finishTimer === undefined) {
      finishTimer = setTimeout(() => finish(true), 200);
      peer.once("end", () => finish(true));
      peer.once("close", () => finish(true));
    }
    return;
  }
  finished = true;
  clearTimeout(startupTimer); clearTimeout(phaseTimer); clearTimeout(killTimer); clearTimeout(finishTimer);
  peer?.destroy(); server?.close();
  emit("terminated", { import: importResult, run: runResult });
  process.stdin.pause();
}
function stop(graceful = false) {
  if (finished || stopping) return;
  stopping = true;
  clearTimeout(startupTimer); clearTimeout(phaseTimer);
  if (child === undefined) { finish(); return; }
  if (graceful && phase === "run" && authenticated && peer?.writable) {
    // Let the observer exit its tree and flush the append-only watch cache.
    peer.write(frame({ schemaVersion: 1, profile: PROFILE, sequence: engineOutgoing++, kind: "stop", payload: {} }));
  } else child.kill("SIGTERM");
  killTimer = setTimeout(() => child?.kill("SIGKILL"), 1000);
}
function runProcess(name, args, timeout, done) {
  phase = name;
  const stdout = [], stderr = [];
  let stdoutBytes = 0, stderrBytes = 0, stdoutTruncated = false, stderrTruncated = false, timedOut = false;
  child = spawn(options.godotExecutable, args, {
    cwd: options.projectRoot,
    env: { ...process.env, CHRONORIFT_PORT: String(server?.address()?.port ?? 0), CHRONORIFT_TOKEN: token, CHRONORIFT_EXECUTION_ID: options.executionId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const launched = child;
  const collect = (chunks, stream, chunk) => {
    const bytes = stream === "stdout" ? stdoutBytes : stderrBytes;
    const retained = chunk.subarray(0, Math.max(0, MAX_LOG - bytes));
    if (retained.length > 0) chunks.push(retained);
    if (stream === "stdout") { stdoutBytes += retained.length; stdoutTruncated ||= retained.length !== chunk.length; }
    else { stderrBytes += retained.length; stderrTruncated ||= retained.length !== chunk.length; }
  };
  launched.stdout.on("data", (chunk) => collect(stdout, "stdout", chunk));
  launched.stderr.on("data", (chunk) => collect(stderr, "stderr", chunk));
  launched.on("error", (error) => fail(error));
  launched.on("close", (exitCode, signal) => {
    clearTimeout(phaseTimer); clearTimeout(killTimer);
    child = undefined;
    const result = { exitCode, signal, timedOut, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), stdoutTruncated, stderrTruncated };
    if (name === "import") importResult = result; else runResult = result;
    if (stopping || name === "run") { finish(); return; }
    done(result);
  });
  phaseTimer = setTimeout(() => { timedOut = true; fail(new Error(name + " timed out")); }, timeout);
}
function startGame() {
  if (stopping) { finish(); return; }
  server = createServer((socket) => {
    if (peer !== undefined) { socket.destroy(); return; }
    peer = socket;
    socket.setNoDelay(true);
    socket.on("error", (error) => fail(error));
    socket.on("close", () => {
      const timer = setTimeout(() => { if (!finished && !stopping) fail(new Error("Godot inspection connection closed")); }, 200);
      timer.unref();
    });
    socket.on("data", decoder((message) => {
      if (!authenticated) {
        if (!exactKeys(message, ["schemaVersion", "kind", "token"]) || message.schemaVersion !== 1 || message.kind !== "hello" || message.token !== token) throw new Error("Invalid inspection handshake");
        authenticated = true;
        return;
      }
      if (message?.schemaVersion !== 1 || message.profile !== PROFILE || message.sequence !== engineIncoming++ || !["ready", "query_result", "watch_result", "watch_final", "error"].includes(message.kind)) throw new Error("Invalid Godot inspection message");
      const keys = ["schemaVersion", "profile", "sequence", "kind", "payload"];
      if (["query_result", "watch_result"].includes(message.kind) || (message.kind === "error" && message.requestId !== undefined)) keys.push("requestId");
      if (!exactKeys(message, keys)) throw new Error("Unexpected Godot inspection envelope fields");
      if (message.kind === "ready") {
        if (message.payload?.executionId !== options.executionId) throw new Error("Inspection execution identity mismatch");
        clearTimeout(startupTimer);
      }
      if (message.kind === "watch_result") {
        if (message.payload?.executionId !== options.executionId || !["start", "read", "stop"].includes(message.payload.action)) throw new Error("Invalid watch response identity or action");
        const request = watchReads.get(message.requestId);
        if (message.payload.action === "read") {
          if (request === undefined || !Array.isArray(message.payload.records) || message.payload.records.length > 256) throw new Error("Unexpected watch page");
          // Account using the same compact JSON encoding the Host uses after parsing.
          const records = []; let bytesUsed = 0, requiredByteBudget = null;
          for (const record of message.payload.records) {
            const bytes = Buffer.byteLength(JSON.stringify(record));
            if (bytesUsed + bytes > request.byteBudget) { if (records.length === 0) requiredByteBudget = bytes; break; }
            records.push(record); bytesUsed += bytes;
          }
          message.payload = { ...message.payload, records, bytesUsed, nextSequence: records.at(-1)?.sequence ?? request.afterSequence, requiredByteBudget: requiredByteBudget ?? (records.length === 0 ? message.payload.requiredByteBudget : null) };
        }
      }
      if (message.kind === "watch_final") {
        if (!exactKeys(message.payload, ["state", "records", "deliveryComplete"]) || message.payload.state?.executionId !== options.executionId || message.payload.state?.status !== "stopped" || message.payload.deliveryComplete !== true || !Array.isArray(message.payload.records) || message.payload.records.length > 256) throw new Error("Invalid final watch delivery");
      }
      if (message.requestId !== undefined) watchReads.delete(message.requestId);
      emit(message.kind, message.payload, message.requestId);
    }));
  });
  server.on("error", (error) => fail(error));
  server.listen(0, "127.0.0.1", () => {
    if (stopping) { finish(); return; }
    startupTimer = setTimeout(() => fail(new Error("Godot inspection startup timed out")), options.startupTimeoutMs);
    runProcess("run", ["--headless", "--path", options.projectRoot], options.executionTimeoutMs, () => {});
  });
}
process.stdin.on("data", decoder((message) => {
  if (message?.schemaVersion !== 1 || message.profile !== PROFILE || message.sequence !== incoming++) throw new Error("Invalid Host inspection envelope");
  if (message.kind === "stop") {
    if (!exactKeys(message, ["schemaVersion", "profile", "sequence", "kind", "payload"]) || !exactKeys(message.payload, [])) throw new Error("Invalid inspection stop");
    stop(true); return;
  }
  if (!["query", "watch"].includes(message.kind) || typeof message.requestId !== "string" || message.payload?.executionId !== options.executionId) throw new Error("Invalid Host inspection command");
  if (!exactKeys(message, ["schemaVersion", "profile", "sequence", "kind", "payload", "requestId"])) throw new Error("Unexpected Host inspection envelope fields");
  if (!authenticated || phase !== "run" || stopping) {
    emit("error", { code: "NOT_RUNNING", message: "The inspection runtime is not ready" }, message.requestId);
    return;
  }
  if (message.kind === "watch" && message.payload.action === "read") {
    if (watchReads.size >= 256 || watchReads.has(message.requestId)) throw new Error("Watch request tracking budget exceeded");
    const afterSequence = message.payload.afterSequence ?? 0, byteBudget = message.payload.byteBudget ?? 65536;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(byteBudget) || byteBudget < 256 || byteBudget > 65536) throw new Error("Invalid watch read budget");
    watchReads.set(message.requestId, { afterSequence, byteBudget });
  }
  // Fetch a bounded engine page, then enforce the caller's budget after numeric
  // JSON normalization. This also makes requiredByteBudget exact for small reads.
  const payload = message.kind === "watch" && message.payload.action === "read" ? { ...message.payload, byteBudget: 65536 } : message.payload;
  if (!peer.write(frame({ ...message, payload, sequence: engineOutgoing++ }))) {
    process.stdin.pause();
    peer.once("drain", () => process.stdin.resume());
  }
}));
process.stdin.on("end", () => stop());
process.stdin.on("error", (error) => fail(error));
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());
if (options.skipImport === true) startGame();
else runProcess("import", ["--headless", "--path", options.projectRoot, "--editor", "--import"], options.importTimeoutMs, (result) => {
  if (result.exitCode !== 0 || result.signal !== null) { fail(new Error("Godot project import failed")); return; }
  startGame();
});
`;
};
