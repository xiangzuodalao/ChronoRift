import { createHash } from "node:crypto";
import { once } from "node:events";
import { PassThrough } from "node:stream";

import { asSha256DigestV1 } from "@chronorift/domain";
import {
  createLifecycleRuntimeSidecarSource,
  createLifecycleVanillaSmokeSidecarSource,
  type GodotByteTransport,
  type LifecycleSidecarSourceOptions,
} from "@chronorift/godot-adapter";
import {
  GodotLifecycleSidecarDiagnosticV1Schema,
  GodotLifecycleSidecarLaunchV1Schema,
  GodotLifecycleVanillaSmokeDiagnosticV1Schema,
  GodotLifecycleVanillaSmokeLaunchV1Schema,
  encodeWireFrame,
  type GodotLifecycleSidecarDiagnosticV1,
  type GodotLifecycleSidecarLaunchV1,
  type GodotLifecycleVanillaSmokeDiagnosticV1,
  type GodotLifecycleVanillaSmokeLaunchV1,
} from "@chronorift/godot-protocol";
import type { z } from "zod";

import type { SandboxExecutionRequestV1 } from "./contracts.js";
import {
  assertManagedGodotLifecycleRuntimeBinding,
  type ManagedGodotLifecycleRuntimeBindingV1,
  type ManagedGodotLifecycleRuntimeCapabilityV1,
} from "./managed-godot-lifecycle-runtime.js";
import type {
  DuplexTaskSandboxBrokerV1,
  SandboxDuplexHandleV1,
  SandboxExecutionResultV1,
} from "./sandbox-broker.js";

const sha256 = (bytes: Uint8Array | string) =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

class LifecycleDiagnosticFramesV1<T> {
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
    private readonly parse: (value: unknown) => T,
    private readonly accept: (value: T) => void,
  ) {}

  public push(chunk: Uint8Array): void {
    if (this.#ended) {
      throw new Error(
        "lifecycle sidecar diagnostic stream continued after end",
      );
    }
    if (chunk.byteLength === 0) return;
    if (
      this.#encodedByteLength + chunk.byteLength >
      this.limits.totalMaxBytes
    ) {
      throw new Error(
        "lifecycle sidecar diagnostics exceeded the total byte bound",
      );
    }
    this.#encodedByteLength += chunk.byteLength;
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    for (;;) {
      if (this.#buffer.byteLength < 4) break;
      const length = this.#buffer.readUInt32BE(0);
      if (length < 1 || length > this.limits.frameMaxBytes) {
        throw new Error(
          "lifecycle sidecar diagnostic frame has an invalid size",
        );
      }
      if (this.#buffer.byteLength < length + 4) break;
      this.#frameCount += 1;
      if (this.#frameCount > this.limits.maxCount) {
        throw new Error(
          "lifecycle sidecar diagnostics exceeded the frame count bound",
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
        throw new Error(
          "lifecycle sidecar diagnostic frame is not UTF-8 JSON",
          { cause: error },
        );
      }
      this.accept(this.parse(value));
    }
  }

  public end(): void {
    this.#ended = true;
    if (this.#buffer.byteLength !== 0) {
      throw new Error(
        "lifecycle sidecar diagnostics ended with a partial frame",
      );
    }
  }

  public facts(failure: Error | undefined): LifecycleDiagnosticFactsV1<T> {
    return Object.freeze({
      schemaVersion: 1 as const,
      status:
        failure !== undefined
          ? ("failed" as const)
          : this.#ended
            ? ("complete" as const)
            : ("open" as const),
      records: Object.freeze([]),
      frameCount: this.#frameCount,
      encodedByteLength: this.#encodedByteLength,
      limits: this.limits,
      failure:
        failure === undefined
          ? null
          : {
              code: "diagnostic_protocol_failure" as const,
              message: failure.message.slice(0, 4_096),
            },
    });
  }
}

export interface LifecycleDiagnosticFactsV1<T> {
  readonly schemaVersion: 1;
  readonly status: "open" | "complete" | "failed";
  readonly records: readonly T[];
  readonly frameCount: number;
  readonly encodedByteLength: number;
  readonly limits: {
    readonly frameMaxBytes: number;
    readonly totalMaxBytes: number;
    readonly maxCount: number;
  };
  readonly failure: {
    readonly code: "diagnostic_protocol_failure";
    readonly message: string;
  } | null;
}

export interface LifecycleVanillaSmokeResultV1 {
  readonly sandbox: Extract<
    SandboxExecutionResultV1,
    { readonly kind: "executed" }
  >;
  readonly diagnostics: readonly GodotLifecycleVanillaSmokeDiagnosticV1[];
  readonly diagnosticFacts: LifecycleDiagnosticFactsV1<GodotLifecycleVanillaSmokeDiagnosticV1>;
}

export type RunLifecycleVanillaSmokeResultV1 =
  | {
      readonly kind: "completed";
      readonly result: LifecycleVanillaSmokeResultV1;
    }
  | Extract<SandboxExecutionResultV1, { readonly kind: "denied" }>;

export interface SandboxedGodotLifecycleSidecarV1 {
  readonly transport: GodotByteTransport;
  readonly completion: Promise<SandboxExecutionResultV1>;
  diagnostics(): readonly GodotLifecycleSidecarDiagnosticV1[];
  diagnosticFacts(): LifecycleDiagnosticFactsV1<GodotLifecycleSidecarDiagnosticV1>;
  terminate(): Promise<void>;
}

export type OpenSandboxedGodotLifecycleSidecarResultV1 =
  | {
      readonly kind: "opened";
      readonly sidecar: SandboxedGodotLifecycleSidecarV1;
    }
  | SandboxExecutionResultV1;

export interface GodotLifecycleSidecarPortOptionsV1 {
  readonly broker: Pick<DuplexTaskSandboxBrokerV1, "execute" | "openDuplex">;
  readonly managedRuntime: {
    readonly capability: ManagedGodotLifecycleRuntimeCapabilityV1;
    readonly binding: ManagedGodotLifecycleRuntimeBindingV1;
  };
  readonly sourceOptions?: LifecycleSidecarSourceOptions | undefined;
}

const parserFor =
  <T>(schema: z.ZodType<T>) =>
  (value: unknown): T =>
    schema.parse(value);

export class GodotLifecycleSidecarPortV1 {
  readonly #vanillaSource: string;
  readonly #lifecycleSource: string;

  public constructor(
    private readonly options: GodotLifecycleSidecarPortOptionsV1,
  ) {
    assertManagedGodotLifecycleRuntimeBinding(
      options.managedRuntime.capability,
      options.managedRuntime.binding,
    );
    const sourceOptions = options.sourceOptions ?? {
      godotExecutable: options.managedRuntime.capability.godotTarget,
      workspaceRoot: "/workspace",
      runtimeRoot: "/run/chronorift",
    };
    this.#vanillaSource =
      createLifecycleVanillaSmokeSidecarSource(sourceOptions);
    this.#lifecycleSource = createLifecycleRuntimeSidecarSource(sourceOptions);
    if (
      sha256(Buffer.from(this.#vanillaSource, "utf8")) !==
        options.managedRuntime.capability.vanillaSidecarSourceSha256 ||
      sha256(Buffer.from(this.#lifecycleSource, "utf8")) !==
        options.managedRuntime.capability.lifecycleSidecarSourceSha256
    ) {
      throw new TypeError(
        "lifecycle sidecar source no longer matches the managed capability",
      );
    }
  }

  public async runVanillaSmoke(
    launchInput: GodotLifecycleVanillaSmokeLaunchV1,
    signal?: AbortSignal,
  ): Promise<RunLifecycleVanillaSmokeResultV1> {
    assertManagedGodotLifecycleRuntimeBinding(
      this.options.managedRuntime.capability,
      this.options.managedRuntime.binding,
    );
    const launch = GodotLifecycleVanillaSmokeLaunchV1Schema.parse({
      ...launchInput,
      managedRuntimeId: this.options.managedRuntime.capability.managedRuntimeId,
    });
    const stdin = encodeWireFrame(JSON.stringify(launch));
    const request: SandboxExecutionRequestV1 = {
      schemaVersion: 1,
      operationId: `lifecycle-vanilla:${sha256(
        `${launch.taskId}\0${launch.runtimeId}\0${launch.executionId}`,
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
      stdin: { byteLength: stdin.byteLength, sha256: sha256(stdin) },
      timeoutMs: Math.min(
        600_000,
        launch.importTimeoutMs + launch.vanillaTimeoutMs + 5_000,
      ),
    };
    const records: GodotLifecycleVanillaSmokeDiagnosticV1[] = [];
    let parserFailure: Error | undefined;
    const diagnosticAbort = new AbortController();
    const executionSignal =
      signal === undefined
        ? diagnosticAbort.signal
        : AbortSignal.any([signal, diagnosticAbort.signal]);
    const parser = new LifecycleDiagnosticFramesV1(
      {
        frameMaxBytes: launch.diagnosticFrameMaxBytes,
        totalMaxBytes: launch.diagnosticTotalMaxBytes,
        maxCount: launch.diagnosticMaxCount,
      },
      parserFor(GodotLifecycleVanillaSmokeDiagnosticV1Schema),
      (record) => records.push(record),
    );
    const executed = await this.options.broker.execute(request, {
      signal: executionSignal,
      stdin,
      onStderrChunk: (chunk) => {
        if (parserFailure !== undefined) return;
        try {
          parser.push(chunk);
        } catch (error) {
          parserFailure =
            error instanceof Error ? error : new Error(String(error));
          diagnosticAbort.abort(parserFailure);
        }
      },
    });
    if (executed.kind === "denied") return executed;
    try {
      parser.end();
    } catch (error) {
      parserFailure ??=
        error instanceof Error ? error : new Error(String(error));
    }
    const facts = {
      ...parser.facts(parserFailure),
      records: Object.freeze([...records]),
    };
    return {
      kind: "completed",
      result: {
        sandbox: executed,
        diagnostics: Object.freeze([...records]),
        diagnosticFacts: Object.freeze(facts),
      },
    };
  }

  public async openManaged(
    launchInput: GodotLifecycleSidecarLaunchV1,
    signal?: AbortSignal,
  ): Promise<OpenSandboxedGodotLifecycleSidecarResultV1> {
    assertManagedGodotLifecycleRuntimeBinding(
      this.options.managedRuntime.capability,
      this.options.managedRuntime.binding,
    );
    const launch = GodotLifecycleSidecarLaunchV1Schema.parse({
      ...launchInput,
      managedRuntimeId: this.options.managedRuntime.capability.managedRuntimeId,
      overlayHash: this.options.managedRuntime.capability.overlayHash,
      addonHash: this.options.managedRuntime.capability.addonHash,
    });
    const request: SandboxExecutionRequestV1 = {
      schemaVersion: 1,
      operationId: `lifecycle-managed:${sha256(
        `${launch.taskId}\0${launch.runtimeId}\0${launch.executionId}`,
      ).slice(0, 24)}`,
      profile: "godot-headless",
      argv: [
        this.options.managedRuntime.capability.nodeTarget,
        "--input-type=commonjs",
        "--eval",
        this.#lifecycleSource,
      ],
      cwd: "/workspace",
      environment: {},
      timeoutMs: Math.min(600_000, launch.executionTimeoutMs + 5_000),
    };
    const readable = new PassThrough();
    readable.on("error", () => undefined);
    const records: GodotLifecycleSidecarDiagnosticV1[] = [];
    const callbackState: { handle?: SandboxDuplexHandleV1 } = {};
    let parserFailure: Error | undefined;
    let parserEnded = false;
    const parser = new LifecycleDiagnosticFramesV1(
      {
        frameMaxBytes: launch.diagnosticFrameMaxBytes,
        totalMaxBytes: launch.diagnosticTotalMaxBytes,
        maxCount: launch.diagnosticMaxCount,
      },
      parserFor(GodotLifecycleSidecarDiagnosticV1Schema),
      (record) => records.push(record),
    );
    const failCallback = (error: unknown): void => {
      if (parserFailure !== undefined) return;
      parserFailure = error instanceof Error ? error : new Error(String(error));
      readable.destroy(parserFailure);
      void callbackState.handle?.terminate().catch(() => undefined);
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
    const terminateAndObserve = async (): Promise<SandboxExecutionResultV1> => {
      let terminateError: unknown;
      try {
        await handle.terminate();
      } catch (error) {
        terminateError = error;
      }
      try {
        return await handle.completion;
      } catch (completionError) {
        throw new AggregateError(
          terminateError === undefined
            ? [completionError]
            : [terminateError, completionError],
          "lifecycle sidecar cleanup completion failed",
        );
      }
    };
    if (parserFailure !== undefined) return terminateAndObserve();
    try {
      await handle.write(encodeWireFrame(JSON.stringify(launch)));
    } catch {
      readable.destroy();
      return terminateAndObserve();
    }
    if (parserFailure !== undefined) return terminateAndObserve();
    const completion = handle.completion.then((result) => {
      try {
        parser.end();
        parserEnded = true;
      } catch (error) {
        failCallback(error);
      }
      if (parserFailure === undefined) readable.end();
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
        diagnostics: () => Object.freeze([...records]),
        diagnosticFacts: () => {
          const facts = {
            ...parser.facts(parserFailure),
            status:
              parserFailure !== undefined
                ? ("failed" as const)
                : parserEnded
                  ? ("complete" as const)
                  : ("open" as const),
            records: Object.freeze([...records]),
          };
          return Object.freeze(facts);
        },
        terminate: () => handle.terminate(),
      }),
    };
  }
}
