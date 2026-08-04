import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ArtifactIntegrityError,
  ArtifactPathSecurityError,
  ImmutableArtifactConflictError,
} from "./v01-json-artifact-repository.js";
import { V03BenchmarkJsonLedger } from "./v03-benchmark-json-ledger.js";

const definitionId = "benchmark-definition:test";
const executionId = "benchmark-execution:test";
const cellId = "benchmark-cell:test";
const attemptId = "benchmark-attempt:test:1";

describe("V03BenchmarkJsonLedger", () => {
  it("persists the formal benchmark tree with write-once records", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-benchmark-ledger-"));
    const ledger = new V03BenchmarkJsonLedger(root);
    const definition = { schemaVersion: 2, definitionId } as const;
    const started = { schemaVersion: 2, definitionId, executionId } as const;
    const attemptStarted = {
      schemaVersion: 2,
      executionId,
      cellId,
      attemptId,
      ordinal: 1,
    } as const;
    const attemptFinished = {
      ...attemptStarted,
      outcome: "diagnostic_failure",
    } as const;
    const cell = {
      schemaVersion: 2,
      executionId,
      cellId,
      status: "terminal",
    } as const;
    const completed = {
      schemaVersion: 2,
      executionId,
      status: "complete",
    } as const;

    await ledger.writeDefinition(definitionId, definition);
    await ledger.writeExecutionStarted(definitionId, executionId, started);
    await ledger.writeAttemptStarted(
      definitionId,
      executionId,
      cellId,
      1,
      attemptId,
      attemptStarted,
    );
    await ledger.writeAttemptFinished(
      definitionId,
      executionId,
      cellId,
      1,
      attemptId,
      attemptFinished,
    );
    await ledger.writeCell(definitionId, executionId, cellId, cell);
    await ledger.writeExecutionCompleted(definitionId, executionId, completed);

    await expect(ledger.readDefinition(definitionId)).resolves.toEqual(
      definition,
    );
    await expect(
      ledger.readAttemptFinished(
        definitionId,
        executionId,
        cellId,
        1,
        attemptId,
      ),
    ).resolves.toEqual(attemptFinished);
    await expect(
      ledger.tryReadExecutionCompleted(definitionId, executionId),
    ).resolves.toEqual(completed);
    await expect(
      readFile(
        join(
          root,
          "v0.3",
          "benchmarks",
          "definitions",
          encodeURIComponent(definitionId),
          "executions",
          encodeURIComponent(executionId),
          "attempts",
          encodeURIComponent(cellId),
          `001-${encodeURIComponent(attemptId)}`,
          "finished.json",
        ),
        "utf8",
      ),
    ).resolves.toContain('"outcome":"diagnostic_failure"');

    await expect(
      ledger.writeCell(definitionId, executionId, cellId, {
        ...cell,
        status: "different",
      }),
    ).rejects.toBeInstanceOf(ImmutableArtifactConflictError);
  });

  it("returns null only for missing optional terminal records", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-benchmark-missing-"));
    const ledger = new V03BenchmarkJsonLedger(root);
    await expect(
      ledger.tryReadCell(definitionId, executionId, cellId),
    ).resolves.toBeNull();
    await expect(
      ledger.readCell(definitionId, executionId, cellId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("rejects path-like IDs and invalid attempt ordinals", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-benchmark-path-"));
    const ledger = new V03BenchmarkJsonLedger(root);
    expect(() => ledger.definitionPath("../escape")).toThrow(
      ArtifactPathSecurityError,
    );
    expect(() =>
      ledger.attemptStartedPath(
        definitionId,
        executionId,
        cellId,
        0,
        attemptId,
      ),
    ).toThrow(ArtifactPathSecurityError);
  });

  it("rejects a symlinked intermediate directory without writing outside", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-benchmark-symlink-"));
    const outside = await mkdtemp(
      join(tmpdir(), "chronorift-benchmark-outside-"),
    );
    await mkdir(join(root, "v0.3", "benchmarks"), { recursive: true });
    await symlink(outside, join(root, "v0.3", "benchmarks", "definitions"));
    const ledger = new V03BenchmarkJsonLedger(root);
    await expect(
      ledger.writeDefinition(definitionId, { schemaVersion: 2 }),
    ).rejects.toBeInstanceOf(ArtifactPathSecurityError);
    await expect(
      access(join(outside, encodeURIComponent(definitionId))),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports corrupted JSON rather than treating it as resumable state", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-benchmark-corrupt-"));
    const ledger = new V03BenchmarkJsonLedger(root);
    await ledger.writeDefinition(definitionId, { schemaVersion: 2 });
    await writeFile(ledger.definitionPath(definitionId), "not json\n");
    await expect(ledger.readDefinition(definitionId)).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
  });

  it("ignores an unpublished crash temporary and atomically publishes the final", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-benchmark-crash-"));
    const ledger = new V03BenchmarkJsonLedger(root);
    const path = ledger.definitionPath(definitionId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(join(dirname(path), ".crashed.chronorift-tmp"), "partial");
    await ledger.writeDefinition(definitionId, { schemaVersion: 2 });
    await expect(ledger.readDefinition(definitionId)).resolves.toEqual({
      schemaVersion: 2,
    });
  });
});
