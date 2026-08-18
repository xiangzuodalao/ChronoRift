import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  JsonValueSchema,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentPinnedCaptureV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  asSha256DigestV1,
  asTaskId,
  asWorkspaceId,
  projectRuntimeCleanupCompleteV1,
  type JsonValue,
  type M6AdapterBuildCompatibilityLineageV1,
  type ProjectEnvironmentPinnedCaptureV1,
  type ProjectEnvironmentRuntimeObservationReceiptV1,
  type Sha256DigestV1,
  type VNextBuildV1,
} from "@chronorift/domain";
import { canonicalJson, contentHash } from "@chronorift/json-artifacts";
import type { ProjectEnvironmentGameToolPort } from "@chronorift/pi-harness";

import {
  ExternalHiddenFixHostSourceObservationV1Schema,
  ExternalHiddenFixPublicExecutionEvidenceV1Schema,
  type ExternalHiddenFixHostSourceObservationV1,
  type ExternalHiddenFixPublicExecutionEvidenceV1,
} from "./external-hidden-fix-workflow.js";
import type { LocalExternalHiddenFixPatchStoreV1 } from "./external-hidden-fix-evaluator.js";
import {
  ExternalHiddenFixPublicTaskSpecV1Schema,
  type ExternalHiddenFixPublicTaskSpecV1,
} from "./external-hidden-fix-assignment.js";
import { publishPrivateFileOnceV1 } from "./private-atomic-publication.js";
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
  M7_NATURAL_USER_PROMPT_V1,
  M7RuntimeUseExecutionSummaryV1Schema,
  createM7NeutralRuntimeResourceAppendixV1,
  createM7RuntimeResourceMapV1,
  type M7AgentArmIsolationV1,
  type M7PairedAgentBudgetV1,
  type M7PairedAgentInputV1,
  type M7RuntimeUseClassificationV1,
  type M7RuntimeUseExecutionSummaryV1,
} from "./m7-paired-agent.js";
import {
  M7FrozenPatrolClassifierOutputV1Schema,
  M7SensorFreezeRecordV1Schema,
  type M7FrozenPatrolClassifierOutputV1,
  type M7SensorFreezeRecordV1,
} from "./m7-patrol-sensor.js";
import {
  M7_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1,
  createM7CodingToolSurfaceV1,
  type M7AgentGameToolExchangeV1,
  type M7PreparedCodeOnlyArmV1,
  type M7PreparedProjectEnvironmentPairedAgentPortV1,
  type M7PreparedRuntimeArmV1,
  type M7RuntimeAgentEvidenceSnapshotV1,
} from "./m7-project-environment-paired-agent.js";
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
  createSandboxTaskRuntimeRoot,
  preflightSandboxHost,
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

const PRIVATE_DIRECTORY_MODE = 0o700;

const digestJson = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(JsonValueSchema.parse(value)));

const digestBytes = (bytes: Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

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

const historyLossObserved = (
  receipt: ProjectEnvironmentRuntimeObservationReceiptV1,
): boolean =>
  receipt.loss.length > 0 ||
  receipt.coverage.some(
    (entry) =>
      entry.status !== "complete" ||
      entry.droppedRecords > 0 ||
      entry.overwrittenRecords > 0,
  );

const sameBuildClosure = (left: VNextBuildV1, right: VNextBuildV1): boolean =>
  left.taskId === right.taskId &&
  left.workspaceId === right.workspaceId &&
  left.sourceId === right.sourceId &&
  left.buildId === right.buildId &&
  left.sourceHash === right.sourceHash &&
  left.workspaceDiffHash === right.workspaceDiffHash &&
  left.buildConfigurationHash === right.buildConfigurationHash &&
  left.outputHash === right.outputHash;

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
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new TypeError(`${label} must be a real directory`);
  }
  if ((await readdir(path)).length !== 0) {
    throw new TypeError(`${label} must be fresh and empty`);
  }
  return path;
};

const exchangeContains = (
  exchange: M7AgentGameToolExchangeV1,
  ...identities: readonly string[]
): boolean => {
  const bytes = canonicalJson(
    JsonValueSchema.parse({
      input: exchange.input,
      response: exchange.response,
    }),
  );
  return identities.every((identity) => bytes.includes(identity));
};

interface M7ImmutableRecordWriterV1 {
  writeOnce(kind: string, payload: JsonValue): Promise<Sha256DigestV1>;
}

class M7PrivateRecordWriterV1 implements M7ImmutableRecordWriterV1 {
  public constructor(
    private readonly root: string,
    private readonly taskId: string,
  ) {}

  public async writeOnce(
    kind: string,
    untrustedPayload: JsonValue,
  ): Promise<Sha256DigestV1> {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(kind)) {
      throw new TypeError("M7 record kind is invalid");
    }
    const payload = JsonValueSchema.parse(untrustedPayload);
    const basis = JsonValueSchema.parse({
      schemaVersion: 1,
      recordKind: `m7-${kind}`,
      taskId: this.taskId,
      payload,
    });
    const receiptSha256 = digestJson(basis);
    const filename = `${kind}-${receiptSha256}.json`;
    const record = JsonValueSchema.parse({
      schemaVersion: 1,
      recordKind: `m7-${kind}`,
      taskId: this.taskId,
      payload,
      receiptSha256,
    });
    const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
    await publishPrivateFileOnceV1({ root: this.root, filename, bytes });
    return receiptSha256;
  }
}

const createRecordWriter = async (
  layout: ProjectEnvironmentTaskDirectoryLayout,
  taskId: string,
): Promise<M7ImmutableRecordWriterV1> => {
  const root = join(layout.taskRecordDirectory, "m7-paired");
  await mkdir(root, { mode: PRIVATE_DIRECTORY_MODE });
  await chmod(root, PRIVATE_DIRECTORY_MODE);
  return new M7PrivateRecordWriterV1(root, taskId);
};

export interface M7FrozenPatrolClassifierRunnerV1 {
  readonly implementationSha256: Sha256DigestV1;
  classify(input: JsonValue): Promise<M7FrozenPatrolClassifierOutputV1>;
}

type FrozenClassifierModule = {
  readonly classifyM7PatrolExecutionV1: (input: JsonValue) => Promise<unknown>;
};

/**
 * Loads only the preregistered public checker bytes. This Host import is
 * intentionally narrow: every call reopens with O_NOFOLLOW and rehashes the
 * module, and the only argument contains Agent-visible exchanges with an empty
 * pinnedCaptures array. It never receives hidden/runtime-store/auth paths.
 */
export async function loadM7FrozenPatrolClassifierV1(input: {
  readonly modulePath: string;
  readonly expectedImplementationSha256: Sha256DigestV1;
}): Promise<M7FrozenPatrolClassifierRunnerV1> {
  const canonicalPath = await realpath(input.modulePath);
  if (canonicalPath !== input.modulePath) {
    throw new TypeError("M7 frozen classifier path must be canonical");
  }
  const metadata = await lstat(canonicalPath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new TypeError("M7 frozen classifier must be a one-link regular file");
  }
  const readAndVerify = async (): Promise<Uint8Array> => {
    const handle = await open(
      canonicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      const bytes = Uint8Array.from(await handle.readFile());
      const after = await handle.stat();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        digestBytes(bytes) !== input.expectedImplementationSha256
      ) {
        throw new Error("M7 frozen classifier bytes changed");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  };
  await readAndVerify();
  const untrustedModule: unknown = await import(
    `${pathToFileURL(canonicalPath).href}?sha256=${input.expectedImplementationSha256}`
  );
  if (
    typeof untrustedModule !== "object" ||
    untrustedModule === null ||
    !("classifyM7PatrolExecutionV1" in untrustedModule) ||
    typeof untrustedModule.classifyM7PatrolExecutionV1 !== "function"
  ) {
    throw new TypeError(
      "M7 frozen classifier omitted classifyM7PatrolExecutionV1",
    );
  }
  const module = untrustedModule as FrozenClassifierModule;
  return Object.freeze({
    implementationSha256: input.expectedImplementationSha256,
    classify: async (untrustedInput: JsonValue) => {
      await readAndVerify();
      const classifierInput = JsonValueSchema.parse(untrustedInput);
      return M7FrozenPatrolClassifierOutputV1Schema.parse(
        await module.classifyM7PatrolExecutionV1(classifierInput),
      );
    },
  });
}

export interface M7ActualVisibleClassificationV1 {
  readonly input: JsonValue;
  readonly inputSha256: Sha256DigestV1;
  readonly output: M7FrozenPatrolClassifierOutputV1;
  readonly outputSha256: Sha256DigestV1;
  readonly classification: M7RuntimeUseClassificationV1;
  readonly classificationHostToolReturnOrdinal: number | null;
}

export const selectM7AgentVisibleExecutionExchangesV1 = (input: {
  readonly exchanges: readonly M7AgentGameToolExchangeV1[];
  readonly executionId: string;
  readonly runtimeId: string;
}): readonly M7AgentGameToolExchangeV1[] =>
  Object.freeze(
    input.exchanges
      .filter(
        (exchange) =>
          exchangeContains(exchange, input.executionId) ||
          exchangeContains(exchange, input.runtimeId),
      )
      .sort(
        (left, right) =>
          left.hostToolReturnOrdinal - right.hostToolReturnOrdinal,
      ),
  );

/** Classifies prefixes only; backend pinned/runtime records are never inputs. */
export async function classifyM7ActualVisibleExchangePrefixV1(input: {
  readonly exchanges: readonly M7AgentGameToolExchangeV1[];
  readonly classifier: M7FrozenPatrolClassifierRunnerV1;
}): Promise<M7ActualVisibleClassificationV1> {
  const exchanges = [...input.exchanges].sort(
    (left, right) => left.hostToolReturnOrdinal - right.hostToolReturnOrdinal,
  );
  if (
    exchanges.some(
      (exchange, index) =>
        index > 0 &&
        exchange.hostToolReturnOrdinal <=
          (exchanges[index - 1]?.hostToolReturnOrdinal ?? 0),
    )
  ) {
    throw new TypeError("M7 Agent-visible exchange ordinals must be unique");
  }
  let selectedInput: JsonValue = JsonValueSchema.parse({
    gameToolExchanges: [],
    pinnedCaptures: [],
  });
  let selectedOutput = await input.classifier.classify(selectedInput);
  let deliveryOrdinal: number | null = null;
  for (const [index, exchange] of exchanges.entries()) {
    const prefix = exchanges.slice(0, index + 1);
    const classifierInput = JsonValueSchema.parse({
      gameToolExchanges: prefix,
      pinnedCaptures: [],
    });
    const output = await input.classifier.classify(classifierInput);
    selectedInput = classifierInput;
    selectedOutput = output;
    if (output.classification !== "insufficient_observation") {
      deliveryOrdinal = exchange.hostToolReturnOrdinal;
      break;
    }
  }
  const classification: M7RuntimeUseClassificationV1 =
    selectedOutput.classification === "insufficient_observation"
      ? "insufficient"
      : selectedOutput.classification;
  return Object.freeze({
    input: selectedInput,
    inputSha256: digestJson(selectedInput),
    output: selectedOutput,
    outputSha256: digestJson(selectedOutput),
    classification,
    classificationHostToolReturnOrdinal: deliveryOrdinal,
  });
}

interface M7GameRuntimeV1 extends ProjectEnvironmentGameToolPort {
  adapterBuildCompatibilityIdentity(): ReturnType<
    ProjectEnvironmentGameRuntimeV1["adapterBuildCompatibilityIdentity"]
  >;
  close(): Promise<void>;
}

interface M7PreparationDependenciesV1 {
  readonly prepareBuild: typeof prepareM6ExactGodotBuildV1;
  readonly runCompatibility: typeof runM6AdapterBuildCompatibilityV1;
  readonly createRuntime: (
    options: ProjectEnvironmentGameRuntimeOptionsV1,
  ) => M7GameRuntimeV1;
  readonly createSidecar: (
    options: ConstructorParameters<
      typeof GodotProjectEnvironmentSidecarPortV1
    >[0],
  ) => ProjectEnvironmentGameRuntimeOptionsV1["sidecar"];
  readonly createBroker: typeof createDuplexBwrapCgroupTaskSandbox;
  readonly loadClassifier: typeof loadM7FrozenPatrolClassifierV1;
}

const DEFAULT_DEPENDENCIES: M7PreparationDependenciesV1 = {
  prepareBuild: prepareM6ExactGodotBuildV1,
  runCompatibility: runM6AdapterBuildCompatibilityV1,
  createRuntime: (options) => new ProjectEnvironmentGameRuntimeV1(options),
  createSidecar: (options) => new GodotProjectEnvironmentSidecarPortV1(options),
  createBroker: (options) => createDuplexBwrapCgroupTaskSandbox(options),
  loadClassifier: loadM7FrozenPatrolClassifierV1,
};

export interface PrepareM7PairedInfrastructureFromM6RuntimeTaskV1Input {
  /** Ownership transfers to this paired preparation. */
  readonly runtimeTask: PreparedM6ProjectEnvironmentOneTurnTaskV1;
  readonly codeOnlyPatchStore: LocalExternalHiddenFixPatchStoreV1;
  readonly sensorFreeze: M7SensorFreezeRecordV1;
  readonly frozenClassifierModulePath: string;
  readonly codeOnlyPublicTask: ExternalHiddenFixPublicTaskSpecV1;
  readonly codeOnlyPublicTaskSpecSha256: Sha256DigestV1;
  readonly runtimeAgentResourceDirectory: string;
  readonly codeOnlyAgentResourceDirectory: string;
  /** Opaque non-secret identity of the common Host model runtime config. */
  readonly hostModelRuntimeConfigSha256: Sha256DigestV1;
  readonly hostConfigPath?: string | undefined;
}

export interface M7PairedInfrastructureRegistrationInputsV1 {
  readonly schemaVersion: 1;
  readonly baselineSelectedTreeSha256: Sha256DigestV1;
  readonly codingToolSetSha256: Sha256DigestV1;
  readonly sandboxPolicySha256: Sha256DigestV1;
  readonly runtimeGameToolSetSha256: Sha256DigestV1;
  readonly runtimeResourceAppendixSha256: Sha256DigestV1;
  readonly mutantCompatibilityReceiptSha256: Sha256DigestV1;
  readonly runtimeTaskId: string;
  readonly codeOnlyTaskId: string;
  readonly runtimeArmPublicTaskSpecSha256: Sha256DigestV1;
  readonly codeOnlyArmPublicTaskSpecSha256: Sha256DigestV1;
  readonly hostModelRuntimeConfigSha256: Sha256DigestV1;
  readonly runtimeIsolation: M7AgentArmIsolationV1;
  readonly codeOnlyIsolation: M7AgentArmIsolationV1;
}

export interface M7BindPreparedPairedInfrastructureV1Input {
  readonly campaignId: string;
  readonly publicTaskSpecSha256: Sha256DigestV1;
  readonly sensorFreezeRecordSha256: Sha256DigestV1;
}

export type M7RemainingArmCleanupV1 =
  | Readonly<{
      schemaVersion: 1;
      arm: "runtime_enabled" | "code_only";
      state: "started_not_touched";
      receiptSha256: null;
    }>
  | Readonly<{
      schemaVersion: 1;
      arm: "runtime_enabled" | "code_only";
      state: "cleaned_unstarted";
      receiptSha256: Sha256DigestV1;
    }>;

export interface M7RemainingArmsCleanupResultV1 {
  readonly schemaVersion: 1;
  readonly runtimeArm: M7RemainingArmCleanupV1;
  readonly codeOnlyArm: M7RemainingArmCleanupV1;
}

export interface M7PreAgentSandboxDryRunResultV1 {
  readonly schemaVersion: 1;
  readonly runtimeArm: {
    readonly schemaVersion: 1;
    readonly arm: "runtime_enabled";
    readonly sentinelReceiptSha256: Sha256DigestV1;
    readonly cleanupReceiptSha256: Sha256DigestV1;
  };
  readonly codeOnlyArm: {
    readonly schemaVersion: 1;
    readonly arm: "code_only";
    readonly sentinelReceiptSha256: Sha256DigestV1;
    readonly cleanupReceiptSha256: Sha256DigestV1;
  };
}

export interface M7BoundPairedProjectEnvironmentV1 {
  readonly pairedInput: M7PairedAgentInputV1;
  readonly runtimeArm: M7PreparedRuntimeArmV1;
  readonly codeOnlyArm: M7PreparedCodeOnlyArmV1;
  abortBeforeAgent(): Promise<{
    readonly runtimeReceiptSha256: Sha256DigestV1;
    readonly codeOnlyReceiptSha256: Sha256DigestV1;
  }>;
  /**
   * Terminalizes this preparation after a surrounding Gate failure. Arms
   * whose Agent start was already claimed are never touched; every unstarted
   * arm is cleaned exactly once and receives a durable receipt.
   */
  cleanupRemainingAfterGateFailure(): Promise<M7RemainingArmsCleanupResultV1>;
  /**
   * Validates both coding sandboxes without starting Pi, cleaning the runtime
   * arm before the code-only sentinel touches the shared delegated cgroup.
   */
  runPreAgentSandboxDryRunAndCleanup(
    sentinelPort: Pick<
      M7PreparedProjectEnvironmentPairedAgentPortV1,
      "runPreAgentSandboxSentinelOnce"
    >,
  ): Promise<M7PreAgentSandboxDryRunResultV1>;
}

export interface M7PreparedPairedProjectEnvironmentInfrastructureV1 {
  readonly schemaVersion: 1;
  readonly registrationInputs: M7PairedInfrastructureRegistrationInputsV1;
  /** Binds campaign registration without starting either Agent arm. */
  bindCampaignOnce(
    input: M7BindPreparedPairedInfrastructureV1Input,
  ): M7BoundPairedProjectEnvironmentV1;
  /** Cleanup path when campaign registration cannot be committed. */
  abortPreparation(): Promise<void>;
}

interface PreparedCodeOnlyTaskV1 {
  readonly taskId: ReturnType<typeof asTaskId>;
  readonly workspaceId: ReturnType<typeof asWorkspaceId>;
  readonly layout: ProjectEnvironmentTaskDirectoryLayout;
  readonly workspace: MaterializedProjectEnvironmentWorkspaceV1;
  readonly broker: DuplexTaskSandboxBrokerV1;
  readonly policyProfileSha256: Sha256DigestV1;
  readonly sandboxInstanceSha256: Sha256DigestV1;
  readonly codingToolchainTargets: readonly string[];
  readonly agentResourceDirectory: string;
  readonly records: M7ImmutableRecordWriterV1;
}

const M7_CODING_TOOLCHAIN_COMMANDS_V1 = Object.freeze([
  { target: "/bin/bash", hostConfigKey: "bashPath" as const },
  { target: "/usr/bin/rg", hostConfigKey: "rgPath" as const },
  { target: "/usr/bin/find", hostConfigKey: "findPath" as const },
  { target: "/usr/bin/ls", hostConfigKey: "lsPath" as const },
]);

export const deriveM7RuntimeTreatmentExclusiveTargetsV1 = (
  task: PreparedM6ProjectEnvironmentOneTurnTaskV1,
  ordinaryCodingTargets: readonly string[],
): readonly string[] => {
  const ordinaryCodingTargetSet = new Set(ordinaryCodingTargets);
  if (
    ordinaryCodingTargetSet.size !== ordinaryCodingTargets.length ||
    ordinaryCodingTargets.some(
      (target) => !isAbsolute(target) || resolve(target) !== target,
    )
  ) {
    throw new TypeError(
      "M7 coding toolchain targets must be unique absolute paths",
    );
  }
  return Object.freeze(
    [
      ...task.managedRuntime.capability.toolchain.files.map(
        (file) => file.target,
      ),
      task.managedRuntime.capability.fontconfigTarget,
      task.managedRuntime.capability.addonParentTarget,
      task.managedRuntime.capability.addonTarget,
      task.managedRuntime.capability.overlayTarget,
      task.managedRuntime.capability.adapterParentTarget,
      task.managedRuntime.capability.adapterTarget,
    ].filter((target) => !ordinaryCodingTargetSet.has(target)),
  );
};

const createCodeOnlyTask = async (input: {
  readonly runtimeTask: PreparedM6ProjectEnvironmentOneTurnTaskV1;
  readonly codeOnlyTaskId: string;
  readonly agentResourceDirectory: string;
  readonly hostConfigPath?: string | undefined;
  readonly createBroker: typeof createDuplexBwrapCgroupTaskSandbox;
}): Promise<PreparedCodeOnlyTaskV1> => {
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
    throw new Error("M7 code-only sandbox preflight failed");
  }
  const taskId = asTaskId(input.codeOnlyTaskId);
  const workspaceId = asWorkspaceId(`workspace.v1.${taskId}`);
  const layout = await createProjectEnvironmentTaskDirectoryLayout({
    runtimeRoot,
    sourceRepositoryRoot:
      input.runtimeTask.assignment.mutatedSource.repositoryRoot,
    taskId,
  });
  const workspace = await materializePrivateTaskWorkspace({
    taskId,
    source: input.runtimeTask.assignment.mutatedSource,
    layout,
  });
  const expectedBaseline =
    input.runtimeTask.assignment.assignment.mutatedBaselineSelectedTreeSha256;
  if (workspace.receipt.selectedTreeSha256 !== expectedBaseline) {
    throw new Error("M7 code-only workspace changed from the mutant baseline");
  }
  const codingToolchain = await inspectSandboxToolchain({
    lddPath: hostConfig.lddPath,
    commands: M7_CODING_TOOLCHAIN_COMMANDS_V1.map((command) => ({
      target: command.target,
      hostPath: hostConfig[command.hostConfigKey],
    })),
  });
  const policy = createSandboxPolicyV1(sandbox.capability.runtimeIdentity, {
    toolchainId: codingToolchain.capability.toolchainId,
    targets: codingToolchain.capability.files.map((file) => file.target),
  });
  const broker = await input.createBroker({
    taskId,
    capability: sandbox.capability,
    hostBinding: sandbox.binding,
    policy,
    toolchain: codingToolchain,
    // Deliberately no managedRuntime: this is the actual Agent broker.
    layout,
    securityEvents: () => Promise.resolve(),
  });
  try {
    const records = await createRecordWriter(layout, taskId);
    const agentResourceDirectory = await requireFreshCanonicalDirectory(
      input.agentResourceDirectory,
      "M7 code-only Agent resource directory",
    );
    const commonCodingProfile = JsonValueSchema.parse({
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
    return Object.freeze({
      taskId,
      workspaceId,
      layout,
      workspace,
      broker,
      policyProfileSha256: digestJson(commonCodingProfile),
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
      records,
    });
  } catch (error) {
    let cleanup;
    try {
      cleanup = await broker.cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "M7 code-only preparation and cleanup both failed",
      );
    }
    if (!cleanupComplete(cleanup)) {
      throw new AggregateError(
        [error, new Error("M7 code-only cleanup receipt was incomplete")],
        "M7 code-only preparation failed without cleanup proof",
      );
    }
    throw error;
  }
};

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

const prepareRuntimeSurface = async (input: {
  readonly task: PreparedM6ProjectEnvironmentOneTurnTaskV1;
  readonly records: M7ImmutableRecordWriterV1;
  readonly classifier: M7FrozenPatrolClassifierRunnerV1;
  readonly dependencies: M7PreparationDependenciesV1;
}): Promise<{
  readonly surface: M7PreparedRuntimeArmV1["runtime"];
  readonly baseline: PreparedM6ExactGodotBuildV1;
  readonly compatibilityReceiptSha256: Sha256DigestV1;
}> => {
  const { task } = input;
  const adapterRevision = ProjectAdapterRevisionV1Schema.parse(
    task.assignment.adapterRevision,
  );
  const baselineSourceHash =
    task.assignment.assignment.mutatedBaselineSelectedTreeSha256;
  const builds = new Map<string, PreparedM6ExactGodotBuildV1>();
  const compatibleBuildIds = new Set<string>();
  const sourceObservations: ExternalHiddenFixHostSourceObservationV1[] = [];
  const runtimeReceipts: ProjectEnvironmentRuntimeObservationReceiptV1[] = [];
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
    readonly persistEvidence: boolean;
    readonly resolveCompatibleBuild?:
      (() => Promise<ProjectEnvironmentRuntimeBuildV1>) | undefined;
  }): M7GameRuntimeV1 => {
    const persistPinnedCapture = options.persistEvidence
      ? async (
          captureInput: ProjectEnvironmentPinnedCaptureV1,
          recordInputs: readonly JsonValue[],
        ): Promise<void> => {
          const capture =
            ProjectEnvironmentPinnedCaptureV1Schema.parse(captureInput);
          const records = recordInputs.map((record) =>
            JsonValueSchema.parse(record),
          );
          if (
            capture.taskId !== task.taskId ||
            capture.buildId !== options.prepared.build.buildId ||
            capture.adapterRevisionId !== adapterRevision.adapterRevisionId ||
            capture.environmentRevisionId !==
              task.internalAdapterOverlayNamespace
          ) {
            throw new Error("M7 pinned capture crossed runtime lineage");
          }
          await task.taskStore.putPinnedCaptureOnce(capture, records);
          const prior = captures.get(capture.executionId) ?? [];
          prior.push(
            Object.freeze({ capture, records: Object.freeze(records) }),
          );
          captures.set(capture.executionId, prior);
        }
      : undefined;
    const persistRuntimeObservation = options.persistEvidence
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
            throw new Error("M7 runtime receipt crossed exact Build lineage");
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
  ) => {
    const current = await freezeCurrentBuild();
    if (!sameBuildClosure(prepared.build, current.build)) {
      throw new Error(
        "M7 compatibility request detached from current workspace bytes",
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
      runtime: createRuntime({ prepared, persistEvidence: false }),
      launchTargetId: task.launchTargetId,
      now: task.now,
    });
    const receiptSha256 = await input.records.writeOnce(
      "compatibility",
      JsonValueSchema.parse({
        schemaVersion: 1,
        identitySemantics:
          "pristine AdapterRevision -> exact mutated Build compatibility",
        receipt: result.receipt,
      }),
    );
    if (result.receipt.outcome !== "compatible") {
      throw new Error("M7 exact Build failed frozen Adapter compatibility");
    }
    compatibleBuildIds.add(prepared.build.buildId);
    return Object.freeze({ receipt: result.receipt, receiptSha256 });
  };

  const baseline = await freezeCurrentBuild();
  if (baseline.build.sourceHash !== baselineSourceHash) {
    throw new Error("M7 runtime Build is not the registered mutant baseline");
  }
  const baselineCompatibility = await runCompatibility(
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

  const resolveCompatibleBuild = async () => {
    const prepared = await freezeCurrentBuild();
    if (!compatibleBuildIds.has(prepared.build.buildId)) {
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
    persistEvidence: true,
    resolveCompatibleBuild,
  });
  let evidenceRead = false;

  const readAgentEvidence: M7PreparedRuntimeArmV1["runtime"]["readAgentEvidence"] =
    async (request): Promise<M7RuntimeAgentEvidenceSnapshotV1> => {
      if (evidenceRead) {
        throw new Error("M7 runtime Agent evidence may be frozen only once");
      }
      evidenceRead = true;
      const executions: ExternalHiddenFixPublicExecutionEvidenceV1[] = [];
      const summaries: M7RuntimeUseExecutionSummaryV1[] = [];
      const executionAudits: JsonValue[] = [];
      for (const receipt of runtimeReceipts) {
        const prepared = builds.get(receipt.buildId);
        if (prepared === undefined) {
          throw new Error("M7 runtime receipt lost its exact Build");
        }
        const linkedExchanges = selectM7AgentVisibleExecutionExchangesV1({
          exchanges: request.exchanges,
          executionId: receipt.executionId,
          runtimeId: receipt.runtimeId,
        });
        if (linkedExchanges.length === 0) continue;
        const classified = await classifyM7ActualVisibleExchangePrefixV1({
          exchanges: linkedExchanges,
          classifier: input.classifier,
        });
        const gameSourceChanges = sourceObservations
          .filter((entry) => entry.sourceSha256 !== baselineSourceHash)
          .map((entry) => {
            const exchange = request.exchanges
              .filter(
                (candidate) =>
                  entry.buildId !== null &&
                  exchangeContains(candidate, entry.buildId),
              )
              .sort(
                (left, right) =>
                  left.hostToolReturnOrdinal - right.hostToolReturnOrdinal,
              )[0];
            return exchange === undefined
              ? null
              : {
                  ...entry,
                  boundary: "game_build_freeze" as const,
                  hostToolReturnOrdinal: exchange.hostToolReturnOrdinal,
                };
          })
          .filter((entry) => entry !== null);
        const firstHostObservedSourceChange = [
          ...request.hostSourceChangeBoundaries.filter(
            (entry) => entry.sourceSha256 !== baselineSourceHash,
          ),
          ...gameSourceChanges,
        ].sort(
          (left, right) =>
            left.hostToolReturnOrdinal - right.hostToolReturnOrdinal,
        )[0];
        const sealExchange = linkedExchanges.find(
          (exchange) => exchange.toolName === "game_stop",
        );
        const runtimeReceiptSha256 = digestJson(receipt);
        const execution =
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
            publicSymptomObserved: classified.classification !== "insufficient",
            publicObservationSha256: classified.outputSha256,
          });
        const summary = M7RuntimeUseExecutionSummaryV1Schema.parse({
          schemaVersion: 1,
          executionId: execution.executionId,
          buildId: execution.buildId,
          sourceSha256: execution.sourceSha256,
          startedAt: execution.startedAt,
          endedAt: execution.endedAt,
          sealed: true,
          coverageComplete: execution.coverageComplete,
          historyLossObserved: historyLossObserved(receipt),
          cleanupProven: execution.cleanupProven,
          runtimeObservationReceiptSha256: runtimeReceiptSha256,
          classifierImplementationSha256: input.classifier.implementationSha256,
          classifierInputSha256: classified.inputSha256,
          sealHostToolReturnOrdinal:
            sealExchange?.hostToolReturnOrdinal ?? null,
          classificationHostToolReturnOrdinal:
            classified.classificationHostToolReturnOrdinal,
          classification: classified.classification,
          classificationOutput: classified.output,
          classificationOutputSha256: classified.outputSha256,
          firstHostObservedSourceChange: firstHostObservedSourceChange ?? null,
        });
        executions.push(execution);
        summaries.push(summary);
        executionAudits.push(
          JsonValueSchema.parse({
            schemaVersion: 1,
            execution,
            summary,
            classifierInput: classified.input,
            runtimeObservationReceipt: receipt,
            backendPinnedCaptures: (
              captures.get(receipt.executionId) ?? []
            ).map((entry) => ({
              capture: entry.capture,
              records: entry.records,
              excludedFromClassifierInput: true,
            })),
          }),
        );
      }
      const receiptSha256 = await input.records.writeOnce(
        "runtime-agent-evidence",
        JsonValueSchema.parse({
          schemaVersion: 1,
          exchangeTranscriptSha256: request.exchangeTranscriptSha256,
          agentVisibleGameToolExchanges: request.exchanges,
          classifierImplementationSha256: input.classifier.implementationSha256,
          classifierPinnedCaptures: [],
          executionAudits,
          sourceObservations,
        }),
      );
      return Object.freeze({
        sourceObservations: Object.freeze([...sourceObservations]),
        executions: Object.freeze(executions),
        runtimeUseSummaries: Object.freeze(summaries),
        receiptSha256,
      });
    };

  return Object.freeze({
    baseline,
    compatibilityReceiptSha256: baselineCompatibility.receiptSha256,
    surface: Object.freeze({
      pristineAdapterRevision: adapterRevision,
      resourceMap: createM7RuntimeResourceMapV1({
        schemaVersion: 1,
        taskId: task.taskId,
        baselineBuildId: baseline.build.buildId,
        baselineSourceId: baseline.build.sourceId,
        launchTargetId: task.launchTargetId,
      }),
      gameToolPort: agentRuntime,
      close: () => agentRuntime.close(),
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

const samePublicArmContract = (
  runtimeTask: ExternalHiddenFixPublicTaskSpecV1,
  codeOnlyTask: ExternalHiddenFixPublicTaskSpecV1,
): boolean => {
  const { taskId: _runtimeTaskId, ...runtimeCommon } = runtimeTask;
  const { taskId: _codeOnlyTaskId, ...codeOnlyCommon } = codeOnlyTask;
  void _runtimeTaskId;
  void _codeOnlyTaskId;
  return canonicalJson(runtimeCommon) === canonicalJson(codeOnlyCommon);
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

/**
 * The sensor freeze is authoritative for the pre-mutation Adapter and
 * pristine subject. A prepared M6 task must not merely reuse the classifier
 * hash while substituting another (possibly bug-specific) Adapter package.
 */
export const assertM7PreparedAssignmentMatchesSensorFreezeV1 = (
  assignment: PreparedM6ProjectEnvironmentOneTurnTaskV1["assignment"],
  untrustedSensorFreeze: M7SensorFreezeRecordV1,
): void => {
  const sensorFreeze = M7SensorFreezeRecordV1Schema.parse(
    untrustedSensorFreeze,
  );
  const adapterRevision = ProjectAdapterRevisionV1Schema.parse(
    assignment.adapterRevision,
  );
  const subjectProjectSha256 = digestJson({
    schemaVersion: 1,
    repository: sensorFreeze.pristineSubject.repository,
    revision: assignment.pristineSource.headCommit,
    projectSourceIdentity: assignment.pristineSource.projectSourceIdentity,
    selectedTreeSha256: assignment.pristineSource.selectedTreeSha256,
  });
  if (
    adapterRevision.adapterRevisionId !==
      sensorFreeze.sensor.adapterRevisionId ||
    adapterRevision.sourceId !== sensorFreeze.pristineSubject.sourceId ||
    adapterRevision.conformanceReceiptId !==
      sensorFreeze.sensor.pristineConformanceReceiptId ||
    assignment.adapterPackage.candidateSha256 !==
      adapterRevision.packageDigest ||
    assignment.adapterConformanceReceipt.receiptId !==
      sensorFreeze.sensor.pristineConformanceReceiptId ||
    assignment.agentProjection.adapter.adapterRevisionId !==
      sensorFreeze.sensor.adapterRevisionId ||
    assignment.agentProjection.adapter.packageSha256 !==
      adapterRevision.packageDigest ||
    assignment.agentProjection.adapter.conformanceReceiptSha256 !==
      sensorFreeze.sensor.pristineConformanceReceiptSha256 ||
    assignment.assignment.pristineSelectedTreeSha256 !==
      sensorFreeze.pristineSubject.selectedTreeSha256 ||
    assignment.pristineSource.selectedTreeSha256 !==
      sensorFreeze.pristineSubject.selectedTreeSha256 ||
    subjectProjectSha256 !==
      sensorFreeze.pristineSubject.subjectProjectSha256 ||
    assignment.pristineSource.headCommit !==
      sensorFreeze.pristineSubject.revision
  ) {
    throw new TypeError(
      "M7 runtime Task substituted a different Adapter or pristine subject after the sensor freeze",
    );
  }
};

/**
 * Production two-stage preparation. It consumes one shared assignment
 * authority, keeps two independently materialized Tasks, and performs no model
 * call. Campaign registration is bound only by bindCampaignOnce.
 */
export async function prepareM7PairedInfrastructureFromM6RuntimeTaskV1(
  untrustedInput: PrepareM7PairedInfrastructureFromM6RuntimeTaskV1Input,
  overrides: Partial<M7PreparationDependenciesV1> = {},
): Promise<M7PreparedPairedProjectEnvironmentInfrastructureV1> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const runtimeTask = untrustedInput.runtimeTask;
  const sensorFreeze = M7SensorFreezeRecordV1Schema.parse(
    untrustedInput.sensorFreeze,
  );
  assertM7PreparedAssignmentMatchesSensorFreezeV1(
    runtimeTask.assignment,
    sensorFreeze,
  );
  const codeOnlyPublicTask = ExternalHiddenFixPublicTaskSpecV1Schema.parse(
    untrustedInput.codeOnlyPublicTask,
  );
  const runtimePublicTask = ExternalHiddenFixPublicTaskSpecV1Schema.parse(
    runtimeTask.publicTask,
  );
  const hostModelRuntimeConfigSha256 = asSha256DigestV1(
    untrustedInput.hostModelRuntimeConfigSha256,
  );
  if (
    runtimePublicTask.goal !== M7_NATURAL_USER_PROMPT_V1 ||
    codeOnlyPublicTask.goal !== M7_NATURAL_USER_PROMPT_V1 ||
    runtimePublicTask.taskId === codeOnlyPublicTask.taskId ||
    runtimeTask.taskId !== runtimePublicTask.taskId ||
    !samePublicArmContract(runtimePublicTask, codeOnlyPublicTask)
  ) {
    throw new TypeError(
      "M7 arm bootstrap tasks must differ only by their frozen Task identity",
    );
  }
  if (
    runtimePublicTask.publicExecutionClassifier.classifierId !==
      sensorFreeze.sensor.classifierId ||
    runtimePublicTask.publicExecutionClassifier.implementationSha256 !==
      sensorFreeze.sensor.classifierImplementationSha256
  ) {
    throw new TypeError(
      "M7 runtime bootstrap task crossed the pre-mutation sensor classifier",
    );
  }
  const runtimeAgentResourceDirectory = await requireFreshCanonicalDirectory(
    untrustedInput.runtimeAgentResourceDirectory,
    "M7 runtime Agent resource directory",
  );
  if (runtimeTask.agentDir !== runtimeAgentResourceDirectory) {
    throw new TypeError(
      "M7 runtime Task did not bind the declared fresh Agent resource directory",
    );
  }
  await requireFreshCanonicalDirectory(
    runtimeTask.layout.piSessionDirectory,
    "M7 runtime Session directory",
  );
  const classifier = await dependencies.loadClassifier({
    modulePath: untrustedInput.frozenClassifierModulePath,
    expectedImplementationSha256:
      sensorFreeze.sensor.classifierImplementationSha256,
  });
  let codeOnlyTask: PreparedCodeOnlyTaskV1 | undefined;
  let runtimeSurfaceToClose: M7PreparedRuntimeArmV1["runtime"] | undefined;
  try {
    codeOnlyTask = await createCodeOnlyTask({
      runtimeTask,
      codeOnlyTaskId: codeOnlyPublicTask.taskId,
      agentResourceDirectory: untrustedInput.codeOnlyAgentResourceDirectory,
      hostConfigPath: untrustedInput.hostConfigPath,
      createBroker: dependencies.createBroker,
    });
    const preparedCodeOnlyTask = codeOnlyTask;
    const runtimeRecords = await createRecordWriter(
      runtimeTask.layout,
      runtimeTask.taskId,
    );
    const runtimePrepared = await prepareRuntimeSurface({
      task: runtimeTask,
      records: runtimeRecords,
      classifier,
      dependencies,
    });
    runtimeSurfaceToClose = runtimePrepared.surface;
    const runtimeCodingTools = createM7CodingToolSurfaceV1(runtimeTask.broker);
    const codeOnlyCodingTools = createM7CodingToolSurfaceV1(
      preparedCodeOnlyTask.broker,
    );
    if (
      canonicalJson(runtimeCodingTools as never) !==
      canonicalJson(codeOnlyCodingTools as never)
    ) {
      throw new TypeError("M7 paired coding tool definitions are not equal");
    }
    const commonCodingProfileSha256 = preparedCodeOnlyTask.policyProfileSha256;
    if (runtimeTask.codingSandboxProfileSha256 !== commonCodingProfileSha256) {
      throw new TypeError(
        "M7 runtime/code-only actual coding-default sandbox profiles differ",
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
      sandboxProfileSha256: commonCodingProfileSha256,
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
      sandboxProfileSha256: commonCodingProfileSha256,
      workspaceBaselineSelectedTreeSha256: baselineSelectedTreeSha256,
      readableSurfaces: armReadableSurfaces(false),
    };
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
    ]);
    let bound = false;
    let aborted = false;
    let anyAgentStarted = false;
    const startedArms = new Set<"runtime_enabled" | "code_only">();
    const markAgentStarted = (arm: "runtime_enabled" | "code_only") => {
      if (aborted) {
        throw new Error(
          `M7 ${arm} Agent cannot start after preparation terminalization`,
        );
      }
      if (startedArms.has(arm)) {
        throw new Error(`M7 ${arm} Agent start may be claimed only once`);
      }
      startedArms.add(arm);
      anyAgentStarted = true;
    };
    const runtimeArm: M7PreparedRuntimeArmV1 = {
      arm: "runtime_enabled",
      isolation: runtimeIsolation,
      workspaceDirectory: runtimeTask.workspace.workspaceDirectory,
      sessionDirectory: runtimeTask.layout.piSessionDirectory,
      agentResourceDirectory: runtimeAgentResourceDirectory,
      broker: runtimeTask.broker,
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
      persistCleanupReceiptOnce: (record) =>
        runtimeRecords.writeOnce("cleanup", record),
      persistSandboxSentinelReceiptOnce: (record) =>
        runtimeRecords.writeOnce("sandbox-sentinel", record),
      markAgentStartedOnce: () => markAgentStarted("runtime_enabled"),
      runtime: runtimePrepared.surface,
    };
    const codeOnlyArm: M7PreparedCodeOnlyArmV1 = {
      arm: "code_only",
      isolation: codeOnlyIsolation,
      workspaceDirectory: preparedCodeOnlyTask.workspace.workspaceDirectory,
      sessionDirectory: preparedCodeOnlyTask.layout.piSessionDirectory,
      agentResourceDirectory: preparedCodeOnlyTask.agentResourceDirectory,
      broker: preparedCodeOnlyTask.broker,
      codingSandboxSentinelForbiddenPaths: forbiddenPaths,
      patchHandoff: {
        hostBaselineGitDirectory:
          preparedCodeOnlyTask.workspace.hostBaselineGitDirectory,
        hostBaselineCommit: preparedCodeOnlyTask.workspace.hostBaselineCommit,
        hostOperationTemporaryDirectory:
          preparedCodeOnlyTask.layout.hostOperationTemporaryDirectory,
        ignoredCachePaths: [],
        patchStore: untrustedInput.codeOnlyPatchStore,
      },
      now: runtimeTask.now,
      persistCleanupReceiptOnce: (record) =>
        preparedCodeOnlyTask.records.writeOnce("cleanup", record),
      persistSandboxSentinelReceiptOnce: (record) =>
        preparedCodeOnlyTask.records.writeOnce("sandbox-sentinel", record),
      markAgentStartedOnce: () => markAgentStarted("code_only"),
    };
    const gameTools = createM6AdmittedGameToolsV1({
      adapterRevision: runtimeTask.assignment.adapterRevision,
      hostAdmittedToolNames: runtimeTask.hostAdmittedGameToolNames,
    });
    const runtimeResourceAppendixSha256 = digestJson(
      createM7NeutralRuntimeResourceAppendixV1(
        runtimePrepared.surface.resourceMap,
      ),
    );
    const registrationInputs: M7PairedInfrastructureRegistrationInputsV1 = {
      schemaVersion: 1,
      baselineSelectedTreeSha256,
      codingToolSetSha256: digestJson(runtimeCodingTools),
      sandboxPolicySha256: commonCodingProfileSha256,
      runtimeGameToolSetSha256: digestJson(gameTools),
      runtimeResourceAppendixSha256,
      mutantCompatibilityReceiptSha256:
        runtimePrepared.compatibilityReceiptSha256,
      runtimeTaskId: runtimeTask.taskId,
      codeOnlyTaskId: preparedCodeOnlyTask.taskId,
      runtimeArmPublicTaskSpecSha256:
        runtimeTask.assignment.agentProjection.publicTask.sha256,
      codeOnlyArmPublicTaskSpecSha256:
        untrustedInput.codeOnlyPublicTaskSpecSha256,
      hostModelRuntimeConfigSha256,
      runtimeIsolation,
      codeOnlyIsolation,
    };
    type UnstartedCleanupReason =
      "gate-failure-before-arm-start" | "pre-agent-dry-run";
    const unstartedCleanupPromises = new Map<
      "runtime_enabled" | "code_only",
      Promise<M7RemainingArmCleanupV1>
    >();
    const cleanupUnstartedArm = (
      arm: "runtime_enabled" | "code_only",
      reason: UnstartedCleanupReason,
    ): Promise<M7RemainingArmCleanupV1> => {
      const existing = unstartedCleanupPromises.get(arm);
      if (existing !== undefined) return existing;
      const cleanupPromise = (async () => {
        if (startedArms.has(arm)) {
          return Object.freeze({
            schemaVersion: 1,
            arm,
            state: "started_not_touched",
            receiptSha256: null,
          });
        }
        const failures: string[] = [];
        let runtimeClosed = arm === "code_only";
        if (arm === "runtime_enabled") {
          try {
            await runtimePrepared.surface.close();
            runtimeClosed = true;
          } catch {
            failures.push("runtime_close_failed");
          }
        }
        let sandboxCleanup: Awaited<
          ReturnType<DuplexTaskSandboxBrokerV1["cleanup"]>
        > | null = null;
        try {
          sandboxCleanup = await (arm === "runtime_enabled"
            ? runtimeTask.broker.cleanup()
            : preparedCodeOnlyTask.broker.cleanup());
          if (!cleanupComplete(sandboxCleanup)) {
            failures.push("sandbox_cleanup_incomplete");
          }
        } catch {
          failures.push("sandbox_cleanup_receipt_unavailable");
        }
        const proven =
          runtimeClosed &&
          sandboxCleanup !== null &&
          cleanupComplete(sandboxCleanup) &&
          failures.length === 0;
        const writer =
          arm === "runtime_enabled"
            ? runtimeRecords
            : preparedCodeOnlyTask.records;
        const receiptSha256 = await writer.writeOnce(
          `remaining-${arm === "runtime_enabled" ? "runtime" : "code-only"}-cleanup`,
          JsonValueSchema.parse({
            schemaVersion: 1,
            reason,
            arm,
            state: "cleaned_unstarted",
            runtimeClosed,
            sandboxCleanup,
            proven,
            failures,
            completedAt: runtimeTask.now(),
          }),
        );
        if (!proven) {
          throw new Error(`M7 ${arm} unstarted-arm cleanup was incomplete`);
        }
        return Object.freeze({
          schemaVersion: 1,
          arm,
          state: "cleaned_unstarted",
          receiptSha256,
        });
      })();
      unstartedCleanupPromises.set(arm, cleanupPromise);
      return cleanupPromise;
    };
    const settleCleanup = async (
      arm: "runtime_enabled" | "code_only",
      reason: UnstartedCleanupReason,
    ): Promise<PromiseSettledResult<M7RemainingArmCleanupV1>> => {
      try {
        return {
          status: "fulfilled",
          value: await cleanupUnstartedArm(arm, reason),
        };
      } catch (reason) {
        return { status: "rejected", reason };
      }
    };
    const cleanupBothUnstartedArms = async (
      reason: UnstartedCleanupReason,
    ): Promise<M7RemainingArmsCleanupResultV1> => {
      // Both brokers share one delegated cgroup root. The runtime Task must
      // relinquish its controller before code-only cleanup may inspect and
      // remove its own scope. Still attempt the second cleanup when the first
      // reports failure so no unstarted arm is silently abandoned.
      const runtimeResult = await settleCleanup("runtime_enabled", reason);
      const codeOnlyResult = await settleCleanup("code_only", reason);
      const settled = [runtimeResult, codeOnlyResult] as const;
      const cleanupErrors = settled.flatMap((entry, index) =>
        entry.status === "rejected"
          ? [
              new Error(
                `M7 ${index === 0 ? "runtime" : "code-only"} unstarted-arm cleanup failed`,
                { cause: entry.reason },
              ),
            ]
          : [],
      );
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "M7 failed to clean every unstarted arm",
        );
      }
      if (
        runtimeResult.status !== "fulfilled" ||
        codeOnlyResult.status !== "fulfilled"
      ) {
        throw new Error("M7 unstarted-arm cleanup lost its result");
      }
      return Object.freeze({
        schemaVersion: 1,
        runtimeArm: runtimeResult.value,
        codeOnlyArm: codeOnlyResult.value,
      });
    };
    let cleanupRemainingPromise:
      Promise<M7RemainingArmsCleanupResultV1> | undefined;
    const cleanupRemainingAfterGateFailure = () => {
      aborted = true;
      cleanupRemainingPromise ??= cleanupBothUnstartedArms(
        "gate-failure-before-arm-start",
      );
      return cleanupRemainingPromise;
    };
    let preAgentDryRunPromise:
      Promise<M7PreAgentSandboxDryRunResultV1> | undefined;
    const runPreAgentSandboxDryRunAndCleanup: M7BoundPairedProjectEnvironmentV1["runPreAgentSandboxDryRunAndCleanup"] =
      (sentinelPort) => {
        if (anyAgentStarted || cleanupRemainingPromise !== undefined) {
          throw new Error(
            "M7 pre-Agent sandbox dry-run cannot follow an Agent or terminal cleanup",
          );
        }
        aborted = true;
        preAgentDryRunPromise ??= (async () => {
          let primaryError: unknown;
          let runtimeSentinelReceiptSha256: Sha256DigestV1 | undefined;
          let codeOnlySentinelReceiptSha256: Sha256DigestV1 | undefined;

          try {
            runtimeSentinelReceiptSha256 =
              await sentinelPort.runPreAgentSandboxSentinelOnce(
                "runtime_enabled",
              );
          } catch (error) {
            primaryError = error;
          }
          const runtimeCleanup = await settleCleanup(
            "runtime_enabled",
            "pre-agent-dry-run",
          );
          if (
            primaryError === undefined &&
            runtimeCleanup.status === "fulfilled"
          ) {
            try {
              codeOnlySentinelReceiptSha256 =
                await sentinelPort.runPreAgentSandboxSentinelOnce("code_only");
            } catch (error) {
              primaryError = error;
            }
          }
          const codeOnlyCleanup = await settleCleanup(
            "code_only",
            "pre-agent-dry-run",
          );

          const cleanupErrors = [runtimeCleanup, codeOnlyCleanup].flatMap(
            (entry, index) =>
              entry.status === "rejected"
                ? [
                    new Error(
                      `M7 ${index === 0 ? "runtime" : "code-only"} pre-Agent dry-run cleanup failed`,
                      { cause: entry.reason },
                    ),
                  ]
                : [],
          );
          if (
            primaryError !== undefined ||
            cleanupErrors.length > 0 ||
            runtimeSentinelReceiptSha256 === undefined ||
            codeOnlySentinelReceiptSha256 === undefined ||
            runtimeCleanup.status !== "fulfilled" ||
            runtimeCleanup.value.state !== "cleaned_unstarted" ||
            codeOnlyCleanup.status !== "fulfilled" ||
            codeOnlyCleanup.value.state !== "cleaned_unstarted"
          ) {
            throw new AggregateError(
              [
                ...(primaryError === undefined ? [] : [primaryError]),
                ...cleanupErrors,
              ],
              "M7 pre-Agent sandbox dry-run failed",
            );
          }
          return Object.freeze({
            schemaVersion: 1 as const,
            runtimeArm: Object.freeze({
              schemaVersion: 1 as const,
              arm: "runtime_enabled" as const,
              sentinelReceiptSha256: runtimeSentinelReceiptSha256,
              cleanupReceiptSha256: runtimeCleanup.value.receiptSha256,
            }),
            codeOnlyArm: Object.freeze({
              schemaVersion: 1 as const,
              arm: "code_only" as const,
              sentinelReceiptSha256: codeOnlySentinelReceiptSha256,
              cleanupReceiptSha256: codeOnlyCleanup.value.receiptSha256,
            }),
          });
        })();
        return preAgentDryRunPromise;
      };
    let abortPromise:
      | Promise<{
          readonly runtimeReceiptSha256: Sha256DigestV1;
          readonly codeOnlyReceiptSha256: Sha256DigestV1;
        }>
      | undefined;
    const abortBeforeAgent = () => {
      if (anyAgentStarted) {
        throw new Error("M7 preparation cannot abort after an Agent starts");
      }
      abortPromise ??= (async () => {
        const result = await cleanupRemainingAfterGateFailure();
        if (
          result.runtimeArm.state !== "cleaned_unstarted" ||
          result.codeOnlyArm.state !== "cleaned_unstarted"
        ) {
          throw new Error("M7 pre-Agent abort touched an Agent-started arm");
        }
        return Object.freeze({
          runtimeReceiptSha256: result.runtimeArm.receiptSha256,
          codeOnlyReceiptSha256: result.codeOnlyArm.receiptSha256,
        });
      })();
      return abortPromise;
    };
    return Object.freeze({
      schemaVersion: 1,
      registrationInputs,
      bindCampaignOnce: (
        binding: M7BindPreparedPairedInfrastructureV1Input,
      ): M7BoundPairedProjectEnvironmentV1 => {
        if (bound || aborted) {
          throw new Error("M7 paired preparation may bind only once");
        }
        if (
          binding.publicTaskSpecSha256.length !== 64 ||
          binding.sensorFreezeRecordSha256 !== sensorFreeze.recordSha256
        ) {
          throw new TypeError("M7 campaign binding crossed frozen inputs");
        }
        bound = true;
        const publicBudget = runtimePublicTask.agentBudget;
        const agentBudget: M7PairedAgentBudgetV1 = {
          schemaVersion: 1,
          attemptsMaximum: 1,
          userTurnsPerAttemptMaximum: 1,
          toolCallsMaximum: publicBudget.toolCallsMaximum,
          wallTimeMsMaximum: publicBudget.wallTimeMsMaximum,
          taskSandboxNetworkMode: "denied",
          taskCredentialMountCountMaximum: 0,
        };
        const pairedInput: M7PairedAgentInputV1 = {
          schemaVersion: 1,
          campaignId: binding.campaignId,
          publicTaskSpecSha256: binding.publicTaskSpecSha256,
          runtimeArmPublicTaskSpecSha256:
            registrationInputs.runtimeArmPublicTaskSpecSha256,
          codeOnlyArmPublicTaskSpecSha256:
            registrationInputs.codeOnlyArmPublicTaskSpecSha256,
          prompt: M7_NATURAL_USER_PROMPT_V1,
          provider: publicBudget.provider,
          model: publicBudget.model,
          thinkingLevel: publicBudget.thinkingLevel,
          agentBudget,
          baselineSelectedTreeSha256,
          commonEnvironmentInstructionsSha256:
            M7_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1,
          hostModelRuntimeConfigSha256,
          codingTools: [...runtimeCodingTools],
          sensorFreezeRecordSha256: binding.sensorFreezeRecordSha256,
          pristineAdapterRevision: runtimeTask.assignment.adapterRevision,
          hostAdmittedGameToolNames: [...runtimeTask.hostAdmittedGameToolNames],
          runtimeResourceMap: runtimePrepared.surface.resourceMap,
          runtimeIsolation,
          codeOnlyIsolation,
        };
        return Object.freeze({
          pairedInput,
          runtimeArm,
          codeOnlyArm,
          abortBeforeAgent,
          cleanupRemainingAfterGateFailure,
          runPreAgentSandboxDryRunAndCleanup,
        });
      },
      abortPreparation: async (): Promise<void> => {
        if (bound) {
          throw new Error(
            "M7 bound preparation must use its bound abortBeforeAgent path",
          );
        }
        await abortBeforeAgent();
      },
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (runtimeSurfaceToClose !== undefined) {
      try {
        await runtimeSurfaceToClose.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      const receipt = await runtimeTask.broker.cleanup();
      if (!cleanupComplete(receipt)) {
        cleanupErrors.push(new Error("runtime cleanup incomplete"));
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (codeOnlyTask !== undefined) {
      try {
        const receipt = await codeOnlyTask.broker.cleanup();
        if (!cleanupComplete(receipt)) {
          cleanupErrors.push(new Error("code-only cleanup incomplete"));
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "M7 paired preparation failed and cleanup was incomplete",
      );
    }
    throw error;
  }
}
