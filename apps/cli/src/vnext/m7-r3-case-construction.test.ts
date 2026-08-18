import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  M6AdapterBuildCompatibilityReceiptV1Schema,
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectAdapterRevisionV1Schema,
  VNextBuildV1Schema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it } from "vitest";

import {
  M7HiddenMutationRegistrationV1Schema,
  M7_PATROL_SCENARIO_PLAN_V1,
  createM7PatrolPreflightResultV1,
  createM7SensorFreezeRecordV1,
  type M7PatrolEntityStateV1,
  type M7PatrolStateTimelineV1,
} from "./m7-patrol-sensor.js";
import {
  M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
  createM7R3PatrolTrajectoryCaseSpecV1,
} from "./m7-patrol-trajectory.js";
import {
  M7R3CaseConstructionReceiptV1Schema,
  M7R3CasePreflightReceiptV1Schema,
  createM7R3CaseConstructionReceiptV1,
  createM7R3CasePreflightReceiptV1,
  createM7R3MutationRegistrationV1,
  createM7R3TrajectoryClassifierFreezeV1,
  openM7R3CaseConstructionStoreV1,
  projectM7R3ClassifierFreezeToPortfolioV1,
  projectM7R3ConstructionToPortfolioCaseV1,
  type CreateM7R3CaseConstructionReceiptV1Input,
  type CreateM7R3CasePreflightReceiptV1Input,
  type M7R3CaseConstructionReceiptV1,
  type M7R3EvaluatorFreshRunInputV1,
  type M7R3TrajectoryClassifierFreezeV1,
} from "./m7-r3-case-construction.js";
import {
  createM7R3TwoCasePortfolioFreezeV1,
  type M7R3TwoCasePortfolioFreezeV1,
} from "./m7-r3-two-case-portfolio.js";

const sha = (value: string): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const digestJson = (value: unknown): Sha256DigestV1 =>
  sha(canonicalJson(value as never));

const sensorMaterials = {
  adapterPackageBytes: "generic patrol adapter package v1\n",
  observationSchemaBytes:
    "entity_id name start_direction direction fall_off_edge speed position_x position_y velocity_x velocity_y grounded\n",
  classifierImplementationBytes:
    "classify generic patrol sequences from public motion state\n",
  pristineConformanceReceiptBytes: "pristine conformance receipt v1\n",
} as const;

const sensorFreeze = () =>
  createM7SensorFreezeRecordV1({
    schemaVersion: 1,
    pristineSubject: {
      repository: "https://github.com/endlessm/moddable-platformer.git",
      revision: "3e793f53598a131c53fb82555191cc14b8db07ff",
      sourceId: "source:moddable-platformer:pristine",
      subjectProjectSha256: sha("subject-project"),
      selectedTreeSha256: sha("pristine-tree"),
    },
    adapterRevisionId: "adapter-revision:generic-patrol:v1",
    pristineConformanceReceiptId: "adapter-conformance:generic-patrol:v1",
    materials: sensorMaterials,
    frozenAt: "2026-08-15T00:00:00.000Z",
  });

const capabilitySet = {
  schemaVersion: 1 as const,
  modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => ({
    schemaVersion: 1 as const,
    module,
    status: "implemented" as const,
    protocolVersion: "project-environment-v1",
    limitations: [],
  })),
};

const adapterRevision = () =>
  ProjectAdapterRevisionV1Schema.parse({
    schemaVersion: 1,
    adapterRevisionId: "adapter-revision:generic-patrol:v1",
    adapterId: "adapter:generic-patrol",
    sourceId: "source:moddable-platformer:pristine",
    packageDigest: sha("canonical adapter package identity"),
    manifestDigest: sha("adapter-manifest"),
    implementationDigest: sha("adapter-implementation"),
    payloadSchemaDigest: sha("canonical adapter payload schema identity"),
    sdkDigest: sha("adapter-sdk"),
    bridgeDigest: sha("adapter-bridge"),
    capabilitySet,
    conformanceReceiptId: "adapter-conformance:generic-patrol:v1",
    contentByteLength: 1_000,
    contentFileCount: 4,
  });

const classifierFreeze = (): M7R3TrajectoryClassifierFreezeV1 =>
  createM7R3TrajectoryClassifierFreezeV1({
    authoritativeSensorFreeze: sensorFreeze(),
    authoritativeAdapterRevision: adapterRevision(),
    classifierImplementationBytes:
      "classify patrol.motion trajectories: contact loss, speed bands, stalls, direction recovery, sustained grounded motion\n",
    frozenAt: "2026-08-15T00:00:30.000Z",
  });

const mutationRegistration = (ordinal: 1 | 2, freeze = sensorFreeze()) => {
  const sourceHash = sha(`mutant-tree-${ordinal}`);
  const basis = {
    schemaVersion: 1 as const,
    sensorFreezeId: freeze.sensorFreezeId,
    mutationSha256: sha(`opaque-mutation-${ordinal}`),
    mutationByteLength: 100 + ordinal,
    mutatedSourceId: `source:${sourceHash}`,
    mutatedSelectedTreeSha256: sourceHash,
    registeredAt: `2026-08-15T00:0${ordinal}:00.000Z`,
  };
  const recordSha256 = digestJson(basis);
  return M7HiddenMutationRegistrationV1Schema.parse({
    ...basis,
    mutationRegistrationId: `m7-mutation:${recordSha256.slice(0, 24)}`,
    recordSha256,
  });
};

const buildFor = (ordinal: 1 | 2, mutation = mutationRegistration(ordinal)) =>
  VNextBuildV1Schema.parse({
    schemaVersion: 1,
    taskId: `task:r3-construction-${ordinal}`,
    workspaceId: `workspace:r3-construction-${ordinal}`,
    sourceId: mutation.mutatedSourceId,
    buildId: `build:r3-mutant-${ordinal}`,
    sourceHash: mutation.mutatedSelectedTreeSha256,
    workspaceDiffHash: sha(`workspace-diff-${ordinal}`),
    buildConfigurationHash: sha(`build-config-${ordinal}`),
    outputHash: sha(`build-output-${ordinal}`),
    createdAt: `2026-08-15T00:1${ordinal}:00.000Z`,
  });

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

const completeTaskCleanup = {
  processGroupTerminated: true,
  cgroupPopulated: false,
  termSent: false,
  killSent: false,
  scopeRemoved: true,
  storageReconciled: true,
};

const compatibilityReceipt = (ordinal: 1 | 2, build = buildFor(ordinal)) =>
  M6AdapterBuildCompatibilityReceiptV1Schema.parse({
    schemaVersion: 1,
    receiptId: `m6-adapter-build-compatibility:r3:${ordinal}`,
    lineage: {
      schemaVersion: 1,
      buildRole: "assignment_baseline",
      baselineSourceHash: build.sourceHash,
      adapterRevision: {
        schemaVersion: 1,
        adapterRevisionId: adapterRevision().adapterRevisionId,
        adapterId: adapterRevision().adapterId,
        sourceId: adapterRevision().sourceId,
        packageDigest: adapterRevision().packageDigest,
        manifestDigest: adapterRevision().manifestDigest,
        implementationDigest: adapterRevision().implementationDigest,
        payloadSchemaDigest: adapterRevision().payloadSchemaDigest,
        sdkDigest: adapterRevision().sdkDigest,
        bridgeDigest: adapterRevision().bridgeDigest,
        conformanceReceiptId: adapterRevision().conformanceReceiptId,
      },
      build,
      toolchain: {
        schemaVersion: 1,
        toolchainReceiptId: "toolchain:r3-preflight",
        artifactDigest: sha("toolchain-artifact"),
      },
    },
    bridgeHandshakeObserved: true,
    instrumentedLaunchObserved: true,
    queryObservations: {
      schemaVersion: 1,
      entityQueryObserved: true,
      stateQueryObserved: true,
      entityRows: 1,
      stateRows: 4,
    },
    coverage: [
      {
        schemaVersion: 1,
        channelId: "project_adapter_observations",
        status: "complete",
        observedRecords: 4,
        droppedRecords: 0,
        overwrittenRecords: 0,
        limitations: [],
      },
    ],
    loss: [],
    cleanup: completeCleanup,
    outcome: "compatible",
    failures: [],
    observedAt: `2026-08-15T00:2${ordinal}:00.000Z`,
  });

const constructionInput = (
  ordinal: 1 | 2,
  freeze = classifierFreeze(),
): CreateM7R3CaseConstructionReceiptV1Input => {
  const oldSensor = sensorFreeze();
  const mutation = mutationRegistration(ordinal, oldSensor);
  const build = buildFor(ordinal, mutation);
  return {
    ordinal,
    trajectoryClassifierFreeze: freeze,
    mutationRegistration: mutation,
    mutatedBuild: build,
    naturalPrompt:
      ordinal === 1
        ? "敌人会掉下平台，请修复。"
        : "巡逻敌人走到平台边缘后会跌落，请修好。",
    trajectoryCaseSpec: createM7R3PatrolTrajectoryCaseSpecV1({
      classifierImplementationSha256: freeze.classifierImplementationSha256,
      expectedBaselineWitnessKinds: ["ground_contact_loss"],
      expectedRecoveryWitnessKinds: ["direction_recovery"],
      frozenAt: `2026-08-15T00:3${ordinal}:00.000Z`,
    }),
    adapterMutantCompatibilityReceipt: compatibilityReceipt(ordinal, build),
    pairedPublicTaskContractBytes: `paired public task contract ${ordinal}\n`,
    preflightImplementationBytes: `preflight implementation ${ordinal}\n`,
    evaluatorImplementationBytes: `hidden evaluator implementation ${ordinal}\n`,
    evaluatorBundleBytes: `hidden evaluator bundle ${ordinal}\n`,
    cleanup: {
      proven: true,
      receiptSha256: sha(`construction-cleanup-${ordinal}`),
    },
    constructedAt: `2026-08-15T00:4${ordinal}:00.000Z`,
  };
};

const constructions = () => {
  const freeze = classifierFreeze();
  return {
    freeze,
    one: createM7R3CaseConstructionReceiptV1(constructionInput(1, freeze)),
    two: createM7R3CaseConstructionReceiptV1(constructionInput(2, freeze)),
  };
};

const portfolioFor = (
  freeze: M7R3TrajectoryClassifierFreezeV1,
  one: M7R3CaseConstructionReceiptV1,
  two: M7R3CaseConstructionReceiptV1,
): M7R3TwoCasePortfolioFreezeV1 =>
  createM7R3TwoCasePortfolioFreezeV1({
    commonRuntimeMaterials: {
      ...projectM7R3ClassifierFreezeToPortfolioV1(freeze),
      validatedGameToolSetSha256: sha("validated-game-tools"),
      commonEnvironmentInstructionsSha256: sha("common-environment"),
      hostModelRuntimeConfigSha256: sha("model-runtime-config"),
    },
    agentConfiguration: {
      provider: "test-provider",
      model: "test-model",
      thinkingLevel: "max",
      agentBudgetSha256: sha("agent-budget"),
      codingToolSetSha256: sha("coding-tools"),
      sandboxPolicySha256: sha("sandbox-policy"),
    },
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
      projectM7R3ConstructionToPortfolioCaseV1(one),
      projectM7R3ConstructionToPortfolioCaseV1(two),
    ],
    frozenAt: "2026-08-15T01:00:00.000Z",
  });

const state = (
  input: Partial<M7PatrolEntityStateV1> = {},
): M7PatrolEntityStateV1 => ({
  entity_id: "enemy:generic:1",
  name: "GenericPatrolEnemy",
  start_direction: 0,
  direction: -1,
  fall_off_edge: false,
  speed: 120,
  position_x: 0,
  position_y: 100,
  velocity_x: -120,
  velocity_y: 0,
  grounded: true,
  ...input,
});

const recoveryTimeline = (executionId: string): M7PatrolStateTimelineV1 => ({
  schemaVersion: 1,
  execution_id: executionId,
  frames: [
    { sample_ordinal: 1, entities: [state()] },
    {
      sample_ordinal: 2,
      entities: [state({ direction: 1, velocity_x: 120, position_x: 4 })],
    },
    {
      sample_ordinal: 3,
      entities: [state({ direction: 1, velocity_x: 120, position_x: 16 })],
    },
  ],
});

const baselineTimeline = (executionId: string): M7PatrolStateTimelineV1 => ({
  schemaVersion: 1,
  execution_id: executionId,
  frames: [
    { sample_ordinal: 1, entities: [state()] },
    {
      sample_ordinal: 2,
      entities: [state({ grounded: false, position_y: 108, velocity_y: 60 })],
    },
    {
      sample_ordinal: 3,
      entities: [state({ grounded: false, position_y: 120, velocity_y: 100 })],
    },
  ],
});

const hiddenMatrix = (
  construction: M7R3CaseConstructionReceiptV1,
  mutateFirstPublic = false,
) =>
  createM7PatrolPreflightResultV1({
    sensorFreezeId: construction.mutation.sensorFreezeId,
    mutationRegistrationId: construction.mutation.mutationRegistrationId,
    runs: (["pristine", "mutant"] as const).flatMap((subject) =>
      M7_PATROL_SCENARIO_PLAN_V1.map((scenario, index) => ({
        schemaVersion: 1 as const,
        subject,
        scenarioId: scenario.scenarioId,
        observation:
          subject === "pristine" ||
          scenario.scenarioClass === "regression_control" ||
          (mutateFirstPublic && subject === "mutant" && index === 0)
            ? ("expected_motion_observed" as const)
            : ("expected_motion_not_observed" as const),
        freshWorkspaceCreated: true,
        freshImportCacheCreated: true,
        freshProcessStarted: true,
        agentLaunchCount: 0 as const,
        observationSha256: sha(`${subject}:${scenario.scenarioId}`),
        cleanupProven: true,
      })),
    ),
    completedAt: "2026-08-15T01:20:00.000Z",
  });

const freshRuns = (): readonly M7R3EvaluatorFreshRunInputV1[] =>
  (["pristine", "mutant"] as const).flatMap((subject) =>
    M7_PATROL_SCENARIO_PLAN_V1.map((scenario) => {
      const key = `${subject}:${scenario.scenarioId}`;
      return {
        subject,
        scenarioId: scenario.scenarioId,
        workspaceIdentitySha256: sha(`workspace:${key}`),
        importCacheIdentitySha256: sha(`import:${key}`),
        processIdentitySha256: sha(`process:${key}`),
        workspaceCreationReceiptSha256: sha(`workspace-receipt:${key}`),
        importCacheCreationReceiptSha256: sha(`import-receipt:${key}`),
        processStartReceiptSha256: sha(`process-receipt:${key}`),
        cleanupReceiptSha256: sha(`cleanup-receipt:${key}`),
      };
    }),
  );

const pristineBuild = (construction: M7R3CaseConstructionReceiptV1) => {
  const sourceHash = construction.pristineSubject.selectedTreeSha256;
  return VNextBuildV1Schema.parse({
    schemaVersion: 1,
    taskId: "task:r3-pristine-preflight",
    workspaceId: "workspace:r3-pristine-preflight",
    sourceId: `source:${sourceHash}`,
    buildId: "build:r3-pristine-preflight",
    sourceHash,
    workspaceDiffHash: sha("pristine-diff"),
    buildConfigurationHash: sha("pristine-config"),
    outputHash: sha("pristine-output"),
    createdAt: "2026-08-15T01:01:00.000Z",
  });
};

const preflightInput = (
  portfolio: M7R3TwoCasePortfolioFreezeV1,
  construction: M7R3CaseConstructionReceiptV1,
  freeze: M7R3TrajectoryClassifierFreezeV1,
  failedMatrix = false,
): CreateM7R3CasePreflightReceiptV1Input => ({
  portfolioFreeze: portfolio,
  constructionReceipt: construction,
  trajectoryClassifierFreeze: freeze,
  pristineObservation: {
    subject: "pristine",
    trajectoryClassifierFreeze: freeze,
    build: pristineBuild(construction),
    selectedTreeSha256: construction.pristineSubject.selectedTreeSha256,
    runtimeId: "runtime:r3-pristine-preflight",
    executionId: "execution:r3-pristine-preflight",
    configuredMainScene: "res://scenes/main.tscn",
    mainSceneLaunchObserved: true,
    adapterRevisionRecordSha256:
      freeze.authoritativeAdapter.adapterRevisionRecordSha256,
    adapterPackageIdentitySha256: sha("pristine-adapter-package-identity"),
    runtimeObservationReceiptSha256: sha("pristine-runtime-observation"),
    taskCleanup: {
      proven: true,
      receipt: completeTaskCleanup,
      receiptSha256: digestJson(completeTaskCleanup),
    },
    sandboxSecurityEvents: {
      count: 0,
      receiptSha256: digestJson([]),
    },
    captureRecordSealSha256: sha("pristine-capture-record-seal"),
    timeline: recoveryTimeline("execution:r3-pristine-preflight"),
    coverageComplete: true,
    coverageReceiptSha256: sha("pristine-coverage"),
    loss: {
      droppedRecordCount: 0,
      overwrittenRecordCount: 0,
      unavailableHistoryObserved: false,
      receiptSha256: sha("pristine-loss"),
    },
    cleanup: {
      proven: true,
      receiptSha256: sha("pristine-cleanup"),
    },
    observedAt: "2026-08-15T01:10:00.000Z",
  },
  mutantObservation: {
    subject: "mutant",
    trajectoryClassifierFreeze: freeze,
    build: VNextBuildV1Schema.parse({
      schemaVersion: 1,
      taskId: "task:r3-mutant-preflight",
      workspaceId: "workspace:r3-mutant-preflight",
      sourceId: construction.mutatedBuild.sourceId,
      buildId: construction.mutatedBuild.buildId,
      sourceHash: construction.mutatedBuild.sourceSha256,
      workspaceDiffHash: sha("mutant-preflight-diff"),
      buildConfigurationHash: sha("mutant-preflight-config"),
      outputHash: sha("mutant-preflight-output"),
      createdAt: "2026-08-15T01:02:00.000Z",
    }),
    selectedTreeSha256: construction.mutatedBuild.selectedTreeSha256,
    runtimeId: "runtime:r3-mutant-preflight",
    executionId: "execution:r3-mutant-preflight",
    configuredMainScene: "res://scenes/main.tscn",
    mainSceneLaunchObserved: true,
    adapterRevisionRecordSha256:
      freeze.authoritativeAdapter.adapterRevisionRecordSha256,
    adapterPackageIdentitySha256: sha("mutant-adapter-package-identity"),
    runtimeObservationReceiptSha256: sha("mutant-runtime-observation"),
    taskCleanup: {
      proven: true,
      receipt: completeTaskCleanup,
      receiptSha256: digestJson(completeTaskCleanup),
    },
    sandboxSecurityEvents: {
      count: 0,
      receiptSha256: digestJson([]),
    },
    captureRecordSealSha256: sha("mutant-capture-record-seal"),
    timeline: baselineTimeline("execution:r3-mutant-preflight"),
    coverageComplete: true,
    coverageReceiptSha256: sha("mutant-coverage"),
    loss: {
      droppedRecordCount: 0,
      overwrittenRecordCount: 0,
      unavailableHistoryObserved: false,
      receiptSha256: sha("mutant-loss"),
    },
    cleanup: {
      proven: true,
      receiptSha256: sha("mutant-cleanup"),
    },
    observedAt: "2026-08-15T01:11:00.000Z",
  },
  hiddenEvaluatorMatrix: hiddenMatrix(construction, failedMatrix),
  evaluatorFreshRuns: freshRuns(),
  completedAt: "2026-08-15T01:30:00.000Z",
});

const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

describe("M7 R3 case construction and preflight", () => {
  it("registers a generic source patch only after the classifier freeze", () => {
    const freeze = classifierFreeze();
    const sourceHash = sha("r3-generic-mutant-tree");
    const build = VNextBuildV1Schema.parse({
      schemaVersion: 1,
      taskId: "task:r3-generic-mutation",
      workspaceId: "workspace:r3-generic-mutation",
      sourceId: `source:${sourceHash}`,
      buildId: "build:r3-generic-mutation",
      sourceHash,
      workspaceDiffHash: sha("r3-generic-mutation-diff"),
      buildConfigurationHash: sha("r3-generic-mutation-config"),
      outputHash: sha("r3-generic-mutation-output"),
      createdAt: "2026-08-15T00:01:00.000Z",
    });
    const patch = [
      "diff --git a/components/enemy/enemy.tscn b/components/enemy/enemy.tscn",
      "index 1111111..2222222 100644",
      "--- a/components/enemy/enemy.tscn",
      "+++ b/components/enemy/enemy.tscn",
      "@@ -1 +1 @@",
      "-old generic value",
      "+new generic value",
      "",
    ].join("\n");
    const registration = createM7R3MutationRegistrationV1({
      trajectoryClassifierFreeze: freeze,
      mutationBytes: patch,
      mutatedBuild: build,
      registeredAt: "2026-08-15T00:01:30.000Z",
    });

    expect(registration).toMatchObject({
      sensorFreezeId: freeze.authoritativeSensorFreezeId,
      mutationSha256: sha(patch),
      mutationByteLength: Buffer.byteLength(patch),
      mutatedSourceId: build.sourceId,
      mutatedSelectedTreeSha256: build.sourceHash,
    });
    expect(M7HiddenMutationRegistrationV1Schema.parse(registration)).toEqual(
      registration,
    );
    expect(() =>
      createM7R3MutationRegistrationV1({
        trajectoryClassifierFreeze: freeze,
        mutationBytes: patch.replaceAll(
          "components/enemy/enemy.tscn",
          "addons/answer.gd",
        ),
        mutatedBuild: build,
        registeredAt: "2026-08-15T00:01:30.000Z",
      }),
    ).toThrow(/forbidden path/iu);
    expect(() =>
      createM7R3MutationRegistrationV1({
        trajectoryClassifierFreeze: freeze,
        mutationBytes: patch,
        mutatedBuild: build,
        registeredAt: "2026-08-14T23:59:59.000Z",
      }),
    ).toThrow(/before.*classifier freeze/iu);
  });

  it("freezes a neutral classifier before mutation and projects two exact portfolio cases", () => {
    const { freeze, one, two } = constructions();
    expect(freeze.frozenBeforeMutation).toBe(true);
    expect(one.outcome).toBe("passed");
    expect(two.outcome).toBe("passed");

    const portfolio = portfolioFor(freeze, one, two);
    expect(portfolio.cases[0]).toMatchObject({
      ordinal: 1,
      ...projectM7R3ConstructionToPortfolioCaseV1(one),
    });
    expect(portfolio.cases[1]).toMatchObject({
      ordinal: 2,
      ...projectM7R3ConstructionToPortfolioCaseV1(two),
    });
    expect(portfolio.commonRuntimeMaterials).toMatchObject(
      projectM7R3ClassifierFreezeToPortfolioV1(freeze),
    );

    const serialized = JSON.stringify({ freeze, one });
    expect(serialized).not.toContain("敌人会掉下平台，请修复。");
    expect(serialized).not.toContain("hidden evaluator implementation 1");
    expect(serialized).not.toContain("paired public task contract 1");
    expect(serialized).not.toMatch(/mutationBytes|promptText|evaluatorPath/iu);
  });

  it("passes only after portfolio freeze with public recovery/baseline witnesses and the exact fresh 9x2 matrix", () => {
    const { freeze, one, two } = constructions();
    const portfolio = portfolioFor(freeze, one, two);
    const preflight = createM7R3CasePreflightReceiptV1(
      preflightInput(portfolio, one, freeze),
    );

    expect(preflight.outcome).toBe("passed");
    expect(preflight.failureReasons).toEqual([]);
    expect(
      preflight.publicTrajectoryObservations[0].selectedWitnesses.map(
        (witness) => witness.kind,
      ),
    ).toContain("direction_recovery");
    expect(
      preflight.publicTrajectoryObservations[1].selectedWitnesses.map(
        (witness) => witness.kind,
      ),
    ).toContain("ground_contact_loss");
    expect(preflight.hiddenEvaluator.matrix.summary).toMatchObject({
      pristineExpectedMotionObserved: 9,
      mutantPublicExpectedMotionObserved: 0,
      mutantHiddenExpectedMotionObserved: 0,
      mutantRegressionExpectedMotionObserved: 3,
      cleanupFailures: 0,
    });
    expect(preflight.hiddenEvaluator.freshRuns).toHaveLength(18);
    expect(M7R3CasePreflightReceiptV1Schema.parse(preflight)).toEqual(
      preflight,
    );
  });

  it("retains typed construction/preflight failures instead of accepting caller verdicts", () => {
    const { freeze, one, two } = constructions();
    const badConstruction = createM7R3CaseConstructionReceiptV1({
      ...constructionInput(1, freeze),
      cleanup: { proven: false, receiptSha256: null },
    });
    expect(badConstruction).toMatchObject({
      outcome: "construction_failed",
      failureReasons: ["construction_cleanup_not_proven"],
    });
    expect(() =>
      projectM7R3ConstructionToPortfolioCaseV1(badConstruction),
    ).toThrow(/failed construction/iu);

    const portfolio = portfolioFor(freeze, one, two);
    const failedPreflight = createM7R3CasePreflightReceiptV1(
      preflightInput(portfolio, one, freeze, true),
    );
    expect(failedPreflight.outcome).toBe("preflight_failed");
    expect(failedPreflight.failureReasons).toContain(
      "hidden_evaluator_matrix_unexpected",
    );

    const tampered = structuredClone(failedPreflight);
    tampered.outcome = "passed";
    tampered.failureReasons = [];
    tampered.recordContentSha256 = digestJson(
      Object.fromEntries(
        Object.entries(tampered).filter(
          ([key]) => key !== "preflightId" && key !== "recordContentSha256",
        ),
      ),
    );
    tampered.preflightId = `m7-r3-case-preflight:${tampered.recordContentSha256.slice(0, 24)}`;
    expect(M7R3CasePreflightReceiptV1Schema.safeParse(tampered).success).toBe(
      false,
    );
  });

  it("uses create-once private files and rejects reroll, overlap, or hardlink aliases", async () => {
    const parent = await mkdtemp(join(tmpdir(), "chronorift-m7-r3-construct-"));
    temporaryRoots.add(parent);
    const root = join(parent, "host-only");
    const exposed = join(parent, "agent-exposed");
    await Promise.all([
      mkdir(root, { mode: 0o700 }),
      mkdir(exposed, { mode: 0o700 }),
    ]);
    await Promise.all([chmod(root, 0o700), chmod(exposed, 0o700)]);
    const store = await openM7R3CaseConstructionStoreV1({
      root,
      exposedRoots: [exposed],
    });
    const freezeInput = {
      authoritativeSensorFreeze: sensorFreeze(),
      authoritativeAdapterRevision: adapterRevision(),
      classifierImplementationBytes:
        "classify patrol.motion generic trajectory behavior\n",
      frozenAt: "2026-08-15T00:00:30.000Z",
    } as const;
    const freeze = await store.createClassifierFreezeOnce(freezeInput);
    await expect(store.createClassifierFreezeOnce(freezeInput)).rejects.toThrow(
      /already exists|reroll/iu,
    );
    const one = await store.createConstructionOnce(
      Object.fromEntries(
        Object.entries(constructionInput(1, freeze)).filter(
          ([key]) => key !== "trajectoryClassifierFreeze",
        ),
      ) as unknown as Omit<
        CreateM7R3CaseConstructionReceiptV1Input,
        "trajectoryClassifierFreeze"
      >,
    );
    await expect(
      store.createConstructionOnce(
        Object.fromEntries(
          Object.entries(constructionInput(1, freeze)).filter(
            ([key]) => key !== "trajectoryClassifierFreeze",
          ),
        ) as unknown as Omit<
          CreateM7R3CaseConstructionReceiptV1Input,
          "trajectoryClassifierFreeze"
        >,
      ),
    ).rejects.toThrow(/already exists|reroll/iu);

    const two = await store.createConstructionOnce(
      Object.fromEntries(
        Object.entries(constructionInput(2, freeze)).filter(
          ([key]) => key !== "trajectoryClassifierFreeze",
        ),
      ) as unknown as Omit<
        CreateM7R3CaseConstructionReceiptV1Input,
        "trajectoryClassifierFreeze"
      >,
    );
    const finalPreflight = createM7R3CasePreflightReceiptV1(
      preflightInput(portfolioFor(freeze, one, two), one, freeze),
    );
    await expect(store.persistPreflightOnce(finalPreflight)).resolves.toEqual(
      finalPreflight,
    );
    await expect(store.readPreflight(1)).resolves.toEqual(finalPreflight);
    await expect(store.persistPreflightOnce(finalPreflight)).rejects.toThrow(
      /already exists|reroll/iu,
    );

    const constructionPath = join(root, "m7-r3.case-01-construction.json");
    const metadata = await lstat(constructionPath);
    expect(metadata.mode & 0o7777).toBe(0o600);
    expect(metadata.nlink).toBe(1);
    expect(await readFile(constructionPath, "utf8")).not.toContain(
      "敌人会掉下平台，请修复。",
    );

    const alias = join(parent, "construction-alias.json");
    await link(constructionPath, alias);
    await expect(store.readConstruction(1)).rejects.toThrow(/one-link/iu);
    expect(one.outcome).toBe("passed");
    await expect(
      openM7R3CaseConstructionStoreV1({ root, exposedRoots: [root] }),
    ).rejects.toThrow(/disjoint/iu);
  });

  it("rejects a classifier whose bytes disclose the mutation locus", () => {
    expect(adapterRevision().packageDigest).not.toBe(
      sensorFreeze().sensor.adapterPackageSha256,
    );
    expect(adapterRevision().payloadSchemaDigest).not.toBe(
      sensorFreeze().sensor.observationSchemaSha256,
    );
    expect(classifierFreeze().authoritativeAdapter.packageSha256).toBe(
      adapterRevision().packageDigest,
    );
    expect(() =>
      createM7R3TrajectoryClassifierFreezeV1({
        authoritativeSensorFreeze: sensorFreeze(),
        authoritativeAdapterRevision: adapterRevision(),
        classifierImplementationBytes: "inspect left_ray collision_mask\n",
        frozenAt: "2026-08-15T00:00:30.000Z",
      }),
    ).toThrow(/Bug-specific|source-specific/iu);
    expect(M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1.configSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    const construction = constructions().one;
    expect(M7R3CaseConstructionReceiptV1Schema.parse(construction)).toEqual(
      construction,
    );
  });
});
