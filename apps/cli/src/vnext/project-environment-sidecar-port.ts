import { once } from "node:events";
import { dirname, join } from "node:path";
import { PassThrough, type Writable } from "node:stream";

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

import type {
  GodotValidationOverlayFile,
  GodotValidationStage,
} from "./godot-validation-stage.js";
import {
  assertManagedGodotProjectEnvironmentRuntimeBinding,
  type ManagedGodotProjectEnvironmentRuntimeBindingV1,
  type ManagedGodotProjectEnvironmentRuntimeCapabilityV1,
} from "./managed-godot-project-environment-runtime.js";
import type {
  SrtGodotProcessResult,
  SrtGodotRunner,
} from "./srt-godot-runner.js";

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

export interface ProjectEnvironmentSidecarDeniedV1 {
  readonly kind: "denied";
  readonly [key: string]: unknown;
}

export type ProjectEnvironmentSidecarExecutionResultV1 =
  | {
      readonly kind: "executed";
      readonly process: SrtGodotProcessResult;
    }
  | ProjectEnvironmentSidecarDeniedV1;

export interface ProjectEnvironmentVanillaSmokeResultV1 {
  readonly sandbox: Extract<
    ProjectEnvironmentSidecarExecutionResultV1,
    { readonly kind: "executed" }
  >;
  readonly diagnostics: readonly GodotLifecycleVanillaSmokeDiagnosticV1[];
}

export interface SandboxedGodotProjectEnvironmentSidecarV1 {
  readonly transport: GodotByteTransport;
  readonly completion: Promise<ProjectEnvironmentSidecarExecutionResultV1>;
  diagnostics(): readonly GodotLifecycleSidecarDiagnosticV1[];
  terminate(): Promise<void>;
}

const asBytes = (chunk: Buffer | string): Uint8Array =>
  typeof chunk === "string" ? Buffer.from(chunk) : chunk;

const writeBytes = async (
  stream: Writable,
  bytes: Uint8Array,
): Promise<void> => {
  if (!stream.write(bytes)) await once(stream, "drain");
};

const endInput = async (stream: Writable, bytes?: Uint8Array): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      stream.off("error", onError);
      reject(error);
    };
    stream.once("error", onError);
    stream.end(bytes, () => {
      stream.off("error", onError);
      resolve();
    });
  });

const sourceOptions = (
  stage: GodotValidationStage,
  godotPath: string,
): LifecycleSidecarSourceOptions => ({
  godotExecutable: godotPath,
  workspaceRoot: stage.projectStagePath,
  runtimeRoot: stage.tempPath,
  preStagedProject: true,
  fontconfigFile: "/etc/fonts/fonts.conf",
});

const managedOverlays = (
  binding: ManagedGodotProjectEnvironmentRuntimeBindingV1,
): readonly GodotValidationOverlayFile[] => [
  ...binding.addonFiles.map((file) => ({
    relativePath: join(
      "addons",
      "chronorift_project_environment",
      file.relativePath,
    ),
    bytes: Uint8Array.from(file.bytes),
  })),
  ...binding.adapterFiles.map((file) => ({
    relativePath: join(".chronorift", "project-adapter", file.relativePath),
    bytes: Uint8Array.from(file.bytes),
  })),
  {
    relativePath: "override.cfg",
    bytes: Uint8Array.from(binding.overlayBytes),
  },
];

export class GodotProjectEnvironmentSidecarPortV1 {
  readonly #overlayFiles: readonly GodotValidationOverlayFile[];

  public constructor(
    private readonly options: {
      readonly runner: Pick<SrtGodotRunner, "open">;
      readonly nodePath: string;
      readonly godotPath: string;
      readonly managedRuntime: {
        readonly capability: ManagedGodotProjectEnvironmentRuntimeCapabilityV1;
        readonly binding: ManagedGodotProjectEnvironmentRuntimeBindingV1;
      };
    },
  ) {
    assertManagedGodotProjectEnvironmentRuntimeBinding(
      options.managedRuntime.capability,
      options.managedRuntime.binding,
    );
    this.#overlayFiles = managedOverlays(options.managedRuntime.binding);
  }

  public async runVanilla(
    input: GodotProjectEnvironmentVanillaSmokeLaunchV1,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly kind: "completed";
        readonly result: ProjectEnvironmentVanillaSmokeResultV1;
      }
    | ProjectEnvironmentSidecarDeniedV1
  > {
    const launch = GodotProjectEnvironmentVanillaSmokeLaunchV1Schema.parse({
      ...input,
      managedRuntimeId: this.options.managedRuntime.capability.managedRuntimeId,
    });
    const parser = this.parser(
      launch,
      GodotLifecycleVanillaSmokeDiagnosticV1Schema,
    );
    const opened = await this.options.runner.open({
      argv: (stage) => [
        this.options.nodePath,
        "--input-type=commonjs",
        "--eval",
        createProjectEnvironmentVanillaSmokeSidecarSource(
          sourceOptions(stage, this.options.godotPath),
        ),
      ],
      timeoutMs: Math.min(
        600_000,
        launch.importTimeoutMs + launch.vanillaTimeoutMs + 5_000,
      ),
      readOnlyPaths: [
        dirname(this.options.nodePath),
        dirname(this.options.godotPath),
      ],
      ...(signal === undefined ? {} : { signal }),
    });

    let parserError: unknown;
    opened.process.stderr.on("data", (chunk: Buffer | string) => {
      try {
        parser.push(asBytes(chunk));
      } catch (error) {
        if (parserError !== undefined) return;
        parserError = error;
        void opened.terminate().catch(() => undefined);
      }
    });
    try {
      await endInput(
        opened.process.stdin,
        encodeWireFrame(JSON.stringify(launch)),
      );
    } catch (error) {
      await opened.terminate().catch(() => undefined);
      throw error;
    }
    const process = await opened.completion;
    if (parserError !== undefined) {
      throw parserError instanceof Error
        ? parserError
        : new Error("PE vanilla diagnostic parser failed");
    }
    parser.end();
    return {
      kind: "completed",
      result: {
        sandbox: { kind: "executed", process },
        diagnostics: parser.records(),
      },
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
    | ProjectEnvironmentSidecarExecutionResultV1
  > {
    const launch = GodotProjectEnvironmentSidecarLaunchV1Schema.parse({
      ...input,
      managedRuntimeId: this.options.managedRuntime.capability.managedRuntimeId,
      overlayHash: this.options.managedRuntime.capability.overlayHash,
      addonHash: this.options.managedRuntime.capability.addonHash,
    });
    const opened = await this.options.runner.open({
      overlayFiles: this.#overlayFiles,
      argv: (stage) => [
        this.options.nodePath,
        "--input-type=commonjs",
        "--eval",
        createProjectEnvironmentRuntimeSidecarSource(
          sourceOptions(stage, this.options.godotPath),
        ),
      ],
      timeoutMs: Math.min(
        600_000,
        launch.importTimeoutMs + launch.executionTimeoutMs + 5_000,
      ),
      readOnlyPaths: [
        dirname(this.options.nodePath),
        dirname(this.options.godotPath),
      ],
      ...(signal === undefined ? {} : { signal }),
    });

    const readable = new PassThrough();
    readable.on("error", () => undefined);
    opened.process.stdout.pipe(readable, { end: false });
    const parser = this.parser(launch, GodotLifecycleSidecarDiagnosticV1Schema);
    let failure: unknown;
    const fail = (error: unknown): void => {
      if (failure !== undefined) return;
      failure = error;
      readable.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
      void opened.terminate().catch(() => undefined);
    };
    opened.process.stderr.on("data", (chunk: Buffer | string) => {
      try {
        parser.push(asBytes(chunk));
      } catch (error) {
        fail(error);
      }
    });

    const completion: Promise<ProjectEnvironmentSidecarExecutionResultV1> =
      opened.completion.then(
        (process) => {
          try {
            parser.end();
          } catch (error) {
            fail(error);
          }
          if (failure === undefined) readable.end();
          return { kind: "executed", process };
        },
        (error: unknown) => {
          fail(error);
          throw error;
        },
      );
    try {
      await writeBytes(
        opened.process.stdin,
        encodeWireFrame(JSON.stringify(launch)),
      );
    } catch (error) {
      fail(error);
      await opened.terminate().catch(() => undefined);
      return completion;
    }

    const transport: GodotByteTransport = {
      readable,
      write: (bytes) => writeBytes(opened.process.stdin, bytes),
      close: () => endInput(opened.process.stdin),
    };
    return {
      kind: "opened",
      sidecar: Object.freeze({
        transport,
        completion,
        diagnostics: () => parser.records(),
        terminate: () => opened.terminate(),
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
