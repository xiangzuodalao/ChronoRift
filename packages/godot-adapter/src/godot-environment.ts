import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import {
  CheckpointCertificateV1Schema,
  EnvironmentSnapshotSchema,
  RuntimeFingerprintV1Schema,
  RuntimeStepReceiptV1Schema,
  StateSnapshotSchema,
  type EnvironmentRef,
  type JsonValue,
  type RuntimeCapability,
  type RuntimeFingerprintV1,
} from "@chronorift/domain";
import type {
  EnvironmentRestoreRequest,
  FrameCommand,
  FrameObservation,
  GameEnvironmentFactoryPort,
  GameEnvironmentLaunchRequest,
  GameEnvironmentPort,
  RestoreReceipt,
} from "@chronorift/gamebranch";
import {
  GodotWireMessageSchema,
  WireFrameDecoder,
  encodeWireFrame,
  hasCapabilities,
  makeGodotWireMessage,
  parseGodotWireMessage,
  type GodotWireMessage,
  type GodotWireMessageKind,
} from "@chronorift/godot-protocol";

import {
  GODOT_ADAPTER,
  GODOT_ADAPTER_VERSION,
  GODOT_FIXTURE_SCENE,
} from "./fixture.js";

const CONNECTION_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 10_000;
const EXECUTION_TIMEOUT_MS = 60_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

const positiveControl = (
  value: JsonValue | undefined,
  fallback: number,
): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;

const fixtureControls = (
  variables: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> =>
  Object.fromEntries(
    Object.entries(variables)
      .filter(([key]) => key.startsWith("fixture."))
      .map(([key, value]) => [key.slice("fixture.".length), value]),
  );

export class GodotAdapterError extends Error {
  public override readonly name = "GodotAdapterError";

  public constructor(
    public readonly code:
      | "PROCESS_FAILED"
      | "CONNECTION_TIMEOUT"
      | "PROTOCOL_ERROR"
      | "CAPABILITY_UNSUPPORTED"
      | "COMMAND_TIMEOUT",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface Waiter {
  readonly predicate: (message: GodotWireMessage) => boolean;
  readonly resolve: (message: GodotWireMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class WirePeer {
  private readonly decoder = new WireFrameDecoder();
  private readonly queue: GodotWireMessage[] = [];
  private readonly waiters = new Set<Waiter>();
  private incomingSequence = 0;
  private outgoingSequence = 0;
  private failure: Error | undefined;

  public constructor(
    private readonly socket: Socket,
    private readonly protocolVersion: 1 | 2,
  ) {
    socket.on("data", (chunk) => {
      try {
        for (const json of this.decoder.push(chunk)) {
          const message = parseGodotWireMessage(json);
          if (message.sequence !== this.incomingSequence) {
            throw new GodotAdapterError(
              "PROTOCOL_ERROR",
              `Expected runtime sequence ${this.incomingSequence}, received ${message.sequence}`,
            );
          }
          this.incomingSequence += 1;
          this.deliver(message);
        }
      } catch (error) {
        this.fail(
          error instanceof Error
            ? error
            : new GodotAdapterError("PROTOCOL_ERROR", String(error)),
        );
      }
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => {
      if (this.failure === undefined) {
        this.fail(
          new GodotAdapterError(
            "PROCESS_FAILED",
            "Godot runtime connection closed unexpectedly",
          ),
        );
      }
    });
  }

  public send(
    kind: GodotWireMessageKind,
    payload: unknown,
    requestId?: string,
  ): void {
    if (this.failure !== undefined) throw this.failure;
    const message = makeGodotWireMessage({
      sequence: this.outgoingSequence,
      kind,
      protocolVersion: this.protocolVersion,
      ...(requestId === undefined ? {} : { requestId }),
      payload: payload as JsonValue,
    });
    this.outgoingSequence += 1;
    this.socket.write(encodeWireFrame(JSON.stringify(message)));
  }

  public waitFor(
    predicate: (message: GodotWireMessage) => boolean,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<GodotWireMessage> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const queuedIndex = this.queue.findIndex(predicate);
    if (queuedIndex >= 0) {
      const message = this.queue.splice(queuedIndex, 1)[0];
      if (message !== undefined) return Promise.resolve(message);
    }
    return new Promise((resolveWait, rejectWait) => {
      const waiter: Waiter = {
        predicate,
        resolve: resolveWait,
        reject: rejectWait,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          rejectWait(
            new GodotAdapterError(
              "COMMAND_TIMEOUT",
              `Godot protocol command timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.add(waiter);
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
    this.send(kind, payload, requestId);
    const response = await this.waitFor(
      (message) => message.requestId === requestId,
    );
    if (response.kind === "error") {
      throw new GodotAdapterError(
        response.payload.code === "CAPABILITY_UNSUPPORTED"
          ? "CAPABILITY_UNSUPPORTED"
          : "PROTOCOL_ERROR",
        `${response.payload.code}: ${response.payload.message}`,
      );
    }
    if (response.kind !== expectedKind) {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        `Expected ${expectedKind}, received ${response.kind}`,
      );
    }
    return response;
  }

  public close(): void {
    this.socket.end();
  }

  private deliver(message: GodotWireMessage): void {
    for (const waiter of this.waiters) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(message);
        return;
      }
    }
    this.queue.push(message);
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> =>
  new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new GodotAdapterError("CONNECTION_TIMEOUT", message)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(
          error instanceof Error ? error : new Error(String(error)),
        );
      },
    );
  });

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new GodotAdapterError("PROCESS_FAILED", "TCP server has no port");
  }
  return address.port;
};

const boundedOutput = (
  child: GodotChild,
): { readonly stdout: () => string; readonly stderr: () => string } => {
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const append = (
    current: Buffer<ArrayBufferLike>,
    chunk: Buffer<ArrayBufferLike>,
  ): Buffer<ArrayBufferLike> => {
    const combined = Buffer.concat([current, chunk]);
    return combined.byteLength <= MAX_PROCESS_OUTPUT_BYTES
      ? combined
      : combined.subarray(combined.byteLength - MAX_PROCESS_OUTPUT_BYTES);
  };
  child.stdout.on("data", (chunk: Buffer<ArrayBufferLike>) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer<ArrayBufferLike>) => {
    stderr = append(stderr, chunk);
  });
  return {
    stdout: () => stdout.toString("utf8"),
    stderr: () => stderr.toString("utf8"),
  };
};

type GodotChild = ChildProcessByStdio<null, Readable, Readable>;

interface LaunchedRuntime {
  readonly peer: WirePeer;
  readonly child: GodotChild;
  readonly server: Server;
  readonly fingerprint: RuntimeFingerprintV1;
  readonly output: {
    readonly stdout: () => string;
    readonly stderr: () => string;
  };
}

const launchRuntime = async (options: {
  readonly binary: string;
  readonly projectDirectory: string;
  readonly runtimeRoot: string;
  readonly request: GameEnvironmentLaunchRequest;
}): Promise<LaunchedRuntime> => {
  const expected = options.request.environment.runtimeFingerprint;
  if (expected === undefined) {
    throw new GodotAdapterError(
      "PROTOCOL_ERROR",
      "Godot EnvironmentRef requires a runtime fingerprint",
    );
  }
  const server = createServer();
  const fixedFps = positiveControl(
    options.request.controls.variables["fixed_fps"],
    expected.fixedFps,
  );
  const physicsTicksPerSecond = positiveControl(
    options.request.controls.variables["physics_ticks_per_second"],
    expected.physicsTicksPerSecond,
  );
  const port = await listen(server);
  const token = randomBytes(32).toString("hex");
  const socketPromise = new Promise<Socket>((resolveSocket, rejectSocket) => {
    server.once("connection", resolveSocket);
    server.once("error", rejectSocket);
  });
  const processRoot = resolve(options.runtimeRoot, options.request.executionId);
  await mkdir(processRoot, { recursive: true });
  const child: GodotChild = spawn(
    options.binary,
    [
      "--headless",
      "--path",
      options.projectDirectory,
      "--fixed-fps",
      String(fixedFps),
      "--rendering-method",
      "gl_compatibility",
      "--audio-driver",
      "Dummy",
    ],
    {
      cwd: options.projectDirectory,
      env: {
        LANG: "C.UTF-8",
        XDG_DATA_HOME: resolve(processRoot, "data"),
        XDG_CONFIG_HOME: resolve(processRoot, "config"),
        XDG_CACHE_HOME: resolve(processRoot, "cache"),
        CHRONORIFT_HOST: "127.0.0.1",
        CHRONORIFT_PORT: String(port),
        CHRONORIFT_TOKEN: token,
        CHRONORIFT_FIXED_FPS: String(fixedFps),
        CHRONORIFT_PHYSICS_TPS: String(physicsTicksPerSecond),
        CHRONORIFT_PROTOCOL_VERSION: String(expected.protocolVersion),
        CHRONORIFT_ADAPTER_VERSION: expected.adapterVersion,
        CHRONORIFT_FIXTURE_CONTROLS: JSON.stringify(
          fixtureControls(options.request.controls.variables),
        ),
        CHRONORIFT_PROJECT_HASH: expected.projectHash,
        CHRONORIFT_ADDON_HASH: expected.addonHash,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = boundedOutput(child);
  const executionTimer = setTimeout(
    () => child.kill("SIGTERM"),
    EXECUTION_TIMEOUT_MS,
  );
  child.once("exit", () => clearTimeout(executionTimer));
  const processFailure = new Promise<never>((_, rejectProcess) => {
    child.once("error", (error) => rejectProcess(error));
    child.once("exit", (code, signal) =>
      rejectProcess(
        new GodotAdapterError(
          "PROCESS_FAILED",
          `Godot exited before the protocol completed (code=${String(code)}, signal=${String(signal)}): ${output.stderr()}`,
        ),
      ),
    );
  });
  let socket: Socket;
  try {
    socket = await Promise.race([
      withTimeout(
        socketPromise,
        CONNECTION_TIMEOUT_MS,
        `Godot did not connect within ${CONNECTION_TIMEOUT_MS}ms`,
      ),
      processFailure,
    ]);
  } catch (error) {
    child.kill("SIGTERM");
    server.close();
    throw error;
  }
  server.close();
  const peer = new WirePeer(socket, expected.protocolVersion);
  try {
    const hello = await peer.waitFor(
      (message) => message.kind === "hello",
      CONNECTION_TIMEOUT_MS,
    );
    if (hello.kind !== "hello") {
      throw new GodotAdapterError("PROTOCOL_ERROR", "Runtime omitted hello");
    }
    if (hello.payload.token !== token) {
      peer.send("error", {
        code: "AUTH_FAILED",
        message: "Single-run token mismatch",
      });
      throw new GodotAdapterError("PROTOCOL_ERROR", "Godot token mismatch");
    }
    const fingerprint = RuntimeFingerprintV1Schema.parse(
      hello.payload.fingerprint,
    );
    const expectedIdentity = {
      engine: expected.engine,
      engineVersion: expected.engineVersion,
      adapterVersion: expected.adapterVersion,
      protocolVersion: expected.protocolVersion,
      platform: expected.platform,
      renderer: expected.renderer,
      physicsTicksPerSecond,
      fixedFps,
      projectHash: expected.projectHash,
      addonHash: expected.addonHash,
    };
    const actualIdentity = {
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
    };
    if (JSON.stringify(actualIdentity) !== JSON.stringify(expectedIdentity)) {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        `Godot runtime fingerprint mismatch: ${JSON.stringify(actualIdentity)}`,
      );
    }
    if (!hasCapabilities(fingerprint, options.request.requiredCapabilities)) {
      throw new GodotAdapterError(
        "CAPABILITY_UNSUPPORTED",
        "Godot runtime lacks a required capability",
      );
    }
    const helloRequestId = `request:${randomUUID()}`;
    peer.send(
      "hello_accept",
      { requiredCapabilities: options.request.requiredCapabilities },
      helloRequestId,
    );
    await peer.request(
      "configure",
      {
        probePlan:
          options.request.environment.scene === GODOT_FIXTURE_SCENE
            ? {
                ...options.request.probePlan,
                properties: [
                  ...new Set([
                    ...options.request.probePlan.properties,
                    "switch.active",
                    "door.open",
                    "door.receiver_connected",
                  ]),
                ],
              }
            : options.request.probePlan,
      },
      "configured",
    );
    return { peer, child, server, fingerprint, output };
  } catch (error) {
    peer.close();
    child.kill("SIGTERM");
    throw error;
  }
};

export interface GodotGameEnvironmentFactoryOptions {
  readonly binary: string;
  readonly projectDirectory: string;
  readonly runtimeRoot: string;
}

export class GodotGameEnvironmentFactory implements GameEnvironmentFactoryPort {
  public constructor(
    private readonly options: GodotGameEnvironmentFactoryOptions,
  ) {}

  public async create(
    request: GameEnvironmentLaunchRequest,
  ): Promise<GameEnvironmentPort> {
    if (
      request.environment.adapter !== GODOT_ADAPTER ||
      !["0.2.0", GODOT_ADAPTER_VERSION].includes(
        request.environment.adapterVersion,
      )
    ) {
      throw new GodotAdapterError(
        "PROTOCOL_ERROR",
        `Unsupported Godot environment ${request.environment.adapter}@${request.environment.adapterVersion}`,
      );
    }
    const runtime = await launchRuntime({
      binary: this.options.binary,
      projectDirectory: this.options.projectDirectory,
      runtimeRoot: this.options.runtimeRoot,
      request,
    });
    return new GodotGameEnvironment(request.environment, runtime);
  }
}

class GodotGameEnvironment implements GameEnvironmentPort {
  public readonly descriptor: EnvironmentRef;
  private disposed = false;

  public constructor(
    environment: EnvironmentRef,
    private readonly runtime: LaunchedRuntime,
  ) {
    this.descriptor = {
      ...environment,
      runtimeFingerprint: runtime.fingerprint,
    };
  }

  public async restore(
    request: EnvironmentRestoreRequest,
  ): Promise<RestoreReceipt> {
    this.assertActive();
    const response = await this.runtime.peer.request(
      "restore",
      {
        snapshot: request.snapshot,
        ...(request.certificate === undefined
          ? {}
          : { certificate: request.certificate }),
        nextTick: request.nextTick,
        simTimeUs: request.simTimeUs,
      },
      "restored",
    );
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

  public async step(command: FrameCommand): Promise<FrameObservation> {
    this.assertActive();
    const hostStartUs = Number(process.hrtime.bigint() / 1000n);
    const response = await this.runtime.peer.request(
      "step",
      {
        tick: command.tick,
        simTimeUs: command.simTimeUs,
        deltaUs: command.deltaUs,
        inputs: command.inputs,
      },
      "stepped",
    );
    const hostEndUs = Number(process.hrtime.bigint() / 1000n);
    if (response.kind !== "stepped") {
      throw new GodotAdapterError("PROTOCOL_ERROR", "Invalid step response");
    }
    const runtime = RuntimeStepReceiptV1Schema.parse({
      ...response.payload.receipt.runtime,
      hostMonotonicStartUs: hostStartUs,
      hostMonotonicEndUs: hostEndUs,
    });
    return {
      events: response.payload.events,
      state: response.payload.state,
      receipt: {
        requestedTick: response.payload.receipt.requestedTick,
        realizedTick: response.payload.receipt.realizedTick,
        requestedDeltaUs: response.payload.receipt.requestedDeltaUs,
        realizedDeltaUs: response.payload.receipt.realizedDeltaUs,
        appliedInputOrders: response.payload.receipt.appliedInputOrders,
        runtime,
      },
    };
  }

  public async snapshot(): Promise<{
    readonly snapshot: ReturnType<typeof EnvironmentSnapshotSchema.parse>;
    readonly certificate: ReturnType<
      typeof CheckpointCertificateV1Schema.parse
    >;
  }> {
    this.assertActive();
    const response = await this.runtime.peer.request(
      "snapshot",
      {},
      "snapshot_result",
    );
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

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.runtime.peer.request("shutdown", {}, "shutdown_ack");
    } catch {
      // Process cleanup below remains mandatory after a protocol failure.
    }
    this.runtime.peer.close();
    await new Promise<void>((resolveExit) => {
      if (this.runtime.child.exitCode !== null) {
        resolveExit();
        return;
      }
      const timer = setTimeout(() => {
        this.runtime.child.kill("SIGTERM");
        resolveExit();
      }, 2000);
      this.runtime.child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new GodotAdapterError(
        "PROCESS_FAILED",
        "Godot environment is disposed",
      );
    }
  }
}

export const requiredGodotCapabilities = (): readonly RuntimeCapability[] => [
  "observe.signal_allowlist",
  "observe.property_sampling",
  "control.input_event_action",
  "clock.process_frame",
  "clock.physics_tick",
  "launch.fixed_fps",
  "checkpoint.l0_restart",
  "checkpoint.fixture_semantic",
];

export const parseGodotMessageForTest = (value: unknown): GodotWireMessage =>
  GodotWireMessageSchema.parse(value);
