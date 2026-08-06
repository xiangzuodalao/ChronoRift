import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  DiagnosisProposalV4Schema,
  DiagnosisVerdictV3Schema,
  EvidenceAccessReceiptV2Schema,
  ExecutionFingerprintV2Schema,
  ExperimentReservationV1Schema,
  FrozenContractBundleV3Schema,
  asEvidenceAccessReceiptId,
  asExperimentReservationId,
  claimPolicyManifestV1Content,
  executionFingerprintV2Content,
  frozenContractBundleV3Content,
  type ContractId,
  type DiagnosisProposalV4,
  type DiagnosisVerdictV3,
  type EvidenceAccessReceiptId,
  type EvidenceAccessReceiptV2,
  type ExecutionFingerprintV2,
  type ExecutionId,
  type ExperimentReservationId,
  type ExperimentReservationV1,
  type FrozenContractBundleV3,
  type InvestigationId,
  type JsonValue,
  type ProposalId,
  type RunId,
  type VerdictId,
} from "@chronorift/domain";
import type { V04ArtifactRepositoryPort } from "@chronorift/gamebranch";

import { contentHash } from "./canonical-json.js";
import {
  ArtifactIntegrityError,
  ArtifactPathSecurityError,
} from "./v01-json-artifact-repository.js";
import { V03JsonArtifactRepository } from "./v03-json-artifact-repository.js";

const CONTRACT_BUNDLES = "contract-bundles-v3";
const EXECUTION_FINGERPRINTS = "execution-fingerprints-v2";
const EXPERIMENT_RESERVATIONS = "experiment-reservations-v1";
const EVIDENCE_ACCESS_RECEIPTS = "evidence-access-receipts-v2";
const PROPOSALS = "proposals-v4";
const VERDICTS = "verdicts-v3";

const isContained = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
};

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const expectedReceiptId = (
  receipt: EvidenceAccessReceiptV2,
): EvidenceAccessReceiptId => {
  const { receiptId, issuedAt, ...content } = receipt;
  void receiptId;
  void issuedAt;
  return asEvidenceAccessReceiptId(
    `receipt:v2:${contentHash(content as unknown as JsonValue)}`,
  );
};

const expectedReservationId = (
  reservation: Extract<
    ExperimentReservationV1,
    { readonly reservationKind: "intervention" }
  >,
): ExperimentReservationId =>
  asExperimentReservationId(
    `reservation:v1:${contentHash({
      investigationId: reservation.investigationId,
      interventionId: reservation.interventionId,
    })}`,
  );

const fingerprintSemanticContent = (
  fingerprint: ExecutionFingerprintV2,
): JsonValue => {
  const content = executionFingerprintV2Content(fingerprint);
  const { executionId, ...semantic } = content;
  void executionId;
  return semantic as unknown as JsonValue;
};

const fingerprintComparisonBasis = (
  fingerprint: ExecutionFingerprintV2,
): JsonValue =>
  ({
    runId: fingerprint.runId,
    investigationId: fingerprint.investigationId,
    source: fingerprint.source,
    build: fingerprint.build,
    runtime: {
      engine: fingerprint.runtime.engine,
      engineVersion: fingerprint.runtime.engineVersion,
      platform: fingerprint.runtime.platform,
      renderer: fingerprint.runtime.renderer,
      physicsEngine: fingerprint.runtime.physicsEngine,
      adapterVersion: fingerprint.runtime.adapterVersion,
      protocolVersion: fingerprint.runtime.protocolVersion,
      pluginVersion: fingerprint.runtime.pluginVersion,
      registeredRngDomains: fingerprint.runtime.registeredRngDomains,
    },
    contract: fingerprint.contract,
    claimPolicyManifest: fingerprint.claimPolicyManifest,
    checkpoint: fingerprint.checkpoint,
    probe: fingerprint.probe,
    telemetry: fingerprint.telemetry,
  }) as unknown as JsonValue;

/**
 * Run-scoped, write-once v0.4 artifact repository.
 *
 * Stable v0.3 runtime facts are inherited unchanged, but this repository
 * deliberately selects the v0.4 namespace so old artifact bytes and paths are
 * never migrated or replaced.
 */
export class V04JsonArtifactRepository
  extends V03JsonArtifactRepository
  implements V04ArtifactRepositoryPort
{
  public constructor(artifactRoot: string, runId: RunId) {
    super(artifactRoot, runId, "v0.4");
  }

  private assertRunScope(actualRunId: RunId, kind: string, id: string): void {
    if (actualRunId !== this.runId) {
      throw new ArtifactIntegrityError(
        `${kind}:${id}: artifact belongs to run ${actualRunId}, not ${this.runId}`,
      );
    }
  }

  private assertContractIntegrity(contract: FrozenContractBundleV3): void {
    const expected = `contract:v3:${contentHash(
      frozenContractBundleV3Content(contract) as unknown as JsonValue,
    )}`;
    if (contract.contractId !== expected) {
      throw new ArtifactIntegrityError(
        `${CONTRACT_BUNDLES}:${contract.contractId}`,
      );
    }
  }

  private assertFingerprintIntegrity(
    fingerprint: ExecutionFingerprintV2,
  ): void {
    this.assertRunScope(
      fingerprint.runId,
      EXECUTION_FINGERPRINTS,
      fingerprint.executionId,
    );
    const expectedFingerprintHash = contentHash(
      fingerprintSemanticContent(fingerprint),
    );
    const expectedComparisonBasisHash = contentHash(
      fingerprintComparisonBasis(fingerprint),
    );
    const expectedClaimPolicyManifestHash = contentHash(
      claimPolicyManifestV1Content(
        fingerprint.claimPolicyManifest,
      ) as unknown as JsonValue,
    );
    if (
      fingerprint.fingerprintHash !== expectedFingerprintHash ||
      fingerprint.comparisonBasisHash !== expectedComparisonBasisHash ||
      fingerprint.claimPolicyManifest.manifestHash !==
        expectedClaimPolicyManifestHash
    ) {
      throw new ArtifactIntegrityError(
        `${EXECUTION_FINGERPRINTS}:${fingerprint.executionId}`,
      );
    }
  }

  private assertReservationIntegrity(
    reservation: ExperimentReservationV1,
  ): void {
    this.assertRunScope(
      reservation.runId,
      EXPERIMENT_RESERVATIONS,
      reservation.reservationId,
    );
    if (
      reservation.reservationKind === "intervention" &&
      reservation.reservationId !== expectedReservationId(reservation)
    ) {
      throw new ArtifactIntegrityError(
        `${EXPERIMENT_RESERVATIONS}:${reservation.reservationId}`,
      );
    }
  }

  private assertReceiptIntegrity(receipt: EvidenceAccessReceiptV2): void {
    this.assertRunScope(
      receipt.runId,
      EVIDENCE_ACCESS_RECEIPTS,
      receipt.receiptId,
    );
    if (receipt.receiptId !== expectedReceiptId(receipt)) {
      throw new ArtifactIntegrityError(
        `${EVIDENCE_ACCESS_RECEIPTS}:${receipt.receiptId}`,
      );
    }
  }

  private assertProposalIntegrity(proposal: DiagnosisProposalV4): void {
    this.assertRunScope(proposal.runId, PROPOSALS, proposal.proposalId);
  }

  private assertVerdictIntegrity(verdict: DiagnosisVerdictV3): void {
    this.assertRunScope(verdict.runId, VERDICTS, verdict.verdictId);
  }

  public async putContractBundle(
    contract: FrozenContractBundleV3,
  ): Promise<void> {
    const parsed = FrozenContractBundleV3Schema.parse(contract);
    this.assertContractIntegrity(parsed);
    await this.put(
      CONTRACT_BUNDLES,
      parsed.contractId,
      FrozenContractBundleV3Schema,
      parsed,
    );
  }

  public getContractBundle(
    contractId: ContractId,
  ): Promise<FrozenContractBundleV3> {
    return this.get(
      CONTRACT_BUNDLES,
      contractId,
      FrozenContractBundleV3Schema,
      (value) => value.contractId,
      (value) => this.assertContractIntegrity(value),
    );
  }

  public async putExecutionFingerprint(
    fingerprint: ExecutionFingerprintV2,
  ): Promise<void> {
    const parsed = ExecutionFingerprintV2Schema.parse(fingerprint);
    this.assertFingerprintIntegrity(parsed);
    await this.put(
      EXECUTION_FINGERPRINTS,
      parsed.executionId,
      ExecutionFingerprintV2Schema,
      parsed,
    );
  }

  public getExecutionFingerprint(
    executionId: ExecutionId,
  ): Promise<ExecutionFingerprintV2> {
    return this.get(
      EXECUTION_FINGERPRINTS,
      executionId,
      ExecutionFingerprintV2Schema,
      (value) => value.executionId,
      (value) => this.assertFingerprintIntegrity(value),
    );
  }

  public async putExperimentReservation(
    reservation: ExperimentReservationV1,
  ): Promise<void> {
    const parsed = ExperimentReservationV1Schema.parse(reservation);
    this.assertReservationIntegrity(parsed);
    await this.put(
      EXPERIMENT_RESERVATIONS,
      parsed.reservationId,
      ExperimentReservationV1Schema,
      parsed,
    );
  }

  public getExperimentReservation(
    reservationId: ExperimentReservationId,
  ): Promise<ExperimentReservationV1> {
    return this.get(
      EXPERIMENT_RESERVATIONS,
      reservationId,
      ExperimentReservationV1Schema,
      (value) => value.reservationId,
      (value) => this.assertReservationIntegrity(value),
    );
  }

  public async listExperimentReservations(
    investigationId: InvestigationId,
  ): Promise<readonly ExperimentReservationV1[]> {
    const directory = resolve(this.runDirectory, EXPERIMENT_RESERVATIONS);
    if (!isContained(this.runDirectory, directory)) {
      throw new ArtifactPathSecurityError(directory);
    }

    for (const ancestor of [
      this.artifactDirectory,
      this.storageDirectory,
      resolve(this.storageDirectory, "runs"),
      this.runDirectory,
    ]) {
      let metadata;
      try {
        metadata = await lstat(ancestor);
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new ArtifactPathSecurityError(ancestor);
      }
    }

    let directoryMetadata;
    try {
      directoryMetadata = await lstat(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    if (
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory()
    ) {
      throw new ArtifactPathSecurityError(directory);
    }
    const canonicalRun = await realpath(this.runDirectory);
    const canonicalDirectory = await realpath(directory);
    if (!isContained(canonicalRun, canonicalDirectory)) {
      throw new ArtifactPathSecurityError(directory);
    }

    const entries = await readdir(directory, { withFileTypes: true });
    const reservations: ExperimentReservationV1[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new ArtifactPathSecurityError(resolve(directory, entry.name));
      }
      if (!entry.name.endsWith(".json")) {
        throw new ArtifactIntegrityError(
          `${EXPERIMENT_RESERVATIONS}:non-canonical-file:${entry.name}`,
        );
      }
      const encodedId = entry.name.slice(0, -".json".length);
      let decodedId: string;
      try {
        decodedId = decodeURIComponent(encodedId);
      } catch {
        throw new ArtifactIntegrityError(
          `${EXPERIMENT_RESERVATIONS}:non-canonical-file:${entry.name}`,
        );
      }
      if (encodeURIComponent(decodedId) !== encodedId) {
        throw new ArtifactIntegrityError(
          `${EXPERIMENT_RESERVATIONS}:non-canonical-file:${entry.name}`,
        );
      }
      const reservationId = asExperimentReservationId(decodedId);
      const reservation = await this.getExperimentReservation(reservationId);
      if (reservation.investigationId === investigationId) {
        reservations.push(reservation);
      }
    }

    return reservations.sort(
      (left, right) =>
        left.budget.ordinal - right.budget.ordinal ||
        left.reservedAt.localeCompare(right.reservedAt) ||
        left.reservationId.localeCompare(right.reservationId),
    );
  }

  public async putEvidenceAccessReceipt(
    receipt: EvidenceAccessReceiptV2,
  ): Promise<void> {
    const parsed = EvidenceAccessReceiptV2Schema.parse(receipt);
    this.assertReceiptIntegrity(parsed);
    await this.put(
      EVIDENCE_ACCESS_RECEIPTS,
      parsed.receiptId,
      EvidenceAccessReceiptV2Schema,
      parsed,
    );
  }

  public getEvidenceAccessReceipt(
    receiptId: EvidenceAccessReceiptId,
  ): Promise<EvidenceAccessReceiptV2> {
    return this.get(
      EVIDENCE_ACCESS_RECEIPTS,
      receiptId,
      EvidenceAccessReceiptV2Schema,
      (value) => value.receiptId,
      (value) => this.assertReceiptIntegrity(value),
    );
  }

  public async putProposalV4(proposal: DiagnosisProposalV4): Promise<void> {
    const parsed = DiagnosisProposalV4Schema.parse(proposal);
    this.assertProposalIntegrity(parsed);
    await this.put(
      PROPOSALS,
      parsed.proposalId,
      DiagnosisProposalV4Schema,
      parsed,
    );
  }

  public getProposalV4(proposalId: ProposalId): Promise<DiagnosisProposalV4> {
    return this.get(
      PROPOSALS,
      proposalId,
      DiagnosisProposalV4Schema,
      (value) => value.proposalId,
      (value) => this.assertProposalIntegrity(value),
    );
  }

  public async putVerdictV3(verdict: DiagnosisVerdictV3): Promise<void> {
    const parsed = DiagnosisVerdictV3Schema.parse(verdict);
    this.assertVerdictIntegrity(parsed);
    await this.put(
      VERDICTS,
      parsed.verdictId,
      DiagnosisVerdictV3Schema,
      parsed,
    );
  }

  public getVerdictV3(verdictId: VerdictId): Promise<DiagnosisVerdictV3> {
    return this.get(
      VERDICTS,
      verdictId,
      DiagnosisVerdictV3Schema,
      (value) => value.verdictId,
      (value) => this.assertVerdictIntegrity(value),
    );
  }
}
