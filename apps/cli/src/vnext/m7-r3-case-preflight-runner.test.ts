import { createHash } from "node:crypto";

import {
  M6AdapterBuildCompatibilityReceiptV1Schema,
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectAdapterRevisionV1Schema,
  VNextBuildV1Schema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import {
  canonicalJson,
  projectEnvironmentPackageContentDigestV1,
} from "@chronorift/json-artifacts";
import { describe, expect, it, vi } from "vitest";

import {
  M7HiddenMutationRegistrationV1Schema,
  M7_PATROL_SCENARIO_PLAN_V1,
  createM7SensorFreezeRecordV1,
  type M7PatrolEntityStateV1,
} from "./m7-patrol-sensor.js";
import { createM7R3PatrolTrajectoryCaseSpecV1 } from "./m7-patrol-trajectory.js";
import {
  createM7R3CaseConstructionReceiptV1,
  createM7R3TrajectoryClassifierFreezeV1,
  projectM7R3ClassifierFreezeToPortfolioV1,
  projectM7R3ConstructionToPortfolioCaseV1,
  type M7R3CaseConstructionReceiptV1,
  type M7R3CasePreflightReceiptV1,
  type M7R3TrajectoryClassifierFreezeV1,
} from "./m7-r3-case-construction.js";
import {
  M7R3PreflightApiBlockerErrorV1,
  createM7R3HostDerivedCaptureRecordSealV1,
  runM7R3TwoCasePreflightV1,
  type M7R3CasePreflightEvidenceRecordV1,
  type M7R3CasePreflightHostPortsV1,
  type M7R3HiddenEvaluatorPreflightRequestV1,
  type M7R3NoAgentPublicObservationRequestV1,
} from "./m7-r3-case-preflight-runner.js";
import {
  createM7R3TwoCasePortfolioFreezeV1,
  type M7R3TwoCasePortfolioFreezeV1,
} from "./m7-r3-two-case-portfolio.js";

const sha = (value: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const digestJson = (value: unknown): Sha256DigestV1 =>
  sha(canonicalJson(value as never));

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

const taskCleanup = {
  processGroupTerminated: true,
  cgroupPopulated: false,
  termSent: false,
  killSent: false,
  scopeRemoved: true,
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
    materials: {
      adapterPackageBytes: "generic patrol adapter package v1\n",
      observationSchemaBytes:
        "entity_id name start_direction direction fall_off_edge speed position_x position_y velocity_x velocity_y grounded\n",
      classifierImplementationBytes:
        "classify generic patrol sequences from public motion state\n",
      pristineConformanceReceiptBytes: "pristine conformance receipt v1\n",
    },
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
      "classify patrol.motion trajectories from contact speed stall direction and grounded motion\n",
    frozenAt: "2026-08-15T00:00:30.000Z",
  });

const mutationRegistration = (ordinal: 1 | 2) => {
  const freeze = sensorFreeze();
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

const mutantBuild = (ordinal: 1 | 2) => {
  const mutation = mutationRegistration(ordinal);
  return VNextBuildV1Schema.parse({
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
};

const compatibility = (ordinal: 1 | 2, build = mutantBuild(ordinal)) =>
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
      stateRows: 3,
    },
    coverage,
    loss: [],
    cleanup,
    outcome: "compatible",
    failures: [],
    observedAt: `2026-08-15T00:2${ordinal}:00.000Z`,
  });

const construction = (
  ordinal: 1 | 2,
  freeze: M7R3TrajectoryClassifierFreezeV1,
): M7R3CaseConstructionReceiptV1 => {
  const mutation = mutationRegistration(ordinal);
  const build = mutantBuild(ordinal);
  return createM7R3CaseConstructionReceiptV1({
    ordinal,
    trajectoryClassifierFreeze: freeze,
    mutationRegistration: mutation,
    mutatedBuild: build,
    naturalPrompt:
      ordinal === 1
        ? "Patrolling enemies move inconsistently on sloped terrain. Fix it."
        : "Some patrolling enemies eventually stop moving. Fix it.",
    trajectoryCaseSpec: createM7R3PatrolTrajectoryCaseSpecV1({
      classifierImplementationSha256: freeze.classifierImplementationSha256,
      expectedBaselineWitnessKinds: ["ground_contact_loss"],
      expectedRecoveryWitnessKinds: ["direction_recovery"],
      frozenAt: `2026-08-15T00:3${ordinal}:00.000Z`,
    }),
    adapterMutantCompatibilityReceipt: compatibility(ordinal, build),
    pairedPublicTaskContractBytes: `paired public task contract ${ordinal}\n`,
    preflightImplementationBytes: `preflight implementation ${ordinal}\n`,
    evaluatorImplementationBytes: `hidden evaluator implementation ${ordinal}\n`,
    evaluatorBundleBytes: `hidden evaluator bundle ${ordinal}\n`,
    cleanup: {
      proven: true,
      receiptSha256: sha(`construction-cleanup-${ordinal}`),
    },
    constructedAt: `2026-08-15T00:4${ordinal}:00.000Z`,
  });
};

interface FrozenFixture {
  readonly freeze: M7R3TrajectoryClassifierFreezeV1;
  readonly constructions: readonly [
    M7R3CaseConstructionReceiptV1,
    M7R3CaseConstructionReceiptV1,
  ];
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
}

const frozenFixture = (): FrozenFixture => {
  const freeze = classifierFreeze();
  const one = construction(1, freeze);
  const two = construction(2, freeze);
  const portfolio = createM7R3TwoCasePortfolioFreezeV1({
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
  return { freeze, constructions: [one, two], portfolio };
};

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

const statesFor = (subject: "pristine" | "mutant") =>
  subject === "pristine"
    ? [
        state(),
        state({ direction: 1, velocity_x: 120, position_x: 4 }),
        state({ direction: 1, velocity_x: 120, position_x: 16 }),
      ]
    : [
        state(),
        state({ grounded: false, position_y: 108, velocity_y: 60 }),
        state({ grounded: false, position_y: 120, velocity_y: 100 }),
      ];

const observationRecords = (subject: "pristine" | "mutant") =>
  statesFor(subject).map((entry, index) => ({
    schemaVersion: 1 as const,
    recordSequence: index + 1,
    clock: {
      processFrame: index + 1,
      physicsTick: index + 1,
      simulationTimeUs: (index + 1) * 16_667,
      renderFrame: null,
    },
    kind: "state_sample" as const,
    payload: {
      stateDomainId: "patrol.motion",
      value: { agents: [entry] },
      semanticCoverage: "declared" as const,
    },
  }));

interface PublicEvidenceOptions {
  readonly querySampleCount?: number;
  readonly disjointCaptureBatch?: boolean;
  readonly cleanupIncomplete?: boolean;
  readonly tamperSource?: boolean;
  readonly tamperCaptureRecordSeal?: boolean;
  readonly tamperAdapterIdentity?: boolean;
  readonly queryDroppedRecords?: number;
}

const publicEvidence = (
  request: M7R3NoAgentPublicObservationRequestV1,
  freeze: M7R3TrajectoryClassifierFreezeV1,
  options: PublicEvidenceOptions = {},
) => {
  const taskId = `task:r3-preflight:${request.ordinal}:${request.subject}`;
  const runtimeId = `runtime:r3-preflight:${request.ordinal}:${request.subject}`;
  const executionId = `execution:r3-preflight:${request.ordinal}:${request.subject}`;
  const buildId =
    request.expectedSource.buildId ??
    `build:r3-preflight:${request.ordinal}:${request.subject}`;
  const environmentRevisionId = `environment-revision:r3:${request.ordinal}:${request.subject}`;
  const launchTargetId = "main";
  const querySourceRecords = observationRecords(request.subject);
  const records = options.disjointCaptureBatch
    ? querySourceRecords.map((record) => ({
        ...record,
        recordSequence: record.recordSequence + 100,
      }))
    : querySourceRecords;
  const queryRecords = querySourceRecords.slice(
    0,
    options.querySampleCount ?? 3,
  );
  const finalCleanup = options.cleanupIncomplete
    ? { ...cleanup, isolationGroupEmpty: false }
    : cleanup;
  const finalCoverage = coverage;
  const queryCoverage =
    options.queryDroppedRecords === undefined
      ? finalCoverage
      : finalCoverage.map((entry) => ({
          ...entry,
          droppedRecords: options.queryDroppedRecords ?? 0,
        }));
  const captureWindowId = `capture:r3:${request.ordinal}:${request.subject}`;
  const build = VNextBuildV1Schema.parse({
    schemaVersion: 1,
    taskId,
    workspaceId: `workspace:r3-preflight:${request.ordinal}:${request.subject}`,
    sourceId: request.expectedSource.sourceId,
    buildId,
    sourceHash: request.expectedSource.sourceSha256,
    workspaceDiffHash: sha(
      `preflight-diff:${request.ordinal}:${request.subject}`,
    ),
    buildConfigurationHash: sha(
      `preflight-config:${request.ordinal}:${request.subject}`,
    ),
    outputHash: sha(`preflight-output:${request.ordinal}:${request.subject}`),
    createdAt: "2026-08-15T01:10:00.000Z",
  });
  const clock = {
    schemaVersion: 1 as const,
    processFrame: 3,
    physicsTick: 3,
    simulationTimeUs: 50_001,
    renderFrame: null,
    hostMonotonicUs: 100_000,
  };
  const recordsBytes = Buffer.from(
    `${canonicalJson(records as never)}\n`,
    "utf8",
  );
  const captureManifest = {
    schemaVersion: 1 as const,
    captureWindowId,
    taskId,
    runtimeId,
    executionId,
    buildId,
    environmentRevisionId,
    adapterRevisionId: freeze.authoritativeAdapter.adapterRevisionId,
    recordCount: records.length,
    contentDigest: projectEnvironmentPackageContentDigestV1([
      { path: "records.json", bytes: recordsBytes },
    ]),
    anchorClock: clock,
    coverage: finalCoverage,
    loss: [],
    createdAt: "2026-08-15T01:12:00.000Z",
  };
  const launch = {
    input: {
      schemaVersion: 1 as const,
      taskId,
      buildId,
      launchTargetId,
    },
    output: {
      schemaVersion: 1 as const,
      taskId,
      runtimeId,
      executionId,
      buildId,
      environmentRevisionId,
      adapterRevisionId: freeze.authoritativeAdapter.adapterRevisionId,
      launchReceiptId: `launch-receipt:r3:${request.ordinal}:${request.subject}`,
      requested: { launchTargetId, parameters: {} },
      realized: {
        launchTargetId,
        parameters: {},
        renderer: "headless",
        clock,
      },
      status: "running" as const,
      modules: capabilitySet.modules,
      limitations: [],
    },
  };
  const stateQueries = [
    {
      input: {
        schemaVersion: 1 as const,
        taskId,
        executionId,
        select: "state" as const,
        limit: 200,
      },
      output: {
        schemaVersion: 1 as const,
        taskId,
        executionId,
        rows: queryRecords.map((record, index) => ({
          schemaVersion: 1 as const,
          rowId: `query-row:r3:${request.ordinal}:${request.subject}:${index + 1}`,
          kind: "state" as const,
          clock: null,
          value: record,
        })),
        nextCursor: null,
        coverage: queryCoverage,
        loss: [],
        limitations: [],
      },
    },
  ];
  const capturePins = [
    {
      input: {
        schemaVersion: 1 as const,
        taskId,
        runtimeId,
        anchor: { kind: "now" as const },
        before: 0,
        after: 0,
      },
      output: {
        schemaVersion: 1 as const,
        taskId,
        runtimeId,
        captureWindowId,
        anchor: {
          requested: { kind: "now" as const },
          realized: clock,
          quantized: true,
        },
        coverage: finalCoverage,
        loss: [],
        limitations: [],
      },
    },
  ];
  const stop = {
    input: { schemaVersion: 1 as const, taskId, runtimeId },
    output: {
      schemaVersion: 1 as const,
      taskId,
      runtimeId,
      executionId,
      status: "stopped" as const,
      cleanup: finalCleanup,
      coverage: finalCoverage,
      loss: [],
      limitations: [],
    },
  };
  const failures = options.cleanupIncomplete
    ? ["Runtime sandbox cleanup was incomplete."]
    : [];
  const runtimeObservationReceipt = {
    schemaVersion: 1 as const,
    receiptId: `runtime-observation:r3:${request.ordinal}:${request.subject}`,
    taskId,
    runtimeId,
    executionId,
    buildId,
    environmentRevisionId,
    adapterRevisionId: freeze.authoritativeAdapter.adapterRevisionId,
    launchTargetId,
    instrumentationMode: "instrumented" as const,
    status: "stopped" as const,
    bridgeHandshakeCount: 1,
    clock,
    queryObservations: {
      schemaVersion: 1 as const,
      entityQueryCount: 1,
      entityRows: 1,
      stateQueryCount: 1,
      stateRows: queryRecords.length,
    },
    captureCount: 1,
    captureWindowIds: [captureWindowId],
    coverage: finalCoverage,
    loss: [],
    cleanup: finalCleanup,
    outcome: options.cleanupIncomplete
      ? ("incomplete" as const)
      : ("succeeded" as const),
    failures,
    startedAt: "2026-08-15T01:11:00.000Z",
    observedAt: "2026-08-15T01:13:00.000Z",
    completedAt: "2026-08-15T01:14:00.000Z",
  };
  const exactCaptureRecordSeal = createM7R3HostDerivedCaptureRecordSealV1({
    taskId,
    executionId,
    records,
  });
  const authoritativeRevision = adapterRevision();
  const revision =
    options.tamperAdapterIdentity === true
      ? ProjectAdapterRevisionV1Schema.parse({
          ...authoritativeRevision,
          implementationDigest: sha("substituted-adapter-implementation"),
        })
      : authoritativeRevision;
  const adapterPackageIdentity = {
    schemaVersion: 1 as const,
    packageSha256: revision.packageDigest,
    manifestSha256: revision.manifestDigest,
    implementationSha256: revision.implementationDigest,
    observationSchemaSha256: revision.payloadSchemaDigest,
    adapterId: revision.adapterId,
    contentByteLength: revision.contentByteLength,
    contentFileCount: revision.contentFileCount,
  };
  return {
    schemaVersion: 1 as const,
    configuredMainScene: request.configuredMainScene,
    build,
    selectedTreeSha256: request.expectedSource.selectedTreeSha256,
    adapterRevision: revision,
    adapterPackageIdentity,
    fingerprint: {
      schemaVersion: 1 as const,
      protocolProfile: "chronorift-godot-project-environment-v1" as const,
      protocolVersion: 1 as const,
      engine: "godot" as const,
      engineVersion: "4.7.1",
      engineBuildHash: "test-build",
      platform: "linux",
      renderer: "headless" as const,
      displayServer: "headless" as const,
      audioDriver: "Dummy",
      physicsTicksPerSecond: 60,
      configuredMainScene: request.configuredMainScene,
      modules: capabilitySet,
      identity: {
        taskId,
        sourceClosureId: build.sourceId,
        environmentRevisionId,
        adapterRevisionId: freeze.authoritativeAdapter.adapterRevisionId,
        buildId,
        runtimeId,
        executionId,
        instrumentationMode: "instrumented" as const,
        candidateSourceHash: options.tamperSource
          ? sha("crossed-source")
          : build.sourceHash,
        adapterManifestSha256: freeze.authoritativeAdapter.manifestSha256,
        sdkSha256: freeze.authoritativeAdapter.sdkSha256,
        bridgeSha256: freeze.authoritativeAdapter.bridgeSha256,
        toolchainSha256: sha("toolchain-artifact"),
      },
    },
    launch,
    stateQueries,
    capturePins,
    pinnedCaptures: [{ manifest: captureManifest, records }],
    stop,
    runtimeObservationReceipt,
    taskCleanupReceipt: taskCleanup,
    taskCleanupReceiptSha256: digestJson(taskCleanup),
    sandboxSecurityEvents: [],
    sandboxSecurityEventsSha256: digestJson([]),
    captureRecordSeal:
      options.tamperCaptureRecordSeal === true
        ? {
            ...exactCaptureRecordSeal,
            contentHash: sha("tampered-capture-seal"),
          }
        : exactCaptureRecordSeal,
    agentLaunchCount: 0,
    providerInvocationCount: 0,
    piSessionCount: 0,
  };
};

interface PortsOptions {
  readonly querySampleCount?: number;
  readonly disjointCaptureBatch?: boolean;
  readonly publicCleanupIncomplete?: boolean;
  readonly tamperSource?: boolean;
  readonly tamperCaptureRecordSeal?: boolean;
  readonly tamperAdapterIdentity?: boolean;
  readonly queryDroppedRecords?: number;
  readonly hiddenUnexpected?: boolean;
  readonly hiddenCleanupFailsAt?: number;
}

const portsFor = (
  ordinal: 1 | 2,
  freeze: M7R3TrajectoryClassifierFreezeV1,
  log: string[],
  persisted: M7R3CasePreflightReceiptV1[],
  rawEvidence: M7R3CasePreflightEvidenceRecordV1[],
  publicRequests: M7R3NoAgentPublicObservationRequestV1[],
  options: PortsOptions = {},
): M7R3CasePreflightHostPortsV1 => {
  let hiddenOrdinal = 0;
  return {
    ordinal,
    configuredMainScene: "res://scenes/main.tscn",
    projectEnvironment: {
      observeConfiguredMainScene: vi.fn(
        async (request: M7R3NoAgentPublicObservationRequestV1) => {
          log.push(`case-${ordinal}:public:${request.subject}`);
          publicRequests.push(request);
          return publicEvidence(request, freeze, {
            ...(options.querySampleCount === undefined
              ? {}
              : { querySampleCount: options.querySampleCount }),
            ...(options.disjointCaptureBatch === true
              ? { disjointCaptureBatch: true }
              : {}),
            ...(options.publicCleanupIncomplete === true &&
            request.subject === "pristine"
              ? { cleanupIncomplete: true }
              : {}),
            ...(options.tamperSource === true && request.subject === "pristine"
              ? { tamperSource: true }
              : {}),
            ...(options.tamperCaptureRecordSeal === true &&
            request.subject === "pristine"
              ? { tamperCaptureRecordSeal: true }
              : {}),
            ...(options.tamperAdapterIdentity === true &&
            request.subject === "pristine"
              ? { tamperAdapterIdentity: true }
              : {}),
            ...(options.queryDroppedRecords === undefined
              ? {}
              : { queryDroppedRecords: options.queryDroppedRecords }),
          });
        },
      ),
    },
    hiddenEvaluator: {
      runFresh: vi.fn(
        async (request: M7R3HiddenEvaluatorPreflightRequestV1) => {
          hiddenOrdinal += 1;
          log.push(
            `case-${ordinal}:hidden:${request.subject}:${request.scenario.scenarioId}`,
          );
          const expected =
            request.subject === "pristine" ||
            request.scenario.scenarioClass === "regression_control";
          const unexpected =
            options.hiddenUnexpected === true &&
            request.subject === "mutant" &&
            request.scenario.scenarioClass === "public_reproduction" &&
            request.scenario.repetition === 1;
          const cleanupProven = options.hiddenCleanupFailsAt !== hiddenOrdinal;
          const privatePath = `/host/private/case-${ordinal}/evaluator.mjs`;
          return {
            schemaVersion: 1,
            subject: request.subject,
            scenarioId: request.scenario.scenarioId,
            observation:
              expected || unexpected
                ? "expected_motion_observed"
                : "expected_motion_not_observed",
            observationReceipt: {
              schemaVersion: 1,
              evaluatorPrivatePath: privatePath,
              observed: expected || unexpected,
            },
            workspace: {
              created: true,
              identity: `${privatePath}/workspace/${hiddenOrdinal}`,
              creationReceipt: {
                schemaVersion: 1,
                privatePath,
                kind: "workspace-created",
                hiddenOrdinal,
              },
            },
            importCache: {
              created: true,
              identity: `${privatePath}/import/${hiddenOrdinal}`,
              creationReceipt: {
                schemaVersion: 1,
                privatePath,
                kind: "import-cache-created",
                hiddenOrdinal,
              },
            },
            process: {
              started: true,
              identity: `${privatePath}/process/${hiddenOrdinal}`,
              startReceipt: {
                schemaVersion: 1,
                privatePath,
                kind: "process-started",
                hiddenOrdinal,
              },
            },
            cleanup: {
              proven: cleanupProven,
              receipt: {
                schemaVersion: 1,
                privatePath,
                kind: "cleanup",
                proven: cleanupProven,
              },
            },
            agentLaunchCount: 0,
            providerInvocationCount: 0,
            piSessionCount: 0,
          };
        },
      ),
    },
    persistence: {
      persistPreflightOnce: vi.fn(
        async (receipt: M7R3CasePreflightReceiptV1) => {
          log.push(`case-${ordinal}:persist`);
          persisted.push(receipt);
          return structuredClone(receipt);
        },
      ),
    },
    evidencePersistence: {
      persistEvidenceOnce: vi.fn(
        async (record: M7R3CasePreflightEvidenceRecordV1) => {
          rawEvidence.push(record);
          return structuredClone(record);
        },
      ),
    },
  };
};

const runFixture = async (input: {
  readonly caseOne?: PortsOptions;
  readonly caseTwo?: PortsOptions;
}) => {
  const frozen = frozenFixture();
  const log: string[] = [];
  const persisted: M7R3CasePreflightReceiptV1[] = [];
  const rawEvidence: M7R3CasePreflightEvidenceRecordV1[] = [];
  const publicRequests: M7R3NoAgentPublicObservationRequestV1[] = [];
  const ports = [
    portsFor(
      1,
      frozen.freeze,
      log,
      persisted,
      rawEvidence,
      publicRequests,
      input.caseOne,
    ),
    portsFor(
      2,
      frozen.freeze,
      log,
      persisted,
      rawEvidence,
      publicRequests,
      input.caseTwo,
    ),
  ] as const;
  const promise = runM7R3TwoCasePreflightV1({
    trajectoryClassifierFreeze: frozen.freeze,
    constructionReceipts: frozen.constructions,
    portfolioFreeze: frozen.portfolio,
    cases: ports,
    now: () => "2026-08-15T02:00:00.000Z",
  });
  return {
    promise,
    frozen,
    log,
    persisted,
    rawEvidence,
    publicRequests,
    ports,
  };
};

describe("M7 R3 no-Agent case preflight runner", () => {
  it("runs both cases sequentially from exact PE query/capture evidence and persists the fresh 9+9 matrices", async () => {
    const fixture = await runFixture({});
    const result = await fixture.promise;

    expect(result.status).toBe("completed");
    expect(result).toMatchObject({
      agentLaunchCount: 0,
      providerInvocationCount: 0,
      piSessionCount: 0,
    });
    expect(result.receipts).toHaveLength(2);
    expect(
      result.receipts.every((receipt) => receipt.outcome === "passed"),
    ).toBe(true);
    expect(fixture.persisted).toEqual(result.receipts);
    expect(fixture.log.slice(0, 3)).toEqual([
      "case-1:public:pristine",
      "case-1:public:mutant",
      `case-1:hidden:pristine:${M7_PATROL_SCENARIO_PLAN_V1[0]!.scenarioId}`,
    ]);
    expect(fixture.log.indexOf("case-1:persist")).toBe(20);
    expect(fixture.log[21]).toBe("case-2:public:pristine");
    expect(fixture.log.at(-1)).toBe("case-2:persist");
    expect(
      result.receipts[0].publicTrajectoryObservations[0].selectedWitnesses.map(
        (entry) => entry.kind,
      ),
    ).toContain("direction_recovery");
    expect(
      result.receipts[0].publicTrajectoryObservations[1].selectedWitnesses.map(
        (entry) => entry.kind,
      ),
    ).toContain("ground_contact_loss");
    expect(result.receipts[0].hiddenEvaluator.matrix.runs).toHaveLength(18);
    expect(result.receipts[0].hiddenEvaluator.freshRuns).toHaveLength(18);
    expect(JSON.stringify(result.receipts)).not.toContain("/host/private/");
    expect(JSON.stringify(fixture.publicRequests)).not.toMatch(
      /classifier|witness|ground_contact_loss|direction_recovery/iu,
    );
  });

  it("retains an unexpected hidden-oracle result as a failed denominator case without rerolling or stopping case two", async () => {
    const fixture = await runFixture({
      caseOne: { hiddenUnexpected: true },
    });
    const result = await fixture.promise;

    expect(result.status).toBe("completed");
    expect(result.receipts[0].outcome).toBe("preflight_failed");
    expect(result.receipts[0].failureReasons).toContain(
      "hidden_evaluator_matrix_unexpected",
    );
    expect(result.receipts[1].outcome).toBe("passed");
    expect(
      fixture.log.filter((entry) => entry.includes(":hidden:")),
    ).toHaveLength(36);
    expect(fixture.persisted).toHaveLength(2);
    expect(fixture.rawEvidence).toHaveLength(40);
    expect(
      fixture.rawEvidence.filter(
        (record) => record.evidenceKind === "public_observation",
      ),
    ).toHaveLength(4);
    expect(
      fixture.rawEvidence.filter(
        (record) => record.evidenceKind === "hidden_evaluator_run",
      ),
    ).toHaveLength(36);
  });

  it("reports an exact timeline API blocker instead of inventing missing patrol.motion frames", async () => {
    const fixture = await runFixture({ caseOne: { querySampleCount: 1 } });

    await expect(fixture.promise).rejects.toMatchObject({
      name: "M7R3PreflightApiBlockerErrorV1",
      code: "patrol_motion_timeline_unavailable",
      ordinal: 1,
      subject: "pristine",
    });
    expect(fixture.log).toEqual(["case-1:public:pristine"]);
    expect(fixture.persisted).toEqual([]);
  });

  it("uses the Agent-visible query timeline when the later pinned transport batch is disjoint", async () => {
    const fixture = await runFixture({
      caseOne: { disjointCaptureBatch: true },
    });

    const result = await fixture.promise;
    expect(result.status).toBe("completed");
    expect(result.receipts[0].outcome).toBe("passed");
    expect(
      result.receipts[0].publicTrajectoryObservations.every(
        (observation) => observation.coverage.observedFrameCount === 3,
      ),
    ).toBe(true);
  });

  it("rejects crossed Build/Source runtime lineage before hidden evaluation or persistence", async () => {
    const fixture = await runFixture({ caseOne: { tamperSource: true } });

    await expect(fixture.promise).rejects.toMatchObject({
      code: "project_environment_lineage_mismatch",
      ordinal: 1,
      subject: "pristine",
    });
    expect(fixture.log).toEqual(["case-1:public:pristine"]);
    expect(fixture.persisted).toHaveLength(0);
  });

  it("recomputes the Host-derived capture-record seal from exact pinned bytes", async () => {
    const fixture = await runFixture({
      caseOne: { tamperCaptureRecordSeal: true },
    });

    await expect(fixture.promise).rejects.toMatchObject({
      code: "pinned_capture_content_mismatch",
      ordinal: 1,
      subject: "pristine",
    });
    expect(fixture.log).toEqual(["case-1:public:pristine"]);
    expect(fixture.persisted).toHaveLength(0);
  });

  it("rejects replacement Adapter bytes hidden behind the authoritative revision ID", async () => {
    const fixture = await runFixture({
      caseOne: { tamperAdapterIdentity: true },
    });

    await expect(fixture.promise).rejects.toMatchObject({
      code: "project_environment_lineage_mismatch",
      ordinal: 1,
      subject: "pristine",
    });
    expect(fixture.log).toEqual(["case-1:public:pristine"]);
    expect(fixture.persisted).toHaveLength(0);
  });

  it("aggregates query coverage loss instead of counting only the runtime receipt", async () => {
    const fixture = await runFixture({
      caseOne: { queryDroppedRecords: 2 },
    });
    const result = await fixture.promise;

    expect(result.status).toBe("completed");
    expect(result.receipts[0]!.outcome).toBe("preflight_failed");
    expect(
      result.receipts[0]!.publicTrajectoryObservations[0].loss,
    ).toMatchObject({
      historyLossObserved: true,
      droppedRecordCount: 2,
    });
  });

  it("does not start another PE execution when public cleanup is not proven", async () => {
    const fixture = await runFixture({
      caseOne: { publicCleanupIncomplete: true },
    });

    await expect(fixture.promise).rejects.toMatchObject({
      code: "public_observation_cleanup_not_proven",
      ordinal: 1,
      subject: "pristine",
    });
    expect(fixture.log).toEqual(["case-1:public:pristine"]);
    expect(fixture.persisted).toEqual([]);
  });

  it("persists the partial hidden matrix and safety-stops before another shared-cgroup run after cleanup failure", async () => {
    const fixture = await runFixture({
      caseOne: { hiddenCleanupFailsAt: 1 },
    });
    const result = await fixture.promise;

    expect(result).toMatchObject({
      status: "safety_stopped",
      reason: "hidden_evaluator_cleanup_not_proven",
      stoppedAfter: {
        ordinal: 1,
        subject: "pristine",
        scenarioId: M7_PATROL_SCENARIO_PLAN_V1[0]!.scenarioId,
      },
    });
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]!.outcome).toBe("preflight_failed");
    expect(result.receipts[0]!.failureReasons).toEqual(
      expect.arrayContaining([
        "hidden_evaluator_matrix_incomplete",
        "hidden_evaluator_cleanup_not_proven",
      ]),
    );
    expect(fixture.log).toEqual([
      "case-1:public:pristine",
      "case-1:public:mutant",
      `case-1:hidden:pristine:${M7_PATROL_SCENARIO_PLAN_V1[0]!.scenarioId}`,
      "case-1:persist",
    ]);
    expect(fixture.persisted).toHaveLength(1);
  });

  it("uses a path-free blocker type and never exposes a port exception message", async () => {
    const frozen = frozenFixture();
    const ports: M7R3CasePreflightHostPortsV1 = {
      ordinal: 1,
      configuredMainScene: "res://scenes/main.tscn",
      projectEnvironment: {
        observeConfiguredMainScene: async () => {
          throw new Error("/host/private/assignment/evaluator.mjs");
        },
      },
      hiddenEvaluator: { runFresh: vi.fn() },
      persistence: { persistPreflightOnce: vi.fn() },
    };
    let caught: unknown;
    try {
      await runM7R3TwoCasePreflightV1({
        trajectoryClassifierFreeze: frozen.freeze,
        constructionReceipts: frozen.constructions,
        portfolioFreeze: frozen.portfolio,
        cases: [
          ports,
          {
            ...ports,
            ordinal: 2,
          },
        ],
        now: () => "2026-08-15T02:00:00.000Z",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(M7R3PreflightApiBlockerErrorV1);
    expect(String(caught)).not.toContain("/host/private/");
    expect(caught).toMatchObject({ code: "project_environment_port_failed" });
  });
});
