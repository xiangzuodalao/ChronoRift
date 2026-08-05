import type {
  BenchmarkAttemptFinishedV3,
  BenchmarkAttemptId,
  BenchmarkAttemptProgressV3,
  BenchmarkAttemptStartedV3,
  BenchmarkCellId,
  BenchmarkCellResultV3,
  BenchmarkDefinitionId,
  BenchmarkExecutionId,
  BenchmarkExecutionSelectionV3,
  BenchmarkExecutionStartedV3,
  BenchmarkReportV3,
  BenchmarkSuiteSpecV3,
} from "@chronorift/domain";

/** Append-only persistence boundary for schema-version 3 formal campaigns. */
export interface V03BenchmarkArtifactRepositoryV3Port {
  putDefinitionV3(spec: BenchmarkSuiteSpecV3): Promise<void>;
  getDefinitionV3(id: BenchmarkDefinitionId): Promise<BenchmarkSuiteSpecV3>;
  putExecutionSelectionV3(record: BenchmarkExecutionSelectionV3): Promise<void>;
  getExecutionSelectionV3(
    definitionId: BenchmarkDefinitionId,
  ): Promise<BenchmarkExecutionSelectionV3 | null>;
  putExecutionStartedV3(record: BenchmarkExecutionStartedV3): Promise<void>;
  getExecutionStartedV3(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
  ): Promise<BenchmarkExecutionStartedV3 | null>;
  putAttemptStartedV3(record: BenchmarkAttemptStartedV3): Promise<void>;
  getAttemptStartedV3(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
    ordinal: number,
    attemptId: BenchmarkAttemptId,
  ): Promise<BenchmarkAttemptStartedV3 | null>;
  putAttemptProgressV3(record: BenchmarkAttemptProgressV3): Promise<void>;
  getAttemptProgressV3(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
    ordinal: number,
    attemptId: BenchmarkAttemptId,
  ): Promise<readonly BenchmarkAttemptProgressV3[]>;
  putAttemptFinishedV3(record: BenchmarkAttemptFinishedV3): Promise<void>;
  getAttemptFinishedV3(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
    ordinal: number,
    attemptId: BenchmarkAttemptId,
  ): Promise<BenchmarkAttemptFinishedV3 | null>;
  putCellV3(record: BenchmarkCellResultV3): Promise<void>;
  getCellV3(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
  ): Promise<BenchmarkCellResultV3 | null>;
  putCompletedV3(report: BenchmarkReportV3): Promise<void>;
  getCompletedV3(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
  ): Promise<BenchmarkReportV3 | null>;
}
