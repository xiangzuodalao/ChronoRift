import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  isAbsolute,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  JsonValueSchema,
  Sha256DigestV1Schema,
  SourceIdSchema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

import { publishPrivateFileOnceV1 } from "./private-atomic-publication.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RECORD_BYTE_LIMIT = 1024 * 1024;

const portfolioIdSchema = z.string().regex(/^m7-r3-portfolio:[a-f0-9]{24}$/u);
const portfolioCaseIdSchema = z.string().regex(/^m7-r3-case:[a-f0-9]{24}$/u);
const campaignIdSchema = z.string().regex(/^m7-campaign:[a-f0-9]{24}$/u);
const trajectoryCaseSpecIdSchema = z
  .string()
  .regex(/^m7-r3-trajectory-case:[a-f0-9]{24}$/u);
const gitRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/u);

const digest = (bytes: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const digestJson = (value: unknown): Sha256DigestV1 =>
  digest(canonicalJson(JsonValueSchema.parse(value)));

const addIssue = (
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void => {
  context.addIssue({ code: "custom", path: [...path], message });
};

const validateContentHash = (
  value: Readonly<Record<string, unknown>> & {
    readonly recordContentSha256: Sha256DigestV1;
  },
  context: z.RefinementCtx,
): void => {
  const { recordContentSha256, ...basis } = value;
  if (recordContentSha256 !== digestJson(basis)) {
    addIssue(
      context,
      ["recordContentSha256"],
      "record content hash does not match its canonical bytes",
    );
  }
};

const caseOrdinalSchema = z.union([z.literal(1), z.literal(2)]);

const subjectIdentitySchema = z
  .object({
    subjectProjectSha256: Sha256DigestV1Schema,
    pristineProjectRevision: gitRevisionSchema,
    pristineSelectedTreeSha256: Sha256DigestV1Schema,
  })
  .strict();

const mutantIdentitySchema = z
  .object({
    mutationSha256: Sha256DigestV1Schema,
    mutatedBuildSourceId: SourceIdSchema,
    mutatedBuildSourceSha256: Sha256DigestV1Schema,
    mutatedBaselineSelectedTreeSha256: Sha256DigestV1Schema,
    mutatedBuildSourceIdentitySha256: Sha256DigestV1Schema,
  })
  .strict();

const portfolioCaseIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    ordinal: caseOrdinalSchema,
    subject: subjectIdentitySchema,
    mutant: mutantIdentitySchema,
    /** SHA-256 of the exact natural-user prompt UTF-8 bytes. */
    naturalPromptUtf8Sha256: Sha256DigestV1Schema,
    trajectoryCaseSpecId: trajectoryCaseSpecIdSchema,
    trajectoryCaseSpecSha256: Sha256DigestV1Schema,
    adapterMutantCompatibilityReceiptSha256: Sha256DigestV1Schema,
    pairedPublicTaskContractSha256: Sha256DigestV1Schema,
    preflightImplementationSha256: Sha256DigestV1Schema,
    evaluatorImplementationSha256: Sha256DigestV1Schema,
    evaluatorBundleSha256: Sha256DigestV1Schema,
  })
  .strict();

const frozenPortfolioCaseSchema = portfolioCaseIdentitySchema
  .extend({ caseId: portfolioCaseIdSchema })
  .strict()
  .superRefine((value, context) => {
    const identity = portfolioCaseIdentitySchema.parse({
      schemaVersion: value.schemaVersion,
      ordinal: value.ordinal,
      subject: value.subject,
      mutant: value.mutant,
      naturalPromptUtf8Sha256: value.naturalPromptUtf8Sha256,
      trajectoryCaseSpecId: value.trajectoryCaseSpecId,
      trajectoryCaseSpecSha256: value.trajectoryCaseSpecSha256,
      adapterMutantCompatibilityReceiptSha256:
        value.adapterMutantCompatibilityReceiptSha256,
      pairedPublicTaskContractSha256: value.pairedPublicTaskContractSha256,
      preflightImplementationSha256: value.preflightImplementationSha256,
      evaluatorImplementationSha256: value.evaluatorImplementationSha256,
      evaluatorBundleSha256: value.evaluatorBundleSha256,
    });
    const expected = `m7-r3-case:${digestJson(identity).slice(0, 24)}`;
    if (value.caseId !== expected) {
      addIssue(
        context,
        ["caseId"],
        "case ID must derive from the frozen case identity and ordinal",
      );
    }
    if (
      value.trajectoryCaseSpecId !==
      `m7-r3-trajectory-case:${value.trajectoryCaseSpecSha256.slice(0, 24)}`
    ) {
      addIssue(
        context,
        ["trajectoryCaseSpecId"],
        "trajectory case-spec ID must derive from its frozen content hash",
      );
    }
    const expectedMutantSourceIdentity = digestJson({
      schemaVersion: 1,
      sourceId: value.mutant.mutatedBuildSourceId,
      sourceHash: value.mutant.mutatedBuildSourceSha256,
    });
    if (
      value.mutant.mutatedBuildSourceIdentitySha256 !==
      expectedMutantSourceIdentity
    ) {
      addIssue(
        context,
        ["mutant", "mutatedBuildSourceIdentitySha256"],
        "mutant Build source identity must derive from its source ID and source hash",
      );
    }
    if (
      value.subject.pristineSelectedTreeSha256 ===
      value.mutant.mutatedBaselineSelectedTreeSha256
    ) {
      addIssue(
        context,
        ["mutant", "mutatedBaselineSelectedTreeSha256"],
        "mutant and pristine selected-tree identities must differ",
      );
    }
  });

const frozenCasesSchema = z
  .tuple([frozenPortfolioCaseSchema, frozenPortfolioCaseSchema])
  .superRefine((cases, context) => {
    if (cases[0].ordinal !== 1 || cases[1].ordinal !== 2) {
      addIssue(
        context,
        ["cases"],
        "the two cases must remain in frozen ordinal order 1 then 2",
      );
    }
    for (const [field, left, right] of [
      ["caseId", cases[0].caseId, cases[1].caseId],
      [
        "mutationSha256",
        cases[0].mutant.mutationSha256,
        cases[1].mutant.mutationSha256,
      ],
      [
        "mutatedBuildSourceId",
        cases[0].mutant.mutatedBuildSourceId,
        cases[1].mutant.mutatedBuildSourceId,
      ],
      [
        "mutatedBaselineSelectedTreeSha256",
        cases[0].mutant.mutatedBaselineSelectedTreeSha256,
        cases[1].mutant.mutatedBaselineSelectedTreeSha256,
      ],
      [
        "naturalPromptUtf8Sha256",
        cases[0].naturalPromptUtf8Sha256,
        cases[1].naturalPromptUtf8Sha256,
      ],
      [
        "trajectoryCaseSpecId",
        cases[0].trajectoryCaseSpecId,
        cases[1].trajectoryCaseSpecId,
      ],
      [
        "trajectoryCaseSpecSha256",
        cases[0].trajectoryCaseSpecSha256,
        cases[1].trajectoryCaseSpecSha256,
      ],
      [
        "adapterMutantCompatibilityReceiptSha256",
        cases[0].adapterMutantCompatibilityReceiptSha256,
        cases[1].adapterMutantCompatibilityReceiptSha256,
      ],
      [
        "pairedPublicTaskContractSha256",
        cases[0].pairedPublicTaskContractSha256,
        cases[1].pairedPublicTaskContractSha256,
      ],
    ] as const) {
      if (left === right) {
        addIssue(
          context,
          ["cases", 1, field],
          `the two frozen cases must have distinct ${field} identities`,
        );
      }
    }
  });

const commonRuntimeMaterialsSchema = z
  .object({
    authoritativeSensorFreezeRecordSha256: Sha256DigestV1Schema,
    adapterRevisionSha256: Sha256DigestV1Schema,
    adapterPackageSha256: Sha256DigestV1Schema,
    adapterObservationSchemaSha256: Sha256DigestV1Schema,
    trajectoryClassifierFreezeRecordSha256: Sha256DigestV1Schema,
    trajectoryClassifierImplementationSha256: Sha256DigestV1Schema,
    trajectoryClassifierConfigSha256: Sha256DigestV1Schema,
    validatedGameToolSetSha256: Sha256DigestV1Schema,
    pristineAdapterConformanceReceiptSha256: Sha256DigestV1Schema,
    commonEnvironmentInstructionsSha256: Sha256DigestV1Schema,
    hostModelRuntimeConfigSha256: Sha256DigestV1Schema,
  })
  .strict();

const agentConfigurationSchema = z
  .object({
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    thinkingLevel: z.enum([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
    agentBudgetSha256: Sha256DigestV1Schema,
    codingToolSetSha256: Sha256DigestV1Schema,
    sandboxPolicySha256: Sha256DigestV1Schema,
  })
  .strict();

const pairedAttemptPlanSchema = z
  .object({
    armOrder: z.tuple([z.literal("runtime_enabled"), z.literal("code_only")]),
    attemptsPerArm: z.literal(1),
    retriesAllowed: z.literal(false),
    userTurnsPerArm: z.literal(1),
  })
  .strict();

const evaluationPlanSchema = z
  .object({
    scenarioClassOrder: z.tuple([
      z.literal("public_reproduction"),
      z.literal("hidden_variant"),
      z.literal("regression_control"),
    ]),
    repetitionsPerScenarioClass: z.literal(3),
    expectedFreshCopyRunCount: z.literal(9),
    freshCopyPerRun: z.literal(true),
  })
  .strict();

const portfolioFreezeIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    cases: frozenCasesSchema,
    commonRuntimeMaterials: commonRuntimeMaterialsSchema,
    agentConfiguration: agentConfigurationSchema,
    pairedAttemptPlan: pairedAttemptPlanSchema,
    evaluationPlan: evaluationPlanSchema,
  })
  .strict();

const portfolioFreezeBaseSchema = portfolioFreezeIdentitySchema.extend({
  recordKind: z.literal("m7-r3-two-case-portfolio-freeze"),
  portfolioId: portfolioIdSchema,
  frozenBeforeAnyAgent: z.literal(true),
  frozenAt: z.string().datetime(),
  recordContentSha256: Sha256DigestV1Schema,
});

export const M7R3TwoCasePortfolioFreezeV1Schema = portfolioFreezeBaseSchema
  .strict()
  .superRefine((value, context) => {
    const identity = portfolioFreezeIdentitySchema.parse({
      schemaVersion: value.schemaVersion,
      cases: value.cases,
      commonRuntimeMaterials: value.commonRuntimeMaterials,
      agentConfiguration: value.agentConfiguration,
      pairedAttemptPlan: value.pairedAttemptPlan,
      evaluationPlan: value.evaluationPlan,
    });
    const expected = `m7-r3-portfolio:${digestJson(identity).slice(0, 24)}`;
    if (value.portfolioId !== expected) {
      addIssue(
        context,
        ["portfolioId"],
        "portfolio ID must derive from the complete frozen two-case design",
      );
    }
    validateContentHash(value, context);
  });
export type M7R3TwoCasePortfolioFreezeV1 = z.infer<
  typeof M7R3TwoCasePortfolioFreezeV1Schema
>;

const portfolioCaseInputSchema = portfolioCaseIdentitySchema.omit({
  schemaVersion: true,
  ordinal: true,
});

const createPortfolioFreezeInputSchema = z
  .object({
    commonRuntimeMaterials: commonRuntimeMaterialsSchema,
    agentConfiguration: agentConfigurationSchema,
    pairedAttemptPlan: pairedAttemptPlanSchema,
    evaluationPlan: evaluationPlanSchema,
    cases: z.tuple([portfolioCaseInputSchema, portfolioCaseInputSchema]),
    frozenAt: z.string().datetime(),
  })
  .strict();
export type CreateM7R3TwoCasePortfolioFreezeV1Input = z.input<
  typeof createPortfolioFreezeInputSchema
>;

export const createM7R3TwoCasePortfolioFreezeV1 = (
  input: CreateM7R3TwoCasePortfolioFreezeV1Input,
): M7R3TwoCasePortfolioFreezeV1 => {
  const parsed = createPortfolioFreezeInputSchema.parse(input);
  const cases = parsed.cases.map((caseInput, index) => {
    const identity = portfolioCaseIdentitySchema.parse({
      schemaVersion: 1,
      ordinal: index + 1,
      ...caseInput,
    });
    return frozenPortfolioCaseSchema.parse({
      ...identity,
      caseId: `m7-r3-case:${digestJson(identity).slice(0, 24)}`,
    });
  }) as unknown as z.infer<typeof frozenCasesSchema>;
  const identity = portfolioFreezeIdentitySchema.parse({
    schemaVersion: 1,
    cases,
    commonRuntimeMaterials: parsed.commonRuntimeMaterials,
    agentConfiguration: parsed.agentConfiguration,
    pairedAttemptPlan: parsed.pairedAttemptPlan,
    evaluationPlan: parsed.evaluationPlan,
  });
  const basis = {
    ...identity,
    recordKind: "m7-r3-two-case-portfolio-freeze" as const,
    portfolioId: `m7-r3-portfolio:${digestJson(identity).slice(0, 24)}`,
    frozenBeforeAnyAgent: true as const,
    frozenAt: parsed.frozenAt,
  };
  return M7R3TwoCasePortfolioFreezeV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

const caseReferenceCommonSchema = z.object({
  schemaVersion: z.literal(1),
  recordKind: z.literal("m7-r3-portfolio-case-reference"),
  portfolioId: portfolioIdSchema,
  portfolioFreezeRecordSha256: Sha256DigestV1Schema,
  caseOrdinal: caseOrdinalSchema,
  caseId: portfolioCaseIdSchema,
  recordedAt: z.string().datetime(),
});

const nullCampaignReferences = {
  campaignInfrastructureReceiptSha256: z.null(),
  campaignId: z.null(),
  caseCampaignAdmissionRecordSha256: z.null(),
  mutationRegistrationRecordSha256: z.null(),
  campaignTerminalRecordSha256: z.null(),
  runtimeEnabledResultRecordSha256: z.null(),
  codeOnlyResultRecordSha256: z.null(),
  agentDeliveryTraceRecordSha256: z.null(),
  trajectoryUseEvidenceRecordSha256: z.null(),
} as const;

const nullStageReceipts = {
  constructionReceiptSha256: z.null(),
  preflightReceiptSha256: z.null(),
} as const;

const constructionFailureReferenceBasisSchema = caseReferenceCommonSchema
  .extend({
    disposition: z.literal("construction_failed"),
    constructionReceiptSha256: Sha256DigestV1Schema,
    preflightReceiptSha256: z.null(),
    ...nullCampaignReferences,
  })
  .strict();
const preflightFailureReferenceBasisSchema = caseReferenceCommonSchema
  .extend({
    disposition: z.literal("preflight_failed"),
    constructionReceiptSha256: z.null(),
    preflightReceiptSha256: Sha256DigestV1Schema,
    ...nullCampaignReferences,
  })
  .strict();
const campaignTerminalReferenceBasisSchema = caseReferenceCommonSchema
  .extend({
    disposition: z.literal("campaign_terminal"),
    ...nullStageReceipts,
    campaignInfrastructureReceiptSha256: z.null(),
    campaignId: campaignIdSchema,
    caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
    mutationRegistrationRecordSha256: Sha256DigestV1Schema,
    campaignTerminalRecordSha256: Sha256DigestV1Schema,
    runtimeEnabledResultRecordSha256: Sha256DigestV1Schema.nullable(),
    codeOnlyResultRecordSha256: Sha256DigestV1Schema.nullable(),
    agentDeliveryTraceRecordSha256: Sha256DigestV1Schema,
    trajectoryUseEvidenceRecordSha256: Sha256DigestV1Schema,
  })
  .strict();
const campaignInfrastructureFailureReferenceBasisSchema =
  caseReferenceCommonSchema
    .extend({
      disposition: z.literal("campaign_infrastructure_failure"),
      ...nullStageReceipts,
      campaignInfrastructureReceiptSha256: Sha256DigestV1Schema,
      campaignId: campaignIdSchema.nullable(),
      caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema.nullable(),
      mutationRegistrationRecordSha256: Sha256DigestV1Schema.nullable(),
      campaignTerminalRecordSha256: z.null(),
      runtimeEnabledResultRecordSha256: z.null(),
      codeOnlyResultRecordSha256: z.null(),
      agentDeliveryTraceRecordSha256: z.null(),
      trajectoryUseEvidenceRecordSha256: z.null(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.campaignId === null &&
        (value.caseCampaignAdmissionRecordSha256 !== null ||
          value.mutationRegistrationRecordSha256 !== null)
      ) {
        addIssue(
          context,
          ["campaignId"],
          "campaign identity is required before admission or mutation-registration references",
        );
      }
    });
const safetyStopReferenceBasisSchema = caseReferenceCommonSchema
  .extend({
    disposition: z.literal("not_started_safety_stop"),
    ...nullStageReceipts,
    ...nullCampaignReferences,
  })
  .strict();

const caseReferenceBasisSchema = z.discriminatedUnion("disposition", [
  constructionFailureReferenceBasisSchema,
  preflightFailureReferenceBasisSchema,
  campaignTerminalReferenceBasisSchema,
  campaignInfrastructureFailureReferenceBasisSchema,
  safetyStopReferenceBasisSchema,
]);

/**
 * A denominator entry, not a copied campaign result. Successful construction
 * refers only to the immutable content hashes owned by the existing M7
 * campaign store. Pre-Agent construction/preflight failure instead binds its
 * own create-once stage receipt; an explicit safety stop has neither kind.
 */
export const M7R3PortfolioCaseReferenceV1Schema = z
  .discriminatedUnion("disposition", [
    constructionFailureReferenceBasisSchema.extend({
      recordContentSha256: Sha256DigestV1Schema,
    }),
    preflightFailureReferenceBasisSchema.extend({
      recordContentSha256: Sha256DigestV1Schema,
    }),
    campaignTerminalReferenceBasisSchema.extend({
      recordContentSha256: Sha256DigestV1Schema,
    }),
    campaignInfrastructureFailureReferenceBasisSchema.extend({
      recordContentSha256: Sha256DigestV1Schema,
    }),
    safetyStopReferenceBasisSchema.extend({
      recordContentSha256: Sha256DigestV1Schema,
    }),
  ])
  .superRefine((value, context) => validateContentHash(value, context));
export type M7R3PortfolioCaseReferenceV1 = z.infer<
  typeof M7R3PortfolioCaseReferenceV1Schema
>;

const recordCaseInputSchema = z.discriminatedUnion("disposition", [
  z
    .object({
      portfolioId: portfolioIdSchema,
      portfolioFreezeRecordSha256: Sha256DigestV1Schema,
      caseOrdinal: caseOrdinalSchema,
      caseId: portfolioCaseIdSchema,
      disposition: z.literal("construction_failed"),
      constructionReceiptSha256: Sha256DigestV1Schema,
      preflightReceiptSha256: z.null(),
      ...nullCampaignReferences,
      recordedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      portfolioId: portfolioIdSchema,
      portfolioFreezeRecordSha256: Sha256DigestV1Schema,
      caseOrdinal: caseOrdinalSchema,
      caseId: portfolioCaseIdSchema,
      disposition: z.literal("campaign_infrastructure_failure"),
      ...nullStageReceipts,
      campaignInfrastructureReceiptSha256: Sha256DigestV1Schema,
      campaignId: campaignIdSchema.nullable(),
      caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema.nullable(),
      mutationRegistrationRecordSha256: Sha256DigestV1Schema.nullable(),
      campaignTerminalRecordSha256: z.null(),
      runtimeEnabledResultRecordSha256: z.null(),
      codeOnlyResultRecordSha256: z.null(),
      agentDeliveryTraceRecordSha256: z.null(),
      trajectoryUseEvidenceRecordSha256: z.null(),
      recordedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      portfolioId: portfolioIdSchema,
      portfolioFreezeRecordSha256: Sha256DigestV1Schema,
      caseOrdinal: caseOrdinalSchema,
      caseId: portfolioCaseIdSchema,
      disposition: z.literal("preflight_failed"),
      constructionReceiptSha256: z.null(),
      preflightReceiptSha256: Sha256DigestV1Schema,
      ...nullCampaignReferences,
      recordedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      portfolioId: portfolioIdSchema,
      portfolioFreezeRecordSha256: Sha256DigestV1Schema,
      caseOrdinal: caseOrdinalSchema,
      caseId: portfolioCaseIdSchema,
      disposition: z.literal("campaign_terminal"),
      ...nullStageReceipts,
      campaignInfrastructureReceiptSha256: z.null(),
      campaignId: campaignIdSchema,
      caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
      mutationRegistrationRecordSha256: Sha256DigestV1Schema,
      campaignTerminalRecordSha256: Sha256DigestV1Schema,
      runtimeEnabledResultRecordSha256: Sha256DigestV1Schema.nullable(),
      codeOnlyResultRecordSha256: Sha256DigestV1Schema.nullable(),
      agentDeliveryTraceRecordSha256: Sha256DigestV1Schema,
      trajectoryUseEvidenceRecordSha256: Sha256DigestV1Schema,
      recordedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      portfolioId: portfolioIdSchema,
      portfolioFreezeRecordSha256: Sha256DigestV1Schema,
      caseOrdinal: caseOrdinalSchema,
      caseId: portfolioCaseIdSchema,
      disposition: z.literal("not_started_safety_stop"),
      ...nullStageReceipts,
      ...nullCampaignReferences,
      recordedAt: z.string().datetime(),
    })
    .strict(),
]);
export type RecordM7R3PortfolioCaseOnceV1Input = z.input<
  typeof recordCaseInputSchema
>;

const createCaseReference = (
  input: RecordM7R3PortfolioCaseOnceV1Input,
): M7R3PortfolioCaseReferenceV1 => {
  const basis = caseReferenceBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-portfolio-case-reference",
    ...recordCaseInputSchema.parse(input),
  });
  return M7R3PortfolioCaseReferenceV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

const summaryCaseCommonSchema = z.object({
  caseOrdinal: caseOrdinalSchema,
  caseId: portfolioCaseIdSchema,
  caseReferenceRecordSha256: Sha256DigestV1Schema,
});

const summaryCaseSchema = z.discriminatedUnion("disposition", [
  summaryCaseCommonSchema
    .extend({
      disposition: z.literal("construction_failed"),
      constructionReceiptSha256: Sha256DigestV1Schema,
      preflightReceiptSha256: z.null(),
      ...nullCampaignReferences,
    })
    .strict(),
  summaryCaseCommonSchema
    .extend({
      disposition: z.literal("preflight_failed"),
      constructionReceiptSha256: z.null(),
      preflightReceiptSha256: Sha256DigestV1Schema,
      ...nullCampaignReferences,
    })
    .strict(),
  summaryCaseCommonSchema
    .extend({
      disposition: z.literal("campaign_terminal"),
      ...nullStageReceipts,
      campaignInfrastructureReceiptSha256: z.null(),
      campaignId: campaignIdSchema,
      caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
      mutationRegistrationRecordSha256: Sha256DigestV1Schema,
      campaignTerminalRecordSha256: Sha256DigestV1Schema,
      runtimeEnabledResultRecordSha256: Sha256DigestV1Schema.nullable(),
      codeOnlyResultRecordSha256: Sha256DigestV1Schema.nullable(),
      agentDeliveryTraceRecordSha256: Sha256DigestV1Schema,
      trajectoryUseEvidenceRecordSha256: Sha256DigestV1Schema,
    })
    .strict(),
  summaryCaseCommonSchema
    .extend({
      disposition: z.literal("campaign_infrastructure_failure"),
      ...nullStageReceipts,
      campaignInfrastructureReceiptSha256: Sha256DigestV1Schema,
      campaignId: campaignIdSchema.nullable(),
      caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema.nullable(),
      mutationRegistrationRecordSha256: Sha256DigestV1Schema.nullable(),
      campaignTerminalRecordSha256: z.null(),
      runtimeEnabledResultRecordSha256: z.null(),
      codeOnlyResultRecordSha256: z.null(),
      agentDeliveryTraceRecordSha256: z.null(),
      trajectoryUseEvidenceRecordSha256: z.null(),
    })
    .strict(),
  summaryCaseCommonSchema
    .extend({
      disposition: z.literal("not_started_safety_stop"),
      ...nullStageReceipts,
      ...nullCampaignReferences,
    })
    .strict(),
]);

const summaryBaseSchema = z.object({
  schemaVersion: z.literal(1),
  recordKind: z.literal("m7-r3-two-case-portfolio-summary"),
  portfolioId: portfolioIdSchema,
  portfolioFreezeRecordSha256: Sha256DigestV1Schema,
  denominatorCaseCount: z.literal(2),
  recordedCaseCount: z.literal(2),
  cases: z.tuple([summaryCaseSchema, summaryCaseSchema]),
  summarizedAt: z.string().datetime(),
  recordContentSha256: Sha256DigestV1Schema,
});

/** A reference index only; it intentionally derives no comparative verdict. */
export const M7R3TwoCasePortfolioSummaryV1Schema = summaryBaseSchema
  .strict()
  .superRefine((value, context) => {
    if (value.cases[0].caseOrdinal !== 1 || value.cases[1].caseOrdinal !== 2) {
      addIssue(
        context,
        ["cases"],
        "summary must preserve the frozen two-case order",
      );
    }
    value.cases.forEach((caseReference, index) => {
      if (
        caseReference.disposition === "campaign_infrastructure_failure" &&
        caseReference.campaignId === null &&
        (caseReference.caseCampaignAdmissionRecordSha256 !== null ||
          caseReference.mutationRegistrationRecordSha256 !== null)
      ) {
        addIssue(
          context,
          ["cases", index, "campaignId"],
          "campaign identity is required before admission or mutation-registration references",
        );
      }
    });
    validateContentHash(value, context);
  });
export type M7R3TwoCasePortfolioSummaryV1 = z.infer<
  typeof M7R3TwoCasePortfolioSummaryV1Schema
>;

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const requireEffectiveUserId = (): number => {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw new Error("M7 R3 portfolio store requires effective-user checks");
  }
  return uid;
};

const pathWithinOrEqual = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
};

const canonicalDirectory = async (inputPath: string, label: string) => {
  const absolute = resolve(inputPath);
  if (absolute === parsePath(absolute).root) {
    throw new Error(`${label} must not be a filesystem root`);
  }
  const metadata = await lstat(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  const canonical = await realpath(absolute);
  if (canonical !== absolute) {
    throw new Error(`${label} must be canonical with no symlink component`);
  }
  return { canonical, metadata };
};

interface PrivateRootIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
}

type PortfolioRecordKind = "freeze" | "case-1" | "case-2" | "summary";

const portfolioRecordName = (kind: PortfolioRecordKind): string => {
  switch (kind) {
    case "freeze":
      return "m7-r3.portfolio-freeze.json";
    case "case-1":
      return "m7-r3.case-01-reference.json";
    case "case-2":
      return "m7-r3.case-02-reference.json";
    case "summary":
      return "m7-r3.portfolio-summary.json";
  }
};

const kindForCase = (ordinal: 1 | 2): PortfolioRecordKind =>
  ordinal === 1 ? "case-1" : "case-2";

export class M7R3TwoCasePortfolioStoreV1 {
  readonly #root: string;
  readonly #identity: PrivateRootIdentity;

  private constructor(root: string, identity: PrivateRootIdentity) {
    this.#root = root;
    this.#identity = identity;
  }

  public static async open(input: {
    readonly root: string;
    readonly exposedRoots: readonly string[];
  }): Promise<M7R3TwoCasePortfolioStoreV1> {
    const { canonical: root, metadata } = await canonicalDirectory(
      input.root,
      "M7 R3 Host-only portfolio root",
    );
    if (
      metadata.uid !== requireEffectiveUserId() ||
      (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw new Error(
        "M7 R3 Host-only portfolio root must be owned by the current user with mode 0700",
      );
    }
    for (const [index, exposedRoot] of input.exposedRoots.entries()) {
      const { canonical: exposed } = await canonicalDirectory(
        exposedRoot,
        `M7 R3 exposed root ${index + 1}`,
      );
      if (
        pathWithinOrEqual(root, exposed) ||
        pathWithinOrEqual(exposed, root)
      ) {
        throw new Error(
          "M7 R3 Host-only portfolio root must be disjoint from Agent-exposed roots",
        );
      }
    }
    return new M7R3TwoCasePortfolioStoreV1(root, {
      dev: metadata.dev,
      ino: metadata.ino,
      uid: metadata.uid,
      mode: metadata.mode,
    });
  }

  public get root(): string {
    return this.#root;
  }

  async #requireRoot(): Promise<void> {
    const metadata = await lstat(this.#root);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== this.#identity.dev ||
      metadata.ino !== this.#identity.ino ||
      metadata.uid !== this.#identity.uid ||
      metadata.mode !== this.#identity.mode ||
      (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE ||
      (await realpath(this.#root)) !== this.#root
    ) {
      throw new Error("M7 R3 Host-only portfolio root identity changed");
    }
  }

  #path(kind: PortfolioRecordKind): string {
    return resolve(this.#root, portfolioRecordName(kind));
  }

  async #writeOnce(kind: PortfolioRecordKind, value: unknown): Promise<void> {
    await this.#requireRoot();
    const bytes = Buffer.from(
      `${canonicalJson(JsonValueSchema.parse(value))}\n`,
      "utf8",
    );
    if (bytes.byteLength > RECORD_BYTE_LIMIT) {
      throw new Error("M7 R3 portfolio record exceeds its byte limit");
    }
    try {
      await publishPrivateFileOnceV1({
        root: this.#root,
        filename: portfolioRecordName(kind),
        bytes,
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(
          `M7 R3 ${kind} already exists; overwrite, retry, and reroll are forbidden`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #read<T>(
    kind: PortfolioRecordKind,
    parse: (value: unknown) => T,
  ): Promise<T> {
    await this.#requireRoot();
    const path = this.#path(kind);
    if (!pathWithinOrEqual(this.#root, path)) {
      throw new Error("M7 R3 portfolio record escaped its root");
    }
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.uid !== requireEffectiveUserId() ||
      (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
      metadata.size > RECORD_BYTE_LIMIT ||
      (await realpath(path)) !== path
    ) {
      throw new Error(
        "M7 R3 portfolio record must remain a canonical one-link owned mode-0600 regular file",
      );
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (
        opened.dev !== metadata.dev ||
        opened.ino !== metadata.ino ||
        opened.nlink !== 1 ||
        opened.size > RECORD_BYTE_LIMIT
      ) {
        throw new Error(
          "M7 R3 portfolio record identity changed while opening",
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await handle.readFile(),
          ),
        );
      } catch (error) {
        throw new Error("M7 R3 portfolio record is not valid UTF-8 JSON", {
          cause: error,
        });
      }
      const afterRead = await handle.stat();
      if (
        afterRead.dev !== opened.dev ||
        afterRead.ino !== opened.ino ||
        afterRead.nlink !== 1 ||
        afterRead.size !== opened.size
      ) {
        throw new Error("M7 R3 portfolio record changed while reading");
      }
      return parse(value);
    } finally {
      await handle.close();
    }
  }

  public async createPortfolioOnce(
    input: CreateM7R3TwoCasePortfolioFreezeV1Input,
  ): Promise<M7R3TwoCasePortfolioFreezeV1> {
    const freeze = createM7R3TwoCasePortfolioFreezeV1(input);
    await this.#writeOnce("freeze", freeze);
    return freeze;
  }

  public readPortfolio(): Promise<M7R3TwoCasePortfolioFreezeV1> {
    return this.#read("freeze", (value) =>
      M7R3TwoCasePortfolioFreezeV1Schema.parse(value),
    );
  }

  public async recordCaseOnce(
    input: RecordM7R3PortfolioCaseOnceV1Input,
  ): Promise<M7R3PortfolioCaseReferenceV1> {
    const parsed = recordCaseInputSchema.parse(input);
    const freeze = await this.readPortfolio();
    const frozenCase = freeze.cases[parsed.caseOrdinal - 1]!;
    if (
      parsed.portfolioId !== freeze.portfolioId ||
      parsed.portfolioFreezeRecordSha256 !== freeze.recordContentSha256 ||
      parsed.caseId !== frozenCase.caseId
    ) {
      throw new Error(
        "M7 R3 case reference crossed its frozen portfolio or case identity",
      );
    }
    if (parsed.caseOrdinal === 2) {
      try {
        await this.readCaseReference(1);
      } catch (error) {
        throw new Error(
          "M7 R3 case 2 cannot be recorded before case 1; frozen order is mandatory",
          { cause: error },
        );
      }
    } else if (parsed.disposition === "not_started_safety_stop") {
      throw new Error(
        "M7 R3 not_started_safety_stop is only valid for the later case",
      );
    }
    const record = createCaseReference(parsed);
    await this.#writeOnce(kindForCase(parsed.caseOrdinal), record);
    return record;
  }

  public async readCaseReference(
    ordinal: 1 | 2,
  ): Promise<M7R3PortfolioCaseReferenceV1> {
    const record = await this.#read(kindForCase(ordinal), (value) =>
      M7R3PortfolioCaseReferenceV1Schema.parse(value),
    );
    const freeze = await this.readPortfolio();
    const frozenCase = freeze.cases[ordinal - 1]!;
    if (
      record.portfolioId !== freeze.portfolioId ||
      record.portfolioFreezeRecordSha256 !== freeze.recordContentSha256 ||
      record.caseOrdinal !== ordinal ||
      record.caseId !== frozenCase.caseId
    ) {
      throw new Error(
        "M7 R3 case reference crossed its frozen portfolio or case identity",
      );
    }
    return record;
  }

  public async finalizeSummaryOnce(
    summarizedAt: string,
  ): Promise<M7R3TwoCasePortfolioSummaryV1> {
    const [freeze, caseOne, caseTwo] = await Promise.all([
      this.readPortfolio(),
      this.readCaseReference(1),
      this.readCaseReference(2),
    ]);
    const cases = [caseOne, caseTwo].map((record) => ({
      caseOrdinal: record.caseOrdinal,
      caseId: record.caseId,
      disposition: record.disposition,
      caseReferenceRecordSha256: record.recordContentSha256,
      constructionReceiptSha256: record.constructionReceiptSha256,
      preflightReceiptSha256: record.preflightReceiptSha256,
      campaignInfrastructureReceiptSha256:
        record.campaignInfrastructureReceiptSha256,
      campaignId: record.campaignId,
      caseCampaignAdmissionRecordSha256:
        record.caseCampaignAdmissionRecordSha256,
      mutationRegistrationRecordSha256: record.mutationRegistrationRecordSha256,
      campaignTerminalRecordSha256: record.campaignTerminalRecordSha256,
      runtimeEnabledResultRecordSha256: record.runtimeEnabledResultRecordSha256,
      codeOnlyResultRecordSha256: record.codeOnlyResultRecordSha256,
      agentDeliveryTraceRecordSha256: record.agentDeliveryTraceRecordSha256,
      trajectoryUseEvidenceRecordSha256:
        record.trajectoryUseEvidenceRecordSha256,
    })) as unknown as z.infer<typeof summaryBaseSchema>["cases"];
    const basis = {
      schemaVersion: 1 as const,
      recordKind: "m7-r3-two-case-portfolio-summary" as const,
      portfolioId: freeze.portfolioId,
      portfolioFreezeRecordSha256: freeze.recordContentSha256,
      denominatorCaseCount: 2 as const,
      recordedCaseCount: 2 as const,
      cases,
      summarizedAt: z.string().datetime().parse(summarizedAt),
    };
    const summary = M7R3TwoCasePortfolioSummaryV1Schema.parse({
      ...basis,
      recordContentSha256: digestJson(basis),
    });
    await this.#writeOnce("summary", summary);
    return summary;
  }

  public readSummary(): Promise<M7R3TwoCasePortfolioSummaryV1> {
    return this.#read("summary", (value) =>
      M7R3TwoCasePortfolioSummaryV1Schema.parse(value),
    );
  }
}

export const openM7R3TwoCasePortfolioStoreV1 = (input: {
  readonly root: string;
  readonly exposedRoots: readonly string[];
}): Promise<M7R3TwoCasePortfolioStoreV1> =>
  M7R3TwoCasePortfolioStoreV1.open(input);
