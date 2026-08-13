import { createHash } from "node:crypto";

import {
  AdapterConformanceReceiptV1Schema,
  ObserverEffectReceiptV1Schema,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentRevisionV1Schema,
  asAdapterConformanceReceiptId,
  asObserverEffectReceiptId,
  asProjectAdapterRevisionId,
  asProjectEnvironmentRevisionId,
  asSha256DigestV1,
  type AdapterId,
  type ObserverEffectDifferenceV1,
  type PROJECT_CAPABILITY_MODULE_NAMES_V1,
  type ProjectAdapterCandidateReferenceV1,
  type ProjectAdapterRevisionV1,
  type ProjectEnvironmentId,
  type ProjectEnvironmentOperationId,
  type ProjectEnvironmentRevisionV1,
  type ProjectToolchainReceiptId,
  type Sha256DigestV1,
} from "@chronorift/domain";
import {
  PROJECT_ADAPTER_REQUIRED_MODULES_V1,
  type ProjectAdapterManifestV1,
} from "@chronorift/godot-protocol";
import {
  loadProjectAdapterPackageV1,
  type LoadedProjectAdapterPackageV1,
} from "@chronorift/godot-adapter";
import {
  canonicalJson,
  contentHash,
  projectEnvironmentPackageContentDigestV1,
} from "@chronorift/json-artifacts";

import { PROJECT_ADAPTER_REFERENCE_PLACEHOLDER_SEMANTICS_V1 } from "./project-adapter-reference-template.js";

export interface ProjectEnvironmentProcessObservationV1 {
  readonly launched: boolean;
  readonly importSucceeded: boolean;
  readonly stableWindowObserved: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdoutSha256: Sha256DigestV1;
  readonly stderrSha256: Sha256DigestV1;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly elapsedMonotonicMs: number;
  readonly resourceUsage: {
    readonly cpuUsageUsec: number;
    readonly memoryPeakBytes: number | null;
    readonly pidsPeak: number | null;
  };
  readonly sourceIdentityReverified: boolean;
  readonly processTreeTerminated: boolean;
  readonly isolationGroupEmpty: boolean;
  readonly scopeRemoved: boolean;
  readonly scratchRemoved: boolean;
  readonly storageReconciled: boolean;
}

export interface ProjectEnvironmentInstrumentedObservationV1 extends ProjectEnvironmentProcessObservationV1 {
  readonly bridgeHandshakeCount: number;
  readonly entityLifecycleRecords: number;
  readonly stateSamples: number;
  readonly queries: number;
  readonly observedCustomEventTypeIds: readonly string[];
  readonly captures: number;
  readonly stateDomainIds: readonly string[];
  readonly transportRecords: number;
  readonly droppedRecords: number;
  readonly overwrittenRecords: number;
  readonly semanticCoverage: "declared" | "partial" | "unknown";
  readonly runtimeFailures: readonly string[];
  readonly bridgeExited: boolean;
}

export interface ProjectEnvironmentConformanceDriverV1 {
  runVanilla(): Promise<ProjectEnvironmentProcessObservationV1>;
  runBridgeOnly(): Promise<ProjectEnvironmentProcessObservationV1>;
  runInstrumented(
    loaded: LoadedProjectAdapterPackageV1,
  ): Promise<ProjectEnvironmentInstrumentedObservationV1>;
}

export interface ValidateProjectAdapterCandidateV1Request {
  readonly candidateDirectory: string;
  readonly candidateFiles: readonly {
    readonly path: string;
    readonly bytes: Uint8Array;
  }[];
  readonly candidate: ProjectAdapterCandidateReferenceV1;
  readonly adapterId: AdapterId;
  readonly environmentId: ProjectEnvironmentId;
  readonly publicationOperationId: ProjectEnvironmentOperationId;
  readonly toolchainReceiptId: ProjectToolchainReceiptId;
  readonly expectedMainScene: string;
  readonly sdkDigest: Sha256DigestV1;
  readonly bridgeDigest: Sha256DigestV1;
  readonly policyProfileDigest: Sha256DigestV1;
}

export interface ProjectEnvironmentConformanceClockV1 {
  now(): string;
}

export interface ValidatedProjectAdapterCandidateV1 {
  readonly loaded: LoadedProjectAdapterPackageV1;
  readonly conformance: ReturnType<
    typeof AdapterConformanceReceiptV1Schema.parse
  >;
  readonly observerEffect: ReturnType<
    typeof ObserverEffectReceiptV1Schema.parse
  >;
  readonly adapterRevision: ProjectAdapterRevisionV1;
  readonly environmentRevision: ProjectEnvironmentRevisionV1;
  readonly revisionFiles: readonly {
    readonly path: string;
    readonly bytes: Uint8Array;
  }[];
}

const hashText = (label: string, value: string): Sha256DigestV1 =>
  asSha256DigestV1(
    createHash("sha256").update(label).update("\0").update(value).digest("hex"),
  );

const jsonFact = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Parameters<typeof contentHash>[0];

const digestFact = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(jsonFact(value)));

const lifecycleFact = (value: ProjectEnvironmentProcessObservationV1) => ({
  schemaVersion: 1 as const,
  launched: value.launched,
  importSucceeded: value.importSucceeded,
  stableWindowObserved: value.stableWindowObserved,
  exitCode: value.exitCode,
  signal: value.signal,
  timedOut: value.timedOut,
  sourceIdentityReverified: value.sourceIdentityReverified,
  processTreeTerminated: value.processTreeTerminated,
  isolationGroupEmpty: value.isolationGroupEmpty,
  scopeRemoved: value.scopeRemoved,
  scratchRemoved: value.scratchRemoved,
  storageReconciled: value.storageReconciled,
  elapsedMonotonicMs: value.elapsedMonotonicMs,
});

const resourceUsageFact = (value: ProjectEnvironmentProcessObservationV1) => ({
  schemaVersion: 1 as const,
  ...value.resourceUsage,
});

const resourceUsageComplete = (
  value: ProjectEnvironmentProcessObservationV1,
): boolean =>
  value.resourceUsage.memoryPeakBytes !== null &&
  value.resourceUsage.pidsPeak !== null;

const pushDifference = (
  differences: ObserverEffectDifferenceV1[],
  input: Omit<ObserverEffectDifferenceV1, "schemaVersion">,
): void => {
  if (input.baselineDigest === input.instrumentedDigest) return;
  differences.push({ schemaVersion: 1, ...input });
};

const candidateContentDigest = (
  loaded: LoadedProjectAdapterPackageV1,
): Sha256DigestV1 =>
  asSha256DigestV1(
    contentHash(
      jsonFact({
        schemaVersion: 1,
        files: loaded.files
          .map((file) => ({
            path: file.path,
            byteLength: file.bytes,
            sha256: file.sha256,
          }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      }),
    ),
  );

const canonicalRecordBytes = (value: unknown): Uint8Array =>
  Buffer.from(`${canonicalJson(jsonFact(value))}\n`, "utf8");

const moduleSetFromManifest = (
  manifest: ProjectAdapterManifestV1,
): {
  readonly schemaVersion: 1;
  readonly modules: readonly {
    readonly schemaVersion: 1;
    readonly module: (typeof PROJECT_CAPABILITY_MODULE_NAMES_V1)[number];
    readonly status:
      | "implemented"
      | "unsupported"
      | "unavailable_by_policy"
      | "unavailable_by_environment"
      | "degraded";
    readonly protocolVersion: string | null;
    readonly limitations: readonly string[];
  }[];
} => ({
  schemaVersion: 1,
  modules: manifest.modules.modules.map((module) => ({ ...module })),
});

const cleanupFrom = (value: ProjectEnvironmentInstrumentedObservationV1) => ({
  schemaVersion: 1 as const,
  processTreeTerminated: value.processTreeTerminated,
  runtimeExited:
    value.launched && value.exitCode === 0 && value.signal === null,
  bridgeExited: value.bridgeExited,
  isolationGroupEmpty: value.isolationGroupEmpty,
  scopeRemoved: value.scopeRemoved,
  scratchRemoved: value.scratchRemoved,
  storageReconciled: value.storageReconciled,
});

const processFailure = (
  label: string,
  value: ProjectEnvironmentProcessObservationV1,
): string | null =>
  value.launched &&
  value.importSucceeded &&
  value.stableWindowObserved &&
  !value.timedOut &&
  value.signal === null &&
  value.exitCode === 0 &&
  value.sourceIdentityReverified &&
  value.processTreeTerminated &&
  value.isolationGroupEmpty &&
  value.scopeRemoved &&
  value.scratchRemoved &&
  value.storageReconciled
    ? null
    : `${label} smoke did not satisfy its bounded process and cleanup contract`;

const schemaDigest = (
  loaded: LoadedProjectAdapterPackageV1,
  schemaId: string,
): Sha256DigestV1 => {
  const declaration = loaded.manifest.schemas.find(
    (schema) => schema.schemaId === schemaId,
  );
  if (declaration === undefined) {
    throw new Error(
      `adapter state domain references missing schema ${schemaId}`,
    );
  }
  return asSha256DigestV1(declaration.sha256);
};

/**
 * Authoritative ordering is fixed here; Agent investigation order is not. The
 * returned facts prove only schema-valid, identity-bound observations during
 * these bounded runs, not semantic truth about the project.
 */
export async function validateProjectAdapterCandidateV1(
  input: ValidateProjectAdapterCandidateV1Request,
  driver: ProjectEnvironmentConformanceDriverV1,
  clock: ProjectEnvironmentConformanceClockV1 = {
    now: () => new Date().toISOString(),
  },
): Promise<ValidatedProjectAdapterCandidateV1> {
  const loaded = await loadProjectAdapterPackageV1(input.candidateDirectory, {
    requireSingleLaunchTarget: true,
    expectedMainScene: input.expectedMainScene,
    requireEmptyLaunchParameters: true,
    requiredImplementedModules: PROJECT_ADAPTER_REQUIRED_MODULES_V1,
  });
  if (
    candidateContentDigest(loaded) !== input.candidate.contentDigest ||
    loaded.files.length !== input.candidate.fileCount ||
    loaded.totalBytes !== input.candidate.byteLength ||
    loaded.manifest.adapterId !== input.adapterId
  ) {
    throw new Error(
      "loaded ProjectAdapter package does not match the frozen candidate identity",
    );
  }
  const candidateFiles = input.candidateFiles
    .map((file) => ({ path: file.path, bytes: Uint8Array.from(file.bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const suppliedCandidateDigest = asSha256DigestV1(
    projectEnvironmentPackageContentDigestV1(candidateFiles),
  );
  if (suppliedCandidateDigest !== input.candidate.contentDigest) {
    throw new Error(
      "supplied ProjectAdapter bytes do not match the frozen candidate identity",
    );
  }
  const placeholder = PROJECT_ADAPTER_REFERENCE_PLACEHOLDER_SEMANTICS_V1;
  const hasProjectSpecificEntityType = loaded.manifest.entityTypes.some(
    (entityType) =>
      entityType.entityTypeId !== placeholder.entityTypeId ||
      entityType.schemaId !== placeholder.entitySchemaId,
  );
  const hasProjectSpecificStateDomain = loaded.manifest.stateDomains.some(
    (stateDomain) =>
      stateDomain.stateDomainId !== placeholder.stateDomainId ||
      stateDomain.schemaId !== placeholder.stateSchemaId,
  );
  if (!hasProjectSpecificEntityType || !hasProjectSpecificStateDomain) {
    throw new Error(
      "ProjectAdapter candidate still uses the structural reference placeholder instead of project-specific entity and state semantics",
    );
  }

  const startedAt = clock.now();
  const vanilla = await driver.runVanilla();
  const bridgeOnly = await driver.runBridgeOnly();
  const instrumented = await driver.runInstrumented(loaded);
  const completedAt = clock.now();
  const failures = [
    processFailure("vanilla", vanilla),
    processFailure("bridge-only", bridgeOnly),
    processFailure("instrumented", instrumented),
    ...instrumented.runtimeFailures,
  ].filter((failure): failure is string => failure !== null);
  const requiredModules = new Set<string>(PROJECT_ADAPTER_REQUIRED_MODULES_V1);
  for (const module of loaded.manifest.modules.modules) {
    if (
      !requiredModules.has(module.module) &&
      (module.status === "implemented" || module.status === "degraded")
    ) {
      failures.push(
        `optional module ${module.module} claims ${module.status}, but PE-A external-project conformance does not exercise that module`,
      );
    }
  }
  for (const domain of loaded.manifest.stateDomains) {
    if (domain.checkpointDisposition === "captured") {
      failures.push(
        `state domain ${domain.stateDomainId} claims captured checkpoint state, but PE-A external-project conformance does not exercise snapshot and restore`,
      );
    }
  }
  if (
    instrumented.bridgeHandshakeCount < 1 ||
    instrumented.entityLifecycleRecords <
      loaded.manifest.smoke.minimumEntityLifecycleRecords ||
    instrumented.stateSamples < loaded.manifest.smoke.minimumStateSamples ||
    instrumented.queries < 1 ||
    instrumented.captures < 1 ||
    !loaded.manifest.smoke.requiredStateDomainIds.every((id) =>
      instrumented.stateDomainIds.includes(id),
    ) ||
    !loaded.manifest.smoke.requiredCustomEventTypeIds.every((id) =>
      instrumented.observedCustomEventTypeIds.includes(id),
    )
  ) {
    failures.push(
      "instrumented smoke did not observe the adapter-declared Ready minimum",
    );
  }
  if (instrumented.droppedRecords > 0 || instrumented.overwrittenRecords > 0) {
    failures.push("instrumented Ready smoke reported transport history loss");
  }
  if (instrumented.semanticCoverage !== "declared") {
    failures.push(
      `instrumented Ready smoke reported ${instrumented.semanticCoverage} adapter semantic coverage`,
    );
  }

  const capabilitySet = moduleSetFromManifest(loaded.manifest);
  const stateDomains = loaded.manifest.stateDomains.map((domain) => ({
    schemaVersion: 1 as const,
    domainId: domain.stateDomainId,
    disposition: domain.checkpointDisposition,
    schemaDigest:
      domain.checkpointDisposition === "captured"
        ? schemaDigest(loaded, domain.schemaId)
        : null,
    limitations:
      domain.checkpointDisposition === "captured"
        ? []
        : [`adapter declares ${domain.checkpointDisposition}`],
  }));
  const conformanceReceiptId = asAdapterConformanceReceiptId(
    `conformance:v1:${contentHash(
      jsonFact({
        schemaVersion: 1,
        taskId: input.candidate.taskId,
        candidateId: input.candidate.candidateId,
        candidateDigest: input.candidate.contentDigest,
        vanilla,
        bridgeOnly,
        instrumented,
      }),
    )}`,
  );
  const conformance = AdapterConformanceReceiptV1Schema.parse({
    schemaVersion: 1,
    receiptId: conformanceReceiptId,
    taskId: input.candidate.taskId,
    attemptId: input.candidate.attemptId,
    sourceId: input.candidate.sourceId,
    candidateId: input.candidate.candidateId,
    candidateDigest: input.candidate.contentDigest,
    toolchainReceiptId: input.toolchainReceiptId,
    capabilitySet,
    stateDomains,
    observations: {
      schemaVersion: 1,
      bridgeHandshakes: instrumented.bridgeHandshakeCount,
      entityLifecycleRecords: instrumented.entityLifecycleRecords,
      stateSamples: instrumented.stateSamples,
      queries: instrumented.queries,
      declaredCustomEventTypes:
        loaded.manifest.smoke.requiredCustomEventTypeIds.length,
      observedCustomEventTypes: instrumented.observedCustomEventTypeIds.filter(
        (id) => loaded.manifest.smoke.requiredCustomEventTypeIds.includes(id),
      ).length,
      captures: instrumented.captures,
    },
    coverage: [
      {
        schemaVersion: 1,
        channelId: "project-adapter-observations",
        status:
          instrumented.droppedRecords === 0 &&
          instrumented.overwrittenRecords === 0 &&
          instrumented.semanticCoverage === "declared"
            ? "complete"
            : "incomplete",
        observedRecords: instrumented.transportRecords,
        droppedRecords: instrumented.droppedRecords,
        overwrittenRecords: instrumented.overwrittenRecords,
        limitations:
          instrumented.droppedRecords === 0 &&
          instrumented.overwrittenRecords === 0 &&
          instrumented.semanticCoverage === "declared"
            ? []
            : [
                instrumented.semanticCoverage === "declared"
                  ? "transport loss occurred during conformance"
                  : `adapter semantic coverage was ${instrumented.semanticCoverage}`,
              ],
      },
    ],
    cleanup: cleanupFrom(instrumented),
    outcome: failures.length === 0 ? "conformed" : "rejected",
    failures,
    startedAt,
    completedAt,
  });
  if (conformance.outcome !== "conformed") {
    throw new Error(
      `ProjectAdapter conformance rejected: ${failures.join("; ")}`,
    );
  }

  const differences: ObserverEffectDifferenceV1[] = [];
  if (!vanilla.stdoutTruncated && !bridgeOnly.stdoutTruncated) {
    pushDifference(differences, {
      comparison: "vanilla_to_bridge",
      dimension: "process_stdout",
      baselineDigest: vanilla.stdoutSha256,
      instrumentedDigest: bridgeOnly.stdoutSha256,
      description:
        "Vanilla and bridge-only bounded Host-observable stdout differed; SceneTree was not observed in vanilla.",
    });
  }
  if (!vanilla.stderrTruncated && !bridgeOnly.stderrTruncated) {
    pushDifference(differences, {
      comparison: "vanilla_to_bridge",
      dimension: "process_stderr",
      baselineDigest: vanilla.stderrSha256,
      instrumentedDigest: bridgeOnly.stderrSha256,
      description:
        "Vanilla and bridge-only bounded Host-observable stderr differed; SceneTree was not observed in vanilla.",
    });
  }
  if (!bridgeOnly.stdoutTruncated && !instrumented.stdoutTruncated) {
    pushDifference(differences, {
      comparison: "bridge_to_instrumented",
      dimension: "process_stdout",
      baselineDigest: bridgeOnly.stdoutSha256,
      instrumentedDigest: instrumented.stdoutSha256,
      description:
        "Bridge-only and adapter-instrumented bounded Host-observable stdout differed.",
    });
  }
  if (!bridgeOnly.stderrTruncated && !instrumented.stderrTruncated) {
    pushDifference(differences, {
      comparison: "bridge_to_instrumented",
      dimension: "process_stderr",
      baselineDigest: bridgeOnly.stderrSha256,
      instrumentedDigest: instrumented.stderrSha256,
      description:
        "Bridge-only and adapter-instrumented bounded Host-observable stderr differed.",
    });
  }
  pushDifference(differences, {
    comparison: "vanilla_to_bridge",
    dimension: "process_lifecycle",
    baselineDigest: digestFact(lifecycleFact(vanilla)),
    instrumentedDigest: digestFact(lifecycleFact(bridgeOnly)),
    description: `Vanilla and bridge-only Host-observable lifecycle or elapsed time differed: baseline=${canonicalJson(jsonFact(lifecycleFact(vanilla)))}; instrumented=${canonicalJson(jsonFact(lifecycleFact(bridgeOnly)))}.`,
  });
  pushDifference(differences, {
    comparison: "bridge_to_instrumented",
    dimension: "process_lifecycle",
    baselineDigest: digestFact(lifecycleFact(bridgeOnly)),
    instrumentedDigest: digestFact(lifecycleFact(instrumented)),
    description: `Bridge-only and adapter-instrumented Host-observable lifecycle or elapsed time differed: baseline=${canonicalJson(jsonFact(lifecycleFact(bridgeOnly)))}; instrumented=${canonicalJson(jsonFact(lifecycleFact(instrumented)))}.`,
  });
  if (resourceUsageComplete(vanilla) && resourceUsageComplete(bridgeOnly)) {
    pushDifference(differences, {
      comparison: "vanilla_to_bridge",
      dimension: "resource_usage",
      baselineDigest: digestFact(resourceUsageFact(vanilla)),
      instrumentedDigest: digestFact(resourceUsageFact(bridgeOnly)),
      description: `Vanilla and bridge-only observed CPU, memory-peak, or process-peak usage differed: baseline=${canonicalJson(jsonFact(resourceUsageFact(vanilla)))}; instrumented=${canonicalJson(jsonFact(resourceUsageFact(bridgeOnly)))}.`,
    });
  }
  if (
    resourceUsageComplete(bridgeOnly) &&
    resourceUsageComplete(instrumented)
  ) {
    pushDifference(differences, {
      comparison: "bridge_to_instrumented",
      dimension: "resource_usage",
      baselineDigest: digestFact(resourceUsageFact(bridgeOnly)),
      instrumentedDigest: digestFact(resourceUsageFact(instrumented)),
      description: `Bridge-only and adapter-instrumented observed CPU, memory-peak, or process-peak usage differed: baseline=${canonicalJson(jsonFact(resourceUsageFact(bridgeOnly)))}; instrumented=${canonicalJson(jsonFact(resourceUsageFact(instrumented)))}.`,
    });
  }
  const observerRuns = [
    ["vanilla", vanilla],
    ["bridge-only", bridgeOnly],
    ["instrumented", instrumented],
  ] as const;
  const alignmentGaps = observerRuns.flatMap(([label, observation]) => [
    ...(observation.stdoutTruncated
      ? [`${label} stdout capture was truncated.`]
      : []),
    ...(observation.stderrTruncated
      ? [`${label} stderr capture was truncated.`]
      : []),
    ...(observation.resourceUsage.memoryPeakBytes === null
      ? [`${label} memory-peak usage was unavailable.`]
      : []),
    ...(observation.resourceUsage.pidsPeak === null
      ? [`${label} process-peak usage was unavailable.`]
      : []),
  ]);
  const observerStatus =
    alignmentGaps.length === 0
      ? ("measured" as const)
      : ("incomplete" as const);
  const observerUnknowns = [
    "Godot project and adapter share one untrusted runtime principal.",
    "No observed smoke difference does not prove absence of observer effect.",
    "Task aggregate storage is cumulative and is not interpreted as per-smoke resource usage.",
    ...(alignmentGaps.length === 0
      ? []
      : [
          "Observer-effect comparison is incomplete where output or resource measurements were unavailable.",
        ]),
  ];
  const observerEffect = ObserverEffectReceiptV1Schema.parse({
    schemaVersion: 1,
    receiptId: asObserverEffectReceiptId(
      `observer:v1:${contentHash(
        jsonFact({
          schemaVersion: 1,
          candidateDigest: input.candidate.contentDigest,
          vanilla,
          bridgeOnly,
          instrumented,
          status: observerStatus,
          differences,
          alignmentGaps,
          unknowns: observerUnknowns,
        }),
      )}`,
    ),
    taskId: input.candidate.taskId,
    attemptId: input.candidate.attemptId,
    sourceId: input.candidate.sourceId,
    candidateId: input.candidate.candidateId,
    status: observerStatus,
    differences,
    alignmentGaps,
    unknowns: observerUnknowns,
    observedAt: completedAt,
  });

  const adapterRevisionId = asProjectAdapterRevisionId(
    `adapter-revision:v1:${loaded.candidateSha256}`,
  );
  const implementationDigest = hashText(
    "project-adapter-implementation-v1",
    loaded.files
      .filter((file) => file.path.endsWith(".gd"))
      .map((file) => `${file.path}:${file.sha256}`)
      .join("\n"),
  );
  const payloadSchemaDigest = hashText(
    "project-adapter-payload-schemas-v1",
    loaded.manifest.schemas
      .map((schema) => `${schema.schemaId}:${schema.sha256}`)
      .join("\n"),
  );
  const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
    schemaVersion: 1,
    adapterRevisionId,
    adapterId: input.adapterId,
    sourceId: input.candidate.sourceId,
    packageDigest: loaded.candidateSha256,
    manifestDigest: loaded.manifestSha256,
    implementationDigest,
    payloadSchemaDigest,
    sdkDigest: input.sdkDigest,
    bridgeDigest: input.bridgeDigest,
    capabilitySet,
    conformanceReceiptId,
    contentByteLength: loaded.totalBytes,
    contentFileCount: loaded.files.length,
  });
  const environmentContent = {
    schemaVersion: 1 as const,
    environmentId: input.environmentId,
    sourceId: input.candidate.sourceId,
    adapterRevisionId,
    sdkDigest: input.sdkDigest,
    bridgeDigest: input.bridgeDigest,
    toolchainReceiptId: input.toolchainReceiptId,
    conformanceReceiptId,
    observerEffectReceiptId: observerEffect.receiptId,
    policyProfileDigest: input.policyProfileDigest,
    publicationOperationId: input.publicationOperationId,
  };
  const revisionFiles = Object.freeze([
    ...candidateFiles.map((file) =>
      Object.freeze({
        path: `adapter/${file.path}`,
        bytes: Uint8Array.from(file.bytes),
      }),
    ),
    Object.freeze({
      path: "records/adapter-revision.v1.json",
      bytes: canonicalRecordBytes(adapterRevision),
    }),
    Object.freeze({
      path: "records/conformance-receipt.v1.json",
      bytes: canonicalRecordBytes(conformance),
    }),
    Object.freeze({
      path: "records/observer-effect-receipt.v1.json",
      bytes: canonicalRecordBytes(observerEffect),
    }),
  ]);
  const revisionContentDigest = asSha256DigestV1(
    projectEnvironmentPackageContentDigestV1(revisionFiles),
  );
  const environmentRevision = ProjectEnvironmentRevisionV1Schema.parse({
    ...environmentContent,
    environmentRevisionId: asProjectEnvironmentRevisionId(
      `environment-revision:v1:${contentHash(
        jsonFact({
          ...environmentContent,
          contentDigest: revisionContentDigest,
        }),
      )}`,
    ),
    contentDigest: revisionContentDigest,
    publishedAt: completedAt,
  });
  return Object.freeze({
    loaded,
    conformance,
    observerEffect,
    adapterRevision,
    environmentRevision,
    revisionFiles,
  });
}
