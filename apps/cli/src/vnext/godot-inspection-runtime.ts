import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  INSPECTION_INPUT_SCHEMAS_V1,
  InspectionLaunchOutputV1Schema,
  InspectionQueryInputV1Schema,
  InspectionQueryOutputV1Schema,
  InspectionRunRecordV1Schema,
  InspectionStopOutputV1Schema,
  InspectionStopInputV1Schema,
  InspectionToolResponseV1Schema,
  type InspectionErrorV1,
  type InspectionQueryInputV1,
  type InspectionRunRecordV1,
  type InspectionToolResponseV1,
} from "@chronorift/domain";
import {
  GODOT_INSPECTION_OVERLAY_FILES_V1,
  GodotInspectionWireClient,
  createGodotInspectionSidecarSource,
} from "@chronorift/godot-adapter";
import type { GodotInspectionTerminatedV1 } from "@chronorift/godot-protocol";
import type {
  InspectionGameToolPort,
  InspectionGameToolPortRequestV1,
} from "@chronorift/pi-harness";

import { prepareGodotInspectionCandidate } from "./godot-inspection-source.js";
import type {
  SrtGodotProcessResult,
  SrtGodotRunHandle,
  SrtGodotRunner,
} from "./srt-godot-runner.js";
import type { SrtCommandResult } from "./srt-sandbox-controller.js";

export interface GodotInspectionRuntimeOptions {
  readonly runner: Pick<SrtGodotRunner, "open">;
  readonly candidateWorkspace: string;
  readonly artifactsDirectory: string;
  readonly nodePath: string;
  readonly godotPath: string;
  readonly now?: (() => string) | undefined;
  readonly importTimeoutMs?: number | undefined;
  readonly startupTimeoutMs?: number | undefined;
  readonly executionTimeoutMs?: number | undefined;
  readonly queryTimeoutMs?: number | undefined;
  readonly stopTimeoutMs?: number | undefined;
}

interface Execution {
  readonly executionId: string;
  readonly startedAt: string;
  mainScene: string | null;
  engineVersion: string | null;
  handle: SrtGodotRunHandle | null;
  client: GodotInspectionWireClient | null;
  terminated: GodotInspectionTerminatedV1 | null;
  error: InspectionErrorV1 | null;
  completion: Promise<InspectionRunRecordV1> | null;
  stopping: Promise<InspectionRunRecordV1> | null;
  record: InspectionRunRecordV1 | null;
}

class InspectionFailure extends Error {
  public constructor(readonly detail: InspectionErrorV1) {
    super(detail.message);
  }
}

const errorDetail = (
  error: unknown,
  code: InspectionErrorV1["code"],
): InspectionErrorV1 =>
  error instanceof InspectionFailure
    ? error.detail
    : {
        code,
        message:
          (error instanceof Error ? error.message : String(error)).slice(
            0,
            4_096,
          ) || code,
      };

const failure = (
  code: InspectionErrorV1["code"],
  message: string,
): InspectionFailure => new InspectionFailure({ code, message });

/** One task-local live game with immutable source and ordinary object inspection. */
export class GodotInspectionRuntime implements InspectionGameToolPort {
  readonly #executions = new Map<string, Execution>();
  #active: Execution | null = null;
  #operation: Promise<unknown> = Promise.resolve();
  #closed = false;
  #closing: Promise<void> | null = null;
  readonly #bounds: {
    importTimeoutMs: number;
    startupTimeoutMs: number;
    executionTimeoutMs: number;
    queryTimeoutMs: number;
    stopTimeoutMs: number;
  };

  public constructor(private readonly options: GodotInspectionRuntimeOptions) {
    this.#bounds = {
      importTimeoutMs: options.importTimeoutMs ?? 120_000,
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      executionTimeoutMs: options.executionTimeoutMs ?? 600_000,
      queryTimeoutMs: options.queryTimeoutMs ?? 30_000,
      stopTimeoutMs: options.stopTimeoutMs ?? 5_000,
    };
    for (const [name, value] of Object.entries(this.#bounds)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 600_000)
        throw new TypeError(`${name} must be an integer between 1 and 600000`);
    }
  }

  public records(): readonly InspectionRunRecordV1[] {
    return [...this.#executions.values()].flatMap((value) =>
      value.record === null ? [] : [value.record],
    );
  }

  public recordPaths(): readonly string[] {
    return this.records().map((record) => this.recordPath(record.executionId));
  }

  public invoke(
    request: InspectionGameToolPortRequestV1,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const operation = this.#operation.then(
      async (): Promise<InspectionToolResponseV1> => {
        try {
          if (this.#closed)
            throw failure(
              "runtime_closed",
              "The Godot inspection runtime is closed",
            );
          if (signal?.aborted)
            throw failure("cancelled", "Inspection operation was cancelled");
          const schema = INSPECTION_INPUT_SCHEMAS_V1[request.toolName];
          const input = schema.safeParse(request.input);
          if (!input.success)
            throw failure(
              "invalid_request",
              input.error.message.slice(0, 4_096),
            );
          let output: unknown;
          if (request.toolName === "game_launch") {
            output = await this.launch(signal);
          } else if (request.toolName === "game_query") {
            output = await this.query(
              InspectionQueryInputV1Schema.parse(request.input),
              signal,
            );
          } else {
            const { executionId } = InspectionStopInputV1Schema.parse(
              request.input,
            );
            const execution = this.lookup(executionId);
            output = InspectionStopOutputV1Schema.parse({
              schemaVersion: 1,
              executionId,
              recordPath: this.recordPath(executionId),
              record: await this.stop(execution),
            });
          }
          return InspectionToolResponseV1Schema.parse({
            schemaVersion: 1,
            outcome: "success",
            output,
          });
        } catch (error) {
          return InspectionToolResponseV1Schema.parse({
            schemaVersion: 1,
            outcome: "error",
            error: errorDetail(error, "operation_failed"),
          });
        }
      },
    );
    this.#operation = operation.catch(() => undefined);
    return operation;
  }

  public close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      // Interrupt pending protocol waits before waiting for the serialized call.
      if (this.#active?.handle != null) await this.stop(this.#active);
      await this.#operation;
      if (this.#active !== null) await this.stop(this.#active);
    })();
    return this.#closing;
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
  private recordPath(executionId: string): string {
    return join(this.options.artifactsDirectory, `${executionId}.json`);
  }
  private lookup(executionId: string): Execution {
    const execution = this.#executions.get(executionId);
    if (execution === undefined)
      throw failure(
        "execution_not_found",
        "Execution does not belong to this inspection session",
      );
    return execution;
  }

  private async launch(signal?: AbortSignal): Promise<unknown> {
    if (this.#active !== null)
      throw failure(
        "busy",
        "A game is already running; stop that execution before launching again",
      );
    const execution: Execution = {
      executionId: `inspection.${randomUUID()}`,
      startedAt: this.now(),
      mainScene: null,
      engineVersion: null,
      handle: null,
      client: null,
      terminated: null,
      error: null,
      completion: null,
      stopping: null,
      record: null,
    };
    this.#active = execution;
    this.#executions.set(execution.executionId, execution);
    try {
      const source = await prepareGodotInspectionCandidate(
        this.options.candidateWorkspace,
      );
      execution.mainScene = source.mainScene;
      if (this.#closed || signal?.aborted)
        throw failure("cancelled", "Game launch was cancelled");
      const handle = await this.options.runner.open({
        sourceFiles: source.sourceFiles,
        overlayFiles: GODOT_INSPECTION_OVERLAY_FILES_V1,
        argv: (stage) => [
          this.options.nodePath,
          "--input-type=commonjs",
          "--eval",
          createGodotInspectionSidecarSource({
            godotExecutable: this.options.godotPath,
            projectRoot: stage.projectStagePath,
            executionId: execution.executionId,
            importTimeoutMs: this.#bounds.importTimeoutMs,
            startupTimeoutMs: this.#bounds.startupTimeoutMs,
            executionTimeoutMs: this.#bounds.executionTimeoutMs,
          }),
        ],
        timeoutMs:
          this.#bounds.importTimeoutMs +
          this.#bounds.startupTimeoutMs +
          this.#bounds.executionTimeoutMs +
          this.#bounds.stopTimeoutMs,
        readOnlyPaths: [
          dirname(this.options.nodePath),
          dirname(this.options.godotPath),
        ],
      });
      execution.handle = handle;
      // Observe writable failures even when no request is being sent.
      handle.process.stdin.on("error", () => undefined);
      const client = new GodotInspectionWireClient({
        readable: handle.process.stdout,
        write: (bytes) =>
          new Promise<void>((resolve, reject) => {
            handle.process.stdin.write(bytes, (error) =>
              error ? reject(error) : resolve(),
            );
          }),
        close: () => {
          handle.process.stdin.end();
          return Promise.resolve();
        },
      });
      execution.client = client;
      void client.termination.then(
        (terminated) => {
          execution.terminated = terminated;
        },
        (error: unknown) => {
          execution.error ??= errorDetail(error, "protocol_error");
          void handle.terminate().catch(() => undefined);
        },
      );
      execution.completion = handle.completion.then(
        (result) => this.finish(execution, result),
        async (error: unknown) => {
          execution.error ??= errorDetail(error, "operation_failed");
          // Source verification can fail after the process has already yielded
          // valid output. Retain those facts even when no final hash is available.
          const process = await handle.process.wait().catch(() => null);
          return this.finish(execution, null, process);
        },
      );
      // A persistence failure must remain observable to close/stop, never unhandled.
      void execution.completion.catch(() => undefined);
      if (this.#closed || signal?.aborted)
        throw failure("cancelled", "Game launch was cancelled");
      const ready = await this.withCancellation(
        execution,
        client.ready(
          this.#bounds.importTimeoutMs + this.#bounds.startupTimeoutMs,
        ),
        signal,
      );
      if (ready.executionId !== execution.executionId)
        throw failure(
          "execution_mismatch",
          "Godot handshake belongs to another execution",
        );
      execution.mainScene = ready.scene;
      execution.engineVersion = ready.engineVersion;
      if (execution.record !== null || this.#closed)
        throw failure(
          "execution_exited",
          "Game exited before launch completed",
        );
      return InspectionLaunchOutputV1Schema.parse({
        schemaVersion: 1,
        executionId: execution.executionId,
        sourceSha256: handle.sourceSha256,
        mainScene: ready.scene,
        engineVersion: ready.engineVersion,
        root: ready.root,
      });
    } catch (error) {
      execution.error ??= errorDetail(error, "launch_failed");
      await this.stop(execution);
      throw new InspectionFailure(execution.error);
    }
  }

  private async query(
    input: InspectionQueryInputV1,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const execution = this.lookup(input.executionId);
    if (
      execution !== this.#active ||
      execution.record !== null ||
      execution.client === null
    )
      throw failure(
        "execution_exited",
        "Execution has exited; recorded process results remain available through game_stop",
      );
    try {
      const result = await this.withCancellation(
        execution,
        execution.client.query(input, this.#bounds.queryTimeoutMs),
        signal,
      );
      return InspectionQueryOutputV1Schema.parse({
        ...result,
        hostReceivedAt: this.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Valid negative replies are ordinary query outcomes, not process failures.
      for (const code of [
        "object_not_found",
        "execution_mismatch",
        "invalid_request",
        "budget_exhausted",
      ] as const) {
        if (message.startsWith(`${code}:`)) throw failure(code, message);
      }
      execution.error ??= errorDetail(
        error,
        /timed out/iu.test(message) ? "query_timeout" : "protocol_error",
      );
      await this.stop(execution);
      throw new InspectionFailure(execution.error);
    }
  }

  private async withCancellation<T>(
    execution: Execution,
    operation: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal === undefined) return operation;
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        const error = failure(
          "cancelled",
          "Inspection operation was cancelled",
        );
        execution.error ??= error.detail;
        void this.stop(execution).catch(() => undefined);
        reject(error);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, cancelled]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }

  private stop(execution: Execution): Promise<InspectionRunRecordV1> {
    if (execution.record !== null) return Promise.resolve(execution.record);
    if (execution.stopping !== null) return execution.stopping;
    execution.stopping = (async () => {
      if (execution.handle === null) return this.finish(execution, null);
      if (execution.terminated === null && execution.client !== null) {
        try {
          execution.terminated = await execution.client.stop(
            this.#bounds.stopTimeoutMs,
          );
        } catch {
          await execution.handle.terminate().catch(() => undefined);
        }
      }
      if (execution.completion === null)
        throw new Error("Inspection execution has no completion handler");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          execution.completion,
          new Promise<InspectionRunRecordV1>((resolve, reject) => {
            timer = setTimeout(() => {
              void execution
                .handle!.terminate()
                .then(() => execution.completion!)
                .then(resolve, reject);
            }, this.#bounds.stopTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    })();
    return execution.stopping;
  }

  private async finish(
    execution: Execution,
    result: SrtGodotProcessResult | null,
    observedProcess: SrtCommandResult | null = null,
  ): Promise<InspectionRunRecordV1> {
    if (execution.record !== null) return execution.record;
    if (execution.handle !== null && execution.terminated === null)
      execution.error ??= {
        code: "protocol_error",
        message: "Execution ended without complete Godot process results",
      };
    if (execution.handle !== null && execution.engineVersion === null)
      execution.error ??= {
        code: "launch_failed",
        message:
          "Game exited before its main scene became available for inspection",
      };
    if (result?.sourceUnchanged === false)
      execution.error = {
        code: "source_changed",
        message: "Staged project source changed during execution",
      };
    const process = result?.process ?? observedProcess;
    const stderr = process?.stderr ?? "";
    const record = InspectionRunRecordV1Schema.parse({
      schemaVersion: 1,
      executionId: execution.executionId,
      sourceSha256:
        result?.sourceSha256 ?? execution.handle?.sourceSha256 ?? null,
      observedSourceSha256: result?.observedSourceSha256 ?? null,
      sourceUnchanged: result?.sourceUnchanged ?? null,
      mainScene: execution.mainScene,
      engineVersion: execution.engineVersion,
      startedAt: execution.startedAt,
      endedAt: this.now(),
      status: process?.status ?? "failed",
      exitCode: process?.exitCode ?? null,
      signal: process?.signal ?? null,
      import: execution.terminated?.import ?? null,
      run: execution.terminated?.run ?? null,
      stderr: stderr.slice(0, 64 * 1_024),
      stderrTruncated:
        (process?.stderrTruncated ?? false) || stderr.length > 64 * 1_024,
      error: execution.error,
    });
    try {
      await mkdir(this.options.artifactsDirectory, {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        this.recordPath(execution.executionId),
        `${JSON.stringify(record, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      execution.record = record;
      return record;
    } finally {
      if (this.#active === execution) this.#active = null;
      await execution.client?.close().catch(() => undefined);
    }
  }
}
