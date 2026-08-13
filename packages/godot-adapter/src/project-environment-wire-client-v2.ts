import { randomUUID } from "node:crypto";

import {
  GodotProjectEnvironmentFingerprintV2Schema,
  GodotProjectEnvironmentRuntimeIdentityV2Schema,
  WireFrameDecoder,
  encodeWireFrame,
  makeGodotProjectEnvironmentWireMessageV2,
  parseGodotProjectEnvironmentWireMessageV2,
  type GodotProjectEnvironmentFingerprintV2,
  type GodotProjectEnvironmentRuntimeIdentityV2,
  type GodotProjectEnvironmentWireMessageKindV2,
  type GodotProjectEnvironmentWireMessageV2,
} from "@chronorift/godot-protocol";

import { GodotAdapterError } from "./errors.js";
import type { GodotByteTransport } from "./godot-wire-client.js";

type MessageOf<Kind extends GodotProjectEnvironmentWireMessageKindV2> = Extract<
  GodotProjectEnvironmentWireMessageV2,
  { readonly kind: Kind }
>;
type PayloadOf<Kind extends GodotProjectEnvironmentWireMessageKindV2> =
  MessageOf<Kind>["payload"];
interface WaiterV2 {
  readonly predicate: (
    message: GodotProjectEnvironmentWireMessageV2,
  ) => boolean;
  readonly resolve: (message: GodotProjectEnvironmentWireMessageV2) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class GodotProjectEnvironmentWireClientV2 {
  readonly #decoder = new WireFrameDecoder();
  readonly #queue: GodotProjectEnvironmentWireMessageV2[] = [];
  readonly #waiters = new Set<WaiterV2>();
  #incoming = 0;
  #outgoing = 0;
  #failure: Error | undefined;
  #closed = false;

  public constructor(private readonly transport: GodotByteTransport) {
    transport.readable.on("data", this.onData);
    transport.readable.on("error", this.onError);
    transport.readable.on("end", this.onEnd);
  }

  public async send(
    kind: GodotProjectEnvironmentWireMessageKindV2,
    payload: unknown,
    requestId?: string,
  ): Promise<void> {
    this.assertOpen();
    const message = makeGodotProjectEnvironmentWireMessageV2({
      sequence: this.#outgoing,
      kind,
      ...(requestId === undefined ? {} : { requestId }),
      payload,
    });
    this.#outgoing += 1;
    await this.transport.write(encodeWireFrame(JSON.stringify(message)));
  }

  public waitFor(
    predicate: (message: GodotProjectEnvironmentWireMessageV2) => boolean,
    timeoutMs = 30_000,
  ): Promise<GodotProjectEnvironmentWireMessageV2> {
    this.assertOpen();
    const index = this.#queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.#queue.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter: WaiterV2 = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(
            new GodotAdapterError(
              "COMMAND_TIMEOUT",
              "Timed out waiting for Project Environment V2 message",
            ),
          );
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  public async request(
    kind: GodotProjectEnvironmentWireMessageKindV2,
    payload: unknown,
    expected: GodotProjectEnvironmentWireMessageKindV2,
    timeoutMs = 30_000,
  ): Promise<GodotProjectEnvironmentWireMessageV2> {
    const requestId = `request.v2.${randomUUID()}`;
    const pending = this.waitFor(
      (message) => message.requestId === requestId,
      timeoutMs,
    );
    void pending.catch(() => undefined);
    await this.send(kind, payload, requestId);
    const response = await pending;
    if (response.kind === "error")
      throw new GodotAdapterError(
        response.payload.code === "CAPABILITY_UNSUPPORTED"
          ? "CAPABILITY_UNSUPPORTED"
          : "PROTOCOL_ERROR",
        `${response.payload.code}: ${response.payload.message}`,
      );
    if (response.kind !== expected)
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        `Expected V2 ${expected}, received ${response.kind}`,
      );
    return response;
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.detach();
    await this.transport.close();
    this.fail(
      new GodotAdapterError(
        "PROCESS_FAILED",
        "Project Environment V2 client closed",
      ),
    );
  }

  private readonly onData = (chunk: Uint8Array): void => {
    try {
      for (const json of this.#decoder.push(chunk)) {
        const message = parseGodotProjectEnvironmentWireMessageV2(json);
        if (message.sequence !== this.#incoming)
          throw new GodotAdapterError(
            "PROTOCOL_ERROR",
            `Expected V2 message ${this.#incoming}, received ${message.sequence}`,
          );
        this.#incoming += 1;
        let delivered = false;
        for (const waiter of this.#waiters) {
          if (!waiter.predicate(message)) continue;
          clearTimeout(waiter.timer);
          this.#waiters.delete(waiter);
          waiter.resolve(message);
          delivered = true;
          break;
        }
        if (!delivered) {
          if (this.#queue.length >= 64)
            throw new GodotAdapterError(
              "PROTOCOL_ERROR",
              "V2 unsolicited queue exceeded its bound",
            );
          this.#queue.push(message);
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("V2 decode failed"));
    }
  };
  private readonly onError = (error: Error): void => this.fail(error);
  private readonly onEnd = (): void =>
    this.fail(new GodotAdapterError("PROCESS_FAILED", "V2 transport ended"));
  private fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }
  private detach(): void {
    this.transport.readable.off("data", this.onData);
    this.transport.readable.off("error", this.onError);
    this.transport.readable.off("end", this.onEnd);
  }
  private assertOpen(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed)
      throw new GodotAdapterError("PROCESS_FAILED", "V2 client is closed");
  }
}

export class GodotProjectEnvironmentRuntimeClientV2 {
  #closed = false;
  public constructor(
    public readonly fingerprint: GodotProjectEnvironmentFingerprintV2,
    public readonly ready: PayloadOf<"ready">,
    private readonly peer: GodotProjectEnvironmentWireClientV2,
  ) {}
  public async status(): Promise<PayloadOf<"status_result">> {
    const response = await this.peer.request("status", {}, "status_result");
    if (response.kind !== "status_result")
      throw new Error("invalid V2 status response");
    return response.payload;
  }
  public async nextObservationBatch(
    timeoutMs?: number,
  ): Promise<PayloadOf<"observation_batch">> {
    const response = await this.peer.waitFor(
      (message) => message.kind === "observation_batch",
      timeoutMs,
    );
    if (response.kind !== "observation_batch")
      throw new Error("invalid V2 observation response");
    return response.payload;
  }
  public acknowledgeObservationBatch(
    batch: PayloadOf<"observation_batch">,
    nextWindowBatches = 8,
  ): Promise<void> {
    return this.peer.send("observation_ack", {
      batchId: batch.batchId,
      acceptedThroughRecordSequence: batch.lastRecordSequence,
      nextWindowBatches,
    });
  }
  public async configureCapture(
    request: PayloadOf<"capture_configure">,
  ): Promise<PayloadOf<"capture_configured">> {
    const response = await this.peer.request(
      "capture_configure",
      request,
      "capture_configured",
    );
    if (response.kind !== "capture_configured")
      throw new Error("invalid V2 capture response");
    return response.payload;
  }
  public async shutdown(): Promise<PayloadOf<"shutdown_ack">> {
    this.#closed = true;
    try {
      const response = await this.peer.request("shutdown", {}, "shutdown_ack");
      if (response.kind !== "shutdown_ack")
        throw new Error("invalid V2 shutdown response");
      return response.payload;
    } finally {
      await this.peer.close();
    }
  }
}

export interface GodotProjectEnvironmentConnectRequestV2 {
  readonly schemaVersion: 2;
  readonly token: string;
  readonly expectedIdentity: GodotProjectEnvironmentRuntimeIdentityV2;
  readonly expectedEngineVersion: string;
  readonly expectedPlatform: string;
  readonly expectedMainScene: string;
  readonly expectedAdapterManifestSha256: string;
  readonly observationWindowBatches?: number | undefined;
  readonly handshakeTimeoutMs?: number | undefined;
}

export const connectGodotProjectEnvironmentRuntimeV2 = async (
  transport: GodotByteTransport,
  request: GodotProjectEnvironmentConnectRequestV2,
): Promise<GodotProjectEnvironmentRuntimeClientV2> => {
  if (
    !/^[a-f0-9]{64}$/u.test(request.token) ||
    !/^[a-f0-9]{64}$/u.test(request.expectedAdapterManifestSha256)
  )
    throw new TypeError("invalid V2 connect identity");
  const identity = GodotProjectEnvironmentRuntimeIdentityV2Schema.parse(
    request.expectedIdentity,
  );
  const peer = new GodotProjectEnvironmentWireClientV2(transport);
  try {
    const hello = await peer.waitFor(
      (message) => message.kind === "hello",
      request.handshakeTimeoutMs,
    );
    if (hello.kind !== "hello" || hello.payload.token !== request.token)
      throw new GodotAdapterError("PROTOCOL_ERROR", "V2 authentication failed");
    const fingerprint = GodotProjectEnvironmentFingerprintV2Schema.parse(
      hello.payload.fingerprint,
    );
    const mismatches = [
      ...(JSON.stringify(fingerprint.identity) === JSON.stringify(identity)
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
        : ["mainScene"]),
      ...(fingerprint.identity.adapterManifestSha256 ===
      request.expectedAdapterManifestSha256
        ? []
        : ["manifest"]),
    ];
    if (mismatches.length > 0)
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        `V2 fingerprint mismatch: ${mismatches.join(",")}`,
      );
    const ready = await peer.request(
      "hello_accept",
      {
        adapterManifestSha256: request.expectedAdapterManifestSha256,
        observationWindowBatches: request.observationWindowBatches ?? 8,
      },
      "ready",
      request.handshakeTimeoutMs,
    );
    if (
      ready.kind !== "ready" ||
      !ready.payload.running ||
      ready.payload.currentScene === null
    )
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        "V2 runtime returned invalid readiness",
      );
    return new GodotProjectEnvironmentRuntimeClientV2(
      fingerprint,
      ready.payload,
      peer,
    );
  } catch (error) {
    await peer.close().catch(() => undefined);
    throw error;
  }
};
