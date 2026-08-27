import { createHash } from "node:crypto";

import {
  AdapterConformanceReceiptV2Schema,
  ObserverEffectReceiptV1Schema,
  ProjectAdapterLaunchTargetConformanceEvidenceV1Schema,
  ProjectAdapterLaunchTargetValidationV1Schema,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentDynamicObservationChainV2Schema,
  asAdapterConformanceReceiptId,
  type AdapterConformanceReceiptV2,
  type AdapterId,
  type ObserverEffectReceiptV1,
  type ProjectAdapterLaunchTargetConformanceEvidenceV1,
  type ProjectAdapterLaunchTargetValidationV1,
  type ProjectAdapterRevisionV1,
  type ProjectEnvironmentRevisionV1,
  type ProjectToolchainReceiptId,
  type SourceId,
} from "@chronorift/domain";
import {
  loadProjectAdapterPackageFilesV2,
  ProjectAdapterObservationExecutionValidatorV2,
  recognizeProjectAdapterDynamicTracesV2,
  type LoadedProjectAdapterPackageV2,
  type ProjectAdapterLaunchTargetV2,
} from "@chronorift/godot-adapter";
import type { GodotProjectEnvironmentObservationRecordV2 } from "@chronorift/godot-protocol";
import {
  canonicalJson,
  contentHash,
  projectEnvironmentPackageContentDigestV1,
  type ProjectEnvironmentPackageFileInputV1,
} from "@chronorift/json-artifacts";

import { ProjectSourceClosureV1Schema } from "./source-preflight.js";
import { ProjectEnvironmentWorkspaceMaterializationReceiptV2Schema } from "./workspace-materializer.js";

const LAUNCH_TARGET_CONFORMANCE_PATH =
  "records/launch-target-conformance.v1.json" as const;
const PRIMARY_RAW_RECORDS_PATH =
  "records/dynamic-projection-conformance.v2.json" as const;
const PRIMARY_RAW_CHAIN_PATH =
  "records/dynamic-projection-chain.v2.json" as const;
const DEFAULT_RAW_RECORDS_PATH =
  "records/dynamic-projection-conformance.default.v2.json" as const;
const DEFAULT_RAW_CHAIN_PATH =
  "records/dynamic-projection-chain.default.v2.json" as const;

const candidateContentDigest = (
  loaded: LoadedProjectAdapterPackageV2,
): string =>
  contentHash({
    schemaVersion: 1,
    files: loaded.files
      .map((file) => ({
        path: file.path,
        byteLength: file.bytes,
        sha256: file.sha256,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });

const recordBytes = (
  files: readonly ProjectEnvironmentPackageFileInputV1[],
  path: string,
): Uint8Array => {
  const matches = files.filter((file) => file.path === path);
  if (matches.length !== 1 || matches[0] === undefined)
    throw new Error(`published V2 Project Environment is missing ${path}`);
  return matches[0].bytes;
};

export type ProjectEnvironmentReuseV2FailureCode =
  "review_required" | "target_not_validated";

export class ProjectEnvironmentReuseV2Error extends Error {
  public override readonly name = "ProjectEnvironmentReuseV2Error";

  public constructor(
    public readonly code: ProjectEnvironmentReuseV2FailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export const assertReusableProjectEnvironmentRuntimeDigestsV2 = (input: {
  readonly revision: Pick<
    ProjectEnvironmentRevisionV1,
    "sdkDigest" | "bridgeDigest" | "policyProfileDigest"
  >;
  readonly sdkDigest: string;
  readonly bridgeDigest: string;
  readonly policyProfileDigest: string;
}): void => {
  if (
    input.sdkDigest !== input.revision.sdkDigest ||
    input.bridgeDigest !== input.revision.bridgeDigest ||
    input.policyProfileDigest !== input.revision.policyProfileDigest
  )
    reuseFailure(
      "review_required",
      "review_required: V2 SDK, bridge, or sandbox policy changed",
    );
};

const reuseFailure = (
  code: ProjectEnvironmentReuseV2FailureCode,
  message: string,
  cause?: unknown,
): never => {
  throw new ProjectEnvironmentReuseV2Error(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
};

export const resolveReusableProjectEnvironmentLaunchTargetV2 = (
  adapterPackage: LoadedProjectAdapterPackageV2,
  validation: ProjectAdapterLaunchTargetValidationV1,
  requestedTargetId: string | undefined,
  expectedConformanceReceiptId: AdapterConformanceReceiptV2["receiptId"],
): ProjectAdapterLaunchTargetV2 => {
  const manifestTargetIds = [...adapterPackage.manifest.launchTargets]
    .map((target) => target.targetId)
    .sort();
  const validationTargetIds = validation.targets
    .map((target) => target.targetId)
    .sort();
  const defaultTarget = adapterPackage.launchTargetSelection.defaultTarget;
  if (
    JSON.stringify(manifestTargetIds) !== JSON.stringify(validationTargetIds) ||
    validation.defaultTargetId !== defaultTarget.targetId ||
    validation.targets.some(
      (target) =>
        target.status === "validated" &&
        target.conformanceReceiptId !== expectedConformanceReceiptId,
    )
  )
    throw new Error(
      "published V2 launch-target validation crossed its manifest or conformance binding",
    );
  const targetId = requestedTargetId ?? defaultTarget.targetId;
  const target = adapterPackage.manifest.launchTargets.find(
    (candidate) => candidate.targetId === targetId,
  );
  const targetValidation = validation.targets.find(
    (candidate) => candidate.targetId === targetId,
  );
  if (target === undefined || targetValidation?.status !== "validated")
    return reuseFailure(
      "target_not_validated",
      `target_not_validated: launch target ${targetId} was not validated when this adapter revision was published`,
    );
  return target;
};
const parseCanonical = <T>(
  files: readonly ProjectEnvironmentPackageFileInputV1[],
  path: string,
  parse: (value: unknown) => T,
): T => {
  const raw = recordBytes(files, path);
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(raw),
  ) as unknown;
  const parsed = parse(value);
  if (
    !Buffer.from(raw).equals(Buffer.from(`${canonicalJson(value as never)}\n`))
  )
    throw new Error(`published V2 record is not canonical: ${path}`);
  return parsed;
};

export interface InspectedReusableProjectEnvironmentV2 {
  readonly schemaVersion: 2;
  readonly revision: ProjectEnvironmentRevisionV1;
  readonly adapterRevision: ProjectAdapterRevisionV1;
  readonly conformance: AdapterConformanceReceiptV2;
  readonly observerEffect: ObserverEffectReceiptV1;
  readonly launchTargetValidation: ProjectAdapterLaunchTargetValidationV1;
  readonly launchTargetConformance: ProjectAdapterLaunchTargetConformanceEvidenceV1 | null;
  readonly selectedLaunchTarget: ProjectAdapterLaunchTargetV2;
  readonly adapterPackage: LoadedProjectAdapterPackageV2;
  readonly adapterFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[];
}

export function inspectReusableProjectEnvironmentRevisionV2(input: {
  readonly revision: ProjectEnvironmentRevisionV1;
  readonly files: readonly ProjectEnvironmentPackageFileInputV1[];
  readonly expectedSourceId: SourceId;
  readonly expectedToolchainReceiptId: ProjectToolchainReceiptId;
  readonly expectedAdapterId: AdapterId;
  readonly expectedMainScene: string;
  readonly selectedLaunchTargetId?: string | undefined;
}): InspectedReusableProjectEnvironmentV2 {
  if (input.revision.sourceId !== input.expectedSourceId)
    return reuseFailure(
      "review_required",
      "review_required: current V2 environment differs from the selected source closure",
    );
  if (input.revision.toolchainReceiptId !== input.expectedToolchainReceiptId)
    throw new Error("current V2 environment differs from its toolchain");
  const allowed = new Set([
    "records/adapter-revision.v1.json",
    "records/conformance-receipt.v2.json",
    "records/dynamic-projection-conformance.v2.json",
    "records/dynamic-projection-chain.v2.json",
    "records/observer-effect-receipt.v1.json",
    "records/launch-target-validation.v1.json",
    LAUNCH_TARGET_CONFORMANCE_PATH,
    DEFAULT_RAW_RECORDS_PATH,
    DEFAULT_RAW_CHAIN_PATH,
    "records/source-closure.v1.json",
    "records/source-materialization-receipt.v2.json",
  ]);
  if (
    input.files.some(
      (file) => !file.path.startsWith("adapter/") && !allowed.has(file.path),
    )
  )
    throw new Error("published V2 revision contains an unsupported path");
  if (
    projectEnvironmentPackageContentDigestV1(input.files) !==
    input.revision.contentDigest
  )
    throw new Error(
      "published V2 revision physical seal differs from current pointer",
    );
  const adapterFiles = input.files
    .filter((file) => file.path.startsWith("adapter/"))
    .map((file) =>
      Object.freeze({
        relativePath: file.path.slice(8),
        bytes: Uint8Array.from(file.bytes),
      }),
    );
  let adapterPackage: LoadedProjectAdapterPackageV2;
  try {
    adapterPackage = loadProjectAdapterPackageFilesV2(
      adapterFiles.map((file) => ({
        path: file.relativePath,
        bytes: file.bytes,
      })),
      {
        selectedLaunchTargetId: input.selectedLaunchTargetId,
        expectedMainScene: input.expectedMainScene,
        requireEmptyLaunchParameters: true,
      },
    );
  } catch (error) {
    if (
      input.selectedLaunchTargetId !== undefined &&
      error instanceof Error &&
      "code" in error &&
      error.code === "target_not_validated"
    )
      return reuseFailure(
        "target_not_validated",
        `target_not_validated: launch target ${input.selectedLaunchTargetId} is not declared by this adapter revision`,
        error,
      );
    throw error;
  }
  const adapterRevision = parseCanonical(
    input.files,
    "records/adapter-revision.v1.json",
    (value) => ProjectAdapterRevisionV1Schema.parse(value),
  );
  const conformance = parseCanonical(
    input.files,
    "records/conformance-receipt.v2.json",
    (value) => AdapterConformanceReceiptV2Schema.parse(value),
  );
  const sourceClosureFiles = input.files.filter(
    (file) => file.path === "records/source-closure.v1.json",
  );
  const sourceReceiptFiles = input.files.filter(
    (file) => file.path === "records/source-materialization-receipt.v2.json",
  );
  if (
    sourceClosureFiles.length > 1 ||
    sourceReceiptFiles.length > 1 ||
    sourceClosureFiles.length !== sourceReceiptFiles.length
  )
    throw new Error(
      "published V2 revision must contain the exact source closure and materialization receipt pair",
    );
  if (sourceClosureFiles.length === 1) {
    const sourceClosure = parseCanonical(
      input.files,
      "records/source-closure.v1.json",
      (value) => ProjectSourceClosureV1Schema.parse(value),
    );
    const sourceReceipt = parseCanonical(
      input.files,
      "records/source-materialization-receipt.v2.json",
      (value) =>
        ProjectEnvironmentWorkspaceMaterializationReceiptV2Schema.parse(value),
    );
    if (
      sourceClosure.sourceId !== input.revision.sourceId ||
      sourceReceipt.sourceId !== input.revision.sourceId
    )
      return reuseFailure(
        "review_required",
        "review_required: published V2 source records differ from the selected source closure",
      );
    if (
      sourceReceipt.taskId !== conformance.taskId ||
      sourceClosure.sourceRevision !== sourceReceipt.sourceRevision ||
      sourceClosure.projectPath !== sourceReceipt.projectPrefix ||
      sourceClosure.selectedTreeSha256 !== sourceReceipt.selectedTreeSha256 ||
      sourceClosure.mainScene !== input.expectedMainScene
    )
      throw new Error(
        "published V2 source closure crossed its materialization or candidate binding",
      );
  }
  const targetValidationFiles = input.files.filter(
    (file) => file.path === "records/launch-target-validation.v1.json",
  );
  if (targetValidationFiles.length > 1)
    throw new Error(
      "published V2 revision contains duplicate launch-target validation",
    );
  const launchTargetValidation =
    targetValidationFiles.length === 1
      ? parseCanonical(
          input.files,
          "records/launch-target-validation.v1.json",
          (value) => ProjectAdapterLaunchTargetValidationV1Schema.parse(value),
        )
      : adapterPackage.manifest.launchTargets.length === 1
        ? ProjectAdapterLaunchTargetValidationV1Schema.parse({
            schemaVersion: 1,
            recordKind: "chronorift-project-adapter-launch-target-validation",
            defaultTargetId:
              adapterPackage.launchTargetSelection.defaultTarget.targetId,
            selectedTargetId:
              adapterPackage.launchTargetSelection.defaultTarget.targetId,
            targets: [
              {
                schemaVersion: 1,
                targetId:
                  adapterPackage.launchTargetSelection.defaultTarget.targetId,
                status: "validated",
                conformanceReceiptId: conformance.receiptId,
              },
            ],
          })
        : reuseFailure(
            "target_not_validated",
            "target_not_validated: published multi-target adapter has no validation record",
          );
  const selectedLaunchTarget = resolveReusableProjectEnvironmentLaunchTargetV2(
    adapterPackage,
    launchTargetValidation,
    input.selectedLaunchTargetId,
    conformance.receiptId,
  );
  const verifyRawChain = (
    rawRecordsPath: string,
    rawChainPath: string,
    expected?: {
      readonly rawRecordsSha256: string;
      readonly rawChainSha256: string;
    },
  ) => {
    const chainBytes = recordBytes(input.files, rawChainPath);
    const chain = parseCanonical(input.files, rawChainPath, (value) =>
      ProjectEnvironmentDynamicObservationChainV2Schema.parse(value),
    );
    const rawBytes = recordBytes(input.files, rawRecordsPath);
    if (
      createHash("sha256").update(rawBytes).digest("hex") !==
        chain.recordsSha256 ||
      (expected !== undefined &&
        (chain.recordsSha256 !== expected.rawRecordsSha256 ||
          createHash("sha256").update(chainBytes).digest("hex") !==
            expected.rawChainSha256)) ||
      chain.taskId !== conformance.taskId ||
      chain.adapterRevisionId !== adapterRevision.adapterRevisionId ||
      chain.manifestSha256 !== adapterPackage.manifestSha256
    )
      throw new Error("published V2 target raw chain crossed its binding");
    const records = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(rawBytes),
    ) as unknown;
    if (
      !Array.isArray(records) ||
      records.length !== chain.recordCount ||
      !Buffer.from(rawBytes).equals(
        Buffer.from(`${canonicalJson(records as never)}\n`),
      )
    )
      throw new Error(
        "published V2 target raw chain count or encoding mismatch",
      );
    const validator = new ProjectAdapterObservationExecutionValidatorV2(
      adapterPackage,
      chain.executionId,
    );
    const validated: GodotProjectEnvironmentObservationRecordV2[] = records.map(
      (record) => validator.validate(record),
    );
    const traces = recognizeProjectAdapterDynamicTracesV2(
      adapterPackage,
      validated,
    );
    const storedTraces = chain.traces.map((trace) => ({
      traceId: trace.traceId,
      entityId: trace.entityId,
      firstIncarnation: trace.firstIncarnation,
      lastIncarnation: trace.lastIncarnation,
      recordSequences: trace.recordSequences,
    }));
    if (
      canonicalJson(JSON.parse(JSON.stringify(traces)) as never) !==
      canonicalJson(storedTraces)
    )
      throw new Error("published V2 target dynamic trace cannot be replayed");
    return chain;
  };
  const launchTargetConformanceFiles = input.files.filter(
    (file) => file.path === LAUNCH_TARGET_CONFORMANCE_PATH,
  );
  if (launchTargetConformanceFiles.length > 1)
    throw new Error(
      "published V2 revision contains duplicate launch-target conformance",
    );
  const launchTargetConformance =
    launchTargetConformanceFiles.length === 1
      ? parseCanonical(input.files, LAUNCH_TARGET_CONFORMANCE_PATH, (value) =>
          ProjectAdapterLaunchTargetConformanceEvidenceV1Schema.parse(value),
        )
      : null;
  if (
    launchTargetConformance === null &&
    adapterPackage.manifest.launchTargets.length !== 1
  )
    throw new Error(
      "published multi-target V2 revision is missing target conformance evidence",
    );
  if (launchTargetConformance === null) {
    const chain = verifyRawChain(
      PRIMARY_RAW_RECORDS_PATH,
      PRIMARY_RAW_CHAIN_PATH,
    );
    if (
      conformance.rawObservationChainPath !== PRIMARY_RAW_RECORDS_PATH ||
      conformance.rawObservationChainSha256 !== chain.recordsSha256 ||
      canonicalJson(conformance.dynamicTraces) !== canonicalJson(chain.traces)
    )
      throw new Error("published legacy V2 raw chain digest mismatch");
  } else {
    const expectedTargetOrder =
      launchTargetValidation.defaultTargetId ===
      launchTargetValidation.selectedTargetId
        ? [launchTargetValidation.defaultTargetId]
        : [
            launchTargetValidation.defaultTargetId,
            launchTargetValidation.selectedTargetId,
          ];
    const validatedTargetIds = launchTargetValidation.targets
      .filter((target) => target.status === "validated")
      .map((target) => target.targetId)
      .sort();
    if (
      launchTargetConformance.conformanceReceiptId !== conformance.receiptId ||
      launchTargetConformance.defaultTargetId !==
        launchTargetValidation.defaultTargetId ||
      launchTargetConformance.selectedTargetId !==
        launchTargetValidation.selectedTargetId ||
      JSON.stringify(
        launchTargetConformance.targets.map((target) => target.targetId),
      ) !== JSON.stringify(expectedTargetOrder) ||
      JSON.stringify(
        launchTargetConformance.targets.map((target) => target.targetId).sort(),
      ) !== JSON.stringify(validatedTargetIds)
    )
      throw new Error(
        "published V2 target conformance crossed its validation record",
      );
    const verifiedChains = new Map(
      launchTargetConformance.targets.map((target) => [
        target.targetId,
        verifyRawChain(
          target.rawObservationRecordsPath,
          target.rawObservationChainPath,
          {
            rawRecordsSha256: target.rawObservationRecordsSha256,
            rawChainSha256: target.rawObservationChainSha256,
          },
        ),
      ]),
    );
    const selectedEvidence = launchTargetConformance.targets.find(
      (target) => target.targetId === launchTargetConformance.selectedTargetId,
    )!;
    const selectedChain = verifiedChains.get(selectedEvidence.targetId)!;
    if (
      conformance.rawObservationChainPath !==
        selectedEvidence.rawObservationRecordsPath ||
      conformance.rawObservationChainSha256 !==
        selectedEvidence.rawObservationRecordsSha256 ||
      canonicalJson(conformance.dynamicTraces) !==
        canonicalJson(selectedChain.traces)
    )
      throw new Error(
        "published V2 conformance receipt crossed its selected target raw chain",
      );
    const recomputedReceiptId = asAdapterConformanceReceiptId(
      `conformance:v2:${contentHash(
        JSON.parse(
          JSON.stringify({
            candidate: conformance.candidateDigest,
            targets: launchTargetConformance.targets.map((target) => ({
              targetId: target.targetId,
              vanilla: target.vanillaDigest,
              bridgeOnly: target.bridgeOnlyDigest,
              instrumented: target.instrumentedDigest,
            })),
            raw: selectedChain.recordsSha256,
            traces: selectedChain.traces,
          }),
        ) as never,
      )}`,
    );
    if (recomputedReceiptId !== conformance.receiptId)
      throw new Error(
        "published V2 target conformance digests do not reproduce the receipt identity",
      );
  }
  const observerEffect = parseCanonical(
    input.files,
    "records/observer-effect-receipt.v1.json",
    (value) => ObserverEffectReceiptV1Schema.parse(value),
  );
  const revisionBindingMismatches = [
    ["adapter-id", adapterRevision.adapterId !== input.expectedAdapterId],
    [
      "adapter-revision-id",
      adapterRevision.adapterRevisionId !== input.revision.adapterRevisionId,
    ],
    ["adapter-source", adapterRevision.sourceId !== input.revision.sourceId],
    [
      "adapter-package",
      adapterRevision.packageDigest !== adapterPackage.candidateSha256,
    ],
    [
      "adapter-manifest",
      adapterRevision.manifestDigest !== adapterPackage.manifestSha256,
    ],
    ["adapter-sdk", adapterRevision.sdkDigest !== input.revision.sdkDigest],
    [
      "adapter-bridge",
      adapterRevision.bridgeDigest !== input.revision.bridgeDigest,
    ],
    [
      "revision-conformance",
      conformance.receiptId !== input.revision.conformanceReceiptId,
    ],
    ["conformance-source", conformance.sourceId !== input.revision.sourceId],
    [
      "conformance-candidate",
      conformance.candidateDigest !== candidateContentDigest(adapterPackage),
    ],
    [
      "conformance-toolchain",
      conformance.toolchainReceiptId !== input.revision.toolchainReceiptId,
    ],
    ["conformance-outcome", conformance.outcome !== "conformed"],
    [
      "revision-observer-effect",
      observerEffect.receiptId !== input.revision.observerEffectReceiptId,
    ],
    ["observer-source", observerEffect.sourceId !== input.revision.sourceId],
    ["observer-task", observerEffect.taskId !== conformance.taskId],
    ["observer-attempt", observerEffect.attemptId !== conformance.attemptId],
    [
      "observer-candidate",
      observerEffect.candidateId !== conformance.candidateId,
    ],
  ]
    .filter((entry) => entry[1] === true)
    .map((entry) => entry[0]);
  if (revisionBindingMismatches.length > 0)
    throw new Error(
      `published V2 evidence closure crossed revision bindings: ${revisionBindingMismatches.join(", ")}`,
    );
  return Object.freeze({
    schemaVersion: 2,
    revision: input.revision,
    adapterRevision,
    conformance,
    observerEffect,
    launchTargetValidation,
    launchTargetConformance,
    selectedLaunchTarget,
    adapterPackage,
    adapterFiles: Object.freeze(adapterFiles),
  });
}
