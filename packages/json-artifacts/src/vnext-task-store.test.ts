import { createHash } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rmdir,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonValueSchema,
  asTaskId,
  taskNamespaceDigestV1,
  type JsonValue,
  type TaskId,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import { canonicalJson, contentHash } from "./canonical-json.js";
import { ArtifactCorruptionError, ArtifactNotFoundError } from "./errors.js";
import {
  ArtifactPathSecurityError,
  ImmutableArtifactConflictError,
} from "./v01-json-artifact-repository.js";
import {
  VNextTaskStore,
  type TaskLedgerEnvelopeV1,
  type VNextTaskBytesSlot,
} from "./vnext-task-store.js";

const STORE_MARKER = ".chronorift-vnext-task-store-v1.json";

interface EventPayload {
  readonly event: string;
}

function parseEvent(input: unknown): EventPayload {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !("event" in input) ||
    typeof input.event !== "string"
  ) {
    throw new Error("expected exactly one string event field");
  }
  return { event: input.event };
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const taskRootFor = (root: string, taskId: TaskId): string =>
  join(root, "tasks", taskNamespaceDigestV1(taskId));

const recordsFor = (root: string, taskId: TaskId): string =>
  join(taskRootFor(root, taskId), "records");

async function createTaskRoot(root: string, taskId: TaskId): Promise<string> {
  const taskRoot = taskRootFor(root, taskId);
  await mkdir(taskRoot, { recursive: true, mode: 0o700 });
  return taskRoot;
}

async function createStoreHarness(taskId = asTaskId("task_fixture")) {
  const root = await mkdtemp(join(tmpdir(), "chronorift-task-store-"));
  const taskRoot = await createTaskRoot(root, taskId);
  const store = new VNextTaskStore(root);
  await store.create(taskId);
  return {
    records: recordsFor(root, taskId),
    root,
    store,
    taskId,
    taskRoot,
  };
}

function envelope(
  sequence: number,
  previousRecordHash: string | null,
  payload: JsonValue,
): TaskLedgerEnvelopeV1 {
  const basis = {
    schemaVersion: 1 as const,
    sequence,
    previousRecordHash,
    payload,
  };
  return { ...basis, recordHash: contentHash(basis) };
}

describe("VNextTaskStore", () => {
  it("owns only records and leaves arbitrary Task-root siblings untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-task-store-owner-"));
    const taskId = asTaskId("task_owner_fixture");
    const taskRoot = await createTaskRoot(root, taskId);
    const outside = await mkdtemp(join(tmpdir(), "chronorift-store-outside-"));
    await writeFile(join(outside, "sentinel"), "outside\n");
    await symlink(outside, join(taskRoot, "workspace"), "dir");
    await writeFile(join(taskRoot, "tmp"), "not a directory\n");
    await symlink("missing-target", join(taskRoot, "sandbox-artifacts"));
    await mkdir(join(taskRoot, "host-baseline.git"), { mode: 0o700 });
    await writeFile(
      join(taskRoot, "host-baseline.git", "sentinel"),
      "baseline\n",
    );
    await symlink(outside, join(taskRoot, "host-tmp"), "dir");

    const siblingTaskId = asTaskId("task_owner_sibling");
    await createTaskRoot(root, siblingTaskId);
    const siblingStore = new VNextTaskStore(root);
    await siblingStore.create(siblingTaskId);
    await siblingStore.putBytesOnce(
      siblingTaskId,
      "patch.diff",
      Buffer.from("sibling\n"),
    );

    const store = new VNextTaskStore(root);
    await store.create(taskId);
    await store.putBytesOnce(taskId, "patch.diff", Buffer.from("patch\n"));
    await store.discard(taskId);

    await expect(lstat(taskRoot)).resolves.toMatchObject({});
    await expect(lstat(recordsFor(root, taskId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(taskRoot, "tmp"), "utf8")).resolves.toBe(
      "not a directory\n",
    );
    await expect(
      readFile(join(taskRoot, "host-baseline.git", "sentinel"), "utf8"),
    ).resolves.toBe("baseline\n");
    await expect(readFile(join(outside, "sentinel"), "utf8")).resolves.toBe(
      "outside\n",
    );
    await expect(lstat(join(taskRoot, "workspace"))).resolves.toMatchObject({});
    await expect(
      lstat(join(taskRoot, "sandbox-artifacts")),
    ).resolves.toMatchObject({});
    await expect(lstat(join(taskRoot, "host-tmp"))).resolves.toMatchObject({});
    await expect(
      readFile(join(recordsFor(root, siblingTaskId), "patch.diff"), "utf8"),
    ).resolves.toBe("sibling\n");
  });

  it("publishes canonical strict JSON once and rejects parser bypasses", async () => {
    const { records, store, taskId } = await createStoreHarness();
    await store.putJsonOnce(
      taskId,
      "task.json",
      { event: "created" },
      parseEvent,
    );
    await store.putJsonOnce(
      taskId,
      "task.json",
      { event: "created" },
      parseEvent,
    );
    await expect(readFile(join(records, "task.json"), "utf8")).resolves.toBe(
      `${canonicalJson({ event: "created" })}\n`,
    );
    await expect(
      store.readJson(taskId, "task.json", parseEvent),
    ).resolves.toEqual({ event: "created" });

    await store.putJsonOnce(
      taskId,
      "managed-runtime.json",
      { event: "managed" },
      parseEvent,
    );
    await expect(
      store.readJson(taskId, "managed-runtime.json", parseEvent),
    ).resolves.toEqual({ event: "managed" });
    await store.putJsonOnce(
      taskId,
      "managed-lifecycle-runtime.json",
      { event: "managed-lifecycle" },
      parseEvent,
    );
    await expect(
      store.readJson(taskId, "managed-lifecycle-runtime.json", parseEvent),
    ).resolves.toEqual({ event: "managed-lifecycle" });
    await store.putJsonOnce(
      taskId,
      "project-capability.json",
      { event: "external" },
      parseEvent,
    );
    await expect(
      store.readJson(taskId, "project-capability.json", parseEvent),
    ).resolves.toEqual({ event: "external" });

    await expect(
      store.putJsonOnce(
        taskId,
        "workspace.json",
        { event: "created", unknown: true } as unknown as EventPayload,
        parseEvent,
      ),
    ).rejects.toThrow(/exactly one/u);
    await expect(
      store.putJsonOnce(
        taskId,
        "workspace.json",
        { event: "created" },
        () => ({ event: undefined }) as unknown as EventPayload,
      ),
    ).rejects.toThrow();
    await expect(
      store.append(
        taskId,
        "security.jsonl",
        { event: "created", unknown: true } as unknown as EventPayload,
        parseEvent,
      ),
    ).rejects.toThrow(/exactly one/u);
    await expect(
      store.append(
        taskId,
        "security.jsonl",
        { event: "created" },
        () => ({ event: undefined }) as unknown as EventPayload,
      ),
    ).rejects.toThrow();
  });

  it("stores exact bounded external project descriptor bytes", async () => {
    const { store, taskId } = await createStoreHarness();
    const descriptor = Buffer.from('{"schemaVersion":1}\n');
    await store.putBytesOnce(taskId, "project-descriptor.json", descriptor);
    await expect(
      store.readBytes(taskId, "project-descriptor.json"),
    ).resolves.toEqual(Uint8Array.from(descriptor));
    await expect(
      store.putBytesOnce(
        taskId,
        "project-descriptor.json",
        Buffer.alloc(64 * 1024 + 1),
      ),
    ).rejects.toThrow(/byte limit/u);
  });

  it("rejects invalid or noncanonical stored JSON", async () => {
    const { records, store, taskId } = await createStoreHarness();
    await writeFile(join(records, "task.json"), "{not-json}\n");
    await expect(
      store.readJson(taskId, "task.json", parseEvent),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);

    await writeFile(join(records, "task.json"), '{"event": "spaced"}\n');
    await expect(
      store.readJson(taskId, "task.json", parseEvent),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);

    await writeFile(join(records, "task-events.jsonl"), "{not-json}\n");
    await expect(
      store.readLedger(taskId, "task-events.jsonl", parseEvent),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);
  });

  it("treats different immutable content as a conflict", async () => {
    const { store, taskId } = await createStoreHarness();
    await store.putBytesOnce(taskId, "patch.diff", Buffer.from("one"));
    await expect(
      store.putBytesOnce(taskId, "patch.diff", Buffer.from("two")),
    ).rejects.toBeInstanceOf(ImmutableArtifactConflictError);
    await store.putBytesOnce(taskId, "patch.diff", Buffer.from("one"));
  });

  it("allows exactly one concurrent different-content publication", async () => {
    const { store, taskId } = await createStoreHarness();
    const results = await Promise.allSettled([
      store.putBytesOnce(taskId, "patch.diff", Buffer.from("one")),
      store.putBytesOnce(taskId, "patch.diff", Buffer.from("two")),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  it("drains a begun append, rejects later writes, and then discards", async () => {
    const { records, store, taskId } = await createStoreHarness();
    const append = store.append(
      taskId,
      "task-events.jsonl",
      { event: "begun-before-discard" },
      parseEvent,
    );
    const discard = store.discard(taskId);
    const lateWrite = store.putJsonOnce(
      taskId,
      "sandbox-capability.json",
      { event: "too-late" },
      parseEvent,
    );

    await Promise.all([
      expect(append).resolves.toMatchObject({ sequence: 0 }),
      expect(lateWrite).rejects.toThrow(/discard/u),
      expect(discard).resolves.toBeUndefined(),
    ]);
    await expect(lstat(records)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hash-chains concurrent appends, seals, and rejects later appends", async () => {
    const { records, store, taskId } = await createStoreHarness();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.append(
          taskId,
          "security.jsonl",
          { event: `event-${index}` },
          parseEvent,
        ),
      ),
    );
    const ledger = await store.readLedger(taskId, "security.jsonl", parseEvent);
    expect(ledger).toHaveLength(12);

    const bytes = await readFile(join(records, "security.jsonl"));
    const seal = await store.seal(taskId, "security.jsonl");
    expect(seal).toMatchObject({
      schemaVersion: 1,
      recordCount: 12,
      ledgerByteLength: bytes.byteLength,
      ledgerSha256: sha256(bytes),
    });
    await expect(store.seal(taskId, "security.jsonl")).resolves.toEqual(seal);
    await expect(
      store.append(taskId, "security.jsonl", { event: "too-late" }, parseEvent),
    ).rejects.toThrow(/sealed/u);
  });

  it("rejects a corrupted middle hash", async () => {
    const { records, store, taskId } = await createStoreHarness();
    await store.append(
      taskId,
      "sandbox-operations.jsonl",
      { event: "one" },
      parseEvent,
    );
    await store.append(
      taskId,
      "sandbox-operations.jsonl",
      { event: "two" },
      parseEvent,
    );
    await store.append(
      taskId,
      "sandbox-operations.jsonl",
      { event: "three" },
      parseEvent,
    );
    const ledgerPath = join(records, "sandbox-operations.jsonl");
    const lines = (await readFile(ledgerPath, "utf8")).trimEnd().split("\n");
    const middle = JsonValueSchema.parse(JSON.parse(lines[1] ?? ""));
    if (
      middle === null ||
      Array.isArray(middle) ||
      typeof middle !== "object"
    ) {
      throw new Error("test fixture is not an object");
    }
    middle.recordHash = "0".repeat(64);
    lines[1] = canonicalJson(middle);
    await writeFile(ledgerPath, `${lines.join("\n")}\n`);

    await expect(
      store.readLedger(taskId, "sandbox-operations.jsonl", parseEvent),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);
  });

  it("rejects a sequence gap even when the record hash is recomputed", async () => {
    const { records, store, taskId } = await createStoreHarness();
    await store.append(
      taskId,
      "task-events.jsonl",
      { event: "one" },
      parseEvent,
    );
    const changed = envelope(7, null, { event: "one" });
    await writeFile(
      join(records, "task-events.jsonl"),
      `${canonicalJson(changed as unknown as JsonValue)}\n`,
    );

    await expect(
      store.readLedger(taskId, "task-events.jsonl", parseEvent),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);
  });

  it("rejects a missing final newline", async () => {
    const { records, store, taskId } = await createStoreHarness();
    await store.append(
      taskId,
      "sandbox-preflight.jsonl",
      { event: "one" },
      parseEvent,
    );
    const ledgerPath = join(records, "sandbox-preflight.jsonl");
    const size = (await lstat(ledgerPath)).size;
    await truncate(ledgerPath, size - 1);
    await expect(
      store.readLedger(taskId, "sandbox-preflight.jsonl", parseEvent),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);
  });

  it("rejects ledger bytes that no longer match an immutable seal", async () => {
    const { records, store, taskId } = await createStoreHarness();
    const first = await store.append(
      taskId,
      "exports.jsonl",
      { event: "one" },
      parseEvent,
    );
    await store.seal(taskId, "exports.jsonl");
    const extra = envelope(1, first.recordHash, { event: "injected" });
    const ledgerPath = join(records, "exports.jsonl");
    const original = await readFile(ledgerPath, "utf8");
    await writeFile(
      ledgerPath,
      `${original}${canonicalJson(extra as unknown as JsonValue)}\n`,
    );

    await expect(
      store.readLedger(taskId, "exports.jsonl", parseEvent),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);
  });

  it("rejects symlink-swapped owned directories and path-like slot casts", async () => {
    const { records, store, taskId } = await createStoreHarness();
    await store.putBytesOnce(taskId, "patch.diff", Buffer.from("one"));
    const movedRecords = `${records}-moved`;
    await rename(records, movedRecords);
    await symlink(movedRecords, records, "dir");
    await expect(store.readBytes(taskId, "patch.diff")).rejects.toBeInstanceOf(
      ArtifactPathSecurityError,
    );

    const other = await createStoreHarness(asTaskId("task_slot_fixture"));
    await expect(
      other.store.putBytesOnce(
        other.taskId,
        "../workspace/evil" as VNextTaskBytesSlot,
        Buffer.from("evil"),
      ),
    ).rejects.toBeInstanceOf(ArtifactPathSecurityError);
    await expect(
      lstat(join(other.taskRoot, "workspace", "evil")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses only the derived namespace for path-like raw Task IDs", async () => {
    const taskId = asTaskId("../../outside/task");
    const { records, root, store } = await createStoreHarness(taskId);
    await store.putBytesOnce(taskId, "patch.diff", Buffer.from("safe"));
    await expect(readFile(join(records, "patch.diff"), "utf8")).resolves.toBe(
      "safe",
    );
    expect(records).toContain(taskNamespaceDigestV1(taskId));
    await expect(lstat(join(root, "outside"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("binds a records marker to the exact Task identity", async () => {
    const first = await createStoreHarness(asTaskId("task_marker_source"));
    const secondTaskId = asTaskId("task_marker_target");
    await createTaskRoot(first.root, secondTaskId);
    const secondRecords = recordsFor(first.root, secondTaskId);
    await mkdir(secondRecords, { mode: 0o700 });
    const copiedMarker = await readFile(join(first.records, STORE_MARKER));
    await writeFile(join(secondRecords, STORE_MARKER), copiedMarker);

    await expect(
      new VNextTaskStore(first.root).create(secondTaskId),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);
  });

  it("requires its marker for records-only discard and preserves sibling Tasks", async () => {
    const { records, root, store, taskId, taskRoot } =
      await createStoreHarness();
    const siblingTaskId = asTaskId("task_sibling");
    const siblingRoot = await createTaskRoot(root, siblingTaskId);
    const siblingStore = new VNextTaskStore(root);
    await siblingStore.create(siblingTaskId);
    await siblingStore.putBytesOnce(
      siblingTaskId,
      "patch.diff",
      Buffer.from("sibling"),
    );

    await unlink(join(records, STORE_MARKER));
    await expect(store.discard(taskId)).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
    await expect(lstat(taskRoot)).resolves.toMatchObject({});
    await expect(
      readFile(join(recordsFor(root, siblingTaskId), "patch.diff"), "utf8"),
    ).resolves.toBe("sibling");

    await writeFile(join(records, STORE_MARKER), "{}\n");
    await expect(store.discard(taskId)).rejects.toBeInstanceOf(
      ArtifactCorruptionError,
    );
    await expect(lstat(siblingRoot)).resolves.toMatchObject({});

    const foreign = await createStoreHarness(asTaskId("task_foreign_record"));
    await writeFile(join(foreign.records, "foreign"), "not store-owned\n");
    await expect(foreign.store.discard(foreign.taskId)).rejects.toBeInstanceOf(
      ArtifactPathSecurityError,
    );
    await expect(
      readFile(join(foreign.records, "foreign"), "utf8"),
    ).resolves.toBe("not store-owned\n");
    await expect(lstat(foreign.taskRoot)).resolves.toMatchObject({});
  });

  it("does not delete validated records when discard finds a foreign entry and can retry", async () => {
    const { records, store, taskId } = await createStoreHarness();
    await store.putJsonOnce(
      taskId,
      "sandbox-capability.json",
      { event: "frozen-capability" },
      parseEvent,
    );
    await store.append(
      taskId,
      "sandbox-preflight.jsonl",
      { event: "supported" },
      parseEvent,
    );
    const capabilityPath = join(records, "sandbox-capability.json");
    const preflightPath = join(records, "sandbox-preflight.jsonl");
    const capabilityBefore = await readFile(capabilityPath);
    const preflightBefore = await readFile(preflightPath);
    const foreignPath = join(records, "foreign");
    await writeFile(foreignPath, "not store-owned\n");

    await expect(store.discard(taskId)).rejects.toBeInstanceOf(
      ArtifactPathSecurityError,
    );
    await expect(readFile(capabilityPath)).resolves.toEqual(capabilityBefore);
    await expect(readFile(preflightPath)).resolves.toEqual(preflightBefore);

    await unlink(foreignPath);
    await expect(store.discard(taskId)).resolves.toBeUndefined();
    await expect(lstat(records)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a multiply-linked owned record without deleting its siblings", async () => {
    const { records, root, store, taskId } = await createStoreHarness();
    await store.putJsonOnce(
      taskId,
      "sandbox-capability.json",
      { event: "frozen-capability" },
      parseEvent,
    );
    await store.append(
      taskId,
      "sandbox-preflight.jsonl",
      { event: "supported" },
      parseEvent,
    );
    const capabilityPath = join(records, "sandbox-capability.json");
    const preflightPath = join(records, "sandbox-preflight.jsonl");
    const outsideLink = join(root, "capability-hard-link");
    const preflightBefore = await readFile(preflightPath);
    await link(capabilityPath, outsideLink);

    await expect(store.discard(taskId)).rejects.toBeInstanceOf(
      ArtifactPathSecurityError,
    );
    await expect(readFile(capabilityPath)).resolves.toEqual(
      await readFile(outsideLink),
    );
    await expect(readFile(preflightPath)).resolves.toEqual(preflightBefore);

    await unlink(outsideLink);
    await expect(store.discard(taskId)).resolves.toBeUndefined();
  });

  it("restores its marker when final directory removal races and retries cleanup", async () => {
    const { records, store, taskId } = await createStoreHarness();
    const markerPath = join(records, STORE_MARKER);
    const foreignPath = join(records, "foreign-after-marker");
    const injectAfterMarkerRemoval = (async () => {
      for (;;) {
        try {
          await lstat(markerPath);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            await writeFile(foreignPath, "raced final rmdir\n");
            return;
          }
          throw error;
        }
        await new Promise<void>((resolvePromise) => {
          setImmediate(resolvePromise);
        });
      }
    })();

    const firstDiscard = store.discard(taskId);
    const firstDiscardRejected = expect(firstDiscard).rejects.toBeInstanceOf(
      ArtifactPathSecurityError,
    );
    await injectAfterMarkerRemoval;
    await firstDiscardRejected;
    await expect(lstat(markerPath)).resolves.toMatchObject({});

    await unlink(foreignPath);
    await expect(store.discard(taskId)).resolves.toBeUndefined();
    await expect(lstat(records)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries Task-parent sync after records were removed and rechecks its identity", async () => {
    const { records, store, taskId, taskRoot } = await createStoreHarness();
    const internals = store as unknown as {
      syncDirectory(
        path: string,
        expectedIdentity: { readonly dev: number; readonly ino: number },
      ): Promise<void>;
    };
    const syncDirectory = internals.syncDirectory.bind(store);
    let parentSyncFailed = false;
    internals.syncDirectory = async (path, expectedIdentity) => {
      if (path === taskRoot && !parentSyncFailed) {
        try {
          await lstat(records);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            parentSyncFailed = true;
            throw new Error("injected Task-parent sync failure");
          }
          throw error;
        }
      }
      await syncDirectory(path, expectedIdentity);
    };

    await expect(store.discard(taskId)).rejects.toThrow(
      /injected Task-parent sync failure/u,
    );
    await expect(lstat(records)).rejects.toMatchObject({ code: "ENOENT" });

    const movedTaskRoot = `${taskRoot}-moved`;
    await rename(taskRoot, movedTaskRoot);
    await mkdir(taskRoot, { mode: 0o700 });
    await expect(store.discard(taskId)).rejects.toBeInstanceOf(
      ArtifactPathSecurityError,
    );

    await rmdir(taskRoot);
    await rename(movedTaskRoot, taskRoot);
    await expect(store.discard(taskId)).resolves.toBeUndefined();
  });

  it("rejects unexpected pre-marker records content", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-task-store-dirty-"));
    const taskId = asTaskId("task_dirty_records");
    await createTaskRoot(root, taskId);
    const records = recordsFor(root, taskId);
    await mkdir(records, { mode: 0o700 });
    await writeFile(join(records, "foreign"), "not owned\n");

    await expect(new VNextTaskStore(root).create(taskId)).rejects.toThrow(
      /empty|marker|unexpected/u,
    );
    expect(await readdir(records)).toEqual(["foreign"]);
  });
});
