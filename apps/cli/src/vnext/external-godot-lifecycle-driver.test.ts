import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";

import {
  VNextBuildV1Schema,
  asBuildId,
  asExecutionId,
  asRuntimeId,
  asSha256DigestV1,
  asSourceId,
  asTaskId,
  asWorkspaceId,
  lifecycleCleanupProven,
  type JsonValue,
} from "@chronorift/domain";
import {
  createLifecycleRuntimeSidecarSource,
  createLifecycleVanillaSmokeSidecarSource,
  type GodotByteTransport,
} from "@chronorift/godot-adapter";
import {
  GODOT_LIFECYCLE_CAPABILITIES_V1,
  WireFrameDecoder,
  encodeWireFrame,
  makeGodotLifecycleWireMessage,
  parseGodotLifecycleWireMessage,
  type GodotLifecycleSidecarDiagnosticV1,
  type GodotLifecycleSidecarLaunchV1,
  type GodotLifecycleVanillaSmokeDiagnosticV1,
  type GodotLifecycleVanillaSmokeLaunchV1,
} from "@chronorift/godot-protocol";
import { contentHash } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import type { PreparedExternalGodotLifecycleBuildV1 } from "./candidate-godot-build.js";
import {
  SandboxExecutionReceiptV1Schema,
  SandboxExecutionRequestV1Schema,
  SandboxToolchainCapabilityV1Schema,
} from "./contracts.js";
import {
  ExternalGodotLifecycleLaunchFailureV1,
  createExternalGodotLifecycleSandboxDriverV1,
} from "./external-godot-lifecycle-driver.js";
import type {
  GodotLifecycleSidecarPortV1,
  LifecycleDiagnosticFactsV1,
  SandboxedGodotLifecycleSidecarV1,
} from "./godot-lifecycle-sidecar-port.js";
import { createManagedGodotLifecycleRuntimeV1 } from "./managed-godot-lifecycle-runtime.js";
import { resolveResourceLimitsV1 } from "./sandbox-policy.js";
import type { SandboxExecutionResultV1 } from "./sandbox-broker.js";

const timestamp = "2026-08-10T00:00:00.000Z";
const digest = (value: string | Uint8Array) =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));
const emptyDigest = digest(Buffer.alloc(0));
const jsonValue = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

const managedRuntime = () => {
  const files = [
    { target: "/bin/sh", sha256: digest("shell"), command: false },
    {
      target: "/lib/x86_64-linux-gnu/libfontconfig.so.1",
      sha256: digest("fontconfig"),
      command: false,
    },
    {
      target: "/opt/chronorift/bin/godot",
      sha256: digest("godot"),
      command: true,
    },
    {
      target: "/opt/chronorift/bin/node",
      sha256: digest("node"),
      command: true,
    },
    {
      target: "/usr/bin/xdg-user-dir",
      sha256: digest("xdg"),
      command: false,
    },
  ] as const;
  const toolchainContent = { schemaVersion: 1 as const, files };
  const toolchain = SandboxToolchainCapabilityV1Schema.parse({
    ...toolchainContent,
    toolchainId: `sandbox-toolchain:v1:${contentHash(
      jsonValue(toolchainContent),
    )}`,
  });
  const sourceOptions = {
    godotExecutable: "/opt/chronorift/bin/godot",
    workspaceRoot: "/workspace",
    runtimeRoot: "/run/chronorift",
  } as const;
  return createManagedGodotLifecycleRuntimeV1({
    doctorVersion: "4.7.1.stable.official.a13da4feb",
    nodeTarget: "/opt/chronorift/bin/node",
    godotTarget: "/opt/chronorift/bin/godot",
    toolchain: {
      capability: toolchain,
      binding: {
        toolchainId: toolchain.toolchainId,
        files: files.map((file) => ({
          target: file.target,
          hostPath: `/host${file.target}`,
        })),
      },
    },
    vanillaSidecarSource:
      createLifecycleVanillaSmokeSidecarSource(sourceOptions),
    lifecycleSidecarSource: createLifecycleRuntimeSidecarSource(sourceOptions),
    addonFiles: [
      {
        relativePath: "lifecycle_probe.gd",
        bytes: Buffer.from("extends Node\n"),
      },
    ],
  });
};

const preparedFor = (
  runtime: ReturnType<typeof managedRuntime>["capability"],
): PreparedExternalGodotLifecycleBuildV1 => ({
  build: VNextBuildV1Schema.parse({
    schemaVersion: 1,
    taskId: asTaskId("task:external"),
    workspaceId: asWorkspaceId("workspace:external"),
    sourceId: asSourceId(`source:${"1".repeat(64)}`),
    buildId: asBuildId(`build:${"2".repeat(64)}`),
    sourceHash: digest("source"),
    workspaceDiffHash: digest("diff"),
    buildConfigurationHash: digest("config"),
    outputHash: digest("output"),
    createdAt: timestamp,
  }),
  configuredMainScene: "res://main.tscn",
  projectHash: digest("project"),
  descriptorHash: digest("descriptor"),
  overlayHash: runtime.overlayHash,
  addonHash: runtime.addonHash,
  vanillaSidecarHash: runtime.vanillaSidecarSourceSha256,
  lifecycleSidecarHash: runtime.lifecycleSidecarSourceSha256,
  fileCount: 2,
  byteLength: 64,
});

const streamCapture = {
  totalBytes: 0,
  capturedBytes: 0,
  sha256: emptyDigest,
  capturedSha256: emptyDigest,
  truncated: false,
};

const sandboxResult = (
  operationId: string,
  cleanup = true,
): Extract<SandboxExecutionResultV1, { readonly kind: "executed" }> => {
  const request = SandboxExecutionRequestV1Schema.parse({
    schemaVersion: 1,
    operationId,
    profile: "godot-headless",
    argv: ["/opt/chronorift/bin/node"],
    cwd: "/workspace",
    environment: {},
    timeoutMs: 10_000,
  });
  return {
    kind: "executed",
    receipt: SandboxExecutionReceiptV1Schema.parse({
      schemaVersion: 1,
      taskId: asTaskId("task:external"),
      operationId,
      policyId: `sandbox-policy:v2:${"a".repeat(64)}`,
      sandboxCapabilitySha256: digest("sandbox"),
      sandboxBackend: "bwrap-direct-cgroup-v2",
      status: "succeeded",
      requested: request,
      realizedResources: resolveResourceLimitsV1("godot-headless", 10_000),
      realizedMechanisms: {
        cpu: "cgroup-v2",
        memory: "cgroup-v2",
        processCount: "cgroup-v2",
        openFiles: "rlimit-nofile",
        fileSize: "rlimit-fsize",
        wallTimeout: "host-monotonic-timer",
        aggregateStorage: "dedicated-capacity-bounded-filesystem-v1",
        unavailable: [],
      },
      resourceUsage: {
        cpuUsageUsec: 1,
        memoryPeakBytes: 2,
        pidsPeak: 1,
        aggregateStorage: { usedBytes: 4_096, usedInodes: 12 },
      },
      stdout: streamCapture,
      stderr: streamCapture,
      exitCode: 0,
      signal: null,
      startedAtMonotonicMs: 1,
      endedAtMonotonicMs: 5_000,
      cleanup: {
        processGroupTerminated: cleanup,
        cgroupPopulated: !cleanup,
        termSent: true,
        killSent: false,
        scopeRemoved: cleanup,
      },
    }),
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  };
};

const processReceipt = (signal: string | null = null) => ({
  exitCode: signal === null ? 0 : null,
  signal,
  timedOut: false,
  durationMs: 2_000,
  stdout: {
    totalBytes: 0,
    sha256: emptyDigest,
    retainedBytes: 0,
    truncated: false,
  },
  stderr: {
    totalBytes: 0,
    sha256: emptyDigest,
    retainedBytes: 0,
    truncated: false,
  },
});

const facts = <T>(records: readonly T[]): LifecycleDiagnosticFactsV1<T> => ({
  schemaVersion: 1,
  status: "open",
  records,
  frameCount: records.length,
  encodedByteLength: 1,
  limits: { frameMaxBytes: 65_536, totalMaxBytes: 1_048_576, maxCount: 128 },
  failure: null,
});

interface FakePortOptions {
  readonly vanillaCleanup?: boolean;
  readonly vanillaFailedPhase?: "import" | "vanilla";
  readonly managedOpenFailure?: boolean;
  readonly managedCleanup?: boolean;
  readonly fingerprintMismatch?: boolean;
  readonly truncatedStdout?: boolean;
  readonly corruptedFullStdoutSummary?: boolean;
  readonly terminalStdout?: boolean;
  readonly omitVanillaSourceVerification?: boolean;
  readonly omitManagedSourceVerification?: boolean;
  readonly vanillaPortReject?: boolean;
  readonly managedPortReject?: boolean;
}

const fakePort = (
  runtime: ReturnType<typeof managedRuntime>["capability"],
  options: FakePortOptions = {},
) => {
  const calls: string[] = [];
  let terminateCalls = 0;
  let managedOpenCalls = 0;
  let completionObserved = false;
  let naturalExit = (): void => undefined;

  const port: Pick<
    GodotLifecycleSidecarPortV1,
    "runVanillaSmoke" | "openManaged"
  > = {
    runVanillaSmoke(launch: GodotLifecycleVanillaSmokeLaunchV1) {
      calls.push("vanilla");
      if (options.vanillaPortReject === true) {
        return Promise.reject(new Error("vanilla port rejected"));
      }
      const diagnostics: GodotLifecycleVanillaSmokeDiagnosticV1[] = [
        {
          schemaVersion: 1,
          kind: "stage_ready",
          candidateSourceHash: launch.candidateSourceHash,
          fileCount: 2,
          byteLength: 64,
        },
      ];
      if (options.vanillaFailedPhase === undefined) {
        if (options.omitVanillaSourceVerification !== true) {
          diagnostics.push({
            schemaVersion: 1,
            kind: "source_verified",
            phase: "import",
            candidateSourceHash: launch.candidateSourceHash,
            fileCount: 2,
            byteLength: 64,
          });
          diagnostics.push({
            schemaVersion: 1,
            kind: "source_verified",
            phase: "vanilla",
            candidateSourceHash: launch.candidateSourceHash,
            fileCount: 2,
            byteLength: 64,
          });
        }
        diagnostics.push({
          schemaVersion: 1,
          kind: "smoke_complete",
          candidateSourceHash: launch.candidateSourceHash,
          fileCount: 2,
          byteLength: 64,
          stabilityObservedMs: 2_000,
          import: processReceipt(),
          vanilla: processReceipt("SIGTERM"),
        });
      } else {
        const importReceipt =
          options.vanillaFailedPhase === "import"
            ? { ...processReceipt(), exitCode: 1 }
            : processReceipt();
        const vanillaReceipt =
          options.vanillaFailedPhase === "vanilla"
            ? { ...processReceipt(), exitCode: 1 }
            : null;
        diagnostics.push(
          {
            schemaVersion: 1,
            kind: "smoke_failed",
            candidateSourceHash: launch.candidateSourceHash,
            fileCount: 2,
            byteLength: 64,
            failedPhase: options.vanillaFailedPhase,
            import: importReceipt,
            vanilla: vanillaReceipt,
          },
          {
            schemaVersion: 1,
            kind: "sidecar_error",
            phase: options.vanillaFailedPhase,
            code:
              options.vanillaFailedPhase === "import"
                ? "GODOT_IMPORT_FAILED"
                : "VANILLA_EXITED_EARLY",
            message: `vanilla ${options.vanillaFailedPhase} failed`,
          },
        );
      }
      return Promise.resolve({
        kind: "completed" as const,
        result: {
          sandbox: sandboxResult(
            "lifecycle-vanilla:test",
            options.vanillaCleanup ?? true,
          ),
          diagnostics,
          diagnosticFacts: facts(diagnostics),
        },
      });
    },
    openManaged(launch: GodotLifecycleSidecarLaunchV1) {
      calls.push("managed");
      managedOpenCalls += 1;
      if (options.managedPortReject === true) {
        return Promise.reject(new Error("managed port rejected"));
      }
      if (options.managedOpenFailure === true) {
        return Promise.resolve(sandboxResult("lifecycle-managed:open-failed"));
      }
      const readable = new PassThrough();
      const decoder = new WireFrameDecoder();
      const records: GodotLifecycleSidecarDiagnosticV1[] = [
        {
          schemaVersion: 1,
          kind: "stage_ready",
          candidateSourceHash: launch.candidateSourceHash,
          overlayHash: launch.overlayHash,
          addonHash: launch.addonHash,
          fileCount: 2,
          byteLength: 64,
        },
        { schemaVersion: 1, kind: "godot_started", pid: 123 },
      ];
      if (
        options.truncatedStdout === true ||
        options.corruptedFullStdoutSummary === true
      ) {
        records.push({
          schemaVersion: 1,
          kind: "process_output",
          phase: "managed",
          stream: "stdout",
          offset: 0,
          bytesBase64: Buffer.from("abc").toString("base64"),
        });
      }
      let runtimeSequence = 1;
      let finalized = false;
      let resolveCompletion!: (result: SandboxExecutionResultV1) => void;
      const completion = new Promise<SandboxExecutionResultV1>((resolve) => {
        resolveCompletion = resolve;
      });
      void completion.then(() => {
        completionObserved = true;
      });
      const sample = (processFrames: number, physicsFrames: number) => ({
        processFrames,
        physicsFrames,
        processTimeUs: processFrames * 16_667,
        physicsTimeUs: physicsFrames * 16_667,
        configuredMainScene: launch.expectedMainScene,
        currentScene: launch.expectedMainScene,
      });
      const writeRuntime = (
        kind: "hello" | "ready" | "status_result" | "shutdown_ack",
        payload: Parameters<typeof makeGodotLifecycleWireMessage>[0]["payload"],
        requestId?: string,
      ): void => {
        readable.write(
          encodeWireFrame(
            JSON.stringify(
              makeGodotLifecycleWireMessage({
                sequence: kind === "hello" ? 0 : runtimeSequence++,
                kind,
                payload,
                ...(requestId === undefined ? {} : { requestId }),
              }),
            ),
          ),
        );
      };
      const finalize = (): void => {
        if (finalized) return;
        finalized = true;
        if (options.terminalStdout === true) {
          records.push({
            schemaVersion: 1,
            kind: "process_output",
            phase: "managed",
            stream: "stdout",
            offset: 0,
            bytesBase64: Buffer.from("abc").toString("base64"),
          });
        }
        const retainedStdout =
          options.truncatedStdout === true ||
          options.corruptedFullStdoutSummary === true ||
          options.terminalStdout === true
            ? 3
            : 0;
        records.push(
          {
            schemaVersion: 1,
            kind: "stream_summary",
            stream: "stdout",
            receipt: {
              totalBytes:
                options.truncatedStdout === true
                  ? 10
                  : options.corruptedFullStdoutSummary === true
                    ? 3
                    : options.terminalStdout === true
                      ? 3
                      : 0,
              sha256:
                options.truncatedStdout === true ||
                options.corruptedFullStdoutSummary === true
                  ? digest("managed-stdout")
                  : options.terminalStdout === true
                    ? digest("abc")
                    : emptyDigest,
              retainedBytes: retainedStdout,
              truncated: options.truncatedStdout === true,
            },
          },
          {
            schemaVersion: 1,
            kind: "stream_summary",
            stream: "stderr",
            receipt: {
              totalBytes: 0,
              sha256: emptyDigest,
              retainedBytes: 0,
              truncated: false,
            },
          },
          {
            schemaVersion: 1,
            kind: "godot_exit",
            exitCode: 0,
            signal: null,
            timedOut: false,
          },
        );
        if (options.omitManagedSourceVerification !== true) {
          records.push({
            schemaVersion: 1,
            kind: "source_verified",
            phase: "managed",
            candidateSourceHash: launch.candidateSourceHash,
            fileCount: 2,
            byteLength: 64,
          });
        }
        resolveCompletion(
          sandboxResult(
            "lifecycle-managed:test",
            options.managedCleanup ?? true,
          ),
        );
        readable.end();
      };
      naturalExit = finalize;
      const transport: GodotByteTransport = {
        readable,
        write: async (bytes) => {
          for (const json of decoder.push(bytes)) {
            const message = parseGodotLifecycleWireMessage(json);
            if (message.kind === "hello_accept") {
              writeRuntime(
                "ready",
                { baseline: sample(10, 20), observed: sample(130, 140) },
                message.requestId,
              );
            } else if (message.kind === "status") {
              writeRuntime(
                "status_result",
                sample(150, 160),
                message.requestId,
              );
            } else if (message.kind === "shutdown") {
              writeRuntime(
                "shutdown_ack",
                { status: sample(151, 161) },
                message.requestId,
              );
            }
          }
        },
        close: async () => {
          finalize();
        },
      };
      const sidecar: SandboxedGodotLifecycleSidecarV1 = {
        transport,
        completion,
        diagnostics: () => records,
        diagnosticFacts: () => ({
          ...facts(records),
          status: finalized ? "complete" : "open",
        }),
        terminate: async () => {
          terminateCalls += 1;
          finalize();
        },
      };
      queueMicrotask(() => {
        writeRuntime("hello", {
          token: launch.token,
          fingerprint: {
            schemaVersion: 1,
            protocolProfile: "chronorift-godot-lifecycle-v1",
            protocolVersion: 1,
            engine: "godot",
            engineVersion:
              options.fingerprintMismatch === true
                ? "4.7.2-stable (official)"
                : runtime.engineVersion,
            engineBuildHash: "a13da4feb",
            adapterVersion: "0.4.0",
            platform: "Linux",
            renderer: "gl_compatibility",
            displayServer: "headless",
            audioDriver: "Dummy",
            physicsTicksPerSecond: 60,
            configuredMainScene: launch.expectedMainScene,
            capabilities: [...GODOT_LIFECYCLE_CAPABILITIES_V1],
            identity: {
              taskId: launch.taskId,
              buildId: launch.buildId,
              runtimeId: launch.runtimeId,
              executionId: launch.executionId,
              managedRuntimeId: launch.managedRuntimeId,
              candidateSourceHash: launch.candidateSourceHash,
              overlayHash: launch.overlayHash,
              addonHash: launch.addonHash,
            },
          },
        });
      });
      return Promise.resolve({ kind: "opened" as const, sidecar });
    },
  };
  return {
    port,
    calls,
    naturalExit: () => naturalExit(),
    get terminateCalls() {
      return terminateCalls;
    },
    get managedOpenCalls() {
      return managedOpenCalls;
    },
    get completionObserved() {
      return completionObserved;
    },
  };
};

const launchRequest = (
  runtime: ReturnType<typeof managedRuntime>["capability"],
  prepared: PreparedExternalGodotLifecycleBuildV1,
) => ({
  taskId: asTaskId("task:external"),
  runtimeId: asRuntimeId("runtime:external"),
  executionId: asExecutionId("execution:external"),
  workspaceDirectory: "/workspace",
  prepared,
  managedRuntime: {
    managedRuntimeId: runtime.managedRuntimeId,
    addonHash: runtime.addonHash,
    overlayHash: runtime.overlayHash,
    vanillaSidecarSourceSha256: runtime.vanillaSidecarSourceSha256,
    lifecycleSidecarSourceSha256: runtime.lifecycleSidecarSourceSha256,
    protocolProfile: runtime.protocolProfile,
  },
  token: "e".repeat(64),
});

const captureLaunchFailure = async (
  attempt: Promise<unknown>,
): Promise<ExternalGodotLifecycleLaunchFailureV1> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ExternalGodotLifecycleLaunchFailureV1) return error;
    throw error;
  }
  throw new Error("expected lifecycle launch failure");
};

describe("external Godot lifecycle sandbox driver", () => {
  it("maps vanilla, ready/status, and controlled stop into ordered receipts", async () => {
    const runtime = managedRuntime();
    const prepared = preparedFor(runtime.capability);
    const harness = fakePort(runtime.capability);
    const driver = createExternalGodotLifecycleSandboxDriverV1({
      sidecarPort: harness.port,
      managedRuntime: runtime.capability,
      now: () => timestamp,
    });

    const session = await driver.launch(
      launchRequest(runtime.capability, prepared),
    );
    expect(harness.calls).toEqual(["vanilla", "managed"]);
    expect(session.initial.phases.map((phase) => phase.phase)).toEqual([
      "vanilla_import",
      "vanilla_smoke",
      "managed_import",
      "managed_handshake",
      "managed_status",
    ]);
    const vanillaImport = session.initial.phases[0]!;
    const vanillaSmoke = session.initial.phases[1]!;
    expect(vanillaImport).toMatchObject({
      timingFidelity: "operation_bounds",
      processDurationMs: 2_000,
      hostMonotonicStartUs: 1_000,
      hostMonotonicEndUs: 5_000_000,
    });
    expect(vanillaSmoke).toMatchObject({
      timingFidelity: "operation_bounds",
      processDurationMs: 2_000,
      stabilityObservedMs: 2_000,
      hostMonotonicStartUs: vanillaImport.hostMonotonicStartUs,
      hostMonotonicEndUs: vanillaImport.hostMonotonicEndUs,
    });
    expect(session.initial.facts.clocks).toMatchObject({
      processFrameDelta: 140,
      physicsTickDelta: 140,
    });
    expect(session.initial.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "clock",
          status: "sampled",
          emittedRecords: 3,
        }),
        expect.objectContaining({
          channel: "probe",
          status: "sampled",
          emittedRecords: 3,
        }),
      ]),
    );
    expect(session.initial.loss).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "clock", kind: "sampled" }),
        expect.objectContaining({
          channel: "probe",
          kind: "observer_effect",
        }),
      ]),
    );
    expect(session.initial.facts.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "clock", status: "partial" }),
      ]),
    );
    expect(session.initial.facts.loss).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "clock",
          kind: "unavailable",
        }),
      ]),
    );
    expect(lifecycleCleanupProven(session.initial.phases[1]!.cleanup!)).toBe(
      true,
    );

    const status = await session.status();
    expect(status).toMatchObject({
      facts: { status: "running" },
      phases: [{ phase: "managed_status" }],
    });
    expect(
      status.coverage.find((entry) => entry.channel === "clock")
        ?.emittedRecords,
    ).toBe(4);
    const stopped = await session.stop();
    expect(stopped.facts.status).toBe("stopped");
    expect(stopped.phases).toMatchObject([
      { phase: "managed_stop", outcome: "controlled_stop" },
    ]);
    expect(
      stopped.coverage.find((entry) => entry.channel === "clock")
        ?.emittedRecords,
    ).toBe(5);
    expect(lifecycleCleanupProven(stopped.cleanup)).toBe(true);
  });

  it("does not mount the managed overlay until vanilla cleanup is proven", async () => {
    const runtime = managedRuntime();
    const prepared = preparedFor(runtime.capability);
    const harness = fakePort(runtime.capability, { vanillaCleanup: false });
    const driver = createExternalGodotLifecycleSandboxDriverV1({
      sidecarPort: harness.port,
      managedRuntime: runtime.capability,
    });

    const failure = await captureLaunchFailure(
      driver.launch(launchRequest(runtime.capability, prepared)),
    );
    expect(failure.receipt).toMatchObject({
      stage: "vanilla_smoke",
      executionId: "execution:external",
      phases: [
        { phase: "vanilla_import", outcome: "succeeded" },
        { phase: "vanilla_smoke", cleanup: { scopeRemoved: false } },
      ],
      cleanup: { scopeRemoved: false },
    });
    expect(failure.receipt.coverage.length).toBeGreaterThan(0);
    expect(failure.receipt.loss.length).toBeGreaterThan(0);
    expect(harness.managedOpenCalls).toBe(0);
    expect(harness.calls).toEqual(["vanilla"]);
  });

  it("carries terminal vanilla process receipts in a typed launch failure", async () => {
    const runtime = managedRuntime();
    const prepared = preparedFor(runtime.capability);
    const harness = fakePort(runtime.capability, {
      vanillaFailedPhase: "vanilla",
    });
    const driver = createExternalGodotLifecycleSandboxDriverV1({
      sidecarPort: harness.port,
      managedRuntime: runtime.capability,
    });

    const failure = await captureLaunchFailure(
      driver.launch(launchRequest(runtime.capability, prepared)),
    );
    expect(failure.receipt).toMatchObject({
      stage: "vanilla_smoke",
      phases: [
        { phase: "vanilla_import", outcome: "succeeded", exitCode: 0 },
        {
          phase: "vanilla_smoke",
          outcome: "failed",
          exitCode: 1,
          cleanup: { processGroupTerminated: true },
        },
      ],
      cleanup: { processGroupTerminated: true },
    });
    expect(harness.managedOpenCalls).toBe(0);
  });

  it("returns broker cleanup when the managed sidecar cannot open", async () => {
    const runtime = managedRuntime();
    const prepared = preparedFor(runtime.capability);
    const harness = fakePort(runtime.capability, {
      managedOpenFailure: true,
    });
    const driver = createExternalGodotLifecycleSandboxDriverV1({
      sidecarPort: harness.port,
      managedRuntime: runtime.capability,
    });

    const failure = await captureLaunchFailure(
      driver.launch(launchRequest(runtime.capability, prepared)),
    );
    expect(failure.receipt).toMatchObject({
      stage: "managed_open",
      executionId: "execution:external",
      phases: [
        { phase: "vanilla_import" },
        { phase: "vanilla_smoke" },
        { phase: "managed_import", outcome: "failed" },
      ],
      cleanup: { processGroupTerminated: true },
    });
  });

  it("terminates and observes sandbox completion after handshake failure", async () => {
    const runtime = managedRuntime();
    const prepared = preparedFor(runtime.capability);
    const harness = fakePort(runtime.capability, {
      fingerprintMismatch: true,
    });
    const driver = createExternalGodotLifecycleSandboxDriverV1({
      sidecarPort: harness.port,
      managedRuntime: runtime.capability,
    });

    const failure = await captureLaunchFailure(
      driver.launch(launchRequest(runtime.capability, prepared)),
    );
    expect(failure).toBeInstanceOf(ExternalGodotLifecycleLaunchFailureV1);
    expect(failure.message).toMatch(/fingerprint mismatch/iu);
    expect(failure.receipt).toMatchObject({
      stage: "managed_handshake",
      executionId: "execution:external",
      phases: [
        { phase: "vanilla_import" },
        { phase: "vanilla_smoke" },
        { phase: "managed_import", outcome: "succeeded" },
        {
          phase: "managed_handshake",
          outcome: "failed",
          cleanup: { processGroupTerminated: true },
        },
      ],
      cleanup: { processGroupTerminated: true },
    });
    expect(harness.terminateCalls).toBe(1);
    expect(harness.completionObserved).toBe(true);
  });

  it("preserves handshake and incomplete-cleanup failures together", async () => {
    const runtime = managedRuntime();
    const prepared = preparedFor(runtime.capability);
    const harness = fakePort(runtime.capability, {
      fingerprintMismatch: true,
      managedCleanup: false,
    });
    const driver = createExternalGodotLifecycleSandboxDriverV1({
      sidecarPort: harness.port,
      managedRuntime: runtime.capability,
    });

    const failure = await captureLaunchFailure(
      driver.launch(launchRequest(runtime.capability, prepared)),
    );
    expect(failure.message).toMatch(/incomplete sandbox cleanup/iu);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect(failure.receipt).toMatchObject({
      stage: "managed_handshake",
      cleanup: { processGroupTerminated: false, scopeRemoved: false },
    });
    expect(harness.completionObserved).toBe(true);
  });

  it("preserves stream truncation as partial coverage and explicit loss", async () => {
    const runtime = managedRuntime();
    const prepared = preparedFor(runtime.capability);
    const harness = fakePort(runtime.capability, { truncatedStdout: true });
    const driver = createExternalGodotLifecycleSandboxDriverV1({
      sidecarPort: harness.port,
      managedRuntime: runtime.capability,
    });
    const session = await driver.launch(
      launchRequest(runtime.capability, prepared),
    );

    const stopped = await session.stop();
    expect(stopped.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "log", status: "partial" }),
      ]),
    );
    expect(stopped.loss).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "log",
          kind: "dropped",
          count: 7,
        }),
      ]),
    );
    expect(stopped.facts.diagnostics).toMatchObject({
      stdoutTotalBytes: 10,
      stdoutRetainedBytes: 3,
      stdoutTruncated: true,
    });
  });

  it("carries truncated process chunks and loss through a typed handshake failure once", async () => {
    const runtime = managedRuntime();
    const prepared = preparedFor(runtime.capability);
    const harness = fakePort(runtime.capability, {
      fingerprintMismatch: true,
      truncatedStdout: true,
    });
    const driver = createExternalGodotLifecycleSandboxDriverV1({
      sidecarPort: harness.port,
      managedRuntime: runtime.capability,
    });

    const failure = await captureLaunchFailure(
      driver.launch(launchRequest(runtime.capability, prepared)),
    );
    expect(failure.receipt.diagnostics).toHaveLength(1);
    expect(failure.receipt.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "log",
          status: "partial",
          emittedRecords: 1,
        }),
      ]),
    );
    expect(failure.receipt.loss).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "log",
          kind: "dropped",
          count: 7,
        }),
      ]),
    );
    expect(
      failure.receipt.phases.reduce(
        (total, receipt) => total + receipt.stdout.totalBytes,
        0,
      ),
    ).toBe(10);
  });

  for (const [name, options, stage] of [
    ["vanilla", { vanillaPortReject: true }, "vanilla_import"],
    ["managed", { managedPortReject: true }, "managed_open"],
  ] as const) {
    it(`wraps a direct ${name} sidecar rejection as an unknown-start typed failure`, async () => {
      const runtime = managedRuntime();
      const prepared = preparedFor(runtime.capability);
      const harness = fakePort(runtime.capability, options);
      const driver = createExternalGodotLifecycleSandboxDriverV1({
        sidecarPort: harness.port,
        managedRuntime: runtime.capability,
      });
      const failure = await captureLaunchFailure(
        driver.launch(launchRequest(runtime.capability, prepared)),
      );
      expect(failure.receipt).toMatchObject({
        stage,
        cleanup: null,
      });
      expect(failure.receipt.phases.at(-1)).toMatchObject({
        operationState: "unknown",
        cleanup: null,
      });
    });
  }

  it("requires exact vanilla and terminal managed source verification receipts", async () => {
    const runtime = managedRuntime();
    const prepared = preparedFor(runtime.capability);
    const vanillaDriver = createExternalGodotLifecycleSandboxDriverV1({
      sidecarPort: fakePort(runtime.capability, {
        omitVanillaSourceVerification: true,
      }).port,
      managedRuntime: runtime.capability,
    });
    await expect(
      captureLaunchFailure(
        vanillaDriver.launch(launchRequest(runtime.capability, prepared)),
      ),
    ).resolves.toMatchObject({ receipt: { stage: "vanilla_smoke" } });

    const managedDriver = createExternalGodotLifecycleSandboxDriverV1({
      sidecarPort: fakePort(runtime.capability, {
        omitManagedSourceVerification: true,
      }).port,
      managedRuntime: runtime.capability,
    });
    const session = await managedDriver.launch(
      launchRequest(runtime.capability, prepared),
    );
    await expect(session.stop()).resolves.toMatchObject({
      facts: { status: "crashed" },
    });
  });

  it("rejects a corrupt fully retained process-output summary", async () => {
    const runtime = managedRuntime();
    const prepared = preparedFor(runtime.capability);
    const driver = createExternalGodotLifecycleSandboxDriverV1({
      sidecarPort: fakePort(runtime.capability, {
        corruptedFullStdoutSummary: true,
      }).port,
      managedRuntime: runtime.capability,
    });
    const session = await driver.launch(
      launchRequest(runtime.capability, prepared),
    );
    await expect(session.stop()).rejects.toThrow(/does not match retained/iu);
  });

  it("allows combined vanilla and managed diagnostic chunks above one sidecar's count bound", async () => {
    const runtime = managedRuntime();
    const prepared = preparedFor(runtime.capability);
    const driver = createExternalGodotLifecycleSandboxDriverV1({
      sidecarPort: fakePort(runtime.capability, {
        vanillaPortReject: true,
      }).port,
      managedRuntime: runtime.capability,
    });
    const base = await captureLaunchFailure(
      driver.launch(launchRequest(runtime.capability, prepared)),
    );
    const diagnostics = Array.from({ length: 129 }, (_, offset) => ({
      schemaVersion: 1 as const,
      phase: "import" as const,
      stream: "stdout" as const,
      offset,
      byteLength: 1,
      sha256: digest("x"),
      bytesBase64: Buffer.from("x").toString("base64"),
    }));
    expect(
      new ExternalGodotLifecycleLaunchFailureV1({
        ...base.receipt,
        diagnostics,
      }).receipt.diagnostics,
    ).toHaveLength(129);
  });

  it("reports a naturally clean broker completion as stopped", async () => {
    const runtime = managedRuntime();
    const prepared = preparedFor(runtime.capability);
    const harness = fakePort(runtime.capability);
    const driver = createExternalGodotLifecycleSandboxDriverV1({
      sidecarPort: harness.port,
      managedRuntime: runtime.capability,
    });
    const session = await driver.launch(
      launchRequest(runtime.capability, prepared),
    );

    harness.naturalExit();
    await expect(session.status()).resolves.toMatchObject({
      facts: { status: "stopped" },
    });
    await expect(session.stop()).resolves.toMatchObject({
      facts: { status: "stopped" },
      phases: [{ phase: "managed_stop", outcome: "succeeded" }],
    });
  });
});
