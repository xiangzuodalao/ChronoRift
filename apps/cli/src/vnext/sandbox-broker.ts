import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import {
  asSha256DigestV1,
  taskNamespaceDigestV1,
  type JsonValue,
  type TaskId,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

import { BoundedOutputCapture } from "./bounded-output.js";
import {
  SANDBOX_FDS,
  buildSandboxProcessPlan,
  type BuildSandboxProcessPlanInput,
  type SandboxProcessPlan,
} from "./bubblewrap-command.js";
import {
  SandboxCleanupReceiptV1Schema,
  SandboxExecutionReceiptV1Schema,
  SandboxExecutionRequestV1Schema,
  SandboxHostCapabilityV1Schema,
  SandboxPolicyV1Schema,
  SandboxToolchainCapabilityV1Schema,
  SandboxOperationIdV1Schema,
  SecurityEventV1Schema,
  type ObservedResourceUsageV1,
  type SandboxCleanupReceiptV1,
  type SandboxExecutionReceiptV1,
  type SandboxExecutionRequestV1,
  type SandboxHostCapabilityV1,
  type SandboxPolicyV1,
  type SandboxToolchainCapabilityV1,
  type SecurityEventV1,
} from "./contracts.js";
import {
  CgroupV2Controller,
  waitForCgroupEmpty,
  type CgroupEnforcementLimitsV1,
  type ExecutionCgroupScope,
} from "./cgroup-v2.js";
import { M1Error, sanitizeM1Diagnostic } from "./errors.js";
import {
  startSandboxBootstrap,
  type SandboxBootstrapSession,
} from "./sandbox-bootstrap.js";
import {
  assertTrustedHostExecutablePath,
  type SandboxHostBinding,
} from "./sandbox-preflight.js";
import { resolveResourceLimitsV1 } from "./sandbox-policy.js";
import type { TaskDirectoryLayout } from "./task-paths.js";
import type { SandboxToolchainBindingV1 } from "./sandbox-toolchain.js";

export interface MonotonicClockV1 {
  now(): number;
}

export interface SandboxExecutionOptionsV1 {
  readonly signal?: AbortSignal | undefined;
  readonly stdin?: Uint8Array | undefined;
  readonly onStdoutChunk?:
    ((chunk: Uint8Array) => void | Promise<void>) | undefined;
  readonly onStderrChunk?:
    ((chunk: Uint8Array) => void | Promise<void>) | undefined;
}

export type SandboxExecutionResultV1 =
  | {
      readonly kind: "executed";
      readonly receipt: SandboxExecutionReceiptV1;
      readonly stdout: Uint8Array;
      readonly stderr: Uint8Array;
    }
  | { readonly kind: "denied"; readonly securityEvent: SecurityEventV1 };

export interface TaskSandboxBrokerV1 {
  execute(
    request: SandboxExecutionRequestV1,
    options?: SandboxExecutionOptionsV1,
  ): Promise<SandboxExecutionResultV1>;
  cleanup(): Promise<SandboxCleanupReceiptV1>;
}

export interface SandboxBrokerBoundResources {
  readonly workspaceFd: number;
  readonly temporaryFd: number;
  readonly artifactsFd: number;
  readonly runtimeFd: number;
  readonly toolchainFiles: readonly {
    readonly fd: number;
    readonly target: string;
  }[];
  close(): Promise<void>;
}

export interface SandboxBrokerCgroupController {
  createExecutionScope(
    operationId: string,
    limits: CgroupEnforcementLimitsV1,
  ): Promise<ExecutionCgroupScope>;
  cleanup(): Promise<void>;
}

export interface SandboxBrokerDependencies {
  verifyExecutableTrust(path: string): Promise<void>;
  bindResources(input: {
    readonly capability: SandboxHostCapabilityV1;
    readonly hostBinding: SandboxHostBinding;
    readonly layout: TaskDirectoryLayout;
    readonly toolchain?:
      | {
          readonly capability: SandboxToolchainCapabilityV1;
          readonly binding: SandboxToolchainBindingV1;
        }
      | undefined;
  }): Promise<SandboxBrokerBoundResources>;
  createCgroupController(input: {
    readonly delegatedCgroupRoot: string;
    readonly taskId: TaskId;
  }): Promise<SandboxBrokerCgroupController>;
  startBootstrap(input: {
    readonly cwd: string;
    readonly inheritedFds: readonly number[];
  }): Promise<SandboxBootstrapSession>;
  buildProcessPlan(input: BuildSandboxProcessPlanInput): SandboxProcessPlan;
  sleep(milliseconds: number): Promise<void>;
  wallNow(): string;
  reportDiagnostic(error: unknown): void | Promise<void>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

interface StreamDrain {
  readonly settled: Promise<void>;
}

type TerminalReason =
  | {
      readonly kind: "exit";
      readonly exitCode: number | null;
      readonly signal: string | null;
    }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "launch_failed"; readonly error: unknown };

interface ExecutionRuntime {
  scope: ExecutionCgroupScope | undefined;
  session: SandboxBootstrapSession | undefined;
  stdoutDrain: StreamDrain | undefined;
  stderrDrain: StreamDrain | undefined;
}

interface ActiveExecution {
  readonly cancel: () => void;
  readonly result: Promise<SandboxExecutionResultV1>;
}

const REALIZED_MECHANISMS = {
  cpu: "cgroup-v2",
  memory: "cgroup-v2",
  processCount: "cgroup-v2",
  openFiles: "rlimit-nofile",
  fileSize: "rlimit-fsize",
  wallTimeout: "host-monotonic-timer",
  unavailable: [],
} as const;

const EMPTY_USAGE: ObservedResourceUsageV1 = {
  cpuUsageUsec: 0,
  memoryPeakBytes: null,
  pidsPeak: null,
};

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return { promise, resolve: resolvePromise };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function assertLayout(taskId: TaskId, layout: TaskDirectoryLayout): void {
  if (
    !isObject(layout) ||
    !hasExactKeys(layout, [
      "taskRootDirectory",
      "taskRecordDirectory",
      "workspaceDirectory",
      "sandboxTemporaryDirectory",
      "sandboxArtifactScratchDirectory",
      "piSessionDirectory",
      "hostBaselineGitDirectory",
      "hostOperationTemporaryDirectory",
    ])
  ) {
    throw new M1Error("path_denied", "invalid Task directory layout");
  }
  const root = layout.taskRootDirectory;
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    basename(root) !== taskNamespaceDigestV1(taskId) ||
    basename(dirname(root)) !== "tasks"
  ) {
    throw new M1Error(
      "path_denied",
      "Task root does not match the derived Task namespace",
    );
  }
  const expected = {
    taskRecordDirectory: join(root, "records"),
    workspaceDirectory: join(root, "workspace"),
    sandboxTemporaryDirectory: join(root, "tmp"),
    sandboxArtifactScratchDirectory: join(root, "sandbox-artifacts"),
    piSessionDirectory: join(root, "pi-sessions"),
    hostBaselineGitDirectory: join(root, "host-baseline.git"),
    hostOperationTemporaryDirectory: join(root, "host-tmp"),
  } as const;
  for (const [key, value] of Object.entries(expected)) {
    if (layout[key as keyof typeof expected] !== value) {
      throw new M1Error(
        "path_denied",
        `Task layout ${key} is not the fixed Task child`,
      );
    }
  }
}

function assertHostBinding(binding: SandboxHostBinding): void {
  if (
    !isObject(binding) ||
    !hasExactKeys(binding, [
      "delegatedCgroupRoot",
      "bwrapPath",
      "prlimitPath",
      "busyboxPath",
    ]) ||
    !Object.values(binding).every(
      (value) => typeof value === "string" && value.length > 0,
    )
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "invalid physical sandbox Host binding",
    );
  }
}

function assertToolchainBinding(
  capability: SandboxToolchainCapabilityV1,
  binding: SandboxToolchainBindingV1,
): void {
  if (
    !isObject(binding) ||
    !hasExactKeys(binding, ["toolchainId", "files"]) ||
    binding.toolchainId !== capability.toolchainId ||
    !Array.isArray(binding.files) ||
    binding.files.length !== capability.files.length
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "invalid physical toolchain binding",
    );
  }
  for (const [index, file] of binding.files.entries()) {
    if (
      !isObject(file) ||
      !hasExactKeys(file, ["target", "hostPath"]) ||
      file.target !== capability.files[index]?.target ||
      typeof file.hostPath !== "string" ||
      !isAbsolute(file.hostPath) ||
      resolve(file.hostPath) !== file.hostPath
    ) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "invalid physical toolchain file binding",
      );
    }
  }
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

async function openPinned(
  path: string,
  kind: "directory" | "executable" | "runtime-file",
): Promise<FileHandle> {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    (await realpath(path)) !== path
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      `sandbox ${kind} path must be absolute, canonical, and symlink-free`,
    );
  }
  const before = await lstat(path);
  if (
    before.isSymbolicLink() ||
    (kind === "directory" ? !before.isDirectory() : !before.isFile()) ||
    (kind === "executable" && (before.mode & 0o111) === 0)
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      `sandbox ${kind} has the wrong file type or mode`,
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      (kind === "directory" ? constants.O_DIRECTORY : 0),
  );
  const opened = await handle.stat();
  if (
    opened.dev !== before.dev ||
    opened.ino !== before.ino ||
    (kind === "directory" ? !opened.isDirectory() : !opened.isFile())
  ) {
    await handle.close();
    throw new M1Error(
      "sandbox_preflight_failed",
      `sandbox ${kind} identity changed while opening`,
    );
  }
  return handle;
}

async function executableIdentity(path: string): Promise<string> {
  const handle = await openPinned(path, "executable");
  try {
    return sha256(await handle.readFile());
  } finally {
    await handle.close();
  }
}

export function createRetryableResourceCloser(
  resources: readonly { close(): Promise<void> }[],
): () => Promise<void> {
  const pending = new Set(resources);
  let activeAttempt: Promise<void> | undefined;
  return () => {
    if (activeAttempt !== undefined) return activeAttempt;
    if (pending.size === 0) return Promise.resolve();
    const attempted = [...pending].reverse();
    const closeAttempt = Promise.allSettled(
      attempted.map((resource) => resource.close()),
    ).then((results) => {
      let failureObserved = false;
      let firstFailure: unknown;
      for (const [index, result] of results.entries()) {
        const resource = attempted[index];
        if (resource === undefined) continue;
        if (result.status === "fulfilled") {
          pending.delete(resource);
        } else {
          if (!failureObserved) firstFailure = result.reason;
          failureObserved = true;
        }
      }
      if (failureObserved) {
        throw firstFailure instanceof Error
          ? firstFailure
          : new Error("sandbox resource close failed", {
              cause: firstFailure,
            });
      }
    });
    const trackedAttempt = closeAttempt.finally(() => {
      if (activeAttempt === trackedAttempt) activeAttempt = undefined;
    });
    activeAttempt = trackedAttempt;
    return trackedAttempt;
  };
}

async function bindDefaultResources(input: {
  readonly capability: SandboxHostCapabilityV1;
  readonly hostBinding: SandboxHostBinding;
  readonly layout: TaskDirectoryLayout;
  readonly toolchain?:
    | {
        readonly capability: SandboxToolchainCapabilityV1;
        readonly binding: SandboxToolchainBindingV1;
      }
    | undefined;
}): Promise<SandboxBrokerBoundResources> {
  const handles: FileHandle[] = [];
  try {
    const workspace = await openPinned(
      input.layout.workspaceDirectory,
      "directory",
    );
    handles.push(workspace);
    const temporary = await openPinned(
      input.layout.sandboxTemporaryDirectory,
      "directory",
    );
    handles.push(temporary);
    const artifacts = await openPinned(
      input.layout.sandboxArtifactScratchDirectory,
      "directory",
    );
    handles.push(artifacts);
    const runtime = await openPinned(
      input.hostBinding.busyboxPath,
      "executable",
    );
    handles.push(runtime);
    const toolchainFiles: { readonly fd: number; readonly target: string }[] =
      [];
    if (input.toolchain !== undefined) {
      if (
        input.toolchain.capability.toolchainId !==
          input.toolchain.binding.toolchainId ||
        input.toolchain.capability.files.length !==
          input.toolchain.binding.files.length
      ) {
        throw new M1Error(
          "sandbox_preflight_failed",
          "toolchain capability does not match its physical binding",
        );
      }
      for (const [
        index,
        capabilityFile,
      ] of input.toolchain.capability.files.entries()) {
        const bindingFile = input.toolchain.binding.files[index];
        if (bindingFile?.target !== capabilityFile.target) {
          throw new M1Error(
            "sandbox_preflight_failed",
            "toolchain binding targets do not match the frozen capability",
          );
        }
        const handle = await openPinned(bindingFile.hostPath, "runtime-file");
        handles.push(handle);
        if (sha256(await handle.readFile()) !== capabilityFile.sha256) {
          throw new M1Error(
            "sandbox_preflight_failed",
            "toolchain file no longer matches its frozen identity",
          );
        }
        toolchainFiles.push({ fd: handle.fd, target: capabilityFile.target });
      }
    }

    const [bwrapIdentity, prlimitIdentity, runtimeBytes, cgroupIdentity] =
      await Promise.all([
        executableIdentity(input.hostBinding.bwrapPath),
        executableIdentity(input.hostBinding.prlimitPath),
        runtime.readFile(),
        CgroupV2Controller.preflight(input.hostBinding.delegatedCgroupRoot),
      ]);
    const delegatedIdentity = contentHash({
      schemaVersion: 1,
      canonicalPath: cgroupIdentity.canonicalPath,
      device: cgroupIdentity.device.toString(),
      inode: cgroupIdentity.inode.toString(),
    });
    if (
      bwrapIdentity !== input.capability.bwrap.identity ||
      prlimitIdentity !== input.capability.prlimitIdentity ||
      sha256(runtimeBytes) !== input.capability.runtimeIdentity ||
      delegatedIdentity !== input.capability.delegatedCgroupRootIdentity
    ) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "physical sandbox binding no longer matches its frozen capability",
      );
    }

    const close = createRetryableResourceCloser(handles);
    return {
      workspaceFd: workspace.fd,
      temporaryFd: temporary.fd,
      artifactsFd: artifacts.fd,
      runtimeFd: runtime.fd,
      toolchainFiles: Object.freeze(toolchainFiles),
      close,
    };
  } catch (error) {
    await Promise.allSettled(
      [...handles].reverse().map((handle) => handle.close()),
    );
    throw error;
  }
}

const defaultDependencies: SandboxBrokerDependencies = {
  verifyExecutableTrust: async (path) => {
    await assertTrustedHostExecutablePath(path);
  },
  bindResources: bindDefaultResources,
  createCgroupController: ({ delegatedCgroupRoot, taskId }) =>
    CgroupV2Controller.create(delegatedCgroupRoot, taskId),
  startBootstrap: (input) => startSandboxBootstrap(input),
  buildProcessPlan: buildSandboxProcessPlan,
  sleep: (milliseconds) =>
    new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  wallNow: () => new Date().toISOString(),
  reportDiagnostic: () => undefined,
};

function assertBoundDescriptors(resources: SandboxBrokerBoundResources): void {
  const descriptors = [
    resources.workspaceFd,
    resources.temporaryFd,
    resources.artifactsFd,
    resources.runtimeFd,
    ...resources.toolchainFiles.map((file) => file.fd),
  ];
  if (
    !descriptors.every((fd) => Number.isInteger(fd) && fd >= 0) ||
    new Set(descriptors).size !== descriptors.length
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "pinned sandbox descriptors must be distinct nonnegative integers",
    );
  }
}

function captureStream(
  stream: NodeJS.ReadableStream,
  capture: BoundedOutputCapture,
  callback: ((chunk: Uint8Array) => void | Promise<void>) | undefined,
  reportDiagnostic: (error: unknown) => void | Promise<void>,
): StreamDrain {
  const ended = deferred<void>();
  let callbackTail = Promise.resolve();
  let streamEnded = false;
  const finish = (): void => {
    if (streamEnded) return;
    streamEnded = true;
    ended.resolve();
  };
  stream.on("data", (rawChunk: unknown) => {
    const chunk =
      typeof rawChunk === "string"
        ? Buffer.from(rawChunk)
        : Buffer.from(rawChunk as Uint8Array);
    capture.add(chunk);
    if (callback !== undefined) {
      stream.pause();
      const owned = Uint8Array.from(chunk);
      callbackTail = Promise.resolve()
        .then(() => callback(owned))
        .catch((error: unknown) =>
          Promise.resolve(reportDiagnostic(error)).catch(() => undefined),
        )
        .then(() => {
          if (!streamEnded) stream.resume();
        });
    }
  });
  stream.once("end", finish);
  stream.once("close", finish);
  stream.once("error", (error: unknown) => {
    void Promise.resolve(reportDiagnostic(error));
    finish();
  });
  return {
    settled: ended.promise.then(() => callbackTail),
  };
}

const pathAtOrBelow = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith("../") &&
      !isAbsolute(difference))
  );
};

function assertHostExecutablesOutsideWritableLayout(
  binding: SandboxHostBinding,
  layout: TaskDirectoryLayout,
  toolchain: SandboxToolchainBindingV1 | undefined,
): void {
  const executables = [
    binding.bwrapPath,
    binding.prlimitPath,
    binding.busyboxPath,
    ...(toolchain?.files.map((file) => file.hostPath) ?? []),
  ];
  const writableRoots = [
    layout.workspaceDirectory,
    layout.sandboxTemporaryDirectory,
    layout.sandboxArtifactScratchDirectory,
  ];
  if (
    executables.some((executable) =>
      writableRoots.some(
        (root) =>
          pathAtOrBelow(root, executable) || pathAtOrBelow(executable, root),
      ),
    )
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox Host executable paths must not overlap writable Task paths",
    );
  }
}

function assertProcessPlan(
  plan: SandboxProcessPlan,
  request: SandboxExecutionRequestV1,
  binding: SandboxHostBinding,
  layout: TaskDirectoryLayout,
  runtimeTargets: readonly { readonly fd: number; readonly target: string }[],
  toolchainBinding: SandboxToolchainBindingV1 | undefined,
): void {
  const expectedFds = [
    SANDBOX_FDS.block,
    SANDBOX_FDS.status,
    SANDBOX_FDS.workspace,
    SANDBOX_FDS.temporary,
    SANDBOX_FDS.artifacts,
    ...runtimeTargets.map((target) => target.fd),
  ];
  const commandSeparator = plan.args.length - request.argv.length - 1;
  if (
    plan.executable !== binding.prlimitPath ||
    plan.args[3] !== "--" ||
    plan.args[4] !== binding.bwrapPath ||
    JSON.stringify(plan.inheritedFds) !== JSON.stringify(expectedFds) ||
    commandSeparator <= 4 ||
    plan.args[commandSeparator] !== "--" ||
    JSON.stringify(plan.args.slice(commandSeparator + 1)) !==
      JSON.stringify(request.argv)
  ) {
    throw new M1Error(
      "sandbox_launch_failed",
      "sandbox process plan crossed its fixed executable or FD boundary",
    );
  }
  const serialized = [plan.executable, ...plan.args].join("\0");
  for (const forbidden of [
    layout.taskRecordDirectory,
    layout.hostBaselineGitDirectory,
    layout.hostOperationTemporaryDirectory,
    binding.busyboxPath,
    ...(toolchainBinding?.files
      .filter((file) => file.hostPath !== file.target)
      .map((file) => file.hostPath) ?? []),
  ]) {
    if (serialized.includes(forbidden)) {
      throw new M1Error(
        "sandbox_launch_failed",
        "sandbox process plan exposed a forbidden Host path",
      );
    }
  }
}

class BwrapCgroupTaskSandbox implements TaskSandboxBrokerV1 {
  readonly #active = new Set<ActiveExecution>();
  readonly #executionCleanupReceipts: SandboxCleanupReceiptV1[] = [];
  #controllerPromise: Promise<SandboxBrokerCgroupController> | undefined;
  #closed = false;
  #cleanupPromise: Promise<SandboxCleanupReceiptV1> | undefined;

  public constructor(
    private readonly taskId: TaskId,
    private readonly capability: SandboxHostCapabilityV1,
    private readonly capabilitySha256: ReturnType<typeof asSha256DigestV1>,
    private readonly hostBinding: SandboxHostBinding,
    private readonly policy: SandboxPolicyV1,
    private readonly toolchain:
      | {
          readonly capability: SandboxToolchainCapabilityV1;
          readonly binding: SandboxToolchainBindingV1;
        }
      | undefined,
    private readonly layout: TaskDirectoryLayout,
    private readonly resources: SandboxBrokerBoundResources,
    private readonly securityEvents: (event: SecurityEventV1) => Promise<void>,
    private readonly clock: MonotonicClockV1,
    private readonly dependencies: SandboxBrokerDependencies,
  ) {}

  public async execute(
    request: SandboxExecutionRequestV1,
    options: SandboxExecutionOptionsV1 = {},
  ): Promise<SandboxExecutionResultV1> {
    if (this.#closed) {
      throw new M1Error(
        "command_cancelled",
        "Task sandbox broker is already cleaned",
      );
    }
    const ownedStdin =
      options.stdin === undefined ? undefined : Uint8Array.from(options.stdin);
    const authorized = await this.authorizeRequest(request, ownedStdin);
    if (authorized.kind === "denied") return authorized;
    if (this.#closed) {
      throw new M1Error(
        "command_cancelled",
        "Task sandbox cleanup won the authorization race",
      );
    }

    const active = this.startExecution(authorized.request, {
      ...options,
      ...(ownedStdin === undefined ? {} : { stdin: ownedStdin }),
    });
    this.#active.add(active);
    try {
      const result = await active.result;
      if (result.kind === "executed") {
        this.#executionCleanupReceipts.push(result.receipt.cleanup);
      }
      return result;
    } finally {
      this.#active.delete(active);
    }
  }

  public cleanup(): Promise<SandboxCleanupReceiptV1> {
    if (this.#cleanupPromise !== undefined) return this.#cleanupPromise;
    const attempt = this.cleanupOnce();
    this.#cleanupPromise = attempt;
    void attempt.then(
      (receipt) => {
        if (
          (!receipt.processGroupTerminated ||
            receipt.cgroupPopulated ||
            !receipt.scopeRemoved) &&
          this.#cleanupPromise === attempt
        ) {
          this.#cleanupPromise = undefined;
        }
      },
      () => {
        if (this.#cleanupPromise === attempt) this.#cleanupPromise = undefined;
      },
    );
    return attempt;
  }

  private async authorizeRequest(
    rawRequest: SandboxExecutionRequestV1,
    stdin: Uint8Array | undefined,
  ): Promise<
    | {
        readonly kind: "authorized";
        readonly request: SandboxExecutionRequestV1;
      }
    | { readonly kind: "denied"; readonly securityEvent: SecurityEventV1 }
  > {
    const parsed = SandboxExecutionRequestV1Schema.safeParse(rawRequest);
    if (!parsed.success) {
      return this.deny(
        rawRequest,
        "capability_denied",
        "invalid sandbox request",
      );
    }
    const request = parsed.data;
    if (
      (request.stdin === undefined) !== (stdin === undefined) ||
      (request.stdin !== undefined &&
        stdin !== undefined &&
        (request.stdin.byteLength !== stdin.byteLength ||
          request.stdin.sha256 !== sha256(stdin)))
    ) {
      return this.deny(
        request,
        "capability_denied",
        "stdin bytes do not match the declared bounded descriptor",
      );
    }
    const permittedCommands = new Set([
      "/bin/busybox",
      ...(this.toolchain?.capability.files
        .filter((file) => file.command)
        .map((file) => file.target) ?? []),
    ]);
    if (!permittedCommands.has(request.argv[0])) {
      return this.deny(
        request,
        "capability_denied",
        "sandbox command is not present in the frozen toolchain",
      );
    }
    const unknownEnvironment = Object.keys(request.environment).find(
      (key) => key !== "CI" && key !== "NO_COLOR",
    );
    if (unknownEnvironment !== undefined) {
      return this.deny(
        request,
        "capability_denied",
        `environment key ${unknownEnvironment} is not permitted`,
      );
    }
    const forbiddenPaths = [
      this.layout.taskRecordDirectory,
      this.layout.hostBaselineGitDirectory,
      this.layout.hostOperationTemporaryDirectory,
    ];
    const suppliedStrings = [
      ...request.argv,
      ...Object.values(request.environment),
    ];
    if (
      suppliedStrings.some((value) =>
        forbiddenPaths.some((path) => value.includes(path)),
      )
    ) {
      return this.deny(
        request,
        "path_denied",
        "physical Host Task paths are not accepted by the sandbox request",
      );
    }
    return { kind: "authorized", request };
  }

  private async deny(
    rawRequest: unknown,
    code: "path_denied" | "capability_denied",
    message: string,
  ): Promise<{
    readonly kind: "denied";
    readonly securityEvent: SecurityEventV1;
  }> {
    const parsedOperationId = isObject(rawRequest)
      ? SandboxOperationIdV1Schema.safeParse(rawRequest.operationId)
      : undefined;
    const operationId =
      parsedOperationId?.success === true
        ? parsedOperationId.data
        : "invalid-operation";
    const firstArg =
      isObject(rawRequest) &&
      Array.isArray(rawRequest.argv) &&
      typeof rawRequest.argv[0] === "string"
        ? rawRequest.argv[0]
        : "sandbox-request";
    const securityEvent = SecurityEventV1Schema.parse({
      schemaVersion: 1,
      eventId: `security:${randomUUID()}`,
      taskId: this.taskId,
      operationId,
      decision: "denied",
      code,
      message: sanitizeM1Diagnostic(message, []),
      occurredAt: this.dependencies.wallNow(),
      target: sanitizeM1Diagnostic(firstArg, []) || "sandbox-request",
      sideEffectStarted: false,
    });
    await this.securityEvents(securityEvent);
    return { kind: "denied", securityEvent };
  }

  private startExecution(
    request: SandboxExecutionRequestV1,
    options: SandboxExecutionOptionsV1,
  ): ActiveExecution {
    const limits = resolveResourceLimitsV1(request.profile, request.timeoutMs);
    const runtimeTargets = [
      { fd: SANDBOX_FDS.runtimeStart, target: "/bin/busybox" },
      ...this.resources.toolchainFiles.map((file, index) => ({
        fd: SANDBOX_FDS.runtimeStart + 1 + index,
        target: file.target,
      })),
    ];
    const plan = this.dependencies.buildProcessPlan({
      request,
      limits,
      binaries: {
        prlimit: this.hostBinding.prlimitPath,
        bwrap: this.hostBinding.bwrapPath,
      },
      runtimeTargets,
      unshareCgroupNamespace: this.capability.cgroupNamespaceUnshared,
    });
    assertProcessPlan(
      plan,
      request,
      this.hostBinding,
      this.layout,
      runtimeTargets,
      this.toolchain?.binding,
    );

    const startedAtMonotonicMs = this.clock.now();
    const stdoutCapture = new BoundedOutputCapture(limits.stdoutMaxBytes);
    const stderrCapture = new BoundedOutputCapture(limits.stderrMaxBytes);
    const runtime: ExecutionRuntime = {
      scope: undefined,
      session: undefined,
      stdoutDrain: undefined,
      stderrDrain: undefined,
    };
    const setupDone = deferred<void>();
    const terminal = deferred<TerminalReason>();
    let terminalReason: TerminalReason | undefined;
    const selectTerminal = (reason: TerminalReason): void => {
      if (terminalReason !== undefined) return;
      terminalReason = reason;
      terminal.resolve(reason);
    };
    const timer = setTimeout(
      () => selectTerminal({ kind: "timeout" }),
      limits.timeoutMs,
    );
    const onAbort = (): void => selectTerminal({ kind: "cancelled" });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();

    void (async () => {
      try {
        if (terminalReason !== undefined) return;
        const controller = await this.controller();
        if (terminalReason !== undefined) return;
        runtime.scope = await controller.createExecutionScope(
          request.operationId,
          limits,
        );
        if (terminalReason !== undefined) return;
        runtime.session = await this.dependencies.startBootstrap({
          cwd: this.layout.taskRootDirectory,
          inheritedFds: [
            this.resources.workspaceFd,
            this.resources.temporaryFd,
            this.resources.artifactsFd,
            this.resources.runtimeFd,
            ...this.resources.toolchainFiles.map((file) => file.fd),
          ],
        });
        runtime.stdoutDrain = captureStream(
          runtime.session.stdout,
          stdoutCapture,
          options.onStdoutChunk,
          (error) => this.reportDiagnostic(error),
        );
        runtime.stderrDrain = captureStream(
          runtime.session.stderr,
          stderrCapture,
          options.onStderrChunk,
          (error) => this.reportDiagnostic(error),
        );
        void runtime.session.waitForChildExit().then(
          (exit) =>
            selectTerminal({
              kind: "exit",
              exitCode: exit.exitCode,
              signal: exit.signal,
            }),
          (error: unknown) => selectTerminal({ kind: "launch_failed", error }),
        );
        if (terminalReason !== undefined) return;
        await runtime.scope.attach(runtime.session.pid);
        await runtime.scope.verifyAttached(
          await runtime.session.inspectCgroupMembership(),
        );
        if (terminalReason !== undefined) return;
        await runtime.session.launch({
          executable: plan.executable,
          args: plan.args,
        });
        await Promise.all([
          runtime.session.waitForChildStarted(),
          runtime.session.waitForSandboxStatus(),
        ]);
        if (terminalReason !== undefined) return;
        const stdinDelivery = runtime.session.provideStdin(
          options.stdin ?? new Uint8Array(),
        );
        void stdinDelivery.catch(() => undefined);
        await runtime.session.authorize();
        await stdinDelivery;
      } catch (error) {
        selectTerminal({ kind: "launch_failed", error });
      } finally {
        setupDone.resolve();
      }
    })();

    const result = (async (): Promise<SandboxExecutionResultV1> => {
      const reason = await terminal.promise;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);

      let termSent = false;
      const requestTermination = async (): Promise<void> => {
        if (termSent || runtime.session === undefined) return;
        try {
          await runtime.session.terminate();
          termSent = true;
        } catch (error) {
          await this.reportDiagnostic(error);
        }
      };
      if (reason.kind !== "exit") await requestTermination();
      await setupDone.promise;
      if (reason.kind !== "exit") await requestTermination();

      let cgroupPopulated = false;
      if (runtime.scope !== undefined) {
        try {
          cgroupPopulated = await runtime.scope.populated();
        } catch (error) {
          cgroupPopulated = true;
          await this.reportDiagnostic(error);
        }
      }
      if (cgroupPopulated && runtime.session !== undefined) {
        await requestTermination();
        if (termSent) await this.dependencies.sleep(250);
      }

      let killSent = false;
      if (runtime.scope !== undefined) {
        try {
          cgroupPopulated = await runtime.scope.populated();
          if (cgroupPopulated) {
            killSent = await runtime.scope.kill();
            await waitForCgroupEmpty(runtime.scope);
          }
          cgroupPopulated = await runtime.scope.populated();
        } catch (error) {
          cgroupPopulated = true;
          await this.reportDiagnostic(error);
        }
      }

      let resourceUsage = EMPTY_USAGE;
      let scopeRemoved = runtime.scope === undefined;
      if (runtime.scope !== undefined) {
        try {
          resourceUsage = await runtime.scope.usage();
        } catch (error) {
          await this.reportDiagnostic(error);
        }
        if (!cgroupPopulated) {
          try {
            await runtime.scope.remove();
            scopeRemoved = true;
          } catch (error) {
            await this.reportDiagnostic(error);
          }
        }
      }

      if (runtime.session !== undefined) {
        await Promise.race([
          runtime.session.waitForBootstrapExit().then(
            () => true,
            () => true,
          ),
          this.dependencies.sleep(250).then(() => false),
        ]);
      }
      await Promise.all([
        runtime.stdoutDrain?.settled ?? Promise.resolve(),
        runtime.stderrDrain?.settled ?? Promise.resolve(),
      ]);

      const cleanup = SandboxCleanupReceiptV1Schema.parse({
        processGroupTerminated: scopeRemoved && !cgroupPopulated,
        cgroupPopulated,
        termSent,
        killSent,
        scopeRemoved,
      });
      const status: SandboxExecutionReceiptV1["status"] =
        reason.kind === "exit"
          ? reason.exitCode === 0 && reason.signal === null
            ? "succeeded"
            : "failed"
          : reason.kind === "timeout"
            ? "timed_out"
            : reason.kind === "cancelled"
              ? "cancelled"
              : "launch_failed";
      if (reason.kind === "launch_failed") {
        await this.reportDiagnostic(reason.error);
      }
      const receipt = SandboxExecutionReceiptV1Schema.parse({
        schemaVersion: 1,
        taskId: this.taskId,
        operationId: request.operationId,
        policyId: this.policy.policyId,
        sandboxCapabilitySha256: this.capabilitySha256,
        sandboxBackend: "bwrap-direct-cgroup-v2",
        status,
        requested: request,
        realizedResources: limits,
        realizedMechanisms: REALIZED_MECHANISMS,
        resourceUsage,
        stdout: stdoutCapture.receipt(),
        stderr: stderrCapture.receipt(),
        exitCode: reason.kind === "exit" ? reason.exitCode : null,
        signal: reason.kind === "exit" ? reason.signal : null,
        startedAtMonotonicMs,
        endedAtMonotonicMs: this.clock.now(),
        cleanup,
      });
      return {
        kind: "executed",
        receipt,
        stdout: stdoutCapture.bytes(),
        stderr: stderrCapture.bytes(),
      };
    })();
    return { cancel: () => selectTerminal({ kind: "cancelled" }), result };
  }

  private controller(): Promise<SandboxBrokerCgroupController> {
    this.#controllerPromise ??= this.dependencies.createCgroupController({
      delegatedCgroupRoot: this.hostBinding.delegatedCgroupRoot,
      taskId: this.taskId,
    });
    return this.#controllerPromise;
  }

  private async reportDiagnostic(error: unknown): Promise<void> {
    try {
      await this.dependencies.reportDiagnostic(error);
    } catch {
      // Diagnostics must not block pipe draining or cleanup.
    }
  }

  private async cleanupOnce(): Promise<SandboxCleanupReceiptV1> {
    this.#closed = true;
    for (const execution of this.#active) execution.cancel();
    await Promise.allSettled([...this.#active].map(({ result }) => result));

    let controllerCleaned = this.#controllerPromise === undefined;
    if (this.#controllerPromise !== undefined) {
      try {
        await (await this.#controllerPromise).cleanup();
        controllerCleaned = true;
      } catch (error) {
        await this.reportDiagnostic(error);
      }
    }
    let resourcesClosed = false;
    try {
      await this.resources.close();
      resourcesClosed = true;
    } catch (error) {
      await this.reportDiagnostic(error);
    }

    return SandboxCleanupReceiptV1Schema.parse({
      processGroupTerminated: controllerCleaned && resourcesClosed,
      cgroupPopulated: !controllerCleaned,
      termSent: this.#executionCleanupReceipts.some(
        (receipt) => receipt.termSent,
      ),
      killSent: this.#executionCleanupReceipts.some(
        (receipt) => receipt.killSent,
      ),
      scopeRemoved: controllerCleaned && resourcesClosed,
    });
  }
}

export async function createBwrapCgroupTaskSandbox(
  options: {
    readonly taskId: TaskId;
    readonly capability: SandboxHostCapabilityV1;
    readonly hostBinding: SandboxHostBinding;
    readonly policy: SandboxPolicyV1;
    readonly toolchain?:
      | {
          readonly capability: SandboxToolchainCapabilityV1;
          readonly binding: SandboxToolchainBindingV1;
        }
      | undefined;
    readonly layout: TaskDirectoryLayout;
    readonly securityEvents: (event: SecurityEventV1) => Promise<void>;
    readonly clock?: MonotonicClockV1 | undefined;
  },
  dependencies: SandboxBrokerDependencies = defaultDependencies,
): Promise<TaskSandboxBrokerV1> {
  const capability = SandboxHostCapabilityV1Schema.parse(options.capability);
  const policy = SandboxPolicyV1Schema.parse(options.policy);
  const toolchain =
    options.toolchain === undefined
      ? undefined
      : {
          capability: SandboxToolchainCapabilityV1Schema.parse(
            options.toolchain.capability,
          ),
          binding: options.toolchain.binding,
        };
  if (toolchain !== undefined) {
    assertToolchainBinding(toolchain.capability, toolchain.binding);
  }
  assertHostBinding(options.hostBinding);
  assertLayout(options.taskId, options.layout);
  const hostBinding = Object.freeze({ ...options.hostBinding });
  assertHostExecutablesOutsideWritableLayout(
    hostBinding,
    options.layout,
    toolchain?.binding,
  );
  if (policy.runtimeIdentity !== capability.runtimeIdentity) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox policy runtime does not match the Host capability",
    );
  }
  const expectedReadonlyTargets = [
    "/bin/busybox",
    ...(toolchain?.capability.files.map((file) => file.target) ?? []),
  ].sort();
  if (
    policy.toolchainId !== (toolchain?.capability.toolchainId ?? null) ||
    JSON.stringify(policy.readonlyTargets) !==
      JSON.stringify(expectedReadonlyTargets)
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox policy does not match the frozen toolchain capability",
    );
  }
  await Promise.all([
    dependencies.verifyExecutableTrust(hostBinding.bwrapPath),
    dependencies.verifyExecutableTrust(hostBinding.prlimitPath),
    dependencies.verifyExecutableTrust(hostBinding.busyboxPath),
  ]);
  const resources = await dependencies.bindResources({
    capability,
    hostBinding,
    layout: options.layout,
    ...(toolchain === undefined ? {} : { toolchain }),
  });
  try {
    assertBoundDescriptors(resources);
    const capabilitySha256 = asSha256DigestV1(
      contentHash(capability as unknown as JsonValue),
    );
    return new BwrapCgroupTaskSandbox(
      options.taskId,
      capability,
      capabilitySha256,
      hostBinding,
      policy,
      toolchain,
      options.layout,
      resources,
      options.securityEvents,
      options.clock ?? { now: () => performance.now() },
      dependencies,
    );
  } catch (error) {
    await resources.close().catch(() => undefined);
    throw error;
  }
}
