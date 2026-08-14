import { createHash } from "node:crypto";

import { asSha256DigestV1, type JsonValue } from "@chronorift/domain";
import {
  createLifecycleRuntimeSidecarSource,
  createLifecycleVanillaSmokeSidecarSource,
} from "@chronorift/godot-adapter";
import { WireFrameDecoder, encodeWireFrame } from "@chronorift/godot-protocol";
import { contentHash } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import { SandboxToolchainCapabilityV1Schema } from "./contracts.js";
import { GodotLifecycleSidecarPortV1 } from "./godot-lifecycle-sidecar-port.js";
import { createManagedGodotLifecycleRuntimeV1 } from "./managed-godot-lifecycle-runtime.js";
import type {
  DuplexTaskSandboxBrokerV1,
  SandboxDuplexExecutionOptionsV1,
  SandboxExecutionOptionsV1,
  SandboxExecutionResultV1,
} from "./sandbox-broker.js";

const digest = (value: string | Uint8Array) =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));
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
    nodeTarget: sourceOptions.godotExecutable.replace("godot", "node"),
    godotTarget: sourceOptions.godotExecutable,
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

const cleanupResult = (): SandboxExecutionResultV1 => ({
  kind: "executed",
  receipt: {
    status: "succeeded",
    cleanup: {
      processGroupTerminated: true,
      cgroupPopulated: false,
      scopeRemoved: true,
    },
  } as never,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
});

class FakeBroker implements DuplexTaskSandboxBrokerV1 {
  public request: unknown;
  public executeOptions: SandboxExecutionOptionsV1 | undefined;
  public duplexOptions: SandboxDuplexExecutionOptionsV1 | undefined;
  public readonly writes: Uint8Array[] = [];
  public terminated = false;
  public beforeExecute:
    ((options: SandboxExecutionOptionsV1) => Promise<void>) | undefined;
  public beforeOpen:
    ((options: SandboxDuplexExecutionOptionsV1) => Promise<void>) | undefined;
  #resolveCompletion!: (result: SandboxExecutionResultV1) => void;
  readonly #completion = new Promise<SandboxExecutionResultV1>((resolve) => {
    this.#resolveCompletion = resolve;
  });

  public complete(result: SandboxExecutionResultV1): void {
    this.#resolveCompletion(result);
  }

  public async execute(
    request: unknown,
    options: SandboxExecutionOptionsV1 = {},
  ): Promise<SandboxExecutionResultV1> {
    this.request = request;
    this.executeOptions = options;
    await this.beforeExecute?.(options);
    return cleanupResult();
  }

  public async openDuplex(
    request: unknown,
    options: SandboxDuplexExecutionOptionsV1 = {},
  ) {
    this.request = request;
    this.duplexOptions = options;
    await this.beforeOpen?.(options);
    return {
      kind: "opened" as const,
      handle: {
        write: async (bytes: Uint8Array) => {
          this.writes.push(Uint8Array.from(bytes));
        },
        endInput: async () => undefined,
        terminate: async () => {
          this.terminated = true;
        },
        completion: this.#completion,
      },
    };
  }

  public cleanup(): Promise<never> {
    throw new Error("not used");
  }
}

const common = {
  schemaVersion: 1 as const,
  runtimeProfile: "chronorift-managed-godot-lifecycle-v1" as const,
  taskId: "task:external",
  buildId: "build:external",
  runtimeId: "runtime:external",
  executionId: "execution:external",
  managedRuntimeId: `managed-godot-runtime:v1:${"a".repeat(64)}`,
  candidateSourceHash: digest("candidate"),
  diagnosticFrameMaxBytes: 65_536,
  diagnosticTotalMaxBytes: 1_048_576,
  diagnosticMaxCount: 128,
  outputCaptureMaxBytes: 262_144,
};

const vanillaLaunch = () => ({
  ...common,
  operation: "vanilla_smoke" as const,
  importTimeoutMs: 120_000,
  vanillaTimeoutMs: 10_000,
  stabilityWindowMs: 2_000 as const,
});

const managedLaunch = () => ({
  ...common,
  operation: "managed_lifecycle" as const,
  protocolProfile: "chronorift-godot-lifecycle-v1" as const,
  protocolVersion: 1 as const,
  token: "e".repeat(64),
  overlayHash: digest("replaced-overlay"),
  addonHash: digest("replaced-addon"),
  expectedMainScene: "res://main.tscn",
  importTimeoutMs: 120_000,
  startupTimeoutMs: 30_000,
  executionTimeoutMs: 450_000,
});

describe("GodotLifecycleSidecarPortV1", () => {
  it("sends a framed one-shot launch and parses bounded vanilla diagnostics", async () => {
    const broker = new FakeBroker();
    broker.beforeExecute = async (options) => {
      await options.onStderrChunk?.(
        encodeWireFrame(
          JSON.stringify({
            schemaVersion: 1,
            kind: "stage_ready",
            candidateSourceHash: common.candidateSourceHash,
            fileCount: 2,
            byteLength: 64,
          }),
        ),
      );
    };
    const runtime = managedRuntime();
    const port = new GodotLifecycleSidecarPortV1({
      broker,
      managedRuntime: runtime,
    });

    const result = await port.runVanillaSmoke(vanillaLaunch());
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") throw new Error("expected completion");
    expect(result.result.diagnosticFacts).toMatchObject({
      status: "complete",
      failure: null,
      records: [{ kind: "stage_ready" }],
    });
    const decoder = new WireFrameDecoder();
    const launchFrame = decoder.push(
      broker.executeOptions?.stdin ?? new Uint8Array(),
    );
    expect(JSON.parse(launchFrame[0]!)).toMatchObject({
      operation: "vanilla_smoke",
      managedRuntimeId: runtime.capability.managedRuntimeId,
    });
  });

  it("keeps the lifecycle token out of argv and replaces overlay identities", async () => {
    const broker = new FakeBroker();
    const runtime = managedRuntime();
    const port = new GodotLifecycleSidecarPortV1({
      broker,
      managedRuntime: runtime,
    });

    const opened = await port.openManaged(managedLaunch());
    expect(opened.kind).toBe("opened");
    expect(JSON.stringify(broker.request)).not.toContain("e".repeat(64));
    const decoder = new WireFrameDecoder();
    const launchFrame = decoder.push(broker.writes[0]!);
    expect(JSON.parse(launchFrame[0]!)).toMatchObject({
      token: "e".repeat(64),
      overlayHash: runtime.capability.overlayHash,
      addonHash: runtime.capability.addonHash,
    });
  });

  it("terminates and waits for cleanup when managed diagnostics are malformed", async () => {
    const broker = new FakeBroker();
    broker.beforeOpen = async (options) => {
      await options.onStderrChunk?.(encodeWireFrame("not-json"));
    };
    const completed = cleanupResult();
    broker.complete(completed);
    const port = new GodotLifecycleSidecarPortV1({
      broker,
      managedRuntime: managedRuntime(),
    });

    await expect(port.openManaged(managedLaunch())).resolves.toBe(completed);
    expect(broker.terminated).toBe(true);
  });

  it("preserves one-shot cleanup while reporting diagnostic frame overflow", async () => {
    const broker = new FakeBroker();
    broker.beforeExecute = async (options) => {
      const oversizedHeader = Buffer.alloc(4);
      oversizedHeader.writeUInt32BE(65_537);
      await options.onStderrChunk?.(oversizedHeader);
    };
    const port = new GodotLifecycleSidecarPortV1({
      broker,
      managedRuntime: managedRuntime(),
    });

    const result = await port.runVanillaSmoke(vanillaLaunch());
    expect(result).toMatchObject({
      kind: "completed",
      result: {
        sandbox: { kind: "executed" },
        diagnosticFacts: {
          status: "failed",
          failure: { code: "diagnostic_protocol_failure" },
        },
      },
    });
    expect(broker.executeOptions?.signal?.aborted).toBe(true);
  });
});
