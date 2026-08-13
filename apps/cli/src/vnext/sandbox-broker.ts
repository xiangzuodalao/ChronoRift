import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
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
import { DEFAULT_RUNTIME_SIDECAR_TARGETS } from "@chronorift/godot-adapter";

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
  SandboxMountAdmissionReceiptV1Schema,
  SandboxPolicySchema,
  SandboxToolchainCapabilityV1Schema,
  SandboxOperationIdV1Schema,
  SecurityEventV1Schema,
  type ObservedResourceUsageV1,
  type AggregateStorageUsageV1,
  type SandboxCleanupReceiptV1,
  type SandboxExecutionReceiptV1,
  type SandboxExecutionRequestV1,
  type SandboxHostCapabilityV1,
  type SandboxMountAdmissionReceiptV1,
  type SandboxPolicy,
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
  SandboxBootstrapReadinessCleanupError,
  startSandboxBootstrap,
  type SandboxBootstrapSession,
} from "./sandbox-bootstrap.js";
import {
  assertSandboxTaskStorageLayoutMatches,
  assertTrustedHostExecutablePath,
  type SandboxHostBinding,
} from "./sandbox-preflight.js";
import { resolveResourceLimitsV1 } from "./sandbox-policy.js";
import type { TaskDirectoryLayout } from "./task-paths.js";
import type { SandboxToolchainBindingV1 } from "./sandbox-toolchain.js";
import {
  ManagedGodotRuntimeCapabilityV1Schema,
  assertManagedGodotRuntimeBinding,
  type ManagedGodotRuntimeBindingV1,
  type ManagedGodotRuntimeCapabilityV1,
} from "./managed-godot-runtime.js";
import {
  ManagedGodotLifecycleRuntimeCapabilityV1Schema,
  assertManagedGodotLifecycleRuntimeBinding,
  type ManagedGodotLifecycleRuntimeBindingV1,
  type ManagedGodotLifecycleRuntimeCapabilityV1,
} from "./managed-godot-lifecycle-runtime.js";
import {
  ManagedGodotSemanticRuntimeCapabilityV1Schema,
  assertManagedGodotSemanticRuntimeBinding,
  type ManagedGodotSemanticRuntimeBindingV1,
  type ManagedGodotSemanticRuntimeCapabilityV1,
} from "./managed-godot-semantic-runtime.js";
import {
  ManagedGodotProjectEnvironmentRuntimeCapabilityV1Schema,
  assertManagedGodotProjectEnvironmentRuntimeBinding,
  type ManagedGodotProjectEnvironmentRuntimeBindingV1,
  type ManagedGodotProjectEnvironmentRuntimeCapabilityV1,
} from "./managed-godot-project-environment-runtime.js";

export type SandboxManagedGodotRuntimeV1 =
  | {
      readonly capability: ManagedGodotRuntimeCapabilityV1;
      readonly binding: ManagedGodotRuntimeBindingV1;
    }
  | {
      readonly capability: ManagedGodotLifecycleRuntimeCapabilityV1;
      readonly binding: ManagedGodotLifecycleRuntimeBindingV1;
    }
  | {
      readonly capability: ManagedGodotSemanticRuntimeCapabilityV1;
      readonly binding: ManagedGodotSemanticRuntimeBindingV1;
    }
  | {
      readonly capability: ManagedGodotProjectEnvironmentRuntimeCapabilityV1;
      readonly binding: ManagedGodotProjectEnvironmentRuntimeBindingV1;
    };
type SandboxManagedGodotRuntimeBindingV1 =
  | ManagedGodotRuntimeBindingV1
  | ManagedGodotLifecycleRuntimeBindingV1
  | ManagedGodotSemanticRuntimeBindingV1
  | ManagedGodotProjectEnvironmentRuntimeBindingV1;

const isLifecycleManagedRuntime = (
  runtime: SandboxManagedGodotRuntimeV1,
): runtime is {
  readonly capability: ManagedGodotLifecycleRuntimeCapabilityV1;
  readonly binding: ManagedGodotLifecycleRuntimeBindingV1;
} =>
  "runtimeProfile" in runtime.capability &&
  runtime.capability.runtimeProfile === "chronorift-managed-godot-lifecycle-v1";

const isSemanticManagedRuntime = (
  runtime: SandboxManagedGodotRuntimeV1,
): runtime is {
  readonly capability: ManagedGodotSemanticRuntimeCapabilityV1;
  readonly binding: ManagedGodotSemanticRuntimeBindingV1;
} =>
  "runtimeProfile" in runtime.capability &&
  runtime.capability.runtimeProfile === "chronorift-managed-godot-semantic-v1";

const isProjectEnvironmentManagedRuntime = (
  runtime: SandboxManagedGodotRuntimeV1,
): runtime is {
  readonly capability: ManagedGodotProjectEnvironmentRuntimeCapabilityV1;
  readonly binding: ManagedGodotProjectEnvironmentRuntimeBindingV1;
} =>
  "runtimeProfile" in runtime.capability &&
  runtime.capability.runtimeProfile ===
    "chronorift-managed-godot-project-environment-v1";

const isOverlayManagedRuntime = (
  runtime: SandboxManagedGodotRuntimeV1,
): runtime is
  | {
      readonly capability: ManagedGodotLifecycleRuntimeCapabilityV1;
      readonly binding: ManagedGodotLifecycleRuntimeBindingV1;
    }
  | {
      readonly capability: ManagedGodotSemanticRuntimeCapabilityV1;
      readonly binding: ManagedGodotSemanticRuntimeBindingV1;
    }
  | {
      readonly capability: ManagedGodotProjectEnvironmentRuntimeCapabilityV1;
      readonly binding: ManagedGodotProjectEnvironmentRuntimeBindingV1;
    } =>
  isLifecycleManagedRuntime(runtime) ||
  isSemanticManagedRuntime(runtime) ||
  isProjectEnvironmentManagedRuntime(runtime);

const assertSandboxManagedRuntimeBinding = (
  runtime: SandboxManagedGodotRuntimeV1,
): void => {
  if (isLifecycleManagedRuntime(runtime)) {
    assertManagedGodotLifecycleRuntimeBinding(
      runtime.capability,
      runtime.binding,
    );
  } else if (isSemanticManagedRuntime(runtime)) {
    assertManagedGodotSemanticRuntimeBinding(
      runtime.capability,
      runtime.binding,
    );
  } else if (isProjectEnvironmentManagedRuntime(runtime)) {
    assertManagedGodotProjectEnvironmentRuntimeBinding(
      runtime.capability,
      runtime.binding,
    );
  } else {
    assertManagedGodotRuntimeBinding(runtime.capability, runtime.binding);
  }
};

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

export interface SandboxDuplexExecutionOptionsV1 {
  readonly signal?: AbortSignal | undefined;
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

export interface SandboxDuplexHandleV1 {
  write(bytes: Uint8Array): Promise<void>;
  endInput(): Promise<void>;
  terminate(): Promise<void>;
  readonly completion: Promise<SandboxExecutionResultV1>;
}

export type SandboxDuplexOpenResultV1 =
  | { readonly kind: "opened"; readonly handle: SandboxDuplexHandleV1 }
  | SandboxExecutionResultV1;

export interface TaskSandboxBrokerV1 {
  execute(
    request: SandboxExecutionRequestV1,
    options?: SandboxExecutionOptionsV1,
  ): Promise<SandboxExecutionResultV1>;
  cleanup(): Promise<SandboxCleanupReceiptV1>;
}

export interface DuplexTaskSandboxBrokerV1 extends TaskSandboxBrokerV1 {
  openDuplex(
    request: SandboxExecutionRequestV1,
    options?: SandboxDuplexExecutionOptionsV1,
  ): Promise<SandboxDuplexOpenResultV1>;
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
  readonly managedRuntimeFiles?:
    | readonly {
        readonly fd: number;
        readonly target: string;
      }[]
    | undefined;
  readonly managedFontconfig?:
    | {
        readonly fd: number;
        readonly target: string;
      }
    | undefined;
  readonly managedAddon?:
    | {
        readonly parentFd: number;
        readonly parentTarget: string;
        readonly fd: number;
        readonly target: string;
      }
    | undefined;
  readonly managedOverlay?:
    | {
        readonly fd: number;
        readonly target: string;
      }
    | undefined;
  readonly managedAdapter?:
    | {
        readonly parentFd: number;
        readonly parentTarget: string;
        readonly fd: number;
        readonly target: string;
      }
    | undefined;
  close(): Promise<void>;
}

export interface SandboxBrokerCgroupController {
  createExecutionScope(
    operationId: string,
    limits: CgroupEnforcementLimitsV1,
  ): Promise<ExecutionCgroupScope>;
  cleanup(): Promise<void>;
}

export interface SandboxBrokerScratchCleanup {
  readonly path: string;
  close(): Promise<void>;
}

export interface SandboxBrokerExecutionScratch extends SandboxBrokerScratchCleanup {
  readonly fd: number;
}

export class SandboxExecutionScratchCreationError extends Error {
  public constructor(
    message: string,
    public readonly scratch: SandboxBrokerScratchCleanup,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "SandboxExecutionScratchCreationError";
  }
}

export interface SandboxBrokerDependencies {
  verifyExecutableTrust(path: string): Promise<void>;
  inspectTaskStorage(input: {
    readonly capability: NonNullable<SandboxHostCapabilityV1["taskStorage"]>;
    readonly taskStorageRoot: string;
    readonly layoutPaths: readonly string[];
  }): Promise<AggregateStorageUsageV1>;
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
    readonly managedRuntime?: SandboxManagedGodotRuntimeV1 | undefined;
  }): Promise<SandboxBrokerBoundResources>;
  createExecutionScratch(input: {
    readonly layout: TaskDirectoryLayout;
    readonly operationId: string;
  }): Promise<SandboxBrokerExecutionScratch>;
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
  bootstrapCleanup: SandboxBootstrapReadinessCleanupError | undefined;
  scratch: SandboxBrokerExecutionScratch | undefined;
  scratchCleanup: SandboxBrokerScratchCleanup | undefined;
  scratchCreationFailed: boolean;
  stdoutDrain: StreamDrain | undefined;
  stderrDrain: StreamDrain | undefined;
}

interface ActiveExecution {
  readonly cancel: () => void;
  readonly ready: Promise<boolean>;
  readonly write: (bytes: Uint8Array) => Promise<void>;
  readonly endInput: () => Promise<void>;
  readonly terminate: () => Promise<void>;
  readonly result: Promise<SandboxExecutionResultV1>;
}

const BASE_REALIZED_MECHANISMS = {
  cpu: "cgroup-v2",
  memory: "cgroup-v2",
  processCount: "cgroup-v2",
  openFiles: "rlimit-nofile",
  fileSize: "rlimit-fsize",
  wallTimeout: "host-monotonic-timer",
} as const;

const realizedMechanismsFor = (
  capability: SandboxHostCapabilityV1,
  aggregateStorageObserved: boolean,
): SandboxExecutionReceiptV1["realizedMechanisms"] =>
  capability.taskStorage === undefined || !aggregateStorageObserved
    ? { ...BASE_REALIZED_MECHANISMS, unavailable: ["aggregate-storage"] }
    : {
        ...BASE_REALIZED_MECHANISMS,
        aggregateStorage: capability.taskStorage.kind,
        unavailable: [],
      };

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
  const baseKeys = [
    "taskRootDirectory",
    "taskRecordDirectory",
    "runtimeRecordDirectory",
    "workspaceDirectory",
    "sandboxTemporaryDirectory",
    "sandboxArtifactScratchDirectory",
    "piSessionDirectory",
    "hostBaselineGitDirectory",
    "hostOperationTemporaryDirectory",
  ] as const;
  if (
    !isObject(layout) ||
    (!hasExactKeys(layout, baseKeys) &&
      !hasExactKeys(layout, [...baseKeys, "projectEnvironmentRecordDirectory"]))
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
    runtimeRecordDirectory: join(root, "runtime-records"),
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
  const projectEnvironmentRecordDirectory = (
    layout as TaskDirectoryLayout & {
      readonly projectEnvironmentRecordDirectory?: unknown;
    }
  ).projectEnvironmentRecordDirectory;
  if (
    projectEnvironmentRecordDirectory !== undefined &&
    projectEnvironmentRecordDirectory !==
      join(root, "project-environment-records")
  ) {
    throw new M1Error(
      "path_denied",
      "Task layout projectEnvironmentRecordDirectory is not the fixed Task child",
    );
  }
}

function assertHostBinding(
  capability: SandboxHostCapabilityV1,
  binding: SandboxHostBinding,
): void {
  const expectedKeys = [
    "delegatedCgroupRoot",
    "bwrapPath",
    "prlimitPath",
    "busyboxPath",
    ...(capability.taskStorage === undefined ? [] : ["taskStorageRoot"]),
  ];
  if (
    !isObject(binding) ||
    !hasExactKeys(binding, expectedKeys) ||
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

export class SandboxBrokerSetupCleanupError extends AggregateError {
  public constructor(
    public readonly primaryError: unknown,
    cleanupError: unknown,
    private readonly retry: () => Promise<void>,
  ) {
    super(
      [primaryError, cleanupError],
      "sandbox setup failed without proven resource cleanup",
    );
    this.name = "SandboxBrokerSetupCleanupError";
  }

  public retryCleanup(): Promise<void> {
    return this.retry();
  }
}

export const rethrowAfterBoundedSetupCleanup = async (
  primaryError: unknown,
  cleanup: () => Promise<void>,
): Promise<never> => {
  let lastCleanupError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await cleanup();
    } catch (error) {
      lastCleanupError = error;
      continue;
    }
    throw primaryError;
  }
  throw new SandboxBrokerSetupCleanupError(
    primaryError,
    lastCleanupError,
    cleanup,
  );
};

const restoreScratchDirectoryModes = async (
  directoryPath: Buffer,
  expectedDevice: number,
): Promise<void> => {
  const statistics = await lstat(directoryPath);
  if (
    statistics.isSymbolicLink() ||
    !statistics.isDirectory() ||
    statistics.dev !== expectedDevice
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "operation scratch cleanup encountered a non-directory or nested filesystem",
    );
  }
  await chmod(directoryPath, 0o700);
  const entries = await readdir(directoryPath, {
    encoding: "buffer",
    withFileTypes: true,
  });
  for (const entry of entries) {
    const childPath = Buffer.concat([
      directoryPath,
      Buffer.from("/"),
      entry.name,
    ]);
    const child = await lstat(childPath);
    if (child.isSymbolicLink() || !child.isDirectory()) continue;
    await restoreScratchDirectoryModes(childPath, expectedDevice);
  }
};

export async function createBoundedExecutionScratch(input: {
  readonly temporaryDirectory: string;
}): Promise<SandboxBrokerExecutionScratch> {
  const parentPath = input.temporaryDirectory;
  let directoryPath: string | undefined;
  let handle: FileHandle | undefined;
  let parentDevice: number | undefined;
  try {
    if (
      !isAbsolute(parentPath) ||
      resolve(parentPath) !== parentPath ||
      (await realpath(parentPath)) !== parentPath
    ) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "operation scratch parent must be absolute, canonical, and symlink-free",
      );
    }
    const parent = await lstat(parentPath);
    parentDevice = parent.dev;
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "operation scratch parent must be a real directory",
      );
    }
    directoryPath = await mkdtemp(join(parentPath, "runtime-"));
    const created = await lstat(directoryPath);
    const currentUid = process.geteuid?.();
    if (
      (await realpath(directoryPath)) !== directoryPath ||
      created.isSymbolicLink() ||
      !created.isDirectory() ||
      created.dev !== parent.dev ||
      currentUid === undefined ||
      currentUid <= 0 ||
      created.uid !== currentUid ||
      (created.mode & 0o7777) !== 0o700
    ) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "operation scratch did not remain a private directory on Task storage",
      );
    }
    handle = await openPinned(directoryPath, "directory");
  } catch (error) {
    if (directoryPath !== undefined && parentDevice !== undefined) {
      const scratch = createOwnedScratchCleanup(
        directoryPath,
        parentDevice,
        handle,
      );
      try {
        await scratch.close();
      } catch (cleanupError) {
        throw new SandboxExecutionScratchCreationError(
          "operation scratch creation failed without proven cleanup",
          scratch,
          new AggregateError(
            [error, cleanupError],
            "operation scratch creation and cleanup failed",
          ),
        );
      }
    } else if (handle !== undefined) {
      await handle.close();
    }
    throw error;
  }

  const pinnedHandle = handle;
  const pinnedPath = directoryPath;
  const scratch = createOwnedScratchCleanup(
    pinnedPath,
    parentDevice,
    pinnedHandle,
  );
  return Object.freeze({ fd: pinnedHandle.fd, ...scratch });
}

const createOwnedScratchCleanup = (
  pinnedPath: string,
  expectedDevice: number,
  pinnedHandle: FileHandle | undefined,
): SandboxBrokerScratchCleanup => {
  let handleClosed = false;
  let directoryRemoved = false;
  let activeClose: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (activeClose !== undefined) return activeClose;
    if (handleClosed && directoryRemoved) return Promise.resolve();
    const attempt = (async () => {
      if (!directoryRemoved) {
        const visible = await lstat(pinnedPath);
        const pinned = await pinnedHandle?.stat();
        if (
          !visible.isDirectory() ||
          visible.isSymbolicLink() ||
          visible.dev !== expectedDevice ||
          (pinned !== undefined &&
            (!pinned.isDirectory() ||
              pinned.dev !== visible.dev ||
              pinned.ino !== visible.ino))
        ) {
          throw new M1Error(
            "sandbox_preflight_failed",
            "operation scratch identity changed before cleanup",
          );
        }
        await pinnedHandle?.chmod(0o700);
        await restoreScratchDirectoryModes(
          Buffer.from(pinnedPath),
          expectedDevice,
        );
        await rm(pinnedPath, { recursive: true, force: true });
        directoryRemoved = true;
      }
      if (!handleClosed && pinnedHandle !== undefined) {
        await pinnedHandle.close();
        handleClosed = true;
      } else if (pinnedHandle === undefined) {
        handleClosed = true;
      }
    })();
    const tracked = attempt.finally(() => {
      if (activeClose === tracked) activeClose = undefined;
    });
    activeClose = tracked;
    return tracked;
  };
  return Object.freeze({ path: pinnedPath, close });
};

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
  readonly managedRuntime?: SandboxManagedGodotRuntimeV1 | undefined;
}): Promise<SandboxBrokerBoundResources> {
  const resources: { close(): Promise<void> }[] = [];
  const keepHandle = (handle: FileHandle): FileHandle => {
    resources.push(handle);
    return handle;
  };
  try {
    const workspace = keepHandle(
      await openPinned(input.layout.workspaceDirectory, "directory"),
    );
    const temporary = keepHandle(
      await openPinned(input.layout.sandboxTemporaryDirectory, "directory"),
    );
    const artifacts = keepHandle(
      await openPinned(
        input.layout.sandboxArtifactScratchDirectory,
        "directory",
      ),
    );
    const runtime = keepHandle(
      await openPinned(input.hostBinding.busyboxPath, "executable"),
    );
    const bindToolchain = async (
      toolchain:
        | {
            readonly capability: SandboxToolchainCapabilityV1;
            readonly binding: SandboxToolchainBindingV1;
          }
        | undefined,
    ): Promise<{ readonly fd: number; readonly target: string }[]> => {
      const bound: { readonly fd: number; readonly target: string }[] = [];
      if (toolchain === undefined) return bound;
      if (
        toolchain.capability.toolchainId !== toolchain.binding.toolchainId ||
        toolchain.capability.files.length !== toolchain.binding.files.length
      ) {
        throw new M1Error(
          "sandbox_preflight_failed",
          "toolchain capability does not match its physical binding",
        );
      }
      for (const [
        index,
        capabilityFile,
      ] of toolchain.capability.files.entries()) {
        const bindingFile = toolchain.binding.files[index];
        if (bindingFile?.target !== capabilityFile.target) {
          throw new M1Error(
            "sandbox_preflight_failed",
            "toolchain binding targets do not match the frozen capability",
          );
        }
        const handle = keepHandle(
          await openPinned(bindingFile.hostPath, "runtime-file"),
        );
        if (sha256(await handle.readFile()) !== capabilityFile.sha256) {
          throw new M1Error(
            "sandbox_preflight_failed",
            "toolchain file no longer matches its frozen identity",
          );
        }
        bound.push({ fd: handle.fd, target: capabilityFile.target });
      }
      return bound;
    };
    const toolchainFiles = await bindToolchain(input.toolchain);
    const managedRuntimeFiles = await bindToolchain(
      input.managedRuntime === undefined
        ? undefined
        : {
            capability: input.managedRuntime.capability.toolchain,
            binding: input.managedRuntime.binding.toolchain,
          },
    );
    let managedFontconfig:
      { readonly fd: number; readonly target: string } | undefined;
    let managedAddon:
      | {
          readonly parentFd: number;
          readonly parentTarget: string;
          readonly fd: number;
          readonly target: string;
        }
      | undefined;
    let managedOverlay:
      { readonly fd: number; readonly target: string } | undefined;
    let managedAdapter:
      | {
          readonly parentFd: number;
          readonly parentTarget: string;
          readonly fd: number;
          readonly target: string;
        }
      | undefined;
    if (input.managedRuntime !== undefined) {
      assertSandboxManagedRuntimeBinding(input.managedRuntime);
      const fontconfigDirectory = await mkdtemp(
        join(input.layout.hostOperationTemporaryDirectory, "fontconfig-"),
      );
      resources.push({
        close: () => rm(fontconfigDirectory, { recursive: true, force: true }),
      });
      const fontconfigPath = join(fontconfigDirectory, "fonts.conf");
      await writeFile(
        fontconfigPath,
        input.managedRuntime.binding.fontconfigBytes,
        { flag: "wx", mode: 0o400 },
      );
      const fontconfigHandle = keepHandle(
        await openPinned(fontconfigPath, "runtime-file"),
      );
      managedFontconfig = {
        fd: fontconfigHandle.fd,
        target: input.managedRuntime.capability.fontconfigTarget,
      };
      const addonParentDirectory = await mkdtemp(
        join(input.layout.hostOperationTemporaryDirectory, "managed-addon-"),
      );
      const addonDirectory = join(
        addonParentDirectory,
        basename(input.managedRuntime.capability.addonTarget),
      );
      await mkdir(addonDirectory, { mode: 0o700 });
      resources.push({
        close: () => rm(addonParentDirectory, { recursive: true, force: true }),
      });
      for (const file of input.managedRuntime.binding.addonFiles) {
        const target = join(addonDirectory, ...file.relativePath.split("/"));
        const parent = dirname(target);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        await writeFile(target, file.bytes, { flag: "wx", mode: 0o400 });
      }
      const addonParentHandle = keepHandle(
        await openPinned(addonParentDirectory, "directory"),
      );
      const addonHandle = keepHandle(
        await openPinned(addonDirectory, "directory"),
      );
      managedAddon = {
        parentFd: addonParentHandle.fd,
        parentTarget: input.managedRuntime.capability.addonParentTarget,
        fd: addonHandle.fd,
        target: input.managedRuntime.capability.addonTarget,
      };
      if (isOverlayManagedRuntime(input.managedRuntime)) {
        const overlayDirectory = await mkdtemp(
          join(
            input.layout.hostOperationTemporaryDirectory,
            "managed-overlay-",
          ),
        );
        resources.push({
          close: () => rm(overlayDirectory, { recursive: true, force: true }),
        });
        const overlayPath = join(overlayDirectory, "override.cfg");
        await writeFile(
          overlayPath,
          input.managedRuntime.binding.overlayBytes,
          { flag: "wx", mode: 0o400 },
        );
        const overlayHandle = keepHandle(
          await openPinned(overlayPath, "runtime-file"),
        );
        managedOverlay = {
          fd: overlayHandle.fd,
          target: input.managedRuntime.capability.overlayTarget,
        };
      }
      if (isProjectEnvironmentManagedRuntime(input.managedRuntime)) {
        const adapterParentDirectory = await mkdtemp(
          join(
            input.layout.hostOperationTemporaryDirectory,
            "managed-adapter-",
          ),
        );
        const adapterDirectory = join(
          adapterParentDirectory,
          basename(input.managedRuntime.capability.adapterTarget),
        );
        await mkdir(adapterDirectory, { mode: 0o700 });
        resources.push({
          close: () =>
            rm(adapterParentDirectory, { recursive: true, force: true }),
        });
        for (const file of input.managedRuntime.binding.adapterFiles) {
          const target = join(
            adapterDirectory,
            ...file.relativePath.split("/"),
          );
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, file.bytes, { flag: "wx", mode: 0o400 });
        }
        const adapterParentHandle = keepHandle(
          await openPinned(adapterParentDirectory, "directory"),
        );
        const adapterHandle = keepHandle(
          await openPinned(adapterDirectory, "directory"),
        );
        managedAdapter = {
          parentFd: adapterParentHandle.fd,
          parentTarget: input.managedRuntime.capability.adapterParentTarget,
          fd: adapterHandle.fd,
          target: input.managedRuntime.capability.adapterTarget,
        };
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

    const close = createRetryableResourceCloser(resources);
    return {
      workspaceFd: workspace.fd,
      temporaryFd: temporary.fd,
      artifactsFd: artifacts.fd,
      runtimeFd: runtime.fd,
      toolchainFiles: Object.freeze(toolchainFiles),
      managedRuntimeFiles: Object.freeze(managedRuntimeFiles),
      ...(managedFontconfig === undefined ? {} : { managedFontconfig }),
      ...(managedAddon === undefined ? {} : { managedAddon }),
      ...(managedOverlay === undefined ? {} : { managedOverlay }),
      ...(managedAdapter === undefined ? {} : { managedAdapter }),
      close,
    };
  } catch (error) {
    return rethrowAfterBoundedSetupCleanup(
      error,
      createRetryableResourceCloser(resources),
    );
  }
}

const defaultDependencies: SandboxBrokerDependencies = {
  verifyExecutableTrust: async (path) => {
    await assertTrustedHostExecutablePath(path);
  },
  inspectTaskStorage: ({ capability, taskStorageRoot, layoutPaths }) =>
    assertSandboxTaskStorageLayoutMatches(
      capability,
      taskStorageRoot,
      layoutPaths,
    ),
  bindResources: bindDefaultResources,
  createExecutionScratch: ({ layout }) =>
    createBoundedExecutionScratch({
      temporaryDirectory: layout.hostOperationTemporaryDirectory,
    }),
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
    ...(resources.managedRuntimeFiles?.map((file) => file.fd) ?? []),
    ...(resources.managedFontconfig === undefined
      ? []
      : [resources.managedFontconfig.fd]),
    ...(resources.managedAddon === undefined
      ? []
      : [resources.managedAddon.parentFd, resources.managedAddon.fd]),
    ...(resources.managedOverlay === undefined
      ? []
      : [resources.managedOverlay.fd]),
    ...(resources.managedAdapter === undefined
      ? []
      : [resources.managedAdapter.parentFd, resources.managedAdapter.fd]),
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

const taskLayoutPaths = (layout: TaskDirectoryLayout): readonly string[] => [
  layout.taskRootDirectory,
  layout.taskRecordDirectory,
  layout.runtimeRecordDirectory,
  layout.workspaceDirectory,
  layout.sandboxTemporaryDirectory,
  layout.sandboxArtifactScratchDirectory,
  layout.piSessionDirectory,
  layout.hostBaselineGitDirectory,
  layout.hostOperationTemporaryDirectory,
];

function assertLayoutWithinTaskStorage(
  capability: SandboxHostCapabilityV1,
  binding: SandboxHostBinding,
  layout: TaskDirectoryLayout,
  managedRuntime:
    | ManagedGodotRuntimeCapabilityV1
    | ManagedGodotLifecycleRuntimeCapabilityV1
    | ManagedGodotSemanticRuntimeCapabilityV1
    | ManagedGodotProjectEnvironmentRuntimeCapabilityV1
    | undefined,
): void {
  if (
    managedRuntime !== undefined &&
    (capability.taskStorage === undefined ||
      binding.taskStorageRoot === undefined)
  ) {
    throw new M1Error(
      "resource_limit_unavailable",
      "managed runtime tasks require bounded aggregate Task storage",
    );
  }
  if (
    (capability.taskStorage === undefined) !==
    (binding.taskStorageRoot === undefined)
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "task storage capability and Host binding disagree",
    );
  }
  const taskStorageRoot = binding.taskStorageRoot;
  if (taskStorageRoot === undefined) return;
  if (
    !isAbsolute(taskStorageRoot) ||
    resolve(taskStorageRoot) !== taskStorageRoot
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "task storage root must be an absolute normalized path",
    );
  }
  for (const taskPath of taskLayoutPaths(layout)) {
    if (!pathAtOrBelow(taskStorageRoot, taskPath)) {
      throw new M1Error(
        "path_denied",
        "Task layout must remain within bounded aggregate Task storage",
      );
    }
  }
}

function assertHostExecutablesOutsideWritableLayout(
  binding: SandboxHostBinding,
  layout: TaskDirectoryLayout,
  toolchain: SandboxToolchainBindingV1 | undefined,
  managedRuntime: SandboxManagedGodotRuntimeBindingV1 | undefined,
): void {
  const executables = [
    binding.bwrapPath,
    binding.prlimitPath,
    binding.busyboxPath,
    ...(toolchain?.files.map((file) => file.hostPath) ?? []),
    ...(managedRuntime?.toolchain.files.map((file) => file.hostPath) ?? []),
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

interface SanitizedBindMountV1 {
  readonly access: "read-write" | "read-only";
  readonly fd: number;
  readonly target: string;
}

const credentialLikeSandboxTarget = (target: string): boolean => {
  const normalized = target.toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  return (
    normalized === "/root" ||
    normalized.startsWith("/root/") ||
    normalized === "/home" ||
    normalized.startsWith("/home/") ||
    normalized === "/run/secrets" ||
    normalized.startsWith("/run/secrets/") ||
    normalized === "/var/run/secrets" ||
    normalized.startsWith("/var/run/secrets/") ||
    normalized === "/credentials" ||
    normalized.startsWith("/credentials/") ||
    segments.some((segment) =>
      [".aws", ".gnupg", ".netrc", ".ssh", "auth.json", "credentials"].includes(
        segment,
      ),
    )
  );
};

const readSanitizedBindMounts = (
  plan: SandboxProcessPlan,
  commandSeparator: number,
): readonly SanitizedBindMountV1[] => {
  const mounts: SanitizedBindMountV1[] = [];
  for (let index = 0; index < commandSeparator; index += 1) {
    const argument = plan.args[index];
    if (argument !== "--bind-fd" && argument !== "--ro-bind-fd") continue;
    const fdValue = plan.args[index + 1];
    const target = plan.args[index + 2];
    const fd = Number(fdValue);
    if (
      index + 2 >= commandSeparator ||
      fdValue === undefined ||
      !/^\d+$/u.test(fdValue) ||
      !Number.isSafeInteger(fd) ||
      target === undefined ||
      !isAbsolute(target) ||
      resolve(target) !== target ||
      target.includes("\0")
    ) {
      throw new M1Error(
        "sandbox_launch_failed",
        "sandbox process plan contains an invalid bind mount",
      );
    }
    mounts.push({
      access: argument === "--ro-bind-fd" ? "read-only" : "read-write",
      fd,
      target,
    });
    index += 2;
  }
  return mounts;
};

function assertProcessPlan(
  plan: SandboxProcessPlan,
  request: SandboxExecutionRequestV1,
  binding: SandboxHostBinding,
  layout: TaskDirectoryLayout,
  runtimeScratch: { readonly fd: number; readonly target: string } | undefined,
  runtimeTargets: readonly { readonly fd: number; readonly target: string }[],
  toolchainBinding: SandboxToolchainBindingV1 | undefined,
): SandboxMountAdmissionReceiptV1 {
  const expectedFds = [
    SANDBOX_FDS.block,
    SANDBOX_FDS.status,
    SANDBOX_FDS.workspace,
    SANDBOX_FDS.temporary,
    SANDBOX_FDS.artifacts,
    ...(runtimeScratch === undefined ? [] : [runtimeScratch.fd]),
    ...runtimeTargets.map((target) => target.fd),
  ];
  const commandSeparator = plan.args.length - request.argv.length - 1;
  if (
    plan.executable !== binding.prlimitPath ||
    plan.args[3] !== "--" ||
    plan.args[4] !== binding.bwrapPath ||
    JSON.stringify(plan.inheritedFds) !== JSON.stringify(expectedFds) ||
    (request.profile === "godot-headless") !==
      (runtimeScratch?.fd === SANDBOX_FDS.runtimeScratch &&
        runtimeScratch.target === "/run/chronorift") ||
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
  const actualMounts = readSanitizedBindMounts(plan, commandSeparator);
  const expectedMounts: readonly SanitizedBindMountV1[] = [
    {
      access: request.profile === "godot-headless" ? "read-only" : "read-write",
      fd: SANDBOX_FDS.workspace,
      target: "/workspace",
    },
    {
      access: "read-write",
      fd: SANDBOX_FDS.temporary,
      target: "/tmp",
    },
    {
      access: "read-write",
      fd: SANDBOX_FDS.artifacts,
      target: "/artifacts",
    },
    ...(runtimeScratch === undefined
      ? []
      : [
          {
            access: "read-write" as const,
            fd: runtimeScratch.fd,
            target: runtimeScratch.target,
          },
        ]),
    ...runtimeTargets.map(({ fd, target }) => ({
      access: "read-only" as const,
      fd,
      target,
    })),
  ];
  if (JSON.stringify(actualMounts) !== JSON.stringify(expectedMounts)) {
    throw new M1Error(
      "sandbox_launch_failed",
      "sandbox process plan changed the exact admitted mount set",
    );
  }
  const credentialTargetCount = actualMounts.filter((mount) =>
    credentialLikeSandboxTarget(mount.target),
  ).length;
  if (credentialTargetCount !== 0) {
    throw new M1Error(
      "sandbox_launch_failed",
      "sandbox process plan attempted to mount a credential-like target",
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
  const readonlyTargets = actualMounts
    .filter((mount) => mount.access === "read-only")
    .map((mount) => mount.target);
  const sanitizedMountPlan = actualMounts.map(({ access, target }) => ({
    access,
    target,
  }));
  return SandboxMountAdmissionReceiptV1Schema.parse({
    schemaVersion: 1,
    evidenceBasis: "validated-process-plan",
    profile: request.profile,
    workspaceAccess:
      request.profile === "godot-headless" ? "read-only" : "read-write",
    taskSharedWritableTargets: ["/tmp", "/artifacts"],
    operationPrivateWritableTargets:
      runtimeScratch === undefined ? [] : ["/run/chronorift"],
    readonlyTargetCount: readonlyTargets.length,
    readonlyTargetsSha256: asSha256DigestV1(contentHash(readonlyTargets)),
    mountCount: actualMounts.length,
    mountPlanSha256: asSha256DigestV1(contentHash(sanitizedMountPlan)),
    credentialTargetCount: 0,
  });
}

class BwrapCgroupTaskSandbox implements DuplexTaskSandboxBrokerV1 {
  readonly #active = new Set<ActiveExecution>();
  readonly #executionCleanupReceipts: SandboxCleanupReceiptV1[] = [];
  readonly #executionScratches = new Set<SandboxBrokerScratchCleanup>();
  readonly #bootstrapCleanups =
    new Set<SandboxBootstrapReadinessCleanupError>();
  #controllerPromise: Promise<SandboxBrokerCgroupController> | undefined;
  #closed = false;
  #cleanupPromise: Promise<SandboxCleanupReceiptV1> | undefined;

  public constructor(
    private readonly taskId: TaskId,
    private readonly capability: SandboxHostCapabilityV1,
    private readonly capabilitySha256: ReturnType<typeof asSha256DigestV1>,
    private readonly hostBinding: SandboxHostBinding,
    private readonly policy: SandboxPolicy,
    private readonly toolchain:
      | {
          readonly capability: SandboxToolchainCapabilityV1;
          readonly binding: SandboxToolchainBindingV1;
        }
      | undefined,
    private readonly managedRuntime: SandboxManagedGodotRuntimeV1 | undefined,
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

    const active = this.trackExecution(
      this.startExecution(
        authorized.request,
        {
          ...options,
          ...(ownedStdin === undefined ? {} : { stdin: ownedStdin }),
        },
        false,
      ),
    );
    return active.result;
  }

  public async openDuplex(
    request: SandboxExecutionRequestV1,
    options: SandboxDuplexExecutionOptionsV1 = {},
  ): Promise<SandboxDuplexOpenResultV1> {
    if (this.#closed) {
      throw new M1Error(
        "command_cancelled",
        "Task sandbox broker is already cleaned",
      );
    }
    const authorized = await this.authorizeRequest(request, undefined);
    if (authorized.kind === "denied") return authorized;
    if (this.#closed) {
      throw new M1Error(
        "command_cancelled",
        "Task sandbox cleanup won the authorization race",
      );
    }

    const active = this.trackExecution(
      this.startExecution(authorized.request, options, true),
    );
    if (!(await active.ready)) return active.result;
    const handle: SandboxDuplexHandleV1 = Object.freeze({
      write: (bytes: Uint8Array) => active.write(bytes),
      endInput: () => active.endInput(),
      terminate: () => active.terminate(),
      completion: active.result,
    });
    return { kind: "opened", handle };
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
            !receipt.scopeRemoved ||
            (this.capability.taskStorage !== undefined &&
              this.hostBinding.taskStorageRoot !== undefined &&
              receipt.storageReconciled !== true)) &&
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

  private trackExecution(execution: ActiveExecution): ActiveExecution {
    const tracked: ActiveExecution = {
      ...execution,
      result: execution.result.then((result) => {
        if (result.kind === "executed") {
          this.#executionCleanupReceipts.push(result.receipt.cleanup);
        }
        return result;
      }),
    };
    this.#active.add(tracked);
    void tracked.result.then(
      () => this.#active.delete(tracked),
      () => this.#active.delete(tracked),
    );
    return tracked;
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
    const profileToolchainCapability =
      request.profile === "godot-headless"
        ? this.managedRuntime?.capability.toolchain
        : this.toolchain?.capability;
    const permittedCommands = new Set([
      "/bin/busybox",
      ...(profileToolchainCapability?.files
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
      this.layout.runtimeRecordDirectory,
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
    duplex: boolean,
  ): ActiveExecution {
    const limits = resolveResourceLimitsV1(request.profile, request.timeoutMs);
    const profileFiles =
      request.profile === "godot-headless"
        ? (this.resources.managedRuntimeFiles ?? [])
        : this.resources.toolchainFiles;
    const profileBinding =
      request.profile === "godot-headless"
        ? this.managedRuntime?.binding.toolchain
        : this.toolchain?.binding;

    const startedAtMonotonicMs = this.clock.now();
    const stdoutCapture = new BoundedOutputCapture(limits.stdoutMaxBytes);
    const stderrCapture = new BoundedOutputCapture(limits.stderrMaxBytes);
    const runtime: ExecutionRuntime = {
      scope: undefined,
      session: undefined,
      bootstrapCleanup: undefined,
      scratch: undefined,
      scratchCleanup: undefined,
      scratchCreationFailed: false,
      stdoutDrain: undefined,
      stderrDrain: undefined,
    };
    let mountAdmission: SandboxMountAdmissionReceiptV1 | undefined;
    const setupDone = deferred<void>();
    const ready = deferred<boolean>();
    const terminal = deferred<TerminalReason>();
    let readyPublished = false;
    const publishReady = (value: boolean): void => {
      if (readyPublished) return;
      readyPublished = true;
      ready.resolve(value);
    };
    let terminalReason: TerminalReason | undefined;
    let inputClosed = false;
    let inputTail: Promise<void> = Promise.resolve();
    let endInputPromise: Promise<void> | undefined;
    const selectTerminal = (reason: TerminalReason): void => {
      if (terminalReason !== undefined) return;
      terminalReason = reason;
      inputClosed = true;
      terminal.resolve(reason);
    };
    const inputUnavailable = (): M1Error =>
      new M1Error(
        "command_cancelled",
        "Sandbox duplex stdin is ended or the execution has terminated",
      );
    const write = (bytes: Uint8Array): Promise<void> => {
      if (!duplex) {
        return Promise.reject(
          new M1Error(
            "capability_denied",
            "One-shot sandbox executions do not expose duplex stdin",
          ),
        );
      }
      if (!(bytes instanceof Uint8Array)) {
        return Promise.reject(
          new TypeError("Sandbox duplex input must be a Uint8Array"),
        );
      }
      if (inputClosed) return Promise.reject(inputUnavailable());
      const owned = Uint8Array.from(bytes);
      const pending = inputTail.then(async () => {
        if (terminalReason !== undefined || runtime.session === undefined) {
          throw inputUnavailable();
        }
        await runtime.session.writeStdin(owned);
      });
      const guarded = pending.catch((error: unknown) => {
        inputClosed = true;
        selectTerminal({ kind: "launch_failed", error });
        throw error;
      });
      inputTail = guarded.then(
        () => undefined,
        () => undefined,
      );
      return guarded;
    };
    const endInput = (): Promise<void> => {
      if (!duplex) {
        return Promise.reject(
          new M1Error(
            "capability_denied",
            "One-shot sandbox executions do not expose duplex stdin",
          ),
        );
      }
      if (endInputPromise !== undefined) return endInputPromise;
      if (inputClosed) return Promise.reject(inputUnavailable());
      inputClosed = true;
      const pending = inputTail.then(async () => {
        if (runtime.session === undefined) throw inputUnavailable();
        await runtime.session.endStdin();
      });
      endInputPromise = pending.catch((error: unknown) => {
        selectTerminal({ kind: "launch_failed", error });
        throw error;
      });
      inputTail = endInputPromise.then(
        () => undefined,
        () => undefined,
      );
      return endInputPromise;
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
        let runtimeScratchTarget:
          { readonly fd: number; readonly target: string } | undefined;
        if (request.profile === "godot-headless") {
          let scratch: SandboxBrokerExecutionScratch;
          try {
            scratch = await this.dependencies.createExecutionScratch({
              layout: this.layout,
              operationId: request.operationId,
            });
          } catch (error) {
            if (error instanceof SandboxExecutionScratchCreationError) {
              runtime.scratchCleanup = error.scratch;
              runtime.scratchCreationFailed = true;
              this.#executionScratches.add(error.scratch);
            }
            throw error;
          }
          runtime.scratch = scratch;
          runtime.scratchCleanup = scratch;
          this.#executionScratches.add(scratch);
          const existingDescriptors = [
            this.resources.workspaceFd,
            this.resources.temporaryFd,
            this.resources.artifactsFd,
            this.resources.runtimeFd,
            ...profileFiles.map((file) => file.fd),
            ...(this.resources.managedFontconfig === undefined
              ? []
              : [this.resources.managedFontconfig.fd]),
            ...(this.resources.managedAddon === undefined
              ? []
              : [
                  this.resources.managedAddon.parentFd,
                  this.resources.managedAddon.fd,
                ]),
            ...(this.resources.managedOverlay === undefined
              ? []
              : [this.resources.managedOverlay.fd]),
            ...(this.resources.managedAdapter === undefined
              ? []
              : [
                  this.resources.managedAdapter.parentFd,
                  this.resources.managedAdapter.fd,
                ]),
          ];
          if (
            !Number.isInteger(scratch.fd) ||
            scratch.fd < 0 ||
            existingDescriptors.includes(scratch.fd) ||
            !isAbsolute(scratch.path) ||
            resolve(scratch.path) !== scratch.path ||
            scratch.path === this.layout.hostOperationTemporaryDirectory ||
            !pathAtOrBelow(
              this.layout.hostOperationTemporaryDirectory,
              scratch.path,
            )
          ) {
            throw new M1Error(
              "sandbox_preflight_failed",
              "operation scratch crossed its fixed Task storage boundary",
            );
          }
          if (
            this.capability.taskStorage === undefined ||
            this.hostBinding.taskStorageRoot === undefined
          ) {
            throw new M1Error(
              "resource_limit_unavailable",
              "Godot operation scratch requires bounded aggregate Task storage",
            );
          }
          await this.dependencies.inspectTaskStorage({
            capability: this.capability.taskStorage,
            taskStorageRoot: this.hostBinding.taskStorageRoot,
            layoutPaths: [...taskLayoutPaths(this.layout), scratch.path],
          });
          runtimeScratchTarget = {
            fd: SANDBOX_FDS.runtimeScratch,
            target: "/run/chronorift",
          };
        }
        if (terminalReason !== undefined) return;
        const includeManagedAddon =
          request.profile === "godot-headless" &&
          this.resources.managedAddon !== undefined &&
          (this.managedRuntime === undefined ||
            !isOverlayManagedRuntime(this.managedRuntime) ||
            duplex);
        const includeManagedOverlay =
          request.profile === "godot-headless" &&
          this.resources.managedOverlay !== undefined &&
          this.managedRuntime !== undefined &&
          isOverlayManagedRuntime(this.managedRuntime) &&
          duplex;
        const includeManagedAdapter =
          request.profile === "godot-headless" &&
          this.resources.managedAdapter !== undefined &&
          this.managedRuntime !== undefined &&
          isProjectEnvironmentManagedRuntime(this.managedRuntime) &&
          duplex;
        const runtimeStart =
          SANDBOX_FDS.runtimeStart +
          (runtimeScratchTarget === undefined ? 0 : 1);
        const runtimeTargets = [
          "/bin/busybox",
          ...profileFiles.map((file) => file.target),
          ...(request.profile === "godot-headless" &&
          this.resources.managedFontconfig !== undefined
            ? [this.resources.managedFontconfig.target]
            : []),
          ...(includeManagedAddon && this.resources.managedAddon !== undefined
            ? [
                this.resources.managedAddon.parentTarget,
                this.resources.managedAddon.target,
              ]
            : []),
          ...(includeManagedOverlay &&
          this.resources.managedOverlay !== undefined
            ? [this.resources.managedOverlay.target]
            : []),
          ...(includeManagedAdapter &&
          this.resources.managedAdapter !== undefined
            ? [
                this.resources.managedAdapter.parentTarget,
                this.resources.managedAdapter.target,
              ]
            : []),
        ].map((target, index) => ({ fd: runtimeStart + index, target }));
        const plan = this.dependencies.buildProcessPlan({
          request,
          limits,
          binaries: {
            prlimit: this.hostBinding.prlimitPath,
            bwrap: this.hostBinding.bwrapPath,
          },
          ...(runtimeScratchTarget === undefined
            ? {}
            : { runtimeScratch: runtimeScratchTarget }),
          runtimeTargets,
          unshareCgroupNamespace: this.capability.cgroupNamespaceUnshared,
        });
        mountAdmission = assertProcessPlan(
          plan,
          request,
          this.hostBinding,
          this.layout,
          runtimeScratchTarget,
          runtimeTargets,
          profileBinding,
        );
        if (terminalReason !== undefined) return;
        const controller = await this.controller();
        if (terminalReason !== undefined) return;
        runtime.scope = await controller.createExecutionScope(
          request.operationId,
          limits,
        );
        if (terminalReason !== undefined) return;
        try {
          runtime.session = await this.dependencies.startBootstrap({
            cwd: this.layout.taskRootDirectory,
            inheritedFds: [
              this.resources.workspaceFd,
              this.resources.temporaryFd,
              this.resources.artifactsFd,
              ...(runtime.scratch === undefined ? [] : [runtime.scratch.fd]),
              this.resources.runtimeFd,
              ...profileFiles.map((file) => file.fd),
              ...(request.profile === "godot-headless" &&
              this.resources.managedFontconfig !== undefined
                ? [this.resources.managedFontconfig.fd]
                : []),
              ...(includeManagedAddon &&
              this.resources.managedAddon !== undefined
                ? [
                    this.resources.managedAddon.parentFd,
                    this.resources.managedAddon.fd,
                  ]
                : []),
              ...(includeManagedOverlay &&
              this.resources.managedOverlay !== undefined
                ? [this.resources.managedOverlay.fd]
                : []),
              ...(includeManagedAdapter &&
              this.resources.managedAdapter !== undefined
                ? [
                    this.resources.managedAdapter.parentFd,
                    this.resources.managedAdapter.fd,
                  ]
                : []),
            ],
          });
        } catch (error) {
          if (error instanceof SandboxBootstrapReadinessCleanupError) {
            runtime.bootstrapCleanup = error;
            this.#bootstrapCleanups.add(error);
          }
          throw error;
        }
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
        if (duplex) {
          await runtime.session.authorize();
          if (terminalReason !== undefined) return;
          publishReady(true);
        } else {
          const stdinDelivery = runtime.session.provideStdin(
            options.stdin ?? new Uint8Array(),
          );
          void stdinDelivery.catch(() => undefined);
          await runtime.session.authorize();
          await stdinDelivery;
        }
      } catch (error) {
        selectTerminal({ kind: "launch_failed", error });
      } finally {
        publishReady(false);
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
      let aggregateStorageObserved = false;
      if (
        this.capability.taskStorage !== undefined &&
        this.hostBinding.taskStorageRoot !== undefined
      ) {
        try {
          const aggregateStorage = await this.dependencies.inspectTaskStorage({
            capability: this.capability.taskStorage,
            taskStorageRoot: this.hostBinding.taskStorageRoot,
            layoutPaths: [
              ...taskLayoutPaths(this.layout),
              ...(runtime.scratchCleanup === undefined
                ? []
                : [runtime.scratchCleanup.path]),
            ],
          });
          resourceUsage = {
            ...resourceUsage,
            aggregateStorage,
          };
          aggregateStorageObserved = true;
        } catch (error) {
          await this.reportDiagnostic(error);
        }
      }

      let bootstrapExited =
        runtime.session === undefined && runtime.bootstrapCleanup === undefined;
      if (runtime.session !== undefined) {
        bootstrapExited = await Promise.race([
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

      let scratchRemoved = runtime.scratchCleanup === undefined;
      if (runtime.scratchCleanup !== undefined) {
        if (
          !runtime.scratchCreationFailed &&
          bootstrapExited &&
          !cgroupPopulated &&
          scopeRemoved
        ) {
          try {
            await runtime.scratchCleanup.close();
            this.#executionScratches.delete(runtime.scratchCleanup);
            scratchRemoved = true;
          } catch (error) {
            await this.reportDiagnostic(error);
          }
        } else {
          await this.reportDiagnostic(
            new M1Error(
              "sandbox_launch_failed",
              "operation scratch retained until process and cgroup cleanup are proven",
            ),
          );
        }
      }
      const processGroupTerminated =
        bootstrapExited && scopeRemoved && !cgroupPopulated;
      const allResourcesRemoved = processGroupTerminated && scratchRemoved;

      let storageReconciled: boolean | undefined;
      if (
        this.capability.taskStorage !== undefined &&
        this.hostBinding.taskStorageRoot !== undefined
      ) {
        storageReconciled = false;
        if (allResourcesRemoved && aggregateStorageObserved) {
          try {
            await this.dependencies.inspectTaskStorage({
              capability: this.capability.taskStorage,
              taskStorageRoot: this.hostBinding.taskStorageRoot,
              layoutPaths: taskLayoutPaths(this.layout),
            });
            storageReconciled = true;
          } catch (error) {
            await this.reportDiagnostic(error);
          }
        }
      }

      const cleanup = SandboxCleanupReceiptV1Schema.parse({
        processGroupTerminated,
        cgroupPopulated,
        termSent,
        killSent,
        scopeRemoved: allResourcesRemoved,
        ...(storageReconciled === undefined ? {} : { storageReconciled }),
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
        realizedMechanisms: realizedMechanismsFor(
          this.capability,
          aggregateStorageObserved,
        ),
        resourceUsage,
        stdout: stdoutCapture.receipt(),
        stderr: stderrCapture.receipt(),
        exitCode: reason.kind === "exit" ? reason.exitCode : null,
        signal: reason.kind === "exit" ? reason.signal : null,
        startedAtMonotonicMs,
        endedAtMonotonicMs: this.clock.now(),
        cleanup,
        ...(mountAdmission === undefined ? {} : { mountAdmission }),
      });
      return {
        kind: "executed",
        receipt,
        stdout: stdoutCapture.bytes(),
        stderr: stderrCapture.bytes(),
      };
    })();
    return {
      cancel: () => selectTerminal({ kind: "cancelled" }),
      ready: ready.promise,
      write,
      endInput,
      terminate: () => {
        selectTerminal({ kind: "cancelled" });
        return Promise.resolve();
      },
      result,
    };
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

    const bootstrapCleanups = [...this.#bootstrapCleanups];
    const bootstrapCleanupResults = await Promise.allSettled(
      bootstrapCleanups.map((owner) => owner.retryCleanup()),
    );
    for (const [index, result] of bootstrapCleanupResults.entries()) {
      const owner = bootstrapCleanups[index];
      if (owner === undefined) continue;
      if (result.status === "fulfilled") {
        this.#bootstrapCleanups.delete(owner);
      } else {
        await this.reportDiagnostic(result.reason);
      }
    }
    const bootstrapProcessesCleaned = this.#bootstrapCleanups.size === 0;

    let controllerCleaned = this.#controllerPromise === undefined;
    if (this.#controllerPromise !== undefined) {
      try {
        await (await this.#controllerPromise).cleanup();
        controllerCleaned = true;
      } catch (error) {
        await this.reportDiagnostic(error);
      }
    }
    if (controllerCleaned && bootstrapProcessesCleaned) {
      const scratches = [...this.#executionScratches];
      const scratchResults = await Promise.allSettled(
        scratches.map((scratch) => scratch.close()),
      );
      for (const [index, result] of scratchResults.entries()) {
        const scratch = scratches[index];
        if (scratch === undefined) continue;
        if (result.status === "fulfilled") {
          this.#executionScratches.delete(scratch);
        } else {
          await this.reportDiagnostic(result.reason);
        }
      }
    }
    const scratchesClosed = this.#executionScratches.size === 0;
    let resourcesClosed = false;
    try {
      await this.resources.close();
      resourcesClosed = true;
    } catch (error) {
      await this.reportDiagnostic(error);
    }

    let storageReconciled: boolean | undefined;
    if (
      this.capability.taskStorage !== undefined &&
      this.hostBinding.taskStorageRoot !== undefined
    ) {
      storageReconciled = false;
      try {
        await this.dependencies.inspectTaskStorage({
          capability: this.capability.taskStorage,
          taskStorageRoot: this.hostBinding.taskStorageRoot,
          layoutPaths: [
            ...taskLayoutPaths(this.layout),
            ...[...this.#executionScratches].map((scratch) => scratch.path),
          ],
        });
        storageReconciled = true;
      } catch (error) {
        await this.reportDiagnostic(error);
      }
    }

    const processGroupsTerminated =
      controllerCleaned && bootstrapProcessesCleaned;
    const allResourcesRemoved =
      processGroupsTerminated && scratchesClosed && resourcesClosed;
    return SandboxCleanupReceiptV1Schema.parse({
      processGroupTerminated: processGroupsTerminated,
      cgroupPopulated: !controllerCleaned,
      termSent: this.#executionCleanupReceipts.some(
        (receipt) => receipt.termSent,
      ),
      killSent: this.#executionCleanupReceipts.some(
        (receipt) => receipt.killSent,
      ),
      scopeRemoved: allResourcesRemoved,
      ...(storageReconciled === undefined ? {} : { storageReconciled }),
    });
  }
}

export interface CreateBwrapCgroupTaskSandboxOptionsV1 {
  readonly taskId: TaskId;
  readonly capability: SandboxHostCapabilityV1;
  readonly hostBinding: SandboxHostBinding;
  readonly policy: SandboxPolicy;
  readonly toolchain?:
    | {
        readonly capability: SandboxToolchainCapabilityV1;
        readonly binding: SandboxToolchainBindingV1;
      }
    | undefined;
  readonly managedRuntime?: SandboxManagedGodotRuntimeV1 | undefined;
  readonly layout: TaskDirectoryLayout;
  readonly securityEvents: (event: SecurityEventV1) => Promise<void>;
  readonly clock?: MonotonicClockV1 | undefined;
}

export async function createDuplexBwrapCgroupTaskSandbox(
  options: CreateBwrapCgroupTaskSandboxOptionsV1,
  dependencies: SandboxBrokerDependencies = defaultDependencies,
): Promise<DuplexTaskSandboxBrokerV1> {
  const capability = SandboxHostCapabilityV1Schema.parse(options.capability);
  const policy = SandboxPolicySchema.parse(options.policy);
  if (
    policy.schemaVersion === 2 &&
    capability.bwrap.features.at(-1) !== "remount-ro"
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "Sandbox Policy V2 requires frozen bubblewrap remount-ro support",
    );
  }
  const toolchain =
    options.toolchain === undefined
      ? undefined
      : {
          capability: SandboxToolchainCapabilityV1Schema.parse(
            options.toolchain.capability,
          ),
          binding: options.toolchain.binding,
        };
  let managedRuntime: SandboxManagedGodotRuntimeV1 | undefined;
  if (options.managedRuntime !== undefined) {
    managedRuntime = isLifecycleManagedRuntime(options.managedRuntime)
      ? {
          capability: ManagedGodotLifecycleRuntimeCapabilityV1Schema.parse(
            options.managedRuntime.capability,
          ),
          binding: options.managedRuntime.binding,
        }
      : isSemanticManagedRuntime(options.managedRuntime)
        ? {
            capability: ManagedGodotSemanticRuntimeCapabilityV1Schema.parse(
              options.managedRuntime.capability,
            ),
            binding: options.managedRuntime.binding,
          }
        : isProjectEnvironmentManagedRuntime(options.managedRuntime)
          ? {
              capability:
                ManagedGodotProjectEnvironmentRuntimeCapabilityV1Schema.parse(
                  options.managedRuntime.capability,
                ),
              binding: options.managedRuntime.binding,
            }
          : {
              capability: ManagedGodotRuntimeCapabilityV1Schema.parse(
                options.managedRuntime.capability,
              ),
              binding: options.managedRuntime.binding,
            };
  }
  assertHostBinding(capability, options.hostBinding);
  const hostBinding = Object.freeze({ ...options.hostBinding });
  if (toolchain !== undefined) {
    assertToolchainBinding(toolchain.capability, toolchain.binding);
  }
  if (managedRuntime !== undefined) {
    assertSandboxManagedRuntimeBinding(managedRuntime);
    const shellIndex = managedRuntime.capability.toolchain.files.findIndex(
      (file) => file.target === DEFAULT_RUNTIME_SIDECAR_TARGETS.shellExecutable,
    );
    if (
      shellIndex < 0 ||
      managedRuntime.capability.toolchain.files[shellIndex]?.sha256 !==
        capability.runtimeIdentity ||
      managedRuntime.binding.toolchain.files[shellIndex]?.hostPath !==
        hostBinding.busyboxPath
    ) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "managed /bin/sh must reuse the frozen sandbox busybox identity",
      );
    }
  }
  assertLayout(options.taskId, options.layout);
  assertLayoutWithinTaskStorage(
    capability,
    hostBinding,
    options.layout,
    managedRuntime?.capability,
  );
  assertHostExecutablesOutsideWritableLayout(
    hostBinding,
    options.layout,
    toolchain?.binding,
    managedRuntime?.binding,
  );
  if (policy.runtimeIdentity !== capability.runtimeIdentity) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox policy runtime does not match the Host capability",
    );
  }
  const targetsFor = (
    frozen: { readonly capability: SandboxToolchainCapabilityV1 } | undefined,
  ): readonly string[] =>
    [
      "/bin/busybox",
      ...(frozen?.capability.files.map((file) => file.target) ?? []),
    ].sort();
  const managedTargets = (): readonly string[] =>
    managedRuntime === undefined
      ? ["/bin/busybox"]
      : [
          "/bin/busybox",
          ...managedRuntime.capability.toolchain.files.map(
            (file) => file.target,
          ),
          managedRuntime.capability.fontconfigTarget,
          managedRuntime.capability.addonParentTarget,
          managedRuntime.capability.addonTarget,
          ...(isOverlayManagedRuntime(managedRuntime)
            ? [managedRuntime.capability.overlayTarget]
            : []),
          ...(isProjectEnvironmentManagedRuntime(managedRuntime)
            ? [
                managedRuntime.capability.adapterParentTarget,
                managedRuntime.capability.adapterTarget,
              ]
            : []),
        ].sort();
  if (policy.schemaVersion === 1) {
    if (managedRuntime !== undefined) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "Sandbox Policy V1 policy cannot authorize a managed runtime",
      );
    }
    if (
      policy.toolchainId !== (toolchain?.capability.toolchainId ?? null) ||
      JSON.stringify(policy.readonlyTargets) !==
        JSON.stringify(targetsFor(toolchain))
    ) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox policy does not match the frozen toolchain capability",
      );
    }
  } else if (
    toolchain === undefined ||
    managedRuntime === undefined ||
    policy.profileBindings["coding-default"].toolchainId !==
      toolchain.capability.toolchainId ||
    policy.profileBindings["coding-default"].managedRuntimeId !== null ||
    policy.profileBindings["coding-default"].workspaceAccess !== "read-write" ||
    JSON.stringify(policy.profileBindings["coding-default"].readonlyTargets) !==
      JSON.stringify(targetsFor(toolchain)) ||
    policy.profileBindings["godot-headless"].toolchainId !==
      managedRuntime.capability.toolchain.toolchainId ||
    policy.profileBindings["godot-headless"].managedRuntimeId !==
      managedRuntime.capability.managedRuntimeId ||
    policy.profileBindings["godot-headless"].workspaceAccess !== "read-only" ||
    JSON.stringify(policy.profileBindings["godot-headless"].readonlyTargets) !==
      JSON.stringify(managedTargets())
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox Policy V2 profile bindings do not match the frozen toolchains",
    );
  }
  if (
    capability.taskStorage !== undefined &&
    hostBinding.taskStorageRoot !== undefined
  ) {
    await dependencies.inspectTaskStorage({
      capability: capability.taskStorage,
      taskStorageRoot: hostBinding.taskStorageRoot,
      layoutPaths: taskLayoutPaths(options.layout),
    });
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
    ...(managedRuntime === undefined ? {} : { managedRuntime }),
  });
  try {
    assertBoundDescriptors(resources);
    if (
      (managedRuntime === undefined) !==
        (resources.managedAddon === undefined) ||
      (managedRuntime === undefined) !==
        (resources.managedFontconfig === undefined) ||
      (managedRuntime !== undefined &&
        isOverlayManagedRuntime(managedRuntime)) !==
        (resources.managedOverlay !== undefined) ||
      (managedRuntime !== undefined &&
        isProjectEnvironmentManagedRuntime(managedRuntime)) !==
        (resources.managedAdapter !== undefined) ||
      (managedRuntime !== undefined &&
        (resources.managedAddon?.target !==
          managedRuntime.capability.addonTarget ||
          resources.managedAddon.parentTarget !==
            managedRuntime.capability.addonParentTarget ||
          resources.managedFontconfig?.target !==
            managedRuntime.capability.fontconfigTarget ||
          (isOverlayManagedRuntime(managedRuntime) &&
            resources.managedOverlay?.target !==
              managedRuntime.capability.overlayTarget) ||
          (isProjectEnvironmentManagedRuntime(managedRuntime) &&
            (resources.managedAdapter?.target !==
              managedRuntime.capability.adapterTarget ||
              resources.managedAdapter.parentTarget !==
                managedRuntime.capability.adapterParentTarget))))
    ) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "pinned managed addon does not match the frozen runtime target",
      );
    }
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
      managedRuntime,
      options.layout,
      resources,
      options.securityEvents,
      options.clock ?? { now: () => performance.now() },
      dependencies,
    );
  } catch (error) {
    return rethrowAfterBoundedSetupCleanup(error, () => resources.close());
  }
}

export async function createBwrapCgroupTaskSandbox(
  options: CreateBwrapCgroupTaskSandboxOptionsV1,
  dependencies: SandboxBrokerDependencies = defaultDependencies,
): Promise<TaskSandboxBrokerV1> {
  return createDuplexBwrapCgroupTaskSandbox(options, dependencies);
}
