import type {
  BenchmarkAttemptId,
  BenchmarkAttemptStartedV2,
  BenchmarkAttemptFinishedV2,
  BenchmarkAttemptProgressV2,
  BenchmarkCellId,
  BenchmarkCellResultV2,
  BenchmarkDefinitionId,
  BenchmarkExecutionId,
  BenchmarkExecutionStartedV2,
  BenchmarkExecutionSelectionV2,
  BenchmarkReportV2,
  BenchmarkSuiteSpecV2,
} from "@chronorift/domain";

/** Append-only formal benchmark persistence boundary. */
export interface V03BenchmarkArtifactRepositoryPort {
  putDefinition(spec: BenchmarkSuiteSpecV2): Promise<void>;
  getDefinition(id: BenchmarkDefinitionId): Promise<BenchmarkSuiteSpecV2>;
  putExecutionSelection(record: BenchmarkExecutionSelectionV2): Promise<void>;
  getExecutionSelection(
    definitionId: BenchmarkDefinitionId,
  ): Promise<BenchmarkExecutionSelectionV2 | null>;
  putExecutionStarted(record: BenchmarkExecutionStartedV2): Promise<void>;
  getExecutionStarted(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
  ): Promise<BenchmarkExecutionStartedV2 | null>;
  putAttemptStarted(record: BenchmarkAttemptStartedV2): Promise<void>;
  getAttemptStarted(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
    ordinal: number,
    attemptId: BenchmarkAttemptId,
  ): Promise<BenchmarkAttemptStartedV2 | null>;
  putAttemptFinished(record: BenchmarkAttemptFinishedV2): Promise<void>;
  putAttemptProgress(record: BenchmarkAttemptProgressV2): Promise<void>;
  getLatestAttemptProgress(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
    ordinal: number,
    attemptId: BenchmarkAttemptId,
  ): Promise<BenchmarkAttemptProgressV2 | null>;
  getAttemptFinished(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
    ordinal: number,
    attemptId: BenchmarkAttemptId,
  ): Promise<BenchmarkAttemptFinishedV2 | null>;
  putCell(record: BenchmarkCellResultV2): Promise<void>;
  getCell(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
  ): Promise<BenchmarkCellResultV2 | null>;
  putCompleted(report: BenchmarkReportV2): Promise<void>;
  getCompleted(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
  ): Promise<BenchmarkReportV2 | null>;
}
