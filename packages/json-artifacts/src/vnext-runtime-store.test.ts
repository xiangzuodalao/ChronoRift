import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  VNextSemanticCheckpointResourceV1Schema,
  asTaskId,
  taskNamespaceDigestV1,
  type TaskId,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical-json.js";
import { ArtifactCorruptionError, ArtifactNotFoundError } from "./errors.js";
import {
  ArtifactPathSecurityError,
  ImmutableArtifactConflictError,
} from "./v01-json-artifact-repository.js";
import {
  RuntimeExecutionSealedError,
  VNEXT_RUNTIME_RESOURCE_DIRECTORIES,
  VNextRuntimeStore,
  type VNextRuntimeResourceKind,
} from "./vnext-runtime-store.js";

const RESOURCE_MARKER = ".chronorift-vnext-runtime-resource-v1.json";

interface OwnedRecord {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly label: string;
}

interface RawEvent {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly executionId: string;
  readonly sequence: number;
  readonly label: string;
}

const exactKeys = (
  input: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(input).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
};

function parseOwnedRecord(input: unknown): OwnedRecord {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !exactKeys(input as Record<string, unknown>, [
      "schemaVersion",
      "taskId",
      "label",
    ]) ||
    !("schemaVersion" in input) ||
    input.schemaVersion !== 1 ||
    !("taskId" in input) ||
    typeof input.taskId !== "string" ||
    !("label" in input) ||
    typeof input.label !== "string"
  ) {
    throw new Error("invalid owned record");
  }
  return {
    schemaVersion: 1,
    taskId: asTaskId(input.taskId),
    label: input.label,
  };
}

function parseRawEvent(input: unknown): RawEvent {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !exactKeys(input as Record<string, unknown>, [
      "schemaVersion",
      "taskId",
      "executionId",
      "sequence",
      "label",
    ]) ||
    !("schemaVersion" in input) ||
    input.schemaVersion !== 1 ||
    !("taskId" in input) ||
    typeof input.taskId !== "string" ||
    !("executionId" in input) ||
    typeof input.executionId !== "string" ||
    !("sequence" in input) ||
    !Number.isSafeInteger(input.sequence) ||
    (input.sequence as number) < 0 ||
    !("label" in input) ||
    typeof input.label !== "string"
  ) {
    throw new Error("invalid raw event");
  }
  return {
    schemaVersion: 1,
    taskId: asTaskId(input.taskId),
    executionId: input.executionId,
    sequence: input.sequence as number,
    label: input.label,
  };
}

const taskRootFor = (root: string, taskId: TaskId): string =>
  join(root, "tasks", taskNamespaceDigestV1(taskId));

const runtimeRecordsFor = (root: string, taskId: TaskId): string =>
  join(taskRootFor(root, taskId), "runtime-records");

async function createTaskRoot(root: string, taskId: TaskId): Promise<string> {
  const taskRoot = taskRootFor(root, taskId);
  await mkdir(taskRoot, { recursive: true, mode: 0o700 });
  return taskRoot;
}

async function createHarness(taskId = asTaskId("task_runtime_fixture")) {
  const root = await mkdtemp(join(tmpdir(), "chronorift-runtime-store-"));
  const taskRoot = await createTaskRoot(root, taskId);
  const store = new VNextRuntimeStore(root);
  await store.create(taskId);
  return {
    root,
    runtimeRecords: runtimeRecordsFor(root, taskId),
    store,
    taskId,
    taskRoot,
  };
}

async function onlyResourceDirectory(
  runtimeRecords: string,
  kind: VNextRuntimeResourceKind,
): Promise<string> {
  const category = join(
    runtimeRecords,
    VNEXT_RUNTIME_RESOURCE_DIRECTORIES[kind],
  );
  const entries = await readdir(category);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatch(/^[a-f0-9]{64}$/u);
  return join(category, entries[0] ?? "missing");
}

describe("VNextRuntimeStore", () => {
  it("stores every resource kind below a task-owned digest directory", async () => {
    const { runtimeRecords, store, taskId } = await createHarness();
    const kinds = Object.keys(
      VNEXT_RUNTIME_RESOURCE_DIRECTORIES,
    ) as VNextRuntimeResourceKind[];

    for (const [index, kind] of kinds.entries()) {
      const resourceId =
        index === 0 ? "../../host/absolute-looking" : `${kind}_fixture`;
      const value: OwnedRecord = {
        schemaVersion: 1,
        taskId,
        label: kind,
      };
      await store.putResourceOnce(
        taskId,
        kind,
        resourceId,
        value,
        parseOwnedRecord,
      );
      await expect(
        store.readResource(taskId, kind, resourceId, parseOwnedRecord),
      ).resolves.toEqual(value);

      const resourceDirectory = await onlyResourceDirectory(
        runtimeRecords,
        kind,
      );
      expect(resourceDirectory).not.toContain(resourceId);
      expect((await readdir(resourceDirectory)).sort()).toEqual(
        [RESOURCE_MARKER, "record.json"].sort(),
      );
    }
  });

  it("persists and reads a task-owned semantic checkpoint resource", async () => {
    const { store, taskId } = await createHarness();
    const checkpointId = "checkpoint:semantic:persistence";
    const digest = "a".repeat(64);
    const resource = VNextSemanticCheckpointResourceV1Schema.parse({
      schemaVersion: 1,
      resourceKind: "semantic_checkpoint",
      taskId,
      checkpointId,
      payload: {
        schemaVersion: 1,
        taskId,
        checkpointId,
        executionId: "execution:semantic:persistence",
        runtimeId: "runtime:semantic:persistence",
        buildId: "build:semantic:persistence",
        adapterId: "adapter:semantic:persistence",
        adapterProfileSha256: digest,
        semanticBarrier: "adapter_process_tail",
        projection: {
          schemaVersion: 1,
          stateSchemaVersion: "chronorift.timer-spawn:v1",
          subject: {
            stableId: "semantic:subject",
            incarnation: 1,
            targetScene: "res://spawner.tscn",
            spawnIntervalSeconds: 1,
            spawnScene: "res://enemy.tscn",
          },
          timer: {
            stableId: "semantic:timer",
            incarnation: 1,
            waitTimeSeconds: 1,
            timeLeftSeconds: 0.5,
            paused: false,
            stopped: false,
            oneShot: false,
            autostart: false,
            processCallback: "idle",
            ignoreTimeScale: false,
            timeoutOrdinal: 0,
          },
          entities: [],
          nextSpawnOrdinal: 0,
          capturedAt: {
            processFrame: 1,
            physicsTick: 1,
            simulationTimeUs: 16_667,
            hostMonotonicUs: null,
            renderFrame: null,
          },
        },
        projectionSha256: digest,
        capturedDomains: [
          "subject.configuration",
          "spawned_entities",
          "timer.configuration",
          "timer.runtime",
        ],
        uncontrolledDomains: ["scene_private_state"],
        restoreDependencyOrder: [
          "subject.configuration",
          "spawned_entities",
          "timer.configuration",
          "timer.runtime",
        ],
        fidelity: "descriptive_only",
        equivalentForkEligible: false,
      },
    });

    await store.putResourceOnce(
      taskId,
      "checkpoint",
      checkpointId,
      resource,
      (value) => VNextSemanticCheckpointResourceV1Schema.parse(value),
    );
    await expect(
      store.readResource(taskId, "checkpoint", checkpointId, (value) =>
        VNextSemanticCheckpointResourceV1Schema.parse(value),
      ),
    ).resolves.toEqual(resource);
  });

  it("validates strict payloads, task ownership, and immutable conflicts", async () => {
    const { store, taskId } = await createHarness();
    const value: OwnedRecord = {
      schemaVersion: 1,
      taskId,
      label: "build-one",
    };
    await store.putResourceOnce(
      taskId,
      "build",
      "build_one",
      value,
      parseOwnedRecord,
    );
    await expect(
      store.putResourceOnce(
        taskId,
        "build",
        "build_one",
        value,
        parseOwnedRecord,
      ),
    ).resolves.toBeUndefined();
    await expect(
      store.putResourceOnce(
        taskId,
        "build",
        "build_one",
        { ...value, label: "different" },
        parseOwnedRecord,
      ),
    ).rejects.toBeInstanceOf(ImmutableArtifactConflictError);

    await expect(
      store.putResourceOnce(
        taskId,
        "runtime",
        "runtime_foreign",
        {
          schemaVersion: 1,
          taskId: asTaskId("task_foreign"),
          label: "foreign",
        },
        parseOwnedRecord,
      ),
    ).rejects.toThrow(/different Task/u);
    await expect(
      store.putResourceOnce(
        taskId,
        "runtime",
        "runtime_not_strict",
        { ...value, extra: true } as unknown as OwnedRecord,
        parseOwnedRecord,
      ),
    ).rejects.toThrow(/invalid owned record/u);
  });

  it("detects canonical record corruption and payload hash mismatch", async () => {
    const { runtimeRecords, store, taskId } = await createHarness();
    await store.putResourceOnce(
      taskId,
      "checkpoint",
      "checkpoint_one",
      { schemaVersion: 1, taskId, label: "original" },
      parseOwnedRecord,
    );
    const resourceDirectory = await onlyResourceDirectory(
      runtimeRecords,
      "checkpoint",
    );
    const path = join(resourceDirectory, "record.json");
    const envelope = JSON.parse(await readFile(path, "utf8")) as {
      payload: { label: string };
    };
    envelope.payload.label = "tampered";
    await writeFile(path, `${canonicalJson(envelope as never)}\n`);

    await expect(
      store.readResource(
        taskId,
        "checkpoint",
        "checkpoint_one",
        parseOwnedRecord,
      ),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);
  });

  it("hash-chains execution events, seals them, and rejects later appends", async () => {
    const { runtimeRecords, store, taskId } = await createHarness();
    const executionId = "execution_one";
    await store.putResourceOnce(
      taskId,
      "execution",
      executionId,
      { schemaVersion: 1, taskId, label: "running" },
      parseOwnedRecord,
    );

    await Promise.all(
      Array.from({ length: 8 }, (_, sequence) =>
        store.appendExecutionEvent(
          taskId,
          executionId,
          {
            schemaVersion: 1,
            taskId,
            executionId,
            sequence,
            label: `event-${sequence}`,
          },
          parseRawEvent,
        ),
      ),
    );
    const events = await store.readExecutionEvents(
      taskId,
      executionId,
      parseRawEvent,
    );
    expect(events.map((event) => event.sequence)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);

    const resourceDirectory = await onlyResourceDirectory(
      runtimeRecords,
      "execution",
    );
    const ledger = await readFile(join(resourceDirectory, "events.jsonl"));
    const eventEnvelopes = ledger
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(eventEnvelopes[0]?.previousHash).toBeNull();
    expect(eventEnvelopes[1]?.previousHash).toBe(eventEnvelopes[0]?.recordHash);
    expect(
      eventEnvelopes.every(
        (event) =>
          typeof event.recordHash === "string" &&
          /^[a-f0-9]{64}$/u.test(event.recordHash),
      ),
    ).toBe(true);
    const seal = await store.sealExecution(taskId, executionId);
    expect(seal).toMatchObject({
      schemaVersion: 1,
      taskId,
      executionId,
      count: 8,
      byteLength: ledger.byteLength,
      contentHash: createHash("sha256").update(ledger).digest("hex"),
    });
    expect(seal.headHash).toMatch(/^[a-f0-9]{64}$/u);
    await expect(store.sealExecution(taskId, executionId)).resolves.toEqual(
      seal,
    );
    await expect(store.readExecutionSeal(taskId, executionId)).resolves.toEqual(
      seal,
    );
    await expect(
      store.appendExecutionEvent(
        taskId,
        executionId,
        {
          schemaVersion: 1,
          taskId,
          executionId,
          sequence: 8,
          label: "too-late",
        },
        parseRawEvent,
      ),
    ).rejects.toBeInstanceOf(RuntimeExecutionSealedError);
  });

  it("requires a physical, ledger-matching seal when reading a seal", async () => {
    const { runtimeRecords, store, taskId } = await createHarness();
    const executionId = "execution_seal_required";
    await store.appendExecutionEvent(
      taskId,
      executionId,
      {
        schemaVersion: 1,
        taskId,
        executionId,
        sequence: 0,
        label: "original",
      },
      parseRawEvent,
    );
    await store.sealExecution(taskId, executionId);
    const resourceDirectory = await onlyResourceDirectory(
      runtimeRecords,
      "execution",
    );
    const sealPath = join(resourceDirectory, "events.seal.json");
    await unlink(sealPath);
    await expect(
      store.readExecutionSeal(taskId, executionId),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);

    await store.sealExecution(taskId, executionId);
    const seal = JSON.parse(await readFile(sealPath, "utf8")) as {
      count: number;
    };
    seal.count += 1;
    await writeFile(sealPath, `${canonicalJson(seal as never)}\n`);
    await expect(
      store.readExecutionSeal(taskId, executionId),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);
  });

  it("rejects an orphan physical seal without a terminal execution record on reopen", async () => {
    const { root, store, taskId } = await createHarness(
      asTaskId("task_runtime_orphan_seal"),
    );
    const executionId = "execution_orphan_seal";
    await store.appendExecutionEvent(
      taskId,
      executionId,
      {
        schemaVersion: 1,
        taskId,
        executionId,
        sequence: 0,
        label: "sealed-before-terminal-publish",
      },
      parseRawEvent,
    );
    await store.sealExecution(taskId, executionId);

    const reopened = new VNextRuntimeStore(root);
    await expect(reopened.open(taskId)).rejects.toBeInstanceOf(
      ArtifactCorruptionError,
    );
  });

  it("summarizes owned resource IDs and execution seal state without Host paths or verdicts", async () => {
    const { root, store, taskId } = await createHarness(
      asTaskId("task:runtime-summary"),
    );
    await Promise.all([
      store.putResourceOnce(
        taskId,
        "build",
        "build:second",
        { schemaVersion: 1, taskId, label: "second" },
        parseOwnedRecord,
      ),
      store.putResourceOnce(
        taskId,
        "build",
        "build:first",
        { schemaVersion: 1, taskId, label: "first" },
        parseOwnedRecord,
      ),
    ]);
    for (const executionId of ["execution:sealed", "execution:running"]) {
      await store.appendExecutionEvent(
        taskId,
        executionId,
        {
          schemaVersion: 1,
          taskId,
          executionId,
          sequence: 0,
          label: executionId,
        },
        parseRawEvent,
      );
    }
    await store.sealExecution(taskId, "execution:sealed");
    await store.putResourceOnce(
      taskId,
      "execution",
      "execution:sealed",
      { schemaVersion: 1, taskId, label: "terminal" },
      parseOwnedRecord,
    );

    const summary = await store.summarize(taskId);
    expect(summary).toMatchObject({ schemaVersion: 1, taskId });
    expect(summary.kinds).toHaveLength(
      Object.keys(VNEXT_RUNTIME_RESOURCE_DIRECTORIES).length,
    );
    expect(
      summary.kinds.find((entry) => entry.resourceKind === "build"),
    ).toEqual({
      resourceKind: "build",
      count: 2,
      resourceIds: ["build:first", "build:second"],
    });
    expect(
      summary.kinds.find((entry) => entry.resourceKind === "checkpoint"),
    ).toEqual({ resourceKind: "checkpoint", count: 0, resourceIds: [] });
    expect(summary.executions).toEqual([
      { executionId: "execution:running", sealed: false },
      { executionId: "execution:sealed", sealed: true },
    ]);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toMatch(/oracle|verdict|evaluator/iu);
  });

  it("rejects corrupted execution event chains and foreign event ownership", async () => {
    const { runtimeRecords, store, taskId } = await createHarness();
    const executionId = "execution_corrupt";
    await store.appendExecutionEvent(
      taskId,
      executionId,
      {
        schemaVersion: 1,
        taskId,
        executionId,
        sequence: 0,
        label: "original",
      },
      parseRawEvent,
    );
    const resourceDirectory = await onlyResourceDirectory(
      runtimeRecords,
      "execution",
    );
    const ledgerPath = join(resourceDirectory, "events.jsonl");
    const envelope = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      payload: { label: string };
    };
    envelope.payload.label = "tampered";
    await writeFile(ledgerPath, `${canonicalJson(envelope as never)}\n`);

    await expect(
      store.readExecutionEvents(taskId, executionId, parseRawEvent),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);

    await expect(
      store.appendExecutionEvent(
        taskId,
        "execution_foreign",
        {
          schemaVersion: 1,
          taskId,
          executionId: "different_execution",
          sequence: 0,
          label: "foreign",
        },
        parseRawEvent,
      ),
    ).rejects.toThrow(/different Execution/u);
  });

  it("rejects record symlinks, foreign resource children, and copied ownership markers", async () => {
    const first = await createHarness(asTaskId("task_runtime_first"));
    await first.store.putResourceOnce(
      first.taskId,
      "trace",
      "trace_one",
      { schemaVersion: 1, taskId: first.taskId, label: "first" },
      parseOwnedRecord,
    );
    const firstResource = await onlyResourceDirectory(
      first.runtimeRecords,
      "trace",
    );
    const outside = join(first.root, "outside.json");
    await writeFile(outside, "outside\n");
    await unlink(join(firstResource, "record.json"));
    await symlink(outside, join(firstResource, "record.json"));
    await expect(
      first.store.readResource(
        first.taskId,
        "trace",
        "trace_one",
        parseOwnedRecord,
      ),
    ).rejects.toBeInstanceOf(ArtifactPathSecurityError);

    const second = await createHarness(asTaskId("task_runtime_second"));
    await second.store.putResourceOnce(
      second.taskId,
      "branch",
      "branch_one",
      { schemaVersion: 1, taskId: second.taskId, label: "second" },
      parseOwnedRecord,
    );
    const secondResource = await onlyResourceDirectory(
      second.runtimeRecords,
      "branch",
    );
    await writeFile(join(secondResource, "foreign-child"), "foreign\n");
    await expect(
      second.store.readResource(
        second.taskId,
        "branch",
        "branch_one",
        parseOwnedRecord,
      ),
    ).rejects.toBeInstanceOf(ArtifactPathSecurityError);

    const ownership = await createHarness(
      asTaskId("task_runtime_ownership_target"),
    );
    const thirdTaskId = asTaskId("task_runtime_third");
    await createTaskRoot(ownership.root, thirdTaskId);
    const thirdStore = new VNextRuntimeStore(ownership.root);
    await thirdStore.create(thirdTaskId);
    await thirdStore.putResourceOnce(
      thirdTaskId,
      "comparison",
      "comparison_one",
      { schemaVersion: 1, taskId: thirdTaskId, label: "third" },
      parseOwnedRecord,
    );
    const thirdResource = await onlyResourceDirectory(
      runtimeRecordsFor(ownership.root, thirdTaskId),
      "comparison",
    );
    await ownership.store.putResourceOnce(
      ownership.taskId,
      "comparison",
      "comparison_one",
      { schemaVersion: 1, taskId: ownership.taskId, label: "target" },
      parseOwnedRecord,
    );
    const copiedTarget = await onlyResourceDirectory(
      ownership.runtimeRecords,
      "comparison",
    );
    await copyFile(
      join(thirdResource, RESOURCE_MARKER),
      join(copiedTarget, RESOURCE_MARKER),
    );
    await expect(
      ownership.store.readResource(
        ownership.taskId,
        "comparison",
        "comparison_one",
        parseOwnedRecord,
      ),
    ).rejects.toBeInstanceOf(ArtifactCorruptionError);
  });

  it("discards only its owned tree and leaves Task siblings and other Tasks", async () => {
    const { root, runtimeRecords, store, taskId, taskRoot } =
      await createHarness();
    await writeFile(join(taskRoot, "task-sibling"), "keep\n");
    await store.putResourceOnce(
      taskId,
      "tool-call",
      "call_one",
      { schemaVersion: 1, taskId, label: "call" },
      parseOwnedRecord,
    );
    await store.appendExecutionEvent(
      taskId,
      "execution_one",
      {
        schemaVersion: 1,
        taskId,
        executionId: "execution_one",
        sequence: 0,
        label: "event",
      },
      parseRawEvent,
    );

    const siblingTaskId = asTaskId("task_runtime_sibling");
    await createTaskRoot(root, siblingTaskId);
    const siblingStore = new VNextRuntimeStore(root);
    await siblingStore.create(siblingTaskId);
    await siblingStore.putResourceOnce(
      siblingTaskId,
      "build",
      "build_sibling",
      { schemaVersion: 1, taskId: siblingTaskId, label: "sibling" },
      parseOwnedRecord,
    );

    await store.discard(taskId);
    await expect(lstat(runtimeRecords)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(taskRoot, "task-sibling"), "utf8"),
    ).resolves.toBe("keep\n");
    await expect(
      siblingStore.readResource(
        siblingTaskId,
        "build",
        "build_sibling",
        parseOwnedRecord,
      ),
    ).resolves.toMatchObject({ label: "sibling" });
  });

  it("refuses discard when an unowned child is present", async () => {
    const { runtimeRecords, store, taskId } = await createHarness();
    await store.putResourceOnce(
      taskId,
      "build",
      "build_must_survive",
      { schemaVersion: 1, taskId, label: "must-survive" },
      parseOwnedRecord,
    );
    const ownedBuild = await onlyResourceDirectory(runtimeRecords, "build");
    await store.putResourceOnce(
      taskId,
      "runtime",
      "runtime_one",
      { schemaVersion: 1, taskId, label: "runtime" },
      parseOwnedRecord,
    );
    const resource = await onlyResourceDirectory(runtimeRecords, "runtime");
    await writeFile(join(resource, "unowned"), "do not remove\n");

    await expect(store.discard(taskId)).rejects.toBeInstanceOf(
      ArtifactPathSecurityError,
    );
    await expect(readFile(join(resource, "unowned"), "utf8")).resolves.toBe(
      "do not remove\n",
    );
    await expect(
      readFile(join(ownedBuild, "record.json"), "utf8"),
    ).resolves.toContain("must-survive");

    await unlink(join(resource, "unowned"));
    await expect(store.discard(taskId)).resolves.toBeUndefined();
    await expect(lstat(runtimeRecords)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fully scans and rejects a symlink before deleting earlier owned resources", async () => {
    const { root, runtimeRecords, store, taskId } = await createHarness(
      asTaskId("task_runtime_discard_symlink"),
    );
    await store.putResourceOnce(
      taskId,
      "build",
      "build_must_survive_symlink",
      { schemaVersion: 1, taskId, label: "survives-symlink" },
      parseOwnedRecord,
    );
    const ownedBuild = await onlyResourceDirectory(runtimeRecords, "build");
    await store.putResourceOnce(
      taskId,
      "runtime",
      "runtime_symlink",
      { schemaVersion: 1, taskId, label: "runtime" },
      parseOwnedRecord,
    );
    const runtime = await onlyResourceDirectory(runtimeRecords, "runtime");
    const outside = join(root, "outside-discard.json");
    await writeFile(outside, "outside\n");
    await unlink(join(runtime, "record.json"));
    await symlink(outside, join(runtime, "record.json"));

    await expect(store.discard(taskId)).rejects.toBeInstanceOf(
      ArtifactPathSecurityError,
    );
    await expect(
      readFile(join(ownedBuild, "record.json"), "utf8"),
    ).resolves.toContain("survives-symlink");
    await expect(readFile(outside, "utf8")).resolves.toBe("outside\n");
  });

  it("publishes into a pre-created empty root and strictly reopens it", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-runtime-open-"));
    const taskId = asTaskId("task_runtime_open");
    const taskRoot = await createTaskRoot(root, taskId);
    const runtimeRecords = join(taskRoot, "runtime-records");
    await mkdir(runtimeRecords, { mode: 0o700 });

    const creatingStore = new VNextRuntimeStore(root);
    await creatingStore.create(taskId);
    await creatingStore.putResourceOnce(
      taskId,
      "build",
      "build_open",
      { schemaVersion: 1, taskId, label: "open" },
      parseOwnedRecord,
    );

    const resumedStore = new VNextRuntimeStore(root);
    await resumedStore.open(taskId);
    await expect(
      resumedStore.readResource(
        taskId,
        "build",
        "build_open",
        parseOwnedRecord,
      ),
    ).resolves.toMatchObject({ label: "open" });

    await writeFile(join(runtimeRecords, "foreign"), "foreign\n");
    const rejectedStore = new VNextRuntimeStore(root);
    await expect(rejectedStore.open(taskId)).rejects.toBeInstanceOf(
      ArtifactPathSecurityError,
    );
  });

  it("strict open revalidates stored hashes before resuming", async () => {
    const { root, runtimeRecords, store, taskId } = await createHarness(
      asTaskId("task_runtime_resume_corrupt"),
    );
    await store.putResourceOnce(
      taskId,
      "index",
      "index_corrupt",
      { schemaVersion: 1, taskId, label: "before" },
      parseOwnedRecord,
    );
    const resource = await onlyResourceDirectory(runtimeRecords, "index");
    const path = join(resource, "record.json");
    const envelope = JSON.parse(await readFile(path, "utf8")) as {
      payload: { label: string };
    };
    envelope.payload.label = "after";
    await writeFile(path, `${canonicalJson(envelope as never)}\n`);

    const resumedStore = new VNextRuntimeStore(root);
    await expect(resumedStore.open(taskId)).rejects.toBeInstanceOf(
      ArtifactCorruptionError,
    );
  });
});
