import { createHash } from "node:crypto";
import { once } from "node:events";
import { PassThrough } from "node:stream";

import { asSha256DigestV1 } from "@chronorift/domain";
import {
  createSemanticRuntimeSidecarSource,
  createSemanticVanillaSmokeSidecarSource,
  type GodotByteTransport,
  type LifecycleSidecarSourceOptions,
} from "@chronorift/godot-adapter";
import {
  GodotSemanticSidecarDiagnosticV1Schema,
  GodotSemanticSidecarLaunchV1Schema,
  GodotSemanticVanillaSmokeDiagnosticV1Schema,
  GodotSemanticVanillaSmokeLaunchV1Schema,
  encodeWireFrame,
  type GodotSemanticSidecarDiagnosticV1,
  type GodotSemanticSidecarLaunchV1,
  type GodotSemanticVanillaSmokeDiagnosticV1,
  type GodotSemanticVanillaSmokeLaunchV1,
} from "@chronorift/godot-protocol";
import type { z } from "zod";

import type { SandboxExecutionRequestV1 } from "./contracts.js";
import {
  assertManagedGodotSemanticRuntimeBinding,
  type ManagedGodotSemanticRuntimeBindingV1,
  type ManagedGodotSemanticRuntimeCapabilityV1,
} from "./managed-godot-semantic-runtime.js";
import type {
  DuplexTaskSandboxBrokerV1,
  SandboxDuplexHandleV1,
  SandboxExecutionResultV1,
} from "./sandbox-broker.js";

const sha256 = (bytes: Uint8Array | string) =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

class SemanticDiagnosticFramesV1<T> {
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
      throw new Error("semantic sidecar diagnostic stream continued after end");
    }
    if (chunk.byteLength === 0) return;
    if (
      this.#encodedByteLength + chunk.byteLength >
      this.limits.totalMaxBytes
    ) {
      throw new Error(
        "semantic sidecar diagnostics exceeded the total byte bound",
      );
    }
    this.#encodedByteLength += chunk.byteLength;
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    for (;;) {
      if (this.#buffer.byteLength < 4) break;
      const length = this.#buffer.readUInt32BE(0);
      if (length < 1 || length > this.limits.frameMaxBytes) {
        throw new Error(
          "semantic sidecar diagnostic frame has an invalid size",
        );
      }
      if (this.#buffer.byteLength < length + 4) break;
      this.#frameCount += 1;
      if (this.#frameCount > this.limits.maxCount) {
        throw new Error(
          "semantic sidecar diagnostics exceeded the frame count bound",
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
        throw new Error("semantic sidecar diagnostic frame is not UTF-8 JSON", {
          cause: error,
        });
      }
      this.accept(this.parse(value));
    }
  }

  public end(): void {
    this.#ended = true;
    if (this.#buffer.byteLength !== 0) {
      throw new Error(
        "semantic sidecar diagnostics ended with a partial frame",
      );
    }
  }

  public facts(failure: Error | undefined): SemanticDiagnosticFactsV1<T> {
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

export interface SemanticDiagnosticFactsV1<T> {
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

export interface SemanticVanillaSmokeResultV1 {
  readonly sandbox: Extract<
    SandboxExecutionResultV1,
    { readonly kind: "executed" }
  >;
  readonly diagnostics: readonly GodotSemanticVanillaSmokeDiagnosticV1[];
  readonly diagnosticFacts: SemanticDiagnosticFactsV1<GodotSemanticVanillaSmokeDiagnosticV1>;
}

export type RunSemanticVanillaSmokeResultV1 =
  | {
      readonly kind: "completed";
      readonly result: SemanticVanillaSmokeResultV1;
    }
  | Extract<SandboxExecutionResultV1, { readonly kind: "denied" }>;

export interface SandboxedGodotSemanticSidecarV1 {
  readonly transport: GodotByteTransport;
  readonly completion: Promise<SandboxExecutionResultV1>;
  diagnostics(): readonly GodotSemanticSidecarDiagnosticV1[];
  diagnosticFacts(): SemanticDiagnosticFactsV1<GodotSemanticSidecarDiagnosticV1>;
  terminate(): Promise<void>;
}

export type OpenSandboxedGodotSemanticSidecarResultV1 =
  | {
      readonly kind: "opened";
      readonly sidecar: SandboxedGodotSemanticSidecarV1;
    }
  | SandboxExecutionResultV1;

export interface GodotSemanticSidecarPortOptionsV1 {
  readonly broker: Pick<DuplexTaskSandboxBrokerV1, "execute" | "openDuplex">;
  readonly managedRuntime: {
    readonly capability: ManagedGodotSemanticRuntimeCapabilityV1;
    readonly binding: ManagedGodotSemanticRuntimeBindingV1;
  };
  readonly sourceOptions?: LifecycleSidecarSourceOptions | undefined;
}

const parserFor =
  <T>(schema: z.ZodType<T>) =>
  (value: unknown): T =>
    schema.parse(value);

export class GodotSemanticSidecarPortV1 {
  readonly #vanillaSource: string;
  readonly #semanticSource: string;

  public constructor(
    private readonly options: GodotSemanticSidecarPortOptionsV1,
  ) {
    assertManagedGodotSemanticRuntimeBinding(
      options.managedRuntime.capability,
      options.managedRuntime.binding,
    );
    const sourceOptions = options.sourceOptions ?? {
      godotExecutable: options.managedRuntime.capability.godotTarget,
      workspaceRoot: "/workspace",
      runtimeRoot: "/run/chronorift",
    };
    this.#vanillaSource =
      createSemanticVanillaSmokeSidecarSource(sourceOptions);
    this.#semanticSource = createSemanticRuntimeSidecarSource(sourceOptions);
    if (
      sha256(Buffer.from(this.#vanillaSource, "utf8")) !==
        options.managedRuntime.capability.vanillaSidecarSourceSha256 ||
      sha256(Buffer.from(this.#semanticSource, "utf8")) !==
        options.managedRuntime.capability.semanticSidecarSourceSha256
    ) {
      throw new TypeError(
        "semantic sidecar source no longer matches the managed capability",
      );
    }
  }

  public async runVanillaSmoke(
    launchInput: GodotSemanticVanillaSmokeLaunchV1,
    signal?: AbortSignal,
  ): Promise<RunSemanticVanillaSmokeResultV1> {
    assertManagedGodotSemanticRuntimeBinding(
      this.options.managedRuntime.capability,
      this.options.managedRuntime.binding,
    );
    const launch = GodotSemanticVanillaSmokeLaunchV1Schema.parse({
      ...launchInput,
      managedRuntimeId: this.options.managedRuntime.capability.managedRuntimeId,
    });
    const stdin = encodeWireFrame(JSON.stringify(launch));
    const request: SandboxExecutionRequestV1 = {
      schemaVersion: 1,
      operationId: `semantic-vanilla:${sha256(
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
    const records: GodotSemanticVanillaSmokeDiagnosticV1[] = [];
    let parserFailure: Error | undefined;
    const diagnosticAbort = new AbortController();
    const executionSignal =
      signal === undefined
        ? diagnosticAbort.signal
        : AbortSignal.any([signal, diagnosticAbort.signal]);
    const parser = new SemanticDiagnosticFramesV1(
      {
        frameMaxBytes: launch.diagnosticFrameMaxBytes,
        totalMaxBytes: launch.diagnosticTotalMaxBytes,
        maxCount: launch.diagnosticMaxCount,
      },
      parserFor(GodotSemanticVanillaSmokeDiagnosticV1Schema),
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
    launchInput: GodotSemanticSidecarLaunchV1,
    signal?: AbortSignal,
  ): Promise<OpenSandboxedGodotSemanticSidecarResultV1> {
    assertManagedGodotSemanticRuntimeBinding(
      this.options.managedRuntime.capability,
      this.options.managedRuntime.binding,
    );
    const launch = GodotSemanticSidecarLaunchV1Schema.parse({
      ...launchInput,
      managedRuntimeId: this.options.managedRuntime.capability.managedRuntimeId,
      overlayHash: this.options.managedRuntime.capability.overlayHash,
      addonHash: this.options.managedRuntime.capability.addonHash,
    });
    const request: SandboxExecutionRequestV1 = {
      schemaVersion: 1,
      operationId: `semantic-managed:${sha256(
        `${launch.taskId}\0${launch.runtimeId}\0${launch.executionId}`,
      ).slice(0, 24)}`,
      profile: "godot-headless",
      argv: [
        this.options.managedRuntime.capability.nodeTarget,
        "--input-type=commonjs",
        "--eval",
        this.#semanticSource,
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
    const records: GodotSemanticSidecarDiagnosticV1[] = [];
    const callbackState: { handle?: SandboxDuplexHandleV1 } = {};
    let parserFailure: Error | undefined;
    let parserEnded = false;
    const parser = new SemanticDiagnosticFramesV1(
      {
        frameMaxBytes: launch.diagnosticFrameMaxBytes,
        totalMaxBytes: launch.diagnosticTotalMaxBytes,
        maxCount: launch.diagnosticMaxCount,
      },
      parserFor(GodotSemanticSidecarDiagnosticV1Schema),
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
          "semantic sidecar cleanup completion failed",
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
