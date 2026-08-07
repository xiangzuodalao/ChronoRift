import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";

import {
  asSha256DigestV1,
  asTaskId,
  taskNamespaceDigestV1,
  type JsonValue,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import { buildSandboxProcessPlan } from "./bubblewrap-command.js";
import type {
  ObservedResourceUsageV1,
  SandboxExecutionRequestV1,
  SandboxHostCapabilityV1,
} from "./contracts.js";
import type {
  CgroupEnforcementLimitsV1,
  ExecutionCgroupScope,
} from "./cgroup-v2.js";
import { createSandboxPolicyV1 } from "./sandbox-policy.js";
import type { SandboxToolchainBindingV1 } from "./sandbox-toolchain.js";
import type {
  SandboxBootstrapLaunchPlan,
  SandboxBootstrapSession,
} from "./sandbox-bootstrap.js";
import {
  createBwrapCgroupTaskSandbox,
  createRetryableResourceCloser,
  type SandboxBrokerBoundResources,
  type SandboxBrokerCgroupController,
  type SandboxBrokerDependencies,
} from "./sandbox-broker.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const digest = asSha256DigestV1("a".repeat(64));
const taskId = asTaskId("task_broker_fixture");
const taskRoot = `/runtime/tasks/${taskNamespaceDigestV1(taskId)}`;
const capability: SandboxHostCapabilityV1 = {
  schemaVersion: 1,
  platform: "linux",
  architecture: "x64",
  bwrap: {
    identity: digest,
    version: "bubblewrap 1.0",
    features: ["block-fd", "json-status-fd", "bind-fd", "ro-bind-fd"],
  },
  prlimitIdentity: digest,
  runtimeIdentity: digest,
  delegatedCgroupRootIdentity: digest,
  controllers: ["cpu", "memory", "pids"],
  cgroupNamespaceUnshared: true,
  activeProbeSha256: digest,
};
const hostBinding = {
  delegatedCgroupRoot: "/sys/fs/cgroup/delegated",
  bwrapPath: "/usr/bin/bwrap",
  prlimitPath: "/usr/bin/prlimit",
  busyboxPath: "/usr/bin/busybox",
} as const;
const layout = {
  taskRootDirectory: taskRoot,
  taskRecordDirectory: `${taskRoot}/records`,
  workspaceDirectory: `${taskRoot}/workspace`,
  sandboxTemporaryDirectory: `${taskRoot}/tmp`,
  sandboxArtifactScratchDirectory: `${taskRoot}/sandbox-artifacts`,
  piSessionDirectory: `${taskRoot}/pi-sessions`,
  hostBaselineGitDirectory: `${taskRoot}/host-baseline.git`,
  hostOperationTemporaryDirectory: `${taskRoot}/host-tmp`,
} as const;
const policy = createSandboxPolicyV1(digest);
const toolchainFiles = [
  { target: "/bin/bash", sha256: digest, command: true },
  { target: "/lib/libc.so.6", sha256: digest, command: false },
] as const;
const toolchainCapability = {
  schemaVersion: 1 as const,
  toolchainId: `sandbox-toolchain:v1:${contentHash({
    schemaVersion: 1,
    files: toolchainFiles,
  } as unknown as JsonValue)}`,
  files: toolchainFiles,
};
const toolchainBinding: SandboxToolchainBindingV1 = {
  toolchainId: toolchainCapability.toolchainId,
  files: [
    { target: "/bin/bash", hostPath: "/usr/bin/bash" },
    { target: "/lib/libc.so.6", hostPath: "/usr/lib/libc.so.6" },
  ],
};
const validRequest: SandboxExecutionRequestV1 = {
  schemaVersion: 1,
  operationId: "operation_fixture",
  profile: "coding-default",
  argv: ["/bin/busybox", "true"],
  cwd: "/workspace",
  environment: {},
};

interface HarnessOptions {
  readonly hanging?: boolean;
  readonly childExitCode?: number;
  readonly statusChildPid?: number;
  readonly rejectChildVerification?: boolean;
  readonly stdoutChunks?: readonly Uint8Array[];
  readonly closeFails?: boolean;
  readonly cleanupFailsOnce?: boolean;
  readonly controllerCleanupFails?: boolean;
  readonly diagnosticRejects?: boolean;
  readonly trustFails?: boolean;
  readonly toolchain?: boolean;
}

class FakeScope implements ExecutionCgroupScope {
  public readonly scopeIdentity = "scope-fixture";
  public populatedValue = false;
  public killCount = 0;
  public removeCount = 0;

  public constructor(
    private readonly log: string[],
    private readonly rejectChildVerification: boolean,
  ) {}

  public async attach(pid: number): Promise<void> {
    this.log.push(`attach:${pid}`);
    this.populatedValue = true;
  }

  public async verifyAttached(reportedCgroupPath: string): Promise<void> {
    this.log.push(`verify:${reportedCgroupPath}`);
    if (this.rejectChildVerification) {
      throw new Error("bootstrap is outside execution cgroup");
    }
  }

  public async usage(): Promise<ObservedResourceUsageV1> {
    this.log.push("usage");
    return { cpuUsageUsec: 11, memoryPeakBytes: 22, pidsPeak: 3 };
  }

  public async kill(): Promise<boolean> {
    this.log.push("cgroup.kill");
    this.killCount += 1;
    const killed = this.populatedValue;
    this.populatedValue = false;
    return killed;
  }

  public async populated(): Promise<boolean> {
    this.log.push(`populated:${String(this.populatedValue)}`);
    return this.populatedValue;
  }

  public async remove(): Promise<void> {
    this.log.push("scope.remove");
    if (this.populatedValue) throw new Error("scope is populated");
    this.removeCount += 1;
  }
}

class FakeController implements SandboxBrokerCgroupController {
  public scopeCreates = 0;
  public cleanupCount = 0;

  public constructor(
    private readonly log: string[],
    readonly scope: FakeScope,
    private readonly cleanupFails: boolean,
    private readonly cleanupFailsOnce: boolean,
  ) {}

  public async createExecutionScope(
    operationId: string,
    _limits: CgroupEnforcementLimitsV1,
  ): Promise<ExecutionCgroupScope> {
    void _limits;
    this.log.push(`scope:${operationId}`);
    this.scopeCreates += 1;
    return this.scope;
  }

  public async cleanup(): Promise<void> {
    this.log.push("controller.cleanup");
    this.cleanupCount += 1;
    if (
      this.cleanupFails ||
      (this.cleanupFailsOnce && this.cleanupCount === 1)
    ) {
      throw new Error("controller cleanup failed");
    }
  }
}

class FakeBootstrapSession implements SandboxBootstrapSession {
  public readonly pid = 100;
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public authorized = false;
  public terminateCount = 0;
  public stdin = new Uint8Array();
  readonly #childExit = deferred<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>();
  readonly #bootstrapExit = deferred<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>();

  public constructor(
    private readonly log: string[],
    private readonly scope: FakeScope,
    private readonly options: HarnessOptions,
  ) {}

  public inspectCgroupMembership(): Promise<string> {
    this.log.push("inspect_cgroup");
    return Promise.resolve("/task-fixture/scope-fixture");
  }

  public async launch(_plan: SandboxBootstrapLaunchPlan): Promise<void> {
    void _plan;
    this.log.push("launch");
  }

  public async waitForChildStarted(): Promise<number> {
    this.log.push("child_started");
    return 200;
  }

  public async waitForSandboxStatus(): Promise<
    Readonly<Record<string, unknown>>
  > {
    this.log.push("status");
    return { "child-pid": this.options.statusChildPid ?? 200 };
  }

  public async authorize(): Promise<void> {
    this.log.push("authorize");
    this.authorized = true;
    if (this.options.hanging === true) return;
    for (const chunk of this.options.stdoutChunks ?? []) {
      this.stdout.write(chunk);
    }
    this.stdout.end();
    this.stderr.end();
    this.scope.populatedValue = false;
    const exit = {
      exitCode: this.options.childExitCode ?? 0,
      signal: null,
    } as const;
    this.#childExit.resolve(exit);
    this.#bootstrapExit.resolve(exit);
  }

  public async provideStdin(bytes: Uint8Array): Promise<void> {
    this.log.push(`stdin:${String(bytes.byteLength)}`);
    this.stdin = Uint8Array.from(bytes);
  }

  public async terminate(): Promise<void> {
    this.log.push("ipc:terminate");
    this.terminateCount += 1;
    this.stdout.end();
    this.stderr.end();
    const exit = { exitCode: null, signal: "SIGTERM" as const };
    this.#childExit.resolve(exit);
    this.#bootstrapExit.resolve(exit);
  }

  public waitForChildExit(): Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }> {
    return this.#childExit.promise;
  }

  public waitForBootstrapExit(): Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }> {
    return this.#bootstrapExit.promise;
  }
}

function createFakeBrokerHarness(options: HarnessOptions = {}) {
  const log: string[] = [];
  const securityEvents: unknown[] = [];
  const diagnostics: unknown[] = [];
  const scope = new FakeScope(log, options.rejectChildVerification === true);
  const controller = new FakeController(
    log,
    scope,
    options.controllerCleanupFails === true,
    options.cleanupFailsOnce === true,
  );
  const session = new FakeBootstrapSession(log, scope, options);
  let processStarts = 0;
  let controllerCreates = 0;
  let bindingCloses = 0;
  const boundResources: SandboxBrokerBoundResources = {
    workspaceFd: 40,
    temporaryFd: 41,
    artifactsFd: 42,
    runtimeFd: 43,
    toolchainFiles:
      options.toolchain === true
        ? [
            { fd: 44, target: "/bin/bash" },
            { fd: 45, target: "/lib/libc.so.6" },
          ]
        : [],
    close: async () => {
      log.push("bindings.close");
      bindingCloses += 1;
      if (
        options.closeFails === true ||
        (options.cleanupFailsOnce === true && bindingCloses === 1)
      ) {
        throw new Error("binding close failed");
      }
    },
  };
  const dependencies: SandboxBrokerDependencies = {
    verifyExecutableTrust: async (path) => {
      log.push(`trust:${path}`);
      if (options.trustFails === true) {
        throw new Error("unsafe executable path");
      }
    },
    bindResources: async () => {
      log.push("binding.verify");
      return boundResources;
    },
    createCgroupController: async () => {
      log.push("controller.create");
      controllerCreates += 1;
      return controller;
    },
    startBootstrap: async () => {
      log.push("bootstrap.start");
      processStarts += 1;
      return session;
    },
    buildProcessPlan: buildSandboxProcessPlan,
    sleep: async (milliseconds) => {
      log.push(`sleep:${milliseconds}`);
    },
    wallNow: () => "2026-08-07T00:00:00.000Z",
    reportDiagnostic: async (error) => {
      diagnostics.push(error);
      if (options.diagnosticRejects === true) {
        throw new Error("diagnostic sink failed");
      }
    },
  };
  let monotonic = 0;
  const brokerPromise = createBwrapCgroupTaskSandbox(
    {
      taskId,
      capability,
      hostBinding,
      policy:
        options.toolchain === true
          ? createSandboxPolicyV1(digest, {
              toolchainId: toolchainCapability.toolchainId,
              targets: toolchainCapability.files.map((file) => file.target),
            })
          : policy,
      ...(options.toolchain === true
        ? {
            toolchain: {
              capability: toolchainCapability,
              binding: toolchainBinding,
            },
          }
        : {}),
      layout,
      securityEvents: async (event) => {
        securityEvents.push(event);
      },
      clock: { now: () => (monotonic += 1) },
    },
    dependencies,
  );
  return {
    brokerPromise,
    controller,
    diagnostics,
    get bindingCloses() {
      return bindingCloses;
    },
    get controllerCreates() {
      return controllerCreates;
    },
    log,
    get processStarts() {
      return processStarts;
    },
    scope,
    securityEvents,
    session,
  };
}

describe("Task-bound sandbox broker", () => {
  it("denies executable, environment, and request-supplied mount data before side effects", async () => {
    for (const request of [
      { ...validRequest, argv: ["/bin/curl", "https://example.com"] },
      { ...validRequest, environment: { SSH_AUTH_SOCK: "/run/ssh.sock" } },
      {
        ...validRequest,
        mounts: [
          { source: layout.hostBaselineGitDirectory, target: "/source" },
        ],
      },
    ]) {
      const harness = createFakeBrokerHarness();
      const broker = await harness.brokerPromise;
      const result = await broker.execute(
        request as unknown as SandboxExecutionRequestV1,
      );
      expect(result).toMatchObject({
        kind: "denied",
        securityEvent: { sideEffectStarted: false },
      });
      expect(harness.controllerCreates).toBe(0);
      expect(harness.processStarts).toBe(0);
      expect(harness.securityEvents).toHaveLength(1);
      await broker.cleanup();
    }
  });

  it("authorizes only after bootstrap attach/readback and child status cgroup validation", async () => {
    const harness = createFakeBrokerHarness();
    const broker = await harness.brokerPromise;
    const result = await broker.execute(validRequest);
    expect(result).toMatchObject({
      kind: "executed",
      receipt: { status: "succeeded", exitCode: 0 },
    });
    const positions = [
      "scope:operation_fixture",
      "attach:100",
      "inspect_cgroup",
      "verify:/task-fixture/scope-fixture",
      "launch",
      "child_started",
      "status",
      "authorize",
    ].map((entry) => harness.log.indexOf(entry));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
    expect(harness.session.authorized).toBe(true);
    await broker.cleanup();
  });

  it("preserves command arguments containing an option separator", async () => {
    const harness = createFakeBrokerHarness();
    const broker = await harness.brokerPromise;
    const result = await broker.execute({
      ...validRequest,
      argv: ["/bin/busybox", "cat", "--", "/workspace/input.txt"],
    });
    expect(result).toMatchObject({
      kind: "executed",
      receipt: { status: "succeeded", exitCode: 0 },
    });
    await broker.cleanup();
  });

  it("binds opaque stdin bytes to the persisted request descriptor", async () => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    const request = {
      ...validRequest,
      stdin: {
        byteLength: bytes.byteLength,
        sha256: asSha256DigestV1(
          createHash("sha256").update(bytes).digest("hex"),
        ),
      },
    };
    const acceptedHarness = createFakeBrokerHarness();
    const acceptedBroker = await acceptedHarness.brokerPromise;
    await expect(
      acceptedBroker.execute(request, { stdin: bytes }),
    ).resolves.toMatchObject({
      kind: "executed",
      receipt: { requested: { stdin: request.stdin } },
    });
    expect(Buffer.from(acceptedHarness.session.stdin)).toEqual(bytes);
    await acceptedBroker.cleanup();

    const deniedHarness = createFakeBrokerHarness();
    const deniedBroker = await deniedHarness.brokerPromise;
    await expect(
      deniedBroker.execute(request, { stdin: Buffer.from("different") }),
    ).resolves.toMatchObject({
      kind: "denied",
      securityEvent: { sideEffectStarted: false },
    });
    expect(deniedHarness.processStarts).toBe(0);
    await deniedBroker.cleanup();
  });

  it("authorizes only commands declared by the frozen toolchain", async () => {
    const harness = createFakeBrokerHarness({ toolchain: true });
    const broker = await harness.brokerPromise;
    await expect(
      broker.execute({
        ...validRequest,
        argv: ["/bin/bash", "-lc", "true"],
      }),
    ).resolves.toMatchObject({
      kind: "executed",
      receipt: { status: "succeeded" },
    });
    expect(harness.log).toContain("stdin:0");

    await expect(
      broker.execute({ ...validRequest, argv: ["/lib/libc.so.6"] }),
    ).resolves.toMatchObject({
      kind: "denied",
      securityEvent: { sideEffectStarted: false },
    });
    await broker.cleanup();
  });

  it("never authorizes a bootstrap outside the execution cgroup", async () => {
    const harness = createFakeBrokerHarness({ rejectChildVerification: true });
    const broker = await harness.brokerPromise;
    const result = await broker.execute(validRequest);
    expect(result).toMatchObject({
      kind: "executed",
      receipt: { status: "launch_failed" },
    });
    expect(harness.session.authorized).toBe(false);
    expect(harness.log).toContain("ipc:terminate");
    expect(harness.log).toContain("cgroup.kill");
    await broker.cleanup();
  });

  it("selects timeout once, requests TERM only through bootstrap IPC, then uses cgroup.kill", async () => {
    const harness = createFakeBrokerHarness({ hanging: true });
    const broker = await harness.brokerPromise;
    const result = await broker.execute({ ...validRequest, timeoutMs: 1 });
    expect(result).toMatchObject({
      kind: "executed",
      receipt: {
        status: "timed_out",
        cleanup: {
          processGroupTerminated: true,
          termSent: true,
          killSent: true,
          cgroupPopulated: false,
          scopeRemoved: true,
        },
      },
    });
    expect(harness.session.terminateCount).toBe(1);
    expect(harness.scope.killCount).toBe(1);
    expect(harness.log.indexOf("ipc:terminate")).toBeLessThan(
      harness.log.indexOf("cgroup.kill"),
    );
    expect(harness.log).not.toContain(expect.stringMatching(/^signal:/u));
    await broker.cleanup();
  });

  it("classifies AbortSignal cancellation without allowing a later child exit to rewrite it", async () => {
    const harness = createFakeBrokerHarness({ hanging: true });
    const broker = await harness.brokerPromise;
    const controller = new AbortController();
    const execution = broker.execute(validRequest, {
      signal: controller.signal,
    });
    controller.abort();
    const result = await execution;
    expect(result).toMatchObject({
      kind: "executed",
      receipt: { status: "cancelled" },
    });
    await broker.cleanup();
  });

  it("drains output while running callbacks sequentially after callback failure", async () => {
    const chunks = [
      Buffer.from("one"),
      Buffer.from("two"),
      Buffer.from("three"),
    ];
    const harness = createFakeBrokerHarness({ stdoutChunks: chunks });
    const broker = await harness.brokerPromise;
    let activeCallbacks = 0;
    let maximumActiveCallbacks = 0;
    let callbackCount = 0;
    const result = await broker.execute(validRequest, {
      onStdoutChunk: async () => {
        callbackCount += 1;
        activeCallbacks += 1;
        maximumActiveCallbacks = Math.max(
          maximumActiveCallbacks,
          activeCallbacks,
        );
        try {
          await Promise.resolve();
          if (callbackCount === 1) throw new Error("consumer failed");
        } finally {
          activeCallbacks -= 1;
        }
      },
    });
    expect(result.kind).toBe("executed");
    if (result.kind !== "executed") throw new Error("expected execution");
    expect(Buffer.from(result.stdout).toString("utf8")).toBe("onetwothree");
    expect(result.receipt.stdout.totalBytes).toBe(11);
    expect(callbackCount).toBe(3);
    expect(maximumActiveCallbacks).toBe(1);
    expect(harness.diagnostics).toHaveLength(1);
    await broker.cleanup();
  });

  it("pauses the stream instead of queueing copies behind a slow callback", async () => {
    const chunks = Array.from({ length: 2_048 }, () =>
      Buffer.alloc(4 * 1024, 0x61),
    );
    const harness = createFakeBrokerHarness({ stdoutChunks: chunks });
    const broker = await harness.brokerPromise;
    const callbackStarted = deferred<void>();
    const releaseCallback = deferred<void>();
    let callbackCount = 0;
    const execution = broker.execute(validRequest, {
      onStdoutChunk: async () => {
        callbackCount += 1;
        if (callbackCount === 1) {
          callbackStarted.resolve();
          await releaseCallback.promise;
        }
      },
    });

    await callbackStarted.promise;
    expect(harness.session.stdout.isPaused()).toBe(true);
    expect(harness.session.stdout.readableLength).toBeGreaterThan(0);
    expect(callbackCount).toBe(1);

    releaseCallback.resolve();
    const result = await execution;
    expect(result).toMatchObject({
      kind: "executed",
      receipt: {
        status: "succeeded",
        stdout: { totalBytes: chunks.length * chunks[0]!.byteLength },
      },
    });
    expect(callbackCount).toBeGreaterThan(1);
    await broker.cleanup();
  });

  it("rejects Host executables that overlap a writable sandbox mount before binding", async () => {
    const harness = createFakeBrokerHarness();
    let bindingCalls = 0;
    await expect(
      createBwrapCgroupTaskSandbox(
        {
          taskId,
          capability,
          hostBinding: {
            ...hostBinding,
            prlimitPath: `${layout.workspaceDirectory}/prlimit`,
          },
          policy,
          layout,
          securityEvents: async () => undefined,
        },
        {
          verifyExecutableTrust: async () => undefined,
          bindResources: async () => {
            bindingCalls += 1;
            return {
              workspaceFd: 50,
              temporaryFd: 51,
              artifactsFd: 52,
              runtimeFd: 53,
              toolchainFiles: [],
              close: async () => undefined,
            };
          },
          createCgroupController: async () => harness.controller,
          startBootstrap: async () => harness.session,
          buildProcessPlan: buildSandboxProcessPlan,
          sleep: async () => undefined,
          wallNow: () => "2026-08-07T00:00:00.000Z",
          reportDiagnostic: async () => undefined,
        },
      ),
    ).rejects.toThrow(/overlap/u);
    expect(bindingCalls).toBe(0);
  });

  it("revalidates all Host executables before binding resources", async () => {
    const harness = createFakeBrokerHarness({ trustFails: true });
    await expect(harness.brokerPromise).rejects.toThrow(/unsafe executable/u);
    expect(harness.log).toContain(`trust:${hostBinding.bwrapPath}`);
    expect(harness.log).toContain(`trust:${hostBinding.prlimitPath}`);
    expect(harness.log).toContain(`trust:${hostBinding.busyboxPath}`);
    expect(harness.log).not.toContain("binding.verify");
  });

  it("classifies a nonzero command exit as failed rather than denied", async () => {
    const harness = createFakeBrokerHarness({ childExitCode: 7 });
    const broker = await harness.brokerPromise;
    const result = await broker.execute(validRequest);
    expect(result).toMatchObject({
      kind: "executed",
      receipt: { status: "failed", exitCode: 7 },
    });
    expect(harness.securityEvents).toHaveLength(0);
    await broker.cleanup();
  });

  it("closes pinned resources and task cgroup exactly once", async () => {
    const harness = createFakeBrokerHarness();
    const broker = await harness.brokerPromise;
    await broker.execute(validRequest);
    const first = await broker.cleanup();
    const second = await broker.cleanup();
    expect(second).toEqual(first);
    expect(harness.bindingCloses).toBe(1);
    expect(harness.controller.cleanupCount).toBe(1);
  });

  it("retries an unproven cleanup, then caches the proven receipt", async () => {
    const harness = createFakeBrokerHarness({ cleanupFailsOnce: true });
    const broker = await harness.brokerPromise;
    await broker.execute(validRequest);

    await expect(broker.cleanup()).resolves.toMatchObject({
      processGroupTerminated: false,
      cgroupPopulated: true,
      scopeRemoved: false,
    });
    const recovered = await broker.cleanup();
    expect(recovered).toMatchObject({
      processGroupTerminated: true,
      cgroupPopulated: false,
      scopeRemoved: true,
    });
    await expect(broker.cleanup()).resolves.toEqual(recovered);
    expect(harness.bindingCloses).toBe(2);
    expect(harness.controller.cleanupCount).toBe(2);
  });

  it("retries only resource handles whose previous close failed", async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const close = createRetryableResourceCloser([
      {
        close: async () => {
          firstCalls += 1;
          if (firstCalls === 1) throw new Error("transient close failure");
        },
      },
      {
        close: async () => {
          secondCalls += 1;
        },
      },
    ]);

    await expect(close()).rejects.toThrow(/transient close failure/u);
    expect([firstCalls, secondCalls]).toEqual([1, 1]);
    await expect(close()).resolves.toBeUndefined();
    await expect(close()).resolves.toBeUndefined();
    expect([firstCalls, secondCalls]).toEqual([2, 1]);
  });

  it("lets cleanup win an authorization race without starting side effects", async () => {
    const harness = createFakeBrokerHarness();
    const broker = await harness.brokerPromise;
    const execution = broker.execute(validRequest);
    const cleanup = broker.cleanup();
    await expect(execution).rejects.toMatchObject({
      code: "command_cancelled",
    });
    await expect(cleanup).resolves.toMatchObject({ scopeRemoved: true });
    expect(harness.controllerCreates).toBe(0);
    expect(harness.processStarts).toBe(0);
  });

  it("does not claim complete cleanup when controller or pinned-resource cleanup fails", async () => {
    const harness = createFakeBrokerHarness({
      closeFails: true,
      controllerCleanupFails: true,
    });
    const broker = await harness.brokerPromise;
    await broker.execute(validRequest);
    await expect(broker.cleanup()).resolves.toMatchObject({
      processGroupTerminated: false,
      cgroupPopulated: true,
      scopeRemoved: false,
    });
  });

  it("contains diagnostic sink rejection while continuing output drain", async () => {
    const harness = createFakeBrokerHarness({
      stdoutChunks: [Buffer.from("still-drained")],
      diagnosticRejects: true,
    });
    const broker = await harness.brokerPromise;
    const result = await broker.execute(validRequest, {
      onStdoutChunk: async () => {
        throw new Error("consumer failed");
      },
    });
    expect(result).toMatchObject({
      kind: "executed",
      receipt: { status: "succeeded", stdout: { totalBytes: 13 } },
    });
    await broker.cleanup();
  });

  it("fails Host binding verification before creating a cgroup or process", async () => {
    const harness = createFakeBrokerHarness();
    const dependencies: SandboxBrokerDependencies = {
      verifyExecutableTrust: async () => undefined,
      bindResources: async () => {
        throw new Error("runtime identity mismatch");
      },
      createCgroupController: async () => {
        throw new Error("must not create controller");
      },
      startBootstrap: async () => {
        throw new Error("must not start process");
      },
      buildProcessPlan: buildSandboxProcessPlan,
      sleep: async () => undefined,
      wallNow: () => "2026-08-07T00:00:00.000Z",
      reportDiagnostic: async () => undefined,
    };
    await expect(
      createBwrapCgroupTaskSandbox(
        {
          taskId,
          capability,
          hostBinding,
          policy,
          layout,
          securityEvents: async () => undefined,
        },
        dependencies,
      ),
    ).rejects.toThrow(/identity mismatch/u);
    expect(harness.controllerCreates).toBe(0);
    expect(harness.processStarts).toBe(0);
    await (await harness.brokerPromise).cleanup();
  });
});
