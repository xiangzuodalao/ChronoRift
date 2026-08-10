import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { relative, resolve, sep } from "node:path";
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
  hasCapabilities,
  type GodotWireMessage,
} from "@chronorift/godot-protocol";

import {
  GODOT_ADAPTER,
  GODOT_ADAPTER_VERSION,
  GODOT_FIXTURE_SCENE,
  clearGeneratedGodotCache,
  verifyStagedGodotProject,
} from "./fixture.js";
import { GodotAdapterError } from "./errors.js";
import {
  GodotWireClient,
  createSocketGodotTransport,
} from "./godot-wire-client.js";

const CONNECTION_TIMEOUT_MS = 30_000;
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
  readonly peer: GodotWireClient;
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
  await verifyStagedGodotProject(options.projectDirectory, {
    projectHash: expected.projectHash,
    addonHash: expected.addonHash,
  });
  await clearGeneratedGodotCache(options.projectDirectory);
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
  const runtimeRoot = resolve(options.runtimeRoot);
  await mkdir(runtimeRoot, { recursive: true });
  const runtimeRootMetadata = await lstat(runtimeRoot);
  if (
    runtimeRootMetadata.isSymbolicLink() ||
    !runtimeRootMetadata.isDirectory()
  ) {
    throw new GodotAdapterError(
      "PROCESS_FAILED",
      `Godot runtime root must be a real directory: ${runtimeRoot}`,
    );
  }
  const canonicalRuntimeRoot = await realpath(runtimeRoot);
  const executionKey = createHash("sha256")
    .update(options.request.executionId)
    .digest("hex")
    .slice(0, 24);
  const processRoot = resolve(
    canonicalRuntimeRoot,
    `execution-${executionKey}-${randomUUID()}`,
  );
  const processRelative = relative(canonicalRuntimeRoot, processRoot);
  if (
    processRelative === ".." ||
    processRelative.startsWith(`..${sep}`) ||
    processRelative.startsWith(sep)
  ) {
    throw new GodotAdapterError(
      "PROCESS_FAILED",
      "Godot runtime process path escaped its root",
    );
  }
  await mkdir(processRoot, { recursive: false });
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
  const peer = new GodotWireClient(
    createSocketGodotTransport(socket),
    expected.protocolVersion,
  );
  try {
    const hello = await peer.waitFor(
      (message) => message.kind === "hello",
      CONNECTION_TIMEOUT_MS,
    );
    if (hello.kind !== "hello") {
      throw new GodotAdapterError("PROTOCOL_ERROR", "Runtime omitted hello");
    }
    if (hello.payload.token !== token) {
      await peer.send("error", {
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
    await peer.send(
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
    await peer.close();
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
    await this.runtime.peer.close();
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
