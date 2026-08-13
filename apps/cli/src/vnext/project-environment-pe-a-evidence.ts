import { createHash } from "node:crypto";

import {
  AdapterConformanceReceiptV1Schema,
  AdapterCompatibilityReceiptV1Schema,
  EnvironmentBindingEpochV1Schema,
  EnvironmentPublicationReceiptV1Schema,
  ObserverEffectReceiptV1Schema,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentBuildBindingV1Schema,
  ProjectEnvironmentPinnedCaptureV1Schema,
  ProjectEnvironmentReuseReceiptV1Schema,
  ProjectEnvironmentRevisionV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  ProjectEnvironmentTurnV1Schema,
  ProjectInitializationAttemptV1Schema,
  ProjectInitializationAttemptEventV1Schema,
  ProjectToolchainReceiptV1Schema,
  projectRuntimeCleanupCompleteV1,
  foldProjectInitializationAttemptV1,
  type ProjectEnvironmentRuntimeObservationReceiptV1,
  type JsonValue,
  type ProjectObservationCoverageV1,
} from "@chronorift/domain";
import type { LoadedProjectAdapterPackageV1 } from "@chronorift/godot-adapter";
import {
  canonicalJson,
  contentHash,
  projectEnvironmentPackageContentDigestV1,
  type ImmutablePackageSealV1,
  type ProjectEnvironmentPackageFileInputV1,
  type ProjectEnvironmentTaskEvidenceInventoryV1,
} from "@chronorift/json-artifacts";

import type { PreparedProjectEnvironmentGodotBuildV1 } from "./candidate-godot-build.js";
import type { VerifiedProjectEnvironmentSourceV1 } from "./source-preflight.js";

export interface BuildProjectEnvironmentPeAEvidenceV1Input {
  readonly source: VerifiedProjectEnvironmentSourceV1;
  readonly loadedAdapter: LoadedProjectAdapterPackageV1;
  readonly adapterRevision: unknown;
  readonly toolchain: unknown;
  readonly environmentRevision: unknown;
  readonly revisionFiles: readonly ProjectEnvironmentPackageFileInputV1[];
  readonly revisionPackage: {
    readonly payloadHash: string;
    readonly packageHash: string;
    readonly packageSeal: ImmutablePackageSealV1;
  };
  readonly publication: unknown;
  readonly initializationAttempt: unknown;
  readonly taskInventory: ProjectEnvironmentTaskEvidenceInventoryV1;
  readonly environmentBinding: unknown;
  readonly preparedBuild: PreparedProjectEnvironmentGodotBuildV1;
  readonly finalBuildBinding: unknown;
  readonly compatibility: unknown;
  readonly turns: readonly unknown[];
  /** A durable receipt read from ProjectEnvironmentTaskStoreV1. */
  readonly runtime: ProjectEnvironmentRuntimeObservationReceiptV1;
  /** Exact immutable packages named by runtime.captureWindowIds. */
  readonly pinnedCaptures: readonly ProjectEnvironmentPeAPinnedCaptureInputV1[];
  readonly reuse: BuildProjectEnvironmentPeAReuseEvidenceV1Input;
  readonly goalDelivered: boolean;
}

export interface ProjectEnvironmentPeAPinnedCaptureInputV1 {
  readonly payload: unknown;
  readonly records: readonly JsonValue[];
  readonly recordsBytes: Uint8Array;
  readonly payloadHash: string;
  readonly packageHash: string;
  readonly packageSeal: ImmutablePackageSealV1;
}

export interface BuildProjectEnvironmentPeAReuseEvidenceV1Input {
  /** Exact receipt body recorded by the reuse Task (the stable ID excludes observedAt). */
  readonly toolchain: unknown;
  readonly receipt: unknown;
  readonly environmentBinding: unknown;
  readonly preparedBuild: PreparedProjectEnvironmentGodotBuildV1;
  readonly finalBuildBinding: unknown;
  readonly compatibility: unknown;
  readonly turns: readonly unknown[];
  readonly runtime: ProjectEnvironmentRuntimeObservationReceiptV1;
  readonly pinnedCaptures: readonly ProjectEnvironmentPeAPinnedCaptureInputV1[];
  readonly taskInventory: ProjectEnvironmentTaskEvidenceInventoryV1;
  readonly goalDelivered: boolean;
}

const jsonFact = (value: unknown): Parameters<typeof contentHash>[0] =>
  JSON.parse(JSON.stringify(value)) as Parameters<typeof contentHash>[0];

const hash = (value: unknown): string => contentHash(jsonFact(value));

const seal = <T extends object>(
  value: T,
): Readonly<T & { recordHash: string }> =>
  Object.freeze({ ...value, recordHash: hash(value) });

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

function requireEvidence(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition)
    throw new TypeError(`invalid PE-A evidence input: ${message}`);
}

const requireTimestamp = (value: string, label: string): number => {
  const parsed = Date.parse(value);
  requireEvidence(
    Number.isFinite(parsed) && new Date(parsed).toISOString() === value,
    `${label} must be a canonical UTC timestamp`,
  );
  return parsed;
};

const requireCounter = (
  value: number,
  minimum: number,
  label: string,
): void => {
  requireEvidence(
    Number.isSafeInteger(value) && value >= minimum,
    `${label} is outside its counter bound`,
  );
};

const fileManifest = (files: readonly ProjectEnvironmentPackageFileInputV1[]) =>
  Object.freeze(
    files
      .map((file) =>
        Object.freeze({
          path: file.path,
          byteLength: file.bytes.byteLength,
          sha256: sha256(file.bytes),
        }),
      )
      .sort((left, right) => left.path.localeCompare(right.path)),
  );

const recordFileManifest = (files: LoadedProjectAdapterPackageV1["files"]) =>
  Object.freeze(
    files
      .map((file) =>
        Object.freeze({
          path: file.path,
          byteLength: file.bytes,
          sha256: file.sha256,
        }),
      )
      .sort((left, right) => left.path.localeCompare(right.path)),
  );

const packageDigest = (
  files: readonly {
    readonly path: string;
    readonly byteLength: number;
    readonly sha256: string;
  }[],
): string => hash({ schemaVersion: 1, files });

const adapterPackageDigest = (
  files: readonly {
    readonly path: string;
    readonly sha256: string;
  }[],
): string => {
  const identity = createHash("sha256");
  for (const file of files) {
    identity.update(file.path);
    identity.update("\0");
    identity.update(file.sha256);
    identity.update("\0");
  }
  return identity.digest("hex");
};

const embeddedAdapterJsonDocument = (input: {
  readonly revisionFiles: readonly ProjectEnvironmentPackageFileInputV1[];
  readonly adapterPath: string;
  readonly expectedSha256: string;
  readonly label: string;
}) => {
  const file = input.revisionFiles.find(
    (candidate) => candidate.path === `adapter/${input.adapterPath}`,
  );
  requireEvidence(
    file !== undefined &&
      file.bytes.byteLength > 0 &&
      file.bytes.byteLength <= 256 * 1024 &&
      sha256(file.bytes) === input.expectedSha256,
    `${input.label} exact published bytes are missing or invalid`,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
    ) as unknown;
  } catch {
    throw new TypeError(
      `invalid PE-A evidence input: ${input.label} is not strict UTF-8 JSON`,
    );
  }
  requireEvidence(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    `${input.label} must contain one JSON object`,
  );
  return Object.freeze({
    path: input.adapterPath,
    byteLength: file.bytes.byteLength,
    sha256: input.expectedSha256,
    canonicalBase64: Buffer.from(file.bytes).toString("base64"),
  });
};

const buildProjectHash = (
  sourceHash: string,
  buildConfigurationHash: string,
): string =>
  sha256(
    `chronorift-project-environment-build-v1\0${sourceHash}\0${buildConfigurationHash}`,
  );

const completeCoverage = (
  coverage: readonly ProjectObservationCoverageV1[],
  label: string,
): void => {
  requireEvidence(coverage.length > 0, `${label} has no coverage channels`);
  requireEvidence(
    new Set(coverage.map((entry) => entry.channelId)).size === coverage.length,
    `${label} contains duplicate coverage channels`,
  );
  for (const entry of coverage) {
    requireEvidence(
      entry.status === "complete" &&
        entry.observedRecords > 0 &&
        entry.droppedRecords === 0 &&
        entry.overwrittenRecords === 0 &&
        entry.limitations.length === 0,
      `${label}.${entry.channelId} is incomplete or declares loss`,
    );
  }
};

const REQUIRED_READY_MODULES = Object.freeze([
  "lifecycle",
  "clock",
  "runtime_error",
  "entity_projection",
  "state_projection",
  "event_projection",
  "capture",
] as const);

const exactPublishedReceipt = <T>(input: {
  readonly revisionFiles: readonly ProjectEnvironmentPackageFileInputV1[];
  readonly revisionManifest: readonly {
    readonly path: string;
    readonly byteLength: number;
    readonly sha256: string;
  }[];
  readonly path: string;
  readonly label: string;
  readonly parse: (value: unknown) => T;
}) => {
  const file = input.revisionFiles.find(
    (candidate) => candidate.path === input.path,
  );
  const manifest = input.revisionManifest.find(
    (candidate) => candidate.path === input.path,
  );
  requireEvidence(
    file !== undefined && manifest !== undefined,
    `published revision is missing ${input.path}`,
  );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    throw new TypeError(
      `invalid PE-A evidence input: ${input.label} is not UTF-8`,
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError(
      `invalid PE-A evidence input: ${input.label} is not JSON`,
    );
  }
  const receipt = input.parse(parsedJson);
  const canonicalBytes = Buffer.from(
    `${canonicalJson(jsonFact(receipt))}\n`,
    "utf8",
  );
  requireEvidence(
    Buffer.from(file.bytes).equals(canonicalBytes),
    `${input.label} is not the exact canonical published record`,
  );
  requireEvidence(
    manifest.byteLength === canonicalBytes.byteLength &&
      manifest.sha256 === sha256(canonicalBytes),
    `${input.label} does not match the revision file manifest`,
  );
  return seal({
    schemaVersion: 1 as const,
    path: input.path,
    byteLength: manifest.byteLength,
    sha256: manifest.sha256,
    receipt,
  });
};

const captureEvidence = (input: {
  readonly stored: ProjectEnvironmentPeAPinnedCaptureInputV1;
  readonly runtime: ProjectEnvironmentRuntimeObservationReceiptV1;
  readonly label: string;
}) => {
  const manifest = ProjectEnvironmentPinnedCaptureV1Schema.parse(
    input.stored.payload,
  );
  const canonicalRecords = Buffer.from(
    `${canonicalJson(jsonFact(input.stored.records))}\n`,
    "utf8",
  );
  requireEvidence(
    canonicalRecords.byteLength <= 4 * 1024 * 1024 &&
      Buffer.from(input.stored.recordsBytes).equals(canonicalRecords),
    `${input.label} raw records are not the bounded canonical records.json bytes`,
  );
  const recordsFile = Object.freeze({
    path: "records.json" as const,
    byteLength: canonicalRecords.byteLength,
    sha256: sha256(canonicalRecords),
  });
  requireEvidence(
    manifest.taskId === input.runtime.taskId &&
      manifest.runtimeId === input.runtime.runtimeId &&
      manifest.executionId === input.runtime.executionId &&
      manifest.buildId === input.runtime.buildId &&
      manifest.environmentRevisionId === input.runtime.environmentRevisionId &&
      manifest.adapterRevisionId === input.runtime.adapterRevisionId &&
      manifest.recordCount === input.stored.records.length &&
      manifest.contentDigest === packageDigest([recordsFile]) &&
      manifest.loss.length === 0,
    `${input.label} manifest crossed its runtime lineage or raw records`,
  );
  completeCoverage(manifest.coverage, `${input.label} coverage`);
  const payloadHash = hash(manifest);
  requireEvidence(
    input.stored.payloadHash === payloadHash,
    `${input.label} payload hash is invalid`,
  );
  const envelopeBasis = {
    schemaVersion: 1 as const,
    ownerId: manifest.taskId,
    resourceId: manifest.captureWindowId,
    payload: manifest,
    payloadHash,
  };
  const envelopeRecordHash = hash(envelopeBasis);
  const sealBasis = {
    schemaVersion: 1 as const,
    ownerId: manifest.taskId,
    resourceId: manifest.captureWindowId,
    operationId: null,
    recordHash: envelopeRecordHash,
    files: [recordsFile],
    packageByteLength: recordsFile.byteLength,
  };
  const packageHash = hash(sealBasis);
  requireEvidence(
    hash(input.stored.packageSeal) === hash({ ...sealBasis, packageHash }) &&
      input.stored.packageSeal.packageHash === packageHash &&
      input.stored.packageHash === packageHash,
    `${input.label} immutable package seal is invalid`,
  );
  return seal({
    schemaVersion: 1 as const,
    manifest,
    recordsCanonicalBase64: canonicalRecords.toString("base64"),
    payloadHash,
    packageSeal: Object.freeze({ ...sealBasis, packageHash }),
  });
};

const runtimeCaptureEvidence = (input: {
  readonly runtime: ProjectEnvironmentRuntimeObservationReceiptV1;
  readonly captures: readonly ProjectEnvironmentPeAPinnedCaptureInputV1[];
  readonly label: string;
}) => {
  requireEvidence(
    input.captures.length === input.runtime.captureCount &&
      input.runtime.captureWindowIds.length === input.runtime.captureCount,
    `${input.label} does not contain every runtime capture window`,
  );
  const byId = new Map(
    input.captures.map((capture) => {
      const manifest = ProjectEnvironmentPinnedCaptureV1Schema.parse(
        capture.payload,
      );
      return [manifest.captureWindowId, capture] as const;
    }),
  );
  requireEvidence(
    byId.size === input.captures.length &&
      input.runtime.captureWindowIds.every((captureWindowId) =>
        byId.has(captureWindowId),
      ),
    `${input.label} capture identities are missing or duplicated`,
  );
  return Object.freeze(
    input.runtime.captureWindowIds.map((captureWindowId, index) =>
      captureEvidence({
        stored: byId.get(captureWindowId)!,
        runtime: input.runtime,
        label: `${input.label}[${index}]`,
      }),
    ),
  );
};

const taskInventoryEvidence = (input: {
  readonly inventory: ProjectEnvironmentTaskEvidenceInventoryV1;
  readonly expectedCandidateCount: number;
  readonly expectedCaptureWindowIds: readonly string[];
  readonly label: string;
}) => {
  const inventory = input.inventory;
  requireEvidence(
    inventory.schemaVersion === 1 &&
      inventory.candidatePackages.length === input.expectedCandidateCount,
    `${input.label} candidate package inventory is not the expected physical closure`,
  );
  const resourceDigest = (kind: string, resourceId: string): string =>
    sha256(`${kind}\0${inventory.taskId}\0${resourceId}`);
  const checkPackages = (
    packages: typeof inventory.candidatePackages,
    storeKind: string,
    label: string,
  ) => {
    requireEvidence(
      new Set(packages.map((entry) => entry.resourceId)).size ===
        packages.length,
      `${label} contains duplicate resources`,
    );
    for (const entry of packages) {
      requireEvidence(
        entry.resourceDigest === resourceDigest(storeKind, entry.resourceId),
        `${label} resource digest is invalid`,
      );
    }
  };
  checkPackages(
    inventory.candidatePackages,
    "chronorift-project-adapter-candidate-v1",
    `${input.label} candidates`,
  );
  checkPackages(
    inventory.captureWindowPackages,
    "chronorift-project-environment-pinned-capture-v1",
    `${input.label} captures`,
  );
  requireEvidence(
    inventory.captureWindowPackages.length ===
      input.expectedCaptureWindowIds.length &&
      input.expectedCaptureWindowIds.every((id) =>
        inventory.captureWindowPackages.some(
          (entry) => entry.resourceId === id,
        ),
      ),
    `${input.label} capture package inventory does not match runtime receipts`,
  );
  for (const [index, record] of inventory.records.entries()) {
    requireEvidence(
      record.schemaVersion === 1 &&
        record.taskId === inventory.taskId &&
        record.resourceDigest ===
          resourceDigest(record.recordKind, record.resourceId) &&
        record.payloadHash === hash(record.payload),
      `${input.label} record[${index}] identity or payload hash is invalid`,
    );
    const recordBasis = {
      schemaVersion: 1 as const,
      taskId: record.taskId,
      recordKind: record.recordKind,
      resourceId: record.resourceId,
      resourceDigest: record.resourceDigest,
      payload: record.payload,
      payloadHash: record.payloadHash,
    };
    requireEvidence(
      record.recordHash === hash(recordBasis),
      `${input.label} record[${index}] envelope hash is invalid`,
    );
  }
  requireEvidence(
    new Set(
      inventory.records.map(
        (record) => `${record.recordKind}\0${record.resourceId}`,
      ),
    ).size === inventory.records.length,
    `${input.label} contains duplicate immutable Task records`,
  );
  const ledgerPayloads = new Map<string, readonly unknown[]>();
  requireEvidence(
    inventory.ledgers.length === 3 &&
      new Set(inventory.ledgers.map((ledger) => ledger.kind)).size === 3,
    `${input.label} must contain all three sealed ledgers`,
  );
  for (const ledger of inventory.ledgers) {
    const bytes = Buffer.from(ledger.canonicalBase64, "base64");
    requireEvidence(
      bytes.toString("base64") === ledger.canonicalBase64 &&
        ledger.seal.ownerId === inventory.taskId &&
        ledger.seal.recordCount === ledger.envelopes.length &&
        ledger.seal.finalRecordHash ===
          (ledger.envelopes.at(-1)?.recordHash ?? null) &&
        ledger.seal.ledgerByteLength === bytes.byteLength &&
        ledger.seal.ledgerSha256 === sha256(bytes),
      `${input.label}.${ledger.kind} seal does not match raw ledger bytes`,
    );
    let previousRecordHash: string | null = null;
    const canonicalLines: string[] = [];
    for (const [sequence, envelope] of ledger.envelopes.entries()) {
      const basis = {
        schemaVersion: 1 as const,
        ownerId: inventory.taskId,
        sequence,
        previousRecordHash,
        payload: envelope.payload,
      };
      requireEvidence(
        envelope.schemaVersion === 1 &&
          envelope.ownerId === inventory.taskId &&
          envelope.sequence === sequence &&
          envelope.previousRecordHash === previousRecordHash &&
          envelope.recordHash === hash(basis),
        `${input.label}.${ledger.kind} chain is invalid at ${sequence}`,
      );
      canonicalLines.push(canonicalJson(jsonFact(envelope)));
      previousRecordHash = envelope.recordHash;
    }
    const expectedBytes = Buffer.from(
      canonicalLines.length === 0 ? "" : `${canonicalLines.join("\n")}\n`,
      "utf8",
    );
    requireEvidence(
      bytes.equals(expectedBytes),
      `${input.label}.${ledger.kind} raw bytes are not canonical envelopes`,
    );
    ledgerPayloads.set(
      ledger.kind,
      Object.freeze(ledger.envelopes.map((envelope) => envelope.payload)),
    );
  }
  const inventoryBasis = {
    schemaVersion: 1 as const,
    taskId: inventory.taskId,
    candidatePackages: inventory.candidatePackages,
    captureWindowPackages: inventory.captureWindowPackages,
    records: inventory.records,
    ledgers: inventory.ledgers,
  };
  requireEvidence(
    inventory.inventoryHash === hash(inventoryBasis),
    `${input.label} inventory hash is invalid`,
  );
  return {
    evidence: seal({ ...inventory }),
    records: inventory.records,
    attemptEvents: (ledgerPayloads.get("attempt-events") ?? []).map((value) =>
      ProjectInitializationAttemptEventV1Schema.parse(value),
    ),
    bindingEpochs: (ledgerPayloads.get("binding-epochs") ?? []).map((value) =>
      EnvironmentBindingEpochV1Schema.parse(value),
    ),
    turns: (ledgerPayloads.get("turns") ?? []).map((value) =>
      ProjectEnvironmentTurnV1Schema.parse(value),
    ),
  };
};

/**
 * Projects already-validated product records into the frozen PE-A evidence
 * manifest. This helper performs no I/O and does not infer facts from Agent
 * prose. The independent Node validator remains the release evidence reader.
 */
export function buildProjectEnvironmentPeAEvidenceV1(
  input: BuildProjectEnvironmentPeAEvidenceV1Input,
) {
  const adapterRevision = ProjectAdapterRevisionV1Schema.parse(
    input.adapterRevision,
  );
  const toolchain = ProjectToolchainReceiptV1Schema.parse(input.toolchain);
  const environmentRevision = ProjectEnvironmentRevisionV1Schema.parse(
    input.environmentRevision,
  );
  const publication = EnvironmentPublicationReceiptV1Schema.parse(
    input.publication,
  );
  const environmentBinding = EnvironmentBindingEpochV1Schema.parse(
    input.environmentBinding,
  );
  const finalBuildBinding = ProjectEnvironmentBuildBindingV1Schema.parse(
    input.finalBuildBinding,
  );
  const compatibility = AdapterCompatibilityReceiptV1Schema.parse(
    input.compatibility,
  );
  const turns = input.turns.map((turn) =>
    ProjectEnvironmentTurnV1Schema.parse(turn),
  );
  const initializationAttempt = ProjectInitializationAttemptV1Schema.parse(
    input.initializationAttempt,
  );
  const sourceIdentityBasis = {
    schemaVersion: 1 as const,
    sourceKind: input.source.sourceKind,
    headCommit: input.source.headCommit,
    selectedTreeSha256: input.source.selectedTreeSha256,
    mainScene: input.source.mainScene,
    requestedGodotVersion: input.source.requestedGodotVersion,
  };
  requireEvidence(
    hash(sourceIdentityBasis) === input.source.projectSourceIdentity,
    "verified source identity does not match its canonical content",
  );
  const sourceId = `source:v1:${input.source.projectSourceIdentity}`;
  const source = seal({
    schemaVersion: 1 as const,
    sourceId,
    projectSourceIdentity: input.source.projectSourceIdentity,
    sourceKind: input.source.sourceKind,
    headCommit: input.source.headCommit,
    selectedTreeSha256: input.source.selectedTreeSha256,
    mainScene: input.source.mainScene,
    requestedGodotVersion: input.source.requestedGodotVersion,
    clean: true as const,
    rootCount: 1 as const,
    projectCount: 1 as const,
    credentialLikePathCount: 0 as const,
  });
  const toolchainIdentity = {
    schemaVersion: 1 as const,
    requested: toolchain.requested,
    status: toolchain.status,
    realized: toolchain.realized,
    limitations: [...toolchain.limitations],
  };
  requireEvidence(
    toolchain.status === "realized" &&
      toolchain.realized !== null &&
      toolchain.requested.engineFamily === "godot" &&
      toolchain.requested.versionRequirement === "4.7.1" &&
      toolchain.realized.engineFamily === "godot" &&
      toolchain.realized.version === "4.7.1" &&
      toolchain.requested.platform === toolchain.realized.platform &&
      toolchain.requested.requiredFeatures.every((feature) =>
        toolchain.realized!.features.includes(feature),
      ) &&
      toolchain.limitations.length === 0 &&
      toolchain.receiptId ===
        `toolchain-receipt:v1:${hash({
          schemaVersion: 1,
          label: "toolchain-receipt",
          value: toolchainIdentity,
        })}`,
    "toolchain receipt does not prove the requested realized Godot 4.7.1 artifact",
  );
  const toolchainEvidence = seal({ ...toolchain });

  const adapterFiles = recordFileManifest(input.loadedAdapter.files);
  const adapterPackageIdentity = adapterPackageDigest(adapterFiles);
  requireEvidence(
    input.loadedAdapter.schemaVersion === 1 &&
      input.loadedAdapter.candidateSha256 === adapterPackageIdentity &&
      adapterRevision.packageDigest === adapterPackageIdentity &&
      adapterRevision.adapterRevisionId ===
        `adapter-revision:v1:${adapterPackageIdentity}`,
    "loaded Adapter package and revision identities do not match",
  );
  requireEvidence(
    adapterRevision.sourceId === sourceId &&
      adapterRevision.manifestDigest === input.loadedAdapter.manifestSha256 &&
      adapterRevision.adapterId === input.loadedAdapter.manifest.adapterId,
    "Adapter revision does not match the verified source or loaded manifest",
  );
  const implementationDigest = sha256(
    `project-adapter-implementation-v1\0${adapterFiles
      .filter((file) => file.path.endsWith(".gd"))
      .map((file) => `${file.path}:${file.sha256}`)
      .join("\n")}`,
  );
  const payloadSchemas = Object.freeze(
    input.loadedAdapter.manifest.schemas.map((schema) =>
      Object.freeze({
        schemaId: schema.schemaId,
        path: schema.path,
        sha256: schema.sha256,
      }),
    ),
  );
  const payloadSchemaDigest = sha256(
    `project-adapter-payload-schemas-v1\0${payloadSchemas
      .map((schema) => `${schema.schemaId}:${schema.sha256}`)
      .join("\n")}`,
  );
  requireEvidence(
    adapterRevision.implementationDigest === implementationDigest &&
      adapterRevision.payloadSchemaDigest === payloadSchemaDigest &&
      adapterRevision.contentByteLength === input.loadedAdapter.totalBytes &&
      adapterRevision.contentFileCount === adapterFiles.length,
    "Adapter revision content digests or counts do not match the loaded package",
  );
  const adapterDocuments = seal({
    schemaVersion: 1 as const,
    manifest: embeddedAdapterJsonDocument({
      revisionFiles: input.revisionFiles,
      adapterPath: "manifest.json",
      expectedSha256: input.loadedAdapter.manifestSha256,
      label: "published adapter manifest",
    }),
    payloadSchemas: Object.freeze(
      input.loadedAdapter.manifest.schemas.map((schema) =>
        embeddedAdapterJsonDocument({
          revisionFiles: input.revisionFiles,
          adapterPath: schema.path,
          expectedSha256: schema.sha256,
          label: `published adapter schema ${schema.schemaId}`,
        }),
      ),
    ),
  });
  const adapter = seal({
    schemaVersion: 1 as const,
    adapterRevisionId: adapterRevision.adapterRevisionId,
    adapterId: adapterRevision.adapterId,
    sourceId: adapterRevision.sourceId,
    packageFiles: adapterFiles,
    packageDigest: adapterRevision.packageDigest,
    manifestDigest: adapterRevision.manifestDigest,
    implementationDigest: adapterRevision.implementationDigest,
    payloadSchemas,
    payloadSchemaDigest: adapterRevision.payloadSchemaDigest,
    sdkDigest: adapterRevision.sdkDigest,
    bridgeDigest: adapterRevision.bridgeDigest,
    conformanceReceiptId: adapterRevision.conformanceReceiptId,
    modules: Object.freeze(
      adapterRevision.capabilitySet.modules.map((module) =>
        Object.freeze({ ...module, limitations: [...module.limitations] }),
      ),
    ),
    contentByteLength: adapterRevision.contentByteLength,
    contentFileCount: adapterRevision.contentFileCount,
    documents: adapterDocuments,
  });

  const revisionFiles = fileManifest(input.revisionFiles);
  requireEvidence(
    projectEnvironmentPackageContentDigestV1(input.revisionFiles) ===
      environmentRevision.contentDigest &&
      packageDigest(revisionFiles) === environmentRevision.contentDigest,
    "environment revision files do not match the published content digest",
  );
  for (const adapterFile of adapterFiles) {
    const stored = revisionFiles.find(
      (file) => file.path === `adapter/${adapterFile.path}`,
    );
    requireEvidence(
      stored?.byteLength === adapterFile.byteLength &&
        stored.sha256 === adapterFile.sha256,
      `environment revision does not preserve adapter/${adapterFile.path}`,
    );
  }
  requireEvidence(
    environmentRevision.sourceId === sourceId &&
      environmentRevision.adapterRevisionId ===
        adapterRevision.adapterRevisionId &&
      environmentRevision.sdkDigest === adapterRevision.sdkDigest &&
      environmentRevision.bridgeDigest === adapterRevision.bridgeDigest &&
      environmentRevision.toolchainReceiptId === toolchain.receiptId &&
      environmentRevision.conformanceReceiptId ===
        adapterRevision.conformanceReceiptId,
    "environment revision does not match source or Adapter revision",
  );
  const publishedConformance = exactPublishedReceipt({
    revisionFiles: input.revisionFiles,
    revisionManifest: revisionFiles,
    path: "records/conformance-receipt.v1.json",
    label: "published conformance receipt",
    parse: (value) => AdapterConformanceReceiptV1Schema.parse(value),
  });
  const publishedObserverEffect = exactPublishedReceipt({
    revisionFiles: input.revisionFiles,
    revisionManifest: revisionFiles,
    path: "records/observer-effect-receipt.v1.json",
    label: "published observer-effect receipt",
    parse: (value) => ObserverEffectReceiptV1Schema.parse(value),
  });
  const conformance = publishedConformance.receipt;
  requireEvidence(
    conformance.receiptId === environmentRevision.conformanceReceiptId &&
      conformance.receiptId === adapterRevision.conformanceReceiptId &&
      conformance.sourceId === sourceId &&
      conformance.candidateDigest.length === 64 &&
      conformance.toolchainReceiptId ===
        environmentRevision.toolchainReceiptId &&
      conformance.outcome === "conformed" &&
      conformance.failures.length === 0 &&
      conformance.stateDomains.length > 0 &&
      REQUIRED_READY_MODULES.every(
        (module) =>
          conformance.capabilitySet.modules.find(
            (candidate) => candidate.module === module,
          )?.status === "implemented",
      ) &&
      hash(conformance.capabilitySet) === hash(adapterRevision.capabilitySet) &&
      conformance.observations.bridgeHandshakes > 0 &&
      conformance.observations.entityLifecycleRecords > 0 &&
      conformance.observations.stateSamples > 0 &&
      conformance.observations.queries > 0 &&
      conformance.observations.captures > 0 &&
      conformance.observations.observedCustomEventTypes ===
        conformance.observations.declaredCustomEventTypes &&
      projectRuntimeCleanupCompleteV1(conformance.cleanup),
    "published conformance receipt does not establish the declared Ready boundary",
  );
  completeCoverage(conformance.coverage, "published conformance coverage");
  const observerEffect = publishedObserverEffect.receipt;
  requireEvidence(
    observerEffect.receiptId === environmentRevision.observerEffectReceiptId &&
      observerEffect.taskId === conformance.taskId &&
      observerEffect.attemptId === conformance.attemptId &&
      observerEffect.sourceId === conformance.sourceId &&
      observerEffect.candidateId === conformance.candidateId &&
      observerEffect.status === "measured",
    "published observer-effect receipt crossed its conformance binding",
  );
  const publishedReceipts = seal({
    schemaVersion: 1 as const,
    conformance: publishedConformance,
    observerEffect: publishedObserverEffect,
  });
  const environmentIdentityBasis = {
    schemaVersion: 1 as const,
    environmentId: environmentRevision.environmentId,
    sourceId: environmentRevision.sourceId,
    adapterRevisionId: environmentRevision.adapterRevisionId,
    sdkDigest: environmentRevision.sdkDigest,
    bridgeDigest: environmentRevision.bridgeDigest,
    toolchainReceiptId: environmentRevision.toolchainReceiptId,
    conformanceReceiptId: environmentRevision.conformanceReceiptId,
    observerEffectReceiptId: environmentRevision.observerEffectReceiptId,
    policyProfileDigest: environmentRevision.policyProfileDigest,
    publicationOperationId: environmentRevision.publicationOperationId,
    contentDigest: environmentRevision.contentDigest,
  };
  requireEvidence(
    environmentRevision.environmentRevisionId ===
      `environment-revision:v1:${hash(environmentIdentityBasis)}`,
    "environment revision identity does not match canonical content",
  );
  const revisionPayloadHash = hash(environmentRevision);
  const revisionEnvelopeBasis = {
    schemaVersion: 1 as const,
    ownerId: environmentRevision.environmentId,
    resourceId: environmentRevision.environmentRevisionId,
    payload: environmentRevision,
    payloadHash: revisionPayloadHash,
  };
  const revisionSealBasis = {
    schemaVersion: 1 as const,
    ownerId: environmentRevision.environmentId,
    resourceId: environmentRevision.environmentRevisionId,
    operationId: environmentRevision.publicationOperationId,
    recordHash: hash(revisionEnvelopeBasis),
    files: revisionFiles,
    packageByteLength: revisionFiles.reduce(
      (total, file) => total + file.byteLength,
      0,
    ),
  };
  const revisionPackageHash = hash(revisionSealBasis);
  requireEvidence(
    input.revisionPackage.payloadHash === revisionPayloadHash &&
      input.revisionPackage.packageHash === revisionPackageHash &&
      input.revisionPackage.packageSeal.packageHash === revisionPackageHash &&
      hash(input.revisionPackage.packageSeal) ===
        hash({ ...revisionSealBasis, packageHash: revisionPackageHash }),
    "published revision immutable package seal is invalid",
  );
  const revisionPackage = seal({
    schemaVersion: 1 as const,
    payloadHash: revisionPayloadHash,
    packageSeal: Object.freeze({
      ...revisionSealBasis,
      packageHash: revisionPackageHash,
    }),
  });
  const environment = seal({
    ...environmentIdentityBasis,
    environmentRevisionId: environmentRevision.environmentRevisionId,
    revisionFiles,
    publishedAt: environmentRevision.publishedAt,
    revisionPackage,
  });

  requireEvidence(
    publication.outcome === "committed" &&
      publication.revisionMaterialized &&
      publication.pointerCommitted &&
      publication.environmentId === environmentRevision.environmentId &&
      publication.targetEnvironmentRevisionId ===
        environmentRevision.environmentRevisionId &&
      publication.realizedCurrentRevisionId ===
        environmentRevision.environmentRevisionId &&
      publication.operationId === environmentRevision.publicationOperationId &&
      publication.expectedCurrentRevisionId === null &&
      publication.observedCurrentRevisionId === null &&
      publication.failures.length === 0,
    "publication is not the committed initial pointer for the revision",
  );
  const publicationContent = {
    schemaVersion: publication.schemaVersion,
    operationId: publication.operationId,
    taskId: publication.taskId,
    attemptId: publication.attemptId,
    environmentId: publication.environmentId,
    targetEnvironmentRevisionId: publication.targetEnvironmentRevisionId,
    expectedCurrentRevisionId: publication.expectedCurrentRevisionId,
    observedCurrentRevisionId: publication.observedCurrentRevisionId,
    realizedCurrentRevisionId: publication.realizedCurrentRevisionId,
    revisionMaterialized: publication.revisionMaterialized,
    pointerCommitted: publication.pointerCommitted,
    outcome: publication.outcome,
    failures: [...publication.failures],
    completedAt: publication.completedAt,
  };
  requireEvidence(
    publication.receiptId ===
      `publication-receipt:v1:${hash(publicationContent)}`,
    "publication receipt identity does not match canonical content",
  );
  const publicationEvidence = seal({
    ...publicationContent,
    receiptId: publication.receiptId,
  });

  const build = input.preparedBuild.build;
  requireEvidence(
    build.sourceHash !== input.source.selectedTreeSha256,
    "candidate Build does not contain a source change",
  );
  requireEvidence(
    build.sourceId === `source:${build.sourceHash}` &&
      build.workspaceDiffHash ===
        hash({
          schemaVersion: 1,
          baselineSourceHash: input.source.selectedTreeSha256,
          candidateSourceHash: build.sourceHash,
        }),
    "candidate Build source or workspace-diff identity is invalid",
  );
  requireEvidence(
    input.preparedBuild.projectHash ===
      buildProjectHash(build.sourceHash, build.buildConfigurationHash) &&
      build.outputHash === input.preparedBuild.projectHash &&
      build.buildId ===
        `build:${hash({
          schemaVersion: 1,
          projectHash: input.preparedBuild.projectHash,
          buildConfigurationHash: build.buildConfigurationHash,
          outputHash: build.outputHash,
        })}`,
    "candidate Build project/output hash does not match its source and configuration",
  );
  requireEvidence(
    finalBuildBinding.compatibilityStatus === "compatible" &&
      finalBuildBinding.compatibilityReceiptId !== null &&
      finalBuildBinding.taskId === build.taskId &&
      finalBuildBinding.workspaceId === build.workspaceId &&
      finalBuildBinding.sourceId === build.sourceId &&
      finalBuildBinding.buildId === build.buildId &&
      finalBuildBinding.bindingEpochId ===
        input.preparedBuild.binding.bindingEpochId &&
      finalBuildBinding.environmentRevisionId ===
        environmentRevision.environmentRevisionId &&
      finalBuildBinding.adapterRevisionId ===
        adapterRevision.adapterRevisionId &&
      finalBuildBinding.payloadSchemaDigest ===
        adapterRevision.payloadSchemaDigest &&
      finalBuildBinding.sdkDigest === environmentRevision.sdkDigest &&
      finalBuildBinding.bridgeDigest === environmentRevision.bridgeDigest &&
      finalBuildBinding.toolchainReceiptId ===
        environmentRevision.toolchainReceiptId,
    "final candidate Build binding is not exact and compatible",
  );
  requireEvidence(
    compatibility.receiptId === finalBuildBinding.compatibilityReceiptId &&
      compatibility.taskId === build.taskId &&
      compatibility.buildId === build.buildId &&
      compatibility.sourceId === build.sourceId &&
      compatibility.environmentRevisionId ===
        environmentRevision.environmentRevisionId &&
      compatibility.adapterRevisionId === adapterRevision.adapterRevisionId &&
      compatibility.toolchainReceiptId ===
        environmentRevision.toolchainReceiptId &&
      compatibility.outcome === "compatible" &&
      compatibility.failures.length === 0,
    "compatibility receipt does not bind the exact candidate Build",
  );
  completeCoverage(compatibility.coverage, "compatibility coverage");
  requireEvidence(
    projectRuntimeCleanupCompleteV1(compatibility.cleanup),
    "compatibility cleanup is incomplete",
  );
  const compatibilityContent = {
    schemaVersion: compatibility.schemaVersion,
    taskId: compatibility.taskId,
    buildId: compatibility.buildId,
    sourceId: compatibility.sourceId,
    environmentRevisionId: compatibility.environmentRevisionId,
    adapterRevisionId: compatibility.adapterRevisionId,
    toolchainReceiptId: compatibility.toolchainReceiptId,
    bridgeHandshakeObserved: compatibility.bridgeHandshakeObserved,
    instrumentedLaunchObserved: compatibility.instrumentedLaunchObserved,
    queryObservations: compatibility.queryObservations,
    coverage: compatibility.coverage.map((entry) => ({
      ...entry,
      limitations: [...entry.limitations],
    })),
    capabilitySet: {
      schemaVersion: 1 as const,
      modules: adapter.modules,
    },
    cleanup: compatibility.cleanup,
    outcome: compatibility.outcome,
    failures: [...compatibility.failures],
    observedAt: compatibility.observedAt,
  };
  requireEvidence(
    compatibility.receiptId ===
      `compatibility:v1:${hash(compatibilityContent)}`,
    "compatibility receipt identity does not match canonical content",
  );
  const compatibilityEvidence = seal({
    schemaVersion: compatibility.schemaVersion,
    receiptId: compatibility.receiptId,
    taskId: compatibility.taskId,
    buildId: compatibility.buildId,
    sourceId: compatibility.sourceId,
    environmentRevisionId: compatibility.environmentRevisionId,
    adapterRevisionId: compatibility.adapterRevisionId,
    toolchainReceiptId: compatibility.toolchainReceiptId,
    bridgeHandshakeObserved: compatibility.bridgeHandshakeObserved,
    instrumentedLaunchObserved: compatibility.instrumentedLaunchObserved,
    queryObservations: compatibility.queryObservations,
    coverage: compatibilityContent.coverage,
    modules: adapter.modules,
    cleanup: compatibility.cleanup,
    outcome: compatibility.outcome,
    failures: [...compatibility.failures],
    observedAt: compatibility.observedAt,
  });
  const candidateBuild = seal({
    schemaVersion: 1 as const,
    taskId: build.taskId,
    workspaceId: build.workspaceId,
    sourceId: build.sourceId,
    buildId: build.buildId,
    baselineSourceHash: input.source.selectedTreeSha256,
    sourceHash: build.sourceHash,
    workspaceDiffHash: build.workspaceDiffHash,
    buildConfigurationHash: build.buildConfigurationHash,
    projectHash: input.preparedBuild.projectHash,
    outputHash: build.outputHash,
    bindingEpochId: finalBuildBinding.bindingEpochId,
    environmentRevisionId: finalBuildBinding.environmentRevisionId,
    adapterRevisionId: finalBuildBinding.adapterRevisionId,
    payloadSchemaDigest: finalBuildBinding.payloadSchemaDigest,
    sdkDigest: finalBuildBinding.sdkDigest,
    bridgeDigest: finalBuildBinding.bridgeDigest,
    toolchainReceiptId: finalBuildBinding.toolchainReceiptId,
    compatibilityReceiptId: finalBuildBinding.compatibilityReceiptId,
    createdAt: build.createdAt,
  });

  requireEvidence(
    environmentBinding.state === "bound" &&
      environmentBinding.taskId === publication.taskId &&
      environmentBinding.attemptId === publication.attemptId &&
      environmentBinding.bindingEpochId === finalBuildBinding.bindingEpochId &&
      environmentBinding.publicationOperationId === publication.operationId &&
      environmentBinding.publicationReceiptId === publication.receiptId &&
      environmentBinding.environment.environmentRevisionId ===
        environmentRevision.environmentRevisionId &&
      hash(environmentBinding.environment) ===
        hash({
          schemaVersion: environmentRevision.schemaVersion,
          environmentId: environmentRevision.environmentId,
          environmentRevisionId: environmentRevision.environmentRevisionId,
          sourceId: environmentRevision.sourceId,
          adapterRevisionId: environmentRevision.adapterRevisionId,
          sdkDigest: environmentRevision.sdkDigest,
          bridgeDigest: environmentRevision.bridgeDigest,
          toolchainReceiptId: environmentRevision.toolchainReceiptId,
          conformanceReceiptId: environmentRevision.conformanceReceiptId,
          observerEffectReceiptId: environmentRevision.observerEffectReceiptId,
          policyProfileDigest: environmentRevision.policyProfileDigest,
          contentDigest: environmentRevision.contentDigest,
        }),
    "environment binding does not match publication and candidate Build",
  );
  const binding = seal({
    schemaVersion: 1 as const,
    bindingEpochId: environmentBinding.bindingEpochId,
    taskId: environmentBinding.taskId,
    ordinal: environmentBinding.ordinal,
    state: environmentBinding.state,
    attemptId: environmentBinding.attemptId,
    environment: environmentBinding.environment,
    publicationOperationId: environmentBinding.publicationOperationId,
    publicationReceiptId: environmentBinding.publicationReceiptId,
    compatibilityReceiptId: compatibility.receiptId,
    createdAt: environmentBinding.createdAt,
    boundAt: environmentBinding.boundAt,
  });

  requireEvidence(turns.length === 2, "exactly two PE-A turns are required");
  const initializationTurn = turns[0];
  const goalTurn = turns[1];
  requireEvidence(
    initializationTurn !== undefined &&
      goalTurn !== undefined &&
      initializationTurn.purpose === "environment_initialization" &&
      goalTurn.purpose === "user_goal" &&
      initializationTurn.status === "completed" &&
      goalTurn.status === "completed" &&
      initializationTurn.taskId === publication.taskId &&
      goalTurn.taskId === publication.taskId &&
      initializationTurn.sessionId === goalTurn.sessionId &&
      initializationTurn.attemptId === publication.attemptId &&
      initializationTurn.bindingEpochId === null &&
      initializationTurn.queuedGoalDigest === goalTurn.promptDigest &&
      goalTurn.attemptId === null &&
      goalTurn.bindingEpochId === environmentBinding.bindingEpochId &&
      goalTurn.queuedGoalDigest === null &&
      initializationTurn.startedAt !== null &&
      initializationTurn.endedAt !== null &&
      goalTurn.startedAt !== null &&
      goalTurn.endedAt !== null,
    "turns do not prove init, publication, binding, then same-Session goal",
  );
  requireEvidence(
    requireTimestamp(initializationTurn.endedAt, "initialization turn end") <=
      requireTimestamp(publication.completedAt, "publication completion") &&
      requireTimestamp(publication.completedAt, "publication completion") <=
        requireTimestamp(environmentBinding.boundAt, "binding completion") &&
      requireTimestamp(environmentBinding.boundAt, "binding completion") <=
        requireTimestamp(goalTurn.startedAt, "goal turn start"),
    "publication/binding/goal ordering is invalid",
  );
  const goalStartedAt = requireTimestamp(goalTurn.startedAt, "goal turn start");
  const goalEndedAt = requireTimestamp(goalTurn.endedAt, "goal turn end");
  const buildCreatedAt = requireTimestamp(
    build.createdAt,
    "candidate Build creation",
  );
  const compatibilityObservedAt = requireTimestamp(
    compatibility.observedAt,
    "compatibility observation",
  );
  requireEvidence(
    buildCreatedAt >= goalStartedAt &&
      compatibilityObservedAt >= buildCreatedAt &&
      compatibilityObservedAt <= goalEndedAt,
    "candidate Build compatibility is outside the user-goal turn",
  );
  requireEvidence(
    initializationAttempt.taskId === publication.taskId &&
      initializationAttempt.attemptId === publication.attemptId &&
      initializationAttempt.sessionId === initializationTurn.sessionId &&
      initializationAttempt.sourceId === sourceId &&
      initializationAttempt.state === "succeeded" &&
      initializationAttempt.candidateId !== null &&
      initializationAttempt.publicationOperationId ===
        publication.operationId &&
      initializationAttempt.environmentRevisionId ===
        environmentRevision.environmentRevisionId &&
      initializationAttempt.adapterRevisionId ===
        adapterRevision.adapterRevisionId &&
      initializationAttempt.publicationReceiptId === publication.receiptId &&
      initializationAttempt.bindingEpochId ===
        environmentBinding.bindingEpochId &&
      initializationAttempt.terminalCode === null &&
      initializationAttempt.terminalMessage === null &&
      initializationAttempt.sealedAt !== null &&
      hash(initializationAttempt.budget) === hash(initializationTurn.budget),
    "folded initialization attempt does not bind its Session, model contract, publication, and success",
  );
  const initializationAttemptEvidence = seal({ ...initializationAttempt });
  const turnEvidence = Object.freeze(
    [initializationTurn, goalTurn].map((turn, sequence) =>
      seal({
        schemaVersion: 1 as const,
        sequence,
        turnId: turn.turnId,
        taskId: turn.taskId,
        sessionId: turn.sessionId,
        purpose: turn.purpose,
        attemptId: turn.attemptId,
        bindingEpochId: turn.bindingEpochId,
        promptDigest: turn.promptDigest,
        queuedGoalDigest: turn.queuedGoalDigest,
        budget: turn.budget,
        usageStatus: turn.usageStatus,
        usage: turn.usage,
        status: turn.status,
        terminalCode: turn.terminalCode,
        terminalMessage: turn.terminalMessage,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
      }),
    ),
  );

  const runtime = ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse(
    input.runtime,
  );
  requireEvidence(
    runtime.schemaVersion === 1 &&
      runtime.taskId === build.taskId &&
      runtime.buildId === build.buildId &&
      runtime.environmentRevisionId ===
        environmentRevision.environmentRevisionId &&
      runtime.adapterRevisionId === adapterRevision.adapterRevisionId &&
      runtime.instrumentationMode === "instrumented" &&
      runtime.status === "stopped" &&
      runtime.bridgeHandshakeCount > 0 &&
      runtime.queryObservations.entityQueryCount > 0 &&
      runtime.queryObservations.entityRows > 0 &&
      runtime.queryObservations.stateQueryCount > 0 &&
      runtime.queryObservations.stateRows > 0 &&
      runtime.captureCount > 0 &&
      runtime.clock !== null &&
      runtime.loss.length === 0 &&
      projectRuntimeCleanupCompleteV1(runtime.cleanup) &&
      runtime.outcome === "succeeded" &&
      runtime.failures.length === 0,
    "candidate runtime observation is incomplete, lossy, or bound to another Build",
  );
  const runtimeClock = runtime.clock;
  requireEvidence(
    runtimeClock !== null,
    "successful runtime omitted its clock",
  );
  requireCounter(runtimeClock.processFrame, 0, "runtime clock processFrame");
  requireCounter(runtimeClock.physicsTick, 0, "runtime clock physicsTick");
  requireCounter(
    runtimeClock.simulationTimeUs,
    0,
    "runtime clock simulationTimeUs",
  );
  if (runtimeClock.renderFrame !== null) {
    requireCounter(runtimeClock.renderFrame, 0, "runtime clock renderFrame");
  }
  requireCounter(
    runtimeClock.hostMonotonicUs,
    0,
    "runtime clock hostMonotonicUs",
  );
  completeCoverage(runtime.coverage, "runtime coverage");
  const runtimeStartedAt = requireTimestamp(runtime.startedAt, "runtime start");
  const runtimeObservedAt = requireTimestamp(
    runtime.observedAt,
    "runtime observation",
  );
  const runtimeCompletedAt = requireTimestamp(
    runtime.completedAt,
    "runtime completion",
  );
  requireEvidence(
    runtimeStartedAt >= compatibilityObservedAt &&
      runtimeStartedAt <= runtimeObservedAt &&
      runtimeObservedAt <= runtimeCompletedAt &&
      runtimeCompletedAt <= goalEndedAt,
    "candidate runtime observation timestamps are outside the goal turn",
  );
  requireEvidence(input.goalDelivered, "the user goal was not delivered");
  const runtimeEvidence = seal({
    ...runtime,
    coverage: runtime.coverage.map((entry) => ({
      ...entry,
      limitations: [...entry.limitations],
    })),
    loss: [...runtime.loss],
  });
  const pinnedCaptures = runtimeCaptureEvidence({
    runtime,
    captures: input.pinnedCaptures,
    label: "first-session pinned captures",
  });
  const firstTaskInventory = taskInventoryEvidence({
    inventory: input.taskInventory,
    expectedCandidateCount: 1,
    expectedCaptureWindowIds: runtime.captureWindowIds,
    label: "first Task inventory",
  });
  requireEvidence(
    firstTaskInventory.attemptEvents.length ===
      initializationAttempt.eventCount &&
      hash(
        foldProjectInitializationAttemptV1(firstTaskInventory.attemptEvents),
      ) === hash(initializationAttempt) &&
      firstTaskInventory.bindingEpochs.length === 1 &&
      hash(firstTaskInventory.bindingEpochs[0]) === hash(environmentBinding) &&
      firstTaskInventory.turns.length === turns.length &&
      firstTaskInventory.turns.every(
        (turn, index) => hash(turn) === hash(turns[index]),
      ),
    "first Task raw sealed ledgers do not match folded attempt, binding, or turns",
  );
  const firstRecordPayload = (kind: string, resourceId: string) =>
    firstTaskInventory.records.find(
      (record) =>
        record.recordKind === kind && record.resourceId === resourceId,
    )?.payload;
  requireEvidence(
    hash(
      firstRecordPayload(
        "initialization-attempt",
        initializationAttempt.attemptId,
      ),
    ) === hash(initializationAttempt) &&
      hash(firstRecordPayload("toolchain-receipt", toolchain.receiptId)) ===
        hash(toolchain) &&
      hash(firstRecordPayload("publication-receipt", publication.receiptId)) ===
        hash(publication) &&
      hash(
        firstRecordPayload("compatibility-receipt", compatibility.receiptId),
      ) === hash(compatibility) &&
      hash(
        firstRecordPayload("runtime-observation-receipt", runtime.receiptId),
      ) === hash(runtime),
    "first Task immutable record inventory does not match evidence bodies",
  );
  const firstRuntimeRecords = firstTaskInventory.records.filter(
    (record) => record.recordKind === "runtime-observation-receipt",
  );
  const firstCompatibilityRecords = firstTaskInventory.records.filter(
    (record) => record.recordKind === "compatibility-receipt",
  );
  const firstCompatibilityHistory = firstCompatibilityRecords.map((record) =>
    AdapterCompatibilityReceiptV1Schema.parse(record.payload),
  );
  for (const historical of firstCompatibilityHistory) {
    const { receiptId, ...content } = historical;
    requireEvidence(
      historical.taskId === build.taskId &&
        historical.environmentRevisionId ===
          environmentRevision.environmentRevisionId &&
        historical.adapterRevisionId === adapterRevision.adapterRevisionId &&
        historical.toolchainReceiptId ===
          environmentRevision.toolchainReceiptId &&
        historical.outcome === "compatible" &&
        historical.failures.length === 0 &&
        projectRuntimeCleanupCompleteV1(historical.cleanup) &&
        hash(historical.capabilitySet) ===
          hash({ schemaVersion: 1 as const, modules: adapter.modules }) &&
        receiptId === `compatibility:v1:${hash(content)}`,
      "first Task compatibility history contains an invalid or incompatible receipt",
    );
    completeCoverage(
      historical.coverage,
      "first Task compatibility history coverage",
    );
  }
  requireEvidence(
    firstRuntimeRecords.length === 1 &&
      firstRuntimeRecords[0]?.resourceId === runtime.receiptId &&
      firstCompatibilityHistory.some(
        (historical) => historical.receiptId === compatibility.receiptId,
      ) &&
      firstCompatibilityRecords.every(
        (record, index) =>
          record.resourceId === firstCompatibilityHistory[index]?.receiptId,
      ),
    "first Task evidence does not contain its complete bound runtime and compatibility history",
  );

  const reuseReceipt = ProjectEnvironmentReuseReceiptV1Schema.parse(
    input.reuse.receipt,
  );
  const reuseToolchain = ProjectToolchainReceiptV1Schema.parse(
    input.reuse.toolchain,
  );
  const reuseBinding = EnvironmentBindingEpochV1Schema.parse(
    input.reuse.environmentBinding,
  );
  const reuseFinalBuildBinding = ProjectEnvironmentBuildBindingV1Schema.parse(
    input.reuse.finalBuildBinding,
  );
  const reuseCompatibility = AdapterCompatibilityReceiptV1Schema.parse(
    input.reuse.compatibility,
  );
  const reuseTurns = input.reuse.turns.map((turn) =>
    ProjectEnvironmentTurnV1Schema.parse(turn),
  );
  const reuseRuntime =
    ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse(
      input.reuse.runtime,
    );
  const reuseBuild = input.reuse.preparedBuild.build;
  const reuseToolchainIdentity = {
    schemaVersion: 1 as const,
    requested: reuseToolchain.requested,
    status: reuseToolchain.status,
    realized: reuseToolchain.realized,
    limitations: [...reuseToolchain.limitations],
  };
  requireEvidence(
    reuseToolchain.receiptId === toolchain.receiptId &&
      hash(reuseToolchainIdentity) === hash(toolchainIdentity) &&
      reuseToolchain.receiptId ===
        `toolchain-receipt:v1:${hash({
          schemaVersion: 1,
          label: "toolchain-receipt",
          value: reuseToolchainIdentity,
        })}`,
    "reuse Task toolchain receipt does not bind the exact realized toolchain identity",
  );
  const reuseToolchainEvidence = seal({ ...reuseToolchain });
  requireEvidence(
    reuseBuild.taskId !== build.taskId &&
      reuseBuild.sourceHash === input.source.selectedTreeSha256 &&
      reuseBuild.sourceId === `source:${reuseBuild.sourceHash}` &&
      reuseBuild.workspaceDiffHash ===
        hash({
          schemaVersion: 1,
          baselineSourceHash: input.source.selectedTreeSha256,
          candidateSourceHash: reuseBuild.sourceHash,
        }),
    "reuse Build is not a distinct unchanged-source Task Build",
  );
  requireEvidence(
    input.reuse.preparedBuild.projectHash ===
      buildProjectHash(
        reuseBuild.sourceHash,
        reuseBuild.buildConfigurationHash,
      ) &&
      reuseBuild.outputHash === input.reuse.preparedBuild.projectHash &&
      reuseBuild.buildId ===
        `build:${hash({
          schemaVersion: 1,
          projectHash: input.reuse.preparedBuild.projectHash,
          buildConfigurationHash: reuseBuild.buildConfigurationHash,
          outputHash: reuseBuild.outputHash,
        })}`,
    "reuse Build project/output hash is invalid",
  );
  requireEvidence(
    reuseFinalBuildBinding.compatibilityStatus === "compatible" &&
      reuseFinalBuildBinding.compatibilityReceiptId !== null &&
      reuseFinalBuildBinding.taskId === reuseBuild.taskId &&
      reuseFinalBuildBinding.workspaceId === reuseBuild.workspaceId &&
      reuseFinalBuildBinding.sourceId === reuseBuild.sourceId &&
      reuseFinalBuildBinding.buildId === reuseBuild.buildId &&
      reuseFinalBuildBinding.bindingEpochId ===
        input.reuse.preparedBuild.binding.bindingEpochId &&
      reuseFinalBuildBinding.environmentRevisionId ===
        environmentRevision.environmentRevisionId &&
      reuseFinalBuildBinding.adapterRevisionId ===
        adapterRevision.adapterRevisionId &&
      reuseFinalBuildBinding.payloadSchemaDigest ===
        adapterRevision.payloadSchemaDigest &&
      reuseFinalBuildBinding.sdkDigest === environmentRevision.sdkDigest &&
      reuseFinalBuildBinding.bridgeDigest ===
        environmentRevision.bridgeDigest &&
      reuseFinalBuildBinding.toolchainReceiptId ===
        environmentRevision.toolchainReceiptId,
    "reuse Build binding is not exact and compatible",
  );
  requireEvidence(
    reuseCompatibility.receiptId ===
      reuseFinalBuildBinding.compatibilityReceiptId &&
      reuseCompatibility.taskId === reuseBuild.taskId &&
      reuseCompatibility.buildId === reuseBuild.buildId &&
      reuseCompatibility.sourceId === reuseBuild.sourceId &&
      reuseCompatibility.environmentRevisionId ===
        environmentRevision.environmentRevisionId &&
      reuseCompatibility.adapterRevisionId ===
        adapterRevision.adapterRevisionId &&
      reuseCompatibility.toolchainReceiptId ===
        environmentRevision.toolchainReceiptId &&
      reuseCompatibility.outcome === "compatible" &&
      reuseCompatibility.failures.length === 0 &&
      projectRuntimeCleanupCompleteV1(reuseCompatibility.cleanup),
    "reuse compatibility receipt crossed its exact Build binding",
  );
  completeCoverage(reuseCompatibility.coverage, "reuse compatibility coverage");
  const reuseCompatibilityContent = {
    schemaVersion: reuseCompatibility.schemaVersion,
    taskId: reuseCompatibility.taskId,
    buildId: reuseCompatibility.buildId,
    sourceId: reuseCompatibility.sourceId,
    environmentRevisionId: reuseCompatibility.environmentRevisionId,
    adapterRevisionId: reuseCompatibility.adapterRevisionId,
    toolchainReceiptId: reuseCompatibility.toolchainReceiptId,
    bridgeHandshakeObserved: reuseCompatibility.bridgeHandshakeObserved,
    instrumentedLaunchObserved: reuseCompatibility.instrumentedLaunchObserved,
    queryObservations: reuseCompatibility.queryObservations,
    coverage: reuseCompatibility.coverage.map((entry) => ({
      ...entry,
      limitations: [...entry.limitations],
    })),
    capabilitySet: { schemaVersion: 1 as const, modules: adapter.modules },
    cleanup: reuseCompatibility.cleanup,
    outcome: reuseCompatibility.outcome,
    failures: [...reuseCompatibility.failures],
    observedAt: reuseCompatibility.observedAt,
  };
  requireEvidence(
    reuseCompatibility.receiptId ===
      `compatibility:v1:${hash(reuseCompatibilityContent)}`,
    "reuse compatibility receipt identity is invalid",
  );
  const reuseCompatibilityEvidence = seal({
    schemaVersion: reuseCompatibility.schemaVersion,
    receiptId: reuseCompatibility.receiptId,
    taskId: reuseCompatibility.taskId,
    buildId: reuseCompatibility.buildId,
    sourceId: reuseCompatibility.sourceId,
    environmentRevisionId: reuseCompatibility.environmentRevisionId,
    adapterRevisionId: reuseCompatibility.adapterRevisionId,
    toolchainReceiptId: reuseCompatibility.toolchainReceiptId,
    bridgeHandshakeObserved: reuseCompatibility.bridgeHandshakeObserved,
    instrumentedLaunchObserved: reuseCompatibility.instrumentedLaunchObserved,
    queryObservations: reuseCompatibility.queryObservations,
    coverage: reuseCompatibilityContent.coverage,
    modules: adapter.modules,
    cleanup: reuseCompatibility.cleanup,
    outcome: reuseCompatibility.outcome,
    failures: [...reuseCompatibility.failures],
    observedAt: reuseCompatibility.observedAt,
  });
  const reuseBuildEvidence = seal({
    schemaVersion: 1 as const,
    taskId: reuseBuild.taskId,
    workspaceId: reuseBuild.workspaceId,
    sourceId: reuseBuild.sourceId,
    buildId: reuseBuild.buildId,
    baselineSourceHash: input.source.selectedTreeSha256,
    sourceHash: reuseBuild.sourceHash,
    workspaceDiffHash: reuseBuild.workspaceDiffHash,
    buildConfigurationHash: reuseBuild.buildConfigurationHash,
    projectHash: input.reuse.preparedBuild.projectHash,
    outputHash: reuseBuild.outputHash,
    bindingEpochId: reuseFinalBuildBinding.bindingEpochId,
    environmentRevisionId: reuseFinalBuildBinding.environmentRevisionId,
    adapterRevisionId: reuseFinalBuildBinding.adapterRevisionId,
    payloadSchemaDigest: reuseFinalBuildBinding.payloadSchemaDigest,
    sdkDigest: reuseFinalBuildBinding.sdkDigest,
    bridgeDigest: reuseFinalBuildBinding.bridgeDigest,
    toolchainReceiptId: reuseFinalBuildBinding.toolchainReceiptId,
    compatibilityReceiptId: reuseFinalBuildBinding.compatibilityReceiptId,
    createdAt: reuseBuild.createdAt,
  });
  const reuseReceiptContent = Object.fromEntries(
    Object.entries(reuseReceipt).filter(([key]) => key !== "receiptId"),
  );
  requireEvidence(
    reuseReceipt.receiptId === `reuse:v1:${hash(reuseReceiptContent)}` &&
      reuseReceipt.taskId === reuseBuild.taskId &&
      reuseReceipt.sourceId === environmentRevision.sourceId &&
      reuseReceipt.buildId === reuseBuild.buildId &&
      reuseReceipt.buildSourceId === reuseBuild.sourceId &&
      reuseReceipt.environmentRevisionId ===
        environmentRevision.environmentRevisionId &&
      reuseReceipt.adapterRevisionId === adapterRevision.adapterRevisionId &&
      reuseReceipt.toolchainReceiptId ===
        environmentRevision.toolchainReceiptId &&
      reuseReceipt.sdkDigest === environmentRevision.sdkDigest &&
      reuseReceipt.bridgeDigest === environmentRevision.bridgeDigest &&
      reuseReceipt.policyProfileDigest ===
        environmentRevision.policyProfileDigest &&
      reuseReceipt.observedCurrentRevisionId ===
        environmentRevision.environmentRevisionId &&
      reuseReceipt.compatibilityReceiptId === reuseCompatibility.receiptId &&
      reuseReceipt.outcome === "reused" &&
      reuseReceipt.failures.length === 0 &&
      projectRuntimeCleanupCompleteV1(reuseReceipt.cleanup),
    "reuse receipt does not bind the exact current revision and smoke Build",
  );
  requireEvidence(
    reuseBinding.state === "reused" &&
      reuseBinding.taskId === reuseReceipt.taskId &&
      reuseBinding.sessionId === reuseReceipt.sessionId &&
      reuseBinding.bindingEpochId === reuseFinalBuildBinding.bindingEpochId &&
      reuseBinding.reuseReceiptId === reuseReceipt.receiptId &&
      reuseBinding.compatibilityReceiptId === reuseCompatibility.receiptId &&
      reuseBinding.environment.environmentRevisionId ===
        environmentRevision.environmentRevisionId &&
      hash(reuseBinding.environment) === hash(environmentBinding.environment),
    "reuse binding crossed its Session, receipt, compatibility, or revision",
  );
  const reuseReceiptEvidence = seal({ ...reuseReceipt });
  const reuseBindingEvidence = seal({ ...reuseBinding });
  requireEvidence(
    reuseTurns.length === 1 &&
      reuseTurns[0]?.purpose === "user_goal" &&
      reuseTurns[0].status === "completed" &&
      reuseTurns[0].taskId === reuseReceipt.taskId &&
      reuseTurns[0].sessionId === reuseReceipt.sessionId &&
      reuseTurns[0].sessionId !== goalTurn.sessionId &&
      reuseTurns[0].attemptId === null &&
      reuseTurns[0].bindingEpochId === reuseBinding.bindingEpochId &&
      reuseTurns[0].queuedGoalDigest === null &&
      reuseTurns[0].startedAt !== null &&
      reuseTurns[0].endedAt !== null &&
      requireTimestamp(reuseBinding.boundAt, "reuse binding completion") <=
        requireTimestamp(reuseTurns[0].startedAt, "reuse goal start"),
    "reuse Task does not prove one user-goal turn in a new bound Session",
  );
  const reuseTurn = reuseTurns[0];
  if (reuseTurn?.startedAt === null || reuseTurn?.endedAt === null) {
    throw new TypeError(
      "invalid PE-A evidence input: reuse goal turn omitted timestamps",
    );
  }
  const reuseTurnEvidence = Object.freeze([
    seal({
      schemaVersion: 1 as const,
      sequence: 0,
      turnId: reuseTurn.turnId,
      taskId: reuseTurn.taskId,
      sessionId: reuseTurn.sessionId,
      purpose: reuseTurn.purpose,
      attemptId: reuseTurn.attemptId,
      bindingEpochId: reuseTurn.bindingEpochId,
      promptDigest: reuseTurn.promptDigest,
      queuedGoalDigest: reuseTurn.queuedGoalDigest,
      budget: reuseTurn.budget,
      usageStatus: reuseTurn.usageStatus,
      usage: reuseTurn.usage,
      status: reuseTurn.status,
      terminalCode: reuseTurn.terminalCode,
      terminalMessage: reuseTurn.terminalMessage,
      startedAt: reuseTurn.startedAt,
      endedAt: reuseTurn.endedAt,
    }),
  ]);
  requireEvidence(
    reuseRuntime.taskId === reuseBuild.taskId &&
      reuseRuntime.buildId === reuseBuild.buildId &&
      reuseRuntime.environmentRevisionId ===
        environmentRevision.environmentRevisionId &&
      reuseRuntime.adapterRevisionId === adapterRevision.adapterRevisionId &&
      reuseRuntime.instrumentationMode === "instrumented" &&
      reuseRuntime.status === "stopped" &&
      reuseRuntime.bridgeHandshakeCount > 0 &&
      reuseRuntime.queryObservations.entityQueryCount > 0 &&
      reuseRuntime.queryObservations.entityRows > 0 &&
      reuseRuntime.queryObservations.stateQueryCount > 0 &&
      reuseRuntime.queryObservations.stateRows > 0 &&
      reuseRuntime.captureCount > 0 &&
      reuseRuntime.loss.length === 0 &&
      projectRuntimeCleanupCompleteV1(reuseRuntime.cleanup) &&
      reuseRuntime.outcome === "succeeded" &&
      reuseRuntime.failures.length === 0,
    "reuse runtime observation is incomplete, lossy, or crossed its Build",
  );
  completeCoverage(reuseRuntime.coverage, "reuse runtime coverage");
  const reuseRuntimeStartedAt = requireTimestamp(
    reuseRuntime.startedAt,
    "reuse runtime start",
  );
  const reuseRuntimeObservedAt = requireTimestamp(
    reuseRuntime.observedAt,
    "reuse runtime observation",
  );
  const reuseRuntimeCompletedAt = requireTimestamp(
    reuseRuntime.completedAt,
    "reuse runtime completion",
  );
  requireEvidence(
    reuseRuntimeStartedAt >=
      requireTimestamp(reuseTurn.startedAt, "reuse goal start") &&
      reuseRuntimeStartedAt <= reuseRuntimeObservedAt &&
      reuseRuntimeObservedAt <= reuseRuntimeCompletedAt &&
      reuseRuntimeCompletedAt <=
        requireTimestamp(reuseTurn.endedAt, "reuse goal end"),
    "reuse runtime observation is outside the new-Session goal turn",
  );
  requireEvidence(
    input.reuse.goalDelivered,
    "reuse user goal was not delivered",
  );
  const reuseRuntimeEvidence = seal({
    ...reuseRuntime,
    coverage: reuseRuntime.coverage.map((entry) => ({
      ...entry,
      limitations: [...entry.limitations],
    })),
    loss: [...reuseRuntime.loss],
  });
  const reusePinnedCaptures = runtimeCaptureEvidence({
    runtime: reuseRuntime,
    captures: input.reuse.pinnedCaptures,
    label: "reuse-session pinned captures",
  });
  const reusedTaskInventory = taskInventoryEvidence({
    inventory: input.reuse.taskInventory,
    expectedCandidateCount: 0,
    expectedCaptureWindowIds: reuseRuntime.captureWindowIds,
    label: "reuse Task inventory",
  });
  requireEvidence(
    reusedTaskInventory.attemptEvents.length === 0 &&
      reusedTaskInventory.bindingEpochs.length === 1 &&
      hash(reusedTaskInventory.bindingEpochs[0]) === hash(reuseBinding) &&
      reusedTaskInventory.turns.length === 1 &&
      hash(reusedTaskInventory.turns[0]) === hash(reuseTurn),
    "reuse Task raw sealed ledgers contain initialization or cross their binding/turn",
  );
  const reusedRecordPayload = (kind: string, resourceId: string) =>
    reusedTaskInventory.records.find(
      (record) =>
        record.recordKind === kind && record.resourceId === resourceId,
    )?.payload;
  requireEvidence(
    !reusedTaskInventory.records.some(
      (record) =>
        record.recordKind === "initialization-attempt" ||
        record.recordKind === "publication-intent" ||
        record.recordKind === "publication-receipt" ||
        record.recordKind === "conformance-receipt" ||
        record.recordKind === "observer-effect-receipt",
    ),
    "reuse Task contains initialization/publication records",
  );
  requireEvidence(
    hash(reusedRecordPayload("toolchain-receipt", reuseToolchain.receiptId)) ===
      hash(reuseToolchain) &&
      hash(reusedRecordPayload("reuse-receipt", reuseReceipt.receiptId)) ===
        hash(reuseReceipt) &&
      hash(
        reusedRecordPayload(
          "compatibility-receipt",
          reuseCompatibility.receiptId,
        ),
      ) === hash(reuseCompatibility) &&
      hash(
        reusedRecordPayload(
          "runtime-observation-receipt",
          reuseRuntime.receiptId,
        ),
      ) === hash(reuseRuntime),
    "reuse Task immutable record inventory does not match evidence bodies",
  );
  const reuseRuntimeRecords = reusedTaskInventory.records.filter(
    (record) => record.recordKind === "runtime-observation-receipt",
  );
  const reuseCompatibilityRecords = reusedTaskInventory.records.filter(
    (record) => record.recordKind === "compatibility-receipt",
  );
  const reuseCompatibilityHistory = reuseCompatibilityRecords.map((record) =>
    AdapterCompatibilityReceiptV1Schema.parse(record.payload),
  );
  for (const historical of reuseCompatibilityHistory) {
    const { receiptId, ...content } = historical;
    requireEvidence(
      historical.taskId === reuseBuild.taskId &&
        historical.environmentRevisionId ===
          environmentRevision.environmentRevisionId &&
        historical.adapterRevisionId === adapterRevision.adapterRevisionId &&
        historical.toolchainReceiptId ===
          environmentRevision.toolchainReceiptId &&
        historical.outcome === "compatible" &&
        historical.failures.length === 0 &&
        projectRuntimeCleanupCompleteV1(historical.cleanup) &&
        hash(historical.capabilitySet) ===
          hash({ schemaVersion: 1 as const, modules: adapter.modules }) &&
        receiptId === `compatibility:v1:${hash(content)}`,
      "reuse Task compatibility history contains an invalid or incompatible receipt",
    );
    completeCoverage(
      historical.coverage,
      "reuse Task compatibility history coverage",
    );
  }
  requireEvidence(
    reuseRuntimeRecords.length === 1 &&
      reuseRuntimeRecords[0]?.resourceId === reuseRuntime.receiptId &&
      reuseCompatibilityHistory.some(
        (historical) => historical.receiptId === reuseCompatibility.receiptId,
      ) &&
      reuseCompatibilityRecords.every(
        (record, index) =>
          record.resourceId === reuseCompatibilityHistory[index]?.receiptId,
      ),
    "reuse Task evidence does not contain its complete bound runtime and compatibility history",
  );
  const reuseEvidence = seal({
    schemaVersion: 1 as const,
    taskInventory: reusedTaskInventory.evidence,
    toolchain: reuseToolchainEvidence,
    receipt: reuseReceiptEvidence,
    binding: reuseBindingEvidence,
    candidateBuild: reuseBuildEvidence,
    compatibility: reuseCompatibilityEvidence,
    turns: reuseTurnEvidence,
    runtime: reuseRuntimeEvidence,
    pinnedCaptures: reusePinnedCaptures,
    goalDelivered: true as const,
  });

  const basis = {
    schemaVersion: 1 as const,
    evidenceKind: "chronorift-project-environment-pe-a-evidence" as const,
    evidenceProfile: "author-validate-publish-use-reuse-v1" as const,
    source,
    toolchain: toolchainEvidence,
    adapter,
    environment,
    publishedReceipts,
    publication: publicationEvidence,
    initializationAttempt: initializationAttemptEvidence,
    taskInventory: firstTaskInventory.evidence,
    candidateBuild,
    compatibility: compatibilityEvidence,
    binding,
    turns: turnEvidence,
    runtime: runtimeEvidence,
    pinnedCaptures,
    reuse: reuseEvidence,
    goalDelivered: true as const,
  };
  return Object.freeze({ ...basis, bundleContentHash: hash(basis) });
}

export type ProjectEnvironmentPeAEvidenceBundleV1 = ReturnType<
  typeof buildProjectEnvironmentPeAEvidenceV1
>;
