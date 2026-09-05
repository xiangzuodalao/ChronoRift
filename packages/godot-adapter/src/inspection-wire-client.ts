import { randomUUID } from "node:crypto";
import {
  InspectionQueryInputV1Schema,
  InspectionWatchInputV1Schema,
  InspectionWatchArchiveV1Schema,
  InspectionWatchStateV1Schema,
  type InspectionWatchInputV1,
  type InspectionWatchOutputV1,
  type InspectionWatchArchiveV1,
  type InspectionWatchStateV1,
  type InspectionWatchRecordV1,
  type InspectionQueryResultV1,
} from "@chronorift/domain";
import {
  GODOT_INSPECTION_PROTOCOL_V1,
  GodotInspectionMessageV1Schema,
  WireFrameDecoder,
  encodeWireFrame,
  parseGodotInspectionMessageV1,
  type GodotInspectionMessageV1,
  type GodotInspectionReadyV1,
  type GodotInspectionTerminatedV1,
} from "@chronorift/godot-protocol";
import type { GodotByteTransport } from "./godot-wire-client.js";

interface Waiter {
  readonly predicate: (message: GodotInspectionMessageV1) => boolean;
  readonly resolve: (message: GodotInspectionMessageV1) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

/** One bounded, sequence-checked inspection connection; no project semantics. */
export class GodotInspectionWireClient {
  readonly #decoder = new WireFrameDecoder({ fatalUtf8: true });
  readonly #queue: GodotInspectionMessageV1[] = [];
  readonly #waiters = new Set<Waiter>();
  #incoming = 0;
  #outgoing = 0;
  #failure: Error | undefined;
  #closed = false;
  #executionId: string | undefined;
  readonly #watchRequests = new Map<string, InspectionWatchInputV1>();
  #watchStart: Extract<InspectionWatchInputV1, { action: "start" }> | undefined;
  #capturedWatch: InspectionWatchArchiveV1 | undefined;
  #watchFinal = false;

  /** Only records actually delivered over the connection; never fills lost samples. */
  public get capturedWatch(): InspectionWatchArchiveV1 | undefined {
    return this.#capturedWatch === undefined
      ? undefined
      : structuredClone(this.#capturedWatch);
  }
  public readonly termination: Promise<GodotInspectionTerminatedV1>;

  public constructor(private readonly transport: GodotByteTransport) {
    transport.readable.on("data", this.onData);
    transport.readable.on("error", this.onError);
    transport.readable.on("end", this.onEnd);
    this.termination = this.waitFor(
      (message) => message.kind === "terminated",
    ).then((message) => {
      if (message.kind !== "terminated")
        throw new Error("Invalid inspection termination");
      return message.payload;
    });
    void this.termination.catch(() => undefined);
  }

  public async ready(timeoutMs = 150_000): Promise<GodotInspectionReadyV1> {
    const message = await this.waitFor(
      (value) =>
        value.kind === "ready" ||
        (value.kind === "error" && value.requestId === undefined),
      timeoutMs,
    );
    if (message.kind === "error")
      throw new Error(`${message.payload.code}: ${message.payload.message}`);
    if (message.kind !== "ready") throw new Error("Invalid inspection ready");
    return message.payload;
  }

  public async query(
    input: unknown,
    timeoutMs = 10_000,
  ): Promise<InspectionQueryResultV1> {
    const validated = InspectionQueryInputV1Schema.parse(input);
    const requestId = `inspection.${randomUUID()}`;
    const pending = this.waitFor(
      (message) => "requestId" in message && message.requestId === requestId,
      timeoutMs,
    );
    void pending.catch(() => undefined);
    await this.send({ kind: "query", requestId, payload: validated });
    const message = await pending;
    if (message.kind === "error")
      throw new Error(`${message.payload.code}: ${message.payload.message}`);
    if (message.kind !== "query_result")
      throw new Error("Unexpected inspection query response");
    if (
      message.payload.executionId !== validated.executionId ||
      message.payload.select !== validated.select
    )
      throw new Error("Inspection response does not match the request");
    if (
      "objectRef" in validated.target &&
      message.payload.target.objectRef !== validated.target.objectRef
    )
      throw new Error("Inspection response target does not match the request");
    if (validated.select === "values" && message.payload.select === "values") {
      if (
        message.payload.values.length !== validated.names.length ||
        message.payload.values.some(
          (value, index) => value.name !== validated.names[index],
        )
      )
        throw new Error(
          "Inspection response properties do not match the request",
        );
    } else if (
      validated.select !== "values" &&
      message.payload.select !== "values" &&
      (message.payload.offset !== validated.offset ||
        message.payload.items.length > validated.limit)
    ) {
      throw new Error("Inspection response page does not match the request");
    }
    return message.payload;
  }

  public async watch(
    input: unknown,
    timeoutMs = 10_000,
  ): Promise<InspectionWatchOutputV1> {
    const validated = InspectionWatchInputV1Schema.parse(input);
    if (
      this.#executionId !== undefined &&
      validated.executionId !== this.#executionId
    )
      throw new Error("execution_mismatch: Watch belongs to another execution");
    if (this.#watchRequests.size >= 4)
      throw new Error("Inspection pending watch request bound exceeded");
    const requestId = `inspection.${randomUUID()}`;
    this.#watchRequests.set(requestId, validated);
    if (validated.action === "start" && this.#watchStart === undefined)
      this.#watchStart = validated;
    const pending = this.waitFor(
      (message) => "requestId" in message && message.requestId === requestId,
      timeoutMs,
    );
    void pending.catch(() => undefined);
    try {
      await this.send({ kind: "watch", requestId, payload: validated });
      const message = await pending;
      if (message.kind === "error")
        throw new Error(`${message.payload.code}: ${message.payload.message}`);
      if (message.kind !== "watch_result")
        throw new Error("Unexpected inspection watch response");
      return message.payload;
    } catch (error) {
      // Keep correlation for a delayed response after timeout: it is still obtained evidence.
      if (this.#failure !== undefined) this.#watchRequests.delete(requestId);
      throw error;
    }
  }

  private validateWatchResponse(
    input: InspectionWatchInputV1,
    output: InspectionWatchOutputV1,
  ): void {
    if (
      input.executionId !== output.executionId ||
      input.action !== output.action ||
      (input.action !== "start" && input.watchId !== output.watchId)
    )
      throw new Error("Inspection watch response does not match the request");
    if (input.action === "start") {
      this.validateWatchBinding(input, output);
      if (output.status !== "sampling" || output.recordedCount !== 0)
        throw new Error(
          "Inspection watch start must acknowledge registration before sampling",
        );
    }
    if (input.action === "read" && output.action === "read") {
      if (
        output.bytesUsed > input.byteBudget ||
        output.records.some(
          (record) => record.sequence <= input.afterSequence,
        ) ||
        (output.records.length === 0 &&
          output.nextSequence !== input.afterSequence) ||
        (output.requiredByteBudget !== null &&
          (output.requiredByteBudget <= input.byteBudget ||
            output.recordedCount <= input.afterSequence)) ||
        (output.deliveryComplete &&
          output.recordedCount > input.afterSequence &&
          output.records.length === 0 &&
          output.requiredByteBudget === null)
      )
        throw new Error(
          "Inspection watch page does not match the request budget or cursor",
        );
      if (
        output.deliveryComplete &&
        output.records.some(
          (record, index) =>
            record.sequence !== input.afterSequence + index + 1,
        )
      )
        throw new Error("Inspection watch page omitted records");
    }
  }

  private validateWatchBinding(
    input: Extract<InspectionWatchInputV1, { action: "start" }>,
    state: InspectionWatchStateV1,
  ): void {
    if (
      state.executionId !== input.executionId ||
      state.sampleCount !== input.sampleCount ||
      state.boundTargets.length !== input.targets.length ||
      state.boundTargets.some((bound, index) => {
        const requested = input.targets[index]!;
        return (
          JSON.stringify(bound.names) !== JSON.stringify(requested.names) ||
          ("objectRef" in requested.target &&
            bound.target.objectRef !== requested.target.objectRef) ||
          ("path" in requested.target &&
            bound.target.path !== requested.target.path)
        );
      })
    )
      throw new Error("Inspection watch binding does not match the request");
  }

  private captureWatch(
    state: InspectionWatchStateV1,
    records: readonly InspectionWatchRecordV1[],
    complete: boolean,
  ): void {
    if (this.#watchFinal)
      throw new Error("Inspection watch received data after its final archive");
    if (
      this.#executionId !== undefined &&
      state.executionId !== this.#executionId
    )
      throw new Error("Inspection watch belongs to another execution");
    if (this.#watchStart === undefined)
      throw new Error("Inspection watch was not requested");
    this.validateWatchBinding(this.#watchStart, state);
    const previous = this.#capturedWatch;
    if (
      previous !== undefined &&
      (previous.state.watchId !== state.watchId ||
        previous.state.recordedCount > state.recordedCount ||
        JSON.stringify(previous.state.boundTargets) !==
          JSON.stringify(state.boundTargets) ||
        (previous.state.status === "stopped" &&
          (state.status !== "stopped" ||
            state.stopReason !== previous.state.stopReason)))
    )
      throw new Error("Inspection watch changed its identity or prior state");
    const merged = new Map(
      previous?.records.map((record) => [record.sequence, record]),
    );
    for (const record of records) {
      const old = merged.get(record.sequence);
      if (old !== undefined && JSON.stringify(old) !== JSON.stringify(record))
        throw new Error("Inspection watch changed an already delivered record");
      merged.set(record.sequence, record);
    }
    this.#capturedWatch = InspectionWatchArchiveV1Schema.parse({
      state,
      records: [...merged.values()].sort((a, b) => a.sequence - b.sequence),
      deliveryComplete: complete,
    });
    this.#watchFinal = complete;
  }

  public async stop(timeoutMs = 5_000): Promise<GodotInspectionTerminatedV1> {
    await this.send({ kind: "stop", payload: {} });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.termination,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Inspection stop timed out")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.transport.readable.off("data", this.onData);
    this.transport.readable.off("error", this.onError);
    this.transport.readable.off("end", this.onEnd);
    this.fail(new Error("Inspection connection closed"));
    await this.transport.close();
  }

  private async send(fields: unknown): Promise<void> {
    if (this.#failure !== undefined) throw this.#failure;
    const message = GodotInspectionMessageV1Schema.parse({
      schemaVersion: 1,
      profile: GODOT_INSPECTION_PROTOCOL_V1,
      sequence: this.#outgoing,
      ...(fields as Record<string, unknown>),
    });
    this.#outgoing += 1;
    try {
      await this.transport.write(encodeWireFrame(JSON.stringify(message)));
    } catch (error) {
      const failure =
        error instanceof Error
          ? error
          : new Error("Inspection transport write failed");
      this.fail(failure);
      throw failure;
    }
  }

  private waitFor(
    predicate: Waiter["predicate"],
    timeoutMs?: number,
  ): Promise<GodotInspectionMessageV1> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    const index = this.#queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.#queue.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer:
          timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                this.#waiters.delete(waiter);
                reject(new Error("Inspection request timed out"));
              }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  private readonly onData = (chunk: Uint8Array): void => {
    if (this.#failure !== undefined) return;
    try {
      for (const json of this.#decoder.push(chunk)) {
        const message = parseGodotInspectionMessageV1(json);
        if (message.sequence !== this.#incoming++)
          throw new Error("Inspection message sequence mismatch");
        if (message.kind === "ready")
          this.#executionId = message.payload.executionId;
        if (message.kind === "watch_result") {
          const input = this.#watchRequests.get(message.requestId);
          if (input === undefined)
            throw new Error("Unrequested inspection watch response");
          this.validateWatchResponse(input, message.payload);
          const state = InspectionWatchStateV1Schema.strip().parse(
            message.payload,
          );
          this.captureWatch(
            state,
            message.payload.action === "read" ? message.payload.records : [],
            false,
          );
          this.#watchRequests.delete(message.requestId);
        }
        if (message.kind === "watch_final") {
          this.captureWatch(
            message.payload.state,
            message.payload.records,
            true,
          );
          continue;
        }
        if (message.kind === "error" && message.requestId !== undefined) {
          if (
            this.#watchRequests.get(message.requestId)?.action === "start" &&
            this.#capturedWatch === undefined
          )
            this.#watchStart = undefined;
          this.#watchRequests.delete(message.requestId);
        }
        const waiter = [...this.#waiters].find((candidate) =>
          candidate.predicate(message),
        );
        if (waiter !== undefined) {
          clearTimeout(waiter.timer);
          this.#waiters.delete(waiter);
          waiter.resolve(message);
        } else {
          if (this.#queue.length >= 4)
            throw new Error("Inspection unsolicited message bound exceeded");
          this.#queue.push(message);
        }
        if (message.kind === "terminated") {
          this.fail(new Error("Godot inspection execution exited"));
        }
      }
    } catch (error) {
      this.fail(
        error instanceof Error ? error : new Error("Invalid inspection frame"),
      );
    }
  };
  private readonly onError = (error: Error): void => this.fail(error);
  private readonly onEnd = (): void => {
    try {
      this.#decoder.end();
    } catch (error) {
      this.fail(
        error instanceof Error ? error : new Error("Partial inspection frame"),
      );
    }
    this.fail(new Error("Inspection transport ended"));
  };
  private fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }
}
