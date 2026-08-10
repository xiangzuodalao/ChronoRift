import { randomUUID } from "node:crypto";

import type { JsonValue } from "@chronorift/domain";
import {
  GODOT_LIFECYCLE_CAPABILITIES_V1,
  GODOT_LIFECYCLE_READY_PHYSICS_TICK_DELTA_V1,
  GODOT_LIFECYCLE_READY_PROCESS_FRAME_DELTA_V1,
  GodotLifecycleFingerprintV1Schema,
  GodotLifecycleRuntimeIdentityV1Schema,
  GodotLifecycleStatusSampleV1Schema,
  WireFrameDecoder,
  encodeWireFrame,
  makeGodotLifecycleWireMessage,
  parseGodotLifecycleWireMessage,
  type GodotLifecycleFingerprintV1,
  type GodotLifecycleRuntimeIdentityV1,
  type GodotLifecycleStatusSampleV1,
  type GodotLifecycleWireMessage,
  type GodotLifecycleWireMessageKind,
} from "@chronorift/godot-protocol";

import { GodotAdapterError } from "./errors.js";
import type { GodotByteTransport } from "./godot-wire-client.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_UNSOLICITED_MESSAGES = 16;
const DEFAULT_MAX_UNSOLICITED_BYTES = 128 * 1024;

interface Waiter {
  readonly predicate: (message: GodotLifecycleWireMessage) => boolean;
  readonly resolve: (message: GodotLifecycleWireMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface GodotLifecycleWireClientOptions {
  readonly commandTimeoutMs?: number | undefined;
  readonly maxUnsolicitedMessages?: number | undefined;
  readonly maxUnsolicitedBytes?: number | undefined;
}

/**
 * A lifecycle-profile peer. It deliberately does not accept the M3 message
 * union, so step/configure/snapshot/restore cannot leak into this profile.
 */
export class GodotLifecycleWireClient {
  readonly #decoder = new WireFrameDecoder();
  readonly #queue: {
    readonly message: GodotLifecycleWireMessage;
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
    options: GodotLifecycleWireClientOptions = {},
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
      throw new TypeError(
        "Godot lifecycle wire client bounds must be positive integers",
      );
    }

    transport.readable.on("data", this.onData);
    transport.readable.on("error", this.onError);
    transport.readable.on("end", this.onEnd);
    transport.readable.on("close", this.onClose);
  }

  public async send(
    kind: GodotLifecycleWireMessageKind,
    payload: unknown,
    requestId?: string,
  ): Promise<void> {
    this.assertOpen();
    const message = makeGodotLifecycleWireMessage({
      sequence: this.#outgoingSequence,
      kind,
      ...(requestId === undefined ? {} : { requestId }),
      payload: payload as JsonValue,
    });
    this.#outgoingSequence += 1;
    try {
      await this.transport.write(encodeWireFrame(JSON.stringify(message)));
    } catch (error) {
      const failure = this.asFailure(
        error,
        "Godot lifecycle wire write failed",
      );
      this.fail(failure);
      throw failure;
    }
  }

  public waitFor(
    predicate: (message: GodotLifecycleWireMessage) => boolean,
    timeoutMs = this.#commandTimeoutMs,
  ): Promise<GodotLifecycleWireMessage> {
    this.assertOpen();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
      throw new TypeError(
        "Godot lifecycle wait timeout must be between 1 and 600000 ms",
      );
    }
    const queuedIndex = this.#queue.findIndex(({ message }) =>
      predicate(message),
    );
    if (queuedIndex >= 0) {
      const [queued] = this.#queue.splice(queuedIndex, 1);
      if (queued === undefined) {
        throw new GodotAdapterError(
          "PROTOCOL_ERROR",
          "Lifecycle wire queue changed unexpectedly",
        );
      }
      this.#queuedBytes -= queued.encodedBytes;
      return Promise.resolve(queued.message);
    }
    return new Promise<GodotLifecycleWireMessage>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(
            new GodotAdapterError(
              "COMMAND_TIMEOUT",
              "Timed out waiting for Godot lifecycle wire message",
            ),
          );
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  public async request(
    kind: GodotLifecycleWireMessageKind,
    payload: unknown,
    expectedKind: GodotLifecycleWireMessageKind,
    timeoutMs = this.#commandTimeoutMs,
  ): Promise<GodotLifecycleWireMessage> {
    const requestId = `request:${randomUUID()}`;
    const responsePromise = this.waitFor(
      (message) => message.requestId === requestId,
      timeoutMs,
    );
    void responsePromise.catch(() => undefined);
    await this.send(kind, payload, requestId);
    const response = await responsePromise;
    if (response.kind === "error") {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        `${response.payload.code}: ${response.payload.message}`,
      );
    }
    if (response.kind !== expectedKind) {
      const failure = new GodotAdapterError(
        "PROTOCOL_ERROR",
        `Expected lifecycle ${expectedKind}, received ${response.kind}`,
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
      this.fail(
        this.asFailure(error, "Godot lifecycle wire stream ended partially"),
      );
    }
    await this.closeTransport();
    if (this.#failure === undefined) {
      this.fail(
        new GodotAdapterError(
          "PROCESS_FAILED",
          "Godot lifecycle wire client closed",
        ),
      );
    }
  }

  private readonly onData = (chunk: Uint8Array): void => {
    try {
      for (const json of this.#decoder.push(chunk)) {
        const message = parseGodotLifecycleWireMessage(json);
        if (message.sequence !== this.#incomingSequence) {
          throw new GodotAdapterError(
            "PROTOCOL_ERROR",
            `Expected lifecycle runtime sequence ${this.#incomingSequence}, received ${message.sequence}`,
          );
        }
        this.#incomingSequence += 1;
        this.deliver(message, Buffer.byteLength(json, "utf8") + 4);
      }
    } catch (error) {
      this.fail(
        this.asFailure(error, "Godot lifecycle protocol decode failed"),
      );
    }
  };

  private readonly onError = (error: Error): void => {
    this.fail(error);
  };

  private readonly onEnd = (): void => {
    try {
      this.#decoder.end();
    } catch (error) {
      this.fail(
        this.asFailure(error, "Godot lifecycle wire stream ended partially"),
      );
      return;
    }
    if (!this.#closed) {
      this.fail(
        new GodotAdapterError(
          "PROCESS_FAILED",
          "Godot lifecycle runtime connection ended unexpectedly",
        ),
      );
    }
  };

  private readonly onClose = (): void => {
    if (!this.#closed && this.#failure === undefined) {
      this.fail(
        new GodotAdapterError(
          "PROCESS_FAILED",
          "Godot lifecycle runtime connection closed unexpectedly",
        ),
      );
    }
  };

  private deliver(
    message: GodotLifecycleWireMessage,
    encodedBytes: number,
  ): void {
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
        "Godot lifecycle runtime exceeded the bounded unsolicited-message queue",
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
        "Godot lifecycle wire client is closed",
      );
    }
  }

  private asFailure(error: unknown, fallback: string): Error {
    return error instanceof Error
      ? error
      : new GodotAdapterError("PROTOCOL_ERROR", fallback, { cause: error });
  }
}

export interface GodotLifecycleConnectRequestV1 {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly expectedIdentity: GodotLifecycleRuntimeIdentityV1;
  readonly expectedEngineVersion: string;
  readonly expectedPlatform: string;
  readonly expectedRenderer: string;
  readonly expectedDisplayServer: string;
  readonly expectedAudioDriver: string;
  readonly expectedMainScene: string;
  readonly handshakeTimeoutMs?: number | undefined;
}

export interface GodotLifecycleStatusReceiptV1 {
  readonly sample: GodotLifecycleStatusSampleV1;
  readonly hostMonotonicStartUs: number;
  readonly hostMonotonicEndUs: number;
}

export interface GodotLifecycleReadyReceiptV1 {
  readonly baseline: GodotLifecycleStatusSampleV1;
  readonly observed: GodotLifecycleStatusSampleV1;
  readonly hostMonotonicStartUs: number;
  readonly hostMonotonicEndUs: number;
}

export class GodotLifecycleRuntimeClient {
  #closed = false;

  public constructor(
    public readonly fingerprint: GodotLifecycleFingerprintV1,
    public readonly ready: GodotLifecycleReadyReceiptV1,
    private readonly peer: GodotLifecycleWireClient,
  ) {}

  public async status(): Promise<GodotLifecycleStatusReceiptV1> {
    this.assertOpen();
    const hostMonotonicStartUs = Math.floor(performance.now() * 1_000);
    const response = await this.peer.request("status", {}, "status_result");
    const hostMonotonicEndUs = Math.floor(performance.now() * 1_000);
    if (response.kind !== "status_result") {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        "Invalid lifecycle status response",
      );
    }
    return {
      sample: GodotLifecycleStatusSampleV1Schema.parse(response.payload),
      hostMonotonicStartUs,
      hostMonotonicEndUs,
    };
  }

  public async shutdown(): Promise<GodotLifecycleStatusReceiptV1> {
    if (this.#closed) {
      throw new GodotAdapterError(
        "PROCESS_FAILED",
        "Godot lifecycle runtime client is closed",
      );
    }
    this.#closed = true;
    const hostMonotonicStartUs = Math.floor(performance.now() * 1_000);
    try {
      const response = await this.peer.request("shutdown", {}, "shutdown_ack");
      const hostMonotonicEndUs = Math.floor(performance.now() * 1_000);
      if (response.kind !== "shutdown_ack") {
        throw new GodotAdapterError(
          "PROTOCOL_ERROR",
          "Invalid lifecycle shutdown response",
        );
      }
      return {
        sample: GodotLifecycleStatusSampleV1Schema.parse(
          response.payload.status,
        ),
        hostMonotonicStartUs,
        hostMonotonicEndUs,
      };
    } finally {
      await this.peer.close();
    }
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new GodotAdapterError(
        "PROCESS_FAILED",
        "Godot lifecycle runtime client is closed",
      );
    }
  }
}

const identityEquals = (
  left: GodotLifecycleRuntimeIdentityV1,
  right: GodotLifecycleRuntimeIdentityV1,
): boolean => JSON.stringify(left) === JSON.stringify(right);

export const connectGodotLifecycleRuntime = async (
  transport: GodotByteTransport,
  request: GodotLifecycleConnectRequestV1,
): Promise<GodotLifecycleRuntimeClient> => {
  if (!/^[a-f0-9]{64}$/u.test(request.token)) {
    throw new GodotAdapterError(
      "PROTOCOL_ERROR",
      "Invalid Godot lifecycle runtime token",
    );
  }
  const expectedIdentity = GodotLifecycleRuntimeIdentityV1Schema.parse(
    request.expectedIdentity,
  );
  const validFingerprintText = (value: string): boolean =>
    value.length >= 1 &&
    value.length <= 128 &&
    !value.includes("\0") &&
    !value.includes("\r") &&
    !value.includes("\n");
  if (
    typeof request.expectedEngineVersion !== "string" ||
    !validFingerprintText(request.expectedEngineVersion) ||
    typeof request.expectedPlatform !== "string" ||
    !validFingerprintText(request.expectedPlatform) ||
    typeof request.expectedRenderer !== "string" ||
    !validFingerprintText(request.expectedRenderer) ||
    typeof request.expectedDisplayServer !== "string" ||
    !validFingerprintText(request.expectedDisplayServer) ||
    typeof request.expectedAudioDriver !== "string" ||
    !validFingerprintText(request.expectedAudioDriver) ||
    typeof request.expectedMainScene !== "string" ||
    (!request.expectedMainScene.startsWith("res://") &&
      !request.expectedMainScene.startsWith("uid://"))
  ) {
    throw new GodotAdapterError(
      "PROTOCOL_ERROR",
      "Invalid expected Godot lifecycle fingerprint",
    );
  }

  const peer = new GodotLifecycleWireClient(transport);
  try {
    const hello = await peer.waitFor(
      (message) => message.kind === "hello",
      request.handshakeTimeoutMs ?? 30_000,
    );
    if (hello.kind !== "hello" || hello.payload.token !== request.token) {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        "Godot lifecycle runtime authentication failed",
      );
    }
    const fingerprint = GodotLifecycleFingerprintV1Schema.parse(
      hello.payload.fingerprint,
    );
    const mismatches = [
      ...(identityEquals(fingerprint.identity, expectedIdentity)
        ? []
        : ["identity"]),
      ...(fingerprint.engineVersion === request.expectedEngineVersion
        ? []
        : ["engineVersion"]),
      ...(fingerprint.platform === request.expectedPlatform
        ? []
        : ["platform"]),
      ...(fingerprint.renderer === request.expectedRenderer
        ? []
        : ["renderer"]),
      ...(fingerprint.displayServer === request.expectedDisplayServer
        ? []
        : ["displayServer"]),
      ...(fingerprint.audioDriver === request.expectedAudioDriver
        ? []
        : ["audioDriver"]),
      ...(fingerprint.configuredMainScene === request.expectedMainScene
        ? []
        : ["configuredMainScene"]),
    ];
    if (mismatches.length > 0) {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        `Godot lifecycle runtime fingerprint mismatch: ${mismatches.join(", ")}${
          mismatches.includes("engineVersion")
            ? ` (received ${fingerprint.engineVersion})`
            : ""
        }`,
      );
    }
    const readyStartUs = Math.floor(performance.now() * 1_000);
    const ready = await peer.request(
      "hello_accept",
      {
        requiredCapabilities: [...GODOT_LIFECYCLE_CAPABILITIES_V1],
        minimumProcessFrameDelta: GODOT_LIFECYCLE_READY_PROCESS_FRAME_DELTA_V1,
        minimumPhysicsTickDelta: GODOT_LIFECYCLE_READY_PHYSICS_TICK_DELTA_V1,
      },
      "ready",
      request.handshakeTimeoutMs ?? 30_000,
    );
    const readyEndUs = Math.floor(performance.now() * 1_000);
    if (ready.kind !== "ready") {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        "Godot lifecycle runtime did not become ready",
      );
    }
    return new GodotLifecycleRuntimeClient(
      fingerprint,
      {
        baseline: GodotLifecycleStatusSampleV1Schema.parse(
          ready.payload.baseline,
        ),
        observed: GodotLifecycleStatusSampleV1Schema.parse(
          ready.payload.observed,
        ),
        hostMonotonicStartUs: readyStartUs,
        hostMonotonicEndUs: readyEndUs,
      },
      peer,
    );
  } catch (error) {
    await peer.close().catch(() => undefined);
    throw error;
  }
};
