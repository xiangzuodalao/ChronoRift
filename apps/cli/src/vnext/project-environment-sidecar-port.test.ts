import { once } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createManagedGodotProjectEnvironmentRuntimeV1 } from "./managed-godot-project-environment-runtime.js";
import { GodotProjectEnvironmentSidecarPortV1 } from "./project-environment-sidecar-port.js";
import { createManagedGodotProjectEnvironmentRuntimeV2 } from "./managed-godot-project-environment-runtime-v2.js";
import { GodotProjectEnvironmentSidecarPortV2 } from "./project-environment-sidecar-port-v2.js";
import type {
  OpenSrtGodotOptions,
  SrtGodotProcessResult,
  SrtGodotRunHandle,
} from "./srt-godot-runner.js";

const hash = (character: string): string => character.repeat(64);

const PROCESS_RESULT: SrtGodotProcessResult = {
  process: {
    status: "exited",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 12,
    timedOut: false,
    cancelled: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  },
  sourceSha256: hash("a"),
  observedSourceSha256: hash("a"),
  sourceUnchanged: true,
};

interface FakeRunCall {
  readonly options: OpenSrtGodotOptions;
  readonly argv: readonly string[];
  readonly stdinChunks: Buffer[];
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly terminate: ReturnType<typeof vi.fn>;
  finish(result?: SrtGodotProcessResult): void;
}

class FakeRunner {
  public readonly calls: FakeRunCall[] = [];

  public async open(options: OpenSrtGodotOptions): Promise<SrtGodotRunHandle> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdinChunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => stdinChunks.push(Buffer.from(chunk)));
    let resolveCompletion!: (value: SrtGodotProcessResult) => void;
    const completion = new Promise<SrtGodotProcessResult>((resolve) => {
      resolveCompletion = resolve;
    });
    let finished = false;
    const finish = (result = PROCESS_RESULT): void => {
      if (finished) return;
      finished = true;
      stdout.end();
      stderr.end();
      resolveCompletion(result);
    };
    const terminate = vi.fn(async () => finish());
    const stage = {
      stageRoot: "/stages/run",
      projectStagePath: "/stages/run/project",
      godotCachePath: "/stages/run/project/.godot",
      homePath: "/stages/run/home",
      tempPath: "/stages/run/tmp",
      artifactsPath: "/stages/run/artifacts",
      sourceSha256: hash("a"),
      verifySourceUnchanged: async () => ({
        observedSourceSha256: hash("a"),
        sourceUnchanged: true,
      }),
      cleanup: () => Promise.resolve(),
    };
    const argv = options.argv(stage);
    const call = {
      options,
      argv,
      stdinChunks,
      stdout,
      stderr,
      terminate,
      finish,
    } satisfies FakeRunCall;
    this.calls.push(call);
    return {
      sourceSha256: hash("a"),
      process: {
        pid: 123,
        stdin,
        stdout,
        stderr,
        wait: async () => (await completion).process,
        stop: async () => {
          finish();
          return PROCESS_RESULT.process;
        },
      },
      completion,
      terminate,
    };
  }
}

const adapterFiles = [
  { relativePath: "manifest.json", bytes: Buffer.from("{}\n") },
  {
    relativePath: "src/adapter.gd",
    bytes: Buffer.from("extends ChronoRiftProjectAdapterV1\n"),
  },
];

const runtimeV1 = () =>
  createManagedGodotProjectEnvironmentRuntimeV1({
    doctorVersion: "4.7.1.stable.official.a13da4feb",
    adapterFiles,
  });

const runtimeV2 = () =>
  createManagedGodotProjectEnvironmentRuntimeV2({
    doctorVersion: "4.7.1.stable.official.a13da4feb",
    adapterFiles,
  });

const decodedLaunch = (chunks: readonly Buffer[]): Record<string, unknown> => {
  const bytes = Buffer.concat(chunks);
  const length = bytes.readUInt32BE(0);
  return JSON.parse(bytes.subarray(4, length + 4).toString("utf8")) as Record<
    string,
    unknown
  >;
};

describe("SRT Project Environment sidecar ports", () => {
  it("runs V1 vanilla from a physical pre-staged project without overlays", async () => {
    const managedRuntime = runtimeV1();
    const runner = new FakeRunner();
    const port = new GodotProjectEnvironmentSidecarPortV1({
      runner,
      nodePath: "/home/developer/node/bin/node",
      godotPath: "/home/developer/godot/Godot",
      managedRuntime,
    });
    const pending = port.runVanilla({
      schemaVersion: 1,
      runtimeProfile: "chronorift-managed-godot-project-environment-v1",
      taskId: "task.test",
      buildId: "build.test",
      runtimeId: "runtime.test",
      executionId: "execution.test",
      managedRuntimeId: managedRuntime.capability.managedRuntimeId,
      candidateSourceHash: hash("1"),
      diagnosticFrameMaxBytes: 1024,
      diagnosticTotalMaxBytes: 16 * 1024,
      diagnosticMaxCount: 16,
      outputCaptureMaxBytes: 1024,
      operation: "vanilla_smoke",
      importTimeoutMs: 1000,
      vanillaTimeoutMs: 3000,
      stabilityWindowMs: 2000,
    });

    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    const call = runner.calls[0]!;
    expect(call.options.overlayFiles).toBeUndefined();
    expect(call.options.readOnlyPaths).toEqual([
      "/home/developer/node/bin",
      "/home/developer/godot",
    ]);
    expect(call.argv.slice(0, 3)).toEqual([
      "/home/developer/node/bin/node",
      "--input-type=commonjs",
      "--eval",
    ]);
    expect(call.argv[3]).toContain(
      'const WORKSPACE_ROOT = "/stages/run/project"',
    );
    expect(call.argv[3]).toContain("const PRE_STAGED_PROJECT = true");
    expect(call.argv[3]).toContain(
      'const GODOT_EXECUTABLE = "/home/developer/godot/Godot"',
    );
    await vi.waitFor(() => expect(call.stdinChunks.length).toBeGreaterThan(0));
    expect(decodedLaunch(call.stdinChunks)).toMatchObject({
      operation: "vanilla_smoke",
      candidateSourceHash: hash("1"),
    });
    call.finish();

    await expect(pending).resolves.toMatchObject({
      kind: "completed",
      result: {
        sandbox: { kind: "executed", process: PROCESS_RESULT },
        diagnostics: [],
      },
    });
  });

  it("maps V2 managed runtime files into the stage and forwards duplex I/O", async () => {
    const managedRuntime = runtimeV2();
    const runner = new FakeRunner();
    const port = new GodotProjectEnvironmentSidecarPortV2({
      runner,
      nodePath: "/tools/node/node",
      godotPath: "/tools/godot/Godot",
      managedRuntime,
    });
    const pending = port.openManaged({
      schemaVersion: 2,
      runtimeProfile: "chronorift-managed-godot-project-environment-v2",
      taskId: "task.test",
      buildId: "build.test",
      runtimeId: "runtime.test",
      executionId: "execution.test",
      managedRuntimeId: managedRuntime.capability.managedRuntimeId,
      candidateSourceHash: hash("1"),
      diagnosticFrameMaxBytes: 1024,
      diagnosticTotalMaxBytes: 16 * 1024,
      diagnosticMaxCount: 16,
      outputCaptureMaxBytes: 1024,
      operation: "managed_lifecycle",
      protocolProfile: "chronorift-godot-project-environment-v2",
      protocolVersion: 2,
      token: hash("2"),
      overlayHash: managedRuntime.capability.overlayHash,
      addonHash: managedRuntime.capability.addonHash,
      expectedMainScene: "res://main.tscn",
      instrumentationMode: "instrumented",
      sourceClosureId: "source.test",
      environmentRevisionId: "environment.test",
      adapterRevisionId: "adapter.test",
      adapterManifestSha256: hash("3"),
      sdkSha256: hash("4"),
      bridgeSha256: hash("5"),
      toolchainSha256: hash("6"),
      importTimeoutMs: 1000,
      startupTimeoutMs: 1000,
      executionTimeoutMs: 5000,
    });

    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    const opened = await pending;
    if (opened.kind !== "opened") throw new Error("sidecar did not open");
    const call = runner.calls[0]!;
    expect(call.options.readOnlyPaths).toEqual(["/tools/node", "/tools/godot"]);
    const overlayFiles = call.options.overlayFiles ?? [];
    expect(
      overlayFiles.some(
        (file) =>
          file.relativePath === ".chronorift/project-adapter/manifest.json",
      ),
    ).toBe(true);
    expect(
      overlayFiles.some(
        (file) =>
          file.relativePath ===
          `addons/chronorift_project_environment/${managedRuntime.binding.addonFiles[0]!.relativePath}`,
      ),
    ).toBe(true);
    expect(overlayFiles.at(-1)).toMatchObject({ relativePath: "override.cfg" });
    expect(call.argv[3]).toContain('const RUNTIME_ROOT = "/stages/run/tmp"');

    const output = once(opened.sidecar.transport.readable, "data");
    call.stdout.write("bridge-frame");
    expect(String((await output)[0])).toBe("bridge-frame");
    await opened.sidecar.transport.write(Buffer.from("request-frame"));
    await vi.waitFor(() =>
      expect(Buffer.concat(call.stdinChunks).includes("request-frame")).toBe(
        true,
      ),
    );
    call.finish();

    await expect(opened.sidecar.completion).resolves.toEqual({
      kind: "executed",
      process: PROCESS_RESULT,
    });
  });
});
