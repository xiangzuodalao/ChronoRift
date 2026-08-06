import { createHash } from "node:crypto";

import {
  ClaimPolicyManifestV1Schema,
  asClaimPolicyId,
  asContractId,
  asEvidenceAccessReceiptId,
  asExperimentReservationId,
  claimPolicyManifestV1Content,
  frozenContractBundleV3Content,
  type ClaimPolicyManifestV1,
  type ContractId,
  type EvidenceAccessReceiptId,
  type EvidenceAccessReceiptV2,
  type ExecutionFingerprintV2,
  type ExperimentReservationId,
  type FrozenContractBundleV3,
  type InterventionId,
  type InvestigationId,
  type JsonValue,
} from "@chronorift/domain";

import { canonicalStringify } from "./canonical.js";

export const v04ContentHash = (value: JsonValue): string =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex");

export interface V04ClaimPolicyDescriptorInput {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly mechanismId: string;
  readonly assertionSchemaId: string;
}

export const v04ClaimPolicyManifestFor = (
  descriptors: readonly V04ClaimPolicyDescriptorInput[],
): ClaimPolicyManifestV1 => {
  const content = {
    schemaVersion: 1 as const,
    policies: descriptors
      .map((descriptor) => ({
        policyId: asClaimPolicyId(descriptor.policyId),
        policyVersion: descriptor.policyVersion,
        mechanismId: descriptor.mechanismId,
        assertionSchemaId: descriptor.assertionSchemaId,
      }))
      .sort((left, right) => left.policyId.localeCompare(right.policyId)),
  };
  return ClaimPolicyManifestV1Schema.parse({
    ...content,
    manifestHash: v04ContentHash(content),
  });
};

export const v04ClaimPolicyManifestHash = (
  manifest: ClaimPolicyManifestV1,
): string =>
  v04ContentHash(
    claimPolicyManifestV1Content(manifest) as unknown as JsonValue,
  );

export const v04ContractIdFor = (
  content: Omit<FrozenContractBundleV3, "contractId">,
): ContractId =>
  asContractId(
    `contract:v3:${v04ContentHash(content as unknown as JsonValue)}`,
  );

export const v04ContractBundleHash = (bundle: FrozenContractBundleV3): string =>
  v04ContentHash(frozenContractBundleV3Content(bundle) as unknown as JsonValue);

export const v04EvidenceAccessReceiptIdFor = (
  receipt: Omit<EvidenceAccessReceiptV2, "receiptId" | "issuedAt">,
): EvidenceAccessReceiptId =>
  asEvidenceAccessReceiptId(
    `receipt:v2:${v04ContentHash(receipt as unknown as JsonValue)}`,
  );

export const v04ExperimentReservationIdFor = (
  investigationId: InvestigationId,
  interventionId: InterventionId,
): ExperimentReservationId =>
  asExperimentReservationId(
    `reservation:v1:${v04ContentHash({
      investigationId,
      interventionId,
    })}`,
  );

export const v04FingerprintSemanticContent = (
  fingerprint: Omit<
    ExecutionFingerprintV2,
    "fingerprintHash" | "comparisonBasisHash"
  >,
): JsonValue => {
  const { executionId, ...semantic } = fingerprint;
  void executionId;
  return semantic as unknown as JsonValue;
};

export const v04ComparisonBasisContent = (
  fingerprint: Omit<
    ExecutionFingerprintV2,
    "fingerprintHash" | "comparisonBasisHash"
  >,
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
