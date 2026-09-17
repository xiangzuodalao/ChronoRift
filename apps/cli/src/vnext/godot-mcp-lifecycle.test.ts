import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { GodotMcpEnvironment } from "./godot-mcp-environment.js";
import {
  GodotMcpControlError,
  GodotMcpTransport,
  type GodotMcpDiagnostic,
} from "./godot-mcp-transport.js";
import {
  SrtSandboxController,
  type SrtCommandResult,
  type SrtDuplexHandle,
} from "./srt-sandbox-controller.js";

vi.mock("./godot-mcp-installation.js", () => ({
  resolveGodotMcpInstallation: async () => ({
    directory: "/test/mcp",
    python: "/test/python",
    xvfb: "/test/bin/Xvfb",
    files: {},
  }),
}));

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cr-lifecycle-"));
  const workspace = join(root, "project");
  await mkdir(workspace);
  await writeFile(join(workspace, "project.godot"), "config_version=5\n");
  const controller = new SrtSandboxController();
  const stops = vi.fn();
  const open = vi
    .spyOn(controller, "openEditor")
    .mockImplementation(async () => {
      let finish!: (result: SrtCommandResult) => void;
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
      const done = new Promise<SrtCommandResult>((resolve) => {
        finish = resolve;
      });
      return {
        pid: 1,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        wait: () => done,
        stop: async () => {
          stops();
          finish(result);
          return result;
        },
      };
    });
  vi.spyOn(GodotMcpTransport.prototype, "bind").mockResolvedValue();
  const control = vi
    .spyOn(GodotMcpTransport.prototype, "control")
    .mockResolvedValue({});
  const admit = vi.fn();
  const environment = await GodotMcpEnvironment.create({
    controller,
    workspace,
    godot: "/test/godot",
    recordsDirectory: join(root, "records"),
    isolationReadRoots: [root],
    admit,
  });
  await environment.prepare();
  return {
    environment,
    open,
    stops,
    control,
    admit,
    async close() {
      await environment.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("does not launch an editor for a validated cold stop or wait; cancellation preserves the environment", async () => {
  const f = await fixture();
  try {
    const operation = vi.fn();
    const receipt = {
      content: [{ type: "text", text: "Host: already stopped" }],
    };
    expect(
      await f.environment.runTool(
        "project_manage",
        "stop",
        operation,
        undefined,
        true,
        {
          tool: "project_manage",
          operation: "stop",
          whenEditorStopped: () => receipt,
        },
      ),
    ).toBe(receipt);
    expect(operation).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
    const state = await f.environment.wait("state", 0);
    expect(state).toMatchObject({
      editorState: "stopped",
      editorGeneration: 0,
    });
    await f.environment.runTool("editor_state", "start", async () => "ready");
    const abort = new AbortController();
    const waiting = f.environment.wait("cancel", 10_000, abort.signal);
    const timer = setTimeout(() => abort.abort(), 10);
    await expect(waiting).rejects.toThrow();
    clearTimeout(timer);
    expect(f.stops).not.toHaveBeenCalled();
    expect(await f.environment.wait("state", 0)).toMatchObject({
      editorState: "ready",
      editorGeneration: 1,
    });
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.admit).toHaveBeenCalledWith("environment_wait");
    await expect(f.environment.wait("invalid", -1)).rejects.toThrow(
      "duration_ms",
    );
    await expect(f.environment.wait("invalid", 10_001)).rejects.toThrow(
      "duration_ms",
    );
    await expect(f.environment.wait("invalid", 0.5)).rejects.toThrow(
      "duration_ms",
    );
  } finally {
    await f.close();
  }
});

it("tears down failed startup and permits a fresh explicit call without replaying the failed operation", async () => {
  const f = await fixture();
  try {
    f.control.mockRejectedValueOnce(new Error("startup failed"));
    const operation = vi.fn(async () => "called");
    await expect(
      f.environment.runTool("editor_state", "first", operation),
    ).rejects.toThrow("startup failed");
    expect(operation).not.toHaveBeenCalled();
    expect(f.stops).toHaveBeenCalledTimes(1);
    expect(await f.environment.wait("state", 0)).toMatchObject({
      editorState: "failed",
      editorGeneration: 1,
    });
    expect(
      await f.environment.runTool("editor_state", "retry", operation),
    ).toBe("called");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(await f.environment.wait("state", 0)).toMatchObject({
      editorState: "ready",
      editorGeneration: 2,
    });
  } finally {
    await f.close();
  }
});

it("blocks coding on save failure and preserves tool content when reporting successful invalidation", async () => {
  const f = await fixture();
  try {
    await f.environment.runTool("editor_state", "start", async () => "ready");
    const original = {
      content: [{ type: "image", data: "image", mimeType: "image/png" }],
      details: { exitCode: 3 },
      isError: true,
    };
    const write = vi.fn(async () => original);
    f.control.mockRejectedValueOnce(new Error("cannot save scene"));
    await expect(f.environment.runCoding("write", write)).rejects.toThrow(
      "cannot save scene",
    );
    expect(write).not.toHaveBeenCalled();
    expect(f.stops).not.toHaveBeenCalled();
    const result = await f.environment.runCoding("write", write);
    expect(result.content[0]).toEqual(original.content[0]);
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      exitCode: 3,
      chronoriftEnvironment: {
        editorState: "stopped",
        runtimeReferencesInvalidated: true,
        editorGeneration: 1,
      },
    });
    expect(JSON.stringify(result.content)).toContain(
      "use project_run explicitly",
    );
    expect(f.stops).toHaveBeenCalledTimes(1);
    // A further coding-only operation has no additional lifecycle notice.
    expect(await f.environment.runCoding("bash", write)).toBe(original);
    await f.environment.close();
    const { events } = JSON.parse(
      await readFile(f.environment.recordPaths()[0]!, "utf8"),
    ) as { events: unknown[] };
    expect(events).toContainEqual(
      expect.objectContaining({ event: "saved_and_stopped", reason: "write" }),
    );
  } finally {
    await f.close();
  }
});

it("retains control diagnostics in artifacts and propagates the original error", async () => {
  const f = await fixture();
  try {
    const diagnostic: GodotMcpDiagnostic = {
      operation: "start_editor",
      step: "waiting for editor readiness",
      elapsedMs: 120_000,
      timeoutMs: 120_000,
      leaves: [{ type: "TimeoutError", message: "" }],
      truncated: false,
      lastReadiness: "importing",
    };
    const error = new GodotMcpControlError("startup failed", diagnostic);
    f.control.mockRejectedValueOnce(error);
    await expect(
      f.environment.runTool("editor_state", "first", async () => "unused"),
    ).rejects.toBe(error);
    expect(f.control).toHaveBeenCalledWith({ op: "start_editor" }, 150_000);
    await f.environment.close();
    const record = JSON.parse(
      await readFile(f.environment.recordPaths()[0]!, "utf8"),
    ) as { events: unknown[] };
    expect(record.events).toContainEqual({
      event: "control_failed",
      editorGeneration: 1,
      runIndex: 0,
      error: "startup failed",
      diagnostic,
    });
  } finally {
    await f.close();
  }
});

it("exports stderr incomplete markers left by forced process termination", async () => {
  const f = await fixture();
  try {
    const directory = f.open.mock.calls[0]![0].artifactsPath;
    await writeFile(
      join(directory, "process-99.stderr.log"),
      "persisted before termination\n",
    );
    await writeFile(
      join(directory, "process-99.stderr.log.incomplete"),
      "true\n",
    );
    await f.environment.close();
    const records = join(f.environment.recordPaths()[0]!, "..");
    expect(
      await readFile(join(records, "run-0-process-99.stderr.log"), "utf8"),
    ).toBe("persisted before termination\n");
    expect(
      await readFile(
        join(records, "run-0-process-99.stderr.log.incomplete"),
        "utf8",
      ),
    ).toBe("true\n");
  } finally {
    await f.close();
  }
});

it("preserves thrown coding errors and adds invalidation context after closing the editor", async () => {
  const f = await fixture();
  try {
    await f.environment.runTool("editor_state", "start", async () => "ready");
    const original = Object.assign(new Error("Command exited with code 1"), {
      code: "command_failed",
    });
    await expect(
      f.environment.runCoding("bash", async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(original.message).toContain("Command exited with code 1");
    expect(original.message).toContain(
      "Previous runtime references are invalid",
    );
    expect(original.code).toBe("command_failed");
  } finally {
    await f.close();
  }
});

it("detaches the startup signal so cancelling a later wait does not cancel the editor process", async () => {
  const f = await fixture();
  try {
    await f.environment.runCoding("bash", async () => undefined);
    const abort = new AbortController();
    await f.environment.runTool(
      "editor_state",
      "start",
      async () => "ready",
      abort.signal,
    );
    const processSignal = f.open.mock.calls[1]![0].signal!;
    const waiting = f.environment.wait("cancel-wait", 10_000, abort.signal);
    const timer = setTimeout(() => abort.abort(), 10);
    await expect(waiting).rejects.toThrow();
    clearTimeout(timer);
    expect(processSignal.aborted).toBe(false);
    expect(await f.environment.wait("state", 0)).toMatchObject({
      editorState: "ready",
    });
    expect(f.stops).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("holds the serial slot until a cancelled MCP process exits before an explicit retry", async () => {
  const f = await fixture();
  try {
    await f.environment.runTool("editor_state", "start", async () => "ready");
    const handle = await (f.open.mock.results[0]!
      .value as Promise<SrtDuplexHandle>);
    const originalStop = handle.stop.bind(handle);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(handle, "stop").mockImplementation(async () => {
      await gate;
      return originalStop();
    });
    const abort = new AbortController();
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const call = f.environment.runTool(
      "editor_state",
      "cancel",
      () =>
        new Promise((_resolve, reject) => {
          entered();
          abort.signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        }),
      abort.signal,
    );
    const rejected = expect(call).rejects.toThrow("cancelled");
    await entry;
    abort.abort();
    const operation = vi.fn(async () => "retried");
    const retry = f.environment.runTool("editor_state", "retry", operation);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(operation).not.toHaveBeenCalled();
    expect(f.open).toHaveBeenCalledTimes(1);
    release();
    await rejected;
    expect(await retry).toBe("retried");
    expect(f.open).toHaveBeenCalledTimes(2);
    await expect(f.environment.close()).rejects.toThrow("unsaved editor state");
  } finally {
    await f.close();
  }
});
