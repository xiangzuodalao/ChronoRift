import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  asSha256DigestV1,
  TaskIdentityV1Schema,
  TaskPatchIdentityV1Schema,
  taskNamespaceDigestV1,
  type JsonValue,
  type TaskId,
  type TaskIdentityV1,
} from "@chronorift/domain";
import {
  VNextTaskStore,
  contentHash,
  type VNextTaskBytesSlot,
  type VNextTaskJsonSlot,
  type VNextTaskLedgerSlot,
} from "@chronorift/json-artifacts";

import {
  M1TaskEventV1Schema,
  SandboxCleanupReceiptV1Schema,
  PatchExportReceiptV1Schema,
  PatchExportEventV1Schema,
  RelativeExportPathV1Schema,
  SandboxHostCapabilityV1Schema,
  TaskFixtureCapabilityV1Schema,
  SandboxExecutionReceiptV1Schema,
  SandboxExecutionRequestV1Schema,
  SandboxOperationRecordV1Schema,
  SandboxPolicyV1Schema,
  SandboxPreflightReceiptV1Schema,
  SandboxToolchainCapabilityV1Schema,
  SecurityEventV1Schema,
  WorkspaceMaterializationReceiptV1Schema,
  type PatchExportReceiptV1,
  type SandboxCleanupReceiptV1,
  type SandboxExecutionRequestV1,
  type SandboxHostCapabilityV1,
  type SandboxPolicyV1,
  type SandboxToolchainCapabilityV1,
  type SecurityEventV1,
  type WorkspaceMaterializationReceiptV1,
} from "./contracts.js";
import { M1Error, M1PatchExportError, sanitizeM1Diagnostic } from "./errors.js";
import { NodeHostGitPort } from "./host-git.js";
import {
  exportTaskPatch,
  extractTaskPatch,
  type ExtractedTaskPatch,
} from "./patch-handoff.js";
import {
  createBwrapCgroupTaskSandbox,
  type SandboxExecutionOptionsV1,
  type SandboxExecutionResultV1,
  type TaskSandboxBrokerV1,
} from "./sandbox-broker.js";
import {
  assertSandboxHostBindingMatches,
  preflightSandboxHost,
  type SandboxHostBinding,
  type SandboxHostPreflightRequest,
  type SandboxHostPreflightResult,
} from "./sandbox-preflight.js";
import { createSandboxPolicyV1 } from "./sandbox-policy.js";
import {
  inspectSandboxToolchain,
  type SandboxToolchainBindingV1,
  type SandboxToolchainCommandBindingV1,
} from "./sandbox-toolchain.js";
import {
  preflightCleanGitSubtree,
  type CleanGitSubtreePreflightRequest,
  type VerifiedGitSubtree,
} from "./source-preflight.js";
import {
  createTaskDirectoryLayout,
  type TaskDirectoryLayout,
} from "./task-paths.js";
import {
  materializePrivateTaskWorkspace,
  type MaterializedPrivateTaskWorkspace,
} from "./workspace-materializer.js";

interface M1TaskRecordStore {
  create(taskId: TaskId): Promise<void>;
  putJsonOnce<T>(
    taskId: TaskId,
    slot: VNextTaskJsonSlot,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<void>;
  readJson<T>(
    taskId: TaskId,
    slot: VNextTaskJsonSlot,
    parse: (input: unknown) => T,
  ): Promise<T>;
  putBytesOnce(
    taskId: TaskId,
    slot: VNextTaskBytesSlot,
    bytes: Uint8Array,
  ): Promise<void>;
  readBytes(taskId: TaskId, slot: VNextTaskBytesSlot): Promise<Uint8Array>;
  append<T>(
    taskId: TaskId,
    slot: VNextTaskLedgerSlot,
    payload: T,
    parse: (input: unknown) => T,
  ): Promise<unknown>;
  discard(taskId: TaskId): Promise<void>;
}

export interface M1TaskEnvironment {
  readonly task: TaskIdentityV1;
  readonly workspace: WorkspaceMaterializationReceiptV1;
  readonly sandboxCapability: SandboxHostCapabilityV1;
  readonly toolchainCapability?: SandboxToolchainCapabilityV1 | undefined;
  readonly policy: SandboxPolicyV1;
}

export interface PrepareM1TaskEnvironmentRequest {
  readonly taskId: TaskId;
  readonly projectPath: string;
  readonly trustedFixtureRoot: string;
  readonly runtimeRoot: string;
  readonly sandboxHost: SandboxHostPreflightRequest;
  readonly sandboxToolchain?:
    | {
        readonly lddPath: string;
        readonly commands: readonly SandboxToolchainCommandBindingV1[];
      }
    | undefined;
}

interface M1TaskEnvironmentDependencies {
  readonly now: () => string;
  readonly preflightSandbox: (
    request: SandboxHostPreflightRequest,
  ) => Promise<SandboxHostPreflightResult>;
  readonly preflightSource: (
    request: CleanGitSubtreePreflightRequest,
  ) => Promise<VerifiedGitSubtree>;
  readonly createLayout: typeof createTaskDirectoryLayout;
  readonly createStore: (runtimeRoot: string) => M1TaskRecordStore;
  readonly materializeWorkspace: typeof materializePrivateTaskWorkspace;
  readonly assertSandboxBinding: typeof assertSandboxHostBindingMatches;
  readonly inspectToolchain: typeof inspectSandboxToolchain;
  readonly createBroker: typeof createBwrapCgroupTaskSandbox;
  readonly extractPatch: typeof extractTaskPatch;
  readonly exportPatch: typeof exportTaskPatch;
  readonly cleanStagingRegistration: (
    source: VerifiedGitSubtree,
    layout: TaskDirectoryLayout,
  ) => Promise<void>;
}

interface M1TaskEnvironmentState {
  readonly layout: TaskDirectoryLayout;
  readonly source: VerifiedGitSubtree;
  readonly materialized: MaterializedPrivateTaskWorkspace;
  readonly binding: SandboxHostBinding;
  readonly broker: TaskSandboxBrokerV1;
  readonly store: M1TaskRecordStore;
  readonly gate: TaskOperationGate;
  readonly dependencies: M1TaskEnvironmentDependencies;
  readonly sensitiveValues: readonly string[];
  readonly securityEvents: TaskSecurityEventRecorder;
  recordsDiscarded: boolean;
  discardPromise: Promise<SandboxCleanupReceiptV1> | undefined;
}

const ENVIRONMENT_STATES = new WeakMap<
  M1TaskEnvironment,
  M1TaskEnvironmentState
>();

const MUTABLE_TASK_CHILDREN = [
  "workspace",
  "tmp",
  "sandbox-artifacts",
  "host-baseline.git",
  "host-tmp",
] as const;
const DISCARDABLE_TASK_CHILDREN = new Set<string>(MUTABLE_TASK_CHILDREN);

class TaskOperationGate {
  #accepting = true;
  #tail: Promise<void> = Promise.resolve();

  public run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#accepting) return Promise.reject(commandCancelled());
    const result = this.#tail.then(async () => {
      if (!this.#accepting) throw commandCancelled();
      return operation();
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public close(): void {
    this.#accepting = false;
  }

  public drain(): Promise<void> {
    return this.#tail;
  }
}

class TaskSecurityEventRecorder {
  readonly #persistedById = new Map<string, SecurityEventV1>();
  #activeOperationId: string | undefined;
  #stagedById = new Map<string, SecurityEventV1>();

  public constructor(
    readonly taskId: TaskId,
    readonly store: M1TaskRecordStore,
    readonly sensitiveValues: readonly string[],
  ) {}

  public begin(operationId: string): void {
    if (this.#activeOperationId !== undefined) {
      throw new M1Error(
        "artifact_write_failed",
        "a sandbox security-event scope is already active",
      );
    }
    this.#activeOperationId = operationId;
    this.#stagedById = new Map();
  }

  public stage(value: unknown): SecurityEventV1 {
    const parsed = SecurityEventV1Schema.parse(value);
    if (
      this.#activeOperationId === undefined ||
      parsed.taskId !== this.taskId ||
      parsed.operationId !== this.#activeOperationId
    ) {
      throw new M1Error(
        "artifact_write_failed",
        "sandbox security event is not bound to the active Task operation",
      );
    }
    const event = SecurityEventV1Schema.parse({
      ...parsed,
      message:
        sanitizeM1Diagnostic(parsed.message, this.sensitiveValues) ||
        "sandbox operation denied",
      target:
        sanitizeM1Diagnostic(parsed.target, this.sensitiveValues) ||
        "sandbox target redacted",
    });
    const previous =
      this.#stagedById.get(event.eventId) ??
      this.#persistedById.get(event.eventId);
    if (previous !== undefined && !sameJson(previous, event)) {
      throw new M1Error(
        "artifact_write_failed",
        "sandbox security event id was reused with different content",
      );
    }
    if (this.#persistedById.has(event.eventId)) {
      throw new M1Error(
        "artifact_write_failed",
        "sandbox security event id was reused across operations",
      );
    }
    this.#stagedById.set(event.eventId, event);
    return event;
  }

  public assertNoneStaged(): void {
    if (this.#stagedById.size !== 0) {
      throw new M1Error(
        "artifact_write_failed",
        "an executed sandbox operation also emitted a denial event",
      );
    }
  }

  public async commitDenial(value: unknown): Promise<SecurityEventV1> {
    const event = this.stage(value);
    if (
      this.#stagedById.size !== 1 ||
      !sameJson(this.#stagedById.get(event.eventId), event)
    ) {
      throw new M1Error(
        "artifact_write_failed",
        "sandbox denial result does not match its staged security event",
      );
    }
    await this.store.append(this.taskId, "security.jsonl", event, (stored) =>
      SecurityEventV1Schema.parse(stored),
    );
    this.#persistedById.set(event.eventId, event);
    return event;
  }

  public end(operationId: string): void {
    if (this.#activeOperationId !== operationId) {
      throw new M1Error(
        "artifact_write_failed",
        "sandbox security-event scope ended out of order",
      );
    }
    this.#activeOperationId = undefined;
    this.#stagedById = new Map();
  }
}

const commandCancelled = (): M1Error =>
  new M1Error("command_cancelled", "Task lifecycle is closing or discarded");

const cloneAndFreeze = <T>(value: T): T => {
  const cloned = structuredClone(value);
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object") return;
    if (ArrayBuffer.isView(candidate)) return;
    for (const child of Object.values(candidate)) freeze(child);
    Object.freeze(candidate);
  };
  freeze(cloned);
  return cloned;
};

const defaultCleanStagingRegistration = async (
  source: VerifiedGitSubtree,
  layout: TaskDirectoryLayout,
): Promise<void> => {
  const git = new NodeHostGitPort();
  const stagingPath = join(
    layout.hostOperationTemporaryDirectory,
    "staging-worktree",
  );
  const isRegistered = (listing: Uint8Array): boolean =>
    new TextDecoder("utf-8", { fatal: true })
      .decode(listing)
      .split("\n")
      .some((line) => line === `worktree ${stagingPath}`);
  const before = await git.listWorktrees(source.repositoryRoot);
  if (isRegistered(before)) {
    try {
      await git.removeWorktree({
        repositoryRoot: source.repositoryRoot,
        worktreePath: stagingPath,
      });
    } catch (error) {
      if (isRegistered(await git.listWorktrees(source.repositoryRoot))) {
        throw error;
      }
    }
  }
  if (isRegistered(await git.listWorktrees(source.repositoryRoot))) {
    throw new M1Error(
      "artifact_write_failed",
      "staging worktree cleanup could not be proven",
    );
  }
};

const DEFAULT_DEPENDENCIES: M1TaskEnvironmentDependencies = {
  now: () => new Date().toISOString(),
  preflightSandbox: (request) => preflightSandboxHost(request),
  preflightSource: (request) => preflightCleanGitSubtree(request),
  createLayout: createTaskDirectoryLayout,
  createStore: (runtimeRoot) => new VNextTaskStore(runtimeRoot),
  materializeWorkspace: (request) => materializePrivateTaskWorkspace(request),
  assertSandboxBinding: assertSandboxHostBindingMatches,
  inspectToolchain: (request) => inspectSandboxToolchain(request),
  createBroker: (request) => createBwrapCgroupTaskSandbox(request),
  extractPatch: (request) => extractTaskPatch(request),
  exportPatch: (request) => exportTaskPatch(request),
  cleanStagingRegistration: defaultCleanStagingRegistration,
};

const fdChildPath = (parent: FileHandle, name: string): string =>
  `/proc/self/fd/${String(parent.fd)}/${name}`;

const fdChildBufferPath = (parent: FileHandle, name: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from(`/proc/self/fd/${String(parent.fd)}/`, "utf8"),
    name,
  ]);

const sameIdentity = (
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean => left.dev === right.dev && left.ino === right.ino;

const removePinnedEntry = async (
  parent: FileHandle,
  entryName: Buffer,
): Promise<void> => {
  if (
    entryName.length === 0 ||
    entryName.equals(Buffer.from(".")) ||
    entryName.equals(Buffer.from("..")) ||
    entryName.includes(0x2f) ||
    entryName.includes(0)
  ) {
    throw new M1Error("path_denied", "unsafe Task cleanup entry name");
  }
  const entryPath = fdChildBufferPath(parent, entryName);
  const before = await lstat(entryPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    await unlink(entryPath);
    return;
  }

  const child = await open(
    entryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let removed = false;
  try {
    const opened = await child.stat();
    if (!opened.isDirectory() || !sameIdentity(before, opened)) {
      throw new M1Error(
        "path_denied",
        "Task cleanup directory identity changed while opening",
      );
    }
    for (const childName of await readdir(`/proc/self/fd/${String(child.fd)}`, {
      encoding: "buffer",
    })) {
      await removePinnedEntry(child, childName);
    }
    await child.sync();
    const rebound = await lstat(entryPath);
    if (!rebound.isDirectory() || !sameIdentity(opened, rebound)) {
      throw new M1Error(
        "path_denied",
        "Task cleanup directory identity changed before removal",
      );
    }
    await rmdir(entryPath);
    removed = true;
  } finally {
    await child.close();
  }
  if (!removed) {
    throw new M1Error(
      "artifact_write_failed",
      "Task cleanup directory removal was not completed",
    );
  }
};

const withPinnedTaskRoot = async <T>(
  taskId: TaskId,
  layout: TaskDirectoryLayout,
  operation: (taskRoot: FileHandle, tasksDirectory: FileHandle) => Promise<T>,
): Promise<T> => {
  const expectedName = taskNamespaceDigestV1(taskId);
  if (
    basename(layout.taskRootDirectory) !== expectedName ||
    resolve(layout.taskRootDirectory) !== layout.taskRootDirectory
  ) {
    throw new M1Error(
      "path_denied",
      "Task root does not match its derived namespace",
    );
  }
  const tasksPath = dirname(layout.taskRootDirectory);
  if ((await realpath(tasksPath)) !== tasksPath) {
    throw new M1Error("path_denied", "Task parent must remain canonical");
  }
  const tasksDirectory = await open(
    tasksPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let taskRoot: FileHandle | undefined;
  try {
    taskRoot = await open(
      fdChildPath(tasksDirectory, expectedName),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const [pathIdentity, openedIdentity] = await Promise.all([
      lstat(layout.taskRootDirectory),
      taskRoot.stat(),
    ]);
    if (
      pathIdentity.isSymbolicLink() ||
      !pathIdentity.isDirectory() ||
      !openedIdentity.isDirectory() ||
      !sameIdentity(pathIdentity, openedIdentity)
    ) {
      throw new M1Error(
        "path_denied",
        "Task root identity changed before lifecycle cleanup",
      );
    }
    return await operation(taskRoot, tasksDirectory);
  } finally {
    await taskRoot?.close();
    await tasksDirectory.close();
  }
};

const removeMutableTaskState = async (
  taskId: TaskId,
  layout: TaskDirectoryLayout,
): Promise<void> =>
  withPinnedTaskRoot(taskId, layout, async (taskRoot) => {
    const entries = await readdir(`/proc/self/fd/${String(taskRoot.fd)}`);
    const unexpected = entries.find(
      (entry) => entry !== "records" && !DISCARDABLE_TASK_CHILDREN.has(entry),
    );
    if (unexpected !== undefined) {
      throw new M1Error(
        "path_denied",
        "Task root contains an unowned top-level entry",
      );
    }
    for (const child of MUTABLE_TASK_CHILDREN) {
      if (entries.includes(child)) {
        await removePinnedEntry(taskRoot, Buffer.from(child));
      }
    }
    const remaining = await readdir(`/proc/self/fd/${String(taskRoot.fd)}`);
    if (remaining.length !== 1 || remaining[0] !== "records") {
      throw new M1Error(
        "artifact_write_failed",
        "mutable Task cleanup did not leave exactly the records directory",
      );
    }
    await taskRoot.sync();
  });

const removeCompleteTaskRoot = async (
  taskId: TaskId,
  layout: TaskDirectoryLayout,
): Promise<void> =>
  withPinnedTaskRoot(taskId, layout, async (taskRoot, tasksDirectory) => {
    const entries = await readdir(`/proc/self/fd/${String(taskRoot.fd)}`);
    const unexpected = entries.find(
      (entry) => !DISCARDABLE_TASK_CHILDREN.has(entry),
    );
    if (unexpected !== undefined) {
      throw new M1Error(
        "path_denied",
        "Task root contains an unowned or unremoved top-level entry",
      );
    }
    for (const entry of entries) {
      await removePinnedEntry(taskRoot, Buffer.from(entry));
    }
    if ((await readdir(`/proc/self/fd/${String(taskRoot.fd)}`)).length !== 0) {
      throw new M1Error(
        "artifact_write_failed",
        "Task root changed while its owned children were removed",
      );
    }
    await taskRoot.sync();
    const rebound = await lstat(
      fdChildPath(tasksDirectory, taskNamespaceDigestV1(taskId)),
    );
    const opened = await taskRoot.stat();
    if (!rebound.isDirectory() || !sameIdentity(rebound, opened)) {
      throw new M1Error(
        "path_denied",
        "Task root identity changed before final removal",
      );
    }
    await rmdir(fdChildPath(tasksDirectory, taskNamespaceDigestV1(taskId)));
    await tasksDirectory.sync();
  });

const assertCompleteTaskRootIsOwned = async (
  taskId: TaskId,
  layout: TaskDirectoryLayout,
): Promise<void> =>
  withPinnedTaskRoot(taskId, layout, async (taskRoot) => {
    const entries = await readdir(`/proc/self/fd/${String(taskRoot.fd)}`);
    if (
      !entries.includes("records") ||
      entries.some(
        (entry) => entry !== "records" && !DISCARDABLE_TASK_CHILDREN.has(entry),
      )
    ) {
      throw new M1Error(
        "path_denied",
        "Task root is missing its records or contains an unowned entry",
      );
    }
  });

const requireEnvironmentState = (
  environment: M1TaskEnvironment,
): M1TaskEnvironmentState => {
  const state = ENVIRONMENT_STATES.get(environment);
  if (state === undefined) {
    throw new M1Error(
      "capability_denied",
      "M1 Task environment is not owned by this process",
    );
  }
  return state;
};

const normalizeError = (
  error: unknown,
  fallbackCode: "artifact_write_failed" | "sandbox_preflight_failed",
  sensitiveValues: readonly string[],
): M1Error => {
  const code = error instanceof M1Error ? error.code : fallbackCode;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message =
    sanitizeM1Diagnostic(rawMessage, sensitiveValues) || "M1 operation failed";
  if (error instanceof M1PatchExportError) {
    return new M1PatchExportError(
      error.code === "patch_export_failed"
        ? "patch_export_failed"
        : "artifact_write_failed",
      message,
      error.outputPath,
      error.targetPublished,
    );
  }
  return new M1Error(code, message);
};

const cleanupWasProven = (receipt: SandboxCleanupReceiptV1): boolean =>
  receipt.processGroupTerminated &&
  !receipt.cgroupPopulated &&
  receipt.scopeRemoved;

const cleanupBrokerAfterSetupFailure = async (
  broker: TaskSandboxBrokerV1,
): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const receipt = SandboxCleanupReceiptV1Schema.parse(
        await broker.cleanup(),
      );
      if (cleanupWasProven(receipt)) return;
    } catch {
      // A retryable broker forgets a rejected or unproven cleanup attempt.
    }
  }
  throw new M1Error(
    "artifact_write_failed",
    "sandbox cleanup could not be proven after setup failure",
  );
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const sameJson = (left: unknown, right: unknown): boolean =>
  contentHash(left as JsonValue) === contentHash(right as JsonValue);

const assertStreamReceiptMatches = (
  streamName: "stdout" | "stderr",
  bytes: Uint8Array,
  receipt: {
    readonly totalBytes: number;
    readonly capturedBytes: number;
    readonly sha256: string;
    readonly capturedSha256: string;
    readonly truncated: boolean;
  },
): void => {
  if (
    receipt.capturedBytes !== bytes.byteLength ||
    receipt.totalBytes < receipt.capturedBytes ||
    receipt.truncated !== receipt.totalBytes > receipt.capturedBytes ||
    receipt.capturedSha256 !== sha256(bytes) ||
    (!receipt.truncated &&
      (receipt.totalBytes !== bytes.byteLength ||
        receipt.sha256 !== sha256(bytes)))
  ) {
    throw new M1Error(
      "artifact_write_failed",
      `${streamName} bytes do not match the sandbox execution receipt`,
    );
  }
};

const recordSetupFailure = async (input: {
  readonly taskId: TaskId;
  readonly store: M1TaskRecordStore;
  readonly now: () => string;
  readonly error: M1Error;
}): Promise<void> => {
  await input.store.append(
    input.taskId,
    "task-events.jsonl",
    {
      schemaVersion: 1,
      taskId: input.taskId,
      kind: "setup_failed",
      occurredAt: input.now(),
      code: input.error.code,
      message: input.error.message,
    },
    (value) => M1TaskEventV1Schema.parse(value),
  );
};

const bindMaterializedWorkspace = (input: {
  readonly taskId: TaskId;
  readonly source: VerifiedGitSubtree;
  readonly layout: TaskDirectoryLayout;
  readonly materialized: MaterializedPrivateTaskWorkspace;
}): MaterializedPrivateTaskWorkspace => {
  const receipt = WorkspaceMaterializationReceiptV1Schema.parse(
    input.materialized.receipt,
  );
  const fixtureCapability = TaskFixtureCapabilityV1Schema.parse(
    input.materialized.fixtureCapability,
  );
  if (
    input.materialized.workspaceDirectory !== input.layout.workspaceDirectory ||
    input.materialized.hostBaselineGitDirectory !==
      input.layout.hostBaselineGitDirectory ||
    receipt.taskId !== input.taskId ||
    receipt.repositoryIdentity !== input.source.repositoryIdentity ||
    receipt.sourceRevision !== input.source.headCommit ||
    receipt.projectPrefix !== input.source.projectPrefix ||
    receipt.selectedTreeSha256 !== input.source.selectedTreeSha256 ||
    receipt.agentBaselineCommit !== input.materialized.agentBaselineCommit ||
    receipt.hostBaselineCommit !== input.materialized.hostBaselineCommit ||
    receipt.fixtureCapabilitySha256 !==
      input.source.fixtureCapability.capabilitySha256 ||
    !sameJson(
      receipt.excludedCachePaths,
      input.source.fixtureCapability.ignoredCachePaths,
    ) ||
    !sameJson(fixtureCapability, input.source.fixtureCapability)
  ) {
    throw new M1Error(
      "artifact_write_failed",
      "workspace materialization is not bound to the verified Task source and private layout",
    );
  }
  return {
    workspaceDirectory: input.layout.workspaceDirectory,
    hostBaselineGitDirectory: input.layout.hostBaselineGitDirectory,
    agentBaselineCommit: receipt.agentBaselineCommit,
    hostBaselineCommit: receipt.hostBaselineCommit,
    receipt,
    fixtureCapability,
  };
};

export async function prepareM1TaskEnvironment(
  request: PrepareM1TaskEnvironmentRequest,
  overrides: Partial<M1TaskEnvironmentDependencies> = {},
): Promise<M1TaskEnvironment> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const earlySensitiveValues = [
    request.projectPath,
    request.trustedFixtureRoot,
    request.runtimeRoot,
    request.sandboxHost.delegatedCgroupRoot,
    request.sandboxHost.bwrapPath,
    request.sandboxHost.prlimitPath,
    request.sandboxHost.busyboxPath,
    ...(request.sandboxToolchain === undefined
      ? []
      : [
          request.sandboxToolchain.lddPath,
          ...request.sandboxToolchain.commands.flatMap((command) => [
            command.target,
            command.hostPath,
          ]),
        ]),
  ];

  let sandboxResult: SandboxHostPreflightResult;
  let sandboxReceipt: ReturnType<typeof SandboxPreflightReceiptV1Schema.parse>;
  try {
    sandboxResult = await dependencies.preflightSandbox(request.sandboxHost);
    sandboxReceipt = SandboxPreflightReceiptV1Schema.parse(
      sandboxResult.receipt,
    );
  } catch (error) {
    throw normalizeError(
      error,
      "sandbox_preflight_failed",
      earlySensitiveValues,
    );
  }
  if (sandboxResult.kind === "unsupported") {
    if (sandboxReceipt.status !== "unsupported") {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox preflight returned an inconsistent unsupported receipt",
      );
    }
    const sanitizedReceipt = SandboxPreflightReceiptV1Schema.parse({
      ...sandboxReceipt,
      blockers: sandboxReceipt.blockers.map((blocker) => ({
        ...blocker,
        message:
          sanitizeM1Diagnostic(blocker.message, earlySensitiveValues) ||
          "sandbox preflight blocker",
      })),
    });
    if (sanitizedReceipt.status !== "unsupported") {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox preflight receipt changed status while being sanitized",
      );
    }
    const message = sanitizedReceipt.blockers
      .map((blocker) => blocker.message)
      .join("; ");
    throw new M1Error(
      "sandbox_preflight_failed",
      message || "sandbox preflight is unsupported",
      sanitizedReceipt,
    );
  }
  if (sandboxReceipt.status !== "supported") {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox preflight returned an inconsistent supported receipt",
    );
  }
  const sandboxCapability = SandboxHostCapabilityV1Schema.parse(
    sandboxResult.capability,
  );
  const computedCapabilitySha256 = asSha256DigestV1(
    contentHash(sandboxCapability as unknown as JsonValue),
  );
  if (sandboxReceipt.capabilitySha256 !== computedCapabilitySha256) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox preflight capability does not match its receipt",
    );
  }
  const sandbox = {
    ...sandboxResult,
    capability: sandboxCapability,
    receipt: sandboxReceipt,
  };

  let toolchain:
    | {
        readonly capability: SandboxToolchainCapabilityV1;
        readonly binding: SandboxToolchainBindingV1;
      }
    | undefined;
  if (request.sandboxToolchain !== undefined) {
    try {
      toolchain = await dependencies.inspectToolchain(request.sandboxToolchain);
    } catch (error) {
      throw normalizeError(
        error,
        "sandbox_preflight_failed",
        earlySensitiveValues,
      );
    }
  }

  let source: VerifiedGitSubtree;
  try {
    source = await dependencies.preflightSource({
      projectPath: request.projectPath,
      trustedFixtureRoot: request.trustedFixtureRoot,
      sourceRepositoryExclusionRoots: [request.runtimeRoot],
    });
  } catch (error) {
    throw normalizeError(error, "artifact_write_failed", earlySensitiveValues);
  }

  const sensitiveValues = [
    ...earlySensitiveValues,
    source.repositoryRoot,
    source.projectRoot,
  ];
  let layout: TaskDirectoryLayout | undefined;
  let store: M1TaskRecordStore | undefined;
  let broker: TaskSandboxBrokerV1 | undefined;
  try {
    layout = await dependencies.createLayout({
      runtimeRoot: request.runtimeRoot,
      sourceRepositoryRoot: source.repositoryRoot,
      taskId: request.taskId,
    });
    sensitiveValues.push(layout.taskRootDirectory);
    store = dependencies.createStore(request.runtimeRoot);
    await store.create(request.taskId);

    const task = TaskIdentityV1Schema.parse({
      schemaVersion: 1,
      taskId: request.taskId,
      createdAt: dependencies.now(),
    });
    await store.putJsonOnce(request.taskId, "task.json", task, (value) =>
      TaskIdentityV1Schema.parse(value),
    );
    await store.append(
      request.taskId,
      "task-events.jsonl",
      {
        schemaVersion: 1,
        taskId: request.taskId,
        kind: "creating",
        occurredAt: dependencies.now(),
      },
      (value) => M1TaskEventV1Schema.parse(value),
    );
    await store.append(
      request.taskId,
      "sandbox-preflight.jsonl",
      sandbox.receipt,
      (value) => SandboxPreflightReceiptV1Schema.parse(value),
    );
    await store.putJsonOnce(
      request.taskId,
      "sandbox-capability.json",
      sandbox.capability,
      (value) => SandboxHostCapabilityV1Schema.parse(value),
    );
    if (toolchain !== undefined) {
      await store.putJsonOnce(
        request.taskId,
        "sandbox-toolchain.json",
        toolchain.capability,
        (value) => SandboxToolchainCapabilityV1Schema.parse(value),
      );
    }

    const materialized = bindMaterializedWorkspace({
      taskId: request.taskId,
      source,
      layout,
      materialized: await dependencies.materializeWorkspace({
        taskId: request.taskId,
        source,
        layout,
      }),
    });
    await store.putJsonOnce(
      request.taskId,
      "workspace.json",
      materialized.receipt,
      (value) => WorkspaceMaterializationReceiptV1Schema.parse(value),
    );
    const policy = createSandboxPolicyV1(
      sandbox.capability.runtimeIdentity,
      toolchain === undefined
        ? undefined
        : {
            toolchainId: toolchain.capability.toolchainId,
            targets: toolchain.capability.files.map((file) => file.target),
          },
    );
    await store.putJsonOnce(
      request.taskId,
      "sandbox-policy.json",
      policy,
      (value) => SandboxPolicyV1Schema.parse(value),
    );
    await dependencies.assertSandboxBinding(
      sandbox.capability,
      sandbox.binding,
    );
    const taskStore = store;
    const securityEvents = new TaskSecurityEventRecorder(
      request.taskId,
      taskStore,
      sensitiveValues,
    );
    broker = await dependencies.createBroker({
      taskId: request.taskId,
      capability: sandbox.capability,
      hostBinding: sandbox.binding,
      policy,
      ...(toolchain === undefined ? {} : { toolchain }),
      layout,
      securityEvents: (event) => {
        securityEvents.stage(event);
        return Promise.resolve();
      },
    });
    await store.append(
      request.taskId,
      "task-events.jsonl",
      {
        schemaVersion: 1,
        taskId: request.taskId,
        kind: "ready",
        occurredAt: dependencies.now(),
        policyId: policy.policyId,
        baselineSourceHash: materialized.receipt.selectedTreeSha256,
      },
      (value) => M1TaskEventV1Schema.parse(value),
    );

    const environment = Object.freeze({
      task: cloneAndFreeze(task),
      workspace: cloneAndFreeze(materialized.receipt),
      sandboxCapability: cloneAndFreeze(sandbox.capability),
      ...(toolchain === undefined
        ? {}
        : { toolchainCapability: cloneAndFreeze(toolchain.capability) }),
      policy: cloneAndFreeze(policy),
    });
    ENVIRONMENT_STATES.set(environment, {
      layout,
      source,
      materialized,
      binding: sandbox.binding,
      broker,
      store,
      gate: new TaskOperationGate(),
      dependencies,
      sensitiveValues,
      securityEvents,
      recordsDiscarded: false,
      discardPromise: undefined,
    });
    return environment;
  } catch (error) {
    let normalized = normalizeError(
      error,
      "artifact_write_failed",
      sensitiveValues,
    );
    if (layout !== undefined && store !== undefined) {
      try {
        if (broker !== undefined) {
          await cleanupBrokerAfterSetupFailure(broker);
        }
        await dependencies.cleanStagingRegistration(source, layout);
        await removeMutableTaskState(request.taskId, layout);
      } catch (cleanupError) {
        normalized = normalizeError(
          cleanupError,
          "artifact_write_failed",
          sensitiveValues,
        );
      }
      try {
        await recordSetupFailure({
          taskId: request.taskId,
          store,
          now: dependencies.now,
          error: normalized,
        });
      } catch (recordError) {
        throw normalizeError(
          recordError,
          "artifact_write_failed",
          sensitiveValues,
        );
      }
    }
    throw normalized;
  }
}

export function executeAndRecordM1Command(
  environment: M1TaskEnvironment,
  request: SandboxExecutionRequestV1,
  options?: SandboxExecutionOptionsV1,
): Promise<SandboxExecutionResultV1> {
  const state = requireEnvironmentState(environment);
  return state.gate.run(async () => {
    let brokerInvoked = false;
    try {
      const parsedRequest = SandboxExecutionRequestV1Schema.parse(request);
      state.securityEvents.begin(parsedRequest.operationId);
      try {
        brokerInvoked = true;
        const result = await state.broker.execute(parsedRequest, options);
        if (result.kind === "denied") {
          const event = await state.securityEvents.commitDenial(
            result.securityEvent,
          );
          return { kind: "denied", securityEvent: event };
        }
        state.securityEvents.assertNoneStaged();
        if (
          !(result.stdout instanceof Uint8Array) ||
          !(result.stderr instanceof Uint8Array)
        ) {
          throw new M1Error(
            "artifact_write_failed",
            "sandbox execution returned invalid stream bytes",
          );
        }
        const receipt = SandboxExecutionReceiptV1Schema.parse(result.receipt);
        const expectedCapabilitySha256 = asSha256DigestV1(
          contentHash(environment.sandboxCapability as unknown as JsonValue),
        );
        const frozenProfile =
          environment.policy.profiles[parsedRequest.profile];
        const expectedRealizedResources = {
          ...frozenProfile,
          timeoutMs: parsedRequest.timeoutMs ?? frozenProfile.timeoutMs,
        };
        if (
          receipt.taskId !== environment.task.taskId ||
          receipt.operationId !== parsedRequest.operationId ||
          receipt.policyId !== environment.policy.policyId ||
          receipt.sandboxCapabilitySha256 !== expectedCapabilitySha256 ||
          !sameJson(receipt.requested, parsedRequest) ||
          !sameJson(receipt.realizedResources, expectedRealizedResources)
        ) {
          throw new M1Error(
            "artifact_write_failed",
            "sandbox execution receipt is not bound to the frozen Task lineage",
          );
        }
        assertStreamReceiptMatches("stdout", result.stdout, receipt.stdout);
        assertStreamReceiptMatches("stderr", result.stderr, receipt.stderr);
        try {
          await state.store.append(
            environment.task.taskId,
            "sandbox-operations.jsonl",
            {
              schemaVersion: 1,
              taskId: environment.task.taskId,
              recordedAt: state.dependencies.now(),
              receipt,
            },
            (value) => SandboxOperationRecordV1Schema.parse(value),
          );
        } finally {
          if (!cleanupWasProven(receipt.cleanup)) state.gate.close();
        }
        return {
          kind: "executed",
          receipt,
          stdout: Uint8Array.from(result.stdout),
          stderr: Uint8Array.from(result.stderr),
        };
      } finally {
        state.securityEvents.end(parsedRequest.operationId);
      }
    } catch (error) {
      if (brokerInvoked) state.gate.close();
      throw normalizeError(
        error,
        "artifact_write_failed",
        state.sensitiveValues,
      );
    }
  });
}

export function extractAndPersistM1Patch(
  environment: M1TaskEnvironment,
): Promise<ExtractedTaskPatch> {
  const state = requireEnvironmentState(environment);
  return state.gate.run(async () => {
    try {
      const extracted = await state.dependencies.extractPatch({
        taskId: environment.task.taskId,
        workspaceDirectory: state.layout.workspaceDirectory,
        hostBaselineGitDirectory: state.layout.hostBaselineGitDirectory,
        hostBaselineCommit: state.materialized.hostBaselineCommit,
        baselineSourceHash: state.materialized.receipt.selectedTreeSha256,
        ignoredCachePaths:
          state.materialized.fixtureCapability.ignoredCachePaths,
        fixtureCapability: state.materialized.fixtureCapability,
        hostOperationTemporaryDirectory:
          state.layout.hostOperationTemporaryDirectory,
      });
      if (!(extracted.patchBytes instanceof Uint8Array)) {
        throw new M1Error(
          "artifact_write_failed",
          "patch extraction returned invalid bytes",
        );
      }
      const identity = TaskPatchIdentityV1Schema.parse(extracted.identity);
      const patchBytes = Uint8Array.from(extracted.patchBytes);
      if (
        extracted.roundTripVerified !== true ||
        identity.taskId !== environment.task.taskId ||
        identity.baselineSourceHash !==
          state.materialized.receipt.selectedTreeSha256 ||
        identity.byteLength !== patchBytes.byteLength ||
        identity.patchHash !== sha256(patchBytes) ||
        identity.patchId !== `patch:v1:${identity.patchHash}`
      ) {
        throw new M1Error(
          "artifact_write_failed",
          "patch extraction is not bound to the frozen Task baseline and bytes",
        );
      }
      await state.store.putBytesOnce(
        environment.task.taskId,
        "patch.diff",
        patchBytes,
      );
      await state.store.putJsonOnce(
        environment.task.taskId,
        "patch.json",
        identity,
        (value) => TaskPatchIdentityV1Schema.parse(value),
      );
      return cloneAndFreeze({
        identity,
        patchBytes,
        roundTripVerified: true as const,
      });
    } catch (error) {
      throw normalizeError(
        error,
        "artifact_write_failed",
        state.sensitiveValues,
      );
    }
  });
}

export function exportM1Patch(
  environment: M1TaskEnvironment,
  extracted: ExtractedTaskPatch,
  request: { readonly hostCwd: string; readonly outputPath: string },
): Promise<PatchExportReceiptV1> {
  const state = requireEnvironmentState(environment);
  return state.gate.run(async () => {
    let outputPath: string;
    let suppliedIdentity: ReturnType<typeof TaskPatchIdentityV1Schema.parse>;
    try {
      outputPath = RelativeExportPathV1Schema.parse(request.outputPath);
      suppliedIdentity = TaskPatchIdentityV1Schema.parse(extracted.identity);
      if (!(extracted.patchBytes instanceof Uint8Array)) {
        throw new M1Error(
          "artifact_write_failed",
          "exported patch bytes are invalid",
        );
      }
      const [storedIdentity, storedBytes] = await Promise.all([
        state.store.readJson(environment.task.taskId, "patch.json", (value) =>
          TaskPatchIdentityV1Schema.parse(value),
        ),
        state.store.readBytes(environment.task.taskId, "patch.diff"),
      ]);
      if (
        extracted.roundTripVerified !== true ||
        suppliedIdentity.taskId !== environment.task.taskId ||
        suppliedIdentity.baselineSourceHash !==
          state.materialized.receipt.selectedTreeSha256 ||
        suppliedIdentity.byteLength !== extracted.patchBytes.byteLength ||
        suppliedIdentity.patchHash !== sha256(extracted.patchBytes) ||
        !sameJson(storedIdentity, suppliedIdentity) ||
        !Buffer.from(storedBytes).equals(Buffer.from(extracted.patchBytes))
      ) {
        throw new M1Error(
          "artifact_write_failed",
          "exported patch must match the immutable Task patch records",
        );
      }
      await state.store.append(
        environment.task.taskId,
        "exports.jsonl",
        {
          schemaVersion: 1,
          taskId: environment.task.taskId,
          kind: "requested",
          patchId: suppliedIdentity.patchId,
          patchSha256: suppliedIdentity.patchHash,
          outputPath,
          occurredAt: state.dependencies.now(),
        },
        (value) => PatchExportEventV1Schema.parse(value),
      );
    } catch (error) {
      throw normalizeError(error, "artifact_write_failed", [
        ...state.sensitiveValues,
        request.hostCwd,
      ]);
    }

    const validateReceipt = (value: unknown): PatchExportReceiptV1 => {
      const receipt = PatchExportReceiptV1Schema.parse(value);
      if (
        receipt.taskId !== environment.task.taskId ||
        receipt.patchId !== suppliedIdentity.patchId ||
        receipt.patchSha256 !== suppliedIdentity.patchHash ||
        receipt.outputPath !== outputPath ||
        receipt.byteLength !== suppliedIdentity.byteLength
      ) {
        throw new M1Error(
          "artifact_write_failed",
          "patch export receipt is not bound to the requested Task patch",
        );
      }
      return receipt;
    };

    try {
      let recordedReceipt: PatchExportReceiptV1 | undefined;
      const receipt = await state.dependencies.exportPatch({
        taskId: environment.task.taskId,
        hostCwd: request.hostCwd,
        outputPath,
        extracted,
        now: state.dependencies.now,
        onPublished: async (publishedReceipt) => {
          const validated = validateReceipt(publishedReceipt);
          try {
            await state.store.append(
              environment.task.taskId,
              "exports.jsonl",
              {
                schemaVersion: 1,
                taskId: environment.task.taskId,
                kind: "completed",
                receipt: validated,
                occurredAt: state.dependencies.now(),
              },
              (value) => PatchExportEventV1Schema.parse(value),
            );
          } catch {
            throw new M1Error(
              "artifact_write_failed",
              "patch was published but export completion could not be recorded",
            );
          }
          recordedReceipt = validated;
        },
      });
      const validatedReceipt = validateReceipt(receipt);
      if (
        recordedReceipt === undefined ||
        !sameJson(recordedReceipt, validatedReceipt)
      ) {
        throw new M1PatchExportError(
          "artifact_write_failed",
          "patch export adapter bypassed the required publication record",
          outputPath,
          false,
        );
      }
      return validatedReceipt;
    } catch (error) {
      const normalized = normalizeError(error, "artifact_write_failed", [
        ...state.sensitiveValues,
        request.hostCwd,
      ]);
      const exportError =
        normalized instanceof M1PatchExportError
          ? normalized
          : new M1PatchExportError(
              normalized.code === "patch_export_failed"
                ? "patch_export_failed"
                : "artifact_write_failed",
              normalized.message,
              outputPath,
              false,
            );
      try {
        await state.store.append(
          environment.task.taskId,
          "exports.jsonl",
          {
            schemaVersion: 1,
            taskId: environment.task.taskId,
            kind: "failed",
            patchId: suppliedIdentity.patchId,
            patchSha256: suppliedIdentity.patchHash,
            outputPath,
            occurredAt: state.dependencies.now(),
            code:
              exportError.code === "patch_export_failed"
                ? "patch_export_failed"
                : "artifact_write_failed",
            message: exportError.message,
            targetPublished: exportError.targetPublished,
          },
          (value) => PatchExportEventV1Schema.parse(value),
        );
      } catch {
        throw new M1PatchExportError(
          "artifact_write_failed",
          "patch export outcome could not be recorded",
          outputPath,
          exportError.targetPublished,
        );
      }
      throw exportError;
    }
  });
}

export function discardM1Task(
  environment: M1TaskEnvironment,
): Promise<SandboxCleanupReceiptV1> {
  const state = requireEnvironmentState(environment);
  if (state.discardPromise !== undefined) return state.discardPromise;
  state.gate.close();
  const attempt = (async () => {
    try {
      let cleanup: SandboxCleanupReceiptV1;
      try {
        cleanup = SandboxCleanupReceiptV1Schema.parse(
          await state.broker.cleanup(),
        );
      } finally {
        await state.gate.drain();
      }
      if (!cleanupWasProven(cleanup)) {
        throw new M1Error(
          "artifact_write_failed",
          "Task sandbox cleanup could not be proven; Task records were retained",
        );
      }
      if (!state.recordsDiscarded) {
        await assertCompleteTaskRootIsOwned(
          environment.task.taskId,
          state.layout,
        );
        await state.store.discard(environment.task.taskId);
        state.recordsDiscarded = true;
      }
      await removeCompleteTaskRoot(environment.task.taskId, state.layout);
      return cleanup;
    } catch (error) {
      throw normalizeError(
        error,
        "artifact_write_failed",
        state.sensitiveValues,
      );
    }
  })();
  state.discardPromise = attempt;
  void attempt.catch(() => {
    if (state.discardPromise === attempt) state.discardPromise = undefined;
  });
  return attempt;
}
