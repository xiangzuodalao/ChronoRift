import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { asSha256DigestV1, type JsonValue } from "@chronorift/domain";
import { createRuntimeSidecarSource } from "@chronorift/godot-adapter";
import { WireFrameDecoder, encodeWireFrame } from "@chronorift/godot-protocol";
import { contentHash } from "@chronorift/json-artifacts";

import { SandboxToolchainCapabilityV1Schema } from "./contracts.js";
import { GodotSidecarPortV1 } from "./godot-sidecar-port.js";
import { createManagedGodotRuntimeV1 } from "./managed-godot-runtime.js";
import type {
  DuplexTaskSandboxBrokerV1,
  SandboxDuplexExecutionOptionsV1,
  SandboxExecutionResultV1,
} from "./sandbox-broker.js";

const digest = (value: string | Uint8Array) =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const jsonValue = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

const managedRuntime = () => {
  const files = [
    {
      target: "/bin/sh",
      sha256: digest("busybox"),
      command: false,
    },
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
      sha256: digest("xdg-user-dir"),
      command: false,
    },
  ] as const;
  const content = { schemaVersion: 1 as const, files };
  const capability = SandboxToolchainCapabilityV1Schema.parse({
    ...content,
    toolchainId: `sandbox-toolchain:v1:${contentHash(jsonValue(content))}`,
  });
  const source = createRuntimeSidecarSource({
    godotExecutable: "/opt/chronorift/bin/godot",
    workspaceRoot: "/workspace",
    runtimeRoot: "/run/chronorift",
  });
  return createManagedGodotRuntimeV1({
    doctorVersion: "4.7.1.stable.official.a13da4feb",
    nodeTarget: "/opt/chronorift/bin/node",
    godotTarget: "/opt/chronorift/bin/godot",
    toolchain: {
      capability,
      binding: {
        toolchainId: capability.toolchainId,
        files: [
          { target: files[0].target, hostPath: "/usr/bin/busybox" },
          { target: files[1].target, hostPath: "/usr/lib/libfontconfig.so.1" },
          { target: files[2].target, hostPath: "/usr/lib/godot" },
          { target: files[3].target, hostPath: "/usr/bin/node" },
          { target: files[4].target, hostPath: "/usr/bin/xdg-user-dir" },
        ],
      },
    },
    sidecarSource: source,
    addonFiles: [{ relativePath: "probe.gd", bytes: Buffer.from("probe") }],
  });
};

class FakeDuplexBroker implements DuplexTaskSandboxBrokerV1 {
  public request: unknown;
  public options: SandboxDuplexExecutionOptionsV1 | undefined;
  public readonly writes: Uint8Array[] = [];
  public inputEnded = false;
  public terminated = false;
  public failWrite = false;
  public failTerminate = false;
  public beforeOpenReturn:
    ((options: SandboxDuplexExecutionOptionsV1) => Promise<void>) | undefined;
  #resolveCompletion!: (value: SandboxExecutionResultV1) => void;
  readonly #completion = new Promise<SandboxExecutionResultV1>(
    (resolveCompletion) => {
      this.#resolveCompletion = resolveCompletion;
    },
  );

  public complete(result: SandboxExecutionResultV1): void {
    this.#resolveCompletion(result);
  }
  public async openDuplex(
    request: unknown,
    options?: SandboxDuplexExecutionOptionsV1,
  ) {
    this.request = request;
    this.options = options;
    if (options !== undefined) await this.beforeOpenReturn?.(options);
    return {
      kind: "opened" as const,
      handle: {
        write: async (bytes: Uint8Array) => {
          if (this.failWrite) throw new Error("prelude write failed");
          this.writes.push(Uint8Array.from(bytes));
        },
        endInput: async () => {
          this.inputEnded = true;
        },
        terminate: async () => {
          this.terminated = true;
          if (this.failTerminate) throw new Error("terminate failed");
        },
        completion: this.#completion,
      },
    };
  }

  public execute(): Promise<SandboxExecutionResultV1> {
    throw new Error("not used");
  }

  public cleanup(): Promise<never> {
    throw new Error("not used");
  }
}

const launch = () => ({
  schemaVersion: 1 as const,
  taskId: "task:test",
  buildId: "build:test",
  runtimeId: "runtime:test",
  executionId: "execution:test",
  candidateSourceHash: digest("candidate"),
  fixtureHash: digest("fixture"),
  projectHash: digest("project"),
  addonHash: digest("replaced-by-port"),
  protocolVersion: 2 as const,
  token: "e".repeat(64),
  fixedFps: 120 as const,
  physicsTicksPerSecond: 60 as const,
  fixtureControls: {},
  startupTimeoutMs: 30_000,
  executionTimeoutMs: 180_000,
  diagnosticFrameMaxBytes: 65_536,
  diagnosticTotalMaxBytes: 1024 * 1024,
  diagnosticMaxCount: 128,
});

const cleanupResult = (scopeRemoved = true): SandboxExecutionResultV1 => ({
  kind: "executed",
  receipt: {
    cleanup: {
      processGroupTerminated: scopeRemoved,
      cgroupPopulated: !scopeRemoved,
      scopeRemoved,
    },
  } as never,
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
});

describe("GodotSidecarPortV1", () => {
  it("keeps launch secrets out of argv and sends a validated framed prelude", async () => {
    const broker = new FakeDuplexBroker();
    const runtime = managedRuntime();
    const port = new GodotSidecarPortV1({ broker, managedRuntime: runtime });
    const opened = await port.open(launch());
    expect(opened.kind).toBe("opened");
    const serializedRequest = JSON.stringify(broker.request);
    expect(serializedRequest).not.toContain("e".repeat(64));
    expect(broker.request).toMatchObject({
      profile: "godot-headless",
      environment: {},
    });
    expect((broker.request as { argv: string[] }).argv.slice(0, 3)).toEqual([
      runtime.capability.nodeTarget,
      "--input-type=commonjs",
      "--eval",
    ]);
    const decoder = new WireFrameDecoder();
    const frames = decoder.push(broker.writes[0]!);
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!)).toMatchObject({
      token: "e".repeat(64),
      addonHash: runtime.capability.addonHash,
    });
    expect(JSON.parse(frames[0]!)).not.toHaveProperty("addonFiles");
  });

  it("waits for cleanup when diagnostics fail before openDuplex returns", async () => {
    const broker = new FakeDuplexBroker();
    broker.beforeOpenReturn = async (options) => {
      await options.onStderrChunk?.(encodeWireFrame("not-json"));
    };
    const completed = cleanupResult();
    broker.complete(completed);
    const port = new GodotSidecarPortV1({
      broker,
      managedRuntime: managedRuntime(),
    });

    await expect(port.open(launch())).resolves.toBe(completed);
    expect(broker.terminated).toBe(true);
  });

  it("waits for cleanup when the launch prelude cannot be written", async () => {
    const broker = new FakeDuplexBroker();
    broker.failWrite = true;
    const completed = cleanupResult();
    broker.complete(completed);
    const port = new GodotSidecarPortV1({
      broker,
      managedRuntime: managedRuntime(),
    });

    await expect(port.open(launch())).resolves.toBe(completed);
    expect(broker.terminated).toBe(true);
  });

  it("uses completion as cleanup truth even when terminate reports an error", async () => {
    const broker = new FakeDuplexBroker();
    broker.failWrite = true;
    broker.failTerminate = true;
    const completed = cleanupResult();
    broker.complete(completed);
    const port = new GodotSidecarPortV1({
      broker,
      managedRuntime: managedRuntime(),
    });

    await expect(port.open(launch())).resolves.toBe(completed);
    expect(broker.terminated).toBe(true);
  });

  it("returns an unproven cleanup receipt for the coordinator to reject", async () => {
    const broker = new FakeDuplexBroker();
    broker.failWrite = true;
    const completed = cleanupResult(false);
    broker.complete(completed);
    const port = new GodotSidecarPortV1({
      broker,
      managedRuntime: managedRuntime(),
    });

    await expect(port.open(launch())).resolves.toBe(completed);
    expect(completed).toMatchObject({
      kind: "executed",
      receipt: {
        cleanup: {
          processGroupTerminated: false,
          cgroupPopulated: true,
          scopeRemoved: false,
        },
      },
    });
  });

  it("parses fragmented strict diagnostics and terminates on corruption", async () => {
    const broker = new FakeDuplexBroker();
    const port = new GodotSidecarPortV1({
      broker,
      managedRuntime: managedRuntime(),
    });
    const opened = await port.open(launch());
    if (opened.kind !== "opened") throw new Error("expected sidecar");
    opened.sidecar.transport.readable.on("error", () => undefined);
    const frame = encodeWireFrame(
      JSON.stringify({
        schemaVersion: 1,
        kind: "godot_started",
        pid: 123,
      }),
    );
    await broker.options?.onStderrChunk?.(frame.subarray(0, 7));
    await broker.options?.onStderrChunk?.(frame.subarray(7));
    expect(opened.sidecar.diagnostics()).toEqual([
      { schemaVersion: 1, kind: "godot_started", pid: 123 },
    ]);

    await broker.options?.onStderrChunk?.(encodeWireFrame("not-json"));
    expect(broker.terminated).toBe(true);
    expect(opened.sidecar.diagnosticFacts()).toMatchObject({
      schemaVersion: 1,
      status: "failed",
      frameCount: 2,
      records: [{ kind: "godot_started", pid: 123 }],
      failure: { code: "diagnostic_protocol_failure" },
    });
  });

  it.each([
    {
      label: "frame",
      launchBounds: {
        diagnosticFrameMaxBytes: 1_024,
        diagnosticTotalMaxBytes: 4_096,
        diagnosticMaxCount: 4,
      },
      chunks: [
        (() => {
          const header = Buffer.alloc(4);
          header.writeUInt32BE(1_025);
          return header;
        })(),
      ],
      message: "frame",
    },
    {
      label: "total bytes",
      launchBounds: {
        diagnosticFrameMaxBytes: 1_024,
        diagnosticTotalMaxBytes: 4_096,
        diagnosticMaxCount: 128,
      },
      chunks: [Buffer.alloc(4_097)],
      message: "total byte",
    },
    {
      label: "frame count",
      launchBounds: {
        diagnosticFrameMaxBytes: 1_024,
        diagnosticTotalMaxBytes: 4_096,
        diagnosticMaxCount: 1,
      },
      chunks: [
        encodeWireFrame(
          JSON.stringify({
            schemaVersion: 1,
            kind: "godot_started",
            pid: 123,
          }),
        ),
        encodeWireFrame(
          JSON.stringify({
            schemaVersion: 1,
            kind: "godot_started",
            pid: 124,
          }),
        ),
      ],
      message: "frame count",
    },
  ])(
    "terminates on diagnostic $label overflow and exposes a bounded failure fact",
    async ({ launchBounds, chunks, message }) => {
      const broker = new FakeDuplexBroker();
      const port = new GodotSidecarPortV1({
        broker,
        managedRuntime: managedRuntime(),
      });
      const opened = await port.open({ ...launch(), ...launchBounds });
      if (opened.kind !== "opened") throw new Error("expected sidecar");
      opened.sidecar.transport.readable.on("error", () => undefined);
      for (const chunk of chunks) {
        await broker.options?.onStderrChunk?.(chunk);
      }
      expect(broker.terminated).toBe(true);
      const facts = opened.sidecar.diagnosticFacts();
      expect(facts).toMatchObject({
        status: "failed",
        limits: {
          frameMaxBytes: launchBounds.diagnosticFrameMaxBytes,
          totalMaxBytes: launchBounds.diagnosticTotalMaxBytes,
          maxCount: launchBounds.diagnosticMaxCount,
        },
        failure: { code: "diagnostic_protocol_failure" },
      });
      expect(facts.failure?.message).toContain(message);
      broker.complete({
        kind: "executed",
        receipt: {
          cleanup: {
            processGroupTerminated: true,
            cgroupPopulated: false,
            scopeRemoved: true,
          },
        } as never,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      });
      await expect(opened.sidecar.completion).resolves.toMatchObject({
        kind: "executed",
        receipt: {
          cleanup: {
            processGroupTerminated: true,
            cgroupPopulated: false,
            scopeRemoved: true,
          },
        },
      });
    },
  );

  it("keeps a framed sidecar limit failure visible while preserving cleanup proof", async () => {
    const broker = new FakeDuplexBroker();
    const port = new GodotSidecarPortV1({
      broker,
      managedRuntime: managedRuntime(),
    });
    const opened = await port.open(launch());
    if (opened.kind !== "opened") throw new Error("expected sidecar");
    await broker.options?.onStderrChunk?.(
      encodeWireFrame(
        JSON.stringify({
          schemaVersion: 1,
          kind: "sidecar_error",
          code: "DIAGNOSTIC_LIMIT_EXCEEDED",
          message: "diagnostic count bound exceeded",
        }),
      ),
    );
    expect(opened.sidecar.diagnosticFacts()).toMatchObject({
      status: "failed",
      records: [{ code: "DIAGNOSTIC_LIMIT_EXCEEDED" }],
      failure: { code: "diagnostic_limit_exceeded" },
    });
    broker.complete({
      kind: "executed",
      receipt: { cleanup: { scopeRemoved: true } } as never,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    });
    await expect(opened.sidecar.completion).resolves.toMatchObject({
      receipt: { cleanup: { scopeRemoved: true } },
    });
  });
});
