import type {
  DiagnosisProposalV4,
  DiagnosisVerdictV3,
  ContractId,
  EvidenceAccessReceiptId,
  EvidenceAccessReceiptV2,
  ExecutionFingerprintV2,
  ExecutionId,
  ExperimentReservationId,
  ExperimentReservationV1,
  FrozenContractBundleV3,
  InvestigationId,
  ProposalId,
  VerdictId,
} from "@chronorift/domain";

import type { V03ArtifactRepositoryPort } from "./v03-artifact-repository.js";

/** v0.4 facts extend, rather than mutate, the stable v2 execution ledger. */
export interface V04ArtifactRepositoryPort extends V03ArtifactRepositoryPort {
  putContractBundle(contract: FrozenContractBundleV3): Promise<void>;
  getContractBundle(contractId: ContractId): Promise<FrozenContractBundleV3>;
  putExecutionFingerprint(fingerprint: ExecutionFingerprintV2): Promise<void>;
  getExecutionFingerprint(
    executionId: ExecutionId,
  ): Promise<ExecutionFingerprintV2>;
  putExperimentReservation(reservation: ExperimentReservationV1): Promise<void>;
  getExperimentReservation(
    reservationId: ExperimentReservationId,
  ): Promise<ExperimentReservationV1>;
  listExperimentReservations(
    investigationId: InvestigationId,
  ): Promise<readonly ExperimentReservationV1[]>;
  putEvidenceAccessReceipt(receipt: EvidenceAccessReceiptV2): Promise<void>;
  getEvidenceAccessReceipt(
    receiptId: EvidenceAccessReceiptId,
  ): Promise<EvidenceAccessReceiptV2>;
  putProposalV4(proposal: DiagnosisProposalV4): Promise<void>;
  getProposalV4(proposalId: ProposalId): Promise<DiagnosisProposalV4>;
  putVerdictV3(verdict: DiagnosisVerdictV3): Promise<void>;
  getVerdictV3(verdictId: VerdictId): Promise<DiagnosisVerdictV3>;
}
