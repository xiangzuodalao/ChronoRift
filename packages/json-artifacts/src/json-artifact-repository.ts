import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  BranchRecordSchema,
  BranchRunSchema,
  CheckpointContentSchema,
  CheckpointSchema,
  DiagnosisReportSchema,
  EvidenceBundleSchema,
  InputTraceSchema,
  InvariantEvaluationSchema,
  RunManifestSchema,
  TelemetryEventSchema,
  asCheckpointId,
  type BranchId,
  type BranchRecord,
  type BranchRun,
  type Checkpoint,
  type CheckpointContent,
  type CheckpointId,
  type DiagnosisReport,
  type EvaluationId,
  type EvidenceBundle,
  type EvidenceId,
  type InputTrace,
  type InputTraceId,
  type InvariantEvaluation,
  type JsonValue,
  type ReportId,
  type RunId,
  type RunManifest,
  type TelemetryEvent,
} from "@chronorift/domain";
import type { ArtifactRepositoryPort } from "@chronorift/gamebranch";

import { contentHash } from "./canonical-json.js";

export class ArtifactNotFoundError extends Error {
  constructor(readonly artifactPath: string) {
    super(`Artifact not found: ${artifactPath}`);
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactCorruptionError extends Error {
  constructor(
    readonly artifactPath: string,
    cause: unknown,
  ) {
    super(`Artifact is invalid: ${artifactPath}`, { cause });
    this.name = "ArtifactCorruptionError";
  }
}

export class ManifestRevisionConflictError extends Error {
  constructor(
    readonly runId: RunId,
    readonly expected: number | null,
    readonly actual: number | null,
  ) {
    super(
      `Manifest revision conflict for ${runId}: expected ${String(expected)}, actual ${String(actual)}`,
    );
    this.name = "ManifestRevisionConflictError";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const artifactSegment = (id: string): string => encodeURIComponent(id);

/** Durable, schema-validating JSON/JSONL implementation of the core repository port. */
export class JsonArtifactRepository implements ArtifactRepositoryPort {
  constructor(readonly rootDirectory: string) {}

  async putCheckpoint(content: CheckpointContent): Promise<Checkpoint> {
    const parsed = CheckpointContentSchema.parse(content);
    const checkpoint: Checkpoint = {
      checkpointId: asCheckpointId(
        `checkpoint_${contentHash(parsed as unknown as JsonValue)}`,
      ),
      content: parsed,
    };
    await this.writeJson(
      this.path(
        "checkpoints",
        `${artifactSegment(checkpoint.checkpointId)}.json`,
      ),
      CheckpointSchema.parse(checkpoint),
    );
    return checkpoint;
  }

  async getCheckpoint(checkpointId: CheckpointId): Promise<Checkpoint> {
    return this.readJson(
      this.path("checkpoints", `${artifactSegment(checkpointId)}.json`),
      CheckpointSchema,
    );
  }

  async putInputTrace(trace: InputTrace): Promise<void> {
    const parsed = InputTraceSchema.parse(trace);
    await this.writeJson(
      this.path("traces", `${artifactSegment(parsed.inputTraceId)}.json`),
      parsed,
    );
  }

  async getInputTrace(inputTraceId: InputTraceId): Promise<InputTrace> {
    return this.readJson(
      this.path("traces", `${artifactSegment(inputTraceId)}.json`),
      InputTraceSchema,
    );
  }

  async putBranch(branch: BranchRecord): Promise<void> {
    const parsed = BranchRecordSchema.parse(branch);
    await this.writeJson(
      this.path("branches", artifactSegment(parsed.branchId), "branch.json"),
      parsed,
    );
  }

  async getBranch(branchId: BranchId): Promise<BranchRecord> {
    return this.readJson(
      this.path("branches", artifactSegment(branchId), "branch.json"),
      BranchRecordSchema,
    );
  }

  async appendTelemetry(
    branchId: BranchId,
    events: readonly TelemetryEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    const parsed = events.map((event) => TelemetryEventSchema.parse(event));
    const path = this.path(
      "branches",
      artifactSegment(branchId),
      "events.jsonl",
    );
    await mkdir(dirname(path), { recursive: true });
    await appendFile(
      path,
      `${parsed.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
  }

  async readTelemetry(branchId: BranchId): Promise<readonly TelemetryEvent[]> {
    const path = this.path(
      "branches",
      artifactSegment(branchId),
      "events.jsonl",
    );
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new ArtifactNotFoundError(path);
      }
      throw error;
    }

    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const events: TelemetryEvent[] = [];
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      try {
        events.push(TelemetryEventSchema.parse(JSON.parse(line)));
      } catch (error) {
        const isLast = index === lines.length - 1;
        if (isLast && !text.endsWith("\n")) break;
        throw new ArtifactCorruptionError(`${path}:${index + 1}`, error);
      }
    }
    return events;
  }

  async putBranchRun(run: BranchRun): Promise<void> {
    const parsed = BranchRunSchema.parse(run);
    await this.writeJson(
      this.path("branches", artifactSegment(parsed.branchId), "run.json"),
      parsed,
    );
  }

  async getBranchRun(branchId: BranchId): Promise<BranchRun> {
    return this.readJson(
      this.path("branches", artifactSegment(branchId), "run.json"),
      BranchRunSchema,
    );
  }

  async putEvaluation(evaluation: InvariantEvaluation): Promise<void> {
    const parsed = InvariantEvaluationSchema.parse(evaluation);
    await this.writeJson(
      this.path("evaluations", `${artifactSegment(parsed.evaluationId)}.json`),
      parsed,
    );
  }

  async getEvaluation(
    evaluationId: EvaluationId,
  ): Promise<InvariantEvaluation> {
    return this.readJson(
      this.path("evaluations", `${artifactSegment(evaluationId)}.json`),
      InvariantEvaluationSchema,
    );
  }

  async putEvidence(evidence: EvidenceBundle): Promise<void> {
    const parsed = EvidenceBundleSchema.parse(evidence);
    await this.writeJson(
      this.path("evidence", `${artifactSegment(parsed.evidenceId)}.json`),
      parsed,
    );
  }

  async getEvidence(evidenceId: EvidenceId): Promise<EvidenceBundle> {
    return this.readJson(
      this.path("evidence", `${artifactSegment(evidenceId)}.json`),
      EvidenceBundleSchema,
    );
  }

  async putManifest(
    manifest: RunManifest,
    expectedRevision: number | null,
  ): Promise<void> {
    const parsed = RunManifestSchema.parse(manifest);
    const path = this.path(
      "runs",
      artifactSegment(parsed.runId),
      "manifest.json",
    );
    const present = await exists(path);
    let actualRevision: number | null = null;
    if (present) {
      actualRevision = (await this.readJson(path, RunManifestSchema)).revision;
    }

    if (actualRevision !== expectedRevision) {
      throw new ManifestRevisionConflictError(
        parsed.runId,
        expectedRevision,
        actualRevision,
      );
    }
    const requiredRevision =
      expectedRevision === null ? 0 : expectedRevision + 1;
    if (parsed.revision !== requiredRevision) {
      throw new ManifestRevisionConflictError(
        parsed.runId,
        requiredRevision,
        parsed.revision,
      );
    }
    await this.writeJson(path, parsed);
  }

  async getManifest(runId: RunId): Promise<RunManifest> {
    return this.readJson(
      this.path("runs", artifactSegment(runId), "manifest.json"),
      RunManifestSchema,
    );
  }

  async putDiagnosis(report: DiagnosisReport): Promise<void> {
    const parsed = DiagnosisReportSchema.parse(report);
    await this.writeJson(
      this.path("diagnoses", `${artifactSegment(parsed.reportId)}.json`),
      parsed,
    );
  }

  async getDiagnosis(reportId: ReportId): Promise<DiagnosisReport> {
    return this.readJson(
      this.path("diagnoses", `${artifactSegment(reportId)}.json`),
      DiagnosisReportSchema,
    );
  }

  resolveRunDirectory(runId: RunId): string {
    return this.path("runs", artifactSegment(runId));
  }

  private path(...segments: string[]): string {
    return join(this.rootDirectory, ...segments);
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, path);
  }

  private async readJson<T>(
    path: string,
    schema: { parse(value: unknown): T },
  ): Promise<T> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new ArtifactNotFoundError(path);
      }
      throw error;
    }
    try {
      return schema.parse(JSON.parse(text));
    } catch (error) {
      throw new ArtifactCorruptionError(path, error);
    }
  }
}
