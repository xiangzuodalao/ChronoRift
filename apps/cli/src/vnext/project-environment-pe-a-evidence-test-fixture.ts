import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  AdapterConformanceReceiptV1Schema,
  AdapterCompatibilityReceiptV1Schema,
  EnvironmentBindingEpochV1Schema,
  EnvironmentPublicationReceiptV1Schema,
  ObserverEffectReceiptV1Schema,
  ProjectAdapterRevisionV1Schema,
  ProjectAdapterCandidateReferenceV1Schema,
  ProjectEnvironmentBuildBindingV1Schema,
  ProjectEnvironmentPinnedCaptureV1Schema,
  ProjectEnvironmentReuseReceiptV1Schema,
  ProjectEnvironmentRevisionV1Schema,
  ProjectEnvironmentTurnV1Schema,
  ProjectInitializationAttemptEventV1Schema,
  ProjectToolchainReceiptV1Schema,
  VNextBuildV1Schema,
  asAdapterCompatibilityReceiptId,
  asAdapterConformanceReceiptId,
  asBuildId,
  asCaptureWindowId,
  asEnvironmentBindingEpochId,
  asEnvironmentPublicationReceiptId,
  asExecutionId,
  asObserverEffectReceiptId,
  asProjectAdapterCandidateId,
  asProjectAdapterRevisionId,
  asProjectEnvironmentId,
  asProjectEnvironmentOperationId,
  asProjectEnvironmentRuntimeObservationReceiptId,
  asProjectEnvironmentReuseReceiptId,
  asProjectEnvironmentTaskId,
  asProjectEnvironmentTurnId,
  asProjectInitializationAttemptId,
  asProjectInitializationAttemptEventId,
  asProjectSessionId,
  asProjectToolchainReceiptId,
  asRuntimeId,
  asSha256DigestV1,
  asSourceId,
  asWorkspaceId,
  foldProjectInitializationAttemptV1,
} from "@chronorift/domain";
import { loadProjectAdapterPackageV1 } from "@chronorift/godot-adapter";
import {
  canonicalJson,
  contentHash,
  projectEnvironmentPackageContentDigestV1,
  ProjectEnvironmentTaskStoreV1,
} from "@chronorift/json-artifacts";
import type { PreparedProjectEnvironmentGodotBuildV1 } from "./candidate-godot-build.js";
import type { BuildProjectEnvironmentPeAEvidenceV1Input } from "./project-environment-pe-a-evidence.js";
import type { VerifiedProjectEnvironmentSourceV1 } from "./source-preflight.js";

const adapterDirectory = resolve(
  "fixtures/godot-project-environment-snapshot-characterization/adapter",
);
const temporaryRoots: string[] = [];

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");
const jsonHash = (value: unknown): string =>
  contentHash(
    JSON.parse(JSON.stringify(value)) as Parameters<typeof contentHash>[0],
  );
const digest = (label: string) =>
  asSha256DigestV1(sha256(`chronorift-pe-a-builder-${label}`));
const canonicalRecordBytes = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${canonicalJson(jsonFact(value))}\n`);

const jsonFact = (value: unknown): Parameters<typeof canonicalJson>[0] =>
  JSON.parse(JSON.stringify(value)) as Parameters<typeof canonicalJson>[0];

const cleanup = () => ({
  schemaVersion: 1 as const,
  processTreeTerminated: true,
  runtimeExited: true,
  bridgeExited: true,
  isolationGroupEmpty: true,
  scopeRemoved: true,
  scratchRemoved: true,
  storageReconciled: true,
});

const coverage = (channelId: string, observedRecords = 2) => [
  {
    schemaVersion: 1 as const,
    channelId,
    status: "complete" as const,
    observedRecords,
    droppedRecords: 0,
    overwrittenRecords: 0,
    limitations: [],
  },
];

const turnBudget = {
  schemaVersion: 1 as const,
  wallTimeMs: 60_000,
  toolCallLimit: 64,
  runtimeTimeMs: 30_000,
  tokenPolicy: "observe_only" as const,
  tokenLimit: null,
  storageByteLimit: 1_048_576,
  storageInodeLimit: 1_024,
};

const turnUsage = {
  schemaVersion: 1 as const,
  wallTimeMs: 1_000,
  toolCalls: 4,
  runtimeTimeMs: null,
  inputTokens: 100,
  outputTokens: 100,
  storageBytes: null,
  storageInodes: null,
};

const implementationDigest = (
  files: readonly { path: string; sha256: string }[],
) =>
  asSha256DigestV1(
    sha256(
      `project-adapter-implementation-v1\0${files
        .filter((file) => file.path.endsWith(".gd"))
        .map((file) => `${file.path}:${file.sha256}`)
        .join("\n")}`,
    ),
  );

const payloadSchemaDigest = (
  schemas: readonly { schemaId: string; sha256: string }[],
) =>
  asSha256DigestV1(
    sha256(
      `project-adapter-payload-schemas-v1\0${schemas
        .map((schema) => `${schema.schemaId}:${schema.sha256}`)
        .join("\n")}`,
    ),
  );

const storedPinnedCapture = (input: {
  readonly captureWindowId: ReturnType<typeof asCaptureWindowId>;
  readonly taskId: ReturnType<typeof asProjectEnvironmentTaskId>;
  readonly runtimeId: ReturnType<typeof asRuntimeId>;
  readonly executionId: ReturnType<typeof asExecutionId>;
  readonly buildId: ReturnType<typeof asBuildId>;
  readonly environmentRevisionId: string;
  readonly adapterRevisionId: string;
  readonly clock: {
    readonly schemaVersion: 1;
    readonly processFrame: number;
    readonly physicsTick: number;
    readonly simulationTimeUs: number;
    readonly renderFrame: number | null;
    readonly hostMonotonicUs: number;
  };
  readonly createdAt: string;
}) => {
  const records = [
    {
      schemaVersion: 1 as const,
      recordSequence: 0,
      kind: "state_sample",
      clock: {
        processFrame: input.clock.processFrame,
        physicsTick: input.clock.physicsTick,
        simulationTimeUs: input.clock.simulationTimeUs,
        renderFrame: input.clock.renderFrame,
      },
      payload: {
        stateDomainId: "world",
        value: { counter: 2 },
        semanticCoverage: "declared",
      },
    },
  ];
  const recordsBytes = canonicalRecordBytes(records);
  const files = [
    {
      path: "records.json",
      byteLength: recordsBytes.byteLength,
      sha256: sha256(recordsBytes),
    },
  ];
  const payload = ProjectEnvironmentPinnedCaptureV1Schema.parse({
    schemaVersion: 1,
    captureWindowId: input.captureWindowId,
    taskId: input.taskId,
    runtimeId: input.runtimeId,
    executionId: input.executionId,
    buildId: input.buildId,
    environmentRevisionId: input.environmentRevisionId,
    adapterRevisionId: input.adapterRevisionId,
    recordCount: records.length,
    contentDigest: projectEnvironmentPackageContentDigestV1([
      { path: "records.json", bytes: recordsBytes },
    ]),
    anchorClock: input.clock,
    coverage: coverage("project_adapter_observations", records.length),
    loss: [],
    createdAt: input.createdAt,
  });
  const payloadHash = jsonHash(payload);
  const envelope = {
    schemaVersion: 1 as const,
    ownerId: input.taskId,
    resourceId: input.captureWindowId,
    payload,
    payloadHash,
  };
  const recordHash = jsonHash(envelope);
  const sealBasis = {
    schemaVersion: 1 as const,
    ownerId: input.taskId,
    resourceId: input.captureWindowId,
    operationId: null,
    recordHash,
    files,
    packageByteLength: recordsBytes.byteLength,
  };
  const packageHash = jsonHash(sealBasis);
  return {
    payload,
    records,
    recordsBytes,
    payloadHash,
    packageHash,
    packageSeal: { ...sealBasis, packageHash },
  };
};

const storedRevisionPackage = (input: {
  readonly payload: ReturnType<typeof ProjectEnvironmentRevisionV1Schema.parse>;
  readonly files: readonly {
    readonly path: string;
    readonly bytes: Uint8Array;
  }[];
}) => {
  const payloadHash = jsonHash(input.payload);
  const envelope = {
    schemaVersion: 1 as const,
    ownerId: input.payload.environmentId,
    resourceId: input.payload.environmentRevisionId,
    payload: input.payload,
    payloadHash,
  };
  const files = input.files
    .map((file) => ({
      path: file.path,
      byteLength: file.bytes.byteLength,
      sha256: sha256(file.bytes),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const basis = {
    schemaVersion: 1 as const,
    ownerId: input.payload.environmentId,
    resourceId: input.payload.environmentRevisionId,
    operationId: input.payload.publicationOperationId,
    recordHash: jsonHash(envelope),
    files,
    packageByteLength: files.reduce(
      (total, file) => total + file.byteLength,
      0,
    ),
  };
  const packageHash = jsonHash(basis);
  return {
    payloadHash,
    packageHash,
    packageSeal: { ...basis, packageHash },
  };
};

export const buildProjectEnvironmentPeATestInput =
  async (): Promise<BuildProjectEnvironmentPeAEvidenceV1Input> => {
    const loadedAdapter = await loadProjectAdapterPackageV1(adapterDirectory, {
      requireSingleLaunchTarget: true,
      expectedMainScene: "res://main.tscn",
      requireEmptyLaunchParameters: true,
    });
    const selectedTreeSha256 = digest("baseline-source");
    const sourceIdentityBasis = {
      schemaVersion: 1 as const,
      sourceKind: "project-environment-v1-clean-git" as const,
      headCommit: "1".repeat(40),
      selectedTreeSha256,
      mainScene: "res://main.tscn",
      requestedGodotVersion: "4.7.1" as const,
    };
    const projectSourceIdentity = asSha256DigestV1(
      jsonHash(sourceIdentityBasis),
    );
    const source: VerifiedProjectEnvironmentSourceV1 = {
      sourceKind: sourceIdentityBasis.sourceKind,
      repositoryRoot: "/host/path-must-not-be-exported",
      projectRoot: "/host/path-must-not-be-exported",
      projectPrefix: "",
      headCommit: sourceIdentityBasis.headCommit,
      selectedTreeSha256,
      projectSourceIdentity,
      entries: [],
      mainScene: sourceIdentityBasis.mainScene,
      requestedGodotVersion: sourceIdentityBasis.requestedGodotVersion,
    };
    const sourceId = asSourceId(`source:v1:${projectSourceIdentity}`);
    const taskId = asProjectEnvironmentTaskId("task.pea.builder");
    const attemptId = asProjectInitializationAttemptId("attempt.pea.builder");
    const candidateId = asProjectAdapterCandidateId("candidate.pea.builder");
    const toolchainReceiptId = asProjectToolchainReceiptId(
      `toolchain-receipt:v1:${jsonHash({
        schemaVersion: 1,
        label: "toolchain-receipt",
        value: {
          schemaVersion: 1,
          requested: {
            schemaVersion: 1,
            engineFamily: "godot",
            versionRequirement: "4.7.1",
            platform: "linux-x86_64",
            requiredFeatures: ["headless"],
          },
          status: "realized",
          realized: {
            schemaVersion: 1,
            engineFamily: "godot",
            version: "4.7.1",
            platform: "linux-x86_64",
            artifactDigest: digest("godot-artifact"),
            features: ["headless"],
            renderer: "headless",
          },
          limitations: [],
        },
      })}`,
    );
    const toolchain = ProjectToolchainReceiptV1Schema.parse({
      schemaVersion: 1,
      receiptId: toolchainReceiptId,
      requested: {
        schemaVersion: 1,
        engineFamily: "godot",
        versionRequirement: "4.7.1",
        platform: "linux-x86_64",
        requiredFeatures: ["headless"],
      },
      status: "realized",
      realized: {
        schemaVersion: 1,
        engineFamily: "godot",
        version: "4.7.1",
        platform: "linux-x86_64",
        artifactDigest: digest("godot-artifact"),
        features: ["headless"],
        renderer: "headless",
      },
      limitations: [],
      observedAt: "2026-08-13T00:00:00.000Z",
    });
    const conformanceReceiptId = asAdapterConformanceReceiptId(
      "conformance.v1.builder",
    );
    const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
      schemaVersion: 1,
      adapterRevisionId: asProjectAdapterRevisionId(
        `adapter-revision:v1:${loadedAdapter.candidateSha256}`,
      ),
      adapterId: loadedAdapter.manifest.adapterId,
      sourceId,
      packageDigest: loadedAdapter.candidateSha256,
      manifestDigest: loadedAdapter.manifestSha256,
      implementationDigest: implementationDigest(loadedAdapter.files),
      payloadSchemaDigest: payloadSchemaDigest(loadedAdapter.manifest.schemas),
      sdkDigest: digest("sdk"),
      bridgeDigest: digest("bridge"),
      capabilitySet: loadedAdapter.manifest.modules,
      conformanceReceiptId,
      contentByteLength: loadedAdapter.totalBytes,
      contentFileCount: loadedAdapter.files.length,
    });
    const candidatePackageFiles = await Promise.all(
      loadedAdapter.files.map(async (file) => ({
        path: file.path,
        bytes: new Uint8Array(
          await readFile(join(adapterDirectory, file.path)),
        ),
      })),
    );
    const candidateContentDigest = asSha256DigestV1(
      projectEnvironmentPackageContentDigestV1(candidatePackageFiles),
    );
    const conformance = AdapterConformanceReceiptV1Schema.parse({
      schemaVersion: 1,
      receiptId: conformanceReceiptId,
      taskId,
      attemptId,
      sourceId,
      candidateId,
      candidateDigest: candidateContentDigest,
      toolchainReceiptId,
      capabilitySet: adapterRevision.capabilitySet,
      stateDomains: [
        {
          schemaVersion: 1,
          domainId: "world",
          disposition: "uncontrolled",
          schemaDigest: null,
          limitations: ["synthetic fixture state is not checkpointed"],
        },
      ],
      observations: {
        schemaVersion: 1,
        bridgeHandshakes: 1,
        entityLifecycleRecords: 1,
        stateSamples: 1,
        queries: 2,
        declaredCustomEventTypes: 0,
        observedCustomEventTypes: 0,
        captures: 1,
      },
      coverage: coverage("project-adapter-observations", 4),
      cleanup: cleanup(),
      outcome: "conformed",
      failures: [],
      startedAt: "2026-08-13T00:00:01.000Z",
      completedAt: "2026-08-13T00:00:08.000Z",
    });
    const observerEffect = ObserverEffectReceiptV1Schema.parse({
      schemaVersion: 1,
      receiptId: asObserverEffectReceiptId("observer.v1.builder"),
      taskId,
      attemptId,
      sourceId,
      candidateId,
      status: "measured",
      differences: [],
      alignmentGaps: [],
      unknowns: ["synthetic fixture does not establish semantic equivalence"],
      observedAt: "2026-08-13T00:00:08.000Z",
    });
    const revisionFiles = [
      ...candidatePackageFiles.map((file) => ({
        path: `adapter/${file.path}`,
        bytes: file.bytes,
      })),
      {
        path: "records/adapter-revision.v1.json",
        bytes: canonicalRecordBytes(adapterRevision),
      },
      {
        path: "records/conformance-receipt.v1.json",
        bytes: canonicalRecordBytes(conformance),
      },
      {
        path: "records/observer-effect-receipt.v1.json",
        bytes: canonicalRecordBytes(observerEffect),
      },
    ];
    const contentDigest = asSha256DigestV1(
      projectEnvironmentPackageContentDigestV1(revisionFiles),
    );
    const environmentId = asProjectEnvironmentId("environment.v1.builder");
    const operationId = asProjectEnvironmentOperationId(
      "publication.v1.builder",
    );
    const environmentIdentity = {
      schemaVersion: 1 as const,
      environmentId,
      sourceId,
      adapterRevisionId: adapterRevision.adapterRevisionId,
      sdkDigest: adapterRevision.sdkDigest,
      bridgeDigest: adapterRevision.bridgeDigest,
      toolchainReceiptId,
      conformanceReceiptId: adapterRevision.conformanceReceiptId,
      observerEffectReceiptId: observerEffect.receiptId,
      policyProfileDigest: digest("policy"),
      publicationOperationId: operationId,
      contentDigest,
    };
    const environmentRevision = ProjectEnvironmentRevisionV1Schema.parse({
      ...environmentIdentity,
      environmentRevisionId: `environment-revision:v1:${jsonHash(
        environmentIdentity,
      )}`,
      publishedAt: "2026-08-13T00:00:09.000Z",
    });
    const publicationContent = {
      schemaVersion: 1 as const,
      operationId,
      taskId,
      attemptId,
      environmentId,
      targetEnvironmentRevisionId: environmentRevision.environmentRevisionId,
      expectedCurrentRevisionId: null,
      observedCurrentRevisionId: null,
      realizedCurrentRevisionId: environmentRevision.environmentRevisionId,
      revisionMaterialized: true,
      pointerCommitted: true,
      outcome: "committed" as const,
      failures: [],
      completedAt: "2026-08-13T00:00:11.000Z",
    };
    const publication = EnvironmentPublicationReceiptV1Schema.parse({
      ...publicationContent,
      receiptId: asEnvironmentPublicationReceiptId(
        `publication-receipt:v1:${jsonHash(publicationContent)}`,
      ),
    });
    const bindingEpochId = asEnvironmentBindingEpochId("binding.v1.builder");
    const environmentReference = {
      schemaVersion: 1 as const,
      environmentId,
      environmentRevisionId: environmentRevision.environmentRevisionId,
      sourceId,
      adapterRevisionId: adapterRevision.adapterRevisionId,
      sdkDigest: adapterRevision.sdkDigest,
      bridgeDigest: adapterRevision.bridgeDigest,
      toolchainReceiptId: environmentRevision.toolchainReceiptId,
      conformanceReceiptId: adapterRevision.conformanceReceiptId,
      observerEffectReceiptId: environmentRevision.observerEffectReceiptId,
      policyProfileDigest: environmentRevision.policyProfileDigest,
      contentDigest,
    };
    const environmentBinding = EnvironmentBindingEpochV1Schema.parse({
      schemaVersion: 1,
      bindingEpochId,
      taskId,
      ordinal: 0,
      state: "bound",
      attemptId,
      environment: environmentReference,
      publicationOperationId: operationId,
      publicationReceiptId: publication.receiptId,
      createdAt: publication.completedAt,
      boundAt: "2026-08-13T00:00:12.000Z",
    });
    const sourceHash = digest("candidate-source");
    const buildConfigurationHash = digest("build-configuration");
    const projectHash = asSha256DigestV1(
      sha256(
        `chronorift-project-environment-build-v1\0${sourceHash}\0${buildConfigurationHash}`,
      ),
    );
    const buildId = asBuildId(
      `build:${jsonHash({
        schemaVersion: 1,
        projectHash,
        buildConfigurationHash,
        outputHash: projectHash,
      })}`,
    );
    const build = VNextBuildV1Schema.parse({
      schemaVersion: 1,
      taskId,
      workspaceId: asWorkspaceId("workspace.pea.builder"),
      sourceId: asSourceId(`source:${sourceHash}`),
      buildId,
      sourceHash,
      workspaceDiffHash: jsonHash({
        schemaVersion: 1,
        baselineSourceHash: selectedTreeSha256,
        candidateSourceHash: sourceHash,
      }),
      buildConfigurationHash,
      outputHash: projectHash,
      createdAt: "2026-08-13T00:00:15.000Z",
    });
    const pendingBinding = ProjectEnvironmentBuildBindingV1Schema.parse({
      schemaVersion: 1,
      taskId,
      workspaceId: build.workspaceId,
      sourceId: build.sourceId,
      buildId,
      bindingEpochId,
      environmentRevisionId: environmentRevision.environmentRevisionId,
      adapterRevisionId: adapterRevision.adapterRevisionId,
      payloadSchemaDigest: adapterRevision.payloadSchemaDigest,
      sdkDigest: adapterRevision.sdkDigest,
      bridgeDigest: adapterRevision.bridgeDigest,
      toolchainReceiptId: environmentRevision.toolchainReceiptId,
      compatibilityStatus: "pending",
      compatibilityReceiptId: null,
      createdAt: build.createdAt,
    });
    const preparedBuild: PreparedProjectEnvironmentGodotBuildV1 = {
      build,
      binding: pendingBinding,
      configuredMainScene: source.mainScene,
      projectHash,
      fileCount: 3,
      byteLength: 2_048,
    };
    const compatibilityContent = {
      schemaVersion: 1 as const,
      taskId,
      buildId,
      sourceId: build.sourceId,
      environmentRevisionId: environmentRevision.environmentRevisionId,
      adapterRevisionId: adapterRevision.adapterRevisionId,
      toolchainReceiptId: environmentRevision.toolchainReceiptId,
      bridgeHandshakeObserved: true,
      instrumentedLaunchObserved: true,
      queryObservations: {
        schemaVersion: 1 as const,
        entityQueryObserved: true,
        stateQueryObserved: true,
        entityRows: 1,
        stateRows: 1,
      },
      coverage: coverage("compatibility_observations"),
      capabilitySet: adapterRevision.capabilitySet,
      cleanup: cleanup(),
      outcome: "compatible" as const,
      failures: [],
      observedAt: "2026-08-13T00:00:16.000Z",
    };
    const compatibility = AdapterCompatibilityReceiptV1Schema.parse({
      ...compatibilityContent,
      receiptId: asAdapterCompatibilityReceiptId(
        `compatibility:v1:${jsonHash(compatibilityContent)}`,
      ),
    });
    const baselineCompatibilityContent = {
      ...compatibilityContent,
      buildId: asBuildId("build:baseline.builder"),
      sourceId,
      observedAt: "2026-08-13T00:00:14.000Z",
    };
    const baselineCompatibility = AdapterCompatibilityReceiptV1Schema.parse({
      ...baselineCompatibilityContent,
      receiptId: asAdapterCompatibilityReceiptId(
        `compatibility:v1:${jsonHash(baselineCompatibilityContent)}`,
      ),
    });
    const finalBuildBinding = ProjectEnvironmentBuildBindingV1Schema.parse({
      ...pendingBinding,
      compatibilityStatus: "compatible",
      compatibilityReceiptId: compatibility.receiptId,
    });
    const sessionId = asProjectSessionId("session.pea.builder");
    const goalDigest = digest("queued-goal");
    const turns = [
      ProjectEnvironmentTurnV1Schema.parse({
        schemaVersion: 1,
        turnId: asProjectEnvironmentTurnId("turn.init.builder"),
        taskId,
        sessionId,
        purpose: "environment_initialization",
        attemptId,
        bindingEpochId: null,
        promptDigest: digest("initialization-prompt"),
        queuedGoalDigest: goalDigest,
        budget: turnBudget,
        usageStatus: "partial",
        usage: turnUsage,
        status: "completed",
        terminalCode: null,
        terminalMessage: null,
        startedAt: "2026-08-13T00:00:00.000Z",
        endedAt: "2026-08-13T00:00:10.000Z",
      }),
      ProjectEnvironmentTurnV1Schema.parse({
        schemaVersion: 1,
        turnId: asProjectEnvironmentTurnId("turn.goal.builder"),
        taskId,
        sessionId,
        purpose: "user_goal",
        attemptId: null,
        bindingEpochId,
        promptDigest: goalDigest,
        queuedGoalDigest: null,
        budget: turnBudget,
        usageStatus: "partial",
        usage: turnUsage,
        status: "completed",
        terminalCode: null,
        terminalMessage: null,
        startedAt: "2026-08-13T00:00:13.000Z",
        endedAt: "2026-08-13T00:00:30.000Z",
      }),
    ];
    const runtime = {
      schemaVersion: 1 as const,
      receiptId: asProjectEnvironmentRuntimeObservationReceiptId(
        "runtime-observation-receipt.v1.builder",
      ),
      taskId,
      runtimeId: asRuntimeId("runtime.pea.builder"),
      executionId: asExecutionId("execution.pea.builder"),
      buildId,
      environmentRevisionId: environmentRevision.environmentRevisionId,
      adapterRevisionId: adapterRevision.adapterRevisionId,
      launchTargetId: "main",
      instrumentationMode: "instrumented" as const,
      status: "stopped" as const,
      bridgeHandshakeCount: 1,
      clock: {
        schemaVersion: 1 as const,
        processFrame: 12,
        physicsTick: 6,
        simulationTimeUs: 200_000,
        renderFrame: null,
        hostMonotonicUs: 900_000,
      },
      queryObservations: {
        schemaVersion: 1 as const,
        entityQueryCount: 1,
        entityRows: 1,
        stateQueryCount: 1,
        stateRows: 1,
      },
      captureCount: 1,
      captureWindowIds: [asCaptureWindowId("capture-window.v1.builder")],
      coverage: coverage("candidate_runtime_observations", 4),
      loss: [],
      cleanup: cleanup(),
      outcome: "succeeded" as const,
      failures: [],
      startedAt: "2026-08-13T00:00:17.000Z",
      observedAt: "2026-08-13T00:00:18.000Z",
      completedAt: "2026-08-13T00:00:19.000Z",
    };
    const pinnedCaptures = [
      storedPinnedCapture({
        captureWindowId: runtime.captureWindowIds[0]!,
        taskId,
        runtimeId: runtime.runtimeId,
        executionId: runtime.executionId,
        buildId,
        environmentRevisionId: environmentRevision.environmentRevisionId,
        adapterRevisionId: adapterRevision.adapterRevisionId,
        clock: runtime.clock,
        createdAt: runtime.observedAt,
      }),
    ];
    const candidateReference = ProjectAdapterCandidateReferenceV1Schema.parse({
      schemaVersion: 1,
      taskId,
      attemptId,
      candidateId,
      adapterId: loadedAdapter.manifest.adapterId,
      sourceId,
      contentDigest: candidateContentDigest,
      fileCount: candidatePackageFiles.length,
      byteLength: candidatePackageFiles.reduce(
        (total, file) => total + file.bytes.byteLength,
        0,
      ),
      frozenAt: "2026-08-13T00:00:05.000Z",
    });
    const eventTimes = [
      "2026-08-13T00:00:00.000Z",
      "2026-08-13T00:00:01.000Z",
      "2026-08-13T00:00:05.000Z",
      "2026-08-13T00:00:06.000Z",
      "2026-08-13T00:00:09.000Z",
      "2026-08-13T00:00:11.000Z",
      "2026-08-13T00:00:11.500Z",
      "2026-08-13T00:00:12.000Z",
    ] as const;
    const baseEvent = (sequence: number) => ({
      schemaVersion: 1 as const,
      eventId: asProjectInitializationAttemptEventId(
        `attempt-event.pea.builder.${sequence}`,
      ),
      attemptId,
      taskId,
      sequence,
      occurredAt: eventTimes[sequence]!,
    });
    const attemptEvents = [
      ProjectInitializationAttemptEventV1Schema.parse({
        ...baseEvent(0),
        eventKind: "created",
        predecessorAttemptId: null,
        sessionId,
        sourceId,
        providerId: "openai-codex",
        modelId: "gpt-5.6",
        thinkingLevel: "high",
        budget: turnBudget,
      }),
      ProjectInitializationAttemptEventV1Schema.parse({
        ...baseEvent(1),
        eventKind: "agent_running",
      }),
      ProjectInitializationAttemptEventV1Schema.parse({
        ...baseEvent(2),
        eventKind: "candidate_frozen",
        candidate: candidateReference,
      }),
      ProjectInitializationAttemptEventV1Schema.parse({
        ...baseEvent(3),
        eventKind: "validating",
      }),
      ProjectInitializationAttemptEventV1Schema.parse({
        ...baseEvent(4),
        eventKind: "publishing",
        operationId,
      }),
      ProjectInitializationAttemptEventV1Schema.parse({
        ...baseEvent(5),
        eventKind: "publication_committed",
        operationId,
        environmentRevisionId: environmentRevision.environmentRevisionId,
        adapterRevisionId: adapterRevision.adapterRevisionId,
        publicationReceiptId: publication.receiptId,
      }),
      ProjectInitializationAttemptEventV1Schema.parse({
        ...baseEvent(6),
        eventKind: "binding",
      }),
      ProjectInitializationAttemptEventV1Schema.parse({
        ...baseEvent(7),
        eventKind: "succeeded",
        bindingEpochId,
      }),
    ];
    const initializationAttempt =
      foldProjectInitializationAttemptV1(attemptEvents);
    const firstStoreParent = await mkdtemp(
      join(tmpdir(), "chronorift-pe-a-first-store-"),
    );
    temporaryRoots.push(firstStoreParent);
    const firstStoreRoot = join(firstStoreParent, "store");
    const firstTaskStore = new ProjectEnvironmentTaskStoreV1({
      storeRoot: firstStoreRoot,
      taskId,
    });
    await firstTaskStore.create();
    await firstTaskStore.putCandidateOnce(
      candidateReference,
      candidatePackageFiles,
    );
    await firstTaskStore.putPinnedCaptureOnce(
      pinnedCaptures[0]!.payload,
      pinnedCaptures[0]!.records,
    );
    await firstTaskStore.putInitializationAttemptOnce(initializationAttempt);
    await firstTaskStore.putToolchainReceiptOnce(toolchain);
    await firstTaskStore.putPublicationReceiptOnce(publication);
    await firstTaskStore.putCompatibilityReceiptOnce(baselineCompatibility);
    await firstTaskStore.putCompatibilityReceiptOnce(compatibility);
    await firstTaskStore.putRuntimeObservationReceiptOnce(runtime);
    for (const event of attemptEvents) {
      await firstTaskStore.appendAttemptEvent(event);
    }
    await firstTaskStore.appendBindingEpoch(environmentBinding);
    for (const turn of turns) await firstTaskStore.appendTurn(turn);
    const firstTaskInventory = await firstTaskStore.freezeEvidenceInventory();

    const reuseTaskId = asProjectEnvironmentTaskId("task.pea.reuse.builder");
    const reuseSessionId = asProjectSessionId("session.pea.reuse.builder");
    const reuseBindingEpochId = asEnvironmentBindingEpochId(
      "binding.v1.reuse.builder",
    );
    const reuseBuildConfigurationHash = digest("reuse-build-configuration");
    const reuseProjectHash = asSha256DigestV1(
      sha256(
        `chronorift-project-environment-build-v1\0${selectedTreeSha256}\0${reuseBuildConfigurationHash}`,
      ),
    );
    const reuseBuildId = asBuildId(
      `build:${jsonHash({
        schemaVersion: 1,
        projectHash: reuseProjectHash,
        buildConfigurationHash: reuseBuildConfigurationHash,
        outputHash: reuseProjectHash,
      })}`,
    );
    const reuseBuild = VNextBuildV1Schema.parse({
      schemaVersion: 1,
      taskId: reuseTaskId,
      workspaceId: asWorkspaceId("workspace.pea.reuse.builder"),
      sourceId: asSourceId(`source:${selectedTreeSha256}`),
      buildId: reuseBuildId,
      sourceHash: selectedTreeSha256,
      workspaceDiffHash: jsonHash({
        schemaVersion: 1,
        baselineSourceHash: selectedTreeSha256,
        candidateSourceHash: selectedTreeSha256,
      }),
      buildConfigurationHash: reuseBuildConfigurationHash,
      outputHash: reuseProjectHash,
      createdAt: "2026-08-13T00:00:31.000Z",
    });
    const reusePendingBinding = ProjectEnvironmentBuildBindingV1Schema.parse({
      schemaVersion: 1,
      taskId: reuseTaskId,
      workspaceId: reuseBuild.workspaceId,
      sourceId: reuseBuild.sourceId,
      buildId: reuseBuildId,
      bindingEpochId: reuseBindingEpochId,
      environmentRevisionId: environmentRevision.environmentRevisionId,
      adapterRevisionId: adapterRevision.adapterRevisionId,
      payloadSchemaDigest: adapterRevision.payloadSchemaDigest,
      sdkDigest: adapterRevision.sdkDigest,
      bridgeDigest: adapterRevision.bridgeDigest,
      toolchainReceiptId: environmentRevision.toolchainReceiptId,
      compatibilityStatus: "pending",
      compatibilityReceiptId: null,
      createdAt: reuseBuild.createdAt,
    });
    const reusePreparedBuild: PreparedProjectEnvironmentGodotBuildV1 = {
      build: reuseBuild,
      binding: reusePendingBinding,
      configuredMainScene: source.mainScene,
      projectHash: reuseProjectHash,
      fileCount: 3,
      byteLength: 2_048,
    };
    const reuseCompatibilityContent = {
      ...compatibilityContent,
      taskId: reuseTaskId,
      buildId: reuseBuildId,
      sourceId: reuseBuild.sourceId,
      observedAt: "2026-08-13T00:00:32.000Z",
    };
    const reuseCompatibility = AdapterCompatibilityReceiptV1Schema.parse({
      ...reuseCompatibilityContent,
      receiptId: asAdapterCompatibilityReceiptId(
        `compatibility:v1:${jsonHash(reuseCompatibilityContent)}`,
      ),
    });
    const reuseFinalBuildBinding = ProjectEnvironmentBuildBindingV1Schema.parse(
      {
        ...reusePendingBinding,
        compatibilityStatus: "compatible",
        compatibilityReceiptId: reuseCompatibility.receiptId,
      },
    );
    const reuseReceiptContent = {
      schemaVersion: 1 as const,
      taskId: reuseTaskId,
      sessionId: reuseSessionId,
      sourceId,
      buildId: reuseBuildId,
      buildSourceId: reuseBuild.sourceId,
      environmentRevisionId: environmentRevision.environmentRevisionId,
      adapterRevisionId: adapterRevision.adapterRevisionId,
      toolchainReceiptId: environmentRevision.toolchainReceiptId,
      sdkDigest: environmentRevision.sdkDigest,
      bridgeDigest: environmentRevision.bridgeDigest,
      policyProfileDigest: environmentRevision.policyProfileDigest,
      observedCurrentRevisionId: environmentRevision.environmentRevisionId,
      compatibilityReceiptId: reuseCompatibility.receiptId,
      schemaBindingValidated: true,
      adapterPackageValidated: true,
      quickSmokeCompatible: true,
      cleanup: cleanup(),
      outcome: "reused" as const,
      failures: [],
      observedAt: "2026-08-13T00:00:33.000Z",
    };
    const reuseReceipt = ProjectEnvironmentReuseReceiptV1Schema.parse({
      ...reuseReceiptContent,
      receiptId: asProjectEnvironmentReuseReceiptId(
        `reuse:v1:${jsonHash(reuseReceiptContent)}`,
      ),
    });
    const reuseBinding = EnvironmentBindingEpochV1Schema.parse({
      schemaVersion: 1,
      bindingEpochId: reuseBindingEpochId,
      taskId: reuseTaskId,
      ordinal: 0,
      state: "reused",
      sessionId: reuseSessionId,
      environment: environmentReference,
      reuseReceiptId: reuseReceipt.receiptId,
      compatibilityReceiptId: reuseCompatibility.receiptId,
      createdAt: reuseCompatibility.observedAt,
      boundAt: reuseReceipt.observedAt,
    });
    const reuseTurn = ProjectEnvironmentTurnV1Schema.parse({
      schemaVersion: 1,
      turnId: asProjectEnvironmentTurnId("turn.goal.reuse.builder"),
      taskId: reuseTaskId,
      sessionId: reuseSessionId,
      purpose: "user_goal",
      attemptId: null,
      bindingEpochId: reuseBindingEpochId,
      promptDigest: digest("reuse-goal"),
      queuedGoalDigest: null,
      budget: turnBudget,
      usageStatus: "partial",
      usage: turnUsage,
      status: "completed",
      terminalCode: null,
      terminalMessage: null,
      startedAt: "2026-08-13T00:00:34.000Z",
      endedAt: "2026-08-13T00:00:50.000Z",
    });
    const reuseRuntime = {
      ...runtime,
      receiptId: asProjectEnvironmentRuntimeObservationReceiptId(
        "runtime-observation-receipt.v1.reuse.builder",
      ),
      taskId: reuseTaskId,
      runtimeId: asRuntimeId("runtime.pea.reuse.builder"),
      executionId: asExecutionId("execution.pea.reuse.builder"),
      buildId: reuseBuildId,
      captureWindowIds: [asCaptureWindowId("capture-window.v1.reuse.builder")],
      startedAt: "2026-08-13T00:00:36.000Z",
      observedAt: "2026-08-13T00:00:38.000Z",
      completedAt: "2026-08-13T00:00:40.000Z",
    };
    const reusePinnedCaptures = [
      storedPinnedCapture({
        captureWindowId: reuseRuntime.captureWindowIds[0]!,
        taskId: reuseTaskId,
        runtimeId: reuseRuntime.runtimeId,
        executionId: reuseRuntime.executionId,
        buildId: reuseBuildId,
        environmentRevisionId: environmentRevision.environmentRevisionId,
        adapterRevisionId: adapterRevision.adapterRevisionId,
        clock: reuseRuntime.clock,
        createdAt: reuseRuntime.observedAt,
      }),
    ];
    const reuseStoreParent = await mkdtemp(
      join(tmpdir(), "chronorift-pe-a-reuse-store-"),
    );
    temporaryRoots.push(reuseStoreParent);
    const reuseStoreRoot = join(reuseStoreParent, "store");
    const reuseTaskStore = new ProjectEnvironmentTaskStoreV1({
      storeRoot: reuseStoreRoot,
      taskId: reuseTaskId,
    });
    await reuseTaskStore.create();
    const reuseToolchain = ProjectToolchainReceiptV1Schema.parse({
      ...toolchain,
      observedAt: "2026-08-13T00:00:13.500Z",
    });
    await reuseTaskStore.putPinnedCaptureOnce(
      reusePinnedCaptures[0]!.payload,
      reusePinnedCaptures[0]!.records,
    );
    await reuseTaskStore.putToolchainReceiptOnce(reuseToolchain);
    await reuseTaskStore.putReuseReceiptOnce(reuseReceipt);
    await reuseTaskStore.putCompatibilityReceiptOnce(reuseCompatibility);
    await reuseTaskStore.putRuntimeObservationReceiptOnce(reuseRuntime);
    await reuseTaskStore.appendBindingEpoch(reuseBinding);
    await reuseTaskStore.appendTurn(reuseTurn);
    const reuseTaskInventory = await reuseTaskStore.freezeEvidenceInventory();
    return {
      source,
      loadedAdapter,
      adapterRevision,
      toolchain,
      environmentRevision,
      revisionFiles,
      revisionPackage: storedRevisionPackage({
        payload: environmentRevision,
        files: revisionFiles,
      }),
      publication,
      initializationAttempt,
      taskInventory: firstTaskInventory,
      environmentBinding,
      preparedBuild,
      finalBuildBinding,
      compatibility,
      turns,
      runtime,
      pinnedCaptures,
      reuse: {
        toolchain: reuseToolchain,
        receipt: reuseReceipt,
        environmentBinding: reuseBinding,
        preparedBuild: reusePreparedBuild,
        finalBuildBinding: reuseFinalBuildBinding,
        compatibility: reuseCompatibility,
        turns: [reuseTurn],
        runtime: reuseRuntime,
        pinnedCaptures: reusePinnedCaptures,
        taskInventory: reuseTaskInventory,
        goalDelivered: true,
      },
      goalDelivered: true,
    };
  };

export const cleanupProjectEnvironmentPeATestInputs =
  async (): Promise<void> => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  };
