import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  AdapterCompatibilityReceiptV1Schema,
  AdapterCompatibilityReceiptV2Schema,
  AdapterConformanceReceiptV1Schema,
  AdapterConformanceReceiptV2Schema,
  CaptureWindowIdSchema,
  EnvironmentBindingEpochV1Schema,
  EnvironmentPublicationIntentV1Schema,
  EnvironmentPublicationReceiptV1Schema,
  JsonValueSchema,
  ObserverEffectReceiptV1Schema,
  ProjectAdapterCandidateReferenceV1Schema,
  ProjectEnvironmentBuildBindingV1Schema,
  ProjectEnvironmentPinnedCaptureV1Schema,
  ProjectEnvironmentPinnedCaptureV2Schema,
  ProjectEnvironmentOperationIdSchema,
  ProjectEnvironmentReuseReceiptV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV2Schema,
  ProjectEnvironmentTaskIdSchema,
  ProjectEnvironmentTurnV1Schema,
  ProjectInitializationAttemptEventV1Schema,
  ProjectInitializationAttemptV1Schema,
  ProjectToolchainReceiptV1Schema,
  VNextBuildV1Schema,
  foldProjectInitializationAttemptV1,
  type AdapterCompatibilityReceiptV1,
  type AdapterCompatibilityReceiptV2,
  type AdapterConformanceReceiptV1,
  type AdapterConformanceReceiptV2,
  type CaptureWindowId,
  type EnvironmentBindingEpochV1,
  type EnvironmentPublicationIntentV1,
  type EnvironmentPublicationReceiptV1,
  type JsonValue,
  type ObserverEffectReceiptV1,
  type ProjectAdapterCandidateId,
  type ProjectAdapterCandidateReferenceV1,
  type ProjectEnvironmentBuildBindingV1,
  type ProjectEnvironmentPinnedCaptureV1,
  type ProjectEnvironmentPinnedCaptureV2,
  type ProjectEnvironmentReuseReceiptV1,
  type ProjectEnvironmentRuntimeObservationReceiptV1,
  type ProjectEnvironmentRuntimeObservationReceiptV2,
  type ProjectEnvironmentOperationId,
  type ProjectEnvironmentTurnV1,
  type ProjectInitializationAttemptEventV1,
  type ProjectInitializationAttemptId,
  type ProjectInitializationAttemptV1,
  type ProjectToolchainReceiptV1,
  type TaskId,
  type VNextBuildV1,
} from "@chronorift/domain";

import { canonicalJson, contentHash } from "./canonical-json.js";
import {
  ArtifactCorruptionError,
  ArtifactNotFoundError,
} from "./json-artifact-repository.js";
import { ArtifactPathSecurityError } from "./v01-json-artifact-repository.js";
import {
  appendLedger,
  asJsonValue,
  assertDirectoryIdentity,
  assertOpaqueId,
  assertQuotaAvailable,
  canonicalBytes,
  canonicalDirectoryIdentity,
  createChildDirectory,
  createPrivateDirectory,
  hasExactKeys,
  inspectImmutablePackage,
  inspectImmutablePackageCollection,
  inspectTreeUsage,
  isObject,
  isSha256,
  materializeImmutablePackage,
  parseCanonicalJsonBytes,
  projectEnvironmentPackageContentDigestV1,
  readCanonicalJson,
  readLedger,
  readSealedLedgerEvidence,
  resourceDigest,
  sealLedger,
  validateLedger,
  validateQuota,
  writeImmutableFile,
  type DirectoryIdentity,
  type ImmutablePackageSealV1,
  type ProjectEnvironmentLedgerEnvelopeV1,
  type ProjectEnvironmentLedgerSealV1,
  type ProjectEnvironmentPackageFileInputV1,
  type ProjectEnvironmentStoreQuotaV1,
  type StoredProjectEnvironmentPackageV1,
} from "./project-environment-store-internals.js";

export type ProjectEnvironmentTaskRecordKindV1 =
  | "initialization-attempt"
  | "publication-intent"
  | "publication-receipt"
  | "toolchain-receipt"
  | "conformance-receipt"
  | "observer-effect-receipt"
  | "compatibility-receipt"
  | "reuse-receipt"
  | "runtime-observation-receipt"
  | "build"
  | "build-binding";

export type ProjectEnvironmentTaskLedgerKindV1 =
  "attempt-events" | "binding-epochs" | "turns";

export interface ProjectEnvironmentTaskStoreOptionsV1 {
  readonly storeRoot: string;
  readonly taskId: TaskId;
  readonly quota?: ProjectEnvironmentStoreQuotaV1;
}

export interface ProjectEnvironmentTaskStoreSummaryV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly candidates: number;
  readonly captureWindows: number;
  readonly records: number;
  readonly ledgerRecords: number;
  readonly sealedLedgers: number;
  readonly bytes: number;
  readonly entries: number;
}

export interface ProjectEnvironmentTaskEvidenceInventoryV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly candidatePackages: readonly {
    readonly resourceId: string;
    readonly resourceDigest: string;
  }[];
  readonly captureWindowPackages: readonly {
    readonly resourceId: string;
    readonly resourceDigest: string;
  }[];
  readonly records: readonly {
    readonly schemaVersion: 1;
    readonly taskId: TaskId;
    readonly recordKind: ProjectEnvironmentTaskRecordKindV1;
    readonly resourceId: string;
    readonly resourceDigest: string;
    readonly payload: JsonValue;
    readonly payloadHash: string;
    readonly recordHash: string;
  }[];
  readonly ledgers: readonly {
    readonly kind: ProjectEnvironmentTaskLedgerKindV1;
    readonly canonicalBase64: string;
    readonly envelopes: readonly ProjectEnvironmentLedgerEnvelopeV1[];
    readonly seal: ProjectEnvironmentLedgerSealV1;
  }[];
  readonly inventoryHash: string;
}

export interface StoredProjectEnvironmentPinnedCaptureV1 {
  readonly payload:
    ProjectEnvironmentPinnedCaptureV1 | ProjectEnvironmentPinnedCaptureV2;
  readonly records: readonly JsonValue[];
  readonly recordsBytes: Uint8Array;
  readonly payloadHash: string;
  readonly packageHash: string;
  readonly packageSeal: ImmutablePackageSealV1;
}

interface ProjectEnvironmentTaskStoreMarkerV1 {
  readonly schemaVersion: 1;
  readonly storeKind: "chronorift-project-environment-task-store-v1";
  readonly taskId: TaskId;
  readonly taskNamespaceDigest: string;
  readonly quota: ProjectEnvironmentStoreQuotaV1;
}

interface TaskRecordEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly recordKind: ProjectEnvironmentTaskRecordKindV1;
  readonly resourceId: string;
  readonly resourceDigest: string;
  readonly payload: JsonValue;
  readonly payloadHash: string;
  readonly recordHash: string;
}

type TaskRecordPayload =
  | ProjectInitializationAttemptV1
  | EnvironmentPublicationIntentV1
  | EnvironmentPublicationReceiptV1
  | ProjectToolchainReceiptV1
  | AdapterConformanceReceiptV1
  | AdapterConformanceReceiptV2
  | ObserverEffectReceiptV1
  | AdapterCompatibilityReceiptV1
  | AdapterCompatibilityReceiptV2
  | ProjectEnvironmentReuseReceiptV1
  | ProjectEnvironmentRuntimeObservationReceiptV1
  | ProjectEnvironmentRuntimeObservationReceiptV2
  | VNextBuildV1
  | ProjectEnvironmentBuildBindingV1;

const STORE_MARKER = ".chronorift-project-environment-task-store-v1.json";
const CANDIDATES = "candidates";
const CAPTURE_WINDOWS = "capture-windows";
const PINNED_CAPTURE_RECORDS = "records.json";
const RECORDS = "records";
const LEDGERS = "ledgers";
const ROOT_ENTRIES = new Set([
  STORE_MARKER,
  CANDIDATES,
  CAPTURE_WINDOWS,
  RECORDS,
  LEDGERS,
]);

export const PROJECT_ENVIRONMENT_TASK_STORE_DEFAULT_QUOTA_V1 = Object.freeze({
  maximumTotalBytes: 96 * 1024 * 1024,
  maximumEntries: 2_048,
  maximumCanonicalJsonBytes: 2 * 1024 * 1024,
  maximumPackageBytes: 8 * 1024 * 1024,
  maximumPackageFiles: 256,
}) satisfies ProjectEnvironmentStoreQuotaV1;

const RECORD_KINDS: readonly ProjectEnvironmentTaskRecordKindV1[] = [
  "initialization-attempt",
  "publication-intent",
  "publication-receipt",
  "toolchain-receipt",
  "conformance-receipt",
  "observer-effect-receipt",
  "compatibility-receipt",
  "reuse-receipt",
  "runtime-observation-receipt",
  "build",
  "build-binding",
];
const RECORD_KIND_SET = new Set<string>(RECORD_KINDS);
const LEDGER_FILES: Readonly<
  Record<ProjectEnvironmentTaskLedgerKindV1, string>
> = {
  "attempt-events": "attempt-events.jsonl",
  "binding-epochs": "binding-epochs.jsonl",
  turns: "turns.jsonl",
};
const LEDGER_NAMES = new Set<string>(Object.values(LEDGER_FILES));

const parseCandidateReference = (
  input: unknown,
): ProjectAdapterCandidateReferenceV1 =>
  ProjectAdapterCandidateReferenceV1Schema.parse(input);
const parsePinnedCapture = (
  input: unknown,
): ProjectEnvironmentPinnedCaptureV1 | ProjectEnvironmentPinnedCaptureV2 => {
  const version = isObject(input) ? input.schemaVersion : undefined;
  return version === 2
    ? ProjectEnvironmentPinnedCaptureV2Schema.parse(input)
    : ProjectEnvironmentPinnedCaptureV1Schema.parse(input);
};
const parseInitializationAttempt = (
  input: unknown,
): ProjectInitializationAttemptV1 =>
  ProjectInitializationAttemptV1Schema.parse(input);
const parsePublicationIntent = (
  input: unknown,
): EnvironmentPublicationIntentV1 =>
  EnvironmentPublicationIntentV1Schema.parse(input);
const parsePublicationReceipt = (
  input: unknown,
): EnvironmentPublicationReceiptV1 =>
  EnvironmentPublicationReceiptV1Schema.parse(input);
const parseToolchainReceipt = (input: unknown): ProjectToolchainReceiptV1 =>
  ProjectToolchainReceiptV1Schema.parse(input);
const parseConformanceReceipt = (
  input: unknown,
): AdapterConformanceReceiptV1 | AdapterConformanceReceiptV2 =>
  isObject(input) && input.schemaVersion === 2
    ? AdapterConformanceReceiptV2Schema.parse(input)
    : AdapterConformanceReceiptV1Schema.parse(input);
const parseObserverEffectReceipt = (input: unknown): ObserverEffectReceiptV1 =>
  ObserverEffectReceiptV1Schema.parse(input);
const parseCompatibilityReceipt = (
  input: unknown,
): AdapterCompatibilityReceiptV1 | AdapterCompatibilityReceiptV2 =>
  isObject(input) && input.schemaVersion === 2
    ? AdapterCompatibilityReceiptV2Schema.parse(input)
    : AdapterCompatibilityReceiptV1Schema.parse(input);
const parseReuseReceipt = (input: unknown): ProjectEnvironmentReuseReceiptV1 =>
  ProjectEnvironmentReuseReceiptV1Schema.parse(input);
const parseRuntimeObservationReceipt = (
  input: unknown,
):
  | ProjectEnvironmentRuntimeObservationReceiptV1
  | ProjectEnvironmentRuntimeObservationReceiptV2 =>
  isObject(input) && input.schemaVersion === 2
    ? ProjectEnvironmentRuntimeObservationReceiptV2Schema.parse(input)
    : ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse(input);
const parseBuild = (input: unknown): VNextBuildV1 =>
  VNextBuildV1Schema.parse(input);
const parseBuildBinding = (input: unknown): ProjectEnvironmentBuildBindingV1 =>
  ProjectEnvironmentBuildBindingV1Schema.parse(input);
const parseAttemptEvent = (
  input: unknown,
): ProjectInitializationAttemptEventV1 =>
  ProjectInitializationAttemptEventV1Schema.parse(input);
const parseBindingEpoch = (input: unknown): EnvironmentBindingEpochV1 =>
  EnvironmentBindingEpochV1Schema.parse(input);
const parseTurn = (input: unknown): ProjectEnvironmentTurnV1 =>
  ProjectEnvironmentTurnV1Schema.parse(input);

function taskNamespaceDigest(taskId: TaskId): string {
  return resourceDigest(
    "chronorift-project-environment-task-store-v1",
    taskId,
    "task",
  );
}

function parseQuota(input: unknown): ProjectEnvironmentStoreQuotaV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "maximumTotalBytes",
      "maximumEntries",
      "maximumCanonicalJsonBytes",
      "maximumPackageBytes",
      "maximumPackageFiles",
    ])
  ) {
    throw new Error("invalid Project Environment store quota");
  }
  const quota = {
    maximumTotalBytes: input.maximumTotalBytes,
    maximumEntries: input.maximumEntries,
    maximumCanonicalJsonBytes: input.maximumCanonicalJsonBytes,
    maximumPackageBytes: input.maximumPackageBytes,
    maximumPackageFiles: input.maximumPackageFiles,
  };
  if (
    Object.values(quota).some(
      (value) =>
        typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0,
    )
  ) {
    throw new Error(
      "Project Environment quota values must be positive integers",
    );
  }
  const parsed = quota as ProjectEnvironmentStoreQuotaV1;
  validateQuota(parsed);
  return parsed;
}

function parseMarker(input: unknown): ProjectEnvironmentTaskStoreMarkerV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "storeKind",
      "taskId",
      "taskNamespaceDigest",
      "quota",
    ]) ||
    input.schemaVersion !== 1 ||
    input.storeKind !== "chronorift-project-environment-task-store-v1" ||
    !isSha256(input.taskNamespaceDigest)
  ) {
    throw new Error("invalid Project Environment Task store marker");
  }
  return {
    schemaVersion: 1,
    storeKind: "chronorift-project-environment-task-store-v1",
    taskId: ProjectEnvironmentTaskIdSchema.parse(input.taskId),
    taskNamespaceDigest: input.taskNamespaceDigest,
    quota: parseQuota(input.quota),
  };
}

function parseRecordKind(input: unknown): ProjectEnvironmentTaskRecordKindV1 {
  if (typeof input !== "string" || !RECORD_KIND_SET.has(input)) {
    throw new Error("unsupported Project Environment Task record kind");
  }
  return input as ProjectEnvironmentTaskRecordKindV1;
}

function parsePayload(
  kind: ProjectEnvironmentTaskRecordKindV1,
  input: unknown,
): TaskRecordPayload {
  switch (kind) {
    case "initialization-attempt":
      return ProjectInitializationAttemptV1Schema.parse(input);
    case "publication-intent":
      return EnvironmentPublicationIntentV1Schema.parse(input);
    case "publication-receipt":
      return EnvironmentPublicationReceiptV1Schema.parse(input);
    case "toolchain-receipt":
      return ProjectToolchainReceiptV1Schema.parse(input);
    case "conformance-receipt":
      return parseConformanceReceipt(input);
    case "observer-effect-receipt":
      return ObserverEffectReceiptV1Schema.parse(input);
    case "compatibility-receipt":
      return parseCompatibilityReceipt(input);
    case "reuse-receipt":
      return ProjectEnvironmentReuseReceiptV1Schema.parse(input);
    case "runtime-observation-receipt":
      return parseRuntimeObservationReceipt(input);
    case "build":
      return VNextBuildV1Schema.parse(input);
    case "build-binding":
      return ProjectEnvironmentBuildBindingV1Schema.parse(input);
  }
}

function parseRecordEnvelope(input: unknown): TaskRecordEnvelopeV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "taskId",
      "recordKind",
      "resourceId",
      "resourceDigest",
      "payload",
      "payloadHash",
      "recordHash",
    ]) ||
    input.schemaVersion !== 1 ||
    typeof input.resourceId !== "string" ||
    !isSha256(input.resourceDigest) ||
    !isSha256(input.payloadHash) ||
    !isSha256(input.recordHash)
  ) {
    throw new Error("invalid Project Environment Task record envelope");
  }
  return {
    schemaVersion: 1,
    taskId: ProjectEnvironmentTaskIdSchema.parse(input.taskId),
    recordKind: parseRecordKind(input.recordKind),
    resourceId: input.resourceId,
    resourceDigest: input.resourceDigest,
    payload: JsonValueSchema.parse(input.payload),
    payloadHash: input.payloadHash,
    recordHash: input.recordHash,
  };
}

function recordEnvelope(
  taskId: TaskId,
  kind: ProjectEnvironmentTaskRecordKindV1,
  resourceId: string,
  payload: JsonValue,
): TaskRecordEnvelopeV1 {
  const payloadHash = contentHash(payload);
  const digest = resourceDigest(kind, taskId, resourceId);
  const basis = {
    schemaVersion: 1 as const,
    taskId,
    recordKind: kind,
    resourceId,
    resourceDigest: digest,
    payload,
    payloadHash,
  };
  return { ...basis, recordHash: contentHash(asJsonValue(basis)) };
}

function sameQuota(
  left: ProjectEnvironmentStoreQuotaV1,
  right: ProjectEnvironmentStoreQuotaV1,
): boolean {
  return canonicalJson(asJsonValue(left)) === canonicalJson(asJsonValue(right));
}

function ledgerParser(
  kind: ProjectEnvironmentTaskLedgerKindV1,
): (input: unknown) => JsonValue {
  switch (kind) {
    case "attempt-events":
      return (input) =>
        asJsonValue(ProjectInitializationAttemptEventV1Schema.parse(input));
    case "binding-epochs":
      return (input) =>
        asJsonValue(EnvironmentBindingEpochV1Schema.parse(input));
    case "turns":
      return (input) =>
        asJsonValue(ProjectEnvironmentTurnV1Schema.parse(input));
  }
}

/**
 * Host-only Task persistence for PE-A candidates, facts, and append-only
 * attempt/binding/turn histories. The root is supplied by CLI layout code.
 */
export class ProjectEnvironmentTaskStoreV1 {
  public readonly storeRoot: string;
  public readonly taskId: TaskId;
  public readonly quota: ProjectEnvironmentStoreQuotaV1;
  private root: DirectoryIdentity | undefined;
  private candidates: DirectoryIdentity | undefined;
  private captureWindows: DirectoryIdentity | undefined;
  private records: DirectoryIdentity | undefined;
  private ledgers: DirectoryIdentity | undefined;
  private readonly queues = new Map<string, Promise<void>>();

  public constructor(options: ProjectEnvironmentTaskStoreOptionsV1) {
    this.storeRoot = resolve(options.storeRoot);
    this.taskId = ProjectEnvironmentTaskIdSchema.parse(options.taskId);
    this.quota =
      options.quota ?? PROJECT_ENVIRONMENT_TASK_STORE_DEFAULT_QUOTA_V1;
    validateQuota(this.quota);
  }

  public async create(): Promise<void> {
    const { directory: root, created } = await createPrivateDirectory(
      this.storeRoot,
    );
    this.root = root;
    const names = await readdir(root.path);
    if (!created && names.includes(STORE_MARKER)) {
      await this.open();
      return;
    }
    if (
      names.some(
        (name) =>
          ![CANDIDATES, CAPTURE_WINDOWS, RECORDS, LEDGERS].includes(name),
      )
    ) {
      throw new ArtifactPathSecurityError(
        root.path,
        "Task store must be empty or contain only an interrupted initial layout",
      );
    }
    this.candidates = (await createChildDirectory(root, CANDIDATES)).directory;
    this.captureWindows = (
      await createChildDirectory(root, CAPTURE_WINDOWS)
    ).directory;
    this.records = (await createChildDirectory(root, RECORDS)).directory;
    this.ledgers = (await createChildDirectory(root, LEDGERS)).directory;
    for (const directory of [
      this.candidates,
      this.captureWindows,
      this.records,
      this.ledgers,
    ]) {
      if ((await readdir(directory.path)).length !== 0) {
        throw new ArtifactPathSecurityError(
          directory.path,
          "interrupted Task store categories must be empty",
        );
      }
    }
    const marker = this.marker();
    await assertQuotaAvailable(
      root,
      this.quota,
      canonicalBytes(asJsonValue(marker)).byteLength,
      1,
    );
    await writeImmutableFile(
      root,
      STORE_MARKER,
      canonicalBytes(asJsonValue(marker)),
    );
    await this.open();
  }

  public async open(): Promise<void> {
    const root = await canonicalDirectoryIdentity(this.storeRoot);
    const names = (await readdir(root.path)).sort();
    if (
      names.length !== ROOT_ENTRIES.size ||
      names.some((name) => !ROOT_ENTRIES.has(name))
    ) {
      throw new ArtifactPathSecurityError(
        root.path,
        "Task store layout contains missing or unexpected entries",
      );
    }
    const candidates = await canonicalDirectoryIdentity(
      join(root.path, CANDIDATES),
    );
    const captureWindows = await canonicalDirectoryIdentity(
      join(root.path, CAPTURE_WINDOWS),
    );
    const records = await canonicalDirectoryIdentity(join(root.path, RECORDS));
    const ledgers = await canonicalDirectoryIdentity(join(root.path, LEDGERS));
    let marker: ProjectEnvironmentTaskStoreMarkerV1;
    try {
      marker = parseMarker(
        await readCanonicalJson(
          root,
          join(root.path, STORE_MARKER),
          this.quota.maximumCanonicalJsonBytes,
        ),
      );
    } catch (error) {
      if (error instanceof ArtifactCorruptionError) throw error;
      throw new ArtifactCorruptionError(join(root.path, STORE_MARKER), error);
    }
    if (
      marker.taskId !== this.taskId ||
      marker.taskNamespaceDigest !== taskNamespaceDigest(this.taskId) ||
      !sameQuota(marker.quota, this.quota)
    ) {
      throw new ArtifactCorruptionError(
        join(root.path, STORE_MARKER),
        new Error("Task store marker ownership or quota does not match"),
      );
    }
    this.root = root;
    this.candidates = candidates;
    this.captureWindows = captureWindows;
    this.records = records;
    this.ledgers = ledgers;
    await inspectImmutablePackageCollection(
      candidates,
      "chronorift-project-adapter-candidate-v1",
      this.taskId,
      this.quota,
      false,
    );
    const captureIdentities = await inspectImmutablePackageCollection(
      captureWindows,
      "chronorift-project-environment-pinned-capture-v1",
      this.taskId,
      this.quota,
      false,
    );
    for (const identity of captureIdentities) {
      await this.readPinnedCapture(
        CaptureWindowIdSchema.parse(identity.resourceId),
      );
    }
    await this.validateRecords();
    await this.validateLedgers();
    await assertQuotaAvailable(root, this.quota);
  }

  public async putCandidateOnce(
    reference: ProjectAdapterCandidateReferenceV1,
    files: readonly ProjectEnvironmentPackageFileInputV1[],
  ): Promise<ImmutablePackageSealV1> {
    const parsed = ProjectAdapterCandidateReferenceV1Schema.parse(reference);
    this.assertTaskOwned(parsed.taskId, "candidate");
    const byteLength = files.reduce(
      (sum, file) => sum + file.bytes.byteLength,
      0,
    );
    if (
      parsed.fileCount !== files.length ||
      parsed.byteLength !== byteLength ||
      parsed.contentDigest !== projectEnvironmentPackageContentDigestV1(files)
    ) {
      throw new TypeError(
        "candidate reference counts or content digest do not match package bytes",
      );
    }
    return this.enqueue(`candidate:${parsed.candidateId}`, () =>
      materializeImmutablePackage({
        collection: this.requireCandidates(),
        storeKind: "chronorift-project-adapter-candidate-v1",
        ownerId: this.taskId,
        resourceId: parsed.candidateId,
        operationId: null,
        payload: parsed,
        parse: parseCandidateReference,
        files,
        quota: this.quota,
        storeRoot: this.requireRoot(),
      }),
    );
  }

  public async readCandidate(
    candidateId: ProjectAdapterCandidateId,
  ): Promise<
    StoredProjectEnvironmentPackageV1<ProjectAdapterCandidateReferenceV1>
  > {
    assertOpaqueId(candidateId, "candidate ID");
    const inspected = await inspectImmutablePackage(
      this.requireCandidates(),
      "chronorift-project-adapter-candidate-v1",
      this.taskId,
      candidateId,
      null,
      parseCandidateReference,
      this.quota,
      false,
    );
    if (
      inspected.state !== "complete" ||
      inspected.payload === undefined ||
      inspected.seal === undefined
    ) {
      throw new ArtifactCorruptionError(
        this.storeRoot,
        new Error("candidate package is not complete"),
      );
    }
    const reference = inspected.payload;
    if (
      reference.taskId !== this.taskId ||
      reference.candidateId !== candidateId ||
      reference.contentDigest !==
        projectEnvironmentPackageContentDigestV1(inspected.files)
    ) {
      throw new ArtifactCorruptionError(
        this.storeRoot,
        new Error("candidate reference does not match its stored package"),
      );
    }
    return {
      payload: reference,
      files: inspected.files,
      payloadHash: contentHash(asJsonValue(reference)),
      packageHash: inspected.seal.packageHash,
      packageSeal: inspected.seal,
    };
  }

  public async putPinnedCaptureOnce(
    value: ProjectEnvironmentPinnedCaptureV1,
    records: readonly JsonValue[],
  ): Promise<ImmutablePackageSealV1> {
    const parsed = ProjectEnvironmentPinnedCaptureV1Schema.parse(value);
    this.assertTaskOwned(parsed.taskId, "pinned capture");
    if (!Array.isArray(records)) {
      throw new TypeError("pinned capture records must be an array");
    }
    const parsedRecords = records.map((record) =>
      JsonValueSchema.parse(record),
    );
    const recordsBytes = canonicalBytes(asJsonValue(parsedRecords));
    const files = [
      { path: PINNED_CAPTURE_RECORDS, bytes: recordsBytes },
    ] as const;
    if (
      parsed.recordCount !== parsedRecords.length ||
      parsed.contentDigest !== projectEnvironmentPackageContentDigestV1(files)
    ) {
      throw new TypeError(
        "pinned capture record count or content digest does not match records.json",
      );
    }
    return this.enqueue(`capture-window:${parsed.captureWindowId}`, () =>
      materializeImmutablePackage({
        collection: this.requireCaptureWindows(),
        storeKind: "chronorift-project-environment-pinned-capture-v1",
        ownerId: this.taskId,
        resourceId: parsed.captureWindowId,
        operationId: null,
        payload: parsed,
        parse: parsePinnedCapture,
        files,
        quota: this.quota,
        storeRoot: this.requireRoot(),
      }),
    );
  }

  public async putPinnedCaptureV2Once(
    value: ProjectEnvironmentPinnedCaptureV2,
    records: readonly JsonValue[],
  ): Promise<ImmutablePackageSealV1> {
    const parsed = ProjectEnvironmentPinnedCaptureV2Schema.parse(value);
    this.assertTaskOwned(parsed.taskId, "V2 pinned capture");
    const parsedRecords = records.map((record) =>
      JsonValueSchema.parse(record),
    );
    const files = [
      {
        path: PINNED_CAPTURE_RECORDS,
        bytes: canonicalBytes(asJsonValue(parsedRecords)),
      },
    ] as const;
    if (
      parsed.recordCount !== parsedRecords.length ||
      parsed.contentDigest !== projectEnvironmentPackageContentDigestV1(files)
    )
      throw new TypeError("V2 pinned capture does not match records.json");
    return this.enqueue(`capture-window:${parsed.captureWindowId}`, () =>
      materializeImmutablePackage({
        collection: this.requireCaptureWindows(),
        storeKind: "chronorift-project-environment-pinned-capture-v1",
        ownerId: this.taskId,
        resourceId: parsed.captureWindowId,
        operationId: null,
        payload: parsed,
        parse: parsePinnedCapture,
        files,
        quota: this.quota,
        storeRoot: this.requireRoot(),
      }),
    );
  }

  public async readPinnedCapture(
    captureWindowId: CaptureWindowId,
  ): Promise<StoredProjectEnvironmentPinnedCaptureV1> {
    const parsedCaptureWindowId = CaptureWindowIdSchema.parse(captureWindowId);
    const inspected = await inspectImmutablePackage(
      this.requireCaptureWindows(),
      "chronorift-project-environment-pinned-capture-v1",
      this.taskId,
      parsedCaptureWindowId,
      null,
      parsePinnedCapture,
      this.quota,
      false,
    );
    if (
      inspected.state !== "complete" ||
      inspected.payload === undefined ||
      inspected.seal === undefined
    ) {
      throw new ArtifactCorruptionError(
        this.storeRoot,
        new Error("pinned capture package is not complete"),
      );
    }
    const capture = inspected.payload;
    const recordsFile = inspected.files[0];
    if (
      capture.taskId !== this.taskId ||
      capture.captureWindowId !== parsedCaptureWindowId ||
      inspected.files.length !== 1 ||
      recordsFile?.path !== PINNED_CAPTURE_RECORDS
    ) {
      throw new ArtifactCorruptionError(
        this.storeRoot,
        new Error("pinned capture manifest does not match its stored package"),
      );
    }
    const recordsPath = join(
      this.requireCaptureWindows().path,
      resourceDigest(
        "chronorift-project-environment-pinned-capture-v1",
        this.taskId,
        parsedCaptureWindowId,
      ),
      "files",
      PINNED_CAPTURE_RECORDS,
    );
    const recordsValue = parseCanonicalJsonBytes(
      recordsPath,
      Buffer.from(recordsFile.bytes),
    );
    if (!Array.isArray(recordsValue)) {
      throw new ArtifactCorruptionError(
        recordsPath,
        new Error("pinned capture records.json must contain a JSON array"),
      );
    }
    const records = recordsValue.map((record) => JsonValueSchema.parse(record));
    if (
      capture.recordCount !== records.length ||
      capture.contentDigest !==
        projectEnvironmentPackageContentDigestV1(inspected.files)
    ) {
      throw new ArtifactCorruptionError(
        this.storeRoot,
        new Error(
          "pinned capture record count or content digest does not match records.json",
        ),
      );
    }
    return {
      payload: capture,
      records,
      recordsBytes: Uint8Array.from(recordsFile.bytes),
      payloadHash: contentHash(asJsonValue(capture)),
      packageHash: inspected.seal.packageHash,
      packageSeal: inspected.seal,
    };
  }

  public putInitializationAttemptOnce(
    value: ProjectInitializationAttemptV1,
  ): Promise<void> {
    return this.putRecord(
      "initialization-attempt",
      value.attemptId,
      value,
      parseInitializationAttempt,
    );
  }

  public readInitializationAttempt(
    attemptId: ProjectInitializationAttemptId,
  ): Promise<ProjectInitializationAttemptV1> {
    return this.readRecord(
      "initialization-attempt",
      attemptId,
      parseInitializationAttempt,
    );
  }

  public putPublicationIntentOnce(
    value: EnvironmentPublicationIntentV1,
  ): Promise<void> {
    return this.putRecord(
      "publication-intent",
      value.operationId,
      value,
      parsePublicationIntent,
    );
  }

  public readPublicationIntent(
    operationId: ProjectEnvironmentOperationId,
  ): Promise<EnvironmentPublicationIntentV1> {
    return this.readRecord(
      "publication-intent",
      operationId,
      parsePublicationIntent,
    );
  }

  public putPublicationReceiptOnce(
    value: EnvironmentPublicationReceiptV1,
  ): Promise<void> {
    return this.putRecord(
      "publication-receipt",
      value.receiptId,
      value,
      parsePublicationReceipt,
    );
  }

  public readPublicationReceipt(
    receiptId: EnvironmentPublicationReceiptV1["receiptId"],
  ): Promise<EnvironmentPublicationReceiptV1> {
    return this.readRecord(
      "publication-receipt",
      receiptId,
      parsePublicationReceipt,
    );
  }

  public async findPublicationReceiptByOperation(
    operationIdInput: ProjectEnvironmentOperationId,
  ): Promise<EnvironmentPublicationReceiptV1 | null> {
    const operationId =
      ProjectEnvironmentOperationIdSchema.parse(operationIdInput);
    const records = this.requireRecords();
    let found: EnvironmentPublicationReceiptV1 | null = null;
    for (const name of (await readdir(records.path)).sort()) {
      const match =
        /^publication-receipt\.(?<digest>[a-f0-9]{64})\.json$/u.exec(name);
      if (match?.groups === undefined) continue;
      const path = join(records.path, name);
      let receipt: EnvironmentPublicationReceiptV1;
      try {
        const envelope = parseRecordEnvelope(
          await readCanonicalJson(
            records,
            path,
            this.quota.maximumCanonicalJsonBytes,
          ),
        );
        if (envelope.recordKind !== "publication-receipt") {
          throw new Error(
            "publication receipt path has a different record kind",
          );
        }
        receipt = parsePublicationReceipt(envelope.payload);
        const expected = recordEnvelope(
          this.taskId,
          "publication-receipt",
          receipt.receiptId,
          envelope.payload,
        );
        if (
          match.groups.digest !== expected.resourceDigest ||
          canonicalJson(asJsonValue(expected)) !==
            canonicalJson(asJsonValue(envelope))
        ) {
          throw new Error(
            "publication receipt path, ownership, or hash mismatch",
          );
        }
      } catch (error) {
        if (error instanceof ArtifactCorruptionError) throw error;
        throw new ArtifactCorruptionError(path, error);
      }
      if (receipt.operationId !== operationId) continue;
      if (
        found !== null &&
        canonicalJson(asJsonValue(found)) !==
          canonicalJson(asJsonValue(receipt))
      ) {
        throw new ArtifactCorruptionError(
          records.path,
          new Error("publication operation has multiple distinct receipts"),
        );
      }
      found = receipt;
    }
    await assertDirectoryIdentity(records);
    return found;
  }

  public putToolchainReceiptOnce(
    value: ProjectToolchainReceiptV1,
  ): Promise<void> {
    return this.putRecord(
      "toolchain-receipt",
      value.receiptId,
      value,
      parseToolchainReceipt,
    );
  }

  public readToolchainReceipt(
    receiptId: ProjectToolchainReceiptV1["receiptId"],
  ): Promise<ProjectToolchainReceiptV1> {
    return this.readRecord(
      "toolchain-receipt",
      receiptId,
      parseToolchainReceipt,
    );
  }

  public putConformanceReceiptOnce(
    value: AdapterConformanceReceiptV1,
  ): Promise<void> {
    return this.putRecord(
      "conformance-receipt",
      value.receiptId,
      value,
      parseConformanceReceipt,
    );
  }

  public readConformanceReceipt(
    receiptId: AdapterConformanceReceiptV1["receiptId"],
  ): Promise<AdapterConformanceReceiptV1> {
    return this.readRecord("conformance-receipt", receiptId, (input) =>
      AdapterConformanceReceiptV1Schema.parse(input),
    );
  }

  public putConformanceReceiptV2Once(
    value: AdapterConformanceReceiptV2,
  ): Promise<void> {
    return this.putRecord(
      "conformance-receipt",
      value.receiptId,
      value,
      (input) => AdapterConformanceReceiptV2Schema.parse(input),
    );
  }

  public readConformanceReceiptV2(
    receiptId: AdapterConformanceReceiptV2["receiptId"],
  ): Promise<AdapterConformanceReceiptV2> {
    return this.readRecord("conformance-receipt", receiptId, (input) =>
      AdapterConformanceReceiptV2Schema.parse(input),
    );
  }

  public putObserverEffectReceiptOnce(
    value: ObserverEffectReceiptV1,
  ): Promise<void> {
    return this.putRecord(
      "observer-effect-receipt",
      value.receiptId,
      value,
      parseObserverEffectReceipt,
    );
  }

  public readObserverEffectReceipt(
    receiptId: ObserverEffectReceiptV1["receiptId"],
  ): Promise<ObserverEffectReceiptV1> {
    return this.readRecord(
      "observer-effect-receipt",
      receiptId,
      parseObserverEffectReceipt,
    );
  }

  public putCompatibilityReceiptOnce(
    value: AdapterCompatibilityReceiptV1,
  ): Promise<void> {
    return this.putRecord(
      "compatibility-receipt",
      value.receiptId,
      value,
      parseCompatibilityReceipt,
    );
  }

  public readCompatibilityReceipt(
    receiptId: AdapterCompatibilityReceiptV1["receiptId"],
  ): Promise<AdapterCompatibilityReceiptV1> {
    return this.readRecord("compatibility-receipt", receiptId, (input) =>
      AdapterCompatibilityReceiptV1Schema.parse(input),
    );
  }

  public putCompatibilityReceiptV2Once(
    value: AdapterCompatibilityReceiptV2,
  ): Promise<void> {
    return this.putRecord(
      "compatibility-receipt",
      value.receiptId,
      value,
      (input) => AdapterCompatibilityReceiptV2Schema.parse(input),
    );
  }

  public readCompatibilityReceiptV2(
    receiptId: AdapterCompatibilityReceiptV2["receiptId"],
  ): Promise<AdapterCompatibilityReceiptV2> {
    return this.readRecord("compatibility-receipt", receiptId, (input) =>
      AdapterCompatibilityReceiptV2Schema.parse(input),
    );
  }

  public putReuseReceiptOnce(
    value: ProjectEnvironmentReuseReceiptV1,
  ): Promise<void> {
    return this.putRecord(
      "reuse-receipt",
      value.receiptId,
      value,
      parseReuseReceipt,
    );
  }

  public readReuseReceipt(
    receiptId: ProjectEnvironmentReuseReceiptV1["receiptId"],
  ): Promise<ProjectEnvironmentReuseReceiptV1> {
    return this.readRecord("reuse-receipt", receiptId, parseReuseReceipt);
  }

  public putRuntimeObservationReceiptOnce(
    value: ProjectEnvironmentRuntimeObservationReceiptV1,
  ): Promise<void> {
    return this.putRecord(
      "runtime-observation-receipt",
      value.receiptId,
      value,
      parseRuntimeObservationReceipt,
    );
  }

  public readRuntimeObservationReceipt(
    receiptId: ProjectEnvironmentRuntimeObservationReceiptV1["receiptId"],
  ): Promise<ProjectEnvironmentRuntimeObservationReceiptV1> {
    return this.readRecord("runtime-observation-receipt", receiptId, (input) =>
      ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse(input),
    );
  }

  public putRuntimeObservationReceiptV2Once(
    value: ProjectEnvironmentRuntimeObservationReceiptV2,
  ): Promise<void> {
    return this.putRecord(
      "runtime-observation-receipt",
      value.receiptId,
      value,
      (input) =>
        ProjectEnvironmentRuntimeObservationReceiptV2Schema.parse(input),
    );
  }

  public readRuntimeObservationReceiptV2(
    receiptId: ProjectEnvironmentRuntimeObservationReceiptV2["receiptId"],
  ): Promise<ProjectEnvironmentRuntimeObservationReceiptV2> {
    return this.readRecord("runtime-observation-receipt", receiptId, (input) =>
      ProjectEnvironmentRuntimeObservationReceiptV2Schema.parse(input),
    );
  }

  public putBuildBindingOnce(
    value: ProjectEnvironmentBuildBindingV1,
  ): Promise<void> {
    return this.putRecord(
      "build-binding",
      value.buildId,
      value,
      parseBuildBinding,
    );
  }

  public putBuildOnce(value: VNextBuildV1): Promise<void> {
    return this.putRecord("build", value.buildId, value, parseBuild);
  }

  public readBuild(buildId: VNextBuildV1["buildId"]): Promise<VNextBuildV1> {
    return this.readRecord("build", buildId, parseBuild);
  }

  public readBuildBinding(
    buildId: ProjectEnvironmentBuildBindingV1["buildId"],
  ): Promise<ProjectEnvironmentBuildBindingV1> {
    return this.readRecord("build-binding", buildId, parseBuildBinding);
  }

  public appendAttemptEvent(
    value: ProjectInitializationAttemptEventV1,
  ): Promise<ProjectEnvironmentLedgerEnvelopeV1> {
    const parsed = ProjectInitializationAttemptEventV1Schema.parse(value);
    this.assertTaskOwned(parsed.taskId, "attempt event");
    return this.enqueue("ledger:attempt-events", async () => {
      const existing = await readLedger(
        this.requireLedgers(),
        LEDGER_FILES["attempt-events"],
        this.taskId,
        parseAttemptEvent,
        this.quota,
      );
      const attemptEvents = existing.filter(
        (event) => event.attemptId === parsed.attemptId,
      );
      foldProjectInitializationAttemptV1([...attemptEvents, parsed]);
      return appendLedger(
        this.requireRoot(),
        this.requireLedgers(),
        LEDGER_FILES["attempt-events"],
        this.taskId,
        parsed,
        parseAttemptEvent,
        this.quota,
      );
    });
  }

  public appendBindingEpoch(
    value: EnvironmentBindingEpochV1,
  ): Promise<ProjectEnvironmentLedgerEnvelopeV1> {
    return this.appendToLedger("binding-epochs", value, parseBindingEpoch);
  }

  public appendTurn(
    value: ProjectEnvironmentTurnV1,
  ): Promise<ProjectEnvironmentLedgerEnvelopeV1> {
    return this.appendToLedger("turns", value, parseTurn);
  }

  public async readAttemptEvents(): Promise<
    readonly ProjectInitializationAttemptEventV1[]
  > {
    return this.readTypedLedger("attempt-events", parseAttemptEvent);
  }

  public async readBindingEpochs(): Promise<
    readonly EnvironmentBindingEpochV1[]
  > {
    return this.readTypedLedger("binding-epochs", parseBindingEpoch);
  }

  public async readTurns(): Promise<readonly ProjectEnvironmentTurnV1[]> {
    return this.readTypedLedger("turns", parseTurn);
  }

  public sealLedger(
    kind: ProjectEnvironmentTaskLedgerKindV1,
  ): Promise<ProjectEnvironmentLedgerSealV1> {
    return this.enqueue(`ledger:${kind}`, () =>
      sealLedger(
        this.requireRoot(),
        this.requireLedgers(),
        LEDGER_FILES[kind],
        this.taskId,
        this.quota,
      ),
    );
  }

  public async summary(): Promise<ProjectEnvironmentTaskStoreSummaryV1> {
    await this.revalidate();
    const candidates = await readdir(this.requireCandidates().path);
    const captureWindows = await readdir(this.requireCaptureWindows().path);
    const records = await readdir(this.requireRecords().path);
    const ledgerNames = await readdir(this.requireLedgers().path);
    let ledgerRecords = 0;
    let sealedLedgers = 0;
    for (const kind of Object.keys(
      LEDGER_FILES,
    ) as ProjectEnvironmentTaskLedgerKindV1[]) {
      const values = await this.readTypedLedger(kind, ledgerParser(kind));
      ledgerRecords += values.length;
      if (ledgerNames.includes(`${LEDGER_FILES[kind]}.seal.json`)) {
        sealedLedgers += 1;
      }
    }
    const usage = await inspectTreeUsage(this.requireRoot());
    return {
      schemaVersion: 1,
      taskId: this.taskId,
      candidates: candidates.length,
      captureWindows: captureWindows.length,
      records: records.length,
      ledgerRecords,
      sealedLedgers,
      bytes: usage.bytes,
      entries: usage.entries,
    };
  }

  /**
   * Seals all append-only Task ledgers and freezes a path-free inventory of
   * every immutable collection entry and record envelope. This is local
   * physical closure evidence, not a signature or Host attestation.
   */
  public async freezeEvidenceInventory(): Promise<ProjectEnvironmentTaskEvidenceInventoryV1> {
    await this.revalidate();
    for (const kind of Object.keys(
      LEDGER_FILES,
    ) as ProjectEnvironmentTaskLedgerKindV1[]) {
      await this.sealLedger(kind);
    }
    const candidatePackages = (
      await inspectImmutablePackageCollection(
        this.requireCandidates(),
        "chronorift-project-adapter-candidate-v1",
        this.taskId,
        this.quota,
        false,
      )
    ).map(({ resourceId, resourceDigest }) => ({
      resourceId,
      resourceDigest,
    }));
    const captureWindowPackages = (
      await inspectImmutablePackageCollection(
        this.requireCaptureWindows(),
        "chronorift-project-environment-pinned-capture-v1",
        this.taskId,
        this.quota,
        false,
      )
    ).map(({ resourceId, resourceDigest }) => ({
      resourceId,
      resourceDigest,
    }));
    const records: TaskRecordEnvelopeV1[] = [];
    const recordsDirectory = this.requireRecords();
    for (const name of (await readdir(recordsDirectory.path)).sort()) {
      const value = await readCanonicalJson(
        recordsDirectory,
        join(recordsDirectory.path, name),
        this.quota.maximumCanonicalJsonBytes,
      );
      const envelope = parseRecordEnvelope(value);
      parsePayload(envelope.recordKind, envelope.payload);
      records.push(envelope);
    }
    const ledgers = await Promise.all(
      (Object.keys(LEDGER_FILES) as ProjectEnvironmentTaskLedgerKindV1[]).map(
        async (kind) => {
          const evidence = await readSealedLedgerEvidence(
            this.requireLedgers(),
            LEDGER_FILES[kind],
            this.taskId,
            ledgerParser(kind),
            this.quota,
          );
          return {
            kind,
            canonicalBase64: Buffer.from(evidence.bytes).toString("base64"),
            envelopes: evidence.envelopes,
            seal: evidence.seal,
          };
        },
      ),
    );
    const basis = {
      schemaVersion: 1 as const,
      taskId: this.taskId,
      candidatePackages: Object.freeze(candidatePackages),
      captureWindowPackages: Object.freeze(captureWindowPackages),
      records: Object.freeze(records),
      ledgers: Object.freeze(ledgers),
    };
    return Object.freeze({
      ...basis,
      inventoryHash: contentHash(asJsonValue(basis)),
    });
  }

  private marker(): ProjectEnvironmentTaskStoreMarkerV1 {
    return {
      schemaVersion: 1,
      storeKind: "chronorift-project-environment-task-store-v1",
      taskId: this.taskId,
      taskNamespaceDigest: taskNamespaceDigest(this.taskId),
      quota: this.quota,
    };
  }

  private assertTaskOwned(taskId: TaskId, label: string): void {
    if (taskId !== this.taskId) {
      throw new ArtifactPathSecurityError(
        this.storeRoot,
        `${label} belongs to a different Task`,
      );
    }
  }

  private async putRecord<T>(
    kind: ProjectEnvironmentTaskRecordKindV1,
    resourceId: string,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<void> {
    assertOpaqueId(resourceId, "Task record resource ID");
    const payload = asJsonValue(parse(value));
    const parsed = parsePayload(kind, payload);
    if ("taskId" in parsed) this.assertTaskOwned(parsed.taskId, kind);
    const envelope = recordEnvelope(this.taskId, kind, resourceId, payload);
    const bytes = canonicalBytes(asJsonValue(envelope));
    if (bytes.byteLength > this.quota.maximumCanonicalJsonBytes) {
      throw new TypeError("Task record exceeds the canonical JSON byte limit");
    }
    const name = `${kind}.${envelope.resourceDigest}.json`;
    await this.enqueue(`record:${name}`, async () => {
      await assertQuotaAvailable(
        this.requireRoot(),
        this.quota,
        bytes.byteLength,
        1,
      );
      await writeImmutableFile(this.requireRecords(), name, bytes);
    });
  }

  private async readRecord<T>(
    kind: ProjectEnvironmentTaskRecordKindV1,
    resourceId: string,
    parse: (input: unknown) => T,
  ): Promise<T> {
    assertOpaqueId(resourceId, "Task record resource ID");
    const digest = resourceDigest(kind, this.taskId, resourceId);
    const path = join(this.requireRecords().path, `${kind}.${digest}.json`);
    const input = await readCanonicalJson(
      this.requireRecords(),
      path,
      this.quota.maximumCanonicalJsonBytes,
    );
    let envelope: TaskRecordEnvelopeV1;
    try {
      envelope = parseRecordEnvelope(input);
      const expected = recordEnvelope(
        this.taskId,
        kind,
        resourceId,
        envelope.payload,
      );
      if (
        canonicalJson(asJsonValue(expected)) !==
        canonicalJson(asJsonValue(envelope))
      ) {
        throw new Error("Task record identity or hash mismatch");
      }
      parsePayload(kind, envelope.payload);
      return parse(envelope.payload);
    } catch (error) {
      throw new ArtifactCorruptionError(path, error);
    }
  }

  private appendToLedger<T>(
    kind: ProjectEnvironmentTaskLedgerKindV1,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<ProjectEnvironmentLedgerEnvelopeV1> {
    const parsed = parse(value);
    if (
      isObject(parsed) &&
      "taskId" in parsed &&
      typeof parsed.taskId === "string"
    ) {
      this.assertTaskOwned(
        ProjectEnvironmentTaskIdSchema.parse(parsed.taskId),
        kind,
      );
    }
    return this.enqueue(`ledger:${kind}`, () =>
      appendLedger(
        this.requireRoot(),
        this.requireLedgers(),
        LEDGER_FILES[kind],
        this.taskId,
        parsed,
        parse,
        this.quota,
      ),
    );
  }

  private readTypedLedger<T>(
    kind: ProjectEnvironmentTaskLedgerKindV1,
    parse: (input: unknown) => T,
  ): Promise<readonly T[]> {
    return this.enqueue(`ledger:${kind}`, () =>
      readLedger(
        this.requireLedgers(),
        LEDGER_FILES[kind],
        this.taskId,
        parse,
        this.quota,
      ),
    );
  }

  private async validateRecords(): Promise<void> {
    const directory = this.requireRecords();
    for (const name of (await readdir(directory.path)).sort()) {
      const match = /^(?<kind>[a-z-]+)\.(?<digest>[a-f0-9]{64})\.json$/u.exec(
        name,
      );
      if (match?.groups === undefined) {
        throw new ArtifactPathSecurityError(
          join(directory.path, name),
          "unexpected Task record name",
        );
      }
      const kind = parseRecordKind(match.groups.kind);
      const path = join(directory.path, name);
      let envelope: TaskRecordEnvelopeV1;
      try {
        envelope = parseRecordEnvelope(
          await readCanonicalJson(
            directory,
            path,
            this.quota.maximumCanonicalJsonBytes,
          ),
        );
        const expected = recordEnvelope(
          this.taskId,
          kind,
          envelope.resourceId,
          envelope.payload,
        );
        if (
          match.groups.digest !== expected.resourceDigest ||
          canonicalJson(asJsonValue(expected)) !==
            canonicalJson(asJsonValue(envelope))
        ) {
          throw new Error("Task record path, ownership, or hash mismatch");
        }
        parsePayload(kind, envelope.payload);
      } catch (error) {
        if (error instanceof ArtifactCorruptionError) throw error;
        throw new ArtifactCorruptionError(path, error);
      }
    }
    await assertDirectoryIdentity(directory);
  }

  private async validateLedgers(): Promise<void> {
    const directory = this.requireLedgers();
    const names = await readdir(directory.path);
    for (const name of names) {
      const ledgerName = name.endsWith(".seal.json")
        ? name.slice(0, -".seal.json".length)
        : name;
      if (!LEDGER_NAMES.has(ledgerName)) {
        throw new ArtifactPathSecurityError(
          join(directory.path, name),
          "unexpected Task ledger entry",
        );
      }
      const status = await lstat(join(directory.path, name));
      if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
        throw new ArtifactPathSecurityError(
          join(directory.path, name),
          "Task ledger entry must be a singly-linked regular file",
        );
      }
    }
    for (const kind of Object.keys(
      LEDGER_FILES,
    ) as ProjectEnvironmentTaskLedgerKindV1[]) {
      await validateLedger(
        directory,
        LEDGER_FILES[kind],
        this.taskId,
        this.quota,
      );
      await this.readTypedLedger(kind, ledgerParser(kind));
    }
    const attemptEvents = await readLedger(
      directory,
      LEDGER_FILES["attempt-events"],
      this.taskId,
      parseAttemptEvent,
      this.quota,
    );
    const attempts = new Map<string, ProjectInitializationAttemptEventV1[]>();
    for (const event of attemptEvents) {
      const events = attempts.get(event.attemptId) ?? [];
      events.push(event);
      attempts.set(event.attemptId, events);
    }
    for (const events of attempts.values()) {
      try {
        foldProjectInitializationAttemptV1(events);
      } catch (error) {
        throw new ArtifactCorruptionError(
          join(directory.path, LEDGER_FILES["attempt-events"]),
          error,
        );
      }
    }
  }

  private async revalidate(): Promise<void> {
    const root = this.requireRoot();
    await assertDirectoryIdentity(root);
    await assertDirectoryIdentity(this.requireCandidates());
    await assertDirectoryIdentity(this.requireCaptureWindows());
    await assertDirectoryIdentity(this.requireRecords());
    await assertDirectoryIdentity(this.requireLedgers());
    const names = await readdir(root.path);
    if (
      names.some((name) => !ROOT_ENTRIES.has(name)) ||
      names.length !== ROOT_ENTRIES.size
    ) {
      throw new ArtifactPathSecurityError(
        root.path,
        "Task store layout changed",
      );
    }
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, completion);
    void completion.finally(() => {
      if (this.queues.get(key) === completion) this.queues.delete(key);
    });
    return result;
  }

  private requireRoot(): DirectoryIdentity {
    if (this.root === undefined)
      throw new ArtifactNotFoundError(this.storeRoot);
    return this.root;
  }

  private requireCandidates(): DirectoryIdentity {
    if (this.candidates === undefined) {
      throw new ArtifactNotFoundError(join(this.storeRoot, CANDIDATES));
    }
    return this.candidates;
  }

  private requireCaptureWindows(): DirectoryIdentity {
    if (this.captureWindows === undefined) {
      throw new ArtifactNotFoundError(join(this.storeRoot, CAPTURE_WINDOWS));
    }
    return this.captureWindows;
  }

  private requireRecords(): DirectoryIdentity {
    if (this.records === undefined) {
      throw new ArtifactNotFoundError(join(this.storeRoot, RECORDS));
    }
    return this.records;
  }

  private requireLedgers(): DirectoryIdentity {
    if (this.ledgers === undefined) {
      throw new ArtifactNotFoundError(join(this.storeRoot, LEDGERS));
    }
    return this.ledgers;
  }
}

export {
  IncompleteProjectEnvironmentArtifactError,
  ProjectEnvironmentLedgerSealedError,
  ProjectEnvironmentStoreQuotaError,
  projectEnvironmentPackageContentDigestV1,
  type ImmutablePackageSealV1,
  type ProjectEnvironmentLedgerEnvelopeV1,
  type ProjectEnvironmentLedgerSealV1,
  type ProjectEnvironmentPackageFileInputV1,
  type ProjectEnvironmentStoreQuotaV1,
  type StoredProjectEnvironmentPackageV1,
} from "./project-environment-store-internals.js";
