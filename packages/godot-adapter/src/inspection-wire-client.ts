import { randomUUID } from "node:crypto";
import {
  InspectionQueryInputV1Schema,
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
    await this.transport.write(encodeWireFrame(JSON.stringify(message)));
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
