import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonValueSchema,
  M6AdapterBuildCompatibilityReceiptV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  asSha256DigestV1,
  asSourceId,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExternalHiddenFixFreshRunReceiptV1 } from "./external-hidden-fix.js";
import {
  createM7AgentVisibleGameToolExchangeHashV1,
  createM7RuntimeResourceMapV1,
  type M7AgentArmIsolationV1,
} from "./m7-paired-agent.js";
import type { M7AgentGameToolExchangeV1 } from "./m7-project-environment-paired-agent.js";
import {
  M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
  createM7R3PatrolTrajectoryCaseSpecV1,
} from "./m7-patrol-trajectory.js";
import type { M7PatrolEntityStateV1 } from "./m7-patrol-sensor.js";
import { createM7R3AgentDeliveryTrackerV1 } from "./m7-r3-agent-delivery.js";
import {
  createM7R3CaseCampaignAdmissionV1,
  type M7R3CaseCampaignAdmissionV1,
} from "./m7-r3-case-admission.js";
import {
  M7R3PairedAgentAttemptBindingV1Schema,
  createM7R3AgentAttemptFailureReceiptV1,
  createM7R3AgentAttemptEvidenceSidecarV1,
  createM7R3NaturalUserPromptV1,
  createM7R3PairedAgentArmResultV1,
  createM7R3PairedCaseContractV1,
  type M7R3PairedAgentAttemptBindingV1,
  type M7R3PairedAgentAttemptRecordV1,
  type M7R3PairedCaseContractV1,
} from "./m7-r3-paired-agent.js";
import {
  M7R3AgentVisibleGameToolExchangeReceiptV1Schema,
  createM7R3RuntimeEvidenceReceiptV1,
  createM7R3RuntimeTrajectoryExecutionMaterialV1,
  type M7R3RuntimeEvidenceReceiptV1,
} from "./m7-r3-project-environment-paired-agent.js";
import {
  M7R3ArmEvaluatorEvidenceV1Schema,
  M7R3LocalArmAdmissionV1Schema,
  M7R3LocalArmRunEnvelopeV1Schema,
  M7R3RuntimeUseLocalEvidenceStoreV1,
  runM7R3RuntimeUseLocalCampaignGateForTestingV1,
  type M7R3HiddenEvaluatorPortV1,
  type M7R3RuntimeUsePairedArmPortV1,
} from "./m7-r3-runtime-use-local-gate.js";
import {
  createM7R3TwoCasePortfolioFreezeV1,
  type M7R3TwoCasePortfolioFreezeV1,
} from "./m7-r3-two-case-portfolio.js";
import {
  deriveM7BuildSourceIdentitySha256V1,
  openM7RuntimeUseCampaignStoreV1,
  type BeginM7ArmOnceV1Input,
  type M7ArmV1,
  type M7CampaignSensorBindingV1,
  type M7MutationRegistrationV1,
  type M7RuntimeUseCampaignStoreV1,
} from "./m7-runtime-use-campaign.js";

const sha = (value: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));
const hashJson = (value: unknown): Sha256DigestV1 =>
  sha(canonicalJson(JsonValueSchema.parse(value)));

const CLASSIFIER_IMPLEMENTATION_SHA256 = sha(
  "R3 generic patrol trajectory classifier implementation",
);
const BASELINE_SHA256 = sha("R3 case-one mutated baseline");
const BASELINE_SOURCE_ID = asSourceId(`source:${BASELINE_SHA256}`);
const CANDIDATE_SHA256 = sha("runtime_enabled candidate tree");
const CANDIDATE_SOURCE_ID = asSourceId(`source:${CANDIDATE_SHA256}`);
const ADAPTER_REVISION_ID = "adapter-revision:m7-r3:generic-patrol-v1";
const RUNTIME_TASK_ID = "task:m7-r3:runtime_enabled";
const completeCleanup = {
  schemaVersion: 1 as const,
  processTreeTerminated: true,
  runtimeExited: true,
  bridgeExited: true,
  isolationGroupEmpty: true,
  scopeRemoved: true,
  scratchRemoved: true,
  storageReconciled: true,
};
const compatibilityReceipt = (input: {
  readonly kind: "baseline" | "candidate";
  readonly buildId: string;
  readonly sourceId: string;
  readonly sourceHash: Sha256DigestV1;
}) =>
  M6AdapterBuildCompatibilityReceiptV1Schema.parse({
    schemaVersion: 1 as const,
    receiptId: `compatibility:m7-r3:${input.kind}`,
    lineage: {
      schemaVersion: 1,
      buildRole:
        input.kind === "baseline" ? "assignment_baseline" : "candidate",
      baselineSourceHash: BASELINE_SHA256,
      adapterRevision: {
        schemaVersion: 1,
        adapterRevisionId: ADAPTER_REVISION_ID,
        adapterId: "adapter:m7-r3:generic-patrol",
        sourceId: asSourceId("source:m7-r3:pristine-adapter"),
        packageDigest: sha("R3 pristine adapter package"),
        manifestDigest: sha("R3 pristine adapter manifest"),
        implementationDigest: sha("R3 pristine adapter implementation"),
        payloadSchemaDigest: sha("R3 generic patrol schema"),
        sdkDigest: sha("R3 Adapter SDK"),
        bridgeDigest: sha("R3 Adapter bridge"),
        conformanceReceiptId: "conformance:m7-r3:generic-patrol",
      },
      build: {
        schemaVersion: 1,
        taskId: RUNTIME_TASK_ID,
        workspaceId: "workspace:m7-r3:runtime_enabled",
        sourceId: input.sourceId,
        buildId: input.buildId,
        sourceHash: input.sourceHash,
        workspaceDiffHash: sha(`R3 ${input.kind} workspace diff`),
        buildConfigurationHash: sha("R3 Build configuration"),
        outputHash: sha(`R3 ${input.kind} Build output`),
        createdAt: "2026-08-16T00:03:00.000Z",
      },
      toolchain: {
        schemaVersion: 1,
        toolchainReceiptId: "toolchain-receipt:m7-r3:test",
        artifactDigest: sha("R3 Godot toolchain artifact"),
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
    coverage: [
      {
        schemaVersion: 1,
        channelId: "project_adapter_observations",
        status: "complete",
        observedRecords: 3,
        droppedRecords: 0,
        overwrittenRecords: 0,
        limitations: [],
      },
    ],
    loss: [],
    cleanup: completeCleanup,
    outcome: "compatible",
    failures: [],
    observedAt: "2026-08-16T00:04:00.000Z",
  });

const BASELINE_COMPATIBILITY = compatibilityReceipt({
  kind: "baseline",
  buildId: "build:m7-r3:mutant",
  sourceId: BASELINE_SOURCE_ID,
  sourceHash: BASELINE_SHA256,
});

const roots = new Set<string>();
afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

const portfolioFixture = (): {
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly prompt: ReturnType<typeof createM7R3NaturalUserPromptV1>;
  readonly caseSpec: ReturnType<typeof createM7R3PatrolTrajectoryCaseSpecV1>;
} => {
  const prompt = createM7R3NaturalUserPromptV1(
    "Patrolling enemies sometimes stop moving. Investigate and fix the behavior without changing the level layout.",
  );
  const secondPrompt = createM7R3NaturalUserPromptV1(
    "Patrolling enemies move inconsistently on slopes. Investigate and fix the behavior without changing the level layout.",
  );
  const caseSpec = createM7R3PatrolTrajectoryCaseSpecV1({
    classifierImplementationSha256: CLASSIFIER_IMPLEMENTATION_SHA256,
    expectedBaselineWitnessKinds: ["grounded_stall"],
    expectedRecoveryWitnessKinds: ["sustained_grounded_motion"],
    frozenAt: "2026-08-16T00:00:00.000Z",
  });
  const secondSpec = createM7R3PatrolTrajectoryCaseSpecV1({
    classifierImplementationSha256: CLASSIFIER_IMPLEMENTATION_SHA256,
    expectedBaselineWitnessKinds: ["ground_contact_loss"],
    expectedRecoveryWitnessKinds: ["direction_recovery"],
    frozenAt: "2026-08-16T00:00:00.000Z",
  });
  const commonRuntimeMaterials = {
    authoritativeSensorFreezeRecordSha256: sha("R3 sensor freeze"),
    adapterRevisionSha256: sha("R3 pristine adapter revision"),
    adapterPackageSha256: sha("R3 pristine adapter package"),
    adapterObservationSchemaSha256: sha("R3 generic patrol schema"),
    trajectoryClassifierFreezeRecordSha256: sha("R3 classifier freeze"),
    trajectoryClassifierImplementationSha256: CLASSIFIER_IMPLEMENTATION_SHA256,
    trajectoryClassifierConfigSha256:
      M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1.configSha256,
    validatedGameToolSetSha256: sha("R3 validated game tools"),
    pristineAdapterConformanceReceiptSha256: sha(
      "R3 pristine adapter conformance",
    ),
    commonEnvironmentInstructionsSha256: sha(
      "R3 common environment instructions",
    ),
    hostModelRuntimeConfigSha256: sha("R3 Host model runtime configuration"),
  };
  const agentConfiguration = {
    provider: "test-provider",
    model: "test-model",
    thinkingLevel: "high" as const,
    agentBudgetSha256: sha("R3 one-attempt budget"),
    codingToolSetSha256: sha("R3 coding tools"),
    sandboxPolicySha256: sha("R3 sandbox policy"),
  };
  const portfolio = createM7R3TwoCasePortfolioFreezeV1({
    commonRuntimeMaterials,
    agentConfiguration,
    pairedAttemptPlan: {
      armOrder: ["runtime_enabled", "code_only"],
      attemptsPerArm: 1,
      retriesAllowed: false,
      userTurnsPerArm: 1,
    },
    evaluationPlan: {
      scenarioClassOrder: [
        "public_reproduction",
        "hidden_variant",
        "regression_control",
      ],
      repetitionsPerScenarioClass: 3,
      expectedFreshCopyRunCount: 9,
      freshCopyPerRun: true,
    },
    cases: [
      {
        subject: {
          subjectProjectSha256: sha("R3 external project"),
          pristineProjectRevision: "3e793f53598a131c53fb82555191cc14b8db07ff",
          pristineSelectedTreeSha256: sha("R3 pristine tree"),
        },
        mutant: {
          mutationSha256: sha("R3 hidden mutation one"),
          mutatedBuildSourceId: BASELINE_SOURCE_ID,
          mutatedBuildSourceSha256: BASELINE_SHA256,
          mutatedBaselineSelectedTreeSha256: BASELINE_SHA256,
          mutatedBuildSourceIdentitySha256: deriveM7BuildSourceIdentitySha256V1(
            {
              sourceId: BASELINE_SOURCE_ID,
              sourceHash: BASELINE_SHA256,
            },
          ),
        },
        naturalPromptUtf8Sha256: prompt.utf8Sha256,
        trajectoryCaseSpecId: caseSpec.caseId,
        trajectoryCaseSpecSha256: caseSpec.caseSpecSha256,
        adapterMutantCompatibilityReceiptSha256: sha(
          canonicalJson(BASELINE_COMPATIBILITY),
        ),
        pairedPublicTaskContractSha256: sha("R3 paired task one"),
        preflightImplementationSha256: sha("R3 preflight one"),
        evaluatorImplementationSha256: sha("R3 evaluator one"),
        evaluatorBundleSha256: sha("R3 evaluator bundle one"),
      },
      {
        subject: {
          subjectProjectSha256: sha("R3 external project"),
          pristineProjectRevision: "3e793f53598a131c53fb82555191cc14b8db07ff",
          pristineSelectedTreeSha256: sha("R3 pristine tree"),
        },
        mutant: {
          mutationSha256: sha("R3 hidden mutation two"),
          mutatedBuildSourceId: asSourceId("source:m7-r3:case-two-mutant"),
          mutatedBuildSourceSha256: sha("R3 case-two mutant"),
          mutatedBaselineSelectedTreeSha256: sha("R3 case-two mutant"),
          mutatedBuildSourceIdentitySha256: deriveM7BuildSourceIdentitySha256V1(
            {
              sourceId: asSourceId("source:m7-r3:case-two-mutant"),
              sourceHash: sha("R3 case-two mutant"),
            },
          ),
        },
        naturalPromptUtf8Sha256: secondPrompt.utf8Sha256,
        trajectoryCaseSpecId: secondSpec.caseId,
        trajectoryCaseSpecSha256: secondSpec.caseSpecSha256,
        adapterMutantCompatibilityReceiptSha256: sha(
          "R3 mutant compatibility two",
        ),
        pairedPublicTaskContractSha256: sha("R3 paired task two"),
        preflightImplementationSha256: sha("R3 preflight two"),
        evaluatorImplementationSha256: sha("R3 evaluator two"),
        evaluatorBundleSha256: sha("R3 evaluator bundle two"),
      },
    ],
    frozenAt: "2026-08-16T00:00:00.000Z",
  });
  return { portfolio, prompt, caseSpec };
};

interface CampaignFixture {
  readonly parent: string;
  readonly exposed: string;
  readonly store: M7RuntimeUseCampaignStoreV1;
  readonly evidence: M7R3RuntimeUseLocalEvidenceStoreV1;
  readonly sensor: M7CampaignSensorBindingV1;
  readonly registration: M7MutationRegistrationV1;
  readonly admission: M7R3CaseCampaignAdmissionV1;
  readonly contract: M7R3PairedCaseContractV1;
}

const campaignFixture = async (): Promise<CampaignFixture> => {
  const parent = await mkdtemp(join(tmpdir(), "chronorift-m7-r3-gate-"));
  roots.add(parent);
  const campaignRoot = join(parent, "campaign");
  const evidenceRoot = join(parent, "evidence");
  const exposed = join(parent, "agent");
  await Promise.all(
    [campaignRoot, evidenceRoot, exposed].map(async (root) => {
      await mkdir(root, { mode: 0o700 });
      await chmod(root, 0o700);
    }),
  );
  const store = await openM7RuntimeUseCampaignStoreV1({
    root: campaignRoot,
    exposedRoots: [exposed],
  });
  const evidence = await M7R3RuntimeUseLocalEvidenceStoreV1.open({
    root: evidenceRoot,
    exposedRoots: [exposed],
  });
  const { portfolio, prompt, caseSpec } = portfolioFixture();
  const frozenCase = portfolio.cases[0]!;
  const contract = createM7R3PairedCaseContractV1({
    portfolioId: portfolio.portfolioId,
    caseOrdinal: 1,
    caseId: frozenCase.caseId,
    mutatedBaselineSelectedTreeSha256:
      frozenCase.mutant.mutatedBaselineSelectedTreeSha256,
    naturalPrompt: prompt,
    pairedAgentProtocolImplementationSha256: sha(
      "R3 paired protocol implementation",
    ),
    pairedPublicTaskContractSha256: frozenCase.pairedPublicTaskContractSha256,
    runtimeArmPublicTaskSpecSha256: sha("R3 runtime public task"),
    codeOnlyArmPublicTaskSpecSha256: sha("R3 code-only public task"),
    adapterMutantCompatibilityReceiptSha256:
      frozenCase.adapterMutantCompatibilityReceiptSha256,
    commonRuntimeMaterials: portfolio.commonRuntimeMaterials,
    agentConfiguration: portfolio.agentConfiguration,
    trajectoryClassifierConfig: M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
    trajectoryCaseSpec: caseSpec,
  });
  const sensor = await store.bindCampaignSensorOnce({
    schemaVersion: 1,
    authoritativeSensorFreezeId: `m7-sensor-freeze:${"a".repeat(24)}`,
    authoritativeSensorFreezeRecordSha256:
      portfolio.commonRuntimeMaterials.authoritativeSensorFreezeRecordSha256,
    subjectProjectSha256: frozenCase.subject.subjectProjectSha256,
    pristineProjectRevision: frozenCase.subject.pristineProjectRevision,
    pristineSelectedTreeSha256: frozenCase.subject.pristineSelectedTreeSha256,
    pristineAdapterRevisionSha256:
      portfolio.commonRuntimeMaterials.adapterRevisionSha256,
    adapterPackageSha256: portfolio.commonRuntimeMaterials.adapterPackageSha256,
    adapterObservationSchemaSha256:
      portfolio.commonRuntimeMaterials.adapterObservationSchemaSha256,
    publicPatrolClassifierSha256: CLASSIFIER_IMPLEMENTATION_SHA256,
    pristineConformanceReceiptSha256:
      portfolio.commonRuntimeMaterials.pristineAdapterConformanceReceiptSha256,
    validatedGameToolSetSha256:
      portfolio.commonRuntimeMaterials.validatedGameToolSetSha256,
    boundAt: "2026-08-16T00:01:00.000Z",
  });
  const registration = await store.registerMutationOnce({
    mutationSha256: frozenCase.mutant.mutationSha256,
    mutatedBaselineSelectedTreeSha256:
      frozenCase.mutant.mutatedBaselineSelectedTreeSha256,
    mutatedBuildSourceIdentitySha256: deriveM7BuildSourceIdentitySha256V1({
      sourceId: frozenCase.mutant.mutatedBuildSourceId,
      sourceHash: frozenCase.mutant.mutatedBuildSourceSha256,
    }),
    adapterMutantCompatibilityReceiptSha256:
      frozenCase.adapterMutantCompatibilityReceiptSha256,
    publicTaskSpecSha256: frozenCase.pairedPublicTaskContractSha256,
    evaluatorImplementationSha256: frozenCase.evaluatorImplementationSha256,
    evaluatorBundleSha256: frozenCase.evaluatorBundleSha256,
    provider: portfolio.agentConfiguration.provider,
    model: portfolio.agentConfiguration.model,
    thinkingLevel: portfolio.agentConfiguration.thinkingLevel,
    agentBudgetSha256: portfolio.agentConfiguration.agentBudgetSha256,
    codingToolSetSha256: portfolio.agentConfiguration.codingToolSetSha256,
    sandboxPolicySha256: portfolio.agentConfiguration.sandboxPolicySha256,
    registeredAt: "2026-08-16T00:02:00.000Z",
  });
  await store.putPreflightOnce({
    pristinePassCount: 9,
    mutantPublicAndHiddenPassCount: 0,
    mutantRegressionPassCount: 3,
    genericClassifierMutantWitnessObserved: true,
    pristineAdapterConformancePassed: true,
    mutantBuildCompatibilityPassed: true,
    cleanupProven: true,
    infrastructureFailureCode: null,
    completedAt: "2026-08-16T00:03:00.000Z",
  });
  const admission = createM7R3CaseCampaignAdmissionV1({
    portfolioFreeze: portfolio,
    caseOrdinal: 1,
    campaignId: registration.campaignId,
    mutationRegistrationRecordSha256: registration.recordContentSha256,
    naturalPromptCanonicalJsonSha256: prompt.canonicalJsonSha256,
    pairedAgentProtocolImplementationSha256:
      contract.pairedAgentProtocolImplementationSha256,
    pairedCaseContractContentSha256: contract.pairedCaseContractContentSha256,
    runtimeArmPublicTaskSpecSha256: contract.runtimeArmPublicTaskSpecSha256,
    codeOnlyArmPublicTaskSpecSha256: contract.codeOnlyArmPublicTaskSpecSha256,
    admittedAt: "2026-08-16T00:04:00.000Z",
  });
  return {
    parent,
    exposed,
    store,
    evidence,
    sensor,
    registration,
    admission,
    contract,
  };
};

const readableSurfaces = (runtime: boolean) => ({
  chronoriftGameTools: runtime,
  publicRuntimeRecordsThroughGameTools: runtime,
  projectAdapterPackage: false as const,
  rawGodotExecutable: false as const,
  hiddenAssignmentStore: false as const,
  hiddenMutationOrEvaluator: false as const,
  otherArmPatchOrRecords: false as const,
});

const claimInput = (
  fixture: CampaignFixture,
  arm: M7ArmV1,
): BeginM7ArmOnceV1Input => ({
  campaignId: fixture.registration.campaignId,
  arm,
  binding: {
    publicTaskSpecSha256: fixture.registration.publicTaskSpecSha256,
    provider: fixture.registration.provider,
    model: fixture.registration.model,
    thinkingLevel: fixture.registration.thinkingLevel,
    agentBudgetSha256: fixture.registration.agentBudgetSha256,
    workspaceBaselineSelectedTreeSha256:
      fixture.registration.mutatedBaselineSelectedTreeSha256,
    codingToolSetSha256: fixture.registration.codingToolSetSha256,
    sandboxPolicySha256: fixture.registration.sandboxPolicySha256,
  },
  taskId: `task:m7-r3:${arm}`,
  sessionIdentitySha256: sha(`${arm} R3 session`),
  workspaceIdentitySha256: sha(`${arm} R3 workspace`),
  cacheIdentitySha256: sha(`${arm} R3 cache`),
  startedAt:
    arm === "runtime_enabled"
      ? "2026-08-16T00:05:00.000Z"
      : "2026-08-16T00:08:00.000Z",
});

const isolation = (
  fixture: CampaignFixture,
  arm: M7ArmV1,
): M7AgentArmIsolationV1 => {
  const claim = claimInput(fixture, arm);
  return {
    schemaVersion: 1,
    arm,
    taskId: claim.taskId,
    workspaceHandle: `workspace:m7-r3:${arm}`,
    workspaceInstanceSha256: claim.workspaceIdentitySha256,
    sessionInstanceSha256: claim.sessionIdentitySha256,
    cacheInstanceSha256: claim.cacheIdentitySha256,
    sandboxInstanceSha256: sha(`${arm} R3 sandbox instance`),
    sandboxProfileSha256: fixture.registration.sandboxPolicySha256,
    workspaceBaselineSelectedTreeSha256:
      fixture.registration.mutatedBaselineSelectedTreeSha256,
    readableSurfaces: readableSurfaces(arm === "runtime_enabled"),
  };
};

const attemptBinding = (
  fixture: CampaignFixture,
  arm: M7ArmV1,
): M7R3PairedAgentAttemptBindingV1 => {
  const runtime = arm === "runtime_enabled";
  const basis = {
    schemaVersion: 1 as const,
    recordKind: "m7-r3-paired-agent-attempt-binding" as const,
    campaignId: fixture.registration.campaignId,
    portfolioId: fixture.contract.portfolioId,
    caseId: fixture.contract.caseId,
    caseCampaignAdmissionRecordSha256: fixture.admission.recordContentSha256,
    pairedCaseContractContentSha256:
      fixture.contract.pairedCaseContractContentSha256,
    arm,
    attemptOrdinal: 1 as const,
    userTurnsMaximum: 1 as const,
    promptUtf8Sha256: fixture.contract.naturalPrompt.utf8Sha256,
    promptCanonicalJsonSha256:
      fixture.contract.naturalPrompt.canonicalJsonSha256,
    publicTaskSpecSha256: runtime
      ? fixture.contract.runtimeArmPublicTaskSpecSha256
      : fixture.contract.codeOnlyArmPublicTaskSpecSha256,
    pairedPublicTaskContractSha256:
      fixture.contract.pairedPublicTaskContractSha256,
    provider: fixture.registration.provider,
    model: fixture.registration.model,
    thinkingLevel: fixture.registration.thinkingLevel,
    agentBudgetSha256: fixture.registration.agentBudgetSha256,
    baselineSelectedTreeSha256:
      fixture.registration.mutatedBaselineSelectedTreeSha256,
    commonEnvironmentInstructionsSha256:
      fixture.contract.commonRuntimeMaterials
        .commonEnvironmentInstructionsSha256,
    hostModelRuntimeConfigSha256:
      fixture.contract.commonRuntimeMaterials.hostModelRuntimeConfigSha256,
    codingToolSetSha256: fixture.registration.codingToolSetSha256,
    sandboxProfileSha256: fixture.registration.sandboxPolicySha256,
    isolation: isolation(fixture, arm),
    surfaceEqualityProofSha256: sha("R3 paired surface equality proof"),
    runtimeSurface: runtime
      ? {
          schemaVersion: 1 as const,
          sensorFreezeRecordSha256:
            fixture.admission.authoritativeSensorFreezeRecordSha256,
          pristineAdapterRevisionId: ADAPTER_REVISION_ID,
          pristineAdapterRevisionSha256:
            fixture.contract.commonRuntimeMaterials.adapterRevisionSha256,
          pristineAdapterPackageSha256:
            fixture.contract.commonRuntimeMaterials.adapterPackageSha256,
          pristineAdapterConformanceReceiptSha256:
            fixture.contract.commonRuntimeMaterials
              .pristineAdapterConformanceReceiptSha256,
          admittedGameToolSetSha256:
            fixture.registration.runtimeGameToolSetSha256,
          runtimeResourceMap: createM7RuntimeResourceMapV1({
            schemaVersion: 1,
            taskId: claimInput(fixture, arm).taskId,
            baselineBuildId: "build:m7-r3:mutant",
            baselineSourceId: BASELINE_SOURCE_ID,
            launchTargetId: "launch:m7-r3:main",
          }),
          runtimeResourceAppendixSha256: sha("R3 neutral runtime appendix"),
          trajectory: {
            schemaVersion: 1 as const,
            classifierId: fixture.contract.trajectoryCaseSpec.classifierId,
            classifierFreezeRecordSha256:
              fixture.admission.trajectory.classifierFreezeRecordSha256,
            classifierImplementationSha256:
              fixture.admission.trajectory.classifierImplementationSha256,
            classifierConfigSha256:
              fixture.admission.trajectory.classifierConfigSha256,
            caseSpecId: fixture.admission.trajectory.caseSpecId,
            caseSpecSha256: fixture.admission.trajectory.caseSpecSha256,
          },
        }
      : null,
  };
  return M7R3PairedAgentAttemptBindingV1Schema.parse({
    ...basis,
    bindingContentSha256: hashJson(basis),
  });
};

const localAdmission = (fixture: CampaignFixture, arm: M7ArmV1) => {
  const binding = attemptBinding(fixture, arm);
  return M7R3LocalArmAdmissionV1Schema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-local-arm-admission",
    arm,
    caseCampaignAdmissionRecordSha256: fixture.admission.recordContentSha256,
    pairedCaseContractContentSha256:
      fixture.contract.pairedCaseContractContentSha256,
    pairedAttemptBindingContentSha256: binding.bindingContentSha256,
    pairedAttemptBinding: binding,
    claim: claimInput(fixture, arm),
  });
};

const entity = (
  input: Partial<M7PatrolEntityStateV1> = {},
): M7PatrolEntityStateV1 => ({
  entity_id: "enemy:one",
  name: "Enemy",
  start_direction: 1,
  direction: 1,
  fall_off_edge: false,
  speed: 100,
  position_x: 0,
  position_y: 0,
  velocity_x: 100,
  velocity_y: 0,
  grounded: true,
  ...input,
});

const queryResponse = (input: {
  readonly callOrdinal: number;
  readonly taskId: string;
  readonly executionId: string;
  readonly runtimeId: string;
  readonly buildId: string;
  readonly states: readonly M7PatrolEntityStateV1[];
  readonly sequenceStart: number;
}): JsonValue => ({
  schemaVersion: 1,
  toolCallId: `call-game-${input.callOrdinal}`,
  outcome: "success",
  output: {
    schemaVersion: 1,
    taskId: input.taskId,
    executionId: input.executionId,
    rows: input.states.map((state, index) => ({
      schemaVersion: 1,
      rowId: `query-row:${input.executionId}:${input.sequenceStart + index}`,
      kind: "state",
      clock: null,
      value: {
        schemaVersion: 1,
        kind: "state_sample",
        recordSequence: input.sequenceStart + index,
        clock: { processFrame: input.sequenceStart + index },
        payload: {
          stateDomainId: "patrol.motion",
          semanticCoverage: "declared",
          value: { agents: [state] },
        },
      },
    })),
    nextCursor: null,
    coverage: [],
    loss: [],
    limitations: [],
  },
});

const finalToolResult = (details: JsonValue): JsonValue => ({
  content: [{ type: "text", text: JSON.stringify(details) }],
  details,
});

const runtimeObservationReceipt = (input: {
  readonly kind: "baseline" | "candidate";
  readonly runtimeId: string;
  readonly executionId: string;
  readonly buildId: string;
  readonly startedAt: string;
  readonly completedAt: string;
}) =>
  ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse({
    schemaVersion: 1,
    receiptId: `runtime-observation-receipt:m7-r3:${input.kind}`,
    taskId: RUNTIME_TASK_ID,
    runtimeId: input.runtimeId,
    executionId: input.executionId,
    buildId: input.buildId,
    environmentRevisionId: `environment-revision:m7-r3:${input.kind}`,
    adapterRevisionId: ADAPTER_REVISION_ID,
    launchTargetId: "launch:m7-r3:main",
    instrumentationMode: "instrumented",
    status: "stopped",
    bridgeHandshakeCount: 1,
    clock: {
      schemaVersion: 1,
      processFrame: 12,
      physicsTick: 7,
      simulationTimeUs: 200_000,
      renderFrame: null,
      hostMonotonicUs: 500_000,
    },
    queryObservations: {
      schemaVersion: 1,
      entityQueryCount: 1,
      entityRows: 1,
      stateQueryCount: 1,
      stateRows: 3,
    },
    captureCount: 1,
    captureWindowIds: [`capture-window:m7-r3:${input.kind}`],
    coverage: [
      {
        schemaVersion: 1,
        channelId: "project_adapter_observations",
        status: "complete",
        observedRecords: 3,
        droppedRecords: 0,
        overwrittenRecords: 0,
        limitations: [],
      },
    ],
    loss: [],
    cleanup: completeCleanup,
    outcome: "succeeded",
    failures: [],
    startedAt: input.startedAt,
    observedAt: input.startedAt,
    completedAt: input.completedAt,
  });

const runtimeMaterialProjection = (input: {
  readonly receipt: ReturnType<typeof runtimeObservationReceipt>;
  readonly compatibility: ReturnType<typeof compatibilityReceipt>;
}) =>
  createM7R3RuntimeTrajectoryExecutionMaterialV1({
    adapterBuildCompatibilityReceipt: input.compatibility,
    runtimeObservationReceipt: input.receipt,
  });

const exchangeReceipt = (exchange: M7AgentGameToolExchangeV1) => {
  const finalResult = finalToolResult(exchange.response);
  const response = exchange.response as Readonly<Record<string, JsonValue>>;
  const output = response.output as Readonly<Record<string, JsonValue>>;
  const basis = {
    schemaVersion: 1 as const,
    recordKind: "m7-r3-agent-visible-game-tool-exchange-receipt" as const,
    ordinal: exchange.ordinal,
    toolCallId: exchange.toolCallId,
    toolName: exchange.toolName,
    input: exchange.input,
    responseDetails: exchange.response,
    responseDetailsSha256: hashJson(exchange.response),
    finalToolResult: finalResult,
    finalToolResultSha256: hashJson(finalResult),
    outputIdentity: {
      taskId: typeof output.taskId === "string" ? output.taskId : null,
      executionId:
        typeof output.executionId === "string" ? output.executionId : null,
      runtimeId: typeof output.runtimeId === "string" ? output.runtimeId : null,
      buildId: typeof output.buildId === "string" ? output.buildId : null,
    },
    observedAt: exchange.observedAt,
    hostToolReturnOrdinal: exchange.hostToolReturnOrdinal,
  };
  return M7R3AgentVisibleGameToolExchangeReceiptV1Schema.parse({
    ...basis,
    recordContentSha256: hashJson(basis),
  });
};

const runtimeEvidence = (input: {
  readonly fixture: CampaignFixture;
  readonly binding: M7R3PairedAgentAttemptBindingV1;
  readonly omitCandidateModelAvailability?: boolean;
}): {
  readonly trace: ReturnType<
    ReturnType<typeof createM7R3AgentDeliveryTrackerV1>["snapshot"]
  >;
  readonly receipt: M7R3RuntimeEvidenceReceiptV1;
  readonly publicExchanges: ReturnType<
    typeof createM7AgentVisibleGameToolExchangeHashV1
  >[];
} => {
  const runtimeSurface = input.binding.runtimeSurface;
  if (runtimeSurface === null) throw new Error("runtime fixture lost surface");
  const taskId = input.binding.isolation.taskId;
  const baselineExecutionId = "execution:m7-r3:baseline";
  const candidateExecutionId = "execution:m7-r3:candidate";
  const baselineRuntimeId = "runtime:m7-r3:baseline";
  const candidateRuntimeId = "runtime:m7-r3:candidate";
  const baselineBuildId = runtimeSurface.runtimeResourceMap.baselineBuildId;
  const candidateBuildId = "build:m7-r3:candidate";
  const baselineResponse = queryResponse({
    callOrdinal: 1,
    taskId,
    executionId: baselineExecutionId,
    runtimeId: baselineRuntimeId,
    buildId: baselineBuildId,
    states: [
      entity({ velocity_x: 0, position_x: 1 }),
      entity({ velocity_x: 0, position_x: 1 }),
      entity({ velocity_x: 0, position_x: 1 }),
    ],
    sequenceStart: 1,
  });
  const candidateResponse = queryResponse({
    callOrdinal: 2,
    taskId,
    executionId: candidateExecutionId,
    runtimeId: candidateRuntimeId,
    buildId: candidateBuildId,
    states: [
      entity({ position_x: 0, velocity_x: 100 }),
      entity({ position_x: 2, velocity_x: 100 }),
      entity({ position_x: 4, velocity_x: 100 }),
    ],
    sequenceStart: 10,
  });
  const exchanges: M7AgentGameToolExchangeV1[] = [
    {
      schemaVersion: 1,
      ordinal: 1,
      toolCallId: "call-game-1",
      toolName: "game_query",
      input: {
        schemaVersion: 1,
        taskId,
        executionId: baselineExecutionId,
        select: "state",
        limit: 200,
      },
      response: baselineResponse,
      observedAt: "2026-08-16T00:05:10.000Z",
      hostToolReturnOrdinal: 1,
    },
    {
      schemaVersion: 1,
      ordinal: 2,
      toolCallId: "call-game-2",
      toolName: "game_query",
      input: {
        schemaVersion: 1,
        taskId,
        executionId: candidateExecutionId,
        select: "state",
        limit: 200,
      },
      response: candidateResponse,
      observedAt: "2026-08-16T00:06:10.000Z",
      hostToolReturnOrdinal: 3,
    },
  ];
  const tracker = createM7R3AgentDeliveryTrackerV1();
  tracker.onEvent({ type: "turn_start" });
  const baselineResult = finalToolResult(baselineResponse);
  tracker.onEvent({
    type: "tool_execution_start",
    toolCallId: exchanges[0]!.toolCallId,
    toolName: exchanges[0]!.toolName,
    args: exchanges[0]!.input,
  });
  tracker.recordFinalToolResult({
    toolCallId: exchanges[0]!.toolCallId,
    toolName: exchanges[0]!.toolName,
    toolKind: "game",
    hostToolReturnOrdinal: 1,
    finalResult: baselineResult,
  });
  tracker.onEvent({
    type: "tool_execution_end",
    toolCallId: exchanges[0]!.toolCallId,
    toolName: exchanges[0]!.toolName,
    result: baselineResult,
    isError: false,
  });
  tracker.onEvent({ type: "turn_start" });
  const codingResult: JsonValue = {
    content: [{ type: "text", text: "patch written" }],
    details: { changed: true },
  };
  tracker.onEvent({
    type: "tool_execution_start",
    toolCallId: "call-coding-1",
    toolName: "write",
    args: { path: "enemy.gd" },
  });
  tracker.recordFinalToolResult({
    toolCallId: "call-coding-1",
    toolName: "write",
    toolKind: "coding",
    hostToolReturnOrdinal: 2,
    finalResult: codingResult,
  });
  tracker.recordCodingSourceObservation({
    toolCallId: "call-coding-1",
    toolName: "write",
    hostToolReturnOrdinal: 2,
    baselineSourceSha256: BASELINE_SHA256,
    observedSourceSha256: CANDIDATE_SHA256,
    observedAt: "2026-08-16T00:06:00.000Z",
  });
  tracker.onEvent({
    type: "tool_execution_end",
    toolCallId: "call-coding-1",
    toolName: "write",
    result: codingResult,
    isError: false,
  });
  const candidateResult = finalToolResult(candidateResponse);
  tracker.onEvent({
    type: "tool_execution_start",
    toolCallId: exchanges[1]!.toolCallId,
    toolName: exchanges[1]!.toolName,
    args: exchanges[1]!.input,
  });
  tracker.recordFinalToolResult({
    toolCallId: exchanges[1]!.toolCallId,
    toolName: exchanges[1]!.toolName,
    toolKind: "game",
    hostToolReturnOrdinal: 3,
    finalResult: candidateResult,
  });
  tracker.onEvent({
    type: "tool_execution_end",
    toolCallId: exchanges[1]!.toolCallId,
    toolName: exchanges[1]!.toolName,
    result: candidateResult,
    isError: false,
  });
  if (!input.omitCandidateModelAvailability) {
    tracker.onEvent({ type: "turn_start" });
  }
  const trace = tracker.snapshot();
  const executions = [
    {
      schemaVersion: 1 as const,
      executionId: baselineExecutionId,
      buildId: baselineBuildId,
      sourceSha256: BASELINE_SHA256,
      startedAt: "2026-08-16T00:05:05.000Z",
      endedAt: "2026-08-16T00:05:20.000Z",
      sealed: true,
      coverageComplete: true,
      cleanupProven: true,
      publicSymptomObserved: true,
      publicObservationSha256: sha("R3 baseline public observation"),
    },
    {
      schemaVersion: 1 as const,
      executionId: candidateExecutionId,
      buildId: candidateBuildId,
      sourceSha256: CANDIDATE_SHA256,
      startedAt: "2026-08-16T00:06:05.000Z",
      endedAt: "2026-08-16T00:06:20.000Z",
      sealed: true,
      coverageComplete: true,
      cleanupProven: true,
      publicSymptomObserved: false,
      publicObservationSha256: sha("R3 candidate public observation"),
    },
  ];
  const sourceObservations = [
    {
      schemaVersion: 1 as const,
      boundary: "game_build_freeze" as const,
      sourceSha256: BASELINE_SHA256,
      buildId: baselineBuildId,
      observedAt: "2026-08-16T00:05:04.000Z",
    },
    {
      schemaVersion: 1 as const,
      boundary: "game_build_freeze" as const,
      sourceSha256: CANDIDATE_SHA256,
      buildId: candidateBuildId,
      observedAt: "2026-08-16T00:06:04.000Z",
    },
  ];
  const baselineObservation = runtimeObservationReceipt({
    kind: "baseline",
    runtimeId: baselineRuntimeId,
    executionId: baselineExecutionId,
    buildId: baselineBuildId,
    startedAt: executions[0]!.startedAt,
    completedAt: executions[0]!.endedAt,
  });
  const candidateObservation = runtimeObservationReceipt({
    kind: "candidate",
    runtimeId: candidateRuntimeId,
    executionId: candidateExecutionId,
    buildId: candidateBuildId,
    startedAt: executions[1]!.startedAt,
    completedAt: executions[1]!.endedAt,
  });
  const candidateCompatibility = compatibilityReceipt({
    kind: "candidate",
    buildId: candidateBuildId,
    sourceId: CANDIDATE_SOURCE_ID,
    sourceHash: CANDIDATE_SHA256,
  });
  const trajectoryMaterials = [
    runtimeMaterialProjection({
      receipt: baselineObservation,
      compatibility: BASELINE_COMPATIBILITY,
    }),
    runtimeMaterialProjection({
      receipt: candidateObservation,
      compatibility: candidateCompatibility,
    }),
  ];
  const receipt = createM7R3RuntimeEvidenceReceiptV1({
    schemaVersion: 1,
    recordKind: "m7-r3-runtime-agent-evidence-receipt",
    campaignId: input.fixture.registration.campaignId,
    portfolioId: input.fixture.contract.portfolioId,
    caseId: input.fixture.contract.caseId,
    caseCampaignAdmissionRecordSha256:
      input.fixture.admission.recordContentSha256,
    pairedCaseContractContentSha256:
      input.fixture.contract.pairedCaseContractContentSha256,
    attemptBindingContentSha256: input.binding.bindingContentSha256,
    arm: "runtime_enabled",
    attemptOrdinal: 1,
    baselineSelectedTreeSha256: BASELINE_SHA256,
    backendProjectionReceiptSha256: sha("R3 backend projection"),
    exchangeTranscriptSha256: hashJson(exchanges),
    exchanges: exchanges.map(exchangeReceipt),
    agentDeliveryTrace: trace,
    sourceObservations,
    executions,
    trajectoryMaterials,
  });
  return {
    trace,
    receipt,
    publicExchanges: exchanges.map((exchange) =>
      createM7AgentVisibleGameToolExchangeHashV1(exchange),
    ),
  };
};

interface AttemptOptions {
  readonly status?: "completed" | "provider_failure" | "timed_out" | "aborted";
  readonly candidate?: "valid" | "none";
  readonly cleanup?: boolean;
  readonly omitCandidateModelAvailability?: boolean;
}

const attemptEnvelope = (input: {
  readonly fixture: CampaignFixture;
  readonly arm: M7ArmV1;
  readonly options: AttemptOptions;
}) => {
  const binding = attemptBinding(input.fixture, input.arm);
  const status = input.options.status ?? "completed";
  const cleanupProven = input.options.cleanup ?? true;
  const candidateRequested = input.options.candidate === "valid";
  const patchSha256 = sha(`${input.arm} R3 patch bytes`);
  const candidateTreeSha256 =
    input.arm === "runtime_enabled"
      ? CANDIDATE_SHA256
      : sha("code_only candidate tree");
  const candidatePatch =
    status === "completed" && candidateRequested
      ? {
          schemaVersion: 1 as const,
          patch: {
            schemaVersion: 1 as const,
            artifactId: `m6-artifact:${patchSha256}`,
            rawSha256: patchSha256,
            byteLength: 123,
          },
          patchIdentity: {
            schemaVersion: 1 as const,
            baselineSelectedTreeSha256: BASELINE_SHA256,
            candidateSelectedTreeSha256: candidateTreeSha256,
            patchSha256,
            byteLength: 123,
          },
          admissible: true,
          roundTripVerified: true,
        }
      : null;
  const runtime =
    input.arm === "runtime_enabled"
      ? runtimeEvidence({
          fixture: input.fixture,
          binding,
          ...(input.options.omitCandidateModelAvailability === undefined
            ? {}
            : {
                omitCandidateModelAvailability:
                  input.options.omitCandidateModelAvailability,
              }),
        })
      : null;
  const codeOnlyTracker = createM7R3AgentDeliveryTrackerV1();
  codeOnlyTracker.onEvent({ type: "turn_start" });
  const trace = runtime?.trace ?? codeOnlyTracker.snapshot();
  const sourceObservations = [
    ...(runtime?.receipt.sourceObservations ?? []),
    ...(candidatePatch === null
      ? []
      : [
          {
            schemaVersion: 1 as const,
            boundary: "patch_freeze" as const,
            sourceSha256: candidateTreeSha256,
            buildId: null,
            observedAt: "2026-08-16T00:06:30.000Z",
          },
        ]),
  ];
  const resultCommon = {
    schemaVersion: 1 as const,
    recordKind: "m7-r3-paired-agent-arm-result" as const,
    campaignId: input.fixture.registration.campaignId,
    portfolioId: input.fixture.contract.portfolioId,
    caseId: input.fixture.contract.caseId,
    caseCampaignAdmissionRecordSha256:
      input.fixture.admission.recordContentSha256,
    pairedCaseContractContentSha256:
      input.fixture.contract.pairedCaseContractContentSha256,
    attemptOrdinal: 1 as const,
    userTurnCount: 1 as const,
    status,
    realizedProvider: input.fixture.registration.provider,
    realizedModel: input.fixture.registration.model,
    realizedThinkingLevel: input.fixture.registration.thinkingLevel,
    attemptBindingContentSha256: binding.bindingContentSha256,
    agentDeliveryTraceRecordSha256: trace.recordContentSha256,
    candidatePatch,
    sourceObservations,
  };
  const result =
    input.arm === "runtime_enabled"
      ? createM7R3PairedAgentArmResultV1({
          ...resultCommon,
          arm: "runtime_enabled",
          activeToolNames: ["read", "game_query"],
          executions: runtime?.receipt.executions ?? [],
          agentVisibleGameToolExchanges: runtime?.publicExchanges ?? [],
          // Deliberately absent: the Gate must rebuild these from the exact
          // receipt, not trust the runner's derived projection.
          trajectorySummaries: [],
          runtimeEvidenceReceiptSha256:
            runtime?.receipt.recordContentSha256 ?? null,
        })
      : createM7R3PairedAgentArmResultV1({
          ...resultCommon,
          arm: "code_only",
          activeToolNames: ["read"],
          executions: [],
          agentVisibleGameToolExchanges: [],
          trajectorySummaries: [],
          runtimeEvidenceReceiptSha256: null,
        });
  const cleanupReceiptSha256 = cleanupProven
    ? sha(`${input.arm} R3 cleanup`)
    : null;
  const attemptEvidence = createM7R3AgentAttemptEvidenceSidecarV1({
    campaignId: input.fixture.registration.campaignId,
    portfolioId: input.fixture.contract.portfolioId,
    caseId: input.fixture.contract.caseId,
    caseCampaignAdmissionRecordSha256:
      input.fixture.admission.recordContentSha256,
    pairedCaseContractContentSha256:
      input.fixture.contract.pairedCaseContractContentSha256,
    arm: input.arm,
    attemptBindingContentSha256: binding.bindingContentSha256,
    terminalStage: cleanupProven ? "sealed" : "cleanup",
    terminalCode: cleanupProven ? "completed" : "cleanup_not_proven",
    piTurnStarted: true,
    piResultObserved: true,
    piStats: {
      schemaVersion: 1,
      eventsObserved: 10,
      userMessages: 1,
      assistantMessages: 2,
      toolCalls: input.arm === "runtime_enabled" ? 3 : 0,
      toolResults: input.arm === "runtime_enabled" ? 3 : 0,
      totalMessages: 4,
      inputTokens: 10,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 20,
      cost: 0,
    },
    agentDeliveryTraceRecordSha256: trace.recordContentSha256,
    agentVisibleGameToolExchanges: runtime?.publicExchanges ?? [],
    sourceObservations,
    resultRecordContentSha256: result.recordContentSha256,
    runtimeEvidenceReceiptSha256: runtime?.receipt.recordContentSha256 ?? null,
    trajectorySummarySha256s: [],
    cleanup: {
      schemaVersion: 1,
      runtimeCloseRequired: input.arm === "runtime_enabled",
      runtimeCloseAttempted: input.arm === "runtime_enabled",
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
      cleanupProven,
      cleanupReceiptSha256,
      cleanupInfrastructureFailure: false,
    },
  });
  const attempt: M7R3PairedAgentAttemptRecordV1 = {
    schemaVersion: 1,
    recordKind: "m7-r3-paired-agent-attempt-record",
    arm: input.arm,
    binding,
    result,
    infrastructureFailureCode: null,
    cleanup: {
      schemaVersion: 1,
      arm: input.arm,
      attemptBindingContentSha256: binding.bindingContentSha256,
      proven: cleanupProven,
      receiptSha256: cleanupReceiptSha256,
    },
    cleanupInfrastructureFailure: false,
    attemptEvidence,
  };
  return {
    schemaVersion: 1 as const,
    recordKind: "m7-r3-local-arm-run-envelope" as const,
    arm: input.arm,
    attempt,
    deliveryTrace: trace,
    runtimeEvidenceReceipt: runtime?.receipt ?? null,
  };
};

const failedRuntimeEnvelopeBeforeFirstPiEvent = (input: {
  readonly fixture: CampaignFixture;
}) => {
  const binding = attemptBinding(input.fixture, "runtime_enabled");
  const trace = createM7R3AgentDeliveryTrackerV1().snapshot();
  const cleanupReceiptSha256 = sha("runtime_enabled early-failure cleanup");
  const attemptEvidence = createM7R3AgentAttemptEvidenceSidecarV1({
    campaignId: input.fixture.registration.campaignId,
    portfolioId: input.fixture.contract.portfolioId,
    caseId: input.fixture.contract.caseId,
    caseCampaignAdmissionRecordSha256:
      input.fixture.admission.recordContentSha256,
    pairedCaseContractContentSha256:
      input.fixture.contract.pairedCaseContractContentSha256,
    arm: "runtime_enabled",
    attemptBindingContentSha256: binding.bindingContentSha256,
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
      cleanupReceiptSha256,
      cleanupInfrastructureFailure: false,
    },
  });
  const failureReceipt = createM7R3AgentAttemptFailureReceiptV1({
    campaignId: input.fixture.registration.campaignId,
    portfolioId: input.fixture.contract.portfolioId,
    caseId: input.fixture.contract.caseId,
    arm: "runtime_enabled",
    attemptBindingContentSha256: binding.bindingContentSha256,
    attemptEvidenceRecordSha256: attemptEvidence.recordContentSha256,
    piTurnStarted: false,
    lifecycle: [],
    primaryFailure: {
      schemaVersion: 1,
      stage: "authentication_check",
      category: "authentication",
      errorName: "Error",
      platformCode: null,
      syscall: null,
      messageSha256: sha("sanitized authentication failure"),
      causeSha256s: [],
    },
    cleanupFailures: [],
    sealFailure: null,
  });
  const envelope = M7R3LocalArmRunEnvelopeV1Schema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-local-arm-run-envelope",
    arm: "runtime_enabled",
    attempt: {
      schemaVersion: 1,
      recordKind: "m7-r3-paired-agent-attempt-record",
      arm: "runtime_enabled",
      binding,
      result: null,
      infrastructureFailureCode: "runner_threw",
      cleanup: {
        schemaVersion: 1,
        arm: "runtime_enabled",
        attemptBindingContentSha256: binding.bindingContentSha256,
        proven: true,
        receiptSha256: cleanupReceiptSha256,
      },
      cleanupInfrastructureFailure: false,
      attemptEvidence,
      failureReceipt,
    },
    deliveryTrace: trace,
    runtimeEvidenceReceipt: null,
  });
  return { envelope, trace, cleanupReceiptSha256, failureReceipt };
};

const pairedArmPort = (input: {
  readonly fixture: CampaignFixture;
  readonly runtime: AttemptOptions;
  readonly codeOnly: AttemptOptions;
  readonly events: string[];
  readonly throwRuntime?: boolean;
}): M7R3RuntimeUsePairedArmPortV1 => ({
  getArmAdmission: async (arm) => localAdmission(input.fixture, arm),
  runArmOnce: async (request) => {
    input.events.push(`run:${request.arm}`);
    if (request.arm === "runtime_enabled" && input.throwRuntime) {
      throw new Error("simulated R3 arm infrastructure failure");
    }
    const expectedBinding = attemptBinding(input.fixture, request.arm);
    expect(request.pairedAttemptBindingContentSha256).toBe(
      expectedBinding.bindingContentSha256,
    );
    return attemptEnvelope({
      fixture: input.fixture,
      arm: request.arm,
      options:
        request.arm === "runtime_enabled" ? input.runtime : input.codeOnly,
    });
  },
});

const successfulFreshRun = (input: {
  readonly fixture: CampaignFixture;
  readonly request: Parameters<M7R3HiddenEvaluatorPortV1["runFreshCopy"]>[0];
  readonly outcome: "passed" | "failed";
}): ExternalHiddenFixFreshRunReceiptV1 => ({
  schemaVersion: 1,
  assignmentId: input.request.plan.assignmentId,
  freshCopyId: input.request.plan.freshCopyId,
  ordinal: input.request.plan.ordinal,
  scenarioClass: input.request.plan.scenarioClass,
  repetition: input.request.plan.repetition,
  baselineSelectedTreeSha256:
    input.fixture.registration.mutatedBaselineSelectedTreeSha256,
  candidateSelectedTreeSha256:
    input.request.expectedCandidateSelectedTreeSha256,
  patchSha256: input.request.patch.rawSha256,
  freshWorkspaceCreated: true,
  freshImportCacheCreated: true,
  freshProcessStarted: true,
  outcome: input.outcome,
  observationSha256: sha(`${input.request.plan.freshCopyId}:${input.outcome}`),
  cleanupProven: true,
});

const execute = async (input: {
  readonly fixture: CampaignFixture;
  readonly runtime: AttemptOptions;
  readonly codeOnly: AttemptOptions;
  readonly runtimeEvaluation?: "passed" | "failed";
  readonly codeOnlyEvaluation?: "passed" | "failed";
  readonly throwRuntime?: boolean;
}) => {
  const events: string[] = [];
  const runtimeEvaluator = vi.fn(
    async (request: Parameters<M7R3HiddenEvaluatorPortV1["runFreshCopy"]>[0]) =>
      successfulFreshRun({
        fixture: input.fixture,
        request,
        outcome: input.runtimeEvaluation ?? "passed",
      }),
  );
  const codeOnlyEvaluator = vi.fn(
    async (request: Parameters<M7R3HiddenEvaluatorPortV1["runFreshCopy"]>[0]) =>
      successfulFreshRun({
        fixture: input.fixture,
        request,
        outcome: input.codeOnlyEvaluation ?? "passed",
      }),
  );
  const terminal = await runM7R3RuntimeUseLocalCampaignGateForTestingV1({
    campaignId: input.fixture.registration.campaignId,
    campaignStore: input.fixture.store,
    caseAdmission: input.fixture.admission,
    caseContract: input.fixture.contract,
    armPort: pairedArmPort({
      fixture: input.fixture,
      runtime: input.runtime,
      codeOnly: input.codeOnly,
      events,
      ...(input.throwRuntime === undefined
        ? {}
        : { throwRuntime: input.throwRuntime }),
    }),
    evaluatorPortsForTesting: {
      runtime_enabled: { runFreshCopy: runtimeEvaluator },
      code_only: { runFreshCopy: codeOnlyEvaluator },
    },
    evidenceWriterForTesting: input.fixture.evidence,
    now: () => "2026-08-16T00:10:00.000Z",
  });
  return { terminal, events, runtimeEvaluator, codeOnlyEvaluator };
};

describe("M7 R3 local runtime-use campaign Gate", () => {
  it("supports only an accepted runtime candidate independently grounded in exact pre/post-edit ToolResults", async () => {
    const fixture = await campaignFixture();
    const outcome = await execute({
      fixture,
      runtime: { candidate: "valid" },
      codeOnly: { candidate: "none" },
    });

    expect(outcome.terminal.outcome).toBe("claim_supported");
    expect(outcome.events).toEqual(["run:runtime_enabled", "run:code_only"]);
    expect(outcome.runtimeEvaluator).toHaveBeenCalledTimes(9);
    expect(outcome.codeOnlyEvaluator).not.toHaveBeenCalled();
    const trajectory = await fixture.evidence.readTrajectoryUse(
      fixture.registration.campaignId,
    );
    expect(trajectory.trajectoryUseEstablished).toBe(true);
    expect(trajectory.summaries).toHaveLength(2);
    expect(trajectory.baselineWitnesses[0]?.kind).toBe("grounded_stall");
    expect(trajectory.candidateRecoveryWitnesses[0]?.kind).toBe(
      "sustained_grounded_motion",
    );
    expect(
      await fixture.evidence.readRuntimeEvidence(
        fixture.registration.campaignId,
      ),
    ).toMatchObject({
      baselineSelectedTreeSha256: BASELINE_SHA256,
      exchanges: [{ toolCallId: "call-game-1" }, { toolCallId: "call-game-2" }],
    });
  });

  it("does not support the claim when code-only also produces an accepted candidate", async () => {
    const fixture = await campaignFixture();
    const outcome = await execute({
      fixture,
      runtime: { candidate: "valid" },
      codeOnly: { candidate: "valid" },
    });
    expect(outcome.terminal).toMatchObject({
      outcome: "claim_not_supported",
      reason: "code_only_candidate_accepted",
    });
    expect(outcome.runtimeEvaluator).toHaveBeenCalledTimes(9);
    expect(outcome.codeOnlyEvaluator).toHaveBeenCalledTimes(9);
  });

  it("treats a valid trace with no later candidate delivery as experimental rejection, not infrastructure", async () => {
    const fixture = await campaignFixture();
    const outcome = await execute({
      fixture,
      runtime: {
        candidate: "valid",
        omitCandidateModelAvailability: true,
      },
      codeOnly: { candidate: "none" },
    });
    expect(outcome.terminal).toMatchObject({
      outcome: "claim_not_supported",
      reason: "runtime_use_not_verified",
    });
    const runtime = await fixture.store.readArmResult("runtime_enabled");
    expect(runtime).toMatchObject({
      loopOutcome: "completed",
      runtimeUseOutcome: "rejected",
      evaluatorOutcome: "accepted",
    });
  });

  it.each(["provider_failure", "timed_out", "aborted"] as const)(
    "keeps code-only %s comparison-inconclusive",
    async (status) => {
      const fixture = await campaignFixture();
      const outcome = await execute({
        fixture,
        runtime: { candidate: "valid" },
        codeOnly: { status, candidate: "none" },
      });
      expect(outcome.terminal.outcome).toBe("comparison_inconclusive");
      expect(outcome.codeOnlyEvaluator).not.toHaveBeenCalled();
    },
  );

  it("safety-stops before code-only and preserves cleanup override after runtime cleanup failure", async () => {
    const fixture = await campaignFixture();
    const outcome = await execute({
      fixture,
      runtime: { candidate: "valid", cleanup: false },
      codeOnly: { candidate: "none" },
    });
    expect(outcome.events).toEqual(["run:runtime_enabled"]);
    expect(outcome.terminal.outcome).toBe("cleanup_failed");
    expect(outcome.terminal.primaryOutcome).not.toBeNull();
    expect(outcome.codeOnlyEvaluator).not.toHaveBeenCalled();
  });

  it("retains exactly nine independently identified evaluator runs", async () => {
    const fixture = await campaignFixture();
    await execute({
      fixture,
      runtime: { candidate: "valid" },
      codeOnly: { candidate: "none" },
    });
    const evidence = await fixture.evidence.readEvaluator(
      fixture.registration.campaignId,
      "runtime_enabled",
    );
    expect(M7R3ArmEvaluatorEvidenceV1Schema.parse(evidence)).toEqual(evidence);
    expect(evidence.runs).toHaveLength(9);
    expect(new Set(evidence.runs.map((run) => run.freshCopyId)).size).toBe(9);
    expect(
      (await fixture.store.readArmResult("runtime_enabled")).freshRunReferences,
    ).toHaveLength(9);
    expect(
      M7R3ArmEvaluatorEvidenceV1Schema.safeParse({
        ...evidence,
        runs: [evidence.runs[1], evidence.runs[0], ...evidence.runs.slice(2)],
      }).success,
    ).toBe(false);
  });

  it("retains an infrastructure terminal once and never reruns a failed arm", async () => {
    const fixture = await campaignFixture();
    const first = await execute({
      fixture,
      runtime: { candidate: "none" },
      codeOnly: { candidate: "none" },
      throwRuntime: true,
    });
    expect(first.terminal.outcome).toBe("cleanup_failed");
    expect(first.events).toEqual(["run:runtime_enabled"]);
    const delivery = await fixture.evidence.readDeliveryTrace(
      fixture.registration.campaignId,
      "runtime_enabled",
    );
    expect(delivery).toMatchObject({
      availability: "unavailable",
      unavailableReason: "attempt_envelope_unavailable",
      trace: null,
    });
    const trajectory = await fixture.evidence.readTrajectoryUse(
      fixture.registration.campaignId,
    );
    expect(trajectory.rejectionReasons).toContain(
      "runtime_evidence_receipt_missing",
    );
    expect(
      (await fixture.store.readArmResult("runtime_enabled"))
        .runtimeUseReceiptSha256,
    ).toBe(trajectory.recordContentSha256);
    await expect(
      execute({
        fixture,
        runtime: { candidate: "valid" },
        codeOnly: { candidate: "none" },
      }),
    ).rejects.toThrow(/already|exists|terminal|claim/iu);
  });

  it("retains a pre-event failed trace and its cleanup proof without allowing trace substitution", async () => {
    const fixture = await campaignFixture();
    const failure = failedRuntimeEnvelopeBeforeFirstPiEvent({ fixture });
    const substitutedTracker = createM7R3AgentDeliveryTrackerV1();
    substitutedTracker.onEvent({ type: "turn_start" });
    expect(
      M7R3LocalArmRunEnvelopeV1Schema.safeParse({
        ...failure.envelope,
        deliveryTrace: substitutedTracker.snapshot(),
      }).success,
    ).toBe(false);
    expect(
      M7R3LocalArmRunEnvelopeV1Schema.safeParse({
        ...failure.envelope,
        deliveryTrace: null,
      }).success,
    ).toBe(false);

    const events: string[] = [];
    const evaluator = vi.fn();
    const terminal = await runM7R3RuntimeUseLocalCampaignGateForTestingV1({
      campaignId: fixture.registration.campaignId,
      campaignStore: fixture.store,
      caseAdmission: fixture.admission,
      caseContract: fixture.contract,
      armPort: {
        getArmAdmission: async (arm) => localAdmission(fixture, arm),
        runArmOnce: async (request) => {
          events.push(`run:${request.arm}`);
          return request.arm === "runtime_enabled"
            ? failure.envelope
            : attemptEnvelope({
                fixture,
                arm: "code_only",
                options: { candidate: "none" },
              });
        },
      },
      evaluatorPortsForTesting: {
        runtime_enabled: { runFreshCopy: evaluator },
        code_only: { runFreshCopy: evaluator },
      },
      evidenceWriterForTesting: fixture.evidence,
      now: () => "2026-08-16T00:10:00.000Z",
    });

    expect(terminal).toMatchObject({
      outcome: "infrastructure_failure",
      reason: "arm_infrastructure_failed",
    });
    expect(events).toEqual(["run:runtime_enabled", "run:code_only"]);
    expect(evaluator).not.toHaveBeenCalled();
    expect(await fixture.store.readArmResult("runtime_enabled")).toMatchObject({
      observedTurnCount: 0,
      loopOutcome: "infrastructure_failed",
      cleanupProven: true,
      cleanupReceiptSha256: failure.cleanupReceiptSha256,
    });
    expect(
      await fixture.evidence.readAttempt(
        fixture.registration.campaignId,
        "runtime_enabled",
      ),
    ).toMatchObject({
      terminalStage: "pi_turn",
      terminalCode: "operation_threw",
      agentDeliveryTraceRecordSha256: failure.trace.recordContentSha256,
    });
    expect(
      await fixture.evidence.readAttemptFailure(
        fixture.registration.campaignId,
        "runtime_enabled",
      ),
    ).toEqual(failure.failureReceipt);
    expect(
      await fixture.evidence.readDeliveryTrace(
        fixture.registration.campaignId,
        "runtime_enabled",
      ),
    ).toMatchObject({
      availability: "retained",
      trace: {
        recordContentSha256: failure.trace.recordContentSha256,
        observedPiEventCount: 0,
      },
    });
  });
});

describe("M7 R3 Host-only evidence retention", () => {
  it("uses create-once mode-0600 one-link records outside Agent roots", async () => {
    const fixture = await campaignFixture();
    await execute({
      fixture,
      runtime: { candidate: "valid" },
      codeOnly: { candidate: "none" },
    });
    const names = await readdir(fixture.evidence.root);
    expect(names.some((name) => name.endsWith(".runtime-evidence.json"))).toBe(
      true,
    );
    for (const name of names) {
      const metadata = await lstat(join(fixture.evidence.root, name));
      expect(metadata.mode & 0o7777).toBe(0o600);
      expect(metadata.nlink).toBe(1);
    }
    const trajectory = await fixture.evidence.readTrajectoryUse(
      fixture.registration.campaignId,
    );
    await expect(
      fixture.evidence.putTrajectoryUseOnce(trajectory),
    ).rejects.toThrow(/already exists|retry is forbidden/iu);

    const trajectoryName = names.find((name) =>
      name.endsWith(".runtime-trajectory-use.json"),
    );
    expect(trajectoryName).toBeDefined();
    const path = join(fixture.evidence.root, trajectoryName ?? "missing");
    const alias = join(fixture.parent, "trajectory-hardlink-alias.json");
    await link(path, alias);
    await expect(
      fixture.evidence.readTrajectoryUse(fixture.registration.campaignId),
    ).rejects.toThrow(/identity changed/u);
  });
});
