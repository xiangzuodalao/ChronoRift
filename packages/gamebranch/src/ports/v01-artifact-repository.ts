import type {
  BranchId,
  BranchSpec,
  CapsuleId,
  Checkpoint,
  CheckpointContent,
  CheckpointId,
  ComparisonId,
  ContractId,
  DiagnosisProposal,
  DiagnosisVerdict,
  EvidenceCapsule,
  ExecutionComparison,
  ExecutionId,
  ExecutionLog,
  FrozenContract,
  InputTrace,
  InputTraceId,
  ProposalId,
  VerdictId,
} from "@chronorift/domain";

/**
 * Narrow persistence boundary for the v0.1 vertical slice.
 *
 * Implementations validate schemas and use write-once semantics. Repeating an
 * identical write may be idempotent; overwriting an ID with different content
 * must fail.
 */
export interface V01ArtifactRepositoryPort {
  putCheckpoint(content: CheckpointContent): Promise<Checkpoint>;
  getCheckpoint(checkpointId: CheckpointId): Promise<Checkpoint>;

  putInputTrace(trace: InputTrace): Promise<void>;
  getInputTrace(inputTraceId: InputTraceId): Promise<InputTrace>;

  putFrozenContract(contract: FrozenContract): Promise<void>;
  getFrozenContract(contractId: ContractId): Promise<FrozenContract>;

  putBranchSpec(branch: BranchSpec): Promise<void>;
  getBranchSpec(branchId: BranchId): Promise<BranchSpec>;

  putExecutionLog(execution: ExecutionLog): Promise<void>;
  getExecutionLog(executionId: ExecutionId): Promise<ExecutionLog>;

  putEvidenceCapsule(capsule: EvidenceCapsule): Promise<void>;
  getEvidenceCapsule(capsuleId: CapsuleId): Promise<EvidenceCapsule>;

  putExecutionComparison(comparison: ExecutionComparison): Promise<void>;
  getExecutionComparison(
    comparisonId: ComparisonId,
  ): Promise<ExecutionComparison>;

  putDiagnosisProposal(proposal: DiagnosisProposal): Promise<void>;
  getDiagnosisProposal(proposalId: ProposalId): Promise<DiagnosisProposal>;

  putDiagnosisVerdict(verdict: DiagnosisVerdict): Promise<void>;
  getDiagnosisVerdict(verdictId: VerdictId): Promise<DiagnosisVerdict>;
}
