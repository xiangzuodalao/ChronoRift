import { createHash, randomUUID, type Hash } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  JsonValueSchema,
  taskNamespaceDigestV1,
  type JsonValue,
  type TaskId,
} from "@chronorift/domain";

import {
  canonicalJson,
  contentHash as canonicalContentHash,
} from "./canonical-json.js";
import {
  ArtifactCorruptionError,
  ArtifactNotFoundError,
} from "./json-artifact-repository.js";
import {
  ArtifactPathSecurityError,
  ImmutableArtifactConflictError,
} from "./v01-json-artifact-repository.js";

export const VNEXT_RUNTIME_RESOURCE_DIRECTORIES = {
  build: "builds",
  runtime: "runtimes",
  execution: "executions",
  capture: "capture-windows",
  checkpoint: "checkpoints",
  trace: "traces",
  branch: "branches",
  index: "indexes",
  comparison: "comparisons",
  "tool-call": "tool-calls",
} as const;

export type VNextRuntimeResourceKind =
  keyof typeof VNEXT_RUNTIME_RESOURCE_DIRECTORIES;

export interface RuntimeResourceEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly resourceKind: VNextRuntimeResourceKind;
  readonly resourceId: string;
  readonly resourceDigest: string;
  readonly payload: JsonValue;
  readonly payloadHash: string;
  readonly recordHash: string;
}

export interface RuntimeEventEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly executionId: string;
  readonly sequence: number;
  readonly previousHash: string | null;
  readonly payload: JsonValue;
  readonly payloadHash: string;
  readonly recordHash: string;
}

export interface RuntimeExecutionSealV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly executionId: string;
  readonly count: number;
  readonly headHash: string | null;
  readonly byteLength: number;
  readonly contentHash: string;
}

export interface VNextRuntimeResourceKindSummaryV1 {
  readonly resourceKind: VNextRuntimeResourceKind;
  readonly count: number;
  readonly resourceIds: readonly string[];
}

export interface VNextRuntimeExecutionSummaryV1 {
  readonly executionId: string;
  readonly sealed: boolean;
}

/** Read-only, path-free inventory for user-facing Task inspection. */
export interface VNextRuntimeResourceSummaryV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly kinds: readonly VNextRuntimeResourceKindSummaryV1[];
  readonly executions: readonly VNextRuntimeExecutionSummaryV1[];
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface TaskBaseContext {
  readonly taskId: TaskId;
  readonly rootPath: string;
  readonly tasksPath: string;
  readonly taskPath: string;
  readonly rootIdentity: FileIdentity;
  readonly tasksIdentity: FileIdentity;
  readonly taskIdentity: FileIdentity;
}

interface RuntimeStoreContext extends TaskBaseContext {
  readonly storePath: string;
  readonly storeIdentity: FileIdentity;
}

interface CategoryContext {
  readonly store: RuntimeStoreContext;
  readonly kind: VNextRuntimeResourceKind;
  readonly categoryPath: string;
  readonly categoryIdentity: FileIdentity;
}

interface ResourceContext {
  readonly category: CategoryContext;
  readonly resourceId: string;
  readonly resourceDigest: string;
  readonly resourcePath: string;
  readonly resourceIdentity: FileIdentity;
}

interface RuntimeStoreMarkerV1 {
  readonly schemaVersion: 1;
  readonly storeKind: "chronorift-vnext-runtime-records";
  readonly taskId: string;
  readonly taskNamespaceDigest: string;
}

interface RuntimeResourceMarkerV1 {
  readonly schemaVersion: 1;
  readonly storeKind: "chronorift-vnext-runtime-resource";
  readonly taskId: string;
  readonly resourceKind: VNextRuntimeResourceKind;
  readonly resourceId: string;
  readonly resourceDigest: string;
}

interface RuntimeEventLedgerState {
  readonly bytes: Buffer;
  readonly envelopes: readonly RuntimeEventEnvelopeV1[];
  readonly ledgerFile: RegularFileState | undefined;
  readonly seal: RuntimeExecutionSealV1 | undefined;
}

interface RegularFileState {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface BoundedFileRead {
  readonly bytes: Buffer;
  readonly file: RegularFileState;
}

interface RuntimeEventAppendState {
  readonly resourceIdentity: FileIdentity;
  readonly ledgerFile: RegularFileState | undefined;
  readonly count: number;
  readonly headHash: string | null;
  readonly byteLength: number;
  readonly contentHasher: Hash;
  readonly seal: RuntimeExecutionSealV1 | undefined;
}

interface OwnedFileSnapshot {
  readonly name: string;
  readonly path: string;
  readonly identity: FileIdentity;
}

interface OwnedResourceSnapshot {
  readonly context: ResourceContext;
  readonly files: readonly OwnedFileSnapshot[];
}

interface OwnedCategorySnapshot {
  readonly context: CategoryContext;
  readonly resources: readonly OwnedResourceSnapshot[];
}

interface OwnedTreeSnapshot {
  readonly context: RuntimeStoreContext;
  readonly marker: OwnedFileSnapshot;
  readonly categories: readonly OwnedCategorySnapshot[];
}

interface TaskLifecycleState {
  activeOperations: number;
  phase: "open" | "discarding" | "discarded";
  readonly drainWaiters: Set<() => void>;
  discardAttempt: Promise<void> | undefined;
}

const STORE_MARKER = ".chronorift-vnext-runtime-store-v1.json";
const RESOURCE_MARKER = ".chronorift-vnext-runtime-resource-v1.json";
const RESOURCE_RECORD = "record.json";
const EVENT_LEDGER = "events.jsonl";
const EVENT_SEAL = "events.seal.json";

/** Frozen Host allocation and persistence limits for vNext runtime records. */
export const VNEXT_RUNTIME_MAX_CANONICAL_JSON_BYTES = 8 * 1024 * 1024;
export const VNEXT_RUNTIME_MAX_EVENT_LEDGER_BYTES = 64 * 1024 * 1024;
export const VNEXT_RUNTIME_MAX_EVENT_BYTES = 1024 * 1024;
export const VNEXT_RUNTIME_MAX_EVENT_COUNT = 10_000;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RESOURCE_KINDS = Object.keys(
  VNEXT_RUNTIME_RESOURCE_DIRECTORIES,
) as VNextRuntimeResourceKind[];
const RESOURCE_KIND_SET = new Set<string>(RESOURCE_KINDS);
const CATEGORY_NAMES = new Set<string>(
  Object.values(VNEXT_RUNTIME_RESOURCE_DIRECTORIES),
);

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
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

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function identityOf(value: {
  readonly dev: number;
  readonly ino: number;
}): FileIdentity {
  return { dev: value.dev, ino: value.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function regularFileStateOf(value: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}): RegularFileState {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

function sameRegularFileIdentity(
  left: RegularFileState,
  right: RegularFileState,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameRegularFileState(
  left: RegularFileState,
  right: RegularFileState,
): boolean {
  return (
    sameRegularFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameStoreContext(
  left: RuntimeStoreContext,
  right: RuntimeStoreContext,
): boolean {
  return (
    left.rootPath === right.rootPath &&
    left.tasksPath === right.tasksPath &&
    left.taskPath === right.taskPath &&
    left.storePath === right.storePath &&
    sameIdentity(left.rootIdentity, right.rootIdentity) &&
    sameIdentity(left.tasksIdentity, right.tasksIdentity) &&
    sameIdentity(left.taskIdentity, right.taskIdentity) &&
    sameIdentity(left.storeIdentity, right.storeIdentity)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asJsonValue(value: unknown): JsonValue {
  return JsonValueSchema.parse(value);
}

function canonicalBytes(value: JsonValue): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cloneJson(value: JsonValue): JsonValue {
  return asJsonValue(JSON.parse(canonicalJson(value)) as unknown);
}

function parseStoreMarker(input: unknown): RuntimeStoreMarkerV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "storeKind",
      "taskId",
      "taskNamespaceDigest",
    ]) ||
    input.schemaVersion !== 1 ||
    input.storeKind !== "chronorift-vnext-runtime-records" ||
    typeof input.taskId !== "string" ||
    !isSha256(input.taskNamespaceDigest)
  ) {
    throw new Error("invalid vNext runtime store marker");
  }
  return {
    schemaVersion: 1,
    storeKind: "chronorift-vnext-runtime-records",
    taskId: input.taskId,
    taskNamespaceDigest: input.taskNamespaceDigest,
  };
}

function parseResourceKind(value: unknown): VNextRuntimeResourceKind {
  if (typeof value !== "string" || !RESOURCE_KIND_SET.has(value)) {
    throw new Error("invalid vNext runtime resource kind");
  }
  return value as VNextRuntimeResourceKind;
}

function parseResourceMarker(input: unknown): RuntimeResourceMarkerV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "storeKind",
      "taskId",
      "resourceKind",
      "resourceId",
      "resourceDigest",
    ]) ||
    input.schemaVersion !== 1 ||
    input.storeKind !== "chronorift-vnext-runtime-resource" ||
    typeof input.taskId !== "string" ||
    typeof input.resourceId !== "string" ||
    input.resourceId.length === 0 ||
    !isSha256(input.resourceDigest)
  ) {
    throw new Error("invalid vNext runtime resource marker");
  }
  return {
    schemaVersion: 1,
    storeKind: "chronorift-vnext-runtime-resource",
    taskId: input.taskId,
    resourceKind: parseResourceKind(input.resourceKind),
    resourceId: input.resourceId,
    resourceDigest: input.resourceDigest,
  };
}

function parseResourceEnvelope(input: unknown): RuntimeResourceEnvelopeV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "taskId",
      "resourceKind",
      "resourceId",
      "resourceDigest",
      "payload",
      "payloadHash",
      "recordHash",
    ]) ||
    input.schemaVersion !== 1 ||
    typeof input.taskId !== "string" ||
    typeof input.resourceId !== "string" ||
    input.resourceId.length === 0 ||
    !isSha256(input.resourceDigest) ||
    !isSha256(input.payloadHash) ||
    !isSha256(input.recordHash)
  ) {
    throw new Error("invalid vNext runtime resource envelope");
  }
  const payload = asJsonValue(input.payload);
  const resourceKind = parseResourceKind(input.resourceKind);
  const basis = asJsonValue({
    schemaVersion: 1,
    taskId: input.taskId,
    resourceKind,
    resourceId: input.resourceId,
    resourceDigest: input.resourceDigest,
    payload,
    payloadHash: input.payloadHash,
  });
  if (input.payloadHash !== canonicalContentHash(payload)) {
    throw new Error("runtime resource payload hash mismatch");
  }
  if (input.recordHash !== canonicalContentHash(basis)) {
    throw new Error("runtime resource envelope hash mismatch");
  }
  return {
    schemaVersion: 1,
    taskId: input.taskId as TaskId,
    resourceKind,
    resourceId: input.resourceId,
    resourceDigest: input.resourceDigest,
    payload,
    payloadHash: input.payloadHash,
    recordHash: input.recordHash,
  };
}

function parseEventEnvelope(input: unknown): RuntimeEventEnvelopeV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "taskId",
      "executionId",
      "sequence",
      "previousHash",
      "payload",
      "payloadHash",
      "recordHash",
    ]) ||
    input.schemaVersion !== 1 ||
    typeof input.taskId !== "string" ||
    typeof input.executionId !== "string" ||
    input.executionId.length === 0 ||
    !isNonnegativeSafeInteger(input.sequence) ||
    !(input.previousHash === null || isSha256(input.previousHash)) ||
    !isSha256(input.payloadHash) ||
    !isSha256(input.recordHash)
  ) {
    throw new Error("invalid vNext runtime event envelope");
  }
  const payload = asJsonValue(input.payload);
  const basis = asJsonValue({
    schemaVersion: 1,
    taskId: input.taskId,
    executionId: input.executionId,
    sequence: input.sequence,
    previousHash: input.previousHash,
    payload,
    payloadHash: input.payloadHash,
  });
  if (input.payloadHash !== canonicalContentHash(payload)) {
    throw new Error("runtime event payload hash mismatch");
  }
  if (input.recordHash !== canonicalContentHash(basis)) {
    throw new Error("runtime event envelope hash mismatch");
  }
  return {
    schemaVersion: 1,
    taskId: input.taskId as TaskId,
    executionId: input.executionId,
    sequence: input.sequence,
    previousHash: input.previousHash,
    payload,
    payloadHash: input.payloadHash,
    recordHash: input.recordHash,
  };
}

function parseExecutionSeal(input: unknown): RuntimeExecutionSealV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "taskId",
      "executionId",
      "count",
      "headHash",
      "byteLength",
      "contentHash",
    ]) ||
    input.schemaVersion !== 1 ||
    typeof input.taskId !== "string" ||
    typeof input.executionId !== "string" ||
    input.executionId.length === 0 ||
    !isNonnegativeSafeInteger(input.count) ||
    !(input.headHash === null || isSha256(input.headHash)) ||
    !isNonnegativeSafeInteger(input.byteLength) ||
    !isSha256(input.contentHash)
  ) {
    throw new Error("invalid vNext runtime execution seal");
  }
  return {
    schemaVersion: 1,
    taskId: input.taskId as TaskId,
    executionId: input.executionId,
    count: input.count,
    headHash: input.headHash,
    byteLength: input.byteLength,
    contentHash: input.contentHash,
  };
}

export function runtimeResourceNamespaceDigestV1(
  taskId: TaskId,
  kind: VNextRuntimeResourceKind,
  resourceId: string,
): string {
  if (typeof resourceId !== "string" || resourceId.length === 0) {
    throw new TypeError("runtime resource ID must be a non-empty string");
  }
  return createHash("sha256")
    .update("chronorift-vnext-runtime-resource-v1\0")
    .update(taskId)
    .update("\0")
    .update(kind)
    .update("\0")
    .update(resourceId)
    .digest("hex");
}

export class RuntimeExecutionSealedError extends Error {
  public constructor(readonly executionId: string) {
    super(`Runtime execution event ledger is sealed: ${executionId}`);
    this.name = "RuntimeExecutionSealedError";
  }
}

export class RuntimeExecutionLimitError extends Error {
  public constructor(
    readonly executionId: string,
    readonly limit: "event_count" | "event_bytes" | "ledger_bytes",
    readonly maximum: number,
  ) {
    super(
      `Runtime execution ${limit} limit exceeded for ${executionId}: maximum ${maximum}`,
    );
    this.name = "RuntimeExecutionLimitError";
  }
}

/**
 * Host-owned persistence for vNext runtime records.
 *
 * The adapter owns only `runtime-records/` below an existing Task root. Raw
 * resource IDs are metadata and are never interpolated into filesystem paths.
 */
export class VNextRuntimeStore {
  public readonly runtimeRoot: string;
  private readonly contexts = new Map<string, RuntimeStoreContext>();
  private readonly taskQueues = new Map<string, Promise<void>>();
  private readonly taskLifecycles = new Map<string, TaskLifecycleState>();
  private readonly appendStates = new Map<string, RuntimeEventAppendState>();

  public constructor(runtimeRoot: string) {
    this.runtimeRoot = resolve(runtimeRoot);
  }

  public async create(taskId: TaskId): Promise<void> {
    return this.runTaskOperation(taskId, () =>
      this.enqueueTask(taskId, () => this.createUnlocked(taskId)),
    );
  }

  public async open(taskId: TaskId): Promise<void> {
    return this.runTaskOperation(taskId, () =>
      this.enqueueTask(taskId, async () => {
        const context = await this.inspectStoreContext(taskId);
        await this.assertStoreMarker(context, taskId);
        this.clearAppendStates(taskId);
        try {
          await this.scanOwnedTree(context);
          this.rememberContext(taskId, context);
        } catch (error) {
          this.clearAppendStates(taskId);
          throw error;
        }
      }),
    );
  }

  public async putResourceOnce<T>(
    taskId: TaskId,
    kind: VNextRuntimeResourceKind,
    resourceId: string,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<void> {
    this.assertKind(kind);
    this.assertResourceId(resourceId);
    return this.runTaskOperation(taskId, () =>
      this.enqueueTask(taskId, async () => {
        const payload = this.parseOwnedPayload(taskId, value, parse);
        const context = await this.requireStore(taskId);
        const resource = await this.ensureResource(context, kind, resourceId);
        const payloadHash = canonicalContentHash(payload);
        const basis = asJsonValue({
          schemaVersion: 1,
          taskId,
          resourceKind: kind,
          resourceId,
          resourceDigest: resource.resourceDigest,
          payload,
          payloadHash,
        });
        const envelope: RuntimeResourceEnvelopeV1 = {
          schemaVersion: 1,
          taskId,
          resourceKind: kind,
          resourceId,
          resourceDigest: resource.resourceDigest,
          payload,
          payloadHash,
          recordHash: canonicalContentHash(basis),
        };
        await this.writeImmutableBytes(
          resource.resourcePath,
          resource.resourceIdentity,
          join(resource.resourcePath, RESOURCE_RECORD),
          canonicalBytes(asJsonValue(envelope)),
          () => this.assertResourceHierarchy(resource),
        );
      }),
    );
  }

  public async readResource<T>(
    taskId: TaskId,
    kind: VNextRuntimeResourceKind,
    resourceId: string,
    parse: (input: unknown) => T,
  ): Promise<T> {
    this.assertKind(kind);
    this.assertResourceId(resourceId);
    return this.runTaskOperation(taskId, () =>
      this.enqueueTask(taskId, async () => {
        const context = await this.requireStore(taskId);
        const resource = await this.openResource(context, kind, resourceId);
        const envelope = await this.readAndValidateResourceEnvelope(resource);
        try {
          const parsed = parse(envelope.payload);
          const parsedJson = asJsonValue(parsed);
          this.assertPayloadTask(taskId, parsedJson);
          if (canonicalJson(parsedJson) !== canonicalJson(envelope.payload)) {
            throw new Error("runtime resource parser changed stored payload");
          }
          return parsed;
        } catch (error) {
          throw new ArtifactCorruptionError(
            join(resource.resourcePath, RESOURCE_RECORD),
            error,
          );
        }
      }),
    );
  }

  public async appendExecutionEvent<T>(
    taskId: TaskId,
    executionId: string,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<RuntimeEventEnvelopeV1> {
    this.assertResourceId(executionId);
    return this.runTaskOperation(taskId, () =>
      this.enqueueTask(taskId, async () => {
        const payload = this.parseOwnedPayload(taskId, value, parse);
        this.assertEventExecution(executionId, payload);
        const context = await this.requireStore(taskId);
        const resource = await this.ensureResource(
          context,
          "execution",
          executionId,
        );
        const state = await this.requireAppendState(resource);
        if (state.seal !== undefined) {
          throw new RuntimeExecutionSealedError(executionId);
        }
        const sequence = state.count;
        if (sequence >= VNEXT_RUNTIME_MAX_EVENT_COUNT) {
          throw new RuntimeExecutionLimitError(
            executionId,
            "event_count",
            VNEXT_RUNTIME_MAX_EVENT_COUNT,
          );
        }
        this.assertEventSequence(sequence, payload);
        const previousHash = state.headHash;
        const payloadHash = canonicalContentHash(payload);
        const basis = asJsonValue({
          schemaVersion: 1,
          taskId,
          executionId,
          sequence,
          previousHash,
          payload,
          payloadHash,
        });
        const envelope: RuntimeEventEnvelopeV1 = {
          schemaVersion: 1,
          taskId,
          executionId,
          sequence,
          previousHash,
          payload,
          payloadHash,
          recordHash: canonicalContentHash(basis),
        };
        const line = canonicalBytes(asJsonValue(envelope));
        if (line.byteLength > VNEXT_RUNTIME_MAX_EVENT_BYTES) {
          throw new RuntimeExecutionLimitError(
            executionId,
            "event_bytes",
            VNEXT_RUNTIME_MAX_EVENT_BYTES,
          );
        }
        if (
          state.byteLength + line.byteLength >
          VNEXT_RUNTIME_MAX_EVENT_LEDGER_BYTES
        ) {
          throw new RuntimeExecutionLimitError(
            executionId,
            "ledger_bytes",
            VNEXT_RUNTIME_MAX_EVENT_LEDGER_BYTES,
          );
        }
        const stateKey = this.appendStateKey(resource);
        try {
          const ledgerFile = await this.appendLine(
            resource,
            join(resource.resourcePath, EVENT_LEDGER),
            line,
            state.ledgerFile,
          );
          state.contentHasher.update(line);
          this.appendStates.set(stateKey, {
            resourceIdentity: resource.resourceIdentity,
            ledgerFile,
            count: sequence + 1,
            headHash: envelope.recordHash,
            byteLength: state.byteLength + line.byteLength,
            contentHasher: state.contentHasher,
            seal: undefined,
          });
        } catch (error) {
          // A failed post-write durability or identity check may still have
          // changed the file. Force one bounded recovery scan before retrying.
          this.appendStates.delete(stateKey);
          throw error;
        }
        return envelope;
      }),
    );
  }

  public async readExecutionEvents<T>(
    taskId: TaskId,
    executionId: string,
    parse: (input: unknown) => T,
  ): Promise<readonly T[]> {
    this.assertResourceId(executionId);
    return this.runTaskOperation(taskId, () =>
      this.enqueueTask(taskId, async () => {
        const context = await this.requireStore(taskId);
        const resource = await this.openResource(
          context,
          "execution",
          executionId,
        );
        const state = await this.readEventLedgerState(resource);
        const path = join(resource.resourcePath, EVENT_LEDGER);
        try {
          return state.envelopes.map((envelope) => {
            const parsed = parse(envelope.payload);
            const parsedJson = asJsonValue(parsed);
            this.assertPayloadTask(taskId, parsedJson);
            this.assertEventExecution(executionId, parsedJson);
            this.assertEventSequence(envelope.sequence, parsedJson);
            if (canonicalJson(parsedJson) !== canonicalJson(envelope.payload)) {
              throw new Error("runtime event parser changed stored payload");
            }
            return parsed;
          });
        } catch (error) {
          throw new ArtifactCorruptionError(path, error);
        }
      }),
    );
  }

  /** Reads and validates the immutable physical seal against its raw ledger. */
  public async readExecutionSeal(
    taskId: TaskId,
    executionId: string,
  ): Promise<RuntimeExecutionSealV1> {
    this.assertResourceId(executionId);
    return this.runTaskOperation(taskId, () =>
      this.enqueueTask(taskId, async () => {
        const context = await this.requireStore(taskId);
        const resource = await this.openResource(
          context,
          "execution",
          executionId,
        );
        const state = await this.readEventLedgerState(resource);
        if (state.seal === undefined) {
          throw new ArtifactNotFoundError(
            join(resource.resourcePath, EVENT_SEAL),
          );
        }
        return state.seal;
      }),
    );
  }

  public async sealExecution(
    taskId: TaskId,
    executionId: string,
  ): Promise<RuntimeExecutionSealV1> {
    this.assertResourceId(executionId);
    return this.runTaskOperation(taskId, () =>
      this.enqueueTask(taskId, async () => {
        const context = await this.requireStore(taskId);
        const resource = await this.openResource(
          context,
          "execution",
          executionId,
        );
        const state = await this.readEventLedgerState(resource);
        if (state.seal !== undefined) return state.seal;
        const seal: RuntimeExecutionSealV1 = {
          schemaVersion: 1,
          taskId,
          executionId,
          count: state.envelopes.length,
          headHash: state.envelopes.at(-1)?.recordHash ?? null,
          byteLength: state.bytes.byteLength,
          contentHash: sha256(state.bytes),
        };
        await this.writeImmutableBytes(
          resource.resourcePath,
          resource.resourceIdentity,
          join(resource.resourcePath, EVENT_SEAL),
          canonicalBytes(asJsonValue(seal)),
          () => this.assertResourceHierarchy(resource),
        );
        return seal;
      }),
    );
  }

  public async summarize(
    taskId: TaskId,
  ): Promise<VNextRuntimeResourceSummaryV1> {
    return this.runTaskOperation(taskId, () =>
      this.enqueueTask(taskId, async () => {
        const context = await this.inspectStoreContext(taskId);
        this.rememberContext(taskId, context);
        await this.assertStoreMarker(context, taskId);
        const snapshot = await this.scanOwnedTree(context);
        const resourcesByKind = new Map(
          snapshot.categories.map((category) => [
            category.context.kind,
            category.resources,
          ]),
        );
        const kinds = RESOURCE_KINDS.map((resourceKind) => {
          const resourceIds = Object.freeze(
            (resourcesByKind.get(resourceKind) ?? [])
              .map((resource) => resource.context.resourceId)
              .sort(compareText),
          );
          return Object.freeze({
            resourceKind,
            count: resourceIds.length,
            resourceIds,
          });
        });
        const executions = Object.freeze(
          (resourcesByKind.get("execution") ?? [])
            .map((resource) =>
              Object.freeze({
                executionId: resource.context.resourceId,
                sealed: resource.files.some((file) => file.name === EVENT_SEAL),
              }),
            )
            .sort((left, right) =>
              compareText(left.executionId, right.executionId),
            ),
        );
        return Object.freeze({
          schemaVersion: 1 as const,
          taskId,
          kinds: Object.freeze(kinds),
          executions,
        });
      }),
    );
  }

  public async discard(taskId: TaskId): Promise<void> {
    const lifecycle = this.lifecycleFor(taskId);
    if (lifecycle.phase === "discarded") {
      return Promise.reject(
        new ArtifactNotFoundError(this.storePathFor(taskId)),
      );
    }
    if (lifecycle.discardAttempt !== undefined) {
      return lifecycle.discardAttempt;
    }
    lifecycle.phase = "discarding";
    let deletionStarted = false;
    const operation = (async () => {
      await this.waitForTaskOperations(lifecycle);
      await this.enqueueTask(taskId, async () => {
        const context = await this.requireStoreForDiscard(taskId);
        const snapshot = await this.scanOwnedTree(context);
        deletionStarted = true;
        await this.deleteOwnedSnapshot(snapshot);
      });
      lifecycle.phase = "discarded";
    })();
    const tracked = operation.then(
      () => {
        lifecycle.discardAttempt = undefined;
      },
      (error: unknown) => {
        lifecycle.discardAttempt = undefined;
        if (!deletionStarted) lifecycle.phase = "open";
        throw error;
      },
    );
    lifecycle.discardAttempt = tracked;
    return tracked;
  }

  private async createUnlocked(taskId: TaskId): Promise<void> {
    const base = await this.inspectTaskBase(taskId);
    const storePath = join(base.taskPath, "runtime-records");
    let created = false;
    try {
      await this.canonicalDirectoryIdentity(storePath, true);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      try {
        await mkdir(storePath, { mode: 0o700 });
        created = true;
      } catch (mkdirError) {
        if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") {
          throw mkdirError;
        }
      }
    }
    const context = await this.inspectStoreContext(taskId);
    if (
      !sameIdentity(base.rootIdentity, context.rootIdentity) ||
      !sameIdentity(base.tasksIdentity, context.tasksIdentity) ||
      !sameIdentity(base.taskIdentity, context.taskIdentity)
    ) {
      throw new ArtifactPathSecurityError(
        storePath,
        "Task hierarchy changed while creating runtime records",
      );
    }
    if (created) {
      await this.syncDirectory(context.taskPath, context.taskIdentity);
    }

    const entries = await readdir(context.storePath);
    if (entries.length === 0) {
      await this.writeImmutableBytes(
        context.storePath,
        context.storeIdentity,
        join(context.storePath, STORE_MARKER),
        canonicalBytes(asJsonValue(this.storeMarkerFor(taskId))),
        () => this.assertStoreHierarchy(context),
      );
    } else if (!entries.includes(STORE_MARKER)) {
      throw new ArtifactPathSecurityError(
        context.storePath,
        "runtime-records must be empty before its ownership marker is published",
      );
    }
    await this.assertStoreMarker(context, taskId);
    this.clearAppendStates(taskId);
    try {
      await this.scanOwnedTree(context);
      this.rememberContext(taskId, context);
    } catch (error) {
      this.clearAppendStates(taskId);
      throw error;
    }
  }

  private parseOwnedPayload<T>(
    taskId: TaskId,
    value: T,
    parse: (input: unknown) => T,
  ): JsonValue {
    const parsed = cloneJson(asJsonValue(parse(value)));
    this.assertPayloadTask(taskId, parsed);
    return parsed;
  }

  private assertPayloadTask(taskId: TaskId, payload: JsonValue): void {
    if (
      !isObject(payload) ||
      typeof payload.taskId !== "string" ||
      payload.taskId !== taskId
    ) {
      throw new Error("runtime record belongs to a different Task");
    }
  }

  private assertEventExecution(executionId: string, payload: JsonValue): void {
    if (
      !isObject(payload) ||
      typeof payload.executionId !== "string" ||
      payload.executionId !== executionId
    ) {
      throw new Error("runtime event belongs to a different Execution");
    }
  }

  private assertEventSequence(sequence: number, payload: JsonValue): void {
    if (!isObject(payload) || payload.sequence !== sequence) {
      throw new Error(
        `runtime event sequence must equal its append position ${sequence}`,
      );
    }
  }

  private assertKind(kind: VNextRuntimeResourceKind): void {
    if (typeof kind !== "string" || !RESOURCE_KIND_SET.has(kind)) {
      throw new ArtifactPathSecurityError(
        typeof kind === "string" ? kind : "<non-string kind>",
        "unsupported vNext runtime resource kind",
      );
    }
  }

  private assertResourceId(resourceId: string): void {
    if (typeof resourceId !== "string" || resourceId.length === 0) {
      throw new ArtifactPathSecurityError(
        typeof resourceId === "string" ? resourceId : "<non-string ID>",
        "runtime resource ID must be a non-empty string",
      );
    }
  }

  private storeMarkerFor(taskId: TaskId): RuntimeStoreMarkerV1 {
    return {
      schemaVersion: 1,
      storeKind: "chronorift-vnext-runtime-records",
      taskId,
      taskNamespaceDigest: taskNamespaceDigestV1(taskId),
    };
  }

  private resourceMarkerFor(
    taskId: TaskId,
    kind: VNextRuntimeResourceKind,
    resourceId: string,
  ): RuntimeResourceMarkerV1 {
    return {
      schemaVersion: 1,
      storeKind: "chronorift-vnext-runtime-resource",
      taskId,
      resourceKind: kind,
      resourceId,
      resourceDigest: runtimeResourceNamespaceDigestV1(
        taskId,
        kind,
        resourceId,
      ),
    };
  }

  private storePathFor(taskId: TaskId): string {
    return join(
      this.runtimeRoot,
      "tasks",
      taskNamespaceDigestV1(taskId),
      "runtime-records",
    );
  }

  private async inspectTaskBase(taskId: TaskId): Promise<TaskBaseContext> {
    const rootPath = this.runtimeRoot;
    const tasksPath = join(rootPath, "tasks");
    const taskPath = join(tasksPath, taskNamespaceDigestV1(taskId));
    try {
      return {
        taskId,
        rootPath,
        tasksPath,
        taskPath,
        rootIdentity: await this.canonicalDirectoryIdentity(rootPath),
        tasksIdentity: await this.canonicalDirectoryIdentity(tasksPath),
        taskIdentity: await this.canonicalDirectoryIdentity(taskPath),
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new ArtifactNotFoundError(taskPath);
      }
      throw error;
    }
  }

  private async inspectStoreContext(
    taskId: TaskId,
  ): Promise<RuntimeStoreContext> {
    const base = await this.inspectTaskBase(taskId);
    const storePath = join(base.taskPath, "runtime-records");
    try {
      return {
        ...base,
        storePath,
        storeIdentity: await this.canonicalDirectoryIdentity(storePath, true),
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new ArtifactNotFoundError(storePath);
      }
      throw error;
    }
  }

  private rememberContext(taskId: TaskId, context: RuntimeStoreContext): void {
    const previous = this.contexts.get(taskId);
    if (previous !== undefined && !sameStoreContext(previous, context)) {
      throw new ArtifactPathSecurityError(
        context.storePath,
        "runtime-records directory changed since it was opened",
      );
    }
    this.contexts.set(taskId, context);
  }

  private async requireStore(taskId: TaskId): Promise<RuntimeStoreContext> {
    const context = await this.inspectStoreContext(taskId);
    const requiresRecoveryScan = !this.contexts.has(taskId);
    this.rememberContext(taskId, context);
    await this.assertStoreMarker(context, taskId);
    if (requiresRecoveryScan) {
      this.clearAppendStates(taskId);
      try {
        await this.scanOwnedTree(context);
      } catch (error) {
        this.contexts.delete(taskId);
        this.clearAppendStates(taskId);
        throw error;
      }
    }
    return context;
  }

  private async requireStoreForDiscard(
    taskId: TaskId,
  ): Promise<RuntimeStoreContext> {
    const context = await this.inspectStoreContext(taskId);
    this.rememberContext(taskId, context);
    await this.assertStoreMarker(context, taskId);
    return context;
  }

  private async assertStoreMarker(
    context: RuntimeStoreContext,
    taskId: TaskId,
  ): Promise<void> {
    const path = join(context.storePath, STORE_MARKER);
    const stored = await this.readCanonicalJson(path, () =>
      this.assertStoreHierarchy(context),
    );
    let marker: RuntimeStoreMarkerV1;
    try {
      marker = parseStoreMarker(stored);
    } catch (error) {
      throw new ArtifactCorruptionError(path, error);
    }
    const expected = this.storeMarkerFor(taskId);
    if (
      marker.taskId !== expected.taskId ||
      marker.taskNamespaceDigest !== expected.taskNamespaceDigest
    ) {
      throw new ArtifactCorruptionError(
        path,
        new Error("runtime-records marker belongs to a different Task"),
      );
    }
  }

  private async ensureCategory(
    context: RuntimeStoreContext,
    kind: VNextRuntimeResourceKind,
  ): Promise<CategoryContext> {
    const categoryPath = join(
      context.storePath,
      VNEXT_RUNTIME_RESOURCE_DIRECTORIES[kind],
    );
    let created = false;
    try {
      await this.canonicalDirectoryIdentity(categoryPath, true);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      try {
        await mkdir(categoryPath, { mode: 0o700 });
        created = true;
      } catch (mkdirError) {
        if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") {
          throw mkdirError;
        }
      }
    }
    const category: CategoryContext = {
      store: context,
      kind,
      categoryPath,
      categoryIdentity: await this.canonicalDirectoryIdentity(
        categoryPath,
        true,
      ),
    };
    await this.assertCategoryHierarchy(category);
    if (created) {
      await this.syncDirectory(context.storePath, context.storeIdentity);
    }
    return category;
  }

  private async openCategory(
    context: RuntimeStoreContext,
    kind: VNextRuntimeResourceKind,
  ): Promise<CategoryContext> {
    const categoryPath = join(
      context.storePath,
      VNEXT_RUNTIME_RESOURCE_DIRECTORIES[kind],
    );
    try {
      const category: CategoryContext = {
        store: context,
        kind,
        categoryPath,
        categoryIdentity: await this.canonicalDirectoryIdentity(
          categoryPath,
          true,
        ),
      };
      await this.assertCategoryHierarchy(category);
      return category;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new ArtifactNotFoundError(categoryPath);
      }
      throw error;
    }
  }

  private async ensureResource(
    context: RuntimeStoreContext,
    kind: VNextRuntimeResourceKind,
    resourceId: string,
  ): Promise<ResourceContext> {
    const category = await this.ensureCategory(context, kind);
    const resourceDigest = runtimeResourceNamespaceDigestV1(
      contextTaskId(context),
      kind,
      resourceId,
    );
    const resourcePath = join(category.categoryPath, resourceDigest);
    let created = false;
    try {
      await this.canonicalDirectoryIdentity(resourcePath, true);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      try {
        await mkdir(resourcePath, { mode: 0o700 });
        created = true;
      } catch (mkdirError) {
        if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") {
          throw mkdirError;
        }
      }
    }
    const resource: ResourceContext = {
      category,
      resourceId,
      resourceDigest,
      resourcePath,
      resourceIdentity: await this.canonicalDirectoryIdentity(
        resourcePath,
        true,
      ),
    };
    await this.assertResourceHierarchy(resource);
    if (created) {
      await this.syncDirectory(
        category.categoryPath,
        category.categoryIdentity,
      );
    }
    const entries = await readdir(resource.resourcePath);
    if (entries.length === 0) {
      await this.writeImmutableBytes(
        resource.resourcePath,
        resource.resourceIdentity,
        join(resource.resourcePath, RESOURCE_MARKER),
        canonicalBytes(
          asJsonValue(
            this.resourceMarkerFor(contextTaskId(context), kind, resourceId),
          ),
        ),
        () => this.assertResourceHierarchy(resource),
      );
    } else if (!entries.includes(RESOURCE_MARKER)) {
      throw new ArtifactPathSecurityError(
        resource.resourcePath,
        "runtime resource must be empty before its ownership marker is published",
      );
    }
    await this.assertResourceMarker(resource);
    await this.assertResourceEntries(resource);
    return resource;
  }

  private async openResource(
    context: RuntimeStoreContext,
    kind: VNextRuntimeResourceKind,
    resourceId: string,
  ): Promise<ResourceContext> {
    const category = await this.openCategory(context, kind);
    const resourceDigest = runtimeResourceNamespaceDigestV1(
      contextTaskId(context),
      kind,
      resourceId,
    );
    const resourcePath = join(category.categoryPath, resourceDigest);
    try {
      const resource: ResourceContext = {
        category,
        resourceId,
        resourceDigest,
        resourcePath,
        resourceIdentity: await this.canonicalDirectoryIdentity(
          resourcePath,
          true,
        ),
      };
      await this.assertResourceHierarchy(resource);
      await this.assertResourceMarker(resource);
      await this.assertResourceEntries(resource);
      return resource;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new ArtifactNotFoundError(resourcePath);
      }
      throw error;
    }
  }

  private async assertResourceMarker(resource: ResourceContext): Promise<void> {
    const path = join(resource.resourcePath, RESOURCE_MARKER);
    const stored = await this.readCanonicalJson(path, () =>
      this.assertResourceHierarchy(resource),
    );
    let marker: RuntimeResourceMarkerV1;
    try {
      marker = parseResourceMarker(stored);
    } catch (error) {
      throw new ArtifactCorruptionError(path, error);
    }
    const expected = this.resourceMarkerFor(
      contextTaskId(resource.category.store),
      resource.category.kind,
      resource.resourceId,
    );
    if (
      marker.taskId !== expected.taskId ||
      marker.resourceKind !== expected.resourceKind ||
      marker.resourceId !== expected.resourceId ||
      marker.resourceDigest !== expected.resourceDigest
    ) {
      throw new ArtifactCorruptionError(
        path,
        new Error("runtime resource marker ownership mismatch"),
      );
    }
  }

  private async assertResourceEntries(
    resource: ResourceContext,
  ): Promise<void> {
    const allowed = new Set<string>([RESOURCE_MARKER, RESOURCE_RECORD]);
    if (resource.category.kind === "execution") {
      allowed.add(EVENT_LEDGER);
      allowed.add(EVENT_SEAL);
    }
    for (const entry of await readdir(resource.resourcePath)) {
      if (!allowed.has(entry)) {
        throw new ArtifactPathSecurityError(
          join(resource.resourcePath, entry),
          "foreign child in runtime resource directory",
        );
      }
      const path = join(resource.resourcePath, entry);
      const status = await lstat(path);
      if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
        throw new ArtifactPathSecurityError(
          path,
          "runtime resource child is not an owned regular file",
        );
      }
    }
  }

  private async readAndValidateResourceEnvelope(
    resource: ResourceContext,
  ): Promise<RuntimeResourceEnvelopeV1> {
    const path = join(resource.resourcePath, RESOURCE_RECORD);
    const stored = await this.readCanonicalJson(path, () =>
      this.assertResourceHierarchy(resource),
    );
    try {
      const envelope = parseResourceEnvelope(stored);
      if (
        envelope.taskId !== contextTaskId(resource.category.store) ||
        envelope.resourceKind !== resource.category.kind ||
        envelope.resourceId !== resource.resourceId ||
        envelope.resourceDigest !== resource.resourceDigest
      ) {
        throw new Error("runtime resource envelope ownership mismatch");
      }
      this.assertPayloadTask(envelope.taskId, envelope.payload);
      return envelope;
    } catch (error) {
      throw new ArtifactCorruptionError(path, error);
    }
  }

  private appendStateKey(resource: ResourceContext): string {
    return `${taskNamespaceDigestV1(contextTaskId(resource.category.store))}:${resource.resourceDigest}`;
  }

  private clearAppendStates(taskId: TaskId): void {
    const prefix = `${taskNamespaceDigestV1(taskId)}:`;
    for (const key of this.appendStates.keys()) {
      if (key.startsWith(prefix)) this.appendStates.delete(key);
    }
  }

  private rememberAppendState(
    resource: ResourceContext,
    state: RuntimeEventLedgerState,
  ): RuntimeEventAppendState {
    const appendState: RuntimeEventAppendState = {
      resourceIdentity: resource.resourceIdentity,
      ledgerFile: state.ledgerFile,
      count: state.envelopes.length,
      headHash: state.envelopes.at(-1)?.recordHash ?? null,
      byteLength: state.bytes.byteLength,
      contentHasher: createHash("sha256").update(state.bytes),
      seal: state.seal,
    };
    this.appendStates.set(this.appendStateKey(resource), appendState);
    return appendState;
  }

  private async requireAppendState(
    resource: ResourceContext,
  ): Promise<RuntimeEventAppendState> {
    const cached = this.appendStates.get(this.appendStateKey(resource));
    if (
      cached !== undefined &&
      sameIdentity(cached.resourceIdentity, resource.resourceIdentity)
    ) {
      return cached;
    }
    return this.rememberAppendState(
      resource,
      await this.readEventLedgerState(resource),
    );
  }

  private async readEventLedgerState(
    resource: ResourceContext,
  ): Promise<RuntimeEventLedgerState> {
    const ledgerPath = join(resource.resourcePath, EVENT_LEDGER);
    let bytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let ledgerFile: RegularFileState | undefined;
    try {
      const read = await this.readRegularFileSnapshot(
        ledgerPath,
        () => this.assertResourceHierarchy(resource),
        VNEXT_RUNTIME_MAX_EVENT_LEDGER_BYTES,
      );
      bytes = read.bytes;
      ledgerFile = read.file;
    } catch (error) {
      if (!(error instanceof ArtifactNotFoundError)) throw error;
    }

    const envelopes: RuntimeEventEnvelopeV1[] = [];
    try {
      if (bytes.byteLength > 0) {
        if (bytes.at(-1) !== 0x0a) {
          throw new Error("runtime event ledger is missing its final newline");
        }
        let lineStart = 0;
        while (lineStart < bytes.byteLength) {
          if (envelopes.length >= VNEXT_RUNTIME_MAX_EVENT_COUNT) {
            throw new Error(
              `runtime event ledger exceeds ${VNEXT_RUNTIME_MAX_EVENT_COUNT} events`,
            );
          }
          const lineEnd = bytes.indexOf(0x0a, lineStart);
          if (lineEnd < lineStart) {
            throw new Error("runtime event ledger line is unterminated");
          }
          const lineByteLength = lineEnd - lineStart + 1;
          if (lineByteLength > VNEXT_RUNTIME_MAX_EVENT_BYTES) {
            throw new Error(
              `runtime event exceeds ${VNEXT_RUNTIME_MAX_EVENT_BYTES} bytes`,
            );
          }
          const index = envelopes.length;
          const line = bytes.toString("utf8", lineStart, lineEnd);
          const parsed = asJsonValue(JSON.parse(line) as unknown);
          if (`${canonicalJson(parsed)}\n` !== `${line}\n`) {
            throw new Error("runtime event ledger line is not canonical JSON");
          }
          const envelope = parseEventEnvelope(parsed);
          const previousHash = envelopes.at(-1)?.recordHash ?? null;
          if (
            envelope.taskId !== contextTaskId(resource.category.store) ||
            envelope.executionId !== resource.resourceId ||
            envelope.sequence !== index ||
            envelope.previousHash !== previousHash
          ) {
            throw new Error("runtime event chain or ownership mismatch");
          }
          this.assertPayloadTask(envelope.taskId, envelope.payload);
          this.assertEventExecution(envelope.executionId, envelope.payload);
          this.assertEventSequence(envelope.sequence, envelope.payload);
          envelopes.push(envelope);
          lineStart = lineEnd + 1;
        }
      }
    } catch (error) {
      this.appendStates.delete(this.appendStateKey(resource));
      throw new ArtifactCorruptionError(ledgerPath, error);
    }

    const sealPath = join(resource.resourcePath, EVENT_SEAL);
    let seal: RuntimeExecutionSealV1 | undefined;
    try {
      const stored = await this.readCanonicalJson(sealPath, () =>
        this.assertResourceHierarchy(resource),
      );
      try {
        seal = parseExecutionSeal(stored);
      } catch (error) {
        throw new ArtifactCorruptionError(sealPath, error);
      }
    } catch (error) {
      if (!(error instanceof ArtifactNotFoundError)) throw error;
    }
    if (
      seal !== undefined &&
      (seal.taskId !== contextTaskId(resource.category.store) ||
        seal.executionId !== resource.resourceId ||
        seal.count !== envelopes.length ||
        seal.headHash !== (envelopes.at(-1)?.recordHash ?? null) ||
        seal.byteLength !== bytes.byteLength ||
        seal.contentHash !== sha256(bytes))
    ) {
      this.appendStates.delete(this.appendStateKey(resource));
      throw new ArtifactCorruptionError(
        sealPath,
        new Error("runtime execution seal does not match its event ledger"),
      );
    }
    const state = { bytes, envelopes, ledgerFile, seal };
    this.rememberAppendState(resource, state);
    return state;
  }

  private async scanOwnedTree(
    context: RuntimeStoreContext,
  ): Promise<OwnedTreeSnapshot> {
    await this.assertStoreHierarchy(context);
    const rootEntries = await readdir(context.storePath);
    if (!rootEntries.includes(STORE_MARKER)) {
      throw new ArtifactPathSecurityError(
        context.storePath,
        "runtime-records ownership marker is missing",
      );
    }
    for (const entry of rootEntries) {
      if (entry !== STORE_MARKER && !CATEGORY_NAMES.has(entry)) {
        throw new ArtifactPathSecurityError(
          join(context.storePath, entry),
          "foreign child in runtime-records root",
        );
      }
    }
    const marker = await this.snapshotRegularFile(
      context,
      join(context.storePath, STORE_MARKER),
      STORE_MARKER,
    );
    const categories: OwnedCategorySnapshot[] = [];
    for (const kind of RESOURCE_KINDS) {
      const name = VNEXT_RUNTIME_RESOURCE_DIRECTORIES[kind];
      if (!rootEntries.includes(name)) continue;
      const categoryPath = join(context.storePath, name);
      const category: CategoryContext = {
        store: context,
        kind,
        categoryPath,
        categoryIdentity: await this.canonicalDirectoryIdentity(
          categoryPath,
          true,
        ),
      };
      await this.assertCategoryHierarchy(category);
      const resources: OwnedResourceSnapshot[] = [];
      for (const resourceDigest of await readdir(categoryPath)) {
        if (!SHA256_PATTERN.test(resourceDigest)) {
          throw new ArtifactPathSecurityError(
            join(categoryPath, resourceDigest),
            "foreign child in runtime resource category",
          );
        }
        const resourcePath = join(categoryPath, resourceDigest);
        const markerPath = join(resourcePath, RESOURCE_MARKER);
        const resourceIdentity = await this.canonicalDirectoryIdentity(
          resourcePath,
          true,
        );
        const storedMarker = await this.readCanonicalJson(markerPath, () =>
          this.assertCategoryHierarchy(category),
        );
        let parsedMarker: RuntimeResourceMarkerV1;
        try {
          parsedMarker = parseResourceMarker(storedMarker);
        } catch (error) {
          throw new ArtifactCorruptionError(markerPath, error);
        }
        const resource: ResourceContext = {
          category,
          resourceId: parsedMarker.resourceId,
          resourceDigest,
          resourcePath,
          resourceIdentity,
        };
        if (
          parsedMarker.taskId !== contextTaskId(context) ||
          parsedMarker.resourceKind !== kind ||
          parsedMarker.resourceDigest !== resourceDigest ||
          runtimeResourceNamespaceDigestV1(
            contextTaskId(context),
            kind,
            parsedMarker.resourceId,
          ) !== resourceDigest
        ) {
          throw new ArtifactCorruptionError(
            markerPath,
            new Error("runtime resource marker ownership mismatch"),
          );
        }
        await this.assertResourceHierarchy(resource);
        await this.assertResourceEntries(resource);
        const files: OwnedFileSnapshot[] = [];
        for (const child of await readdir(resourcePath)) {
          files.push(
            await this.snapshotRegularFile(
              resource,
              join(resourcePath, child),
              child,
            ),
          );
        }
        if (files.some((file) => file.name === RESOURCE_RECORD)) {
          await this.readAndValidateResourceEnvelope(resource);
        }
        if (
          kind === "execution" &&
          (files.some((file) => file.name === EVENT_LEDGER) ||
            files.some((file) => file.name === EVENT_SEAL))
        ) {
          await this.readEventLedgerState(resource);
        }
        if (
          kind === "execution" &&
          files.some((file) => file.name === EVENT_SEAL) &&
          !files.some((file) => file.name === RESOURCE_RECORD)
        ) {
          throw new ArtifactCorruptionError(
            join(resourcePath, EVENT_SEAL),
            new Error(
              "sealed runtime execution is missing its terminal resource record",
            ),
          );
        }
        resources.push({
          context: resource,
          files: files.sort((left, right) =>
            left.name.localeCompare(right.name),
          ),
        });
      }
      categories.push({
        context: category,
        resources: resources.sort((left, right) =>
          left.context.resourceDigest.localeCompare(
            right.context.resourceDigest,
          ),
        ),
      });
    }
    return { context, marker, categories };
  }

  private async snapshotRegularFile(
    parent: RuntimeStoreContext | ResourceContext,
    path: string,
    name: string,
  ): Promise<OwnedFileSnapshot> {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
      throw new ArtifactPathSecurityError(
        path,
        "owned runtime-records child is not a single-link regular file",
      );
    }
    if ("storePath" in parent) {
      await this.assertStoreHierarchy(parent);
    } else {
      await this.assertResourceHierarchy(parent);
    }
    return { name, path, identity: identityOf(status) };
  }

  private async deleteOwnedSnapshot(
    snapshot: OwnedTreeSnapshot,
  ): Promise<void> {
    // The complete tree has been validated before this method unlinks anything.
    for (const category of snapshot.categories) {
      for (const resource of category.resources) {
        const payloads = resource.files.filter(
          (file) => file.name !== RESOURCE_MARKER,
        );
        for (const file of payloads) {
          await this.unlinkOwnedFile(file);
        }
        const marker = resource.files.find(
          (file) => file.name === RESOURCE_MARKER,
        );
        if (marker === undefined) {
          throw new ArtifactPathSecurityError(
            resource.context.resourcePath,
            "validated runtime resource marker disappeared from snapshot",
          );
        }
        await this.assertDirectoryContainsOnly(
          resource.context.resourcePath,
          resource.context.resourceIdentity,
          [RESOURCE_MARKER],
        );
        await this.unlinkOwnedFile(marker);
        await this.removeOwnedDirectory(
          resource.context.resourcePath,
          resource.context.resourceIdentity,
        );
        await this.syncDirectory(
          category.context.categoryPath,
          category.context.categoryIdentity,
        );
      }
      await this.assertDirectoryContainsOnly(
        category.context.categoryPath,
        category.context.categoryIdentity,
        [],
      );
      await this.removeOwnedDirectory(
        category.context.categoryPath,
        category.context.categoryIdentity,
      );
      await this.syncDirectory(
        snapshot.context.storePath,
        snapshot.context.storeIdentity,
      );
    }
    await this.assertDirectoryContainsOnly(
      snapshot.context.storePath,
      snapshot.context.storeIdentity,
      [STORE_MARKER],
    );
    await this.unlinkOwnedFile(snapshot.marker);
    await this.removeOwnedDirectory(
      snapshot.context.storePath,
      snapshot.context.storeIdentity,
    );
    await this.syncDirectory(
      snapshot.context.taskPath,
      snapshot.context.taskIdentity,
    );
    const taskId = contextTaskId(snapshot.context);
    this.contexts.delete(taskId);
    this.clearAppendStates(taskId);
  }

  private async assertDirectoryContainsOnly(
    path: string,
    expectedIdentity: FileIdentity,
    expectedNames: readonly string[],
  ): Promise<void> {
    const actualIdentity = await this.canonicalDirectoryIdentity(path, true);
    if (!sameIdentity(actualIdentity, expectedIdentity)) {
      throw new ArtifactPathSecurityError(
        path,
        "owned directory identity changed during discard",
      );
    }
    const actual = (await readdir(path)).sort();
    const expected = [...expectedNames].sort();
    if (
      actual.length !== expected.length ||
      actual.some((entry, index) => entry !== expected[index])
    ) {
      throw new ArtifactPathSecurityError(
        path,
        "owned directory changed after discard snapshot; refusing recursive deletion",
      );
    }
  }

  private async unlinkOwnedFile(file: OwnedFileSnapshot): Promise<void> {
    const status = await lstat(file.path);
    if (
      status.isSymbolicLink() ||
      !status.isFile() ||
      status.nlink !== 1 ||
      !sameIdentity(identityOf(status), file.identity)
    ) {
      throw new ArtifactPathSecurityError(
        file.path,
        "owned file identity changed during discard",
      );
    }
    await unlink(file.path);
  }

  private async removeOwnedDirectory(
    path: string,
    expectedIdentity: FileIdentity,
  ): Promise<void> {
    const status = await lstat(path);
    if (
      status.isSymbolicLink() ||
      !status.isDirectory() ||
      !sameIdentity(identityOf(status), expectedIdentity)
    ) {
      throw new ArtifactPathSecurityError(
        path,
        "owned directory identity changed before removal",
      );
    }
    try {
      await rmdir(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOTEMPTY") {
        throw new ArtifactPathSecurityError(
          path,
          "owned directory changed during discard; refusing recursive deletion",
        );
      }
      throw error;
    }
  }

  private async canonicalDirectoryIdentity(
    path: string,
    requirePrivateMode = false,
  ): Promise<FileIdentity> {
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
        "owned runtime directory mode must be exactly 0o700",
      );
    }
    return identityOf(status);
  }

  private async assertStoreHierarchy(
    expected: RuntimeStoreContext,
  ): Promise<void> {
    const actual: RuntimeStoreContext = {
      taskId: expected.taskId,
      rootPath: expected.rootPath,
      tasksPath: expected.tasksPath,
      taskPath: expected.taskPath,
      storePath: expected.storePath,
      rootIdentity: await this.canonicalDirectoryIdentity(expected.rootPath),
      tasksIdentity: await this.canonicalDirectoryIdentity(expected.tasksPath),
      taskIdentity: await this.canonicalDirectoryIdentity(expected.taskPath),
      storeIdentity: await this.canonicalDirectoryIdentity(
        expected.storePath,
        true,
      ),
    };
    if (!sameStoreContext(expected, actual)) {
      throw new ArtifactPathSecurityError(
        expected.storePath,
        "runtime-records hierarchy changed during I/O",
      );
    }
  }

  private async assertCategoryHierarchy(
    expected: CategoryContext,
  ): Promise<void> {
    await this.assertStoreHierarchy(expected.store);
    const identity = await this.canonicalDirectoryIdentity(
      expected.categoryPath,
      true,
    );
    if (!sameIdentity(identity, expected.categoryIdentity)) {
      throw new ArtifactPathSecurityError(
        expected.categoryPath,
        "runtime resource category changed during I/O",
      );
    }
  }

  private async assertResourceHierarchy(
    expected: ResourceContext,
  ): Promise<void> {
    await this.assertCategoryHierarchy(expected.category);
    const identity = await this.canonicalDirectoryIdentity(
      expected.resourcePath,
      true,
    );
    if (!sameIdentity(identity, expected.resourceIdentity)) {
      throw new ArtifactPathSecurityError(
        expected.resourcePath,
        "runtime resource directory changed during I/O",
      );
    }
  }

  private async readCanonicalJson(
    path: string,
    assertHierarchy: () => Promise<void>,
  ): Promise<JsonValue> {
    const bytes = await this.readRegularFile(
      path,
      assertHierarchy,
      VNEXT_RUNTIME_MAX_CANONICAL_JSON_BYTES,
    );
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

  private async readRegularFile(
    path: string,
    assertHierarchy: () => Promise<void>,
    maximumBytes: number,
  ): Promise<Buffer> {
    return (
      await this.readRegularFileSnapshot(path, assertHierarchy, maximumBytes)
    ).bytes;
  }

  private async readRegularFileSnapshot(
    path: string,
    assertHierarchy: () => Promise<void>,
    maximumBytes: number,
  ): Promise<BoundedFileRead> {
    await assertHierarchy();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const before = await lstat(path, { bigint: true });
      if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
        throw new ArtifactPathSecurityError(
          path,
          "runtime record is not a single-link regular file",
        );
      }
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const opened = await handle.stat({ bigint: true });
      const openedState = regularFileStateOf(opened);
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        before.dev !== opened.dev ||
        before.ino !== opened.ino
      ) {
        throw new ArtifactPathSecurityError(
          path,
          "runtime record identity changed while opening",
        );
      }
      if (opened.size > BigInt(maximumBytes)) {
        throw new ArtifactCorruptionError(
          path,
          new Error(
            `runtime record exceeds its ${maximumBytes}-byte allocation limit`,
          ),
        );
      }
      const byteLength = Number(opened.size);
      const bytes = Buffer.alloc(byteLength);
      let offset = 0;
      while (offset < byteLength) {
        const read = await handle.read(
          bytes,
          offset,
          byteLength - offset,
          offset,
        );
        if (read.bytesRead === 0) {
          throw new ArtifactPathSecurityError(
            path,
            "runtime record shrank while reading",
          );
        }
        offset += read.bytesRead;
      }
      const probe = Buffer.allocUnsafe(1);
      if ((await handle.read(probe, 0, 1, byteLength)).bytesRead !== 0) {
        throw new ArtifactPathSecurityError(
          path,
          "runtime record grew beyond its checked size while reading",
        );
      }
      const afterOpen = regularFileStateOf(await handle.stat({ bigint: true }));
      if (!sameRegularFileState(openedState, afterOpen)) {
        throw new ArtifactPathSecurityError(
          path,
          "runtime record changed while reading",
        );
      }
      await assertHierarchy();
      const after = await lstat(path, { bigint: true });
      const afterState = regularFileStateOf(after);
      if (
        after.isSymbolicLink() ||
        !after.isFile() ||
        after.nlink !== 1n ||
        !sameRegularFileState(afterState, afterOpen)
      ) {
        throw new ArtifactPathSecurityError(
          path,
          "runtime record identity changed while reading",
        );
      }
      return { bytes, file: afterState };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new ArtifactNotFoundError(path);
      }
      if (isNodeError(error) && error.code === "ELOOP") {
        throw new ArtifactPathSecurityError(
          path,
          "runtime record symlink rejected",
        );
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async writeImmutableBytes(
    directoryPath: string,
    directoryIdentity: FileIdentity,
    path: string,
    bytes: Buffer,
    assertHierarchy: () => Promise<void>,
  ): Promise<void> {
    if (bytes.byteLength > VNEXT_RUNTIME_MAX_CANONICAL_JSON_BYTES) {
      throw new ArtifactCorruptionError(
        path,
        new Error(
          `runtime record exceeds its ${VNEXT_RUNTIME_MAX_CANONICAL_JSON_BYTES}-byte persistence limit`,
        ),
      );
    }
    await assertHierarchy();
    const temporaryPath = join(
      directoryPath,
      `.chronorift-runtime-stage-${randomUUID()}.tmp`,
    );
    let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryIdentity: FileIdentity | undefined;
    try {
      temporaryHandle = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      const status = await temporaryHandle.stat();
      if (!status.isFile()) {
        throw new ArtifactPathSecurityError(
          temporaryPath,
          "staged runtime record is not a regular file",
        );
      }
      temporaryIdentity = identityOf(status);
      await temporaryHandle.writeFile(bytes);
      await temporaryHandle.sync();
      await assertHierarchy();
      try {
        await link(temporaryPath, path);
        const published = await lstat(path);
        if (
          published.isSymbolicLink() ||
          !published.isFile() ||
          !sameIdentity(identityOf(published), temporaryIdentity)
        ) {
          throw new ArtifactPathSecurityError(
            path,
            "published runtime record does not match staged inode",
          );
        }
        await this.syncDirectory(directoryPath, directoryIdentity);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        const existing = await this.readRegularFile(
          path,
          assertHierarchy,
          VNEXT_RUNTIME_MAX_CANONICAL_JSON_BYTES,
        );
        if (!existing.equals(bytes)) {
          throw new ImmutableArtifactConflictError(path);
        }
      }
    } finally {
      await temporaryHandle?.close();
      if (temporaryIdentity !== undefined) {
        try {
          const staged = await lstat(temporaryPath);
          if (
            staged.isSymbolicLink() ||
            !staged.isFile() ||
            !sameIdentity(identityOf(staged), temporaryIdentity)
          ) {
            throw new ArtifactPathSecurityError(
              temporaryPath,
              "staged runtime record changed before cleanup",
            );
          }
          await unlink(temporaryPath);
          await this.syncDirectory(directoryPath, directoryIdentity);
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        }
      }
    }
  }

  private async appendLine(
    resource: ResourceContext,
    path: string,
    line: Buffer,
    expected: RegularFileState | undefined,
  ): Promise<RegularFileState> {
    await this.assertResourceHierarchy(resource);
    const sealPath = join(resource.resourcePath, EVENT_SEAL);
    if (
      await this.regularFileExists(sealPath, () =>
        this.assertResourceHierarchy(resource),
      )
    ) {
      throw new RuntimeExecutionSealedError(resource.resourceId);
    }
    let before: RegularFileState | undefined;
    try {
      const status = await lstat(path, { bigint: true });
      if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1n) {
        throw new ArtifactPathSecurityError(
          path,
          "runtime event ledger is not a single-link regular file",
        );
      }
      before = regularFileStateOf(status);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    if (
      (expected === undefined) !== (before === undefined) ||
      (expected !== undefined &&
        before !== undefined &&
        !sameRegularFileState(expected, before))
    ) {
      throw new ArtifactPathSecurityError(
        path,
        "runtime event ledger changed after its bounded append state was validated",
      );
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NOFOLLOW,
        0o600,
      );
      const opened = await handle.stat({ bigint: true });
      const openedState = regularFileStateOf(opened);
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        (before !== undefined && !sameRegularFileState(before, openedState))
      ) {
        throw new ArtifactPathSecurityError(
          path,
          "runtime event ledger identity is unsafe for append",
        );
      }
      await handle.writeFile(line);
      await handle.sync();
      await this.assertResourceHierarchy(resource);
      const after = await lstat(path, { bigint: true });
      const afterState = regularFileStateOf(after);
      if (
        after.isSymbolicLink() ||
        !after.isFile() ||
        after.nlink !== 1n ||
        !sameRegularFileIdentity(afterState, openedState) ||
        afterState.size !== openedState.size + BigInt(line.byteLength)
      ) {
        throw new ArtifactPathSecurityError(
          path,
          "runtime event ledger changed during append",
        );
      }
      await this.syncDirectory(
        resource.resourcePath,
        resource.resourceIdentity,
      );
      return afterState;
    } catch (error) {
      if (isNodeError(error) && error.code === "ELOOP") {
        throw new ArtifactPathSecurityError(
          path,
          "event ledger symlink rejected",
        );
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async regularFileExists(
    path: string,
    assertHierarchy: () => Promise<void>,
  ): Promise<boolean> {
    await assertHierarchy();
    try {
      const status = await lstat(path);
      if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
        throw new ArtifactPathSecurityError(
          path,
          "runtime record is not a single-link regular file",
        );
      }
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private async syncDirectory(
    path: string,
    expectedIdentity: FileIdentity,
  ): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const status = await handle.stat();
      if (
        !status.isDirectory() ||
        !sameIdentity(identityOf(status), expectedIdentity)
      ) {
        throw new ArtifactPathSecurityError(
          path,
          "directory identity changed before fsync",
        );
      }
      await handle.sync();
    } catch (error) {
      if (isNodeError(error) && error.code === "ELOOP") {
        throw new ArtifactPathSecurityError(path, "directory symlink rejected");
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private lifecycleFor(taskId: TaskId): TaskLifecycleState {
    const current = this.taskLifecycles.get(taskId);
    if (current !== undefined) return current;
    const created: TaskLifecycleState = {
      activeOperations: 0,
      phase: "open",
      drainWaiters: new Set(),
      discardAttempt: undefined,
    };
    this.taskLifecycles.set(taskId, created);
    return created;
  }

  private runTaskOperation<T>(
    taskId: TaskId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lifecycle = this.lifecycleFor(taskId);
    if (lifecycle.phase !== "open") {
      return Promise.reject(
        new ArtifactPathSecurityError(
          this.storePathFor(taskId),
          "runtime-records discard has begun; new operations are rejected",
        ),
      );
    }
    lifecycle.activeOperations += 1;
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        lifecycle.activeOperations -= 1;
        if (lifecycle.activeOperations === 0) {
          for (const waiter of lifecycle.drainWaiters) waiter();
          lifecycle.drainWaiters.clear();
        }
      });
  }

  private waitForTaskOperations(lifecycle: TaskLifecycleState): Promise<void> {
    if (lifecycle.activeOperations === 0) return Promise.resolve();
    return new Promise((resolveWaiter) => {
      lifecycle.drainWaiters.add(resolveWaiter);
    });
  }

  private enqueueTask<T>(
    taskId: TaskId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = taskNamespaceDigestV1(taskId);
    const previous = this.taskQueues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.taskQueues.set(key, settled);
    void settled.finally(() => {
      if (this.taskQueues.get(key) === settled) this.taskQueues.delete(key);
    });
    return result;
  }
}

function contextTaskId(context: RuntimeStoreContext): TaskId {
  return context.taskId;
}
