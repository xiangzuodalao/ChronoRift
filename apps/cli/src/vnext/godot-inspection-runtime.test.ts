import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InspectionRunRecordV1Schema,
  InspectionToolResponseV1Schema,
  InspectionWatchOutputV1Schema,
  paginateInspectionWatchArchiveV1,
  type InspectionToolNameV1,
  type InspectionWatchArchiveV1,
} from "@chronorift/domain";
import {
  GODOT_INSPECTION_PROTOCOL_V1,
  WireFrameDecoder,
  encodeWireFrame,
  type GodotInspectionMessageV1,
} from "@chronorift/godot-protocol";

import { GodotInspectionRuntime } from "./godot-inspection-runtime.js";
import { SrtGodotRunner } from "./srt-godot-runner.js";
import type {
  SrtCommandResult,
  SrtGodotRequest,
} from "./srt-sandbox-controller.js";

const processObservation = (stdout: string) => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

interface FakeExecution {
  readonly request: SrtGodotRequest;
  readonly executionId: string;
  finish(options?: {
    readonly code?: number;
    readonly sourceChanged?: boolean;
    readonly sourceInvalid?: boolean;
    readonly noTerminal?: boolean;
    readonly noWatchFinal?: boolean;
  }): Promise<void>;
}

describe("GodotInspectionRuntime", () => {
  let root: string;
  let candidate: string;
  let runtime: GodotInspectionRuntime;
  let importMode: "normal" | "error" | "pending";
  let importStarted: boolean;
  let behavior:
    | "normal"
    | "no_query"
    | "bad_query"
    | "missing_object"
    | "wrong_execution"
    | "no_ready";
  let watchBehavior: "normal" | "pending" | "invalid";
  let onWatchRequest: (() => void) | undefined;
  const executions: FakeExecution[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chronorift-inspection-runtime-"));
    candidate = join(root, "candidate");
    executions.length = 0;
    importMode = "normal";
    importStarted = false;
    behavior = "normal";
    watchBehavior = "normal";
    onWatchRequest = undefined;
    await mkdir(candidate);
    await writeFile(
      join(candidate, "project.godot"),
      '[application]\nrun/main_scene="res://main.tscn"\n',
    );
    await writeFile(
      join(candidate, "main.tscn"),
      '[gd_scene format=3]\n[node name="Main" type="Node"]\n',
    );
    const runner = new SrtGodotRunner({
      candidateWorkspace: candidate,
      validationRoot: join(root, "stages"),
      controller: {
        openGodotImport: async (request) => {
          importStarted = true;
          const result: SrtCommandResult = {
            status: "exited",
            exitCode: 0,
            signal: null,
            stdout: "import output",
            stderr: "",
            durationMs: 1,
            timedOut: false,
            cancelled: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
          const completed =
            importMode === "pending"
              ? new Promise<SrtCommandResult>((resolve) => {
                  const finish = () =>
                    resolve({
                      ...result,
                      status: "cancelled",
                      exitCode: null,
                      signal: "SIGKILL",
                      cancelled: true,
                    });
                  if (request.signal?.aborted) finish();
                  else
                    request.signal?.addEventListener("abort", finish, {
                      once: true,
                    });
                })
              : Promise.resolve(
                  importMode === "error"
                    ? { ...result, stderr: "ERROR: import failed" }
                    : result,
                );
          return {
            pid: 122,
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            wait: () => completed,
            stop: () => completed,
          };
        },
        openGodot: async (request) => {
          const executionId = request.argv
            .join(" ")
            .match(/inspection\.[a-f0-9-]{36}/u)?.[0];
          if (executionId === undefined)
            throw new Error("sidecar source is missing executionId");
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          let sequence = 0;
          let finished = false;
          let watch: InspectionWatchArchiveV1 | undefined;
          let resolve!: (result: SrtCommandResult) => void;
          const completion = new Promise<SrtCommandResult>((done) => {
            resolve = done;
          });
          const emit = (fields: object): void => {
            stdout.write(
              encodeWireFrame(
                JSON.stringify({
                  schemaVersion: 1,
                  profile: GODOT_INSPECTION_PROTOCOL_V1,
                  sequence: sequence++,
                  ...fields,
                }),
              ),
            );
          };
          const finish: FakeExecution["finish"] = async (options = {}) => {
            if (finished) return;
            finished = true;
            if (options.sourceChanged)
              await writeFile(
                join(request.projectStagePath, "main.tscn"),
                "tampered source",
              );
            if (options.sourceInvalid) {
              await rm(join(request.projectStagePath, "main.tscn"));
              await symlink(
                "project.godot",
                join(request.projectStagePath, "main.tscn"),
              );
            }
            if (
              watch !== undefined &&
              !options.noTerminal &&
              !options.noWatchFinal
            )
              emit({
                kind: "watch_final",
                payload: { ...watch, deliveryComplete: true },
              });
            if (!options.noTerminal)
              emit({
                kind: "terminated",
                payload: {
                  import: processObservation("import output"),
                  run: {
                    ...processObservation("game output"),
                    exitCode: options.code ?? 0,
                  },
                },
              });
            stdout.end();
            stderr.end();
            resolve({
              status: "exited",
              exitCode: options.code ?? 0,
              signal: null,
              stdout: "wire bytes",
              stderr: "wrapper diagnostic",
              durationMs: 10,
              timedOut: false,
              cancelled: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          };
          const target = {
            objectRef: `${executionId}:1`,
            className: "Node",
            name: "Main",
            path: ".",
            childCount: 0,
          };
          const decoder = new WireFrameDecoder();
          stdin.on("data", (chunk: Buffer) => {
            for (const json of decoder.push(chunk)) {
              const command = JSON.parse(json) as GodotInspectionMessageV1;
              if (command.kind === "stop") void finish();
              if (command.kind === "watch") {
                onWatchRequest?.();
                if (watchBehavior === "pending") continue;
                if (watchBehavior === "invalid") {
                  stdout.write(Buffer.from([0, 0, 0, 1, 0xff]));
                  continue;
                }
                const input = command.payload;
                if (input.action === "start" && watch === undefined) {
                  watch = {
                    state: {
                      schemaVersion: 1,
                      executionId,
                      watchId: `${executionId}.watch.1`,
                      phase: "physics_frame_signal_before_node_physics_process",
                      status: "stopped",
                      stopReason: "sample_count",
                      sampleCount: input.sampleCount,
                      recordedCount: 1,
                      boundTargets: input.targets.map((entry) => ({
                        target,
                        names: entry.names,
                      })),
                    },
                    records: [
                      {
                        sequence: 1,
                        sample: { processFrame: 10, physicsTick: 9 },
                        targets: input.targets.map((entry) => ({
                          target,
                          values: entry.names.map((name) => ({
                            name,
                            status: "success" as const,
                            value: 12,
                          })),
                        })),
                      },
                    ],
                    deliveryComplete: false,
                  };
                  emit({
                    kind: "watch_result",
                    requestId: command.requestId,
                    payload: {
                      ...watch.state,
                      status: "sampling",
                      stopReason: null,
                      recordedCount: 0,
                      action: "start",
                    },
                  });
                } else if (
                  watch === undefined ||
                  ("watchId" in input && input.watchId !== watch.state.watchId)
                ) {
                  emit({
                    kind: "error",
                    requestId: command.requestId,
                    payload: {
                      code: "object_not_found",
                      message: "Unknown watch",
                    },
                  });
                } else if (input.action === "start") {
                  emit({
                    kind: "error",
                    requestId: command.requestId,
                    payload: {
                      code: "busy",
                      message: "One window per Execution",
                    },
                  });
                } else {
                  emit({
                    kind: "watch_result",
                    requestId: command.requestId,
                    payload:
                      input.action === "read"
                        ? paginateInspectionWatchArchiveV1(
                            { ...watch, deliveryComplete: true },
                            input,
                          )
                        : { ...watch.state, action: "stop" },
                  });
                }
                continue;
              }
              if (command.kind !== "query") continue;
              if (behavior === "no_query") continue;
              if (behavior === "bad_query") {
                stdout.write(Buffer.from([0, 0, 0, 1, 0xff]));
                continue;
              }
              if (behavior === "missing_object") {
                emit({
                  kind: "error",
                  requestId: command.requestId,
                  payload: {
                    code: "object_not_found",
                    message: "Object no longer exists",
                  },
                });
                continue;
              }
              const query = command.payload;
              const base = {
                schemaVersion: 1,
                executionId,
                select: query.select,
                sample: { processFrame: 10, physicsTick: 9 },
                target,
              };
              emit({
                kind: "query_result",
                requestId: command.requestId,
                payload:
                  query.select === "values"
                    ? {
                        ...base,
                        values: query.names.map((name) => ({
                          name,
                          status: "success",
                          value: 12,
                        })),
                      }
                    : { ...base, items: [], offset: query.offset, total: 0 },
              });
            }
          });
          executions.push({ request, executionId, finish });
          if (behavior !== "no_ready")
            setTimeout(
              () =>
                emit({
                  kind: "ready",
                  payload: {
                    executionId:
                      behavior === "wrong_execution"
                        ? "different-execution"
                        : executionId,
                    engineVersion: "4.5.2.stable",
                    scene: "res://main.tscn",
                    root: target,
                  },
                }),
              0,
            );
          return {
            pid: 123,
            stdin,
            stdout,
            stderr,
            wait: () => completion,
            stop: async () => {
              await finish({ noTerminal: true });
              return completion;
            },
          };
        },
      },
    });
    runtime = new GodotInspectionRuntime({
      runner,
      candidateWorkspace: candidate,
      artifactsDirectory: join(root, "records"),
      nodePath: "/usr/bin/node",
      godotPath: "/opt/godot",
      importTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
      executionTimeoutMs: 10_000,
      queryTimeoutMs: 40,
      stopTimeoutMs: 100,
    });
  });

  afterEach(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const invoke = async (
    toolName: InspectionToolNameV1,
    input: unknown,
    signal?: AbortSignal,
  ) =>
    InspectionToolResponseV1Schema.parse(
      await runtime.invoke(
        { schemaVersion: 1, toolCallId: "test-call", toolName, input },
        signal,
      ),
    );
  const launch = async () => {
    const response = await invoke("game_launch", { schemaVersion: 1 });
    expect(response.outcome).toBe("success");
    if (response.outcome !== "success" || !("root" in response.output))
      throw new Error(JSON.stringify(response));
    return response.output;
  };

  it("launches immutable current source, queries, and saves idempotent process results", async () => {
    const first = await launch();
    await expect(
      invoke("game_launch", { schemaVersion: 1 }),
    ).resolves.toMatchObject({ outcome: "error", error: { code: "busy" } });
    const changedSource =
      '[gd_scene format=3]\n[node name="Changed" type="Node"]\n';
    await writeFile(join(candidate, "main.tscn"), changedSource);
    expect(
      await readFile(
        join(executions[0]!.request.projectStagePath, "main.tscn"),
        "utf8",
      ),
    ).not.toBe(changedSource);
    await expect(
      invoke("game_query", {
        schemaVersion: 1,
        executionId: first.executionId,
        select: "values",
        names: ["width"],
      }),
    ).resolves.toMatchObject({
      outcome: "success",
      output: {
        values: [{ name: "width", status: "success", value: 12 }],
        hostReceivedAt: expect.any(String) as unknown,
      },
    });
    const stopped = await invoke("game_stop", {
      schemaVersion: 1,
      executionId: first.executionId,
    });
    expect(stopped).toMatchObject({
      outcome: "success",
      output: {
        record: {
          sourceSha256: first.sourceSha256,
          sourceUnchanged: true,
          import: { stdout: "import output" },
          run: { stdout: "game output" },
          stderr: "wrapper diagnostic",
          error: null,
        },
      },
    });
    expect(
      await invoke("game_stop", {
        schemaVersion: 1,
        executionId: first.executionId,
      }),
    ).toEqual(stopped);
    expect(
      InspectionRunRecordV1Schema.parse(
        JSON.parse(await readFile(runtime.recordPaths()[0]!, "utf8")),
      ),
    ).toEqual(runtime.records()[0]);
    const second = await launch();
    expect(second.sourceSha256).not.toBe(first.sourceSha256);
    await expect(
      invoke("game_query", {
        schemaVersion: 1,
        executionId: first.executionId,
        select: "children",
      }),
    ).resolves.toMatchObject({
      outcome: "error",
      error: { code: "execution_exited" },
    });
    await expect(
      invoke("game_stop", {
        schemaVersion: 1,
        executionId: "foreign-execution",
      }),
    ).resolves.toMatchObject({
      outcome: "error",
      error: { code: "execution_not_found" },
    });
  });

  it("retains natural crash output and permits a subsequent launch", async () => {
    const first = await launch();
    await executions[0]!.finish({ code: 7 });
    await expect.poll(() => runtime.records().length).toBe(1);
    expect(runtime.records()[0]).toMatchObject({
      executionId: first.executionId,
      exitCode: 7,
      run: { exitCode: 7 },
      sourceUnchanged: true,
    });
    await launch();
  });

  it.each(["no_query", "bad_query"] as const)(
    "terminates and records an unresponsive or invalid runtime (%s)",
    async (mode) => {
      const run = await launch();
      behavior = mode;
      const response = await invoke("game_query", {
        schemaVersion: 1,
        executionId: run.executionId,
        select: "children",
      });
      expect(response).toMatchObject({
        outcome: "error",
        error: {
          code: mode === "no_query" ? "query_timeout" : "protocol_error",
        },
      });
      expect(runtime.records()).toHaveLength(1);
      expect(runtime.records()[0]?.error?.code).toBe(
        mode === "no_query" ? "query_timeout" : "protocol_error",
      );
    },
  );

  it("keeps a game available after an ordinary missing-object response", async () => {
    const run = await launch();
    behavior = "missing_object";
    await expect(
      invoke("game_query", {
        schemaVersion: 1,
        executionId: run.executionId,
        select: "children",
        target: { objectRef: "gone" },
      }),
    ).resolves.toMatchObject({
      outcome: "error",
      error: { code: "object_not_found" },
    });
    expect(runtime.records()).toHaveLength(0);
    behavior = "normal";
    await expect(
      invoke("game_query", {
        schemaVersion: 1,
        executionId: run.executionId,
        select: "children",
      }),
    ).resolves.toMatchObject({ outcome: "success" });
  });

  it("cancels pending queries and closes the process", async () => {
    const run = await launch();
    behavior = "no_query";
    const abort = new AbortController();
    const pending = invoke(
      "game_query",
      { schemaVersion: 1, executionId: run.executionId, select: "children" },
      abort.signal,
    );
    setTimeout(() => abort.abort(), 1);
    await expect(pending).resolves.toMatchObject({
      outcome: "error",
      error: { code: "cancelled" },
    });
    expect(runtime.records()[0]?.error?.code).toBe("cancelled");
  });

  it("retains exit-zero import errors without starting the game", async () => {
    importMode = "error";
    await expect(
      invoke("game_launch", { schemaVersion: 1 }),
    ).resolves.toMatchObject({ outcome: "error" });
    expect(executions).toHaveLength(0);
    expect(runtime.records()[0]).toMatchObject({
      import: {
        exitCode: 0,
        stdout: "import output",
        stderr: "ERROR: import failed",
      },
      run: null,
      sourceSha256: null,
      sourceUnchanged: null,
      error: { code: "launch_failed" },
    });
  });

  it("close cancels an in-flight import and retains its output without opening a run stage", async () => {
    importMode = "pending";
    const pending = invoke("game_launch", { schemaVersion: 1 });
    await expect.poll(() => importStarted).toBe(true);
    await runtime.close();
    await expect(pending).resolves.toMatchObject({
      outcome: "error",
      error: { code: "cancelled" },
    });
    expect(executions).toHaveLength(0);
    expect(runtime.records()[0]).toMatchObject({
      status: "cancelled",
      import: { stdout: "import output", signal: "SIGKILL" },
      run: null,
      error: { code: "cancelled" },
    });
  });

  it("closes a pending launch without waiting for its readiness deadline", async () => {
    behavior = "no_ready";
    const pending = invoke("game_launch", { schemaVersion: 1 });
    await expect.poll(() => executions.length).toBe(1);
    await runtime.close();
    await expect(pending).resolves.toMatchObject({ outcome: "error" });
    expect(runtime.records()).toHaveLength(1);
    expect(runtime.records()[0]).toMatchObject({
      sourceUnchanged: true,
      error: { code: "cancelled" },
    });
    await expect(
      invoke("game_launch", { schemaVersion: 1 }),
    ).resolves.toMatchObject({
      outcome: "error",
      error: { code: "runtime_closed" },
    });
  });

  it("records staged-source corruption without claiming integrity", async () => {
    await launch();
    await executions[0]!.finish({ sourceChanged: true });
    await expect.poll(() => runtime.records().length).toBe(1);
    expect(runtime.records()[0]).toMatchObject({
      sourceUnchanged: false,
      error: { code: "source_changed" },
    });
  });

  it("preserves actual process output when source verification cannot produce a hash", async () => {
    await launch();
    await executions[0]!.finish({ code: 7, sourceInvalid: true });
    await expect.poll(() => runtime.records().length).toBe(1);
    expect(runtime.records()[0]).toMatchObject({
      status: "exited",
      exitCode: 7,
      stderr: "wrapper diagnostic",
      observedSourceSha256: null,
      sourceUnchanged: null,
      run: { exitCode: 7, stdout: "game output" },
      error: { code: "operation_failed" },
    });
  });

  it("rejects a foreign handshake and records failed source admission", async () => {
    behavior = "wrong_execution";
    await expect(
      invoke("game_launch", { schemaVersion: 1 }),
    ).resolves.toMatchObject({
      outcome: "error",
      error: { code: "execution_mismatch" },
    });
    await writeFile(join(candidate, "project.godot"), "[application]\n");
    await expect(
      invoke("game_launch", { schemaVersion: 1 }),
    ).resolves.toMatchObject({
      outcome: "error",
      error: { code: "launch_failed" },
    });
    expect(runtime.records()[1]).toMatchObject({
      sourceSha256: null,
      mainScene: null,
      status: "failed",
      run: null,
    });
  });

  it("rejects unsupported query arguments without touching the game", async () => {
    await expect(
      invoke("game_query", {
        schemaVersion: 1,
        executionId: "other",
        select: "values",
        names: ["x"],
        filter: "unsupported",
      }),
    ).resolves.toMatchObject({
      outcome: "error",
      error: { code: "invalid_request" },
    });
    expect(executions).toHaveLength(0);
  });

  const startWatch = async (executionId: string) => {
    const response = await invoke("game_watch", {
      schemaVersion: 1,
      executionId,
      action: "start",
      targets: [{ target: { path: "." }, names: ["width"] }],
      sampleCount: 1,
    });
    if (response.outcome !== "success")
      throw new Error(JSON.stringify(response));
    return InspectionWatchOutputV1Schema.parse(response.output);
  };
  const readWatch = (
    executionId: string,
    watchId: string,
    signal?: AbortSignal,
  ) =>
    invoke(
      "game_watch",
      { schemaVersion: 1, executionId, watchId, action: "read" },
      signal,
    );

  it("retains the final watch, reads after exit, and rejects cross-execution watch IDs", async () => {
    const first = await launch();
    const watch = await startWatch(first.executionId);
    const stopInput = {
      schemaVersion: 1,
      executionId: first.executionId,
      watchId: watch.watchId,
      action: "stop",
    };
    expect(await invoke("game_watch", stopInput)).toEqual(
      await invoke("game_watch", stopInput),
    );
    expect(runtime.records()).toHaveLength(0);
    await expect(startWatch(first.executionId)).rejects.toThrow("busy");
    await invoke("game_stop", {
      schemaVersion: 1,
      executionId: first.executionId,
    });
    const record = runtime.records()[0]!;
    expect(record.watch).toMatchObject({
      deliveryComplete: true,
      records: [{ sequence: 1 }],
    });
    expect(await readWatch(first.executionId, watch.watchId)).toMatchObject({
      outcome: "success",
      output: {
        deliveryComplete: true,
        records: [{ sequence: 1 }],
        nextSequence: 1,
      },
    });
    expect(await invoke("game_watch", stopInput)).toMatchObject({
      outcome: "success",
    });
    expect(
      JSON.parse(await readFile(runtime.recordPaths()[0]!, "utf8")),
    ).toEqual(record);
    const second = await launch();
    await startWatch(second.executionId);
    expect(await readWatch(second.executionId, watch.watchId)).toMatchObject({
      outcome: "error",
      error: { code: "object_not_found" },
    });
    expect(await readWatch("foreign", watch.watchId)).toMatchObject({
      outcome: "error",
      error: { code: "execution_not_found" },
    });
    expect(runtime.records()).toHaveLength(1);
  });

  it.each([false, true])(
    "preserves only retrieved watch records on abrupt exit (page read=%s)",
    async (readPage) => {
      const run = await launch();
      const watch = await startWatch(run.executionId);
      if (readPage) await readWatch(run.executionId, watch.watchId);
      await executions[0]!.finish({ code: 7, noWatchFinal: true });
      await invoke("game_stop", {
        schemaVersion: 1,
        executionId: run.executionId,
      });
      expect(runtime.records()[0]?.watch).toMatchObject({
        deliveryComplete: false,
      });
      expect(runtime.records()[0]?.watch?.records).toHaveLength(
        readPage ? 1 : 0,
      );
      expect(await readWatch(run.executionId, watch.watchId)).toMatchObject({
        outcome: "success",
        output: { deliveryComplete: false },
      });
    },
  );

  it.each(["cancel", "timeout", "invalid", "close"] as const)(
    "cleans up a pending/invalid watch on %s",
    async (mode) => {
      const run = await launch();
      const watch = await startWatch(run.executionId);
      await readWatch(run.executionId, watch.watchId);
      watchBehavior = mode === "invalid" ? "invalid" : "pending";
      const requested = new Promise<void>((resolve) => {
        onWatchRequest = resolve;
      });
      const abort = new AbortController();
      const pending = readWatch(run.executionId, watch.watchId, abort.signal);
      await requested;
      if (mode === "cancel") abort.abort();
      if (mode === "close") await runtime.close();
      expect(await pending).toMatchObject({ outcome: "error" });
      await runtime.close();
      const record = runtime.records()[0]!;
      expect(record.watch?.records).toHaveLength(1);
      expect(record.watch?.deliveryComplete).toBe(mode === "close");
      if (mode !== "close")
        expect(record.error?.code).toBe(
          mode === "cancel"
            ? "cancelled"
            : mode === "timeout"
              ? "query_timeout"
              : "protocol_error",
        );
      expect(record.sourceUnchanged).toBe(true);
      await expect(
        readFile(join(executions[0]!.request.projectStagePath, "main.tscn")),
      ).rejects.toThrow();
    },
  );

  it("retains complete final delivery when a normal exit interrupts a watch read", async () => {
    const run = await launch();
    const watch = await startWatch(run.executionId);
    watchBehavior = "pending";
    const requested = new Promise<void>((resolve) => {
      onWatchRequest = resolve;
    });
    const pending = readWatch(run.executionId, watch.watchId);
    await requested;
    await executions[0]!.finish();
    expect(await pending).toMatchObject({
      outcome: "error",
      error: { code: "execution_exited" },
    });
    expect(runtime.records()[0]).toMatchObject({
      error: null,
      watch: { deliveryComplete: true, records: [{ sequence: 1 }] },
    });
    expect(await readWatch(run.executionId, watch.watchId)).toMatchObject({
      outcome: "success",
      output: { deliveryComplete: true, records: [{ sequence: 1 }] },
    });
  });
});
