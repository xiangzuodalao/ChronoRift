import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import {
  isAbsolute,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  JsonValueSchema,
  M6AdapterBuildCompatibilityReceiptV1Schema,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentPinnedCaptureV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  asSha256DigestV1,
  asTaskId,
  asWorkspaceId,
  type JsonValue,
  type M6AdapterBuildCompatibilityLineageV1,
  type M6AdapterBuildCompatibilityReceiptV1,
  type ProjectEnvironmentPinnedCaptureV1,
  type ProjectEnvironmentRuntimeObservationReceiptV1,
  type Sha256DigestV1,
  type VNextBuildV1,
} from "@chronorift/domain";
import { canonicalJson, contentHash } from "@chronorift/json-artifacts";
import type { ProjectEnvironmentGameToolPort } from "@chronorift/pi-harness";

import { SecurityEventV1Schema, type SecurityEventV1 } from "./contracts.js";
import {
  ExternalHiddenFixPublicTaskSpecV1Schema,
  type ExternalHiddenFixPublicTaskSpecV1,
} from "./external-hidden-fix-assignment.js";
import type { LocalExternalHiddenFixPatchStoreV1 } from "./external-hidden-fix-evaluator.js";
import {
  ExternalHiddenFixHostSourceObservationV1Schema,
  ExternalHiddenFixPublicExecutionEvidenceV1Schema,
  type ExternalHiddenFixHostSourceObservationV1,
  type ExternalHiddenFixPublicExecutionEvidenceV1,
} from "./external-hidden-fix-workflow.js";
import {
  createM6AdapterBuildCompatibilityLineageV1,
  runM6AdapterBuildCompatibilityV1,
} from "./m6-adapter-build-compatibility.js";
import {
  prepareM6ExactGodotBuildV1,
  type PreparedM6ExactGodotBuildV1,
} from "./m6-exact-godot-build.js";
import { createM6AdmittedGameToolsV1 } from "./m6-one-turn-agent.js";
import type { PreparedM6ProjectEnvironmentOneTurnTaskV1 } from "./m6-project-environment-one-turn.js";
import {
  M7_R3_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1,
  M7R3TaskStorageHeadroomReceiptV1Schema,
  M7R3RuntimeEvidenceReceiptV1Schema,
  createM7R3CodingToolSurfaceV1,
  createM7R3EvaluatorHeadroomReceiptV1,
  createM7R3RuntimeTrajectoryExecutionMaterialV1,
  prepareM7R3ProjectEnvironmentPairedAgentPortV1,
  type M7R3PreparedCodeOnlyArmV1,
  type M7R3PreparedRuntimeArmV1,
  type M7R3TaskStorageHeadroomReceiptV1,
  type M7R3RuntimeEvidenceReceiptV1,
  type M7R3RuntimeTrajectoryExecutionMaterialV1,
} from "./m7-r3-project-environment-paired-agent.js";
import {
  M7R3AgentDeliveryTraceV1Schema,
  type M7R3AgentDeliveryTraceV1,
} from "./m7-r3-agent-delivery.js";
import { publishPrivateFileOnceV1 } from "./private-atomic-publication.js";
import {
  M7R3CaseCampaignAdmissionV1Schema,
  type M7R3CaseCampaignAdmissionV1,
} from "./m7-r3-case-admission.js";
import {
  M7R3AgentAttemptEvidenceSidecarV1Schema,
  M7R3PairedAgentInputV1Schema,
  M7R3PairedCaseContractV1Schema,
  createM7R3PairedAgentProtocolV1,
  createM7R3NeutralRuntimeResourceAppendixV1,
  runM7R3PairedAgentArmOnceV1,
  type M7R3PairedAgentAttemptRecordV1,
  type M7R3PairedAgentInputV1,
  type M7R3PairedAgentProtocolV1,
  type M7R3PairedCaseContractV1,
} from "./m7-r3-paired-agent.js";
import {
  M7R3LocalArmAdmissionV1Schema,
  M7R3LocalArmRunEnvelopeV1Schema,
  type M7R3LocalArmRunEnvelopeV1,
  type M7R3RuntimeUsePairedArmPortV1,
} from "./m7-r3-runtime-use-local-gate.js";
import {
  M7PatrolTrajectoryClassifierConfigV1Schema,
  M7R3PatrolTrajectoryCaseSpecV1Schema,
  type M7PatrolTrajectoryClassifierConfigV1,
  type M7R3PatrolTrajectoryCaseSpecV1,
} from "./m7-patrol-trajectory.js";
import {
  createM7RuntimeResourceMapV1,
  type M7AgentArmIsolationV1,
  type M7PairedAgentBudgetV1,
} from "./m7-paired-agent.js";
import { deriveM7RuntimeTreatmentExclusiveTargetsV1 } from "./m7-project-environment-paired-preparation.js";
import { GodotProjectEnvironmentSidecarPortV1 } from "./project-environment-sidecar-port.js";
import {
  ProjectEnvironmentGameRuntimeV1,
  type ProjectEnvironmentGameRuntimeOptionsV1,
  type ProjectEnvironmentRuntimeBuildV1,
} from "./project-environment-game-runtime.js";
import { readProjectEnvironmentHostConfigV1 } from "./project-environment-host-config.js";
import {
  createDuplexBwrapCgroupTaskSandbox,
  type DuplexTaskSandboxBrokerV1,
} from "./sandbox-broker.js";
import { createSandboxPolicyV1 } from "./sandbox-policy.js";
import {
  assertSandboxTaskStorageHeadroomV1,
  createSandboxTaskRuntimeRoot,
  preflightSandboxHost,
  type SandboxTaskStorageHeadroomV1,
} from "./sandbox-preflight.js";
import { inspectSandboxToolchain } from "./sandbox-toolchain.js";
import {
  createProjectEnvironmentTaskDirectoryLayout,
  type ProjectEnvironmentTaskDirectoryLayout,
} from "./task-paths.js";
import {
  materializePrivateTaskWorkspace,
  type MaterializedProjectEnvironmentWorkspaceV1,
} from "./workspace-materializer.js";
import {
  ProjectEnvironmentPreparationInfrastructureErrorV1,
  ProjectEnvironmentPreparationResourceOwnerV1,
} from "./preparation-resource-owner.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;

const digestJson = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(JsonValueSchema.parse(value)));

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(JsonValueSchema.parse(left)) ===
  canonicalJson(JsonValueSchema.parse(right));

const pathWithinOrEqual = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
};

const requireFreshCanonicalDirectory = async (
  path: string,
  label: string,
): Promise<string> => {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    (await realpath(path)) !== path
  ) {
    throw new TypeError(`${label} must be a canonical absolute directory`);
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError(`${label} must be a real directory`);
  }
  if ((await readdir(path)).length !== 0) {
    throw new TypeError(`${label} must be fresh and empty`);
  }
  return path;
};

const assertDisjoint = (
  entries: readonly { readonly label: string; readonly path: string }[],
): void => {
  for (const [index, left] of entries.entries()) {
    for (const right of entries.slice(index + 1)) {
      if (
        pathWithinOrEqual(left.path, right.path) ||
        pathWithinOrEqual(right.path, left.path)
      ) {
        throw new TypeError(
          `${left.label} and ${right.label} must be disjoint`,
        );
      }
    }
  }
};

const cleanupComplete = (receipt: {
  readonly processGroupTerminated: boolean;
  readonly cgroupPopulated: boolean;
  readonly scopeRemoved: boolean;
  readonly storageReconciled?: boolean | undefined;
}): boolean =>
  receipt.processGroupTerminated &&
  !receipt.cgroupPopulated &&
  receipt.scopeRemoved &&
  receipt.storageReconciled === true;

export interface M7R3ImmutableRecordWriterV1 {
  writeOnce(
    kind: string,
    payload: JsonValue,
    expectedLogicalContentSha256?: Sha256DigestV1,
  ): Promise<Sha256DigestV1>;
  readOnce(kind: string): Promise<JsonValue>;
  readOptional(kind: string): Promise<JsonValue | null>;
  appendSecurityEvent(event: SecurityEventV1): Promise<void>;
}

interface DurableRootIdentityV1 {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
}

const effectiveUserId = (): number => {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw new Error("M7 R3 durable records require effective-user checks");
  }
  return uid;
};

const requireDurableRoot = async (
  inputPath: string,
  label: string,
  requireEmpty: boolean,
): Promise<{
  readonly path: string;
  readonly identity: DurableRootIdentityV1;
}> => {
  const path = resolve(inputPath);
  if (
    !isAbsolute(inputPath) ||
    inputPath !== path ||
    path === parsePath(path).root
  ) {
    throw new TypeError(`${label} must be a canonical non-root absolute path`);
  }
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    metadata.uid !== effectiveUserId() ||
    (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new TypeError(
      `${label} must be current-user owned canonical mode-0700 directory`,
    );
  }
  if (requireEmpty && (await readdir(path)).length !== 0) {
    throw new TypeError(`${label} must be fresh and empty`);
  }
  return {
    path,
    identity: {
      dev: metadata.dev,
      ino: metadata.ino,
      uid: metadata.uid,
      mode: metadata.mode,
    },
  };
};

class M7R3PrivateRecordWriterV1 implements M7R3ImmutableRecordWriterV1 {
  readonly #writtenKinds = new Set<string>();
  #securityEventCount = 0;
  #securityTailSha256: Sha256DigestV1 | null = null;
  #securityAppendTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly root: string,
    private readonly taskId: string,
    private readonly rootIdentity: DurableRootIdentityV1,
  ) {}

  public static async open(input: {
    readonly root: string;
    readonly taskId: string;
    readonly requireEmpty: boolean;
  }): Promise<M7R3PrivateRecordWriterV1> {
    const root = await requireDurableRoot(
      input.root,
      `M7 R3 ${input.taskId} durable record root`,
      input.requireEmpty,
    );
    return new M7R3PrivateRecordWriterV1(
      root.path,
      input.taskId,
      root.identity,
    );
  }

  async #requireRoot(): Promise<void> {
    const current = await requireDurableRoot(
      this.root,
      `M7 R3 ${this.taskId} durable record root`,
      false,
    );
    if (
      current.identity.dev !== this.rootIdentity.dev ||
      current.identity.ino !== this.rootIdentity.ino ||
      current.identity.uid !== this.rootIdentity.uid ||
      current.identity.mode !== this.rootIdentity.mode
    ) {
      throw new Error("M7 R3 durable record root identity changed");
    }
  }

  static #kind(kind: string): string {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(kind)) {
      throw new TypeError("M7 R3 record kind is invalid");
    }
    return kind;
  }

  public async writeOnce(
    untrustedKind: string,
    untrustedPayload: JsonValue,
    expectedLogicalContentSha256?: Sha256DigestV1,
  ): Promise<Sha256DigestV1> {
    const kind = M7R3PrivateRecordWriterV1.#kind(untrustedKind);
    if (this.#writtenKinds.has(kind)) {
      throw new Error(`M7 R3 ${kind} record may be persisted only once`);
    }
    this.#writtenKinds.add(kind);
    await this.#requireRoot();
    if (
      (await readdir(this.root)).some((name) => name.startsWith(`${kind}-`))
    ) {
      throw new Error(`M7 R3 ${kind} durable record already exists`);
    }
    const payload = JsonValueSchema.parse(untrustedPayload);
    const fullCanonicalSha256 = digestJson(payload);
    const record =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? payload
        : null;
    const embeddedLogicalIdentity =
      typeof record?.recordContentSha256 === "string"
        ? asSha256DigestV1(record.recordContentSha256)
        : null;
    const logicalContentSha256 =
      expectedLogicalContentSha256 ??
      embeddedLogicalIdentity ??
      fullCanonicalSha256;
    if (
      expectedLogicalContentSha256 !== undefined &&
      embeddedLogicalIdentity !== null &&
      embeddedLogicalIdentity !== expectedLogicalContentSha256
    ) {
      throw new TypeError(
        `M7 R3 ${kind} record crossed its embedded logical identity`,
      );
    }
    if (
      expectedLogicalContentSha256 !== undefined &&
      embeddedLogicalIdentity === null &&
      expectedLogicalContentSha256 !== fullCanonicalSha256
    ) {
      throw new TypeError(
        `M7 R3 ${kind} record has no verifiable logical identity`,
      );
    }
    const bytes = Buffer.from(`${canonicalJson(payload)}\n`, "utf8");
    if (bytes.byteLength > MAX_RECORD_BYTES) {
      throw new Error(`M7 R3 ${kind} record exceeds its byte limit`);
    }
    const filename = `${kind}-${logicalContentSha256}-${fullCanonicalSha256}.json`;
    await publishPrivateFileOnceV1({ root: this.root, filename, bytes });
    return logicalContentSha256;
  }

  async #read(
    untrustedKind: string,
    optional: boolean,
  ): Promise<JsonValue | null> {
    const kind = M7R3PrivateRecordWriterV1.#kind(untrustedKind);
    await this.#requireRoot();
    const prefix = `${kind}-`;
    const names = (await readdir(this.root)).filter(
      (name) => name.startsWith(prefix) && name.endsWith(".json"),
    );
    if (names.length === 0 && optional) return null;
    if (names.length !== 1) {
      throw new Error(
        `M7 R3 ${kind} durable record cardinality is ${String(names.length)}`,
      );
    }
    const name = names[0]!;
    const match = new RegExp(
      `^${kind}-([a-f0-9]{64})-([a-f0-9]{64})\\.json$`,
      "u",
    ).exec(name);
    if (match === null) {
      throw new Error(`M7 R3 ${kind} durable record name is invalid`);
    }
    const logicalContentSha256 = asSha256DigestV1(match[1]!);
    const expectedFullCanonicalSha256 = asSha256DigestV1(match[2]!);
    const path = resolve(this.root, name);
    if (!pathWithinOrEqual(this.root, path)) {
      throw new Error(`M7 R3 ${kind} durable record escaped its root`);
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const [metadata, pathMetadata, canonical] = await Promise.all([
        handle.stat(),
        lstat(path),
        realpath(path),
      ]);
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.uid !== effectiveUserId() ||
        (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
        metadata.size > MAX_RECORD_BYTES ||
        pathMetadata.isSymbolicLink() ||
        pathMetadata.dev !== metadata.dev ||
        pathMetadata.ino !== metadata.ino ||
        canonical !== path
      ) {
        throw new Error(`M7 R3 ${kind} durable record identity changed`);
      }
      const bytes = await handle.readFile();
      let parsed: JsonValue;
      try {
        parsed = JsonValueSchema.parse(
          JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
        );
      } catch (error) {
        throw new Error(`M7 R3 ${kind} durable record is invalid JSON`, {
          cause: error,
        });
      }
      if (
        digestJson(parsed) !== expectedFullCanonicalSha256 ||
        !Buffer.from(`${canonicalJson(parsed)}\n`, "utf8").equals(bytes)
      ) {
        throw new Error(`M7 R3 ${kind} durable record bytes changed`);
      }
      const record =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? parsed
          : null;
      if (
        typeof record?.recordContentSha256 === "string" &&
        asSha256DigestV1(record.recordContentSha256) !== logicalContentSha256
      ) {
        throw new Error(`M7 R3 ${kind} logical identity changed`);
      }
      if (
        typeof record?.recordContentSha256 !== "string" &&
        logicalContentSha256 !== expectedFullCanonicalSha256
      ) {
        throw new Error(`M7 R3 ${kind} logical identity changed`);
      }
      return parsed;
    } finally {
      await handle.close();
    }
  }

  public readOnce(kind: string): Promise<JsonValue> {
    return this.#read(kind, false).then((value) => {
      if (value === null) throw new Error(`M7 R3 ${kind} record is missing`);
      return value;
    });
  }

  public readOptional(kind: string): Promise<JsonValue | null> {
    return this.#read(kind, true);
  }

  public appendSecurityEvent(eventInput: SecurityEventV1): Promise<void> {
    const event = SecurityEventV1Schema.parse(eventInput);
    if (event.taskId !== this.taskId) {
      return Promise.reject(
        new TypeError("M7 R3 security event crossed its Task"),
      );
    }
    this.#securityAppendTail = this.#securityAppendTail.then(async () => {
      if (this.#securityEventCount >= 1_000) {
        throw new Error("M7 R3 security-event retention budget exhausted");
      }
      this.#securityEventCount += 1;
      const basis = JsonValueSchema.parse({
        schemaVersion: 1,
        recordKind: "m7-r3-sandbox-security-event-projection",
        taskId: event.taskId,
        ordinal: this.#securityEventCount,
        eventId: event.eventId,
        operationId: event.operationId,
        decision: event.decision,
        code: event.code,
        occurredAt: event.occurredAt,
        sideEffectStarted: event.sideEffectStarted,
        messageSha256: digestJson(event.message),
        targetSha256: digestJson(event.target),
        sourceEventSha256: digestJson(event),
        previousRecordContentSha256: this.#securityTailSha256,
      });
      const recordContentSha256 = digestJson(basis);
      const record = JsonValueSchema.parse({
        ...(basis as Record<string, JsonValue>),
        recordContentSha256,
      });
      await this.writeOnce(
        `security-event-${String(this.#securityEventCount).padStart(6, "0")}`,
        record,
        recordContentSha256,
      );
      this.#securityTailSha256 = recordContentSha256;
    });
    return this.#securityAppendTail;
  }
}

const createRecordWriter = async (
  root: string,
  taskId: string,
): Promise<M7R3ImmutableRecordWriterV1> =>
  M7R3PrivateRecordWriterV1.open({ root, taskId, requireEmpty: true });

export const openM7R3DurableRecordStoreV1 = (input: {
  readonly root: string;
  readonly taskId: string;
}): Promise<M7R3ImmutableRecordWriterV1> =>
  createRecordWriter(input.root, input.taskId);

export const reopenM7R3DurableRecordStoreV1 = (input: {
  readonly root: string;
  readonly taskId: string;
}): Promise<M7R3ImmutableRecordWriterV1> =>
  M7R3PrivateRecordWriterV1.open({
    root: input.root,
    taskId: input.taskId,
    requireEmpty: false,
  });

interface M7R3GameRuntimeV1 extends ProjectEnvironmentGameToolPort {
  adapterBuildCompatibilityIdentity(): ReturnType<
    ProjectEnvironmentGameRuntimeV1["adapterBuildCompatibilityIdentity"]
  >;
  close(): Promise<void>;
}

export interface M7R3PreparedCodeOnlyTaskV1 {
  readonly taskId: ReturnType<typeof asTaskId>;
  readonly workspaceId: ReturnType<typeof asWorkspaceId>;
  readonly layout: ProjectEnvironmentTaskDirectoryLayout;
  readonly workspace: MaterializedProjectEnvironmentWorkspaceV1;
  readonly broker: DuplexTaskSandboxBrokerV1;
  readonly policyProfileSha256: Sha256DigestV1;
  readonly sandboxInstanceSha256: Sha256DigestV1;
  readonly codingToolchainTargets: readonly string[];
  readonly agentResourceDirectory: string;
  readonly records: M7R3ImmutableRecordWriterV1;
  readonly assertTaskStorageHeadroom: () => Promise<SandboxTaskStorageHeadroomV1>;
}

const CODING_TOOLCHAIN_COMMANDS = Object.freeze([
  { target: "/bin/bash", hostConfigKey: "bashPath" as const },
  { target: "/usr/bin/rg", hostConfigKey: "rgPath" as const },
  { target: "/usr/bin/find", hostConfigKey: "findPath" as const },
  { target: "/usr/bin/ls", hostConfigKey: "lsPath" as const },
]);

interface M7R3CodeOnlyPreparationDependenciesV1 {
  readonly readHostConfig: typeof readProjectEnvironmentHostConfigV1;
  readonly createRuntimeRoot: typeof createSandboxTaskRuntimeRoot;
  readonly preflightSandbox: typeof preflightSandboxHost;
  readonly createLayout: typeof createProjectEnvironmentTaskDirectoryLayout;
  readonly materializeWorkspace: typeof materializePrivateTaskWorkspace;
  readonly inspectToolchain: typeof inspectSandboxToolchain;
  readonly createBroker: typeof createDuplexBwrapCgroupTaskSandbox;
}

const DEFAULT_CODE_ONLY_DEPENDENCIES: M7R3CodeOnlyPreparationDependenciesV1 = {
  readHostConfig: readProjectEnvironmentHostConfigV1,
  createRuntimeRoot: createSandboxTaskRuntimeRoot,
  preflightSandbox: preflightSandboxHost,
  createLayout: createProjectEnvironmentTaskDirectoryLayout,
  materializeWorkspace: materializePrivateTaskWorkspace,
  inspectToolchain: inspectSandboxToolchain,
  createBroker: createDuplexBwrapCgroupTaskSandbox,
};

/**
 * Creates the actual code-only Task. The broker options intentionally omit
 * `managedRuntime`; only the four ordinary coding binaries are inspected and
 * mounted. The frozen Adapter package and Godot treatment never enter this
 * broker's physical namespace.
 */
export async function prepareM7R3CodeOnlyTaskFromM6RuntimeTaskV1(
  input: {
    readonly runtimeTask: PreparedM6ProjectEnvironmentOneTurnTaskV1;
    readonly codeOnlyTaskId: string;
    readonly agentResourceDirectory: string;
    readonly durableRecords: M7R3ImmutableRecordWriterV1;
    readonly hostConfigPath?: string | undefined;
  },
  overrides: Partial<M7R3CodeOnlyPreparationDependenciesV1> = {},
): Promise<M7R3PreparedCodeOnlyTaskV1> {
  const dependencies = { ...DEFAULT_CODE_ONLY_DEPENDENCIES, ...overrides };
  const hostConfig = await dependencies.readHostConfig(input.hostConfigPath);
  const runtimeRoot = await dependencies.createRuntimeRoot(
    hostConfig.taskStorageRoot,
    hostConfig.runtimeRoot,
  );
  const sandbox = await dependencies.preflightSandbox({
    delegatedCgroupRoot: hostConfig.delegatedCgroupRoot,
    bwrapPath: hostConfig.bwrapPath,
    prlimitPath: hostConfig.prlimitPath,
    busyboxPath: hostConfig.busyboxPath,
    taskStorageRoot: hostConfig.taskStorageRoot,
  });
  if (sandbox.kind !== "supported") {
    throw new Error("M7 R3 code-only sandbox preflight failed");
  }
  if (
    sandbox.capability.taskStorage === undefined ||
    sandbox.binding.taskStorageRoot === undefined
  ) {
    throw new Error("M7 R3 code-only sandbox omitted bounded Task storage");
  }
  const taskStorageCapability = sandbox.capability.taskStorage;
  const taskStorageRoot = sandbox.binding.taskStorageRoot;
  const taskId = asTaskId(input.codeOnlyTaskId);
  if (taskId === input.runtimeTask.taskId) {
    throw new TypeError("M7 R3 arms require distinct Task identities");
  }
  const workspaceId = asWorkspaceId(`workspace.v1.${taskId}`);
  const layout = await dependencies.createLayout({
    runtimeRoot,
    sourceRepositoryRoot:
      input.runtimeTask.assignment.mutatedSource.repositoryRoot,
    taskId,
  });
  const owner = new ProjectEnvironmentPreparationResourceOwnerV1(layout);
  let stage = "workspace";
  try {
    const workspace = await dependencies.materializeWorkspace({
      taskId,
      source: input.runtimeTask.assignment.mutatedSource,
      layout,
    });
    const expectedBaseline =
      input.runtimeTask.assignment.assignment.mutatedBaselineSelectedTreeSha256;
    if (workspace.receipt.selectedTreeSha256 !== expectedBaseline) {
      throw new Error("M7 R3 code-only workspace changed from mutant baseline");
    }
    stage = "toolchain";
    const codingToolchain = await dependencies.inspectToolchain({
      lddPath: hostConfig.lddPath,
      commands: CODING_TOOLCHAIN_COMMANDS.map((command) => ({
        target: command.target,
        hostPath: hostConfig[command.hostConfigKey],
      })),
    });
    const policy = createSandboxPolicyV1(sandbox.capability.runtimeIdentity, {
      toolchainId: codingToolchain.capability.toolchainId,
      targets: codingToolchain.capability.files.map((file) => file.target),
    });
    stage = "broker";
    const broker = await dependencies.createBroker({
      taskId,
      capability: sandbox.capability,
      hostBinding: sandbox.binding,
      policy,
      toolchain: codingToolchain,
      layout,
      securityEvents: (event) =>
        input.durableRecords.appendSecurityEvent(event),
    });
    owner.adoptBroker(broker);
    stage = "agent_resource";
    const agentResourceDirectory = await requireFreshCanonicalDirectory(
      input.agentResourceDirectory,
      "M7 R3 code-only Agent resource directory",
    );
    const codingProfile = JsonValueSchema.parse({
      schemaVersion: 1,
      runtimeIdentity: policy.runtimeIdentity,
      writableTargets: policy.writableTargets,
      namespaces: policy.namespaces,
      network: policy.network,
      copiedEnvironmentKeys: policy.copiedEnvironmentKeys,
      resourceLimits: policy.profiles["coding-default"],
      toolchainId: policy.toolchainId,
      managedRuntimeId: null,
      workspaceAccess: "read-write",
      readonlyTargets: policy.readonlyTargets,
    });
    const prepared = Object.freeze({
      taskId,
      workspaceId,
      layout,
      workspace,
      broker,
      policyProfileSha256: digestJson(codingProfile),
      sandboxInstanceSha256: digestJson({
        schemaVersion: 1,
        taskId,
        policyId: policy.policyId,
        workspaceReceipt: workspace.receipt,
      }),
      codingToolchainTargets: Object.freeze(
        codingToolchain.capability.files.map((file) => file.target),
      ),
      agentResourceDirectory,
      records: input.durableRecords,
      assertTaskStorageHeadroom: () =>
        assertSandboxTaskStorageHeadroomV1(
          taskStorageCapability,
          taskStorageRoot,
        ),
    });
    owner.release();
    return prepared;
  } catch (error) {
    if (stage === "broker") owner.adoptBrokerSetupCleanupFailure(error);
    throw new ProjectEnvironmentPreparationInfrastructureErrorV1(
      `m7-r3-code-only:${stage}`,
      await owner.cleanupAfterFailure(),
      error,
    );
  }
}

const runtimeBuild = (
  prepared: PreparedM6ExactGodotBuildV1,
): ProjectEnvironmentRuntimeBuildV1 =>
  Object.freeze({
    schemaVersion: 1,
    buildId: prepared.build.buildId,
    sourceClosureId: prepared.build.sourceId,
    candidateSourceHash: prepared.build.sourceHash,
    expectedMainScene: prepared.configuredMainScene,
  });

const sameBuildClosure = (left: VNextBuildV1, right: VNextBuildV1): boolean =>
  left.taskId === right.taskId &&
  left.workspaceId === right.workspaceId &&
  left.sourceId === right.sourceId &&
  left.buildId === right.buildId &&
  left.sourceHash === right.sourceHash &&
  left.workspaceDiffHash === right.workspaceDiffHash &&
  left.buildConfigurationHash === right.buildConfigurationHash &&
  left.outputHash === right.outputHash;

export interface M7R3RuntimePreparationDependenciesV1 {
  readonly prepareBuild: typeof prepareM6ExactGodotBuildV1;
  readonly runCompatibility: typeof runM6AdapterBuildCompatibilityV1;
  readonly createRuntime: (
    options: ProjectEnvironmentGameRuntimeOptionsV1,
  ) => M7R3GameRuntimeV1;
  readonly createSidecar: (
    options: ConstructorParameters<
      typeof GodotProjectEnvironmentSidecarPortV1
    >[0],
  ) => ProjectEnvironmentGameRuntimeOptionsV1["sidecar"];
}

const DEFAULT_RUNTIME_DEPENDENCIES: M7R3RuntimePreparationDependenciesV1 = {
  prepareBuild: prepareM6ExactGodotBuildV1,
  runCompatibility: runM6AdapterBuildCompatibilityV1,
  createRuntime: (options) => new ProjectEnvironmentGameRuntimeV1(options),
  createSidecar: (options) => new GodotProjectEnvironmentSidecarPortV1(options),
};

export interface M7R3PreparedRuntimeSurfaceV1 {
  readonly baseline: PreparedM6ExactGodotBuildV1;
  readonly baselineCompatibilityReceipt: M6AdapterBuildCompatibilityReceiptV1;
  readonly surface: M7R3PreparedRuntimeArmV1["runtime"];
}

export const prepareM7R3RuntimeSurfaceFromM6TaskV1 = async (input: {
  readonly task: PreparedM6ProjectEnvironmentOneTurnTaskV1;
  readonly records: M7R3ImmutableRecordWriterV1;
  readonly pristineAdapterConformanceReceiptSha256: Sha256DigestV1;
  readonly dependencies: M7R3RuntimePreparationDependenciesV1;
}): Promise<M7R3PreparedRuntimeSurfaceV1> => {
  const { task } = input;
  const adapterRevision = ProjectAdapterRevisionV1Schema.parse(
    task.assignment.adapterRevision,
  );
  const baselineSourceHash =
    task.assignment.assignment.mutatedBaselineSelectedTreeSha256;
  const builds = new Map<string, PreparedM6ExactGodotBuildV1>();
  const compatibilityReceipts = new Map<
    string,
    M6AdapterBuildCompatibilityReceiptV1
  >();
  const runtimeReceipts: ProjectEnvironmentRuntimeObservationReceiptV1[] = [];
  const sourceObservations: ExternalHiddenFixHostSourceObservationV1[] = [];
  const captures = new Map<
    string,
    Array<{
      readonly capture: ProjectEnvironmentPinnedCaptureV1;
      readonly records: readonly JsonValue[];
    }>
  >();

  const freezeCurrentBuild = async (): Promise<PreparedM6ExactGodotBuildV1> => {
    const prepared = await input.dependencies.prepareBuild({
      taskId: task.taskId,
      workspaceId: task.workspaceId,
      workspaceDirectory: task.workspace.workspaceDirectory,
      baselineSourceHash,
      adapterRevision,
      toolchainReceiptId: task.toolchainReceiptId,
      toolchainArtifactDigest: task.toolchain.executableSha256,
      runtimeIdentity: task.runtimeIdentity,
      policyProfileDigest: task.policyProfileDigest,
      now: task.now(),
    });
    builds.set(prepared.build.buildId, prepared);
    return prepared;
  };

  const createRuntime = (options: {
    readonly prepared: PreparedM6ExactGodotBuildV1;
    readonly persistAgentEvidence: boolean;
    readonly resolveCompatibleBuild?:
      (() => Promise<ProjectEnvironmentRuntimeBuildV1>) | undefined;
  }): M7R3GameRuntimeV1 => {
    const persistPinnedCapture = options.persistAgentEvidence
      ? async (
          captureInput: ProjectEnvironmentPinnedCaptureV1,
          recordInputs: readonly JsonValue[],
        ): Promise<void> => {
          const capture =
            ProjectEnvironmentPinnedCaptureV1Schema.parse(captureInput);
          const records = recordInputs.map((record) =>
            JsonValueSchema.parse(record),
          );
          const prepared = builds.get(capture.buildId);
          const compatibility = compatibilityReceipts.get(capture.buildId);
          if (
            prepared === undefined ||
            compatibility === undefined ||
            capture.taskId !== task.taskId ||
            capture.adapterRevisionId !== adapterRevision.adapterRevisionId ||
            capture.environmentRevisionId !==
              task.internalAdapterOverlayNamespace
          ) {
            throw new Error("M7 R3 pinned capture crossed runtime lineage");
          }
          await task.taskStore.putPinnedCaptureOnce(capture, records);
          const prior = captures.get(capture.executionId) ?? [];
          prior.push(
            Object.freeze({ capture, records: Object.freeze(records) }),
          );
          captures.set(capture.executionId, prior);
        }
      : undefined;
    const persistRuntimeObservation = options.persistAgentEvidence
      ? async (
          receiptInput: ProjectEnvironmentRuntimeObservationReceiptV1,
        ): Promise<void> => {
          const receipt =
            ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse(
              receiptInput,
            );
          const prepared = builds.get(receipt.buildId);
          const compatibility = compatibilityReceipts.get(receipt.buildId);
          if (
            prepared === undefined ||
            compatibility === undefined ||
            receipt.taskId !== task.taskId ||
            receipt.adapterRevisionId !== adapterRevision.adapterRevisionId ||
            receipt.environmentRevisionId !==
              task.internalAdapterOverlayNamespace
          ) {
            throw new Error(
              "M7 R3 runtime receipt crossed exact Build compatibility lineage",
            );
          }
          await task.taskStore.putRuntimeObservationReceiptOnce(receipt);
          runtimeReceipts.push(receipt);
        }
      : undefined;
    const runtimeOptions: ProjectEnvironmentGameRuntimeOptionsV1 = {
      sidecar: input.dependencies.createSidecar({
        broker: task.broker,
        managedRuntime: task.managedRuntime,
      }),
      managedRuntime: task.managedRuntime.capability,
      adapterPackage: task.assignment.adapterPackage,
      capabilitySet: adapterRevision.capabilitySet,
      taskId: task.taskId,
      sourceClosureId: options.prepared.build.sourceId,
      environmentRevisionId: task.internalAdapterOverlayNamespace,
      adapterRevisionId: adapterRevision.adapterRevisionId,
      buildId: options.prepared.build.buildId,
      candidateSourceHash: options.prepared.build.sourceHash,
      expectedMainScene: options.prepared.configuredMainScene,
      adapterManifestSha256: task.assignment.adapterPackage.manifestSha256,
      sdkSha256: task.managedRuntime.sdkDigest,
      bridgeSha256: task.managedRuntime.bridgeDigest,
      toolchainSha256: task.toolchain.executableSha256,
      engineVersion: task.managedRuntime.capability.engineVersion,
      ...(options.resolveCompatibleBuild === undefined
        ? {}
        : { resolveCompatibleBuild: options.resolveCompatibleBuild }),
      ...(persistPinnedCapture === undefined ? {} : { persistPinnedCapture }),
      ...(persistRuntimeObservation === undefined
        ? {}
        : { persistRuntimeObservation }),
      now: task.now,
    };
    return input.dependencies.createRuntime(runtimeOptions);
  };

  const runCompatibility = async (
    prepared: PreparedM6ExactGodotBuildV1,
    buildRole: "assignment_baseline" | "candidate",
  ): Promise<M6AdapterBuildCompatibilityReceiptV1> => {
    const current = await freezeCurrentBuild();
    if (!sameBuildClosure(prepared.build, current.build)) {
      throw new Error(
        "M7 R3 compatibility detached from current workspace bytes",
      );
    }
    const lineage: M6AdapterBuildCompatibilityLineageV1 =
      createM6AdapterBuildCompatibilityLineageV1({
        adapterRevision,
        build: prepared.build,
        baselineSourceHash,
        buildRole,
        toolchainReceiptId: task.toolchainReceiptId,
        toolchainArtifactDigest: task.toolchain.executableSha256,
      });
    const result = await input.dependencies.runCompatibility({
      lineage,
      runtime: createRuntime({
        prepared,
        persistAgentEvidence: false,
      }),
      launchTargetId: task.launchTargetId,
      now: task.now,
    });
    const receipt = M6AdapterBuildCompatibilityReceiptV1Schema.parse(
      result.receipt,
    );
    if (receipt.outcome !== "compatible") {
      throw new Error("M7 R3 exact Build failed Adapter compatibility");
    }
    if (
      receipt.lineage.buildRole !== buildRole ||
      !sameBuildClosure(receipt.lineage.build, prepared.build)
    ) {
      throw new TypeError(
        "M7 R3 compatibility receipt crossed exact Build role",
      );
    }
    compatibilityReceipts.set(prepared.build.buildId, receipt);
    await input.records.writeOnce(
      buildRole === "assignment_baseline"
        ? "compatibility-baseline"
        : `compatibility-candidate-${digestJson(prepared.build).slice(0, 24)}`,
      JsonValueSchema.parse(receipt),
      digestJson(receipt),
    );
    return receipt;
  };

  const baseline = await freezeCurrentBuild();
  if (baseline.build.sourceHash !== baselineSourceHash) {
    throw new Error("M7 R3 runtime Build is not the registered mutant");
  }
  const baselineCompatibilityReceipt = await runCompatibility(
    baseline,
    "assignment_baseline",
  );
  sourceObservations.push(
    ExternalHiddenFixHostSourceObservationV1Schema.parse({
      schemaVersion: 1,
      boundary: "game_build_freeze",
      sourceSha256: baseline.build.sourceHash,
      buildId: baseline.build.buildId,
      observedAt: task.now(),
    }),
  );

  const resolveCompatibleBuild =
    async (): Promise<ProjectEnvironmentRuntimeBuildV1> => {
      const prepared = await freezeCurrentBuild();
      if (!compatibilityReceipts.has(prepared.build.buildId)) {
        await runCompatibility(prepared, "candidate");
      }
      if (
        prepared.build.sourceHash !== baselineSourceHash &&
        !sourceObservations.some(
          (entry) => entry.buildId === prepared.build.buildId,
        )
      ) {
        sourceObservations.push(
          ExternalHiddenFixHostSourceObservationV1Schema.parse({
            schemaVersion: 1,
            boundary: "game_build_freeze",
            sourceSha256: prepared.build.sourceHash,
            buildId: prepared.build.buildId,
            observedAt: task.now(),
          }),
        );
      }
      return runtimeBuild(prepared);
    };

  const agentRuntime = createRuntime({
    prepared: baseline,
    persistAgentEvidence: true,
    resolveCompatibleBuild,
  });
  let evidenceRead = false;
  let runtimeEvidencePersisted = false;
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= agentRuntime.close();
    return closed;
  };

  const readAgentEvidence: M7R3PreparedRuntimeArmV1["runtime"]["readAgentEvidence"] =
    async (request) => {
      if (evidenceRead) {
        throw new Error("M7 R3 runtime evidence may be frozen only once");
      }
      evidenceRead = true;
      if (
        request.baselineSelectedTreeSha256 !== baselineSourceHash ||
        request.agentDeliveryTraceRecordSha256 !==
          request.deliveryTrace.recordContentSha256
      ) {
        throw new TypeError(
          "M7 R3 evidence read crossed baseline or delivery trace",
        );
      }
      const materials: M7R3RuntimeTrajectoryExecutionMaterialV1[] = [];
      const executions: ExternalHiddenFixPublicExecutionEvidenceV1[] = [];
      for (const receipt of runtimeReceipts) {
        const compatibility = compatibilityReceipts.get(receipt.buildId);
        if (compatibility === undefined) {
          throw new Error("M7 R3 runtime receipt lost exact compatibility");
        }
        const material = createM7R3RuntimeTrajectoryExecutionMaterialV1({
          adapterBuildCompatibilityReceipt: compatibility,
          runtimeObservationReceipt: receipt,
        });
        materials.push(material);
        executions.push(
          ExternalHiddenFixPublicExecutionEvidenceV1Schema.parse({
            schemaVersion: 1,
            executionId: receipt.executionId,
            buildId: receipt.buildId,
            sourceSha256: compatibility.lineage.build.sourceHash,
            startedAt: receipt.startedAt,
            endedAt: receipt.completedAt,
            sealed: true,
            coverageComplete: material.coverageComplete,
            cleanupProven: material.cleanup.proven,
            publicSymptomObserved: false,
            publicObservationSha256: digestJson({
              schemaVersion: 1,
              kind: "m7-r3-unclassified-runtime-observation",
              runtimeObservationReceiptSha256:
                material.runtimeObservationReceiptSha256,
            }),
          }),
        );
      }
      const backendProjection = JsonValueSchema.parse({
        schemaVersion: 1,
        recordKind: "m7-r3-runtime-backend-projection",
        baselineBuild: baseline.build,
        baselineCompatibilityReceipt,
        exchangeTranscriptSha256: request.exchangeTranscriptSha256,
        agentDeliveryTraceRecordSha256: request.agentDeliveryTraceRecordSha256,
        sourceObservations,
        trajectoryMaterials: materials,
        captures: [...captures.entries()].map(([executionId, entries]) => ({
          executionId,
          entries,
        })),
      });
      const receiptSha256 = await input.records.writeOnce(
        "runtime-backend-projection",
        backendProjection,
      );
      return Object.freeze({
        sourceObservations: Object.freeze([...sourceObservations]),
        executions: Object.freeze(executions),
        trajectoryMaterials: Object.freeze(materials),
        agentDeliveryTraceRecordSha256: request.agentDeliveryTraceRecordSha256,
        receiptSha256,
      });
    };

  return Object.freeze({
    baseline,
    baselineCompatibilityReceipt,
    surface: Object.freeze({
      pristineAdapterRevision: adapterRevision,
      pristineAdapterConformanceReceiptSha256:
        input.pristineAdapterConformanceReceiptSha256,
      adapterMutantCompatibilityReceiptSha256: digestJson(
        baselineCompatibilityReceipt,
      ),
      resourceMap: createM7RuntimeResourceMapV1({
        schemaVersion: 1,
        taskId: task.taskId,
        baselineBuildId: baseline.build.buildId,
        baselineSourceId: baseline.build.sourceId,
        launchTargetId: task.launchTargetId,
      }),
      gameToolPort: agentRuntime,
      persistRuntimeEvidenceReceiptOnce: async (
        recordInput: M7R3RuntimeEvidenceReceiptV1,
      ): Promise<Sha256DigestV1> => {
        if (runtimeEvidencePersisted) {
          throw new Error(
            "M7 R3 strict runtime evidence may be persisted only once",
          );
        }
        runtimeEvidencePersisted = true;
        const record = M7R3RuntimeEvidenceReceiptV1Schema.parse(recordInput);
        return input.records.writeOnce(
          "runtime-agent-evidence",
          JsonValueSchema.parse(record),
          record.recordContentSha256,
        );
      },
      close,
      readAgentEvidence,
    }),
  });
};

const armReadableSurfaces = (runtimeEnabled: boolean) => ({
  chronoriftGameTools: runtimeEnabled,
  publicRuntimeRecordsThroughGameTools: runtimeEnabled,
  projectAdapterPackage: false as const,
  rawGodotExecutable: false as const,
  hiddenAssignmentStore: false as const,
  hiddenMutationOrEvaluator: false as const,
  otherArmPatchOrRecords: false as const,
});

const samePublicTaskContract = (
  runtimeTask: ExternalHiddenFixPublicTaskSpecV1,
  codeOnlyTask: ExternalHiddenFixPublicTaskSpecV1,
): boolean => {
  const { taskId: _runtimeId, ...runtimeCommon } = runtimeTask;
  const { taskId: _codeOnlyId, ...codeOnlyCommon } = codeOnlyTask;
  void _runtimeId;
  void _codeOnlyId;
  return sameJson(runtimeCommon, codeOnlyCommon);
};

const derivedAgentBudget = (
  task: ExternalHiddenFixPublicTaskSpecV1,
): M7PairedAgentBudgetV1 => ({
  schemaVersion: 1,
  attemptsMaximum: 1,
  userTurnsPerAttemptMaximum: 1,
  toolCallsMaximum: task.agentBudget.toolCallsMaximum,
  wallTimeMsMaximum: task.agentBudget.wallTimeMsMaximum,
  taskSandboxNetworkMode: "denied",
  taskCredentialMountCountMaximum: 0,
});

export interface M7R3PreparationRegistrationInputsV1 {
  readonly schemaVersion: 1;
  readonly baselineBuild: VNextBuildV1;
  readonly baselineSelectedTreeSha256: Sha256DigestV1;
  readonly adapterMutantCompatibilityReceipt: M6AdapterBuildCompatibilityReceiptV1;
  readonly adapterMutantCompatibilityReceiptSha256: Sha256DigestV1;
  readonly runtimeArmPublicTaskSpecSha256: Sha256DigestV1;
  readonly codeOnlyArmPublicTaskSpecSha256: Sha256DigestV1;
  readonly codingTools: ReturnType<typeof createM7R3CodingToolSurfaceV1>;
  readonly codingToolSetSha256: Sha256DigestV1;
  readonly sandboxPolicySha256: Sha256DigestV1;
  readonly validatedGameToolSetSha256: Sha256DigestV1;
  readonly runtimeResourceAppendixSha256: Sha256DigestV1;
  readonly runtimeBrokerSecurityEventRetention: "unavailable_legacy_m6";
  readonly codeOnlyBrokerSecurityEventRetention: "durable_hash_chain";
  readonly runtimeIsolation: M7AgentArmIsolationV1;
  readonly codeOnlyIsolation: M7AgentArmIsolationV1;
  readonly pristineAdapterConformanceReceiptSha256: Sha256DigestV1;
  readonly hostModelRuntimeConfigSha256: Sha256DigestV1;
}

export interface M7R3BoundProjectEnvironmentPreparationV1 {
  readonly pairedInput: M7R3PairedAgentInputV1;
  readonly runtimeArm: M7R3PreparedRuntimeArmV1;
  readonly codeOnlyArm: M7R3PreparedCodeOnlyArmV1;
  readonly armPort: M7R3RuntimeUsePairedArmPortV1;
  readonly retainedEvidence: {
    readDeliveryTrace(
      arm: "runtime_enabled" | "code_only",
    ): Promise<M7R3AgentDeliveryTraceV1 | null>;
    readRuntimeEvidenceReceipt(): Promise<M7R3RuntimeEvidenceReceiptV1 | null>;
    readAttemptSidecar(
      arm: "runtime_enabled" | "code_only",
    ): Promise<ReturnType<
      typeof M7R3AgentAttemptEvidenceSidecarV1Schema.parse
    > | null>;
    readSandboxSentinelReceipt(
      arm: "runtime_enabled" | "code_only",
    ): Promise<JsonValue | null>;
    readCleanupReceipt(
      arm: "runtime_enabled" | "code_only",
    ): Promise<JsonValue | null>;
  };
  readRetainedEnvelope(
    arm: "runtime_enabled" | "code_only",
  ): Promise<M7R3LocalArmRunEnvelopeV1>;
  cleanupRemainingAfterFailure(): Promise<M7R3PreparationCleanupTruthV1>;
  hasAgentStarted(): boolean;
  persistInfrastructureFailureOnce(
    input: M7R3PreparationInfrastructureFailureInputV1,
  ): Promise<Sha256DigestV1>;
}

export interface M7R3PreparationCleanupTruthV1 {
  readonly cleanupProven: boolean;
  readonly cleanupReceiptSha256: Sha256DigestV1 | null;
  readonly sandboxSafetyFailure: boolean;
  readonly sandboxSafetyReceiptSha256: Sha256DigestV1 | null;
}

export class M7R3ProjectEnvironmentPreparationInfrastructureErrorV1 extends Error {
  public override readonly name =
    "M7R3ProjectEnvironmentPreparationInfrastructureErrorV1";
  public readonly cleanup: M7R3PreparationCleanupTruthV1;

  public constructor(cleanup: M7R3PreparationCleanupTruthV1, cause: unknown) {
    super("M7 R3 Project Environment preparation failed", { cause });
    if (
      typeof cleanup.cleanupProven !== "boolean" ||
      typeof cleanup.sandboxSafetyFailure !== "boolean" ||
      cleanup.cleanupProven !== (cleanup.cleanupReceiptSha256 !== null)
    ) {
      throw new TypeError("M7 R3 preparation cleanup truth is invalid");
    }
    this.cleanup = Object.freeze({
      cleanupProven: cleanup.cleanupProven,
      cleanupReceiptSha256:
        cleanup.cleanupReceiptSha256 === null
          ? null
          : asSha256DigestV1(cleanup.cleanupReceiptSha256),
      sandboxSafetyFailure: cleanup.sandboxSafetyFailure,
      sandboxSafetyReceiptSha256:
        cleanup.sandboxSafetyReceiptSha256 === null
          ? null
          : asSha256DigestV1(cleanup.sandboxSafetyReceiptSha256),
    });
  }
}

export interface M7R3FailedPreparationCleanupResultV1 {
  readonly cleanup: M7R3PreparationCleanupTruthV1;
  readonly cleanupFailures: readonly unknown[];
}

/**
 * Closes only resources whose acquisition state is known. A nested M6 owner
 * error is accepted as typed cleanup truth; an unknown in-flight failure is
 * deliberately left unproven.
 */
export async function cleanupM7R3FailedPreparationResourcesV1(input: {
  readonly runtimeBroker: Pick<DuplexTaskSandboxBrokerV1, "cleanup">;
  readonly codeOnlyTask?:
    Pick<M7R3PreparedCodeOnlyTaskV1, "broker"> | undefined;
  readonly runtimePrepared?:
    Pick<M7R3PreparedRuntimeSurfaceV1, "surface"> | undefined;
  readonly codeOnlyPreparationStarted: boolean;
  readonly runtimeSurfacePreparationStarted: boolean;
  readonly error: unknown;
}): Promise<M7R3FailedPreparationCleanupResultV1> {
  const cleanupFailures: unknown[] = [];
  const runtimeSurfaceCleanupRequired =
    input.runtimePrepared !== undefined ||
    input.runtimeSurfacePreparationStarted;
  let runtimeSurfaceCleanupAttempted = false;
  let runtimeSurfaceCleanupComplete = !runtimeSurfaceCleanupRequired;
  if (input.runtimePrepared !== undefined) {
    runtimeSurfaceCleanupAttempted = true;
    try {
      await input.runtimePrepared.surface.close();
      runtimeSurfaceCleanupComplete = true;
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  let runtimeBrokerCleanupComplete = false;
  let runtimeBrokerCleanupReceiptSha256: Sha256DigestV1 | null = null;
  try {
    const receipt = await input.runtimeBroker.cleanup();
    runtimeBrokerCleanupComplete = cleanupComplete(receipt);
    runtimeBrokerCleanupReceiptSha256 = digestJson(receipt);
    if (!runtimeBrokerCleanupComplete) {
      cleanupFailures.push(new Error("runtime cleanup incomplete"));
    }
  } catch (error) {
    cleanupFailures.push(error);
  }

  const nestedCodeOnlyCleanup =
    input.error instanceof ProjectEnvironmentPreparationInfrastructureErrorV1
      ? input.error.cleanup
      : null;
  const codeOnlyCleanupRequired =
    input.codeOnlyTask !== undefined || input.codeOnlyPreparationStarted;
  let codeOnlyCleanupAttempted = false;
  let codeOnlyCleanupComplete = !codeOnlyCleanupRequired;
  let codeOnlyCleanupReceiptSha256: Sha256DigestV1 | null = null;
  if (input.codeOnlyTask !== undefined) {
    codeOnlyCleanupAttempted = true;
    try {
      const receipt = await input.codeOnlyTask.broker.cleanup();
      codeOnlyCleanupComplete = cleanupComplete(receipt);
      codeOnlyCleanupReceiptSha256 = digestJson(receipt);
      if (!codeOnlyCleanupComplete) {
        cleanupFailures.push(new Error("code-only cleanup incomplete"));
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
  } else if (
    input.codeOnlyPreparationStarted &&
    nestedCodeOnlyCleanup !== null
  ) {
    try {
      codeOnlyCleanupAttempted =
        nestedCodeOnlyCleanup.sandboxCleanupAttempted ||
        nestedCodeOnlyCleanup.taskRootRemovalAttempted;
      codeOnlyCleanupComplete = nestedCodeOnlyCleanup.cleanupProven;
      codeOnlyCleanupReceiptSha256 = digestJson(nestedCodeOnlyCleanup);
    } catch (error) {
      codeOnlyCleanupComplete = false;
      cleanupFailures.push(error);
    }
  }

  const cleanupProven =
    cleanupFailures.length === 0 &&
    runtimeBrokerCleanupComplete &&
    runtimeSurfaceCleanupComplete &&
    codeOnlyCleanupComplete;
  const cleanupBasis = JsonValueSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-failed-preparation-cleanup-summary",
    runtimeBroker: {
      required: true,
      attempted: true,
      complete: runtimeBrokerCleanupComplete,
      receiptSha256: runtimeBrokerCleanupReceiptSha256,
    },
    runtimeSurface: {
      required: runtimeSurfaceCleanupRequired,
      attempted: runtimeSurfaceCleanupAttempted,
      complete: runtimeSurfaceCleanupComplete,
    },
    codeOnly: {
      required: codeOnlyCleanupRequired,
      attempted: codeOnlyCleanupAttempted,
      complete: codeOnlyCleanupComplete,
      receiptSha256: codeOnlyCleanupReceiptSha256,
    },
    cleanupProven,
  });
  return Object.freeze({
    cleanup: Object.freeze({
      cleanupProven,
      cleanupReceiptSha256: cleanupProven ? digestJson(cleanupBasis) : null,
      sandboxSafetyFailure: false,
      sandboxSafetyReceiptSha256: null,
    }),
    cleanupFailures: Object.freeze([...cleanupFailures]),
  });
}

export type M7R3PreparationInfrastructureFailureStageV1 =
  | "durable_store"
  | "code_only_task"
  | "baseline_compatibility"
  | "case_binding"
  | "sandbox_sentinel"
  | "agent_attempt"
  | "cleanup"
  | "envelope_reopen";

export interface M7R3PreparationInfrastructureFailureInputV1 {
  readonly stage: M7R3PreparationInfrastructureFailureStageV1;
  /** Hash of a sanitized error class/name, never its message or path. */
  readonly errorClassSha256: Sha256DigestV1;
  readonly observedAt: string;
}

export interface M7R3PreparedProjectEnvironmentInfrastructureV1 {
  readonly schemaVersion: 1;
  readonly registrationInputs: M7R3PreparationRegistrationInputsV1;
  bindCaseOnce(input: {
    readonly caseContract: M7R3PairedCaseContractV1;
    readonly caseCampaignAdmission: M7R3CaseCampaignAdmissionV1;
  }): Promise<M7R3BoundProjectEnvironmentPreparationV1>;
  abortPreparation(): Promise<M7R3PreparationCleanupTruthV1>;
}

export interface PrepareM7R3ProjectEnvironmentInfrastructureV1Input {
  /** Ownership of this fresh M6 Task transfers to the R3 preparation. */
  readonly runtimeTask: PreparedM6ProjectEnvironmentOneTurnTaskV1;
  readonly codeOnlyPublicTask: ExternalHiddenFixPublicTaskSpecV1;
  readonly codeOnlyPublicTaskSpecSha256: Sha256DigestV1;
  readonly codeOnlyPatchStore: LocalExternalHiddenFixPatchStoreV1;
  readonly runtimeAgentResourceDirectory: string;
  readonly codeOnlyAgentResourceDirectory: string;
  /** Durable Host-owned storage; must not reside under task tmpfs. */
  readonly runtimeDurableRecordRoot: string;
  /** Durable Host-owned storage; must not reside under task tmpfs. */
  readonly codeOnlyDurableRecordRoot: string;
  readonly trajectoryClassifierConfig: M7PatrolTrajectoryClassifierConfigV1;
  readonly trajectoryCaseSpec: M7R3PatrolTrajectoryCaseSpecV1;
  readonly hostModelRuntimeConfigSha256: Sha256DigestV1;
  /**
   * Exact Host-only paths that this campaign additionally requires both
   * coding sandboxes to prove absent before an Agent starts. The paths are
   * hashed into the retained sentinel receipt and are never Agent content.
   */
  readonly additionalCodingSandboxSentinelForbiddenPaths?:
    readonly string[] | undefined;
  readonly hostConfigPath?: string | undefined;
}

interface M7R3PreparationDependenciesV1 extends M7R3RuntimePreparationDependenciesV1 {
  readonly prepareCodeOnlyTask: typeof prepareM7R3CodeOnlyTaskFromM6RuntimeTaskV1;
}

const DEFAULT_PREPARATION_DEPENDENCIES: M7R3PreparationDependenciesV1 = {
  ...DEFAULT_RUNTIME_DEPENDENCIES,
  prepareCodeOnlyTask: prepareM7R3CodeOnlyTaskFromM6RuntimeTaskV1,
};

/**
 * Production R3 two-stage preparation. Phase one freezes the exact mutant
 * Build compatibility needed by case construction; `bindCaseOnce` later
 * checks the immutable contract/admission and exposes the two concrete arms.
 * No Pi turn is started here and runtime evidence is never synthesized.
 */
export async function prepareM7R3ProjectEnvironmentInfrastructureV1(
  untrustedInput: PrepareM7R3ProjectEnvironmentInfrastructureV1Input,
  overrides: Partial<M7R3PreparationDependenciesV1> = {},
): Promise<M7R3PreparedProjectEnvironmentInfrastructureV1> {
  const input = untrustedInput;
  const dependencies = { ...DEFAULT_PREPARATION_DEPENDENCIES, ...overrides };
  const runtimeTask = input.runtimeTask;
  let codeOnlyTask: M7R3PreparedCodeOnlyTaskV1 | undefined;
  let runtimePrepared: M7R3PreparedRuntimeSurfaceV1 | undefined;
  let codeOnlyPreparationStarted = false;
  let runtimeSurfacePreparationStarted = false;
  try {
    const runtimePublicTask = ExternalHiddenFixPublicTaskSpecV1Schema.parse(
      runtimeTask.publicTask,
    );
    const codeOnlyPublicTask = ExternalHiddenFixPublicTaskSpecV1Schema.parse(
      input.codeOnlyPublicTask,
    );
    const trajectoryClassifierConfig =
      M7PatrolTrajectoryClassifierConfigV1Schema.parse(
        input.trajectoryClassifierConfig,
      );
    const trajectoryCaseSpec = M7R3PatrolTrajectoryCaseSpecV1Schema.parse(
      input.trajectoryCaseSpec,
    );
    const additionalCodingSandboxSentinelForbiddenPaths = Object.freeze([
      ...(input.additionalCodingSandboxSentinelForbiddenPaths ?? []),
    ]);
    if (
      additionalCodingSandboxSentinelForbiddenPaths.length > 16 ||
      new Set(additionalCodingSandboxSentinelForbiddenPaths).size !==
        additionalCodingSandboxSentinelForbiddenPaths.length ||
      additionalCodingSandboxSentinelForbiddenPaths.some(
        (path) =>
          typeof path !== "string" ||
          path.length === 0 ||
          path.length > 4_096 ||
          !isAbsolute(path) ||
          resolve(path) !== path,
      )
    ) {
      throw new TypeError(
        "M7 R3 additional coding-sandbox sentinel paths are invalid",
      );
    }
    if (
      runtimePublicTask.taskId !== runtimeTask.taskId ||
      codeOnlyPublicTask.taskId === runtimePublicTask.taskId ||
      !samePublicTaskContract(runtimePublicTask, codeOnlyPublicTask)
    ) {
      throw new TypeError(
        "M7 R3 public Tasks must differ only by fresh Task identity",
      );
    }
    if (
      trajectoryCaseSpec.classifierId !==
        trajectoryClassifierConfig.classifierId ||
      trajectoryCaseSpec.classifierConfigSha256 !==
        trajectoryClassifierConfig.configSha256
    ) {
      throw new TypeError("M7 R3 trajectory case crossed classifier config");
    }
    const runtimeAgentResourceDirectory = await requireFreshCanonicalDirectory(
      input.runtimeAgentResourceDirectory,
      "M7 R3 runtime Agent resource directory",
    );
    if (runtimeTask.agentDir !== runtimeAgentResourceDirectory) {
      throw new TypeError(
        "M7 R3 runtime Task did not bind the declared Agent cache",
      );
    }
    await requireFreshCanonicalDirectory(
      runtimeTask.layout.piSessionDirectory,
      "M7 R3 runtime Session directory",
    );
    const [runtimeRecords, codeOnlyRecords] = await Promise.all([
      createRecordWriter(input.runtimeDurableRecordRoot, runtimeTask.taskId),
      createRecordWriter(
        input.codeOnlyDurableRecordRoot,
        codeOnlyPublicTask.taskId,
      ),
    ]);
    codeOnlyPreparationStarted = true;
    codeOnlyTask = await dependencies.prepareCodeOnlyTask({
      runtimeTask,
      codeOnlyTaskId: codeOnlyPublicTask.taskId,
      agentResourceDirectory: input.codeOnlyAgentResourceDirectory,
      durableRecords: codeOnlyRecords,
      ...(input.hostConfigPath === undefined
        ? {}
        : { hostConfigPath: input.hostConfigPath }),
    });
    runtimeSurfacePreparationStarted = true;
    runtimePrepared = await prepareM7R3RuntimeSurfaceFromM6TaskV1({
      task: runtimeTask,
      records: runtimeRecords,
      pristineAdapterConformanceReceiptSha256:
        runtimeTask.assignment.agentProjection.adapter.conformanceReceiptSha256,
      dependencies,
    });
    const preparedCodeOnlyTask = codeOnlyTask;
    const preparedRuntime = runtimePrepared;
    const runtimeCodingTools = createM7R3CodingToolSurfaceV1(
      runtimeTask.broker,
    );
    const codeOnlyCodingTools = createM7R3CodingToolSurfaceV1(
      preparedCodeOnlyTask.broker,
    );
    if (!sameJson(runtimeCodingTools, codeOnlyCodingTools)) {
      throw new TypeError("M7 R3 paired coding tool definitions differ");
    }
    if (
      runtimeTask.codingSandboxProfileSha256 !==
      preparedCodeOnlyTask.policyProfileSha256
    ) {
      throw new TypeError(
        "M7 R3 runtime/code-only coding sandbox profiles differ",
      );
    }
    const baselineSelectedTreeSha256 =
      runtimeTask.assignment.assignment.mutatedBaselineSelectedTreeSha256;
    const runtimeIsolation: M7AgentArmIsolationV1 = {
      schemaVersion: 1,
      arm: "runtime_enabled",
      taskId: runtimeTask.taskId,
      workspaceHandle: runtimeTask.workspaceId,
      workspaceInstanceSha256: digestJson({
        taskId: runtimeTask.taskId,
        workspace: runtimeTask.workspace.receipt,
      }),
      sessionInstanceSha256: digestJson({
        taskId: runtimeTask.taskId,
        directory: runtimeTask.layout.piSessionDirectory,
      }),
      cacheInstanceSha256: digestJson({
        taskId: runtimeTask.taskId,
        directory: runtimeAgentResourceDirectory,
      }),
      sandboxInstanceSha256: digestJson({
        taskId: runtimeTask.taskId,
        sandboxRealization: runtimeTask.sandboxRealization,
      }),
      sandboxProfileSha256: runtimeTask.codingSandboxProfileSha256,
      workspaceBaselineSelectedTreeSha256: baselineSelectedTreeSha256,
      readableSurfaces: armReadableSurfaces(true),
    };
    const codeOnlyIsolation: M7AgentArmIsolationV1 = {
      schemaVersion: 1,
      arm: "code_only",
      taskId: preparedCodeOnlyTask.taskId,
      workspaceHandle: preparedCodeOnlyTask.workspaceId,
      workspaceInstanceSha256: digestJson({
        taskId: preparedCodeOnlyTask.taskId,
        workspace: preparedCodeOnlyTask.workspace.receipt,
      }),
      sessionInstanceSha256: digestJson({
        taskId: preparedCodeOnlyTask.taskId,
        directory: preparedCodeOnlyTask.layout.piSessionDirectory,
      }),
      cacheInstanceSha256: digestJson({
        taskId: preparedCodeOnlyTask.taskId,
        directory: preparedCodeOnlyTask.agentResourceDirectory,
      }),
      sandboxInstanceSha256: preparedCodeOnlyTask.sandboxInstanceSha256,
      sandboxProfileSha256: preparedCodeOnlyTask.policyProfileSha256,
      workspaceBaselineSelectedTreeSha256: baselineSelectedTreeSha256,
      readableSurfaces: armReadableSurfaces(false),
    };
    const disjointPaths = [
      {
        label: "runtime workspace",
        path: runtimeTask.workspace.workspaceDirectory,
      },
      {
        label: "runtime Session",
        path: runtimeTask.layout.piSessionDirectory,
      },
      { label: "runtime cache", path: runtimeAgentResourceDirectory },
      {
        label: "code-only workspace",
        path: preparedCodeOnlyTask.workspace.workspaceDirectory,
      },
      {
        label: "code-only Session",
        path: preparedCodeOnlyTask.layout.piSessionDirectory,
      },
      {
        label: "code-only cache",
        path: preparedCodeOnlyTask.agentResourceDirectory,
      },
      {
        label: "runtime durable records",
        path: input.runtimeDurableRecordRoot,
      },
      {
        label: "code-only durable records",
        path: input.codeOnlyDurableRecordRoot,
      },
    ];
    assertDisjoint(disjointPaths);
    for (const durable of [
      input.runtimeDurableRecordRoot,
      input.codeOnlyDurableRecordRoot,
    ]) {
      for (const ephemeralOrAuthority of [
        runtimeTask.layout.taskRecordDirectory,
        runtimeTask.layout.runtimeRecordDirectory,
        runtimeTask.layout.hostBaselineGitDirectory,
        runtimeTask.layout.hostOperationTemporaryDirectory,
        preparedCodeOnlyTask.layout.taskRecordDirectory,
        preparedCodeOnlyTask.layout.runtimeRecordDirectory,
        preparedCodeOnlyTask.layout.hostBaselineGitDirectory,
        preparedCodeOnlyTask.layout.hostOperationTemporaryDirectory,
        runtimeTask.assignment.protectedBaselineRoot,
        runtimeTask.assignment.pristineSource.repositoryRoot,
        runtimeTask.assignment.mutatedSource.repositoryRoot,
      ]) {
        if (
          pathWithinOrEqual(durable, ephemeralOrAuthority) ||
          pathWithinOrEqual(ephemeralOrAuthority, durable)
        ) {
          throw new TypeError(
            "M7 R3 durable records must be outside Task storage and source authorities",
          );
        }
      }
    }
    const forbiddenPaths = Object.freeze([
      ...deriveM7RuntimeTreatmentExclusiveTargetsV1(
        runtimeTask,
        preparedCodeOnlyTask.codingToolchainTargets,
      ),
      runtimeTask.assignment.protectedBaselineRoot,
      runtimeTask.assignment.pristineSource.repositoryRoot,
      runtimeTask.assignment.mutatedSource.repositoryRoot,
      runtimeTask.layout.taskRecordDirectory,
      runtimeTask.layout.runtimeRecordDirectory,
      runtimeTask.layout.hostBaselineGitDirectory,
      runtimeTask.layout.hostOperationTemporaryDirectory,
      preparedCodeOnlyTask.layout.taskRecordDirectory,
      preparedCodeOnlyTask.layout.runtimeRecordDirectory,
      preparedCodeOnlyTask.layout.hostBaselineGitDirectory,
      preparedCodeOnlyTask.layout.hostOperationTemporaryDirectory,
      input.runtimeDurableRecordRoot,
      input.codeOnlyDurableRecordRoot,
      ...additionalCodingSandboxSentinelForbiddenPaths,
    ]);
    if (new Set(forbiddenPaths).size !== forbiddenPaths.length) {
      throw new TypeError("M7 R3 coding-sandbox sentinel paths overlap");
    }
    const gameTools = createM6AdmittedGameToolsV1({
      adapterRevision: runtimeTask.assignment.adapterRevision,
      hostAdmittedToolNames: runtimeTask.hostAdmittedGameToolNames,
    });
    const adapterCompatibilityReceiptSha256 = digestJson(
      preparedRuntime.baselineCompatibilityReceipt,
    );
    const registrationInputs: M7R3PreparationRegistrationInputsV1 = {
      schemaVersion: 1,
      baselineBuild: preparedRuntime.baseline.build,
      baselineSelectedTreeSha256,
      adapterMutantCompatibilityReceipt:
        preparedRuntime.baselineCompatibilityReceipt,
      adapterMutantCompatibilityReceiptSha256:
        adapterCompatibilityReceiptSha256,
      runtimeArmPublicTaskSpecSha256:
        runtimeTask.assignment.agentProjection.publicTask.sha256,
      codeOnlyArmPublicTaskSpecSha256: input.codeOnlyPublicTaskSpecSha256,
      codingTools: runtimeCodingTools,
      codingToolSetSha256: digestJson(runtimeCodingTools),
      sandboxPolicySha256: runtimeTask.codingSandboxProfileSha256,
      validatedGameToolSetSha256: digestJson(gameTools),
      runtimeResourceAppendixSha256: digestJson(
        createM7R3NeutralRuntimeResourceAppendixV1(
          preparedRuntime.surface.resourceMap,
        ),
      ),
      runtimeBrokerSecurityEventRetention: "unavailable_legacy_m6",
      codeOnlyBrokerSecurityEventRetention: "durable_hash_chain",
      runtimeIsolation,
      codeOnlyIsolation,
      pristineAdapterConformanceReceiptSha256:
        runtimeTask.assignment.agentProjection.adapter.conformanceReceiptSha256,
      hostModelRuntimeConfigSha256: input.hostModelRuntimeConfigSha256,
    };

    let bound = false;
    let terminalized = false;
    const started = new Set<"runtime_enabled" | "code_only">();
    const cleanupRecordKinds = new Map<
      "runtime_enabled" | "code_only",
      "cleanup" | "unstarted-cleanup" | "recovery-cleanup"
    >();
    const markStarted = (arm: "runtime_enabled" | "code_only"): void => {
      if (terminalized || started.has(arm)) {
        throw new Error(`M7 R3 ${arm} Agent start is unavailable`);
      }
      started.add(arm);
    };
    let cleanupPromise: Promise<M7R3PreparationCleanupTruthV1> | undefined;
    const cleanupRemaining = (): Promise<M7R3PreparationCleanupTruthV1> => {
      terminalized = true;
      cleanupPromise ??= (async () => {
        const failures: unknown[] = [];
        if (!cleanupRecordKinds.has("runtime_enabled")) {
          const kind = started.has("runtime_enabled")
            ? "recovery-cleanup"
            : "unstarted-cleanup";
          cleanupRecordKinds.set("runtime_enabled", kind);
          let runtimeCloseCompleted = true;
          try {
            await preparedRuntime.surface.close();
          } catch (error) {
            runtimeCloseCompleted = false;
            failures.push(error);
          }
          try {
            const receipt = await runtimeTask.broker.cleanup();
            const sandboxCleanupComplete = cleanupComplete(receipt);
            const proven = runtimeCloseCompleted && sandboxCleanupComplete;
            await runtimeRecords.writeOnce(
              kind,
              JsonValueSchema.parse({
                schemaVersion: 1,
                arm: "runtime_enabled",
                agentStarted: started.has("runtime_enabled"),
                runtimeCloseCompleted,
                cleanup: receipt,
                proven,
                completedAt: runtimeTask.now(),
              }),
            );
            if (!sandboxCleanupComplete) {
              failures.push(new Error("runtime cleanup incomplete"));
            }
          } catch (error) {
            failures.push(error);
          }
        }
        if (!cleanupRecordKinds.has("code_only")) {
          const kind = started.has("code_only")
            ? "recovery-cleanup"
            : "unstarted-cleanup";
          cleanupRecordKinds.set("code_only", kind);
          try {
            const receipt = await preparedCodeOnlyTask.broker.cleanup();
            const proven = cleanupComplete(receipt);
            await preparedCodeOnlyTask.records.writeOnce(
              kind,
              JsonValueSchema.parse({
                schemaVersion: 1,
                arm: "code_only",
                agentStarted: started.has("code_only"),
                cleanup: receipt,
                proven,
                completedAt: runtimeTask.now(),
              }),
            );
            if (!proven) {
              failures.push(new Error("code-only cleanup incomplete"));
            }
          } catch (error) {
            failures.push(error);
          }
        }
        const runtimeCleanupKind = cleanupRecordKinds.get("runtime_enabled");
        const codeOnlyCleanupKind = cleanupRecordKinds.get("code_only");
        const [
          runtimeCleanup,
          codeOnlyCleanup,
          runtimeSentinel,
          codeOnlySentinel,
        ] = await Promise.all([
          runtimeCleanupKind !== undefined
            ? runtimeRecords.readOptional(runtimeCleanupKind).catch(() => null)
            : Promise.resolve(null),
          codeOnlyCleanupKind !== undefined
            ? preparedCodeOnlyTask.records
                .readOptional(codeOnlyCleanupKind)
                .catch(() => null)
            : Promise.resolve(null),
          runtimeRecords.readOptional("sandbox-sentinel").catch(() => null),
          preparedCodeOnlyTask.records
            .readOptional("sandbox-sentinel")
            .catch(() => null),
        ]);
        const proven = (value: JsonValue | null): boolean =>
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          value.proven === true;
        const sentinelFailed = (value: JsonValue | null): boolean =>
          value !== null &&
          (typeof value !== "object" ||
            Array.isArray(value) ||
            value.status !== "succeeded" ||
            value.exitCode !== 0);
        const cleanupProven =
          failures.length === 0 &&
          proven(runtimeCleanup) &&
          proven(codeOnlyCleanup);
        const sandboxSafetyFailure =
          sentinelFailed(runtimeSentinel) || sentinelFailed(codeOnlySentinel);
        const failureClassSha256s = failures.map((failure) =>
          digestJson(failure instanceof Error ? failure.name : typeof failure),
        );
        const cleanupBasis = JsonValueSchema.parse({
          schemaVersion: 1,
          recordKind: "m7-r3-preparation-cleanup-summary",
          runtimeCleanupReceiptSha256:
            runtimeCleanup === null ? null : digestJson(runtimeCleanup),
          codeOnlyCleanupReceiptSha256:
            codeOnlyCleanup === null ? null : digestJson(codeOnlyCleanup),
          cleanupProven,
          failureClassSha256s,
          completedAt: runtimeTask.now(),
        });
        const cleanupRecordContentSha256 = digestJson(cleanupBasis);
        let cleanupSummaryRetained = false;
        try {
          await runtimeRecords.writeOnce(
            "preparation-cleanup-summary",
            JsonValueSchema.parse({
              ...(cleanupBasis as Record<string, JsonValue>),
              recordContentSha256: cleanupRecordContentSha256,
            }),
            cleanupRecordContentSha256,
          );
          cleanupSummaryRetained = true;
        } catch {
          // Cleanup has still been attempted. Without a durable summary it is
          // unavailable as proof and the campaign coordinator retains the
          // surrounding infrastructure failure in its own Host store.
        }
        let sandboxSafetyReceiptSha256: Sha256DigestV1 | null = null;
        if (runtimeSentinel !== null || codeOnlySentinel !== null) {
          const safetyBasis = JsonValueSchema.parse({
            schemaVersion: 1,
            recordKind: "m7-r3-preparation-sandbox-safety-summary",
            runtimeSentinelReceiptSha256:
              runtimeSentinel === null ? null : digestJson(runtimeSentinel),
            codeOnlySentinelReceiptSha256:
              codeOnlySentinel === null ? null : digestJson(codeOnlySentinel),
            sandboxSafetyFailure,
            completedAt: runtimeTask.now(),
          });
          sandboxSafetyReceiptSha256 = digestJson(safetyBasis);
          try {
            await runtimeRecords.writeOnce(
              "preparation-sandbox-safety-summary",
              JsonValueSchema.parse({
                ...(safetyBasis as Record<string, JsonValue>),
                recordContentSha256: sandboxSafetyReceiptSha256,
              }),
              sandboxSafetyReceiptSha256,
            );
          } catch {
            sandboxSafetyReceiptSha256 = null;
          }
        }
        const durablyProven = cleanupProven && cleanupSummaryRetained;
        return Object.freeze({
          cleanupProven: durablyProven,
          cleanupReceiptSha256: durablyProven
            ? cleanupRecordContentSha256
            : null,
          sandboxSafetyFailure,
          sandboxSafetyReceiptSha256,
        });
      })();
      return cleanupPromise;
    };
    const persistDelivery = (
      records: M7R3ImmutableRecordWriterV1,
      recordInput: M7R3AgentDeliveryTraceV1,
    ): Promise<Sha256DigestV1> => {
      const record = M7R3AgentDeliveryTraceV1Schema.parse(recordInput);
      return records.writeOnce(
        "agent-delivery-trace",
        JsonValueSchema.parse(record),
        record.recordContentSha256,
      );
    };
    let infrastructureFailurePersisted = false;
    const persistInfrastructureFailureOnce = async (
      failure: M7R3PreparationInfrastructureFailureInputV1,
    ): Promise<Sha256DigestV1> => {
      const stages = new Set<M7R3PreparationInfrastructureFailureStageV1>([
        "durable_store",
        "code_only_task",
        "baseline_compatibility",
        "case_binding",
        "sandbox_sentinel",
        "agent_attempt",
        "cleanup",
        "envelope_reopen",
      ]);
      const errorClassSha256 = asSha256DigestV1(failure.errorClassSha256);
      if (
        infrastructureFailurePersisted ||
        !stages.has(failure.stage) ||
        !Number.isFinite(Date.parse(failure.observedAt))
      ) {
        throw new TypeError(
          "M7 R3 infrastructure failure is invalid or already retained",
        );
      }
      infrastructureFailurePersisted = true;
      const basis = JsonValueSchema.parse({
        schemaVersion: 1,
        recordKind: "m7-r3-preparation-infrastructure-failure",
        stage: failure.stage,
        errorClassSha256,
        observedAt: failure.observedAt,
      });
      const recordContentSha256 = digestJson(basis);
      return runtimeRecords.writeOnce(
        "infrastructure-failure",
        JsonValueSchema.parse({
          ...(basis as Record<string, JsonValue>),
          recordContentSha256,
        }),
        recordContentSha256,
      );
    };
    let boundProtocol: M7R3PairedAgentProtocolV1 | null = null;
    const evaluatorHeadroomOrdinals = new Map<
      "runtime_enabled" | "code_only",
      number
    >();
    const boundRequestFor = (arm: "runtime_enabled" | "code_only") => {
      if (boundProtocol === null) {
        throw new Error("M7 R3 headroom evidence cannot precede case binding");
      }
      return arm === "runtime_enabled"
        ? boundProtocol.runtimeRequest
        : boundProtocol.codeOnlyRequest;
    };
    const recordsFor = (
      arm: "runtime_enabled" | "code_only",
    ): M7R3ImmutableRecordWriterV1 =>
      arm === "runtime_enabled" ? runtimeRecords : preparedCodeOnlyTask.records;
    const persistTaskStorageHeadroomReceiptOnce = async (
      arm: "runtime_enabled" | "code_only",
      recordInput: M7R3TaskStorageHeadroomReceiptV1,
    ): Promise<Sha256DigestV1> => {
      const record = M7R3TaskStorageHeadroomReceiptV1Schema.parse(recordInput);
      const request = boundRequestFor(arm);
      if (
        record.arm !== arm ||
        record.campaignId !== request.campaignId ||
        record.portfolioId !== request.portfolioId ||
        record.caseId !== request.caseId ||
        record.pairedCaseContractContentSha256 !==
          request.pairedCaseContractContentSha256 ||
        record.taskId !== request.isolation.taskId ||
        record.attemptBindingContentSha256 !==
          request.attemptBinding.bindingContentSha256
      ) {
        throw new TypeError(
          `M7 R3 ${arm} headroom receipt crossed its exact case/attempt binding`,
        );
      }
      return recordsFor(arm).writeOnce(
        "task-storage-headroom",
        JsonValueSchema.parse(record),
        record.recordContentSha256,
      );
    };
    const persistEvaluatorHeadroomObservation = async (
      arm: "runtime_enabled" | "code_only",
      observation: Parameters<
        M7R3PreparedRuntimeArmV1["persistEvaluatorHeadroomObservation"]
      >[0],
    ): Promise<void> => {
      const request = boundRequestFor(arm);
      const expectedOrdinal = (evaluatorHeadroomOrdinals.get(arm) ?? 0) + 1;
      if (observation.runOrdinal !== expectedOrdinal) {
        throw new TypeError(
          `M7 R3 ${arm} evaluator headroom ordinal is not contiguous`,
        );
      }
      const record = createM7R3EvaluatorHeadroomReceiptV1({
        campaignId: request.campaignId,
        portfolioId: request.portfolioId,
        caseId: request.caseId,
        pairedCaseContractContentSha256:
          request.pairedCaseContractContentSha256,
        arm,
        taskId: request.isolation.taskId,
        attemptBindingContentSha256:
          request.attemptBinding.bindingContentSha256,
        runOrdinal: observation.runOrdinal,
        taskStorage: observation.taskStorage,
        evaluatorStorage: observation.evaluatorStorage,
        observedAt: observation.observedAt ?? runtimeTask.now(),
      });
      const retained = await recordsFor(arm).writeOnce(
        `evaluator-headroom-${String(expectedOrdinal).padStart(6, "0")}`,
        JsonValueSchema.parse(record),
        record.recordContentSha256,
      );
      if (retained !== record.recordContentSha256) {
        throw new Error(
          `M7 R3 ${arm} evaluator headroom crossed durable identity`,
        );
      }
      evaluatorHeadroomOrdinals.set(arm, expectedOrdinal);
    };
    const runtimeArm: M7R3PreparedRuntimeArmV1 = {
      arm: "runtime_enabled",
      isolation: runtimeIsolation,
      workspaceDirectory: runtimeTask.workspace.workspaceDirectory,
      sessionDirectory: runtimeTask.layout.piSessionDirectory,
      agentResourceDirectory: runtimeAgentResourceDirectory,
      broker: runtimeTask.broker,
      assertTaskStorageHeadroom: runtimeTask.assertTaskStorageHeadroom,
      persistTaskStorageHeadroomReceiptOnce: (record) =>
        persistTaskStorageHeadroomReceiptOnce("runtime_enabled", record),
      persistEvaluatorHeadroomObservation: (observation) =>
        persistEvaluatorHeadroomObservation("runtime_enabled", observation),
      codingSandboxSentinelForbiddenPaths: forbiddenPaths,
      patchHandoff: {
        hostBaselineGitDirectory:
          runtimeTask.workspace.hostBaselineGitDirectory,
        hostBaselineCommit: runtimeTask.workspace.hostBaselineCommit,
        hostOperationTemporaryDirectory:
          runtimeTask.layout.hostOperationTemporaryDirectory,
        ignoredCachePaths: [],
        patchStore: runtimeTask.patchStore,
      },
      now: runtimeTask.now,
      persistCleanupReceiptOnce: (record) => {
        cleanupRecordKinds.set("runtime_enabled", "cleanup");
        return runtimeRecords.writeOnce("cleanup", record);
      },
      persistSandboxSentinelReceiptOnce: (record) =>
        runtimeRecords.writeOnce("sandbox-sentinel", record),
      persistAgentDeliveryTraceOnce: (record) =>
        persistDelivery(runtimeRecords, record),
      markAgentStartedOnce: () => markStarted("runtime_enabled"),
      runtime: preparedRuntime.surface,
      trajectoryClassifierConfig,
      trajectoryCaseSpec,
    };
    const codeOnlyArm: M7R3PreparedCodeOnlyArmV1 = {
      arm: "code_only",
      isolation: codeOnlyIsolation,
      workspaceDirectory: preparedCodeOnlyTask.workspace.workspaceDirectory,
      sessionDirectory: preparedCodeOnlyTask.layout.piSessionDirectory,
      agentResourceDirectory: preparedCodeOnlyTask.agentResourceDirectory,
      broker: preparedCodeOnlyTask.broker,
      assertTaskStorageHeadroom: preparedCodeOnlyTask.assertTaskStorageHeadroom,
      persistTaskStorageHeadroomReceiptOnce: (record) =>
        persistTaskStorageHeadroomReceiptOnce("code_only", record),
      persistEvaluatorHeadroomObservation: (observation) =>
        persistEvaluatorHeadroomObservation("code_only", observation),
      codingSandboxSentinelForbiddenPaths: forbiddenPaths,
      patchHandoff: {
        hostBaselineGitDirectory:
          preparedCodeOnlyTask.workspace.hostBaselineGitDirectory,
        hostBaselineCommit: preparedCodeOnlyTask.workspace.hostBaselineCommit,
        hostOperationTemporaryDirectory:
          preparedCodeOnlyTask.layout.hostOperationTemporaryDirectory,
        ignoredCachePaths: [],
        patchStore: input.codeOnlyPatchStore,
      },
      now: runtimeTask.now,
      persistCleanupReceiptOnce: (record) => {
        cleanupRecordKinds.set("code_only", "cleanup");
        return preparedCodeOnlyTask.records.writeOnce("cleanup", record);
      },
      persistSandboxSentinelReceiptOnce: (record) =>
        preparedCodeOnlyTask.records.writeOnce("sandbox-sentinel", record),
      persistAgentDeliveryTraceOnce: (record) =>
        persistDelivery(preparedCodeOnlyTask.records, record),
      markAgentStartedOnce: () => markStarted("code_only"),
    };

    return Object.freeze({
      schemaVersion: 1,
      registrationInputs,
      bindCaseOnce: async ({
        caseContract,
        caseCampaignAdmission,
      }: {
        readonly caseContract: M7R3PairedCaseContractV1;
        readonly caseCampaignAdmission: M7R3CaseCampaignAdmissionV1;
      }) => {
        if (bound || terminalized) {
          throw new Error("M7 R3 preparation may bind only once");
        }
        const contract = M7R3PairedCaseContractV1Schema.parse(caseContract);
        const admission = M7R3CaseCampaignAdmissionV1Schema.parse(
          caseCampaignAdmission,
        );
        const agentBudget = derivedAgentBudget(runtimePublicTask);
        const adapterRevision = ProjectAdapterRevisionV1Schema.parse(
          runtimeTask.assignment.adapterRevision,
        );
        if (
          admission.recordContentSha256 !==
            caseCampaignAdmission.recordContentSha256 ||
          admission.portfolioId !== contract.portfolioId ||
          admission.caseId !== contract.caseId ||
          admission.caseOrdinal !== contract.caseOrdinal ||
          admission.pairedProtocol.pairedCaseContractContentSha256 !==
            contract.pairedCaseContractContentSha256 ||
          admission.adapterMutantCompatibilityReceiptSha256 !==
            adapterCompatibilityReceiptSha256 ||
          contract.adapterMutantCompatibilityReceiptSha256 !==
            adapterCompatibilityReceiptSha256 ||
          contract.mutatedBaselineSelectedTreeSha256 !==
            baselineSelectedTreeSha256 ||
          contract.naturalPrompt.text !== runtimePublicTask.goal ||
          contract.naturalPrompt.utf8Sha256 !== admission.prompt.utf8Sha256 ||
          contract.naturalPrompt.canonicalJsonSha256 !==
            admission.prompt.canonicalJsonSha256 ||
          contract.runtimeArmPublicTaskSpecSha256 !==
            registrationInputs.runtimeArmPublicTaskSpecSha256 ||
          contract.codeOnlyArmPublicTaskSpecSha256 !==
            registrationInputs.codeOnlyArmPublicTaskSpecSha256 ||
          contract.agentConfiguration.provider !==
            runtimePublicTask.agentBudget.provider ||
          contract.agentConfiguration.model !==
            runtimePublicTask.agentBudget.model ||
          contract.agentConfiguration.thinkingLevel !==
            runtimePublicTask.agentBudget.thinkingLevel ||
          contract.agentConfiguration.agentBudgetSha256 !==
            digestJson(agentBudget) ||
          contract.agentConfiguration.codingToolSetSha256 !==
            registrationInputs.codingToolSetSha256 ||
          contract.agentConfiguration.sandboxPolicySha256 !==
            registrationInputs.sandboxPolicySha256 ||
          contract.commonRuntimeMaterials.adapterRevisionSha256 !==
            digestJson(adapterRevision) ||
          contract.commonRuntimeMaterials.adapterPackageSha256 !==
            adapterRevision.packageDigest ||
          contract.commonRuntimeMaterials.adapterObservationSchemaSha256 !==
            adapterRevision.payloadSchemaDigest ||
          contract.commonRuntimeMaterials
            .pristineAdapterConformanceReceiptSha256 !==
            registrationInputs.pristineAdapterConformanceReceiptSha256 ||
          contract.commonRuntimeMaterials.validatedGameToolSetSha256 !==
            registrationInputs.validatedGameToolSetSha256 ||
          contract.commonRuntimeMaterials
            .commonEnvironmentInstructionsSha256 !==
            M7_R3_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1 ||
          contract.commonRuntimeMaterials.hostModelRuntimeConfigSha256 !==
            registrationInputs.hostModelRuntimeConfigSha256 ||
          !sameJson(
            contract.trajectoryClassifierConfig,
            trajectoryClassifierConfig,
          ) ||
          !sameJson(contract.trajectoryCaseSpec, trajectoryCaseSpec)
        ) {
          throw new TypeError(
            "M7 R3 case binding crossed frozen preparation inputs",
          );
        }
        bound = true;
        const pairedInput = M7R3PairedAgentInputV1Schema.parse({
          schemaVersion: 1,
          recordKind: "m7-r3-paired-agent-input",
          campaignId: admission.campaignId,
          caseCampaignAdmissionRecordSha256: admission.recordContentSha256,
          caseContract: contract,
          provider: runtimePublicTask.agentBudget.provider,
          model: runtimePublicTask.agentBudget.model,
          thinkingLevel: runtimePublicTask.agentBudget.thinkingLevel,
          agentBudget,
          codingTools: runtimeCodingTools,
          pristineAdapterRevision: adapterRevision,
          hostAdmittedGameToolNames: [...runtimeTask.hostAdmittedGameToolNames],
          runtimeResourceMap: preparedRuntime.surface.resourceMap,
          runtimeIsolation,
          codeOnlyIsolation,
        });
        const protocol: M7R3PairedAgentProtocolV1 =
          createM7R3PairedAgentProtocolV1(pairedInput);
        boundProtocol = protocol;
        const pairedPort = await prepareM7R3ProjectEnvironmentPairedAgentPortV1(
          {
            runtimeArm,
            codeOnlyArm,
          },
        );
        const armRecords = (
          arm: "runtime_enabled" | "code_only",
        ): M7R3ImmutableRecordWriterV1 =>
          arm === "runtime_enabled"
            ? runtimeRecords
            : preparedCodeOnlyTask.records;
        const armRequest = (arm: "runtime_enabled" | "code_only") =>
          arm === "runtime_enabled"
            ? protocol.runtimeRequest
            : protocol.codeOnlyRequest;
        const admissionSkeletonFor = (arm: "runtime_enabled" | "code_only") => {
          const request = armRequest(arm);
          const isolation = request.isolation;
          const eagerlyValidated = M7R3LocalArmAdmissionV1Schema.parse({
            schemaVersion: 1,
            recordKind: "m7-r3-local-arm-admission",
            arm,
            caseCampaignAdmissionRecordSha256: admission.recordContentSha256,
            pairedCaseContractContentSha256:
              contract.pairedCaseContractContentSha256,
            pairedAttemptBindingContentSha256:
              request.attemptBinding.bindingContentSha256,
            pairedAttemptBinding: request.attemptBinding,
            claim: {
              campaignId: admission.campaignId,
              arm,
              binding: {
                // The campaign claim binds the paired public contract. The
                // arm-specific Task spec remains in pairedAttemptBinding.
                publicTaskSpecSha256: contract.pairedPublicTaskContractSha256,
                provider: pairedInput.provider,
                model: pairedInput.model,
                thinkingLevel: pairedInput.thinkingLevel,
                agentBudgetSha256: digestJson(pairedInput.agentBudget),
                workspaceBaselineSelectedTreeSha256:
                  contract.mutatedBaselineSelectedTreeSha256,
                codingToolSetSha256: digestJson(pairedInput.codingTools),
                sandboxPolicySha256: isolation.sandboxProfileSha256,
              },
              taskId: isolation.taskId,
              sessionIdentitySha256: isolation.sessionInstanceSha256,
              workspaceIdentitySha256: isolation.workspaceInstanceSha256,
              cacheIdentitySha256: isolation.cacheInstanceSha256,
              // This value exists only to validate the invariant skeleton.
              // The released admission receives its actual Host time below.
              startedAt: "1970-01-01T00:00:00.000Z",
            },
          });
          const { startedAt: _validationTime, ...claim } =
            eagerlyValidated.claim;
          void _validationTime;
          return Object.freeze({
            schemaVersion: eagerlyValidated.schemaVersion,
            recordKind: eagerlyValidated.recordKind,
            arm: eagerlyValidated.arm,
            caseCampaignAdmissionRecordSha256:
              eagerlyValidated.caseCampaignAdmissionRecordSha256,
            pairedCaseContractContentSha256:
              eagerlyValidated.pairedCaseContractContentSha256,
            pairedAttemptBindingContentSha256:
              eagerlyValidated.pairedAttemptBindingContentSha256,
            pairedAttemptBinding: eagerlyValidated.pairedAttemptBinding,
            claim: Object.freeze(claim),
          });
        };
        const admissionSkeletons = Object.freeze({
          runtime_enabled: admissionSkeletonFor("runtime_enabled"),
          code_only: admissionSkeletonFor("code_only"),
        });
        type LocalArmAdmissionV1 = ReturnType<
          typeof M7R3LocalArmAdmissionV1Schema.parse
        >;
        const localAdmissions = new Map<
          "runtime_enabled" | "code_only",
          LocalArmAdmissionV1
        >();
        const releaseAdmission = (
          arm: "runtime_enabled" | "code_only",
        ): LocalArmAdmissionV1 => {
          if (terminalized) {
            throw new Error(`M7 R3 ${arm} admission is terminalized`);
          }
          if (localAdmissions.has(arm)) {
            throw new Error(`M7 R3 ${arm} admission may be released only once`);
          }
          const skeleton = admissionSkeletons[arm];
          const released = M7R3LocalArmAdmissionV1Schema.parse({
            ...skeleton,
            claim: {
              ...skeleton.claim,
              // Gate calls this immediately before beginArmOnce. In
              // particular, code-only is not timestamped during case bind.
              startedAt: runtimeTask.now(),
            },
          });
          localAdmissions.set(arm, released);
          return released;
        };
        const readDeliveryTrace = async (
          arm: "runtime_enabled" | "code_only",
        ): Promise<M7R3AgentDeliveryTraceV1 | null> => {
          const value = await armRecords(arm).readOptional(
            "agent-delivery-trace",
          );
          return value === null
            ? null
            : M7R3AgentDeliveryTraceV1Schema.parse(value);
        };
        const readRuntimeEvidenceReceipt =
          async (): Promise<M7R3RuntimeEvidenceReceiptV1 | null> => {
            const value = await runtimeRecords.readOptional(
              "runtime-agent-evidence",
            );
            return value === null
              ? null
              : M7R3RuntimeEvidenceReceiptV1Schema.parse(value);
          };
        const readAttemptSidecar = async (
          arm: "runtime_enabled" | "code_only",
        ) => {
          const value = await armRecords(arm).readOptional("attempt-sidecar");
          return value === null
            ? null
            : M7R3AgentAttemptEvidenceSidecarV1Schema.parse(value);
        };
        const readRetainedEnvelope = async (
          arm: "runtime_enabled" | "code_only",
        ): Promise<M7R3LocalArmRunEnvelopeV1> =>
          M7R3LocalArmRunEnvelopeV1Schema.parse(
            await armRecords(arm).readOnce("local-arm-envelope"),
          );
        const armPort: M7R3RuntimeUsePairedArmPortV1 = Object.freeze({
          getArmAdmission: (
            arm: "runtime_enabled" | "code_only",
          ): Promise<unknown> =>
            Promise.resolve().then(() => releaseAdmission(arm)),
          runArmOnce: async (
            requestInput: Parameters<
              M7R3RuntimeUsePairedArmPortV1["runArmOnce"]
            >[0],
          ): Promise<unknown> => {
            const request = JsonValueSchema.parse(requestInput) as unknown as {
              readonly schemaVersion: 1;
              readonly campaignId: string;
              readonly arm: "runtime_enabled" | "code_only";
              readonly campaignClaimContentSha256: Sha256DigestV1;
              readonly pairedAttemptBindingContentSha256: Sha256DigestV1;
              readonly caseCampaignAdmissionRecordSha256: Sha256DigestV1;
              readonly pairedCaseContractContentSha256: Sha256DigestV1;
            };
            const localAdmission = localAdmissions.get(request.arm);
            if (localAdmission === undefined) {
              throw new Error(
                `M7 R3 ${request.arm} run cannot precede Gate admission release`,
              );
            }
            if (
              request.schemaVersion !== 1 ||
              request.campaignId !== admission.campaignId ||
              request.caseCampaignAdmissionRecordSha256 !==
                admission.recordContentSha256 ||
              request.pairedCaseContractContentSha256 !==
                contract.pairedCaseContractContentSha256 ||
              request.pairedAttemptBindingContentSha256 !==
                localAdmission.pairedAttemptBindingContentSha256 ||
              asSha256DigestV1(request.campaignClaimContentSha256) !==
                request.campaignClaimContentSha256
            ) {
              throw new TypeError(
                "M7 R3 Gate arm request crossed its frozen local admission",
              );
            }
            const records = armRecords(request.arm);
            await records.writeOnce(
              "gate-run-request",
              JsonValueSchema.parse(request),
            );
            const attempt: M7R3PairedAgentAttemptRecordV1 =
              await runM7R3PairedAgentArmOnceV1({
                request: armRequest(request.arm),
                port: pairedPort,
              });
            const sidecar = M7R3AgentAttemptEvidenceSidecarV1Schema.parse(
              attempt.attemptEvidence,
            );
            await records.writeOnce(
              "attempt-sidecar",
              JsonValueSchema.parse(sidecar),
              sidecar.recordContentSha256,
            );
            await records.writeOnce(
              "attempt-record",
              JsonValueSchema.parse(attempt),
            );
            const deliveryTrace = await readDeliveryTrace(request.arm);
            const runtimeEvidenceReceipt =
              request.arm === "runtime_enabled"
                ? await readRuntimeEvidenceReceipt()
                : null;
            const envelope = M7R3LocalArmRunEnvelopeV1Schema.parse({
              schemaVersion: 1,
              recordKind: "m7-r3-local-arm-run-envelope",
              arm: request.arm,
              attempt,
              deliveryTrace,
              runtimeEvidenceReceipt,
            });
            await records.writeOnce(
              "local-arm-envelope",
              JsonValueSchema.parse(envelope),
            );
            // Always return a typed reopen from durable Host storage, never
            // the just-constructed in-memory object.
            return readRetainedEnvelope(request.arm);
          },
        });
        return Object.freeze({
          pairedInput,
          runtimeArm,
          codeOnlyArm,
          armPort,
          retainedEvidence: Object.freeze({
            readDeliveryTrace,
            readRuntimeEvidenceReceipt,
            readAttemptSidecar,
            readSandboxSentinelReceipt: (
              arm: "runtime_enabled" | "code_only",
            ) => armRecords(arm).readOptional("sandbox-sentinel"),
            readCleanupReceipt: (arm: "runtime_enabled" | "code_only") =>
              armRecords(arm).readOptional("cleanup"),
          }),
          readRetainedEnvelope,
          cleanupRemainingAfterFailure: cleanupRemaining,
          hasAgentStarted: () => started.size > 0,
          persistInfrastructureFailureOnce,
        });
      },
      abortPreparation: cleanupRemaining,
    });
  } catch (error) {
    const failedCleanup = await cleanupM7R3FailedPreparationResourcesV1({
      runtimeBroker: runtimeTask.broker,
      ...(codeOnlyTask === undefined ? {} : { codeOnlyTask }),
      ...(runtimePrepared === undefined ? {} : { runtimePrepared }),
      codeOnlyPreparationStarted,
      runtimeSurfacePreparationStarted,
      error,
    });
    const cause =
      failedCleanup.cleanupFailures.length === 0
        ? error
        : new AggregateError(
            [error, ...failedCleanup.cleanupFailures],
            "M7 R3 preparation failed and cleanup was incomplete",
          );
    throw new M7R3ProjectEnvironmentPreparationInfrastructureErrorV1(
      failedCleanup.cleanup,
      cause,
    );
  }
}
