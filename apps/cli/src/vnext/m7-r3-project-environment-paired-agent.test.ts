import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1 } from "@chronorift/agent-protocol";
import {
  JsonValueSchema,
  M6AdapterBuildCompatibilityReceiptV1Schema,
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import {
  VNextPiTurnFailure,
  projectVNextPiFailureV1,
  type ProjectEnvironmentGameToolPortRequestV1,
  type RunVNextPiSdkTurnOptions,
} from "@chronorift/pi-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import type { SandboxExecutionRequestV1 } from "./contracts.js";
import { createM6AdmittedGameToolsV1 } from "./m6-one-turn-agent.js";
import {
  createM7RuntimeResourceMapV1,
  type M7AgentArmIsolationV1,
} from "./m7-paired-agent.js";
import {
  M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
  createM7R3PatrolTrajectoryCaseSpecV1,
} from "./m7-patrol-trajectory.js";
import { type M7R3AgentDeliveryTraceV1 } from "./m7-r3-agent-delivery.js";
import {
  createM7R3NaturalUserPromptV1,
  createM7R3PairedAgentProtocolV1,
  createM7R3PairedCaseContractV1,
  runM7R3PairedAgentArmOnceV1,
  type M7R3PairedAgentProtocolV1,
} from "./m7-r3-paired-agent.js";
import {
  M7_R3_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1,
  M7R3RuntimeEvidenceReceiptV1Schema,
  M7R3RuntimeTrajectoryExecutionMaterialV1Schema,
  createM7R3CodingToolSurfaceV1,
  createM7R3RuntimeTrajectoryExecutionMaterialV1,
  prepareM7R3ProjectEnvironmentPairedAgentPortV1,
  type M7R3PreparedCodeOnlyArmV1,
  type M7R3PreparedRuntimeArmV1,
  type M7R3RuntimeEvidenceReceiptV1,
  type M7R3RuntimeTrajectoryExecutionMaterialV1,
  type M7R3TaskStorageHeadroomReceiptV1,
} from "./m7-r3-project-environment-paired-agent.js";
import type {
  SandboxExecutionOptionsV1,
  SandboxExecutionResultV1,
  TaskSandboxBrokerV1,
} from "./sandbox-broker.js";
import { selectedTreeSha256 } from "./selected-tree.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const sha = (value: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const shaJson = (value: unknown): Sha256DigestV1 =>
  sha(canonicalJson(JsonValueSchema.parse(value)));

const transportObservation = (input: {
  readonly requestStartedCount: number;
  readonly responseHeadersCount: number;
  readonly responseCompleteCount: number;
  readonly requestErrorCount: number;
}) => {
  const basis = {
    schemaVersion: 1 as const,
    recordKind: "vnext-pi-host-http-transport-observation" as const,
    ...input,
  };
  return {
    ...basis,
    recordContentSha256: sha(JSON.stringify(basis)),
  };
};

const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
  schemaVersion: 1,
  adapterRevisionId: "adapter-revision:m7-r3:generic-patrol-v1",
  adapterId: "adapter:m7-r3:generic-patrol",
  sourceId: `source:v1:${sha("pristine project")}`,
  packageDigest: sha("generic Adapter package"),
  manifestDigest: sha("generic Adapter manifest"),
  implementationDigest: sha("generic Adapter implementation"),
  payloadSchemaDigest: sha("generic patrol.motion schema"),
  sdkDigest: sha("Adapter SDK"),
  bridgeDigest: sha("Adapter bridge"),
  capabilitySet: {
    schemaVersion: 1,
    modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => ({
      schemaVersion: 1,
      module,
      status: "implemented" as const,
      protocolVersion: "project-environment-v1",
      limitations: [],
    })),
  },
  conformanceReceiptId: "conformance:m7-r3:generic-patrol-v1",
  contentByteLength: 4096,
  contentFileCount: 4,
});

const cleanup = {
  schemaVersion: 1 as const,
  processTreeTerminated: true,
  runtimeExited: true,
  bridgeExited: true,
  isolationGroupEmpty: true,
  scopeRemoved: true,
  scratchRemoved: true,
  storageReconciled: true,
};

const coverage = [
  {
    schemaVersion: 1 as const,
    channelId: "patrol.motion",
    status: "complete" as const,
    observedRecords: 3,
    droppedRecords: 0,
    overwrittenRecords: 0,
    limitations: [],
  },
];

class WorkspaceBroker implements TaskSandboxBrokerV1 {
  public throwAfterWrite = false;
  public readonly cleanup = vi.fn(async () => ({
    processGroupTerminated: true,
    cgroupPopulated: false,
    termSent: false,
    killSent: false,
    scopeRemoved: true,
    storageReconciled: true,
  }));

  public constructor(private readonly workspace: string) {}

  public async execute(
    request: SandboxExecutionRequestV1,
    options?: SandboxExecutionOptionsV1,
  ): Promise<SandboxExecutionResultV1> {
    if (
      request.argv[0] === "/bin/busybox" &&
      request.argv[1] === "sh" &&
      options?.stdin !== undefined
    ) {
      const target = request.argv.at(-1);
      if (target === undefined || !target.startsWith("/workspace/")) {
        throw new Error("unexpected test write target");
      }
      await writeFile(
        join(this.workspace, target.slice("/workspace/".length)),
        options.stdin,
      );
      if (this.throwAfterWrite) throw new Error("write failed after mutation");
    }
    return {
      kind: "executed",
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      receipt: {
        operationId: request.operationId,
        requested: request,
        status: "succeeded",
        exitCode: 0,
      },
    } as unknown as SandboxExecutionResultV1;
  }
}

const readableSurfaces = (runtime: boolean) => ({
  chronoriftGameTools: runtime,
  publicRuntimeRecordsThroughGameTools: runtime,
  projectAdapterPackage: false as const,
  rawGodotExecutable: false as const,
  hiddenAssignmentStore: false as const,
  hiddenMutationOrEvaluator: false as const,
  otherArmPatchOrRecords: false as const,
});

const createWorkspace = async (root: string, arm: string) => {
  const workspace = join(root, `${arm}-workspace`);
  const session = join(root, `${arm}-session`);
  const cache = join(root, `${arm}-cache`);
  const baselineGit = join(root, `${arm}-baseline.git`);
  const hostTemporary = join(root, `${arm}-host-tmp`);
  await Promise.all([
    mkdir(join(workspace, "scripts"), { recursive: true }),
    mkdir(session),
    mkdir(cache),
    mkdir(baselineGit),
    mkdir(hostTemporary),
  ]);
  await Promise.all([
    writeFile(
      join(workspace, "project.godot"),
      '[application]\nrun/main_scene="res://main.tscn"\n',
    ),
    writeFile(
      join(workspace, "main.tscn"),
      '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n',
    ),
    writeFile(
      join(workspace, "scripts", "enemy.gd"),
      "extends Node\nvar speed := 20\n",
    ),
  ]);
  return { workspace, session, cache, baselineGit, hostTemporary };
};

const stateSample = (ordinal: number) => ({
  kind: "state_sample",
  recordSequence: ordinal,
  payload: {
    stateDomainId: "patrol.motion",
    semanticCoverage: "declared",
    value: {
      agents: [
        {
          entity_id: "enemy-1",
          name: "Enemy",
          start_direction: 0,
          direction: 1,
          fall_off_edge: false,
          speed: 20,
          position_x: 100,
          position_y: 80,
          velocity_x: 0,
          velocity_y: 0,
          grounded: true,
        },
      ],
    },
  },
});

const queryResponse = (input: {
  readonly toolCallId: string;
  readonly taskId: string;
  readonly executionId: string;
}) => ({
  schemaVersion: 1 as const,
  toolCallId: input.toolCallId,
  outcome: "success" as const,
  output: {
    schemaVersion: 1 as const,
    taskId: input.taskId,
    executionId: input.executionId,
    rows: [1, 2, 3].map((ordinal) => ({
      schemaVersion: 1 as const,
      rowId: `row:m7-r3:${ordinal}`,
      kind: "state" as const,
      clock: null,
      value: stateSample(ordinal),
    })),
    nextCursor: null,
    coverage: [],
    loss: [],
    limitations: [],
  },
});

interface Campaign {
  readonly protocol: M7R3PairedAgentProtocolV1;
  readonly runtimeArm: M7R3PreparedRuntimeArmV1;
  readonly codeOnlyArm: M7R3PreparedCodeOnlyArmV1;
  readonly runtimeBroker: WorkspaceBroker;
  readonly codeOnlyBroker: WorkspaceBroker;
  readonly readAgentEvidence: ReturnType<typeof vi.fn>;
  readonly runtimeClose: ReturnType<typeof vi.fn>;
  readonly persistedDeliveryTraces: unknown[];
  readonly persistedRuntimeEvidence: M7R3RuntimeEvidenceReceiptV1[];
  readonly persistedTaskStorageHeadroom: M7R3TaskStorageHeadroomReceiptV1[];
  readonly baseline: Sha256DigestV1;
  readonly baselineMaterial: M7R3RuntimeTrajectoryExecutionMaterialV1;
  readonly executionId: string;
}

const createCampaign = async (): Promise<Campaign> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-m7-r3-composer-"));
  roots.push(root);
  const runtimePaths = await createWorkspace(root, "runtime");
  const codeOnlyPaths = await createWorkspace(root, "code-only");
  const baseline = selectedTreeSha256(
    await collectCandidateGodotSourceV1(
      runtimePaths.workspace,
      "project-environment",
      "tracked-tool-scripts-v1",
    ),
  );
  expect(
    selectedTreeSha256(
      await collectCandidateGodotSourceV1(
        codeOnlyPaths.workspace,
        "project-environment",
        "tracked-tool-scripts-v1",
      ),
    ),
  ).toBe(baseline);

  const runtimeBroker = new WorkspaceBroker(runtimePaths.workspace);
  const codeOnlyBroker = new WorkspaceBroker(codeOnlyPaths.workspace);
  const taskId = "task:m7-r3:runtime_enabled";
  const executionId = "execution:m7-r3:baseline";
  const runtimeId = "runtime:m7-r3:baseline";
  const buildId = "build:m7-r3:mutant";
  const sourceId = `source:${baseline}`;
  const environmentRevisionId = "environment-revision:m7-r3:test";
  const compatibility = M6AdapterBuildCompatibilityReceiptV1Schema.parse({
    schemaVersion: 1,
    receiptId: "compat:m7-r3:baseline",
    lineage: {
      schemaVersion: 1,
      buildRole: "assignment_baseline",
      baselineSourceHash: baseline,
      adapterRevision: {
        schemaVersion: 1,
        adapterRevisionId: adapterRevision.adapterRevisionId,
        adapterId: adapterRevision.adapterId,
        sourceId: adapterRevision.sourceId,
        packageDigest: adapterRevision.packageDigest,
        manifestDigest: adapterRevision.manifestDigest,
        implementationDigest: adapterRevision.implementationDigest,
        payloadSchemaDigest: adapterRevision.payloadSchemaDigest,
        sdkDigest: adapterRevision.sdkDigest,
        bridgeDigest: adapterRevision.bridgeDigest,
        conformanceReceiptId: adapterRevision.conformanceReceiptId,
      },
      build: {
        schemaVersion: 1,
        taskId,
        workspaceId: "workspace:m7-r3:runtime_enabled",
        sourceId,
        buildId,
        sourceHash: baseline,
        workspaceDiffHash: sha("mutant workspace diff"),
        buildConfigurationHash: sha("build configuration"),
        outputHash: sha("mutant build output"),
        createdAt: "2026-08-16T00:00:00.000Z",
      },
      toolchain: {
        schemaVersion: 1,
        toolchainReceiptId: "toolchain:m7-r3:test",
        artifactDigest: sha("Godot toolchain artifact"),
      },
    },
    bridgeHandshakeObserved: true,
    instrumentedLaunchObserved: true,
    queryObservations: {
      schemaVersion: 1,
      entityQueryObserved: true,
      stateQueryObserved: true,
      entityRows: 1,
      stateRows: 3,
    },
    coverage,
    loss: [],
    cleanup,
    outcome: "compatible",
    failures: [],
    observedAt: "2026-08-16T00:00:00.000Z",
  });
  const runtimeObservation =
    ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse({
      schemaVersion: 1,
      receiptId: "runtime-observation:m7-r3:baseline",
      taskId,
      runtimeId,
      executionId,
      buildId,
      environmentRevisionId,
      adapterRevisionId: adapterRevision.adapterRevisionId,
      launchTargetId: "launch:m7-r3:main",
      instrumentationMode: "instrumented",
      status: "stopped",
      bridgeHandshakeCount: 1,
      clock: {
        schemaVersion: 1,
        processFrame: 3,
        physicsTick: 3,
        simulationTimeUs: 50_000,
        renderFrame: null,
        hostMonotonicUs: 100_000,
      },
      queryObservations: {
        schemaVersion: 1,
        entityQueryCount: 1,
        entityRows: 1,
        stateQueryCount: 1,
        stateRows: 3,
      },
      captureCount: 1,
      captureWindowIds: ["capture:m7-r3:baseline"],
      coverage,
      loss: [],
      cleanup,
      outcome: "succeeded",
      failures: [],
      startedAt: "2026-08-16T00:00:01.000Z",
      observedAt: "2026-08-16T00:00:02.000Z",
      completedAt: "2026-08-16T00:00:03.000Z",
    });
  const material = createM7R3RuntimeTrajectoryExecutionMaterialV1({
    adapterBuildCompatibilityReceipt: compatibility,
    runtimeObservationReceipt: runtimeObservation,
  });
  const publicExecution = {
    schemaVersion: 1 as const,
    executionId,
    buildId,
    sourceSha256: baseline,
    startedAt: runtimeObservation.startedAt,
    endedAt: runtimeObservation.completedAt,
    sealed: true,
    coverageComplete: true,
    cleanupProven: true,
    publicSymptomObserved: true,
    publicObservationSha256: sha("public grounded stall observation"),
  };
  const sourceObservation = {
    schemaVersion: 1 as const,
    boundary: "game_build_freeze" as const,
    sourceSha256: baseline,
    buildId,
    observedAt: "2026-08-16T00:00:01.000Z",
  };
  const isolation = (
    arm: "runtime_enabled" | "code_only",
  ): M7AgentArmIsolationV1 => ({
    schemaVersion: 1,
    arm,
    taskId: arm === "runtime_enabled" ? taskId : "task:m7-r3:code_only",
    workspaceHandle: `workspace:m7-r3:${arm}`,
    workspaceInstanceSha256: sha(`${arm} workspace`),
    sessionInstanceSha256: sha(`${arm} Session`),
    cacheInstanceSha256: sha(`${arm} cache`),
    sandboxInstanceSha256: sha(`${arm} sandbox`),
    sandboxProfileSha256: sha("shared sandbox policy"),
    workspaceBaselineSelectedTreeSha256: baseline,
    readableSurfaces: readableSurfaces(arm === "runtime_enabled"),
  });
  const runtimeIsolation = isolation("runtime_enabled");
  const codeOnlyIsolation = isolation("code_only");
  const hostAdmittedGameToolNames = [
    PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.query,
  ];
  const admittedGameTools = createM6AdmittedGameToolsV1({
    adapterRevision,
    hostAdmittedToolNames: hostAdmittedGameToolNames,
  });
  const classifierImplementationSha256 = sha(
    "generic classifier implementation",
  );
  const trajectoryCaseSpec = createM7R3PatrolTrajectoryCaseSpecV1({
    classifierImplementationSha256,
    expectedBaselineWitnessKinds: ["grounded_stall"],
    expectedRecoveryWitnessKinds: ["direction_recovery"],
    frozenAt: "2026-08-15T00:00:00.000Z",
  });
  const budget = {
    schemaVersion: 1 as const,
    attemptsMaximum: 1 as const,
    userTurnsPerAttemptMaximum: 1 as const,
    toolCallsMaximum: 64,
    wallTimeMsMaximum: 900_000,
    taskSandboxNetworkMode: "denied" as const,
    taskCredentialMountCountMaximum: 0 as const,
  };
  const codingTools = [...createM7R3CodingToolSurfaceV1(runtimeBroker)];
  const naturalPrompt =
    createM7R3NaturalUserPromptV1("敌人会掉下平台，请修复。");
  const caseContract = createM7R3PairedCaseContractV1({
    portfolioId: "m7-r3-portfolio:0123456789abcdef01234567",
    caseOrdinal: 1,
    caseId: "m7-r3-case:111111111111111111111111",
    mutatedBaselineSelectedTreeSha256: baseline,
    naturalPrompt,
    pairedAgentProtocolImplementationSha256: sha("R3 protocol bytes"),
    pairedPublicTaskContractSha256: sha("paired public task"),
    runtimeArmPublicTaskSpecSha256: sha("runtime public task"),
    codeOnlyArmPublicTaskSpecSha256: sha("code-only public task"),
    adapterMutantCompatibilityReceiptSha256: shaJson(compatibility),
    commonRuntimeMaterials: {
      authoritativeSensorFreezeRecordSha256: sha("sensor freeze"),
      trajectoryClassifierFreezeRecordSha256: sha("classifier freeze"),
      trajectoryClassifierImplementationSha256: classifierImplementationSha256,
      trajectoryClassifierConfigSha256:
        M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1.configSha256,
      adapterRevisionSha256: shaJson(adapterRevision),
      adapterPackageSha256: adapterRevision.packageDigest,
      adapterObservationSchemaSha256: sha("patrol schema"),
      pristineAdapterConformanceReceiptSha256: sha("pristine conformance"),
      validatedGameToolSetSha256: shaJson(admittedGameTools),
      commonEnvironmentInstructionsSha256:
        M7_R3_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1,
      hostModelRuntimeConfigSha256: sha("Host model runtime config"),
    },
    agentConfiguration: {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "max",
      agentBudgetSha256: shaJson(budget),
      codingToolSetSha256: shaJson(codingTools),
      sandboxPolicySha256: runtimeIsolation.sandboxProfileSha256,
    },
    trajectoryClassifierConfig: M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
    trajectoryCaseSpec,
  });
  const resourceMap = createM7RuntimeResourceMapV1({
    schemaVersion: 1,
    taskId,
    baselineBuildId: buildId,
    baselineSourceId: sourceId,
    launchTargetId: "launch:m7-r3:main",
  });
  const protocol = createM7R3PairedAgentProtocolV1({
    schemaVersion: 1,
    recordKind: "m7-r3-paired-agent-input",
    campaignId: "m7-campaign:111111111111111111111111",
    caseCampaignAdmissionRecordSha256: sha("case admission"),
    caseContract,
    provider: caseContract.agentConfiguration.provider,
    model: caseContract.agentConfiguration.model,
    thinkingLevel: caseContract.agentConfiguration.thinkingLevel,
    agentBudget: budget,
    codingTools,
    pristineAdapterRevision: adapterRevision,
    hostAdmittedGameToolNames,
    runtimeResourceMap: resourceMap,
    runtimeIsolation,
    codeOnlyIsolation,
  });

  const persistedDeliveryTraces: unknown[] = [];
  const persistedRuntimeEvidence: M7R3RuntimeEvidenceReceiptV1[] = [];
  const persistedTaskStorageHeadroom: M7R3TaskStorageHeadroomReceiptV1[] = [];
  const runtimeClose = vi.fn(async () => undefined);
  const readAgentEvidence = vi.fn(
    async (input: {
      readonly agentDeliveryTraceRecordSha256: Sha256DigestV1;
    }) => ({
      sourceObservations: [sourceObservation],
      executions: [publicExecution],
      trajectoryMaterials: [material],
      agentDeliveryTraceRecordSha256: input.agentDeliveryTraceRecordSha256,
      receiptSha256: sha("backend evidence projection"),
    }),
  );
  const gameInvoke = vi.fn(
    async (request: ProjectEnvironmentGameToolPortRequestV1) => {
      if (request.toolName !== PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.query) {
        throw new Error("unexpected R3 test game tool");
      }
      return queryResponse({
        toolCallId: request.toolCallId,
        taskId,
        executionId,
      });
    },
  );
  const common = (
    arm: "runtime_enabled" | "code_only",
    paths: typeof runtimePaths,
    broker: WorkspaceBroker,
    armIsolation: M7AgentArmIsolationV1,
  ) => ({
    arm,
    isolation: armIsolation,
    workspaceDirectory: paths.workspace,
    sessionDirectory: paths.session,
    agentResourceDirectory: paths.cache,
    broker,
    codingSandboxSentinelForbiddenPaths: ["/host-only/m7-r3"],
    patchHandoff: {
      hostBaselineGitDirectory: paths.baselineGit,
      hostBaselineCommit: "1".repeat(40),
      hostOperationTemporaryDirectory: paths.hostTemporary,
      ignoredCachePaths: [],
      patchStore: { publishOnce: vi.fn() },
    },
    now: () => "2026-08-16T01:00:00.000Z",
    persistCleanupReceiptOnce: vi.fn(async (record) => shaJson(record)),
    persistSandboxSentinelReceiptOnce: vi.fn(async (record) => shaJson(record)),
    persistAgentDeliveryTraceOnce: vi.fn(
      async (record: M7R3AgentDeliveryTraceV1) => {
        persistedDeliveryTraces.push(record);
        return record.recordContentSha256;
      },
    ),
    assertTaskStorageHeadroom: vi.fn(
      async () =>
        ({
          schemaVersion: 1,
          availableBytes: 512 * 1024 * 1024,
          availableInodes: 65_536,
          requiredAvailableBytes: 256 * 1024 * 1024,
          requiredAvailableInodes: 16_384,
        }) as const,
    ),
    persistTaskStorageHeadroomReceiptOnce: vi.fn(
      async (record: M7R3TaskStorageHeadroomReceiptV1) => {
        persistedTaskStorageHeadroom.push(record);
        return record.recordContentSha256;
      },
    ),
    persistEvaluatorHeadroomObservation: vi.fn(async () => undefined),
    markAgentStartedOnce: vi.fn(),
  });
  const runtimeArm: M7R3PreparedRuntimeArmV1 = {
    ...common("runtime_enabled", runtimePaths, runtimeBroker, runtimeIsolation),
    arm: "runtime_enabled",
    trajectoryClassifierConfig: M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
    trajectoryCaseSpec,
    runtime: {
      pristineAdapterRevision: adapterRevision,
      pristineAdapterConformanceReceiptSha256:
        caseContract.commonRuntimeMaterials
          .pristineAdapterConformanceReceiptSha256,
      adapterMutantCompatibilityReceiptSha256: shaJson(compatibility),
      resourceMap,
      gameToolPort: { invoke: gameInvoke },
      persistRuntimeEvidenceReceiptOnce: vi.fn(
        async (record: M7R3RuntimeEvidenceReceiptV1) => {
          persistedRuntimeEvidence.push(record);
          return record.recordContentSha256;
        },
      ),
      close: runtimeClose,
      readAgentEvidence,
    },
  };
  const codeOnlyArm: M7R3PreparedCodeOnlyArmV1 = {
    ...common("code_only", codeOnlyPaths, codeOnlyBroker, codeOnlyIsolation),
    arm: "code_only",
  };
  return {
    protocol,
    runtimeArm,
    codeOnlyArm,
    runtimeBroker,
    codeOnlyBroker,
    readAgentEvidence,
    runtimeClose,
    persistedDeliveryTraces,
    persistedRuntimeEvidence,
    persistedTaskStorageHeadroom,
    baseline,
    baselineMaterial: material,
    executionId,
  };
};

const piResult = (
  request: RunVNextPiSdkTurnOptions,
  status: "completed" | "aborted" = "completed",
) => ({
  schemaVersion: 1 as const,
  status,
  sessionId: "session:must-not-be-retained",
  sessionFile: "/host/private/session.jsonl",
  provider: request.provider,
  model: request.model,
  requestedThinkingLevel: request.thinkingLevel,
  realizedThinkingLevel: request.thinkingLevel,
  activeTools: request.tools.map((tool) => tool.name),
  assistantText: "SECRET_AGENT_PROSE",
  errorMessage: null,
  eventsObserved: 0,
  observedTurnCount: 1 as const,
  hostHttpTransportObservation: transportObservation({
    requestStartedCount: 2,
    responseHeadersCount: 2,
    responseCompleteCount: 2,
    requestErrorCount: 0,
  }),
  stats: {
    sessionFile: "/host/private/session.jsonl",
    sessionId: "session:must-not-be-retained",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 3,
    tokens: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
    },
    cost: 0,
  },
});

const queryArguments = (campaign: Campaign) => ({
  schemaVersion: 1,
  taskId: campaign.runtimeArm.isolation.taskId,
  executionId: campaign.executionId,
  select: "state",
  limit: 10,
});

const findTool = (request: RunVNextPiSdkTurnOptions, name: string) => {
  const tool = request.tools.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`${name} tool missing`);
  return tool;
};

const emit = (request: RunVNextPiSdkTurnOptions, event: unknown): void => {
  request.onEvent?.(event as never);
};

const executeQuery = async (
  campaign: Campaign,
  request: RunVNextPiSdkTurnOptions,
  mode: "no_event" | "no_next_turn" | "after_hook_mismatch" | "visible",
) => {
  const toolCallId = `query:${mode}`;
  const args = queryArguments(campaign);
  const query = findTool(request, "game_query");
  if (mode !== "no_event") {
    emit(request, { type: "turn_start" });
    emit(request, {
      type: "tool_execution_start",
      toolCallId,
      toolName: "game_query",
      args,
    });
  }
  const result = await query.execute(
    toolCallId,
    args,
    undefined,
    undefined,
    {} as never,
  );
  if (mode !== "no_event") {
    emit(request, {
      type: "tool_execution_end",
      toolCallId,
      toolName: "game_query",
      result:
        mode === "after_hook_mismatch"
          ? { ...result, details: { schemaVersion: 1, substituted: true } }
          : result,
      isError: false,
    });
    if (mode !== "no_next_turn") emit(request, { type: "turn_start" });
  }
  return result;
};

const prepare = async (
  campaign: Campaign,
  runPiTurn: (request: RunVNextPiSdkTurnOptions) => Promise<unknown>,
) =>
  prepareM7R3ProjectEnvironmentPairedAgentPortV1(campaign, {
    runPiTurn: runPiTurn as never,
  });

describe("M7 R3 Project Environment paired-Agent composer", () => {
  it("does not count a turn when the exact Pi path fails before prompt submission", async () => {
    const campaign = await createCampaign();
    const lifecycle = [
      {
        schemaVersion: 1 as const,
        ordinal: 1,
        stage: "sdk_call_started" as const,
      },
      {
        schemaVersion: 1 as const,
        ordinal: 2,
        stage: "model_runtime_created" as const,
      },
    ];
    const source = Object.assign(
      new Error("mkdir /pi-agent/auth.json.lock SECRET_AUTH"),
      { code: "EROFS", syscall: "mkdir" },
    );
    const port = await prepare(campaign, async (request) => {
      lifecycle.forEach((event) => request.onLifecycleEvent?.(event));
      throw new VNextPiTurnFailure(
        {
          schemaVersion: 1,
          recordKind: "vnext-pi-turn-failure",
          stage: "model_runtime_create",
          lifecycle,
          hostHttpTransportObservation: transportObservation({
            requestStartedCount: 1,
            responseHeadersCount: 0,
            responseCompleteCount: 0,
            requestErrorCount: 1,
          }),
          primaryFailure: projectVNextPiFailureV1(
            source,
            "model_runtime_create",
          ),
          cleanupFailures: [],
        },
        { cause: source },
      );
    });

    const attempt = await runM7R3PairedAgentArmOnceV1({
      request: campaign.protocol.runtimeRequest,
      port,
    });

    expect(
      campaign.runtimeArm.assertTaskStorageHeadroom,
    ).toHaveBeenCalledOnce();
    expect(campaign.persistedTaskStorageHeadroom).toHaveLength(1);
    expect(campaign.persistedTaskStorageHeadroom[0]).toMatchObject({
      recordKind: "m7-r3-task-storage-headroom",
      campaignId: campaign.protocol.runtimeRequest.campaignId,
      portfolioId: campaign.protocol.runtimeRequest.portfolioId,
      caseId: campaign.protocol.runtimeRequest.caseId,
      pairedCaseContractContentSha256:
        campaign.protocol.runtimeRequest.pairedCaseContractContentSha256,
      arm: "runtime_enabled",
      taskId: campaign.protocol.runtimeRequest.isolation.taskId,
      attemptBindingContentSha256:
        campaign.protocol.runtimeRequest.attemptBinding.bindingContentSha256,
      boundary: "pre_pi",
      availableBytes: 512 * 1024 * 1024,
      availableInodes: 65_536,
      requiredAvailableBytes: 256 * 1024 * 1024,
      requiredAvailableInodes: 16_384,
      observedAt: "2026-08-16T01:00:00.000Z",
    });
    expect(campaign.runtimeArm.markAgentStartedOnce).not.toHaveBeenCalled();
    expect(attempt.attemptEvidence).toMatchObject({
      piTurnStarted: false,
      piResultObserved: false,
      terminalStage: "pi_turn",
    });
    expect(attempt.failureReceipt).toMatchObject({
      piTurnStarted: false,
      hostHttpTransportObservation: {
        requestStartedCount: 1,
        responseHeadersCount: 0,
        responseCompleteCount: 0,
        requestErrorCount: 1,
      },
      lifecycle,
      primaryFailure: {
        stage: "model_runtime_create",
        category: "permission",
        platformCode: "EROFS",
        syscall: "mkdir",
      },
      cleanupFailures: [],
      sealFailure: null,
    });
    expect(JSON.stringify(attempt.failureReceipt)).not.toMatch(
      /pi-agent|SECRET_AUTH/u,
    );
  });

  it("rejects a below-threshold headroom projection before persistence or Pi", async () => {
    const campaign = await createCampaign();
    vi.mocked(
      campaign.runtimeArm.assertTaskStorageHeadroom,
    ).mockResolvedValueOnce({
      schemaVersion: 1,
      availableBytes: 256 * 1024 * 1024 - 1,
      availableInodes: 16_384,
      requiredAvailableBytes: 256 * 1024 * 1024,
      requiredAvailableInodes: 16_384,
    });
    const runPiTurn = vi.fn();
    const port = await prepare(campaign, runPiTurn);

    const attempt = await runM7R3PairedAgentArmOnceV1({
      request: campaign.protocol.runtimeRequest,
      port,
    });

    expect(runPiTurn).not.toHaveBeenCalled();
    expect(
      campaign.runtimeArm.persistTaskStorageHeadroomReceiptOnce,
    ).not.toHaveBeenCalled();
    expect(attempt.attemptEvidence).toMatchObject({
      piTurnStarted: false,
      piResultObserved: false,
    });
  });

  it("does not start Pi when the create-once headroom receipt cannot persist", async () => {
    const campaign = await createCampaign();
    vi.mocked(
      campaign.runtimeArm.persistTaskStorageHeadroomReceiptOnce,
    ).mockRejectedValueOnce(new Error("injected durable headroom failure"));
    const runPiTurn = vi.fn();
    const port = await prepare(campaign, runPiTurn);

    const attempt = await runM7R3PairedAgentArmOnceV1({
      request: campaign.protocol.runtimeRequest,
      port,
    });

    expect(
      campaign.runtimeArm.persistTaskStorageHeadroomReceiptOnce,
    ).toHaveBeenCalledOnce();
    expect(runPiTurn).not.toHaveBeenCalled();
    expect(campaign.runtimeArm.markAgentStartedOnce).not.toHaveBeenCalled();
    expect(attempt.attemptEvidence).toMatchObject({
      piTurnStarted: false,
      piResultObserved: false,
      terminalStage: "pi_turn",
    });
  });

  it.each(["no_event", "no_next_turn", "after_hook_mismatch"] as const)(
    "retains the execution but zero eligible summaries for %s",
    async (mode) => {
      const campaign = await createCampaign();
      const port = await prepare(campaign, async (request) => {
        await executeQuery(campaign, request, mode);
        return piResult(request);
      });

      const attempt = await runM7R3PairedAgentArmOnceV1({
        request: campaign.protocol.runtimeRequest,
        port,
      });

      expect(attempt.result?.arm).toBe("runtime_enabled");
      if (attempt.result?.arm !== "runtime_enabled") {
        throw new Error("runtime result missing");
      }
      expect(attempt.result.executions).toHaveLength(1);
      expect(attempt.result.trajectorySummaries).toEqual([]);
      expect(attempt.result.runtimeEvidenceReceiptSha256).toBe(
        campaign.persistedRuntimeEvidence[0]?.recordContentSha256,
      );
      expect(campaign.runtimeBroker.cleanup).toHaveBeenCalledTimes(1);
      expect(campaign.runtimeClose).toHaveBeenCalledTimes(1);
    },
  );

  it("binds a real PE query args/details/final ToolResult to a recomputable strict receipt", async () => {
    const campaign = await createCampaign();
    const port = await prepare(campaign, async (request) => {
      await executeQuery(campaign, request, "visible");
      return piResult(request);
    });

    const attempt = await runM7R3PairedAgentArmOnceV1({
      request: campaign.protocol.runtimeRequest,
      port,
    });

    if (attempt.result?.arm !== "runtime_enabled") {
      throw new Error("runtime result missing");
    }
    expect(attempt.result.hostHttpTransportObservation).toMatchObject({
      requestStartedCount: 2,
      responseHeadersCount: 2,
      responseCompleteCount: 2,
      requestErrorCount: 0,
    });
    expect(attempt.result.trajectorySummaries).toHaveLength(1);
    const receipt = M7R3RuntimeEvidenceReceiptV1Schema.parse(
      campaign.persistedRuntimeEvidence[0],
    );
    expect(receipt.recordContentSha256).toBe(
      attempt.result.runtimeEvidenceReceiptSha256,
    );
    expect(receipt.agentDeliveryTrace.recordContentSha256).toBe(
      attempt.result.agentDeliveryTraceRecordSha256,
    );
    expect(receipt.exchanges[0]).toMatchObject({
      toolName: "game_query",
      input: queryArguments(campaign),
      outputIdentity: {
        taskId: campaign.runtimeArm.isolation.taskId,
        executionId: campaign.executionId,
      },
    });
    expect(receipt.trajectoryMaterials[0]?.runtimeObservationReceipt).toEqual(
      campaign.persistedRuntimeEvidence[0]?.trajectoryMaterials[0]
        ?.runtimeObservationReceipt,
    );
    const retained = JSON.stringify(receipt);
    expect(retained).not.toContain("SECRET_AGENT_PROSE");
    expect(retained).not.toContain("/host/private/session.jsonl");
    expect(retained).not.toContain("session:must-not-be-retained");
  });

  it("retains distinct exact compatibility receipts for baseline and candidate Builds and rejects derived-fact tampering", async () => {
    const campaign = await createCampaign();
    const baselineMaterial = campaign.baselineMaterial;
    const candidateSourceHash = sha("candidate selected tree");
    const candidateCompatibility =
      M6AdapterBuildCompatibilityReceiptV1Schema.parse({
        ...baselineMaterial.adapterBuildCompatibilityReceipt,
        receiptId: "compat:m7-r3:candidate",
        lineage: {
          ...baselineMaterial.adapterBuildCompatibilityReceipt.lineage,
          buildRole: "candidate",
          build: {
            ...baselineMaterial.adapterBuildCompatibilityReceipt.lineage.build,
            buildId: "build:m7-r3:candidate",
            sourceId: `source:${candidateSourceHash}`,
            sourceHash: candidateSourceHash,
            outputHash: sha("candidate build output"),
            createdAt: "2026-08-16T00:10:00.000Z",
          },
        },
        observedAt: "2026-08-16T00:10:00.000Z",
      });
    const candidateRuntime =
      ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse({
        ...baselineMaterial.runtimeObservationReceipt,
        receiptId: "runtime-observation:m7-r3:candidate",
        runtimeId: "runtime:m7-r3:candidate",
        executionId: "execution:m7-r3:candidate",
        buildId: "build:m7-r3:candidate",
        environmentRevisionId: "environment-revision:m7-r3:candidate-runtime",
        startedAt: "2026-08-16T00:10:01.000Z",
        observedAt: "2026-08-16T00:10:02.000Z",
        completedAt: "2026-08-16T00:10:03.000Z",
      });
    const candidateMaterial = createM7R3RuntimeTrajectoryExecutionMaterialV1({
      adapterBuildCompatibilityReceipt: candidateCompatibility,
      runtimeObservationReceipt: candidateRuntime,
    });

    expect(
      candidateMaterial.lineage.adapterCompatibilityReceiptSha256,
    ).not.toBe(baselineMaterial.lineage.adapterCompatibilityReceiptSha256);
    expect(baselineMaterial).toMatchObject({
      buildRole: "assignment_baseline",
      baselineSourceHash: campaign.baseline,
    });
    expect(candidateMaterial).toMatchObject({
      buildRole: "candidate",
      baselineSourceHash: campaign.baseline,
    });
    expect(candidateMaterial.lineage).toMatchObject({
      buildId: "build:m7-r3:candidate",
      sourceId: `source:${candidateSourceHash}`,
      executionId: "execution:m7-r3:candidate",
    });
    expect(() =>
      M7R3RuntimeTrajectoryExecutionMaterialV1Schema.parse({
        ...candidateMaterial,
        coverageComplete: false,
      }),
    ).toThrow(/derive from its exact typed observation receipt/u);
  });

  it("records parallel same-turn game/edit ordering without claiming later runtime use", async () => {
    const campaign = await createCampaign();
    const port = await prepare(campaign, async (request) => {
      const queryCallId = "query:parallel";
      const writeCallId = "write:parallel";
      const queryArgs = queryArguments(campaign);
      const writeArgs = {
        path: "scripts/enemy.gd",
        content: "extends Node\nvar speed := 21\n",
      };
      emit(request, { type: "turn_start" });
      emit(request, {
        type: "tool_execution_start",
        toolCallId: queryCallId,
        toolName: "game_query",
        args: queryArgs,
      });
      emit(request, {
        type: "tool_execution_start",
        toolCallId: writeCallId,
        toolName: "write",
        args: writeArgs,
      });
      const queryResult = await findTool(request, "game_query").execute(
        queryCallId,
        queryArgs,
        undefined,
        undefined,
        {} as never,
      );
      emit(request, {
        type: "tool_execution_end",
        toolCallId: queryCallId,
        toolName: "game_query",
        result: queryResult,
        isError: false,
      });
      const writeResult = await findTool(request, "write").execute(
        writeCallId,
        writeArgs,
        undefined,
        undefined,
        {} as never,
      );
      emit(request, {
        type: "tool_execution_end",
        toolCallId: writeCallId,
        toolName: "write",
        result: writeResult,
        isError: false,
      });
      emit(request, { type: "turn_start" });
      return piResult(request, "aborted");
    });

    const attempt = await runM7R3PairedAgentArmOnceV1({
      request: campaign.protocol.runtimeRequest,
      port,
    });

    if (attempt.result?.arm !== "runtime_enabled") {
      throw new Error("runtime result missing");
    }
    expect(attempt.result.trajectorySummaries).toHaveLength(1);
    expect(
      attempt.result.trajectorySummaries[0]?.firstHostObservedSourceChange,
    ).toMatchObject({
      hostToolReturnOrdinal: 2,
      sourceChangingToolIssuedInAgentTurnOrdinal: 1,
    });
    expect(
      attempt.result.trajectorySummaries[0]?.agentVisibleFinalToolResult
        .availableToModelAtAgentTurnOrdinal,
    ).toBe(2);
  });

  it("keeps the code-only arm free of runtime tools/materials and cleans each arm once", async () => {
    const campaign = await createCampaign();
    const requests: RunVNextPiSdkTurnOptions[] = [];
    const port = await prepare(campaign, async (request) => {
      requests.push(request);
      return piResult(request);
    });

    const runtimeAttempt = await runM7R3PairedAgentArmOnceV1({
      request: campaign.protocol.runtimeRequest,
      port,
    });
    const codeOnlyAttempt = await runM7R3PairedAgentArmOnceV1({
      request: campaign.protocol.codeOnlyRequest,
      port,
    });

    expect(requests.map((request) => request.prompt)).toEqual([
      campaign.protocol.runtimeRequest.prompt,
      campaign.protocol.runtimeRequest.prompt,
    ]);
    expect(
      requests[1]?.tools.some((tool) => tool.name.startsWith("game_")),
    ).toBe(false);
    expect(requests[1]?.additionalEnvironmentInstructions).toBeUndefined();
    expect(campaign.readAgentEvidence).not.toHaveBeenCalled();
    expect(codeOnlyAttempt.result).toMatchObject({
      arm: "code_only",
      executions: [],
      agentVisibleGameToolExchanges: [],
      trajectorySummaries: [],
      runtimeEvidenceReceiptSha256: null,
    });
    expect(runtimeAttempt.result?.agentDeliveryTraceRecordSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(codeOnlyAttempt.result?.agentDeliveryTraceRecordSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(campaign.runtimeBroker.cleanup).toHaveBeenCalledTimes(1);
    expect(campaign.codeOnlyBroker.cleanup).toHaveBeenCalledTimes(1);
    expect(campaign.runtimeClose).toHaveBeenCalledTimes(1);
  });

  it("records a Host source boundary when a coding tool mutates and then throws", async () => {
    const campaign = await createCampaign();
    campaign.runtimeBroker.throwAfterWrite = true;
    const port = await prepare(campaign, async (request) => {
      const args = {
        path: "scripts/enemy.gd",
        content: "extends Node\nvar speed := 99\n",
      };
      emit(request, { type: "turn_start" });
      emit(request, {
        type: "tool_execution_start",
        toolCallId: "write:throws",
        toolName: "write",
        args,
      });
      await expect(
        findTool(request, "write").execute(
          "write:throws",
          args,
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/after mutation/u);
      return piResult(request, "aborted");
    });

    await runM7R3PairedAgentArmOnceV1({
      request: campaign.protocol.runtimeRequest,
      port,
    });

    expect(campaign.persistedDeliveryTraces[0]).toMatchObject({
      firstHostObservedSourceChange: {
        boundary: "coding_tool_return",
        sourceChangingToolIssuedInAgentTurnOrdinal: 1,
      },
    });
  });

  it("rejects a runtime reader trace substitution without rerunning the Agent", async () => {
    const campaign = await createCampaign();
    campaign.readAgentEvidence.mockResolvedValueOnce({
      sourceObservations: [],
      executions: [],
      trajectoryMaterials: [],
      agentDeliveryTraceRecordSha256: sha("substituted trace"),
      receiptSha256: sha("backend evidence projection"),
    });
    const runPiTurn = vi.fn(async (request: RunVNextPiSdkTurnOptions) => {
      await executeQuery(campaign, request, "visible");
      return piResult(request);
    });
    const port = await prepare(campaign, runPiTurn);

    const attempt = await runM7R3PairedAgentArmOnceV1({
      request: campaign.protocol.runtimeRequest,
      port,
    });

    expect(attempt.result).toBeNull();
    expect(attempt.infrastructureFailureCode).toMatch(/^runner_/u);
    expect(runPiTurn).toHaveBeenCalledTimes(1);
    expect(campaign.runtimeBroker.cleanup).toHaveBeenCalledTimes(1);
  });
});
