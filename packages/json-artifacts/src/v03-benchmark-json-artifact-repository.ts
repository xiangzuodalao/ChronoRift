import {
  BenchmarkAttemptStartedV2Schema,
  BenchmarkAttemptProgressV2Schema,
  BenchmarkAttemptFinishedV2Schema,
  BenchmarkCellResultV2Schema,
  BenchmarkExecutionStartedV2Schema,
  BenchmarkExecutionSelectionV2Schema,
  BenchmarkReportV2Schema,
  BenchmarkSuiteSpecV2Schema,
  type BenchmarkAttemptId,
  type BenchmarkAttemptStartedV2,
  type BenchmarkAttemptProgressV2,
  type BenchmarkAttemptFinishedV2,
  type BenchmarkCellId,
  type BenchmarkCellResultV2,
  type BenchmarkDefinitionId,
  type BenchmarkExecutionId,
  type BenchmarkExecutionStartedV2,
  type BenchmarkExecutionSelectionV2,
  type BenchmarkReportV2,
  type BenchmarkSuiteSpecV2,
  type JsonValue,
} from "@chronorift/domain";
import type { V03BenchmarkArtifactRepositoryPort } from "@chronorift/gamebranch";

import { ArtifactIntegrityError } from "./v01-json-artifact-repository.js";
import { contentHash } from "./canonical-json.js";
import { V03BenchmarkJsonLedger } from "./v03-benchmark-json-ledger.js";

interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

export class V03BenchmarkJsonArtifactRepository implements V03BenchmarkArtifactRepositoryPort {
  public readonly ledger: V03BenchmarkJsonLedger;

  public constructor(artifactRoot: string) {
    this.ledger = new V03BenchmarkJsonLedger(artifactRoot);
  }

  private parseStored<T>(
    schema: RuntimeSchema<T>,
    value: unknown,
    identity: string,
  ): T {
    try {
      return schema.parse(value);
    } catch (error) {
      void error;
      throw new ArtifactIntegrityError(identity);
    }
  }

  private assertAttemptFinishedIntegrity(
    record: BenchmarkAttemptFinishedV2,
  ): BenchmarkAttemptFinishedV2 {
    const outcome = record.attempt.outcome;
    if (
      (outcome.status === "completed" ||
        outcome.status === "diagnostic_failure") &&
      (record.rawManifest === null ||
        contentHash(record.rawManifest) !== outcome.rawManifestHash ||
        record.terminalCell?.rawManifestHash !== outcome.rawManifestHash)
    ) {
      throw new ArtifactIntegrityError(record.attempt.attemptId);
    }
    return record;
  }

  public putDefinition(spec: BenchmarkSuiteSpecV2): Promise<void> {
    const parsed = BenchmarkSuiteSpecV2Schema.parse(spec);
    return this.ledger.writeDefinition(
      parsed.definitionId,
      parsed as unknown as JsonValue,
    );
  }

  public async getDefinition(
    id: BenchmarkDefinitionId,
  ): Promise<BenchmarkSuiteSpecV2> {
    const parsed = this.parseStored(
      BenchmarkSuiteSpecV2Schema,
      await this.ledger.readDefinition(id),
      `benchmark-definition:${id}`,
    );
    if (parsed.definitionId !== id) throw new ArtifactIntegrityError(id);
    return parsed;
  }

  public putExecutionStarted(
    record: BenchmarkExecutionStartedV2,
  ): Promise<void> {
    const parsed = BenchmarkExecutionStartedV2Schema.parse(record);
    return this.ledger.writeExecutionStarted(
      parsed.definitionId,
      parsed.executionId,
      parsed as unknown as JsonValue,
    );
  }

  public putExecutionSelection(
    record: BenchmarkExecutionSelectionV2,
  ): Promise<void> {
    const parsed = BenchmarkExecutionSelectionV2Schema.parse(record);
    return this.ledger.writeExecutionSelection(
      parsed.definitionId,
      parsed as unknown as JsonValue,
    );
  }

  public async getExecutionSelection(
    definitionId: BenchmarkDefinitionId,
  ): Promise<BenchmarkExecutionSelectionV2 | null> {
    const value = await this.ledger.tryReadExecutionSelection(definitionId);
    const parsed =
      value === null
        ? null
        : this.parseStored(
            BenchmarkExecutionSelectionV2Schema,
            value,
            `benchmark-execution-selection:${definitionId}`,
          );
    if (parsed !== null && parsed.definitionId !== definitionId) {
      throw new ArtifactIntegrityError(definitionId);
    }
    return parsed;
  }

  public async getExecutionStarted(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
  ): Promise<BenchmarkExecutionStartedV2 | null> {
    const value = await this.ledger.tryReadExecutionStarted(
      definitionId,
      executionId,
    );
    const parsed =
      value === null
        ? null
        : this.parseStored(
            BenchmarkExecutionStartedV2Schema,
            value,
            `benchmark-execution-started:${executionId}`,
          );
    if (
      parsed !== null &&
      (parsed.definitionId !== definitionId ||
        parsed.executionId !== executionId)
    ) {
      throw new ArtifactIntegrityError(executionId);
    }
    return parsed;
  }

  public putAttemptStarted(record: BenchmarkAttemptStartedV2): Promise<void> {
    const parsed = BenchmarkAttemptStartedV2Schema.parse(record);
    return this.ledger.writeAttemptStarted(
      parsed.definitionId,
      parsed.executionId,
      parsed.cellId,
      parsed.ordinal,
      parsed.attemptId,
      parsed as unknown as JsonValue,
    );
  }

  public async getAttemptStarted(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
    ordinal: number,
    attemptId: BenchmarkAttemptId,
  ): Promise<BenchmarkAttemptStartedV2 | null> {
    const value = await this.ledger.tryReadAttemptStarted(
      definitionId,
      executionId,
      cellId,
      ordinal,
      attemptId,
    );
    const parsed =
      value === null
        ? null
        : this.parseStored(
            BenchmarkAttemptStartedV2Schema,
            value,
            `benchmark-attempt-started:${attemptId}`,
          );
    if (
      parsed !== null &&
      (parsed.definitionId !== definitionId ||
        parsed.executionId !== executionId ||
        parsed.cellId !== cellId ||
        parsed.ordinal !== ordinal ||
        parsed.attemptId !== attemptId)
    ) {
      throw new ArtifactIntegrityError(attemptId);
    }
    return parsed;
  }

  public putAttemptFinished(record: BenchmarkAttemptFinishedV2): Promise<void> {
    const parsed = this.assertAttemptFinishedIntegrity(
      BenchmarkAttemptFinishedV2Schema.parse(record),
    );
    return this.ledger.writeAttemptFinished(
      parsed.attempt.definitionId,
      parsed.attempt.executionId,
      parsed.attempt.cellId,
      parsed.attempt.ordinal,
      parsed.attempt.attemptId,
      parsed as unknown as JsonValue,
    );
  }

  public putAttemptProgress(record: BenchmarkAttemptProgressV2): Promise<void> {
    const parsed = BenchmarkAttemptProgressV2Schema.parse(record);
    return this.ledger.writeAttemptProgress(
      parsed.definitionId,
      parsed.executionId,
      parsed.cellId,
      parsed.ordinal,
      parsed.attemptId,
      parsed.sequence,
      parsed as unknown as JsonValue,
    );
  }

  public async getLatestAttemptProgress(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
    ordinal: number,
    attemptId: BenchmarkAttemptId,
  ): Promise<BenchmarkAttemptProgressV2 | null> {
    const values = await this.ledger.listAttemptProgress(
      definitionId,
      executionId,
      cellId,
      ordinal,
      attemptId,
    );
    const records = values.map((value, index) => {
      const record = this.parseStored(
        BenchmarkAttemptProgressV2Schema,
        value,
        `benchmark-attempt-progress:${attemptId}:${index + 1}`,
      );
      if (
        record.definitionId !== definitionId ||
        record.executionId !== executionId ||
        record.cellId !== cellId ||
        record.ordinal !== ordinal ||
        record.attemptId !== attemptId ||
        record.sequence !== index + 1
      ) {
        throw new ArtifactIntegrityError(attemptId);
      }
      return record;
    });
    return records.at(-1) ?? null;
  }

  public async getAttemptFinished(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
    ordinal: number,
    attemptId: BenchmarkAttemptId,
  ): Promise<BenchmarkAttemptFinishedV2 | null> {
    const value = await this.ledger.tryReadAttemptFinished(
      definitionId,
      executionId,
      cellId,
      ordinal,
      attemptId,
    );
    const parsed =
      value === null
        ? null
        : this.assertAttemptFinishedIntegrity(
            this.parseStored(
              BenchmarkAttemptFinishedV2Schema,
              value,
              `benchmark-attempt-finished:${attemptId}`,
            ),
          );
    if (
      parsed !== null &&
      (parsed.attempt.definitionId !== definitionId ||
        parsed.attempt.executionId !== executionId ||
        parsed.attempt.cellId !== cellId ||
        parsed.attempt.ordinal !== ordinal ||
        parsed.attempt.attemptId !== attemptId)
    ) {
      throw new ArtifactIntegrityError(attemptId);
    }
    return parsed;
  }

  public putCell(record: BenchmarkCellResultV2): Promise<void> {
    const parsed = BenchmarkCellResultV2Schema.parse(record);
    return this.ledger.writeCell(
      parsed.definitionId,
      parsed.executionId,
      parsed.cellId,
      parsed,
    );
  }

  public async getCell(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
  ): Promise<BenchmarkCellResultV2 | null> {
    const value = await this.ledger.tryReadCell(
      definitionId,
      executionId,
      cellId,
    );
    const parsed =
      value === null
        ? null
        : this.parseStored(
            BenchmarkCellResultV2Schema,
            value,
            `benchmark-cell:${cellId}`,
          );
    if (
      parsed !== null &&
      (parsed.definitionId !== definitionId ||
        parsed.executionId !== executionId ||
        parsed.cellId !== cellId)
    ) {
      throw new ArtifactIntegrityError(cellId);
    }
    return parsed;
  }

  public putCompleted(report: BenchmarkReportV2): Promise<void> {
    const parsed = BenchmarkReportV2Schema.parse(report);
    return this.ledger.writeExecutionCompleted(
      parsed.suite.definitionId,
      parsed.executionId,
      parsed as unknown as JsonValue,
    );
  }

  public async getCompleted(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
  ): Promise<BenchmarkReportV2 | null> {
    const value = await this.ledger.tryReadExecutionCompleted(
      definitionId,
      executionId,
    );
    const parsed =
      value === null
        ? null
        : this.parseStored(
            BenchmarkReportV2Schema,
            value,
            `benchmark-execution-completed:${executionId}`,
          );
    if (
      parsed !== null &&
      (parsed.suite.definitionId !== definitionId ||
        parsed.executionId !== executionId)
    ) {
      throw new ArtifactIntegrityError(executionId);
    }
    return parsed;
  }
}
