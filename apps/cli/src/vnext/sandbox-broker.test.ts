import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  asSha256DigestV1,
  asTaskId,
  taskNamespaceDigestV1,
  type JsonValue,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import {
  buildSandboxProcessPlan,
  type SandboxProcessPlan,
} from "./bubblewrap-command.js";
import type {
  ObservedResourceUsageV1,
  SandboxExecutionRequestV1,
  SandboxHostCapabilityV1,
} from "./contracts.js";
import type {
  CgroupEnforcementLimitsV1,
  ExecutionCgroupScope,
} from "./cgroup-v2.js";
import {
  createSandboxPolicyV1,
  createSandboxPolicyV2,
} from "./sandbox-policy.js";
import { createManagedGodotRuntimeV1 } from "./managed-godot-runtime.js";
import { createManagedGodotLifecycleRuntimeV1 } from "./managed-godot-lifecycle-runtime.js";
import type { SandboxToolchainBindingV1 } from "./sandbox-toolchain.js";
import type {
  SandboxBootstrapLaunchPlan,
  SandboxBootstrapSession,
} from "./sandbox-bootstrap.js";
import { SandboxBootstrapReadinessCleanupError } from "./sandbox-bootstrap.js";
import {
  createBwrapCgroupTaskSandbox,
  createBoundedExecutionScratch,
  createDuplexBwrapCgroupTaskSandbox,
  createRetryableResourceCloser,
  rethrowAfterBoundedSetupCleanup,
  SandboxBrokerSetupCleanupError,
  SandboxExecutionScratchCreationError,
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
const taskStorageCapability = {
  kind: "dedicated-capacity-bounded-filesystem-v1" as const,
  filesystem: "tmpfs" as const,
  totalBytes: 4_194_304,
  totalInodes: 1_024,
  rootIdentitySha256: digest,
};
const m3SandboxCapability: SandboxHostCapabilityV1 = {
  ...capability,
  bwrap: {
    ...capability.bwrap,
    features: [
      "block-fd",
      "json-status-fd",
      "bind-fd",
      "ro-bind-fd",
      "remount-ro",
    ],
  },
  taskStorage: taskStorageCapability,
};
const hostBinding = {
  delegatedCgroupRoot: "/sys/fs/cgroup/delegated",
  bwrapPath: "/usr/bin/bwrap",
  prlimitPath: "/usr/bin/prlimit",
  busyboxPath: "/usr/bin/busybox",
} as const;
const m3HostBinding = {
  ...hostBinding,
  taskStorageRoot: "/runtime",
} as const;
const layout = {
  taskRootDirectory: taskRoot,
  taskRecordDirectory: `${taskRoot}/records`,
  runtimeRecordDirectory: `${taskRoot}/runtime-records`,
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
const managedRuntimeFiles = [
  { target: "/bin/sh", sha256: digest, command: false },
  { target: "/lib/libc.so.6", sha256: digest, command: false },
  {
    target: "/lib/x86_64-linux-gnu/libfontconfig.so.1",
    sha256: digest,
    command: false,
  },
  { target: "/opt/chronorift/bin/godot", sha256: digest, command: true },
  { target: "/opt/chronorift/bin/node", sha256: digest, command: true },
  { target: "/usr/bin/xdg-user-dir", sha256: digest, command: false },
] as const;
const managedRuntimeCapability = {
  schemaVersion: 1 as const,
  toolchainId: `sandbox-toolchain:v1:${contentHash({
    schemaVersion: 1,
    files: managedRuntimeFiles,
  } as unknown as JsonValue)}`,
  files: managedRuntimeFiles,
};
const managedRuntimeBinding: SandboxToolchainBindingV1 = {
  toolchainId: managedRuntimeCapability.toolchainId,
  files: [
    { target: "/bin/sh", hostPath: "/usr/bin/busybox" },
    { target: "/lib/libc.so.6", hostPath: "/usr/lib/libc.so.6" },
    {
      target: "/lib/x86_64-linux-gnu/libfontconfig.so.1",
      hostPath: "/usr/lib/libfontconfig.so.1",
    },
    { target: "/opt/chronorift/bin/godot", hostPath: "/usr/lib/godot" },
    { target: "/opt/chronorift/bin/node", hostPath: "/usr/bin/node" },
    { target: "/usr/bin/xdg-user-dir", hostPath: "/usr/bin/xdg-user-dir" },
  ],
};
const managedRuntime = createManagedGodotRuntimeV1({
  doctorVersion: "4.7.1.stable.official.a13da4feb",
  nodeTarget: "/opt/chronorift/bin/node",
  godotTarget: "/opt/chronorift/bin/godot",
  toolchain: {
    capability: managedRuntimeCapability,
    binding: managedRuntimeBinding,
  },
  sidecarSource: "trusted sidecar source",
  addonFiles: [
    { relativePath: "plugin.cfg", bytes: Buffer.from("[plugin]\n") },
  ],
});
const managedLifecycleRuntime = createManagedGodotLifecycleRuntimeV1({
  doctorVersion: "4.7.1.stable.official.a13da4feb",
  nodeTarget: "/opt/chronorift/bin/node",
  godotTarget: "/opt/chronorift/bin/godot",
  toolchain: {
    capability: managedRuntimeCapability,
    binding: managedRuntimeBinding,
  },
  vanillaSidecarSource: "trusted vanilla sidecar source",
  lifecycleSidecarSource: "trusted lifecycle sidecar source",
  addonFiles: [
    {
      relativePath: "lifecycle_probe.gd",
      bytes: Buffer.from("extends Node\n"),
    },
  ],
});
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
  readonly blockStdinWrites?: boolean;
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
  readonly managedRuntime?: boolean;
  readonly managedLifecycleRuntime?: boolean;
  readonly managedShellPath?: string;
  readonly legacyManagedPolicy?: boolean;
  readonly storageBindingDrift?: boolean;
  readonly storageObservationFails?: boolean;
  readonly storageCleanupObservationFailsOnce?: boolean;
  readonly scratchCleanupFailsOnce?: boolean;
  readonly missingRemountCapability?: boolean;
  readonly scopeRemoveFails?: boolean;
  readonly scratchCreationCleanupFails?: boolean;
  readonly invalidBoundResources?: boolean;
  readonly bootstrapCleanupUnproven?: boolean;
  readonly mutateProcessPlan?:
    ((plan: SandboxProcessPlan) => SandboxProcessPlan) | undefined;
}

class FakeScope implements ExecutionCgroupScope {
  public readonly scopeIdentity = "scope-fixture";
  public populatedValue = false;
  public killCount = 0;
  public removeCount = 0;

  public constructor(
    private readonly log: string[],
    private readonly rejectChildVerification: boolean,
    private readonly removeFails: boolean,
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
    if (this.removeFails) throw new Error("scope removal failed");
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
  public stdinEnded = false;
  public stdinWritesStarted = 0;
  public launchPlan: SandboxBootstrapLaunchPlan | undefined;
  readonly #stdinWriteReleases: Deferred<void>[] = [];
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

  public async launch(plan: SandboxBootstrapLaunchPlan): Promise<void> {
    this.launchPlan = plan;
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

  public async writeStdin(bytes: Uint8Array): Promise<void> {
    if (this.stdinEnded) throw new Error("stdin is already ended");
    this.stdinWritesStarted += 1;
    if (this.options.blockStdinWrites === true) {
      const release = deferred<void>();
      this.#stdinWriteReleases.push(release);
      await release.promise;
    }
    this.log.push(`stdin:${String(bytes.byteLength)}`);
    this.stdin = Uint8Array.from([...this.stdin, ...bytes]);
  }

  public releaseNextStdinWrite(): void {
    const release = this.#stdinWriteReleases.shift();
    if (release === undefined) throw new Error("no pending stdin write");
    release.resolve();
  }

  public async endStdin(): Promise<void> {
    this.stdinEnded = true;
  }

  public async provideStdin(bytes: Uint8Array): Promise<void> {
    await this.writeStdin(bytes);
    await this.endStdin();
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
  const activeManagedRuntime =
    options.managedLifecycleRuntime === true
      ? managedLifecycleRuntime
      : options.managedRuntime === true
        ? managedRuntime
        : undefined;
  const log: string[] = [];
  const securityEvents: unknown[] = [];
  const diagnostics: unknown[] = [];
  const scope = new FakeScope(
    log,
    options.rejectChildVerification === true,
    options.scopeRemoveFails === true,
  );
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
  let scratchCreates = 0;
  let scratchCloseAttempts = 0;
  let bootstrapCleanupAttempts = 0;
  let bootstrapCleanupProven = false;
  let storageCleanupObservationFailures = 0;
  const scratchPaths: string[] = [];
  const activeScratchPaths = new Set<string>();
  const inspectedLayoutPaths: (readonly string[])[] = [];
  const bootstrapInheritedFds: (readonly number[])[] = [];
  const boundResources: SandboxBrokerBoundResources = {
    workspaceFd: 40,
    temporaryFd: 41,
    artifactsFd: options.invalidBoundResources === true ? 40 : 42,
    runtimeFd: 43,
    toolchainFiles:
      options.toolchain === true
        ? [
            { fd: 44, target: "/bin/bash" },
            { fd: 45, target: "/lib/libc.so.6" },
          ]
        : [],
    managedRuntimeFiles:
      activeManagedRuntime !== undefined
        ? [
            { fd: 46, target: "/bin/sh" },
            { fd: 47, target: "/lib/libc.so.6" },
            {
              fd: 48,
              target: "/lib/x86_64-linux-gnu/libfontconfig.so.1",
            },
            { fd: 49, target: "/opt/chronorift/bin/godot" },
            { fd: 50, target: "/opt/chronorift/bin/node" },
            { fd: 51, target: "/usr/bin/xdg-user-dir" },
          ]
        : [],
    ...(activeManagedRuntime !== undefined
      ? {
          managedFontconfig: {
            fd: 52,
            target: activeManagedRuntime.capability.fontconfigTarget,
          },
        }
      : {}),
    ...(activeManagedRuntime !== undefined
      ? {
          managedAddon: {
            parentFd: 53,
            parentTarget: activeManagedRuntime.capability.addonParentTarget,
            fd: 54,
            target: activeManagedRuntime.capability.addonTarget,
          },
        }
      : {}),
    ...(options.managedLifecycleRuntime === true
      ? {
          managedOverlay: {
            fd: 55,
            target: managedLifecycleRuntime.capability.overlayTarget,
          },
        }
      : {}),
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
    inspectTaskStorage: async (input) => {
      log.push("storage.inspect");
      inspectedLayoutPaths.push(input.layoutPaths);
      if (options.storageBindingDrift === true) {
        throw new Error("task storage binding drift");
      }
      if (options.storageObservationFails === true && processStarts > 0) {
        throw new Error("task storage observation failed");
      }
      if (
        options.storageCleanupObservationFailsOnce === true &&
        bindingCloses > 0 &&
        storageCleanupObservationFailures === 0
      ) {
        storageCleanupObservationFailures += 1;
        throw new Error("final task storage observation failed once");
      }
      return { usedBytes: 2_097_152, usedInodes: 24 };
    },
    createExecutionScratch: async ({ layout: taskLayout }) => {
      scratchCreates += 1;
      const path = `${taskLayout.hostOperationTemporaryDirectory}/runtime-${String(
        scratchCreates,
      )}`;
      const fd = 60 + scratchCreates;
      let closed = false;
      scratchPaths.push(path);
      activeScratchPaths.add(path);
      log.push(`scratch.create:${path}`);
      const scratch = {
        fd,
        path,
        close: async () => {
          scratchCloseAttempts += 1;
          log.push(`scratch.close:${path}`);
          if (
            options.scratchCleanupFailsOnce === true &&
            scratchCloseAttempts === 1
          ) {
            throw new Error("scratch cleanup failed");
          }
          if (!closed) {
            closed = true;
            activeScratchPaths.delete(path);
          }
        },
      };
      if (options.scratchCreationCleanupFails === true) {
        scratchCloseAttempts += 1;
        log.push(`scratch.close:${path}`);
        throw new SandboxExecutionScratchCreationError(
          "scratch validation failed without proven cleanup",
          scratch,
          new AggregateError(
            [
              new Error("scratch validation failed"),
              new Error("scratch cleanup failed"),
            ],
            "scratch creation and cleanup failed",
          ),
        );
      }
      return scratch;
    },
    createCgroupController: async () => {
      log.push("controller.create");
      controllerCreates += 1;
      return controller;
    },
    startBootstrap: async (input) => {
      log.push("bootstrap.start");
      processStarts += 1;
      bootstrapInheritedFds.push(input.inheritedFds);
      if (options.bootstrapCleanupUnproven === true) {
        throw new SandboxBootstrapReadinessCleanupError(
          new Error("sandbox bootstrap readiness timed out"),
          new Error("sandbox bootstrap termination timed out"),
          async () => {
            bootstrapCleanupAttempts += 1;
            log.push("bootstrap.cleanup");
            if (!bootstrapCleanupProven) {
              throw new Error("sandbox bootstrap termination timed out");
            }
          },
        );
      }
      return session;
    },
    buildProcessPlan: (input) => {
      const plan = buildSandboxProcessPlan(input);
      return options.mutateProcessPlan?.(plan) ?? plan;
    },
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
  const brokerPromise = createDuplexBwrapCgroupTaskSandbox(
    {
      taskId,
      capability:
        activeManagedRuntime !== undefined
          ? options.missingRemountCapability === true
            ? { ...m3SandboxCapability, bwrap: capability.bwrap }
            : m3SandboxCapability
          : capability,
      hostBinding:
        activeManagedRuntime !== undefined ? m3HostBinding : hostBinding,
      policy:
        activeManagedRuntime !== undefined &&
        options.legacyManagedPolicy !== true
          ? createSandboxPolicyV2(digest, {
              coding: {
                toolchainId: toolchainCapability.toolchainId,
                targets: toolchainCapability.files.map((file) => file.target),
              },
              godot: {
                toolchainId: managedRuntimeCapability.toolchainId,
                managedRuntimeId:
                  activeManagedRuntime.capability.managedRuntimeId,
                targets: [
                  ...managedRuntimeCapability.files.map((file) => file.target),
                  activeManagedRuntime.capability.fontconfigTarget,
                  activeManagedRuntime.capability.addonParentTarget,
                  activeManagedRuntime.capability.addonTarget,
                  ...(options.managedLifecycleRuntime === true
                    ? [managedLifecycleRuntime.capability.overlayTarget]
                    : []),
                ],
              },
            })
          : options.toolchain === true
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
      ...(activeManagedRuntime !== undefined
        ? {
            managedRuntime:
              options.managedRuntime === true &&
              options.managedShellPath !== undefined
                ? {
                    capability: managedRuntime.capability,
                    binding: {
                      ...managedRuntime.binding,
                      toolchain: {
                        ...managedRuntime.binding.toolchain,
                        files: managedRuntime.binding.toolchain.files.map(
                          (file) =>
                            file.target === "/bin/sh"
                              ? {
                                  ...file,
                                  hostPath:
                                    options.managedShellPath ?? file.hostPath,
                                }
                              : file,
                        ),
                      },
                    },
                  }
                : activeManagedRuntime,
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
    activeScratchPaths,
    bootstrapInheritedFds,
    get controllerCreates() {
      return controllerCreates;
    },
    log,
    inspectedLayoutPaths,
    get processStarts() {
      return processStarts;
    },
    get bootstrapCleanupAttempts() {
      return bootstrapCleanupAttempts;
    },
    proveBootstrapCleanup() {
      bootstrapCleanupProven = true;
    },
    scope,
    securityEvents,
    session,
    get scratchCloseAttempts() {
      return scratchCloseAttempts;
    },
    get scratchCreates() {
      return scratchCreates;
    },
    scratchPaths,
  };
}

describe("Task-bound sandbox broker", () => {
  it("allocates concurrent Host-only scratch roots and removes mode-000 candidate trees", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-scratch-test-"));
    const hostOnlyParent = join(root, "host-tmp");
    const sandboxTemporary = join(root, "sandbox-tmp");
    await Promise.all([
      mkdir(hostOnlyParent, { mode: 0o700 }),
      mkdir(sandboxTemporary, { mode: 0o700 }),
    ]);
    try {
      const [first, second] = await Promise.all([
        createBoundedExecutionScratch({
          temporaryDirectory: hostOnlyParent,
        }),
        createBoundedExecutionScratch({
          temporaryDirectory: hostOnlyParent,
        }),
      ]);
      expect(first.path).not.toBe(second.path);
      expect(first.path.startsWith(`${hostOnlyParent}/runtime-`)).toBe(true);
      expect(second.path.startsWith(`${hostOnlyParent}/runtime-`)).toBe(true);
      expect(await readdir(sandboxTemporary)).toEqual([]);

      const nested = join(first.path, "candidate", "nested");
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "file"), "candidate");
      const externalTarget = join(root, "must-survive");
      await writeFile(externalTarget, "outside");
      await symlink(externalTarget, join(first.path, "external-link"));
      await chmod(nested, 0o000);
      await chmod(join(first.path, "candidate"), 0o000);
      await chmod(first.path, 0o000);

      await Promise.all([first.close(), second.close()]);
      await expect(access(first.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(second.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(externalTarget, "utf8")).resolves.toBe("outside");
      await expect(first.close()).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
    if (result.kind !== "executed") throw new Error("expected execution");
    expect(result.receipt.realizedMechanisms.unavailable).toEqual([
      "aggregate-storage",
    ]);
    expect(harness.scratchCreates).toBe(0);
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

  it("opens a duplex execution only after authorization and keeps stdin writable", async () => {
    const harness = createFakeBrokerHarness({ hanging: true });
    const broker = await harness.brokerPromise;

    const opened = await broker.openDuplex(validRequest);

    expect(opened.kind).toBe("opened");
    if (opened.kind !== "opened") throw new Error("expected duplex handle");
    expect(harness.session.authorized).toBe(true);
    await opened.handle.write(Buffer.from("first"));
    await opened.handle.write(Buffer.from("second"));
    expect(Buffer.from(harness.session.stdin).toString("utf8")).toBe(
      "firstsecond",
    );
    expect(harness.session.stdinEnded).toBe(false);

    await opened.handle.endInput();
    expect(harness.session.stdinEnded).toBe(true);
    await expect(opened.handle.write(Buffer.from("late"))).rejects.toThrow(
      /ended/u,
    );

    await opened.handle.terminate();
    await expect(opened.handle.completion).resolves.toMatchObject({
      kind: "executed",
      receipt: { status: "cancelled" },
    });
    await broker.cleanup();
  });

  it("serializes duplex writes and waits for backpressure before ending stdin", async () => {
    const harness = createFakeBrokerHarness({
      hanging: true,
      blockStdinWrites: true,
    });
    const broker = await harness.brokerPromise;
    const opened = await broker.openDuplex(validRequest);
    if (opened.kind !== "opened") throw new Error("expected duplex handle");

    const first = opened.handle.write(Buffer.from("one"));
    const second = opened.handle.write(Buffer.from("two"));
    const ended = opened.handle.endInput();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.session.stdinWritesStarted).toBe(1);
    expect(harness.session.stdinEnded).toBe(false);

    harness.session.releaseNextStdinWrite();
    await first;
    await Promise.resolve();
    expect(harness.session.stdinWritesStarted).toBe(2);
    expect(harness.session.stdinEnded).toBe(false);

    harness.session.releaseNextStdinWrite();
    await Promise.all([second, ended]);
    expect(Buffer.from(harness.session.stdin).toString("utf8")).toBe("onetwo");
    expect(harness.session.stdinEnded).toBe(true);

    await opened.handle.terminate();
    await broker.cleanup();
  });

  it("cancels an open duplex execution when its AbortSignal fires", async () => {
    const harness = createFakeBrokerHarness({ hanging: true });
    const broker = await harness.brokerPromise;
    const controller = new AbortController();
    const opened = await broker.openDuplex(validRequest, {
      signal: controller.signal,
    });
    if (opened.kind !== "opened") throw new Error("expected duplex handle");

    controller.abort();

    await expect(opened.handle.completion).resolves.toMatchObject({
      kind: "executed",
      receipt: {
        status: "cancelled",
        cleanup: { processGroupTerminated: true, scopeRemoved: true },
      },
    });
    expect(harness.session.terminateCount).toBe(1);
    expect(harness.scope.killCount).toBe(1);
    await broker.cleanup();
  });

  it("cleanup cancels and drains an active duplex execution", async () => {
    const harness = createFakeBrokerHarness({ hanging: true });
    const broker = await harness.brokerPromise;
    const opened = await broker.openDuplex(validRequest);
    if (opened.kind !== "opened") throw new Error("expected duplex handle");

    const cleanup = await broker.cleanup();

    expect(cleanup).toMatchObject({
      processGroupTerminated: true,
      cgroupPopulated: false,
      scopeRemoved: true,
    });
    await expect(opened.handle.completion).resolves.toMatchObject({
      kind: "executed",
      receipt: { status: "cancelled" },
    });
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

  it("mounts and authorizes managed Godot commands only for the Godot profile", async () => {
    const harness = createFakeBrokerHarness({
      hanging: true,
      toolchain: true,
      managedRuntime: true,
    });
    const broker = await harness.brokerPromise;

    await expect(
      broker.execute({
        ...validRequest,
        argv: ["/opt/chronorift/bin/node", "--version"],
      }),
    ).resolves.toMatchObject({ kind: "denied" });
    for (const runtimeOnlyCommand of ["/bin/sh", "/usr/bin/xdg-user-dir"]) {
      await expect(
        broker.execute({
          ...validRequest,
          profile: "godot-headless",
          argv: [runtimeOnlyCommand],
        }),
      ).resolves.toMatchObject({ kind: "denied" });
    }
    await expect(
      broker.execute({
        ...validRequest,
        profile: "godot-headless",
        argv: ["/bin/bash", "-lc", "true"],
      }),
    ).resolves.toMatchObject({ kind: "denied" });

    const opened = await broker.openDuplex({
      ...validRequest,
      profile: "godot-headless",
      argv: ["/opt/chronorift/bin/node", "--version"],
    });
    expect(opened.kind).toBe("opened");
    if (opened.kind !== "opened") throw new Error("expected duplex handle");
    const serializedPlan = harness.session.launchPlan?.args.join("\0") ?? "";
    expect(serializedPlan).toContain(
      ["--ro-bind-fd", "5", "/workspace"].join("\0"),
    );
    expect(serializedPlan).toContain(
      ["--bind-fd", "8", "/run/chronorift"].join("\0"),
    );
    expect(serializedPlan).not.toContain("--tmpfs");
    expect(serializedPlan).toContain(
      ["--ro-bind-fd", "16", managedRuntime.capability.fontconfigTarget].join(
        "\0",
      ),
    );
    expect(serializedPlan).toContain(
      ["--ro-bind-fd", "17", managedRuntime.capability.addonParentTarget].join(
        "\0",
      ),
    );
    expect(serializedPlan).toContain(
      ["--ro-bind-fd", "18", managedRuntime.capability.addonTarget].join("\0"),
    );
    expect(harness.bootstrapInheritedFds).toEqual([
      [40, 41, 42, 61, 43, 46, 47, 48, 49, 50, 51, 52, 53, 54],
    ]);
    expect(harness.scratchPaths).toHaveLength(1);
    expect(harness.inspectedLayoutPaths).toContainEqual(
      expect.arrayContaining([harness.scratchPaths[0]]),
    );
    await opened.handle.terminate();
    const completion = await opened.handle.completion;
    expect(completion).toMatchObject({
      kind: "executed",
      receipt: {
        mountAdmission: {
          evidenceBasis: "validated-process-plan",
          profile: "godot-headless",
          workspaceAccess: "read-only",
          taskSharedWritableTargets: ["/tmp", "/artifacts"],
          operationPrivateWritableTargets: ["/run/chronorift"],
          credentialTargetCount: 0,
        },
        realizedMechanisms: {
          aggregateStorage: "dedicated-capacity-bounded-filesystem-v1",
          unavailable: [],
        },
        resourceUsage: {
          aggregateStorage: { usedBytes: 2_097_152, usedInodes: 24 },
        },
      },
    });
    expect(harness.activeScratchPaths).toEqual(new Set());
    expect(harness.scratchCloseAttempts).toBe(1);
    await broker.cleanup();
  });

  it("rejects a process plan that makes the Godot workspace writable", async () => {
    const harness = createFakeBrokerHarness({
      toolchain: true,
      managedRuntime: true,
      mutateProcessPlan: (plan) => {
        const args = [...plan.args];
        const workspaceTarget = args.findIndex(
          (argument, index) =>
            argument === "/workspace" && args[index - 2] === "--ro-bind-fd",
        );
        if (workspaceTarget < 2) throw new Error("missing workspace mount");
        args[workspaceTarget - 2] = "--bind-fd";
        return { ...plan, args };
      },
    });
    const broker = await harness.brokerPromise;
    const result = await broker.execute({
      ...validRequest,
      profile: "godot-headless",
      argv: ["/opt/chronorift/bin/node", "--version"],
    });
    expect(result).toMatchObject({
      kind: "executed",
      receipt: { status: "launch_failed" },
    });
    if (result.kind !== "executed") throw new Error("expected execution");
    expect(result.receipt.mountAdmission).toBeUndefined();
    expect(harness.processStarts).toBe(0);
    await broker.cleanup();
  });

  it("rejects an unexpected credential target in the process plan", async () => {
    const harness = createFakeBrokerHarness({
      toolchain: true,
      managedRuntime: true,
      mutateProcessPlan: (plan) => {
        const args = [...plan.args];
        const remountRoot = args.indexOf("--remount-ro");
        if (remountRoot < 0) throw new Error("missing root remount");
        args.splice(
          remountRoot,
          0,
          "--ro-bind-fd",
          "9",
          "/root/.pi/agent/auth.json",
        );
        return { ...plan, args };
      },
    });
    const broker = await harness.brokerPromise;
    const result = await broker.execute({
      ...validRequest,
      profile: "godot-headless",
      argv: ["/opt/chronorift/bin/node", "--version"],
    });
    expect(result).toMatchObject({
      kind: "executed",
      receipt: { status: "launch_failed" },
    });
    if (result.kind !== "executed") throw new Error("expected execution");
    expect(result.receipt.mountAdmission).toBeUndefined();
    expect(harness.processStarts).toBe(0);
    await broker.cleanup();
  });

  it("pins lifecycle addon and overlay mounts while preserving denial and cleanup boundaries", async () => {
    const harness = createFakeBrokerHarness({
      hanging: true,
      toolchain: true,
      managedLifecycleRuntime: true,
    });
    const broker = await harness.brokerPromise;

    await expect(
      broker.execute({
        ...validRequest,
        argv: ["/opt/chronorift/bin/node", "--version"],
      }),
    ).resolves.toMatchObject({
      kind: "denied",
      securityEvent: { sideEffectStarted: false },
    });
    const opened = await broker.openDuplex({
      ...validRequest,
      profile: "godot-headless",
      argv: ["/opt/chronorift/bin/node", "--version"],
    });
    if (opened.kind !== "opened") throw new Error("expected duplex handle");
    const serializedPlan = harness.session.launchPlan?.args.join("\0") ?? "";
    for (const [fd, target] of [
      ["17", managedLifecycleRuntime.capability.addonParentTarget],
      ["18", managedLifecycleRuntime.capability.addonTarget],
      ["19", managedLifecycleRuntime.capability.overlayTarget],
    ] as const) {
      expect(serializedPlan).toContain(["--ro-bind-fd", fd, target].join("\0"));
    }
    expect(harness.bootstrapInheritedFds).toEqual([
      [40, 41, 42, 61, 43, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55],
    ]);

    await opened.handle.terminate();
    await expect(opened.handle.completion).resolves.toMatchObject({
      kind: "executed",
      receipt: {
        status: "cancelled",
        cleanup: { processGroupTerminated: true, scopeRemoved: true },
      },
    });
    await expect(broker.cleanup()).resolves.toMatchObject({
      processGroupTerminated: true,
      cgroupPopulated: false,
      scopeRemoved: true,
      storageReconciled: true,
    });
  });

  it("does not claim Task storage reconciliation when final inspection is unavailable", async () => {
    const harness = createFakeBrokerHarness({
      toolchain: true,
      managedLifecycleRuntime: true,
      storageObservationFails: true,
    });
    const broker = await harness.brokerPromise;
    await expect(
      broker.execute({
        ...validRequest,
        profile: "godot-headless",
        argv: ["/opt/chronorift/bin/node", "--version"],
      }),
    ).resolves.toMatchObject({
      kind: "executed",
      receipt: { status: "succeeded" },
    });
    await expect(broker.cleanup()).resolves.toMatchObject({
      processGroupTerminated: true,
      cgroupPopulated: false,
      scopeRemoved: true,
      storageReconciled: false,
    });
    expect(
      harness.diagnostics.some(
        (diagnostic) =>
          diagnostic instanceof Error &&
          diagnostic.message === "task storage observation failed",
      ),
    ).toBe(true);
  });

  it("retries rather than caching a cleanup whose storage inspection was unproven", async () => {
    const harness = createFakeBrokerHarness({
      toolchain: true,
      managedLifecycleRuntime: true,
      storageCleanupObservationFailsOnce: true,
    });
    const broker = await harness.brokerPromise;
    await expect(broker.cleanup()).resolves.toMatchObject({
      processGroupTerminated: true,
      cgroupPopulated: false,
      scopeRemoved: true,
      storageReconciled: false,
    });
    const recovered = await broker.cleanup();
    expect(recovered).toMatchObject({
      processGroupTerminated: true,
      cgroupPopulated: false,
      scopeRemoved: true,
      storageReconciled: true,
    });
    await expect(broker.cleanup()).resolves.toEqual(recovered);
    expect(harness.bindingCloses).toBe(2);
  });

  it("keeps lifecycle addon and overlay mounts out of vanilla one-shot operations", async () => {
    const harness = createFakeBrokerHarness({
      toolchain: true,
      managedLifecycleRuntime: true,
    });
    const broker = await harness.brokerPromise;

    await expect(
      broker.execute({
        ...validRequest,
        profile: "godot-headless",
        argv: ["/opt/chronorift/bin/node", "--version"],
      }),
    ).resolves.toMatchObject({
      kind: "executed",
      receipt: { status: "succeeded" },
    });
    const serializedPlan = harness.session.launchPlan?.args.join("\0") ?? "";
    expect(serializedPlan).toContain(
      [
        "--ro-bind-fd",
        "16",
        managedLifecycleRuntime.capability.fontconfigTarget,
      ].join("\0"),
    );
    for (const target of [
      managedLifecycleRuntime.capability.addonParentTarget,
      managedLifecycleRuntime.capability.addonTarget,
      managedLifecycleRuntime.capability.overlayTarget,
    ]) {
      expect(serializedPlan).not.toContain(target);
    }
    expect(harness.bootstrapInheritedFds).toEqual([
      [40, 41, 42, 61, 43, 46, 47, 48, 49, 50, 51, 52],
    ]);
    await broker.cleanup();
  });

  it("retains failed operation scratch cleanup and retries it through broker cleanup", async () => {
    const harness = createFakeBrokerHarness({
      toolchain: true,
      managedRuntime: true,
      scratchCleanupFailsOnce: true,
    });
    const broker = await harness.brokerPromise;
    const result = await broker.execute({
      ...validRequest,
      profile: "godot-headless",
      argv: ["/opt/chronorift/bin/node", "--version"],
    });

    expect(result).toMatchObject({
      kind: "executed",
      receipt: {
        status: "succeeded",
        cleanup: {
          processGroupTerminated: true,
          cgroupPopulated: false,
          scopeRemoved: false,
        },
      },
    });
    expect(harness.activeScratchPaths).toEqual(
      new Set([harness.scratchPaths[0]]),
    );
    await expect(broker.cleanup()).resolves.toMatchObject({
      processGroupTerminated: true,
      cgroupPopulated: false,
      scopeRemoved: true,
    });
    expect(harness.activeScratchPaths).toEqual(new Set());
    expect(harness.scratchCloseAttempts).toBe(2);
  });

  it("retains bootstrap process and scratch ownership until cleanup proves exit", async () => {
    const harness = createFakeBrokerHarness({
      toolchain: true,
      managedRuntime: true,
      bootstrapCleanupUnproven: true,
    });
    const broker = await harness.brokerPromise;
    const result = await broker.execute({
      ...validRequest,
      profile: "godot-headless",
      argv: ["/opt/chronorift/bin/node", "--version"],
    });

    expect(result).toMatchObject({
      kind: "executed",
      receipt: {
        status: "launch_failed",
        cleanup: {
          processGroupTerminated: false,
          cgroupPopulated: false,
          scopeRemoved: false,
        },
      },
    });
    expect(harness.scratchCloseAttempts).toBe(0);
    expect(harness.activeScratchPaths).toEqual(
      new Set([harness.scratchPaths[0]]),
    );

    await expect(broker.cleanup()).resolves.toMatchObject({
      processGroupTerminated: false,
      cgroupPopulated: false,
      scopeRemoved: false,
    });
    expect(harness.bootstrapCleanupAttempts).toBe(1);
    expect(harness.scratchCloseAttempts).toBe(0);
    expect(harness.activeScratchPaths).toEqual(
      new Set([harness.scratchPaths[0]]),
    );

    harness.proveBootstrapCleanup();
    await expect(broker.cleanup()).resolves.toMatchObject({
      processGroupTerminated: true,
      cgroupPopulated: false,
      scopeRemoved: true,
    });
    expect(harness.bootstrapCleanupAttempts).toBe(2);
    expect(harness.scratchCloseAttempts).toBe(1);
    expect(harness.activeScratchPaths).toEqual(new Set());
  });

  it("retains scratch after bootstrap exit until cgroup scope cleanup is proven", async () => {
    const harness = createFakeBrokerHarness({
      toolchain: true,
      managedRuntime: true,
      scopeRemoveFails: true,
    });
    const broker = await harness.brokerPromise;
    const result = await broker.execute({
      ...validRequest,
      profile: "godot-headless",
      argv: ["/opt/chronorift/bin/node", "--version"],
    });

    expect(result).toMatchObject({
      kind: "executed",
      receipt: {
        cleanup: {
          processGroupTerminated: false,
          cgroupPopulated: false,
          scopeRemoved: false,
        },
      },
    });
    expect(harness.scratchCloseAttempts).toBe(0);
    expect(harness.activeScratchPaths).toEqual(
      new Set([harness.scratchPaths[0]]),
    );
    await expect(broker.cleanup()).resolves.toMatchObject({
      processGroupTerminated: true,
      cgroupPopulated: false,
      scopeRemoved: true,
    });
    expect(harness.scratchCloseAttempts).toBe(1);
    expect(harness.activeScratchPaths).toEqual(new Set());
  });

  it("retains allocator ownership when validation and initial removal both fail", async () => {
    const harness = createFakeBrokerHarness({
      toolchain: true,
      managedRuntime: true,
      scratchCreationCleanupFails: true,
    });
    const broker = await harness.brokerPromise;
    const result = await broker.execute({
      ...validRequest,
      profile: "godot-headless",
      argv: ["/opt/chronorift/bin/node", "--version"],
    });

    expect(result).toMatchObject({
      kind: "executed",
      receipt: {
        status: "launch_failed",
        cleanup: {
          processGroupTerminated: true,
          cgroupPopulated: false,
          scopeRemoved: false,
        },
      },
    });
    expect(harness.processStarts).toBe(0);
    expect(harness.scratchCloseAttempts).toBe(1);
    expect(harness.activeScratchPaths).toEqual(
      new Set([harness.scratchPaths[0]]),
    );
    await expect(broker.cleanup()).resolves.toMatchObject({
      processGroupTerminated: true,
      cgroupPopulated: false,
      scopeRemoved: true,
    });
    expect(harness.scratchCloseAttempts).toBe(2);
    expect(harness.activeScratchPaths).toEqual(new Set());
  });

  it("rejects a managed /bin/sh binding that does not reuse frozen busybox", async () => {
    const harness = createFakeBrokerHarness({
      toolchain: true,
      managedRuntime: true,
      managedShellPath: "/usr/bin/dash",
    });

    await expect(harness.brokerPromise).rejects.toThrow(
      /\/bin\/sh must reuse the frozen sandbox busybox identity/u,
    );
    expect(harness.processStarts).toBe(0);
  });

  it("rejects managed task-storage binding drift before binding or execution", async () => {
    const harness = createFakeBrokerHarness({
      toolchain: true,
      managedRuntime: true,
      storageBindingDrift: true,
    });

    await expect(harness.brokerPromise).rejects.toThrow(
      /storage binding drift/u,
    );
    expect(harness.log).not.toContain("binding.verify");
    expect(harness.processStarts).toBe(0);
  });

  it("records aggregate storage as unavailable when final observation fails", async () => {
    const harness = createFakeBrokerHarness({
      toolchain: true,
      managedRuntime: true,
      storageObservationFails: true,
    });
    const broker = await harness.brokerPromise;
    const result = await broker.execute(validRequest);

    expect(result).toMatchObject({
      kind: "executed",
      receipt: {
        realizedMechanisms: { unavailable: ["aggregate-storage"] },
      },
    });
    if (result.kind !== "executed") throw new Error("expected execution");
    expect(result.receipt.realizedMechanisms.aggregateStorage).toBeUndefined();
    expect(result.receipt.resourceUsage.aggregateStorage).toBeUndefined();
    expect(harness.diagnostics).toHaveLength(1);
    await broker.cleanup();
  });

  it("rejects managed runtime mounts under a legacy V1 policy", async () => {
    const harness = createFakeBrokerHarness({
      toolchain: true,
      managedRuntime: true,
      legacyManagedPolicy: true,
    });

    await expect(harness.brokerPromise).rejects.toThrow(
      /V1 policy cannot authorize a managed runtime/u,
    );
    expect(harness.processStarts).toBe(0);
  });

  it("rejects a Policy V2 capability that did not freeze remount-ro support", async () => {
    const harness = createFakeBrokerHarness({
      toolchain: true,
      managedRuntime: true,
      missingRemountCapability: true,
    });

    await expect(harness.brokerPromise).rejects.toThrow(/remount-ro/u);
    expect(harness.processStarts).toBe(0);
    expect(harness.log).not.toContain("binding.verify");
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
          inspectTaskStorage: async () => ({ usedBytes: 0, usedInodes: 0 }),
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
          createExecutionScratch: async () => {
            throw new Error("must not create operation scratch");
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

  it("proves cleanup after a mid-bind failure without retrying handles already closed", async () => {
    const primary = new Error("bind failed midway");
    let transientCalls = 0;
    let closedCalls = 0;
    const cleanup = createRetryableResourceCloser([
      {
        close: async () => {
          transientCalls += 1;
          if (transientCalls === 1) throw new Error("transient close failure");
        },
      },
      {
        close: async () => {
          closedCalls += 1;
        },
      },
    ]);

    await expect(
      rethrowAfterBoundedSetupCleanup(primary, cleanup),
    ).rejects.toBe(primary);
    expect([transientCalls, closedCalls]).toEqual([2, 1]);
  });

  it("retries post-bind validation cleanup and propagates retained ownership", async () => {
    const recovered = createFakeBrokerHarness({
      invalidBoundResources: true,
      cleanupFailsOnce: true,
    });
    await expect(recovered.brokerPromise).rejects.toThrow(/descriptors/u);
    expect(recovered.bindingCloses).toBe(2);

    const retained = createFakeBrokerHarness({
      invalidBoundResources: true,
      closeFails: true,
    });
    const error = await retained.brokerPromise.catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SandboxBrokerSetupCleanupError);
    expect(retained.bindingCloses).toBe(3);
    if (!(error instanceof SandboxBrokerSetupCleanupError)) {
      throw new Error("expected retained setup ownership");
    }
    await expect(error.retryCleanup()).rejects.toThrow(/binding close failed/u);
    expect(retained.bindingCloses).toBe(4);
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
      inspectTaskStorage: async () => ({ usedBytes: 0, usedInodes: 0 }),
      bindResources: async () => {
        throw new Error("runtime identity mismatch");
      },
      createExecutionScratch: async () => {
        throw new Error("must not create operation scratch");
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
