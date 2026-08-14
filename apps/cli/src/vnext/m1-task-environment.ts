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
  asWorkspaceId,
  TaskIdentityV1Schema,
  TaskPatchIdentityV1Schema,
  taskNamespaceDigestV1,
  type JsonValue,
  type Sha256DigestV1,
  type TaskId,
  type TaskIdentityV1,
  type WorkspaceId,
} from "@chronorift/domain";
import {
  VNextRuntimeStore,
  VNextTaskStore,
  contentHash,
  type RuntimeEventEnvelopeV1,
  type RuntimeExecutionSealV1,
  type VNextRuntimeResourceSummaryV1,
  type VNextRuntimeResourceKind,
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
  TaskGodotProjectCapabilityV1Schema,
  TaskFixtureCapabilityV1Schema,
  SandboxExecutionReceiptV1Schema,
  SandboxExecutionRequestV1Schema,
  SandboxOperationRecordV1Schema,
  SandboxPolicySchema,
  SandboxPreflightReceiptV1Schema,
  SandboxToolchainCapabilityV1Schema,
  SecurityEventV1Schema,
  WorkspaceMaterializationReceiptSchema,
  WorkspaceMaterializationReceiptV1Schema,
  WorkspaceMaterializationReceiptV2Schema,
  type PatchExportReceiptV1,
  type SandboxCleanupReceiptV1,
  type SandboxExecutionRequestV1,
  type SandboxHostCapabilityV1,
  type SandboxPolicy,
  type SandboxToolchainCapabilityV1,
  type SecurityEventV1,
  type TaskGodotProjectCapabilityV1,
  type TaskFixtureCapabilityV1,
  type WorkspaceMaterializationReceipt,
  type WorkspaceMaterializationReceiptV1,
  type WorkspaceMaterializationReceiptV2,
} from "./contracts.js";
import { M1Error, M1PatchExportError, sanitizeM1Diagnostic } from "./errors.js";
import { NodeHostGitPort } from "./host-git.js";
import {
  exportTaskPatch,
  extractTaskPatch,
  type ExtractedTaskPatch,
} from "./patch-handoff.js";
import {
  createDuplexBwrapCgroupTaskSandbox,
  SandboxBrokerSetupCleanupError,
  type DuplexTaskSandboxBrokerV1,
  type SandboxDuplexExecutionOptionsV1,
  type SandboxDuplexOpenResultV1,
  type SandboxExecutionOptionsV1,
  type SandboxExecutionResultV1,
} from "./sandbox-broker.js";
import {
  assertSandboxHostBindingMatches,
  assertSandboxTaskStorageLayoutMatches,
  preflightSandboxHost,
  type SandboxHostBinding,
  type SandboxHostPreflightRequest,
  type SandboxHostPreflightResult,
} from "./sandbox-preflight.js";
import {
  createSandboxPolicyV1,
  createSandboxPolicyV2,
} from "./sandbox-policy.js";
import {
  inspectSandboxToolchain,
  type SandboxToolchainBindingV1,
  type SandboxToolchainCommandBindingV1,
} from "./sandbox-toolchain.js";
import {
  DEFAULT_MANAGED_GODOT_HOST_DEPENDENCY_PATHS,
  preflightManagedGodotRuntimeV1,
  type ManagedGodotRuntimePreflightInputV1,
  type ManagedGodotRuntimePreflightResultV1,
} from "./managed-godot-runtime-preflight.js";
import {
  ManagedGodotRuntimeCapabilityV1Schema,
  type ManagedGodotRuntimeCapabilityV1,
} from "./managed-godot-runtime.js";
import {
  ManagedGodotLifecycleRuntimeCapabilityV1Schema,
  type ManagedGodotLifecycleRuntimeCapabilityV1,
} from "./managed-godot-lifecycle-runtime.js";
import {
  ManagedGodotSemanticRuntimeCapabilityV1Schema,
  type ManagedGodotSemanticRuntimeCapabilityV1,
} from "./managed-godot-semantic-runtime.js";
import {
  DEFAULT_MANAGED_GODOT_LIFECYCLE_HOST_DEPENDENCY_PATHS,
  preflightManagedGodotLifecycleRuntimeV1,
  type ManagedGodotLifecycleRuntimePreflightInputV1,
  type ManagedGodotLifecycleRuntimePreflightResultV1,
} from "./managed-godot-lifecycle-runtime-preflight.js";
import {
  DEFAULT_MANAGED_GODOT_SEMANTIC_HOST_DEPENDENCY_PATHS,
  preflightManagedGodotSemanticRuntimeV1,
  type ManagedGodotSemanticRuntimePreflightInputV1,
  type ManagedGodotSemanticRuntimePreflightResultV1,
} from "./managed-godot-semantic-runtime-preflight.js";
import { GodotSidecarPortV1 } from "./godot-sidecar-port.js";
import { GodotLifecycleSidecarPortV1 } from "./godot-lifecycle-sidecar-port.js";
import { GodotSemanticSidecarPortV1 } from "./godot-semantic-sidecar-port.js";
import {
  parseGodotProjectDescriptorSnapshotV1,
  type GodotProjectDescriptorSnapshotV1,
  type HostGodotProjectDescriptorSnapshotV1,
} from "./godot-project-descriptor.js";
import {
  GodotSemanticAdapterProfileSnapshotV1Schema,
  parseGodotSemanticAdapterProfileSnapshotV1,
  type GodotSemanticAdapterProfileSnapshotV1,
  type HostGodotSemanticAdapterProfileSnapshotV1,
} from "./semantic-adapter-profile.js";
import {
  preflightCleanGitSubtree,
  preflightCleanExternalGodotProject,
  type CleanGitSubtreePreflightRequest,
  type CleanExternalGodotProjectPreflightRequest,
  type VerifiedExternalGodotProject,
  type VerifiedGitSubtree,
  type VerifiedTaskSource,
} from "./source-preflight.js";
import {
  createTaskDirectoryLayout,
  openTaskDirectoryLayout,
  type TaskDirectoryLayout,
} from "./task-paths.js";
import {
  materializePrivateTaskWorkspace,
  type MaterializedExternalGodotProjectWorkspace,
  type MaterializedTaskWorkspace,
  type MaterializeTaskWorkspaceRequest,
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

interface M1TaskRuntimeRecordStore {
  create(taskId: TaskId): Promise<void>;
  open(taskId: TaskId): Promise<void>;
  putResourceOnce<T>(
    taskId: TaskId,
    kind: VNextRuntimeResourceKind,
    resourceId: string,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<void>;
  readResource<T>(
    taskId: TaskId,
    kind: VNextRuntimeResourceKind,
    resourceId: string,
    parse: (input: unknown) => T,
  ): Promise<T>;
  appendExecutionEvent<T>(
    taskId: TaskId,
    executionId: string,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<RuntimeEventEnvelopeV1>;
  readExecutionEvents<T>(
    taskId: TaskId,
    executionId: string,
    parse: (input: unknown) => T,
  ): Promise<readonly T[]>;
  readExecutionSeal(
    taskId: TaskId,
    executionId: string,
  ): Promise<RuntimeExecutionSealV1>;
  sealExecution(
    taskId: TaskId,
    executionId: string,
  ): Promise<RuntimeExecutionSealV1>;
  summarize(taskId: TaskId): Promise<VNextRuntimeResourceSummaryV1>;
  discard(taskId: TaskId): Promise<void>;
}

export interface M1TaskRuntimeArtifactStore {
  putResourceOnce<T>(
    kind: VNextRuntimeResourceKind,
    resourceId: string,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<void>;
  readResource<T>(
    kind: VNextRuntimeResourceKind,
    resourceId: string,
    parse: (input: unknown) => T,
  ): Promise<T>;
  appendExecutionEvent<T>(
    executionId: string,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<RuntimeEventEnvelopeV1>;
  readExecutionEvents<T>(
    executionId: string,
    parse: (input: unknown) => T,
  ): Promise<readonly T[]>;
  readExecutionSeal(executionId: string): Promise<RuntimeExecutionSealV1>;
  sealExecution(executionId: string): Promise<RuntimeExecutionSealV1>;
  summarize(): Promise<VNextRuntimeResourceSummaryV1>;
}

interface M1TaskEnvironmentCommon {
  readonly task: TaskIdentityV1;
  readonly sandboxCapability: SandboxHostCapabilityV1;
  readonly toolchainCapability?: SandboxToolchainCapabilityV1 | undefined;
  readonly policy: SandboxPolicy;
  readonly runtimeStore: M1TaskRuntimeArtifactStore;
}

export interface M1FixtureTaskEnvironment extends M1TaskEnvironmentCommon {
  readonly sourceKind?: undefined;
  readonly workspace: WorkspaceMaterializationReceiptV1;
  readonly projectCapability?: undefined;
  readonly managedRuntimeCapability?:
    ManagedGodotRuntimeCapabilityV1 | undefined;
  readonly managedLifecycleRuntimeCapability?: undefined;
  readonly managedSemanticRuntimeCapability?: undefined;
  readonly semanticAdapterProfile?: undefined;
}

export interface M1ExternalGodotTaskEnvironment extends M1TaskEnvironmentCommon {
  readonly sourceKind: "godot-external-lifecycle-v1";
  readonly workspace: WorkspaceMaterializationReceiptV2;
  readonly projectCapability: TaskGodotProjectCapabilityV1;
  readonly managedRuntimeCapability?: undefined;
  readonly managedLifecycleRuntimeCapability: ManagedGodotLifecycleRuntimeCapabilityV1;
  readonly managedSemanticRuntimeCapability?: undefined;
  readonly semanticAdapterProfile?: undefined;
}

export interface M1ExternalGodotSemanticTaskEnvironment extends M1TaskEnvironmentCommon {
  readonly sourceKind: "godot-external-semantic-v1";
  readonly workspace: WorkspaceMaterializationReceiptV2;
  readonly projectCapability: TaskGodotProjectCapabilityV1;
  readonly managedRuntimeCapability?: undefined;
  readonly managedLifecycleRuntimeCapability?: undefined;
  readonly managedSemanticRuntimeCapability: ManagedGodotSemanticRuntimeCapabilityV1;
  readonly semanticAdapterProfile: GodotSemanticAdapterProfileSnapshotV1;
}

export type M1TaskEnvironment =
  | M1FixtureTaskEnvironment
  | M1ExternalGodotTaskEnvironment
  | M1ExternalGodotSemanticTaskEnvironment;

export const isM1ExternalGodotTaskEnvironment = (
  environment: M1TaskEnvironment,
): environment is M1ExternalGodotTaskEnvironment =>
  environment.sourceKind === "godot-external-lifecycle-v1";

export const isM1ExternalGodotSemanticTaskEnvironment = (
  environment: M1TaskEnvironment,
): environment is M1ExternalGodotSemanticTaskEnvironment =>
  environment.sourceKind === "godot-external-semantic-v1";

export interface PrepareM1TaskEnvironmentRequest {
  readonly taskId: TaskId;
  readonly projectPath: string;
  readonly trustedFixtureRoot?: string | undefined;
  readonly externalProjectDescriptor?:
    HostGodotProjectDescriptorSnapshotV1 | undefined;
  readonly runtimeRoot: string;
  readonly sandboxHost: SandboxHostPreflightRequest;
  readonly sandboxToolchain?:
    | {
        readonly lddPath: string;
        readonly commands: readonly SandboxToolchainCommandBindingV1[];
      }
    | undefined;
  readonly managedGodotRuntime?:
    ManagedGodotRuntimePreflightInputV1 | undefined;
  readonly managedGodotLifecycleRuntime?:
    ManagedGodotLifecycleRuntimePreflightInputV1 | undefined;
  readonly managedGodotSemanticRuntime?:
    ManagedGodotSemanticRuntimePreflightInputV1 | undefined;
  readonly semanticAdapterProfile?:
    HostGodotSemanticAdapterProfileSnapshotV1 | undefined;
}

export interface ResumeM1TaskEnvironmentRequest {
  readonly taskId: TaskId;
  readonly runtimeRoot: string;
  readonly sandboxHost: SandboxHostPreflightRequest;
  readonly sandboxToolchain?: PrepareM1TaskEnvironmentRequest["sandboxToolchain"];
  readonly managedGodotRuntime?: PrepareM1TaskEnvironmentRequest["managedGodotRuntime"];
  readonly managedGodotLifecycleRuntime?: PrepareM1TaskEnvironmentRequest["managedGodotLifecycleRuntime"];
  readonly managedGodotSemanticRuntime?: PrepareM1TaskEnvironmentRequest["managedGodotSemanticRuntime"];
}

interface M1TaskEnvironmentDependencies {
  readonly now: () => string;
  readonly preflightSandbox: (
    request: SandboxHostPreflightRequest,
  ) => Promise<SandboxHostPreflightResult>;
  readonly preflightSource: (
    request: CleanGitSubtreePreflightRequest,
  ) => Promise<VerifiedGitSubtree>;
  readonly preflightExternalSource: (
    request: CleanExternalGodotProjectPreflightRequest,
  ) => Promise<VerifiedExternalGodotProject>;
  readonly createLayout: typeof createTaskDirectoryLayout;
  readonly openLayout: typeof openTaskDirectoryLayout;
  readonly createStore: (runtimeRoot: string) => M1TaskRecordStore;
  readonly createRuntimeStore: (
    runtimeRoot: string,
  ) => M1TaskRuntimeRecordStore;
  readonly materializeWorkspace: (
    request: MaterializeTaskWorkspaceRequest,
  ) => Promise<MaterializedTaskWorkspaceCandidate>;
  readonly assertSandboxBinding: typeof assertSandboxHostBindingMatches;
  readonly assertTaskStorageLayout: typeof assertSandboxTaskStorageLayoutMatches;
  readonly inspectToolchain: typeof inspectSandboxToolchain;
  readonly preflightManagedRuntime: typeof preflightManagedGodotRuntimeV1;
  readonly preflightManagedLifecycleRuntime: typeof preflightManagedGodotLifecycleRuntimeV1;
  readonly preflightManagedSemanticRuntime: typeof preflightManagedGodotSemanticRuntimeV1;
  readonly createBroker: typeof createDuplexBwrapCgroupTaskSandbox;
  readonly extractPatch: typeof extractTaskPatch;
  readonly exportPatch: typeof exportTaskPatch;
  readonly cleanStagingRegistration: (
    source: VerifiedTaskSource,
    layout: TaskDirectoryLayout,
  ) => Promise<void>;
}

interface MaterializedTaskWorkspaceCandidate {
  readonly sourceKind?: "godot-external-lifecycle-v1" | undefined;
  readonly workspaceDirectory: string;
  readonly hostBaselineGitDirectory: string;
  readonly agentBaselineCommit: string;
  readonly hostBaselineCommit: string;
  readonly receipt: WorkspaceMaterializationReceipt;
  readonly fixtureCapability?: TaskFixtureCapabilityV1 | undefined;
  readonly projectCapability?: TaskGodotProjectCapabilityV1 | undefined;
  readonly descriptorSnapshot?: GodotProjectDescriptorSnapshotV1 | undefined;
}

interface M1TaskEnvironmentState {
  readonly layout: TaskDirectoryLayout;
  readonly materialized: MaterializedTaskWorkspace;
  readonly binding: SandboxHostBinding;
  readonly broker: DuplexTaskSandboxBrokerV1;
  readonly managedRuntime: ManagedGodotRuntimePreflightResultV1 | undefined;
  readonly managedLifecycleRuntime:
    ManagedGodotLifecycleRuntimePreflightResultV1 | undefined;
  readonly managedSemanticRuntime:
    ManagedGodotSemanticRuntimePreflightResultV1 | undefined;
  readonly activeDuplexCompletions: Set<Promise<unknown>>;
  readonly store: M1TaskRecordStore;
  readonly runtimeStore: M1TaskRuntimeRecordStore;
  readonly gate: TaskOperationGate;
  readonly dependencies: M1TaskEnvironmentDependencies;
  readonly sensitiveValues: readonly string[];
  readonly securityEvents: TaskSecurityEventRecorder;
  recordsDiscarded: boolean;
  runtimeRecordsDiscarded: boolean;
  cleanupPromise: Promise<SandboxCleanupReceiptV1> | undefined;
  suspendPromise: Promise<SandboxCleanupReceiptV1> | undefined;
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
  "pi-sessions",
  "host-baseline.git",
  "host-tmp",
] as const;
const DISCARDABLE_TASK_CHILDREN = new Set<string>(MUTABLE_TASK_CHILDREN);
const ARTIFACT_TASK_CHILDREN = ["records", "runtime-records"] as const;
const MANAGED_RUNTIME_SLOT = "managed-runtime.json" as VNextTaskJsonSlot;
const MANAGED_LIFECYCLE_RUNTIME_SLOT =
  "managed-lifecycle-runtime.json" as VNextTaskJsonSlot;
const MANAGED_SEMANTIC_RUNTIME_SLOT =
  "managed-semantic-runtime.json" as VNextTaskJsonSlot;
const SEMANTIC_ADAPTER_PROFILE_SLOT =
  "semantic-adapter-profile.json" as VNextTaskJsonSlot;

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
  source: VerifiedTaskSource,
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
  preflightExternalSource: (request) =>
    preflightCleanExternalGodotProject(request),
  createLayout: createTaskDirectoryLayout,
  openLayout: openTaskDirectoryLayout,
  createStore: (runtimeRoot) => new VNextTaskStore(runtimeRoot),
  createRuntimeStore: (runtimeRoot) => new VNextRuntimeStore(runtimeRoot),
  materializeWorkspace: (request) => materializePrivateTaskWorkspace(request),
  assertSandboxBinding: assertSandboxHostBindingMatches,
  assertTaskStorageLayout: assertSandboxTaskStorageLayoutMatches,
  inspectToolchain: (request) => inspectSandboxToolchain(request),
  preflightManagedRuntime: (request, dependencies) =>
    preflightManagedGodotRuntimeV1(request, dependencies),
  preflightManagedLifecycleRuntime: (request, dependencies) =>
    preflightManagedGodotLifecycleRuntimeV1(request, dependencies),
  preflightManagedSemanticRuntime: (request, dependencies) =>
    preflightManagedGodotSemanticRuntimeV1(request, dependencies),
  createBroker: (request) => createDuplexBwrapCgroupTaskSandbox(request),
  extractPatch: (request) => extractTaskPatch(request),
  exportPatch: (request) => exportTaskPatch(request),
  cleanStagingRegistration: defaultCleanStagingRegistration,
};

const bindTaskRuntimeStore = (
  taskId: TaskId,
  store: M1TaskRuntimeRecordStore,
): M1TaskRuntimeArtifactStore =>
  Object.freeze({
    putResourceOnce: <T>(
      kind: VNextRuntimeResourceKind,
      resourceId: string,
      value: T,
      parse: (input: unknown) => T,
    ): Promise<void> =>
      store.putResourceOnce(taskId, kind, resourceId, value, parse),
    readResource: <T>(
      kind: VNextRuntimeResourceKind,
      resourceId: string,
      parse: (input: unknown) => T,
    ): Promise<T> => store.readResource(taskId, kind, resourceId, parse),
    appendExecutionEvent: <T>(
      executionId: string,
      value: T,
      parse: (input: unknown) => T,
    ): Promise<RuntimeEventEnvelopeV1> =>
      store.appendExecutionEvent(taskId, executionId, value, parse),
    readExecutionEvents: <T>(
      executionId: string,
      parse: (input: unknown) => T,
    ): Promise<readonly T[]> =>
      store.readExecutionEvents(taskId, executionId, parse),
    readExecutionSeal: (executionId: string): Promise<RuntimeExecutionSealV1> =>
      store.readExecutionSeal(taskId, executionId),
    sealExecution: (executionId: string): Promise<RuntimeExecutionSealV1> =>
      store.sealExecution(taskId, executionId),
    summarize: (): Promise<VNextRuntimeResourceSummaryV1> =>
      store.summarize(taskId),
  });

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
      (entry) =>
        !ARTIFACT_TASK_CHILDREN.includes(
          entry as (typeof ARTIFACT_TASK_CHILDREN)[number],
        ) && !DISCARDABLE_TASK_CHILDREN.has(entry),
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
    if (
      JSON.stringify(remaining.sort()) !==
      JSON.stringify([...ARTIFACT_TASK_CHILDREN].sort())
    ) {
      throw new M1Error(
        "artifact_write_failed",
        "mutable Task cleanup did not leave exactly the owned artifact directories",
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
  state: {
    readonly recordsDiscarded: boolean;
    readonly runtimeRecordsDiscarded: boolean;
  },
): Promise<void> =>
  withPinnedTaskRoot(taskId, layout, async (taskRoot) => {
    const entries = await readdir(`/proc/self/fd/${String(taskRoot.fd)}`);
    const expectedArtifacts = [
      ...(state.recordsDiscarded ? [] : ["records"]),
      ...(state.runtimeRecordsDiscarded ? [] : ["runtime-records"]),
    ];
    if (
      expectedArtifacts.some((entry) => !entries.includes(entry)) ||
      entries.some((entry) => {
        if (expectedArtifacts.includes(entry)) return false;
        return !DISCARDABLE_TASK_CHILDREN.has(entry);
      })
    ) {
      throw new M1Error(
        "path_denied",
        "Task root is missing an owned artifact directory or contains an unowned entry",
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
  receipt.scopeRemoved &&
  receipt.storageReconciled !== false;

const cleanupBrokerAfterSetupFailure = async (
  broker: DuplexTaskSandboxBrokerV1,
  primaryError: unknown,
): Promise<void> => {
  let lastCleanupError: unknown;
  const cleanup = async (): Promise<void> => {
    const receipt = SandboxCleanupReceiptV1Schema.parse(await broker.cleanup());
    if (!cleanupWasProven(receipt)) {
      throw new M1Error(
        "artifact_write_failed",
        "sandbox cleanup could not be proven after setup failure",
      );
    }
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await cleanup();
      return;
    } catch (error) {
      lastCleanupError = error;
      // A retryable broker forgets a rejected or unproven cleanup attempt.
    }
  }
  throw new SandboxBrokerSetupCleanupError(
    primaryError,
    lastCleanupError,
    cleanup,
  );
};

const retryRetainedBrokerSetupCleanup = async (
  error: SandboxBrokerSetupCleanupError,
): Promise<boolean> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await error.retryCleanup();
      return true;
    } catch {
      // The error retains its retryable owner for the next bounded attempt.
    }
  }
  return false;
};

const resolveBrokerSetupCleanupOwnership = async (
  error: unknown,
): Promise<{
  readonly primaryError: unknown;
  readonly retainedOwner: SandboxBrokerSetupCleanupError | undefined;
}> => {
  if (!(error instanceof SandboxBrokerSetupCleanupError)) {
    return { primaryError: error, retainedOwner: undefined };
  }
  if (await retryRetainedBrokerSetupCleanup(error)) {
    return { primaryError: error.primaryError, retainedOwner: undefined };
  }
  return { primaryError: error.primaryError, retainedOwner: error };
};

const retainedSetupCleanupError = (
  owner: SandboxBrokerSetupCleanupError,
  additionalError?: unknown,
): M1Error =>
  new M1Error(
    "artifact_write_failed",
    "sandbox setup cleanup remains unproven; Task state was retained",
    additionalError === undefined
      ? owner
      : new AggregateError(
          [owner, additionalError],
          "sandbox setup cleanup and failure recording both failed",
        ),
  );

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const sameJson = (left: unknown, right: unknown): boolean =>
  contentHash(left as JsonValue) === contentHash(right as JsonValue);

const LEGACY_BWRAP_FEATURES = [
  "block-fd",
  "json-status-fd",
  "bind-fd",
  "ro-bind-fd",
] as const;
const CURRENT_BWRAP_FEATURES = [
  ...LEGACY_BWRAP_FEATURES,
  "remount-ro",
] as const;

const sameStableSandboxCapability = (
  left: SandboxHostCapabilityV1,
  right: SandboxHostCapabilityV1,
  policySchemaVersion: SandboxPolicy["schemaVersion"],
): boolean => {
  const normalizedLeft =
    policySchemaVersion === 1 &&
    sameJson(left.bwrap.features, LEGACY_BWRAP_FEATURES) &&
    sameJson(right.bwrap.features, CURRENT_BWRAP_FEATURES)
      ? {
          ...left,
          bwrap: { ...left.bwrap, features: CURRENT_BWRAP_FEATURES },
        }
      : left;
  // A fresh preflight must prove both fields, but neither is a stable Host
  // security identity: the probe contains observed usage and a delegation is
  // intentionally replaceable across process/container lifetimes.
  const {
    activeProbeSha256: _leftProbe,
    delegatedCgroupRootIdentity: _leftDelegation,
    ...leftStable
  } = normalizedLeft;
  const {
    activeProbeSha256: _rightProbe,
    delegatedCgroupRootIdentity: _rightDelegation,
    ...rightStable
  } = right;
  void _leftProbe;
  void _leftDelegation;
  void _rightProbe;
  void _rightDelegation;
  return sameJson(leftStable, rightStable);
};

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

const isExternalVerifiedSource = (
  source: VerifiedTaskSource,
): source is VerifiedExternalGodotProject => "projectCapability" in source;

const isExternalMaterializedWorkspace = (
  materialized: MaterializedTaskWorkspaceCandidate,
): materialized is MaterializedExternalGodotProjectWorkspace =>
  materialized.sourceKind === "godot-external-lifecycle-v1" &&
  materialized.projectCapability !== undefined &&
  materialized.descriptorSnapshot !== undefined;

const bindMaterializedWorkspace = (input: {
  readonly taskId: TaskId;
  readonly source: VerifiedTaskSource;
  readonly layout: TaskDirectoryLayout;
  readonly materialized: MaterializedTaskWorkspaceCandidate;
}): MaterializedTaskWorkspace => {
  const commonMismatch =
    input.materialized.workspaceDirectory !== input.layout.workspaceDirectory ||
    input.materialized.hostBaselineGitDirectory !==
      input.layout.hostBaselineGitDirectory ||
    input.materialized.receipt.taskId !== input.taskId ||
    input.materialized.receipt.repositoryIdentity !==
      input.source.repositoryIdentity ||
    input.materialized.receipt.sourceRevision !== input.source.headCommit ||
    input.materialized.receipt.projectPrefix !== input.source.projectPrefix ||
    input.materialized.receipt.selectedTreeSha256 !==
      input.source.selectedTreeSha256 ||
    input.materialized.receipt.agentBaselineCommit !==
      input.materialized.agentBaselineCommit ||
    input.materialized.receipt.hostBaselineCommit !==
      input.materialized.hostBaselineCommit;
  if (commonMismatch) {
    throw new M1Error(
      "artifact_write_failed",
      "workspace materialization is not bound to the verified Task source and private layout",
    );
  }

  if (isExternalVerifiedSource(input.source)) {
    if (!isExternalMaterializedWorkspace(input.materialized)) {
      throw new M1Error(
        "artifact_write_failed",
        "external project materialization returned a fixture workspace",
      );
    }
    const receipt = WorkspaceMaterializationReceiptV2Schema.parse(
      input.materialized.receipt,
    );
    const projectCapability = TaskGodotProjectCapabilityV1Schema.parse(
      input.materialized.projectCapability,
    );
    const descriptorSnapshot = parseGodotProjectDescriptorSnapshotV1(
      input.materialized.descriptorSnapshot.bytes,
    );
    if (
      receipt.projectCapabilitySha256 !==
        input.source.projectCapability.capabilitySha256 ||
      receipt.descriptorSha256 !==
        input.source.descriptorSnapshot.descriptorSha256 ||
      !sameJson(
        receipt.excludedCachePaths,
        input.source.projectCapability.ignoredCachePaths,
      ) ||
      !sameJson(projectCapability, input.source.projectCapability) ||
      descriptorSnapshot.descriptorSha256 !== receipt.descriptorSha256 ||
      !Buffer.from(descriptorSnapshot.bytes).equals(
        Buffer.from(input.source.descriptorSnapshot.bytes),
      )
    ) {
      throw new M1Error(
        "artifact_write_failed",
        "external project workspace is detached from its descriptor and source capability",
      );
    }
    return {
      sourceKind: "godot-external-lifecycle-v1",
      workspaceDirectory: input.layout.workspaceDirectory,
      hostBaselineGitDirectory: input.layout.hostBaselineGitDirectory,
      agentBaselineCommit: receipt.agentBaselineCommit,
      hostBaselineCommit: receipt.hostBaselineCommit,
      receipt,
      projectCapability,
      descriptorSnapshot,
    };
  }

  if (isExternalMaterializedWorkspace(input.materialized)) {
    throw new M1Error(
      "artifact_write_failed",
      "fixture materialization returned an external project workspace",
    );
  }
  const receipt = WorkspaceMaterializationReceiptV1Schema.parse(
    input.materialized.receipt,
  );
  const fixtureCapability = TaskFixtureCapabilityV1Schema.parse(
    input.materialized.fixtureCapability,
  );
  if (
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

const runtimeSensitiveValues = (request: {
  readonly runtimeRoot: string;
  readonly sandboxHost: SandboxHostPreflightRequest;
  readonly sandboxToolchain?: PrepareM1TaskEnvironmentRequest["sandboxToolchain"];
  readonly managedGodotRuntime?: PrepareM1TaskEnvironmentRequest["managedGodotRuntime"];
  readonly managedGodotLifecycleRuntime?: PrepareM1TaskEnvironmentRequest["managedGodotLifecycleRuntime"];
  readonly managedGodotSemanticRuntime?: PrepareM1TaskEnvironmentRequest["managedGodotSemanticRuntime"];
  readonly externalProjectDescriptor?: PrepareM1TaskEnvironmentRequest["externalProjectDescriptor"];
  readonly semanticAdapterProfile?: PrepareM1TaskEnvironmentRequest["semanticAdapterProfile"];
}): string[] => [
  request.runtimeRoot,
  request.sandboxHost.delegatedCgroupRoot,
  request.sandboxHost.bwrapPath,
  request.sandboxHost.prlimitPath,
  request.sandboxHost.busyboxPath,
  ...(request.sandboxHost.taskStorageRoot === undefined
    ? []
    : [request.sandboxHost.taskStorageRoot]),
  ...(request.sandboxToolchain === undefined
    ? []
    : [
        request.sandboxToolchain.lddPath,
        ...request.sandboxToolchain.commands.flatMap((command) => [
          command.target,
          command.hostPath,
        ]),
      ]),
  ...(request.managedGodotRuntime === undefined
    ? []
    : [
        request.managedGodotRuntime.nodePath,
        request.managedGodotRuntime.godotPath,
        request.managedGodotRuntime.fontconfigProbePath ??
          DEFAULT_MANAGED_GODOT_HOST_DEPENDENCY_PATHS.fontconfigProbePath,
        request.managedGodotRuntime.shellPath ??
          DEFAULT_MANAGED_GODOT_HOST_DEPENDENCY_PATHS.shellPath,
        request.managedGodotRuntime.xdgUserDirPath ??
          DEFAULT_MANAGED_GODOT_HOST_DEPENDENCY_PATHS.xdgUserDirPath,
        request.managedGodotRuntime.lddPath,
        request.managedGodotRuntime.addonRoot,
      ]),
  ...(request.managedGodotLifecycleRuntime === undefined
    ? []
    : [
        request.managedGodotLifecycleRuntime.nodePath,
        request.managedGodotLifecycleRuntime.godotPath,
        request.managedGodotLifecycleRuntime.fontconfigProbePath ??
          DEFAULT_MANAGED_GODOT_LIFECYCLE_HOST_DEPENDENCY_PATHS.fontconfigProbePath,
        request.managedGodotLifecycleRuntime.shellPath ??
          DEFAULT_MANAGED_GODOT_LIFECYCLE_HOST_DEPENDENCY_PATHS.shellPath,
        request.managedGodotLifecycleRuntime.xdgUserDirPath ??
          DEFAULT_MANAGED_GODOT_LIFECYCLE_HOST_DEPENDENCY_PATHS.xdgUserDirPath,
        request.managedGodotLifecycleRuntime.lddPath,
        request.managedGodotLifecycleRuntime.addonRoot,
      ]),
  ...(request.managedGodotSemanticRuntime === undefined
    ? []
    : [
        request.managedGodotSemanticRuntime.nodePath,
        request.managedGodotSemanticRuntime.godotPath,
        request.managedGodotSemanticRuntime.fontconfigProbePath ??
          DEFAULT_MANAGED_GODOT_SEMANTIC_HOST_DEPENDENCY_PATHS.fontconfigProbePath,
        request.managedGodotSemanticRuntime.shellPath ??
          DEFAULT_MANAGED_GODOT_SEMANTIC_HOST_DEPENDENCY_PATHS.shellPath,
        request.managedGodotSemanticRuntime.xdgUserDirPath ??
          DEFAULT_MANAGED_GODOT_SEMANTIC_HOST_DEPENDENCY_PATHS.xdgUserDirPath,
        request.managedGodotSemanticRuntime.lddPath,
        request.managedGodotSemanticRuntime.addonRoot,
      ]),
  ...(request.externalProjectDescriptor === undefined
    ? []
    : [request.externalProjectDescriptor.canonicalPath]),
  ...(request.semanticAdapterProfile === undefined
    ? []
    : [request.semanticAdapterProfile.canonicalPath]),
];

const inspectM1Runtime = async (
  request: {
    readonly runtimeRoot: string;
    readonly sandboxHost: SandboxHostPreflightRequest;
    readonly sandboxToolchain?: PrepareM1TaskEnvironmentRequest["sandboxToolchain"];
    readonly managedGodotRuntime?: PrepareM1TaskEnvironmentRequest["managedGodotRuntime"];
    readonly managedGodotLifecycleRuntime?: PrepareM1TaskEnvironmentRequest["managedGodotLifecycleRuntime"];
    readonly managedGodotSemanticRuntime?: PrepareM1TaskEnvironmentRequest["managedGodotSemanticRuntime"];
  },
  dependencies: M1TaskEnvironmentDependencies,
  sensitiveValues: readonly string[],
) => {
  const requestedManagedRuntimeCount = [
    request.managedGodotRuntime,
    request.managedGodotLifecycleRuntime,
    request.managedGodotSemanticRuntime,
  ].filter((value) => value !== undefined).length;
  if (requestedManagedRuntimeCount > 1) {
    throw new M1Error(
      "source_configuration_mismatch",
      "managed Godot runtime profiles are mutually exclusive",
    );
  }
  let sandboxResult: SandboxHostPreflightResult;
  let sandboxReceipt: ReturnType<typeof SandboxPreflightReceiptV1Schema.parse>;
  try {
    sandboxResult = await dependencies.preflightSandbox(request.sandboxHost);
    sandboxReceipt = SandboxPreflightReceiptV1Schema.parse(
      sandboxResult.receipt,
    );
  } catch (error) {
    throw normalizeError(error, "sandbox_preflight_failed", sensitiveValues);
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
          sanitizeM1Diagnostic(blocker.message, sensitiveValues) ||
          "sandbox preflight blocker",
      })),
    });
    if (sanitizedReceipt.status !== "unsupported") {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox preflight receipt changed status while being sanitized",
      );
    }
    throw new M1Error(
      "sandbox_preflight_failed",
      sanitizedReceipt.blockers.map((blocker) => blocker.message).join("; ") ||
        "sandbox preflight is unsupported",
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
  if (
    sandboxReceipt.capabilitySha256 !==
    asSha256DigestV1(contentHash(sandboxCapability as unknown as JsonValue))
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox preflight capability does not match its receipt",
    );
  }
  if (
    request.managedGodotRuntime !== undefined ||
    request.managedGodotLifecycleRuntime !== undefined ||
    request.managedGodotSemanticRuntime !== undefined
  ) {
    const requestedStorageRoot = request.sandboxHost.taskStorageRoot;
    const boundStorageRoot = sandboxResult.binding.taskStorageRoot;
    if (
      requestedStorageRoot === undefined ||
      sandboxCapability.taskStorage === undefined ||
      boundStorageRoot === undefined
    ) {
      throw new M1Error(
        "resource_limit_unavailable",
        "managed Godot runtime requires bounded aggregate Task storage",
      );
    }
    if (
      requestedStorageRoot !== boundStorageRoot ||
      !isAbsolute(request.runtimeRoot) ||
      resolve(request.runtimeRoot) !== request.runtimeRoot
    ) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "managed runtime and task storage roots must be canonical absolute paths",
      );
    }
    let canonicalRuntimeRoot: string;
    let canonicalStorageRoot: string;
    try {
      [canonicalRuntimeRoot, canonicalStorageRoot] = await Promise.all([
        realpath(request.runtimeRoot),
        realpath(boundStorageRoot),
      ]);
    } catch (error) {
      throw normalizeError(error, "sandbox_preflight_failed", sensitiveValues);
    }
    const difference = relative(canonicalStorageRoot, canonicalRuntimeRoot);
    if (
      canonicalRuntimeRoot !== request.runtimeRoot ||
      canonicalStorageRoot !== boundStorageRoot ||
      difference === "" ||
      difference === ".." ||
      difference.startsWith("../") ||
      isAbsolute(difference)
    ) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "managed runtime root must be a canonical child of bounded Task storage",
      );
    }
    try {
      await dependencies.assertTaskStorageLayout(
        sandboxCapability.taskStorage,
        boundStorageRoot,
        [canonicalRuntimeRoot],
      );
    } catch (error) {
      throw normalizeError(error, "sandbox_preflight_failed", sensitiveValues);
    }
  }
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
      throw normalizeError(error, "sandbox_preflight_failed", sensitiveValues);
    }
  }
  let managedRuntime: ManagedGodotRuntimePreflightResultV1 | undefined;
  let managedLifecycleRuntime:
    ManagedGodotLifecycleRuntimePreflightResultV1 | undefined;
  let managedSemanticRuntime:
    ManagedGodotSemanticRuntimePreflightResultV1 | undefined;
  if (request.managedGodotRuntime !== undefined) {
    if (toolchain === undefined) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "managed Godot runtime requires the coding toolchain",
      );
    }
    try {
      managedRuntime = await dependencies.preflightManagedRuntime(
        request.managedGodotRuntime,
      );
    } catch (error) {
      throw normalizeError(error, "sandbox_preflight_failed", sensitiveValues);
    }
  }
  if (request.managedGodotLifecycleRuntime !== undefined) {
    if (toolchain === undefined) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "managed Godot lifecycle runtime requires the coding toolchain",
      );
    }
    try {
      managedLifecycleRuntime =
        await dependencies.preflightManagedLifecycleRuntime(
          request.managedGodotLifecycleRuntime,
        );
    } catch (error) {
      throw normalizeError(error, "sandbox_preflight_failed", sensitiveValues);
    }
  }
  if (request.managedGodotSemanticRuntime !== undefined) {
    if (toolchain === undefined) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "managed Godot semantic runtime requires the coding toolchain",
      );
    }
    try {
      managedSemanticRuntime =
        await dependencies.preflightManagedSemanticRuntime(
          request.managedGodotSemanticRuntime,
        );
    } catch (error) {
      throw normalizeError(error, "sandbox_preflight_failed", sensitiveValues);
    }
  }
  return {
    sandbox: {
      ...sandboxResult,
      capability: sandboxCapability,
      receipt: sandboxReceipt,
    },
    toolchain,
    managedRuntime,
    managedLifecycleRuntime,
    managedSemanticRuntime,
  };
};

export async function prepareM1TaskEnvironment(
  request: PrepareM1TaskEnvironmentRequest,
  overrides: Partial<M1TaskEnvironmentDependencies> = {},
): Promise<M1TaskEnvironment> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const earlySensitiveValues = [
    request.projectPath,
    ...(request.trustedFixtureRoot === undefined
      ? []
      : [request.trustedFixtureRoot]),
    ...(request.externalProjectDescriptor === undefined
      ? []
      : [request.externalProjectDescriptor.canonicalPath]),
    ...runtimeSensitiveValues(request),
  ];
  const {
    sandbox,
    toolchain,
    managedRuntime,
    managedLifecycleRuntime,
    managedSemanticRuntime,
  } = await inspectM1Runtime(request, dependencies, earlySensitiveValues);
  const externalProfile = request.externalProjectDescriptor !== undefined;
  const semanticProfile = managedSemanticRuntime !== undefined;
  if (
    externalProfile !==
      (managedLifecycleRuntime !== undefined || semanticProfile) ||
    semanticProfile !== (request.semanticAdapterProfile !== undefined) ||
    (externalProfile &&
      (managedRuntime !== undefined ||
        request.trustedFixtureRoot !== undefined))
  ) {
    throw new M1Error(
      "source_configuration_mismatch",
      "external descriptor Tasks require exactly one external managed runtime, and semantic Tasks require one adapter profile",
    );
  }
  if (
    managedRuntime !== undefined ||
    managedLifecycleRuntime !== undefined ||
    managedSemanticRuntime !== undefined
  ) {
    try {
      await dependencies.assertSandboxBinding(
        sandbox.capability,
        sandbox.binding,
      );
    } catch (error) {
      throw normalizeError(
        error,
        "sandbox_preflight_failed",
        earlySensitiveValues,
      );
    }
  }

  let source: VerifiedTaskSource;
  try {
    if (request.externalProjectDescriptor === undefined) {
      if (request.trustedFixtureRoot === undefined) {
        throw new M1Error(
          "source_configuration_mismatch",
          "M3 fixture Task requires a trusted fixture root",
        );
      }
      source = await dependencies.preflightSource({
        projectPath: request.projectPath,
        trustedFixtureRoot: request.trustedFixtureRoot,
        sourceRepositoryExclusionRoots: [request.runtimeRoot],
      });
    } else {
      source = await dependencies.preflightExternalSource({
        projectPath: request.projectPath,
        descriptorSnapshot: request.externalProjectDescriptor,
        sourceRepositoryExclusionRoots: [request.runtimeRoot],
      });
    }
  } catch (error) {
    throw normalizeError(error, "artifact_write_failed", earlySensitiveValues);
  }

  let semanticAdapterProfile: GodotSemanticAdapterProfileSnapshotV1 | undefined;
  if (request.semanticAdapterProfile !== undefined) {
    try {
      semanticAdapterProfile = parseGodotSemanticAdapterProfileSnapshotV1(
        request.semanticAdapterProfile.bytes,
      );
      if (
        !("projectCapability" in source) ||
        semanticAdapterProfile.profile.projectCapabilitySha256 !==
          source.projectCapability.capabilitySha256
      ) {
        throw new M1Error(
          "source_configuration_mismatch",
          "semantic adapter profile does not match the verified external project capability",
        );
      }
    } catch (error) {
      throw normalizeError(
        error,
        "artifact_write_failed",
        earlySensitiveValues,
      );
    }
  }

  const sensitiveValues = [
    ...earlySensitiveValues,
    source.repositoryRoot,
    source.projectRoot,
  ];
  let layout: TaskDirectoryLayout | undefined;
  let store: M1TaskRecordStore | undefined;
  let runtimeStore: M1TaskRuntimeRecordStore | undefined;
  let broker: DuplexTaskSandboxBrokerV1 | undefined;
  try {
    layout = await dependencies.createLayout({
      runtimeRoot: request.runtimeRoot,
      sourceRepositoryRoot: source.repositoryRoot,
      taskId: request.taskId,
    });
    sensitiveValues.push(layout.taskRootDirectory);
    store = dependencies.createStore(request.runtimeRoot);
    await store.create(request.taskId);
    runtimeStore = dependencies.createRuntimeStore(request.runtimeRoot);
    await runtimeStore.create(request.taskId);

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
    if (managedRuntime !== undefined) {
      await store.putJsonOnce(
        request.taskId,
        MANAGED_RUNTIME_SLOT,
        managedRuntime.capability,
        (value) => ManagedGodotRuntimeCapabilityV1Schema.parse(value),
      );
    }
    if (managedLifecycleRuntime !== undefined) {
      await store.putJsonOnce(
        request.taskId,
        MANAGED_LIFECYCLE_RUNTIME_SLOT,
        managedLifecycleRuntime.capability,
        (value) => ManagedGodotLifecycleRuntimeCapabilityV1Schema.parse(value),
      );
    }
    if (managedSemanticRuntime !== undefined) {
      await store.putJsonOnce(
        request.taskId,
        MANAGED_SEMANTIC_RUNTIME_SLOT,
        managedSemanticRuntime.capability,
        (value) => ManagedGodotSemanticRuntimeCapabilityV1Schema.parse(value),
      );
    }
    if (semanticAdapterProfile !== undefined) {
      await store.putJsonOnce(
        request.taskId,
        SEMANTIC_ADAPTER_PROFILE_SLOT,
        semanticAdapterProfile,
        (value) => GodotSemanticAdapterProfileSnapshotV1Schema.parse(value),
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
      (value) => WorkspaceMaterializationReceiptSchema.parse(value),
    );
    if (isExternalMaterializedWorkspace(materialized)) {
      await store.putJsonOnce(
        request.taskId,
        "project-capability.json",
        materialized.projectCapability,
        (value) => TaskGodotProjectCapabilityV1Schema.parse(value),
      );
      await store.putBytesOnce(
        request.taskId,
        "project-descriptor.json",
        Uint8Array.from(materialized.descriptorSnapshot.bytes),
      );
    } else {
      await store.putJsonOnce(
        request.taskId,
        "fixture-capability.json",
        materialized.fixtureCapability,
        (value) => TaskFixtureCapabilityV1Schema.parse(value),
      );
    }
    const activeManagedRuntime =
      managedRuntime ?? managedLifecycleRuntime ?? managedSemanticRuntime;
    const policy =
      activeManagedRuntime === undefined
        ? createSandboxPolicyV1(
            sandbox.capability.runtimeIdentity,
            toolchain === undefined
              ? undefined
              : {
                  toolchainId: toolchain.capability.toolchainId,
                  targets: toolchain.capability.files.map(
                    (file) => file.target,
                  ),
                },
          )
        : createSandboxPolicyV2(sandbox.capability.runtimeIdentity, {
            coding: {
              toolchainId: toolchain!.capability.toolchainId,
              targets: toolchain!.capability.files.map((file) => file.target),
            },
            godot: {
              toolchainId:
                activeManagedRuntime.capability.toolchain.toolchainId,
              managedRuntimeId:
                activeManagedRuntime.capability.managedRuntimeId,
              targets: [
                ...activeManagedRuntime.capability.toolchain.files.map(
                  (file) => file.target,
                ),
                activeManagedRuntime.capability.fontconfigTarget,
                activeManagedRuntime.capability.addonParentTarget,
                activeManagedRuntime.capability.addonTarget,
                ...(managedLifecycleRuntime !== undefined
                  ? [managedLifecycleRuntime.capability.overlayTarget]
                  : managedSemanticRuntime !== undefined
                    ? [managedSemanticRuntime.capability.overlayTarget]
                    : []),
              ],
            },
          });
    await store.putJsonOnce(
      request.taskId,
      "sandbox-policy.json",
      policy,
      (value) => SandboxPolicySchema.parse(value),
    );
    if (activeManagedRuntime === undefined) {
      await dependencies.assertSandboxBinding(
        sandbox.capability,
        sandbox.binding,
      );
    }
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
      ...(activeManagedRuntime === undefined
        ? {}
        : { managedRuntime: activeManagedRuntime }),
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

    const commonEnvironment = {
      task: cloneAndFreeze(task),
      sandboxCapability: cloneAndFreeze(sandbox.capability),
      ...(toolchain === undefined
        ? {}
        : { toolchainCapability: cloneAndFreeze(toolchain.capability) }),
      policy: cloneAndFreeze(policy),
      runtimeStore: bindTaskRuntimeStore(request.taskId, runtimeStore),
    } as const;
    const environment: M1TaskEnvironment = isExternalMaterializedWorkspace(
      materialized,
    )
      ? semanticAdapterProfile === undefined
        ? Object.freeze({
            ...commonEnvironment,
            sourceKind: "godot-external-lifecycle-v1" as const,
            workspace: cloneAndFreeze(materialized.receipt),
            projectCapability: cloneAndFreeze(materialized.projectCapability),
            managedLifecycleRuntimeCapability: cloneAndFreeze(
              managedLifecycleRuntime!.capability,
            ),
          })
        : Object.freeze({
            ...commonEnvironment,
            sourceKind: "godot-external-semantic-v1" as const,
            workspace: cloneAndFreeze(materialized.receipt),
            projectCapability: cloneAndFreeze(materialized.projectCapability),
            managedSemanticRuntimeCapability: cloneAndFreeze(
              managedSemanticRuntime!.capability,
            ),
            semanticAdapterProfile: cloneAndFreeze(semanticAdapterProfile),
          })
      : Object.freeze({
          ...commonEnvironment,
          workspace: cloneAndFreeze(materialized.receipt),
          ...(managedRuntime === undefined
            ? {}
            : {
                managedRuntimeCapability: cloneAndFreeze(
                  managedRuntime.capability,
                ),
              }),
        });
    ENVIRONMENT_STATES.set(environment, {
      layout,
      materialized,
      binding: sandbox.binding,
      broker,
      managedRuntime,
      managedLifecycleRuntime,
      managedSemanticRuntime,
      activeDuplexCompletions: new Set(),
      store,
      runtimeStore,
      gate: new TaskOperationGate(),
      dependencies,
      sensitiveValues,
      securityEvents,
      recordsDiscarded: false,
      runtimeRecordsDiscarded: false,
      cleanupPromise: undefined,
      suspendPromise: undefined,
      discardPromise: undefined,
    });
    return environment;
  } catch (error) {
    const initialOwnership = await resolveBrokerSetupCleanupOwnership(error);
    let retainedOwner = initialOwnership.retainedOwner;
    let normalized =
      retainedOwner === undefined
        ? normalizeError(
            initialOwnership.primaryError,
            "artifact_write_failed",
            sensitiveValues,
          )
        : retainedSetupCleanupError(retainedOwner);
    if (layout !== undefined && store !== undefined) {
      if (retainedOwner === undefined && broker !== undefined) {
        try {
          await cleanupBrokerAfterSetupFailure(
            broker,
            initialOwnership.primaryError,
          );
        } catch (cleanupError) {
          const cleanupOwnership =
            await resolveBrokerSetupCleanupOwnership(cleanupError);
          retainedOwner = cleanupOwnership.retainedOwner;
          normalized =
            retainedOwner === undefined
              ? normalizeError(
                  cleanupOwnership.primaryError,
                  "artifact_write_failed",
                  sensitiveValues,
                )
              : retainedSetupCleanupError(retainedOwner);
        }
      }
      if (retainedOwner === undefined) {
        try {
          await dependencies.cleanStagingRegistration(source, layout);
          await removeMutableTaskState(request.taskId, layout);
        } catch (cleanupError) {
          normalized = normalizeError(
            cleanupError,
            "artifact_write_failed",
            sensitiveValues,
          );
        }
      }
      try {
        await recordSetupFailure({
          taskId: request.taskId,
          store,
          now: dependencies.now,
          error: normalized,
        });
      } catch (recordError) {
        if (retainedOwner !== undefined) {
          normalized = retainedSetupCleanupError(retainedOwner, recordError);
        } else {
          throw normalizeError(
            recordError,
            "artifact_write_failed",
            sensitiveValues,
          );
        }
      }
    }
    throw normalized;
  }
}

export async function resumeM1TaskEnvironment(
  request: ResumeM1TaskEnvironmentRequest,
  overrides: Partial<M1TaskEnvironmentDependencies> = {},
): Promise<M1TaskEnvironment> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const sensitiveValues = runtimeSensitiveValues(request);
  const {
    sandbox,
    toolchain,
    managedRuntime,
    managedLifecycleRuntime,
    managedSemanticRuntime,
  } = await inspectM1Runtime(request, dependencies, sensitiveValues);
  let store: M1TaskRecordStore | undefined;
  let runtimeStore: M1TaskRuntimeRecordStore | undefined;
  let broker: DuplexTaskSandboxBrokerV1 | undefined;
  try {
    const layout = await dependencies.openLayout({
      runtimeRoot: request.runtimeRoot,
      taskId: request.taskId,
    });
    sensitiveValues.push(layout.taskRootDirectory);
    store = dependencies.createStore(request.runtimeRoot);
    await store.create(request.taskId);
    runtimeStore = dependencies.createRuntimeStore(request.runtimeRoot);
    const [task, workspace, storedSandbox, policy] = await Promise.all([
      store.readJson(request.taskId, "task.json", (value) =>
        TaskIdentityV1Schema.parse(value),
      ),
      store.readJson(request.taskId, "workspace.json", (value) =>
        WorkspaceMaterializationReceiptSchema.parse(value),
      ),
      store.readJson(request.taskId, "sandbox-capability.json", (value) =>
        SandboxHostCapabilityV1Schema.parse(value),
      ),
      store.readJson(request.taskId, "sandbox-policy.json", (value) =>
        SandboxPolicySchema.parse(value),
      ),
    ]);
    let fixtureCapability: TaskFixtureCapabilityV1 | undefined;
    let projectCapability: TaskGodotProjectCapabilityV1 | undefined;
    let descriptorSnapshot:
      ReturnType<typeof parseGodotProjectDescriptorSnapshotV1> | undefined;
    let semanticAdapterProfile:
      GodotSemanticAdapterProfileSnapshotV1 | undefined;
    if (workspace.schemaVersion === 1) {
      fixtureCapability = await store.readJson(
        request.taskId,
        "fixture-capability.json",
        (value) => TaskFixtureCapabilityV1Schema.parse(value),
      );
    } else {
      const [storedProjectCapability, descriptorBytes] = await Promise.all([
        store.readJson(request.taskId, "project-capability.json", (value) =>
          TaskGodotProjectCapabilityV1Schema.parse(value),
        ),
        store.readBytes(request.taskId, "project-descriptor.json"),
      ]);
      projectCapability = storedProjectCapability;
      descriptorSnapshot =
        parseGodotProjectDescriptorSnapshotV1(descriptorBytes);
      if (managedSemanticRuntime !== undefined) {
        semanticAdapterProfile = await store.readJson(
          request.taskId,
          SEMANTIC_ADAPTER_PROFILE_SLOT,
          (value) => GodotSemanticAdapterProfileSnapshotV1Schema.parse(value),
        );
      }
    }
    const sourceBindingMatches =
      workspace.schemaVersion === 1
        ? fixtureCapability !== undefined &&
          workspace.fixtureCapabilitySha256 ===
            fixtureCapability.capabilitySha256 &&
          sameJson(
            workspace.excludedCachePaths,
            fixtureCapability.ignoredCachePaths,
          )
        : projectCapability !== undefined &&
          descriptorSnapshot !== undefined &&
          workspace.sourceCapabilityKind === projectCapability.capabilityKind &&
          workspace.projectCapabilitySha256 ===
            projectCapability.capabilitySha256 &&
          workspace.descriptorSha256 === descriptorSnapshot.descriptorSha256 &&
          workspace.sourceRevision === projectCapability.sourceRevision &&
          workspace.selectedTreeSha256 ===
            projectCapability.baselineSelectedTreeSha256 &&
          sameJson(
            workspace.excludedCachePaths,
            projectCapability.ignoredCachePaths,
          ) &&
          descriptorSnapshot.descriptor.declaredSourceUrl ===
            projectCapability.declaredSourceUrl &&
          (managedSemanticRuntime === undefined ||
            semanticAdapterProfile?.profile.projectCapabilitySha256 ===
              projectCapability.capabilitySha256);
    const runtimeProfileMatchesWorkspace =
      workspace.schemaVersion === 1
        ? managedLifecycleRuntime === undefined &&
          managedSemanticRuntime === undefined
        : managedRuntime === undefined &&
          Number(managedLifecycleRuntime !== undefined) +
            Number(managedSemanticRuntime !== undefined) ===
            1;
    if (
      task.taskId !== request.taskId ||
      workspace.taskId !== request.taskId ||
      !sourceBindingMatches ||
      !runtimeProfileMatchesWorkspace ||
      !sameStableSandboxCapability(
        storedSandbox,
        sandbox.capability,
        policy.schemaVersion,
      ) ||
      policy.runtimeIdentity !== storedSandbox.runtimeIdentity
    ) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "current runtime does not match the frozen Task identity and capability",
      );
    }
    let storedToolchain: SandboxToolchainCapabilityV1 | undefined;
    let storedManagedRuntime: ManagedGodotRuntimeCapabilityV1 | undefined;
    let storedManagedLifecycleRuntime:
      ManagedGodotLifecycleRuntimeCapabilityV1 | undefined;
    let storedManagedSemanticRuntime:
      ManagedGodotSemanticRuntimeCapabilityV1 | undefined;
    await dependencies.assertSandboxBinding(
      sandbox.capability,
      sandbox.binding,
    );
    if (policy.schemaVersion === 1) {
      if (
        managedRuntime !== undefined ||
        managedLifecycleRuntime !== undefined ||
        managedSemanticRuntime !== undefined
      ) {
        throw new M1Error(
          "sandbox_preflight_failed",
          "Sandbox Policy V1 Task cannot authorize a managed runtime",
        );
      }
      if (policy.toolchainId === null) {
        if (toolchain !== undefined) {
          throw new M1Error(
            "sandbox_preflight_failed",
            "Task was created without the requested toolchain",
          );
        }
      } else {
        if (toolchain === undefined) {
          throw new M1Error(
            "sandbox_preflight_failed",
            "Task continuation requires its frozen toolchain",
          );
        }
        storedToolchain = await store.readJson(
          request.taskId,
          "sandbox-toolchain.json",
          (value) => SandboxToolchainCapabilityV1Schema.parse(value),
        );
        if (
          policy.toolchainId !== storedToolchain.toolchainId ||
          !sameJson(storedToolchain, toolchain.capability) ||
          !sameJson(
            policy.readonlyTargets,
            [
              "/bin/busybox",
              ...storedToolchain.files.map((file) => file.target),
            ].sort(),
          )
        ) {
          throw new M1Error(
            "sandbox_preflight_failed",
            "current toolchain does not match the frozen Task capability",
          );
        }
      }
    } else {
      if (toolchain === undefined) {
        throw new M1Error(
          "sandbox_preflight_failed",
          "Task continuation requires its frozen coding and managed Godot toolchains",
        );
      }
      try {
        storedToolchain = await store.readJson<SandboxToolchainCapabilityV1>(
          request.taskId,
          "sandbox-toolchain.json",
          (value) => SandboxToolchainCapabilityV1Schema.parse(value),
        );
        if (workspace.schemaVersion === 1) {
          if (managedRuntime === undefined) {
            throw new M1Error(
              "sandbox_preflight_failed",
              "M3 Task continuation requires its managed Godot runtime",
            );
          }
          storedManagedRuntime = await store.readJson(
            request.taskId,
            MANAGED_RUNTIME_SLOT,
            (value) => ManagedGodotRuntimeCapabilityV1Schema.parse(value),
          );
        } else if (managedSemanticRuntime !== undefined) {
          storedManagedSemanticRuntime = await store.readJson(
            request.taskId,
            MANAGED_SEMANTIC_RUNTIME_SLOT,
            (value) =>
              ManagedGodotSemanticRuntimeCapabilityV1Schema.parse(value),
          );
        } else {
          if (managedLifecycleRuntime === undefined) {
            throw new M1Error(
              "sandbox_preflight_failed",
              "external Task continuation requires its managed Godot lifecycle runtime",
            );
          }
          storedManagedLifecycleRuntime = await store.readJson(
            request.taskId,
            MANAGED_LIFECYCLE_RUNTIME_SLOT,
            (value) =>
              ManagedGodotLifecycleRuntimeCapabilityV1Schema.parse(value),
          );
        }
      } catch (error) {
        throw new M1Error(
          "sandbox_preflight_failed",
          "Task managed runtime capability is missing or invalid",
          error,
        );
      }
      const storedActiveManagedRuntime =
        storedManagedRuntime ??
        storedManagedLifecycleRuntime ??
        storedManagedSemanticRuntime;
      const currentActiveManagedRuntime =
        managedRuntime ?? managedLifecycleRuntime ?? managedSemanticRuntime;
      if (
        storedToolchain === undefined ||
        storedActiveManagedRuntime === undefined ||
        currentActiveManagedRuntime === undefined
      ) {
        throw new M1Error(
          "sandbox_preflight_failed",
          "Task managed runtime capability is missing or invalid",
        );
      }
      const codingTargets = [
        "/bin/busybox",
        ...storedToolchain.files.map((file) => file.target),
      ].sort();
      const godotTargets = [
        "/bin/busybox",
        ...storedActiveManagedRuntime.toolchain.files.map(
          (file) => file.target,
        ),
        storedActiveManagedRuntime.fontconfigTarget,
        storedActiveManagedRuntime.addonParentTarget,
        storedActiveManagedRuntime.addonTarget,
        ...(storedManagedLifecycleRuntime !== undefined
          ? [storedManagedLifecycleRuntime.overlayTarget]
          : storedManagedSemanticRuntime !== undefined
            ? [storedManagedSemanticRuntime.overlayTarget]
            : []),
      ].sort();
      if (
        !sameJson(storedToolchain, toolchain.capability) ||
        !sameJson(
          storedActiveManagedRuntime,
          currentActiveManagedRuntime.capability,
        ) ||
        policy.profileBindings["coding-default"].toolchainId !==
          storedToolchain.toolchainId ||
        policy.profileBindings["coding-default"].managedRuntimeId !== null ||
        policy.profileBindings["coding-default"].workspaceAccess !==
          "read-write" ||
        !sameJson(
          policy.profileBindings["coding-default"].readonlyTargets,
          codingTargets,
        ) ||
        policy.profileBindings["godot-headless"].toolchainId !==
          storedActiveManagedRuntime.toolchain.toolchainId ||
        policy.profileBindings["godot-headless"].managedRuntimeId !==
          storedActiveManagedRuntime.managedRuntimeId ||
        policy.profileBindings["godot-headless"].workspaceAccess !==
          "read-only" ||
        !sameJson(
          policy.profileBindings["godot-headless"].readonlyTargets,
          godotTargets,
        )
      ) {
        throw new M1Error(
          "sandbox_preflight_failed",
          "current managed runtime does not match the frozen Task capability",
        );
      }
    }
    if (policy.schemaVersion === 1) {
      // Pre-M3 Tasks did not own a runtime-records namespace. Creating an
      // empty, marked store is the only resume migration and leaves every
      // frozen V1 Task/policy record untouched. V2 Tasks must already have
      // their runtime store, so a missing namespace remains corruption.
      await runtimeStore.create(request.taskId);
    } else {
      await runtimeStore.open(request.taskId);
    }
    await store.append(
      request.taskId,
      "sandbox-preflight.jsonl",
      sandbox.receipt,
      (value) => SandboxPreflightReceiptV1Schema.parse(value),
    );
    const taskStore = store;
    const securityEvents = new TaskSecurityEventRecorder(
      request.taskId,
      taskStore,
      sensitiveValues,
    );
    const activeManagedRuntime =
      managedRuntime ?? managedLifecycleRuntime ?? managedSemanticRuntime;
    broker = await dependencies.createBroker({
      taskId: request.taskId,
      capability: sandbox.capability,
      hostBinding: sandbox.binding,
      policy,
      ...(toolchain === undefined ? {} : { toolchain }),
      ...(activeManagedRuntime === undefined
        ? {}
        : { managedRuntime: activeManagedRuntime }),
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
        kind: "resumed",
        occurredAt: dependencies.now(),
        policyId: policy.policyId,
      },
      (value) => M1TaskEventV1Schema.parse(value),
    );
    const materialized: MaterializedTaskWorkspace =
      workspace.schemaVersion === 1
        ? {
            workspaceDirectory: layout.workspaceDirectory,
            hostBaselineGitDirectory: layout.hostBaselineGitDirectory,
            agentBaselineCommit: workspace.agentBaselineCommit,
            hostBaselineCommit: workspace.hostBaselineCommit,
            receipt: workspace,
            fixtureCapability: fixtureCapability!,
          }
        : {
            sourceKind: "godot-external-lifecycle-v1",
            workspaceDirectory: layout.workspaceDirectory,
            hostBaselineGitDirectory: layout.hostBaselineGitDirectory,
            agentBaselineCommit: workspace.agentBaselineCommit,
            hostBaselineCommit: workspace.hostBaselineCommit,
            receipt: workspace,
            projectCapability: projectCapability!,
            descriptorSnapshot: descriptorSnapshot!,
          };
    const commonEnvironment = {
      task: cloneAndFreeze(task),
      // The persisted capability remains the immutable creation-time record,
      // while executions after resume are bound to the freshly proven Host
      // capability. Ephemeral probe and cgroup-delegation identities are
      // intentionally allowed to change across Host lifetimes, so exposing
      // the stored value here would make the broker receipt and Task lineage
      // disagree on the first resumed operation.
      sandboxCapability: cloneAndFreeze(sandbox.capability),
      ...(storedToolchain === undefined
        ? {}
        : { toolchainCapability: cloneAndFreeze(storedToolchain) }),
      policy: cloneAndFreeze(policy),
      runtimeStore: bindTaskRuntimeStore(request.taskId, runtimeStore),
    } as const;
    const environment: M1TaskEnvironment =
      workspace.schemaVersion === 2
        ? storedManagedSemanticRuntime === undefined
          ? Object.freeze({
              ...commonEnvironment,
              sourceKind: "godot-external-lifecycle-v1" as const,
              workspace: cloneAndFreeze(workspace),
              projectCapability: cloneAndFreeze(projectCapability!),
              managedLifecycleRuntimeCapability: cloneAndFreeze(
                storedManagedLifecycleRuntime!,
              ),
            })
          : Object.freeze({
              ...commonEnvironment,
              sourceKind: "godot-external-semantic-v1" as const,
              workspace: cloneAndFreeze(workspace),
              projectCapability: cloneAndFreeze(projectCapability!),
              managedSemanticRuntimeCapability: cloneAndFreeze(
                storedManagedSemanticRuntime,
              ),
              semanticAdapterProfile: cloneAndFreeze(semanticAdapterProfile!),
            })
        : Object.freeze({
            ...commonEnvironment,
            workspace: cloneAndFreeze(workspace),
            ...(storedManagedRuntime === undefined
              ? {}
              : {
                  managedRuntimeCapability:
                    cloneAndFreeze(storedManagedRuntime),
                }),
          });
    ENVIRONMENT_STATES.set(environment, {
      layout,
      materialized,
      binding: sandbox.binding,
      broker,
      managedRuntime,
      managedLifecycleRuntime,
      managedSemanticRuntime,
      activeDuplexCompletions: new Set(),
      store,
      runtimeStore,
      gate: new TaskOperationGate(),
      dependencies,
      sensitiveValues,
      securityEvents,
      recordsDiscarded: false,
      runtimeRecordsDiscarded: false,
      cleanupPromise: undefined,
      suspendPromise: undefined,
      discardPromise: undefined,
    });
    return environment;
  } catch (error) {
    const initialOwnership = await resolveBrokerSetupCleanupOwnership(error);
    let retainedOwner = initialOwnership.retainedOwner;
    let normalized =
      retainedOwner === undefined
        ? normalizeError(
            initialOwnership.primaryError,
            "artifact_write_failed",
            sensitiveValues,
          )
        : retainedSetupCleanupError(retainedOwner);
    if (retainedOwner === undefined && broker !== undefined) {
      try {
        await cleanupBrokerAfterSetupFailure(
          broker,
          initialOwnership.primaryError,
        );
      } catch (cleanupError) {
        const cleanupOwnership =
          await resolveBrokerSetupCleanupOwnership(cleanupError);
        retainedOwner = cleanupOwnership.retainedOwner;
        normalized =
          retainedOwner === undefined
            ? normalizeError(
                cleanupOwnership.primaryError,
                "artifact_write_failed",
                sensitiveValues,
              )
            : retainedSetupCleanupError(retainedOwner);
      }
    }
    if (store !== undefined) {
      try {
        await store.append(
          request.taskId,
          "task-events.jsonl",
          {
            schemaVersion: 1,
            taskId: request.taskId,
            kind: "resume_failed",
            occurredAt: dependencies.now(),
            code: normalized.code,
            message: normalized.message,
          },
          (value) => M1TaskEventV1Schema.parse(value),
        );
      } catch (recordError) {
        if (retainedOwner !== undefined) {
          normalized = retainedSetupCleanupError(retainedOwner, recordError);
        } else {
          throw normalizeError(
            recordError,
            "artifact_write_failed",
            sensitiveValues,
          );
        }
      }
    }
    throw normalized;
  }
}

const recordExecutedM1Command = async (
  environment: M1TaskEnvironment,
  state: M1TaskEnvironmentState,
  parsedRequest: SandboxExecutionRequestV1,
  result: Extract<SandboxExecutionResultV1, { readonly kind: "executed" }>,
): Promise<
  Extract<SandboxExecutionResultV1, { readonly kind: "executed" }>
> => {
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
  const frozenProfile = environment.policy.profiles[parsedRequest.profile];
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
  const taskStorage = environment.sandboxCapability.taskStorage;
  const aggregateStorageUsage = receipt.resourceUsage.aggregateStorage;
  const aggregateStorageUnavailable =
    receipt.realizedMechanisms.aggregateStorage === undefined &&
    receipt.realizedMechanisms.unavailable.length === 1 &&
    aggregateStorageUsage === undefined;
  const aggregateStorageObserved =
    taskStorage !== undefined &&
    receipt.realizedMechanisms.aggregateStorage === taskStorage.kind &&
    receipt.realizedMechanisms.unavailable.length === 0 &&
    aggregateStorageUsage !== undefined &&
    aggregateStorageUsage.usedBytes <= taskStorage.totalBytes &&
    aggregateStorageUsage.usedInodes <= taskStorage.totalInodes;
  if (
    taskStorage === undefined
      ? receipt.realizedMechanisms.aggregateStorage !== undefined ||
        aggregateStorageUsage !== undefined
      : !aggregateStorageObserved && !aggregateStorageUnavailable
  ) {
    throw new M1Error(
      "artifact_write_failed",
      "sandbox execution receipt does not prove bounded aggregate Task storage",
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
};

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
        return await recordExecutedM1Command(
          environment,
          state,
          parsedRequest,
          result,
        );
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

export interface M1TaskDuplexSandboxPortV1 {
  execute(
    request: SandboxExecutionRequestV1,
    options?: SandboxExecutionOptionsV1,
  ): Promise<SandboxExecutionResultV1>;
  openDuplex(
    request: SandboxExecutionRequestV1,
    options?: SandboxDuplexExecutionOptionsV1,
  ): Promise<SandboxDuplexOpenResultV1>;
}

export function getM1TaskDuplexSandboxPort(
  environment: M1TaskEnvironment,
): M1TaskDuplexSandboxPortV1 {
  const state = requireEnvironmentState(environment);
  return Object.freeze({
    execute: (
      request: SandboxExecutionRequestV1,
      options?: SandboxExecutionOptionsV1,
    ): Promise<SandboxExecutionResultV1> =>
      executeAndRecordM1Command(environment, request, options),
    openDuplex: (
      request: SandboxExecutionRequestV1,
      options?: SandboxDuplexExecutionOptionsV1,
    ): Promise<SandboxDuplexOpenResultV1> =>
      state.gate.run(async () => {
        let brokerInvoked = false;
        try {
          const parsedRequest = SandboxExecutionRequestV1Schema.parse(request);
          state.securityEvents.begin(parsedRequest.operationId);
          try {
            brokerInvoked = true;
            const opened = await state.broker.openDuplex(
              parsedRequest,
              options,
            );
            if (opened.kind === "denied") {
              const event = await state.securityEvents.commitDenial(
                opened.securityEvent,
              );
              return { kind: "denied", securityEvent: event };
            }
            state.securityEvents.assertNoneStaged();
            if (opened.kind === "executed") {
              return await recordExecutedM1Command(
                environment,
                state,
                parsedRequest,
                opened,
              );
            }

            const completion = opened.handle.completion
              .then(async (result) => {
                if (result.kind !== "executed") {
                  throw new M1Error(
                    "artifact_write_failed",
                    "opened sandbox duplex execution completed with a denial",
                  );
                }
                return await recordExecutedM1Command(
                  environment,
                  state,
                  parsedRequest,
                  result,
                );
              })
              .catch((error: unknown) => {
                state.gate.close();
                throw normalizeError(
                  error,
                  "artifact_write_failed",
                  state.sensitiveValues,
                );
              });
            state.activeDuplexCompletions.add(completion);
            void completion
              .finally(() => state.activeDuplexCompletions.delete(completion))
              .catch(() => undefined);
            return {
              kind: "opened",
              handle: {
                write: (bytes) => opened.handle.write(bytes),
                endInput: () => opened.handle.endInput(),
                terminate: () => opened.handle.terminate(),
                completion,
              },
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
      }),
  });
}

export function createM1ManagedGodotSidecarPort(
  environment: M1TaskEnvironment,
): GodotSidecarPortV1 {
  const state = requireEnvironmentState(environment);
  if (
    environment.managedRuntimeCapability === undefined ||
    state.managedRuntime === undefined
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "Task has no managed Godot runtime",
    );
  }
  return new GodotSidecarPortV1({
    broker: getM1TaskDuplexSandboxPort(environment),
    managedRuntime: state.managedRuntime,
  });
}

export function createM1ManagedGodotLifecycleSidecarPort(
  environment: M1TaskEnvironment,
): GodotLifecycleSidecarPortV1 {
  const state = requireEnvironmentState(environment);
  if (
    !isM1ExternalGodotTaskEnvironment(environment) ||
    state.managedLifecycleRuntime === undefined
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "Task has no managed Godot lifecycle runtime",
    );
  }
  return new GodotLifecycleSidecarPortV1({
    broker: getM1TaskDuplexSandboxPort(environment),
    managedRuntime: state.managedLifecycleRuntime,
  });
}

export function createM1ManagedGodotSemanticSidecarPort(
  environment: M1TaskEnvironment,
): GodotSemanticSidecarPortV1 {
  const state = requireEnvironmentState(environment);
  if (
    !isM1ExternalGodotSemanticTaskEnvironment(environment) ||
    state.managedSemanticRuntime === undefined
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "Task has no managed Godot semantic runtime",
    );
  }
  return new GodotSemanticSidecarPortV1({
    broker: getM1TaskDuplexSandboxPort(environment),
    managedRuntime: state.managedSemanticRuntime,
  });
}

export interface M1TaskGameRuntimeContextV1 {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly workspaceDirectory: string;
  readonly baselineSourceHash: Sha256DigestV1;
  readonly fixtureCapability: TaskFixtureCapabilityV1;
  readonly managedRuntime: ManagedGodotRuntimeCapabilityV1;
  readonly sidecarPort: GodotSidecarPortV1;
  readonly runtimeStore: M1TaskRuntimeArtifactStore;
}

export function getM1TaskGameRuntimeContext(
  environment: M1TaskEnvironment,
): M1TaskGameRuntimeContextV1 {
  const state = requireEnvironmentState(environment);
  if (
    isM1ExternalGodotTaskEnvironment(environment) ||
    environment.managedRuntimeCapability === undefined ||
    isExternalMaterializedWorkspace(state.materialized)
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "Task has no M3 managed Godot fixture runtime",
    );
  }
  const workspaceId = asWorkspaceId(
    `workspace:v1:${contentHash(environment.workspace as unknown as JsonValue)}`,
  );
  return Object.freeze({
    taskId: environment.task.taskId,
    workspaceId,
    workspaceDirectory: state.layout.workspaceDirectory,
    baselineSourceHash: environment.workspace.selectedTreeSha256,
    fixtureCapability: cloneAndFreeze(state.materialized.fixtureCapability),
    managedRuntime: cloneAndFreeze(environment.managedRuntimeCapability),
    sidecarPort: createM1ManagedGodotSidecarPort(environment),
    runtimeStore: environment.runtimeStore,
  });
}

export interface M1TaskExternalGodotRuntimeContextV1 {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly workspaceDirectory: string;
  readonly baselineSourceHash: Sha256DigestV1;
  readonly projectCapability: TaskGodotProjectCapabilityV1;
  readonly managedLifecycleRuntime: ManagedGodotLifecycleRuntimeCapabilityV1;
  readonly sandboxPort: M1TaskDuplexSandboxPortV1;
  readonly sidecarPort: GodotLifecycleSidecarPortV1;
  readonly runtimeStore: M1TaskRuntimeArtifactStore;
}

export function getM1TaskExternalGodotRuntimeContext(
  environment: M1TaskEnvironment,
): M1TaskExternalGodotRuntimeContextV1 {
  const state = requireEnvironmentState(environment);
  if (
    !isM1ExternalGodotTaskEnvironment(environment) ||
    !isExternalMaterializedWorkspace(state.materialized) ||
    state.managedLifecycleRuntime === undefined
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "Task is not an external Godot lifecycle Task",
    );
  }
  const workspaceId = asWorkspaceId(
    `workspace:v1:${contentHash(environment.workspace as unknown as JsonValue)}`,
  );
  return Object.freeze({
    taskId: environment.task.taskId,
    workspaceId,
    workspaceDirectory: state.layout.workspaceDirectory,
    baselineSourceHash: environment.workspace.selectedTreeSha256,
    projectCapability: cloneAndFreeze(environment.projectCapability),
    managedLifecycleRuntime: cloneAndFreeze(
      environment.managedLifecycleRuntimeCapability,
    ),
    sandboxPort: getM1TaskDuplexSandboxPort(environment),
    sidecarPort: createM1ManagedGodotLifecycleSidecarPort(environment),
    runtimeStore: environment.runtimeStore,
  });
}

export interface M1TaskExternalGodotSemanticRuntimeContextV1 {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly workspaceDirectory: string;
  readonly baselineSourceHash: Sha256DigestV1;
  readonly projectCapability: TaskGodotProjectCapabilityV1;
  readonly managedSemanticRuntime: ManagedGodotSemanticRuntimeCapabilityV1;
  readonly semanticAdapterProfile: GodotSemanticAdapterProfileSnapshotV1;
  readonly sandboxPort: M1TaskDuplexSandboxPortV1;
  readonly sidecarPort: GodotSemanticSidecarPortV1;
  readonly runtimeStore: M1TaskRuntimeArtifactStore;
}

export function getM1TaskExternalGodotSemanticRuntimeContext(
  environment: M1TaskEnvironment,
): M1TaskExternalGodotSemanticRuntimeContextV1 {
  const state = requireEnvironmentState(environment);
  if (
    !isM1ExternalGodotSemanticTaskEnvironment(environment) ||
    !isExternalMaterializedWorkspace(state.materialized) ||
    state.managedSemanticRuntime === undefined
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "Task is not an external Godot semantic Task",
    );
  }
  const workspaceId = asWorkspaceId(
    `workspace:v1:${contentHash(environment.workspace as unknown as JsonValue)}`,
  );
  return Object.freeze({
    taskId: environment.task.taskId,
    workspaceId,
    workspaceDirectory: state.layout.workspaceDirectory,
    baselineSourceHash: environment.workspace.selectedTreeSha256,
    projectCapability: cloneAndFreeze(environment.projectCapability),
    managedSemanticRuntime: cloneAndFreeze(
      environment.managedSemanticRuntimeCapability,
    ),
    semanticAdapterProfile: cloneAndFreeze(environment.semanticAdapterProfile),
    sandboxPort: getM1TaskDuplexSandboxPort(environment),
    sidecarPort: createM1ManagedGodotSemanticSidecarPort(environment),
    runtimeStore: environment.runtimeStore,
  });
}

export function extractAndPersistM1Patch(
  environment: M1TaskEnvironment,
): Promise<ExtractedTaskPatch> {
  const state = requireEnvironmentState(environment);
  return state.gate.run(async () => {
    try {
      const commonPatchRequest = {
        taskId: environment.task.taskId,
        workspaceDirectory: state.layout.workspaceDirectory,
        hostBaselineGitDirectory: state.layout.hostBaselineGitDirectory,
        hostBaselineCommit: state.materialized.hostBaselineCommit,
        baselineSourceHash: state.materialized.receipt.selectedTreeSha256,
        hostOperationTemporaryDirectory:
          state.layout.hostOperationTemporaryDirectory,
      } as const;
      const extracted = isExternalMaterializedWorkspace(state.materialized)
        ? await state.dependencies.extractPatch({
            ...commonPatchRequest,
            sourceKind: "godot-external-lifecycle-v1",
            ignoredCachePaths:
              state.materialized.projectCapability.ignoredCachePaths,
            projectCapability: state.materialized.projectCapability,
          })
        : await state.dependencies.extractPatch({
            ...commonPatchRequest,
            ignoredCachePaths:
              state.materialized.fixtureCapability.ignoredCachePaths,
            fixtureCapability: state.materialized.fixtureCapability,
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

export interface M1TaskHostContext {
  readonly workspaceDirectory: string;
  readonly piSessionDirectory: string;
}

export function getM1TaskHostContext(
  environment: M1TaskEnvironment,
): M1TaskHostContext {
  const state = requireEnvironmentState(environment);
  return Object.freeze({
    workspaceDirectory: state.layout.workspaceDirectory,
    piSessionDirectory: state.layout.piSessionDirectory,
  });
}

const cleanupM1TaskSandbox = (
  state: M1TaskEnvironmentState,
): Promise<SandboxCleanupReceiptV1> => {
  if (state.cleanupPromise !== undefined) return state.cleanupPromise;
  const attempt = (async () => {
    let cleanup: SandboxCleanupReceiptV1;
    try {
      cleanup = SandboxCleanupReceiptV1Schema.parse(
        await state.broker.cleanup(),
      );
      const completions = await Promise.allSettled([
        ...state.activeDuplexCompletions,
      ]);
      const rejected = completions.find(
        (completion) => completion.status === "rejected",
      );
      if (rejected?.status === "rejected") throw rejected.reason;
    } finally {
      await state.gate.drain();
    }
    if (!cleanupWasProven(cleanup)) {
      throw new M1Error(
        "artifact_write_failed",
        "Task sandbox cleanup could not be proven; Task records were retained",
      );
    }
    return cleanup;
  })();
  state.cleanupPromise = attempt;
  void attempt.catch(() => {
    if (state.cleanupPromise === attempt) state.cleanupPromise = undefined;
  });
  return attempt;
};

export function suspendM1Task(
  environment: M1TaskEnvironment,
): Promise<SandboxCleanupReceiptV1> {
  const state = requireEnvironmentState(environment);
  if (state.suspendPromise !== undefined) return state.suspendPromise;
  state.gate.close();
  const attempt = (async () => {
    try {
      const cleanup = await cleanupM1TaskSandbox(state);
      await state.store.append(
        environment.task.taskId,
        "task-events.jsonl",
        {
          schemaVersion: 1,
          taskId: environment.task.taskId,
          kind: "suspended",
          occurredAt: state.dependencies.now(),
          policyId: environment.policy.policyId,
        },
        (value) => M1TaskEventV1Schema.parse(value),
      );
      return cleanup;
    } catch (error) {
      throw normalizeError(
        error,
        "artifact_write_failed",
        state.sensitiveValues,
      );
    }
  })();
  state.suspendPromise = attempt;
  void attempt.catch(() => {
    if (state.suspendPromise === attempt) state.suspendPromise = undefined;
  });
  return attempt;
}

export function discardM1Task(
  environment: M1TaskEnvironment,
): Promise<SandboxCleanupReceiptV1> {
  const state = requireEnvironmentState(environment);
  if (state.discardPromise !== undefined) return state.discardPromise;
  state.gate.close();
  const attempt = (async () => {
    try {
      const cleanup = await cleanupM1TaskSandbox(state);
      if (!state.runtimeRecordsDiscarded) {
        await assertCompleteTaskRootIsOwned(
          environment.task.taskId,
          state.layout,
          state,
        );
        await state.runtimeStore.discard(environment.task.taskId);
        state.runtimeRecordsDiscarded = true;
      }
      if (!state.recordsDiscarded) {
        await assertCompleteTaskRootIsOwned(
          environment.task.taskId,
          state.layout,
          state,
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
