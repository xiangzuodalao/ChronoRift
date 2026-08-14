import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";

import { JsonValueSchema, type JsonValue } from "@chronorift/domain";

import { canonicalJson, contentHash } from "./canonical-json.js";
import {
  ArtifactCorruptionError,
  ArtifactNotFoundError,
} from "./json-artifact-repository.js";
import {
  ArtifactPathSecurityError,
  ImmutableArtifactConflictError,
} from "./v01-json-artifact-repository.js";

export interface ProjectEnvironmentStoreQuotaV1 {
  readonly maximumTotalBytes: number;
  readonly maximumEntries: number;
  readonly maximumCanonicalJsonBytes: number;
  readonly maximumPackageBytes: number;
  readonly maximumPackageFiles: number;
}

export interface ProjectEnvironmentPackageFileInputV1 {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ProjectEnvironmentPackageFileManifestV1 {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface StoredProjectEnvironmentPackageV1<T> {
  readonly payload: T;
  readonly files: readonly ProjectEnvironmentPackageFileInputV1[];
  readonly payloadHash: string;
  readonly packageHash: string;
  readonly packageSeal: ImmutablePackageSealV1;
}

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface DirectoryIdentity {
  readonly path: string;
  readonly identity: FileIdentity;
}

export interface TreeUsage {
  readonly bytes: number;
  readonly entries: number;
}

export interface ProjectEnvironmentLedgerEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly sequence: number;
  readonly previousRecordHash: string | null;
  readonly payload: JsonValue;
  readonly recordHash: string;
}

export interface ProjectEnvironmentLedgerSealV1 {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly recordCount: number;
  readonly finalRecordHash: string | null;
  readonly ledgerByteLength: number;
  readonly ledgerSha256: string;
}

export type ImmutablePackageStoreKind =
  | "chronorift-project-adapter-candidate-v1"
  | "chronorift-project-environment-pinned-capture-v1"
  | "chronorift-project-environment-revision-v1";

interface ImmutablePackageMarkerV1 {
  readonly schemaVersion: 1;
  readonly storeKind: ImmutablePackageStoreKind;
  readonly ownerId: string;
  readonly resourceId: string;
  readonly resourceDigest: string;
  readonly operationId: string | null;
}

interface ImmutablePackageEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly resourceId: string;
  readonly payload: JsonValue;
  readonly payloadHash: string;
  readonly recordHash: string;
}

export interface ImmutablePackageSealV1 {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly resourceId: string;
  readonly operationId: string | null;
  readonly recordHash: string;
  readonly files: readonly ProjectEnvironmentPackageFileManifestV1[];
  readonly packageByteLength: number;
  readonly packageHash: string;
}

export interface ImmutablePackageInspection<T> {
  readonly state: "complete" | "incomplete";
  readonly payload: T | undefined;
  readonly files: readonly ProjectEnvironmentPackageFileInputV1[];
  readonly seal: ImmutablePackageSealV1 | undefined;
}

export interface ImmutablePackageIdentityV1 {
  readonly storeKind: ImmutablePackageStoreKind;
  readonly ownerId: string;
  readonly resourceId: string;
  readonly resourceDigest: string;
  readonly operationId: string | null;
}

export interface MaterializeImmutablePackageInput<T> {
  readonly collection: DirectoryIdentity;
  readonly storeKind: ImmutablePackageStoreKind;
  readonly ownerId: string;
  readonly resourceId: string;
  readonly operationId: string | null;
  readonly payload: T;
  readonly parse: (input: unknown) => T;
  readonly files: readonly ProjectEnvironmentPackageFileInputV1[];
  readonly quota: ProjectEnvironmentStoreQuotaV1;
  readonly storeRoot: DirectoryIdentity;
}

const PACKAGE_MARKER = ".chronorift-project-environment-package-v1.json";
const PACKAGE_RECORD = "record.json";
const PACKAGE_FILES = "files";
const PACKAGE_SEAL = "complete.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ENTRY_PATTERN = /^(?:[A-Za-z0-9]|\.[A-Za-z0-9])[A-Za-z0-9._-]*$/u;

export class ProjectEnvironmentStoreQuotaError extends Error {
  public constructor(
    readonly storePath: string,
    readonly limit: keyof ProjectEnvironmentStoreQuotaV1,
  ) {
    super(`Project Environment store quota exceeded at ${storePath}: ${limit}`);
    this.name = "ProjectEnvironmentStoreQuotaError";
  }
}

export class IncompleteProjectEnvironmentArtifactError extends Error {
  public constructor(readonly artifactPath: string) {
    super(`Project Environment artifact is incomplete: ${artifactPath}`);
    this.name = "IncompleteProjectEnvironmentArtifactError";
  }
}

export class ProjectEnvironmentLedgerSealedError extends Error {
  public constructor(readonly ledgerPath: string) {
    super(`Project Environment ledger is sealed: ${ledgerPath}`);
    this.name = "ProjectEnvironmentLedgerSealedError";
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

export function validateQuota(quota: ProjectEnvironmentStoreQuotaV1): void {
  const names: readonly (keyof ProjectEnvironmentStoreQuotaV1)[] = [
    "maximumTotalBytes",
    "maximumEntries",
    "maximumCanonicalJsonBytes",
    "maximumPackageBytes",
    "maximumPackageFiles",
  ];
  for (const name of names) {
    assertPositiveSafeInteger(quota[name], name);
  }
  if (quota.maximumCanonicalJsonBytes > quota.maximumTotalBytes) {
    throw new TypeError(
      "maximumCanonicalJsonBytes cannot exceed maximumTotalBytes",
    );
  }
  if (quota.maximumPackageBytes > quota.maximumTotalBytes) {
    throw new TypeError("maximumPackageBytes cannot exceed maximumTotalBytes");
  }
  if (quota.maximumPackageFiles > quota.maximumEntries) {
    throw new TypeError("maximumPackageFiles cannot exceed maximumEntries");
  }
}

export function identityOf(value: {
  readonly dev: number;
  readonly ino: number;
}): FileIdentity {
  return { dev: value.dev, ino: value.ino };
}

export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function resourceDigest(
  storeKind: string,
  ownerId: string,
  resourceId: string,
): string {
  return sha256(`${storeKind}\0${ownerId}\0${resourceId}`);
}

export function assertOpaqueId(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} must be a non-empty bounded opaque ID`);
  }
}

export function asJsonValue(value: unknown): JsonValue {
  return JsonValueSchema.parse(value);
}

export function canonicalBytes(value: JsonValue): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

export function parseCanonicalJsonBytes(
  path: string,
  bytes: Buffer,
): JsonValue {
  try {
    const text = bytes.toString("utf8");
    if (!text.endsWith("\n")) {
      throw new Error("canonical JSON is missing its final newline");
    }
    const parsed = asJsonValue(JSON.parse(text.slice(0, -1)) as unknown);
    if (!canonicalBytes(parsed).equals(bytes)) {
      throw new Error("stored JSON bytes are not canonical");
    }
    return parsed;
  } catch (error) {
    throw new ArtifactCorruptionError(path, error);
  }
}

export async function canonicalDirectoryIdentity(
  path: string,
  requirePrivateMode = true,
): Promise<DirectoryIdentity> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new ArtifactPathSecurityError(
      path,
      "expected a real directory, not a symbolic link",
    );
  }
  const canonical = await realpath(path);
  if (resolve(canonical) !== resolve(path)) {
    throw new ArtifactPathSecurityError(
      path,
      `canonical directory differs from its lexical path: ${canonical}`,
    );
  }
  if (requirePrivateMode && (status.mode & 0o777) !== 0o700) {
    throw new ArtifactPathSecurityError(
      path,
      "store directory mode must be exactly 0o700",
    );
  }
  return { path: resolve(path), identity: identityOf(status) };
}

export async function createPrivateDirectory(path: string): Promise<{
  readonly directory: DirectoryIdentity;
  readonly created: boolean;
}> {
  const canonicalPath = resolve(path);
  const parentPath = dirname(canonicalPath);
  const parent = await canonicalDirectoryIdentity(parentPath, false);
  let created = false;
  try {
    await mkdir(canonicalPath, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  const directory = await canonicalDirectoryIdentity(canonicalPath);
  await assertDirectoryIdentity(parent);
  if (created) await syncDirectory(parent);
  return { directory, created };
}

export async function createChildDirectory(
  parent: DirectoryIdentity,
  name: string,
): Promise<{
  readonly directory: DirectoryIdentity;
  readonly created: boolean;
}> {
  if (!SAFE_ENTRY_PATTERN.test(name)) {
    throw new ArtifactPathSecurityError(name, "unsafe child directory name");
  }
  await assertDirectoryIdentity(parent);
  const result = await createPrivateDirectory(join(parent.path, name));
  await assertDirectoryIdentity(parent);
  return result;
}

export async function assertDirectoryIdentity(
  expected: DirectoryIdentity,
): Promise<void> {
  const actual = await canonicalDirectoryIdentity(expected.path);
  if (!sameIdentity(expected.identity, actual.identity)) {
    throw new ArtifactPathSecurityError(
      expected.path,
      "directory identity changed during store operation",
    );
  }
}

export async function syncDirectory(
  directory: DirectoryIdentity,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      directory.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const status = await handle.stat();
    if (
      !status.isDirectory() ||
      !sameIdentity(identityOf(status), directory.identity)
    ) {
      throw new ArtifactPathSecurityError(
        directory.path,
        "directory identity changed before fsync",
      );
    }
    await handle.sync();
  } catch (error) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new ArtifactPathSecurityError(
        directory.path,
        "directory symlink rejected",
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function readRegularFile(
  parent: DirectoryIdentity,
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  await assertDirectoryIdentity(parent);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      throw new ArtifactPathSecurityError(
        path,
        "record must be a singly-linked regular file",
      );
    }
    if ((before.mode & 0o777) !== 0o600) {
      throw new ArtifactPathSecurityError(path, "record mode must be 0o600");
    }
    if (before.size > maximumBytes) {
      throw new ArtifactCorruptionError(
        path,
        new Error("record exceeds its byte limit"),
      );
    }
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !sameIdentity(identityOf(before), identityOf(opened)) ||
      opened.size !== before.size
    ) {
      throw new ArtifactPathSecurityError(
        path,
        "record identity changed while opening",
      );
    }
    const bytes = await handle.readFile();
    await assertDirectoryIdentity(parent);
    const after = await lstat(path);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.nlink !== 1 ||
      !sameIdentity(identityOf(after), identityOf(opened)) ||
      after.size !== opened.size ||
      bytes.byteLength !== opened.size
    ) {
      throw new ArtifactPathSecurityError(
        path,
        "record identity changed while reading",
      );
    }
    return Buffer.from(bytes);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ArtifactNotFoundError(path);
    }
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new ArtifactPathSecurityError(path, "record symlink rejected");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function readCanonicalJson(
  parent: DirectoryIdentity,
  path: string,
  maximumBytes: number,
): Promise<JsonValue> {
  return parseCanonicalJsonBytes(
    path,
    await readRegularFile(parent, path, maximumBytes),
  );
}

async function cleanupStagedFile(
  parent: DirectoryIdentity,
  path: string,
  expectedIdentity: FileIdentity,
): Promise<void> {
  try {
    const status = await lstat(path);
    if (
      status.isSymbolicLink() ||
      !status.isFile() ||
      !sameIdentity(identityOf(status), expectedIdentity)
    ) {
      throw new ArtifactPathSecurityError(
        path,
        "staged file identity changed before cleanup",
      );
    }
    await unlink(path);
    await syncDirectory(parent);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

export async function writeImmutableFile(
  parent: DirectoryIdentity,
  name: string,
  bytes: Buffer,
): Promise<void> {
  if (!SAFE_ENTRY_PATTERN.test(name)) {
    throw new ArtifactPathSecurityError(name, "unsafe immutable file name");
  }
  await assertDirectoryIdentity(parent);
  const path = join(parent.path, name);
  const temporaryPath = join(
    parent.path,
    `.chronorift-stage-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let stagedIdentity: FileIdentity | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const status = await handle.stat();
    stagedIdentity = identityOf(status);
    await handle.writeFile(bytes);
    await handle.sync();
    await assertDirectoryIdentity(parent);
    try {
      await link(temporaryPath, path);
      await syncDirectory(parent);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = await readRegularFile(parent, path, bytes.byteLength);
      if (!existing.equals(bytes)) {
        throw new ImmutableArtifactConflictError(path);
      }
    }
  } finally {
    await handle?.close();
    if (stagedIdentity !== undefined) {
      await cleanupStagedFile(parent, temporaryPath, stagedIdentity);
    }
  }
  const published = await lstat(path);
  if (
    published.isSymbolicLink() ||
    !published.isFile() ||
    published.nlink !== 1 ||
    (published.mode & 0o777) !== 0o600
  ) {
    throw new ArtifactPathSecurityError(
      path,
      "published immutable file has unsafe identity, links, or mode",
    );
  }
}

export async function writeExclusiveFile(
  parent: DirectoryIdentity,
  name: string,
  bytes: Buffer,
): Promise<void> {
  if (!SAFE_ENTRY_PATTERN.test(name)) {
    throw new ArtifactPathSecurityError(name, "unsafe package file name");
  }
  await assertDirectoryIdentity(parent);
  const path = join(parent.path, name);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const status = await handle.stat();
    if (!status.isFile() || status.nlink !== 1) {
      throw new ArtifactPathSecurityError(path, "unsafe new package file");
    }
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new ArtifactPathSecurityError(path, "package symlink rejected");
    }
    throw error;
  } finally {
    await handle?.close();
  }
  await syncDirectory(parent);
}

function assertSafePackagePath(path: string): readonly string[] {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 1024 ||
    path.includes("\\") ||
    path.includes("\0") ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    posix.normalize(path) !== path
  ) {
    throw new ArtifactPathSecurityError(path, "unsafe package-relative path");
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !SAFE_ENTRY_PATTERN.test(segment),
    )
  ) {
    throw new ArtifactPathSecurityError(path, "unsafe package path segment");
  }
  return segments;
}

function normalizedPackageFiles(
  files: readonly ProjectEnvironmentPackageFileInputV1[],
  quota: ProjectEnvironmentStoreQuotaV1,
): readonly ProjectEnvironmentPackageFileInputV1[] {
  const filesAreArray = isArrayValue(files);
  if (!filesAreArray || files.length > quota.maximumPackageFiles) {
    throw new ProjectEnvironmentStoreQuotaError(
      "<candidate-package>",
      "maximumPackageFiles",
    );
  }
  const seen = new Set<string>();
  let byteLength = 0;
  const normalized = files.map((file) => {
    assertSafePackagePath(file.path);
    if (seen.has(file.path)) {
      throw new TypeError(`duplicate package path: ${file.path}`);
    }
    seen.add(file.path);
    if (!(file.bytes instanceof Uint8Array)) {
      throw new TypeError(`package file ${file.path} must contain Uint8Array`);
    }
    const bytes = Uint8Array.from(file.bytes);
    byteLength += bytes.byteLength;
    return { path: file.path, bytes };
  });
  if (byteLength > quota.maximumPackageBytes) {
    throw new ProjectEnvironmentStoreQuotaError(
      "<candidate-package>",
      "maximumPackageBytes",
    );
  }
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

function packageManifest(
  files: readonly ProjectEnvironmentPackageFileInputV1[],
): readonly ProjectEnvironmentPackageFileManifestV1[] {
  return files.map((file) => ({
    path: file.path,
    byteLength: file.bytes.byteLength,
    sha256: sha256(file.bytes),
  }));
}

export function projectEnvironmentPackageContentDigestV1(
  files: readonly ProjectEnvironmentPackageFileInputV1[],
): string {
  const normalized = [...files]
    .map((file) => {
      assertSafePackagePath(file.path);
      if (!(file.bytes instanceof Uint8Array)) {
        throw new TypeError(
          `package file ${file.path} must contain Uint8Array`,
        );
      }
      return {
        path: file.path,
        byteLength: file.bytes.byteLength,
        sha256: sha256(file.bytes),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    normalized.some(
      (file, index) => index > 0 && normalized[index - 1]?.path === file.path,
    )
  ) {
    throw new TypeError("package paths must be unique");
  }
  return contentHash(asJsonValue({ schemaVersion: 1, files: normalized }));
}

function parsePackageMarker(input: unknown): ImmutablePackageMarkerV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "storeKind",
      "ownerId",
      "resourceId",
      "resourceDigest",
      "operationId",
    ]) ||
    input.schemaVersion !== 1 ||
    !(
      input.storeKind === "chronorift-project-adapter-candidate-v1" ||
      input.storeKind === "chronorift-project-environment-pinned-capture-v1" ||
      input.storeKind === "chronorift-project-environment-revision-v1"
    ) ||
    typeof input.ownerId !== "string" ||
    typeof input.resourceId !== "string" ||
    !isSha256(input.resourceDigest) ||
    !(input.operationId === null || typeof input.operationId === "string")
  ) {
    throw new Error("invalid Project Environment package marker");
  }
  return {
    schemaVersion: 1,
    storeKind: input.storeKind,
    ownerId: input.ownerId,
    resourceId: input.resourceId,
    resourceDigest: input.resourceDigest,
    operationId: input.operationId,
  };
}

function parsePackageEnvelope(input: unknown): ImmutablePackageEnvelopeV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "ownerId",
      "resourceId",
      "payload",
      "payloadHash",
      "recordHash",
    ]) ||
    input.schemaVersion !== 1 ||
    typeof input.ownerId !== "string" ||
    typeof input.resourceId !== "string" ||
    !isSha256(input.payloadHash) ||
    !isSha256(input.recordHash)
  ) {
    throw new Error("invalid Project Environment package envelope");
  }
  return {
    schemaVersion: 1,
    ownerId: input.ownerId,
    resourceId: input.resourceId,
    payload: asJsonValue(input.payload),
    payloadHash: input.payloadHash,
    recordHash: input.recordHash,
  };
}

function parsePackageFileManifest(
  input: unknown,
): ProjectEnvironmentPackageFileManifestV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, ["path", "byteLength", "sha256"]) ||
    typeof input.path !== "string" ||
    !isNonnegativeSafeInteger(input.byteLength) ||
    !isSha256(input.sha256)
  ) {
    throw new Error("invalid Project Environment package file manifest");
  }
  assertSafePackagePath(input.path);
  return {
    path: input.path,
    byteLength: input.byteLength,
    sha256: input.sha256,
  };
}

function parsePackageSeal(input: unknown): ImmutablePackageSealV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "ownerId",
      "resourceId",
      "operationId",
      "recordHash",
      "files",
      "packageByteLength",
      "packageHash",
    ]) ||
    input.schemaVersion !== 1 ||
    typeof input.ownerId !== "string" ||
    typeof input.resourceId !== "string" ||
    !(input.operationId === null || typeof input.operationId === "string") ||
    !isSha256(input.recordHash) ||
    !Array.isArray(input.files) ||
    !isNonnegativeSafeInteger(input.packageByteLength) ||
    !isSha256(input.packageHash)
  ) {
    throw new Error("invalid Project Environment package seal");
  }
  const files = input.files.map(parsePackageFileManifest);
  if (
    files.some(
      (file, index) =>
        index > 0 &&
        files[index - 1] !== undefined &&
        files[index - 1]!.path.localeCompare(file.path) >= 0,
    )
  ) {
    throw new Error("package seal paths are duplicated or not sorted");
  }
  return {
    schemaVersion: 1,
    ownerId: input.ownerId,
    resourceId: input.resourceId,
    operationId: input.operationId,
    recordHash: input.recordHash,
    files,
    packageByteLength: input.packageByteLength,
    packageHash: input.packageHash,
  };
}

function envelopeFor(
  ownerId: string,
  resourceId: string,
  payload: JsonValue,
): ImmutablePackageEnvelopeV1 {
  const payloadHash = contentHash(payload);
  const basis = {
    schemaVersion: 1 as const,
    ownerId,
    resourceId,
    payload,
    payloadHash,
  };
  return { ...basis, recordHash: contentHash(asJsonValue(basis)) };
}

function sealFor(
  ownerId: string,
  resourceId: string,
  operationId: string | null,
  recordHash: string,
  files: readonly ProjectEnvironmentPackageFileManifestV1[],
): ImmutablePackageSealV1 {
  const packageByteLength = files.reduce(
    (sum, file) => sum + file.byteLength,
    0,
  );
  const basis = {
    schemaVersion: 1 as const,
    ownerId,
    resourceId,
    operationId,
    recordHash,
    files,
    packageByteLength,
  };
  return { ...basis, packageHash: contentHash(asJsonValue(basis)) };
}

async function ensurePackageFileParent(
  filesRoot: DirectoryIdentity,
  segments: readonly string[],
): Promise<DirectoryIdentity> {
  let parent = filesRoot;
  for (const segment of segments.slice(0, -1)) {
    parent = (await createChildDirectory(parent, segment)).directory;
  }
  return parent;
}

export async function materializeImmutablePackage<T>(
  input: MaterializeImmutablePackageInput<T>,
): Promise<ImmutablePackageSealV1> {
  assertOpaqueId(input.ownerId, "package owner ID");
  assertOpaqueId(input.resourceId, "package resource ID");
  if (input.operationId !== null) {
    assertOpaqueId(input.operationId, "publication operation ID");
  }
  const parsedPayload = asJsonValue(input.parse(input.payload));
  const envelope = envelopeFor(input.ownerId, input.resourceId, parsedPayload);
  const files = normalizedPackageFiles(input.files, input.quota);
  const manifest = packageManifest(files);
  const seal = sealFor(
    input.ownerId,
    input.resourceId,
    input.operationId,
    envelope.recordHash,
    manifest,
  );
  const digest = resourceDigest(
    input.storeKind,
    input.ownerId,
    input.resourceId,
  );
  const packagePath = join(input.collection.path, digest);
  try {
    const existing = await inspectImmutablePackage(
      input.collection,
      input.storeKind,
      input.ownerId,
      input.resourceId,
      input.operationId,
      input.parse,
      input.quota,
      true,
    );
    if (existing.state === "incomplete") {
      throw new IncompleteProjectEnvironmentArtifactError(packagePath);
    }
    if (
      existing.seal?.recordHash !== seal.recordHash ||
      existing.seal.packageHash !== seal.packageHash
    ) {
      throw new ImmutableArtifactConflictError(packagePath);
    }
    return existing.seal;
  } catch (error) {
    if (!(error instanceof ArtifactNotFoundError)) throw error;
  }

  const marker: ImmutablePackageMarkerV1 = {
    schemaVersion: 1,
    storeKind: input.storeKind,
    ownerId: input.ownerId,
    resourceId: input.resourceId,
    resourceDigest: digest,
    operationId: input.operationId,
  };
  const markerBytes = canonicalBytes(asJsonValue(marker));
  const recordBytes = canonicalBytes(asJsonValue(envelope));
  const sealBytes = canonicalBytes(asJsonValue(seal));
  const directorySegments = new Set<string>();
  for (const file of files) {
    const segments = assertSafePackagePath(file.path);
    for (let index = 1; index < segments.length; index += 1) {
      directorySegments.add(segments.slice(0, index).join("/"));
    }
  }
  const additionalEntries = 5 + files.length + directorySegments.size;
  const additionalBytes =
    markerBytes.byteLength +
    recordBytes.byteLength +
    sealBytes.byteLength +
    files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  await assertQuotaAvailable(
    input.storeRoot,
    input.quota,
    additionalBytes,
    additionalEntries,
  );

  const packageDirectory = (
    await createChildDirectory(input.collection, digest)
  ).directory;
  await writeImmutableFile(packageDirectory, PACKAGE_MARKER, markerBytes);
  await writeImmutableFile(packageDirectory, PACKAGE_RECORD, recordBytes);
  const filesRoot = (
    await createChildDirectory(packageDirectory, PACKAGE_FILES)
  ).directory;
  for (const file of files) {
    const segments = assertSafePackagePath(file.path);
    const parent = await ensurePackageFileParent(filesRoot, segments);
    const name = segments.at(-1);
    if (name === undefined) throw new TypeError("empty package path");
    await writeExclusiveFile(parent, name, Buffer.from(file.bytes));
  }
  await writeImmutableFile(packageDirectory, PACKAGE_SEAL, sealBytes);
  await syncDirectory(packageDirectory);
  await syncDirectory(input.collection);
  return seal;
}

async function inspectFileTree(
  root: DirectoryIdentity,
  prefix = "",
): Promise<readonly ProjectEnvironmentPackageFileInputV1[]> {
  await assertDirectoryIdentity(root);
  const names = (await readdir(root.path)).sort();
  const files: ProjectEnvironmentPackageFileInputV1[] = [];
  for (const name of names) {
    if (!SAFE_ENTRY_PATTERN.test(name)) {
      throw new ArtifactPathSecurityError(
        join(root.path, name),
        "unsafe package tree entry name",
      );
    }
    const path = join(root.path, name);
    const status = await lstat(path);
    const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`;
    assertSafePackagePath(relativePath);
    if (status.isSymbolicLink()) {
      throw new ArtifactPathSecurityError(path, "package symlink rejected");
    }
    if (status.isDirectory()) {
      const child = await canonicalDirectoryIdentity(path);
      files.push(...(await inspectFileTree(child, relativePath)));
      continue;
    }
    if (!status.isFile() || status.nlink !== 1) {
      throw new ArtifactPathSecurityError(
        path,
        "package entry must be a singly-linked regular file",
      );
    }
    files.push({
      path: relativePath,
      bytes: Uint8Array.from(
        await readRegularFile(root, path, Number.MAX_SAFE_INTEGER),
      ),
    });
  }
  await assertDirectoryIdentity(root);
  return files;
}

export async function inspectImmutablePackage<T>(
  collection: DirectoryIdentity,
  storeKind: ImmutablePackageStoreKind,
  ownerId: string,
  resourceId: string,
  operationId: string | null,
  parse: (input: unknown) => T,
  quota: ProjectEnvironmentStoreQuotaV1,
  allowIncomplete: boolean,
): Promise<ImmutablePackageInspection<T>> {
  const digest = resourceDigest(storeKind, ownerId, resourceId);
  const packagePath = join(collection.path, digest);
  let packageDirectory: DirectoryIdentity;
  try {
    packageDirectory = await canonicalDirectoryIdentity(packagePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ArtifactNotFoundError(packagePath);
    }
    throw error;
  }
  const names = (await readdir(packageDirectory.path)).sort();
  const allowed = new Set([
    PACKAGE_MARKER,
    PACKAGE_RECORD,
    PACKAGE_FILES,
    PACKAGE_SEAL,
  ]);
  if (names.some((name) => !allowed.has(name))) {
    throw new ArtifactPathSecurityError(
      packageDirectory.path,
      "immutable package contains an unexpected entry",
    );
  }
  if (!names.includes(PACKAGE_MARKER)) {
    if (allowIncomplete && names.length === 0) {
      return {
        state: "incomplete",
        payload: undefined,
        files: [],
        seal: undefined,
      };
    }
    throw new ArtifactCorruptionError(
      packageDirectory.path,
      new Error("immutable package marker is missing"),
    );
  }
  let marker: ImmutablePackageMarkerV1;
  try {
    marker = parsePackageMarker(
      await readCanonicalJson(
        packageDirectory,
        join(packageDirectory.path, PACKAGE_MARKER),
        quota.maximumCanonicalJsonBytes,
      ),
    );
  } catch (error) {
    if (error instanceof ArtifactCorruptionError) throw error;
    throw new ArtifactCorruptionError(
      join(packageDirectory.path, PACKAGE_MARKER),
      error,
    );
  }
  if (
    marker.storeKind !== storeKind ||
    marker.ownerId !== ownerId ||
    marker.resourceId !== resourceId ||
    marker.resourceDigest !== digest ||
    marker.operationId !== operationId
  ) {
    throw new ArtifactCorruptionError(
      join(packageDirectory.path, PACKAGE_MARKER),
      new Error("immutable package marker identity mismatch"),
    );
  }
  if (!names.includes(PACKAGE_SEAL)) {
    if (!allowIncomplete) {
      throw new IncompleteProjectEnvironmentArtifactError(packagePath);
    }
    return {
      state: "incomplete",
      payload: undefined,
      files: [],
      seal: undefined,
    };
  }
  if (!names.includes(PACKAGE_RECORD) || !names.includes(PACKAGE_FILES)) {
    throw new ArtifactCorruptionError(
      packagePath,
      new Error("complete package is missing record or files directory"),
    );
  }
  const filesRoot = await canonicalDirectoryIdentity(
    join(packageDirectory.path, PACKAGE_FILES),
  );
  const files = [...(await inspectFileTree(filesRoot))].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (files.length > quota.maximumPackageFiles) {
    throw new ProjectEnvironmentStoreQuotaError(
      packagePath,
      "maximumPackageFiles",
    );
  }
  const packageBytes = files.reduce(
    (total, file) => total + file.bytes.byteLength,
    0,
  );
  if (packageBytes > quota.maximumPackageBytes) {
    throw new ProjectEnvironmentStoreQuotaError(
      packagePath,
      "maximumPackageBytes",
    );
  }
  let envelope: ImmutablePackageEnvelopeV1;
  let seal: ImmutablePackageSealV1;
  try {
    envelope = parsePackageEnvelope(
      await readCanonicalJson(
        packageDirectory,
        join(packageDirectory.path, PACKAGE_RECORD),
        quota.maximumCanonicalJsonBytes,
      ),
    );
    seal = parsePackageSeal(
      await readCanonicalJson(
        packageDirectory,
        join(packageDirectory.path, PACKAGE_SEAL),
        quota.maximumCanonicalJsonBytes,
      ),
    );
  } catch (error) {
    if (error instanceof ArtifactCorruptionError) throw error;
    throw new ArtifactCorruptionError(packagePath, error);
  }
  const expectedEnvelope = envelopeFor(ownerId, resourceId, envelope.payload);
  const actualManifest = packageManifest(files);
  const expectedSeal = sealFor(
    ownerId,
    resourceId,
    operationId,
    envelope.recordHash,
    actualManifest,
  );
  if (
    envelope.ownerId !== ownerId ||
    envelope.resourceId !== resourceId ||
    envelope.payloadHash !== expectedEnvelope.payloadHash ||
    envelope.recordHash !== expectedEnvelope.recordHash ||
    canonicalJson(asJsonValue(seal)) !==
      canonicalJson(asJsonValue(expectedSeal))
  ) {
    throw new ArtifactCorruptionError(
      packagePath,
      new Error("immutable package hashes or identities do not match"),
    );
  }
  let payload: T;
  try {
    payload = parse(envelope.payload);
    asJsonValue(payload);
  } catch (error) {
    throw new ArtifactCorruptionError(join(packagePath, PACKAGE_RECORD), error);
  }
  return { state: "complete", payload, files, seal };
}

export async function inspectImmutablePackageCollection(
  collection: DirectoryIdentity,
  expectedStoreKind: ImmutablePackageStoreKind,
  expectedOwnerId: string,
  quota: ProjectEnvironmentStoreQuotaV1,
  allowIncomplete: boolean,
): Promise<readonly ImmutablePackageIdentityV1[]> {
  await assertDirectoryIdentity(collection);
  const names = (await readdir(collection.path)).sort();
  const identities: ImmutablePackageIdentityV1[] = [];
  for (const name of names) {
    if (!isSha256(name)) {
      throw new ArtifactPathSecurityError(
        join(collection.path, name),
        "package directory name must be a resource digest",
      );
    }
    const packageDirectory = await canonicalDirectoryIdentity(
      join(collection.path, name),
    );
    const markerPath = join(packageDirectory.path, PACKAGE_MARKER);
    let marker: ImmutablePackageMarkerV1;
    try {
      marker = parsePackageMarker(
        await readCanonicalJson(
          packageDirectory,
          markerPath,
          quota.maximumCanonicalJsonBytes,
        ),
      );
    } catch (error) {
      if (
        allowIncomplete &&
        (error instanceof ArtifactNotFoundError ||
          (isNodeError(error) && error.code === "ENOENT"))
      ) {
        continue;
      }
      if (error instanceof ArtifactCorruptionError) throw error;
      throw new ArtifactCorruptionError(markerPath, error);
    }
    if (
      marker.storeKind !== expectedStoreKind ||
      marker.ownerId !== expectedOwnerId ||
      marker.resourceDigest !== name ||
      resourceDigest(marker.storeKind, marker.ownerId, marker.resourceId) !==
        name
    ) {
      throw new ArtifactCorruptionError(
        markerPath,
        new Error("package marker does not match its collection or digest"),
      );
    }
    const inspected = await inspectImmutablePackage(
      collection,
      marker.storeKind,
      marker.ownerId,
      marker.resourceId,
      marker.operationId,
      (value) => asJsonValue(value),
      quota,
      allowIncomplete,
    );
    if (inspected.state === "complete" || allowIncomplete) {
      identities.push(marker);
    }
  }
  await assertDirectoryIdentity(collection);
  return identities;
}

export async function inspectTreeUsage(
  root: DirectoryIdentity,
  allowedDoubleLinkedInodes: ReadonlySet<string> = new Set(),
): Promise<TreeUsage> {
  await assertDirectoryIdentity(root);
  let bytes = 0;
  let entries = 0;
  const countedDoubleLinkedInodes = new Set<string>();
  const visit = async (directory: DirectoryIdentity): Promise<void> => {
    const names = await readdir(directory.path);
    for (const name of names) {
      const path = join(directory.path, name);
      const status = await lstat(path);
      entries += 1;
      if (status.isSymbolicLink()) {
        throw new ArtifactPathSecurityError(path, "store symlink rejected");
      }
      if (status.isDirectory()) {
        const child = await canonicalDirectoryIdentity(path);
        await visit(child);
      } else if (
        status.isFile() &&
        (status.nlink === 1 ||
          (status.nlink === 2 &&
            allowedDoubleLinkedInodes.has(`${status.dev}:${status.ino}`)))
      ) {
        if ((status.mode & 0o777) !== 0o600) {
          throw new ArtifactPathSecurityError(
            path,
            "store file mode must be 0o600",
          );
        }
        const inodeKey = `${status.dev}:${status.ino}`;
        if (status.nlink === 1 || !countedDoubleLinkedInodes.has(inodeKey)) {
          bytes += status.size;
          if (status.nlink === 2) countedDoubleLinkedInodes.add(inodeKey);
        }
      } else {
        throw new ArtifactPathSecurityError(
          path,
          "store entry must be a directory or singly-linked regular file",
        );
      }
    }
    await assertDirectoryIdentity(directory);
  };
  await visit(root);
  return { bytes, entries };
}

export async function assertQuotaAvailable(
  root: DirectoryIdentity,
  quota: ProjectEnvironmentStoreQuotaV1,
  additionalBytes = 0,
  additionalEntries = 0,
): Promise<void> {
  const usage = await inspectTreeUsage(root);
  if (usage.bytes + additionalBytes > quota.maximumTotalBytes) {
    throw new ProjectEnvironmentStoreQuotaError(root.path, "maximumTotalBytes");
  }
  if (usage.entries + additionalEntries > quota.maximumEntries) {
    throw new ProjectEnvironmentStoreQuotaError(root.path, "maximumEntries");
  }
}

export async function regularFileExists(
  parent: DirectoryIdentity,
  path: string,
): Promise<boolean> {
  await assertDirectoryIdentity(parent);
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
      throw new ArtifactPathSecurityError(
        path,
        "record must be a singly-linked regular file",
      );
    }
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertLedgerName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*\.jsonl$/u.test(name)) {
    throw new ArtifactPathSecurityError(name, "unsafe ledger name");
  }
}

function parseLedgerEnvelope(
  input: unknown,
): ProjectEnvironmentLedgerEnvelopeV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "ownerId",
      "sequence",
      "previousRecordHash",
      "payload",
      "recordHash",
    ]) ||
    input.schemaVersion !== 1 ||
    typeof input.ownerId !== "string" ||
    !isNonnegativeSafeInteger(input.sequence) ||
    !(
      input.previousRecordHash === null || isSha256(input.previousRecordHash)
    ) ||
    !isSha256(input.recordHash)
  ) {
    throw new Error("invalid Project Environment ledger envelope");
  }
  return {
    schemaVersion: 1,
    ownerId: input.ownerId,
    sequence: input.sequence,
    previousRecordHash: input.previousRecordHash,
    payload: asJsonValue(input.payload),
    recordHash: input.recordHash,
  };
}

function parseLedgerSeal(input: unknown): ProjectEnvironmentLedgerSealV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "ownerId",
      "recordCount",
      "finalRecordHash",
      "ledgerByteLength",
      "ledgerSha256",
    ]) ||
    input.schemaVersion !== 1 ||
    typeof input.ownerId !== "string" ||
    !isNonnegativeSafeInteger(input.recordCount) ||
    !(input.finalRecordHash === null || isSha256(input.finalRecordHash)) ||
    !isNonnegativeSafeInteger(input.ledgerByteLength) ||
    !isSha256(input.ledgerSha256)
  ) {
    throw new Error("invalid Project Environment ledger seal");
  }
  return {
    schemaVersion: 1,
    ownerId: input.ownerId,
    recordCount: input.recordCount,
    finalRecordHash: input.finalRecordHash,
    ledgerByteLength: input.ledgerByteLength,
    ledgerSha256: input.ledgerSha256,
  };
}

async function readOptionalRegularFile(
  parent: DirectoryIdentity,
  path: string,
  maximumBytes: number,
): Promise<Buffer | undefined> {
  try {
    return await readRegularFile(parent, path, maximumBytes);
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) return undefined;
    throw error;
  }
}

function parseLedgerBytes(
  path: string,
  ownerId: string,
  bytes: Buffer,
): readonly ProjectEnvironmentLedgerEnvelopeV1[] {
  if (bytes.byteLength === 0) return [];
  try {
    const text = bytes.toString("utf8");
    if (!text.endsWith("\n")) throw new Error("ledger has a truncated line");
    const lines = text.slice(0, -1).split("\n");
    let previousRecordHash: string | null = null;
    return lines.map((line, sequence) => {
      if (line.length === 0) throw new Error("ledger contains an empty line");
      const envelope = parseLedgerEnvelope(JSON.parse(line) as unknown);
      if (canonicalJson(asJsonValue(envelope)) !== line) {
        throw new Error(`ledger record ${sequence} is not canonical JSON`);
      }
      const basis = {
        schemaVersion: 1 as const,
        ownerId,
        sequence,
        previousRecordHash,
        payload: envelope.payload,
      };
      const expectedHash = contentHash(asJsonValue(basis));
      if (
        envelope.ownerId !== ownerId ||
        envelope.sequence !== sequence ||
        envelope.previousRecordHash !== previousRecordHash ||
        envelope.recordHash !== expectedHash
      ) {
        throw new Error(`ledger chain mismatch at record ${sequence}`);
      }
      previousRecordHash = envelope.recordHash;
      return envelope;
    });
  } catch (error) {
    throw new ArtifactCorruptionError(path, error);
  }
}

async function readLedgerState(
  directory: DirectoryIdentity,
  name: string,
  ownerId: string,
  quota: ProjectEnvironmentStoreQuotaV1,
): Promise<{
  readonly bytes: Buffer;
  readonly envelopes: readonly ProjectEnvironmentLedgerEnvelopeV1[];
  readonly seal: ProjectEnvironmentLedgerSealV1 | undefined;
}> {
  assertLedgerName(name);
  const ledgerPath = join(directory.path, name);
  const bytes =
    (await readOptionalRegularFile(
      directory,
      ledgerPath,
      quota.maximumTotalBytes,
    )) ?? Buffer.alloc(0);
  const envelopes = parseLedgerBytes(ledgerPath, ownerId, bytes);
  const sealPath = join(directory.path, `${name}.seal.json`);
  const sealBytes = await readOptionalRegularFile(
    directory,
    sealPath,
    quota.maximumCanonicalJsonBytes,
  );
  let seal: ProjectEnvironmentLedgerSealV1 | undefined;
  if (sealBytes !== undefined) {
    try {
      seal = parseLedgerSeal(parseCanonicalJsonBytes(sealPath, sealBytes));
    } catch (error) {
      if (error instanceof ArtifactCorruptionError) throw error;
      throw new ArtifactCorruptionError(sealPath, error);
    }
    if (
      seal.ownerId !== ownerId ||
      seal.recordCount !== envelopes.length ||
      seal.finalRecordHash !== (envelopes.at(-1)?.recordHash ?? null) ||
      seal.ledgerByteLength !== bytes.byteLength ||
      seal.ledgerSha256 !== sha256(bytes)
    ) {
      throw new ArtifactCorruptionError(
        sealPath,
        new Error("ledger seal does not match ledger bytes"),
      );
    }
  }
  return { bytes, envelopes, seal };
}

export async function appendLedger<T>(
  storeRoot: DirectoryIdentity,
  directory: DirectoryIdentity,
  name: string,
  ownerId: string,
  payload: T,
  parse: (input: unknown) => T,
  quota: ProjectEnvironmentStoreQuotaV1,
): Promise<ProjectEnvironmentLedgerEnvelopeV1> {
  const parsedPayload = asJsonValue(parse(payload));
  const state = await readLedgerState(directory, name, ownerId, quota);
  const ledgerPath = join(directory.path, name);
  if (state.seal !== undefined) {
    throw new ProjectEnvironmentLedgerSealedError(ledgerPath);
  }
  const basis = {
    schemaVersion: 1 as const,
    ownerId,
    sequence: state.envelopes.length,
    previousRecordHash: state.envelopes.at(-1)?.recordHash ?? null,
    payload: parsedPayload,
  };
  const envelope: ProjectEnvironmentLedgerEnvelopeV1 = {
    ...basis,
    recordHash: contentHash(asJsonValue(basis)),
  };
  const line = canonicalBytes(asJsonValue(envelope));
  if (line.byteLength > quota.maximumCanonicalJsonBytes) {
    throw new ProjectEnvironmentStoreQuotaError(
      ledgerPath,
      "maximumCanonicalJsonBytes",
    );
  }
  await assertQuotaAvailable(
    storeRoot,
    quota,
    line.byteLength,
    state.bytes.length === 0 ? 1 : 0,
  );
  let before: FileIdentity | undefined;
  try {
    const status = await lstat(ledgerPath);
    if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
      throw new ArtifactPathSecurityError(
        ledgerPath,
        "ledger must be a singly-linked regular file",
      );
    }
    before = identityOf(status);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      ledgerPath,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      0o600,
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (before !== undefined && !sameIdentity(before, identityOf(opened)))
    ) {
      throw new ArtifactPathSecurityError(
        ledgerPath,
        "ledger identity changed before append",
      );
    }
    await assertDirectoryIdentity(directory);
    await handle.writeFile(line);
    await handle.sync();
  } catch (error) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new ArtifactPathSecurityError(
        ledgerPath,
        "ledger symlink rejected",
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
  await syncDirectory(directory);
  return envelope;
}

export async function readLedger<T>(
  directory: DirectoryIdentity,
  name: string,
  ownerId: string,
  parse: (input: unknown) => T,
  quota: ProjectEnvironmentStoreQuotaV1,
): Promise<readonly T[]> {
  const state = await readLedgerState(directory, name, ownerId, quota);
  const path = join(directory.path, name);
  try {
    return state.envelopes.map((envelope) => {
      const parsed = parse(envelope.payload);
      asJsonValue(parsed);
      return parsed;
    });
  } catch (error) {
    throw new ArtifactCorruptionError(path, error);
  }
}

export async function readSealedLedgerEvidence<T>(
  directory: DirectoryIdentity,
  name: string,
  ownerId: string,
  parse: (input: unknown) => T,
  quota: ProjectEnvironmentStoreQuotaV1,
): Promise<{
  readonly bytes: Uint8Array;
  readonly envelopes: readonly ProjectEnvironmentLedgerEnvelopeV1[];
  readonly seal: ProjectEnvironmentLedgerSealV1;
}> {
  const state = await readLedgerState(directory, name, ownerId, quota);
  if (state.seal === undefined) {
    throw new Error(`Project Environment ledger ${name} is not sealed`);
  }
  try {
    for (const envelope of state.envelopes) {
      asJsonValue(parse(envelope.payload));
    }
  } catch (error) {
    throw new ArtifactCorruptionError(join(directory.path, name), error);
  }
  return Object.freeze({
    bytes: Uint8Array.from(state.bytes),
    envelopes: Object.freeze(
      state.envelopes.map((value) => Object.freeze(value)),
    ),
    seal: Object.freeze(state.seal),
  });
}

export async function sealLedger(
  storeRoot: DirectoryIdentity,
  directory: DirectoryIdentity,
  name: string,
  ownerId: string,
  quota: ProjectEnvironmentStoreQuotaV1,
): Promise<ProjectEnvironmentLedgerSealV1> {
  const state = await readLedgerState(directory, name, ownerId, quota);
  if (state.seal !== undefined) return state.seal;
  const seal: ProjectEnvironmentLedgerSealV1 = {
    schemaVersion: 1,
    ownerId,
    recordCount: state.envelopes.length,
    finalRecordHash: state.envelopes.at(-1)?.recordHash ?? null,
    ledgerByteLength: state.bytes.byteLength,
    ledgerSha256: sha256(state.bytes),
  };
  const bytes = canonicalBytes(asJsonValue(seal));
  await assertQuotaAvailable(storeRoot, quota, bytes.byteLength, 1);
  await writeImmutableFile(directory, `${name}.seal.json`, bytes);
  return seal;
}

export async function validateLedger(
  directory: DirectoryIdentity,
  name: string,
  ownerId: string,
  quota: ProjectEnvironmentStoreQuotaV1,
): Promise<void> {
  await readLedgerState(directory, name, ownerId, quota);
}

export async function directoryExists(
  parent: DirectoryIdentity,
  path: string,
): Promise<boolean> {
  await assertDirectoryIdentity(parent);
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new ArtifactPathSecurityError(path, "expected a real directory");
    }
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export const PROJECT_ENVIRONMENT_PACKAGE_MARKER = PACKAGE_MARKER;
export const PROJECT_ENVIRONMENT_PACKAGE_RECORD = PACKAGE_RECORD;
export const PROJECT_ENVIRONMENT_PACKAGE_FILES = PACKAGE_FILES;
export const PROJECT_ENVIRONMENT_PACKAGE_SEAL = PACKAGE_SEAL;
