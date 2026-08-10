import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { once } from "node:events";

import { asSha256DigestV1 } from "@chronorift/domain";
import {
  type GodotByteTransport,
  type RuntimeSidecarSourceOptions,
  createRuntimeSidecarSource,
} from "@chronorift/godot-adapter";
import {
  RuntimeSidecarDiagnosticV1Schema,
  RuntimeSidecarLaunchV1Schema,
  encodeWireFrame,
  type RuntimeSidecarDiagnosticV1,
  type RuntimeSidecarLaunchV1,
} from "@chronorift/godot-protocol";

import type { SandboxExecutionRequestV1 } from "./contracts.js";
import {
  assertManagedGodotRuntimeBinding,
  type ManagedGodotRuntimeBindingV1,
  type ManagedGodotRuntimeCapabilityV1,
} from "./managed-godot-runtime.js";
import type {
  DuplexTaskSandboxBrokerV1,
  SandboxDuplexHandleV1,
  SandboxExecutionResultV1,
} from "./sandbox-broker.js";

const sha256 = (bytes: Uint8Array | string) =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

class DiagnosticFramesV1 {
  #buffer = Buffer.alloc(0);
  #encodedByteLength = 0;
  #frameCount = 0;
  #ended = false;

  public constructor(
    private readonly limits: {
      readonly frameMaxBytes: number;
      readonly totalMaxBytes: number;
      readonly maxCount: number;
    },
    private readonly accept: (value: RuntimeSidecarDiagnosticV1) => void,
  ) {}

  public push(chunk: Uint8Array): void {
    if (this.#ended) {
      throw new Error("runtime sidecar diagnostic stream continued after end");
    }
    if (chunk.byteLength === 0) return;
    if (
      this.#encodedByteLength + chunk.byteLength >
      this.limits.totalMaxBytes
    ) {
      throw new Error(
        "runtime sidecar diagnostics exceeded the total byte bound",
      );
    }
    this.#encodedByteLength += chunk.byteLength;
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    for (;;) {
      if (this.#buffer.byteLength < 4) break;
      const length = this.#buffer.readUInt32BE(0);
      if (length < 1 || length > this.limits.frameMaxBytes) {
        throw new Error("runtime sidecar diagnostic frame has an invalid size");
      }
      if (this.#buffer.byteLength < length + 4) break;
      this.#frameCount += 1;
      if (this.#frameCount > this.limits.maxCount) {
        throw new Error(
          "runtime sidecar diagnostics exceeded the frame count bound",
        );
      }
      const body = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(body),
        ) as unknown;
      } catch (error) {
        throw new Error("runtime sidecar diagnostic frame is not UTF-8 JSON", {
          cause: error,
        });
      }
      this.accept(RuntimeSidecarDiagnosticV1Schema.parse(value));
    }
  }

  public end(): void {
    this.#ended = true;
    if (this.#buffer.byteLength !== 0) {
      throw new Error("runtime sidecar diagnostics ended with a partial frame");
    }
  }

  public encodedByteLength(): number {
    return this.#encodedByteLength;
  }

  public frameCount(): number {
    return this.#frameCount;
  }
}

export interface RuntimeSidecarDiagnosticFactsV1 {
  readonly schemaVersion: 1;
  readonly status: "open" | "complete" | "failed";
  readonly records: readonly RuntimeSidecarDiagnosticV1[];
  readonly frameCount: number;
  readonly encodedByteLength: number;
  readonly limits: {
    readonly frameMaxBytes: number;
    readonly totalMaxBytes: number;
    readonly maxCount: number;
  };
  readonly failure: {
    readonly code: "diagnostic_protocol_failure" | "diagnostic_limit_exceeded";
    readonly message: string;
  } | null;
}

export interface SandboxedGodotSidecarV1 {
  readonly transport: GodotByteTransport;
  readonly completion: Promise<SandboxExecutionResultV1>;
  diagnostics(): readonly RuntimeSidecarDiagnosticV1[];
  diagnosticFacts(): RuntimeSidecarDiagnosticFactsV1;
  terminate(): Promise<void>;
}

export type OpenSandboxedGodotSidecarResultV1 =
  | {
      readonly kind: "opened";
      readonly sidecar: SandboxedGodotSidecarV1;
    }
  | SandboxExecutionResultV1;

export interface GodotSidecarPortOptionsV1 {
  readonly broker: Pick<DuplexTaskSandboxBrokerV1, "openDuplex">;
  readonly managedRuntime: {
    readonly capability: ManagedGodotRuntimeCapabilityV1;
    readonly binding: ManagedGodotRuntimeBindingV1;
  };
  readonly sourceOptions?: RuntimeSidecarSourceOptions | undefined;
}

export class GodotSidecarPortV1 {
  readonly #source: string;

  public constructor(private readonly options: GodotSidecarPortOptionsV1) {
    assertManagedGodotRuntimeBinding(
      options.managedRuntime.capability,
      options.managedRuntime.binding,
    );
    this.#source = createRuntimeSidecarSource(
      options.sourceOptions ?? {
        godotExecutable: options.managedRuntime.capability.godotTarget,
        workspaceRoot: "/workspace",
        runtimeRoot: "/run/chronorift",
      },
    );
    if (
      sha256(Buffer.from(this.#source, "utf8")) !==
      options.managedRuntime.capability.sidecarSourceSha256
    ) {
      throw new TypeError(
        "runtime sidecar source no longer matches the managed capability",
      );
    }
  }

  public async open(
    launchInput: RuntimeSidecarLaunchV1,
    signal?: AbortSignal,
  ): Promise<OpenSandboxedGodotSidecarResultV1> {
    assertManagedGodotRuntimeBinding(
      this.options.managedRuntime.capability,
      this.options.managedRuntime.binding,
    );
    const launch = RuntimeSidecarLaunchV1Schema.parse({
      ...launchInput,
      addonHash: this.options.managedRuntime.capability.addonHash,
    });
    const request: SandboxExecutionRequestV1 = {
      schemaVersion: 1,
      operationId: `game-runtime:${sha256(`${launch.taskId}\0${launch.runtimeId}`).slice(0, 24)}`,
      profile: "godot-headless",
      argv: [
        this.options.managedRuntime.capability.nodeTarget,
        "--input-type=commonjs",
        "--eval",
        this.#source,
      ],
      cwd: "/workspace",
      environment: {},
      timeoutMs: Math.min(600_000, launch.executionTimeoutMs + 5_000),
    };
    const readable = new PassThrough();
    // A diagnostic failure may arrive after the sandbox process starts but
    // before this port can return the transport to a consumer. Keep that
    // narrow window from becoming an unhandled stream error; consumers still
    // receive the same error event once attached.
    readable.on("error", () => undefined);
    const diagnostics: RuntimeSidecarDiagnosticV1[] = [];
    const callbackState: { handle?: SandboxDuplexHandleV1 } = {};
    let callbackFailure: Error | undefined;
    let diagnosticStreamEnded = false;
    const diagnosticLimits = Object.freeze({
      frameMaxBytes: launch.diagnosticFrameMaxBytes,
      totalMaxBytes: launch.diagnosticTotalMaxBytes,
      maxCount: launch.diagnosticMaxCount,
    });
    const diagnosticParser = new DiagnosticFramesV1(
      diagnosticLimits,
      (diagnostic) => diagnostics.push(diagnostic),
    );
    const failCallback = (error: unknown): void => {
      if (callbackFailure !== undefined) return;
      callbackFailure =
        error instanceof Error ? error : new Error(String(error));
      readable.destroy(callbackFailure);
      void callbackState.handle?.terminate().catch(() => undefined);
    };
    const opened = await this.options.broker.openDuplex(request, {
      ...(signal === undefined ? {} : { signal }),
      onStdoutChunk: async (chunk) => {
        if (!readable.write(chunk)) await once(readable, "drain");
      },
      onStderrChunk: (chunk) => {
        try {
          diagnosticParser.push(chunk);
        } catch (error) {
          failCallback(error);
        }
      },
    });
    if (opened.kind !== "opened") {
      readable.end();
      return opened;
    }
    const handle = opened.handle;
    callbackState.handle = handle;
    const terminateAndObserveCompletion =
      async (): Promise<SandboxExecutionResultV1> => {
        // Completion, rather than terminate(), owns the process-group/cgroup
        // cleanup receipt. Even when termination itself reports an error we
        // must retain ownership until that authoritative result is observed.
        let terminationError: unknown;
        try {
          await handle.terminate();
        } catch (error) {
          terminationError = error;
        }
        try {
          return await handle.completion;
        } catch (completionError) {
          throw new AggregateError(
            terminationError === undefined
              ? [completionError]
              : [terminationError, completionError],
            "runtime sidecar early cleanup completion failed",
          );
        }
      };
    if (callbackFailure !== undefined) {
      return terminateAndObserveCompletion();
    }
    try {
      await handle.write(encodeWireFrame(JSON.stringify(launch)));
    } catch {
      readable.destroy();
      return terminateAndObserveCompletion();
    }
    if (callbackFailure !== undefined) {
      return terminateAndObserveCompletion();
    }
    const completion = handle.completion.then((result) => {
      try {
        diagnosticParser.end();
        diagnosticStreamEnded = true;
      } catch (error) {
        failCallback(error);
      }
      if (callbackFailure === undefined) readable.end();
      return result;
    });
    const transport: GodotByteTransport = {
      readable,
      write: (bytes) => handle.write(bytes),
      close: () => handle.endInput(),
    };
    return {
      kind: "opened",
      sidecar: Object.freeze({
        transport,
        completion,
        diagnostics: () => Object.freeze([...diagnostics]),
        diagnosticFacts: () => {
          const limitFailure = diagnostics.find(
            (diagnostic) =>
              diagnostic.kind === "sidecar_error" &&
              diagnostic.code === "DIAGNOSTIC_LIMIT_EXCEEDED",
          );
          const failure =
            callbackFailure !== undefined
              ? Object.freeze({
                  code: "diagnostic_protocol_failure" as const,
                  message: callbackFailure.message.slice(0, 4_096),
                })
              : limitFailure?.kind === "sidecar_error"
                ? Object.freeze({
                    code: "diagnostic_limit_exceeded" as const,
                    message: limitFailure.message,
                  })
                : null;
          return Object.freeze({
            schemaVersion: 1 as const,
            status:
              failure !== null
                ? ("failed" as const)
                : diagnosticStreamEnded
                  ? ("complete" as const)
                  : ("open" as const),
            records: Object.freeze([...diagnostics]),
            frameCount: diagnosticParser.frameCount(),
            encodedByteLength: diagnosticParser.encodedByteLength(),
            limits: diagnosticLimits,
            failure,
          });
        },
        terminate: () => handle.terminate(),
      }),
    };
  }
}
