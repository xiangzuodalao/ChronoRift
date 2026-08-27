import { once } from "node:events";
import { dirname, join } from "node:path";
import { PassThrough, type Writable } from "node:stream";

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
  type GodotLifecycleVanillaSmokeDiagnosticV1,
  type GodotProjectEnvironmentSidecarLaunchV2,
  type GodotProjectEnvironmentVanillaSmokeLaunchV2,
} from "@chronorift/godot-protocol";

import type {
  GodotValidationOverlayFile,
  GodotValidationStage,
} from "./godot-validation-stage.js";
import {
  assertManagedGodotProjectEnvironmentRuntimeBindingV2,
  type ManagedGodotProjectEnvironmentRuntimeBindingV2,
  type ManagedGodotProjectEnvironmentRuntimeCapabilityV2,
} from "./managed-godot-project-environment-runtime-v2.js";
import type {
  SrtGodotProcessResult,
  SrtGodotRunner,
} from "./srt-godot-runner.js";

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

export interface ProjectEnvironmentSidecarDeniedV2 {
  readonly kind: "denied";
  readonly [key: string]: unknown;
}

export type ProjectEnvironmentSidecarExecutionResultV2 =
  | {
      readonly kind: "executed";
      readonly process: SrtGodotProcessResult;
    }
  | ProjectEnvironmentSidecarDeniedV2;

export interface ProjectEnvironmentVanillaSmokeResultV2 {
  readonly sandbox: Extract<
    ProjectEnvironmentSidecarExecutionResultV2,
    { readonly kind: "executed" }
  >;
  readonly diagnostics: readonly GodotLifecycleVanillaSmokeDiagnosticV1[];
}

export interface SandboxedGodotProjectEnvironmentSidecarV2 {
  readonly transport: GodotByteTransport;
  readonly completion: Promise<ProjectEnvironmentSidecarExecutionResultV2>;
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
  binding: ManagedGodotProjectEnvironmentRuntimeBindingV2,
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

export class GodotProjectEnvironmentSidecarPortV2 {
  readonly #overlayFiles: readonly GodotValidationOverlayFile[];

  public constructor(
    private readonly options: {
      readonly runner: Pick<SrtGodotRunner, "open">;
      readonly nodePath: string;
      readonly godotPath: string;
      readonly managedRuntime: {
        readonly capability: ManagedGodotProjectEnvironmentRuntimeCapabilityV2;
        readonly binding: ManagedGodotProjectEnvironmentRuntimeBindingV2;
      };
    },
  ) {
    assertManagedGodotProjectEnvironmentRuntimeBindingV2(
      options.managedRuntime.capability,
      options.managedRuntime.binding,
    );
    this.#overlayFiles = managedOverlays(options.managedRuntime.binding);
  }

  public async runVanilla(
    input: GodotProjectEnvironmentVanillaSmokeLaunchV2,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly kind: "completed";
        readonly result: ProjectEnvironmentVanillaSmokeResultV2;
      }
    | ProjectEnvironmentSidecarDeniedV2
  > {
    const launch = GodotProjectEnvironmentVanillaSmokeLaunchV2Schema.parse({
      ...input,
      managedRuntimeId: this.options.managedRuntime.capability.managedRuntimeId,
    });
    const parser = new Frames((value) =>
      GodotLifecycleVanillaSmokeDiagnosticV1Schema.parse(value),
    );
    const opened = await this.options.runner.open({
      argv: (stage) => [
        this.options.nodePath,
        "--input-type=commonjs",
        "--eval",
        createProjectEnvironmentVanillaSmokeSidecarSourceV2(
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
        : new Error("PE-B vanilla diagnostic parser failed");
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
    input: GodotProjectEnvironmentSidecarLaunchV2,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly kind: "opened";
        readonly sidecar: SandboxedGodotProjectEnvironmentSidecarV2;
      }
    | ProjectEnvironmentSidecarExecutionResultV2
  > {
    const launch = GodotProjectEnvironmentSidecarLaunchV2Schema.parse({
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
        createProjectEnvironmentRuntimeSidecarSourceV2(
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
    const parser = new Frames((value) =>
      GodotLifecycleSidecarDiagnosticV1Schema.parse(value),
    );
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

    const completion: Promise<ProjectEnvironmentSidecarExecutionResultV2> =
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

    return {
      kind: "opened",
      sidecar: Object.freeze({
        transport: {
          readable,
          write: (bytes: Uint8Array) => writeBytes(opened.process.stdin, bytes),
          close: () => endInput(opened.process.stdin),
        },
        completion,
        diagnostics: () => parser.records(),
        terminate: () => opened.terminate(),
      }),
    };
  }
}
