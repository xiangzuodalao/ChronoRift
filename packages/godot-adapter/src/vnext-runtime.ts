import { randomUUID } from "node:crypto";

import {
  CheckpointCertificateV1Schema,
  EnvironmentSnapshotSchema,
  RuntimeFingerprintV1Schema,
  RuntimeStepReceiptV1Schema,
  StateSnapshotSchema,
  V01EnvironmentEventDraftSchema,
  type CheckpointCertificateV1,
  type EnvironmentSnapshot,
  type JsonObject,
  type RuntimeCapability,
  type RuntimeFingerprintV1,
  type RuntimeStepReceiptV1,
  type StateSnapshot,
  type V01EnvironmentEventDraft,
} from "@chronorift/domain";
import { hasCapabilities } from "@chronorift/godot-protocol";

import { GodotAdapterError } from "./errors.js";
import {
  GodotWireClient,
  type GodotByteTransport,
} from "./godot-wire-client.js";

export interface VNextGodotProbePlanV1 {
  readonly schemaVersion: 1;
  readonly signals: readonly {
    readonly source: string;
    readonly name: string;
  }[];
  readonly properties: readonly string[];
}

export interface VNextGodotConnectRequestV1 {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly expectedFingerprint: RuntimeFingerprintV1;
  readonly requiredCapabilities: readonly RuntimeCapability[];
  readonly probePlan: VNextGodotProbePlanV1;
  readonly handshakeTimeoutMs?: number | undefined;
}

export interface VNextGodotRuntimeInputV1 {
  readonly localId: string;
  readonly order: number;
  readonly action: string;
  readonly target?: string | undefined;
  readonly payload: JsonObject;
}

export interface VNextGodotStepRequestV1 {
  readonly tick: number;
  readonly simTimeUs: number;
  readonly deltaUs: number;
  readonly inputs: readonly VNextGodotRuntimeInputV1[];
}

export interface VNextGodotStepResultV1 {
  readonly events: readonly V01EnvironmentEventDraft[];
  readonly state: StateSnapshot;
  readonly receipt: {
    readonly requestedTick: number;
    readonly realizedTick: number;
    readonly requestedDeltaUs: number;
    readonly realizedDeltaUs: number;
    readonly appliedInputOrders: readonly number[];
    readonly runtime: RuntimeStepReceiptV1;
  };
}

export interface VNextGodotRestoreRequestV1 {
  readonly snapshot: EnvironmentSnapshot;
  readonly certificate?: CheckpointCertificateV1 | undefined;
  readonly nextTick: number;
  readonly simTimeUs: number;
}

export interface VNextGodotRestoreResultV1 {
  readonly restored: true;
  readonly nextTick: number;
  readonly simTimeUs: number;
  readonly state: StateSnapshot;
  readonly runtimeValidation?: unknown;
}

export interface VNextGodotSnapshotResultV1 {
  readonly snapshot: EnvironmentSnapshot;
  readonly certificate: CheckpointCertificateV1;
}

export class VNextGodotRuntimeClient {
  #closed = false;

  public constructor(
    public readonly fingerprint: RuntimeFingerprintV1,
    private readonly peer: GodotWireClient,
  ) {}

  public async step(
    request: VNextGodotStepRequestV1,
  ): Promise<VNextGodotStepResultV1> {
    this.assertOpen();
    const hostMonotonicStartUs = Number(process.hrtime.bigint() / 1000n);
    const response = await this.peer.request("step", request, "stepped");
    const hostMonotonicEndUs = Number(process.hrtime.bigint() / 1000n);
    if (response.kind !== "stepped") {
      throw new GodotAdapterError("PROTOCOL_ERROR", "Invalid step response");
    }
    return {
      events: response.payload.events.map((event) =>
        V01EnvironmentEventDraftSchema.parse(event),
      ),
      state: StateSnapshotSchema.parse(response.payload.state),
      receipt: {
        requestedTick: response.payload.receipt.requestedTick,
        realizedTick: response.payload.receipt.realizedTick,
        requestedDeltaUs: response.payload.receipt.requestedDeltaUs,
        realizedDeltaUs: response.payload.receipt.realizedDeltaUs,
        appliedInputOrders: response.payload.receipt.appliedInputOrders,
        runtime: RuntimeStepReceiptV1Schema.parse({
          ...response.payload.receipt.runtime,
          hostMonotonicStartUs,
          hostMonotonicEndUs,
        }),
      },
    };
  }

  public async snapshot(): Promise<VNextGodotSnapshotResultV1> {
    this.assertOpen();
    const response = await this.peer.request("snapshot", {}, "snapshot_result");
    if (response.kind !== "snapshot_result") {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        "Invalid snapshot response",
      );
    }
    return {
      snapshot: EnvironmentSnapshotSchema.parse(response.payload.snapshot),
      certificate: CheckpointCertificateV1Schema.parse(
        response.payload.certificate,
      ),
    };
  }

  public async restore(
    request: VNextGodotRestoreRequestV1,
  ): Promise<VNextGodotRestoreResultV1> {
    this.assertOpen();
    const response = await this.peer.request("restore", request, "restored");
    if (response.kind !== "restored") {
      throw new GodotAdapterError("PROTOCOL_ERROR", "Invalid restore response");
    }
    return {
      restored: true,
      nextTick: response.payload.nextTick,
      simTimeUs: response.payload.simTimeUs,
      state: StateSnapshotSchema.parse(response.payload.state),
      ...(response.payload.runtimeValidation === undefined
        ? {}
        : { runtimeValidation: response.payload.runtimeValidation }),
    };
  }

  public async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.peer.request("shutdown", {}, "shutdown_ack");
    } finally {
      await this.peer.close();
    }
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new GodotAdapterError(
        "PROCESS_FAILED",
        "Godot runtime client is closed",
      );
    }
  }
}

const fingerprintIdentity = (fingerprint: RuntimeFingerprintV1) => ({
  engine: fingerprint.engine,
  engineVersion: fingerprint.engineVersion,
  adapterVersion: fingerprint.adapterVersion,
  protocolVersion: fingerprint.protocolVersion,
  platform: fingerprint.platform,
  renderer: fingerprint.renderer,
  physicsTicksPerSecond: fingerprint.physicsTicksPerSecond,
  fixedFps: fingerprint.fixedFps,
  projectHash: fingerprint.projectHash,
  addonHash: fingerprint.addonHash,
});

export const connectVNextGodotRuntime = async (
  transport: GodotByteTransport,
  request: VNextGodotConnectRequestV1,
): Promise<VNextGodotRuntimeClient> => {
  if (!/^[a-f0-9]{64}$/u.test(request.token)) {
    throw new GodotAdapterError("PROTOCOL_ERROR", "Invalid runtime token");
  }
  const expected = RuntimeFingerprintV1Schema.parse(
    request.expectedFingerprint,
  );
  if (expected.protocolVersion !== 2) {
    throw new GodotAdapterError(
      "PROTOCOL_ERROR",
      "vNext requires Godot Protocol v2",
    );
  }
  const peer = new GodotWireClient(transport, 2);
  try {
    const hello = await peer.waitFor(
      (message) => message.kind === "hello",
      request.handshakeTimeoutMs ?? 30_000,
    );
    if (hello.kind !== "hello" || hello.payload.token !== request.token) {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        "Godot runtime authentication failed",
      );
    }
    const actual = RuntimeFingerprintV1Schema.parse(hello.payload.fingerprint);
    if (
      JSON.stringify(fingerprintIdentity(actual)) !==
      JSON.stringify(fingerprintIdentity(expected))
    ) {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        "Godot runtime fingerprint mismatch",
      );
    }
    if (!hasCapabilities(actual, request.requiredCapabilities)) {
      throw new GodotAdapterError(
        "CAPABILITY_UNSUPPORTED",
        "Godot runtime lacks a required capability",
      );
    }
    await peer.send(
      "hello_accept",
      { requiredCapabilities: [...request.requiredCapabilities] },
      `request:hello:${randomUUID()}`,
    );
    await peer.request(
      "configure",
      {
        probePlan: {
          schemaVersion: 1,
          signals: request.probePlan.signals.map((signal) => ({ ...signal })),
          properties: [...request.probePlan.properties],
        },
      },
      "configured",
    );
    return new VNextGodotRuntimeClient(actual, peer);
  } catch (error) {
    await peer.close().catch(() => undefined);
    throw error;
  }
};
