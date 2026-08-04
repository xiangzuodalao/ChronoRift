import type {
  CapsuleId,
  Checkpoint,
  CheckpointContent,
  CheckpointId,
  ComparisonId,
  ContractId,
  DiagnosisProposalV2,
  DiagnosisProposalV3,
  DiagnosisVerdictV2,
  EvidenceCapsuleV2,
  ExecutionId,
  FrozenContractV2,
  InputTraceId,
  InputTraceV2,
  ProposalId,
  V03BranchSpec,
  V03ExecutionComparison,
  V03ExecutionLog,
  VerdictId,
  BranchId,
} from "@chronorift/domain";

export interface V03ArtifactRepositoryPort {
  putCheckpoint(content: CheckpointContent): Promise<Checkpoint>;
  getCheckpoint(checkpointId: CheckpointId): Promise<Checkpoint>;
  putContract(contract: FrozenContractV2): Promise<void>;
  getContract(contractId: ContractId): Promise<FrozenContractV2>;
  putInputTrace(trace: InputTraceV2): Promise<void>;
  getInputTrace(inputTraceId: InputTraceId): Promise<InputTraceV2>;
  putBranch(branch: V03BranchSpec): Promise<void>;
  getBranch(branchId: BranchId): Promise<V03BranchSpec>;
  putExecution(execution: V03ExecutionLog): Promise<void>;
  getExecution(executionId: ExecutionId): Promise<V03ExecutionLog>;
  putCapsule(capsule: EvidenceCapsuleV2): Promise<void>;
  getCapsule(capsuleId: CapsuleId): Promise<EvidenceCapsuleV2>;
  putComparison(comparison: V03ExecutionComparison): Promise<void>;
  getComparison(comparisonId: ComparisonId): Promise<V03ExecutionComparison>;
  putProposal(proposal: DiagnosisProposalV2): Promise<void>;
  getProposal(proposalId: ProposalId): Promise<DiagnosisProposalV2>;
  putProposalV3(proposal: DiagnosisProposalV3): Promise<void>;
  getProposalV3(proposalId: ProposalId): Promise<DiagnosisProposalV3>;
  putVerdict(verdict: DiagnosisVerdictV2): Promise<void>;
  getVerdict(verdictId: VerdictId): Promise<DiagnosisVerdictV2>;
}
