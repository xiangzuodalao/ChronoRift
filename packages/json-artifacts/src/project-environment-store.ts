import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  EnvironmentPublicationRecoveryAuthorityV1Schema,
  EnvironmentPublicationRecoveryResolutionV1Schema,
  ProjectEnvironmentIdSchema,
  ProjectEnvironmentOperationIdSchema,
  ProjectEnvironmentRevisionIdSchema,
  ProjectEnvironmentRevisionV1Schema,
  type EnvironmentPublicationRecoveryAuthorityV1,
  type EnvironmentPublicationRecoveryResolutionV1,
  type ProjectEnvironmentId,
  type ProjectEnvironmentOperationId,
  type ProjectEnvironmentRevisionId,
  type ProjectEnvironmentRevisionV1,
} from "@chronorift/domain";

import { canonicalJson, contentHash } from "./canonical-json.js";
import { ArtifactCorruptionError, ArtifactNotFoundError } from "./errors.js";
import {
  ArtifactPathSecurityError,
  ImmutableArtifactConflictError,
} from "./v01-json-artifact-repository.js";
import {
  asJsonValue,
  assertDirectoryIdentity,
  assertQuotaAvailable,
  canonicalBytes,
  canonicalDirectoryIdentity,
  createChildDirectory,
  createPrivateDirectory,
  directoryExists,
  hasExactKeys,
  identityOf,
  inspectImmutablePackage,
  inspectImmutablePackageCollection,
  inspectTreeUsage,
  isNodeError,
  isObject,
  isSha256,
  materializeImmutablePackage,
  projectEnvironmentPackageContentDigestV1,
  ProjectEnvironmentStoreQuotaError,
  readCanonicalJson,
  resourceDigest,
  sameIdentity,
  syncDirectory,
  validateQuota,
  writeImmutableFile,
  type DirectoryIdentity,
  type FileIdentity,
  type ImmutablePackageSealV1,
  type ProjectEnvironmentPackageFileInputV1,
  type ProjectEnvironmentStoreQuotaV1,
  type StoredProjectEnvironmentPackageV1,
} from "./project-environment-store-internals.js";

export interface ProjectEnvironmentStoreOptionsV1 {
  /** Exact `.chronorift/project-environment-v1` path admitted by the CLI. */
  readonly namespaceRoot: string;
  readonly environmentId: ProjectEnvironmentId;
  readonly quota?: ProjectEnvironmentStoreQuotaV1;
}

export interface ProjectEnvironmentCurrentPointerV1 {
  readonly schemaVersion: 1;
  readonly environmentId: ProjectEnvironmentId;
  readonly environmentRevisionId: ProjectEnvironmentRevisionId;
  readonly publicationOperationId: ProjectEnvironmentOperationId;
  readonly revisionContentDigest: string;
  readonly commitRequestedAt: string;
  readonly pointerHash: string;
}

export interface CommitInitialProjectEnvironmentCurrentInputV1 {
  readonly expectedCurrentRevisionId: null;
  readonly environmentRevisionId: ProjectEnvironmentRevisionId;
  readonly publicationOperationId: ProjectEnvironmentOperationId;
  readonly commitRequestedAt: string;
}

export interface InitialProjectEnvironmentPublicationInspectionV1 {
  readonly schemaVersion: 1;
  readonly state:
    | "absent"
    | "revision_incomplete"
    | "revision_materialized"
    | "pointer_prepared"
    | "committed"
    | "conflict";
  readonly environmentId: ProjectEnvironmentId;
  readonly environmentRevisionId: ProjectEnvironmentRevisionId;
  readonly publicationOperationId: ProjectEnvironmentOperationId;
  readonly current: ProjectEnvironmentCurrentPointerV1 | null;
}

export interface ProjectEnvironmentStoreSummaryV1 {
  readonly schemaVersion: 1;
  readonly environmentId: ProjectEnvironmentId;
  readonly completeRevisions: number;
  readonly incompleteRevisions: number;
  readonly transactions: number;
  readonly quarantinedRevisions: number;
  readonly pendingPublicationRecoveries: number;
  readonly resolvedPublicationRecoveries: number;
  readonly interruptedPublicationRecords: number;
  readonly current: ProjectEnvironmentCurrentPointerV1 | null;
  readonly bytes: number;
  readonly entries: number;
}

interface ProjectEnvironmentStoreMarkerV1 {
  readonly schemaVersion: 1;
  readonly storeKind: "chronorift-project-environment-store-v1";
  readonly environmentId: ProjectEnvironmentId;
  readonly environmentNamespaceDigest: string;
  readonly quota: ProjectEnvironmentStoreQuotaV1;
}

interface PublicationTransactionMarkerV1 {
  readonly schemaVersion: 1;
  readonly storeKind: "chronorift-project-environment-publication-transaction-v1";
  readonly environmentId: ProjectEnvironmentId;
  readonly environmentRevisionId: ProjectEnvironmentRevisionId;
  readonly publicationOperationId: ProjectEnvironmentOperationId;
  readonly transactionDigest: string;
  readonly revisionContentDigest: string;
}

interface QuarantineMarkerV1 {
  readonly schemaVersion: 1;
  readonly storeKind: "chronorift-project-environment-quarantine-v1";
  readonly environmentId: ProjectEnvironmentId;
  readonly environmentRevisionId: ProjectEnvironmentRevisionId;
  readonly publicationOperationId: ProjectEnvironmentOperationId;
  readonly quarantineDigest: string;
}

interface PublicationTransactionInspection {
  readonly directory: DirectoryIdentity;
  readonly marker: PublicationTransactionMarkerV1;
  readonly stagedPointerPath: string;
  readonly stagedPointerIdentity: FileIdentity | undefined;
}

interface PublicationRecoveryRecordInspectionV1 {
  readonly directory: DirectoryIdentity;
  readonly authority: EnvironmentPublicationRecoveryAuthorityV1;
  readonly resolution: EnvironmentPublicationRecoveryResolutionV1 | null;
}

const STORE_MARKER = ".chronorift-project-environment-store-v1.json";
const REVISIONS = "revisions";
const TRANSACTIONS = "transactions";
const QUARANTINE = "quarantine";
const PUBLICATION_RECOVERY = "publication-recovery";
const PUBLICATION_ORPHANS = "publication-orphans";
const CURRENT = "current.json";
const TRANSACTION_MARKER = ".chronorift-publication-transaction-v1.json";
const STAGED_POINTER = "current.pointer.json";
const QUARANTINE_MARKER = ".chronorift-quarantine-v1.json";
const QUARANTINED_PARTIAL = "partial";
const RECOVERY_AUTHORITY = "authority.json";
const RECOVERY_RESOLUTION = "resolution.json";
const IMMUTABLE_STAGE_PATTERN =
  /^\.chronorift-stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const INTERRUPTED_RECORD_PATTERN =
  /^(?:authority|transaction)\.[a-f0-9]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:record|tmp)$/u;
const ROOT_REQUIRED = new Set([
  STORE_MARKER,
  REVISIONS,
  TRANSACTIONS,
  QUARANTINE,
  PUBLICATION_RECOVERY,
  PUBLICATION_ORPHANS,
]);

const parseProjectEnvironmentRevision = (
  input: unknown,
): ProjectEnvironmentRevisionV1 =>
  ProjectEnvironmentRevisionV1Schema.parse(input);

export const PROJECT_ENVIRONMENT_STORE_DEFAULT_QUOTA_V1 = Object.freeze({
  maximumTotalBytes: 128 * 1024 * 1024,
  maximumEntries: 4_096,
  maximumCanonicalJsonBytes: 2 * 1024 * 1024,
  maximumPackageBytes: 16 * 1024 * 1024,
  maximumPackageFiles: 512,
}) satisfies ProjectEnvironmentStoreQuotaV1;

export class ProjectEnvironmentCurrentConflictError extends Error {
  public constructor(
    readonly environmentId: ProjectEnvironmentId,
    readonly expectedRevisionId: ProjectEnvironmentRevisionId | null,
    readonly observedRevisionId: ProjectEnvironmentRevisionId,
  ) {
    super(
      `Project Environment current conflict for ${environmentId}: expected ${String(expectedRevisionId)}, observed ${observedRevisionId}`,
    );
    this.name = "ProjectEnvironmentCurrentConflictError";
  }
}

export class ProjectEnvironmentPublicationRecoveryRequiredError extends Error {
  public constructor(readonly namespaceRoot: string) {
    super(
      `Project Environment publication recovery is required: ${namespaceRoot}`,
    );
    this.name = "ProjectEnvironmentPublicationRecoveryRequiredError";
  }
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
  const values = Object.values(input);
  if (
    values.some(
      (value) =>
        typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0,
    )
  ) {
    throw new Error(
      "Project Environment quota values must be positive integers",
    );
  }
  const quota = {
    maximumTotalBytes: input.maximumTotalBytes,
    maximumEntries: input.maximumEntries,
    maximumCanonicalJsonBytes: input.maximumCanonicalJsonBytes,
    maximumPackageBytes: input.maximumPackageBytes,
    maximumPackageFiles: input.maximumPackageFiles,
  } as ProjectEnvironmentStoreQuotaV1;
  validateQuota(quota);
  return quota;
}

function parseStoreMarker(input: unknown): ProjectEnvironmentStoreMarkerV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "storeKind",
      "environmentId",
      "environmentNamespaceDigest",
      "quota",
    ]) ||
    input.schemaVersion !== 1 ||
    input.storeKind !== "chronorift-project-environment-store-v1" ||
    !isSha256(input.environmentNamespaceDigest)
  ) {
    throw new Error("invalid Project Environment store marker");
  }
  return {
    schemaVersion: 1,
    storeKind: "chronorift-project-environment-store-v1",
    environmentId: ProjectEnvironmentIdSchema.parse(input.environmentId),
    environmentNamespaceDigest: input.environmentNamespaceDigest,
    quota: parseQuota(input.quota),
  };
}

function pointerBasis(
  environmentId: ProjectEnvironmentId,
  revision: ProjectEnvironmentRevisionV1,
  commitRequestedAt: string,
) {
  return {
    schemaVersion: 1 as const,
    environmentId,
    environmentRevisionId: revision.environmentRevisionId,
    publicationOperationId: revision.publicationOperationId,
    revisionContentDigest: revision.contentDigest,
    commitRequestedAt,
  };
}

function currentPointer(
  environmentId: ProjectEnvironmentId,
  revision: ProjectEnvironmentRevisionV1,
  commitRequestedAt: string,
): ProjectEnvironmentCurrentPointerV1 {
  const basis = pointerBasis(environmentId, revision, commitRequestedAt);
  return { ...basis, pointerHash: contentHash(asJsonValue(basis)) };
}

function parseCurrentPointer(
  input: unknown,
): ProjectEnvironmentCurrentPointerV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "environmentId",
      "environmentRevisionId",
      "publicationOperationId",
      "revisionContentDigest",
      "commitRequestedAt",
      "pointerHash",
    ]) ||
    input.schemaVersion !== 1 ||
    !isSha256(input.revisionContentDigest) ||
    typeof input.commitRequestedAt !== "string" ||
    !Number.isFinite(Date.parse(input.commitRequestedAt)) ||
    !isSha256(input.pointerHash)
  ) {
    throw new Error("invalid Project Environment current pointer");
  }
  const parsed: ProjectEnvironmentCurrentPointerV1 = {
    schemaVersion: 1,
    environmentId: ProjectEnvironmentIdSchema.parse(input.environmentId),
    environmentRevisionId: ProjectEnvironmentRevisionIdSchema.parse(
      input.environmentRevisionId,
    ),
    publicationOperationId: ProjectEnvironmentOperationIdSchema.parse(
      input.publicationOperationId,
    ),
    revisionContentDigest: input.revisionContentDigest,
    commitRequestedAt: input.commitRequestedAt,
    pointerHash: input.pointerHash,
  };
  const basis = {
    schemaVersion: 1 as const,
    environmentId: parsed.environmentId,
    environmentRevisionId: parsed.environmentRevisionId,
    publicationOperationId: parsed.publicationOperationId,
    revisionContentDigest: parsed.revisionContentDigest,
    commitRequestedAt: parsed.commitRequestedAt,
  };
  if (parsed.pointerHash !== contentHash(asJsonValue(basis))) {
    throw new Error("Project Environment current pointer hash mismatch");
  }
  return parsed;
}

function transactionDigest(
  environmentId: ProjectEnvironmentId,
  revisionId: ProjectEnvironmentRevisionId,
  operationId: ProjectEnvironmentOperationId,
): string {
  return resourceDigest(
    "chronorift-project-environment-publication-transaction-v1",
    environmentId,
    `${revisionId}\0${operationId}`,
  );
}

function publicationRecoveryDigest(
  environmentId: ProjectEnvironmentId,
  operationId: ProjectEnvironmentOperationId,
): string {
  return resourceDigest(
    "chronorift-project-environment-publication-recovery-v1",
    environmentId,
    operationId,
  );
}

function parseTransactionMarker(
  input: unknown,
): PublicationTransactionMarkerV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "storeKind",
      "environmentId",
      "environmentRevisionId",
      "publicationOperationId",
      "transactionDigest",
      "revisionContentDigest",
    ]) ||
    input.schemaVersion !== 1 ||
    input.storeKind !==
      "chronorift-project-environment-publication-transaction-v1" ||
    !isSha256(input.transactionDigest) ||
    !isSha256(input.revisionContentDigest)
  ) {
    throw new Error(
      "invalid Project Environment publication transaction marker",
    );
  }
  return {
    schemaVersion: 1,
    storeKind: "chronorift-project-environment-publication-transaction-v1",
    environmentId: ProjectEnvironmentIdSchema.parse(input.environmentId),
    environmentRevisionId: ProjectEnvironmentRevisionIdSchema.parse(
      input.environmentRevisionId,
    ),
    publicationOperationId: ProjectEnvironmentOperationIdSchema.parse(
      input.publicationOperationId,
    ),
    transactionDigest: input.transactionDigest,
    revisionContentDigest: input.revisionContentDigest,
  };
}

function parseQuarantineMarker(input: unknown): QuarantineMarkerV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "storeKind",
      "environmentId",
      "environmentRevisionId",
      "publicationOperationId",
      "quarantineDigest",
    ]) ||
    input.schemaVersion !== 1 ||
    input.storeKind !== "chronorift-project-environment-quarantine-v1" ||
    !isSha256(input.quarantineDigest)
  ) {
    throw new Error("invalid Project Environment quarantine marker");
  }
  return {
    schemaVersion: 1,
    storeKind: "chronorift-project-environment-quarantine-v1",
    environmentId: ProjectEnvironmentIdSchema.parse(input.environmentId),
    environmentRevisionId: ProjectEnvironmentRevisionIdSchema.parse(
      input.environmentRevisionId,
    ),
    publicationOperationId: ProjectEnvironmentOperationIdSchema.parse(
      input.publicationOperationId,
    ),
    quarantineDigest: input.quarantineDigest,
  };
}

function sameQuota(
  left: ProjectEnvironmentStoreQuotaV1,
  right: ProjectEnvironmentStoreQuotaV1,
): boolean {
  return canonicalJson(asJsonValue(left)) === canonicalJson(asJsonValue(right));
}

async function readFileAllowingTransactionLink(
  parent: DirectoryIdentity,
  path: string,
  maximumBytes: number,
): Promise<{
  readonly bytes: Buffer;
  readonly identity: FileIdentity;
  readonly links: number;
}> {
  await assertDirectoryIdentity(parent);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      (before.nlink !== 1 && before.nlink !== 2) ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > maximumBytes
    ) {
      throw new ArtifactPathSecurityError(
        path,
        "publication pointer has unsafe type, links, mode, or size",
      );
    }
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== before.nlink ||
      !sameIdentity(identityOf(opened), identityOf(before)) ||
      opened.size !== before.size
    ) {
      throw new ArtifactPathSecurityError(
        path,
        "publication pointer changed while opening",
      );
    }
    const bytes = await handle.readFile();
    return {
      bytes: Buffer.from(bytes),
      identity: identityOf(opened),
      links: opened.nlink,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ArtifactNotFoundError(path);
    }
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new ArtifactPathSecurityError(
        path,
        "publication pointer symlink rejected",
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Project-local immutable PE-A revisions plus an initial-current publication
 * transaction. Git admission and `.chronorift/.gitignore` remain CLI concerns.
 */
export class ProjectEnvironmentStoreV1 {
  public readonly namespaceRoot: string;
  public readonly environmentId: ProjectEnvironmentId;
  public readonly quota: ProjectEnvironmentStoreQuotaV1;
  private root: DirectoryIdentity | undefined;
  private revisions: DirectoryIdentity | undefined;
  private transactions: DirectoryIdentity | undefined;
  private quarantine: DirectoryIdentity | undefined;
  private publicationRecovery: DirectoryIdentity | undefined;
  private publicationOrphans: DirectoryIdentity | undefined;
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(options: ProjectEnvironmentStoreOptionsV1) {
    this.namespaceRoot = resolve(options.namespaceRoot);
    this.environmentId = ProjectEnvironmentIdSchema.parse(
      options.environmentId,
    );
    this.quota = options.quota ?? PROJECT_ENVIRONMENT_STORE_DEFAULT_QUOTA_V1;
    validateQuota(this.quota);
  }

  public async create(): Promise<void> {
    const { directory: root, created } = await createPrivateDirectory(
      this.namespaceRoot,
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
          ![
            REVISIONS,
            TRANSACTIONS,
            QUARANTINE,
            PUBLICATION_RECOVERY,
            PUBLICATION_ORPHANS,
          ].includes(name),
      )
    ) {
      throw new ArtifactPathSecurityError(
        root.path,
        "Project store must be empty or contain only an interrupted initial layout",
      );
    }
    this.revisions = (await createChildDirectory(root, REVISIONS)).directory;
    this.transactions = (
      await createChildDirectory(root, TRANSACTIONS)
    ).directory;
    this.quarantine = (await createChildDirectory(root, QUARANTINE)).directory;
    this.publicationRecovery = (
      await createChildDirectory(root, PUBLICATION_RECOVERY)
    ).directory;
    this.publicationOrphans = (
      await createChildDirectory(root, PUBLICATION_ORPHANS)
    ).directory;
    for (const directory of [
      this.revisions,
      this.transactions,
      this.quarantine,
      this.publicationRecovery,
      this.publicationOrphans,
    ]) {
      if ((await readdir(directory.path)).length !== 0) {
        throw new ArtifactPathSecurityError(
          directory.path,
          "interrupted Project store categories must be empty",
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
    const root = await canonicalDirectoryIdentity(this.namespaceRoot);
    const names = (await readdir(root.path)).sort();
    if (
      names.some((name) => !ROOT_REQUIRED.has(name) && name !== CURRENT) ||
      [...ROOT_REQUIRED].some((name) => !names.includes(name))
    ) {
      throw new ArtifactPathSecurityError(
        root.path,
        "Project Environment store layout contains missing or unexpected entries",
      );
    }
    const revisions = await canonicalDirectoryIdentity(
      join(root.path, REVISIONS),
    );
    const transactions = await canonicalDirectoryIdentity(
      join(root.path, TRANSACTIONS),
    );
    const quarantine = await canonicalDirectoryIdentity(
      join(root.path, QUARANTINE),
    );
    const publicationRecovery = await canonicalDirectoryIdentity(
      join(root.path, PUBLICATION_RECOVERY),
    );
    const publicationOrphans = await canonicalDirectoryIdentity(
      join(root.path, PUBLICATION_ORPHANS),
    );
    let marker: ProjectEnvironmentStoreMarkerV1;
    try {
      marker = parseStoreMarker(
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
      marker.environmentId !== this.environmentId ||
      marker.environmentNamespaceDigest !== this.environmentNamespaceDigest() ||
      !sameQuota(marker.quota, this.quota)
    ) {
      throw new ArtifactCorruptionError(
        join(root.path, STORE_MARKER),
        new Error("Project Environment store ownership or quota mismatch"),
      );
    }
    this.root = root;
    this.revisions = revisions;
    this.transactions = transactions;
    this.quarantine = quarantine;
    this.publicationRecovery = publicationRecovery;
    this.publicationOrphans = publicationOrphans;
    await inspectImmutablePackageCollection(
      revisions,
      "chronorift-project-environment-revision-v1",
      this.environmentId,
      this.quota,
      true,
    );
    await this.validateTransactions();
    await this.validateQuarantine();
    await this.validatePublicationRecovery();
    await this.validatePublicationOrphans();
    let recoveryCurrentIdentity: FileIdentity | undefined;
    if (names.includes(CURRENT)) {
      const current = await this.readCurrentAllowingRecoveryLink();
      await this.assertCurrentHasValidRevision(current.pointer);
      if (current.links === 2) {
        recoveryCurrentIdentity = current.identity;
        const transaction = await this.inspectTransaction(
          current.pointer.environmentRevisionId,
          current.pointer.publicationOperationId,
        );
        if (
          transaction?.stagedPointerIdentity === undefined ||
          !sameIdentity(transaction.stagedPointerIdentity, current.identity)
        ) {
          throw new ArtifactPathSecurityError(
            join(root.path, CURRENT),
            "current pointer has an unexplained hard link",
          );
        }
      }
    }
    const usage = await inspectTreeUsage(
      root,
      recoveryCurrentIdentity === undefined
        ? new Set()
        : new Set([
            `${recoveryCurrentIdentity.dev}:${recoveryCurrentIdentity.ino}`,
          ]),
    );
    if (usage.bytes > this.quota.maximumTotalBytes) {
      throw new ProjectEnvironmentStoreQuotaError(
        root.path,
        "maximumTotalBytes",
      );
    }
    if (usage.entries > this.quota.maximumEntries) {
      throw new ProjectEnvironmentStoreQuotaError(root.path, "maximumEntries");
    }
  }

  public putPublicationRecoveryAuthorityOnce(
    value: EnvironmentPublicationRecoveryAuthorityV1,
  ): Promise<void> {
    return this.enqueue(async () => {
      const authority =
        EnvironmentPublicationRecoveryAuthorityV1Schema.parse(value);
      if (authority.environmentId !== this.environmentId) {
        throw new ArtifactPathSecurityError(
          this.namespaceRoot,
          "publication recovery authority belongs to a different environment",
        );
      }
      const recovery = this.requirePublicationRecovery();
      const digest = publicationRecoveryDigest(
        this.environmentId,
        authority.operationId,
      );
      const directory = (await createChildDirectory(recovery, digest))
        .directory;
      const bytes = canonicalBytes(asJsonValue(authority));
      await assertQuotaAvailable(
        this.requireRoot(),
        this.quota,
        bytes.length,
        1,
      );
      await writeImmutableFile(directory, RECOVERY_AUTHORITY, bytes);
      await this.inspectPublicationRecoveryRecord(directory, digest);
    });
  }

  public putPublicationRecoveryResolutionOnce(
    value: EnvironmentPublicationRecoveryResolutionV1,
  ): Promise<void> {
    return this.enqueue(async () => {
      const resolution =
        EnvironmentPublicationRecoveryResolutionV1Schema.parse(value);
      if (resolution.environmentId !== this.environmentId) {
        throw new ArtifactPathSecurityError(
          this.namespaceRoot,
          "publication recovery resolution belongs to a different environment",
        );
      }
      const digest = publicationRecoveryDigest(
        this.environmentId,
        resolution.operationId,
      );
      const directory = await canonicalDirectoryIdentity(
        join(this.requirePublicationRecovery().path, digest),
      );
      const inspected = await this.inspectPublicationRecoveryRecord(
        directory,
        digest,
      );
      this.assertRecoveryResolutionBindings(inspected.authority, resolution);
      const bytes = canonicalBytes(asJsonValue(resolution));
      await assertQuotaAvailable(
        this.requireRoot(),
        this.quota,
        bytes.length,
        1,
      );
      await writeImmutableFile(directory, RECOVERY_RESOLUTION, bytes);
      await this.inspectPublicationRecoveryRecord(directory, digest);
    });
  }

  public async readPublicationRecoveryAuthority(
    operationId: ProjectEnvironmentOperationId,
  ): Promise<EnvironmentPublicationRecoveryAuthorityV1> {
    const parsed = ProjectEnvironmentOperationIdSchema.parse(operationId);
    const digest = publicationRecoveryDigest(this.environmentId, parsed);
    const directory = await canonicalDirectoryIdentity(
      join(this.requirePublicationRecovery().path, digest),
    );
    return (await this.inspectPublicationRecoveryRecord(directory, digest))
      .authority;
  }

  public async readPublicationRecoveryResolution(
    operationId: ProjectEnvironmentOperationId,
  ): Promise<EnvironmentPublicationRecoveryResolutionV1 | null> {
    const parsed = ProjectEnvironmentOperationIdSchema.parse(operationId);
    const digest = publicationRecoveryDigest(this.environmentId, parsed);
    const directory = await canonicalDirectoryIdentity(
      join(this.requirePublicationRecovery().path, digest),
    );
    return (await this.inspectPublicationRecoveryRecord(directory, digest))
      .resolution;
  }

  public async listPendingPublicationRecoveryAuthorities(): Promise<
    readonly EnvironmentPublicationRecoveryAuthorityV1[]
  > {
    const pending: EnvironmentPublicationRecoveryAuthorityV1[] = [];
    const recovery = this.requirePublicationRecovery();
    for (const digest of (await readdir(recovery.path)).sort()) {
      if (!isSha256(digest)) {
        throw new ArtifactPathSecurityError(
          join(recovery.path, digest),
          "publication recovery directory name must be a digest",
        );
      }
      const directory = await canonicalDirectoryIdentity(
        join(recovery.path, digest),
      );
      const inspected = await this.inspectPublicationRecoveryRecord(
        directory,
        digest,
      );
      if (inspected.resolution === null) pending.push(inspected.authority);
    }
    return Object.freeze(pending);
  }

  public async materializeRevisionOnce(
    revision: ProjectEnvironmentRevisionV1,
    files: readonly ProjectEnvironmentPackageFileInputV1[],
  ): Promise<ImmutablePackageSealV1> {
    const parsed = ProjectEnvironmentRevisionV1Schema.parse(revision);
    this.assertRevisionIdentity(parsed);
    if (
      parsed.contentDigest !== projectEnvironmentPackageContentDigestV1(files)
    ) {
      throw new TypeError(
        "Project Environment revision content digest does not match package bytes",
      );
    }
    return this.enqueue(() =>
      materializeImmutablePackage({
        collection: this.requireRevisions(),
        storeKind: "chronorift-project-environment-revision-v1",
        ownerId: this.environmentId,
        resourceId: parsed.environmentRevisionId,
        operationId: parsed.publicationOperationId,
        payload: parsed,
        parse: parseProjectEnvironmentRevision,
        files,
        quota: this.quota,
        storeRoot: this.requireRoot(),
      }),
    );
  }

  public async readRevision(
    revisionId: ProjectEnvironmentRevisionId,
    operationId: ProjectEnvironmentOperationId,
  ): Promise<StoredProjectEnvironmentPackageV1<ProjectEnvironmentRevisionV1>> {
    const inspected = await inspectImmutablePackage(
      this.requireRevisions(),
      "chronorift-project-environment-revision-v1",
      this.environmentId,
      ProjectEnvironmentRevisionIdSchema.parse(revisionId),
      ProjectEnvironmentOperationIdSchema.parse(operationId),
      parseProjectEnvironmentRevision,
      this.quota,
      false,
    );
    if (
      inspected.state !== "complete" ||
      inspected.payload === undefined ||
      inspected.seal === undefined
    ) {
      throw new ArtifactCorruptionError(
        this.namespaceRoot,
        new Error("Project Environment revision is incomplete"),
      );
    }
    const revision = inspected.payload;
    this.assertRevisionIdentity(revision);
    if (
      revision.environmentRevisionId !== revisionId ||
      revision.publicationOperationId !== operationId ||
      revision.contentDigest !==
        projectEnvironmentPackageContentDigestV1(inspected.files)
    ) {
      throw new ArtifactCorruptionError(
        this.namespaceRoot,
        new Error("revision manifest does not match stored package bytes"),
      );
    }
    return {
      payload: revision,
      files: inspected.files,
      payloadHash: contentHash(asJsonValue(revision)),
      packageHash: inspected.seal.packageHash,
      packageSeal: inspected.seal,
    };
  }

  public async readCurrent(): Promise<ProjectEnvironmentCurrentPointerV1 | null> {
    try {
      const current = await this.readCurrentAllowingRecoveryLink();
      if (current.links !== 1) {
        throw new ProjectEnvironmentPublicationRecoveryRequiredError(
          this.namespaceRoot,
        );
      }
      await this.assertCurrentHasValidRevision(current.pointer);
      return current.pointer;
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) return null;
      throw error;
    }
  }

  public commitInitialCurrent(
    input: CommitInitialProjectEnvironmentCurrentInputV1,
  ): Promise<ProjectEnvironmentCurrentPointerV1> {
    return this.enqueue(() => this.commitInitialCurrentUnlocked(input));
  }

  /** Durably stage the initial pointer without changing `current.json`. */
  public prepareInitialCurrent(
    input: CommitInitialProjectEnvironmentCurrentInputV1,
  ): Promise<ProjectEnvironmentCurrentPointerV1> {
    return this.enqueue(async () => {
      if (input.expectedCurrentRevisionId !== null) {
        throw new TypeError(
          "PE-A initial publication requires expected current null",
        );
      }
      const revisionId = ProjectEnvironmentRevisionIdSchema.parse(
        input.environmentRevisionId,
      );
      const operationId = ProjectEnvironmentOperationIdSchema.parse(
        input.publicationOperationId,
      );
      if (!Number.isFinite(Date.parse(input.commitRequestedAt))) {
        throw new TypeError("commitRequestedAt must be an ISO timestamp");
      }
      const stored = await this.readRevision(revisionId, operationId);
      const pointer = currentPointer(
        this.environmentId,
        stored.payload,
        input.commitRequestedAt,
      );
      const existing = await this.readCurrentIfPresent();
      if (existing !== undefined) {
        if (!this.samePointerTarget(existing.pointer, pointer)) {
          throw new ProjectEnvironmentCurrentConflictError(
            this.environmentId,
            null,
            existing.pointer.environmentRevisionId,
          );
        }
        return existing.pointer;
      }
      await this.ensureTransaction(pointer);
      return pointer;
    });
  }

  public inspectInitialPublication(
    revisionId: ProjectEnvironmentRevisionId,
    operationId: ProjectEnvironmentOperationId,
  ): Promise<InitialProjectEnvironmentPublicationInspectionV1> {
    return this.enqueue(() =>
      this.inspectInitialPublicationUnlocked(revisionId, operationId),
    );
  }

  public reconcileInitialPublication(
    input: CommitInitialProjectEnvironmentCurrentInputV1,
  ): Promise<InitialProjectEnvironmentPublicationInspectionV1> {
    return this.enqueue(async () => {
      const before = await this.inspectInitialPublicationUnlocked(
        input.environmentRevisionId,
        input.publicationOperationId,
      );
      if (
        before.state === "absent" ||
        before.state === "revision_incomplete" ||
        before.state === "conflict"
      ) {
        return before;
      }
      await this.commitInitialCurrentUnlocked(input);
      return this.inspectInitialPublicationUnlocked(
        input.environmentRevisionId,
        input.publicationOperationId,
      );
    });
  }

  public quarantineIncompleteRevision(
    revisionId: ProjectEnvironmentRevisionId,
    operationId: ProjectEnvironmentOperationId,
  ): Promise<string> {
    return this.enqueue(async () => {
      const inspected = await this.inspectInitialPublicationUnlocked(
        revisionId,
        operationId,
      );
      if (inspected.state !== "revision_incomplete") {
        throw new TypeError(
          "only an uncommitted incomplete revision can be quarantined",
        );
      }
      const revisions = this.requireRevisions();
      const quarantine = this.requireQuarantine();
      const revisionDigest = resourceDigest(
        "chronorift-project-environment-revision-v1",
        this.environmentId,
        revisionId,
      );
      const digest = resourceDigest(
        "chronorift-project-environment-quarantine-v1",
        this.environmentId,
        `${revisionId}\0${operationId}`,
      );
      const wrapper = (await createChildDirectory(quarantine, digest))
        .directory;
      const marker: QuarantineMarkerV1 = {
        schemaVersion: 1,
        storeKind: "chronorift-project-environment-quarantine-v1",
        environmentId: this.environmentId,
        environmentRevisionId: revisionId,
        publicationOperationId: operationId,
        quarantineDigest: digest,
      };
      await writeImmutableFile(
        wrapper,
        QUARANTINE_MARKER,
        canonicalBytes(asJsonValue(marker)),
      );
      const source = join(revisions.path, revisionDigest);
      const target = join(wrapper.path, QUARANTINED_PARTIAL);
      if (!(await directoryExists(wrapper, target))) {
        try {
          await rename(source, target);
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
          if (!(await directoryExists(wrapper, target))) throw error;
        }
      }
      await syncDirectory(revisions);
      await syncDirectory(wrapper);
      await syncDirectory(quarantine);
      return digest;
    });
  }

  public async summary(): Promise<ProjectEnvironmentStoreSummaryV1> {
    const identities = await inspectImmutablePackageCollection(
      this.requireRevisions(),
      "chronorift-project-environment-revision-v1",
      this.environmentId,
      this.quota,
      true,
    );
    let completeRevisions = 0;
    let incompleteRevisions = 0;
    for (const identity of identities) {
      const inspected = await inspectImmutablePackage(
        this.requireRevisions(),
        identity.storeKind,
        identity.ownerId,
        identity.resourceId,
        identity.operationId,
        (value) => asJsonValue(value),
        this.quota,
        true,
      );
      if (inspected.state === "complete") completeRevisions += 1;
      else incompleteRevisions += 1;
    }
    const revisionDirectoryCount = (await readdir(this.requireRevisions().path))
      .length;
    incompleteRevisions += revisionDirectoryCount - identities.length;
    const usage = await inspectTreeUsage(this.requireRoot());
    let current: ProjectEnvironmentCurrentPointerV1 | null = null;
    try {
      current = (await this.readCurrentAllowingRecoveryLink()).pointer;
    } catch (error) {
      if (!(error instanceof ArtifactNotFoundError)) throw error;
    }
    let pendingPublicationRecoveries = 0;
    let resolvedPublicationRecoveries = 0;
    for (const digest of (
      await readdir(this.requirePublicationRecovery().path)
    ).sort()) {
      const inspected = await this.inspectPublicationRecoveryRecord(
        await canonicalDirectoryIdentity(
          join(this.requirePublicationRecovery().path, digest),
        ),
        digest,
      );
      if (inspected.resolution === null) pendingPublicationRecoveries += 1;
      else resolvedPublicationRecoveries += 1;
    }
    return {
      schemaVersion: 1,
      environmentId: this.environmentId,
      completeRevisions,
      incompleteRevisions,
      transactions: (await readdir(this.requireTransactions().path)).length,
      quarantinedRevisions: (await readdir(this.requireQuarantine().path))
        .length,
      pendingPublicationRecoveries,
      resolvedPublicationRecoveries,
      interruptedPublicationRecords: (
        await readdir(this.requirePublicationOrphans().path)
      ).length,
      current,
      bytes: usage.bytes,
      entries: usage.entries,
    };
  }

  private async commitInitialCurrentUnlocked(
    input: CommitInitialProjectEnvironmentCurrentInputV1,
  ): Promise<ProjectEnvironmentCurrentPointerV1> {
    if (input.expectedCurrentRevisionId !== null) {
      throw new TypeError(
        "PE-A initial publication requires expected current null",
      );
    }
    const revisionId = ProjectEnvironmentRevisionIdSchema.parse(
      input.environmentRevisionId,
    );
    const operationId = ProjectEnvironmentOperationIdSchema.parse(
      input.publicationOperationId,
    );
    if (!Number.isFinite(Date.parse(input.commitRequestedAt))) {
      throw new TypeError("commitRequestedAt must be an ISO timestamp");
    }
    const stored = await this.readRevision(revisionId, operationId);
    const pointer = currentPointer(
      this.environmentId,
      stored.payload,
      input.commitRequestedAt,
    );
    let current:
      | Awaited<ReturnType<typeof this.readCurrentAllowingRecoveryLink>>
      | undefined;
    try {
      current = await this.readCurrentAllowingRecoveryLink();
    } catch (error) {
      if (!(error instanceof ArtifactNotFoundError)) throw error;
    }
    if (current !== undefined) {
      if (!this.samePointerTarget(current.pointer, pointer)) {
        throw new ProjectEnvironmentCurrentConflictError(
          this.environmentId,
          null,
          current.pointer.environmentRevisionId,
        );
      }
      if (current.links === 2) {
        const transaction = await this.inspectTransaction(
          revisionId,
          operationId,
        );
        if (transaction === undefined) {
          throw new ArtifactPathSecurityError(
            join(this.requireRoot().path, CURRENT),
            "committed current pointer has no matching transaction",
          );
        }
        await this.finishTransactionLink(transaction, current.identity);
      }
      return current.pointer;
    }
    const transaction = await this.ensureTransaction(pointer);
    const staged = await readFileAllowingTransactionLink(
      transaction.directory,
      transaction.stagedPointerPath,
      this.quota.maximumCanonicalJsonBytes,
    );
    if (staged.links !== 1) {
      throw new ArtifactPathSecurityError(
        transaction.stagedPointerPath,
        "staged pointer has an unexplained hard link before commit",
      );
    }
    const currentPath = join(this.requireRoot().path, CURRENT);
    try {
      await link(transaction.stagedPointerPath, currentPath);
      await syncDirectory(this.requireRoot());
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const observed = await this.readCurrentAllowingRecoveryLink();
      if (!this.samePointerTarget(observed.pointer, pointer)) {
        throw new ProjectEnvironmentCurrentConflictError(
          this.environmentId,
          null,
          observed.pointer.environmentRevisionId,
        );
      }
    }
    const committed = await this.readCurrentAllowingRecoveryLink();
    if (!sameIdentity(committed.identity, staged.identity)) {
      throw new ArtifactPathSecurityError(
        currentPath,
        "committed pointer does not match its durable transaction inode",
      );
    }
    await this.finishTransactionLink(transaction, committed.identity);
    return pointer;
  }

  private async inspectInitialPublicationUnlocked(
    revisionIdInput: ProjectEnvironmentRevisionId,
    operationIdInput: ProjectEnvironmentOperationId,
  ): Promise<InitialProjectEnvironmentPublicationInspectionV1> {
    const revisionId =
      ProjectEnvironmentRevisionIdSchema.parse(revisionIdInput);
    const operationId =
      ProjectEnvironmentOperationIdSchema.parse(operationIdInput);
    let current: ProjectEnvironmentCurrentPointerV1 | null = null;
    let currentLinks = 0;
    try {
      const read = await this.readCurrentAllowingRecoveryLink();
      current = read.pointer;
      currentLinks = read.links;
    } catch (error) {
      if (!(error instanceof ArtifactNotFoundError)) throw error;
    }
    if (
      current !== null &&
      (current.environmentRevisionId !== revisionId ||
        current.publicationOperationId !== operationId)
    ) {
      return this.inspection("conflict", revisionId, operationId, current);
    }
    const revisionDigest = resourceDigest(
      "chronorift-project-environment-revision-v1",
      this.environmentId,
      revisionId,
    );
    if (
      !(await directoryExists(
        this.requireRevisions(),
        join(this.requireRevisions().path, revisionDigest),
      ))
    ) {
      return this.inspection("absent", revisionId, operationId, current);
    }
    const revision = await inspectImmutablePackage(
      this.requireRevisions(),
      "chronorift-project-environment-revision-v1",
      this.environmentId,
      revisionId,
      operationId,
      parseProjectEnvironmentRevision,
      this.quota,
      true,
    );
    if (revision.state === "incomplete") {
      if (current !== null) {
        throw new ArtifactCorruptionError(
          join(this.requireRoot().path, CURRENT),
          new Error("current points to an incomplete revision"),
        );
      }
      return this.inspection(
        "revision_incomplete",
        revisionId,
        operationId,
        null,
      );
    }
    if (current !== null) {
      if (currentLinks === 2) {
        const transaction = await this.inspectTransaction(
          revisionId,
          operationId,
        );
        if (
          transaction === undefined ||
          transaction.stagedPointerIdentity === undefined ||
          !(await this.currentAndTransactionShareInode(transaction))
        ) {
          throw new ArtifactPathSecurityError(
            join(this.requireRoot().path, CURRENT),
            "current hard link is not explained by its publication transaction",
          );
        }
      }
      return this.inspection("committed", revisionId, operationId, current);
    }
    const transaction = await this.inspectTransaction(revisionId, operationId);
    return this.inspection(
      transaction?.stagedPointerIdentity === undefined
        ? "revision_materialized"
        : "pointer_prepared",
      revisionId,
      operationId,
      null,
    );
  }

  private inspection(
    state: InitialProjectEnvironmentPublicationInspectionV1["state"],
    revisionId: ProjectEnvironmentRevisionId,
    operationId: ProjectEnvironmentOperationId,
    current: ProjectEnvironmentCurrentPointerV1 | null,
  ): InitialProjectEnvironmentPublicationInspectionV1 {
    return {
      schemaVersion: 1,
      state,
      environmentId: this.environmentId,
      environmentRevisionId: revisionId,
      publicationOperationId: operationId,
      current,
    };
  }

  private async ensureTransaction(
    pointer: ProjectEnvironmentCurrentPointerV1,
  ): Promise<PublicationTransactionInspection> {
    const transactions = this.requireTransactions();
    const digest = transactionDigest(
      this.environmentId,
      pointer.environmentRevisionId,
      pointer.publicationOperationId,
    );
    const directory = (await createChildDirectory(transactions, digest))
      .directory;
    const marker: PublicationTransactionMarkerV1 = {
      schemaVersion: 1,
      storeKind: "chronorift-project-environment-publication-transaction-v1",
      environmentId: this.environmentId,
      environmentRevisionId: pointer.environmentRevisionId,
      publicationOperationId: pointer.publicationOperationId,
      transactionDigest: digest,
      revisionContentDigest: pointer.revisionContentDigest,
    };
    await assertQuotaAvailable(
      this.requireRoot(),
      this.quota,
      canonicalBytes(asJsonValue(marker)).byteLength +
        canonicalBytes(asJsonValue(pointer)).byteLength,
      2,
    );
    await writeImmutableFile(
      directory,
      TRANSACTION_MARKER,
      canonicalBytes(asJsonValue(marker)),
    );
    try {
      await writeImmutableFile(
        directory,
        STAGED_POINTER,
        canonicalBytes(asJsonValue(pointer)),
      );
    } catch (error) {
      if (!(error instanceof ImmutableArtifactConflictError)) throw error;
      throw error;
    }
    return (await this.inspectTransaction(
      pointer.environmentRevisionId,
      pointer.publicationOperationId,
    ))!;
  }

  private async inspectTransaction(
    revisionId: ProjectEnvironmentRevisionId,
    operationId: ProjectEnvironmentOperationId,
  ): Promise<PublicationTransactionInspection | undefined> {
    const transactions = this.requireTransactions();
    const digest = transactionDigest(
      this.environmentId,
      revisionId,
      operationId,
    );
    const path = join(transactions.path, digest);
    if (!(await directoryExists(transactions, path))) return undefined;
    const directory = await canonicalDirectoryIdentity(path);
    const names = (await readdir(directory.path)).sort();
    if (
      names.some(
        (name) => name !== TRANSACTION_MARKER && name !== STAGED_POINTER,
      ) ||
      !names.includes(TRANSACTION_MARKER)
    ) {
      throw new ArtifactPathSecurityError(
        directory.path,
        "publication transaction has an invalid layout",
      );
    }
    let marker: PublicationTransactionMarkerV1;
    try {
      marker = parseTransactionMarker(
        await readCanonicalJson(
          directory,
          join(directory.path, TRANSACTION_MARKER),
          this.quota.maximumCanonicalJsonBytes,
        ),
      );
    } catch (error) {
      if (error instanceof ArtifactCorruptionError) throw error;
      throw new ArtifactCorruptionError(
        join(directory.path, TRANSACTION_MARKER),
        error,
      );
    }
    if (
      marker.environmentId !== this.environmentId ||
      marker.environmentRevisionId !== revisionId ||
      marker.publicationOperationId !== operationId ||
      marker.transactionDigest !== digest
    ) {
      throw new ArtifactCorruptionError(
        join(directory.path, TRANSACTION_MARKER),
        new Error("publication transaction marker identity mismatch"),
      );
    }
    const stagedPointerPath = join(directory.path, STAGED_POINTER);
    let stagedPointerIdentity: FileIdentity | undefined;
    if (names.includes(STAGED_POINTER)) {
      const staged = await readFileAllowingTransactionLink(
        directory,
        stagedPointerPath,
        this.quota.maximumCanonicalJsonBytes,
      );
      let pointer: ProjectEnvironmentCurrentPointerV1;
      try {
        pointer = parseCurrentPointer(
          JSON.parse(staged.bytes.toString("utf8").trimEnd()) as unknown,
        );
      } catch (error) {
        throw new ArtifactCorruptionError(stagedPointerPath, error);
      }
      if (
        pointer.environmentId !== marker.environmentId ||
        pointer.environmentRevisionId !== marker.environmentRevisionId ||
        pointer.publicationOperationId !== marker.publicationOperationId ||
        pointer.revisionContentDigest !== marker.revisionContentDigest ||
        !canonicalBytes(asJsonValue(pointer)).equals(staged.bytes)
      ) {
        throw new ArtifactCorruptionError(
          stagedPointerPath,
          new Error("staged pointer does not match transaction marker"),
        );
      }
      stagedPointerIdentity = staged.identity;
    }
    return { directory, marker, stagedPointerPath, stagedPointerIdentity };
  }

  private async finishTransactionLink(
    transaction: PublicationTransactionInspection,
    currentIdentity: FileIdentity,
  ): Promise<void> {
    if (transaction.stagedPointerIdentity === undefined) return;
    if (!sameIdentity(transaction.stagedPointerIdentity, currentIdentity)) {
      throw new ArtifactPathSecurityError(
        transaction.stagedPointerPath,
        "staged and current pointers do not share the committed inode",
      );
    }
    const status = await lstat(transaction.stagedPointerPath);
    if (
      status.isSymbolicLink() ||
      !status.isFile() ||
      status.nlink !== 2 ||
      !sameIdentity(identityOf(status), currentIdentity)
    ) {
      throw new ArtifactPathSecurityError(
        transaction.stagedPointerPath,
        "publication transaction link changed before cleanup",
      );
    }
    await unlink(transaction.stagedPointerPath);
    await syncDirectory(transaction.directory);
    const current = await this.readCurrentAllowingRecoveryLink();
    if (
      current.links !== 1 ||
      !sameIdentity(current.identity, currentIdentity)
    ) {
      throw new ArtifactPathSecurityError(
        join(this.requireRoot().path, CURRENT),
        "current pointer did not become singly linked after commit cleanup",
      );
    }
  }

  private async readCurrentAllowingRecoveryLink(): Promise<{
    readonly pointer: ProjectEnvironmentCurrentPointerV1;
    readonly identity: FileIdentity;
    readonly links: number;
  }> {
    const path = join(this.requireRoot().path, CURRENT);
    const read = await readFileAllowingTransactionLink(
      this.requireRoot(),
      path,
      this.quota.maximumCanonicalJsonBytes,
    );
    try {
      const text = read.bytes.toString("utf8");
      if (!text.endsWith("\n")) {
        throw new Error("current pointer is missing its canonical newline");
      }
      const pointer = parseCurrentPointer(
        JSON.parse(text.slice(0, -1)) as unknown,
      );
      if (!canonicalBytes(asJsonValue(pointer)).equals(read.bytes)) {
        throw new Error("current pointer is not canonical JSON");
      }
      if (pointer.environmentId !== this.environmentId) {
        throw new Error("current pointer belongs to a different environment");
      }
      return { pointer, identity: read.identity, links: read.links };
    } catch (error) {
      throw new ArtifactCorruptionError(path, error);
    }
  }

  private async readCurrentIfPresent(): Promise<
    | Awaited<
        ReturnType<ProjectEnvironmentStoreV1["readCurrentAllowingRecoveryLink"]>
      >
    | undefined
  > {
    try {
      return await this.readCurrentAllowingRecoveryLink();
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) return undefined;
      throw error;
    }
  }

  private async assertCurrentHasValidRevision(
    pointer: ProjectEnvironmentCurrentPointerV1,
  ): Promise<void> {
    const revision = await this.readRevision(
      pointer.environmentRevisionId,
      pointer.publicationOperationId,
    );
    if (revision.payload.contentDigest !== pointer.revisionContentDigest) {
      throw new ArtifactCorruptionError(
        join(this.requireRoot().path, CURRENT),
        new Error("current pointer content digest does not match its revision"),
      );
    }
  }

  private samePointerTarget(
    left: ProjectEnvironmentCurrentPointerV1,
    right: ProjectEnvironmentCurrentPointerV1,
  ): boolean {
    return (
      left.environmentId === right.environmentId &&
      left.environmentRevisionId === right.environmentRevisionId &&
      left.publicationOperationId === right.publicationOperationId &&
      left.revisionContentDigest === right.revisionContentDigest
    );
  }

  private async currentAndTransactionShareInode(
    transaction: PublicationTransactionInspection,
  ): Promise<boolean> {
    if (transaction.stagedPointerIdentity === undefined) return false;
    const current = await this.readCurrentAllowingRecoveryLink();
    return sameIdentity(current.identity, transaction.stagedPointerIdentity);
  }

  private async inspectPublicationRecoveryRecord(
    directory: DirectoryIdentity,
    digest: string,
  ): Promise<PublicationRecoveryRecordInspectionV1> {
    const names = (await readdir(directory.path)).sort();
    if (
      names.some(
        (name) => name !== RECOVERY_AUTHORITY && name !== RECOVERY_RESOLUTION,
      ) ||
      !names.includes(RECOVERY_AUTHORITY)
    ) {
      throw new ArtifactPathSecurityError(
        directory.path,
        "publication recovery record has an invalid layout",
      );
    }
    let authority: EnvironmentPublicationRecoveryAuthorityV1;
    try {
      authority = EnvironmentPublicationRecoveryAuthorityV1Schema.parse(
        await readCanonicalJson(
          directory,
          join(directory.path, RECOVERY_AUTHORITY),
          this.quota.maximumCanonicalJsonBytes,
        ),
      );
    } catch (error) {
      if (error instanceof ArtifactCorruptionError) throw error;
      throw new ArtifactCorruptionError(
        join(directory.path, RECOVERY_AUTHORITY),
        error,
      );
    }
    if (
      authority.environmentId !== this.environmentId ||
      publicationRecoveryDigest(
        authority.environmentId,
        authority.operationId,
      ) !== digest
    ) {
      throw new ArtifactCorruptionError(
        join(directory.path, RECOVERY_AUTHORITY),
        new Error("publication recovery authority identity mismatch"),
      );
    }
    let resolution: EnvironmentPublicationRecoveryResolutionV1 | null = null;
    if (names.includes(RECOVERY_RESOLUTION)) {
      try {
        resolution = EnvironmentPublicationRecoveryResolutionV1Schema.parse(
          await readCanonicalJson(
            directory,
            join(directory.path, RECOVERY_RESOLUTION),
            this.quota.maximumCanonicalJsonBytes,
          ),
        );
        this.assertRecoveryResolutionBindings(authority, resolution);
      } catch (error) {
        if (error instanceof ArtifactCorruptionError) throw error;
        throw new ArtifactCorruptionError(
          join(directory.path, RECOVERY_RESOLUTION),
          error,
        );
      }
    }
    await assertDirectoryIdentity(directory);
    return { directory, authority, resolution };
  }

  private assertRecoveryResolutionBindings(
    authority: EnvironmentPublicationRecoveryAuthorityV1,
    resolution: EnvironmentPublicationRecoveryResolutionV1,
  ): void {
    if (
      resolution.operationId !== authority.operationId ||
      resolution.taskId !== authority.taskId ||
      resolution.attemptId !== authority.attemptId ||
      resolution.environmentId !== authority.environmentId ||
      resolution.targetEnvironmentRevisionId !==
        authority.targetEnvironmentRevisionId ||
      (resolution.bindingEpochId !== null &&
        resolution.bindingEpochId !== authority.bindingEpochId)
    ) {
      throw new Error(
        "publication recovery resolution crossed its durable authority binding",
      );
    }
  }

  private async assertInterruptedStageFile(
    path: string,
    expectedLinks: 1 | 2 = 1,
  ): Promise<FileIdentity> {
    const status = await lstat(path);
    if (
      status.isSymbolicLink() ||
      !status.isFile() ||
      status.nlink !== expectedLinks ||
      (status.mode & 0o777) !== 0o600
    ) {
      throw new ArtifactPathSecurityError(
        path,
        "interrupted immutable stage must be a private regular file with explained links",
      );
    }
    if (status.size > this.quota.maximumCanonicalJsonBytes) {
      throw new ArtifactCorruptionError(
        path,
        new Error("interrupted immutable stage exceeds its byte limit"),
      );
    }
    return identityOf(status);
  }

  private async quarantineInterruptedRecordDirectory(
    collection: DirectoryIdentity,
    directory: DirectoryIdentity,
    kind: "authority" | "transaction",
    digest: string,
    names: readonly string[],
  ): Promise<void> {
    if (names.some((name) => !IMMUTABLE_STAGE_PATTERN.test(name))) {
      throw new ArtifactPathSecurityError(
        directory.path,
        "interrupted publication record contains unexplained bytes",
      );
    }
    for (const name of names) {
      await this.assertInterruptedStageFile(join(directory.path, name));
    }
    await assertDirectoryIdentity(directory);
    await assertDirectoryIdentity(collection);
    const orphans = this.requirePublicationOrphans();
    await assertDirectoryIdentity(orphans);
    const orphanName = `${kind}.${digest}.${randomUUID()}.record`;
    const target = join(orphans.path, orphanName);
    try {
      await lstat(target);
      throw new ArtifactPathSecurityError(
        target,
        "interrupted publication quarantine target already exists",
      );
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    await rename(directory.path, target);
    await syncDirectory(collection);
    await syncDirectory(orphans);
    const quarantined = await canonicalDirectoryIdentity(target);
    if (!sameIdentity(quarantined.identity, directory.identity)) {
      throw new ArtifactPathSecurityError(
        target,
        "interrupted publication directory identity changed during quarantine",
      );
    }
  }

  private async quarantineOrCleanInterruptedStages(
    directory: DirectoryIdentity,
    kind: "authority" | "transaction",
    digest: string,
    publishedNames: readonly string[],
    names: readonly string[],
  ): Promise<void> {
    for (const name of names.filter((entry) =>
      IMMUTABLE_STAGE_PATTERN.test(entry),
    )) {
      const path = join(directory.path, name);
      const status = await lstat(path);
      if (status.nlink === 2) {
        const stagedIdentity = await this.assertInterruptedStageFile(path, 2);
        let duplicate = false;
        for (const publishedName of publishedNames) {
          try {
            const published = await lstat(join(directory.path, publishedName));
            if (
              published.isFile() &&
              !published.isSymbolicLink() &&
              published.nlink === 2 &&
              (published.mode & 0o777) === 0o600 &&
              sameIdentity(identityOf(published), stagedIdentity)
            ) {
              duplicate = true;
              break;
            }
          } catch (error) {
            if (!isNodeError(error) || error.code !== "ENOENT") throw error;
          }
        }
        if (!duplicate) {
          throw new ArtifactPathSecurityError(
            path,
            "interrupted immutable stage hard link is unexplained",
          );
        }
        await unlink(path);
        await syncDirectory(directory);
        continue;
      }
      await this.assertInterruptedStageFile(path);
      const orphans = this.requirePublicationOrphans();
      const target = join(
        orphans.path,
        `${kind}.${digest}.${randomUUID()}.tmp`,
      );
      await assertDirectoryIdentity(directory);
      await assertDirectoryIdentity(orphans);
      await rename(path, target);
      await syncDirectory(directory);
      await syncDirectory(orphans);
      await this.assertInterruptedStageFile(target);
    }
  }

  private async validatePublicationRecovery(): Promise<void> {
    const recovery = this.requirePublicationRecovery();
    for (const digest of (await readdir(recovery.path)).sort()) {
      if (!isSha256(digest)) {
        throw new ArtifactPathSecurityError(
          join(recovery.path, digest),
          "publication recovery directory name must be a digest",
        );
      }
      const directory = await canonicalDirectoryIdentity(
        join(recovery.path, digest),
      );
      const names = (await readdir(directory.path)).sort();
      if (!names.includes(RECOVERY_AUTHORITY)) {
        await this.quarantineInterruptedRecordDirectory(
          recovery,
          directory,
          "authority",
          digest,
          names,
        );
        continue;
      }
      if (
        names.some(
          (name) =>
            name !== RECOVERY_AUTHORITY &&
            name !== RECOVERY_RESOLUTION &&
            !IMMUTABLE_STAGE_PATTERN.test(name),
        )
      ) {
        throw new ArtifactPathSecurityError(
          directory.path,
          "publication recovery record contains an unexpected entry",
        );
      }
      await this.quarantineOrCleanInterruptedStages(
        directory,
        "authority",
        digest,
        [RECOVERY_AUTHORITY, RECOVERY_RESOLUTION],
        names,
      );
      await this.inspectPublicationRecoveryRecord(directory, digest);
    }
  }

  private async validateTransactions(): Promise<void> {
    const transactions = this.requireTransactions();
    for (const name of (await readdir(transactions.path)).sort()) {
      if (!isSha256(name)) {
        throw new ArtifactPathSecurityError(
          join(transactions.path, name),
          "transaction directory name must be a digest",
        );
      }
      const directory = await canonicalDirectoryIdentity(
        join(transactions.path, name),
      );
      const names = (await readdir(directory.path)).sort();
      if (!names.includes(TRANSACTION_MARKER)) {
        await this.quarantineInterruptedRecordDirectory(
          transactions,
          directory,
          "transaction",
          name,
          names,
        );
        continue;
      }
      if (
        names.some(
          (entry) =>
            entry !== TRANSACTION_MARKER &&
            entry !== STAGED_POINTER &&
            !IMMUTABLE_STAGE_PATTERN.test(entry),
        )
      ) {
        throw new ArtifactPathSecurityError(
          directory.path,
          "publication transaction contains an unexpected entry",
        );
      }
      await this.quarantineOrCleanInterruptedStages(
        directory,
        "transaction",
        name,
        [TRANSACTION_MARKER, STAGED_POINTER],
        names,
      );
      let marker: PublicationTransactionMarkerV1;
      try {
        marker = parseTransactionMarker(
          await readCanonicalJson(
            directory,
            join(directory.path, TRANSACTION_MARKER),
            this.quota.maximumCanonicalJsonBytes,
          ),
        );
      } catch (error) {
        if (error instanceof ArtifactCorruptionError) throw error;
        throw new ArtifactCorruptionError(
          join(directory.path, TRANSACTION_MARKER),
          error,
        );
      }
      if (
        marker.transactionDigest !== name ||
        marker.environmentId !== this.environmentId ||
        marker.transactionDigest !==
          transactionDigest(
            marker.environmentId,
            marker.environmentRevisionId,
            marker.publicationOperationId,
          )
      ) {
        throw new ArtifactCorruptionError(
          join(directory.path, TRANSACTION_MARKER),
          new Error("transaction marker does not match its directory"),
        );
      }
      await this.inspectTransaction(
        marker.environmentRevisionId,
        marker.publicationOperationId,
      );
    }
  }

  private async validatePublicationOrphans(): Promise<void> {
    const orphans = this.requirePublicationOrphans();
    for (const name of (await readdir(orphans.path)).sort()) {
      const path = join(orphans.path, name);
      if (!INTERRUPTED_RECORD_PATTERN.test(name)) {
        throw new ArtifactPathSecurityError(
          path,
          "unexpected interrupted publication quarantine entry",
        );
      }
      if (name.endsWith(".tmp")) {
        await this.assertInterruptedStageFile(path);
        continue;
      }
      const directory = await canonicalDirectoryIdentity(path);
      const names = (await readdir(directory.path)).sort();
      if (names.some((entry) => !IMMUTABLE_STAGE_PATTERN.test(entry))) {
        throw new ArtifactPathSecurityError(
          path,
          "interrupted publication quarantine contains unexplained bytes",
        );
      }
      for (const entry of names) {
        await this.assertInterruptedStageFile(join(path, entry));
      }
      await assertDirectoryIdentity(directory);
    }
    await assertDirectoryIdentity(orphans);
  }

  private async validateQuarantine(): Promise<void> {
    const quarantine = this.requireQuarantine();
    for (const name of (await readdir(quarantine.path)).sort()) {
      if (!isSha256(name)) {
        throw new ArtifactPathSecurityError(
          join(quarantine.path, name),
          "quarantine directory name must be a digest",
        );
      }
      const directory = await canonicalDirectoryIdentity(
        join(quarantine.path, name),
      );
      const names = (await readdir(directory.path)).sort();
      if (
        names.some(
          (entry) =>
            entry !== QUARANTINE_MARKER && entry !== QUARANTINED_PARTIAL,
        ) ||
        !names.includes(QUARANTINE_MARKER)
      ) {
        throw new ArtifactPathSecurityError(
          directory.path,
          "quarantine entry has an invalid layout",
        );
      }
      let marker: QuarantineMarkerV1;
      try {
        marker = parseQuarantineMarker(
          await readCanonicalJson(
            directory,
            join(directory.path, QUARANTINE_MARKER),
            this.quota.maximumCanonicalJsonBytes,
          ),
        );
      } catch (error) {
        if (error instanceof ArtifactCorruptionError) throw error;
        throw new ArtifactCorruptionError(
          join(directory.path, QUARANTINE_MARKER),
          error,
        );
      }
      if (
        marker.environmentId !== this.environmentId ||
        marker.quarantineDigest !== name ||
        marker.quarantineDigest !==
          resourceDigest(
            "chronorift-project-environment-quarantine-v1",
            marker.environmentId,
            `${marker.environmentRevisionId}\0${marker.publicationOperationId}`,
          )
      ) {
        throw new ArtifactCorruptionError(
          join(directory.path, QUARANTINE_MARKER),
          new Error("quarantine marker does not match its directory"),
        );
      }
      if (names.includes(QUARANTINED_PARTIAL)) {
        const partial = await canonicalDirectoryIdentity(
          join(directory.path, QUARANTINED_PARTIAL),
        );
        await inspectTreeUsage(partial);
      }
    }
  }

  private assertRevisionIdentity(revision: ProjectEnvironmentRevisionV1): void {
    if (revision.environmentId !== this.environmentId) {
      throw new ArtifactPathSecurityError(
        this.namespaceRoot,
        "revision belongs to a different Project Environment",
      );
    }
  }

  private marker(): ProjectEnvironmentStoreMarkerV1 {
    return {
      schemaVersion: 1,
      storeKind: "chronorift-project-environment-store-v1",
      environmentId: this.environmentId,
      environmentNamespaceDigest: this.environmentNamespaceDigest(),
      quota: this.quota,
    };
  }

  private environmentNamespaceDigest(): string {
    return resourceDigest(
      "chronorift-project-environment-store-v1",
      this.environmentId,
      "project",
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requireRoot(): DirectoryIdentity {
    if (this.root === undefined)
      throw new ArtifactNotFoundError(this.namespaceRoot);
    return this.root;
  }

  private requireRevisions(): DirectoryIdentity {
    if (this.revisions === undefined) {
      throw new ArtifactNotFoundError(join(this.namespaceRoot, REVISIONS));
    }
    return this.revisions;
  }

  private requireTransactions(): DirectoryIdentity {
    if (this.transactions === undefined) {
      throw new ArtifactNotFoundError(join(this.namespaceRoot, TRANSACTIONS));
    }
    return this.transactions;
  }

  private requireQuarantine(): DirectoryIdentity {
    if (this.quarantine === undefined) {
      throw new ArtifactNotFoundError(join(this.namespaceRoot, QUARANTINE));
    }
    return this.quarantine;
  }

  private requirePublicationRecovery(): DirectoryIdentity {
    if (this.publicationRecovery === undefined) {
      throw new ArtifactNotFoundError(
        join(this.namespaceRoot, PUBLICATION_RECOVERY),
      );
    }
    return this.publicationRecovery;
  }

  private requirePublicationOrphans(): DirectoryIdentity {
    if (this.publicationOrphans === undefined) {
      throw new ArtifactNotFoundError(
        join(this.namespaceRoot, PUBLICATION_ORPHANS),
      );
    }
    return this.publicationOrphans;
  }
}

export {
  type ImmutablePackageSealV1,
  type ProjectEnvironmentPackageFileInputV1,
  type ProjectEnvironmentStoreQuotaV1,
  type StoredProjectEnvironmentPackageV1,
} from "./project-environment-store-internals.js";
