import { createHash } from "node:crypto";
import { once } from "node:events";
import { PassThrough } from "node:stream";

import { asSha256DigestV1 } from "@chronorift/domain";
import {
  createProjectEnvironmentRuntimeSidecarSource,
  createProjectEnvironmentVanillaSmokeSidecarSource,
  type GodotByteTransport,
  type LifecycleSidecarSourceOptions,
} from "@chronorift/godot-adapter";
import {
  GodotLifecycleSidecarDiagnosticV1Schema,
  GodotLifecycleVanillaSmokeDiagnosticV1Schema,
  GodotProjectEnvironmentSidecarLaunchV1Schema,
  GodotProjectEnvironmentVanillaSmokeLaunchV1Schema,
  encodeWireFrame,
  type GodotLifecycleSidecarDiagnosticV1,
  type GodotLifecycleVanillaSmokeDiagnosticV1,
  type GodotProjectEnvironmentSidecarLaunchV1,
  type GodotProjectEnvironmentVanillaSmokeLaunchV1,
} from "@chronorift/godot-protocol";
import type { z } from "zod";

import type { SandboxExecutionRequestV1 } from "./contracts.js";
import {
  assertManagedGodotProjectEnvironmentRuntimeBinding,
  type ManagedGodotProjectEnvironmentRuntimeBindingV1,
  type ManagedGodotProjectEnvironmentRuntimeCapabilityV1,
} from "./managed-godot-project-environment-runtime.js";
import type {
  DuplexTaskSandboxBrokerV1,
  SandboxDuplexHandleV1,
  SandboxExecutionResultV1,
} from "./sandbox-broker.js";

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

class DiagnosticFramesV1<T> {
  #buffer = Buffer.alloc(0);
  #encodedBytes = 0;
  #frames = 0;
  #ended = false;
  readonly #records: T[] = [];

  public constructor(
    private readonly limits: {
      readonly frameMaxBytes: number;
      readonly totalMaxBytes: number;
      readonly maxCount: number;
    },
    private readonly parse: (value: unknown) => T,
  ) {}

  public push(chunk: Uint8Array): void {
    if (this.#ended)
      throw new Error("PE sidecar diagnostics continued after end");
    this.#encodedBytes += chunk.byteLength;
    if (this.#encodedBytes > this.limits.totalMaxBytes) {
      throw new Error("PE sidecar diagnostics exceeded the byte bound");
    }
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length < 1 || length > this.limits.frameMaxBytes) {
        throw new Error("PE sidecar diagnostic frame has an invalid length");
      }
      if (this.#buffer.byteLength < length + 4) return;
      this.#frames += 1;
      if (this.#frames > this.limits.maxCount) {
        throw new Error("PE sidecar diagnostics exceeded the frame bound");
      }
      const body = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      this.#records.push(
        this.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(body),
          ) as unknown,
        ),
      );
    }
  }

  public end(): void {
    this.#ended = true;
    if (this.#buffer.byteLength !== 0) {
      throw new Error("PE sidecar diagnostics ended with a partial frame");
    }
  }

  public records(): readonly T[] {
    return Object.freeze([...this.#records]);
  }
}

export interface ProjectEnvironmentVanillaSmokeResultV1 {
  readonly sandbox: Extract<
    SandboxExecutionResultV1,
    { readonly kind: "executed" }
  >;
  readonly diagnostics: readonly GodotLifecycleVanillaSmokeDiagnosticV1[];
}

export interface SandboxedGodotProjectEnvironmentSidecarV1 {
  readonly transport: GodotByteTransport;
  readonly completion: Promise<SandboxExecutionResultV1>;
  diagnostics(): readonly GodotLifecycleSidecarDiagnosticV1[];
  terminate(): Promise<void>;
}

export class GodotProjectEnvironmentSidecarPortV1 {
  readonly #vanillaSource: string;
  readonly #managedSource: string;

  public constructor(
    private readonly options: {
      readonly broker: Pick<
        DuplexTaskSandboxBrokerV1,
        "execute" | "openDuplex"
      >;
      readonly managedRuntime: {
        readonly capability: ManagedGodotProjectEnvironmentRuntimeCapabilityV1;
        readonly binding: ManagedGodotProjectEnvironmentRuntimeBindingV1;
      };
      readonly sourceOptions?: LifecycleSidecarSourceOptions | undefined;
    },
  ) {
    assertManagedGodotProjectEnvironmentRuntimeBinding(
      options.managedRuntime.capability,
      options.managedRuntime.binding,
    );
    const sourceOptions = options.sourceOptions ?? {
      godotExecutable: options.managedRuntime.capability.godotTarget,
      workspaceRoot: "/workspace",
      runtimeRoot: "/run/chronorift",
    };
    this.#vanillaSource =
      createProjectEnvironmentVanillaSmokeSidecarSource(sourceOptions);
    this.#managedSource =
      createProjectEnvironmentRuntimeSidecarSource(sourceOptions);
    if (
      sha256(this.#vanillaSource) !==
        options.managedRuntime.capability.vanillaSidecarSourceSha256 ||
      sha256(this.#managedSource) !==
        options.managedRuntime.capability.projectEnvironmentSidecarSourceSha256
    ) {
      throw new TypeError(
        "PE sidecar sources do not match the runtime binding",
      );
    }
  }

  public async runVanilla(
    input: GodotProjectEnvironmentVanillaSmokeLaunchV1,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly kind: "completed";
        readonly result: ProjectEnvironmentVanillaSmokeResultV1;
      }
    | Extract<SandboxExecutionResultV1, { readonly kind: "denied" }>
  > {
    const launch = GodotProjectEnvironmentVanillaSmokeLaunchV1Schema.parse({
      ...input,
      managedRuntimeId: this.options.managedRuntime.capability.managedRuntimeId,
    });
    const stdin = encodeWireFrame(JSON.stringify(launch));
    const parser = this.parser(
      launch,
      GodotLifecycleVanillaSmokeDiagnosticV1Schema,
    );
    const abort = new AbortController();
    let parserError: unknown;
    const result = await this.options.broker.execute(
      {
        schemaVersion: 1,
        operationId: `pe-vanilla:${sha256(
          `${launch.taskId}\0${launch.executionId}`,
        ).slice(0, 24)}`,
        profile: "godot-headless",
        argv: [
          this.options.managedRuntime.capability.nodeTarget,
          "--input-type=commonjs",
          "--eval",
          this.#vanillaSource,
        ],
        cwd: "/workspace",
        environment: {},
        stdin: {
          byteLength: stdin.byteLength,
          sha256: asSha256DigestV1(sha256(stdin)),
        },
        timeoutMs: Math.min(
          600_000,
          launch.importTimeoutMs + launch.vanillaTimeoutMs + 5_000,
        ),
      },
      {
        signal:
          signal === undefined
            ? abort.signal
            : AbortSignal.any([signal, abort.signal]),
        stdin,
        onStderrChunk: (chunk) => {
          try {
            parser.push(chunk);
          } catch (error) {
            parserError = error;
            abort.abort(error);
          }
        },
      },
    );
    if (result.kind === "denied") return result;
    if (parserError !== undefined) {
      throw parserError instanceof Error
        ? parserError
        : new Error("PE vanilla diagnostic parser failed");
    }
    parser.end();
    return {
      kind: "completed",
      result: { sandbox: result, diagnostics: parser.records() },
    };
  }

  public async openManaged(
    input: GodotProjectEnvironmentSidecarLaunchV1,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly kind: "opened";
        readonly sidecar: SandboxedGodotProjectEnvironmentSidecarV1;
      }
    | SandboxExecutionResultV1
  > {
    const launch = GodotProjectEnvironmentSidecarLaunchV1Schema.parse({
      ...input,
      managedRuntimeId: this.options.managedRuntime.capability.managedRuntimeId,
      overlayHash: this.options.managedRuntime.capability.overlayHash,
      addonHash: this.options.managedRuntime.capability.addonHash,
    });
    const request: SandboxExecutionRequestV1 = {
      schemaVersion: 1,
      operationId: `pe-managed:${sha256(
        `${launch.taskId}\0${launch.executionId}\0${launch.instrumentationMode}`,
      ).slice(0, 24)}`,
      profile: "godot-headless",
      argv: [
        this.options.managedRuntime.capability.nodeTarget,
        "--input-type=commonjs",
        "--eval",
        this.#managedSource,
      ],
      cwd: "/workspace",
      environment: {},
      timeoutMs: Math.min(
        600_000,
        launch.importTimeoutMs + launch.executionTimeoutMs + 5_000,
      ),
    };
    const readable = new PassThrough();
    readable.on("error", () => undefined);
    const parser = this.parser(launch, GodotLifecycleSidecarDiagnosticV1Schema);
    const callback: { handle?: SandboxDuplexHandleV1 } = {};
    let failure: unknown;
    const fail = (error: unknown): void => {
      if (failure !== undefined) return;
      failure = error;
      readable.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
      void callback.handle?.terminate().catch(() => undefined);
    };
    const opened = await this.options.broker.openDuplex(request, {
      ...(signal === undefined ? {} : { signal }),
      onStdoutChunk: async (chunk) => {
        if (!readable.write(chunk)) await once(readable, "drain");
      },
      onStderrChunk: (chunk) => {
        try {
          parser.push(chunk);
        } catch (error) {
          fail(error);
        }
      },
    });
    if (opened.kind !== "opened") {
      readable.end();
      return opened;
    }
    callback.handle = opened.handle;
    try {
      await opened.handle.write(encodeWireFrame(JSON.stringify(launch)));
    } catch (error) {
      fail(error);
      await opened.handle.terminate();
      return opened.handle.completion;
    }
    const completion = opened.handle.completion.then((result) => {
      try {
        parser.end();
      } catch (error) {
        fail(error);
      }
      if (failure === undefined) readable.end();
      return result;
    });
    const transport: GodotByteTransport = {
      readable,
      write: (bytes) => opened.handle.write(bytes),
      close: () => opened.handle.endInput(),
    };
    return {
      kind: "opened",
      sidecar: Object.freeze({
        transport,
        completion,
        diagnostics: () => parser.records(),
        terminate: () => opened.handle.terminate(),
      }),
    };
  }

  private parser<T>(
    launch: {
      readonly diagnosticFrameMaxBytes: number;
      readonly diagnosticTotalMaxBytes: number;
      readonly diagnosticMaxCount: number;
    },
    schema: z.ZodType<T>,
  ): DiagnosticFramesV1<T> {
    return new DiagnosticFramesV1(
      {
        frameMaxBytes: launch.diagnosticFrameMaxBytes,
        totalMaxBytes: launch.diagnosticTotalMaxBytes,
        maxCount: launch.diagnosticMaxCount,
      },
      (value) => schema.parse(value),
    );
  }
}
