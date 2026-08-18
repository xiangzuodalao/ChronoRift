import { randomUUID } from "node:crypto";

import {
  PROJECT_ADAPTER_CAPABILITY_MODULES_V1,
  GodotProjectEnvironmentFingerprintV1Schema,
  GodotProjectEnvironmentRuntimeIdentityV1Schema,
  WireFrameDecoder,
  encodeWireFrame,
  makeGodotProjectEnvironmentWireMessageV1,
  parseGodotProjectEnvironmentWireMessageV1,
  type GodotProjectEnvironmentFingerprintV1,
  type GodotProjectEnvironmentRuntimeIdentityV1,
  type GodotProjectEnvironmentWireMessageKindV1,
  type GodotProjectEnvironmentWireMessageV1,
  type ProjectAdapterCapabilityModuleV1,
} from "@chronorift/godot-protocol";

import { GodotAdapterError } from "./errors.js";
import type { GodotByteTransport } from "./godot-wire-client.js";

type MessageOfKind<Kind extends GodotProjectEnvironmentWireMessageKindV1> =
  Extract<GodotProjectEnvironmentWireMessageV1, { readonly kind: Kind }>;
type PayloadOfKind<Kind extends GodotProjectEnvironmentWireMessageKindV1> =
  MessageOfKind<Kind>["payload"];

interface Waiter {
  readonly predicate: (
    message: GodotProjectEnvironmentWireMessageV1,
  ) => boolean;
  readonly resolve: (message: GodotProjectEnvironmentWireMessageV1) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface GodotProjectEnvironmentWireClientOptionsV1 {
  readonly commandTimeoutMs?: number | undefined;
  readonly maxUnsolicitedMessages?: number | undefined;
  readonly maxUnsolicitedBytes?: number | undefined;
}

export class GodotProjectEnvironmentWireClientV1 {
  readonly #decoder = new WireFrameDecoder();
  readonly #queue: {
    readonly message: GodotProjectEnvironmentWireMessageV1;
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
    options: GodotProjectEnvironmentWireClientOptionsV1 = {},
  ) {
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
    this.#maxUnsolicitedMessages = options.maxUnsolicitedMessages ?? 32;
    this.#maxUnsolicitedBytes = options.maxUnsolicitedBytes ?? 256 * 1_024;
    if (
      !Number.isInteger(this.#commandTimeoutMs) ||
      this.#commandTimeoutMs < 1 ||
      this.#commandTimeoutMs > 600_000 ||
      !Number.isInteger(this.#maxUnsolicitedMessages) ||
      this.#maxUnsolicitedMessages < 1 ||
      this.#maxUnsolicitedMessages > 1_024 ||
      !Number.isInteger(this.#maxUnsolicitedBytes) ||
      this.#maxUnsolicitedBytes < 1 ||
      this.#maxUnsolicitedBytes > 16 * 1_024 * 1_024
    ) {
      throw new TypeError("Project Environment wire client bounds are invalid");
    }
    transport.readable.on("data", this.onData);
    transport.readable.on("error", this.onError);
    transport.readable.on("end", this.onEnd);
    transport.readable.on("close", this.onClose);
  }

  public async send(
    kind: GodotProjectEnvironmentWireMessageKindV1,
    payload: unknown,
    requestId?: string,
  ): Promise<void> {
    this.assertOpen();
    const message = makeGodotProjectEnvironmentWireMessageV1({
      sequence: this.#outgoingSequence,
      kind,
      ...(requestId === undefined ? {} : { requestId }),
      payload,
    });
    this.#outgoingSequence += 1;
    try {
      await this.transport.write(encodeWireFrame(JSON.stringify(message)));
    } catch (error) {
      const failure = this.asFailure(
        error,
        "Project Environment wire write failed",
        "PROCESS_FAILED",
      );
      this.fail(failure);
      throw failure;
    }
  }

  public waitFor(
    predicate: (message: GodotProjectEnvironmentWireMessageV1) => boolean,
    timeoutMs = this.#commandTimeoutMs,
  ): Promise<GodotProjectEnvironmentWireMessageV1> {
    this.assertOpen();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
      throw new TypeError("Project Environment wait timeout is invalid");
    }
    const queuedIndex = this.#queue.findIndex(({ message }) =>
      predicate(message),
    );
    if (queuedIndex >= 0) {
      const [queued] = this.#queue.splice(queuedIndex, 1);
      if (queued === undefined)
        throw new Error("Project Environment queue changed");
      this.#queuedBytes -= queued.encodedBytes;
      return Promise.resolve(queued.message);
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
              "Timed out waiting for Project Environment wire message",
            ),
          );
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  public async request(
    kind: GodotProjectEnvironmentWireMessageKindV1,
    payload: unknown,
    expectedKind: GodotProjectEnvironmentWireMessageKindV1,
    timeoutMs = this.#commandTimeoutMs,
  ): Promise<GodotProjectEnvironmentWireMessageV1> {
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
        response.payload.code === "CAPABILITY_UNSUPPORTED"
          ? "CAPABILITY_UNSUPPORTED"
          : "PROTOCOL_ERROR",
        `${response.payload.code}: ${response.payload.message}`,
      );
    }
    if (response.kind !== expectedKind) {
      const failure = new GodotAdapterError(
        "PROTOCOL_ERROR",
        `Expected Project Environment ${expectedKind}, received ${response.kind}`,
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
        this.asFailure(error, "Project Environment wire ended partially"),
      );
    }
    await this.closeTransport();
    if (this.#failure === undefined) {
      this.fail(
        new GodotAdapterError(
          "PROCESS_FAILED",
          "Project Environment client closed",
        ),
      );
    }
  }

  private readonly onData = (chunk: Uint8Array): void => {
    try {
      for (const json of this.#decoder.push(chunk)) {
        const message = parseGodotProjectEnvironmentWireMessageV1(json);
        if (message.sequence !== this.#incomingSequence) {
          throw new GodotAdapterError(
            "PROTOCOL_ERROR",
            `Expected Project Environment sequence ${this.#incomingSequence}, received ${message.sequence}`,
          );
        }
        this.#incomingSequence += 1;
        this.deliver(message, Buffer.byteLength(json, "utf8") + 4);
      }
    } catch (error) {
      this.fail(
        this.asFailure(error, "Project Environment wire decode failed"),
      );
    }
  };

  private readonly onError = (error: Error): void =>
    this.fail(
      this.asFailure(
        error,
        "Project Environment transport failed",
        "PROCESS_FAILED",
      ),
    );

  private readonly onEnd = (): void => {
    try {
      this.#decoder.end();
    } catch (error) {
      this.fail(
        this.asFailure(error, "Project Environment wire ended partially"),
      );
      return;
    }
    if (!this.#closed) {
      this.fail(
        new GodotAdapterError(
          "PROCESS_FAILED",
          "Project Environment connection ended unexpectedly",
        ),
      );
    }
  };

  private readonly onClose = (): void => {
    if (!this.#closed && this.#failure === undefined) {
      this.fail(
        new GodotAdapterError(
          "PROCESS_FAILED",
          "Project Environment connection closed unexpectedly",
        ),
      );
    }
  };

  private deliver(
    message: GodotProjectEnvironmentWireMessageV1,
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
        "Project Environment unsolicited queue exceeded its bound",
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
        "Project Environment client is closed",
      );
    }
  }

  private asFailure(
    error: unknown,
    fallback: string,
    code: GodotAdapterError["code"] = "PROTOCOL_ERROR",
  ): GodotAdapterError {
    return error instanceof GodotAdapterError
      ? error
      : new GodotAdapterError(code, fallback, { cause: error });
  }
}

export interface GodotProjectEnvironmentConnectRequestV1 {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly expectedIdentity: GodotProjectEnvironmentRuntimeIdentityV1;
  readonly expectedEngineVersion: string;
  readonly expectedPlatform: string;
  readonly expectedMainScene: string;
  readonly expectedAdapterManifestSha256: string;
  readonly requiredModules: readonly ProjectAdapterCapabilityModuleV1[];
  readonly observationWindowBatches?: number | undefined;
  readonly handshakeTimeoutMs?: number | undefined;
}

export class GodotProjectEnvironmentRuntimeClientV1 {
  #closed = false;
  #nextObservationRecordSequence: number;

  public constructor(
    public readonly fingerprint: GodotProjectEnvironmentFingerprintV1,
    public readonly ready: PayloadOfKind<"ready">,
    private readonly peer: GodotProjectEnvironmentWireClientV1,
  ) {
    this.#nextObservationRecordSequence =
      ready.coverage.firstAvailableRecordSequence ??
      ready.nextObservationRecordSequence;
  }

  public async status(): Promise<PayloadOfKind<"status_result">> {
    this.assertOpen();
    const message = await this.peer.request("status", {}, "status_result");
    if (message.kind !== "status_result")
      throw new Error("Invalid status result");
    return message.payload;
  }

  public async nextObservationBatch(
    timeoutMs?: number,
  ): Promise<PayloadOfKind<"observation_batch">> {
    this.assertOpen();
    const message = await this.peer.waitFor(
      (candidate) => candidate.kind === "observation_batch",
      timeoutMs,
    );
    if (message.kind !== "observation_batch")
      throw new Error("Invalid observation batch");
    if (
      message.payload.firstRecordSequence !==
      this.#nextObservationRecordSequence
    ) {
      const failure = new GodotAdapterError(
        "PROTOCOL_ERROR",
        `Expected observation record ${this.#nextObservationRecordSequence}, received ${message.payload.firstRecordSequence}`,
      );
      await this.peer.close().catch(() => undefined);
      throw failure;
    }
    this.#nextObservationRecordSequence =
      message.payload.lastRecordSequence + 1;
    return message.payload;
  }

  public acknowledgeObservationBatch(
    batch: PayloadOfKind<"observation_batch">,
    nextWindowBatches = 1,
  ): Promise<void> {
    this.assertOpen();
    return this.peer.send("observation_ack", {
      batchId: batch.batchId,
      acceptedThroughRecordSequence: batch.lastRecordSequence,
      nextWindowBatches,
    });
  }

  public async query(
    request: PayloadOfKind<"query">,
  ): Promise<PayloadOfKind<"query_result">> {
    this.assertOpen();
    const message = await this.peer.request("query", request, "query_result");
    if (message.kind !== "query_result")
      throw new Error("Invalid query result");
    return message.payload;
  }

  public async configureCapture(
    request: PayloadOfKind<"capture_configure">,
  ): Promise<PayloadOfKind<"capture_configured">> {
    this.assertOpen();
    const message = await this.peer.request(
      "capture_configure",
      request,
      "capture_configured",
    );
    if (message.kind !== "capture_configured")
      throw new Error("Invalid capture result");
    return message.payload;
  }

  public async barrier(
    request: PayloadOfKind<"barrier">,
  ): Promise<PayloadOfKind<"barrier_reached">> {
    this.assertOpen();
    const message = await this.peer.request(
      "barrier",
      request,
      "barrier_reached",
    );
    if (message.kind !== "barrier_reached")
      throw new Error("Invalid barrier result");
    return message.payload;
  }

  public async input(
    request: PayloadOfKind<"input">,
  ): Promise<PayloadOfKind<"input_applied">> {
    this.assertOpen();
    const message = await this.peer.request("input", request, "input_applied");
    if (message.kind !== "input_applied") {
      throw new Error("Invalid input result");
    }
    return message.payload;
  }

  public async setControls(
    request: PayloadOfKind<"controls_set">,
  ): Promise<PayloadOfKind<"controls_set_result">> {
    this.assertOpen();
    const message = await this.peer.request(
      "controls_set",
      request,
      "controls_set_result",
    );
    if (message.kind !== "controls_set_result") {
      throw new Error("Invalid controls result");
    }
    return message.payload;
  }

  public async step(
    request: PayloadOfKind<"step">,
  ): Promise<PayloadOfKind<"stepped">> {
    this.assertOpen();
    const message = await this.peer.request("step", request, "stepped");
    if (message.kind !== "stepped") throw new Error("Invalid step result");
    return message.payload;
  }

  public async snapshot(
    request: PayloadOfKind<"snapshot_create">,
  ): Promise<PayloadOfKind<"snapshot_result">> {
    this.assertOpen();
    const message = await this.peer.request(
      "snapshot_create",
      request,
      "snapshot_result",
    );
    if (message.kind !== "snapshot_result") {
      throw new Error("Invalid snapshot result");
    }
    return message.payload;
  }

  public async restore(
    request: PayloadOfKind<"snapshot_restore">,
  ): Promise<PayloadOfKind<"snapshot_restored">> {
    this.assertOpen();
    const message = await this.peer.request(
      "snapshot_restore",
      request,
      "snapshot_restored",
    );
    if (message.kind !== "snapshot_restored") {
      throw new Error("Invalid restore result");
    }
    return message.payload;
  }

  public async shutdown(): Promise<PayloadOfKind<"shutdown_ack">> {
    this.assertOpen();
    this.#closed = true;
    try {
      const message = await this.peer.request("shutdown", {}, "shutdown_ack");
      if (message.kind !== "shutdown_ack")
        throw new Error("Invalid shutdown result");
      return message.payload;
    } finally {
      await this.peer.close();
    }
  }

  private assertOpen(): void {
    if (this.#closed)
      throw new Error("Project Environment runtime client is closed");
  }
}

const sameIdentity = (
  left: GodotProjectEnvironmentRuntimeIdentityV1,
  right: GodotProjectEnvironmentRuntimeIdentityV1,
): boolean => JSON.stringify(left) === JSON.stringify(right);

export const connectGodotProjectEnvironmentRuntimeV1 = async (
  transport: GodotByteTransport,
  request: GodotProjectEnvironmentConnectRequestV1,
): Promise<GodotProjectEnvironmentRuntimeClientV1> => {
  if (!/^[a-f0-9]{64}$/u.test(request.token)) {
    throw new GodotAdapterError(
      "PROTOCOL_ERROR",
      "Invalid Project Environment token",
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(request.expectedAdapterManifestSha256)) {
    throw new GodotAdapterError(
      "PROTOCOL_ERROR",
      "Invalid expected adapter manifest identity",
    );
  }
  const expectedIdentity = GodotProjectEnvironmentRuntimeIdentityV1Schema.parse(
    request.expectedIdentity,
  );
  if (
    request.requiredModules.length === 0 ||
    new Set(request.requiredModules).size !== request.requiredModules.length ||
    request.requiredModules.some(
      (module) => !PROJECT_ADAPTER_CAPABILITY_MODULES_V1.includes(module),
    )
  ) {
    throw new TypeError("Required Project Environment modules are invalid");
  }
  const observationWindowBatches = request.observationWindowBatches ?? 4;
  if (
    !Number.isInteger(observationWindowBatches) ||
    observationWindowBatches < 1 ||
    observationWindowBatches > 32
  ) {
    throw new TypeError("Project Environment observation window is invalid");
  }
  const peer = new GodotProjectEnvironmentWireClientV1(transport);
  try {
    const hello = await peer.waitFor(
      (message) => message.kind === "hello",
      request.handshakeTimeoutMs ?? 30_000,
    );
    if (hello.kind !== "hello" || hello.payload.token !== request.token) {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        "Project Environment authentication failed",
      );
    }
    const fingerprint = GodotProjectEnvironmentFingerprintV1Schema.parse(
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
      ...(fingerprint.configuredMainScene === request.expectedMainScene
        ? []
        : ["configuredMainScene"]),
      ...(fingerprint.identity.adapterManifestSha256 ===
      request.expectedAdapterManifestSha256
        ? []
        : ["adapterManifestSha256"]),
    ];
    for (const module of request.requiredModules) {
      const declaration = fingerprint.modules.modules.find(
        (candidate) => candidate.module === module,
      );
      if (declaration?.status !== "implemented") {
        mismatches.push(`module:${module}`);
      }
    }
    if (mismatches.length > 0) {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        `Project Environment fingerprint mismatch: ${mismatches.join(", ")}`,
      );
    }
    const ready = await peer.request(
      "hello_accept",
      {
        adapterManifestSha256: request.expectedAdapterManifestSha256,
        requiredModules: [...request.requiredModules],
        observationWindowBatches,
      },
      "ready",
      request.handshakeTimeoutMs ?? 30_000,
    );
    if (ready.kind !== "ready")
      throw new Error("Project Environment runtime not ready");
    if (
      !ready.payload.running ||
      ready.payload.currentScene === null ||
      ready.payload.configuredMainScene !== fingerprint.configuredMainScene ||
      (expectedIdentity.instrumentationMode === "instrumented" &&
        (ready.payload.coverage.status !== "complete" ||
          ready.payload.coverage.semanticCoverage !== "declared" ||
          ready.payload.coverage.droppedRecordCount !== 0 ||
          ready.payload.coverage.overwriteCount !== 0))
    ) {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        "Project Environment runtime returned an invalid readiness sample",
      );
    }
    return new GodotProjectEnvironmentRuntimeClientV1(
      fingerprint,
      ready.payload,
      peer,
    );
  } catch (error) {
    await peer.close().catch(() => undefined);
    throw error;
  }
};
