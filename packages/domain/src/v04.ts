import { z } from "zod";

import {
  CapsuleIdSchema,
  CheckpointIdSchema,
  ClaimPolicyIdSchema,
  ComparisonIdSchema,
  EventIdSchema,
  EvidenceAccessReceiptIdSchema,
  ExecutionIdSchema,
  ExperimentReservationIdSchema,
  FixtureIdSchema,
  InputTraceIdSchema,
  InterventionIdSchema,
  InvestigationIdSchema,
  ProposalIdSchema,
  RunIdSchema,
  VerdictIdSchema,
  type CapsuleId,
  type CheckpointId,
  type ClaimPolicyId,
  type ComparisonId,
  type ContractId,
  type EventId,
  type EvidenceAccessReceiptId,
  type ExecutionId,
  type ExperimentReservationId,
  type FixtureId,
  type InputTraceId,
  type InterventionId,
  type InvestigationId,
  type ProposalId,
  type RunId,
  type VerdictId,
} from "./ids.js";
import {
  PropertyEqualsPredicateSchema,
  SignalPredicateSchema,
  type PropertyEqualsPredicate,
  type SignalPredicate,
} from "./invariant.js";
import { JsonObjectSchema, type JsonObject } from "./json.js";
import { ArtifactReferenceSchema, type ArtifactReference } from "./proposal.js";
import {
  EvidenceAccessKindV1Schema,
  SourceCoverageV1Schema,
  type EvidenceAccessKindV1,
  type SourceCoverageV1,
} from "./diagnostic-v3.js";

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

const claimPolicyIdentifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const claimPolicyVersionPattern = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/u;

export interface ClaimPolicyManifestEntryV1 {
  readonly policyId: ClaimPolicyId;
  readonly policyVersion: string;
  readonly mechanismId: string;
  readonly assertionSchemaId: string;
}

export const ClaimPolicyManifestEntryV1Schema: z.ZodType<ClaimPolicyManifestEntryV1> =
  z
    .object({
      policyId: ClaimPolicyIdSchema.refine((value) =>
        claimPolicyIdentifierPattern.test(value),
      ),
      policyVersion: z.string().regex(claimPolicyVersionPattern),
      mechanismId: z.string().regex(claimPolicyIdentifierPattern),
      assertionSchemaId: z
        .string()
        .min(1)
        .refine((value) => value.trim() === value),
    })
    .strict();

/**
 * Declared identity of the Claim Evidence Policy registry used by an
 * investigation. Entries are sorted so the manifest has one canonical byte
 * representation independent of adapter registration order.
 */
export interface ClaimPolicyManifestV1 {
  readonly schemaVersion: 1;
  readonly policies: readonly ClaimPolicyManifestEntryV1[];
  readonly manifestHash: Sha256Hex;
}

export const ClaimPolicyManifestV1Schema: z.ZodType<ClaimPolicyManifestV1> = z
  .object({
    schemaVersion: z.literal(1),
    policies: z.array(ClaimPolicyManifestEntryV1Schema),
    manifestHash: Sha256HexSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const policyIds = manifest.policies.map((entry) => entry.policyId);
    const mechanismIds = manifest.policies.map((entry) => entry.mechanismId);
    if (new Set(policyIds).size !== policyIds.length) {
      context.addIssue({
        code: "custom",
        message: "Claim policy manifest policy IDs must be unique",
        path: ["policies"],
      });
    }
    if (new Set(mechanismIds).size !== mechanismIds.length) {
      context.addIssue({
        code: "custom",
        message: "Claim policy manifest mechanism IDs must be unique",
        path: ["policies"],
      });
    }
    const sorted = [...policyIds].sort((left, right) =>
      left.localeCompare(right),
    );
    if (policyIds.some((policyId, index) => policyId !== sorted[index])) {
      context.addIssue({
        code: "custom",
        message: "Claim policy manifest entries must be sorted by policy ID",
        path: ["policies"],
      });
    }
  });

export type ClaimPolicyManifestV1Content = Omit<
  ClaimPolicyManifestV1,
  "manifestHash"
>;

export const claimPolicyManifestV1Content = (
  manifest: ClaimPolicyManifestV1,
): ClaimPolicyManifestV1Content => {
  const { manifestHash, ...content } = manifest;
  void manifestHash;
  return content;
};

/** A v0.4 Contract identity is the SHA-256 of FrozenContractBundleV3Content. */
export const ContentAddressedContractIdV3Schema = z
  .string()
  .regex(/^contract:v3:[a-f0-9]{64}$/u) as unknown as z.ZodType<ContractId>;

export interface ContractScopeV3 {
  readonly projectId: string;
  readonly scenePath: string;
  readonly fixtureId?: FixtureId | undefined;
  readonly entityBindings: Readonly<Record<string, string>>;
}

export const ContractScopeV3Schema: z.ZodType<ContractScopeV3> = z
  .object({
    projectId: z.string().min(1),
    scenePath: z.string().min(1),
    fixtureId: FixtureIdSchema.optional(),
    entityBindings: z.record(z.string(), z.string().min(1)),
  })
  .strict();

export interface ContractEvaluatorDescriptorV1 {
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly evaluatorHash: Sha256Hex;
}

export const ContractEvaluatorDescriptorV1Schema: z.ZodType<ContractEvaluatorDescriptorV1> =
  z
    .object({
      evaluatorId: z.string().min(1),
      evaluatorVersion: z.string().min(1),
      evaluatorHash: Sha256HexSchema,
    })
    .strict();

export interface FrozenContractBundleV3 {
  readonly schemaVersion: 3;
  readonly contractId: ContractId;
  readonly contractVersion: string;
  readonly scope: ContractScopeV3;
  readonly authority: {
    readonly status: "frozen";
    readonly authoredBy: string;
    readonly approvedBy: string;
    readonly approvedAt: string;
  };
  readonly evaluator: ContractEvaluatorDescriptorV1;
  readonly rule: {
    readonly trigger: SignalPredicate;
    readonly expectation: PropertyEqualsPredicate;
    readonly withinTicks: number;
    readonly inclusive: true;
  };
}

export const FrozenContractBundleV3Schema: z.ZodType<FrozenContractBundleV3> = z
  .object({
    schemaVersion: z.literal(3),
    contractId: ContentAddressedContractIdV3Schema,
    contractVersion: z.string().min(1),
    scope: ContractScopeV3Schema,
    authority: z
      .object({
        status: z.literal("frozen"),
        authoredBy: z.string().min(1),
        approvedBy: z.string().min(1),
        approvedAt: z.string().datetime(),
      })
      .strict(),
    evaluator: ContractEvaluatorDescriptorV1Schema,
    rule: z
      .object({
        trigger: SignalPredicateSchema,
        expectation: PropertyEqualsPredicateSchema,
        withinTicks: z.number().int().positive(),
        inclusive: z.literal(true),
      })
      .strict(),
  })
  .strict();

/** Exact canonical JSON input whose digest is embedded in contractId. */
export type FrozenContractBundleV3Content = Omit<
  FrozenContractBundleV3,
  "contractId"
>;

export const frozenContractBundleV3Content = (
  bundle: FrozenContractBundleV3,
): FrozenContractBundleV3Content => {
  const { contractId, ...content } = bundle;
  void contractId;
  return content;
};

export interface ExecutionFingerprintV2 {
  readonly schemaVersion: 2;
  readonly executionId: ExecutionId;
  readonly runId: RunId;
  readonly investigationId: InvestigationId;
  readonly source: {
    readonly repositoryId: string;
    readonly treeHash: Sha256Hex;
    readonly gitRevision: string | null;
    readonly dirtyPatchHash: Sha256Hex | null;
  };
  readonly build: {
    readonly gameBuildHash: Sha256Hex;
    readonly importCacheHash: Sha256Hex | null;
  };
  readonly runtime: {
    readonly engine: string;
    readonly engineVersion: string;
    readonly platform: string;
    readonly renderer: string;
    readonly physicsEngine: string;
    readonly adapterVersion: string;
    readonly protocolVersion: string;
    readonly pluginVersion: string;
    readonly configurationHash: Sha256Hex;
    readonly registeredRngDomains: readonly string[];
  };
  readonly contract: {
    readonly contractId: ContractId;
    readonly bundleHash: Sha256Hex;
  };
  readonly claimPolicyManifest: ClaimPolicyManifestV1;
  readonly checkpoint: {
    readonly checkpointId: CheckpointId;
    readonly descriptorHash: Sha256Hex;
    readonly restoreRecipeHash: Sha256Hex;
    readonly coverageHash: Sha256Hex;
  };
  readonly input: {
    readonly inputTraceId: InputTraceId;
    readonly traceHash: Sha256Hex;
    readonly inputMapHash: Sha256Hex;
  };
  readonly controls: {
    readonly requested: JsonObject;
    readonly realized: JsonObject;
  };
  readonly intervention: {
    readonly interventionId: InterventionId | null;
    readonly specification: JsonObject | null;
  };
  readonly probe: {
    readonly profileHash: Sha256Hex;
  };
  readonly telemetry: {
    readonly schemaVersion: number;
    readonly schemaHash: Sha256Hex;
  };
  readonly fingerprintHash: Sha256Hex;
  readonly comparisonBasisHash: Sha256Hex;
}

const executionFingerprintSourceSchema = z
  .object({
    repositoryId: z.string().min(1),
    treeHash: Sha256HexSchema,
    gitRevision: z.string().min(1).nullable(),
    dirtyPatchHash: Sha256HexSchema.nullable(),
  })
  .strict();

const executionFingerprintBuildSchema = z
  .object({
    gameBuildHash: Sha256HexSchema,
    importCacheHash: Sha256HexSchema.nullable(),
  })
  .strict();

const executionFingerprintRuntimeSchema = z
  .object({
    engine: z.string().min(1),
    engineVersion: z.string().min(1),
    platform: z.string().min(1),
    renderer: z.string().min(1),
    physicsEngine: z.string().min(1),
    adapterVersion: z.string().min(1),
    protocolVersion: z.string().min(1),
    pluginVersion: z.string().min(1),
    configurationHash: Sha256HexSchema,
    registeredRngDomains: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((runtime, context) => {
    if (
      new Set(runtime.registeredRngDomains).size !==
      runtime.registeredRngDomains.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Registered RNG domains must be unique",
        path: ["registeredRngDomains"],
      });
    }
  });

const executionFingerprintContractSchema = z
  .object({
    contractId: ContentAddressedContractIdV3Schema,
    bundleHash: Sha256HexSchema,
  })
  .strict();

const executionFingerprintCheckpointSchema = z
  .object({
    checkpointId: CheckpointIdSchema,
    descriptorHash: Sha256HexSchema,
    restoreRecipeHash: Sha256HexSchema,
    coverageHash: Sha256HexSchema,
  })
  .strict();

const executionFingerprintInputSchema = z
  .object({
    inputTraceId: InputTraceIdSchema,
    traceHash: Sha256HexSchema,
    inputMapHash: Sha256HexSchema,
  })
  .strict();

const executionFingerprintControlsSchema = z
  .object({
    requested: JsonObjectSchema,
    realized: JsonObjectSchema,
  })
  .strict();

const executionFingerprintInterventionSchema = z
  .object({
    interventionId: InterventionIdSchema.nullable(),
    specification: JsonObjectSchema.nullable(),
  })
  .strict()
  .superRefine((intervention, context) => {
    if (
      (intervention.interventionId === null) !==
      (intervention.specification === null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Intervention ID and specification must either both be null or both be present",
        path: ["interventionId"],
      });
    }
  });

export const ExecutionFingerprintV2Schema: z.ZodType<ExecutionFingerprintV2> = z
  .object({
    schemaVersion: z.literal(2),
    executionId: ExecutionIdSchema,
    runId: RunIdSchema,
    investigationId: InvestigationIdSchema,
    source: executionFingerprintSourceSchema,
    build: executionFingerprintBuildSchema,
    runtime: executionFingerprintRuntimeSchema,
    contract: executionFingerprintContractSchema,
    claimPolicyManifest: ClaimPolicyManifestV1Schema,
    checkpoint: executionFingerprintCheckpointSchema,
    input: executionFingerprintInputSchema,
    controls: executionFingerprintControlsSchema,
    intervention: executionFingerprintInterventionSchema,
    probe: z.object({ profileHash: Sha256HexSchema }).strict(),
    telemetry: z
      .object({
        schemaVersion: z.number().int().positive(),
        schemaHash: Sha256HexSchema,
      })
      .strict(),
    fingerprintHash: Sha256HexSchema,
    comparisonBasisHash: Sha256HexSchema,
  })
  .strict();

/** Exact canonical JSON input whose digest is fingerprintHash. */
export type ExecutionFingerprintV2Content = Omit<
  ExecutionFingerprintV2,
  "fingerprintHash" | "comparisonBasisHash"
>;

export const executionFingerprintV2Content = (
  fingerprint: ExecutionFingerprintV2,
): ExecutionFingerprintV2Content => {
  const { fingerprintHash, comparisonBasisHash, ...content } = fingerprint;
  void fingerprintHash;
  void comparisonBasisHash;
  return content;
};

/** Investigation-scoped successor to the fixture-scoped v0.3 receipt. */
export interface EvidenceAccessReceiptV2 {
  readonly schemaVersion: 2;
  readonly receiptId: EvidenceAccessReceiptId;
  readonly runId: RunId;
  readonly investigationId: InvestigationId;
  readonly accessKind: EvidenceAccessKindV1;
  readonly resourceId: string;
  readonly requestHash: Sha256Hex;
  readonly contentHash: Sha256Hex;
  readonly sourceCoverage: readonly SourceCoverageV1[];
  readonly issuedAt: string;
}

export const EvidenceAccessReceiptV2Schema: z.ZodType<EvidenceAccessReceiptV2> =
  z
    .object({
      schemaVersion: z.literal(2),
      receiptId: EvidenceAccessReceiptIdSchema,
      runId: RunIdSchema,
      investigationId: InvestigationIdSchema,
      accessKind: EvidenceAccessKindV1Schema,
      resourceId: z.string().min(1),
      requestHash: Sha256HexSchema,
      contentHash: Sha256HexSchema,
      sourceCoverage: z.array(SourceCoverageV1Schema),
      issuedAt: z.string().datetime(),
    })
    .strict()
    .superRefine((receipt, context) => {
      const isSource =
        receipt.accessKind === "source_read" ||
        receipt.accessKind === "source_search";
      if (!isSource && receipt.sourceCoverage.length > 0) {
        context.addIssue({
          code: "custom",
          message: "Only source accesses may carry source coverage receipts",
          path: ["sourceCoverage"],
        });
      }
    });

export interface MechanismAssertionV1 {
  readonly schemaId: string;
  readonly payload: JsonObject;
}

export const MechanismAssertionV1Schema: z.ZodType<MechanismAssertionV1> = z
  .object({
    schemaId: z.string().min(1),
    payload: JsonObjectSchema,
  })
  .strict();

export type DiagnosisClaimV4 =
  | {
      readonly kind: "mechanism";
      readonly mechanismId: string;
      readonly assertion: MechanismAssertionV1;
    }
  | {
      readonly kind: "unknown";
    };

export const DiagnosisClaimV4Schema: z.ZodType<DiagnosisClaimV4> =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("mechanism"),
        mechanismId: z.string().min(1),
        assertion: MechanismAssertionV1Schema,
      })
      .strict(),
    z.object({ kind: z.literal("unknown") }).strict(),
  ]);

export interface DiagnosisProposalV4 {
  readonly schemaVersion: 4;
  readonly proposalId: ProposalId;
  readonly runId: RunId;
  readonly investigationId: InvestigationId;
  readonly capsuleId: CapsuleId;
  readonly baselineExecutionId: ExecutionId;
  readonly replayExecutionId?: ExecutionId | undefined;
  readonly candidateExecutionIds: readonly ExecutionId[];
  readonly comparisonIds: readonly ComparisonId[];
  readonly accessReceiptIds: readonly EvidenceAccessReceiptId[];
  readonly claim: DiagnosisClaimV4;
  readonly summary: string;
  readonly evidenceEventIds: readonly EventId[];
  readonly suspectedSource?:
    { readonly path: string; readonly symbol?: string | undefined } | undefined;
  readonly blockers: readonly string[];
  readonly nextExperiment: string | null;
  /** Agent metadata only. A Conclusion Gate must never use this value. */
  readonly confidence: number;
}

const uniqueProposalReferenceFields = (
  proposal: DiagnosisProposalV4,
  context: z.RefinementCtx,
): void => {
  const uniqueFields: readonly [
    keyof Pick<
      DiagnosisProposalV4,
      | "candidateExecutionIds"
      | "comparisonIds"
      | "accessReceiptIds"
      | "evidenceEventIds"
    >,
    readonly string[],
  ][] = [
    ["candidateExecutionIds", proposal.candidateExecutionIds],
    ["comparisonIds", proposal.comparisonIds],
    ["accessReceiptIds", proposal.accessReceiptIds],
    ["evidenceEventIds", proposal.evidenceEventIds],
  ];
  for (const [field, values] of uniqueFields) {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        message: `${field} must contain unique references`,
        path: [field],
      });
    }
  }
};

export const DiagnosisProposalV4Schema: z.ZodType<DiagnosisProposalV4> = z
  .object({
    schemaVersion: z.literal(4),
    proposalId: ProposalIdSchema,
    runId: RunIdSchema,
    investigationId: InvestigationIdSchema,
    capsuleId: CapsuleIdSchema,
    baselineExecutionId: ExecutionIdSchema,
    replayExecutionId: ExecutionIdSchema.optional(),
    candidateExecutionIds: z.array(ExecutionIdSchema),
    comparisonIds: z.array(ComparisonIdSchema),
    accessReceiptIds: z.array(EvidenceAccessReceiptIdSchema),
    claim: DiagnosisClaimV4Schema,
    summary: z.string().min(1),
    evidenceEventIds: z.array(EventIdSchema),
    suspectedSource: z
      .object({
        path: z.string().min(1),
        symbol: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    blockers: z.array(z.string().min(1)),
    nextExperiment: z.string().min(1).nullable(),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict()
  .superRefine((proposal, context) => {
    uniqueProposalReferenceFields(proposal, context);
    if (proposal.claim.kind === "mechanism") {
      if (proposal.replayExecutionId === undefined) {
        context.addIssue({
          code: "custom",
          message: "A mechanism claim requires a replay execution",
          path: ["replayExecutionId"],
        });
      }
      if (proposal.candidateExecutionIds.length === 0) {
        context.addIssue({
          code: "custom",
          message: "A mechanism claim requires a candidate execution",
          path: ["candidateExecutionIds"],
        });
      }
      if (proposal.comparisonIds.length === 0) {
        context.addIssue({
          code: "custom",
          message: "A mechanism claim requires a canonical comparison",
          path: ["comparisonIds"],
        });
      }
    } else {
      if (proposal.blockers.length === 0) {
        context.addIssue({
          code: "custom",
          message: "An unknown claim requires at least one blocker",
          path: ["blockers"],
        });
      }
      if (proposal.nextExperiment === null) {
        context.addIssue({
          code: "custom",
          message: "An unknown claim requires a next experiment",
          path: ["nextExperiment"],
        });
      }
    }
  });

export type ArtifactReferenceV4 =
  | ArtifactReference
  | {
      readonly artifactKind: "fingerprint";
      readonly executionId: ExecutionId;
    }
  | {
      readonly artifactKind: "reservation";
      readonly reservationId: ExperimentReservationId;
    }
  | {
      readonly artifactKind: "receipt";
      readonly receiptId: EvidenceAccessReceiptId;
    };

export const ArtifactReferenceV4Schema: z.ZodType<ArtifactReferenceV4> =
  z.union([
    ArtifactReferenceSchema,
    z.discriminatedUnion("artifactKind", [
      z
        .object({
          artifactKind: z.literal("fingerprint"),
          executionId: ExecutionIdSchema,
        })
        .strict(),
      z
        .object({
          artifactKind: z.literal("reservation"),
          reservationId: ExperimentReservationIdSchema,
        })
        .strict(),
      z
        .object({
          artifactKind: z.literal("receipt"),
          receiptId: EvidenceAccessReceiptIdSchema,
        })
        .strict(),
    ]),
  ]);

interface DiagnosisVerdictV3Base {
  readonly schemaVersion: 3;
  readonly verdictId: VerdictId;
  readonly proposalId: ProposalId;
  readonly runId: RunId;
  readonly investigationId: InvestigationId;
  readonly summary: string;
  readonly validatedReferences: readonly ArtifactReferenceV4[];
}

export type DiagnosisVerdictV3 =
  | (DiagnosisVerdictV3Base & {
      readonly status: "confirmed";
      readonly claimLevel: "mechanism_supported";
      readonly mechanismId: string;
      readonly claimPolicyId: ClaimPolicyId;
      readonly blockers: readonly [];
      readonly nextExperiment: null;
    })
  | (DiagnosisVerdictV3Base & {
      readonly status: "inconclusive";
      readonly claimLevel: "none";
      readonly mechanismId: string | null;
      readonly claimPolicyId: ClaimPolicyId | null;
      readonly blockers: readonly string[];
      readonly nextExperiment: string;
    });

const diagnosisVerdictV3Base = {
  schemaVersion: z.literal(3),
  verdictId: VerdictIdSchema,
  proposalId: ProposalIdSchema,
  runId: RunIdSchema,
  investigationId: InvestigationIdSchema,
  summary: z.string().min(1),
  validatedReferences: z.array(ArtifactReferenceV4Schema),
};

export const DiagnosisVerdictV3Schema: z.ZodType<DiagnosisVerdictV3> =
  z.discriminatedUnion("status", [
    z
      .object({
        ...diagnosisVerdictV3Base,
        status: z.literal("confirmed"),
        claimLevel: z.literal("mechanism_supported"),
        mechanismId: z.string().min(1),
        claimPolicyId: ClaimPolicyIdSchema,
        blockers: z.tuple([]),
        nextExperiment: z.null(),
      })
      .strict(),
    z
      .object({
        ...diagnosisVerdictV3Base,
        status: z.literal("inconclusive"),
        claimLevel: z.literal("none"),
        mechanismId: z.string().min(1).nullable(),
        claimPolicyId: ClaimPolicyIdSchema.nullable(),
        blockers: z.array(z.string().min(1)).nonempty(),
        nextExperiment: z.string().min(1),
      })
      .strict(),
  ]);

interface ExperimentReservationV1Base {
  readonly schemaVersion: 1;
  readonly reservationId: ExperimentReservationId;
  readonly investigationId: InvestigationId;
  readonly runId: RunId;
  readonly reservedAt: string;
  readonly budget: {
    readonly scope: "investigation";
    readonly ordinal: number;
    readonly maxInterventions: number;
  };
}

export type ExperimentReservationV1 =
  | (ExperimentReservationV1Base & {
      readonly reservationKind: "baseline";
    })
  | (ExperimentReservationV1Base & {
      readonly reservationKind: "intervention";
      readonly interventionId: InterventionId;
    });

const experimentReservationV1Base = {
  schemaVersion: z.literal(1),
  reservationId: ExperimentReservationIdSchema,
  investigationId: InvestigationIdSchema,
  runId: RunIdSchema,
  reservedAt: z.string().datetime(),
  budget: z
    .object({
      scope: z.literal("investigation"),
      ordinal: z.number().int().nonnegative(),
      maxInterventions: z.number().int().nonnegative(),
    })
    .strict(),
};

export const ExperimentReservationV1Schema: z.ZodType<ExperimentReservationV1> =
  z
    .discriminatedUnion("reservationKind", [
      z
        .object({
          ...experimentReservationV1Base,
          reservationKind: z.literal("baseline"),
        })
        .strict(),
      z
        .object({
          ...experimentReservationV1Base,
          reservationKind: z.literal("intervention"),
          interventionId: InterventionIdSchema,
        })
        .strict(),
    ])
    .superRefine((reservation, context) => {
      if (
        reservation.reservationKind === "baseline" &&
        reservation.budget.ordinal !== 0
      ) {
        context.addIssue({
          code: "custom",
          message: "A baseline reservation has budget ordinal zero",
          path: ["budget", "ordinal"],
        });
      }
      if (
        reservation.reservationKind === "intervention" &&
        (reservation.budget.ordinal === 0 ||
          reservation.budget.ordinal > reservation.budget.maxInterventions)
      ) {
        context.addIssue({
          code: "custom",
          message: "Intervention reservation exceeds its investigation budget",
          path: ["budget", "ordinal"],
        });
      }
    });
