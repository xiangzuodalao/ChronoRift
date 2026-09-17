import { PassThrough } from "node:stream";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import {
  GodotMcpControlError,
  GodotMcpTransport,
  type GodotMcpDiagnostic,
} from "./godot-mcp-transport.js";
import type {
  SrtCommandResult,
  SrtDuplexHandle,
} from "./srt-sandbox-controller.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cr-pipe-"));
  const path = join(root, "mcp.sock");
  const transport = new GodotMcpTransport(path);
  await transport.listen();
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  stdin.on("data", (chunk: Buffer) =>
    frames.push(JSON.parse(chunk.toString()) as Record<string, unknown>),
  );
  let exit!: (result: SrtCommandResult) => void;
  const completion = new Promise<SrtCommandResult>((resolve) => {
    exit = resolve;
  });
  const result: SrtCommandResult = {
    status: "exited",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
  const stop = vi.fn(async () => {
    exit(result);
    return result;
  });
  const process: SrtDuplexHandle = {
    pid: undefined,
    stdin,
    stdout,
    stderr: new PassThrough(),
    wait: () => completion,
    stop,
  };
  const ready = transport.bind(process);
  const close = async () => {
    await stop();
    await transport.close();
    await rm(root, { recursive: true, force: true });
  };
  return { transport, path, stdout, frames, ready, stop, close };
}

it("relays exact MCP bytes across split pipe frames and closes pending controls on process exit", async () => {
  const f = await fixture();
  try {
    f.stdout.write('{"ready":');
    f.stdout.write("true}\n");
    await f.ready;
    const socket = createConnection(f.path);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const request = '{"jsonrpc":"2.0","method":"tools/list","id":1}\n';
    socket.write(request);
    await vi.waitFor(() =>
      expect(f.frames.some((frame) => frame.op === "data")).toBe(true),
    );
    expect(
      Buffer.from(
        f.frames.find((frame) => frame.op === "data")!.data as string,
        "base64",
      ).toString(),
    ).toBe(request);
    const response = Buffer.from(
      '{"content":[{"type":"image","data":"exact-bytes"}]}\n',
    );
    const received = new Promise<Buffer>((resolve) =>
      socket.once("data", resolve),
    );
    f.stdout.write(
      JSON.stringify({
        channel: f.frames[0]!.channel,
        data: response.toString("base64"),
      }) + "\n",
    );
    expect(await received).toEqual(response);
    const pending = f.transport.control({ op: "save" });
    const rejected = expect(pending).rejects.toThrow("disconnected");
    await f.stop();
    await rejected;
    socket.destroy();
  } finally {
    await f.close();
  }
});

it("fails closed on an oversized unterminated pipe frame", async () => {
  const f = await fixture();
  try {
    const rejected = expect(f.ready).rejects.toThrow("exceeds limit");
    f.stdout.write("x".repeat(2 * 1024 * 1024 + 1));
    await rejected;
    expect(f.stop).toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

const diagnostic: GodotMcpDiagnostic = {
  operation: "save",
  step: "closing MCP control client",
  elapsedMs: 32,
  timeoutMs: 45_000,
  leaves: [{ type: "ConnectionError", message: "attach disconnected" }],
  truncated: false,
  stderr: {
    log: "process-5.stderr.log",
    truncated: false,
    incomplete: false,
    tail: "connection closed",
  },
};

it.each([diagnostic, undefined])(
  "preserves optional validated control diagnostics: %j",
  async (value) => {
    const f = await fixture();
    try {
      f.stdout.write('{"ready":true}\n');
      await f.ready;
      const pending = f.transport.control({ op: "save" });
      const rejected = expect(pending).rejects.toMatchObject({
        name: "GodotMcpControlError",
        message: "save failed",
        diagnostic: value,
      });
      f.stdout.write(
        JSON.stringify({
          id: f.frames[0]!.id,
          ok: false,
          error: "save failed",
          ...(value === undefined ? {} : { diagnostic: value }),
        }) + "\n",
      );
      await rejected;
      expect(f.stop).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it.each([
  {
    ...diagnostic,
    leaves: Array.from({ length: 17 }, () => diagnostic.leaves[0]),
  },
  { ...diagnostic, leaves: [{ type: "Error", message: "x".repeat(513) }] },
  { ...diagnostic, stderr: { ...diagnostic.stderr, log: "../host-secret" } },
  { ...diagnostic, elapsedMs: -1 },
  { ...diagnostic, unknown: true },
  {
    ...diagnostic,
    leaves: Array.from({ length: 16 }, () => ({
      type: "Error",
      message: "界".repeat(512),
    })),
  },
])(
  "fails closed on invalid or oversized diagnostic metadata: %#",
  async (value) => {
    const f = await fixture();
    try {
      f.stdout.write('{"ready":true}\n');
      await f.ready;
      const pending = f.transport.control({ op: "save" });
      const rejected = expect(pending).rejects.toThrow(
        "Invalid MCP transport frame",
      );
      f.stdout.write(
        JSON.stringify({
          id: f.frames[0]!.id,
          ok: false,
          error: "save failed",
          diagnostic: value,
        }) + "\n",
      );
      await rejected;
      expect(f.stop).toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it("records the actual Host deadline when no supervisor response arrives", async () => {
  const f = await fixture();
  try {
    f.stdout.write('{"ready":true}\n');
    await f.ready;
    const error = await f.transport
      .control({ op: "save" }, 10)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GodotMcpControlError);
    expect(error).toMatchObject({
      diagnostic: {
        operation: "save",
        step: "waiting for supervisor response",
        timeoutMs: 10,
        leaves: [{ type: "TimeoutError" }],
      },
    });
  } finally {
    await f.close();
  }
});
