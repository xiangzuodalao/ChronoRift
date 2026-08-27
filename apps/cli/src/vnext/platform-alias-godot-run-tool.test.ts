import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { GodotLifecycleVanillaSmokeDiagnosticV1 } from "@chronorift/godot-protocol";

import type { PreparedProjectEnvironmentDebugBuildV1 } from "./candidate-godot-build.js";
import type { ManagedGodotProjectEnvironmentRuntimeCapabilityV1 } from "./managed-godot-project-environment-runtime.js";
import {
  createPlatformAliasGodotRunToolV1,
  PlatformAliasGodotRunCallV1Schema,
  PlatformAliasGodotRunResultV1Schema,
} from "./platform-alias-godot-run-tool.js";
import type { GodotProjectEnvironmentSidecarPortV1 } from "./project-environment-sidecar-port.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const candidateHash = sha256("candidate");

const prepared = (
  suffix = "fixture",
): PreparedProjectEnvironmentDebugBuildV1 => ({
  build: {
    schemaVersion: 1,
    buildId: `build:${suffix}`,
    sourceClosureId: `source:${suffix}`,
    candidateSourceHash: candidateHash as never,
    expectedMainScene: "res://main.tscn",
  },
  projectHash: sha256(`project:${suffix}`) as never,
  fileCount: 3,
  byteLength: 512,
});

const streamReceipt = (
  bytes: Uint8Array,
  retainedBytes = bytes.byteLength,
) => ({
  totalBytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  retainedBytes,
  truncated: retainedBytes < bytes.byteLength,
});

const processReceipt = (
  stdout: Uint8Array,
  stderr: Uint8Array,
  input: {
    readonly exitCode?: number | null;
    readonly stdoutRetainedBytes?: number;
    readonly stderrRetainedBytes?: number;
  } = {},
) => ({
  exitCode: input.exitCode ?? 0,
  signal: null,
  timedOut: false,
  durationMs: 2_100,
  stdout: streamReceipt(stdout, input.stdoutRetainedBytes),
  stderr: streamReceipt(stderr, input.stderrRetainedBytes),
});

const outputRecord = (
  phase: "import" | "vanilla",
  stream: "stdout" | "stderr",
  bytes: Uint8Array,
): GodotLifecycleVanillaSmokeDiagnosticV1 => ({
  schemaVersion: 1,
  kind: "process_output",
  phase,
  stream,
  offset: 0,
  bytesBase64: Buffer.from(bytes).toString("base64"),
});

const successDiagnostics = (
  importStdout = Buffer.from("import ok\n"),
  vanillaStdout = Buffer.from("game ok\n"),
  vanillaStderr = Buffer.from(""),
): readonly GodotLifecycleVanillaSmokeDiagnosticV1[] => [
  {
    schemaVersion: 1,
    kind: "stage_ready",
    candidateSourceHash: candidateHash,
    fileCount: 3,
    byteLength: 512,
  },
  outputRecord("import", "stdout", importStdout),
  {
    schemaVersion: 1,
    kind: "source_verified",
    phase: "import",
    candidateSourceHash: candidateHash,
    fileCount: 3,
    byteLength: 512,
  },
  outputRecord("vanilla", "stdout", vanillaStdout),
  outputRecord("vanilla", "stderr", vanillaStderr),
  {
    schemaVersion: 1,
    kind: "source_verified",
    phase: "vanilla",
    candidateSourceHash: candidateHash,
    fileCount: 3,
    byteLength: 512,
  },
  {
    schemaVersion: 1,
    kind: "smoke_complete",
    candidateSourceHash: candidateHash,
    fileCount: 3,
    byteLength: 512,
    stabilityObservedMs: 2_100,
    import: processReceipt(importStdout, Buffer.alloc(0)),
    vanilla: processReceipt(vanillaStdout, vanillaStderr),
  },
];

const completed = (
  diagnostics: readonly GodotLifecycleVanillaSmokeDiagnosticV1[],
  status: "succeeded" | "failed" = "succeeded",
) => ({
  kind: "completed" as const,
  result: {
    sandbox: {
      kind: "executed" as const,
      process: {
        process: {
          status: "exited" as const,
          exitCode: status === "succeeded" ? 0 : 1,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 2_200,
          timedOut: false,
          cancelled: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
        sourceSha256: candidateHash,
        observedSourceSha256: candidateHash,
        sourceUnchanged: true,
      },
    },
    diagnostics,
  },
});

const managedRuntime = {
  managedRuntimeId: `managed-godot-project-environment:v1:${sha256("runtime")}`,
} as ManagedGodotProjectEnvironmentRuntimeCapabilityV1;

const execute = async (
  sidecar: Pick<GodotProjectEnvironmentSidecarPortV1, "runVanilla">,
  options: {
    readonly prepareBuild?: () => Promise<PreparedProjectEnvironmentDebugBuildV1>;
    readonly onCall?: (call: unknown) => void;
  } = {},
) => {
  const tool = createPlatformAliasGodotRunToolV1({
    sidecar,
    managedRuntime,
    taskId: "task:fixture",
    prepareBuild: options.prepareBuild ?? (() => Promise.resolve(prepared())),
    ...(options.onCall === undefined
      ? {}
      : {
          onCall: (call) => {
            options.onCall!(call);
          },
        }),
  });
  const response = await tool.execute(
    "call_fixture",
    {},
    undefined,
    undefined,
    {} as never,
  );
  const block = response.content[0];
  if (block?.type !== "text") throw new Error("missing text tool result");
  return PlatformAliasGodotRunResultV1Schema.parse(JSON.parse(block.text));
};

describe("platform-alias shared raw Godot tool", () => {
  it("freezes the current Build and runs the default scene through the private sidecar stage", async () => {
    const runVanilla = vi.fn((launch: Record<string, unknown>) => {
      void launch;
      return Promise.resolve(completed(successDiagnostics()));
    });
    const first = prepared("first");
    const second = prepared("second");
    let prepareCount = 0;
    const prepareBuild = vi.fn(() =>
      Promise.resolve(prepareCount++ === 0 ? first : second),
    );
    const sidecar = { runVanilla } as unknown as Pick<
      GodotProjectEnvironmentSidecarPortV1,
      "runVanilla"
    >;

    const firstResult = await execute(sidecar, { prepareBuild });
    const secondResult = await execute(sidecar, { prepareBuild });

    expect(firstResult).toMatchObject({
      outcome: "success",
      build: { buildId: "build:first" },
      capture: { stdout: "import ok\ngame ok\n", stderr: "" },
    });
    expect(secondResult).toMatchObject({
      outcome: "success",
      build: { buildId: "build:second" },
    });
    expect(prepareBuild).toHaveBeenCalledTimes(2);
    expect(runVanilla).toHaveBeenCalledTimes(2);
    const firstLaunch = runVanilla.mock.calls[0]![0];
    expect(firstLaunch).toMatchObject({
      operation: "vanilla_smoke",
      taskId: "task:fixture",
      buildId: "build:first",
      candidateSourceHash: candidateHash,
      outputCaptureMaxBytes: 64 * 1024,
      stabilityWindowMs: 2_000,
    });
    expect(firstLaunch).not.toHaveProperty("launchScene");
    expect(firstLaunch).not.toHaveProperty("workspaceDirectory");
    expect(firstLaunch).not.toHaveProperty("adapter");
  });

  it("returns bounded raw output, receipt facts, and a strict recording hook", async () => {
    const importStdout = Buffer.alloc(40_000, "a");
    const vanillaStdout = Buffer.alloc(40_000, "b");
    const diagnostics = successDiagnostics(importStdout, vanillaStdout);
    const onCall = vi.fn((call) =>
      PlatformAliasGodotRunCallV1Schema.parse(call),
    );
    const result = await execute(
      {
        runVanilla: () => Promise.resolve(completed(diagnostics)),
      } as unknown as Pick<GodotProjectEnvironmentSidecarPortV1, "runVanilla">,
      { onCall },
    );

    expect(result.outcome).toBe("success");
    if (result.outcome !== "success") throw new Error("expected success");
    expect(Buffer.byteLength(result.capture.stdout, "utf8")).toBe(64 * 1024);
    expect(result.capture.stdoutTruncated).toBe(true);
    expect(result.receipt.sourceIdentityReverified).toBe(true);
    expect(onCall).toHaveBeenCalledOnce();
    expect(onCall.mock.results[0]!.value).toMatchObject({
      schemaVersion: 1,
      toolCallId: "call_fixture",
      result: { outcome: "success" },
    });
  });

  it("returns raw failure output and receipt without adapter semantics", async () => {
    const stderr = Buffer.from("import parse error\n");
    const diagnostics: readonly GodotLifecycleVanillaSmokeDiagnosticV1[] = [
      outputRecord("import", "stderr", stderr),
      {
        schemaVersion: 1,
        kind: "smoke_failed",
        candidateSourceHash: candidateHash,
        fileCount: 3,
        byteLength: 512,
        failedPhase: "import",
        import: processReceipt(Buffer.alloc(0), stderr, { exitCode: 1 }),
        vanilla: null,
      },
    ];
    const result = await execute({
      runVanilla: () => Promise.resolve(completed(diagnostics, "failed")),
    } as unknown as Pick<GodotProjectEnvironmentSidecarPortV1, "runVanilla">);

    expect(result).toMatchObject({
      outcome: "error",
      error: { code: "execution_failed", recoverable: true },
      capture: { stderr: "import parse error\n" },
      receipt: { sandboxStatus: "failed" },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /platform_geometry|shapeInstance|semanticCoverage|adapterRevision/u,
    );
  });

  it("records sandbox denial and build-preparation failure as distinct errors", async () => {
    const denied = await execute({
      runVanilla: () => Promise.resolve({ kind: "denied" } as never),
    } as unknown as Pick<GodotProjectEnvironmentSidecarPortV1, "runVanilla">);
    expect(denied).toMatchObject({
      outcome: "error",
      error: { code: "denied", recoverable: false },
      build: { buildId: "build:fixture" },
    });
    expect(denied).not.toHaveProperty("receipt");

    const prepareFailed = await execute(
      {
        runVanilla: () => {
          throw new Error("must not run");
        },
      } as unknown as Pick<GodotProjectEnvironmentSidecarPortV1, "runVanilla">,
      {
        prepareBuild: () => Promise.reject(new Error("snapshot changed\npath")),
      },
    );
    expect(prepareFailed).toEqual({
      schemaVersion: 1,
      outcome: "error",
      error: {
        code: "prepare_failed",
        message: "snapshot changed path",
        recoverable: true,
      },
    });
  });
});
