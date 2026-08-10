import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";

import type { JsonValue } from "@chronorift/domain";
import {
  WireFrameDecoder,
  encodeWireFrame,
  makeGodotWireMessage,
  parseGodotWireMessage,
  type GodotWireMessage,
  type GodotWireMessageKind,
} from "@chronorift/godot-protocol";

import { GodotAdapterError } from "./errors.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_UNSOLICITED_MESSAGES = 32;
const DEFAULT_MAX_UNSOLICITED_BYTES = 256 * 1024;

export interface GodotByteTransport {
  readonly readable: NodeJS.ReadableStream;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

interface Waiter {
  readonly predicate: (message: GodotWireMessage) => boolean;
  readonly resolve: (message: GodotWireMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface GodotWireClientOptions {
  readonly commandTimeoutMs?: number | undefined;
  readonly maxUnsolicitedMessages?: number | undefined;
  readonly maxUnsolicitedBytes?: number | undefined;
}

export class GodotWireClient {
  readonly #decoder = new WireFrameDecoder();
  readonly #queue: {
    readonly message: GodotWireMessage;
    readonly encodedBytes: number;
  }[] = [];
  readonly #waiters = new Set<Waiter>();
  readonly #commandTimeoutMs: number;
  readonly #maxUnsolicitedMessages: number;
  readonly #maxUnsolicitedBytes: number;
  #incomingSequence = 0;
  #outgoingSequence = 0;
  #queuedBytes = 0;
  #failure: Error | undefined;
  #closed = false;
  #transportClose: Promise<void> | undefined;

  public constructor(
    private readonly transport: GodotByteTransport,
    private readonly protocolVersion: 1 | 2,
    options: GodotWireClientOptions = {},
  ) {
    this.#commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#maxUnsolicitedMessages =
      options.maxUnsolicitedMessages ?? DEFAULT_MAX_UNSOLICITED_MESSAGES;
    this.#maxUnsolicitedBytes =
      options.maxUnsolicitedBytes ?? DEFAULT_MAX_UNSOLICITED_BYTES;
    if (
      !Number.isInteger(this.#commandTimeoutMs) ||
      this.#commandTimeoutMs < 1 ||
      !Number.isInteger(this.#maxUnsolicitedMessages) ||
      this.#maxUnsolicitedMessages < 1 ||
      this.#maxUnsolicitedMessages > 1_024 ||
      !Number.isInteger(this.#maxUnsolicitedBytes) ||
      this.#maxUnsolicitedBytes < 1 ||
      this.#maxUnsolicitedBytes > 16 * 1024 * 1024
    ) {
      throw new TypeError("Godot wire client bounds must be positive integers");
    }

    transport.readable.on("data", this.onData);
    transport.readable.on("error", this.onError);
    transport.readable.on("end", this.onEnd);
    transport.readable.on("close", this.onClose);
  }

  public async send(
    kind: GodotWireMessageKind,
    payload: unknown,
    requestId?: string,
  ): Promise<void> {
    this.assertOpen();
    const message = makeGodotWireMessage({
      sequence: this.#outgoingSequence,
      kind,
      protocolVersion: this.protocolVersion,
      ...(requestId === undefined ? {} : { requestId }),
      payload: payload as JsonValue,
    });
    this.#outgoingSequence += 1;
    try {
      await this.transport.write(encodeWireFrame(JSON.stringify(message)));
    } catch (error) {
      const failure = this.asFailure(error, "Godot runtime write failed");
      this.fail(failure);
      throw failure;
    }
  }

  public waitFor(
    predicate: (message: GodotWireMessage) => boolean,
    timeoutMs = this.#commandTimeoutMs,
  ): Promise<GodotWireMessage> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#closed) {
      return Promise.reject(
        new GodotAdapterError("PROCESS_FAILED", "Godot wire client is closed"),
      );
    }
    const queuedIndex = this.#queue.findIndex(({ message }) =>
      predicate(message),
    );
    if (queuedIndex >= 0) {
      const queued = this.#queue.splice(queuedIndex, 1)[0];
      if (queued !== undefined) {
        this.#queuedBytes -= queued.encodedBytes;
        return Promise.resolve(queued.message);
      }
    }
    return new Promise((resolveWait, rejectWait) => {
      const waiter: Waiter = {
        predicate,
        resolve: resolveWait,
        reject: rejectWait,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          rejectWait(
            new GodotAdapterError(
              "COMMAND_TIMEOUT",
              `Godot protocol command timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  public async request(
    kind: "configure" | "restore" | "step" | "snapshot" | "shutdown",
    payload: unknown,
    expectedKind:
      | "configured"
      | "restored"
      | "stepped"
      | "snapshot_result"
      | "shutdown_ack",
  ): Promise<GodotWireMessage> {
    const requestId = `request:${randomUUID()}`;
    const responsePromise = this.waitFor(
      (message) => message.requestId === requestId,
    );
    // A failed send closes the client and rejects this waiter before request()
    // can await it. Mark that rejection handled while preserving the original
    // promise for the normal response, timeout, and close paths below.
    void responsePromise.catch(() => undefined);
    await this.send(kind, payload, requestId);
    const response = await responsePromise;
    if (response.kind === "error") {
      throw new GodotAdapterError(
        response.payload.code === "CAPABILITY_UNSUPPORTED"
          ? "CAPABILITY_UNSUPPORTED"
          : "PROTOCOL_ERROR",
        `${response.payload.code}: ${response.payload.message}`,
      );
    }
    if (response.kind !== expectedKind) {
      const failure = new GodotAdapterError(
        "PROTOCOL_ERROR",
        `Expected ${expectedKind}, received ${response.kind}`,
      );
      this.fail(failure);
      throw failure;
    }
    return response;
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      await this.#transportClose;
      return;
    }
    this.#closed = true;
    this.detach();
    try {
      this.#decoder.end();
    } catch (error) {
      this.fail(this.asFailure(error, "Godot wire stream ended partially"));
    }
    await this.closeTransport();
    if (this.#failure === undefined) {
      this.fail(
        new GodotAdapterError("PROCESS_FAILED", "Godot wire client closed"),
      );
    }
  }

  private readonly onData = (chunk: Uint8Array): void => {
    try {
      for (const json of this.#decoder.push(chunk)) {
        const message = parseGodotWireMessage(json);
        if (message.protocolVersion !== this.protocolVersion) {
          throw new GodotAdapterError(
            "PROTOCOL_ERROR",
            `Expected protocol ${this.protocolVersion}, received ${message.protocolVersion}`,
          );
        }
        if (message.sequence !== this.#incomingSequence) {
          throw new GodotAdapterError(
            "PROTOCOL_ERROR",
            `Expected runtime sequence ${this.#incomingSequence}, received ${message.sequence}`,
          );
        }
        this.#incomingSequence += 1;
        this.deliver(message, Buffer.byteLength(json, "utf8") + 4);
      }
    } catch (error) {
      this.fail(this.asFailure(error, "Godot protocol decode failed"));
    }
  };

  private readonly onError = (error: Error): void => {
    this.fail(error);
  };

  private readonly onEnd = (): void => {
    try {
      this.#decoder.end();
    } catch (error) {
      this.fail(this.asFailure(error, "Godot wire stream ended partially"));
      return;
    }
    if (!this.#closed) {
      this.fail(
        new GodotAdapterError(
          "PROCESS_FAILED",
          "Godot runtime connection ended unexpectedly",
        ),
      );
    }
  };

  private readonly onClose = (): void => {
    if (!this.#closed && this.#failure === undefined) {
      this.fail(
        new GodotAdapterError(
          "PROCESS_FAILED",
          "Godot runtime connection closed unexpectedly",
        ),
      );
    }
  };

  private deliver(message: GodotWireMessage, encodedBytes: number): void {
    for (const waiter of this.#waiters) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(waiter);
        waiter.resolve(message);
        return;
      }
    }
    if (
      this.#queue.length >= this.#maxUnsolicitedMessages ||
      this.#queuedBytes + encodedBytes > this.#maxUnsolicitedBytes
    ) {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        "Godot runtime exceeded the bounded unsolicited-message queue count or byte limit",
      );
    }
    this.#queue.push({ message, encodedBytes });
    this.#queuedBytes += encodedBytes;
  }

  private fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#closed = true;
    this.detach();
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
    void this.closeTransport().catch(() => undefined);
  }

  private closeTransport(): Promise<void> {
    this.#transportClose ??= this.transport.close();
    return this.#transportClose;
  }

  private detach(): void {
    this.transport.readable.off("data", this.onData);
    this.transport.readable.off("error", this.onError);
    this.transport.readable.off("end", this.onEnd);
    this.transport.readable.off("close", this.onClose);
  }

  private assertOpen(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed) {
      throw new GodotAdapterError(
        "PROCESS_FAILED",
        "Godot wire client is closed",
      );
    }
  }

  private asFailure(error: unknown, fallback: string): Error {
    return error instanceof Error
      ? error
      : new GodotAdapterError("PROTOCOL_ERROR", fallback, { cause: error });
  }
}

export const createSocketGodotTransport = (
  socket: Socket,
): GodotByteTransport => ({
  readable: socket,
  write: (bytes) =>
    new Promise<void>((resolveWrite, rejectWrite) => {
      socket.write(bytes, (error) => {
        if (error === null || error === undefined) resolveWrite();
        else rejectWrite(error);
      });
    }),
  close: () =>
    new Promise<void>((resolveClose) => {
      if (socket.destroyed) {
        resolveClose();
        return;
      }
      socket.end(resolveClose);
    }),
});
