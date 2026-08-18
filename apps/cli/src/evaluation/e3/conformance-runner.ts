import { execFile } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { constants, readSync } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { Socket } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";

import { z } from "zod";

import { Sha256DigestV1Schema, type JsonValue } from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";

import {
  artifactSinkCommitmentV1,
  assignmentIdV1,
  campaignIdV1,
  campaignRegistrationLeafBytesV1,
  canonicalContentHashV1,
  closurePublicationLeafBytesV1,
  ed25519KeyIdV1,
  eventIdV1,
  sha256HexV1,
  signCanonicalJsonV1,
  verifyCanonicalJsonSignatureV1,
  verifyConsistencyProofV1,
  verifyInclusionProofV1,
} from "./canonical.js";
import {
  E3AppendReceiptV1Schema,
  E3CampaignConformanceEvidenceV1Schema,
  E3CampaignManifestV1Schema,
  E3JournalEntryV1Schema,
  E3JournalV1Schema,
  E3PrimaryClosureV1Schema,
  E3PublicationProofV1Schema,
  E3RevisionEnvelopeV1Schema,
  E3RevisionJournalCheckpointV1Schema,
  E3RolePublicKeyV1Schema,
  E3SanitizedSummaryV1Schema,
  E3_ARTIFACT_SINK_MODE_V1,
  E3_EVENT_ACTOR_ACL_V1,
  E3_EVENT_PAYLOAD_SCHEMA_IDS_V1,
  E3_SCHEMA_IDS_V1,
  type E3AppendReceiptV1,
  type E3CampaignManifestV1,
  type E3JournalEntryV1,
  type E3JournalV1,
  type E3PrimaryClosureV1,
  type E3PublicationProofV1,
  type E3RegistrarServiceBindingV1,
  type E3RegistrarTrustRootV1,
  type E3RevisionEnvelopeV1,
  type E3RevisionJournalCheckpointV1,
  type E3SanitizedSummaryV1,
} from "./contracts.js";
import {
  E3RegistrarClientV1,
  canonicalRegistrarTransportRequestBytesV1,
  createPinnedHttpsTransportV1,
  parseStrictRegistrarJsonV1,
  serviceFromTrustRootV1,
  verifyTrustRootV1,
  type E3StrictJsonTransportV1,
} from "./registrar-client.js";
import {
  E3RegistrarError,
  type E3RegistrarErrorCodeV1,
  type E3RegistrarPortV1,
} from "./registrar-port.js";
import {
  eventHashV1,
  projectRevisionJournalV1,
  revisionHashV1,
  validatePrimaryClosureV1,
} from "./projector.js";

export const E3_CONFORMANCE_NODE_VERSION_V1 = "22.23.1" as const;
export const E3_CONFORMANCE_TRUST_ROOT_RELATIVE_PATH_V1 =
  "testdata/vnext/e3/registrar-trust-root.v1.json" as const;
export const E3_CONFORMANCE_TRUST_ROOT_FREEZE_RELATIVE_PATH_V1 =
  "testdata/vnext/e3/registrar-trust-root.v1.freeze.json" as const;
export const E3_CONFORMANCE_FAULT_CONTROL_POLICY_RELATIVE_PATH_V1 =
  "testdata/vnext/e3/registrar-fault-control-policy.v1.json" as const;
/**
 * Filled only by the release that publishes the independently pinned V1 root.
 * Keeping this out of CI/environment configuration prevents an operator from
 * replacing the root, freeze record, and pin together.  The implementation-only
 * repository deliberately leaves it unselected and therefore cannot pass live.
 */
export const E3_CONFORMANCE_EXTERNAL_TRUST_ROOT_SHA256_V1: string | null = null;
export const E3_CONFORMANCE_LIVE_MATRIX_STATUS_V1 = "full_matrix_v1" as const;
export const E3_CONFORMANCE_RUNNER_RELATIVE_PATH_V1 =
  "apps/cli/src/evaluation/e3/conformance-runner.ts" as const;
export const E3_CONFORMANCE_VALIDATOR_RELATIVE_PATH_V1 =
  ".github/scripts/validate-vnext-e3-campaign.mjs" as const;
export const E3_CONFORMANCE_RUNNER_BUNDLE_PATHS_V1 = Object.freeze([
  E3_CONFORMANCE_RUNNER_RELATIVE_PATH_V1,
  "apps/cli/src/evaluation/e3/e3-campaign-live-cli.ts",
  "apps/cli/src/evaluation/e3/e3-campaign-fault-leaf-cli.ts",
  "apps/cli/src/evaluation/e3/contracts.ts",
  "apps/cli/src/evaluation/e3/canonical.ts",
  "apps/cli/src/evaluation/e3/projector.ts",
  "apps/cli/src/evaluation/e3/registrar-port.ts",
  "apps/cli/src/evaluation/e3/registrar-client.ts",
  "testdata/vnext/e3/e3-campaign-conformance-contract.v1.json",
  "package.json",
  "pnpm-lock.yaml",
] as const);
export const E3_CONFORMANCE_EVIDENCE_FILE_V1 =
  "e3-campaign-conformance-evidence.v1.json" as const;
export const E3_CONFORMANCE_SUITE_EVIDENCE_SCHEMA_ID_V1 =
  "chronorift.e3.campaign-conformance-suite-evidence" as const;
export const E3_CONFORMANCE_SUITE_SUMMARY_SCHEMA_ID_V1 =
  "chronorift.e3.campaign-conformance-suite-summary" as const;
export const E3_CONFORMANCE_FAULT_RECEIPT_SCHEMA_ID_V1 =
  "chronorift.e3.campaign-conformance-fault-receipt" as const;
export const E3_CONFORMANCE_FAULT_CONTROL_POLICY_SCHEMA_ID_V1 =
  "chronorift.e3.registrar-fault-control-policy" as const;
export const E3_CONFORMANCE_FAULT_CONTROL_REQUEST_SCHEMA_ID_V1 =
  "chronorift.e3.campaign-conformance-fault-control-request" as const;
export const E3_CONFORMANCE_FAULT_CONTROL_RESPONSE_SCHEMA_ID_V1 =
  "chronorift.e3.campaign-conformance-fault-control-response" as const;
export const E3_CONFORMANCE_FAULT_CONTROL_FD_V1 = 15 as const;

const E3_CONFORMANCE_FAULT_RECEIPT_SIGNATURE_DOMAIN_V1 =
  "chronorift-e3-conformance-fault-receipt-signature-v1" as const;
const E3_CONFORMANCE_FAULT_CONTROL_POLICY_SIGNATURE_DOMAIN_V1 =
  "chronorift-e3-registrar-fault-control-policy-v1" as const;
const E3_CONFORMANCE_FAULT_CONTROL_REQUEST_ID_DOMAIN_V1 =
  "chronorift-e3-conformance-fault-control-request-v1" as const;

const descriptorFds = (
  registrationCapability: number,
  actorAppendCapability: number,
  actorPrivateKey: number,
  registrationPreparation: number,
) =>
  Object.freeze({
    registrationCapability,
    actorAppendCapability,
    actorPrivateKey,
    registrationPreparation,
  });

export const E3_CONFORMANCE_LIVE_SUITE_FDS_V1 = Object.freeze({
  earlyComplete: descriptorFds(3, 4, 5, 6),
  deadlineIncomplete: descriptorFds(7, 8, 9, 10),
  deadlineCleanupUnproven: descriptorFds(11, 12, 13, 14),
} as const);
export const E3_CONFORMANCE_LIVE_FDS_V1 =
  E3_CONFORMANCE_LIVE_SUITE_FDS_V1.earlyComplete;

export const E3_CONFORMANCE_LIVE_ENV_V1 = Object.freeze({
  registrarServiceId: "CHRONORIFT_E3_REGISTRAR_SERVICE_ID",
  registrarNamespace: "CHRONORIFT_E3_REGISTRAR_NAMESPACE",
  hostCleanupWitness: "CHRONORIFT_E3_HOST_CLEANUP_WITNESS",
  evidenceDirectory: "CHRONORIFT_E3_EVIDENCE_DIR",
} as const);

const E3_CONFORMANCE_CASE_WITNESS_V1 = Object.freeze({
  early_complete: "external_auto_append_v1",
  deadline_incomplete: "external_deadline_no_finish_v1",
  deadline_cleanup_unproven_with_late_cleanup:
    "external_withhold_cleanup_until_closed_then_revision_v1",
} as const);
const E3_CONFORMANCE_SUITE_HOST_WITNESS_MODE_V1 = "external_suite_v1" as const;
const MAX_REPOSITORY_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_CAPABILITY_BYTES = 16 * 1024;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const MAX_PREPARATION_BYTES = 256 * 1024;
const MAX_DEADLINE_DISTANCE_MS = 600_000;
const PUBLICATION_GRACE_MS = 30_000;
const CLOSED_EVIDENCE_POLL_MS = 250;
const MAX_FAULT_CONTROL_REQUEST_BYTES = 16 * 1024;
const MAX_FAULT_CONTROL_RESPONSE_BYTES = 64 * 1024;
const FAULT_CONTROL_RESPONSE_TIMEOUT_MS = 120_000;

const FORBIDDEN_SECRET_ENVIRONMENT = [
  "CHRONORIFT_E3_REGISTRATION_CAPABILITY",
  "CHRONORIFT_E3_ACTOR_APPEND_CAPABILITY",
  "CHRONORIFT_E3_ACTOR_PRIVATE_KEY",
  "CHRONORIFT_E3_ACTOR_PRIVATE_KEY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
] as const;
const FORBIDDEN_CREDENTIAL_ENVIRONMENT_NAME =
  /(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|SECRET_?KEY|SECRET_?ACCESS_?KEY|CREDENTIALS?|OPENAI|ANTHROPIC|GEMINI|GOOGLE_GENERATIVE_AI|AZURE_OPENAI|OPENROUTER|DEEPSEEK|MISTRAL|COHERE|GROQ|TOGETHER|FIREWORKS|VOLCENGINE)/iu;

const IdentifierV1Schema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const TimestampV1Schema = z.string().datetime({ offset: true });
const SignatureV1Schema = z.string().regex(/^[A-Za-z0-9_-]{86}$/u);
const FaultCaseV1Schema = z.enum([
  "registrar_unreachable",
  "transparency_log_unavailable",
]);

const E3CampaignConformanceFaultControlPolicyV1Schema = z
  .object({
    schemaId: z.literal(E3_CONFORMANCE_FAULT_CONTROL_POLICY_SCHEMA_ID_V1),
    schemaVersion: z.literal(1),
    trustRootVersion: IdentifierV1Schema,
    serviceId: IdentifierV1Schema,
    namespace: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u),
    faultControlId: IdentifierV1Schema,
    faultPlanId: Sha256DigestV1Schema,
    faultKey: E3RolePublicKeyV1Schema,
    runnerSha256: Sha256DigestV1Schema,
    validatorSha256: Sha256DigestV1Schema,
    allowedFaultCases: z.tuple([
      z.literal("registrar_unreachable"),
      z.literal("transparency_log_unavailable"),
    ]),
    signatures: z
      .array(
        z
          .object({
            keyId: Sha256DigestV1Schema,
            signature: SignatureV1Schema,
          })
          .strict(),
      )
      .min(2)
      .max(16),
  })
  .strict()
  .superRefine((policy, context) => {
    if (
      new Set(policy.signatures.map(({ keyId }) => keyId)).size !==
      policy.signatures.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["signatures"],
        message: "fault-control policy signature keys must be unique",
      });
    }
  });

export const campaignConformanceFaultReceiptIdV1 = (basis: JsonValue): string =>
  sha256HexV1(
    Buffer.from(
      `chronorift-e3-conformance-fault-receipt-v1\0${canonicalJson(basis)}`,
      "utf8",
    ),
  );

export const campaignConformanceFaultControlRequestIdV1 = (
  basis: JsonValue,
): string =>
  sha256HexV1(
    Buffer.from(
      `${E3_CONFORMANCE_FAULT_CONTROL_REQUEST_ID_DOMAIN_V1}\0${canonicalJson(basis)}`,
      "utf8",
    ),
  );

const E3CampaignConformanceFaultReceiptV1Schema = z
  .object({
    schemaId: z.literal(E3_CONFORMANCE_FAULT_RECEIPT_SCHEMA_ID_V1),
    schemaVersion: z.literal(1),
    receiptId: Sha256DigestV1Schema,
    requestId: Sha256DigestV1Schema,
    faultCase: FaultCaseV1Schema,
    faultControlId: IdentifierV1Schema,
    faultPlanId: Sha256DigestV1Schema,
    faultKeyId: Sha256DigestV1Schema,
    registrarServiceId: IdentifierV1Schema,
    namespace: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u),
    startedAt: TimestampV1Schema,
    completedAt: TimestampV1Schema,
    observedRunnerExitCode: z.number().int().min(1).max(255),
    observedErrorCode: z.literal("live_dependency_unavailable"),
    finalEvidencePresent: z.literal(false),
    successSummaryPresent: z.literal(false),
    signature: SignatureV1Schema,
  })
  .strict()
  .superRefine((receipt, context) => {
    const basis = { ...receipt };
    Reflect.deleteProperty(basis, "receiptId");
    Reflect.deleteProperty(basis, "signature");
    const expectedReceiptId = campaignConformanceFaultReceiptIdV1(basis);
    if (receipt.receiptId !== expectedReceiptId) {
      context.addIssue({
        code: "custom",
        path: ["receiptId"],
        message: "fault receipt identity does not bind its canonical bytes",
      });
    }
    if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "fault receipt completion precedes its start",
      });
    }
  });

const E3CampaignConformanceFaultControlRequestV1Schema = z
  .object({
    schemaId: z.literal(E3_CONFORMANCE_FAULT_CONTROL_REQUEST_SCHEMA_ID_V1),
    schemaVersion: z.literal(1),
    requestId: Sha256DigestV1Schema,
    faultCase: FaultCaseV1Schema,
    registrarServiceId: IdentifierV1Schema,
    namespace: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u),
    evidenceDirectory: z
      .string()
      .min(1)
      .max(4_096)
      .refine(isAbsolute, "evidence directory must be absolute"),
    evidenceFileName: z.literal(E3_CONFORMANCE_EVIDENCE_FILE_V1),
    faultControlId: IdentifierV1Schema,
    faultPlanId: Sha256DigestV1Schema,
    faultKeyId: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((request, context) => {
    const basis = { ...request };
    Reflect.deleteProperty(basis, "requestId");
    if (
      request.requestId !==
      campaignConformanceFaultControlRequestIdV1(asJson(basis))
    ) {
      context.addIssue({
        code: "custom",
        path: ["requestId"],
        message:
          "fault-control request identity does not bind its canonical bytes",
      });
    }
  });

const E3CampaignConformanceFaultControlResponseV1Schema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        schemaId: z.literal(E3_CONFORMANCE_FAULT_CONTROL_RESPONSE_SCHEMA_ID_V1),
        schemaVersion: z.literal(1),
        requestId: Sha256DigestV1Schema,
        status: z.literal("completed"),
        receipt: E3CampaignConformanceFaultReceiptV1Schema,
      })
      .strict(),
    z
      .object({
        schemaId: z.literal(E3_CONFORMANCE_FAULT_CONTROL_RESPONSE_SCHEMA_ID_V1),
        schemaVersion: z.literal(1),
        requestId: Sha256DigestV1Schema,
        status: z.literal("failed"),
        errorCode: z.enum([
          "fault_case_failed",
          "invalid_request",
          "controller_busy",
          "internal_error",
        ]),
        message: z.string().min(1).max(512),
      })
      .strict(),
  ],
);

const E3TrustRootFreezeRecordV1Schema = z
  .object({
    schemaId: z.literal("chronorift.e3.registrar-trust-root-freeze"),
    schemaVersion: z.literal(1),
    trustRootVersion: IdentifierV1Schema,
    trustRootFileSha256: Sha256DigestV1Schema,
    externalChannelPinSha256: Sha256DigestV1Schema.refine(
      (value) => value !== "0".repeat(64),
      "external channel pin cannot be the zero digest",
    ),
    signedAt: TimestampV1Schema,
    predecessor: z.literal(null),
    signatures: z
      .array(
        z
          .object({
            keyId: Sha256DigestV1Schema,
            signature: SignatureV1Schema,
          })
          .strict(),
      )
      .min(2)
      .max(16),
  })
  .strict();

const E3ConformancePreparationV1Schema = z
  .object({
    schemaId: z.literal("chronorift.e3.conformance-preparation"),
    schemaVersion: z.literal(1),
    registrarServiceId: IdentifierV1Schema,
    namespace: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u),
    productSha256: Sha256DigestV1Schema,
    runnerSha256: Sha256DigestV1Schema,
    validatorSha256: Sha256DigestV1Schema,
    trustRootVersion: IdentifierV1Schema,
    assignmentCommitment: Sha256DigestV1Schema,
    leaseId: IdentifierV1Schema,
    artifactSinkMode: z.literal(E3_ARTIFACT_SINK_MODE_V1),
    artifactSinkId: IdentifierV1Schema,
    artifactSinkCommitment: Sha256DigestV1Schema,
    deadline: TimestampV1Schema,
    caseId: z.enum([
      "early_complete",
      "deadline_incomplete",
      "deadline_cleanup_unproven_with_late_cleanup",
    ]),
    cleanupWitnessMode: z.enum([
      "external_auto_append_v1",
      "external_deadline_no_finish_v1",
      "external_withhold_cleanup_until_closed_then_revision_v1",
    ]),
    conformanceActor: E3RolePublicKeyV1Schema,
    cleanupActor: E3RolePublicKeyV1Schema,
  })
  .strict()
  .superRefine((preparation, context) => {
    if (
      preparation.cleanupWitnessMode !==
      E3_CONFORMANCE_CASE_WITNESS_V1[preparation.caseId]
    ) {
      context.addIssue({
        code: "custom",
        path: ["cleanupWitnessMode"],
        message: "cleanup witness mode does not match the frozen suite case",
      });
    }
  });

const E3CampaignConformanceSuiteSummaryV1Schema = z
  .object({
    schemaId: z.literal(E3_CONFORMANCE_SUITE_SUMMARY_SCHEMA_ID_V1),
    schemaVersion: z.literal(1),
    capability: z.literal("campaign_denominator_conformance"),
    campaignPurpose: z.literal("registrar_conformance"),
    claimEligible: z.literal(false),
    modelCalls: z.literal(0),
    evaluatorRuns: z.literal(0),
    campaignCount: z.literal(3),
    assignmentCount: z.literal(3),
    closureCount: z.literal(3),
    faultCaseCount: z.literal(2),
    faultControlId: IdentifierV1Schema,
    faultPlanId: Sha256DigestV1Schema,
    faultControlPolicySha256: Sha256DigestV1Schema,
    faultReceiptHashes: z.tuple([Sha256DigestV1Schema, Sha256DigestV1Schema]),
    productSha256: Sha256DigestV1Schema,
    runnerSha256: Sha256DigestV1Schema,
    validatorSha256: Sha256DigestV1Schema,
    trustRootVersion: IdentifierV1Schema,
    trustRootFileSha256: Sha256DigestV1Schema,
    trustRootFreezeRecordSha256: Sha256DigestV1Schema,
    trustRootExternalPinSha256: Sha256DigestV1Schema,
    registrarServiceId: IdentifierV1Schema,
    tlsSpkiId: Sha256DigestV1Schema,
    artifactSinkId: IdentifierV1Schema,
    artifactSinkCommitment: Sha256DigestV1Schema,
    caseIds: z.tuple([
      z.literal("early_complete"),
      z.literal("deadline_incomplete"),
      z.literal("deadline_cleanup_unproven_with_late_cleanup"),
    ]),
    campaignIds: z.tuple([
      Sha256DigestV1Schema,
      Sha256DigestV1Schema,
      Sha256DigestV1Schema,
    ]),
    assignmentIds: z.tuple([
      Sha256DigestV1Schema,
      Sha256DigestV1Schema,
      Sha256DigestV1Schema,
    ]),
    primaryOutcomes: z.tuple([
      z.literal("conformance_complete"),
      z.literal("incomplete_unknown"),
      z.literal("cleanup_unproven"),
    ]),
    evidenceHashes: z.tuple([
      Sha256DigestV1Schema,
      Sha256DigestV1Schema,
      Sha256DigestV1Schema,
    ]),
    caseSummaries: z.tuple([
      E3SanitizedSummaryV1Schema,
      E3SanitizedSummaryV1Schema,
      E3SanitizedSummaryV1Schema,
    ]),
    eventCount: z.number().int().positive(),
    appendAttemptCount: z.number().int().positive(),
    rejectionCount: z.number().int().nonnegative(),
    idempotentReplayCount: z.number().int().nonnegative(),
    revisionCount: z.number().int().nonnegative(),
  })
  .strict();

const E3CampaignConformanceSuiteEvidenceV1Schema = z
  .object({
    schemaId: z.literal(E3_CONFORMANCE_SUITE_EVIDENCE_SCHEMA_ID_V1),
    schemaVersion: z.literal(1),
    faultControlPolicySha256: Sha256DigestV1Schema,
    cases: z.tuple([
      z
        .object({
          caseId: z.literal("early_complete"),
          evidence: E3CampaignConformanceEvidenceV1Schema,
        })
        .strict(),
      z
        .object({
          caseId: z.literal("deadline_incomplete"),
          evidence: E3CampaignConformanceEvidenceV1Schema,
        })
        .strict(),
      z
        .object({
          caseId: z.literal("deadline_cleanup_unproven_with_late_cleanup"),
          evidence: E3CampaignConformanceEvidenceV1Schema,
        })
        .strict(),
    ]),
    faultReceipts: z.tuple([
      E3CampaignConformanceFaultReceiptV1Schema.refine(
        (receipt) => receipt.faultCase === "registrar_unreachable",
        "first fault receipt must cover registrar_unreachable",
      ),
      E3CampaignConformanceFaultReceiptV1Schema.refine(
        (receipt) => receipt.faultCase === "transparency_log_unavailable",
        "second fault receipt must cover transparency_log_unavailable",
      ),
    ]),
    summary: E3CampaignConformanceSuiteSummaryV1Schema,
  })
  .strict()
  .superRefine((suite, context) => {
    if (suite.faultReceipts[0].requestId === suite.faultReceipts[1].requestId) {
      context.addIssue({
        code: "custom",
        path: ["faultReceipts"],
        message: "fault receipts must bind distinct requests",
      });
    }
    if (
      suite.faultControlPolicySha256 !== suite.summary.faultControlPolicySha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["faultControlPolicySha256"],
        message: "suite evidence and summary must bind the same fault policy",
      });
    }
  });

type E3ConformancePreparationV1 = z.infer<
  typeof E3ConformancePreparationV1Schema
>;

export type E3ConformanceRunnerErrorCodeV1 =
  | "preflight_failed"
  | "orchestration_failed"
  | "evidence_failed"
  | "live_dependency_unavailable";

export class E3ConformanceRunnerError extends Error {
  public constructor(
    public readonly code: E3ConformanceRunnerErrorCodeV1,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`E3.1 conformance runner ${code}: ${message}`, options);
    this.name = "E3ConformanceRunnerError";
  }
}

interface E3ActorPublicKeyV1 {
  readonly actorRole: "conformance_actor" | "cleanup_actor";
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly validFrom: string;
  readonly validUntil: string;
}

export interface E3CampaignConformancePreflightV1 {
  readonly caseId: E3CampaignConformanceSuiteCaseIdV1;
  readonly cleanupWitnessMode: E3ConformancePreparationV1["cleanupWitnessMode"];
  readonly repositoryRoot: string;
  readonly evidenceDirectory: string;
  readonly validatorPath: string;
  readonly trustRoot: E3RegistrarTrustRootV1;
  readonly trustRootFileSha256: string;
  readonly trustRootFreezeRecordSha256: string;
  readonly trustRootExternalPinSha256: string;
  readonly faultControlPolicy: E3CampaignConformanceFaultControlPolicyV1;
  readonly faultControlPolicySha256: string;
  readonly service: E3RegistrarServiceBindingV1;
  readonly manifest: E3CampaignManifestV1;
  readonly actorKeys: readonly [E3ActorPublicKeyV1, E3ActorPublicKeyV1];
  readonly actorPrivateKey: KeyObject;
  readonly leaseId: string;
  readonly registrationCapability: string;
  readonly actorAppendCapability: string;
}

export interface E3CampaignConformanceSuitePreflightV1 {
  readonly earlyComplete: E3CampaignConformancePreflightV1;
  readonly deadlineIncomplete: E3CampaignConformancePreflightV1;
  readonly deadlineCleanupUnproven: E3CampaignConformancePreflightV1;
}

export interface E3CampaignClosedEvidenceV1 {
  readonly journal: E3JournalV1;
  readonly appendReceipts: readonly E3AppendReceiptV1[];
  readonly primaryClosure: E3PrimaryClosureV1;
  readonly revisions: readonly E3RevisionEnvelopeV1[];
  readonly revisionReceipts: readonly E3AppendReceiptV1[];
  readonly revisionJournalCheckpoint: E3RevisionJournalCheckpointV1;
  readonly publicationProof: E3PublicationProofV1;
  readonly rejectionCount: number;
}

/**
 * Host-owned bridge for evidence that the v1 registrar port cannot reconstruct:
 * cleanup/closure append receipts and the externally appended cleanup witness.
 * E3.1 live code must not synthesize these records.
 */
export interface E3CampaignClosureEvidencePortV1 {
  awaitClosedEvidence(input: {
    readonly manifest: E3CampaignManifestV1;
    readonly campaignId: string;
    readonly assignmentId: string;
    readonly knownAppendReceipts: readonly E3AppendReceiptV1[];
  }): Promise<E3CampaignClosedEvidenceV1>;
}

export interface E3CampaignConformanceRunDependenciesV1 {
  readonly registrar: E3RegistrarPortV1;
  readonly closureEvidence: E3CampaignClosureEvidencePortV1;
  readonly now?: (() => Date) | undefined;
  readonly assertResponseLossReplayObserved?:
    ((signedIdempotentReplayCount: number) => void) | undefined;
  readonly validateEvidence?:
    | ((evidencePath: string, validatorPath: string) => Promise<string>)
    | undefined;
}

export interface E3CampaignConformanceRunResultV1 {
  readonly evidencePath: string;
  readonly summary: E3SanitizedSummaryV1;
  readonly primaryOutcome: E3PrimaryClosureV1["primaryOutcome"];
  readonly validatorOutput: string;
}

export type E3CampaignConformanceSuiteCaseIdV1 =
  | "early_complete"
  | "deadline_incomplete"
  | "deadline_cleanup_unproven_with_late_cleanup";

export interface E3CampaignConformanceSuiteCaseResultV1 {
  readonly caseId: E3CampaignConformanceSuiteCaseIdV1;
  readonly campaignId: string;
  readonly assignmentId: string;
  readonly primaryOutcome: E3PrimaryClosureV1["primaryOutcome"];
  readonly closureHash: string;
  readonly revisionCount: number;
}

export type E3CampaignConformanceFaultCaseV1 =
  "registrar_unreachable" | "transparency_log_unavailable";

export type E3CampaignConformanceFaultReceiptV1 = z.infer<
  typeof E3CampaignConformanceFaultReceiptV1Schema
>;
export type E3CampaignConformanceFaultControlPolicyV1 = z.infer<
  typeof E3CampaignConformanceFaultControlPolicyV1Schema
>;

/**
 * Host-owned controller for the two destructive live fault probes. The Host
 * runs each probe in a separate child invocation against the same frozen
 * service/namespace and returns a bounded receipt showing that the child
 * failed closed without creating a final evidence file or success summary.
 * The returned receipt is verified against the threshold-authorized fault key
 * from the fixed repository policy. The fault key is not a registrar role or
 * an Agent-facing actor key.
 */
export interface E3CampaignConformanceFaultControlPortV1 {
  runFaultCase(input: {
    readonly requestId: string;
    readonly faultCase: E3CampaignConformanceFaultCaseV1;
    readonly registrarServiceId: string;
    readonly namespace: string;
    readonly evidenceDirectory: string;
    readonly evidenceFileName: typeof E3_CONFORMANCE_EVIDENCE_FILE_V1;
    readonly faultControlId: string;
    readonly faultPlanId: string;
    readonly faultKeyId: string;
  }): Promise<unknown>;
}

export type E3CampaignConformanceFaultControlRequestV1 = z.infer<
  typeof E3CampaignConformanceFaultControlRequestV1Schema
>;
export type E3CampaignConformanceFaultControlResponseV1 = z.infer<
  typeof E3CampaignConformanceFaultControlResponseV1Schema
>;

export interface E3CampaignConformanceSuiteResultV1 extends Omit<
  E3CampaignConformanceRunResultV1,
  "summary"
> {
  readonly summary: z.infer<typeof E3CampaignConformanceSuiteSummaryV1Schema>;
  readonly cases: readonly [
    E3CampaignConformanceSuiteCaseResultV1,
    E3CampaignConformanceSuiteCaseResultV1,
    E3CampaignConformanceSuiteCaseResultV1,
  ];
}

export interface E3PreparedCampaignConformanceCaseV1 {
  readonly preflight: E3CampaignConformancePreflightV1;
  readonly registrar: E3RegistrarPortV1;
  readonly closureEvidence: E3CampaignClosureEvidencePortV1;
  readonly now?: (() => Date) | undefined;
  readonly assertResponseLossReplayObserved?:
    ((signedIdempotentReplayCount: number) => void) | undefined;
  readonly validateEvidence?:
    | ((evidencePath: string, validatorPath: string) => Promise<string>)
    | undefined;
  readonly assertEvidenceRejected?:
    | ((evidencePath: string, validatorPath: string) => Promise<void>)
    | undefined;
}

export interface E3CampaignLivePreflightOptionsV1 {
  readonly repositoryRoot?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly nodeVersion?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly now?: Date | undefined;
  readonly readInheritedFd?:
    ((fd: number, maximumBytes: number) => Promise<Uint8Array>) | undefined;
}

const fail = (
  code: E3ConformanceRunnerErrorCodeV1,
  message: string,
  cause?: unknown,
): never => {
  throw new E3ConformanceRunnerError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
};

const asJson = (value: unknown): JsonValue => value as JsonValue;

const parseCanonicalFaultControlFrameV1 = (
  bytes: Uint8Array,
): E3CampaignConformanceFaultControlResponseV1 => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    return fail(
      "live_dependency_unavailable",
      "fault-control response is not UTF-8",
      error,
    );
  }
  if (text.length === 0 || text.includes("\0") || text.includes("\r")) {
    fail(
      "live_dependency_unavailable",
      "fault-control response contains forbidden framing bytes",
    );
  }
  let value: unknown;
  try {
    value = parseStrictRegistrarJsonV1(Buffer.from(bytes));
  } catch (error) {
    return fail(
      "live_dependency_unavailable",
      "fault-control response is not strict JSON",
      error,
    );
  }
  if (canonicalJson(asJson(value)) !== text) {
    fail(
      "live_dependency_unavailable",
      "fault-control response is not canonical JSON",
    );
  }
  try {
    return E3CampaignConformanceFaultControlResponseV1Schema.parse(value);
  } catch (error) {
    return fail(
      "live_dependency_unavailable",
      "fault-control response schema is invalid",
      error,
    );
  }
};

class E3CampaignConformanceFaultControlDuplexPortV1 implements E3CampaignConformanceFaultControlPortV1 {
  private inFlight = false;
  private requestCount = 0;

  public constructor(
    private readonly channel: Duplex,
    private readonly responseTimeoutMs: number,
    private readonly maximumResponseBytes: number,
  ) {}

  public async runFaultCase(
    input: Parameters<
      E3CampaignConformanceFaultControlPortV1["runFaultCase"]
    >[0],
  ): Promise<unknown> {
    if (this.inFlight) {
      return fail(
        "orchestration_failed",
        "fault-control channel permits only one in-flight request",
      );
    }
    const expectedCase = [
      "registrar_unreachable",
      "transparency_log_unavailable",
    ] as const;
    if (
      this.requestCount >= expectedCase.length ||
      input.faultCase !== expectedCase[this.requestCount]
    ) {
      return fail(
        "orchestration_failed",
        "fault-control requests must follow the frozen two-case order exactly once",
      );
    }

    let request: E3CampaignConformanceFaultControlRequestV1;
    try {
      request = E3CampaignConformanceFaultControlRequestV1Schema.parse({
        schemaId: E3_CONFORMANCE_FAULT_CONTROL_REQUEST_SCHEMA_ID_V1,
        schemaVersion: 1,
        ...input,
      });
    } catch (error) {
      return fail(
        "orchestration_failed",
        "fault-control request schema or identity is invalid",
        error,
      );
    }
    const frame = Buffer.from(`${canonicalJson(asJson(request))}\n`, "utf8");
    if (frame.byteLength > MAX_FAULT_CONTROL_REQUEST_BYTES) {
      return fail(
        "orchestration_failed",
        "fault-control request exceeds its byte bound",
      );
    }

    this.inFlight = true;
    try {
      const response = await this.exchange(request.requestId, frame);
      this.requestCount += 1;
      if (this.requestCount === expectedCase.length) this.destroyChannel();
      if (response.status === "failed") {
        return fail(
          "live_dependency_unavailable",
          `fault controller reported ${response.errorCode}: ${response.message}`,
        );
      }
      return response.receipt;
    } catch (error) {
      this.destroyChannel();
      if (error instanceof E3ConformanceRunnerError) throw error;
      return fail(
        "live_dependency_unavailable",
        "fault-control channel exchange failed",
        error,
      );
    } finally {
      this.inFlight = false;
    }
  }

  private destroyChannel(): void {
    // Some composite Duplex implementations surface an asynchronous abort
    // while their readable/writable halves are deliberately torn down.
    // The exchange has already settled, so retain a sink only for teardown.
    this.channel.on("error", () => undefined);
    this.channel.destroy();
  }

  private exchange(
    expectedRequestId: string,
    requestFrame: Buffer,
  ): Promise<E3CampaignConformanceFaultControlResponseV1> {
    return new Promise((resolveResponse, rejectResponse) => {
      let responseBytes = Buffer.alloc(0);
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        this.channel.off("data", onData);
        this.channel.off("error", onError);
        this.channel.off("end", onEnd);
        this.channel.off("close", onClose);
      };
      const rejectOnce = (message: string, cause?: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectResponse(
          new E3ConformanceRunnerError(
            "live_dependency_unavailable",
            message,
            cause === undefined ? undefined : { cause },
          ),
        );
      };
      const onData = (chunk: Buffer | string): void => {
        if (settled) return;
        const received = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, "utf8");
        responseBytes = Buffer.concat([responseBytes, received]);
        if (responseBytes.byteLength > this.maximumResponseBytes) {
          rejectOnce("fault-control response exceeds its byte bound");
          return;
        }
        const newline = responseBytes.indexOf(0x0a);
        if (newline < 0) return;
        if (newline !== responseBytes.byteLength - 1) {
          rejectOnce(
            "fault-control channel returned trailing bytes or multiple frames",
          );
          return;
        }
        let response: E3CampaignConformanceFaultControlResponseV1;
        try {
          response = parseCanonicalFaultControlFrameV1(
            responseBytes.subarray(0, newline),
          );
        } catch (error) {
          rejectOnce("fault-control response validation failed", error);
          return;
        }
        if (response.requestId !== expectedRequestId) {
          rejectOnce("fault-control response request identity does not match");
          return;
        }
        settled = true;
        cleanup();
        resolveResponse(response);
      };
      const onError = (error: Error): void => {
        rejectOnce("fault-control channel emitted an error", error);
      };
      const onEnd = (): void => {
        rejectOnce("fault-control channel ended before a complete response");
      };
      const onClose = (): void => {
        rejectOnce("fault-control channel closed before a complete response");
      };
      const timer = setTimeout(() => {
        rejectOnce("fault-control response deadline elapsed");
      }, this.responseTimeoutMs);
      this.channel.on("data", onData);
      this.channel.once("error", onError);
      this.channel.once("end", onEnd);
      this.channel.once("close", onClose);
      this.channel.write(requestFrame, (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          rejectOnce("fault-control request could not be written", error);
        }
      });
    });
  }
}

export const createE3CampaignConformanceFaultControlDuplexPortV1 = (input: {
  readonly channel: Duplex;
  readonly responseTimeoutMs?: number | undefined;
  readonly maximumResponseBytes?: number | undefined;
}): E3CampaignConformanceFaultControlPortV1 => {
  const responseTimeoutMs =
    input.responseTimeoutMs ?? FAULT_CONTROL_RESPONSE_TIMEOUT_MS;
  const maximumResponseBytes =
    input.maximumResponseBytes ?? MAX_FAULT_CONTROL_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(responseTimeoutMs) ||
    responseTimeoutMs < 1 ||
    responseTimeoutMs > FAULT_CONTROL_RESPONSE_TIMEOUT_MS ||
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1 ||
    maximumResponseBytes > MAX_FAULT_CONTROL_RESPONSE_BYTES
  ) {
    return fail(
      "orchestration_failed",
      "fault-control channel bounds are invalid",
    );
  }
  return new E3CampaignConformanceFaultControlDuplexPortV1(
    input.channel,
    responseTimeoutMs,
    maximumResponseBytes,
  );
};

export const createInheritedE3CampaignConformanceFaultControlPortV1 = (
  fd: number = E3_CONFORMANCE_FAULT_CONTROL_FD_V1,
): E3CampaignConformanceFaultControlPortV1 => {
  let channel: Socket;
  try {
    channel = new Socket({ fd, readable: true, writable: true });
  } catch (error) {
    return fail(
      "live_dependency_unavailable",
      `required inherited fault-control descriptor ${String(fd)} is unavailable`,
      error,
    );
  }
  return createE3CampaignConformanceFaultControlDuplexPortV1({ channel });
};

const requiredEnvironment = (
  environment: NodeJS.ProcessEnv,
  name: string,
): string => {
  const value = environment[name];
  if (value === undefined || value.length === 0 || value.includes("\0")) {
    return fail("preflight_failed", `live environment requires ${name}`);
  }
  return value;
};

const assertExactNodeVersion = (nodeVersion: string): void => {
  if (nodeVersion !== E3_CONFORMANCE_NODE_VERSION_V1) {
    fail(
      "preflight_failed",
      `requires exact Node ${E3_CONFORMANCE_NODE_VERSION_V1}, received ${nodeVersion}`,
    );
  }
};

const requiredExternalTrustRootSha256 = (): string => {
  const value = E3_CONFORMANCE_EXTERNAL_TRUST_ROOT_SHA256_V1;
  if (value === null) {
    return fail(
      "preflight_failed",
      "independent registrar trust-root pin has not been published in this release",
    );
  }
  return value;
};

export const readInheritedE3DescriptorV1 = (
  fd: number,
  maximumBytes: number,
): Promise<Uint8Array> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(Math.min(16 * 1024, maximumBytes + 1));
    let count: number;
    try {
      count = readSync(fd, buffer, 0, buffer.byteLength, null);
    } catch (error) {
      return fail(
        "preflight_failed",
        `required inherited descriptor ${String(fd)} is unavailable`,
        error,
      );
    }
    if (count === 0) break;
    total += count;
    if (total > maximumBytes) {
      fail(
        "preflight_failed",
        `inherited descriptor ${String(fd)} exceeds its byte bound`,
      );
    }
    chunks.push(buffer.subarray(0, count));
  }
  if (total === 0) {
    fail(
      "preflight_failed",
      `required inherited descriptor ${String(fd)} is empty`,
    );
  }
  return Promise.resolve(Buffer.concat(chunks));
};

const decodeUtf8 = (bytes: Uint8Array, label: string): string => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.startsWith("\uFEFF") || text.includes("\0")) {
      fail("preflight_failed", `${label} contains a BOM or NUL`);
    }
    return text;
  } catch (error) {
    if (error instanceof E3ConformanceRunnerError) throw error;
    return fail("preflight_failed", `${label} is not UTF-8`, error);
  }
};

const parseCanonicalJson = (bytes: Uint8Array, label: string): unknown => {
  const text = decodeUtf8(bytes, label);
  let value: unknown;
  try {
    value = parseStrictRegistrarJsonV1(Buffer.from(bytes));
  } catch (error) {
    return fail("preflight_failed", `${label} is not JSON`, error);
  }
  const expected = `${canonicalJson(asJson(value))}\n`;
  if (text !== expected) {
    fail(
      "preflight_failed",
      `${label} must use canonical JSON with exactly one trailing LF`,
    );
  }
  return value;
};

const capability = (bytes: Uint8Array, label: string): string => {
  const text = decodeUtf8(bytes, label);
  const value = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (
    value.length < 16 ||
    value.length > MAX_CAPABILITY_BYTES ||
    !/^[A-Za-z0-9._~:-]+$/u.test(value)
  ) {
    fail("preflight_failed", `${label} is not a bounded opaque capability`);
  }
  return value;
};

const canonicalRepositoryRoot = async (path: string): Promise<string> => {
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail(
      "preflight_failed",
      "repository root must be a normalized absolute path",
    );
  }
  let canonical: string;
  let stats;
  try {
    [canonical, stats] = await Promise.all([realpath(path), lstat(path)]);
  } catch (error) {
    return fail("preflight_failed", "repository root is unavailable", error);
  }
  if (canonical !== path || stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("preflight_failed", "repository root is not a canonical directory");
  }
  return canonical;
};

const readFixedRepositoryFile = async (
  repositoryRoot: string,
  relativePath: string,
): Promise<Buffer> => {
  const path = join(repositoryRoot, relativePath);
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    return fail(
      "preflight_failed",
      `required repository input ${relativePath} is unavailable`,
      error,
    );
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size < 1 ||
    before.size > MAX_REPOSITORY_INPUT_BYTES ||
    (await realpath(path)) !== path
  ) {
    fail(
      "preflight_failed",
      `required repository input ${relativePath} is not a bounded canonical file`,
    );
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs
    ) {
      fail(
        "preflight_failed",
        `required repository input ${relativePath} changed before read`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      fail(
        "preflight_failed",
        `required repository input ${relativePath} changed during read`,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
};

const canonicalEmptyEvidenceDirectory = async (
  repositoryRoot: string,
  path: string,
): Promise<string> => {
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail(
      "preflight_failed",
      "evidence directory must be a normalized absolute path",
    );
  }
  let canonical: string;
  let stats;
  let entries: string[];
  try {
    [canonical, stats, entries] = await Promise.all([
      realpath(path),
      lstat(path),
      readdir(path),
    ]);
  } catch (error) {
    return fail("preflight_failed", "evidence directory is unavailable", error);
  }
  const relativeToRepository = relative(repositoryRoot, path);
  if (
    canonical !== path ||
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    entries.length !== 0 ||
    relativeToRepository === "" ||
    (!relativeToRepository.startsWith(`..${sep}`) &&
      relativeToRepository !== "..")
  ) {
    fail(
      "preflight_failed",
      "evidence directory must be an empty canonical directory outside the repository",
    );
  }
  return canonical;
};

export const verifyConfiguredArtifactSinkBindingV1 = (input: {
  readonly artifactSinkMode: string;
  readonly artifactSinkId: string;
  readonly artifactSinkCommitment: string;
  readonly namespace: string;
  readonly leaseId: string;
  readonly canonicalAbsolutePath: string;
  readonly evidenceFileName: string;
}): void => {
  const expectedCommitment = artifactSinkCommitmentV1({
    namespace: input.namespace,
    leaseId: input.leaseId,
    artifactSinkId: input.artifactSinkId,
    canonicalAbsolutePath: input.canonicalAbsolutePath,
    evidenceFileName: input.evidenceFileName,
  });
  if (
    input.artifactSinkMode !== E3_ARTIFACT_SINK_MODE_V1 ||
    input.artifactSinkCommitment !== expectedCommitment
  ) {
    fail(
      "preflight_failed",
      "configured artifact sink does not match the capability-bound registration proposal",
    );
  }
};

const actorPublicKey = (
  privateKeyBytes: Uint8Array,
): {
  readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
  readonly keyId: string;
} => {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(Buffer.from(privateKeyBytes));
  } catch (error) {
    return fail(
      "preflight_failed",
      "actor private-key descriptor is invalid",
      error,
    );
  }
  if (
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519"
  ) {
    fail("preflight_failed", "actor private-key descriptor is not Ed25519");
  }
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  return {
    privateKey,
    publicKeyPem,
    keyId: ed25519KeyIdV1(publicKey),
  };
};

export const verifyTrustRootFreezeRecordV1 = (input: {
  readonly trustRoot: E3RegistrarTrustRootV1;
  readonly trustRootBytes: Uint8Array;
  readonly freezeRecord: unknown;
  readonly expectedExternalTrustRootSha256: string;
}): void => {
  const record = E3TrustRootFreezeRecordV1Schema.parse(input.freezeRecord);
  const trustRootFileSha256 = sha256HexV1(input.trustRootBytes);
  if (
    record.trustRootVersion !== input.trustRoot.trustRootVersion ||
    record.trustRootFileSha256 !== trustRootFileSha256 ||
    record.externalChannelPinSha256 !== trustRootFileSha256 ||
    record.externalChannelPinSha256 !== input.expectedExternalTrustRootSha256 ||
    Date.parse(record.signedAt) < Date.parse(input.trustRoot.validFrom) ||
    Date.parse(record.signedAt) >= Date.parse(input.trustRoot.validUntil)
  ) {
    fail(
      "preflight_failed",
      "trust-root freeze record does not match the independently pinned trust-root bytes",
    );
  }
  const { signatures, ...basis } = record;
  const rootKeys = new Map(
    input.trustRoot.rootKeys.map((key) => [key.keyId, key.publicKeyPem]),
  );
  const uniqueSigners = new Set<string>();
  for (const signature of signatures) {
    const publicKey = rootKeys.get(signature.keyId);
    if (
      publicKey !== undefined &&
      verifyCanonicalJsonSignatureV1({
        publicKey,
        domain: "chronorift-e3-trust-root-freeze-v1",
        schemaId: record.schemaId,
        version: record.schemaVersion,
        value: asJson(basis),
        signature: signature.signature,
      })
    ) {
      uniqueSigners.add(signature.keyId);
    }
  }
  if (uniqueSigners.size < input.trustRoot.signatureThreshold) {
    fail(
      "preflight_failed",
      "trust-root freeze record does not satisfy the pinned threshold",
    );
  }
};

export const verifyFaultControlPolicyV1 = (input: {
  readonly policy: unknown;
  readonly trustRoot: E3RegistrarTrustRootV1;
  readonly service: E3RegistrarServiceBindingV1;
  readonly namespace: string;
  readonly runnerSha256: string;
  readonly validatorSha256: string;
  readonly now: Date;
  readonly requiredUntil: Date;
}): E3CampaignConformanceFaultControlPolicyV1 => {
  const policy = E3CampaignConformanceFaultControlPolicyV1Schema.parse(
    input.policy,
  );
  if (
    policy.trustRootVersion !== input.trustRoot.trustRootVersion ||
    policy.serviceId !== input.service.serviceId ||
    policy.namespace !== input.namespace ||
    policy.runnerSha256 !== input.runnerSha256 ||
    policy.validatorSha256 !== input.validatorSha256
  ) {
    fail(
      "preflight_failed",
      "fault-control policy does not match the pinned service, namespace, or executable identities",
    );
  }
  let faultPublicKey: KeyObject;
  try {
    faultPublicKey = createPublicKey(policy.faultKey.publicKeyPem);
  } catch (error) {
    return fail(
      "preflight_failed",
      "fault-control policy public key is invalid",
      error,
    );
  }
  if (
    faultPublicKey.asymmetricKeyType !== "ed25519" ||
    ed25519KeyIdV1(faultPublicKey) !== policy.faultKey.keyId ||
    Date.parse(policy.faultKey.validFrom) <
      Date.parse(input.trustRoot.validFrom) ||
    Date.parse(policy.faultKey.validUntil) >
      Date.parse(input.trustRoot.validUntil) ||
    input.now.getTime() < Date.parse(policy.faultKey.validFrom) ||
    input.requiredUntil.getTime() >= Date.parse(policy.faultKey.validUntil)
  ) {
    fail(
      "preflight_failed",
      "fault-control key identity or validity does not cover the frozen live run",
    );
  }
  const reservedKeyIds = new Set([
    ...input.trustRoot.rootKeys.map(({ keyId }) => keyId),
    ...input.trustRoot.services.flatMap((candidateService) => [
      candidateService.receiptKey.keyId,
      candidateService.clockKey.keyId,
      candidateService.closureKey.keyId,
      candidateService.logKey.keyId,
    ]),
  ]);
  if (reservedKeyIds.has(policy.faultKey.keyId)) {
    fail(
      "preflight_failed",
      "fault-control key must be distinct from threshold and registrar role keys",
    );
  }
  const { signatures, ...basis } = policy;
  const rootKeys = new Map(
    input.trustRoot.rootKeys.map(({ keyId, publicKeyPem }) => [
      keyId,
      publicKeyPem,
    ]),
  );
  const validSigners = new Set<string>();
  for (const signature of signatures) {
    const publicKey = rootKeys.get(signature.keyId);
    if (
      publicKey === undefined ||
      !verifyCanonicalJsonSignatureV1({
        publicKey,
        domain: E3_CONFORMANCE_FAULT_CONTROL_POLICY_SIGNATURE_DOMAIN_V1,
        schemaId: policy.schemaId,
        version: policy.schemaVersion,
        value: asJson(basis),
        signature: signature.signature,
      })
    ) {
      fail(
        "preflight_failed",
        "fault-control policy contains an unknown or invalid root signature",
      );
    }
    validSigners.add(signature.keyId);
  }
  if (validSigners.size < input.trustRoot.signatureThreshold) {
    fail(
      "preflight_failed",
      "fault-control policy does not satisfy the pinned root threshold",
    );
  }
  return policy;
};

export const verifyCampaignConformanceFaultReceiptV1 = (input: {
  readonly receipt: unknown;
  readonly policy: E3CampaignConformanceFaultControlPolicyV1;
  readonly expectedRequestId: string;
  readonly expectedCase: E3CampaignConformanceFaultCaseV1;
  readonly registrarServiceId: string;
  readonly namespace: string;
}): E3CampaignConformanceFaultReceiptV1 => {
  const receipt = E3CampaignConformanceFaultReceiptV1Schema.parse(
    input.receipt,
  );
  if (
    !input.policy.allowedFaultCases.includes(receipt.faultCase) ||
    receipt.requestId !== input.expectedRequestId ||
    receipt.faultCase !== input.expectedCase ||
    receipt.faultControlId !== input.policy.faultControlId ||
    receipt.faultPlanId !== input.policy.faultPlanId ||
    receipt.faultKeyId !== input.policy.faultKey.keyId ||
    receipt.registrarServiceId !== input.registrarServiceId ||
    receipt.registrarServiceId !== input.policy.serviceId ||
    receipt.namespace !== input.namespace ||
    receipt.namespace !== input.policy.namespace ||
    Date.parse(receipt.startedAt) <
      Date.parse(input.policy.faultKey.validFrom) ||
    Date.parse(receipt.completedAt) >=
      Date.parse(input.policy.faultKey.validUntil)
  ) {
    fail(
      "evidence_failed",
      "fault receipt does not match the threshold-authorized fault-control policy",
    );
  }
  const { signature, ...signedBasis } = receipt;
  if (
    !verifyCanonicalJsonSignatureV1({
      publicKey: input.policy.faultKey.publicKeyPem,
      domain: E3_CONFORMANCE_FAULT_RECEIPT_SIGNATURE_DOMAIN_V1,
      schemaId: receipt.schemaId,
      version: receipt.schemaVersion,
      value: asJson(signedBasis),
      signature,
    })
  ) {
    fail("evidence_failed", "fault receipt signature is invalid");
  }
  return receipt;
};

const assertRoleKeyCoversRun = (
  key: E3ConformancePreparationV1["conformanceActor"],
  now: Date,
  deadline: string,
  label: string,
): void => {
  if (
    now.getTime() < Date.parse(key.validFrom) ||
    Date.parse(deadline) >= Date.parse(key.validUntil)
  ) {
    fail("preflight_failed", `${label} does not cover the conformance window`);
  }
};

export const verifyRegistrarRoleKeyCoverageV1 = (input: {
  readonly trustRoot: E3RegistrarTrustRootV1;
  readonly service: E3RegistrarServiceBindingV1;
  readonly now: Date;
  readonly deadline: string;
}): void => {
  const requiredUntil = Date.parse(input.deadline) + PUBLICATION_GRACE_MS;
  if (
    input.now.getTime() < Date.parse(input.trustRoot.validFrom) ||
    requiredUntil >= Date.parse(input.trustRoot.validUntil)
  ) {
    fail(
      "preflight_failed",
      "trust root does not cover the campaign deadline and publication window",
    );
  }
  for (const [role, key] of [
    ["receipt", input.service.receiptKey],
    ["clock", input.service.clockKey],
    ["closure", input.service.closureKey],
    ["log", input.service.logKey],
  ] as const) {
    if (
      input.now.getTime() < Date.parse(key.validFrom) ||
      requiredUntil >= Date.parse(key.validUntil)
    ) {
      fail(
        "preflight_failed",
        `${role} key does not cover the campaign deadline and publication window`,
      );
    }
  }
};

const preflightE3CampaignLiveCaseV1 = async (
  options: E3CampaignLivePreflightOptionsV1,
  descriptorSet: (typeof E3_CONFORMANCE_LIVE_SUITE_FDS_V1)[keyof typeof E3_CONFORMANCE_LIVE_SUITE_FDS_V1],
  expectedCaseId: E3CampaignConformanceSuiteCaseIdV1,
  expectedHostWitnessMode: string,
): Promise<E3CampaignConformancePreflightV1> => {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  assertExactNodeVersion(nodeVersion);
  if ((options.platform ?? process.platform) !== "linux") {
    fail("preflight_failed", "requires a Linux Host");
  }
  const externalTrustRootSha256 = requiredExternalTrustRootSha256();
  const environment = options.environment ?? process.env;
  for (const name of FORBIDDEN_SECRET_ENVIRONMENT) {
    if (environment[name] !== undefined && environment[name] !== "") {
      fail(
        "preflight_failed",
        `secret material must use inherited descriptors, not ${name}`,
      );
    }
  }
  for (const [name, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      value !== "" &&
      FORBIDDEN_CREDENTIAL_ENVIRONMENT_NAME.test(name)
    ) {
      fail(
        "preflight_failed",
        `credential-bearing environment ${name} is forbidden for registrar conformance`,
      );
    }
  }
  const repositoryRoot = await canonicalRepositoryRoot(
    options.repositoryRoot ?? process.cwd(),
  );
  const trustRootBytes = await readFixedRepositoryFile(
    repositoryRoot,
    E3_CONFORMANCE_TRUST_ROOT_RELATIVE_PATH_V1,
  );
  const [
    freezeRecordBytes,
    faultControlPolicyBytes,
    validatorBytes,
    runnerBundleBytes,
  ] = await Promise.all([
    readFixedRepositoryFile(
      repositoryRoot,
      E3_CONFORMANCE_TRUST_ROOT_FREEZE_RELATIVE_PATH_V1,
    ),
    readFixedRepositoryFile(
      repositoryRoot,
      E3_CONFORMANCE_FAULT_CONTROL_POLICY_RELATIVE_PATH_V1,
    ),
    readFixedRepositoryFile(
      repositoryRoot,
      E3_CONFORMANCE_VALIDATOR_RELATIVE_PATH_V1,
    ),
    Promise.all(
      E3_CONFORMANCE_RUNNER_BUNDLE_PATHS_V1.map(async (relativePath) => ({
        relativePath,
        bytes: await readFixedRepositoryFile(repositoryRoot, relativePath),
      })),
    ),
  ]);
  const now = options.now ?? new Date();
  const trustRoot = verifyTrustRootV1({
    trustRoot: parseCanonicalJson(trustRootBytes, "registrar trust root"),
    now,
  });
  verifyTrustRootFreezeRecordV1({
    trustRoot,
    trustRootBytes,
    freezeRecord: parseCanonicalJson(
      freezeRecordBytes,
      "registrar trust-root freeze record",
    ),
    expectedExternalTrustRootSha256: externalTrustRootSha256,
  });
  const serviceId = requiredEnvironment(
    environment,
    E3_CONFORMANCE_LIVE_ENV_V1.registrarServiceId,
  );
  const namespace = requiredEnvironment(
    environment,
    E3_CONFORMANCE_LIVE_ENV_V1.registrarNamespace,
  );
  const service = serviceFromTrustRootV1({
    trustRoot,
    serviceId,
    namespace,
    now,
  });
  if (
    requiredEnvironment(
      environment,
      E3_CONFORMANCE_LIVE_ENV_V1.hostCleanupWitness,
    ) !== expectedHostWitnessMode
  ) {
    fail(
      "preflight_failed",
      `${E3_CONFORMANCE_LIVE_ENV_V1.hostCleanupWitness} has an unsupported mode`,
    );
  }
  const evidenceDirectory = await canonicalEmptyEvidenceDirectory(
    repositoryRoot,
    requiredEnvironment(
      environment,
      E3_CONFORMANCE_LIVE_ENV_V1.evidenceDirectory,
    ),
  );
  const fdReader = options.readInheritedFd ?? readInheritedE3DescriptorV1;
  const [
    registrationBytes,
    actorCapabilityBytes,
    actorPrivateKeyBytes,
    preparationBytes,
  ] = await Promise.all([
    fdReader(descriptorSet.registrationCapability, MAX_CAPABILITY_BYTES),
    fdReader(descriptorSet.actorAppendCapability, MAX_CAPABILITY_BYTES),
    fdReader(descriptorSet.actorPrivateKey, MAX_PRIVATE_KEY_BYTES),
    fdReader(descriptorSet.registrationPreparation, MAX_PREPARATION_BYTES),
  ]);
  const registrationCapability = capability(
    registrationBytes,
    "registration capability descriptor",
  );
  const actorAppendCapability = capability(
    actorCapabilityBytes,
    "actor append capability descriptor",
  );
  if (registrationCapability === actorAppendCapability) {
    fail(
      "preflight_failed",
      "registration and actor capabilities must be distinct",
    );
  }
  const preparation = E3ConformancePreparationV1Schema.parse(
    parseCanonicalJson(preparationBytes, "registration preparation bundle"),
  );
  if (preparation.caseId !== expectedCaseId) {
    fail(
      "preflight_failed",
      `descriptor set for ${expectedCaseId} contains preparation for ${preparation.caseId}`,
    );
  }
  const runnerSha256 = canonicalContentHashV1(
    asJson(
      runnerBundleBytes.map(({ relativePath, bytes }) => ({
        relativePath,
        sha256: sha256HexV1(bytes),
      })),
    ),
  );
  const validatorSha256 = sha256HexV1(validatorBytes);
  if (
    preparation.registrarServiceId !== service.serviceId ||
    preparation.namespace !== namespace ||
    preparation.trustRootVersion !== trustRoot.trustRootVersion ||
    preparation.runnerSha256 !== runnerSha256 ||
    preparation.validatorSha256 !== validatorSha256
  ) {
    fail(
      "preflight_failed",
      "registration proposal does not match the pinned service or runner inputs",
    );
  }
  verifyConfiguredArtifactSinkBindingV1({
    artifactSinkMode: preparation.artifactSinkMode,
    artifactSinkId: preparation.artifactSinkId,
    artifactSinkCommitment: preparation.artifactSinkCommitment,
    namespace: preparation.namespace,
    leaseId: preparation.leaseId,
    canonicalAbsolutePath: evidenceDirectory,
    evidenceFileName: E3_CONFORMANCE_EVIDENCE_FILE_V1,
  });
  const actor = actorPublicKey(actorPrivateKeyBytes);
  if (
    actor.keyId !== preparation.conformanceActor.keyId ||
    actor.publicKeyPem !== preparation.conformanceActor.publicKeyPem
  ) {
    fail(
      "preflight_failed",
      "actor private key does not match the preparation bundle",
    );
  }
  let cleanupPublicKey: KeyObject;
  try {
    cleanupPublicKey = createPublicKey(preparation.cleanupActor.publicKeyPem);
  } catch (error) {
    return fail(
      "preflight_failed",
      "cleanup actor public key is invalid",
      error,
    );
  }
  if (
    cleanupPublicKey.asymmetricKeyType !== "ed25519" ||
    ed25519KeyIdV1(cleanupPublicKey) !== preparation.cleanupActor.keyId ||
    preparation.cleanupActor.keyId === preparation.conformanceActor.keyId
  ) {
    fail(
      "preflight_failed",
      "cleanup actor key is invalid or aliases the conformance actor",
    );
  }
  const nonActorKeyIds = new Set([
    ...trustRoot.rootKeys.map(({ keyId }) => keyId),
    ...trustRoot.services.flatMap((candidateService) => [
      candidateService.receiptKey.keyId,
      candidateService.clockKey.keyId,
      candidateService.closureKey.keyId,
      candidateService.logKey.keyId,
    ]),
  ]);
  if (
    nonActorKeyIds.has(preparation.conformanceActor.keyId) ||
    nonActorKeyIds.has(preparation.cleanupActor.keyId)
  ) {
    fail(
      "preflight_failed",
      "actor keys must not alias threshold-root or registrar service role keys",
    );
  }
  const deadlineMs = Date.parse(preparation.deadline);
  if (
    deadlineMs <= now.getTime() ||
    deadlineMs - now.getTime() > MAX_DEADLINE_DISTANCE_MS ||
    deadlineMs < Date.parse(trustRoot.validFrom) ||
    deadlineMs >= Date.parse(trustRoot.validUntil)
  ) {
    fail(
      "preflight_failed",
      "preparation deadline is expired, unbounded, or outside the trust root",
    );
  }
  const faultControlPolicy = verifyFaultControlPolicyV1({
    policy: parseCanonicalJson(
      faultControlPolicyBytes,
      "registrar fault-control policy",
    ),
    trustRoot,
    service,
    namespace,
    runnerSha256,
    validatorSha256,
    now,
    requiredUntil: new Date(deadlineMs + PUBLICATION_GRACE_MS),
  });
  if (
    faultControlPolicy.faultKey.keyId === preparation.conformanceActor.keyId ||
    faultControlPolicy.faultKey.keyId === preparation.cleanupActor.keyId
  ) {
    fail(
      "preflight_failed",
      "fault-control key must be distinct from conformance and cleanup actor keys",
    );
  }
  verifyRegistrarRoleKeyCoverageV1({
    trustRoot,
    service,
    now,
    deadline: preparation.deadline,
  });
  assertRoleKeyCoversRun(
    preparation.conformanceActor,
    now,
    preparation.deadline,
    "conformance actor key",
  );
  assertRoleKeyCoversRun(
    preparation.cleanupActor,
    now,
    preparation.deadline,
    "cleanup actor key",
  );
  const manifest = E3CampaignManifestV1Schema.parse({
    schemaId: E3_SCHEMA_IDS_V1.campaignManifest,
    schemaVersion: 1,
    campaignPurpose: "registrar_conformance",
    claimEligible: false,
    modelCalls: 0,
    evaluatorRuns: 0,
    artifactSinkMode: preparation.artifactSinkMode,
    artifactSinkId: preparation.artifactSinkId,
    artifactSinkCommitment: preparation.artifactSinkCommitment,
    namespace,
    registrarServiceId: service.serviceId,
    trustRootVersion: trustRoot.trustRootVersion,
    productSha256: preparation.productSha256,
    runnerSha256,
    validatorSha256,
    deadline: preparation.deadline,
    assignmentCount: 1,
    assignments: [
      {
        slotOrdinal: 0,
        assignmentCommitment: preparation.assignmentCommitment,
        conformanceActorKeyId: preparation.conformanceActor.keyId,
        cleanupActorKeyId: preparation.cleanupActor.keyId,
      },
    ],
  });
  return {
    caseId: preparation.caseId,
    cleanupWitnessMode: preparation.cleanupWitnessMode,
    repositoryRoot,
    evidenceDirectory,
    validatorPath: join(
      repositoryRoot,
      E3_CONFORMANCE_VALIDATOR_RELATIVE_PATH_V1,
    ),
    trustRoot,
    trustRootFileSha256: sha256HexV1(trustRootBytes),
    trustRootFreezeRecordSha256: sha256HexV1(freezeRecordBytes),
    trustRootExternalPinSha256: externalTrustRootSha256,
    faultControlPolicy,
    faultControlPolicySha256: sha256HexV1(faultControlPolicyBytes),
    service,
    manifest,
    actorKeys: [
      {
        actorRole: "conformance_actor",
        ...preparation.conformanceActor,
      },
      { actorRole: "cleanup_actor", ...preparation.cleanupActor },
    ],
    actorPrivateKey: actor.privateKey,
    leaseId: preparation.leaseId,
    registrationCapability,
    actorAppendCapability,
  };
};

export const preflightE3CampaignLiveV1 = async (
  options: E3CampaignLivePreflightOptionsV1 = {},
): Promise<E3CampaignConformancePreflightV1> =>
  await preflightE3CampaignLiveCaseV1(
    options,
    E3_CONFORMANCE_LIVE_SUITE_FDS_V1.earlyComplete,
    "early_complete",
    E3_CONFORMANCE_CASE_WITNESS_V1.early_complete,
  );

export const preflightE3CampaignLiveSuiteV1 = async (
  options: E3CampaignLivePreflightOptionsV1 = {},
): Promise<E3CampaignConformanceSuitePreflightV1> => {
  const [earlyComplete, deadlineIncomplete, deadlineCleanupUnproven] =
    await Promise.all([
      preflightE3CampaignLiveCaseV1(
        options,
        E3_CONFORMANCE_LIVE_SUITE_FDS_V1.earlyComplete,
        "early_complete",
        E3_CONFORMANCE_SUITE_HOST_WITNESS_MODE_V1,
      ),
      preflightE3CampaignLiveCaseV1(
        options,
        E3_CONFORMANCE_LIVE_SUITE_FDS_V1.deadlineIncomplete,
        "deadline_incomplete",
        E3_CONFORMANCE_SUITE_HOST_WITNESS_MODE_V1,
      ),
      preflightE3CampaignLiveCaseV1(
        options,
        E3_CONFORMANCE_LIVE_SUITE_FDS_V1.deadlineCleanupUnproven,
        "deadline_cleanup_unproven_with_late_cleanup",
        E3_CONFORMANCE_SUITE_HOST_WITNESS_MODE_V1,
      ),
    ]);
  const suite = {
    earlyComplete,
    deadlineIncomplete,
    deadlineCleanupUnproven,
  };
  assertLiveSuitePreflightBindingsV1(suite);
  return suite;
};

const signedActorEvent = (input: {
  readonly preflight: E3CampaignConformancePreflightV1;
  readonly campaignId: string;
  readonly assignmentId: string;
  readonly ordinal: number;
  readonly previousHash: string;
  readonly eventKind:
    "conformance_actor_started" | "conformance_actor_finished";
  readonly timestamp: string;
}): E3JournalEntryV1 => {
  const payload =
    input.eventKind === "conformance_actor_started"
      ? { leaseId: input.preflight.leaseId, startedAt: input.timestamp }
      : { leaseId: input.preflight.leaseId, finishedAt: input.timestamp };
  const payloadHash = canonicalContentHashV1(asJson(payload));
  const eventBasis = {
    schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
    schemaVersion: 1 as const,
    campaignId: input.campaignId,
    assignmentId: input.assignmentId,
    eventId: eventIdV1({
      campaignId: input.campaignId,
      assignmentId: input.assignmentId,
      ordinal: input.ordinal,
      previousHash: input.previousHash,
      eventKind: input.eventKind,
      payloadHash,
    }),
    ordinal: input.ordinal,
    previousHash: input.previousHash,
    actorRole: E3_EVENT_ACTOR_ACL_V1[input.eventKind],
    actorKeyId: input.preflight.manifest.assignments[0].conformanceActorKeyId,
    eventKind: input.eventKind,
    payloadSchemaId: E3_EVENT_PAYLOAD_SCHEMA_IDS_V1[input.eventKind],
    payloadHash,
  };
  return E3JournalEntryV1Schema.parse({
    event: {
      ...eventBasis,
      signature: signCanonicalJsonV1({
        privateKey: input.preflight.actorPrivateKey,
        domain: "chronorift-e3-event-v1",
        schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
        version: 1,
        value: asJson(eventBasis),
      }),
    },
    payload,
  });
};

const assertBeforeDeadline = (
  now: Date,
  deadline: string,
  stage: string,
): string => {
  if (now.getTime() >= Date.parse(deadline)) {
    fail("orchestration_failed", `${stage} reached the registered deadline`);
  }
  return now.toISOString();
};

const verifyRegistrationProof = (input: {
  readonly campaignId: string;
  readonly deadline: string;
  readonly proof: Awaited<
    ReturnType<E3RegistrarPortV1["registerCampaign"]>
  >["registrationProof"];
}): void => {
  if (
    !verifyInclusionProofV1({
      leafBytes: campaignRegistrationLeafBytesV1({
        campaignId: input.campaignId,
        deadline: input.deadline,
      }),
      leafIndex: input.proof.inclusionProof.leafIndex,
      treeSize: input.proof.inclusionProof.treeSize,
      auditPath: input.proof.inclusionProof.auditPath,
      expectedRoot: input.proof.checkpoint.rootHash,
    })
  ) {
    fail(
      "orchestration_failed",
      "registrar returned an invalid registration inclusion proof",
    );
  }
};

const verifyPublicationProof = (input: {
  readonly campaignId: string;
  readonly closure: E3PrimaryClosureV1;
  readonly proof: E3PublicationProofV1;
  readonly registrationCheckpointHash: string;
}): void => {
  if (
    canonicalContentHashV1(asJson(input.proof.registrationCheckpoint)) !==
    input.registrationCheckpointHash
  ) {
    fail(
      "evidence_failed",
      "publication proof does not retain the registration checkpoint",
    );
  }
  const inclusion = input.proof.closureInclusionProof;
  if (
    !verifyInclusionProofV1({
      leafBytes: closurePublicationLeafBytesV1({
        campaignId: input.campaignId,
        closureHash: input.closure.closureHash,
      }),
      leafIndex: inclusion.leafIndex,
      treeSize: inclusion.treeSize,
      auditPath: inclusion.auditPath,
      expectedRoot: input.proof.closureCheckpoint.rootHash,
    })
  ) {
    fail("evidence_failed", "closure inclusion proof is invalid");
  }
  const consistency = input.proof.registrationToClosureConsistencyProof;
  if (
    !verifyConsistencyProofV1({
      oldTreeSize: consistency.firstTreeSize,
      newTreeSize: consistency.secondTreeSize,
      oldRoot: input.proof.registrationCheckpoint.rootHash,
      newRoot: input.proof.closureCheckpoint.rootHash,
      proof: consistency.auditPath,
    })
  ) {
    fail(
      "evidence_failed",
      "registration-to-closure consistency proof is invalid",
    );
  }
};

const exactReceipt = (
  actual: E3AppendReceiptV1 | undefined,
  expected: E3AppendReceiptV1,
  label: string,
): void => {
  if (
    actual === undefined ||
    canonicalContentHashV1(asJson(actual)) !==
      canonicalContentHashV1(asJson(expected))
  ) {
    fail("evidence_failed", `${label} append receipt was omitted or replaced`);
  }
};

const expectRegistrarRejection = async (input: {
  readonly operation: Promise<unknown>;
  readonly expectedCodes: readonly E3RegistrarErrorCodeV1[];
  readonly label: string;
}): Promise<void> => {
  try {
    await input.operation;
  } catch (error) {
    if (
      error instanceof E3RegistrarError &&
      input.expectedCodes.includes(error.code)
    ) {
      return;
    }
    return fail(
      "orchestration_failed",
      `${input.label} produced an unexpected registrar response`,
      error,
    );
  }
  fail("orchestration_failed", `${input.label} was unexpectedly accepted`);
};

export class E3ResponseLossObservationTransportV1 implements E3StrictJsonTransportV1 {
  #firstRequestBytes: Buffer | undefined;
  #state: "awaiting_first" | "awaiting_retry" | "verified" | "failed" =
    "awaiting_first";

  public constructor(private readonly inner: E3StrictJsonTransportV1) {}

  public async request(
    input: Parameters<E3StrictJsonTransportV1["request"]>[0],
  ): Promise<unknown> {
    const parsed =
      input.method === "POST" && input.body !== undefined
        ? E3JournalEntryV1Schema.safeParse(input.body)
        : undefined;
    if (
      parsed?.success !== true ||
      parsed.data.event.eventKind !== "conformance_actor_started" ||
      this.#state === "verified"
    ) {
      return await this.inner.request(input);
    }
    if (this.#state === "failed") {
      return fail(
        "orchestration_failed",
        "response-loss observation cannot continue after a failed exchange",
      );
    }
    const requestBytes = canonicalRegistrarTransportRequestBytesV1(input);
    if (this.#state === "awaiting_first") {
      this.#firstRequestBytes = Buffer.from(requestBytes);
      try {
        await this.inner.request(input);
        this.#state = "failed";
        return fail(
          "orchestration_failed",
          "inner transport returned the first actor-start response; no external response loss was observed",
        );
      } catch (error) {
        if (error instanceof E3RegistrarError && error.code === "unavailable") {
          this.#state = "awaiting_retry";
          throw error;
        }
        this.#state = "failed";
        throw error;
      }
    }
    if (!this.#firstRequestBytes?.equals(requestBytes)) {
      this.#state = "failed";
      return fail(
        "orchestration_failed",
        "client response-loss retry changed canonical transport request bytes",
      );
    }
    try {
      const response = await this.inner.request(input);
      this.#state = "verified";
      return response;
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  public assertObservedAndBoundToClosure(
    signedIdempotentReplayCount: number,
  ): void {
    if (this.#state !== "verified") {
      fail(
        "orchestration_failed",
        "external response loss followed by a byte-identical successful client retry was not observed",
      );
    }
    if (signedIdempotentReplayCount !== 1) {
      fail(
        "evidence_failed",
        "signed closure replay count does not corroborate the observed response-loss retry",
      );
    }
  }
}

const independentValidateEvidence = async (
  evidencePath: string,
  validatorPath: string,
): Promise<string> =>
  await new Promise<string>((resolveOutput, reject) => {
    execFile(
      process.execPath,
      [validatorPath, evidencePath],
      {
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        maxBuffer: 1024 * 1024,
        shell: false,
        timeout: 60_000,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(
            new E3ConformanceRunnerError(
              "evidence_failed",
              "independent evidence validator rejected the retained bundle",
              { cause: error },
            ),
          );
          return;
        }
        resolveOutput(stdout);
      },
    );
  });

const independentAssertEvidenceRejected = async (
  evidencePath: string,
  validatorPath: string,
): Promise<void> =>
  await new Promise<void>((resolveRejection, rejectProbe) => {
    execFile(
      process.execPath,
      [validatorPath, evidencePath],
      {
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        maxBuffer: 1024 * 1024,
        shell: false,
        timeout: 60_000,
      },
      (error) => {
        if (error === null) {
          rejectProbe(
            new E3ConformanceRunnerError(
              "evidence_failed",
              "independent evidence validator accepted a mutated bundle",
            ),
          );
          return;
        }
        if (
          error.killed === true ||
          error.signal !== null ||
          typeof error.code !== "number" ||
          error.code === 0
        ) {
          rejectProbe(
            new E3ConformanceRunnerError(
              "evidence_failed",
              "independent evidence validator did not complete the mutation probe",
              { cause: error },
            ),
          );
          return;
        }
        resolveRejection();
      },
    );
  });

type E3SuiteMutationKindV1 =
  "journal" | "signature" | "inclusion" | "consistency";

const changedDigest = (digest: string): string =>
  `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`;

const changedSignature = (signature: string): string =>
  `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;

const mutatePendingSuiteBytesV1 = (
  pendingBytes: Buffer,
  kind: E3SuiteMutationKindV1,
): Buffer => {
  const suite = JSON.parse(pendingBytes.toString("utf8")) as {
    cases: Array<{
      evidence: {
        journal: { events: Array<{ payload: Record<string, unknown> }> };
        appendReceipts: Array<{ signature: string }>;
        publicationProof: {
          closureInclusionProof: { auditPath: string[] };
          registrationToClosureConsistencyProof: { auditPath: string[] };
        };
      };
    }>;
  };
  const evidence = suite.cases[0]?.evidence;
  if (evidence === undefined) {
    return fail("evidence_failed", "pending suite lacks its first case");
  }
  if (kind === "journal") {
    const payload = evidence.journal.events[1]?.payload;
    if (payload === undefined || typeof payload.startedAt !== "string") {
      return fail(
        "evidence_failed",
        "pending suite lacks the actor-start payload for mutation",
      );
    }
    payload.startedAt = "2000-01-01T00:00:00.000Z";
  } else if (kind === "signature") {
    const receipt = evidence.appendReceipts[0];
    if (receipt === undefined) {
      return fail(
        "evidence_failed",
        "pending suite lacks an append receipt for mutation",
      );
    }
    receipt.signature = changedSignature(receipt.signature);
  } else {
    const proof =
      kind === "inclusion"
        ? evidence.publicationProof.closureInclusionProof
        : evidence.publicationProof.registrationToClosureConsistencyProof;
    const node = proof.auditPath[0];
    if (node === undefined) {
      return fail(
        "evidence_failed",
        `pending suite lacks a ${kind} proof node for mutation`,
      );
    }
    proof.auditPath[0] = changedDigest(node);
  }
  return Buffer.from(`${canonicalJson(asJson(suite))}\n`, "utf8");
};

const assertPendingSuiteMutationsRejectedV1 = async (input: {
  readonly pendingPath: string;
  readonly validatorPath: string;
  readonly assertEvidenceRejected: (
    evidencePath: string,
    validatorPath: string,
  ) => Promise<void>;
}): Promise<void> => {
  const pendingBytes = await readFile(input.pendingPath);
  for (const kind of [
    "journal",
    "signature",
    "inclusion",
    "consistency",
  ] as const) {
    const mutationPath = `${input.pendingPath}.mutation-${kind}`;
    const handle = await open(mutationPath, "wx", 0o600);
    try {
      await handle.writeFile(mutatePendingSuiteBytesV1(pendingBytes, kind));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await input.assertEvidenceRejected(mutationPath, input.validatorPath);
    } finally {
      await unlink(mutationPath).catch(() => undefined);
    }
  }
};

const persistValidatedEvidence = async (input: {
  readonly evidenceDirectory: string;
  readonly validatorPath: string;
  readonly evidence: JsonValue;
  readonly validateEvidence: (
    evidencePath: string,
    validatorPath: string,
  ) => Promise<string>;
  readonly beforePublish?:
    ((pendingPath: string, validatorPath: string) => Promise<void>) | undefined;
}): Promise<{
  readonly evidencePath: string;
  readonly validatorOutput: string;
}> => {
  if ((await readdir(input.evidenceDirectory)).length !== 0) {
    fail("evidence_failed", "evidence directory changed after preflight");
  }
  const pendingPath = join(
    input.evidenceDirectory,
    `${E3_CONFORMANCE_EVIDENCE_FILE_V1}.pending`,
  );
  const finalPath = join(
    input.evidenceDirectory,
    E3_CONFORMANCE_EVIDENCE_FILE_V1,
  );
  const bytes = Buffer.from(`${canonicalJson(input.evidence)}\n`, "utf8");
  const expectedHash = sha256HexV1(bytes);
  const handle = await open(pendingPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const validatorOutput = await input.validateEvidence(
    pendingPath,
    input.validatorPath,
  );
  if (sha256HexV1(await readFile(pendingPath)) !== expectedHash) {
    fail("evidence_failed", "evidence changed while it was being validated");
  }
  await input.beforePublish?.(pendingPath, input.validatorPath);
  if (sha256HexV1(await readFile(pendingPath)) !== expectedHash) {
    fail("evidence_failed", "evidence changed during pre-publication probes");
  }
  try {
    await link(pendingPath, finalPath);
  } catch (error) {
    return fail(
      "evidence_failed",
      "validated evidence could not be published without overwrite",
      error,
    );
  }
  try {
    await unlink(pendingPath);
  } catch {
    // The no-replace hard link is the publication commit. Both names point to
    // the already validated immutable bytes; a staging-link cleanup failure
    // must not turn a committed success artifact into a reported failure.
  }
  return { evidencePath: finalPath, validatorOutput };
};

const assembleCampaignEvidenceV1 = (input: {
  readonly preflight: E3CampaignConformancePreflightV1;
  readonly registration: Awaited<
    ReturnType<E3RegistrarPortV1["registerCampaign"]>
  >;
  readonly journal: E3JournalV1;
  readonly appendReceipts: readonly E3AppendReceiptV1[];
  readonly closure: E3PrimaryClosureV1;
  readonly revisions: readonly E3RevisionEnvelopeV1[];
  readonly revisionReceipts: readonly E3AppendReceiptV1[];
  readonly revisionJournalCheckpoint: E3RevisionJournalCheckpointV1;
  readonly publicationProof: E3PublicationProofV1;
  readonly rejectionCount: number;
}) => {
  const campaignId = input.closure.campaignId;
  const assignmentId = input.journal.assignmentId;
  const revisionProjection = projectRevisionJournalV1({
    manifest: input.preflight.manifest,
    journal: input.journal,
    primaryClosure: input.closure,
    revisions: input.revisions,
  });
  const cleanupEventIndex = input.journal.events.findIndex(
    ({ event }) => event.eventKind === "conformance_cleanup_proven",
  );
  const cleanupReceiptHash =
    cleanupEventIndex < 0
      ? null
      : canonicalContentHashV1(
          asJson(input.appendReceipts[cleanupEventIndex]!),
        );
  const summary = E3SanitizedSummaryV1Schema.parse({
    schemaId: E3_SCHEMA_IDS_V1.sanitizedSummary,
    schemaVersion: 1,
    capability: "campaign_denominator_conformance",
    campaignPurpose: "registrar_conformance",
    viewKind: "latest_known",
    publicationState: "closure_published",
    claimEligible: false,
    modelCalls: 0,
    evaluatorRuns: 0,
    artifactSinkMode: input.preflight.manifest.artifactSinkMode,
    artifactSinkId: input.preflight.manifest.artifactSinkId,
    artifactSinkCommitment: input.preflight.manifest.artifactSinkCommitment,
    productSha256: input.preflight.manifest.productSha256,
    runnerSha256: input.preflight.manifest.runnerSha256,
    validatorSha256: input.preflight.manifest.validatorSha256,
    trustRootVersion: input.preflight.manifest.trustRootVersion,
    trustRootFileSha256: input.preflight.trustRootFileSha256,
    trustRootFreezeRecordSha256: input.preflight.trustRootFreezeRecordSha256,
    trustRootExternalPinSha256: input.preflight.trustRootExternalPinSha256,
    registrarServiceId: input.preflight.service.serviceId,
    tlsSpkiId: input.preflight.service.tlsSpkiSha256,
    registrarKeyIds: {
      receipt: input.preflight.service.receiptKey.keyId,
      clock: input.preflight.service.clockKey.keyId,
      closure: input.preflight.service.closureKey.keyId,
      log: input.preflight.service.logKey.keyId,
    },
    actorKeyIds: {
      conformance:
        input.preflight.manifest.assignments[0].conformanceActorKeyId,
      cleanup: input.preflight.manifest.assignments[0].cleanupActorKeyId,
    },
    campaignId,
    assignmentIds: [assignmentId],
    assignmentCount: 1,
    eventCount: input.journal.eventCount,
    appendAttemptCount: input.closure.appendAttemptCount,
    idempotentReplayCount: input.closure.idempotentReplayCount,
    revisionCount: revisionProjection.revisionCount,
    latestKnownEventCount: revisionProjection.latestKnownEventCount,
    rejectionCount: input.rejectionCount,
    closureCount: 1,
    primaryOutcome: input.closure.primaryOutcome,
    outcomeCounts: input.closure.outcomeCounts,
    journalHead: input.journal.journalHead,
    closureHash: input.closure.closureHash,
    deadline: input.preflight.manifest.deadline,
    closedAt: input.closure.closedAt,
    cleanupReceiptHash,
    revisionCheckpointHash: canonicalContentHashV1(
      asJson(input.revisionJournalCheckpoint),
    ),
    registrationCheckpointRoot:
      input.registration.registrationProof.checkpoint.rootHash,
    registrationCheckpointTreeSize:
      input.registration.registrationProof.checkpoint.treeSize,
    registrationCheckpointIssuedAt:
      input.registration.registrationProof.checkpoint.issuedAt,
    checkpointRoot: input.publicationProof.closureCheckpoint.rootHash,
    checkpointTreeSize: input.publicationProof.closureCheckpoint.treeSize,
    checkpointIssuedAt: input.publicationProof.closureCheckpoint.issuedAt,
    registrationInclusionProofHash: canonicalContentHashV1(
      asJson(input.registration.registrationProof.inclusionProof),
    ),
    inclusionProofHash: canonicalContentHashV1(
      asJson(input.publicationProof.closureInclusionProof),
    ),
    consistencyProofHash: canonicalContentHashV1(
      asJson(input.publicationProof.registrationToClosureConsistencyProof),
    ),
  });
  const evidence = E3CampaignConformanceEvidenceV1Schema.parse({
    schemaId: E3_SCHEMA_IDS_V1.campaignEvidence,
    schemaVersion: 1,
    trustRoot: input.preflight.trustRoot,
    actorKeys: input.preflight.actorKeys,
    manifest: input.preflight.manifest,
    registrationProof: input.registration.registrationProof,
    journal: input.journal,
    appendReceipts: input.appendReceipts,
    primaryClosure: input.closure,
    revisions: input.revisions,
    revisionReceipts: input.revisionReceipts,
    revisionJournalCheckpoint: input.revisionJournalCheckpoint,
    publicationProof: input.publicationProof,
    rejectionCount: input.rejectionCount,
    summary,
  });
  return { evidence, summary };
};

interface E3CollectedCampaignEvidenceV1 {
  readonly evidence: ReturnType<
    typeof E3CampaignConformanceEvidenceV1Schema.parse
  >;
  readonly summary: E3SanitizedSummaryV1;
  readonly primaryOutcome: E3PrimaryClosureV1["primaryOutcome"];
}

const collectE3CampaignConformanceV1 = async (
  preflight: E3CampaignConformancePreflightV1,
  dependencies: E3CampaignConformanceRunDependenciesV1,
): Promise<E3CollectedCampaignEvidenceV1> => {
  const campaignId = campaignIdV1(asJson(preflight.manifest));
  const slot = preflight.manifest.assignments[0];
  const assignmentId = assignmentIdV1({
    campaignId,
    slotOrdinal: slot.slotOrdinal,
    assignmentCommitment: slot.assignmentCommitment,
  });
  const registration = await dependencies.registrar.registerCampaign({
    manifest: preflight.manifest,
    actorCapability: preflight.registrationCapability,
  });
  if (
    registration.campaignId !== campaignId ||
    registration.assignmentId !== assignmentId ||
    registration.receipt.ordinal !== 1
  ) {
    fail(
      "orchestration_failed",
      "registration does not bind the canonical campaign and assignment",
    );
  }
  verifyRegistrationProof({
    campaignId,
    deadline: preflight.manifest.deadline,
    proof: registration.registrationProof,
  });
  const now = dependencies.now ?? (() => new Date());
  const started = signedActorEvent({
    preflight,
    campaignId,
    assignmentId,
    ordinal: 2,
    previousHash: registration.receipt.journalHead,
    eventKind: "conformance_actor_started",
    timestamp: assertBeforeDeadline(
      now(),
      preflight.manifest.deadline,
      "actor start",
    ),
  });
  const startedReceipt = await dependencies.registrar.appendEvent({
    campaignId,
    entry: started,
    actorCapability: preflight.actorAppendCapability,
  });
  const changedStart = structuredClone(started);
  changedStart.event.signature = `${started.event.signature.slice(0, -1)}${
    started.event.signature.endsWith("A") ? "B" : "A"
  }`;
  await expectRegistrarRejection({
    operation: dependencies.registrar.appendEvent({
      campaignId,
      entry: changedStart,
      actorCapability: preflight.actorAppendCapability,
    }),
    expectedCodes: ["conflict"],
    label: "same idempotency key with different bytes",
  });
  const outOfOrderFinish = signedActorEvent({
    preflight,
    campaignId,
    assignmentId,
    ordinal: 4,
    previousHash: startedReceipt.journalHead,
    eventKind: "conformance_actor_finished",
    timestamp: assertBeforeDeadline(
      now(),
      preflight.manifest.deadline,
      "out-of-order probe",
    ),
  });
  await expectRegistrarRejection({
    operation: dependencies.registrar.appendEvent({
      campaignId,
      entry: outOfOrderFinish,
      actorCapability: preflight.actorAppendCapability,
    }),
    expectedCodes: ["conflict"],
    label: "out-of-order ordinal",
  });
  const staleHeadFinish = signedActorEvent({
    preflight,
    campaignId,
    assignmentId,
    ordinal: 3,
    previousHash: registration.receipt.journalHead,
    eventKind: "conformance_actor_finished",
    timestamp: assertBeforeDeadline(
      now(),
      preflight.manifest.deadline,
      "stale-head probe",
    ),
  });
  await expectRegistrarRejection({
    operation: dependencies.registrar.appendEvent({
      campaignId,
      entry: staleHeadFinish,
      actorCapability: preflight.actorAppendCapability,
    }),
    expectedCodes: ["conflict"],
    label: "stale previous head",
  });
  const duplicateStart = signedActorEvent({
    preflight,
    campaignId,
    assignmentId,
    ordinal: 3,
    previousHash: startedReceipt.journalHead,
    eventKind: "conformance_actor_started",
    timestamp: (started.payload as { readonly startedAt: string }).startedAt,
  });
  await expectRegistrarRejection({
    operation: dependencies.registrar.appendEvent({
      campaignId,
      entry: duplicateStart,
      actorCapability: preflight.actorAppendCapability,
    }),
    expectedCodes: ["conflict", "invalid"],
    label: "duplicate payload",
  });
  const unauthorizedPayload = {
    deadline: preflight.manifest.deadline,
    observedAt: preflight.manifest.deadline,
  };
  const unauthorizedPayloadHash = canonicalContentHashV1(
    asJson(unauthorizedPayload),
  );
  const unauthorizedRegistrarEvent = E3JournalEntryV1Schema.parse({
    event: {
      schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
      schemaVersion: 1,
      campaignId,
      assignmentId,
      eventId: eventIdV1({
        campaignId,
        assignmentId,
        ordinal: 3,
        previousHash: startedReceipt.journalHead,
        eventKind: "registrar_deadline_elapsed",
        payloadHash: unauthorizedPayloadHash,
      }),
      ordinal: 3,
      previousHash: startedReceipt.journalHead,
      actorRole: "registrar",
      actorKeyId: preflight.manifest.assignments[0].conformanceActorKeyId,
      eventKind: "registrar_deadline_elapsed",
      payloadSchemaId:
        E3_EVENT_PAYLOAD_SCHEMA_IDS_V1.registrar_deadline_elapsed,
      payloadHash: unauthorizedPayloadHash,
      signature: "A".repeat(86),
    },
    payload: unauthorizedPayload,
  });
  const unauthorizedEventBasis = {
    ...unauthorizedRegistrarEvent.event,
  };
  delete (unauthorizedEventBasis as { signature?: string }).signature;
  unauthorizedRegistrarEvent.event.signature = signCanonicalJsonV1({
    privateKey: preflight.actorPrivateKey,
    domain: "chronorift-e3-event-v1",
    schemaId: E3_SCHEMA_IDS_V1.eventEnvelope,
    version: 1,
    value: asJson(unauthorizedEventBasis),
  });
  await expectRegistrarRejection({
    operation: dependencies.registrar.appendEvent({
      campaignId,
      entry: unauthorizedRegistrarEvent,
      actorCapability: preflight.actorAppendCapability,
    }),
    expectedCodes: ["unauthorized"],
    label: "actor capability for registrar-owned event kind",
  });
  const finished = signedActorEvent({
    preflight,
    campaignId,
    assignmentId,
    ordinal: 3,
    previousHash: startedReceipt.journalHead,
    eventKind: "conformance_actor_finished",
    timestamp: assertBeforeDeadline(
      now(),
      preflight.manifest.deadline,
      "actor finish",
    ),
  });
  const badSignatureFinish = structuredClone(finished);
  badSignatureFinish.event.signature = "A".repeat(86);
  await expectRegistrarRejection({
    operation: dependencies.registrar.appendEvent({
      campaignId,
      entry: badSignatureFinish,
      actorCapability: preflight.actorAppendCapability,
    }),
    expectedCodes: ["unauthorized", "invalid"],
    label: "bad actor signature",
  });
  const finishedReceipt = await dependencies.registrar.appendEvent({
    campaignId,
    entry: finished,
    actorCapability: preflight.actorAppendCapability,
  });
  const retained = await dependencies.closureEvidence.awaitClosedEvidence({
    manifest: preflight.manifest,
    campaignId,
    assignmentId,
    knownAppendReceipts: [
      registration.receipt,
      startedReceipt,
      finishedReceipt,
    ],
  });
  const journal = E3JournalV1Schema.parse(retained.journal);
  const appendReceipts = retained.appendReceipts.map((receipt) =>
    E3AppendReceiptV1Schema.parse(receipt),
  );
  const closure = validatePrimaryClosureV1({
    manifest: preflight.manifest,
    journal,
    appendReceipts,
    closure: E3PrimaryClosureV1Schema.parse(retained.primaryClosure),
  });
  dependencies.assertResponseLossReplayObserved?.(
    closure.idempotentReplayCount,
  );
  const publicationProof = E3PublicationProofV1Schema.parse(
    retained.publicationProof,
  );
  const revisions = retained.revisions.map((revision) =>
    E3RevisionEnvelopeV1Schema.parse(revision),
  );
  const revisionReceipts = retained.revisionReceipts.map((receipt) =>
    E3AppendReceiptV1Schema.parse(receipt),
  );
  const revisionJournalCheckpoint = E3RevisionJournalCheckpointV1Schema.parse(
    retained.revisionJournalCheckpoint,
  );
  if (revisions.length !== revisionReceipts.length) {
    fail(
      "evidence_failed",
      "retained revision and receipt chains have different lengths",
    );
  }
  const revisionProjection = projectRevisionJournalV1({
    manifest: preflight.manifest,
    journal,
    primaryClosure: closure,
    revisions,
  });
  const expectedRevisionHead =
    revisions.length === 0 ? null : revisionHashV1(revisions.at(-1)!);
  if (
    closure.primaryOutcome !== "conformance_complete" ||
    Date.parse(closure.closedAt) >= Date.parse(preflight.manifest.deadline) ||
    journal.events.some(
      ({ event }) => event.eventKind === "registrar_deadline_elapsed",
    ) ||
    revisionJournalCheckpoint.campaignId !== campaignId ||
    revisionJournalCheckpoint.primaryClosureHash !== closure.closureHash ||
    revisionJournalCheckpoint.revisionHead !== expectedRevisionHead ||
    revisionJournalCheckpoint.revisionCount !== revisions.length ||
    revisionJournalCheckpoint.latestKnownEventCount !==
      revisionProjection.latestKnownEventCount ||
    retained.rejectionCount !== 6 ||
    closure.rejectionCount !== 6 ||
    closure.idempotentReplayCount !== 1 ||
    closure.appendAttemptCount !== journal.eventCount + 7 ||
    retained.appendReceipts.length !== journal.eventCount ||
    journal.events[1] === undefined ||
    eventHashV1(journal.events[1]) !== eventHashV1(started) ||
    journal.events[2] === undefined ||
    eventHashV1(journal.events[2]) !== eventHashV1(finished)
  ) {
    fail(
      "evidence_failed",
      "closed evidence omitted or changed the retained actor lifecycle",
    );
  }
  exactReceipt(appendReceipts[0], registration.receipt, "registration");
  exactReceipt(appendReceipts[1], startedReceipt, "actor start");
  exactReceipt(appendReceipts[2], finishedReceipt, "actor finish");
  const registrationCheckpointHash = canonicalContentHashV1(
    asJson(registration.registrationProof.checkpoint),
  );
  verifyPublicationProof({
    campaignId,
    closure,
    proof: publicationProof,
    registrationCheckpointHash,
  });
  const { evidence, summary } = assembleCampaignEvidenceV1({
    preflight,
    registration,
    journal,
    appendReceipts,
    closure,
    revisions,
    revisionReceipts,
    revisionJournalCheckpoint,
    publicationProof,
    rejectionCount: retained.rejectionCount,
  });
  return {
    evidence,
    summary,
    primaryOutcome: closure.primaryOutcome,
  };
};

export const runE3CampaignConformanceV1 = async (
  preflight: E3CampaignConformancePreflightV1,
  dependencies: E3CampaignConformanceRunDependenciesV1,
): Promise<E3CampaignConformanceRunResultV1> => {
  const collected = await collectE3CampaignConformanceV1(
    preflight,
    dependencies,
  );
  const persisted = await persistValidatedEvidence({
    evidenceDirectory: preflight.evidenceDirectory,
    validatorPath: preflight.validatorPath,
    evidence: asJson(collected.evidence),
    validateEvidence:
      dependencies.validateEvidence ?? independentValidateEvidence,
  });
  return {
    ...persisted,
    summary: collected.summary,
    primaryOutcome: collected.primaryOutcome,
  };
};

const runDeadlineClosureCaseV1 = async (input: {
  readonly caseId:
    "deadline_incomplete" | "deadline_cleanup_unproven_with_late_cleanup";
  readonly prepared: E3PreparedCampaignConformanceCaseV1;
}): Promise<{
  readonly result: E3CampaignConformanceSuiteCaseResultV1;
  readonly collected: E3CollectedCampaignEvidenceV1;
}> => {
  const { preflight, registrar, closureEvidence } = input.prepared;
  const campaignId = campaignIdV1(asJson(preflight.manifest));
  const slot = preflight.manifest.assignments[0];
  const assignmentId = assignmentIdV1({
    campaignId,
    slotOrdinal: slot.slotOrdinal,
    assignmentCommitment: slot.assignmentCommitment,
  });
  const registration = await registrar.registerCampaign({
    manifest: preflight.manifest,
    actorCapability: preflight.registrationCapability,
  });
  if (
    registration.campaignId !== campaignId ||
    registration.assignmentId !== assignmentId ||
    registration.receipt.ordinal !== 1
  ) {
    fail(
      "orchestration_failed",
      `${input.caseId} registration does not bind its canonical identities`,
    );
  }
  verifyRegistrationProof({
    campaignId,
    deadline: preflight.manifest.deadline,
    proof: registration.registrationProof,
  });

  const now = input.prepared.now ?? (() => new Date());
  const started = signedActorEvent({
    preflight,
    campaignId,
    assignmentId,
    ordinal: 2,
    previousHash: registration.receipt.journalHead,
    eventKind: "conformance_actor_started",
    timestamp: assertBeforeDeadline(
      now(),
      preflight.manifest.deadline,
      `${input.caseId} actor start`,
    ),
  });
  const startedReceipt = await registrar.appendEvent({
    campaignId,
    entry: started,
    actorCapability: preflight.actorAppendCapability,
  });
  const knownAppendReceipts: E3AppendReceiptV1[] = [
    registration.receipt,
    startedReceipt,
  ];
  let finished: E3JournalEntryV1 | undefined;
  if (input.caseId === "deadline_cleanup_unproven_with_late_cleanup") {
    finished = signedActorEvent({
      preflight,
      campaignId,
      assignmentId,
      ordinal: 3,
      previousHash: startedReceipt.journalHead,
      eventKind: "conformance_actor_finished",
      timestamp: assertBeforeDeadline(
        now(),
        preflight.manifest.deadline,
        `${input.caseId} actor finish`,
      ),
    });
    knownAppendReceipts.push(
      await registrar.appendEvent({
        campaignId,
        entry: finished,
        actorCapability: preflight.actorAppendCapability,
      }),
    );
  }

  const retained = await closureEvidence.awaitClosedEvidence({
    manifest: preflight.manifest,
    campaignId,
    assignmentId,
    knownAppendReceipts,
  });
  const journal = E3JournalV1Schema.parse(retained.journal);
  const appendReceipts = retained.appendReceipts.map((receipt) =>
    E3AppendReceiptV1Schema.parse(receipt),
  );
  const closure = validatePrimaryClosureV1({
    manifest: preflight.manifest,
    journal,
    appendReceipts,
    closure: E3PrimaryClosureV1Schema.parse(retained.primaryClosure),
  });
  const expectedOutcome =
    input.caseId === "deadline_incomplete"
      ? "incomplete_unknown"
      : "cleanup_unproven";
  const expectedKinds =
    input.caseId === "deadline_incomplete"
      ? [
          "registrar_assignment_registered",
          "conformance_actor_started",
          "registrar_deadline_elapsed",
          "registrar_primary_closed",
        ]
      : [
          "registrar_assignment_registered",
          "conformance_actor_started",
          "conformance_actor_finished",
          "registrar_deadline_elapsed",
          "registrar_primary_closed",
        ];
  if (
    closure.primaryOutcome !== expectedOutcome ||
    Date.parse(closure.closedAt) < Date.parse(preflight.manifest.deadline) ||
    retained.rejectionCount !== 0 ||
    closure.rejectionCount !== 0 ||
    closure.idempotentReplayCount !== 0 ||
    closure.appendAttemptCount !== journal.eventCount ||
    appendReceipts.length !== journal.eventCount ||
    canonicalContentHashV1(
      asJson(journal.events.map(({ event }) => event.eventKind)),
    ) !== canonicalContentHashV1(asJson(expectedKinds)) ||
    journal.events[1] === undefined ||
    eventHashV1(journal.events[1]) !== eventHashV1(started) ||
    (finished !== undefined &&
      (journal.events[2] === undefined ||
        eventHashV1(journal.events[2]) !== eventHashV1(finished)))
  ) {
    fail(
      "evidence_failed",
      `${input.caseId} closed evidence does not match its frozen lifecycle`,
    );
  }
  for (const [index, receipt] of knownAppendReceipts.entries()) {
    exactReceipt(appendReceipts[index], receipt, `${input.caseId} event`);
  }

  const revisions = retained.revisions.map((revision) =>
    E3RevisionEnvelopeV1Schema.parse(revision),
  );
  const revisionReceipts = retained.revisionReceipts.map((receipt) =>
    E3AppendReceiptV1Schema.parse(receipt),
  );
  const revisionProjection = projectRevisionJournalV1({
    manifest: preflight.manifest,
    journal,
    primaryClosure: closure,
    revisions,
  });
  const revisionCheckpoint = E3RevisionJournalCheckpointV1Schema.parse(
    retained.revisionJournalCheckpoint,
  );
  const expectedRevisionCount =
    input.caseId === "deadline_cleanup_unproven_with_late_cleanup" ? 1 : 0;
  const revisionHead =
    revisions.length === 0 ? null : revisionHashV1(revisions.at(-1)!);
  const lateCleanup = revisions[0]?.lateEntry;
  if (
    revisions.length !== expectedRevisionCount ||
    revisionReceipts.length !== expectedRevisionCount ||
    revisionProjection.revisionCount !== expectedRevisionCount ||
    revisionCheckpoint.campaignId !== campaignId ||
    revisionCheckpoint.primaryClosureHash !== closure.closureHash ||
    revisionCheckpoint.revisionHead !== revisionHead ||
    revisionCheckpoint.revisionCount !== expectedRevisionCount ||
    revisionCheckpoint.latestKnownEventCount !==
      journal.eventCount + expectedRevisionCount ||
    (expectedRevisionCount === 1 &&
      (lateCleanup?.event.eventKind !== "conformance_cleanup_proven" ||
        lateCleanup.event.ordinal !== 4 ||
        lateCleanup.event.previousHash !==
          knownAppendReceipts[2]?.journalHead ||
        Date.parse(revisions[0]!.receivedAt) < Date.parse(closure.closedAt)))
  ) {
    fail(
      "evidence_failed",
      `${input.caseId} revision evidence does not match its frozen lifecycle`,
    );
  }

  const registrationCheckpointHash = canonicalContentHashV1(
    asJson(registration.registrationProof.checkpoint),
  );
  const publicationProof = E3PublicationProofV1Schema.parse(
    retained.publicationProof,
  );
  verifyPublicationProof({
    campaignId,
    closure,
    proof: publicationProof,
    registrationCheckpointHash,
  });
  const assembled = assembleCampaignEvidenceV1({
    preflight,
    registration,
    journal,
    appendReceipts,
    closure,
    revisions,
    revisionReceipts,
    revisionJournalCheckpoint: revisionCheckpoint,
    publicationProof,
    rejectionCount: retained.rejectionCount,
  });
  return {
    result: {
      caseId: input.caseId,
      campaignId,
      assignmentId,
      primaryOutcome: closure.primaryOutcome,
      closureHash: closure.closureHash,
      revisionCount: revisions.length,
    },
    collected: {
      ...assembled,
      primaryOutcome: closure.primaryOutcome,
    },
  };
};

const assertLiveSuitePreflightBindingsV1 = (
  suite: E3CampaignConformanceSuitePreflightV1,
): void => {
  const preflights = [
    suite.earlyComplete,
    suite.deadlineIncomplete,
    suite.deadlineCleanupUnproven,
  ] as const;
  const reference = suite.earlyComplete;
  const expectedCases = [
    "early_complete",
    "deadline_incomplete",
    "deadline_cleanup_unproven_with_late_cleanup",
  ] as const;
  for (const [index, candidate] of preflights.entries()) {
    const expectedCaseId = expectedCases[index]!;
    if (
      candidate.caseId !== expectedCaseId ||
      candidate.cleanupWitnessMode !==
        E3_CONFORMANCE_CASE_WITNESS_V1[expectedCaseId] ||
      candidate.evidenceDirectory !== reference.evidenceDirectory ||
      candidate.validatorPath !== reference.validatorPath ||
      candidate.manifest.namespace !== reference.manifest.namespace ||
      candidate.manifest.artifactSinkId !== reference.manifest.artifactSinkId ||
      candidate.manifest.artifactSinkCommitment !==
        reference.manifest.artifactSinkCommitment ||
      candidate.manifest.registrarServiceId !==
        reference.manifest.registrarServiceId ||
      candidate.manifest.productSha256 !== reference.manifest.productSha256 ||
      candidate.manifest.runnerSha256 !== reference.manifest.runnerSha256 ||
      candidate.manifest.validatorSha256 !==
        reference.manifest.validatorSha256 ||
      candidate.manifest.trustRootVersion !==
        reference.manifest.trustRootVersion ||
      candidate.trustRootFileSha256 !== reference.trustRootFileSha256 ||
      candidate.trustRootFreezeRecordSha256 !==
        reference.trustRootFreezeRecordSha256 ||
      candidate.trustRootExternalPinSha256 !==
        reference.trustRootExternalPinSha256 ||
      candidate.faultControlPolicySha256 !==
        reference.faultControlPolicySha256 ||
      canonicalContentHashV1(asJson(candidate.faultControlPolicy)) !==
        canonicalContentHashV1(asJson(reference.faultControlPolicy)) ||
      canonicalContentHashV1(asJson(candidate.service)) !==
        canonicalContentHashV1(asJson(reference.service)) ||
      canonicalContentHashV1(asJson(candidate.trustRoot)) !==
        canonicalContentHashV1(asJson(reference.trustRoot)) ||
      candidate.leaseId !== reference.leaseId
    ) {
      fail(
        "preflight_failed",
        "live suite cases do not match the frozen case, service, identity, lease, or artifact-sink bindings",
      );
    }
  }
  const campaignIds = preflights.map((preflight) =>
    campaignIdV1(asJson(preflight.manifest)),
  );
  const assignmentIds = preflights.map((preflight, index) => {
    const slot = preflight.manifest.assignments[0];
    return assignmentIdV1({
      campaignId: campaignIds[index]!,
      slotOrdinal: slot.slotOrdinal,
      assignmentCommitment: slot.assignmentCommitment,
    });
  });
  if (
    new Set(campaignIds).size !== 3 ||
    new Set(assignmentIds).size !== 3 ||
    new Set(
      preflights.map(({ registrationCapability }) => registrationCapability),
    ).size !== 3 ||
    new Set(
      preflights.map(({ actorAppendCapability }) => actorAppendCapability),
    ).size !== 3
  ) {
    fail(
      "preflight_failed",
      "live suite requires three unique campaign, assignment, and capability bindings",
    );
  }
};

const assertFinalEvidenceAbsentV1 = async (
  evidenceDirectory: string,
): Promise<void> => {
  try {
    await lstat(join(evidenceDirectory, E3_CONFORMANCE_EVIDENCE_FILE_V1));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    return fail(
      "evidence_failed",
      "final evidence path could not be inspected during a fault probe",
      error,
    );
  }
  fail(
    "evidence_failed",
    "a fault probe created a forbidden final success artifact",
  );
};

const runLiveFaultMatrixV1 = async (input: {
  readonly preflight: E3CampaignConformancePreflightV1;
  readonly faultControl: E3CampaignConformanceFaultControlPortV1;
}): Promise<
  readonly [
    E3CampaignConformanceFaultReceiptV1,
    E3CampaignConformanceFaultReceiptV1,
  ]
> => {
  const receipts: E3CampaignConformanceFaultReceiptV1[] = [];
  await assertFinalEvidenceAbsentV1(input.preflight.evidenceDirectory);
  for (const faultCase of [
    "registrar_unreachable",
    "transparency_log_unavailable",
  ] as const) {
    const requestInput = {
      faultCase,
      registrarServiceId: input.preflight.service.serviceId,
      namespace: input.preflight.manifest.namespace,
      evidenceDirectory: input.preflight.evidenceDirectory,
      evidenceFileName: E3_CONFORMANCE_EVIDENCE_FILE_V1,
      faultControlId: input.preflight.faultControlPolicy.faultControlId,
      faultPlanId: input.preflight.faultControlPolicy.faultPlanId,
      faultKeyId: input.preflight.faultControlPolicy.faultKey.keyId,
    } as const;
    const requestId = campaignConformanceFaultControlRequestIdV1(
      asJson({
        schemaId: E3_CONFORMANCE_FAULT_CONTROL_REQUEST_SCHEMA_ID_V1,
        schemaVersion: 1,
        ...requestInput,
      }),
    );
    const receipt = verifyCampaignConformanceFaultReceiptV1({
      receipt: await input.faultControl.runFaultCase({
        requestId,
        ...requestInput,
      }),
      policy: input.preflight.faultControlPolicy,
      expectedRequestId: requestId,
      expectedCase: faultCase,
      registrarServiceId: input.preflight.service.serviceId,
      namespace: input.preflight.manifest.namespace,
    });
    if (
      receipt.faultCase !== faultCase ||
      receipt.registrarServiceId !== input.preflight.service.serviceId ||
      receipt.namespace !== input.preflight.manifest.namespace ||
      (receipts[0] !== undefined &&
        (receipt.faultControlId !== receipts[0].faultControlId ||
          receipt.faultPlanId !== receipts[0].faultPlanId))
    ) {
      fail(
        "orchestration_failed",
        `${faultCase} receipt does not match the frozen live fault plan`,
      );
    }
    await assertFinalEvidenceAbsentV1(input.preflight.evidenceDirectory);
    receipts.push(receipt);
  }
  return [receipts[0]!, receipts[1]!];
};

/**
 * Runs the two deadline-driven cases first and publishes the sole success
 * artifact only from the final early-completion case. A failure in either
 * prerequisite case therefore cannot leave a partial success artifact.
 * External live preparation must provision three independently registered
 * manifests and capabilities before calling this function.
 */
export const runPreparedE3CampaignLiveSuiteV1 = async (input: {
  readonly deadlineIncomplete: E3PreparedCampaignConformanceCaseV1;
  readonly deadlineCleanupUnproven: E3PreparedCampaignConformanceCaseV1;
  readonly earlyComplete: E3PreparedCampaignConformanceCaseV1;
  readonly faultControl: E3CampaignConformanceFaultControlPortV1;
}): Promise<E3CampaignConformanceSuiteResultV1> => {
  assertLiveSuitePreflightBindingsV1({
    earlyComplete: input.earlyComplete.preflight,
    deadlineIncomplete: input.deadlineIncomplete.preflight,
    deadlineCleanupUnproven: input.deadlineCleanupUnproven.preflight,
  });
  const reference = input.earlyComplete.preflight;
  const faultReceipts = await runLiveFaultMatrixV1({
    preflight: reference,
    faultControl: input.faultControl,
  });
  const [incomplete, cleanupUnproven, complete] = await Promise.all([
    runDeadlineClosureCaseV1({
      caseId: "deadline_incomplete",
      prepared: input.deadlineIncomplete,
    }),
    runDeadlineClosureCaseV1({
      caseId: "deadline_cleanup_unproven_with_late_cleanup",
      prepared: input.deadlineCleanupUnproven,
    }),
    collectE3CampaignConformanceV1(input.earlyComplete.preflight, {
      registrar: input.earlyComplete.registrar,
      closureEvidence: input.earlyComplete.closureEvidence,
      now: input.earlyComplete.now,
      assertResponseLossReplayObserved:
        input.earlyComplete.assertResponseLossReplayObserved,
      validateEvidence: input.earlyComplete.validateEvidence,
    }),
  ]);
  const completeCase: E3CampaignConformanceSuiteCaseResultV1 = {
    caseId: "early_complete",
    campaignId: complete.summary.campaignId,
    assignmentId: complete.summary.assignmentIds[0],
    primaryOutcome: complete.primaryOutcome,
    closureHash: complete.summary.closureHash,
    revisionCount: complete.summary.revisionCount,
  };
  const collectedCases = [
    complete,
    incomplete.collected,
    cleanupUnproven.collected,
  ] as const;
  const suiteSummary = E3CampaignConformanceSuiteSummaryV1Schema.parse({
    schemaId: E3_CONFORMANCE_SUITE_SUMMARY_SCHEMA_ID_V1,
    schemaVersion: 1,
    capability: "campaign_denominator_conformance",
    campaignPurpose: "registrar_conformance",
    claimEligible: false,
    modelCalls: 0,
    evaluatorRuns: 0,
    campaignCount: 3,
    assignmentCount: 3,
    closureCount: 3,
    faultCaseCount: 2,
    faultControlId: faultReceipts[0].faultControlId,
    faultPlanId: faultReceipts[0].faultPlanId,
    faultControlPolicySha256: reference.faultControlPolicySha256,
    faultReceiptHashes: faultReceipts.map((receipt) =>
      canonicalContentHashV1(asJson(receipt)),
    ),
    productSha256: reference.manifest.productSha256,
    runnerSha256: reference.manifest.runnerSha256,
    validatorSha256: reference.manifest.validatorSha256,
    trustRootVersion: reference.manifest.trustRootVersion,
    trustRootFileSha256: reference.trustRootFileSha256,
    trustRootFreezeRecordSha256: reference.trustRootFreezeRecordSha256,
    trustRootExternalPinSha256: reference.trustRootExternalPinSha256,
    registrarServiceId: reference.service.serviceId,
    tlsSpkiId: reference.service.tlsSpkiSha256,
    artifactSinkId: reference.manifest.artifactSinkId,
    artifactSinkCommitment: reference.manifest.artifactSinkCommitment,
    caseIds: [
      "early_complete",
      "deadline_incomplete",
      "deadline_cleanup_unproven_with_late_cleanup",
    ],
    campaignIds: collectedCases.map(({ summary }) => summary.campaignId),
    assignmentIds: collectedCases.map(
      ({ summary }) => summary.assignmentIds[0],
    ),
    primaryOutcomes: collectedCases.map(({ primaryOutcome }) => primaryOutcome),
    evidenceHashes: collectedCases.map(({ evidence }) =>
      canonicalContentHashV1(asJson(evidence)),
    ),
    caseSummaries: collectedCases.map(({ summary }) => summary),
    eventCount: collectedCases.reduce(
      (sum, { summary }) => sum + summary.eventCount,
      0,
    ),
    appendAttemptCount: collectedCases.reduce(
      (sum, { summary }) => sum + summary.appendAttemptCount,
      0,
    ),
    rejectionCount: collectedCases.reduce(
      (sum, { summary }) => sum + summary.rejectionCount,
      0,
    ),
    idempotentReplayCount: collectedCases.reduce(
      (sum, { summary }) => sum + summary.idempotentReplayCount,
      0,
    ),
    revisionCount: collectedCases.reduce(
      (sum, { summary }) => sum + summary.revisionCount,
      0,
    ),
  });
  const suiteEvidence = E3CampaignConformanceSuiteEvidenceV1Schema.parse({
    schemaId: E3_CONFORMANCE_SUITE_EVIDENCE_SCHEMA_ID_V1,
    schemaVersion: 1,
    faultControlPolicySha256: reference.faultControlPolicySha256,
    cases: [
      { caseId: "early_complete", evidence: complete.evidence },
      {
        caseId: "deadline_incomplete",
        evidence: incomplete.collected.evidence,
      },
      {
        caseId: "deadline_cleanup_unproven_with_late_cleanup",
        evidence: cleanupUnproven.collected.evidence,
      },
    ],
    faultReceipts,
    summary: suiteSummary,
  });
  const persisted = await persistValidatedEvidence({
    evidenceDirectory: reference.evidenceDirectory,
    validatorPath: reference.validatorPath,
    evidence: asJson(suiteEvidence),
    validateEvidence:
      input.earlyComplete.validateEvidence ?? independentValidateEvidence,
    beforePublish: async (pendingPath, validatorPath) => {
      await assertPendingSuiteMutationsRejectedV1({
        pendingPath,
        validatorPath,
        assertEvidenceRejected:
          input.earlyComplete.assertEvidenceRejected ??
          independentAssertEvidenceRejected,
      });
    },
  });
  return {
    ...persisted,
    summary: suiteSummary,
    primaryOutcome: complete.primaryOutcome,
    cases: [completeCase, incomplete.result, cleanupUnproven.result],
  };
};

export const createLiveE3RegistrarPortV1 = (
  preflight: E3CampaignConformancePreflightV1,
  environment: NodeJS.ProcessEnv = process.env,
): E3RegistrarPortV1 =>
  new E3RegistrarClientV1(
    preflight.manifest.namespace,
    createPinnedHttpsTransportV1({
      service: preflight.service,
      environment,
    }),
    preflight.service,
  );

const createResponseLossObservedLiveE3RegistrarV1 = (
  preflight: E3CampaignConformancePreflightV1,
  environment: NodeJS.ProcessEnv = process.env,
): {
  readonly registrar: E3RegistrarPortV1;
  readonly assertResponseLossReplayObserved: (
    signedIdempotentReplayCount: number,
  ) => void;
} => {
  const observation = new E3ResponseLossObservationTransportV1(
    createPinnedHttpsTransportV1({
      service: preflight.service,
      environment,
    }),
  );
  return {
    registrar: new E3RegistrarClientV1(
      preflight.manifest.namespace,
      observation,
      preflight.service,
    ),
    assertResponseLossReplayObserved: (signedIdempotentReplayCount) =>
      observation.assertObservedAndBoundToClosure(signedIdempotentReplayCount),
  };
};

export const createRegistrarClosureEvidencePortV1 = (
  registrar: E3RegistrarPortV1,
  options: { readonly minimumRevisionCount?: 0 | 1 } = {},
): E3CampaignClosureEvidencePortV1 => ({
  awaitClosedEvidence: async ({ manifest, campaignId, assignmentId }) => {
    const minimumRevisionCount = options.minimumRevisionCount ?? 0;
    const stopAt = Date.parse(manifest.deadline) + PUBLICATION_GRACE_MS;
    for (;;) {
      const snapshot = await registrar.readClosedEvidence({ campaignId });
      if (
        snapshot !== null &&
        snapshot.revisions.length >= minimumRevisionCount
      ) {
        if (snapshot.assignmentId !== assignmentId) {
          return fail(
            "evidence_failed",
            "closed evidence snapshot belongs to another assignment",
          );
        }
        return {
          journal: snapshot.journal,
          appendReceipts: snapshot.appendReceipts,
          primaryClosure: snapshot.primaryClosure,
          revisions: snapshot.revisions,
          revisionReceipts: snapshot.revisionReceipts,
          revisionJournalCheckpoint: snapshot.revisionJournalCheckpoint,
          publicationProof: snapshot.publicationProof,
          rejectionCount: snapshot.rejectionCount,
        };
      }
      if (Date.now() >= stopAt) {
        return fail(
          "live_dependency_unavailable",
          "registrar did not publish a signed closed-evidence snapshot before the bounded publication grace expired",
        );
      }
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, CLOSED_EVIDENCE_POLL_MS);
      });
    }
  },
});

export const runPreparedE3CampaignLiveV1 = async (input: {
  readonly preflight: E3CampaignConformancePreflightV1;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly closureEvidence?: E3CampaignClosureEvidencePortV1 | undefined;
}): Promise<E3CampaignConformanceRunResultV1> => {
  if (input.closureEvidence === undefined) {
    return fail(
      "live_dependency_unavailable",
      "external Host cleanup-witness and append-receipt evidence port is not configured; refusing to register a campaign",
    );
  }
  const probed = createResponseLossObservedLiveE3RegistrarV1(
    input.preflight,
    input.environment,
  );
  return await runE3CampaignConformanceV1(input.preflight, {
    registrar: probed.registrar,
    closureEvidence: input.closureEvidence,
    assertResponseLossReplayObserved: probed.assertResponseLossReplayObserved,
  });
};

export const runE3CampaignLiveFromEnvironmentV1 = async (options?: {
  readonly preflight?: E3CampaignLivePreflightOptionsV1 | undefined;
  readonly faultControl?: E3CampaignConformanceFaultControlPortV1 | undefined;
  readonly closureEvidence?:
    | {
        readonly earlyComplete: E3CampaignClosureEvidencePortV1;
        readonly deadlineIncomplete: E3CampaignClosureEvidencePortV1;
        readonly deadlineCleanupUnproven: E3CampaignClosureEvidencePortV1;
      }
    | undefined;
}): Promise<E3CampaignConformanceSuiteResultV1> => {
  const liveMatrixStatus: string = E3_CONFORMANCE_LIVE_MATRIX_STATUS_V1;
  if (liveMatrixStatus !== "full_matrix_v1") {
    fail(
      "live_dependency_unavailable",
      "the frozen live fault matrix is not complete; refusing to run the prepared three-campaign suite as the E3.1 live Gate",
    );
  }
  const preflight = await preflightE3CampaignLiveSuiteV1(options?.preflight);
  const faultControl =
    options?.faultControl ??
    createInheritedE3CampaignConformanceFaultControlPortV1();
  const environment = options?.preflight?.environment;
  const complete = createResponseLossObservedLiveE3RegistrarV1(
    preflight.earlyComplete,
    environment,
  );
  const incomplete = createLiveE3RegistrarPortV1(
    preflight.deadlineIncomplete,
    environment,
  );
  const cleanupUnproven = createLiveE3RegistrarPortV1(
    preflight.deadlineCleanupUnproven,
    environment,
  );
  return await runPreparedE3CampaignLiveSuiteV1({
    faultControl,
    earlyComplete: {
      preflight: preflight.earlyComplete,
      registrar: complete.registrar,
      closureEvidence:
        options?.closureEvidence?.earlyComplete ??
        createRegistrarClosureEvidencePortV1(complete.registrar),
      assertResponseLossReplayObserved:
        complete.assertResponseLossReplayObserved,
    },
    deadlineIncomplete: {
      preflight: preflight.deadlineIncomplete,
      registrar: incomplete,
      closureEvidence:
        options?.closureEvidence?.deadlineIncomplete ??
        createRegistrarClosureEvidencePortV1(incomplete),
    },
    deadlineCleanupUnproven: {
      preflight: preflight.deadlineCleanupUnproven,
      registrar: cleanupUnproven,
      closureEvidence:
        options?.closureEvidence?.deadlineCleanupUnproven ??
        createRegistrarClosureEvidencePortV1(cleanupUnproven, {
          minimumRevisionCount: 1,
        }),
    },
  });
};
