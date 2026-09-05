import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createGodotInspectionSidecarSource } from "./inspection-sidecar-source.js";
import { GodotInspectionWireClient } from "./inspection-wire-client.js";

it("rejects unbounded configuration and noncanonical Host-owned paths", () => {
  const defaults = {
    godotExecutable: "/usr/bin/godot",
    projectRoot: "/tmp/inspection-stage",
    executionId: "execution.test",
  };
  expect(() =>
    createGodotInspectionSidecarSource({
      ...defaults,
      projectRoot: "/tmp/../outside",
    }),
  ).toThrow("normalized");
  expect(() =>
    createGodotInspectionSidecarSource({
      ...defaults,
      importTimeoutMs: Infinity,
    }),
  ).toThrow("timeout");
  expect(() =>
    createGodotInspectionSidecarSource({
      ...defaults,
      executionId: "execution/other",
    }),
  ).toThrow("executionId");
});

it("returns actual import spawn failure and terminates without starting a game", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      createGodotInspectionSidecarSource({
        godotExecutable: "/chronorift-missing-inspection-godot/godot",
        projectRoot: process.cwd(),
        executionId: "execution.spawn-failure",
      }),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const client = new GodotInspectionWireClient({
    readable: child.stdout,
    write: (bytes) =>
      new Promise<void>((resolve, reject) =>
        child.stdin.write(bytes, (error) =>
          error ? reject(error) : resolve(),
        ),
      ),
    close: async () => {
      child.stdin.end();
    },
  });
  try {
    await expect(client.ready(5_000)).rejects.toThrow(/ENOENT|exited/u);
    const result = await client.termination;
    expect(result.run).toBeNull();
    expect(result.import?.exitCode).not.toBe(0);
    expect(result.import?.timedOut).toBe(false);
  } finally {
    child.kill("SIGKILL");
    await client.close();
  }
});

it("normalizes watch page budgets and drains final records before graceful termination", async () => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-watch-sidecar-"));
  const executionId = "execution.sidecar-watch";
  const target = {
    objectRef: `${executionId}.object.1`,
    className: "Node",
    path: ".",
  };
  const state = {
    schemaVersion: 1,
    executionId,
    watchId: `${executionId}.watch.1`,
    phase: "physics_frame_signal_before_node_physics_process",
    status: "stopped",
    stopReason: "sample_count",
    sampleCount: 2,
    recordedCount: 2,
    boundTargets: [{ target, names: ["value"] }],
  };
  const records = [1, 2].map((sequence) => ({
    sequence,
    sample: { processFrame: sequence, physicsTick: sequence },
    targets: [
      {
        target,
        values: [{ name: "value", status: "success", value: "x".repeat(180) }],
      },
    ],
  }));
  const recordBytes = Buffer.byteLength(JSON.stringify(records[0]));
  const executable = join(root, "engine.cjs");
  await writeFile(
    executable,
    `#!${process.execPath}
const { connect } = require("node:net");
const state = ${JSON.stringify(state)}, records = ${JSON.stringify(records)};
const PROFILE = "chronorift-godot-inspection-v1";
let outgoing = 0, incoming = 0, buffer = Buffer.alloc(0);
const socket = connect(Number(process.env.CHRONORIFT_PORT), "127.0.0.1");
function write(value) {
  const body = Buffer.from(JSON.stringify(value)), frame = Buffer.alloc(body.length + 4);
  frame.writeUInt32BE(body.length); body.copy(frame, 4); socket.write(frame);
}
function emit(kind, payload, requestId) {
  write({ schemaVersion: 1, profile: PROFILE, sequence: outgoing++, kind, payload, ...(requestId === undefined ? {} : { requestId }) });
}
socket.on("connect", () => {
  write({ schemaVersion: 1, kind: "hello", token: process.env.CHRONORIFT_TOKEN });
  emit("ready", { executionId: state.executionId, engineVersion: "fake", scene: "res://main.tscn", root: state.boundTargets[0].target });
});
socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
    const size = buffer.readUInt32BE(0), message = JSON.parse(buffer.subarray(4, size + 4));
    buffer = buffer.subarray(size + 4);
    if (message.sequence !== incoming++) process.exit(17);
    if (message.kind === "stop") {
      emit("watch_final", { state, records, deliveryComplete: true });
      socket.end(() => process.exit(0));
      return;
    }
    const input = message.payload;
    const result = { ...state, action: input.action };
    if (input.action === "start") Object.assign(result, { status: "sampling", stopReason: null, recordedCount: 0 });
    if (input.action === "read") Object.assign(result, { records: records.filter((record) => record.sequence > input.afterSequence), bytesUsed: 0, nextSequence: 2, requiredByteBudget: null, deliveryComplete: true });
    emit("watch_result", result, message.requestId);
  }
});
`,
    { mode: 0o700 },
  );
  const child = spawn(
    process.execPath,
    [
      "-e",
      createGodotInspectionSidecarSource({
        godotExecutable: executable,
        projectRoot: root,
        executionId,
        skipImport: true,
        executionTimeoutMs: 10_000,
        startupTimeoutMs: 5_000,
      }),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const client = new GodotInspectionWireClient({
    readable: child.stdout,
    write: (bytes) =>
      new Promise<void>((resolve, reject) =>
        child.stdin.write(bytes, (error) =>
          error ? reject(error) : resolve(),
        ),
      ),
    close: async () => {
      child.stdin.end();
    },
  });
  try {
    await client.ready(5_000);
    await client.watch({
      schemaVersion: 1,
      executionId,
      action: "start",
      clock: "physics_tick",
      sampleCount: 2,
      targets: [{ target: { path: "." }, names: ["value"] }],
    });
    const read = (afterSequence: number, byteBudget: number) =>
      client.watch({
        schemaVersion: 1,
        executionId,
        action: "read",
        watchId: state.watchId,
        afterSequence,
        byteBudget,
      });
    expect(await read(0, 256)).toMatchObject({
      records: [],
      bytesUsed: 0,
      nextSequence: 0,
      requiredByteBudget: recordBytes,
    });
    expect(await read(0, recordBytes)).toMatchObject({
      records: [records[0]],
      bytesUsed: recordBytes,
      nextSequence: 1,
      requiredByteBudget: null,
    });
    expect(await read(1, recordBytes)).toMatchObject({
      records: [records[1]],
      bytesUsed: recordBytes,
      nextSequence: 2,
      requiredByteBudget: null,
    });
    const terminated = await client.stop();
    expect(terminated.run).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    expect(client.capturedWatch).toMatchObject({
      state,
      records,
      deliveryComplete: true,
    });
  } finally {
    child.kill("SIGKILL");
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
