import { createHash } from "node:crypto";

import {
  AdapterConformanceReceiptV2Schema,
  ObserverEffectReceiptV1Schema,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentDynamicObservationChainV2Schema,
  type AdapterConformanceReceiptV2,
  type AdapterId,
  type ObserverEffectReceiptV1,
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
} from "@chronorift/godot-adapter";
import type { GodotProjectEnvironmentObservationRecordV2 } from "@chronorift/godot-protocol";
import {
  canonicalJson,
  projectEnvironmentPackageContentDigestV1,
  type ProjectEnvironmentPackageFileInputV1,
} from "@chronorift/json-artifacts";

const recordBytes = (
  files: readonly ProjectEnvironmentPackageFileInputV1[],
  path: string,
): Uint8Array => {
  const matches = files.filter((file) => file.path === path);
  if (matches.length !== 1 || matches[0] === undefined)
    throw new Error(`published V2 Project Environment is missing ${path}`);
  return matches[0].bytes;
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
}): InspectedReusableProjectEnvironmentV2 {
  if (
    input.revision.sourceId !== input.expectedSourceId ||
    input.revision.toolchainReceiptId !== input.expectedToolchainReceiptId
  )
    throw new Error("current V2 environment differs from source/toolchain");
  const allowed = new Set([
    "records/adapter-revision.v1.json",
    "records/conformance-receipt.v2.json",
    "records/dynamic-projection-conformance.v2.json",
    "records/dynamic-projection-chain.v2.json",
    "records/observer-effect-receipt.v1.json",
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
  const adapterPackage = loadProjectAdapterPackageFilesV2(
    adapterFiles.map((file) => ({
      path: file.relativePath,
      bytes: file.bytes,
    })),
    {
      requireSingleLaunchTarget: true,
      expectedMainScene: input.expectedMainScene,
      requireEmptyLaunchParameters: true,
    },
  );
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
  const chain = parseCanonical(
    input.files,
    "records/dynamic-projection-chain.v2.json",
    (value) => ProjectEnvironmentDynamicObservationChainV2Schema.parse(value),
  );
  const rawBytes = recordBytes(
    input.files,
    "records/dynamic-projection-conformance.v2.json",
  );
  if (
    createHash("sha256").update(rawBytes).digest("hex") !==
      chain.recordsSha256 ||
    conformance.rawObservationChainSha256 !== chain.recordsSha256
  )
    throw new Error("published V2 raw chain digest mismatch");
  const records = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(rawBytes),
  ) as unknown;
  if (!Array.isArray(records) || records.length !== chain.recordCount)
    throw new Error("published V2 raw chain count mismatch");
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
    throw new Error("published V2 dynamic trace cannot be replayed");
  const observerEffect = parseCanonical(
    input.files,
    "records/observer-effect-receipt.v1.json",
    (value) => ObserverEffectReceiptV1Schema.parse(value),
  );
  if (
    adapterRevision.adapterId !== input.expectedAdapterId ||
    adapterRevision.adapterRevisionId !== input.revision.adapterRevisionId ||
    adapterRevision.packageDigest !== adapterPackage.candidateSha256 ||
    adapterRevision.manifestDigest !== adapterPackage.manifestSha256 ||
    adapterRevision.sdkDigest !== input.revision.sdkDigest ||
    adapterRevision.bridgeDigest !== input.revision.bridgeDigest ||
    conformance.receiptId !== input.revision.conformanceReceiptId ||
    conformance.outcome !== "conformed" ||
    observerEffect.receiptId !== input.revision.observerEffectReceiptId ||
    observerEffect.status !== "measured"
  )
    throw new Error("published V2 evidence closure crossed a revision binding");
  return Object.freeze({
    schemaVersion: 2,
    revision: input.revision,
    adapterRevision,
    conformance,
    observerEffect,
    adapterPackage,
    adapterFiles: Object.freeze(adapterFiles),
  });
}
