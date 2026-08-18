import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  JsonValueSchema,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentPinnedCaptureV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  ProjectToolchainReceiptV1Schema,
  asProjectEnvironmentTaskId,
  asProjectToolchainReceiptId,
  asSha256DigestV1,
  asTaskId,
  asWorkspaceId,
  projectRuntimeCleanupCompleteV1,
  type JsonValue,
  type M6AdapterBuildCompatibilityLineageV1,
  type M6AdapterBuildCompatibilityReceiptV1,
  type ProjectEnvironmentPinnedCaptureV1,
  type ProjectEnvironmentRuntimeObservationReceiptV1,
  type Sha256DigestV1,
  type VNextBuildV1,
} from "@chronorift/domain";
import {
  loadProjectAdapterPackageFilesV1,
  type ProjectAdapterPackageBytesV1,
} from "@chronorift/godot-adapter";
import {
  ProjectEnvironmentTaskStoreV1,
  canonicalJson,
  contentHash,
} from "@chronorift/json-artifacts";
import { publishPrivateFileOnceV1 } from "./private-atomic-publication.js";
import {
  createProjectEnvironmentGameToolDefinitions,
  createProjectEnvironmentToolCallAdmissionV1,
  createVNextCodingToolDefinitions,
  runVNextPiTurnWithSdk,
  type BrokerToolResult,
  type ProjectEnvironmentGameToolPort,
  type ProjectEnvironmentGameToolPortRequestV1,
  type VNextCodingToolPort,
} from "@chronorift/pi-harness";
import { z } from "zod";

import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import {
  ExternalHiddenFixPatchIdentityV1Schema,
  ExternalHiddenFixAgentAttemptBindingV1Schema,
  type ExternalHiddenFixAgentAttemptBindingV1,
  type ExternalHiddenFixPatchIdentityV1,
  type ExternalHiddenFixPatchReferenceV1,
} from "./external-hidden-fix.js";
import type {
  ExternalHiddenFixPublicTaskSpecV1,
  PreparedExternalHiddenFixAssignmentV1,
} from "./external-hidden-fix-assignment.js";
import type { LocalExternalHiddenFixPatchStoreV1 } from "./external-hidden-fix-evaluator.js";
import {
  ExternalHiddenFixHostSourceObservationV1Schema,
  ExternalHiddenFixPublicExecutionEvidenceV1Schema,
  type ExternalHiddenFixHostSourceObservationV1,
  type ExternalHiddenFixPublicExecutionEvidenceV1,
} from "./external-hidden-fix-workflow.js";
import { SandboxPiCodingToolPort } from "./pi-coding-tool-port.js";
import {
  createM6AdapterBuildCompatibilityLineageV1,
  runM6AdapterBuildCompatibilityV1,
} from "./m6-adapter-build-compatibility.js";
import {
  prepareM6ExactGodotBuildV1,
  type M6ExactBuildRuntimeIdentityV1,
  type PreparedM6ExactGodotBuildV1,
} from "./m6-exact-godot-build.js";
import {
  createM6AdmittedGameToolsV1,
  type M6AgentTurnRequestV1,
  type M6AgentTurnResultV1,
  type M6OneTurnAgentPortV1,
  type M6OneTurnAgentRequestV1,
} from "./m6-one-turn-agent.js";
import { preflightManagedGodotProjectEnvironmentRuntimeV1 } from "./managed-godot-project-environment-runtime-preflight.js";
import type { ManagedGodotProjectEnvironmentRuntimePreflightResultV1 } from "./managed-godot-project-environment-runtime-preflight.js";
import { extractTaskPatch, type ExtractedTaskPatch } from "./patch-handoff.js";
import {
  ProjectEnvironmentGameRuntimeV1,
  type ProjectEnvironmentGameRuntimeOptionsV1,
  type ProjectEnvironmentRuntimeBuildV1,
} from "./project-environment-game-runtime.js";
import {
  readProjectEnvironmentHostConfigV1,
  resolveProjectEnvironmentGodotToolchainV1,
  type ProjectEnvironmentToolchainReceiptV1,
} from "./project-environment-host-config.js";
import { GodotProjectEnvironmentSidecarPortV1 } from "./project-environment-sidecar-port.js";
import {
  createDuplexBwrapCgroupTaskSandbox,
  type DuplexTaskSandboxBrokerV1,
} from "./sandbox-broker.js";
import { createSandboxPolicyV2 } from "./sandbox-policy.js";
import {
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
  assertSandboxTaskStorageHeadroomV1,
  createSandboxTaskRuntimeRoot,
  preflightSandboxHost,
  type SandboxTaskStorageHeadroomV1,
} from "./sandbox-preflight.js";
import { inspectSandboxToolchain } from "./sandbox-toolchain.js";
import { selectedTreeSha256 } from "./selected-tree.js";
import {
  createProjectEnvironmentTaskDirectoryLayout,
  type ProjectEnvironmentTaskDirectoryLayout,
} from "./task-paths.js";
import {
  materializePrivateTaskWorkspace,
  type MaterializedProjectEnvironmentWorkspaceV1,
} from "./workspace-materializer.js";
import type { SandboxCleanupReceiptV1 } from "./contracts.js";
import {
  ProjectEnvironmentPreparationInfrastructureErrorV1,
  ProjectEnvironmentPreparationResourceOwnerV1,
} from "./preparation-resource-owner.js";

const MAX_AGENT_SOURCE_OBSERVATIONS = 997;
const RECORD_DIRECTORY_MODE = 0o700;
const M6_ENVIRONMENT_FIELD_LIMITATION =
  "M6 uses environmentRevisionId only as an internal Adapter-overlay protocol namespace; exact source identity is the Build source:<selected-tree-sha256> lineage.";

const jsonDigest = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(JsonValueSchema.parse(value)));

const m6TaskStorageHeadroomReceiptBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m6-task-storage-headroom"),
    assignmentId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u),
    taskId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u),
    attemptBindingContentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    boundary: z.literal("pre_pi"),
    availableBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    availableInodes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    requiredAvailableBytes: z.literal(
      SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
    ),
    requiredAvailableInodes: z.literal(
      SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
    ),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.availableBytes < value.requiredAvailableBytes) {
      context.addIssue({
        code: "custom",
        path: ["availableBytes"],
        message: "Task-storage byte headroom is below its required bound",
      });
    }
    if (value.availableInodes < value.requiredAvailableInodes) {
      context.addIssue({
        code: "custom",
        path: ["availableInodes"],
        message: "Task-storage inode headroom is below its required bound",
      });
    }
  });

export const M6TaskStorageHeadroomReceiptV1Schema =
  m6TaskStorageHeadroomReceiptBasisSchema
    .extend({
      recordContentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict()
    .superRefine((value, context) => {
      const { recordContentSha256, ...basis } = value;
      if (recordContentSha256 !== jsonDigest(basis)) {
        context.addIssue({
          code: "custom",
          path: ["recordContentSha256"],
          message: "M6 task-storage headroom receipt hash does not match",
        });
      }
    });
export type M6TaskStorageHeadroomReceiptV1 = z.infer<
  typeof M6TaskStorageHeadroomReceiptV1Schema
>;

export const createM6TaskStorageHeadroomReceiptV1 = (
  input: Omit<
    z.input<typeof m6TaskStorageHeadroomReceiptBasisSchema>,
    "schemaVersion" | "recordKind" | "boundary"
  >,
): M6TaskStorageHeadroomReceiptV1 => {
  const basis = m6TaskStorageHeadroomReceiptBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m6-task-storage-headroom",
    boundary: "pre_pi",
    ...input,
  });
  return Object.freeze(
    M6TaskStorageHeadroomReceiptV1Schema.parse({
      ...basis,
      recordContentSha256: jsonDigest(basis),
    }),
  );
};

const sameBuildClosure = (left: VNextBuildV1, right: VNextBuildV1): boolean =>
  left.taskId === right.taskId &&
  left.workspaceId === right.workspaceId &&
  left.sourceId === right.sourceId &&
  left.buildId === right.buildId &&
  left.sourceHash === right.sourceHash &&
  left.workspaceDiffHash === right.workspaceDiffHash &&
  left.buildConfigurationHash === right.buildConfigurationHash &&
  left.outputHash === right.outputHash;

const completeCoverage = (
  receipt: ProjectEnvironmentRuntimeObservationReceiptV1,
): boolean =>
  receipt.coverage.every(
    (entry) =>
      entry.status === "complete" &&
      entry.observedRecords > 0 &&
      entry.droppedRecords === 0 &&
      entry.overwrittenRecords === 0,
  ) && receipt.loss.length === 0;

const managedRuntimeTargets = (
  runtime: ManagedGodotProjectEnvironmentRuntimePreflightResultV1,
): readonly string[] => [
  ...runtime.capability.toolchain.files.map((file) => file.target),
  runtime.capability.fontconfigTarget,
  runtime.capability.addonParentTarget,
  runtime.capability.addonTarget,
  runtime.capability.overlayTarget,
  runtime.capability.adapterParentTarget,
  runtime.capability.adapterTarget,
];

export interface M6PublicGameToolExchangeV1 {
  readonly schemaVersion: 1;
  readonly ordinal: number;
  readonly toolCallId: string;
  readonly toolName: ProjectEnvironmentGameToolPortRequestV1["toolName"];
  readonly input: JsonValue;
  readonly response: JsonValue;
  readonly observedAt: string;
}

export interface M6PublicPinnedCaptureEvidenceV1 {
  readonly capture: ProjectEnvironmentPinnedCaptureV1;
  readonly records: readonly JsonValue[];
}

/**
 * This is an ordinary, Agent-visible evidence checker, not the hidden final
 * evaluator. M6 deliberately requires it because a free-text goal cannot be
 * converted into a truthful `publicSymptomObserved` boolean by the Harness.
 */
export interface M6PublicExecutionClassifierV1 {
  readonly identity: ExternalHiddenFixPublicTaskSpecV1["publicExecutionClassifier"];
  classify(input: {
    readonly publicTask: ExternalHiddenFixPublicTaskSpecV1;
    readonly build: VNextBuildV1;
    readonly runtimeReceipt: ProjectEnvironmentRuntimeObservationReceiptV1;
    readonly gameToolExchanges: readonly M6PublicGameToolExchangeV1[];
    readonly pinnedCaptures: readonly M6PublicPinnedCaptureEvidenceV1[];
  }): Promise<{
    readonly publicSymptomObserved: boolean;
    readonly observation: JsonValue;
  }>;
}

interface M6TaskStorePortV1 {
  putToolchainReceiptOnce(
    value: ReturnType<typeof ProjectToolchainReceiptV1Schema.parse>,
  ): Promise<unknown>;
  putPinnedCaptureOnce(
    value: ProjectEnvironmentPinnedCaptureV1,
    records: readonly JsonValue[],
  ): Promise<unknown>;
  putRuntimeObservationReceiptOnce(
    value: ProjectEnvironmentRuntimeObservationReceiptV1,
  ): Promise<unknown>;
}

interface M6PatchStorePortV1 {
  publishOnce(bytes: Uint8Array): Promise<ExternalHiddenFixPatchReferenceV1>;
}

interface M6ImmutableRecordWriterV1 {
  write(
    recordKind: "compatibility" | "public-execution" | "cleanup" | "headroom",
    payload: JsonValue,
  ): Promise<Sha256DigestV1>;
}

interface M6GameRuntimeV1 extends ProjectEnvironmentGameToolPort {
  adapterBuildCompatibilityIdentity(): ReturnType<
    ProjectEnvironmentGameRuntimeV1["adapterBuildCompatibilityIdentity"]
  >;
  close(): Promise<void>;
}

export interface PreparedM6ProjectEnvironmentOneTurnTaskV1 {
  readonly schemaVersion: 1;
  readonly assignment: PreparedExternalHiddenFixAssignmentV1;
  readonly publicTask: ExternalHiddenFixPublicTaskSpecV1;
  readonly taskId: ReturnType<typeof asTaskId>;
  readonly workspaceId: ReturnType<typeof asWorkspaceId>;
  readonly layout: ProjectEnvironmentTaskDirectoryLayout;
  readonly workspace: MaterializedProjectEnvironmentWorkspaceV1;
  readonly broker: DuplexTaskSandboxBrokerV1;
  readonly taskStore: M6TaskStorePortV1;
  readonly patchStore: M6PatchStorePortV1;
  readonly records: M6ImmutableRecordWriterV1;
  readonly managedRuntime: ManagedGodotProjectEnvironmentRuntimePreflightResultV1;
  readonly toolchain: ProjectEnvironmentToolchainReceiptV1;
  readonly toolchainReceiptId: string;
  readonly policyProfileDigest: Sha256DigestV1;
  /** Actual V2 coding-default projection, excluding the Godot treatment. */
  readonly codingSandboxProfileSha256: Sha256DigestV1;
  readonly runtimeIdentity: M6ExactBuildRuntimeIdentityV1;
  readonly internalAdapterOverlayNamespace: string;
  readonly launchTargetId: string;
  readonly hostAdmittedGameToolNames: readonly ProjectEnvironmentGameToolPortRequestV1["toolName"][];
  readonly publicExecutionClassifier: M6PublicExecutionClassifierV1;
  readonly sandboxRealization: JsonValue;
  readonly assertTaskStorageHeadroom: () => Promise<SandboxTaskStorageHeadroomV1>;
  readonly agentDir?: string | undefined;
  readonly now: () => string;
}

export interface PrepareM6ProjectEnvironmentOneTurnTaskV1Input {
  readonly assignment: PreparedExternalHiddenFixAssignmentV1;
  /** Host-only frozen bytes; never mounted into the coding profile. */
  readonly adapterFiles: readonly ProjectAdapterPackageBytesV1[];
  readonly patchStore: LocalExternalHiddenFixPatchStoreV1;
  readonly publicExecutionClassifier: M6PublicExecutionClassifierV1;
  readonly hostAdmittedGameToolNames: readonly ProjectEnvironmentGameToolPortRequestV1["toolName"][];
  readonly hostConfigPath?: string | undefined;
  readonly agentDir?: string | undefined;
  readonly now?: (() => string) | undefined;
}

export interface M6OneTurnProductionDependenciesV1 {
  readonly runPiTurn: typeof runVNextPiTurnWithSdk;
  readonly prepareBuild: typeof prepareM6ExactGodotBuildV1;
  readonly runCompatibility: typeof runM6AdapterBuildCompatibilityV1;
  readonly extractPatch: typeof extractTaskPatch;
  readonly createRuntime: (
    options: ProjectEnvironmentGameRuntimeOptionsV1,
  ) => M6GameRuntimeV1;
  readonly createSidecar: (
    options: ConstructorParameters<
      typeof GodotProjectEnvironmentSidecarPortV1
    >[0],
  ) => ProjectEnvironmentGameRuntimeOptionsV1["sidecar"];
}

const DEFAULT_PRODUCTION_DEPENDENCIES: M6OneTurnProductionDependenciesV1 = {
  runPiTurn: runVNextPiTurnWithSdk,
  prepareBuild: prepareM6ExactGodotBuildV1,
  runCompatibility: runM6AdapterBuildCompatibilityV1,
  extractPatch: extractTaskPatch,
  createRuntime: (options) => new ProjectEnvironmentGameRuntimeV1(options),
  createSidecar: (options) => new GodotProjectEnvironmentSidecarPortV1(options),
};

class PrivateM6RecordWriterV1 implements M6ImmutableRecordWriterV1 {
  public constructor(
    private readonly root: string,
    private readonly taskId: string,
  ) {}

  public async write(
    recordKind: "compatibility" | "public-execution" | "cleanup" | "headroom",
    payloadInput: JsonValue,
  ): Promise<Sha256DigestV1> {
    const payload = JsonValueSchema.parse(payloadInput);
    const basisObject = {
      schemaVersion: 1,
      recordKind: `m6-${recordKind}`,
      taskId: this.taskId,
      payload,
    };
    const basis = JsonValueSchema.parse(basisObject);
    const contentSha256 = jsonDigest(basis);
    const record = JsonValueSchema.parse({ ...basisObject, contentSha256 });
    const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
    await publishPrivateFileOnceV1({
      root: this.root,
      filename: `${recordKind}-${contentSha256}.json`,
      bytes,
    });
    return contentSha256;
  }
}

const createRecordWriter = async (
  layout: ProjectEnvironmentTaskDirectoryLayout,
  taskId: string,
): Promise<M6ImmutableRecordWriterV1> => {
  const root = join(layout.taskRecordDirectory, "m6-one-turn");
  await mkdir(root, { mode: RECORD_DIRECTORY_MODE });
  await chmod(root, RECORD_DIRECTORY_MODE);
  return new PrivateM6RecordWriterV1(root, taskId);
};

const toolchainReceipt = (
  toolchain: ProjectEnvironmentToolchainReceiptV1,
  observedAt: string,
) => {
  const identity = {
    schemaVersion: 1 as const,
    requested: {
      schemaVersion: 1 as const,
      engineFamily: "godot",
      versionRequirement: "4.7.1",
      platform: "linux-x86_64",
      requiredFeatures: [...toolchain.buildFeatures],
    },
    status: "realized" as const,
    realized: {
      schemaVersion: 1 as const,
      engineFamily: "godot",
      version: toolchain.realizedVersion,
      platform: toolchain.platform,
      artifactDigest: toolchain.executableSha256,
      features: [...toolchain.buildFeatures],
      renderer: toolchain.renderer,
    },
    limitations: [] as const,
  };
  return ProjectToolchainReceiptV1Schema.parse({
    ...identity,
    receiptId: asProjectToolchainReceiptId(
      `toolchain-receipt:v1:${contentHash(identity as never)}`,
    ),
    observedAt,
  });
};

/**
 * Real Host preparation for M6. It creates a new one-shot Task namespace from
 * the registered mutated source, while the hidden baseline/evaluator and the
 * pristine Adapter authority remain outside every sandbox mount.
 */
export async function prepareM6ProjectEnvironmentOneTurnTaskV1(
  input: PrepareM6ProjectEnvironmentOneTurnTaskV1Input,
): Promise<PreparedM6ProjectEnvironmentOneTurnTaskV1> {
  const now = input.now ?? (() => new Date().toISOString());
  const publicTask = input.assignment.agentProjection.publicTask.spec;
  if (
    canonicalJson(input.publicExecutionClassifier.identity) !==
    canonicalJson(publicTask.publicExecutionClassifier)
  ) {
    throw new TypeError(
      "M6 public execution classifier does not match the frozen Agent-visible task identity",
    );
  }
  if (
    publicTask.agentBudget.attemptsMaximum !== 1 ||
    publicTask.agentBudget.userTurnsPerAttemptMaximum !== 1 ||
    publicTask.agentBudget.taskSandboxNetworkMode !== "denied" ||
    publicTask.agentBudget.taskCredentialMountCountMaximum !== 0
  ) {
    throw new TypeError(
      "M6 production composition requires the one-turn denied-by-default task boundary",
    );
  }
  if (publicTask.agentBudget.toolCallsMaximum > MAX_AGENT_SOURCE_OBSERVATIONS) {
    throw new TypeError(
      `M6 toolCallsMaximum exceeds the ${String(MAX_AGENT_SOURCE_OBSERVATIONS)}-observation evidence bound`,
    );
  }
  const admittedNames = [...input.hostAdmittedGameToolNames];
  if (
    admittedNames.length === 0 ||
    new Set(admittedNames).size !== admittedNames.length
  ) {
    throw new TypeError(
      "M6 Host-admitted game tools must be nonempty and unique",
    );
  }

  const hostConfig = await readProjectEnvironmentHostConfigV1(
    input.hostConfigPath,
  );
  const runtimeRoot = await createSandboxTaskRuntimeRoot(
    hostConfig.taskStorageRoot,
    hostConfig.runtimeRoot,
  );
  const sandbox = await preflightSandboxHost({
    delegatedCgroupRoot: hostConfig.delegatedCgroupRoot,
    bwrapPath: hostConfig.bwrapPath,
    prlimitPath: hostConfig.prlimitPath,
    busyboxPath: hostConfig.busyboxPath,
    taskStorageRoot: hostConfig.taskStorageRoot,
  });
  if (sandbox.kind !== "supported") {
    throw new Error(
      `M6 task sandbox preflight failed: ${canonicalJson(sandbox.receipt.blockers as never)}`,
    );
  }
  if (
    sandbox.capability.taskStorage === undefined ||
    sandbox.binding.taskStorageRoot === undefined
  ) {
    throw new Error("M6 task sandbox omitted bounded Task storage");
  }
  const taskStorageCapability = sandbox.capability.taskStorage;
  const taskStorageRoot = sandbox.binding.taskStorageRoot;
  const godot = await resolveProjectEnvironmentGodotToolchainV1(
    hostConfig,
    input.assignment.mutatedSource.requestedGodotVersion,
  );
  const taskId = asTaskId(publicTask.taskId);
  const projectEnvironmentTaskId = asProjectEnvironmentTaskId(
    publicTask.taskId,
  );
  const workspaceId = asWorkspaceId(`workspace.v1.${publicTask.taskId}`);
  const layout = await createProjectEnvironmentTaskDirectoryLayout({
    runtimeRoot,
    sourceRepositoryRoot: input.assignment.mutatedSource.repositoryRoot,
    taskId,
  });
  const owner = new ProjectEnvironmentPreparationResourceOwnerV1(layout);
  let stage = "workspace";
  try {
    const workspace = await materializePrivateTaskWorkspace({
      taskId,
      source: input.assignment.mutatedSource,
      layout,
    });
    if (
      workspace.receipt.selectedTreeSha256 !==
        input.assignment.assignment.mutatedBaselineSelectedTreeSha256 ||
      workspace.receipt.selectedTreeSha256 !==
        input.assignment.agentProjection.baselineSelectedTreeSha256
    ) {
      throw new Error(
        "M6 one-turn workspace detached from its registered mutated baseline",
      );
    }
    stage = "task_store";
    const taskStore = new ProjectEnvironmentTaskStoreV1({
      storeRoot: layout.projectEnvironmentRecordDirectory,
      taskId: projectEnvironmentTaskId,
    });
    await taskStore.create();
    const records = await createRecordWriter(layout, publicTask.taskId);
    stage = "toolchain";
    const codingToolchain = await inspectSandboxToolchain({
      lddPath: hostConfig.lddPath,
      commands: [
        { target: "/bin/bash", hostPath: hostConfig.bashPath },
        { target: "/usr/bin/rg", hostPath: hostConfig.rgPath },
        { target: "/usr/bin/find", hostPath: hostConfig.findPath },
        { target: "/usr/bin/ls", hostPath: hostConfig.lsPath },
      ],
    });
    stage = "managed_runtime";
    const frozenAdapterPackage = loadProjectAdapterPackageFilesV1(
      input.adapterFiles,
      {
        requireSingleLaunchTarget: true,
        expectedMainScene: input.assignment.pristineSource.mainScene,
        requireEmptyLaunchParameters: true,
      },
    );
    if (
      frozenAdapterPackage.candidateSha256 !==
        input.assignment.adapterPackage.candidateSha256 ||
      frozenAdapterPackage.manifestSha256 !==
        input.assignment.adapterPackage.manifestSha256 ||
      canonicalJson(frozenAdapterPackage.files as never) !==
        canonicalJson(input.assignment.adapterPackage.files as never)
    ) {
      throw new Error(
        "M6 supplied Adapter bytes do not match the task-blind frozen package",
      );
    }
    const adapterFiles = input.adapterFiles.map((file) => ({
      relativePath: file.path,
      bytes: Uint8Array.from(file.bytes),
    }));
    const managedRuntime =
      await preflightManagedGodotProjectEnvironmentRuntimeV1({
        hostConfig,
        godot,
        adapterFiles,
      });
    const adapterRevision = ProjectAdapterRevisionV1Schema.parse(
      input.assignment.adapterRevision,
    );
    if (
      adapterRevision.sdkDigest !== managedRuntime.sdkDigest ||
      adapterRevision.bridgeDigest !== managedRuntime.bridgeDigest ||
      adapterRevision.packageDigest !==
        input.assignment.adapterPackage.candidateSha256
    ) {
      throw new Error(
        "M6 managed runtime detached from the frozen pristine AdapterRevision",
      );
    }
    const policy = createSandboxPolicyV2(sandbox.capability.runtimeIdentity, {
      coding: {
        toolchainId: codingToolchain.capability.toolchainId,
        targets: codingToolchain.capability.files.map((file) => file.target),
      },
      godot: {
        toolchainId: managedRuntime.capability.toolchain.toolchainId,
        managedRuntimeId: managedRuntime.capability.managedRuntimeId,
        targets: managedRuntimeTargets(managedRuntime),
      },
    });
    stage = "broker";
    const broker = await createDuplexBwrapCgroupTaskSandbox({
      taskId,
      capability: sandbox.capability,
      hostBinding: sandbox.binding,
      policy,
      toolchain: codingToolchain,
      managedRuntime,
      layout,
      securityEvents: () => Promise.resolve(),
    });
    owner.adoptBroker(broker);
    stage = "finalize";
    const persistedToolchain = toolchainReceipt(godot.receipt, now());
    await taskStore.putToolchainReceiptOnce(persistedToolchain);
    const launchTarget =
      input.assignment.adapterPackage.manifest.launchTargets.find(
        (candidate) => candidate.default,
      );
    if (launchTarget === undefined) {
      throw new Error("M6 frozen ProjectAdapter has no default launch target");
    }
    const policyProfileDigest = jsonDigest(policy);
    const codingSandboxProfileSha256 = jsonDigest({
      schemaVersion: 1,
      runtimeIdentity: policy.runtimeIdentity,
      writableTargets: policy.writableTargets,
      namespaces: policy.namespaces,
      network: policy.network,
      copiedEnvironmentKeys: policy.copiedEnvironmentKeys,
      resourceLimits: policy.profiles["coding-default"],
      toolchainId: policy.profileBindings["coding-default"].toolchainId,
      managedRuntimeId:
        policy.profileBindings["coding-default"].managedRuntimeId,
      workspaceAccess: policy.profileBindings["coding-default"].workspaceAccess,
      readonlyTargets: policy.profileBindings["coding-default"].readonlyTargets,
    });
    const runtimeIdentity: M6ExactBuildRuntimeIdentityV1 = {
      schemaVersion: 1,
      managedRuntimeId: managedRuntime.capability.managedRuntimeId,
      engineVersion: managedRuntime.capability.engineVersion,
      runtimeArtifactDigest: jsonDigest(managedRuntime.capability),
      overlayDigest: managedRuntime.capability.overlayHash,
    };
    const internalAdapterOverlayNamespace = `m6-adapter-overlay:v1:${contentHash(
      {
        schemaVersion: 1,
        assignmentId: input.assignment.assignment.assignmentId,
        adapterRevisionId: adapterRevision.adapterRevisionId,
        managedRuntimeId: managedRuntime.capability.managedRuntimeId,
      },
    )}`;
    const sandboxRealization = JsonValueSchema.parse({
      schemaVersion: 1,
      networkMode: publicTask.agentBudget.taskSandboxNetworkMode,
      credentialMountCountMaximum:
        publicTask.agentBudget.taskCredentialMountCountMaximum,
      sandboxCapabilitySha256: jsonDigest(sandbox.capability),
      policyProfileDigest,
      managedRuntime: runtimeIdentity,
      toolchain: {
        receiptId: persistedToolchain.receiptId,
        artifactDigest: godot.receipt.executableSha256,
        realizedVersion: godot.receipt.realizedVersionOutput,
      },
      workspace: {
        workspaceId,
        materializationReceipt: workspace.receipt,
      },
    });
    const prepared = Object.freeze({
      schemaVersion: 1,
      assignment: input.assignment,
      publicTask,
      taskId,
      workspaceId,
      layout,
      workspace,
      broker,
      taskStore,
      patchStore: input.patchStore,
      records,
      managedRuntime,
      toolchain: godot.receipt,
      toolchainReceiptId: persistedToolchain.receiptId,
      policyProfileDigest,
      codingSandboxProfileSha256,
      runtimeIdentity,
      internalAdapterOverlayNamespace,
      launchTargetId: launchTarget.targetId,
      hostAdmittedGameToolNames: Object.freeze(admittedNames),
      publicExecutionClassifier: input.publicExecutionClassifier,
      sandboxRealization,
      assertTaskStorageHeadroom: () =>
        assertSandboxTaskStorageHeadroomV1(
          taskStorageCapability,
          taskStorageRoot,
        ),
      ...(input.agentDir === undefined ? {} : { agentDir: input.agentDir }),
      now,
    });
    owner.release();
    return prepared;
  } catch (error) {
    if (stage === "broker") owner.adoptBrokerSetupCleanupFailure(error);
    throw new ProjectEnvironmentPreparationInfrastructureErrorV1(
      `m6:${stage}`,
      await owner.cleanupAfterFailure(),
      error,
    );
  }
}

const appendM6Limitation = (
  toolName: ProjectEnvironmentGameToolPortRequestV1["toolName"],
  untrusted: unknown,
): unknown => {
  if (toolName !== "game_capabilities" && toolName !== "game_launch") {
    return untrusted;
  }
  if (
    typeof untrusted !== "object" ||
    untrusted === null ||
    !("outcome" in untrusted) ||
    untrusted.outcome !== "success" ||
    !("output" in untrusted) ||
    typeof untrusted.output !== "object" ||
    untrusted.output === null ||
    !("limitations" in untrusted.output) ||
    !Array.isArray(untrusted.output.limitations) ||
    !untrusted.output.limitations.every(
      (limitation): limitation is string => typeof limitation === "string",
    )
  ) {
    return untrusted;
  }
  return {
    ...untrusted,
    output: {
      ...untrusted.output,
      limitations: [
        ...untrusted.output.limitations,
        M6_ENVIRONMENT_FIELD_LIMITATION,
      ],
    },
  };
};

class ObservingCodingPortV1 implements VNextCodingToolPort {
  public constructor(
    private readonly delegate: VNextCodingToolPort,
    private readonly observeReturn: () => Promise<void>,
  ) {}

  private async observed(
    operation: () => Promise<BrokerToolResult>,
  ): Promise<BrokerToolResult> {
    try {
      return await operation();
    } finally {
      // A failed coding call may still have changed source bytes before its
      // tool boundary became visible to the Host.
      await this.observeReturn();
    }
  }

  public read(path: string, signal?: AbortSignal): Promise<BrokerToolResult> {
    return this.observed(() => this.delegate.read(path, signal));
  }

  public bash(
    command: string,
    options: Parameters<VNextCodingToolPort["bash"]>[1],
  ): Promise<BrokerToolResult> {
    return this.observed(() => this.delegate.bash(command, options));
  }

  public write(
    path: string,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<BrokerToolResult> {
    return this.observed(() => this.delegate.write(path, content, signal));
  }

  public grep(
    request: Parameters<VNextCodingToolPort["grep"]>[0],
    signal?: AbortSignal,
  ): Promise<BrokerToolResult> {
    return this.observed(() => this.delegate.grep(request, signal));
  }

  public find(
    request: Parameters<VNextCodingToolPort["find"]>[0],
    signal?: AbortSignal,
  ): Promise<BrokerToolResult> {
    return this.observed(() => this.delegate.find(request, signal));
  }

  public ls(
    request: Parameters<VNextCodingToolPort["ls"]>[0],
    signal?: AbortSignal,
  ): Promise<BrokerToolResult> {
    return this.observed(() => this.delegate.ls(request, signal));
  }
}

class ObservingGamePortV1 implements ProjectEnvironmentGameToolPort {
  public constructor(
    private readonly delegate: ProjectEnvironmentGameToolPort,
    private readonly exchanges: M6PublicGameToolExchangeV1[],
    private readonly now: () => string,
  ) {}

  public async invoke(
    request: ProjectEnvironmentGameToolPortRequestV1,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const raw = await this.delegate.invoke(request, signal);
    const response = appendM6Limitation(request.toolName, raw);
    this.exchanges.push(
      Object.freeze({
        schemaVersion: 1,
        ordinal: this.exchanges.length,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        input: JsonValueSchema.parse(request.input),
        response: JsonValueSchema.parse(response),
        observedAt: this.now(),
      }),
    );
    return response;
  }
}

const runtimeBuild = (
  build: VNextBuildV1,
  configuredMainScene: string,
): ProjectEnvironmentRuntimeBuildV1 =>
  Object.freeze({
    schemaVersion: 1,
    buildId: build.buildId,
    sourceClosureId: build.sourceId,
    candidateSourceHash: build.sourceHash,
    expectedMainScene: configuredMainScene,
  });

const compatibilityRecord = (input: {
  readonly pendingBinding: unknown;
  readonly receipt: M6AdapterBuildCompatibilityReceiptV1;
  readonly binding: unknown;
}): JsonValue =>
  JsonValueSchema.parse({
    schemaVersion: 1,
    identitySemantics:
      "pristine AdapterRevision -> exact Build compatibility; no ProjectEnvironmentRevision is the mutant Build identity",
    pendingBinding: input.pendingBinding,
    receipt: input.receipt,
    binding: input.binding,
  });

/** Creates the concrete Pi/sandbox/ProjectAdapter port consumed by the M6 one-turn runner. */
export function createM6ProjectEnvironmentOneTurnAgentPortV1(
  task: PreparedM6ProjectEnvironmentOneTurnTaskV1,
  overrides: Partial<M6OneTurnProductionDependenciesV1> = {},
): M6OneTurnAgentPortV1 {
  const dependencies = { ...DEFAULT_PRODUCTION_DEPENDENCIES, ...overrides };
  const adapterRevision = ProjectAdapterRevisionV1Schema.parse(
    task.assignment.adapterRevision,
  );
  const builds = new Map<string, PreparedM6ExactGodotBuildV1>();
  const compatibleBuildIds = new Set<string>();
  const sourceObservations: ExternalHiddenFixHostSourceObservationV1[] = [];
  const executions: ExternalHiddenFixPublicExecutionEvidenceV1[] = [];
  const exchanges: M6PublicGameToolExchangeV1[] = [];
  const captures = new Map<string, M6PublicPinnedCaptureEvidenceV1[]>();
  let lastCodingSourceHash =
    task.assignment.agentProjection.baselineSelectedTreeSha256;
  let firstCodingReturnObserved = false;
  let agentTurnCalled = false;
  let patchFrozen = false;
  let cleanupCalled = false;
  let activeAgentRuntime: M6GameRuntimeV1 | undefined;

  const buildInput = (now: string) => ({
    taskId: task.taskId,
    workspaceId: task.workspaceId,
    workspaceDirectory: task.workspace.workspaceDirectory,
    baselineSourceHash:
      task.assignment.agentProjection.baselineSelectedTreeSha256,
    adapterRevision,
    toolchainReceiptId: task.toolchainReceiptId,
    toolchainArtifactDigest: task.toolchain.executableSha256,
    runtimeIdentity: task.runtimeIdentity,
    policyProfileDigest: task.policyProfileDigest,
    now,
  });

  const freezeCurrentBuild = async (): Promise<PreparedM6ExactGodotBuildV1> => {
    const prepared = await dependencies.prepareBuild(buildInput(task.now()));
    builds.set(prepared.build.buildId, prepared);
    return prepared;
  };

  const createRuntime = (input: {
    readonly build: VNextBuildV1;
    readonly configuredMainScene: string;
    readonly resolveCompatibleBuild?:
      (() => Promise<ProjectEnvironmentRuntimeBuildV1>) | undefined;
    readonly persistAgentEvidence: boolean;
  }): M6GameRuntimeV1 => {
    const persistPinnedCapture = input.persistAgentEvidence
      ? async (
          captureInput: ProjectEnvironmentPinnedCaptureV1,
          recordsInput: readonly JsonValue[],
        ): Promise<void> => {
          const capture =
            ProjectEnvironmentPinnedCaptureV1Schema.parse(captureInput);
          const records = recordsInput.map((record) =>
            JsonValueSchema.parse(record),
          );
          if (
            capture.taskId !== task.taskId ||
            capture.buildId !== input.build.buildId ||
            capture.adapterRevisionId !== adapterRevision.adapterRevisionId ||
            capture.environmentRevisionId !==
              task.internalAdapterOverlayNamespace
          ) {
            throw new Error(
              "M6 pinned capture crossed its Task, Build, or Adapter overlay provenance",
            );
          }
          await task.taskStore.putPinnedCaptureOnce(capture, records);
          const prior = captures.get(capture.executionId) ?? [];
          prior.push(
            Object.freeze({ capture, records: Object.freeze(records) }),
          );
          captures.set(capture.executionId, prior);
        }
      : undefined;
    const persistRuntimeObservation = input.persistAgentEvidence
      ? async (
          receiptInput: ProjectEnvironmentRuntimeObservationReceiptV1,
        ): Promise<void> => {
          const receipt =
            ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse(
              receiptInput,
            );
          const prepared = builds.get(receipt.buildId);
          if (
            prepared === undefined ||
            receipt.taskId !== task.taskId ||
            receipt.adapterRevisionId !== adapterRevision.adapterRevisionId ||
            receipt.environmentRevisionId !==
              task.internalAdapterOverlayNamespace
          ) {
            throw new Error(
              "M6 runtime observation crossed its exact Task, Build, or Adapter overlay provenance",
            );
          }
          await task.taskStore.putRuntimeObservationReceiptOnce(receipt);
          const executionExchanges = exchanges.filter((exchange) => {
            const inputRecord =
              typeof exchange.input === "object" &&
              exchange.input !== null &&
              !Array.isArray(exchange.input)
                ? exchange.input
                : {};
            const responseRecord =
              typeof exchange.response === "object" &&
              exchange.response !== null &&
              !Array.isArray(exchange.response)
                ? exchange.response
                : {};
            const output =
              typeof responseRecord.output === "object" &&
              responseRecord.output !== null &&
              !Array.isArray(responseRecord.output)
                ? responseRecord.output
                : {};
            return (
              inputRecord.executionId === receipt.executionId ||
              inputRecord.runtimeId === receipt.runtimeId ||
              output.executionId === receipt.executionId ||
              output.runtimeId === receipt.runtimeId
            );
          });
          const pinnedCaptures = captures.get(receipt.executionId) ?? [];
          const classified = await task.publicExecutionClassifier.classify({
            publicTask: task.publicTask,
            build: prepared.build,
            runtimeReceipt: receipt,
            gameToolExchanges: Object.freeze(executionExchanges),
            pinnedCaptures: Object.freeze(pinnedCaptures),
          });
          const observation = JsonValueSchema.parse(classified.observation);
          const publicObservationSha256 = jsonDigest({
            schemaVersion: 1,
            publicSymptomObserved: classified.publicSymptomObserved,
            observation,
          });
          const evidence =
            ExternalHiddenFixPublicExecutionEvidenceV1Schema.parse({
              schemaVersion: 1,
              executionId: receipt.executionId,
              buildId: receipt.buildId,
              sourceSha256: prepared.build.sourceHash,
              startedAt: receipt.startedAt,
              endedAt: receipt.completedAt,
              sealed: true,
              coverageComplete:
                receipt.outcome === "succeeded" && completeCoverage(receipt),
              cleanupProven: projectRuntimeCleanupCompleteV1(receipt.cleanup),
              publicSymptomObserved: classified.publicSymptomObserved,
              publicObservationSha256,
            });
          await task.records.write(
            "public-execution",
            JsonValueSchema.parse({
              schemaVersion: 1,
              build: prepared.build,
              publicExecution: evidence,
              runtimeObservationReceipt: receipt,
              publicObservation: observation,
              gameToolExchanges: executionExchanges,
              pinnedCaptureManifests: pinnedCaptures.map(
                (entry) => entry.capture,
              ),
              identitySemantics:
                "runtime environmentRevisionId is an internal Adapter-overlay protocol namespace; Build sourceId/sourceSha256 is authoritative",
            }),
          );
          executions.push(evidence);
        }
      : undefined;
    const options: ProjectEnvironmentGameRuntimeOptionsV1 = {
      sidecar: dependencies.createSidecar({
        broker: task.broker,
        managedRuntime: task.managedRuntime,
      }),
      managedRuntime: task.managedRuntime.capability,
      adapterPackage: task.assignment.adapterPackage,
      capabilitySet: adapterRevision.capabilitySet,
      taskId: task.taskId,
      sourceClosureId: input.build.sourceId,
      environmentRevisionId: task.internalAdapterOverlayNamespace,
      adapterRevisionId: adapterRevision.adapterRevisionId,
      buildId: input.build.buildId,
      candidateSourceHash: input.build.sourceHash,
      expectedMainScene: input.configuredMainScene,
      adapterManifestSha256: task.assignment.adapterPackage.manifestSha256,
      sdkSha256: task.managedRuntime.sdkDigest,
      bridgeSha256: task.managedRuntime.bridgeDigest,
      toolchainSha256: task.toolchain.executableSha256,
      engineVersion: task.managedRuntime.capability.engineVersion,
      ...(input.resolveCompatibleBuild === undefined
        ? {}
        : { resolveCompatibleBuild: input.resolveCompatibleBuild }),
      ...(persistPinnedCapture === undefined ? {} : { persistPinnedCapture }),
      ...(persistRuntimeObservation === undefined
        ? {}
        : { persistRuntimeObservation }),
      now: task.now,
    };
    return dependencies.createRuntime(options);
  };

  const assertLineageMatchesWorkspace = async (
    lineage: M6AdapterBuildCompatibilityLineageV1,
  ): Promise<PreparedM6ExactGodotBuildV1> => {
    const current = await freezeCurrentBuild();
    if (
      !sameBuildClosure(lineage.build, current.build) ||
      lineage.baselineSourceHash !==
        task.assignment.agentProjection.baselineSelectedTreeSha256 ||
      lineage.adapterRevision.adapterRevisionId !==
        adapterRevision.adapterRevisionId ||
      lineage.toolchain.toolchainReceiptId !== task.toolchainReceiptId ||
      lineage.toolchain.artifactDigest !== task.toolchain.executableSha256
    ) {
      throw new Error(
        "M6 compatibility lineage detached from the exact current workspace Build",
      );
    }
    return current;
  };

  const runCompatibility: M6OneTurnAgentPortV1["runCompatibility"] = async (
    request,
  ) => {
    const prepared = await assertLineageMatchesWorkspace(request.lineage);
    const result = await dependencies.runCompatibility({
      lineage: request.lineage,
      runtime: createRuntime({
        build: request.lineage.build,
        configuredMainScene: prepared.configuredMainScene,
        persistAgentEvidence: false,
      }),
      launchTargetId: task.launchTargetId,
      now: task.now,
    });
    await task.records.write("compatibility", compatibilityRecord(result));
    if (result.receipt.outcome === "compatible") {
      compatibleBuildIds.add(result.receipt.lineage.build.buildId);
    }
    return result.receipt;
  };

  const observeCodingToolReturn = async (): Promise<void> => {
    const entries = await collectCandidateGodotSourceV1(
      task.workspace.workspaceDirectory,
      "project-environment",
      "tracked-tool-scripts-v1",
    );
    const sourceHash = selectedTreeSha256(entries);
    if (firstCodingReturnObserved && sourceHash === lastCodingSourceHash)
      return;
    if (sourceObservations.length >= MAX_AGENT_SOURCE_OBSERVATIONS) {
      throw new Error("M6 Host source-observation budget exhausted");
    }
    firstCodingReturnObserved = true;
    lastCodingSourceHash = sourceHash;
    sourceObservations.push(
      ExternalHiddenFixHostSourceObservationV1Schema.parse({
        schemaVersion: 1,
        boundary: "coding_tool_return",
        sourceSha256: sourceHash,
        buildId: null,
        observedAt: task.now(),
      }),
    );
  };

  const resolveCompatibleBuild =
    async (): Promise<ProjectEnvironmentRuntimeBuildV1> => {
      const prepared = await freezeCurrentBuild();
      if (!compatibleBuildIds.has(prepared.build.buildId)) {
        const role =
          prepared.build.sourceHash ===
          task.assignment.agentProjection.baselineSelectedTreeSha256
            ? "assignment_baseline"
            : "candidate";
        const lineage: M6AdapterBuildCompatibilityLineageV1 =
          createM6AdapterBuildCompatibilityLineageV1({
            adapterRevision,
            build: prepared.build,
            baselineSourceHash:
              task.assignment.agentProjection.baselineSelectedTreeSha256,
            buildRole: role,
            toolchainReceiptId: task.toolchainReceiptId,
            toolchainArtifactDigest: task.toolchain.executableSha256,
          });
        const receipt = await runCompatibility({
          schemaVersion: 1,
          phase:
            role === "assignment_baseline"
              ? "assignment_baseline"
              : "candidate",
          lineage,
        });
        if (receipt.outcome !== "compatible") {
          throw new Error(
            "M6 Agent requested a Build that failed exact Adapter compatibility",
          );
        }
      }
      if (
        prepared.build.sourceHash !==
          task.assignment.agentProjection.baselineSelectedTreeSha256 &&
        !sourceObservations.some(
          (entry) =>
            entry.boundary === "game_build_freeze" &&
            entry.buildId === prepared.build.buildId,
        )
      ) {
        if (sourceObservations.length >= MAX_AGENT_SOURCE_OBSERVATIONS) {
          throw new Error("M6 Host source-observation budget exhausted");
        }
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
      return runtimeBuild(prepared.build, prepared.configuredMainScene);
    };

  return Object.freeze({
    runCompatibility,

    runAgentTurn: async (
      turn: M6AgentTurnRequestV1,
    ): Promise<M6AgentTurnResultV1> => {
      if (agentTurnCalled)
        throw new Error("M6 production Agent turn may run only once");
      agentTurnCalled = true;
      if (
        turn.prompt !== task.publicTask.goal ||
        turn.workspaceDirectory !== task.workspace.workspaceDirectory ||
        turn.baselineBuild.taskId !== task.taskId ||
        turn.baselineBuild.workspaceId !== task.workspaceId ||
        turn.pristineAdapterRevision.adapterRevisionId !==
          adapterRevision.adapterRevisionId
      ) {
        throw new Error(
          "M6 Pi turn request detached from its public assignment or exact baseline",
        );
      }
      const admission = createProjectEnvironmentToolCallAdmissionV1(
        task.publicTask.agentBudget.toolCallsMaximum,
      );
      const codingTools = createVNextCodingToolDefinitions(
        new ObservingCodingPortV1(
          new SandboxPiCodingToolPort(task.broker),
          observeCodingToolReturn,
        ),
        { toolCallAdmission: admission },
      );
      const codingToolNames = codingTools.map((tool) => tool.name);
      if (
        codingToolNames.length !== turn.codingToolNames.length ||
        codingToolNames.some((name) => !turn.codingToolNames.includes(name))
      ) {
        throw new Error(
          "M6 Pi coding tools do not match the one-turn Host admission",
        );
      }
      const baselinePrepared = builds.get(turn.baselineBuild.buildId);
      if (baselinePrepared === undefined) {
        throw new Error(
          "M6 baseline compatibility did not retain its exact Build",
        );
      }
      activeAgentRuntime = createRuntime({
        build: turn.baselineBuild,
        configuredMainScene: baselinePrepared.configuredMainScene,
        resolveCompatibleBuild,
        persistAgentEvidence: true,
      });
      const observingGamePort = new ObservingGamePortV1(
        activeAgentRuntime,
        exchanges,
        task.now,
      );
      const allowedGameToolNames = new Set(
        turn.gameTools.map((tool) => tool.name),
      );
      const gameTools = createProjectEnvironmentGameToolDefinitions(
        observingGamePort,
        adapterRevision.capabilitySet,
        { toolCallAdmission: admission },
      ).filter((tool) => allowedGameToolNames.has(tool.name as never));
      if (
        gameTools.length !== turn.gameTools.length ||
        gameTools.some((tool) => !allowedGameToolNames.has(tool.name as never))
      ) {
        throw new Error(
          "M6 Pi game tools do not match the frozen Adapter/Host admission",
        );
      }
      const allTools = Object.freeze([...codingTools, ...gameTools]);
      let piResult: Awaited<ReturnType<typeof runVNextPiTurnWithSdk>>;
      let piFailure: unknown;
      try {
        const taskStorageHeadroom = await task.assertTaskStorageHeadroom();
        const attemptBinding =
          createM6AgentAttemptBindingFromPreparedTaskV1(task);
        const taskStorageHeadroomReceipt = createM6TaskStorageHeadroomReceiptV1(
          {
            assignmentId: task.assignment.assignment.assignmentId,
            taskId: task.taskId,
            attemptBindingContentSha256: jsonDigest(attemptBinding),
            availableBytes: taskStorageHeadroom.availableBytes,
            availableInodes: taskStorageHeadroom.availableInodes,
            requiredAvailableBytes: taskStorageHeadroom.requiredAvailableBytes,
            requiredAvailableInodes:
              taskStorageHeadroom.requiredAvailableInodes,
            observedAt: task.now(),
          },
        );
        await task.records.write(
          "headroom",
          JsonValueSchema.parse(taskStorageHeadroomReceipt),
        );
        piResult = await dependencies.runPiTurn({
          resourceWorkspaceDirectory: task.workspace.workspaceDirectory,
          sessionDirectory: task.layout.piSessionDirectory,
          newSessionId: `m6-${randomUUID()}`,
          ...(task.agentDir === undefined ? {} : { agentDir: task.agentDir }),
          provider: task.publicTask.agentBudget.provider,
          model: task.publicTask.agentBudget.model,
          thinkingLevel: task.publicTask.agentBudget.thinkingLevel,
          prompt: task.publicTask.goal,
          tools: allTools,
          timeoutMs: task.publicTask.agentBudget.wallTimeMsMaximum,
          additionalEnvironmentInstructions: [
            "M6 external hidden-fix assignment:",
            `- assignmentId: ${task.assignment.assignment.assignmentId}`,
            `- taskId: ${task.taskId}`,
            `- baselineBuildId: ${turn.baselineBuild.buildId}`,
            `- baselineSourceId: ${turn.baselineBuild.sourceId}`,
            `- pristineAdapterRevisionId: ${adapterRevision.adapterRevisionId}`,
            `- publicExecutionClassifierId: ${task.publicTask.publicExecutionClassifier.classifierId}`,
            `- publicExecutionClassifierSha256: ${task.publicTask.publicExecutionClassifier.implementationSha256}`,
            "- This is the only Agent attempt and the only user turn for the assignment.",
            "- Use ordinary coding and admitted ProjectAdapter game tools to investigate, edit, and rerun. The hidden evaluator is not mounted and does not run during this turn.",
            "- A game Build is admitted only after compatibility of the exact current source bytes with the frozen pristine AdapterRevision.",
            `- ${M6_ENVIRONMENT_FIELD_LIMITATION}`,
          ].join("\n"),
        });
      } catch (error) {
        piFailure = error;
        throw error;
      } finally {
        try {
          await activeAgentRuntime.close();
        } catch (closeError) {
          if (piFailure !== undefined) {
            throw new AggregateError(
              [piFailure, closeError],
              "M6 Pi turn and runtime sealing both failed",
            );
          }
          throw closeError;
        } finally {
          activeAgentRuntime = undefined;
        }
      }
      if (
        piResult.provider !== task.publicTask.agentBudget.provider ||
        piResult.model !== task.publicTask.agentBudget.model ||
        piResult.requestedThinkingLevel !==
          task.publicTask.agentBudget.thinkingLevel ||
        piResult.realizedThinkingLevel !==
          task.publicTask.agentBudget.thinkingLevel
      ) {
        throw new Error(
          "M6 Pi realized provider/model/thinking did not match the frozen public task",
        );
      }
      const expectedActiveTools = allTools.map((tool) => tool.name);
      if (
        piResult.activeTools.length !== expectedActiveTools.length ||
        piResult.activeTools.some((name) => !expectedActiveTools.includes(name))
      ) {
        throw new Error(
          "M6 Pi active tool set crossed the frozen Host admission",
        );
      }
      const status: M6AgentTurnResultV1["status"] = admission.exhausted
        ? "aborted"
        : piResult.status === "provider_failed"
          ? "provider_failure"
          : piResult.status;
      return Object.freeze({
        schemaVersion: 1,
        status,
        activeToolNames: Object.freeze([...piResult.activeTools]),
        sourceObservations: Object.freeze([...sourceObservations]),
        executions: Object.freeze([...executions]),
      });
    },

    freezePatch: async ({
      baselineBuild,
      candidateBuild,
    }: Parameters<M6OneTurnAgentPortV1["freezePatch"]>[0]): Promise<{
      readonly patch: ExternalHiddenFixPatchReferenceV1;
      readonly patchIdentity: ExternalHiddenFixPatchIdentityV1;
      readonly admissible: boolean;
      readonly roundTripVerified: boolean;
    }> => {
      if (patchFrozen)
        throw new Error("M6 production candidate patch may freeze only once");
      patchFrozen = true;
      if (
        baselineBuild.sourceHash !==
          task.assignment.assignment.mutatedBaselineSelectedTreeSha256 ||
        candidateBuild.taskId !== task.taskId ||
        candidateBuild.workspaceId !== task.workspaceId
      ) {
        throw new Error(
          "M6 patch handoff crossed its registered assignment baseline or Task",
        );
      }
      const extracted: ExtractedTaskPatch = await dependencies.extractPatch({
        sourceKind: "project-environment-v1",
        taskId: task.taskId,
        workspaceDirectory: task.workspace.workspaceDirectory,
        hostBaselineGitDirectory: task.workspace.hostBaselineGitDirectory,
        hostBaselineCommit: task.workspace.hostBaselineCommit,
        baselineSourceHash: baselineBuild.sourceHash,
        ignoredCachePaths: [],
        hostOperationTemporaryDirectory:
          task.layout.hostOperationTemporaryDirectory,
      });
      if (
        extracted.identity.taskId !== task.taskId ||
        extracted.identity.baselineSourceHash !== baselineBuild.sourceHash ||
        extracted.identity.candidateSourceHash !== candidateBuild.sourceHash ||
        extracted.identity.patchHash !==
          asSha256DigestV1(
            createHash("sha256").update(extracted.patchBytes).digest("hex"),
          ) ||
        extracted.identity.byteLength !== extracted.patchBytes.byteLength
      ) {
        throw new Error(
          "M6 extracted patch detached from the exact candidate Build",
        );
      }
      const patch = await task.patchStore.publishOnce(extracted.patchBytes);
      const patchIdentity = ExternalHiddenFixPatchIdentityV1Schema.parse({
        schemaVersion: 1,
        baselineSelectedTreeSha256: extracted.identity.baselineSourceHash,
        candidateSelectedTreeSha256: extracted.identity.candidateSourceHash,
        patchSha256: extracted.identity.patchHash,
        byteLength: extracted.identity.byteLength,
      });
      if (
        patch.rawSha256 !== patchIdentity.patchSha256 ||
        patch.byteLength !== patchIdentity.byteLength
      ) {
        throw new Error("M6 protected patch store changed patch identity");
      }
      return Object.freeze({
        patch,
        patchIdentity,
        admissible: true,
        roundTripVerified: extracted.roundTripVerified,
      });
    },

    cleanupTask: async (): Promise<{
      readonly proven: boolean;
      readonly receiptSha256: Sha256DigestV1 | null;
    }> => {
      if (cleanupCalled)
        throw new Error("M6 production Task cleanup may run only once");
      cleanupCalled = true;
      const failures: string[] = [];
      try {
        await activeAgentRuntime?.close();
      } catch (error) {
        failures.push(
          error instanceof Error
            ? `Agent runtime close failed: ${error.message}`
            : "Agent runtime close failed",
        );
      } finally {
        activeAgentRuntime = undefined;
      }
      let sandboxCleanup: SandboxCleanupReceiptV1;
      try {
        sandboxCleanup = await task.broker.cleanup();
      } catch (error) {
        throw new Error("M6 sandbox cleanup did not return a receipt", {
          cause: error,
        });
      }
      const proven =
        failures.length === 0 &&
        sandboxCleanup.processGroupTerminated &&
        !sandboxCleanup.cgroupPopulated &&
        sandboxCleanup.scopeRemoved &&
        sandboxCleanup.storageReconciled === true;
      if (!proven && failures.length === 0) {
        failures.push("Task sandbox cleanup receipt was incomplete");
      }
      const receiptSha256 = await task.records.write(
        "cleanup",
        JsonValueSchema.parse({
          schemaVersion: 1,
          taskId: task.taskId,
          sandboxCleanup,
          proven,
          failures,
          completedAt: task.now(),
        }),
      );
      return Object.freeze({ proven, receiptSha256 });
    },
  });
}

export const createM6OneTurnRequestFromPreparedTaskV1 = (
  task: PreparedM6ProjectEnvironmentOneTurnTaskV1,
): M6OneTurnAgentRequestV1 => ({
  assignmentId: task.assignment.assignment.assignmentId,
  taskId: task.taskId,
  workspaceId: task.workspaceId,
  workspaceDirectory: task.workspace.workspaceDirectory,
  baselineSourceHash:
    task.assignment.assignment.mutatedBaselineSelectedTreeSha256,
  pristineAdapterRevision: task.assignment.adapterRevision,
  toolchainReceiptId: task.toolchainReceiptId,
  toolchainArtifactDigest: task.toolchain.executableSha256,
  runtimeIdentity: task.runtimeIdentity,
  policyProfileDigest: task.policyProfileDigest,
  hostCodingToolNames: createVNextCodingToolDefinitions(
    new SandboxPiCodingToolPort(task.broker),
  ).map((tool) => tool.name),
  hostAdmittedGameToolNames: task.hostAdmittedGameToolNames,
  prompt: task.publicTask.goal,
  now: task.now,
});

/**
 * Freezes the exact public assignment, model/budget, tool admission, workspace
 * baseline, and realized sandbox closure before the Pi turn can start.
 */
export const createM6AgentAttemptBindingFromPreparedTaskV1 = (
  task: PreparedM6ProjectEnvironmentOneTurnTaskV1,
): ExternalHiddenFixAgentAttemptBindingV1 => {
  const codingToolRecords = createVNextCodingToolDefinitions(
    new SandboxPiCodingToolPort(task.broker),
  ).map((tool) => ({
    schemaVersion: 1 as const,
    family: "coding",
    name: tool.name,
  }));
  const gameToolRecords = createM6AdmittedGameToolsV1({
    adapterRevision: task.assignment.adapterRevision,
    hostAdmittedToolNames: task.hostAdmittedGameToolNames,
  });
  return ExternalHiddenFixAgentAttemptBindingV1Schema.parse({
    schemaVersion: 1,
    assignmentId: task.assignment.assignment.assignmentId,
    agentProjectionContentSha256:
      task.assignment.agentProjection.projectionContentSha256,
    publicTaskSpecSha256: task.assignment.agentProjection.publicTask.sha256,
    taskId: task.publicTask.taskId,
    provider: task.publicTask.agentBudget.provider,
    model: task.publicTask.agentBudget.model,
    thinkingLevel: task.publicTask.agentBudget.thinkingLevel,
    agentBudgetSha256: jsonDigest(task.publicTask.agentBudget),
    workspaceBaselineSelectedTreeSha256:
      task.workspace.receipt.selectedTreeSha256,
    taskBlindAdapterSha256: task.assignment.assignment.taskBlindAdapterSha256,
    admittedToolSetSha256: jsonDigest({
      schemaVersion: 1,
      codingTools: codingToolRecords,
      gameTools: gameToolRecords,
    }),
    sandboxRealizationSha256: jsonDigest(task.sandboxRealization),
  });
};
