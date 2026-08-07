import { createHash, randomUUID } from "node:crypto";
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

import { canonicalJson, contentHash } from "./canonical-json.js";
import {
  ArtifactCorruptionError,
  ArtifactNotFoundError,
} from "./json-artifact-repository.js";
import {
  ArtifactPathSecurityError,
  ImmutableArtifactConflictError,
} from "./v01-json-artifact-repository.js";

export type VNextTaskJsonSlot =
  | "task.json"
  | "workspace.json"
  | "fixture-capability.json"
  | "sandbox-capability.json"
  | "sandbox-toolchain.json"
  | "sandbox-policy.json"
  | "patch.json";

export type VNextTaskBytesSlot = "patch.diff";

export type VNextTaskLedgerSlot =
  | "task-events.jsonl"
  | "sandbox-preflight.jsonl"
  | "sandbox-operations.jsonl"
  | "security.jsonl"
  | "exports.jsonl";

export interface TaskLedgerEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly previousRecordHash: string | null;
  readonly payload: JsonValue;
  readonly recordHash: string;
}

export interface TaskLedgerSealV1 {
  readonly schemaVersion: 1;
  readonly recordCount: number;
  readonly finalRecordHash: string | null;
  readonly ledgerByteLength: number;
  readonly ledgerSha256: string;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface TaskBaseContext {
  readonly rootPath: string;
  readonly tasksPath: string;
  readonly taskPath: string;
  readonly rootIdentity: FileIdentity;
  readonly tasksIdentity: FileIdentity;
  readonly taskIdentity: FileIdentity;
}

interface TaskStoreContext extends TaskBaseContext {
  readonly recordsPath: string;
  readonly recordsIdentity: FileIdentity;
}

interface StoreMarkerV1 {
  readonly schemaVersion: 1;
  readonly storeKind: "chronorift-vnext-task-records";
  readonly taskId: string;
  readonly taskNamespaceDigest: string;
}

interface LedgerState {
  readonly bytes: Buffer;
  readonly envelopes: readonly TaskLedgerEnvelopeV1[];
  readonly seal: TaskLedgerSealV1 | undefined;
}

interface TaskLifecycleState {
  activeWrites: number;
  phase: "open" | "discarding" | "discarded";
  readonly drainWaiters: Set<() => void>;
  discardAttempt: Promise<void> | undefined;
  recordsRemovedContext: TaskStoreContext | undefined;
}

const STORE_MARKER = ".chronorift-vnext-task-store-v1.json";
const JSON_SLOTS: readonly VNextTaskJsonSlot[] = [
  "task.json",
  "workspace.json",
  "fixture-capability.json",
  "sandbox-capability.json",
  "sandbox-toolchain.json",
  "sandbox-policy.json",
  "patch.json",
];
const BYTES_SLOTS: readonly VNextTaskBytesSlot[] = ["patch.diff"];
const LEDGER_SLOTS: readonly VNextTaskLedgerSlot[] = [
  "task-events.jsonl",
  "sandbox-preflight.jsonl",
  "sandbox-operations.jsonl",
  "security.jsonl",
  "exports.jsonl",
];
const JSON_SLOT_SET = new Set<string>(JSON_SLOTS);
const BYTES_SLOT_SET = new Set<string>(BYTES_SLOTS);
const LEDGER_SLOT_SET = new Set<string>(LEDGER_SLOTS);
const OWNED_RECORD_NAMES = new Set<string>([
  STORE_MARKER,
  ...JSON_SLOTS,
  ...BYTES_SLOTS,
  ...LEDGER_SLOTS,
  ...LEDGER_SLOTS.map((slot) => `${slot}.seal.json`),
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function parseStoreMarker(input: unknown): StoreMarkerV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "storeKind",
      "taskId",
      "taskNamespaceDigest",
    ]) ||
    input.schemaVersion !== 1 ||
    input.storeKind !== "chronorift-vnext-task-records" ||
    typeof input.taskId !== "string" ||
    !isSha256(input.taskNamespaceDigest)
  ) {
    throw new Error("invalid vNext Task store marker");
  }
  return {
    schemaVersion: 1,
    storeKind: "chronorift-vnext-task-records",
    taskId: input.taskId,
    taskNamespaceDigest: input.taskNamespaceDigest,
  };
}

function parseEnvelope(input: unknown): TaskLedgerEnvelopeV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "sequence",
      "previousRecordHash",
      "payload",
      "recordHash",
    ]) ||
    input.schemaVersion !== 1 ||
    !isNonnegativeSafeInteger(input.sequence) ||
    !(
      input.previousRecordHash === null || isSha256(input.previousRecordHash)
    ) ||
    !isSha256(input.recordHash)
  ) {
    throw new Error("invalid Task ledger envelope");
  }
  return {
    schemaVersion: 1,
    sequence: input.sequence,
    previousRecordHash: input.previousRecordHash,
    payload: JsonValueSchema.parse(input.payload),
    recordHash: input.recordHash,
  };
}

function parseSeal(input: unknown): TaskLedgerSealV1 {
  if (
    !isObject(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "recordCount",
      "finalRecordHash",
      "ledgerByteLength",
      "ledgerSha256",
    ]) ||
    input.schemaVersion !== 1 ||
    !isNonnegativeSafeInteger(input.recordCount) ||
    !(input.finalRecordHash === null || isSha256(input.finalRecordHash)) ||
    !isNonnegativeSafeInteger(input.ledgerByteLength) ||
    !isSha256(input.ledgerSha256)
  ) {
    throw new Error("invalid Task ledger seal");
  }
  return {
    schemaVersion: 1,
    recordCount: input.recordCount,
    finalRecordHash: input.finalRecordHash,
    ledgerByteLength: input.ledgerByteLength,
    ledgerSha256: input.ledgerSha256,
  };
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

function contextIdentityMatches(
  left: TaskStoreContext,
  right: TaskStoreContext,
): boolean {
  return (
    left.rootPath === right.rootPath &&
    left.tasksPath === right.tasksPath &&
    left.taskPath === right.taskPath &&
    left.recordsPath === right.recordsPath &&
    sameIdentity(left.rootIdentity, right.rootIdentity) &&
    sameIdentity(left.tasksIdentity, right.tasksIdentity) &&
    sameIdentity(left.taskIdentity, right.taskIdentity) &&
    sameIdentity(left.recordsIdentity, right.recordsIdentity)
  );
}

export class TaskLedgerSealedError extends Error {
  public constructor(readonly ledgerPath: string) {
    super(`Task ledger is sealed: ${ledgerPath}`);
    this.name = "TaskLedgerSealedError";
  }
}

/**
 * Host-side persistence for the vNext Task records directory.
 *
 * The adapter deliberately owns only `records/` and its marker. The Task root
 * and every sibling beneath it are lifecycle-owned by the Host coordinator.
 */
export class VNextTaskStore {
  public readonly runtimeRoot: string;
  private readonly contexts = new Map<string, TaskStoreContext>();
  private readonly ledgerQueues = new Map<string, Promise<void>>();
  private readonly taskLifecycles = new Map<string, TaskLifecycleState>();

  public constructor(runtimeRoot: string) {
    this.runtimeRoot = resolve(runtimeRoot);
  }

  public async create(taskId: TaskId): Promise<void> {
    return this.runTaskWrite(taskId, () => this.createUnlocked(taskId));
  }

  private async createUnlocked(taskId: TaskId): Promise<void> {
    const base = await this.inspectTaskBase(taskId);
    const recordsPath = join(base.taskPath, "records");
    let created = false;
    try {
      await this.canonicalDirectoryIdentity(recordsPath, true);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      try {
        await mkdir(recordsPath, { mode: 0o700 });
        created = true;
      } catch (mkdirError) {
        if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") {
          throw mkdirError;
        }
      }
    }

    const context = await this.inspectTaskContext(taskId);
    if (
      !sameIdentity(base.rootIdentity, context.rootIdentity) ||
      !sameIdentity(base.tasksIdentity, context.tasksIdentity) ||
      !sameIdentity(base.taskIdentity, context.taskIdentity)
    ) {
      throw new ArtifactPathSecurityError(
        recordsPath,
        "Task directory hierarchy changed while creating records",
      );
    }
    if (created) {
      await this.syncDirectory(context.taskPath, context.taskIdentity);
    }

    const entries = await readdir(context.recordsPath);
    const marker = this.markerFor(taskId);
    if (entries.length === 0) {
      await this.writeImmutableBytes(
        context,
        join(context.recordsPath, STORE_MARKER),
        canonicalBytes(asJsonValue(marker)),
      );
    } else {
      if (!entries.includes(STORE_MARKER)) {
        throw new ArtifactPathSecurityError(
          context.recordsPath,
          "records must be empty before its store marker is published",
        );
      }
      await this.assertOwnedEntries(context, entries);
      await this.assertMarker(context, taskId);
    }

    const previous = this.contexts.get(taskId);
    if (previous !== undefined && !contextIdentityMatches(previous, context)) {
      throw new ArtifactPathSecurityError(
        context.recordsPath,
        "Task store directory changed since it was opened",
      );
    }
    this.contexts.set(taskId, context);
  }

  public async putJsonOnce<T>(
    taskId: TaskId,
    slot: VNextTaskJsonSlot,
    value: T,
    parse: (input: unknown) => T,
  ): Promise<void> {
    this.assertJsonSlot(slot);
    return this.runTaskWrite(taskId, async () => {
      const parsed = asJsonValue(parse(value));
      const bytes = canonicalBytes(parsed);
      const context = await this.requireContext(taskId);
      await this.writeImmutableBytes(
        context,
        join(context.recordsPath, slot),
        bytes,
      );
    });
  }

  public async readJson<T>(
    taskId: TaskId,
    slot: VNextTaskJsonSlot,
    parse: (input: unknown) => T,
  ): Promise<T> {
    this.assertJsonSlot(slot);
    const context = await this.requireContext(taskId);
    const path = join(context.recordsPath, slot);
    const stored = await this.readCanonicalJson(context, path);
    try {
      const parsed = parse(stored);
      asJsonValue(parsed);
      return parsed;
    } catch (error) {
      throw new ArtifactCorruptionError(path, error);
    }
  }

  public async putBytesOnce(
    taskId: TaskId,
    slot: VNextTaskBytesSlot,
    bytes: Uint8Array,
  ): Promise<void> {
    this.assertBytesSlot(slot);
    return this.runTaskWrite(taskId, async () => {
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError("Task store bytes must be a Uint8Array");
      }
      const ownedBytes = Buffer.from(bytes);
      const context = await this.requireContext(taskId);
      await this.writeImmutableBytes(
        context,
        join(context.recordsPath, slot),
        ownedBytes,
      );
    });
  }

  public async readBytes(
    taskId: TaskId,
    slot: VNextTaskBytesSlot,
  ): Promise<Uint8Array> {
    this.assertBytesSlot(slot);
    const context = await this.requireContext(taskId);
    const bytes = await this.readRegularFile(
      context,
      join(context.recordsPath, slot),
    );
    return Uint8Array.from(bytes);
  }

  public async append<T>(
    taskId: TaskId,
    slot: VNextTaskLedgerSlot,
    payload: T,
    parse: (input: unknown) => T,
  ): Promise<TaskLedgerEnvelopeV1> {
    this.assertLedgerSlot(slot);
    return this.runTaskWrite(taskId, async () => {
      const validatedPayload = asJsonValue(parse(payload));
      const ownedPayload = asJsonValue(
        JSON.parse(canonicalJson(validatedPayload)) as unknown,
      );
      return this.enqueueLedger(taskId, slot, async () => {
        const context = await this.requireContext(taskId);
        const ledgerPath = join(context.recordsPath, slot);
        const sealPath = this.sealPath(context, slot);
        if (await this.regularFileExists(context, sealPath)) {
          throw new TaskLedgerSealedError(ledgerPath);
        }

        const state = await this.readLedgerState(context, slot);
        const previous = state.envelopes.at(-1)?.recordHash ?? null;
        const basis = {
          schemaVersion: 1 as const,
          sequence: state.envelopes.length,
          previousRecordHash: previous,
          payload: ownedPayload,
        };
        const envelope: TaskLedgerEnvelopeV1 = {
          ...basis,
          recordHash: contentHash(asJsonValue(basis)),
        };
        await this.appendLine(
          context,
          ledgerPath,
          canonicalBytes(asJsonValue(envelope)),
          sealPath,
        );
        return envelope;
      });
    });
  }

  public async seal(
    taskId: TaskId,
    slot: VNextTaskLedgerSlot,
  ): Promise<TaskLedgerSealV1> {
    this.assertLedgerSlot(slot);
    return this.runTaskWrite(taskId, () =>
      this.enqueueLedger(taskId, slot, async () => {
        const context = await this.requireContext(taskId);
        const state = await this.readLedgerState(context, slot);
        if (state.seal !== undefined) return state.seal;

        const seal: TaskLedgerSealV1 = {
          schemaVersion: 1,
          recordCount: state.envelopes.length,
          finalRecordHash: state.envelopes.at(-1)?.recordHash ?? null,
          ledgerByteLength: state.bytes.byteLength,
          ledgerSha256: sha256(state.bytes),
        };
        await this.writeImmutableBytes(
          context,
          this.sealPath(context, slot),
          canonicalBytes(asJsonValue(seal)),
        );
        return seal;
      }),
    );
  }

  public async readLedger<T>(
    taskId: TaskId,
    slot: VNextTaskLedgerSlot,
    parse: (input: unknown) => T,
  ): Promise<readonly T[]> {
    this.assertLedgerSlot(slot);
    return this.enqueueLedger(taskId, slot, async () => {
      const context = await this.requireContext(taskId);
      const path = join(context.recordsPath, slot);
      const state = await this.readLedgerState(context, slot);
      try {
        return state.envelopes.map((envelope) => {
          const parsed = parse(envelope.payload);
          asJsonValue(parsed);
          return parsed;
        });
      } catch (error) {
        throw new ArtifactCorruptionError(path, error);
      }
    });
  }

  /** Remove only adapter-owned records; Task-root teardown belongs to the CLI. */
  public async discard(taskId: TaskId): Promise<void> {
    const lifecycle = this.lifecycleFor(taskId);
    if (lifecycle.phase === "discarded") {
      return Promise.reject(
        new ArtifactNotFoundError(this.recordsPathFor(taskId)),
      );
    }
    if (lifecycle.discardAttempt !== undefined) {
      return lifecycle.discardAttempt;
    }
    lifecycle.phase = "discarding";
    const operation = (async () => {
      await this.waitForTaskWrites(lifecycle);
      await this.discardUnlocked(taskId, lifecycle);
      lifecycle.phase = "discarded";
    })();
    const tracked = operation.then(
      () => {
        lifecycle.discardAttempt = undefined;
      },
      (error: unknown) => {
        lifecycle.discardAttempt = undefined;
        throw error;
      },
    );
    lifecycle.discardAttempt = tracked;
    return tracked;
  }

  private async discardUnlocked(
    taskId: TaskId,
    lifecycle: TaskLifecycleState,
  ): Promise<void> {
    if (lifecycle.recordsRemovedContext !== undefined) {
      const removed = lifecycle.recordsRemovedContext;
      await this.syncDirectory(removed.taskPath, removed.taskIdentity);
      this.contexts.delete(taskId);
      lifecycle.recordsRemovedContext = undefined;
      return;
    }
    const context = await this.requireContext(taskId);
    const entries = await readdir(context.recordsPath);
    const remaining = new Map(await this.assertOwnedEntries(context, entries));
    await this.assertOwnedSnapshot(context, remaining);

    const ownedPayloads = [...remaining.keys()]
      .filter((entry) => entry !== STORE_MARKER)
      .sort();
    for (const entry of ownedPayloads) {
      await this.assertOwnedSnapshot(context, remaining);
      const identity = remaining.get(entry);
      if (identity === undefined) {
        throw new ArtifactPathSecurityError(
          join(context.recordsPath, entry),
          "owned record disappeared from the discard snapshot",
        );
      }
      await this.unlinkOwnedFile(
        context,
        join(context.recordsPath, entry),
        identity,
      );
      remaining.delete(entry);
    }
    await this.assertOwnedSnapshot(context, remaining);
    const markerIdentity = remaining.get(STORE_MARKER);
    if (markerIdentity === undefined || remaining.size !== 1) {
      throw new ArtifactPathSecurityError(
        context.recordsPath,
        "discard did not retain exactly the known ownership marker",
      );
    }
    await this.unlinkOwnedFile(
      context,
      join(context.recordsPath, STORE_MARKER),
      markerIdentity,
    );
    await this.assertContext(context);
    try {
      await rmdir(context.recordsPath);
    } catch (error) {
      try {
        await this.writeImmutableBytes(
          context,
          join(context.recordsPath, STORE_MARKER),
          canonicalBytes(asJsonValue(this.markerFor(taskId))),
        );
      } catch (restoreError) {
        throw new ArtifactPathSecurityError(
          context.recordsPath,
          `records cleanup failed and its ownership marker could not be restored: ${
            restoreError instanceof Error
              ? restoreError.message
              : String(restoreError)
          }`,
        );
      }
      if (isNodeError(error) && error.code === "ENOTEMPTY") {
        throw new ArtifactPathSecurityError(
          context.recordsPath,
          "records changed during discard; refusing recursive deletion",
        );
      }
      throw error;
    }
    lifecycle.recordsRemovedContext = context;
    await this.syncDirectory(context.taskPath, context.taskIdentity);
    this.contexts.delete(taskId);
    lifecycle.recordsRemovedContext = undefined;
  }

  private recordsPathFor(taskId: TaskId): string {
    return join(
      this.runtimeRoot,
      "tasks",
      taskNamespaceDigestV1(taskId),
      "records",
    );
  }

  private lifecycleFor(taskId: TaskId): TaskLifecycleState {
    const current = this.taskLifecycles.get(taskId);
    if (current !== undefined) return current;
    const created: TaskLifecycleState = {
      activeWrites: 0,
      phase: "open",
      drainWaiters: new Set(),
      discardAttempt: undefined,
      recordsRemovedContext: undefined,
    };
    this.taskLifecycles.set(taskId, created);
    return created;
  }

  private runTaskWrite<T>(
    taskId: TaskId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lifecycle = this.lifecycleFor(taskId);
    if (lifecycle.phase !== "open") {
      return Promise.reject(
        new ArtifactPathSecurityError(
          this.recordsPathFor(taskId),
          "Task store discard has begun; new writes are rejected",
        ),
      );
    }
    lifecycle.activeWrites += 1;
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        lifecycle.activeWrites -= 1;
        if (lifecycle.activeWrites === 0) {
          for (const resolveWaiter of lifecycle.drainWaiters) resolveWaiter();
          lifecycle.drainWaiters.clear();
        }
      });
  }

  private waitForTaskWrites(lifecycle: TaskLifecycleState): Promise<void> {
    if (lifecycle.activeWrites === 0) return Promise.resolve();
    return new Promise((resolveWaiter) => {
      lifecycle.drainWaiters.add(resolveWaiter);
    });
  }

  private assertJsonSlot(slot: VNextTaskJsonSlot): void {
    if (typeof slot !== "string" || !JSON_SLOT_SET.has(slot)) {
      throw new ArtifactPathSecurityError(
        typeof slot === "string" ? slot : "<non-string slot>",
        "unsupported vNext Task JSON slot",
      );
    }
  }

  private assertBytesSlot(slot: VNextTaskBytesSlot): void {
    if (typeof slot !== "string" || !BYTES_SLOT_SET.has(slot)) {
      throw new ArtifactPathSecurityError(
        typeof slot === "string" ? slot : "<non-string slot>",
        "unsupported vNext Task bytes slot",
      );
    }
  }

  private assertLedgerSlot(slot: VNextTaskLedgerSlot): void {
    if (typeof slot !== "string" || !LEDGER_SLOT_SET.has(slot)) {
      throw new ArtifactPathSecurityError(
        typeof slot === "string" ? slot : "<non-string slot>",
        "unsupported vNext Task ledger slot",
      );
    }
  }

  private markerFor(taskId: TaskId): StoreMarkerV1 {
    return {
      schemaVersion: 1,
      storeKind: "chronorift-vnext-task-records",
      taskId,
      taskNamespaceDigest: taskNamespaceDigestV1(taskId),
    };
  }

  private async inspectTaskBase(taskId: TaskId): Promise<TaskBaseContext> {
    const rootPath = this.runtimeRoot;
    const tasksPath = join(rootPath, "tasks");
    const taskPath = join(tasksPath, taskNamespaceDigestV1(taskId));
    try {
      return {
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

  private async inspectTaskContext(taskId: TaskId): Promise<TaskStoreContext> {
    const base = await this.inspectTaskBase(taskId);
    const recordsPath = join(base.taskPath, "records");
    try {
      return {
        ...base,
        recordsPath,
        recordsIdentity: await this.canonicalDirectoryIdentity(
          recordsPath,
          true,
        ),
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new ArtifactNotFoundError(recordsPath);
      }
      throw error;
    }
  }

  private async requireContext(taskId: TaskId): Promise<TaskStoreContext> {
    const current = await this.inspectTaskContext(taskId);
    const expected = this.contexts.get(taskId);
    if (expected !== undefined && !contextIdentityMatches(expected, current)) {
      throw new ArtifactPathSecurityError(
        current.recordsPath,
        "Task store directory changed since it was opened",
      );
    }
    await this.assertMarker(current, taskId);
    if (expected === undefined) this.contexts.set(taskId, current);
    return current;
  }

  private async assertMarker(
    context: TaskStoreContext,
    taskId: TaskId,
  ): Promise<void> {
    const path = join(context.recordsPath, STORE_MARKER);
    const value = await this.readCanonicalJson(context, path);
    let marker: StoreMarkerV1;
    try {
      marker = parseStoreMarker(value);
    } catch (error) {
      throw new ArtifactCorruptionError(path, error);
    }
    const expected = this.markerFor(taskId);
    if (
      marker.taskId !== expected.taskId ||
      marker.taskNamespaceDigest !== expected.taskNamespaceDigest
    ) {
      throw new ArtifactCorruptionError(
        path,
        new Error("Task store marker belongs to a different Task"),
      );
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
        "records directory mode must be exactly 0o700",
      );
    }
    return identityOf(status);
  }

  private async assertContext(expected: TaskStoreContext): Promise<void> {
    const actual: TaskStoreContext = {
      rootPath: expected.rootPath,
      tasksPath: expected.tasksPath,
      taskPath: expected.taskPath,
      recordsPath: expected.recordsPath,
      rootIdentity: await this.canonicalDirectoryIdentity(expected.rootPath),
      tasksIdentity: await this.canonicalDirectoryIdentity(expected.tasksPath),
      taskIdentity: await this.canonicalDirectoryIdentity(expected.taskPath),
      recordsIdentity: await this.canonicalDirectoryIdentity(
        expected.recordsPath,
        true,
      ),
    };
    if (!contextIdentityMatches(expected, actual)) {
      throw new ArtifactPathSecurityError(
        expected.recordsPath,
        "Task store hierarchy changed during I/O",
      );
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

  private async readRegularFile(
    context: TaskStoreContext,
    path: string,
  ): Promise<Buffer> {
    await this.assertContext(context);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const before = await lstat(path);
      if (before.isSymbolicLink() || !before.isFile()) {
        throw new ArtifactPathSecurityError(
          path,
          "record is not a regular file",
        );
      }
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        !sameIdentity(identityOf(before), identityOf(opened))
      ) {
        throw new ArtifactPathSecurityError(
          path,
          "record identity changed while opening",
        );
      }
      const bytes = await handle.readFile();
      await this.assertContext(context);
      const after = await lstat(path);
      if (
        after.isSymbolicLink() ||
        !after.isFile() ||
        !sameIdentity(identityOf(after), identityOf(opened))
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

  private async readCanonicalJson(
    context: TaskStoreContext,
    path: string,
  ): Promise<JsonValue> {
    const bytes = await this.readRegularFile(context, path);
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

  private async writeImmutableBytes(
    context: TaskStoreContext,
    path: string,
    bytes: Buffer,
  ): Promise<void> {
    await this.assertContext(context);
    const temporaryPath = join(
      context.recordsPath,
      `.chronorift-stage-${randomUUID()}.tmp`,
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
          "staged record is not a regular file",
        );
      }
      temporaryIdentity = identityOf(status);
      await temporaryHandle.writeFile(bytes);
      await temporaryHandle.sync();
      await this.assertContext(context);
      const staged = await lstat(temporaryPath);
      if (
        staged.isSymbolicLink() ||
        !staged.isFile() ||
        !sameIdentity(identityOf(staged), temporaryIdentity)
      ) {
        throw new ArtifactPathSecurityError(
          temporaryPath,
          "staged record identity changed before publication",
        );
      }

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
            "published record does not match the staged inode",
          );
        }
        await this.assertContext(context);
        await this.syncDirectory(context.recordsPath, context.recordsIdentity);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        const existing = await this.readRegularFile(context, path);
        if (!existing.equals(bytes)) {
          throw new ImmutableArtifactConflictError(path);
        }
      }
    } finally {
      await temporaryHandle?.close();
      if (temporaryIdentity !== undefined) {
        await this.unlinkStagedFile(context, temporaryPath, temporaryIdentity);
      }
    }
  }

  private async unlinkStagedFile(
    context: TaskStoreContext,
    path: string,
    expectedIdentity: FileIdentity,
  ): Promise<void> {
    await this.assertContext(context);
    try {
      const status = await lstat(path);
      if (
        status.isSymbolicLink() ||
        !status.isFile() ||
        !sameIdentity(identityOf(status), expectedIdentity)
      ) {
        throw new ArtifactPathSecurityError(
          path,
          "staged record identity changed before cleanup",
        );
      }
      await unlink(path);
      await this.assertContext(context);
      await this.syncDirectory(context.recordsPath, context.recordsIdentity);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }

  private async regularFileExists(
    context: TaskStoreContext,
    path: string,
  ): Promise<boolean> {
    await this.assertContext(context);
    try {
      const status = await lstat(path);
      if (status.isSymbolicLink() || !status.isFile()) {
        throw new ArtifactPathSecurityError(
          path,
          "record is not a regular file",
        );
      }
      await this.assertContext(context);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private async appendLine(
    context: TaskStoreContext,
    ledgerPath: string,
    line: Buffer,
    sealPath: string,
  ): Promise<void> {
    await this.assertContext(context);
    if (await this.regularFileExists(context, sealPath)) {
      throw new TaskLedgerSealedError(ledgerPath);
    }

    let before: FileIdentity | undefined;
    try {
      const status = await lstat(ledgerPath);
      if (status.isSymbolicLink() || !status.isFile()) {
        throw new ArtifactPathSecurityError(
          ledgerPath,
          "ledger is not a regular file",
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
          "ledger identity or link count is unsafe for append",
        );
      }
      await this.assertContext(context);
      await handle.writeFile(line);
      await handle.sync();
      await this.assertContext(context);
      const after = await lstat(ledgerPath);
      if (
        after.isSymbolicLink() ||
        !after.isFile() ||
        !sameIdentity(identityOf(after), identityOf(opened))
      ) {
        throw new ArtifactPathSecurityError(
          ledgerPath,
          "ledger identity changed during append",
        );
      }
      await this.syncDirectory(context.recordsPath, context.recordsIdentity);
    } catch (error) {
      if (isNodeError(error) && error.code === "ELOOP") {
        throw new ArtifactPathSecurityError(
          ledgerPath,
          "ledger symlink rejected by O_NOFOLLOW",
        );
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async readLedgerState(
    context: TaskStoreContext,
    slot: VNextTaskLedgerSlot,
  ): Promise<LedgerState> {
    const ledgerPath = join(context.recordsPath, slot);
    let bytes: Buffer;
    try {
      bytes = await this.readRegularFile(context, ledgerPath);
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) {
        bytes = Buffer.alloc(0);
      } else {
        throw error;
      }
    }
    const envelopes = this.parseLedgerBytes(ledgerPath, bytes);
    const sealPath = this.sealPath(context, slot);
    let seal: TaskLedgerSealV1 | undefined;
    try {
      const sealJson = await this.readCanonicalJson(context, sealPath);
      try {
        seal = parseSeal(sealJson);
      } catch (error) {
        throw new ArtifactCorruptionError(sealPath, error);
      }
    } catch (error) {
      if (!(error instanceof ArtifactNotFoundError)) throw error;
    }
    if (seal !== undefined) {
      this.assertSealMatches(sealPath, seal, bytes, envelopes);
    }
    return { bytes, envelopes, seal };
  }

  private parseLedgerBytes(
    ledgerPath: string,
    bytes: Buffer,
  ): readonly TaskLedgerEnvelopeV1[] {
    if (bytes.byteLength === 0) return [];
    try {
      const text = bytes.toString("utf8");
      if (!text.endsWith("\n")) {
        throw new Error("ledger has a truncated final line");
      }
      const lines = text.slice(0, -1).split("\n");
      const envelopes: TaskLedgerEnvelopeV1[] = [];
      let previousRecordHash: string | null = null;
      for (const [sequence, line] of lines.entries()) {
        if (line.length === 0) throw new Error("ledger contains an empty line");
        const envelope = parseEnvelope(JSON.parse(line) as unknown);
        if (canonicalJson(asJsonValue(envelope)) !== line) {
          throw new Error(`ledger record ${sequence} is not canonical JSON`);
        }
        if (envelope.sequence !== sequence) {
          throw new Error(`ledger sequence gap at record ${sequence}`);
        }
        if (envelope.previousRecordHash !== previousRecordHash) {
          throw new Error(
            `ledger previous hash mismatch at record ${sequence}`,
          );
        }
        const expectedHash = contentHash(
          asJsonValue({
            schemaVersion: 1,
            sequence: envelope.sequence,
            previousRecordHash: envelope.previousRecordHash,
            payload: envelope.payload,
          }),
        );
        if (envelope.recordHash !== expectedHash) {
          throw new Error(`ledger record hash mismatch at record ${sequence}`);
        }
        envelopes.push(envelope);
        previousRecordHash = envelope.recordHash;
      }
      return envelopes;
    } catch (error) {
      throw new ArtifactCorruptionError(ledgerPath, error);
    }
  }

  private assertSealMatches(
    sealPath: string,
    seal: TaskLedgerSealV1,
    bytes: Buffer,
    envelopes: readonly TaskLedgerEnvelopeV1[],
  ): void {
    if (
      seal.recordCount !== envelopes.length ||
      seal.finalRecordHash !== (envelopes.at(-1)?.recordHash ?? null) ||
      seal.ledgerByteLength !== bytes.byteLength ||
      seal.ledgerSha256 !== sha256(bytes)
    ) {
      throw new ArtifactCorruptionError(
        sealPath,
        new Error("Task ledger seal does not match ledger bytes"),
      );
    }
  }

  private sealPath(
    context: TaskStoreContext,
    slot: VNextTaskLedgerSlot,
  ): string {
    return join(context.recordsPath, `${slot}.seal.json`);
  }

  private enqueueLedger<T>(
    taskId: TaskId,
    slot: VNextTaskLedgerSlot,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${taskNamespaceDigestV1(taskId)}\0${slot}`;
    const previous = this.ledgerQueues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.ledgerQueues.set(key, completion);
    void completion.finally(() => {
      if (this.ledgerQueues.get(key) === completion) {
        this.ledgerQueues.delete(key);
      }
    });
    return result;
  }

  private async assertOwnedEntries(
    context: TaskStoreContext,
    entries: readonly string[],
  ): Promise<ReadonlyMap<string, FileIdentity>> {
    await this.assertContext(context);
    if (!entries.includes(STORE_MARKER)) {
      throw new ArtifactNotFoundError(join(context.recordsPath, STORE_MARKER));
    }
    const snapshot = new Map<string, FileIdentity>();
    for (const entry of [...entries].sort()) {
      if (!OWNED_RECORD_NAMES.has(entry)) {
        throw new ArtifactPathSecurityError(
          join(context.recordsPath, entry),
          "unexpected records entry; refusing to broaden store ownership",
        );
      }
      const path = join(context.recordsPath, entry);
      const status = await lstat(path);
      if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
        throw new ArtifactPathSecurityError(
          path,
          "owned records entry is not a singly-linked regular file",
        );
      }
      snapshot.set(entry, identityOf(status));
    }
    await this.assertOwnedSnapshot(context, snapshot);
    return snapshot;
  }

  private async assertOwnedSnapshot(
    context: TaskStoreContext,
    expected: ReadonlyMap<string, FileIdentity>,
  ): Promise<void> {
    await this.assertContext(context);
    const actualNames = (await readdir(context.recordsPath)).sort();
    const expectedNames = [...expected.keys()].sort();
    if (
      actualNames.length !== expectedNames.length ||
      actualNames.some((name, index) => name !== expectedNames[index])
    ) {
      throw new ArtifactPathSecurityError(
        context.recordsPath,
        "records changed after the complete discard snapshot",
      );
    }
    for (const name of expectedNames) {
      const path = join(context.recordsPath, name);
      const status = await lstat(path);
      const expectedIdentity = expected.get(name);
      if (
        expectedIdentity === undefined ||
        status.isSymbolicLink() ||
        !status.isFile() ||
        status.nlink !== 1 ||
        !sameIdentity(identityOf(status), expectedIdentity)
      ) {
        throw new ArtifactPathSecurityError(
          path,
          "owned record no longer matches the complete discard snapshot",
        );
      }
    }
    await this.assertContext(context);
  }

  private async unlinkOwnedFile(
    context: TaskStoreContext,
    path: string,
    expectedIdentity: FileIdentity,
  ): Promise<void> {
    await this.assertContext(context);
    const before = await lstat(path);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      !sameIdentity(identityOf(before), expectedIdentity)
    ) {
      throw new ArtifactPathSecurityError(
        path,
        "owned record changed from the validated discard snapshot",
      );
    }
    await unlink(path);
    await this.assertContext(context);
    await this.syncDirectory(context.recordsPath, context.recordsIdentity);
  }
}
