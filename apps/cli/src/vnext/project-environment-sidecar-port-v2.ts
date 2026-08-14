import { createHash } from "node:crypto";
import { once } from "node:events";
import { PassThrough } from "node:stream";

import { asSha256DigestV1 } from "@chronorift/domain";
import {
  createProjectEnvironmentRuntimeSidecarSourceV2,
  createProjectEnvironmentVanillaSmokeSidecarSourceV2,
  type GodotByteTransport,
  type LifecycleSidecarSourceOptions,
} from "@chronorift/godot-adapter";
import {
  GodotLifecycleSidecarDiagnosticV1Schema,
  GodotLifecycleVanillaSmokeDiagnosticV1Schema,
  GodotProjectEnvironmentSidecarLaunchV2Schema,
  GodotProjectEnvironmentVanillaSmokeLaunchV2Schema,
  encodeWireFrame,
  type GodotLifecycleSidecarDiagnosticV1,
  type GodotProjectEnvironmentSidecarLaunchV2,
  type GodotProjectEnvironmentVanillaSmokeLaunchV2,
} from "@chronorift/godot-protocol";

import type { SandboxExecutionRequestV1 } from "./contracts.js";
import {
  assertManagedGodotProjectEnvironmentRuntimeBindingV2,
  type ManagedGodotProjectEnvironmentRuntimeBindingV2,
  type ManagedGodotProjectEnvironmentRuntimeCapabilityV2,
} from "./managed-godot-project-environment-runtime-v2.js";
import type {
  DuplexTaskSandboxBrokerV1,
  SandboxDuplexHandleV1,
  SandboxExecutionResultV1,
} from "./sandbox-broker.js";

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
class Frames<T> {
  #buffer = Buffer.alloc(0);
  readonly #records: T[] = [];
  public constructor(private readonly parse: (value: unknown) => T) {}
  public push(chunk: Uint8Array): void {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (
        length < 1 ||
        length > 1024 * 1024 ||
        this.#buffer.byteLength < length + 4
      )
        return;
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
    if (this.#buffer.byteLength !== 0)
      throw new Error("V2 sidecar diagnostics ended partially");
  }
  public records(): readonly T[] {
    return Object.freeze([...this.#records]);
  }
}

export interface SandboxedGodotProjectEnvironmentSidecarV2 {
  readonly transport: GodotByteTransport;
  readonly completion: Promise<SandboxExecutionResultV1>;
  diagnostics(): readonly GodotLifecycleSidecarDiagnosticV1[];
  terminate(): Promise<void>;
}

export class GodotProjectEnvironmentSidecarPortV2 {
  readonly #vanillaSource: string;
  readonly #managedSource: string;
  public constructor(
    private readonly options: {
      readonly broker: Pick<
        DuplexTaskSandboxBrokerV1,
        "execute" | "openDuplex"
      >;
      readonly managedRuntime: {
        readonly capability: ManagedGodotProjectEnvironmentRuntimeCapabilityV2;
        readonly binding: ManagedGodotProjectEnvironmentRuntimeBindingV2;
      };
      readonly sourceOptions?: LifecycleSidecarSourceOptions | undefined;
    },
  ) {
    assertManagedGodotProjectEnvironmentRuntimeBindingV2(
      options.managedRuntime.capability,
      options.managedRuntime.binding,
    );
    const sourceOptions = options.sourceOptions ?? {
      godotExecutable: options.managedRuntime.capability.godotTarget,
      workspaceRoot: "/workspace",
      runtimeRoot: "/run/chronorift",
    };
    this.#vanillaSource =
      createProjectEnvironmentVanillaSmokeSidecarSourceV2(sourceOptions);
    this.#managedSource =
      createProjectEnvironmentRuntimeSidecarSourceV2(sourceOptions);
    if (
      sha256(this.#vanillaSource) !==
        options.managedRuntime.capability.vanillaSidecarSourceSha256 ||
      sha256(this.#managedSource) !==
        options.managedRuntime.capability.projectEnvironmentSidecarSourceSha256
    )
      throw new TypeError("PE-B sidecar sources do not match runtime binding");
  }

  public async runVanilla(
    input: GodotProjectEnvironmentVanillaSmokeLaunchV2,
    signal?: AbortSignal,
  ) {
    const launch = GodotProjectEnvironmentVanillaSmokeLaunchV2Schema.parse({
      ...input,
      managedRuntimeId: this.options.managedRuntime.capability.managedRuntimeId,
    });
    const stdin = encodeWireFrame(JSON.stringify(launch));
    const parser = new Frames((value) =>
      GodotLifecycleVanillaSmokeDiagnosticV1Schema.parse(value),
    );
    const result = await this.options.broker.execute(
      {
        schemaVersion: 1,
        operationId: `peb-vanilla:${sha256(`${launch.taskId}\0${launch.executionId}`).slice(0, 24)}`,
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
        ...(signal === undefined ? {} : { signal }),
        stdin,
        onStderrChunk: (chunk) => parser.push(chunk),
      },
    );
    if (result.kind === "denied") return result;
    parser.end();
    return {
      kind: "completed" as const,
      result: { sandbox: result, diagnostics: parser.records() },
    };
  }

  public async openManaged(
    input: GodotProjectEnvironmentSidecarLaunchV2,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly kind: "opened";
        readonly sidecar: SandboxedGodotProjectEnvironmentSidecarV2;
      }
    | SandboxExecutionResultV1
  > {
    const launch = GodotProjectEnvironmentSidecarLaunchV2Schema.parse({
      ...input,
      managedRuntimeId: this.options.managedRuntime.capability.managedRuntimeId,
      overlayHash: this.options.managedRuntime.capability.overlayHash,
      addonHash: this.options.managedRuntime.capability.addonHash,
    });
    const request: SandboxExecutionRequestV1 = {
      schemaVersion: 1,
      operationId: `peb-managed:${sha256(`${launch.taskId}\0${launch.executionId}\0${launch.instrumentationMode}`).slice(0, 24)}`,
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
    const parser = new Frames((value) =>
      GodotLifecycleSidecarDiagnosticV1Schema.parse(value),
    );
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
    return {
      kind: "opened",
      sidecar: Object.freeze({
        transport: {
          readable,
          write: (bytes: Uint8Array) => opened.handle.write(bytes),
          close: () => opened.handle.endInput(),
        },
        completion,
        diagnostics: () => parser.records(),
        terminate: () => opened.handle.terminate(),
      }),
    };
  }
}
