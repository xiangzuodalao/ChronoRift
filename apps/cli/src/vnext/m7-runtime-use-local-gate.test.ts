import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonValueSchema,
  asSha256DigestV1,
  asSourceId,
  type Sha256DigestV1,
  type SourceId,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ExternalHiddenFixFreshCopyRunInputV1,
  ExternalHiddenFixFreshRunReceiptV1,
} from "./external-hidden-fix.js";
import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import {
  M7PairedAgentArmResultV1Schema,
  M7PairedAgentAttemptBindingV1Schema,
  M7RuntimeUseExecutionSummaryV1Schema,
  createM7AgentAttemptEvidenceSidecarV1,
  createM7RuntimeResourceMapV1,
  type M7PairedAgentArmResultV1,
  type M7PairedAgentAttemptBindingV1,
  type M7PairedAgentAttemptRecordV1,
  type M7RuntimeUseExecutionSummaryV1,
} from "./m7-paired-agent.js";
import {
  M7ArmEvaluatorEvidenceV1Schema,
  M7LocalArmAdmissionV1Schema,
  M7RuntimeUseEvidenceReceiptV1Schema,
  M7RuntimeUseLocalEvidenceStoreV1,
  M7RuntimeUseLocalMutationStoreV1,
  runM7RuntimeUseLocalCampaignGateForTestingV1,
  type M7LocalArmAdmissionV1,
  type M7LocalMutationMaterialsV1,
  type M7RuntimeUsePairedArmResultPortV1,
  type M7RuntimeUseEvidenceWriterTestingV1,
} from "./m7-runtime-use-local-gate.js";
import {
  deriveM7BuildSourceIdentitySha256V1,
  openM7RuntimeUseCampaignStoreV1,
  type BeginM7ArmOnceV1Input,
  type CreateM7CampaignSensorBindingV1Input,
  type CreateM7MutationRegistrationV1Input,
  type M7ArmV1,
  type M7CampaignSensorBindingV1,
  type M7MutationRegistrationV1,
  type M7RuntimeUseCampaignStoreV1,
} from "./m7-runtime-use-campaign.js";
import { selectedTreeSha256 } from "./selected-tree.js";

const sha = (value: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const hashJson = (value: unknown): Sha256DigestV1 =>
  sha(canonicalJson(JsonValueSchema.parse(value)));

const MUTANT_SOURCE_ID = asSourceId(`source:${"b".repeat(64)}`);

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

const sensorInput = (): CreateM7CampaignSensorBindingV1Input => ({
  schemaVersion: 1,
  authoritativeSensorFreezeId: `m7-sensor-freeze:${"a".repeat(24)}`,
  authoritativeSensorFreezeRecordSha256: sha("sensor freeze record"),
  subjectProjectSha256: sha("subject project"),
  pristineProjectRevision: "3e793f53598a131c53fb82555191cc14b8db07ff",
  pristineSelectedTreeSha256: sha("pristine tree"),
  pristineAdapterRevisionSha256: sha("pristine adapter revision"),
  adapterPackageSha256: sha("adapter package"),
  adapterObservationSchemaSha256: sha("generic patrol state schema"),
  publicPatrolClassifierSha256: sha("frozen classifier.mjs bytes"),
  pristineConformanceReceiptSha256: sha("pristine conformance"),
  validatedGameToolSetSha256: sha("frozen admitted game tools"),
  boundAt: "2026-08-15T00:00:00.000Z",
});

const registrationInput = (): CreateM7MutationRegistrationV1Input => ({
  mutationSha256: sha("hidden mutation"),
  mutatedBaselineSelectedTreeSha256: sha("mutated baseline"),
  mutatedBuildSourceIdentitySha256: deriveM7BuildSourceIdentitySha256V1({
    sourceId: MUTANT_SOURCE_ID,
    sourceHash: sha("mutated baseline"),
  }),
  adapterMutantCompatibilityReceiptSha256: sha("mutant compatibility"),
  publicTaskSpecSha256: sha("natural user request"),
  evaluatorImplementationSha256: sha("hidden evaluator implementation"),
  evaluatorBundleSha256: sha("hidden 3x3 bundle"),
  provider: "test-provider",
  model: "test-model",
  thinkingLevel: "high",
  agentBudgetSha256: sha("one attempt one turn budget"),
  codingToolSetSha256: sha("identical coding tools"),
  sandboxPolicySha256: sha("identical sandbox"),
  registeredAt: "2026-08-15T00:01:00.000Z",
});

const preflightInput = () => ({
  pristinePassCount: 9,
  mutantPublicAndHiddenPassCount: 0,
  mutantRegressionPassCount: 3,
  genericClassifierMutantWitnessObserved: true,
  pristineAdapterConformancePassed: true,
  mutantBuildCompatibilityPassed: true,
  cleanupProven: true,
  infrastructureFailureCode: null,
  completedAt: "2026-08-15T00:02:00.000Z",
});

interface CampaignFixture {
  readonly parent: string;
  readonly exposed: string;
  readonly evidence: M7RuntimeUseLocalEvidenceStoreV1;
  readonly store: M7RuntimeUseCampaignStoreV1;
  readonly sensor: M7CampaignSensorBindingV1;
  readonly registration: M7MutationRegistrationV1;
  readonly materials: M7LocalMutationMaterialsV1;
}

const campaignFixture = async (): Promise<CampaignFixture> => {
  const parent = await mkdtemp(join(tmpdir(), "chronorift-m7-local-gate-"));
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
  const evidence = await M7RuntimeUseLocalEvidenceStoreV1.open({
    root: evidenceRoot,
    exposedRoots: [exposed],
  });
  const sensor = await store.bindCampaignSensorOnce(sensorInput());
  const registration = await store.registerMutationOnce(registrationInput());
  await store.putPreflightOnce(preflightInput());
  const materialsBasis = {
    schemaVersion: 1 as const,
    recordKind: "m7-local-mutation-materials" as const,
    campaignId: registration.campaignId,
    mutationRegistrationSha256: registration.recordContentSha256,
    evaluatorAssignmentId: `m6-assignment:${sha(
      `m7-local-evaluator\0${registration.campaignId}`,
    ).slice(0, 24)}`,
    baselineRoot: join(parent, "host-baseline"),
    baselineSelectedTreeSha256: registration.mutatedBaselineSelectedTreeSha256,
    evaluatorImplementationPath: join(parent, "hidden-evaluator.mjs"),
    evaluatorImplementationSha256: registration.evaluatorImplementationSha256,
    evaluatorBundlePath: join(parent, "hidden-bundle.json"),
    evaluatorBundleSha256: registration.evaluatorBundleSha256,
    registeredAt: "2026-08-15T00:01:30.000Z",
  };
  const materials: M7LocalMutationMaterialsV1 = {
    ...materialsBasis,
    recordContentSha256: hashJson(materialsBasis),
  };
  return { parent, exposed, evidence, store, sensor, registration, materials };
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
  registration: M7MutationRegistrationV1,
  arm: M7ArmV1,
): BeginM7ArmOnceV1Input => ({
  campaignId: registration.campaignId,
  arm,
  binding: {
    publicTaskSpecSha256: registration.publicTaskSpecSha256,
    provider: registration.provider,
    model: registration.model,
    thinkingLevel: registration.thinkingLevel,
    agentBudgetSha256: registration.agentBudgetSha256,
    workspaceBaselineSelectedTreeSha256:
      registration.mutatedBaselineSelectedTreeSha256,
    codingToolSetSha256: registration.codingToolSetSha256,
    sandboxPolicySha256: registration.sandboxPolicySha256,
  },
  taskId: `task:m7:${arm}`,
  sessionIdentitySha256: sha(`${arm} session`),
  workspaceIdentitySha256: sha(`${arm} workspace`),
  cacheIdentitySha256: sha(`${arm} cache`),
  startedAt:
    arm === "runtime_enabled"
      ? "2026-08-15T00:03:00.000Z"
      : "2026-08-15T00:07:00.000Z",
});

const attemptBinding = (
  registration: M7MutationRegistrationV1,
  arm: M7ArmV1,
  baselineSourceId = MUTANT_SOURCE_ID,
): M7PairedAgentAttemptBindingV1 => {
  const claim = claimInput(registration, arm);
  const runtime = arm === "runtime_enabled";
  const basis = {
    schemaVersion: 1 as const,
    campaignId: registration.campaignId,
    arm,
    attemptOrdinal: 1 as const,
    userTurnsMaximum: 1 as const,
    promptSha256: sha("exact natural prompt bytes"),
    publicTaskSpecSha256: sha(`${arm} bootstrap public task`),
    pairedTaskSpecSha256: registration.publicTaskSpecSha256,
    provider: registration.provider,
    model: registration.model,
    thinkingLevel: registration.thinkingLevel,
    agentBudgetSha256: registration.agentBudgetSha256,
    baselineSelectedTreeSha256: registration.mutatedBaselineSelectedTreeSha256,
    commonEnvironmentInstructionsSha256: sha("common environment appendix"),
    hostModelRuntimeConfigSha256: sha("same host model runtime"),
    codingToolSetSha256: registration.codingToolSetSha256,
    sandboxProfileSha256: registration.sandboxPolicySha256,
    isolation: {
      schemaVersion: 1 as const,
      arm,
      taskId: claim.taskId,
      workspaceHandle: `workspace:m7:${arm}`,
      workspaceInstanceSha256: claim.workspaceIdentitySha256,
      sessionInstanceSha256: claim.sessionIdentitySha256,
      cacheInstanceSha256: claim.cacheIdentitySha256,
      sandboxInstanceSha256: sha(`${arm} sandbox instance`),
      sandboxProfileSha256: registration.sandboxPolicySha256,
      workspaceBaselineSelectedTreeSha256:
        registration.mutatedBaselineSelectedTreeSha256,
      readableSurfaces: readableSurfaces(runtime),
    },
    surfaceEqualityProofSha256: sha("paired equality proof"),
    runtimeSurface: runtime
      ? {
          schemaVersion: 1 as const,
          sensorFreezeRecordSha256: registration.sensorFreezeRecordSha256,
          pristineAdapterRevisionId: "adapter-revision:m7:frozen",
          pristineAdapterPackageSha256: sha("adapter package"),
          admittedGameToolSetSha256: registration.runtimeGameToolSetSha256,
          runtimeResourceMap: createM7RuntimeResourceMapV1({
            schemaVersion: 1,
            taskId: claim.taskId,
            baselineBuildId: "build:m7:mutant",
            baselineSourceId,
            launchTargetId: "launch:m7:default",
          }),
          runtimeResourceAppendixSha256: sha("neutral runtime appendix"),
        }
      : null,
  };
  return M7PairedAgentAttemptBindingV1Schema.parse({
    ...basis,
    bindingContentSha256: hashJson(basis),
  });
};

const admission = (
  registration: M7MutationRegistrationV1,
  arm: M7ArmV1,
): M7LocalArmAdmissionV1 => {
  const binding = attemptBinding(registration, arm);
  return M7LocalArmAdmissionV1Schema.parse({
    schemaVersion: 1,
    arm,
    claim: claimInput(registration, arm),
    pairedAttemptBindingContentSha256: binding.bindingContentSha256,
  });
};

const fallSummary = (input: {
  readonly registration: M7MutationRegistrationV1;
  readonly sensor: M7CampaignSensorBindingV1;
  readonly candidateTree: Sha256DigestV1;
  readonly deliveryOrdinal?: number;
  readonly classifierSha256?: Sha256DigestV1;
}): M7RuntimeUseExecutionSummaryV1 => {
  const classificationOutput = {
    schemaVersion: 1 as const,
    stateDomainId: "patrol.motion" as const,
    classification: "fell_without_reversing" as const,
    declaredSampleCount: 2,
    entityCount: 1,
    fallWitnessCount: 1,
    reversalWitnessCount: 0,
    witnesses: [
      {
        entityId: "enemy-1",
        name: "Enemy",
        outcome: "fell_without_reversing" as const,
        fromFrame: 100,
        toFrame: 101,
        startDirection: 1 as const,
        endDirection: 1 as const,
        startY: 40,
        endY: 85,
      },
    ],
  };
  return M7RuntimeUseExecutionSummaryV1Schema.parse({
    schemaVersion: 1,
    executionId: "execution:m7:mutant-baseline",
    buildId: "build:m7:mutant",
    sourceSha256: input.registration.mutatedBaselineSelectedTreeSha256,
    startedAt: "2026-08-15T00:03:10.000Z",
    // Sealing may occur after the edit. The proof boundary is delivery ordinal 3.
    endedAt: "2026-08-15T00:05:30.000Z",
    sealed: true,
    coverageComplete: true,
    historyLossObserved: false,
    cleanupProven: true,
    runtimeObservationReceiptSha256: sha("full runtime observation record"),
    classifierImplementationSha256:
      input.classifierSha256 ?? input.sensor.publicPatrolClassifierSha256,
    classifierInputSha256: sha("exact Agent-visible exchange classifier input"),
    sealHostToolReturnOrdinal: 7,
    classificationHostToolReturnOrdinal: input.deliveryOrdinal ?? 3,
    classification: "fell_without_reversing",
    classificationOutput,
    classificationOutputSha256: hashJson(classificationOutput),
    firstHostObservedSourceChange: {
      schemaVersion: 1,
      hostToolReturnOrdinal: 5,
      boundary: "coding_tool_return",
      sourceSha256: input.candidateTree,
      buildId: null,
      observedAt: "2026-08-15T00:04:00.000Z",
    },
  });
};

interface AttemptOptions {
  readonly status?: M7PairedAgentArmResultV1["status"];
  readonly candidate?: "valid" | "invalid" | "none";
  readonly summaries?: readonly M7RuntimeUseExecutionSummaryV1[];
  readonly cleanup?: boolean;
  readonly baselineSourceId?: SourceId;
}

const attemptRecord = (input: {
  readonly registration: M7MutationRegistrationV1;
  readonly arm: M7ArmV1;
  readonly options?: AttemptOptions;
}): M7PairedAgentAttemptRecordV1 => {
  const binding = attemptBinding(
    input.registration,
    input.arm,
    input.options?.baselineSourceId,
  );
  const status = input.options?.status ?? "completed";
  const candidateMode = input.options?.candidate ?? "none";
  const patchSha256 = sha(`${input.arm} patch bytes`);
  const candidateTree = sha(`${input.arm} candidate tree`);
  const candidatePatch =
    status === "completed" && candidateMode !== "none"
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
            baselineSelectedTreeSha256:
              input.registration.mutatedBaselineSelectedTreeSha256,
            candidateSelectedTreeSha256: candidateTree,
            patchSha256,
            byteLength: 123,
          },
          admissible: candidateMode === "valid",
          roundTripVerified: candidateMode === "valid",
        }
      : null;
  const summaries =
    input.arm === "runtime_enabled" ? (input.options?.summaries ?? []) : [];
  const executions = summaries.map((summary) => ({
    schemaVersion: 1 as const,
    executionId: summary.executionId,
    buildId: summary.buildId,
    sourceSha256: summary.sourceSha256,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    sealed: summary.sealed,
    coverageComplete: summary.coverageComplete,
    cleanupProven: summary.cleanupProven,
    publicSymptomObserved: true,
    publicObservationSha256: summary.runtimeObservationReceiptSha256,
  }));
  const result = M7PairedAgentArmResultV1Schema.parse({
    schemaVersion: 1,
    arm: input.arm,
    attemptOrdinal: 1,
    userTurnCount: 1,
    status,
    realizedProvider: input.registration.provider,
    realizedModel: input.registration.model,
    realizedThinkingLevel: input.registration.thinkingLevel,
    activeToolNames:
      input.arm === "runtime_enabled" ? ["read", "game.query"] : ["read"],
    attemptBindingContentSha256: binding.bindingContentSha256,
    candidatePatch,
    sourceObservations: [],
    executions,
    runtimeUseSummaries: summaries,
    runtimeEvidenceReceiptSha256:
      input.arm === "runtime_enabled" && summaries.length > 0
        ? sha("paired full runtime evidence")
        : null,
  });
  const cleanup = input.options?.cleanup ?? true;
  const cleanupReceiptSha256 = cleanup ? sha(`${input.arm} cleanup`) : null;
  return {
    schemaVersion: 1,
    arm: input.arm,
    binding,
    result,
    infrastructureFailureCode: null,
    cleanup: {
      schemaVersion: 1,
      arm: input.arm,
      attemptBindingContentSha256: binding.bindingContentSha256,
      proven: cleanup,
      receiptSha256: cleanupReceiptSha256,
    },
    cleanupInfrastructureFailure: false,
    attemptEvidence: createM7AgentAttemptEvidenceSidecarV1({
      campaignId: input.registration.campaignId,
      arm: input.arm,
      attemptBindingContentSha256: binding.bindingContentSha256,
      terminalStage: cleanup ? "sealed" : "cleanup",
      terminalCode: cleanup ? "completed" : "cleanup_not_proven",
      piTurnStarted: true,
      piResultObserved: true,
      piStats: {
        schemaVersion: 1,
        eventsObserved: 1,
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: 3,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 2,
        cost: 0,
      },
      agentVisibleGameToolExchanges: [],
      sourceObservations: [],
      runtimeEvidenceReceiptSha256:
        input.arm === "runtime_enabled" && summaries.length > 0
          ? sha("paired full runtime evidence")
          : null,
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
        cleanupProven: cleanup,
        cleanupReceiptSha256,
        cleanupInfrastructureFailure: false,
      },
    }),
  };
};

const successfulRun = (
  input: ExternalHiddenFixFreshCopyRunInputV1,
  outcome: "passed" | "failed" = "passed",
): ExternalHiddenFixFreshRunReceiptV1 => ({
  schemaVersion: 1,
  assignmentId: input.assignmentId,
  freshCopyId: input.plan.freshCopyId,
  ordinal: input.plan.ordinal,
  scenarioClass: input.plan.scenarioClass,
  repetition: input.plan.repetition,
  baselineSelectedTreeSha256: input.baselineSelectedTreeSha256,
  candidateSelectedTreeSha256: input.expectedCandidateSelectedTreeSha256,
  patchSha256: input.patch.rawSha256,
  freshWorkspaceCreated: true,
  freshImportCacheCreated: true,
  freshProcessStarted: true,
  outcome,
  observationSha256: sha(`${input.plan.freshCopyId}:${outcome}`),
  cleanupProven: true,
});

const armPort = (input: {
  readonly registration: M7MutationRegistrationV1;
  readonly runtime: AttemptOptions;
  readonly codeOnly: AttemptOptions;
  readonly events: string[];
}): M7RuntimeUsePairedArmResultPortV1 => ({
  getArmAdmission: async (arm) => {
    const options = arm === "runtime_enabled" ? input.runtime : input.codeOnly;
    const binding = attemptBinding(
      input.registration,
      arm,
      options.baselineSourceId,
    );
    const value = admission(input.registration, arm);
    return {
      ...value,
      pairedAttemptBindingContentSha256: binding.bindingContentSha256,
    };
  },
  runArmOnce: async (request) => {
    input.events.push(`run:${request.arm}`);
    const options =
      request.arm === "runtime_enabled" ? input.runtime : input.codeOnly;
    const expectedBinding = attemptBinding(
      input.registration,
      request.arm,
      options.baselineSourceId,
    );
    expect(request.pairedAttemptBindingContentSha256).toBe(
      expectedBinding.bindingContentSha256,
    );
    return attemptRecord({
      registration: input.registration,
      arm: request.arm,
      options,
    });
  },
});

const execute = async (input: {
  readonly fixture: CampaignFixture;
  readonly runtime: AttemptOptions;
  readonly codeOnly: AttemptOptions;
  readonly runtimeOutcome?: "passed" | "failed";
  readonly codeOnlyOutcome?: "passed" | "failed";
  readonly evidenceWriter?: M7RuntimeUseEvidenceWriterTestingV1;
}) => {
  const events: string[] = [];
  const runtimeRun = vi.fn(
    async (request: ExternalHiddenFixFreshCopyRunInputV1) =>
      successfulRun(request, input.runtimeOutcome ?? "passed"),
  );
  const codeOnlyRun = vi.fn(
    async (request: ExternalHiddenFixFreshCopyRunInputV1) =>
      successfulRun(request, input.codeOnlyOutcome ?? "passed"),
  );
  const terminal = await runM7RuntimeUseLocalCampaignGateForTestingV1({
    campaignId: input.fixture.registration.campaignId,
    campaignStore: input.fixture.store,
    mutationResolverForTesting: {
      resolve: async () => input.fixture.materials,
    },
    armPort: armPort({
      registration: input.fixture.registration,
      runtime: input.runtime,
      codeOnly: input.codeOnly,
      events,
    }),
    freshCopyRunnersForTesting: {
      runtime_enabled: { runFreshCopy: runtimeRun },
      code_only: { runFreshCopy: codeOnlyRun },
    },
    evidenceWriterForTesting: input.evidenceWriter ?? input.fixture.evidence,
    now: () => "2026-08-15T00:10:00.000Z",
  });
  return { terminal, events, runtimeRun, codeOnlyRun };
};

describe("M7 formal local runtime-use Gate", () => {
  it("supports the paired claim from a pre-edit Agent-visible fall witness without requiring a candidate runtime rerun", async () => {
    const fixture = await campaignFixture();
    const runtimeCandidate = sha("runtime_enabled candidate tree");
    const summary = fallSummary({
      registration: fixture.registration,
      sensor: fixture.sensor,
      candidateTree: runtimeCandidate,
    });
    const result = await execute({
      fixture,
      runtime: { candidate: "valid", summaries: [summary] },
      codeOnly: { candidate: "none" },
    });

    expect(result.terminal.outcome).toBe("claim_supported");
    expect(result.events).toEqual(["run:runtime_enabled", "run:code_only"]);
    expect(result.runtimeRun).toHaveBeenCalledTimes(9);
    expect(result.codeOnlyRun).not.toHaveBeenCalled();

    const runtimeEvidence = await fixture.evidence.readRuntimeUse(
      fixture.registration.campaignId,
    );
    expect(M7RuntimeUseEvidenceReceiptV1Schema.parse(runtimeEvidence)).toEqual(
      runtimeEvidence,
    );
    expect(runtimeEvidence.outcome).toBe("verified");
    expect(runtimeEvidence.classifierImplementationSha256).toBe(
      fixture.sensor.publicPatrolClassifierSha256,
    );
    const runtimeAttempt = await fixture.evidence.readAgentAttempt(
      fixture.registration.campaignId,
      "runtime_enabled",
    );
    expect(runtimeAttempt).toMatchObject({
      campaignId: fixture.registration.campaignId,
      arm: "runtime_enabled",
      terminalStage: "sealed",
      terminalCode: "completed",
      cleanup: { cleanupProven: true },
    });
    await expect(
      fixture.evidence.putAgentAttemptOnce(runtimeAttempt),
    ).rejects.toThrow(/already exists|overwrite/iu);
    expect(runtimeEvidence.authoritativeSensorFreezeRecordSha256).toBe(
      fixture.sensor.authoritativeSensorFreezeRecordSha256,
    );
    expect(runtimeEvidence.firstHostObservedSourceChangeOrdinal).toBe(5);
    expect(runtimeEvidence.baselineSummary?.endedAt).toBe(
      "2026-08-15T00:05:30.000Z",
    );
    expect(runtimeEvidence.candidateSummary).toBeNull();
    expect(runtimeEvidence.candidateRecoveryWitnessCount).toBe(0);

    const evaluatorEvidence = await fixture.evidence.readEvaluator(
      fixture.registration.campaignId,
      "runtime_enabled",
    );
    expect(M7ArmEvaluatorEvidenceV1Schema.parse(evaluatorEvidence)).toEqual(
      evaluatorEvidence,
    );
    expect(evaluatorEvidence.runs).toHaveLength(9);
    expect(
      new Set(evaluatorEvidence.runs.map((run) => run.freshCopyId)).size,
    ).toBe(9);
    const armResult = await fixture.store.readArmResult("runtime_enabled");
    expect(armResult.runtimeUseReceiptSha256).toBe(
      runtimeEvidence.recordContentSha256,
    );
    expect(armResult.evaluatorReceiptSha256).toBe(
      evaluatorEvidence.recordContentSha256,
    );
  });

  it("rejects a fall classifier delivered at the first changed-source boundary", async () => {
    const fixture = await campaignFixture();
    const summary = fallSummary({
      registration: fixture.registration,
      sensor: fixture.sensor,
      candidateTree: sha("runtime_enabled candidate tree"),
      deliveryOrdinal: 5,
    });
    const result = await execute({
      fixture,
      runtime: { candidate: "valid", summaries: [summary] },
      codeOnly: { candidate: "none" },
    });

    expect(result.terminal.outcome).toBe("claim_not_supported");
    expect(result.terminal.reason).toBe("runtime_use_not_verified");
    expect(
      (await fixture.evidence.readRuntimeUse(fixture.registration.campaignId))
        .rejectionReasons,
    ).toContain("baseline_not_before_source_change");
  });

  it("rejects a self-reported classifier implementation detached from the frozen sensor binding", async () => {
    const fixture = await campaignFixture();
    const summary = fallSummary({
      registration: fixture.registration,
      sensor: fixture.sensor,
      candidateTree: sha("runtime_enabled candidate tree"),
      classifierSha256: sha("different classifier bytes"),
    });
    const result = await execute({
      fixture,
      runtime: { candidate: "valid", summaries: [summary] },
      codeOnly: { candidate: "none" },
    });

    expect(result.terminal.outcome).toBe("claim_not_supported");
    expect(
      (await fixture.evidence.readRuntimeUse(fixture.registration.campaignId))
        .rejectionReasons,
    ).toContain("classifier_identity_mismatch");
  });

  it("rejects a fall witness attributed to a Build other than the frozen mutant baseline Build", async () => {
    const fixture = await campaignFixture();
    const summary = M7RuntimeUseExecutionSummaryV1Schema.parse({
      ...fallSummary({
        registration: fixture.registration,
        sensor: fixture.sensor,
        candidateTree: sha("runtime_enabled candidate tree"),
      }),
      buildId: "build:m7:not-the-mutant-baseline",
    });
    const result = await execute({
      fixture,
      runtime: { candidate: "valid", summaries: [summary] },
      codeOnly: { candidate: "none" },
    });

    expect(result.terminal.outcome).toBe("claim_not_supported");
    expect(
      (await fixture.evidence.readRuntimeUse(fixture.registration.campaignId))
        .rejectionReasons,
    ).toContain("baseline_build_mismatch");
  });

  it("rejects a runtime arm whose baseline source identity is not the registered mutant Build", async () => {
    const fixture = await campaignFixture();
    const summary = fallSummary({
      registration: fixture.registration,
      sensor: fixture.sensor,
      candidateTree: sha("runtime_enabled candidate tree"),
    });
    const result = await execute({
      fixture,
      runtime: {
        candidate: "valid",
        summaries: [summary],
        baselineSourceId: asSourceId("source:m7:not-the-registered-mutant"),
      },
      codeOnly: { candidate: "none" },
    });

    expect(result.terminal.outcome).toBe("cleanup_failed");
    expect(result.terminal.primaryOutcome).toBe("infrastructure_failure");
    expect(result.events).toEqual(["run:runtime_enabled"]);
    expect(result.runtimeRun).not.toHaveBeenCalled();
    expect(result.codeOnlyRun).not.toHaveBeenCalled();
  });

  it("retains a terminal infrastructure result when public evidence persistence fails after the arm claim", async () => {
    const fixture = await campaignFixture();
    const summary = fallSummary({
      registration: fixture.registration,
      sensor: fixture.sensor,
      candidateTree: sha("runtime_enabled candidate tree"),
    });
    const result = await execute({
      fixture,
      runtime: { candidate: "valid", summaries: [summary] },
      codeOnly: { candidate: "none" },
      evidenceWriter: {
        putAgentAttemptOnce: (receipt) =>
          fixture.evidence.putAgentAttemptOnce(receipt),
        putRuntimeUseOnce: () =>
          Promise.reject(
            new Error("simulated create-once persistence failure"),
          ),
        putEvaluatorOnce: (receipt) =>
          fixture.evidence.putEvaluatorOnce(receipt),
      },
    });

    expect(result.terminal.outcome).toBe("cleanup_failed");
    expect(result.terminal.primaryOutcome).toBe("infrastructure_failure");
    expect(result.events).toEqual(["run:runtime_enabled"]);
    expect(result.runtimeRun).not.toHaveBeenCalled();
    expect(result.codeOnlyRun).not.toHaveBeenCalled();
    await expect(
      fixture.store.readArmResult("runtime_enabled"),
    ).resolves.toMatchObject({
      loopOutcome: "infrastructure_failed",
      cleanupProven: false,
    });
  });

  it("does not support the claim when code-only independently produces an accepted candidate", async () => {
    const fixture = await campaignFixture();
    const summary = fallSummary({
      registration: fixture.registration,
      sensor: fixture.sensor,
      candidateTree: sha("runtime_enabled candidate tree"),
    });
    const result = await execute({
      fixture,
      runtime: { candidate: "valid", summaries: [summary] },
      codeOnly: { candidate: "valid" },
    });

    expect(result.terminal.outcome).toBe("claim_not_supported");
    expect(result.terminal.reason).toBe("code_only_candidate_accepted");
    expect(result.runtimeRun).toHaveBeenCalledTimes(9);
    expect(result.codeOnlyRun).toHaveBeenCalledTimes(9);
    expect(
      (
        await fixture.evidence.readEvaluator(
          fixture.registration.campaignId,
          "code_only",
        )
      ).runs,
    ).toHaveLength(9);
  });

  it.each(["provider_failure", "timed_out", "aborted"] as const)(
    "classifies a code-only %s as inconclusive, never supported",
    async (status) => {
      const fixture = await campaignFixture();
      const summary = fallSummary({
        registration: fixture.registration,
        sensor: fixture.sensor,
        candidateTree: sha("runtime_enabled candidate tree"),
      });
      const result = await execute({
        fixture,
        runtime: { candidate: "valid", summaries: [summary] },
        codeOnly: { status },
      });

      expect(result.terminal.outcome).toBe("comparison_inconclusive");
      expect(result.codeOnlyRun).not.toHaveBeenCalled();
    },
  );

  it("stops before code-only after runtime cleanup failure and durably retains the prior primary outcome", async () => {
    const fixture = await campaignFixture();
    const summary = fallSummary({
      registration: fixture.registration,
      sensor: fixture.sensor,
      candidateTree: sha("runtime_enabled candidate tree"),
    });
    const result = await execute({
      fixture,
      runtime: { candidate: "valid", summaries: [summary], cleanup: false },
      codeOnly: { candidate: "none" },
    });

    expect(result.events).toEqual(["run:runtime_enabled"]);
    expect(result.terminal.outcome).toBe("cleanup_failed");
    expect(result.terminal.primaryOutcome).toBe("infrastructure_failure");
    expect(result.terminal.primaryReason).toBe(
      "evaluator_infrastructure_failed",
    );
    const reopened = await fixture.store.readTerminal();
    expect(reopened.primaryOutcome).toBe(result.terminal.primaryOutcome);
    expect(reopened.primaryReason).toBe(result.terminal.primaryReason);
  });

  it("retains rejected 3x3 run DTOs create-once and rejects a hardlink alias", async () => {
    const fixture = await campaignFixture();
    const summary = fallSummary({
      registration: fixture.registration,
      sensor: fixture.sensor,
      candidateTree: sha("runtime_enabled candidate tree"),
    });
    const result = await execute({
      fixture,
      runtime: { candidate: "valid", summaries: [summary] },
      codeOnly: { candidate: "none" },
      runtimeOutcome: "failed",
    });
    expect(result.terminal.outcome).toBe("claim_not_supported");
    const evidence = await fixture.evidence.readEvaluator(
      fixture.registration.campaignId,
      "runtime_enabled",
    );
    expect(evidence.outcome).toBe("rejected");
    expect(evidence.runs).toHaveLength(9);
    await expect(fixture.evidence.putEvaluatorOnce(evidence)).rejects.toThrow(
      /overwrite is forbidden/u,
    );

    const runtimeRecord = (await readdir(fixture.evidence.root)).find((name) =>
      name.endsWith(".runtime-use.json"),
    );
    expect(runtimeRecord).toBeDefined();
    const recordPath = join(fixture.evidence.root, runtimeRecord ?? "missing");
    const alias = join(fixture.parent, "runtime-evidence-hardlink-alias.json");
    await link(recordPath, alias);
    expect((await lstat(recordPath)).nlink).toBe(2);
    await expect(
      fixture.evidence.readRuntimeUse(fixture.registration.campaignId),
    ).rejects.toThrow(/identity changed/u);
  });
});

describe("M7 Host-only local mutation materials", () => {
  it("resolves only the frozen baseline/oracle bytes and detects hardlink aliases", async () => {
    const parent = await mkdtemp(join(tmpdir(), "chronorift-m7-materials-"));
    roots.add(parent);
    const campaignRoot = join(parent, "campaign");
    const materialRoot = join(parent, "materials");
    const exposed = join(parent, "agent");
    const baseline = join(materialRoot, "mutated-baseline");
    await Promise.all(
      [campaignRoot, materialRoot, exposed, baseline].map(async (root) => {
        await mkdir(root, { recursive: true, mode: 0o700 });
        await chmod(root, 0o700);
      }),
    );
    const projectFile = join(baseline, "project.godot");
    const evaluatorImplementation = join(materialRoot, "evaluator.mjs");
    const evaluatorBundle = join(materialRoot, "bundle.json");
    const implementationBytes = "export default () => true;\n";
    const bundleBytes = '{"schemaVersion":1}\n';
    await Promise.all([
      writeFile(projectFile, "[application]\n", { mode: 0o600 }),
      writeFile(evaluatorImplementation, implementationBytes, { mode: 0o600 }),
      writeFile(evaluatorBundle, bundleBytes, { mode: 0o600 }),
    ]);
    await Promise.all([
      chmod(projectFile, 0o600),
      chmod(evaluatorImplementation, 0o600),
      chmod(evaluatorBundle, 0o600),
    ]);
    const baselineSha = selectedTreeSha256(
      await collectCandidateGodotSourceV1(
        baseline,
        "project-environment",
        "tracked-tool-scripts-v1",
      ),
    );
    const campaignStore = await openM7RuntimeUseCampaignStoreV1({
      root: campaignRoot,
      exposedRoots: [exposed],
    });
    await campaignStore.bindCampaignSensorOnce(sensorInput());
    const registration = await campaignStore.registerMutationOnce({
      ...registrationInput(),
      mutatedBaselineSelectedTreeSha256: baselineSha,
      mutatedBuildSourceIdentitySha256: deriveM7BuildSourceIdentitySha256V1({
        sourceId: asSourceId(`source:${baselineSha}`),
        sourceHash: baselineSha,
      }),
      evaluatorImplementationSha256: sha(implementationBytes),
      evaluatorBundleSha256: sha(bundleBytes),
    });
    const materialStore = await M7RuntimeUseLocalMutationStoreV1.open({
      root: materialRoot,
      exposedRoots: [exposed],
    });
    const record = await materialStore.registerOnce({
      registration,
      baselineRoot: baseline,
      evaluatorImplementationPath: evaluatorImplementation,
      evaluatorBundlePath: evaluatorBundle,
      registeredAt: "2026-08-15T00:01:30.000Z",
    });
    expect(record.baselineSelectedTreeSha256).toBe(baselineSha);
    expect(
      await materialStore.resolve(registration.campaignId, registration),
    ).toEqual(record);
    await expect(
      materialStore.registerOnce({
        registration,
        baselineRoot: baseline,
        evaluatorImplementationPath: evaluatorImplementation,
        evaluatorBundlePath: evaluatorBundle,
        registeredAt: "2026-08-15T00:01:30.000Z",
      }),
    ).rejects.toThrow(/already exist/u);

    await link(
      evaluatorImplementation,
      join(parent, "evaluator-hardlink-alias.mjs"),
    );
    await expect(
      materialStore.resolve(registration.campaignId, registration),
    ).rejects.toThrow(/frozen private file/u);
  });
});
