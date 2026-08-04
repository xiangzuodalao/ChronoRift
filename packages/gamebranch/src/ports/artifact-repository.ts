import type {
  BranchId,
  BranchRecord,
  BranchRun,
  Checkpoint,
  CheckpointContent,
  CheckpointId,
  DiagnosisReport,
  EvaluationId,
  EvidenceBundle,
  EvidenceId,
  InputTrace,
  InputTraceId,
  InvariantEvaluation,
  ReportId,
  RunId,
  RunManifest,
  TelemetryEvent,
} from "@chronorift/domain";

/** Persistence boundary. Implementations validate and atomically replace JSON DTOs. */
export interface ArtifactRepositoryPort {
  putCheckpoint(content: CheckpointContent): Promise<Checkpoint>;
  getCheckpoint(checkpointId: CheckpointId): Promise<Checkpoint>;

  putInputTrace(trace: InputTrace): Promise<void>;
  getInputTrace(inputTraceId: InputTraceId): Promise<InputTrace>;

  putBranch(branch: BranchRecord): Promise<void>;
  getBranch(branchId: BranchId): Promise<BranchRecord>;
  appendTelemetry(
    branchId: BranchId,
    events: readonly TelemetryEvent[],
  ): Promise<void>;
  putBranchRun(run: BranchRun): Promise<void>;
  getBranchRun(branchId: BranchId): Promise<BranchRun>;

  putEvaluation(evaluation: InvariantEvaluation): Promise<void>;
  getEvaluation(evaluationId: EvaluationId): Promise<InvariantEvaluation>;
  putEvidence(evidence: EvidenceBundle): Promise<void>;
  getEvidence(evidenceId: EvidenceId): Promise<EvidenceBundle>;

  putManifest(
    manifest: RunManifest,
    expectedRevision: number | null,
  ): Promise<void>;
  getManifest(runId: RunId): Promise<RunManifest>;

  putDiagnosis(report: DiagnosisReport): Promise<void>;
  getDiagnosis(reportId: ReportId): Promise<DiagnosisReport>;
}
