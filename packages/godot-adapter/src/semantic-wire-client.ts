import { randomUUID } from "node:crypto";

import {
  GodotSemanticAdapterProfileV1Schema,
  type GodotSemanticAdapterProfileV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import {
  GODOT_SEMANTIC_CAPABILITIES_V1,
  GodotSemanticFingerprintV1Schema,
  GodotSemanticRuntimeIdentityV1Schema,
  GodotSemanticStatusSampleV1Schema,
  WireFrameDecoder,
  encodeWireFrame,
  makeGodotSemanticWireMessage,
  parseGodotSemanticWireMessage,
  type GodotSemanticFingerprintV1,
  type GodotSemanticRuntimeIdentityV1,
  type GodotSemanticStatusSampleV1,
  type GodotSemanticWireMessage,
  type GodotSemanticWireMessageKind,
} from "@chronorift/godot-protocol";

import { GodotAdapterError } from "./errors.js";
import type { GodotByteTransport } from "./godot-wire-client.js";

interface Waiter {
  readonly predicate: (message: GodotSemanticWireMessage) => boolean;
  readonly resolve: (message: GodotSemanticWireMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface GodotSemanticWireClientOptions {
  readonly commandTimeoutMs?: number | undefined;
  readonly maxUnsolicitedMessages?: number | undefined;
  readonly maxUnsolicitedBytes?: number | undefined;
}

export class GodotSemanticWireClient {
  readonly #decoder = new WireFrameDecoder();
  readonly #queue: {
    readonly message: GodotSemanticWireMessage;
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
    options: GodotSemanticWireClientOptions = {},
  ) {
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
    this.#maxUnsolicitedMessages = options.maxUnsolicitedMessages ?? 16;
    this.#maxUnsolicitedBytes = options.maxUnsolicitedBytes ?? 128 * 1024;
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
      throw new TypeError("Godot semantic wire bounds are invalid");
    }
    transport.readable.on("data", this.onData);
    transport.readable.on("error", this.onError);
    transport.readable.on("end", this.onEnd);
    transport.readable.on("close", this.onClose);
  }

  public async send(
    kind: GodotSemanticWireMessageKind,
    payload: unknown,
    requestId?: string,
  ): Promise<void> {
    this.assertOpen();
    const message = makeGodotSemanticWireMessage({
      sequence: this.#outgoingSequence,
      kind,
      ...(requestId === undefined ? {} : { requestId }),
      payload: payload as JsonValue,
    });
    this.#outgoingSequence += 1;
    try {
      await this.transport.write(encodeWireFrame(JSON.stringify(message)));
    } catch (error) {
      const failure = this.asFailure(error, "Godot semantic wire write failed");
      this.fail(failure);
      throw failure;
    }
  }

  public waitFor(
    predicate: (message: GodotSemanticWireMessage) => boolean,
    timeoutMs = this.#commandTimeoutMs,
  ): Promise<GodotSemanticWireMessage> {
    this.assertOpen();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
      throw new TypeError("Godot semantic wait timeout is invalid");
    }
    const queuedIndex = this.#queue.findIndex(({ message }) =>
      predicate(message),
    );
    if (queuedIndex >= 0) {
      const [queued] = this.#queue.splice(queuedIndex, 1);
      if (queued === undefined) throw new Error("Semantic queue changed");
      this.#queuedBytes -= queued.encodedBytes;
      return Promise.resolve(queued.message);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(
            new GodotAdapterError(
              "COMMAND_TIMEOUT",
              "Timed out waiting for Godot semantic wire message",
            ),
          );
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  public async request(
    kind: GodotSemanticWireMessageKind,
    payload: unknown,
    expectedKind: GodotSemanticWireMessageKind,
    timeoutMs = this.#commandTimeoutMs,
  ): Promise<GodotSemanticWireMessage> {
    const requestId = `request:${randomUUID()}`;
    const pending = this.waitFor(
      (message) => message.requestId === requestId,
      timeoutMs,
    );
    void pending.catch(() => undefined);
    await this.send(kind, payload, requestId);
    const response = await pending;
    if (response.kind === "error") {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        `${response.payload.code}: ${response.payload.message}`,
      );
    }
    if (response.kind !== expectedKind) {
      const failure = new GodotAdapterError(
        "PROTOCOL_ERROR",
        `Expected semantic ${expectedKind}, received ${response.kind}`,
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
      this.fail(this.asFailure(error, "Semantic wire stream ended partially"));
    }
    await this.closeTransport();
    if (this.#failure === undefined) {
      this.fail(
        new GodotAdapterError("PROCESS_FAILED", "Semantic client closed"),
      );
    }
  }

  private readonly onData = (chunk: Uint8Array): void => {
    try {
      for (const json of this.#decoder.push(chunk)) {
        const message = parseGodotSemanticWireMessage(json);
        if (message.sequence !== this.#incomingSequence) {
          throw new GodotAdapterError(
            "PROTOCOL_ERROR",
            `Expected semantic sequence ${this.#incomingSequence}, received ${message.sequence}`,
          );
        }
        this.#incomingSequence += 1;
        this.deliver(message, Buffer.byteLength(json, "utf8") + 4);
      }
    } catch (error) {
      this.fail(this.asFailure(error, "Godot semantic decode failed"));
    }
  };

  private readonly onError = (error: Error): void => this.fail(error);
  private readonly onEnd = (): void => {
    try {
      this.#decoder.end();
    } catch (error) {
      this.fail(this.asFailure(error, "Semantic wire stream ended partially"));
      return;
    }
    if (!this.#closed) {
      this.fail(
        new GodotAdapterError(
          "PROCESS_FAILED",
          "Godot semantic connection ended unexpectedly",
        ),
      );
    }
  };
  private readonly onClose = (): void => {
    if (!this.#closed && this.#failure === undefined) {
      this.fail(
        new GodotAdapterError(
          "PROCESS_FAILED",
          "Godot semantic connection closed unexpectedly",
        ),
      );
    }
  };

  private deliver(
    message: GodotSemanticWireMessage,
    encodedBytes: number,
  ): void {
    for (const waiter of this.#waiters) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve(message);
      return;
    }
    if (
      this.#queue.length >= this.#maxUnsolicitedMessages ||
      this.#queuedBytes + encodedBytes > this.#maxUnsolicitedBytes
    ) {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        "Godot semantic unsolicited queue exceeded its bound",
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
        "Semantic client is closed",
      );
    }
  }

  private asFailure(error: unknown, fallback: string): Error {
    return error instanceof Error
      ? error
      : new GodotAdapterError("PROTOCOL_ERROR", fallback, { cause: error });
  }
}

export interface GodotSemanticConnectRequestV1 {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly expectedIdentity: GodotSemanticRuntimeIdentityV1;
  readonly expectedEngineVersion: string;
  readonly expectedPlatform: string;
  readonly expectedRenderer: string;
  readonly expectedDisplayServer: string;
  readonly expectedAudioDriver: string;
  readonly expectedMainScene: string;
  readonly adapterProfile: GodotSemanticAdapterProfileV1;
  readonly adapterProfileSha256: Sha256DigestV1;
  readonly handshakeTimeoutMs?: number | undefined;
}

export interface GodotSemanticObservationReceiptV1 {
  readonly sample: GodotSemanticStatusSampleV1;
  readonly hostMonotonicStartUs: number;
  readonly hostMonotonicEndUs: number;
}

export class GodotSemanticRuntimeClient {
  #closed = false;

  public constructor(
    public readonly fingerprint: GodotSemanticFingerprintV1,
    public readonly ready: GodotSemanticObservationReceiptV1,
    private readonly peer: GodotSemanticWireClient,
  ) {}

  public status(): Promise<GodotSemanticObservationReceiptV1> {
    return this.observe("status", {}, "status_result", (message) => {
      if (message.kind !== "status_result") throw new Error("Invalid status");
      return GodotSemanticStatusSampleV1Schema.parse(message.payload);
    });
  }

  public checkpoint(): Promise<GodotSemanticObservationReceiptV1> {
    return this.observe(
      "checkpoint_create",
      { barrier: "adapter_process_tail" },
      "checkpoint_result",
      (message) => {
        if (message.kind !== "checkpoint_result") {
          throw new Error("Invalid checkpoint result");
        }
        const projection = message.payload.projection;
        return GodotSemanticStatusSampleV1Schema.parse({
          processFrames: projection.capturedAt.processFrame,
          physicsFrames: projection.capturedAt.physicsTick,
          processTimeUs: projection.capturedAt.simulationTimeUs,
          physicsTimeUs: projection.capturedAt.simulationTimeUs,
          configuredMainScene: this.fingerprint.configuredMainScene,
          currentScene: this.ready.sample.currentScene,
          projection,
        });
      },
    );
  }

  public restore(
    projection: GodotSemanticStatusSampleV1["projection"],
  ): Promise<
    GodotSemanticObservationReceiptV1 & {
      readonly limitations: readonly string[];
    }
  > {
    this.assertOpen();
    const start = Math.floor(performance.now() * 1_000);
    return this.peer
      .request("checkpoint_restore", { projection }, "checkpoint_restored")
      .then((message) => {
        const end = Math.floor(performance.now() * 1_000);
        if (message.kind !== "checkpoint_restored") {
          throw new Error("Invalid restore result");
        }
        const restored = message.payload.projection;
        return {
          sample: GodotSemanticStatusSampleV1Schema.parse({
            processFrames: restored.capturedAt.processFrame,
            physicsFrames: restored.capturedAt.physicsTick,
            processTimeUs: restored.capturedAt.simulationTimeUs,
            physicsTimeUs: restored.capturedAt.simulationTimeUs,
            configuredMainScene: this.fingerprint.configuredMainScene,
            currentScene: this.ready.sample.currentScene,
            projection: restored,
          }),
          hostMonotonicStartUs: start,
          hostMonotonicEndUs: end,
          limitations: Object.freeze([...message.payload.limitations]),
        };
      });
  }

  public async shutdown(): Promise<GodotSemanticObservationReceiptV1> {
    if (this.#closed) throw new Error("Semantic client is closed");
    this.#closed = true;
    const start = Math.floor(performance.now() * 1_000);
    try {
      const message = await this.peer.request("shutdown", {}, "shutdown_ack");
      const end = Math.floor(performance.now() * 1_000);
      if (message.kind !== "shutdown_ack") throw new Error("Invalid shutdown");
      return {
        sample: GodotSemanticStatusSampleV1Schema.parse(message.payload.status),
        hostMonotonicStartUs: start,
        hostMonotonicEndUs: end,
      };
    } finally {
      await this.peer.close();
    }
  }

  private async observe(
    kind: GodotSemanticWireMessageKind,
    payload: unknown,
    expectedKind: GodotSemanticWireMessageKind,
    project: (message: GodotSemanticWireMessage) => GodotSemanticStatusSampleV1,
  ): Promise<GodotSemanticObservationReceiptV1> {
    this.assertOpen();
    const start = Math.floor(performance.now() * 1_000);
    const message = await this.peer.request(kind, payload, expectedKind);
    const end = Math.floor(performance.now() * 1_000);
    return {
      sample: project(message),
      hostMonotonicStartUs: start,
      hostMonotonicEndUs: end,
    };
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("Semantic client is closed");
  }
}

const sameIdentity = (
  left: GodotSemanticRuntimeIdentityV1,
  right: GodotSemanticRuntimeIdentityV1,
): boolean => JSON.stringify(left) === JSON.stringify(right);

export const connectGodotSemanticRuntime = async (
  transport: GodotByteTransport,
  request: GodotSemanticConnectRequestV1,
): Promise<GodotSemanticRuntimeClient> => {
  if (!/^[a-f0-9]{64}$/u.test(request.token)) {
    throw new GodotAdapterError("PROTOCOL_ERROR", "Invalid semantic token");
  }
  const expectedIdentity = GodotSemanticRuntimeIdentityV1Schema.parse(
    request.expectedIdentity,
  );
  const adapterProfile = GodotSemanticAdapterProfileV1Schema.parse(
    request.adapterProfile,
  );
  const peer = new GodotSemanticWireClient(transport);
  try {
    const hello = await peer.waitFor(
      (message) => message.kind === "hello",
      request.handshakeTimeoutMs ?? 30_000,
    );
    if (hello.kind !== "hello" || hello.payload.token !== request.token) {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        "Godot semantic authentication failed",
      );
    }
    const fingerprint = GodotSemanticFingerprintV1Schema.parse(
      hello.payload.fingerprint,
    );
    const mismatches = [
      ...(sameIdentity(fingerprint.identity, expectedIdentity)
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
        `Godot semantic fingerprint mismatch: ${mismatches.join(", ")}`,
      );
    }
    const start = Math.floor(performance.now() * 1_000);
    const ready = await peer.request(
      "hello_accept",
      {
        requiredCapabilities: [...GODOT_SEMANTIC_CAPABILITIES_V1],
        adapterProfile,
        adapterProfileSha256: request.adapterProfileSha256,
      },
      "ready",
      request.handshakeTimeoutMs ?? 30_000,
    );
    const end = Math.floor(performance.now() * 1_000);
    if (ready.kind !== "ready") throw new Error("Semantic runtime not ready");
    return new GodotSemanticRuntimeClient(
      fingerprint,
      {
        sample: GodotSemanticStatusSampleV1Schema.parse(ready.payload),
        hostMonotonicStartUs: start,
        hostMonotonicEndUs: end,
      },
      peer,
    );
  } catch (error) {
    await peer.close().catch(() => undefined);
    throw error;
  }
};
