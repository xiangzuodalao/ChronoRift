import { createHash } from "node:crypto";

import { PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1 } from "@chronorift/agent-protocol";
import {
  JsonValueSchema,
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectAdapterRevisionV1Schema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { describe, expect, it, vi } from "vitest";

import { createM6AdmittedGameToolsV1 } from "./m6-one-turn-agent.js";
import {
  M7_NATURAL_USER_PROMPT_V1,
  M7PairedAgentArmRequestV1Schema,
  createM7PairedAgentProtocolV1,
  createM7RuntimeResourceMapV1,
  type M7AgentArmIsolationV1,
  type M7PairedAgentInputV1,
} from "./m7-paired-agent.js";
import {
  M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
  createM7R3PatrolTrajectoryCaseSpecV1,
} from "./m7-patrol-trajectory.js";
import { createM7R3AgentDeliveryTrackerV1 } from "./m7-r3-agent-delivery.js";
import {
  M7R3PairedAgentArmRequestV1Schema,
  M7R3PairedAgentArmResultV1Schema,
  createM7R3AgentAttemptEvidenceSidecarV1,
  createM7R3NaturalUserPromptV1,
  createM7R3NeutralRuntimeResourceAppendixV1,
  createM7R3PairedAgentArmResultV1,
  createM7R3PairedAgentProtocolV1,
  createM7R3PairedCaseContractV1,
  runM7R3PairedAgentArmOnceV1,
  type M7R3PairedAgentArmRequestV1,
  type M7R3PairedAgentInputV1,
  type M7R3PairedAgentPortV1,
  type M7R3PairedCaseContractV1,
} from "./m7-r3-paired-agent.js";

const sha = (value: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const shaJson = (value: unknown): Sha256DigestV1 =>
  sha(canonicalJson(JsonValueSchema.parse(value)));

const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
  schemaVersion: 1,
  adapterRevisionId: "adapter-revision:m7-r3:generic-patrol-v1",
  adapterId: "adapter:m7-r3:generic-patrol",
  sourceId: `source:v1:${sha("pristine external project")}`,
  packageDigest: sha("frozen generic Adapter package"),
  manifestDigest: sha("frozen generic Adapter manifest"),
  implementationDigest: sha("frozen generic Adapter implementation"),
  payloadSchemaDigest: sha("frozen patrol.motion schema"),
  sdkDigest: sha("project Adapter SDK"),
  bridgeDigest: sha("project Adapter bridge"),
  capabilitySet: {
    schemaVersion: 1 as const,
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

const codingTools = ["read", "bash", "edit", "write"].map((name) => ({
  schemaVersion: 1 as const,
  family: "coding" as const,
  name,
  definitionSha256: sha(`coding tool ${name}`),
}));

const budget = {
  schemaVersion: 1 as const,
  attemptsMaximum: 1 as const,
  userTurnsPerAttemptMaximum: 1 as const,
  toolCallsMaximum: 64,
  wallTimeMsMaximum: 900_000,
  taskSandboxNetworkMode: "denied" as const,
  taskCredentialMountCountMaximum: 0 as const,
};

const hostAdmittedGameToolNames = [
  PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.capabilities,
  PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.query,
];

const admittedGameTools = createM6AdmittedGameToolsV1({
  adapterRevision,
  hostAdmittedToolNames: hostAdmittedGameToolNames,
});

const surfaces = (runtimeEnabled: boolean) => ({
  chronoriftGameTools: runtimeEnabled,
  publicRuntimeRecordsThroughGameTools: runtimeEnabled,
  projectAdapterPackage: false as const,
  rawGodotExecutable: false as const,
  hiddenAssignmentStore: false as const,
  hiddenMutationOrEvaluator: false as const,
  otherArmPatchOrRecords: false as const,
});

const isolation = (
  arm: "runtime_enabled" | "code_only",
  baselineSelectedTreeSha256: Sha256DigestV1,
): M7AgentArmIsolationV1 => ({
  schemaVersion: 1,
  arm,
  taskId: `task:m7-r3:${arm}`,
  workspaceHandle: `workspace:m7-r3:${arm}`,
  workspaceInstanceSha256: sha(`${arm} workspace instance`),
  sessionInstanceSha256: sha(`${arm} Session instance`),
  cacheInstanceSha256: sha(`${arm} cache instance`),
  sandboxInstanceSha256: sha(`${arm} sandbox instance`),
  sandboxProfileSha256: sha("same R3 sandbox policy"),
  workspaceBaselineSelectedTreeSha256: baselineSelectedTreeSha256,
  readableSurfaces: surfaces(arm === "runtime_enabled"),
});

const prompts = [
  "Patrolling enemies move inconsistently on sloped terrain: their pace changes with the incline and they can lose contact on descents. Fix the behavior without changing the level layout or the meaning of enemies configured to fall from edges. Leave a reviewable candidate change.",
  "Some patrolling enemies eventually stop moving and never resume even though the game is still running. Investigate and fix the behavior without changing their configured speeds or the level layout. Leave a reviewable candidate change.",
] as const;

const caseContract = (ordinal: 1 | 2): M7R3PairedCaseContractV1 => {
  const classifierImplementationSha256 = sha(
    "generic trajectory classifier implementation frozen before both mutations",
  );
  const trajectoryCaseSpec = createM7R3PatrolTrajectoryCaseSpecV1({
    classifierImplementationSha256,
    expectedBaselineWitnessKinds:
      ordinal === 1
        ? ["ground_contact_loss", "grounded_speed_deviation"]
        : ["grounded_stall"],
    expectedRecoveryWitnessKinds:
      ordinal === 1 ? ["sustained_grounded_motion"] : ["direction_recovery"],
    frozenAt: "2026-08-16T00:00:00.000Z",
  });
  return createM7R3PairedCaseContractV1({
    portfolioId: "m7-r3-portfolio:0123456789abcdef01234567",
    caseOrdinal: ordinal,
    caseId: `m7-r3-case:${ordinal.toString().repeat(24)}`,
    mutatedBaselineSelectedTreeSha256: sha(`mutated baseline ${ordinal}`),
    naturalPrompt: createM7R3NaturalUserPromptV1(prompts[ordinal - 1]!),
    pairedAgentProtocolImplementationSha256: sha(
      "m7-r3-paired-agent implementation",
    ),
    pairedPublicTaskContractSha256: sha(`paired task contract ${ordinal}`),
    runtimeArmPublicTaskSpecSha256: sha(`runtime public task ${ordinal}`),
    codeOnlyArmPublicTaskSpecSha256: sha(`code-only public task ${ordinal}`),
    adapterMutantCompatibilityReceiptSha256: sha(
      `Adapter mutant compatibility ${ordinal}`,
    ),
    commonRuntimeMaterials: {
      authoritativeSensorFreezeRecordSha256: sha(
        "authoritative generic patrol sensor freeze",
      ),
      trajectoryClassifierFreezeRecordSha256: sha(
        "generic trajectory classifier freeze",
      ),
      trajectoryClassifierImplementationSha256: classifierImplementationSha256,
      trajectoryClassifierConfigSha256:
        M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1.configSha256,
      adapterRevisionSha256: shaJson(adapterRevision),
      adapterPackageSha256: adapterRevision.packageDigest,
      adapterObservationSchemaSha256: sha(
        "generic patrol.motion observation schema",
      ),
      pristineAdapterConformanceReceiptSha256: sha(
        "pristine Adapter conformance receipt",
      ),
      validatedGameToolSetSha256: shaJson(admittedGameTools),
      commonEnvironmentInstructionsSha256: sha(
        "common environment instructions",
      ),
      hostModelRuntimeConfigSha256: sha("Host model runtime configuration"),
    },
    agentConfiguration: {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "max",
      agentBudgetSha256: shaJson(budget),
      codingToolSetSha256: shaJson(codingTools),
      sandboxPolicySha256: sha("same R3 sandbox policy"),
    },
    trajectoryClassifierConfig: M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
    trajectoryCaseSpec,
  });
};

const pairedInput = (ordinal: 1 | 2 = 1): M7R3PairedAgentInputV1 => {
  const contract = caseContract(ordinal);
  return {
    schemaVersion: 1,
    recordKind: "m7-r3-paired-agent-input",
    campaignId: `m7-campaign:${ordinal.toString().repeat(24)}`,
    caseCampaignAdmissionRecordSha256: sha(
      `Host-only case campaign admission ${ordinal}`,
    ),
    caseContract: contract,
    provider: contract.agentConfiguration.provider,
    model: contract.agentConfiguration.model,
    thinkingLevel: contract.agentConfiguration.thinkingLevel,
    agentBudget: budget,
    codingTools,
    pristineAdapterRevision: adapterRevision,
    hostAdmittedGameToolNames,
    runtimeResourceMap: createM7RuntimeResourceMapV1({
      schemaVersion: 1,
      taskId: "task:m7-r3:runtime_enabled",
      baselineBuildId: `build:m7-r3:mutant-${ordinal}`,
      baselineSourceId: `source:m7-r3:mutant-${ordinal}`,
      launchTargetId: "launch:m7-r3:main",
    }),
    runtimeIsolation: isolation(
      "runtime_enabled",
      contract.mutatedBaselineSelectedTreeSha256,
    ),
    codeOnlyIsolation: isolation(
      "code_only",
      contract.mutatedBaselineSelectedTreeSha256,
    ),
  };
};

const armResult = (
  request: M7R3PairedAgentArmRequestV1,
  withExecution = false,
) => {
  const common = {
    schemaVersion: 1 as const,
    recordKind: "m7-r3-paired-agent-arm-result" as const,
    campaignId: request.campaignId,
    portfolioId: request.portfolioId,
    caseId: request.caseId,
    caseCampaignAdmissionRecordSha256:
      request.caseCampaignAdmissionRecordSha256,
    pairedCaseContractContentSha256: request.pairedCaseContractContentSha256,
    attemptOrdinal: 1 as const,
    userTurnCount: 1 as const,
    status: "completed" as const,
    realizedProvider: request.provider,
    realizedModel: request.model,
    realizedThinkingLevel: request.thinkingLevel,
    activeToolNames: [
      ...request.codingTools.map((tool) => tool.name),
      ...request.gameTools.map((tool) => tool.name),
    ],
    attemptBindingContentSha256: request.attemptBinding.bindingContentSha256,
    agentDeliveryTraceRecordSha256: sha(`${request.arm} delivery trace`),
    candidatePatch: null,
    sourceObservations: [],
  };
  if (request.arm === "code_only") {
    return createM7R3PairedAgentArmResultV1({
      ...common,
      arm: "code_only",
      executions: [],
      agentVisibleGameToolExchanges: [],
      trajectorySummaries: [],
      runtimeEvidenceReceiptSha256: null,
    });
  }
  return createM7R3PairedAgentArmResultV1({
    ...common,
    arm: "runtime_enabled",
    executions: withExecution
      ? [
          {
            schemaVersion: 1,
            executionId: "execution:m7-r3:baseline",
            buildId: "build:m7-r3:mutant-1",
            sourceSha256: request.baselineSelectedTreeSha256,
            startedAt: "2026-08-16T01:00:00.000Z",
            endedAt: "2026-08-16T01:00:01.000Z",
            sealed: true,
            coverageComplete: false,
            cleanupProven: true,
            publicSymptomObserved: true,
            publicObservationSha256: sha("public observation"),
          },
        ]
      : [],
    agentVisibleGameToolExchanges: [],
    trajectorySummaries: [],
    runtimeEvidenceReceiptSha256: withExecution
      ? sha("runtime evidence receipt")
      : null,
  });
};

const cleanupResult = (
  input: Parameters<M7R3PairedAgentPortV1["cleanupArm"]>[0],
) => ({
  schemaVersion: 1 as const,
  arm: input.arm,
  attemptBindingContentSha256: input.attemptBindingContentSha256,
  proven: true,
  receiptSha256: sha(`${input.arm} cleanup receipt`),
});

const legacyInput = (): M7PairedAgentInputV1 => {
  const baseline = sha("legacy mutant baseline");
  return {
    schemaVersion: 1,
    campaignId: "m7-campaign:abcdef0123456789abcdef01",
    publicTaskSpecSha256: sha("legacy paired task"),
    runtimeArmPublicTaskSpecSha256: sha("legacy runtime task"),
    codeOnlyArmPublicTaskSpecSha256: sha("legacy code-only task"),
    prompt: M7_NATURAL_USER_PROMPT_V1,
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinkingLevel: "max",
    agentBudget: budget,
    baselineSelectedTreeSha256: baseline,
    commonEnvironmentInstructionsSha256: sha("legacy environment"),
    hostModelRuntimeConfigSha256: sha("legacy Host config"),
    codingTools,
    sensorFreezeRecordSha256: sha("legacy sensor freeze"),
    pristineAdapterRevision: adapterRevision,
    hostAdmittedGameToolNames,
    runtimeResourceMap: createM7RuntimeResourceMapV1({
      schemaVersion: 1,
      taskId: "task:m7-r3:runtime_enabled",
      baselineBuildId: "build:legacy:mutant",
      baselineSourceId: "source:legacy:mutant",
      launchTargetId: "launch:legacy:main",
    }),
    runtimeIsolation: isolation("runtime_enabled", baseline),
    codeOnlyIsolation: isolation("code_only", baseline),
  };
};

describe("M7 R3 paired Agent protocol", () => {
  it("keeps V1 and R3 wire records mutually exclusive", () => {
    const r3 = createM7R3PairedAgentProtocolV1(pairedInput());
    const legacy = createM7PairedAgentProtocolV1(legacyInput());

    expect(
      M7PairedAgentArmRequestV1Schema.safeParse(r3.runtimeRequest).success,
    ).toBe(false);
    expect(
      M7R3PairedAgentArmRequestV1Schema.safeParse(legacy.runtimeRequest)
        .success,
    ).toBe(false);
  });

  it("binds two cases to different exact natural prompt bytes", () => {
    const first = createM7R3PairedAgentProtocolV1(pairedInput(1));
    const second = createM7R3PairedAgentProtocolV1(pairedInput(2));

    expect(first.runtimeRequest.prompt).toBe(prompts[0]);
    expect(second.runtimeRequest.prompt).toBe(prompts[1]);
    expect(first.runtimeRequest.prompt).not.toBe(second.runtimeRequest.prompt);
    expect(first.runtimeRequest.promptIdentity.utf8Sha256).not.toBe(
      second.runtimeRequest.promptIdentity.utf8Sha256,
    );
    expect(first.runtimeRequest.promptIdentity.canonicalJsonSha256).not.toBe(
      second.runtimeRequest.promptIdentity.canonicalJsonSha256,
    );
  });

  it("makes same-case arms equal except for the frozen runtime treatment", () => {
    const protocol = createM7R3PairedAgentProtocolV1(pairedInput());
    const { runtimeRequest, codeOnlyRequest } = protocol;

    expect(runtimeRequest.prompt).toBe(codeOnlyRequest.prompt);
    expect(runtimeRequest.promptIdentity).toEqual(
      codeOnlyRequest.promptIdentity,
    );
    expect(runtimeRequest.provider).toBe(codeOnlyRequest.provider);
    expect(runtimeRequest.model).toBe(codeOnlyRequest.model);
    expect(runtimeRequest.thinkingLevel).toBe(codeOnlyRequest.thinkingLevel);
    expect(runtimeRequest.agentBudget).toEqual(codeOnlyRequest.agentBudget);
    expect(runtimeRequest.codingTools).toEqual(codeOnlyRequest.codingTools);
    expect(runtimeRequest.baselineSelectedTreeSha256).toBe(
      codeOnlyRequest.baselineSelectedTreeSha256,
    );
    expect(runtimeRequest.caseCampaignAdmissionRecordSha256).toBe(
      codeOnlyRequest.caseCampaignAdmissionRecordSha256,
    );
    expect(runtimeRequest.runtimeAccess).not.toBeNull();
    expect(runtimeRequest.gameTools.length).toBeGreaterThan(0);
    expect(codeOnlyRequest.runtimeAccess).toBeNull();
    expect(codeOnlyRequest.gameTools).toEqual([]);
    const appendix = createM7R3NeutralRuntimeResourceAppendixV1(
      runtimeRequest.runtimeAccess.runtimeResourceMap,
    );
    expect(appendix).not.toMatch(/trajectory|classifier|caseSpec/iu);
    expect(protocol.surfaceEqualityProof.runtimeResourceAppendixSha256).toBe(
      shaJson(appendix),
    );
    expect(
      protocol.surfaceEqualityProof.runtimeTrajectoryIdentitiesSha256,
    ).not.toBe(
      protocol.surfaceEqualityProof.codeOnlyTrajectoryIdentitiesSha256,
    );
  });

  it("rejects substituted admission and trajectory identities", () => {
    const request =
      createM7R3PairedAgentProtocolV1(pairedInput()).runtimeRequest;
    const changedAdmission = structuredClone(request);
    changedAdmission.caseCampaignAdmissionRecordSha256 = sha(
      "different Host-only admission",
    );
    expect(() =>
      M7R3PairedAgentArmRequestV1Schema.parse(changedAdmission),
    ).toThrow(/frozen attempt binding/u);

    const changedTrajectory = structuredClone(request);
    changedTrajectory.runtimeAccess.trajectory.caseSpecSha256 = sha(
      "substituted trajectory case spec",
    );
    expect(() =>
      M7R3PairedAgentArmRequestV1Schema.parse(changedTrajectory),
    ).toThrow(/trajectory surface/u);
  });

  it("allows a retained runtime execution even when its trajectory summary is unavailable", () => {
    const request =
      createM7R3PairedAgentProtocolV1(pairedInput()).runtimeRequest;
    const result = armResult(request, true);

    expect(result.executions).toHaveLength(1);
    expect(result.trajectorySummaries).toEqual([]);
    expect(M7R3PairedAgentArmResultV1Schema.parse(result)).toEqual(result);

    const illegalCodeOnly = {
      ...armResult(
        createM7R3PairedAgentProtocolV1(pairedInput()).codeOnlyRequest,
      ),
      executions: result.executions,
    };
    expect(
      M7R3PairedAgentArmResultV1Schema.safeParse(illegalCodeOnly).success,
    ).toBe(false);
  });

  it("runs and cleans one arm exactly once when the runner throws", async () => {
    const request =
      createM7R3PairedAgentProtocolV1(pairedInput()).runtimeRequest;
    const runArm = vi.fn(async () => {
      throw new Error("provider transport failed");
    });
    const cleanupArm = vi.fn(
      async (input: Parameters<M7R3PairedAgentPortV1["cleanupArm"]>[0]) =>
        cleanupResult(input),
    );

    const record = await runM7R3PairedAgentArmOnceV1({
      request,
      port: { runArm, cleanupArm },
    });

    expect(runArm).toHaveBeenCalledTimes(1);
    expect(cleanupArm).toHaveBeenCalledTimes(1);
    expect(record.result).toBeNull();
    expect(record.infrastructureFailureCode).toBe("runner_threw");
    expect(record.cleanup.proven).toBe(true);
    expect(record.attemptEvidence.piTurnStarted).toBe(false);
    expect(record.failureReceipt).toMatchObject({
      piTurnStarted: false,
      lifecycle: [],
      primaryFailure: {
        stage: "agent_turn",
        category: "provider",
        errorName: "Error",
      },
      cleanupFailures: [],
      sealFailure: null,
    });
    expect(record.failureReceipt?.primaryFailure?.messageSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(JSON.stringify(record.failureReceipt)).not.toContain(
      "provider transport failed",
    );
  });

  it("keeps a pre-event runner failure bound to its persisted empty delivery trace", async () => {
    const request =
      createM7R3PairedAgentProtocolV1(pairedInput()).runtimeRequest;
    const trace = createM7R3AgentDeliveryTrackerV1().snapshot();
    const cleanupArm = vi.fn(
      async (input: Parameters<M7R3PairedAgentPortV1["cleanupArm"]>[0]) =>
        cleanupResult(input),
    );
    const sealAttemptEvidenceOnce = vi.fn(
      async (
        input: Parameters<
          NonNullable<M7R3PairedAgentPortV1["sealAttemptEvidenceOnce"]>
        >[0],
      ) =>
        createM7R3AgentAttemptEvidenceSidecarV1({
          campaignId: input.campaignId,
          portfolioId: input.portfolioId,
          caseId: input.caseId,
          caseCampaignAdmissionRecordSha256:
            input.caseCampaignAdmissionRecordSha256,
          pairedCaseContractContentSha256:
            input.pairedCaseContractContentSha256,
          arm: input.arm,
          attemptBindingContentSha256: input.attemptBindingContentSha256,
          terminalStage: "pi_turn",
          terminalCode: "operation_threw",
          piTurnStarted: false,
          piResultObserved: false,
          piStats: null,
          agentVisibleGameToolExchanges: [],
          sourceObservations: [],
          resultRecordContentSha256: null,
          agentDeliveryTraceRecordSha256: trace.recordContentSha256,
          runtimeEvidenceReceiptSha256: null,
          trajectorySummarySha256s: [],
          cleanup: {
            schemaVersion: 1,
            runtimeCloseRequired: true,
            runtimeCloseAttempted: true,
            runtimeCloseCompleted: true,
            sandboxCleanupAttempted: true,
            sandboxCleanupReceiptObserved: true,
            processGroupTerminated: true,
            cgroupPopulated: false,
            termSent: false,
            killSent: false,
            scopeRemoved: true,
            storageReconciliationObserved: true,
            storageReconciled: true,
            cleanupResultValid: true,
            cleanupProven: true,
            cleanupReceiptSha256: input.cleanup.receiptSha256,
            cleanupInfrastructureFailure: false,
          },
        }),
    );

    const record = await runM7R3PairedAgentArmOnceV1({
      request,
      port: {
        runArm: async () => {
          throw new Error("Pi failed before its first event");
        },
        cleanupArm,
        sealAttemptEvidenceOnce,
      },
    });

    expect(sealAttemptEvidenceOnce).toHaveBeenCalledWith(
      expect.objectContaining({ runnerFailureCode: "runner_threw" }),
    );
    expect(record).toMatchObject({
      result: null,
      infrastructureFailureCode: "runner_threw",
      cleanup: { proven: true },
      attemptEvidence: {
        terminalStage: "pi_turn",
        terminalCode: "operation_threw",
        piTurnStarted: false,
        agentDeliveryTraceRecordSha256: trace.recordContentSha256,
      },
    });
  });

  it("does not rerun after cleanup failure and keeps the valid arm result", async () => {
    const request =
      createM7R3PairedAgentProtocolV1(pairedInput()).codeOnlyRequest;
    const runArm = vi.fn(async () => armResult(request));
    const cleanupArm = vi.fn(async () => {
      throw new Error("cleanup receipt unavailable");
    });

    const record = await runM7R3PairedAgentArmOnceV1({
      request,
      port: { runArm, cleanupArm },
    });

    expect(runArm).toHaveBeenCalledTimes(1);
    expect(cleanupArm).toHaveBeenCalledTimes(1);
    expect(record.result).not.toBeNull();
    expect(record.infrastructureFailureCode).toBeNull();
    expect(record.cleanupInfrastructureFailure).toBe(true);
    expect(record.cleanup.proven).toBe(false);
    expect(record.failureReceipt).toMatchObject({
      primaryFailure: null,
      cleanupFailures: [
        expect.objectContaining({ stage: "arm_cleanup", errorName: "Error" }),
      ],
      sealFailure: null,
    });
  });
});
