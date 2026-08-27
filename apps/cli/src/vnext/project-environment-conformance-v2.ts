import { createHash } from "node:crypto";

import {
  AdapterConformanceReceiptV2Schema,
  ObserverEffectReceiptV1Schema,
  ProjectAdapterLaunchTargetConformanceEvidenceV1Schema,
  ProjectAdapterLaunchTargetValidationV1Schema,
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

import type {
  ProjectEnvironmentConformanceDriverV2,
  ProjectEnvironmentInstrumentedObservationV2,
} from "./project-environment-conformance-driver-v2.js";
import { runProjectAdapterLaunchTargetConformanceV2 } from "./project-environment-conformance-driver-v2.js";
import { ProjectSourceClosureV1Schema } from "./source-preflight.js";
import { ProjectEnvironmentWorkspaceMaterializationReceiptV2Schema } from "./workspace-materializer.js";

export const PROJECT_ADAPTER_LAUNCH_TARGET_VALIDATION_RECORD_PATH_V1 =
  "records/launch-target-validation.v1.json" as const;
export const PROJECT_ADAPTER_LAUNCH_TARGET_CONFORMANCE_RECORD_PATH_V1 =
  "records/launch-target-conformance.v1.json" as const;

const PRIMARY_RAW_RECORDS_PATH =
  "records/dynamic-projection-conformance.v2.json" as const;
const PRIMARY_RAW_CHAIN_PATH =
  "records/dynamic-projection-chain.v2.json" as const;
const DEFAULT_RAW_RECORDS_PATH =
  "records/dynamic-projection-conformance.default.v2.json" as const;
const DEFAULT_RAW_CHAIN_PATH =
  "records/dynamic-projection-chain.default.v2.json" as const;

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as never;
const bytes = (value: unknown): Uint8Array =>
  Buffer.from(`${canonicalJson(json(value))}\n`, "utf8");
const parseCanonicalBytes = <T>(
  path: string,
  raw: Uint8Array,
  parse: (value: unknown) => T,
): T => {
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(raw),
  ) as unknown;
  const parsed = parse(value);
  if (!Buffer.from(raw).equals(Buffer.from(bytes(parsed))))
    throw new Error(`V2 source record is not canonical: ${path}`);
  return parsed;
};
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

export const projectAdapterObservationFailuresV2 = (
  prefix: string,
  manifest: Awaited<ReturnType<typeof loadProjectAdapterPackageV2>>["manifest"],
  observation: ProjectEnvironmentInstrumentedObservationV2,
): readonly string[] =>
  Object.freeze([
    ...observation.runtimeFailures.map((failure) => `${prefix}: ${failure}`),
    ...(observation.entityLifecycleRecords <
    manifest.smoke.minimumEntityLifecycleRecords
      ? [`${prefix} minimum entity lifecycle records were not observed`]
      : []),
    ...(observation.stateSamples < manifest.smoke.minimumStateSamples
      ? [`${prefix} minimum state samples were not observed`]
      : []),
    ...manifest.smoke.requiredStateDomainIds
      .filter((id) => !observation.stateDomainIds.includes(id))
      .map((id) => `${prefix} required state domain ${id} was not observed`),
    ...manifest.smoke.requiredCustomEventTypeIds
      .filter((id) => !observation.observedCustomEventTypeIds.includes(id))
      .map((id) => `${prefix} required event type ${id} was not observed`),
    ...(observation.dynamicTraces.length !==
    manifest.smoke.requiredDynamicTraces.length
      ? [`${prefix} required dynamic trace was not observed`]
      : []),
    ...(observation.droppedRecords !== 0 ||
    observation.overwrittenRecords !== 0 ||
    observation.semanticCoverage !== "declared"
      ? [`${prefix} dynamic projection was not lossless and declared`]
      : []),
  ]);

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
  value.resourceUsage.cpuUsageUsec !== null &&
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
  readonly sourceRecords?:
    | readonly {
        readonly path: string;
        readonly bytes: Uint8Array;
      }[]
    | undefined;
  readonly candidate: ProjectAdapterCandidateReferenceV1;
  readonly adapterId: AdapterId;
  readonly environmentId: ProjectEnvironmentId;
  readonly publicationOperationId: ProjectEnvironmentOperationId;
  readonly toolchainReceiptId: ProjectToolchainReceiptId;
  readonly expectedMainScene: string;
  readonly selectedLaunchTargetId?: string | undefined;
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
    selectedLaunchTargetId: input.selectedLaunchTargetId,
    expectedMainScene: input.expectedMainScene,
    requireEmptyLaunchParameters: true,
    requiredImplementedModules: PROJECT_ADAPTER_REQUIRED_MODULES_V2,
  });
  const candidateFiles = input.candidateFiles
    .map((file) => ({ path: file.path, bytes: Uint8Array.from(file.bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const requiredSourceRecordPaths = new Set([
    "records/source-closure.v1.json",
    "records/source-materialization-receipt.v2.json",
  ]);
  const sourceRecords = (input.sourceRecords ?? [])
    .map((record) => ({
      path: record.path,
      bytes: Uint8Array.from(record.bytes),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    (sourceRecords.length !== 0 &&
      sourceRecords.length !== requiredSourceRecordPaths.size) ||
    new Set(sourceRecords.map((record) => record.path)).size !==
      sourceRecords.length ||
    sourceRecords.some(
      (record) =>
        !requiredSourceRecordPaths.has(record.path) ||
        record.bytes.byteLength === 0,
    )
  )
    throw new Error(
      "V2 source records must be the exact closure and materialization receipt pair",
    );
  if (sourceRecords.length !== 0) {
    const closureRecord = sourceRecords.find(
      (record) => record.path === "records/source-closure.v1.json",
    )!;
    const receiptRecord = sourceRecords.find(
      (record) =>
        record.path === "records/source-materialization-receipt.v2.json",
    )!;
    const closure = parseCanonicalBytes(
      closureRecord.path,
      closureRecord.bytes,
      (value) => ProjectSourceClosureV1Schema.parse(value),
    );
    const receipt = parseCanonicalBytes(
      receiptRecord.path,
      receiptRecord.bytes,
      (value) =>
        ProjectEnvironmentWorkspaceMaterializationReceiptV2Schema.parse(value),
    );
    if (
      closure.sourceId !== input.candidate.sourceId ||
      receipt.sourceId !== input.candidate.sourceId ||
      receipt.taskId !== input.candidate.taskId ||
      closure.sourceRevision !== receipt.sourceRevision ||
      closure.projectPath !== receipt.projectPrefix ||
      closure.selectedTreeSha256 !== receipt.selectedTreeSha256 ||
      closure.mainScene !== input.expectedMainScene
    )
      throw new Error(
        "V2 source closure and materialization receipt crossed their candidate binding",
      );
  }
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
  const targetRuns = await runProjectAdapterLaunchTargetConformanceV2(
    loaded,
    driver,
  );
  const targetRawEvidence = targetRuns.map((run) => {
    const rawRecordsBytes = bytes(run.instrumented.rawRecords);
    const first = run.instrumented.rawRecords[0]?.recordSequence ?? 0;
    const last = run.instrumented.rawRecords.at(-1)?.recordSequence ?? 0;
    const chain = ProjectEnvironmentDynamicObservationChainV2Schema.parse({
      schemaVersion: 2,
      recordKind: "chronorift-project-environment-dynamic-observation-chain",
      taskId: input.candidate.taskId,
      executionId: run.instrumented.rawRecords[0]?.executionId,
      adapterRevisionId: `adapter-revision:v1:${loaded.candidateSha256}`,
      manifestSha256: loaded.manifestSha256,
      recordCount: run.instrumented.rawRecords.length,
      firstRecordSequence: first,
      lastRecordSequence: last,
      recordsSha256: sha(rawRecordsBytes),
      traces: run.instrumented.dynamicTraces.map((trace) => ({
        schemaVersion: 2,
        ...trace,
      })),
      lossless: true,
    });
    return Object.freeze({
      run,
      rawRecordsBytes,
      chain,
      chainBytes: bytes(chain),
    });
  });
  const primaryEvidence =
    targetRawEvidence.find(
      (evidence) =>
        evidence.run.target.targetId ===
        loaded.launchTargetSelection.selectedTarget.targetId,
    ) ?? targetRawEvidence[0];
  if (primaryEvidence === undefined)
    throw new Error("ProjectAdapter V2 conformance selected no launch target");
  const rawChain = primaryEvidence.chain;
  const completedAt = now();
  const differences: ObserverEffectDifferenceV1[] = [];
  for (const run of targetRuns) {
    const comparisons = [
      ["vanilla_to_bridge", run.vanilla, run.bridgeOnly],
      ["bridge_to_instrumented", run.bridgeOnly, run.instrumented],
    ] as const;
    for (const [comparison, baseline, observed] of comparisons) {
      if (!baseline.stdoutTruncated && !observed.stdoutTruncated)
        addDifference(differences, {
          comparison,
          dimension: "process_stdout",
          baselineDigest: baseline.stdoutSha256,
          instrumentedDigest: observed.stdoutSha256,
          description: `${run.target.targetId} ${comparison} bounded Host-observable stdout differed.`,
        });
      if (!baseline.stderrTruncated && !observed.stderrTruncated)
        addDifference(differences, {
          comparison,
          dimension: "process_stderr",
          baselineDigest: baseline.stderrSha256,
          instrumentedDigest: observed.stderrSha256,
          description: `${run.target.targetId} ${comparison} bounded Host-observable stderr differed.`,
        });
      addDifference(differences, {
        comparison,
        dimension: "process_lifecycle",
        baselineDigest: factDigest(lifecycleFact(baseline)),
        instrumentedDigest: factDigest(lifecycleFact(observed)),
        description: `${run.target.targetId} ${comparison} Host-observable lifecycle or elapsed time differed.`,
      });
      if (resourceComplete(baseline) && resourceComplete(observed))
        addDifference(differences, {
          comparison,
          dimension: "resource_usage",
          baselineDigest: factDigest(resourceFact(baseline)),
          instrumentedDigest: factDigest(resourceFact(observed)),
          description: `${run.target.targetId} ${comparison} observed CPU, memory-peak, or process-peak usage differed.`,
        });
    }
  }
  const observerRuns = targetRuns.flatMap((run) => [
    [`${run.target.targetId} vanilla`, run.vanilla] as const,
    [`${run.target.targetId} bridge-only`, run.bridgeOnly] as const,
    [`${run.target.targetId} instrumented`, run.instrumented] as const,
  ]);
  const alignmentGaps = observerRuns.flatMap(([label, observation]) => [
    ...(observation.stdoutTruncated
      ? [`${label} stdout capture was truncated.`]
      : []),
    ...(observation.stderrTruncated
      ? [`${label} stderr capture was truncated.`]
      : []),
    ...(observation.resourceUsage.cpuUsageUsec === null
      ? [`${label} CPU usage was unavailable under SRT.`]
      : []),
    ...(observation.resourceUsage.memoryPeakBytes === null
      ? [`${label} memory-peak usage was unavailable.`]
      : []),
    ...(observation.resourceUsage.pidsPeak === null
      ? [`${label} process-peak usage was unavailable.`]
      : []),
  ]);
  const failures = targetRuns.flatMap((run) => {
    const prefix = `target ${run.target.targetId}`;
    return [
      ...(!processOkay(run.vanilla) ? [`${prefix} vanilla smoke failed`] : []),
      ...(!processOkay(run.bridgeOnly)
        ? [`${prefix} bridge-only smoke failed`]
        : []),
      ...(!processOkay(run.instrumented)
        ? [`${prefix} instrumented smoke failed`]
        : []),
      ...projectAdapterObservationFailuresV2(
        prefix,
        loaded.manifest,
        run.instrumented,
      ),
    ];
  });
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
      observedRecords: targetRuns.reduce(
        (sum, run) => sum + run.instrumented.rawRecords.length,
        0,
      ),
      droppedRecords: targetRuns.reduce(
        (sum, run) => sum + run.instrumented.droppedRecords,
        0,
      ),
      overwrittenRecords: targetRuns.reduce(
        (sum, run) => sum + run.instrumented.overwrittenRecords,
        0,
      ),
      limitations: failures.length === 0 ? [] : ["dynamic conformance failed"],
    },
  ];
  const targetRunDigests = targetRuns.map((run) => ({
    targetId: run.target.targetId,
    vanilla: factDigest(lifecycleFact(run.vanilla)),
    bridgeOnly: factDigest(lifecycleFact(run.bridgeOnly)),
    instrumented: factDigest({
      ...lifecycleFact(run.instrumented),
      rawRecordsSha256: sha(bytes(run.instrumented.rawRecords)),
      dynamicTraces: run.instrumented.dynamicTraces,
      droppedRecords: run.instrumented.droppedRecords,
      overwrittenRecords: run.instrumented.overwrittenRecords,
      semanticCoverage: run.instrumented.semanticCoverage,
    }),
  }));
  const receiptId = asAdapterConformanceReceiptId(
    `conformance:v2:${contentHash(json({ candidate: input.candidate.contentDigest, targets: targetRunDigests, raw: rawChain.recordsSha256, traces: rawChain.traces }))}`,
  );
  const validatedTargetIds = new Set(
    loaded.launchTargetSelection.targetsToValidate.map(
      (target) => target.targetId,
    ),
  );
  const launchTargetValidation =
    ProjectAdapterLaunchTargetValidationV1Schema.parse({
      schemaVersion: 1,
      recordKind: "chronorift-project-adapter-launch-target-validation",
      defaultTargetId: loaded.launchTargetSelection.defaultTarget.targetId,
      selectedTargetId: loaded.launchTargetSelection.selectedTarget.targetId,
      targets: [...loaded.manifest.launchTargets]
        .sort((left, right) => left.targetId.localeCompare(right.targetId))
        .map((target) => ({
          schemaVersion: 1,
          targetId: target.targetId,
          status: validatedTargetIds.has(target.targetId)
            ? "validated"
            : "declared_unvalidated",
          conformanceReceiptId: validatedTargetIds.has(target.targetId)
            ? receiptId
            : null,
        })),
    });
  const targetDigestById = new Map(
    targetRunDigests.map((target) => [target.targetId, target]),
  );
  const launchTargetConformance =
    ProjectAdapterLaunchTargetConformanceEvidenceV1Schema.parse({
      schemaVersion: 1,
      recordKind: "chronorift-project-adapter-launch-target-conformance",
      conformanceReceiptId: receiptId,
      defaultTargetId: loaded.launchTargetSelection.defaultTarget.targetId,
      selectedTargetId: loaded.launchTargetSelection.selectedTarget.targetId,
      targets: targetRawEvidence.map((evidence) => {
        const targetId = evidence.run.target.targetId;
        const digests = targetDigestById.get(targetId)!;
        const primary =
          targetId === loaded.launchTargetSelection.selectedTarget.targetId;
        return {
          schemaVersion: 1,
          targetId,
          vanillaDigest: digests.vanilla,
          bridgeOnlyDigest: digests.bridgeOnly,
          instrumentedDigest: digests.instrumented,
          rawObservationRecordsPath: primary
            ? PRIMARY_RAW_RECORDS_PATH
            : DEFAULT_RAW_RECORDS_PATH,
          rawObservationRecordsSha256: evidence.chain.recordsSha256,
          rawObservationChainPath: primary
            ? PRIMARY_RAW_CHAIN_PATH
            : DEFAULT_RAW_CHAIN_PATH,
          rawObservationChainSha256: sha(evidence.chainBytes),
        };
      }),
    });
  const targetCleanups = targetRuns.map((run) => cleanup(run.instrumented));
  const conformanceCleanup = {
    schemaVersion: 1 as const,
    processTreeTerminated: targetCleanups.every(
      (receipt) => receipt.processTreeTerminated,
    ),
    runtimeExited: targetCleanups.every((receipt) => receipt.runtimeExited),
    bridgeExited: targetCleanups.every((receipt) => receipt.bridgeExited),
    isolationGroupEmpty: targetCleanups.every(
      (receipt) => receipt.isolationGroupEmpty,
    ),
    scopeRemoved: targetCleanups.every((receipt) => receipt.scopeRemoved),
    scratchRemoved: targetCleanups.every((receipt) => receipt.scratchRemoved),
    storageReconciled: targetCleanups.every(
      (receipt) => receipt.storageReconciled,
    ),
  };
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
      bridgeHandshakes: targetRuns.reduce(
        (sum, run) => sum + run.instrumented.bridgeHandshakeCount,
        0,
      ),
      entityLifecycleRecords: targetRuns.reduce(
        (sum, run) => sum + run.instrumented.entityLifecycleRecords,
        0,
      ),
      stateSamples: targetRuns.reduce(
        (sum, run) => sum + run.instrumented.stateSamples,
        0,
      ),
      queries: targetRuns.reduce(
        (sum, run) => sum + run.instrumented.queries,
        0,
      ),
      declaredCustomEventTypes:
        loaded.manifest.smoke.requiredCustomEventTypeIds.length,
      observedCustomEventTypes:
        loaded.manifest.smoke.requiredCustomEventTypeIds.length,
      captures: targetRuns.reduce(
        (sum, run) => sum + run.instrumented.captures,
        0,
      ),
    },
    coverage,
    cleanup: conformanceCleanup,
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
      `observer:v1:${contentHash(json({ targets: targetRunDigests, differences, alignmentGaps, unknowns: observerUnknowns }))}`,
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
  // SRT does not expose the retired broker's cgroup CPU/memory/PID counters.
  // Preserve that as an incomplete observation instead of making unrelated
  // adapter publication depend on custom sandbox accounting.
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
    ...targetRawEvidence.flatMap((evidence) => {
      const primary =
        evidence.run.target.targetId ===
        loaded.launchTargetSelection.selectedTarget.targetId;
      return [
        Object.freeze({
          path: primary ? PRIMARY_RAW_RECORDS_PATH : DEFAULT_RAW_RECORDS_PATH,
          bytes: evidence.rawRecordsBytes,
        }),
        Object.freeze({
          path: primary ? PRIMARY_RAW_CHAIN_PATH : DEFAULT_RAW_CHAIN_PATH,
          bytes: evidence.chainBytes,
        }),
      ];
    }),
    Object.freeze({
      path: "records/observer-effect-receipt.v1.json",
      bytes: bytes(observerEffect),
    }),
    Object.freeze({
      path: PROJECT_ADAPTER_LAUNCH_TARGET_VALIDATION_RECORD_PATH_V1,
      bytes: bytes(launchTargetValidation),
    }),
    Object.freeze({
      path: PROJECT_ADAPTER_LAUNCH_TARGET_CONFORMANCE_RECORD_PATH_V1,
      bytes: bytes(launchTargetConformance),
    }),
    ...sourceRecords.map((record) =>
      Object.freeze({
        path: record.path,
        bytes: Uint8Array.from(record.bytes),
      }),
    ),
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
    launchTargetValidation,
    launchTargetConformance,
    rawChain,
    adapterRevision,
    environmentRevision,
    revisionFiles,
  });
}
