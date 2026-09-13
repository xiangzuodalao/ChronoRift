import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

export interface ExecutionTiming {
  readonly toolCallId: string;
  readonly name: string;
  readonly requestedAt: string;
  lockRequestedAt: string | null;
  lockAcquiredAt: string | null;
  finishedAt: string | null;
  workspaceLockWaitMs: number;
  durationMs: number | null;
  outcome: "pending" | "returned" | "threw";
}

/** Host timings only: no tool inputs, model content, or environment values. */
export class ExecutionTelemetry {
  readonly records: ExecutionTiming[] = [];
  #saved: Promise<void> | undefined;

  public async measure<T>(
    name: string,
    toolCallId: string,
    operation: (lock: { requested(): void; acquired(): void }) => Promise<T>,
  ): Promise<T> {
    const start = performance.now();
    let waiting: number | undefined;
    const record: ExecutionTiming = {
      toolCallId,
      name,
      requestedAt: new Date().toISOString(),
      lockRequestedAt: null,
      lockAcquiredAt: null,
      finishedAt: null,
      workspaceLockWaitMs: 0,
      durationMs: null,
      outcome: "pending",
    };
    this.records.push(record);
    try {
      const result = await operation({
        requested() {
          record.lockRequestedAt = new Date().toISOString();
          waiting = performance.now();
        },
        acquired() {
          record.lockAcquiredAt = new Date().toISOString();
          record.workspaceLockWaitMs = performance.now() - waiting!;
          waiting = undefined;
        },
      });
      record.outcome = "returned";
      return result;
    } catch (error) {
      record.outcome = "threw";
      throw error;
    } finally {
      if (waiting !== undefined)
        record.workspaceLockWaitMs = performance.now() - waiting;
      record.finishedAt = new Date().toISOString();
      record.durationMs = performance.now() - start;
    }
  }

  /** Freeze once, after this scope's operations have drained. */
  public save(path: string): Promise<void> {
    this.#saved ??= writeFile(
      path,
      JSON.stringify(
        {
          schemaVersion: 1,
          clock: "UTC timestamps; monotonic elapsed milliseconds",
          records: this.records,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return this.#saved;
  }
}
