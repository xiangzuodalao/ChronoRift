import { createHash } from "node:crypto";

import {
  AdapterConformanceReceiptV2Schema,
  ObserverEffectReceiptV1Schema,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentDynamicObservationChainV2Schema,
  ProjectEnvironmentRevisionV1Schema,
  asAdapterConformanceReceiptId,
  asObserverEffectReceiptId,
  asProjectAdapterRevisionId,
  asProjectEnvironmentRevisionId,
  asSha256DigestV1,
  type AdapterId,
  type ObserverEffectDifferenceV1,
  type ProjectAdapterCandidateReferenceV1,
  type ProjectEnvironmentId,
  type ProjectEnvironmentOperationId,
  type ProjectToolchainReceiptId,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { PROJECT_ADAPTER_REQUIRED_MODULES_V2 } from "@chronorift/godot-protocol";
import { loadProjectAdapterPackageV2 } from "@chronorift/godot-adapter";
import {
  canonicalJson,
  contentHash,
  projectEnvironmentPackageContentDigestV1,
} from "@chronorift/json-artifacts";

import type { ProjectEnvironmentConformanceDriverV2 } from "./project-environment-conformance-driver-v2.js";

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as never;
const bytes = (value: unknown): Uint8Array =>
  Buffer.from(`${canonicalJson(json(value))}\n`, "utf8");
const sha = (value: Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));
const hashText = (label: string, value: string): Sha256DigestV1 =>
  asSha256DigestV1(
    createHash("sha256").update(label).update("\0").update(value).digest("hex"),
  );
const candidateContentDigest = (
  loaded: Awaited<ReturnType<typeof loadProjectAdapterPackageV2>>,
): string =>
  contentHash(
    json({
      schemaVersion: 1,
      files: loaded.files
        .map((file) => ({
          path: file.path,
          byteLength: file.bytes,
          sha256: file.sha256,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    }),
  );
const cleanup = (
  value: Awaited<
    ReturnType<ProjectEnvironmentConformanceDriverV2["runInstrumented"]>
  >,
) => ({
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
const processOkay = (
  value: Awaited<
    ReturnType<ProjectEnvironmentConformanceDriverV2["runVanilla"]>
  >,
) =>
  value.launched &&
  value.importSucceeded &&
  value.stableWindowObserved &&
  !value.timedOut &&
  value.exitCode === 0 &&
  value.signal === null &&
  value.sourceIdentityReverified &&
  value.processTreeTerminated &&
  value.isolationGroupEmpty &&
  value.scopeRemoved &&
  value.scratchRemoved &&
  value.storageReconciled;

const factDigest = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(json(value)));
const lifecycleFact = (
  value: Awaited<
    ReturnType<ProjectEnvironmentConformanceDriverV2["runVanilla"]>
  >,
) => ({
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
const resourceFact = (
  value: Awaited<
    ReturnType<ProjectEnvironmentConformanceDriverV2["runVanilla"]>
  >,
) => ({ schemaVersion: 1 as const, ...value.resourceUsage });
const resourceComplete = (
  value: Awaited<
    ReturnType<ProjectEnvironmentConformanceDriverV2["runVanilla"]>
  >,
) =>
  value.resourceUsage.memoryPeakBytes !== null &&
  value.resourceUsage.pidsPeak !== null;
const addDifference = (
  target: ObserverEffectDifferenceV1[],
  difference: Omit<ObserverEffectDifferenceV1, "schemaVersion">,
): void => {
  if (difference.baselineDigest !== difference.instrumentedDigest)
    target.push({ schemaVersion: 1, ...difference });
};

export interface ValidateProjectAdapterCandidateV2Request {
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

export async function validateProjectAdapterCandidateV2(
  input: ValidateProjectAdapterCandidateV2Request,
  driver: ProjectEnvironmentConformanceDriverV2,
  now: () => string = () => new Date().toISOString(),
) {
  const loaded = await loadProjectAdapterPackageV2(input.candidateDirectory, {
    requireSingleLaunchTarget: true,
    expectedMainScene: input.expectedMainScene,
    requireEmptyLaunchParameters: true,
    requiredImplementedModules: PROJECT_ADAPTER_REQUIRED_MODULES_V2,
  });
  const candidateFiles = input.candidateFiles
    .map((file) => ({ path: file.path, bytes: Uint8Array.from(file.bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (
    projectEnvironmentPackageContentDigestV1(candidateFiles) !==
      input.candidate.contentDigest ||
    candidateContentDigest(loaded) !== input.candidate.contentDigest ||
    loaded.files.length !== input.candidate.fileCount ||
    loaded.totalBytes !== input.candidate.byteLength ||
    loaded.manifest.adapterId !== input.adapterId
  )
    throw new Error("loaded V2 adapter differs from its frozen Task candidate");
  const startedAt = now();
  const vanilla = await driver.runVanilla();
  const bridgeOnly = await driver.runBridgeOnly();
  const instrumented = await driver.runInstrumented(loaded);
  const completedAt = now();
  const differences: ObserverEffectDifferenceV1[] = [];
  const comparisons = [
    ["vanilla_to_bridge", vanilla, bridgeOnly],
    ["bridge_to_instrumented", bridgeOnly, instrumented],
  ] as const;
  for (const [comparison, baseline, observed] of comparisons) {
    if (!baseline.stdoutTruncated && !observed.stdoutTruncated)
      addDifference(differences, {
        comparison,
        dimension: "process_stdout",
        baselineDigest: baseline.stdoutSha256,
        instrumentedDigest: observed.stdoutSha256,
        description: `${comparison} bounded Host-observable stdout differed.`,
      });
    if (!baseline.stderrTruncated && !observed.stderrTruncated)
      addDifference(differences, {
        comparison,
        dimension: "process_stderr",
        baselineDigest: baseline.stderrSha256,
        instrumentedDigest: observed.stderrSha256,
        description: `${comparison} bounded Host-observable stderr differed.`,
      });
    addDifference(differences, {
      comparison,
      dimension: "process_lifecycle",
      baselineDigest: factDigest(lifecycleFact(baseline)),
      instrumentedDigest: factDigest(lifecycleFact(observed)),
      description: `${comparison} Host-observable lifecycle or elapsed time differed.`,
    });
    if (resourceComplete(baseline) && resourceComplete(observed))
      addDifference(differences, {
        comparison,
        dimension: "resource_usage",
        baselineDigest: factDigest(resourceFact(baseline)),
        instrumentedDigest: factDigest(resourceFact(observed)),
        description: `${comparison} observed CPU, memory-peak, or process-peak usage differed.`,
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
  const rawBytes = bytes(instrumented.rawRecords);
  const first = instrumented.rawRecords[0]?.recordSequence ?? 0;
  const last = instrumented.rawRecords.at(-1)?.recordSequence ?? 0;
  const rawChain = ProjectEnvironmentDynamicObservationChainV2Schema.parse({
    schemaVersion: 2,
    recordKind: "chronorift-project-environment-dynamic-observation-chain",
    taskId: input.candidate.taskId,
    executionId: instrumented.rawRecords[0]?.executionId,
    adapterRevisionId: `adapter-revision:v1:${loaded.candidateSha256}`,
    manifestSha256: loaded.manifestSha256,
    recordCount: instrumented.rawRecords.length,
    firstRecordSequence: first,
    lastRecordSequence: last,
    recordsSha256: sha(rawBytes),
    traces: instrumented.dynamicTraces.map((trace) => ({
      schemaVersion: 2,
      ...trace,
    })),
    lossless: true,
  });
  const failures = [
    ...(!processOkay(vanilla) ? ["vanilla smoke failed"] : []),
    ...(!processOkay(bridgeOnly) ? ["bridge-only smoke failed"] : []),
    ...(!processOkay(instrumented) ? ["instrumented smoke failed"] : []),
    ...instrumented.runtimeFailures,
    ...(instrumented.dynamicTraces.length !==
    loaded.manifest.smoke.requiredDynamicTraces.length
      ? ["required dynamic trace was not observed"]
      : []),
    ...(instrumented.droppedRecords !== 0 ||
    instrumented.overwrittenRecords !== 0 ||
    instrumented.semanticCoverage !== "declared"
      ? ["dynamic projection was not lossless and declared"]
      : []),
  ];
  for (const module of loaded.manifest.modules.modules)
    if (
      !PROJECT_ADAPTER_REQUIRED_MODULES_V2.includes(module.module as never) &&
      module.status !== "unsupported"
    )
      failures.push(`optional module ${module.module} was not exercised`);
  for (const domain of loaded.manifest.stateDomains)
    if (domain.checkpointDisposition === "captured")
      failures.push(
        `state domain ${domain.stateDomainId} claims unexercised checkpoint capture`,
      );
  const capabilitySet = loaded.manifest.modules;
  const stateDomains = loaded.manifest.stateDomains.map((domain) => ({
    schemaVersion: 1 as const,
    domainId: domain.stateDomainId,
    disposition: domain.checkpointDisposition,
    schemaDigest:
      domain.checkpointDisposition === "captured"
        ? asSha256DigestV1(
            loaded.manifest.schemas.find(
              (schema) => schema.schemaId === domain.schemaId,
            )!.sha256,
          )
        : null,
    limitations:
      domain.checkpointDisposition === "captured"
        ? []
        : [`adapter declares ${domain.checkpointDisposition}`],
  }));
  const coverage = [
    {
      schemaVersion: 1 as const,
      channelId: "project-adapter-observations-v2",
      status:
        failures.length === 0 ? ("complete" as const) : ("incomplete" as const),
      observedRecords: instrumented.rawRecords.length,
      droppedRecords: instrumented.droppedRecords,
      overwrittenRecords: instrumented.overwrittenRecords,
      limitations: failures.length === 0 ? [] : ["dynamic conformance failed"],
    },
  ];
  const receiptId = asAdapterConformanceReceiptId(
    `conformance:v2:${contentHash(json({ candidate: input.candidate.contentDigest, raw: rawChain.recordsSha256, traces: rawChain.traces }))}`,
  );
  const conformance = AdapterConformanceReceiptV2Schema.parse({
    schemaVersion: 2,
    receiptId,
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
      observedCustomEventTypes:
        loaded.manifest.smoke.requiredCustomEventTypeIds.length,
      captures: instrumented.captures,
    },
    coverage,
    cleanup: cleanup(instrumented),
    outcome: failures.length === 0 ? "conformed" : "rejected",
    failures,
    startedAt,
    completedAt,
    observationProtocolVersion: 2,
    adapterSdkVersion: 2,
    rawObservationChainPath: "records/dynamic-projection-conformance.v2.json",
    rawObservationChainSha256: rawChain.recordsSha256,
    dynamicTraces: rawChain.traces,
  });
  if (conformance.outcome !== "conformed")
    throw new Error(
      `ProjectAdapter V2 conformance rejected: ${failures.join("; ")}`,
    );
  const observerUnknowns = [
    "Godot project and adapter share one untrusted runtime principal.",
    "Observed ordering does not attest Signal-to-state causality or adapter semantic correctness.",
    "No observed smoke difference proves absence of observer effect.",
  ];
  const observerEffect = ObserverEffectReceiptV1Schema.parse({
    schemaVersion: 1,
    receiptId: asObserverEffectReceiptId(
      `observer:v1:${contentHash(json({ vanilla, bridgeOnly, instrumented: { ...instrumented, rawRecords: undefined }, differences, alignmentGaps, unknowns: observerUnknowns }))}`,
    ),
    taskId: input.candidate.taskId,
    attemptId: input.candidate.attemptId,
    sourceId: input.candidate.sourceId,
    candidateId: input.candidate.candidateId,
    status: alignmentGaps.length === 0 ? "measured" : "incomplete",
    differences,
    alignmentGaps,
    unknowns: observerUnknowns,
    observedAt: completedAt,
  });
  if (observerEffect.status !== "measured")
    throw new Error(
      `ProjectAdapter V2 observer-effect comparison was incomplete: ${alignmentGaps.join("; ")}`,
    );
  const adapterRevisionId = asProjectAdapterRevisionId(
    `adapter-revision:v1:${loaded.candidateSha256}`,
  );
  const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
    schemaVersion: 1,
    adapterRevisionId,
    adapterId: input.adapterId,
    sourceId: input.candidate.sourceId,
    packageDigest: loaded.candidateSha256,
    manifestDigest: loaded.manifestSha256,
    implementationDigest: hashText(
      "project-adapter-implementation-v2",
      loaded.files
        .filter((file) => file.path.endsWith(".gd"))
        .map((file) => `${file.path}:${file.sha256}`)
        .join("\n"),
    ),
    payloadSchemaDigest: hashText(
      "project-adapter-payload-schemas-v2",
      loaded.manifest.schemas
        .map((schema) => `${schema.schemaId}:${schema.sha256}`)
        .join("\n"),
    ),
    sdkDigest: input.sdkDigest,
    bridgeDigest: input.bridgeDigest,
    capabilitySet,
    conformanceReceiptId: receiptId,
    contentByteLength: loaded.totalBytes,
    contentFileCount: loaded.files.length,
  });
  const revisionFiles = Object.freeze([
    ...candidateFiles.map((file) =>
      Object.freeze({
        path: `adapter/${file.path}`,
        bytes: Uint8Array.from(file.bytes),
      }),
    ),
    Object.freeze({
      path: "records/adapter-revision.v1.json",
      bytes: bytes(adapterRevision),
    }),
    Object.freeze({
      path: "records/conformance-receipt.v2.json",
      bytes: bytes(conformance),
    }),
    Object.freeze({
      path: "records/dynamic-projection-conformance.v2.json",
      bytes: rawBytes,
    }),
    Object.freeze({
      path: "records/dynamic-projection-chain.v2.json",
      bytes: bytes(rawChain),
    }),
    Object.freeze({
      path: "records/observer-effect-receipt.v1.json",
      bytes: bytes(observerEffect),
    }),
  ]);
  const revisionDigest = asSha256DigestV1(
    projectEnvironmentPackageContentDigestV1(revisionFiles),
  );
  const environmentContent = {
    schemaVersion: 1 as const,
    environmentId: input.environmentId,
    sourceId: input.candidate.sourceId,
    adapterRevisionId,
    sdkDigest: input.sdkDigest,
    bridgeDigest: input.bridgeDigest,
    toolchainReceiptId: input.toolchainReceiptId,
    conformanceReceiptId: receiptId,
    observerEffectReceiptId: observerEffect.receiptId,
    policyProfileDigest: input.policyProfileDigest,
    publicationOperationId: input.publicationOperationId,
  };
  const environmentRevision = ProjectEnvironmentRevisionV1Schema.parse({
    ...environmentContent,
    environmentRevisionId: asProjectEnvironmentRevisionId(
      `environment-revision:v1:${contentHash(json({ ...environmentContent, contentDigest: revisionDigest }))}`,
    ),
    contentDigest: revisionDigest,
    publishedAt: completedAt,
  });
  return Object.freeze({
    loaded,
    conformance,
    observerEffect,
    rawChain,
    adapterRevision,
    environmentRevision,
    revisionFiles,
  });
}
