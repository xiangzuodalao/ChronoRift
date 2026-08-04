import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import { JsonValueSchema, type JsonValue } from "@chronorift/domain";

import { canonicalJson } from "./canonical-json.js";
import {
  ArtifactIntegrityError,
  ArtifactPathSecurityError,
  ImmutableArtifactConflictError,
} from "./v01-json-artifact-repository.js";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function safeSegment(value: string): string {
  const hasParentSegment = value
    .split(/[\\/]+/u)
    .some((segment) => segment === "..");
  if (
    value.length === 0 ||
    value === "." ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    hasParentSegment
  ) {
    throw new ArtifactPathSecurityError(
      value,
      "benchmark IDs must be non-empty path-free relative values",
    );
  }
  try {
    return encodeURIComponent(value).replaceAll(".", "%2E");
  } catch (error) {
    throw new ArtifactPathSecurityError(
      value,
      error instanceof Error ? error.message : "benchmark ID cannot be encoded",
    );
  }
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

/**
 * Low-level append-only storage for formal benchmark records.
 *
 * Schemas remain owned by domain/gamebranch. This adapter validates that every
 * payload is JSON and guarantees the immutable on-disk layout. Typed callers
 * must parse every value returned from a read before trusting it.
 */
export class V03BenchmarkJsonLedger {
  public readonly rootDirectory: string;
  private readonly artifactRoot: string;

  public constructor(artifactRoot: string) {
    this.artifactRoot = resolve(artifactRoot);
    this.rootDirectory = resolve(
      this.artifactRoot,
      "v0.3",
      "benchmarks",
      "definitions",
    );
    if (!isContained(this.artifactRoot, this.rootDirectory)) {
      throw new ArtifactPathSecurityError(this.rootDirectory);
    }
  }

  public definitionPath(definitionId: string): string {
    return this.filePath([safeSegment(definitionId), "definition.json"]);
  }

  public executionSelectionPath(definitionId: string): string {
    return this.filePath([safeSegment(definitionId), "selection.json"]);
  }

  public executionStartedPath(
    definitionId: string,
    executionId: string,
  ): string {
    return this.executionFilePath(definitionId, executionId, "started.json");
  }

  public attemptStartedPath(
    definitionId: string,
    executionId: string,
    cellId: string,
    ordinal: number,
    attemptId: string,
  ): string {
    return this.attemptFilePath(
      definitionId,
      executionId,
      cellId,
      ordinal,
      attemptId,
      "started.json",
    );
  }

  public attemptFinishedPath(
    definitionId: string,
    executionId: string,
    cellId: string,
    ordinal: number,
    attemptId: string,
  ): string {
    return this.attemptFilePath(
      definitionId,
      executionId,
      cellId,
      ordinal,
      attemptId,
      "finished.json",
    );
  }

  public attemptProgressPath(
    definitionId: string,
    executionId: string,
    cellId: string,
    ordinal: number,
    attemptId: string,
    sequence: number,
  ): string {
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new ArtifactPathSecurityError(
        String(sequence),
        "progress sequence must be a positive integer",
      );
    }
    return this.attemptFilePath(
      definitionId,
      executionId,
      cellId,
      ordinal,
      attemptId,
      join("progress", `${String(sequence).padStart(6, "0")}.json`),
    );
  }

  public cellPath(
    definitionId: string,
    executionId: string,
    cellId: string,
  ): string {
    return this.executionFilePath(
      definitionId,
      executionId,
      "cells",
      `${safeSegment(cellId)}.json`,
    );
  }

  public executionCompletedPath(
    definitionId: string,
    executionId: string,
  ): string {
    return this.executionFilePath(definitionId, executionId, "completed.json");
  }

  public writeDefinition(
    definitionId: string,
    value: JsonValue,
  ): Promise<void> {
    return this.writeImmutable(this.definitionPath(definitionId), value);
  }

  public readDefinition(definitionId: string): Promise<JsonValue> {
    return this.readRequired(
      this.definitionPath(definitionId),
      `benchmark-definition:${definitionId}`,
    );
  }

  public writeExecutionSelection(
    definitionId: string,
    value: JsonValue,
  ): Promise<void> {
    return this.writeImmutable(
      this.executionSelectionPath(definitionId),
      value,
    );
  }

  public tryReadExecutionSelection(
    definitionId: string,
  ): Promise<JsonValue | null> {
    return this.readOptional(
      this.executionSelectionPath(definitionId),
      `benchmark-execution-selection:${definitionId}`,
    );
  }

  public writeExecutionStarted(
    definitionId: string,
    executionId: string,
    value: JsonValue,
  ): Promise<void> {
    return this.writeImmutable(
      this.executionStartedPath(definitionId, executionId),
      value,
    );
  }

  public readExecutionStarted(
    definitionId: string,
    executionId: string,
  ): Promise<JsonValue> {
    return this.readRequired(
      this.executionStartedPath(definitionId, executionId),
      `benchmark-execution-started:${executionId}`,
    );
  }

  public tryReadExecutionStarted(
    definitionId: string,
    executionId: string,
  ): Promise<JsonValue | null> {
    return this.readOptional(
      this.executionStartedPath(definitionId, executionId),
      `benchmark-execution-started:${executionId}`,
    );
  }

  public writeAttemptStarted(
    definitionId: string,
    executionId: string,
    cellId: string,
    ordinal: number,
    attemptId: string,
    value: JsonValue,
  ): Promise<void> {
    return this.writeImmutable(
      this.attemptStartedPath(
        definitionId,
        executionId,
        cellId,
        ordinal,
        attemptId,
      ),
      value,
    );
  }

  public readAttemptStarted(
    definitionId: string,
    executionId: string,
    cellId: string,
    ordinal: number,
    attemptId: string,
  ): Promise<JsonValue> {
    return this.readRequired(
      this.attemptStartedPath(
        definitionId,
        executionId,
        cellId,
        ordinal,
        attemptId,
      ),
      `benchmark-attempt-started:${attemptId}`,
    );
  }

  public tryReadAttemptStarted(
    definitionId: string,
    executionId: string,
    cellId: string,
    ordinal: number,
    attemptId: string,
  ): Promise<JsonValue | null> {
    return this.readOptional(
      this.attemptStartedPath(
        definitionId,
        executionId,
        cellId,
        ordinal,
        attemptId,
      ),
      `benchmark-attempt-started:${attemptId}`,
    );
  }

  public writeAttemptFinished(
    definitionId: string,
    executionId: string,
    cellId: string,
    ordinal: number,
    attemptId: string,
    value: JsonValue,
  ): Promise<void> {
    return this.writeImmutable(
      this.attemptFinishedPath(
        definitionId,
        executionId,
        cellId,
        ordinal,
        attemptId,
      ),
      value,
    );
  }

  public writeAttemptProgress(
    definitionId: string,
    executionId: string,
    cellId: string,
    ordinal: number,
    attemptId: string,
    sequence: number,
    value: JsonValue,
  ): Promise<void> {
    return this.writeImmutable(
      this.attemptProgressPath(
        definitionId,
        executionId,
        cellId,
        ordinal,
        attemptId,
        sequence,
      ),
      value,
    );
  }

  public async listAttemptProgress(
    definitionId: string,
    executionId: string,
    cellId: string,
    ordinal: number,
    attemptId: string,
  ): Promise<readonly JsonValue[]> {
    const directory = dirname(
      this.attemptProgressPath(
        definitionId,
        executionId,
        cellId,
        ordinal,
        attemptId,
        1,
      ),
    );
    let entries: readonly string[];
    try {
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new ArtifactPathSecurityError(directory);
      }
      entries = await readdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    const names = entries.filter((name) => !name.startsWith(".")).sort();
    if (names.some((name) => !/^\d{6}\.json$/u.test(name))) {
      throw new ArtifactIntegrityError(`benchmark-progress:${attemptId}`);
    }
    const values: JsonValue[] = [];
    for (const name of names) {
      values.push(
        await this.readRequired(
          join(directory, name),
          `benchmark-progress:${attemptId}:${name}`,
        ),
      );
    }
    return values;
  }

  public readAttemptFinished(
    definitionId: string,
    executionId: string,
    cellId: string,
    ordinal: number,
    attemptId: string,
  ): Promise<JsonValue> {
    return this.readRequired(
      this.attemptFinishedPath(
        definitionId,
        executionId,
        cellId,
        ordinal,
        attemptId,
      ),
      `benchmark-attempt-finished:${attemptId}`,
    );
  }

  public tryReadAttemptFinished(
    definitionId: string,
    executionId: string,
    cellId: string,
    ordinal: number,
    attemptId: string,
  ): Promise<JsonValue | null> {
    return this.readOptional(
      this.attemptFinishedPath(
        definitionId,
        executionId,
        cellId,
        ordinal,
        attemptId,
      ),
      `benchmark-attempt-finished:${attemptId}`,
    );
  }

  public writeCell(
    definitionId: string,
    executionId: string,
    cellId: string,
    value: JsonValue,
  ): Promise<void> {
    return this.writeImmutable(
      this.cellPath(definitionId, executionId, cellId),
      value,
    );
  }

  public readCell(
    definitionId: string,
    executionId: string,
    cellId: string,
  ): Promise<JsonValue> {
    return this.readRequired(
      this.cellPath(definitionId, executionId, cellId),
      `benchmark-cell:${cellId}`,
    );
  }

  public tryReadCell(
    definitionId: string,
    executionId: string,
    cellId: string,
  ): Promise<JsonValue | null> {
    return this.readOptional(
      this.cellPath(definitionId, executionId, cellId),
      `benchmark-cell:${cellId}`,
    );
  }

  public writeExecutionCompleted(
    definitionId: string,
    executionId: string,
    value: JsonValue,
  ): Promise<void> {
    return this.writeImmutable(
      this.executionCompletedPath(definitionId, executionId),
      value,
    );
  }

  public readExecutionCompleted(
    definitionId: string,
    executionId: string,
  ): Promise<JsonValue> {
    return this.readRequired(
      this.executionCompletedPath(definitionId, executionId),
      `benchmark-execution-completed:${executionId}`,
    );
  }

  public tryReadExecutionCompleted(
    definitionId: string,
    executionId: string,
  ): Promise<JsonValue | null> {
    return this.readOptional(
      this.executionCompletedPath(definitionId, executionId),
      `benchmark-execution-completed:${executionId}`,
    );
  }

  private filePath(segments: readonly string[]): string {
    const candidate = resolve(this.rootDirectory, ...segments);
    if (!isContained(this.rootDirectory, candidate)) {
      throw new ArtifactPathSecurityError(candidate);
    }
    return candidate;
  }

  private executionFilePath(
    definitionId: string,
    executionId: string,
    ...segments: readonly string[]
  ): string {
    return this.filePath([
      safeSegment(definitionId),
      "executions",
      safeSegment(executionId),
      ...segments,
    ]);
  }

  private attemptFilePath(
    definitionId: string,
    executionId: string,
    cellId: string,
    ordinal: number,
    attemptId: string,
    filename: string,
  ): string {
    if (!Number.isInteger(ordinal) || ordinal < 1) {
      throw new ArtifactPathSecurityError(
        String(ordinal),
        "attempt ordinal must be a positive integer",
      );
    }
    return this.executionFilePath(
      definitionId,
      executionId,
      "attempts",
      safeSegment(cellId),
      `${String(ordinal).padStart(3, "0")}-${safeSegment(attemptId)}`,
      filename,
    );
  }

  private async ensureRealDirectory(directory: string): Promise<void> {
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      await mkdir(directory);
      metadata = await lstat(directory);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ArtifactPathSecurityError(directory);
    }
  }

  private async assertSafeParents(path: string): Promise<void> {
    await mkdir(this.artifactRoot, { recursive: true });
    await this.ensureRealDirectory(this.artifactRoot);
    const pathFromRoot = relative(this.artifactRoot, dirname(path));
    if (
      pathFromRoot === ".." ||
      pathFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(pathFromRoot)
    ) {
      throw new ArtifactPathSecurityError(path);
    }
    let directory = this.artifactRoot;
    for (const segment of pathFromRoot.split(sep).filter(Boolean)) {
      directory = join(directory, segment);
      await this.ensureRealDirectory(directory);
    }
    const canonicalRoot = await realpath(this.artifactRoot);
    const canonicalParent = await realpath(dirname(path));
    if (!isContained(canonicalRoot, canonicalParent)) {
      throw new ArtifactPathSecurityError(path);
    }
  }

  private async assertSafeFile(path: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new ArtifactPathSecurityError(path);
    }
    const canonicalRoot = await realpath(this.artifactRoot);
    const canonicalPath = await realpath(path);
    if (!isContained(canonicalRoot, canonicalPath)) {
      throw new ArtifactPathSecurityError(path);
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeImmutable(path: string, input: JsonValue): Promise<void> {
    const value = JsonValueSchema.parse(input);
    await this.assertSafeParents(path);
    const serialized = `${canonicalJson(value)}\n`;
    const temporaryPath = join(
      dirname(path),
      `.${process.pid}-${randomUUID()}.chronorift-tmp`,
    );
    let temporaryExists = false;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      temporaryExists = true;
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        // A hard link publishes the fully-fsynced inode without ever replacing
        // an existing immutable artifact. A crash before this point leaves only
        // an ignored temporary file; a crash after it leaves a complete final.
        await link(temporaryPath, path);
        // Persist the directory entry, not only the linked file inode.
        await this.syncDirectory(dirname(path));
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        await this.assertSafeFile(path);
        if ((await readFile(path, "utf8")) !== serialized) {
          throw new ImmutableArtifactConflictError(path);
        }
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST" && !temporaryExists) {
        throw new ArtifactIntegrityError(
          "benchmark temporary artifact name collision",
        );
      }
      throw error;
    } finally {
      if (temporaryExists) {
        try {
          await unlink(temporaryPath);
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        }
      }
    }
  }

  private async readRequired(
    path: string,
    identity: string,
  ): Promise<JsonValue> {
    const value = await this.readOptional(path, identity);
    if (value === null) throw new ArtifactIntegrityError(identity);
    return value;
  }

  private async readOptional(
    path: string,
    identity: string,
  ): Promise<JsonValue | null> {
    try {
      await this.assertSafeFile(path);
      return JsonValueSchema.parse(
        JSON.parse(await readFile(path, "utf8")) as unknown,
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      if (
        error instanceof ArtifactPathSecurityError ||
        error instanceof ArtifactIntegrityError
      ) {
        throw error;
      }
      void error;
      throw new ArtifactIntegrityError(identity);
    }
  }
}
